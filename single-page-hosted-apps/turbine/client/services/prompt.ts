/**
 * client/services/prompt.ts — the JobSpec draft, its plan, and its estimate.
 *
 * The spec is reactive (it is small); the computed window list is not (it can
 * be thousands of entries). Planning is debounced because it walks the whole
 * document, and persisted to localStorage so a reload doesn't lose the prompt.
 */
import { DiamondCore } from '@diamondjs/runtime'
import type { CharRange, JobSpec, ModelInfo, ParamValue, PlanEstimate, ReasoningSetting, WindowPlan } from '../../shared/types.ts'
import { api } from './api.ts'
import { defaultJobSpec, FALLBACK_WINDOW_DEFAULTS } from '../../shared/defaults.ts'
import { estimatePlan, planWindows } from '../../shared/engine/planner.ts'
import { CHARS_PER_TOKEN, charsForTokens, sanitizeCharsPerToken, tokensForChars } from '../../shared/engine/tokens.ts'
import { unknownTemplateVariables } from '../../shared/engine/template.ts'
import { documents } from './documents.ts'
import { session } from './session.ts'
import { countTokensMemo, sampleCharsPerToken, tokenizerState } from './tokenizer.ts'

const STORAGE_KEY = 'turbine.prompt.v1'

export interface PromptState {
  spec: JobSpec
  focusTokens: number
  ctxBeforeTokens: number
  ctxAfterTokens: number
  estimate: PlanEstimate | null
  planVersion: number
  planning: boolean
  /** Measured by the last preview: output characters per second. Drives the ETA. */
  measuredCps: number | null
  unknownVars: string[]
  onlySelection: boolean
  initialized: boolean
  /** Chars per token used for every estimate; calibrated from the tokenizer, then from the model's own usage. */
  charsPerToken: number
  cptSource: 'default' | 'tokenizer' | 'model'
  /** Derive generation.max_tokens from the largest focus (1.5× + margin, bounded by the context). */
  maxTokensAuto: boolean
  /** What the backend says the current model accepts. */
  modelInfo: ModelInfo | null
  modelInfoStatus: 'idle' | 'loading' | 'ready' | 'error'
  modelInfoError: string
  /** connection+model the info belongs to, so a changed connection triggers rediscovery. */
  modelInfoKey: string
}

interface Persisted {
  spec: JobSpec
  measuredCps: number | null
  charsPerToken?: number
  cptSource?: PromptState['cptSource']
  maxTokensAuto?: boolean
}

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Persisted>
    if (!parsed.spec || typeof parsed.spec.userTemplate !== 'string') return null
    return { spec: parsed.spec, measuredCps: parsed.measuredCps ?? null, charsPerToken: parsed.charsPerToken, cptSource: parsed.cptSource, maxTokensAuto: parsed.maxTokensAuto }
  } catch {
    return null
  }
}

const initial = defaultJobSpec('document', FALLBACK_WINDOW_DEFAULTS)

export const state = DiamondCore.reactive<PromptState>({
  spec: initial,
  focusTokens: tokensForChars(initial.window.focusChars),
  ctxBeforeTokens: tokensForChars(initial.window.contextBeforeChars),
  ctxAfterTokens: tokensForChars(initial.window.contextAfterChars),
  estimate: null,
  planVersion: 0,
  planning: false,
  measuredCps: null,
  unknownVars: [],
  onlySelection: false,
  initialized: false,
  charsPerToken: CHARS_PER_TOKEN,
  cptSource: 'default',
  maxTokensAuto: true,
  modelInfo: null,
  modelInfoStatus: 'idle',
  modelInfoError: '',
  modelInfoKey: '',
})

function connectionKey(): string {
  const c = session.state.connection
  return c ? `${c.api_type}|${c.base_url}|${c.model}` : ''
}

let windows: WindowPlan[] = []
let planTimer: ReturnType<typeof setTimeout> | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined

function snapshot<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function ctxLen(): number {
  return session.state.connection?.ctx_len ?? 32768
}

/** 1.5× the largest focus plus a margin, never below 256, never more than what the context leaves after the largest prompt. */
export function deriveMaxTokens(maxFocusTokens: number, maxPromptTokens: number, ctx: number): number {
  const wanted = Math.ceil(maxFocusTokens * 1.5) + 64
  const room = Math.max(256, ctx - maxPromptTokens - 16)
  return Math.max(256, Math.min(wanted, room))
}

/** Re-derive the character sizes from the token fields when chars-per-token changes, so "1500 tokens" keeps meaning 1500 tokens. */
function applyCpt(cpt: number, source: PromptState['cptSource']): void {
  const clean = sanitizeCharsPerToken(cpt)
  if (Math.abs(clean - state.charsPerToken) < 0.01 && state.cptSource === source) return
  state.charsPerToken = clean
  state.cptSource = source
  state.spec.window.focusChars = charsForTokens(state.focusTokens, clean)
  state.spec.window.contextBeforeChars = charsForTokens(state.ctxBeforeTokens, clean)
  state.spec.window.contextAfterChars = charsForTokens(state.ctxAfterTokens, clean)
}

function planNow(): void {
  const text = documents.text()
  const spec = snapshot(state.spec)
  spec.window.focusChars = Math.max(64, num(spec.window.focusChars, 6000))
  spec.window.contextBeforeChars = Math.max(0, num(spec.window.contextBeforeChars, 0))
  spec.window.contextAfterChars = Math.max(0, num(spec.window.contextAfterChars, 0))
  if (!text) {
    windows = []
    state.estimate = null
  } else {
    try {
      windows = planWindows(text, spec.window, spec.range)
      let est = estimatePlan(windows, spec, ctxLen(), state.charsPerToken)
      if (state.maxTokensAuto && windows.length > 0) {
        const auto = deriveMaxTokens(est.max_focus_tokens, est.max_prompt_tokens, ctxLen())
        if (auto !== state.spec.generation.max_tokens) {
          state.spec.generation.max_tokens = auto
          spec.generation.max_tokens = auto
          est = estimatePlan(windows, spec, ctxLen(), state.charsPerToken)
        }
      }
      state.estimate = est
    } catch {
      windows = []
      state.estimate = null
    }
  }
  state.unknownVars = unknownTemplateVariables(spec.userTemplate)
  state.planning = false
  state.planVersion++
}

function schedulePlan(): void {
  state.planning = true
  if (planTimer) clearTimeout(planTimer)
  planTimer = setTimeout(planNow, 300)
}

function schedulePersist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ spec: snapshot(state.spec), measuredCps: state.measuredCps, charsPerToken: state.charsPerToken, cptSource: state.cptSource, maxTokensAuto: state.maxTokensAuto } satisfies Persisted))
    } catch {
      /* storage unavailable */
    }
  }, 500)
}

export const prompt = {
  state,
  windows: (): readonly WindowPlan[] => windows,

  /** Call once after session.init() so config defaults are known. */
  init(): void {
    if (state.initialized) return
    state.initialized = true
    const defaults = session.state.config?.window_defaults ?? FALLBACK_WINDOW_DEFAULTS
    const persisted = loadPersisted()
    const spec = persisted?.spec ?? defaultJobSpec(documents.state.doc?.name ?? 'document', defaults)
    if (!spec.generation.reasoning) spec.generation.reasoning = 'off'
    if (!spec.generation.params) spec.generation.params = {}
    state.spec = spec
    state.measuredCps = persisted?.measuredCps ?? null
    state.charsPerToken = sanitizeCharsPerToken(persisted?.charsPerToken)
    state.cptSource = persisted?.cptSource ?? 'default'
    state.maxTokensAuto = persisted?.maxTokensAuto ?? true
    state.focusTokens = tokensForChars(spec.window.focusChars, state.charsPerToken)
    state.ctxBeforeTokens = tokensForChars(spec.window.contextBeforeChars, state.charsPerToken)
    state.ctxAfterTokens = tokensForChars(spec.window.contextAfterChars, state.charsPerToken)
    state.onlySelection = Boolean(spec.range)

    // Calibrate chars-per-token from the real tokenizer once it is loaded and a document exists.
    // A model-measured figure (from a preview) always wins over the tokenizer sample.
    DiamondCore.effect(() => {
      void tokenizerState.version
      void documents.state.docVersion
      if (!tokenizerState.ready || state.cptSource === 'model') return
      const cpt = sampleCharsPerToken(documents.text())
      if (cpt) applyCpt(cpt, 'tokenizer')
    })

    // Keep the spec's source name in step with the loaded document.
    DiamondCore.effect(() => {
      const name = documents.state.doc?.name
      if (name && state.spec.sourceName !== name) state.spec.sourceName = name
      if (documents.state.docVersion >= 0 && state.spec.range) {
        // A new document invalidates a remembered selection range.
        const len = documents.text().length
        if (state.spec.range.end > len) {
          state.spec.range = undefined
          state.onlySelection = false
        }
      }
    })

    // Discover what the model accepts whenever the connection (or its model) changes.
    DiamondCore.effect(() => {
      const key = connectionKey()
      const connected = session.state.connected
      if (!key || !connected) return
      if (key !== state.modelInfoKey) void prompt.discoverModel()
    })

    // Re-plan when anything that shapes the plan changes.
    DiamondCore.effect(() => {
      const s = state.spec
      void [
        s.window.focusChars, s.window.contextBeforeChars, s.window.contextAfterChars, s.window.snap,
        s.mode, s.carry.kind, s.carry.chars, s.generation.max_tokens, s.systemPrompt.length, s.userTemplate.length,
        s.range?.start, s.range?.end, documents.state.docVersion, session.state.connection?.ctx_len,
        state.charsPerToken, state.maxTokensAuto,
      ]
      schedulePlan()
    })

    // Persist on any change.
    DiamondCore.effect(() => {
      void JSON.stringify(state.spec)
      void [state.measuredCps, state.charsPerToken, state.cptSource, state.maxTokensAuto]
      schedulePersist()
    })
  },

  setFocusTokens(v: unknown): void {
    const t = Math.max(16, Math.round(num(v, state.focusTokens)))
    state.focusTokens = t
    state.spec.window.focusChars = charsForTokens(t, state.charsPerToken)
  },
  setCtxBeforeTokens(v: unknown): void {
    const t = Math.max(0, Math.round(num(v, state.ctxBeforeTokens)))
    state.ctxBeforeTokens = t
    state.spec.window.contextBeforeChars = charsForTokens(t, state.charsPerToken)
  },
  setCtxAfterTokens(v: unknown): void {
    const t = Math.max(0, Math.round(num(v, state.ctxAfterTokens)))
    state.ctxAfterTokens = t
    state.spec.window.contextAfterChars = charsForTokens(t, state.charsPerToken)
  },

  /** Restrict the run to the current selection (or lift the restriction). */
  setOnlySelection(on: boolean): void {
    const sel = documents.state.selection
    if (on && sel) {
      state.onlySelection = true
      state.spec.range = { start: sel.start, end: sel.end }
    } else {
      state.onlySelection = false
      state.spec.range = undefined
    }
  },

  resetPrompts(): void {
    const defaults = session.state.config?.window_defaults ?? FALLBACK_WINDOW_DEFAULTS
    const fresh = defaultJobSpec(documents.state.doc?.name ?? 'document', defaults)
    state.spec.systemPrompt = fresh.systemPrompt
    state.spec.userTemplate = fresh.userTemplate
  },

  /** What Preview will treat as the focus: the selection, else the first planned window. */
  previewFocus(): CharRange | null {
    const sel = documents.state.selection
    if (sel) return sel
    const w = windows[0]
    return w ? { start: w.focusStart, end: w.focusEnd } : null
  },

  recordMeasurement(outputChars: number, elapsedMs: number): void {
    if (outputChars > 0 && elapsedMs > 0) state.measuredCps = outputChars / (elapsedMs / 1000)
  },

  /** The model's own prompt token count for a prompt of `promptChars` characters: the best calibration there is. */
  recordUsage(promptChars: number, promptTokens: number | undefined): void {
    if (!promptTokens || promptTokens <= 0 || promptChars <= 0) return
    applyCpt(promptChars / promptTokens, 'model')
  },

  setMaxTokensAuto(on: boolean): void {
    state.maxTokensAuto = on
    if (on) schedulePlan()
  },

  /** Best available token count for `text`: exact from the tokenizer, else the calibrated estimate. */
  tokenCount(text: string): { tokens: number; exact: boolean } {
    void tokenizerState.version
    const exact = countTokensMemo(text)
    if (exact !== null) return { tokens: exact, exact: true }
    return { tokens: tokensForChars(text.length, state.charsPerToken), exact: false }
  },

  /** Ask the backend (via the server, or directly for browser-run connections) what this model accepts. */
  async discoverModel(force = false): Promise<void> {
    const key = connectionKey()
    if (!key) return
    if (!force && state.modelInfoKey === key && state.modelInfoStatus === 'ready') return
    state.modelInfoStatus = 'loading'
    state.modelInfoError = ''
    state.modelInfoKey = key
    try {
      let info: ModelInfo | null = null
      if (session.state.execution === 'browser') info = await session.providerForBrowser().describeModel()
      else {
        const r = await api.providers.describe()
        info = r.execution === 'browser' ? await session.providerForBrowser().describeModel() : r.info
      }
      if (connectionKey() !== key) return // connection changed underneath us
      state.modelInfo = info
      state.modelInfoStatus = 'ready'
      // If the model cannot switch reasoning off, don't keep asking it to.
      const settings = info?.reasoning.settings ?? []
      if (info && settings.length && !settings.includes(state.spec.generation.reasoning ?? 'off')) {
        state.spec.generation.reasoning = settings[0]
      }
    } catch (e) {
      if (connectionKey() !== key) return
      state.modelInfo = null
      state.modelInfoStatus = 'error'
      state.modelInfoError = e instanceof Error ? e.message : String(e)
    }
  },

  setReasoning(r: ReasoningSetting): void {
    state.spec.generation.reasoning = r
  },

  paramValue(key: string): ParamValue | undefined {
    if (key === 'temperature') return state.spec.generation.temperature
    return state.spec.generation.params?.[key]
  },

  /** Set a knob (null clears it so the backend's own default applies). Temperature is a first-class field. */
  setParam(key: string, value: ParamValue | null): void {
    if (key === 'temperature') {
      if (typeof value === 'number') state.spec.generation.temperature = Math.max(0, Math.min(2, value))
      return
    }
    const params = state.spec.generation.params ?? (state.spec.generation.params = {})
    if (value === null) delete params[key]
    else params[key] = value
  },

  /** Turbine's defaults: reasoning off, temperature from config, every other knob left to the backend. */
  resetModelParams(): void {
    const defaults = session.state.config?.window_defaults ?? FALLBACK_WINDOW_DEFAULTS
    state.spec.generation.temperature = defaults.temperature
    state.spec.generation.params = {}
    const settings = state.modelInfo?.reasoning.settings ?? ['off']
    state.spec.generation.reasoning = settings.includes('off') ? 'off' : settings[0]
  },

  /** Human label for where the current chars-per-token figure came from. */
  cptLabel(): string {
    const cpt = state.charsPerToken.toFixed(2)
    switch (state.cptSource) {
      case 'model': return `${cpt} chars/token, measured from the model`
      case 'tokenizer': return `${cpt} chars/token, measured with the tokenizer`
      default: return `${cpt} chars/token, default estimate`
    }
  },

  /** Rough wall-clock estimate for the whole job, ms. */
  etaMs(): number | null {
    const e = state.estimate
    if (!e || e.window_count === 0) return null
    const parallel = state.spec.mode === 'map' ? Math.max(1, num(state.spec.concurrency, 1)) : 1
    if (state.measuredCps) return Math.round(((e.total_focus_chars / state.measuredCps) * 1000) / parallel)
    return Math.round((e.window_count * 20_000) / parallel)
  },

  specSnapshot(): JobSpec {
    return snapshot(state.spec)
  },
}
