/**
 * server/keyvault.ts — short-lived, in-memory, encrypted API key storage.
 *
 *   master secret   TURBINE_MASTER_SECRET (hex, ≥ 32 bytes) or random at boot
 *   session key     HKDF-SHA256(master, salt = sessionId, info = 'turbine-key-vault')
 *   ciphertext      AES-256-GCM, fresh 12-byte IV per put
 *
 * Plaintext exists only inside withKey()'s callback. Expiry zeroizes the
 * buffers. This defends against heap dumps, logs and crash reports — not
 * against a compromised process, which is the honest limit of any in-process
 * vault.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { log } from './log.ts'

interface Entry {
  iv: Buffer
  ct: Buffer
  tag: Buffer
  expiresAt: number
  timer: ReturnType<typeof setTimeout> | null
}

export class KeyVault {
  private readonly master: Buffer
  private readonly entries = new Map<string, Entry>()
  private readonly expireListeners = new Set<(sessionId: string) => void>()

  constructor(masterSecret?: Buffer | string) {
    if (masterSecret) {
      const buf = typeof masterSecret === 'string' ? Buffer.from(masterSecret, 'hex') : masterSecret
      if (buf.length < 32) throw new Error('KeyVault master secret must be at least 32 bytes')
      this.master = buf
    } else {
      this.master = randomBytes(32)
    }
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): KeyVault {
    const hex = env.TURBINE_MASTER_SECRET?.trim()
    if (hex) {
      if (!/^[0-9a-f]{64,}$/i.test(hex)) throw new Error('TURBINE_MASTER_SECRET must be hex and at least 32 bytes (64 hex chars)')
      return new KeyVault(hex)
    }
    log('WARNING', 'TURBINE_MASTER_SECRET not set — using a random in-memory vault secret; held keys will not survive a restart (this is the intended default)')
    return new KeyVault()
  }

  private sessionKey(sessionId: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.master, Buffer.from(sessionId, 'utf8'), 'turbine-key-vault', 32))
  }

  put(sessionId: string, apiKey: string, ttlMs: number): Date {
    this.forget(sessionId)
    const key = this.sessionKey(sessionId)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    key.fill(0)
    const expiresAt = Date.now() + Math.max(1000, ttlMs)
    const entry: Entry = { iv, ct, tag, expiresAt, timer: null }
    this.entries.set(sessionId, entry)
    this.arm(sessionId, entry)
    return new Date(expiresAt)
  }

  private arm(sessionId: string, entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer)
    const delay = Math.max(0, entry.expiresAt - Date.now())
    entry.timer = setTimeout(() => this.expire(sessionId), delay)
    ;(entry.timer as { unref?: () => void }).unref?.()
  }

  private expire(sessionId: string): void {
    const e = this.entries.get(sessionId)
    if (!e) return
    if (e.expiresAt > Date.now()) {
      this.arm(sessionId, e) // extended since the timer was set
      return
    }
    this.zeroize(sessionId, e)
    for (const cb of this.expireListeners) {
      try {
        cb(sessionId)
      } catch (err) {
        log('WARNING', `vault expire listener threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private zeroize(sessionId: string, e: Entry): void {
    if (e.timer) clearTimeout(e.timer)
    e.iv.fill(0)
    e.ct.fill(0)
    e.tag.fill(0)
    this.entries.delete(sessionId)
  }

  private live(sessionId: string): Entry | null {
    const e = this.entries.get(sessionId)
    if (!e) return null
    if (e.expiresAt <= Date.now()) {
      this.expire(sessionId)
      return null
    }
    return e
  }

  has(sessionId: string): boolean {
    return this.live(sessionId) !== null
  }

  expiresAt(sessionId: string): Date | null {
    const e = this.live(sessionId)
    return e ? new Date(e.expiresAt) : null
  }

  extend(sessionId: string, ttlMs: number): Date | null {
    const e = this.live(sessionId)
    if (!e) return null
    e.expiresAt = Date.now() + Math.max(1000, ttlMs)
    this.arm(sessionId, e)
    return new Date(e.expiresAt)
  }

  /** Decrypt just-in-time and hand the plaintext to `fn`. Nothing is cached. */
  async withKey<T>(sessionId: string, fn: (key: string) => Promise<T>): Promise<T> {
    const e = this.live(sessionId)
    if (!e) throw new VaultMissError(sessionId)
    const key = this.sessionKey(sessionId)
    let plain: string
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, e.iv)
      decipher.setAuthTag(e.tag)
      plain = Buffer.concat([decipher.update(e.ct), decipher.final()]).toString('utf8')
    } finally {
      key.fill(0)
    }
    return fn(plain)
  }

  forget(sessionId: string): void {
    const e = this.entries.get(sessionId)
    if (e) this.zeroize(sessionId, e)
  }

  onExpire(cb: (sessionId: string) => void): () => void {
    this.expireListeners.add(cb)
    return () => this.expireListeners.delete(cb)
  }

  /** Test/shutdown helper. */
  clear(): void {
    for (const id of [...this.entries.keys()]) this.forget(id)
  }
}

export class VaultMissError extends Error {
  constructor(sessionId: string) {
    super(`no key held for session ${sessionId.slice(0, 8)}… (expired or never provided)`)
    this.name = 'VaultMissError'
  }
}
