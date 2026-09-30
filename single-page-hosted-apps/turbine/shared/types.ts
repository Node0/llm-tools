/**
 * shared/types.ts — Turbine's domain vocabulary.
 *
 * Runs unchanged in the browser and under Bun. Nothing in here touches the
 * DOM, the filesystem, or a specific HTTP framework.
 *
 * Provenance: the connection shape is Crystallizer's
 * `inference_service_connections` entry (api_type / base_url / default_* /
 * options passthrough), normalized and stripped of the key — keys never ride
 * on a ConnectionSpec; they travel separately and are held by the key vault.
 */

// ─── Providers ───────────────────────────────────────────────────────────────

/** Wire protocol families. vLLM, llama.cpp's server and OpenRouter are all `openai`. */
export type ApiType = 'openai' | 'ollama' | 'anthropic'

/** Where the backend lives relative to the *user's* machine. Drives execution placement. */
export type Locality = 'local' | 'remote'

/** A fully resolved inference connection. Never carries an API key. */
export interface ConnectionSpec {
  /** Human label, e.g. 'ollama-local', 'openrouter'. Used in provenance records. */
  name: string
  api_type: ApiType
  /** Base URL up to but excluding the endpoint path, e.g. 'http://localhost:11434' or 'https://openrouter.ai/api/v1'. */
  base_url: string
  model: string
  /** Context length the backend is configured for. Drives the preflight budget check. */
  ctx_len: number
  locality: Locality
  /** Whether requests need a bearer/x-api-key. Local backends usually don't. */
  requires_key: boolean
  /** Extra static headers (OpenRouter's HTTP-Referer / X-Title, for example). */
  headers?: Record<string, string>
  /** Provider passthrough: Ollama `options`, or extra top-level fields for OpenAI-compatible bodies. */
  options?: Record<string, unknown>
  timeout_ms?: number
  /** Anthropic only. */
  anthropic_version?: string
}

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface GenerateOptions {
  temperature?: number
  max_tokens?: number
  /** Ollama num_ctx. Ignored by other providers. */
  num_ctx?: number
  stop?: string[]
  signal?: AbortSignal
  /** Streaming callback. When present the provider streams and calls this per chunk. */
  onToken?: (chunk: string) => void
}

export interface TokenUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

export interface GenerateResult {
  text: string
  model: string
  usage?: TokenUsage
  finish_reason?: string
  elapsed_ms: number
}

export interface HealthResult {
  ok: boolean
  detail?: string
  latency_ms?: number
}

/** The one interface every backend implements (Crystallizer's LLMProvider Protocol, grown up). */
export interface Provider {
  readonly spec: ConnectionSpec
  generate(messages: ChatMessage[], opts?: GenerateOptions): Promise<GenerateResult>
  listModels(): Promise<string[]>
  health(): Promise<HealthResult>
}

/** Structured provider failure. `retryable` drives the runner's retry policy. */
export class ProviderError extends Error {
  readonly status: number | undefined
  readonly retryable: boolean
  readonly body: string | undefined
  constructor(message: string, opts: { status?: number; retryable?: boolean; body?: string; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'ProviderError'
    this.status = opts.status
    this.retryable = opts.retryable ?? false
    this.body = opts.body
  }
  /** Auth failures are terminal for the whole job, not just one window. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export type SnapMode = 'paragraph' | 'sentence' | 'none'

/** Sizes are in characters. The UI speaks tokens and converts via tokens.ts. */
export interface WindowOptions {
  focusChars: number
  contextBeforeChars: number
  contextAfterChars: number
  snap: SnapMode
}

/** One step of the plan. Only [focusStart, focusEnd) is transformed and emitted. */
export interface WindowPlan {
  index: number
  ctxStart: number
  focusStart: number
  focusEnd: number
  ctxEnd: number
}

export interface CharRange {
  start: number
  end: number
}

/** map: independent windows, parallel. fold: sequential with carry-forward (the actual "reduce"). */
export type RunMode = 'map' | 'fold'

export interface CarrySpec {
  kind: 'none' | 'tail'
  /** For 'tail': how many characters of the previous window's output to carry. */
  chars: number
}

export type ValidatorKind = 'none' | 'conserve' | 'length-ratio'

export interface ValidatorSpec {
  kind: ValidatorKind
  /** conserve: minimum similarity 0..1 between markdown-stripped output and the focus text. Default 0.95. */
  threshold?: number
  /** length-ratio bounds on output.length / focus.length. Defaults 0.5 .. 2.0. */
  minRatio?: number
  maxRatio?: number
}

export interface GenerationSpec {
  temperature: number
  max_tokens: number
  num_ctx?: number
}

export interface RetrySpec {
  /** Total attempts per window, including the first. */
  maxAttempts: number
  /** Multiply temperature by this on each retry (0.5 → 0.2, 0.1, 0.05 ...). */
  temperatureDecay: number
}

/** Everything needed to run one job. Serializable; stored with the job for provenance. */
export interface JobSpec {
  sourceName: string
  systemPrompt: string
  userTemplate: string
  window: WindowOptions
  mode: RunMode
  concurrency: number
  carry: CarrySpec
  generation: GenerationSpec
  validator: ValidatorSpec
  retry: RetrySpec
  /** Inserted between window outputs when assembling. */
  joiner: string
  /** Optional sub-range of the document to process (a selection). Context may still reach outside it. */
  range?: CharRange
}

export interface ValidationResult {
  ok: boolean
  kind: ValidatorKind
  score?: number
  reason?: string
}

export type WindowStatus = 'ok' | 'flagged' | 'failed'

/** One checkpoint line in <stem>__turbine.jsonl. Also the WS snapshot unit. */
export interface WindowRecord {
  index: number
  status: WindowStatus
  output: string
  attempt: number
  model: string
  connection: string
  prompt_hash: string
  started_at: string
  elapsed_ms: number
  usage?: TokenUsage
  validation: ValidationResult
  error?: string
}

export interface PlanEstimate {
  window_count: number
  total_focus_chars: number
  avg_focus_chars: number
  /** Prompt tokens for the largest window: system + template + context + focus + carry. */
  max_prompt_tokens: number
  avg_prompt_tokens: number
  /** Assuming output ≈ focus in size. */
  est_output_tokens: number
  est_total_tokens: number
  fits_context: boolean
  ctx_len: number
  /** Largest focus region, in characters and (estimated) tokens — what max_tokens must accommodate. */
  max_focus_chars: number
  max_focus_tokens: number
  /** True when generation.max_tokens is smaller than the largest focus: outputs may be cut off. */
  max_tokens_may_truncate: boolean
  /** The chars-per-token figure these estimates used. */
  chars_per_token: number
}

export interface JobStats {
  done: number
  flagged: number
  failed: number
  total: number
  elapsed_ms: number
  prompt_tokens: number
  completion_tokens: number
}

/** The runner's event stream. The server relays these over WebSocket; a browser-run job consumes them directly. */
export type WindowEvent =
  | { type: 'planned'; windows: WindowPlan[]; estimate: PlanEstimate }
  | { type: 'window-start'; index: number; attempt: number }
  | { type: 'window-token'; index: number; chunk: string }
  | { type: 'window-done'; record: WindowRecord }
  | { type: 'window-failed'; index: number; attempt: number; error: string; final: boolean }
  | { type: 'progress'; stats: JobStats; eta_ms: number | null }
  | { type: 'paused'; reason: string }
  | { type: 'resumed' }
  | { type: 'halted'; reason: 'auth' | 'error'; error: string }
  | { type: 'complete'; output: string; stats: JobStats }
  | { type: 'cancelled'; stats: JobStats }
