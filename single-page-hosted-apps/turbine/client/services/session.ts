/**
 * client/services/session.ts — who we are and where inference runs.
 *
 * Owns the server session, the deployment config, the provider catalogue, the
 * browser vault, and the ONE in-memory copy of the API key (module-private,
 * never in reactive state, never in storage unencrypted). Also runs the
 * 1-second ticker behind the shell's countdown.
 */
import { DiamondCore } from '@diamondjs/runtime'
import { Print } from '@diamondjs/primafacie'
import type { ConnectionSpec, Provider } from '../../shared/types.ts'
import type { ClientConfig, ConnectRequest, Execution, ProvidersInfo, SessionInfo } from '../../shared/api.ts'
import { createProvider } from '../../shared/providers/index.ts'
import { api } from './api.ts'
import { computeFingerprint } from './fingerprint.ts'
import { vault, type VaultRecord } from './vault.ts'

export interface SessionState extends SessionInfo {
  ready: boolean
  error: string | null
  config: ClientConfig | null
  providers: ProvidersInfo | null
  firstVisit: boolean
  vaultPresent: boolean
  vaultMode: 'local' | 'remote' | null
  vaultHasKey: boolean
  vaultServerKey: boolean
  vaultPresetId: string
  canEncrypt: boolean
  fingerprint: string | null
  /** ms until the server forgets the key; null when nothing is counting down. */
  countdownMs: number | null
  expired: boolean
}

const emptyInfo: SessionInfo = {
  public_deployment: false,
  ttl_seconds: 0,
  connected: false,
  connection: null,
  has_key: false,
  key_expires_at: null,
  server_key: false,
  execution: null,
  fingerprint_changed: false,
}

export const state = DiamondCore.reactive<SessionState>({
  ...emptyInfo,
  ready: false,
  error: null,
  config: null,
  providers: null,
  firstVisit: true,
  vaultPresent: false,
  vaultMode: null,
  vaultHasKey: false,
  vaultServerKey: false,
  vaultPresetId: '',
  canEncrypt: false,
  fingerprint: null,
  countdownMs: null,
  expired: false,
})

let apiKey: string | null = null
let ticker: ReturnType<typeof setInterval> | undefined

function apply(info: SessionInfo): void {
  Object.assign(state, info)
  if (info.has_key || info.server_key || !info.connection) state.expired = false
  if (!info.has_key) {
    // Keep the in-memory key only while the server also holds it.
    if (!info.server_key) apiKey = null
  }
}

function readVault(): VaultRecord | null {
  const rec = vault.load()
  state.vaultPresent = rec !== null
  state.vaultMode = rec?.mode ?? null
  state.vaultHasKey = vault.hasEncryptedKey(rec)
  state.vaultServerKey = Boolean(rec?.server_key)
  state.vaultPresetId = rec?.preset_id ?? ''
  return rec
}

function snapshot<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export interface ConnectOptions {
  mode: 'local' | 'remote'
  presetId: string
  connection: ConnectionSpec
  /** Name of a server-side connection (config.json) whose key lives on the server. */
  serverPreset?: string
  apiKey?: string
  /** Required to persist a remote key in this browser. */
  passphrase?: string
}

async function connectWith(connection: ConnectionSpec, key: string | undefined, serverPreset: string | undefined): Promise<SessionInfo> {
  const body: ConnectRequest = { connection: snapshot(connection) }
  if (serverPreset) body.preset = serverPreset
  if (key) body.api_key = key
  if (state.fingerprint) body.fingerprint = state.fingerprint
  const info = await api.session.connect(body)
  apiKey = key ?? null
  apply(info)
  return info
}

function startTicker(): void {
  if (ticker) return
  ticker = setInterval(() => {
    if (!state.key_expires_at || state.server_key) {
      state.countdownMs = null
      return
    }
    const left = new Date(state.key_expires_at).getTime() - Date.now()
    state.countdownMs = Math.max(0, left)
    if (left <= 0 && !state.expired) {
      state.expired = true
      state.connected = false
      state.has_key = false
      void session.refresh()
    }
  }, 1000)
}

export const session = {
  state,

  async init(): Promise<void> {
    state.canEncrypt = vault.canEncrypt()
    const fp = await computeFingerprint()
    state.fingerprint = fp
    const rec = readVault()
    state.firstVisit = rec === null
    try {
      const [info, config, providers] = await Promise.all([api.session.create({ fingerprint: fp }), api.config(), api.providers.info()])
      apply(info)
      state.config = config
      state.providers = providers
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e)
      Print('FAILURE', `session init failed: ${state.error}`)
    }
    if (rec?.fingerprint && rec.fingerprint !== fp) state.fingerprint_changed = true
    // Keyless connections (local backends, server-held keys) reconnect silently.
    if (!state.connected && rec && (rec.mode === 'local' || rec.server_key)) {
      try {
        await connectWith(rec.connection, undefined, rec.server_key ? rec.preset_id.replace(/^server:/, '') : undefined)
      } catch (e) {
        Print('WARNING', `auto-reconnect skipped: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    state.ready = true
    startTicker()
  },

  async connect(opts: ConnectOptions): Promise<void> {
    await connectWith(opts.connection, opts.apiKey, opts.serverPreset)
    const previous = vault.load()
    const rec: VaultRecord = {
      version: 1,
      salt: previous?.salt ?? vault.newSalt(),
      fingerprint: state.fingerprint,
      mode: opts.mode,
      preset_id: opts.serverPreset ? `server:${opts.serverPreset}` : opts.presetId,
      connection: snapshot(opts.connection),
      server_key: Boolean(opts.serverPreset),
      updated_at: new Date().toISOString(),
    }
    if (opts.apiKey && opts.passphrase && vault.canEncrypt()) {
      rec.enc = await vault.encryptKey(opts.passphrase, opts.apiKey, rec.salt)
    }
    vault.save(rec)
    readVault()
    state.firstVisit = false
    state.fingerprint_changed = false
  },

  /** Returning visit: decrypt the stored key with the passphrase and hand it to the server. */
  async unlock(passphrase: string): Promise<void> {
    const rec = vault.load()
    if (!rec) throw new Error('Nothing is stored in this browser yet.')
    const key = await vault.decryptKey(passphrase, rec)
    await connectWith(rec.connection, key, undefined)
    state.fingerprint_changed = false
  },

  /** Reconnect a stored keyless connection (local backend / server-held key). */
  async reconnectStored(): Promise<void> {
    const rec = vault.load()
    if (!rec) throw new Error('Nothing is stored in this browser yet.')
    await connectWith(rec.connection, undefined, rec.server_key ? rec.preset_id.replace(/^server:/, '') : undefined)
  },

  /** Tell the server to forget the key now. The encrypted copy stays in this browser. */
  async lock(): Promise<void> {
    apiKey = null
    try {
      apply(await api.session.forgetKey())
    } catch (e) {
      Print('WARNING', `lock: ${e instanceof Error ? e.message : String(e)}`)
      state.connected = false
      state.has_key = false
    }
  },

  /** Wipe the browser vault and the server-side key. */
  async forgetBrowser(): Promise<void> {
    vault.clear()
    await session.lock()
    readVault()
    state.firstVisit = true
  },

  async refresh(): Promise<void> {
    try {
      apply(await api.session.get())
    } catch (e) {
      Print('WARNING', `session refresh: ${e instanceof Error ? e.message : String(e)}`)
    }
  },

  /** Where this connection's jobs will run, per the server's decision. */
  get execution(): Execution | null {
    return state.execution
  },

  getApiKey(): string | null {
    return apiKey
  },

  /** A Provider the browser can drive directly (browser-run jobs, local model listing, local preview). */
  providerForBrowser(connection: ConnectionSpec | null = state.connection): Provider {
    if (!connection) throw new Error('No connection is configured.')
    return createProvider(snapshot(connection), apiKey)
  },

  connectionLabel(): string {
    const c = state.connection
    if (!c) return 'Not connected'
    if (c.locality === 'local') {
      let host = c.base_url
      try {
        host = new URL(c.base_url).host
      } catch {
        /* keep raw */
      }
      return `Local: ${c.name} @ ${host} · ${c.model}`
    }
    return `${c.name} · ${c.model}`
  },
}
