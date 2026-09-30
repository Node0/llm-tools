/**
 * shared/providers/ollama.ts — Ollama's native /api/chat.
 *
 * Native rather than Ollama's OpenAI shim so `num_ctx` and the rest of the
 * `options` block are honored — that matters for 32k+ windows on a Mac.
 * Streaming is NDJSON, one JSON object per line, `done: true` on the last.
 *
 * Context: Turbine always sends `options.num_ctx`. Precedence is the job's
 * explicit num_ctx → the Model-parameters knob → the connection's `options`
 * → the connection's ctx_len. So the context the planner budgets against is
 * the context Ollama actually loads the model with.
 *
 * Reasoning: `think` is sent from the normalized setting — false by default.
 * Levels (low/medium/high) are only meaningful to a few models (gpt-oss);
 * everywhere else a level means `true`.
 */

import { ProviderError } from '../types.ts'
import type { ChatMessage, ConnectionSpec, GenerateOptions, GenerateResult, HealthResult, ModelInfo, ParamValue, Provider, ReasoningSetting } from '../types.ts'
import { type FetchLike, now, readLines, request, trimBase } from './http.ts'
import { OLLAMA_OPTIONS, PRESET_PARAMS, parseOllamaParameters, routeParams } from './params.ts'
import { registerProvider } from './registry.ts'

interface OllamaChunk {
  model?: string
  message?: { role?: string; content?: string }
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  error?: string
}

interface OllamaShow {
  parameters?: string
  capabilities?: string[]
  details?: { family?: string; parameter_size?: string; quantization_level?: string }
  model_info?: Record<string, unknown>
}

const LEVEL_MODELS = /gpt-oss/i

export function ollamaThink(model: string, reasoning: ReasoningSetting | undefined): boolean | string {
  const r = reasoning ?? 'off'
  if (r === 'off') return false
  if (r === 'on') return true
  return LEVEL_MODELS.test(model) ? r : true
}

export class OllamaProvider implements Provider {
  readonly spec: ConnectionSpec
  private readonly key: string | null
  private readonly fetchImpl: FetchLike
  private readonly base: string

  constructor(spec: ConnectionSpec, apiKey: string | null, fetchImpl: FetchLike = fetch) {
    this.spec = spec
    this.key = apiKey
    this.fetchImpl = fetchImpl
    this.base = trimBase(spec.base_url)
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(this.spec.headers ?? {}) }
    // Ollama behind a reverse proxy sometimes wants a bearer; harmless otherwise.
    if (this.key) h['authorization'] = `Bearer ${this.key}`
    return h
  }

  /** Build the request body — exported through generate(); tests inspect it via a fake fetch. */
  buildBody(messages: ChatMessage[], opts: GenerateOptions): Record<string, unknown> {
    const stream = typeof opts.onToken === 'function'
    const connOptions: Record<string, unknown> = { ...(this.spec.options ?? {}) }
    // A connection-level `think` is the legacy way to set the default; the job's reasoning wins.
    const connThink = typeof connOptions.think === 'boolean' ? connOptions.think : undefined
    delete connOptions.think
    const { known, extra } = routeParams(opts.params, Object.values(OLLAMA_OPTIONS))
    const options: Record<string, unknown> = { ...connOptions, ...known, ...extra }
    if (opts.temperature !== undefined) options.temperature = opts.temperature
    if (opts.max_tokens !== undefined) options.num_predict = opts.max_tokens
    if (opts.stop) options.stop = opts.stop
    const numCtx = opts.num_ctx ?? (typeof known.num_ctx === 'number' ? known.num_ctx : undefined) ?? (typeof connOptions.num_ctx === 'number' ? connOptions.num_ctx : undefined) ?? this.spec.ctx_len
    options.num_ctx = numCtx
    const think = opts.reasoning !== undefined ? ollamaThink(this.spec.model, opts.reasoning) : (connThink ?? false)
    return { model: this.spec.model, messages, stream, think, options }
  }

  async generate(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    const stream = typeof opts.onToken === 'function'
    const body = this.buildBody(messages, opts)
    const t0 = now()
    const res = await request(
      this.fetchImpl,
      `${this.base}/api/chat`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: opts.signal, timeout_ms: this.spec.timeout_ms ?? 600_000 },
      this.key,
    )

    let text = ''
    let last: OllamaChunk = {}
    if (!stream) {
      last = (await res.json()) as OllamaChunk
      if (last.error) throw new ProviderError(`${this.spec.name}: ${last.error}`)
      text = last.message?.content ?? ''
    } else {
      for await (const line of readLines(res)) {
        let chunk: OllamaChunk
        try {
          chunk = JSON.parse(line) as OllamaChunk
        } catch {
          continue
        }
        if (chunk.error) throw new ProviderError(`${this.spec.name}: ${chunk.error}`)
        const piece = chunk.message?.content
        if (piece) {
          text += piece
          opts.onToken?.(piece)
        }
        last = chunk
        if (chunk.done) break
      }
    }
    return {
      text,
      model: last.model ?? this.spec.model,
      usage: { prompt_tokens: last.prompt_eval_count, completion_tokens: last.eval_count },
      finish_reason: last.done_reason,
      elapsed_ms: Math.round(now() - t0),
    }
  }

  async listModels(): Promise<string[]> {
    const res = await request(this.fetchImpl, `${this.base}/api/tags`, { headers: this.headers(), timeout_ms: 15_000 }, this.key)
    const data = (await res.json()) as { models?: Array<{ name?: string }> }
    return (data.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string').sort()
  }

  async health(): Promise<HealthResult> {
    const t0 = now()
    try {
      const models = await this.listModels()
      const known = models.includes(this.spec.model)
      return {
        ok: true,
        latency_ms: Math.round(now() - t0),
        detail: known ? `${models.length} model(s) available` : `reachable, but '${this.spec.model}' is not pulled (${models.length} model(s) available)`,
      }
    } catch (e) {
      return { ok: false, latency_ms: Math.round(now() - t0), detail: e instanceof Error ? e.message : String(e) }
    }
  }

  /** POST /api/show: capabilities (thinking?), modelfile parameter defaults, and the architecture's context length. */
  async describeModel(): Promise<ModelInfo> {
    const info: ModelInfo = {
      model: this.spec.model,
      api_type: 'ollama',
      flavor: 'ollama',
      reasoning: { supported: 'unknown', settings: ['off', 'on'], default_enabled: true, note: 'Ollama did not report capabilities; thinking is sent as off unless you turn it on.' },
      parameters: PRESET_PARAMS.ollama.map((d) => ({ ...d })),
      defaults: {},
      source: 'preset (Ollama options)',
      notes: [],
    }
    let show: OllamaShow | null = null
    try {
      const res = await request(this.fetchImpl, `${this.base}/api/show`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ model: this.spec.model }), timeout_ms: 15_000 }, this.key)
      show = (await res.json()) as OllamaShow
    } catch (e) {
      info.notes.push(`Could not read /api/show: ${e instanceof Error ? e.message : String(e)}`)
      return info
    }
    info.source = 'ollama /api/show'
    info.capabilities = show.capabilities ?? []
    const thinks = (show.capabilities ?? []).includes('thinking')
    info.reasoning = thinks
      ? { supported: true, settings: LEVEL_MODELS.test(this.spec.model) ? ['off', 'on', 'low', 'medium', 'high'] : ['off', 'on'], default_enabled: true, note: LEVEL_MODELS.test(this.spec.model) ? 'This model takes thinking levels.' : 'This model thinks when asked; levels are not distinguished, so low/medium/high all mean on.' }
      : { supported: false, settings: ['off'], default_enabled: false, note: 'This model does not report a thinking capability.' }
    info.defaults = parseOllamaParameters(show.parameters)
    const mi = show.model_info ?? {}
    for (const [k, v] of Object.entries(mi)) {
      if (k.endsWith('.context_length') && typeof v === 'number') info.context_length = v
    }
    info.parameters = PRESET_PARAMS.ollama.map((d) => {
      const out = { ...d, source: 'backend' as const }
      const dv = info.defaults[d.key]
      if (dv !== undefined && (typeof dv === 'number' || typeof dv === 'string' || typeof dv === 'boolean')) out.default = dv as ParamValue
      if (d.key === 'num_ctx') {
        out.default = this.spec.ctx_len
        if (info.context_length) out.max = info.context_length
      }
      return out
    })
    if (info.context_length && this.spec.ctx_len > info.context_length) {
      info.notes.push(`Your connection's context length (${this.spec.ctx_len.toLocaleString()}) exceeds what this model was trained for (${info.context_length.toLocaleString()}).`)
    }
    if (show.details?.parameter_size) info.notes.push(`${show.details.family ?? ''} ${show.details.parameter_size} ${show.details.quantization_level ?? ''}`.trim())
    return info
  }
}

registerProvider('ollama', (spec, key, f) => new OllamaProvider(spec, key, f))

export type { OllamaShow }
