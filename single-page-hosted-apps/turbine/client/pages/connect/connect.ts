/**
 * ConnectPage — first contact and every return visit.
 *
 * First visit: choose local vs remote, compose the connection, (for remote)
 * enter the key + a passphrase that encrypts it in this browser. Return visit:
 * unlock with the passphrase (or just reconnect for keyless setups).
 */
import { Component, reactive } from '@diamondjs/runtime'
import { Print } from '@diamondjs/primafacie'
import * as T from './connect.diamond.html'
import type { ConnectionSpec } from '../../../shared/types.ts'
import { buildBaseUrl, connectionFromPreset, normalizeConnection, parseBaseUrl, presetById } from '../../../shared/providers/presets.ts'
import { createProvider } from '../../../shared/providers/index.ts'
import { api } from '../../services/api.ts'
import { tip as tipText } from '../../services/tooltips.ts'
import { nav, ui } from '../../services/nav.ts'
import { session } from '../../services/session.ts'
import { vault } from '../../services/vault.ts'

interface ServerConnOption {
  name: string
  label: string
  optionValue: string
}

const LOCAL_DEFAULTS: Record<string, { port: string; path: string }> = {
  ollama: { port: '11434', path: '' },
  vllm: { port: '8000', path: '/v1' },
  llamacpp: { port: '8080', path: '/v1' },
}

export class ConnectPage extends Component {
  createTemplate = (T as unknown as { createTemplate: (this: ConnectPage) => HTMLElement }).createTemplate

  @reactive showFormFlag = false
  @reactive mode: 'local' | 'remote' = 'local'
  @reactive localPreset = 'ollama'
  @reactive scheme = 'http'
  @reactive host = 'localhost'
  @reactive port = '11434'
  @reactive path = ''
  @reactive remotePreset = 'openrouter'
  @reactive baseUrl = 'https://openrouter.ai/api/v1'
  @reactive model = ''
  @reactive ctxLen = '32768'
  @reactive apiKey = ''
  @reactive passphrase = ''
  @reactive passphrase2 = ''
  @reactive unlockPass = ''
  @reactive models: string[] = []
  @reactive busy = false
  @reactive testResult = ''
  @reactive testOk: boolean | null = null
  @reactive error = ''
  /** Flipped after mount so <select> bindings re-run once their <option>s exist. */
  constructor(_params?: Record<string, unknown>) {
    super()
    ui.activeTab = 'connect'
    this.prefillFromVault()
  }

  get localPresetSel(): string {
    return this.localPreset
  }
  set localPresetSel(v: unknown) {
    this.localPreset = String(v ?? 'ollama')
  }
  get schemeSel(): string {
    return this.scheme
  }
  set schemeSel(v: unknown) {
    this.scheme = v === 'https' ? 'https' : 'http'
  }
  get remotePresetSel(): string {
    return this.remotePreset
  }
  set remotePresetSel(v: unknown) {
    this.remotePreset = String(v ?? 'openrouter')
  }

  private prefillFromVault(): void {
    const rec = vault.load()
    if (!rec) {
      this.applyLocalDefaults()
      this.model = session.state.providers?.connections.find((c) => c.connection.api_type === 'ollama')?.connection.model ?? ''
      return
    }
    this.mode = rec.mode
    this.model = rec.connection.model
    this.ctxLen = String(rec.connection.ctx_len)
    if (rec.mode === 'local') {
      this.localPreset = rec.preset_id
      const parts = parseBaseUrl(rec.connection.base_url)
      if (parts) {
        this.scheme = parts.scheme
        this.host = parts.host
        this.port = parts.port
        this.path = parts.path
      }
    } else {
      this.remotePreset = rec.preset_id
      this.baseUrl = rec.connection.base_url
    }
  }

  private applyLocalDefaults(): void {
    const d = LOCAL_DEFAULTS[this.localPreset] ?? LOCAL_DEFAULTS.ollama
    this.scheme = 'http'
    this.host = 'localhost'
    this.port = d.port
    this.path = d.path
    const preset = presetById(this.localPreset)
    if (preset) this.ctxLen = String(preset.ctx_len)
  }

  tip(path: string): string {
    return tipText(path)
  }

  // ── view state ───────────────────────────────────────────────────────────
  get ready(): boolean {
    return session.state.ready
  }
  get initError(): string {
    return session.state.error ?? ''
  }
  get firstVisit(): boolean {
    return session.state.firstVisit
  }
  get showWelcome(): boolean {
    return !this.firstVisit && !this.showFormFlag
  }
  get showForm(): boolean {
    return this.firstVisit || this.showFormFlag
  }
  get fingerprintChanged(): boolean {
    return session.state.fingerprint_changed
  }
  get canEncrypt(): boolean {
    return session.state.canEncrypt
  }
  get isLocal(): boolean {
    return this.mode === 'local'
  }
  get isRemote(): boolean {
    return this.mode === 'remote'
  }
  get usesServerConnection(): boolean {
    return this.remotePreset.startsWith('server:')
  }
  get serverConnections(): ServerConnOption[] {
    return (session.state.providers?.connections ?? [])
      .filter((c) => c.has_server_key)
      .map((c) => ({ name: c.name, label: `${c.name} (key on server) · ${c.connection.model}`, optionValue: `server:${c.name}` }))
  }
  get needsKey(): boolean {
    return this.isRemote && !this.usesServerConnection
  }
  get keyUrl(): string {
    return presetById(this.remotePreset)?.key_url ?? ''
  }
  get composedBaseUrl(): string {
    return buildBaseUrl({ scheme: this.scheme === 'https' ? 'https' : 'http', host: this.host.trim() || 'localhost', port: this.port.trim(), path: this.path.trim() })
  }
  get publicLocalNote(): string {
    if (!session.state.public_deployment) return ''
    return 'This Turbine is publicly deployed, so local backends are called directly from your browser: keep this tab open while a job runs, and allow this origin in the backend (e.g. OLLAMA_ORIGINS).'
  }
  get ttlNote(): string {
    const s = session.state
    if (!this.needsKey || !s.ttl_seconds) return ''
    const m = Math.round(s.ttl_seconds / 60)
    return `The server keeps the key in memory for ${m} minutes${s.config?.extend_on_activity ? ', extended while you work' : ''}; a countdown in the top bar shows what is left.`
  }
  get hasModels(): boolean {
    return this.models.length > 0
  }
  get modelCount(): number {
    return this.models.length
  }
  get testClass(): string {
    return this.testOk === null ? 'muted' : this.testOk ? 'ok' : 'error'
  }
  get testLabel(): string {
    return this.busy ? 'Working…' : 'Test connection'
  }
  get connectLabel(): string {
    return this.busy ? 'Connecting…' : 'Connect'
  }
  get canSubmit(): boolean {
    if (this.busy) return false
    if (!this.model.trim()) return false
    if (this.needsKey) {
      if (!this.apiKey.trim()) return false
      if (this.canEncrypt && (this.passphrase.length < 4 || this.passphrase !== this.passphrase2)) return false
    }
    return true
  }
  get savedSummary(): string {
    const rec = vault.load()
    if (!rec) return ''
    const c = rec.connection
    return rec.mode === 'local' ? `Local ${c.name} at ${c.base_url} · ${c.model}` : `${c.name} · ${c.model}`
  }
  get savedKeyNote(): string {
    const s = session.state
    if (s.vaultServerKey) return 'held by the server'
    if (s.vaultHasKey) return 'encrypted in this browser'
    if (s.vaultMode === 'remote') return 'not saved in this browser — you will be asked for it'
    return ''
  }
  get unlockNeedsPassphrase(): boolean {
    return session.state.vaultHasKey && !session.state.vaultServerKey
  }
  get unlockLabel(): string {
    if (this.busy) return 'Connecting…'
    return this.unlockNeedsPassphrase ? 'Unlock' : 'Connect'
  }

  // ── actions ──────────────────────────────────────────────────────────────
  setMode(mode: 'local' | 'remote'): void {
    this.mode = mode
    this.testResult = ''
    this.testOk = null
    this.error = ''
    if (mode === 'remote') this.onRemotePreset()
  }
  onLocalPreset(): void {
    this.applyLocalDefaults()
    this.models = []
  }
  onRemotePreset(): void {
    this.models = []
    if (this.usesServerConnection) {
      const c = session.state.providers?.connections.find((x) => `server:${x.name}` === this.remotePreset)
      if (c) {
        this.baseUrl = c.connection.base_url
        this.model = c.connection.model
        this.ctxLen = String(c.connection.ctx_len)
      }
      return
    }
    const preset = presetById(this.remotePreset)
    if (preset) {
      this.baseUrl = preset.base_url
      this.ctxLen = String(preset.ctx_len)
      if (preset.default_model && !this.model) this.model = preset.default_model
    }
  }
  pickModel(e: Event): void {
    const v = (e.target as HTMLSelectElement).value
    if (v) this.model = v
  }
  onUnlockKey(e: Event): void {
    if ((e as KeyboardEvent).key === 'Enter') void this.unlock()
  }
  useDifferent(): void {
    this.showFormFlag = true
    this.error = ''
  }
  cancelForm(): void {
    this.showFormFlag = false
    this.error = ''
  }

  private buildConnection(): ConnectionSpec {
    const ctx = Number(this.ctxLen) || 32768
    const model = this.model.trim() || 'model'
    if (this.isLocal) {
      const preset = presetById(this.localPreset) ?? presetById('ollama')!
      return connectionFromPreset(preset, { base_url: this.composedBaseUrl, model, ctx_len: ctx })
    }
    if (this.usesServerConnection) {
      const c = session.state.providers?.connections.find((x) => `server:${x.name}` === this.remotePreset)
      if (!c) throw new Error('That server connection is no longer available.')
      return normalizeConnection({ ...c.connection, model, ctx_len: ctx })
    }
    const preset = presetById(this.remotePreset) ?? presetById('custom-openai')!
    return connectionFromPreset(preset, { base_url: this.baseUrl.trim(), model, ctx_len: ctx })
  }

  private serverPresetName(): string | undefined {
    return this.usesServerConnection ? this.remotePreset.slice('server:'.length) : undefined
  }

  /** Local backends under a public deployment are the browser's business; everything else is the server's. */
  private testInBrowser(connection: ConnectionSpec): boolean {
    return connection.locality === 'local' && session.state.public_deployment
  }

  async listModels(): Promise<void> {
    this.error = ''
    this.busy = true
    try {
      const connection = this.buildConnection()
      let models: string[]
      if (this.testInBrowser(connection)) models = await createProvider(connection, null).listModels()
      else {
        const r = await api.providers.models({ connection, preset: this.serverPresetName(), api_key: this.needsKey ? this.apiKey.trim() : undefined })
        models = r.models
      }
      this.models = models
      if (models.length === 0) this.testResult = 'The backend answered but listed no models.'
      else if (!this.model.trim()) this.model = models[0]
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.busy = false
    }
  }

  async testConnection(): Promise<void> {
    this.error = ''
    this.testResult = ''
    this.testOk = null
    this.busy = true
    try {
      const connection = this.buildConnection()
      if (this.testInBrowser(connection)) {
        const h = await createProvider(connection, null).health()
        this.testOk = h.ok
        this.testResult = `${h.ok ? 'OK' : 'Failed'} · ${h.detail ?? ''} · ${h.latency_ms ?? '?'} ms · from this browser`
      } else {
        const r = await api.providers.test({ connection, preset: this.serverPresetName(), api_key: this.needsKey ? this.apiKey.trim() : undefined })
        this.testOk = r.ok
        this.testResult = `${r.ok ? 'OK' : 'Failed'} · ${r.detail ?? ''} · ${r.latency_ms ?? '?'} ms · via the server (jobs will run ${r.execution === 'browser' ? 'from this browser' : 'on the server'})`
        if (r.models?.length) this.models = r.models
      }
    } catch (e) {
      this.testOk = false
      this.testResult = ''
      this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.busy = false
    }
  }

  async connect(): Promise<void> {
    if (!this.canSubmit) return
    this.error = ''
    this.busy = true
    try {
      const connection = this.buildConnection()
      await session.connect({
        mode: this.mode,
        presetId: this.isLocal ? this.localPreset : this.remotePreset,
        connection,
        serverPreset: this.serverPresetName(),
        apiKey: this.needsKey ? this.apiKey.trim() : undefined,
        passphrase: this.needsKey && this.canEncrypt ? this.passphrase : undefined,
      })
      this.apiKey = ''
      this.passphrase = ''
      this.passphrase2 = ''
      Print('SUCCESS', `connected: ${session.connectionLabel()}`)
      await nav.go(nav.returnTo() ?? '/source')
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.busy = false
    }
  }

  async unlock(): Promise<void> {
    this.error = ''
    this.busy = true
    try {
      if (this.unlockNeedsPassphrase) {
        if (!this.unlockPass) throw new Error('Enter your passphrase.')
        await session.unlock(this.unlockPass)
      } else if (session.state.vaultMode === 'remote' && !session.state.vaultServerKey) {
        // Remote connection whose key was never stored (insecure context): needs the full form.
        this.showFormFlag = true
        return
      } else {
        await session.reconnectStored()
      }
      this.unlockPass = ''
      await nav.go(nav.returnTo() ?? '/source')
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.busy = false
    }
  }

  async forget(): Promise<void> {
    if (!confirm('Forget the saved connection and any encrypted key in this browser?')) return
    await session.forgetBrowser()
    this.showFormFlag = false
    this.prefillFromVault()
  }
}
