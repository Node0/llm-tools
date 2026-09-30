/**
 * server/sessions.ts — browser identity.
 *
 * The cookie is a random id, HttpOnly + SameSite=Strict, long-lived: it is
 * identity, not authorization. The KEY (in the vault) is what expires. A
 * minimal session record (no secrets) is persisted so a server restart keeps
 * your documents and jobs; the key is gone and the client asks for the
 * passphrase again — which is exactly the intended behavior.
 *
 * Fingerprints are a loose "same browser?" check only: they change on browser
 * updates, so they never decide identity and never feed key material.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from 'node:path'
import type { Cookie } from 'elysia'
import type { Execution, SessionInfo } from '../shared/api.ts'
import type { ConnectionSpec } from '../shared/types.ts'
import type { ServerConnection, TurbineConfig } from './config.ts'
import type { KeyVault } from './keyvault.ts'
import { log } from './log.ts'
import { decideExecution } from './policy.ts'

export interface Session {
  id: string
  created_at: string
  last_seen: string
  fingerprint: string | null
  connection: ConnectionSpec | null
  /** Name of the config.json connection this session picked, if any. */
  preset_name: string | null
  fingerprint_changed: boolean
}

const COOKIE_MAX_AGE = 30 * 24 * 3600
const SESSION_ID_RE = /^[0-9a-f]{64}$/

export type CookieJar = Record<string, Cookie<unknown>>

export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly dir: string

  constructor(private readonly config: TurbineConfig, private readonly vault: KeyVault) {
    this.dir = join(config.server.data_dir, 'sessions')
    mkdirSync(this.dir, { recursive: true })
    this.loadFromDisk()
  }

  private loadFromDisk(): void {
    let n = 0
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Session
        if (SESSION_ID_RE.test(s.id)) {
          this.sessions.set(s.id, { ...s, fingerprint_changed: false })
          n++
        }
      } catch (e) {
        log('WARNING', `session file ${f} unreadable: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (n) log('STATE', `restored ${n} session record(s) from ${this.dir}`)
  }

  private persist(s: Session): void {
    const file = join(this.dir, `${s.id}.json`)
    const tmp = `${file}.tmp`
    const { fingerprint_changed: _omit, ...rest } = s
    writeFileSync(tmp, JSON.stringify(rest))
    renameSync(tmp, file)
  }

  get(id: string | undefined | null): Session | undefined {
    if (!id || !SESSION_ID_RE.test(id)) return undefined
    return this.sessions.get(id)
  }

  create(): Session {
    const now = new Date().toISOString()
    const s: Session = {
      id: randomBytes(32).toString('hex'),
      created_at: now,
      last_seen: now,
      fingerprint: null,
      connection: null,
      preset_name: null,
      fingerprint_changed: false,
    }
    this.sessions.set(s.id, s)
    this.persist(s)
    return s
  }

  /** Cookie attributes for this request. Secure iff the browser is talking TLS to us (directly or via a trusted proxy). */
  cookieAttrs(request: Request): { httpOnly: true; sameSite: 'strict'; path: '/'; maxAge: number; secure: boolean } {
    let secure = false
    try {
      secure = new URL(request.url).protocol === 'https:'
    } catch {
      secure = false
    }
    if (!secure && this.config.server.trust_proxy) {
      secure = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase() === 'https'
    }
    return { httpOnly: true, sameSite: 'strict', path: '/', maxAge: COOKIE_MAX_AGE, secure }
  }

  /**
   * Resolve the session for a request, creating one (and setting the cookie)
   * when absent or unknown. Mutating requests count as activity for the
   * optional sliding key TTL.
   */
  resolve(cookie: CookieJar, request: Request): Session {
    const name = this.config.session.cookie_name
    const jar = cookie[name]
    const raw = typeof jar?.value === 'string' ? jar.value : undefined
    let s = this.get(raw)
    if (!s) {
      s = this.create()
      jar.set({ value: s.id, ...this.cookieAttrs(request) })
    }
    this.touch(s, request.method)
    return s
  }

  /** WS path: no cookie jar, just the header. Returns undefined rather than creating. */
  fromCookieHeader(header: string | null | undefined): Session | undefined {
    if (!header) return undefined
    const name = this.config.session.cookie_name
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=')
      if (k === name) return this.get(decodeURIComponent(v.join('=')))
    }
    return undefined
  }

  private touch(s: Session, method: string): void {
    s.last_seen = new Date().toISOString()
    if (this.config.session.extend_on_activity && method !== 'GET' && method !== 'HEAD' && this.vault.has(s.id)) {
      this.vault.extend(s.id, this.config.session.ttl_seconds * 1000)
    }
  }

  recordFingerprint(s: Session, fingerprint: string | undefined): void {
    if (!fingerprint) return
    const fp = fingerprint.slice(0, 128)
    s.fingerprint_changed = s.fingerprint !== null && s.fingerprint !== fp
    if (s.fingerprint !== fp) {
      s.fingerprint = fp
      this.persist(s)
    }
  }

  setConnection(s: Session, connection: ConnectionSpec | null, presetName: string | null): void {
    s.connection = connection
    s.preset_name = presetName
    this.persist(s)
  }

  destroy(s: Session, cookie?: CookieJar): void {
    this.vault.forget(s.id)
    this.sessions.delete(s.id)
    rmSync(join(this.dir, `${s.id}.json`), { force: true })
    cookie?.[this.config.session.cookie_name]?.remove()
  }

  serverConnection(s: Session): ServerConnection | null {
    if (!s.preset_name) return null
    return this.config.connections.find((c) => c.name === s.preset_name) ?? null
  }

  /** True when the server itself owns a key for this session's connection (private deployments only). */
  hasServerKey(s: Session): boolean {
    return Boolean(this.serverConnection(s)?.apiKey)
  }

  execution(s: Session): Execution | null {
    return s.connection ? decideExecution(this.config, s.connection) : null
  }

  /** Is this session ready to run inference? */
  isConnected(s: Session): boolean {
    if (!s.connection) return false
    if (this.execution(s) === 'browser') return true // the browser holds its own key
    if (!s.connection.requires_key) return true
    return this.hasServerKey(s) || this.vault.has(s.id)
  }

  toInfo(s: Session): SessionInfo {
    const serverKey = this.hasServerKey(s)
    const exp = this.vault.expiresAt(s.id)
    return {
      public_deployment: this.config.public_deployment,
      ttl_seconds: this.config.session.ttl_seconds,
      connected: this.isConnected(s),
      connection: s.connection,
      has_key: serverKey || exp !== null,
      key_expires_at: exp ? exp.toISOString() : null,
      server_key: serverKey,
      execution: this.execution(s),
      fingerprint_changed: s.fingerprint_changed,
    }
  }
}
