/**
 * shared/providers/openai.ts — the OpenAI-compatible chat/completions family.
 *
 * Serves OpenAI, OpenRouter, vLLM and llama.cpp's server: all speak
 * POST {base_url}/chat/completions with a bearer token (optional for local
 * servers) and SSE streaming with `data: {...}` / `data: [DONE]`.
 *
 * Where the dialects differ — model discovery and how reasoning is switched
 * on and off — the connection's `flavor` decides:
 *
 *   openrouter  GET /models → supported_parameters, context_length, reasoning descriptor
 *               reasoning: { effort } | { enabled: false }
 *   openai      GET /models has no metadata; reasoning models take reasoning_effort
 *               and max_completion_tokens, and reject sampling parameters
 *   vllm        GET /models → max_model_len; reasoning via chat_template_kwargs.enable_thinking
 *   llamacpp    GET /props → n_ctx + default params; reasoning via chat_template_kwargs
 *               and reasoning_effort
 *   generic     curated OpenAI parameters; nothing reasoning-related is sent unless asked
 */

import { ProviderError } from '../types.ts'
import type { ChatMessage, ConnectionSpec, GenerateOptions, GenerateResult, HealthResult, ModelInfo, ParamDescriptor, ParamValue, Provider, ProviderFlavor, ReasoningSetting } from '../types.ts'
import { type FetchLike, now, readLines, request, trimBase, tryGetJson } from './http.ts'
import { OPENAI_STYLE, OPENROUTER_PARAM_MAP, PRESET_PARAMS, routeParams } from './params.ts'
import { registerProvider } from './registry.ts'

interface ChatChunk {
  choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  model?: string
  error?: { message?: string }
}

interface OpenRouterModel {
  id: string
  context_length?: number
  supported_parameters?: string[]
  default_parameters?: Record<string, unknown>
  top_provider?: { context_length?: number; max_completion_tokens?: number }
  reasoning?: { mandatory?: boolean; default_enabled?: boolean; default_effort?: string; supported_efforts?: string[] } | null
}

/** OpenAI's reasoning families (o-series, GPT-5 …): reasoning_effort, max_completion_tokens, no sampling knobs. */
const OPENAI_REASONING = /^(o[1-9]|gpt-5|gpt-oss)/i
/** GPT-5.1 and later accept reasoning_effort "none". */
const OPENAI_EFFORT_NONE = /^gpt-5\.[1-9]/i

const cache = new Map<string, { at: number; data: OpenRouterModel[] }>()

export class OpenAICompatibleProvider implements Provider {
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

  get flavor(): ProviderFlavor {
    return this.spec.flavor ?? 'generic'
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(this.spec.headers ?? {}) }
    if (this.key) h['authorization'] = `Bearer ${this.key}`
    return h
  }

  /** The request body for one call. Tests inspect this through a fake fetch. */
  buildBody(messages: ChatMessage[], opts: GenerateOptions): Record<string, unknown> {
    const stream = typeof opts.onToken === 'function'
    const flavor = this.flavor
    const reasoningModel = flavor === 'openai' && OPENAI_REASONING.test(this.spec.model)
    const { known, extra } = routeParams(opts.params, Object.values(OPENAI_STYLE))
    const body: Record<string, unknown> = {
      model: this.spec.model,
      messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(this.spec.options ?? {}),
      ...known,
      ...extra,
    }
    // OpenAI reasoning models reject sampling parameters outright; drop them rather than 400.
    if (!reasoningModel && opts.temperature !== undefined) body.temperature = opts.temperature
    if (reasoningModel) for (const k of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'logit_bias']) delete body[k]
    if (opts.max_tokens !== undefined) {
      if (flavor === 'openai') body.max_completion_tokens = opts.max_tokens
      else body.max_tokens = opts.max_tokens
    }
    if (opts.stop) body.stop = opts.stop
    Object.assign(body, this.reasoningFields(opts.reasoning ?? 'off', reasoningModel))
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k]
    return body
  }

  /** Map the normalized reasoning setting to this dialect's wire fields. */
  reasoningFields(r: ReasoningSetting, reasoningModel: boolean): Record<string, unknown> {
    const level = r === 'on' ? undefined : r === 'off' ? 'none' : r
    switch (this.flavor) {
      case 'openrouter':
        // Unified reasoning object. `enabled:false` is the documented off switch; ignored where reasoning is mandatory.
        if (r === 'off') return { reasoning: { enabled: false } }
        return { reasoning: level ? { effort: level } : { enabled: true } }
      case 'openai':
        if (!reasoningModel) return {}
        if (r === 'off') return { reasoning_effort: OPENAI_EFFORT_NONE.test(this.spec.model) ? 'none' : 'minimal' }
        return level ? { reasoning_effort: level } : {}
      case 'vllm':
        return { chat_template_kwargs: { enable_thinking: r !== 'off' } }
      case 'llamacpp':
        if (r === 'off') return { chat_template_kwargs: { enable_thinking: false } }
        return { chat_template_kwargs: { enable_thinking: true }, ...(level ? { reasoning_effort: level } : {}) }
      default:
        // Unknown server: never send reasoning fields unless the user asked for reasoning explicitly.
        if (r === 'off' || r === 'on') return {}
        return { reasoning_effort: level }
    }
  }

  async generate(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    const stream = typeof opts.onToken === 'function'
    const body = this.buildBody(messages, opts)
    const t0 = now()
    const res = await request(
      this.fetchImpl,
      `${this.base}/chat/completions`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: opts.signal, timeout_ms: this.spec.timeout_ms },
      this.key,
    )

    if (!stream) {
      const data = (await res.json()) as ChatChunk
      const text = data.choices?.[0]?.message?.content
      if (typeof text !== 'string') throw new ProviderError(`Malformed response from ${this.spec.name}: no choices[0].message.content`)
      return {
        text,
        model: data.model ?? this.spec.model,
        usage: data.usage,
        finish_reason: data.choices?.[0]?.finish_reason ?? undefined,
        elapsed_ms: Math.round(now() - t0),
      }
    }

    let text = ''
    let usage: GenerateResult['usage']
    let finish: string | undefined
    let model = this.spec.model
    for await (const line of readLines(res)) {
      if (line === '[DONE]') break
      let chunk: ChatChunk
      try {
        chunk = JSON.parse(line) as ChatChunk
      } catch {
        continue // keep-alive noise or a partial frame; ignore
      }
      if (chunk.error?.message) throw new ProviderError(`${this.spec.name}: ${chunk.error.message}`)
      if (chunk.model) model = chunk.model
      if (chunk.usage) usage = chunk.usage
      const choice = chunk.choices?.[0]
      const delta = choice?.delta?.content
      if (delta) {
        text += delta
        opts.onToken?.(delta)
      }
      if (choice?.finish_reason) finish = choice.finish_reason
    }
    return { text, model, usage, finish_reason: finish, elapsed_ms: Math.round(now() - t0) }
  }

  async listModels(): Promise<string[]> {
    const res = await request(this.fetchImpl, `${this.base}/models`, { headers: this.headers(), timeout_ms: 15_000 }, this.key)
    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').sort()
  }

  async health(): Promise<HealthResult> {
    const t0 = now()
    try {
      const models = await this.listModels()
      const known = models.length === 0 || models.includes(this.spec.model)
      return {
        ok: true,
        latency_ms: Math.round(now() - t0),
        detail: known ? `${models.length} model(s) listed` : `reachable, but '${this.spec.model}' is not in the model list`,
      }
    } catch (e) {
      return { ok: false, latency_ms: Math.round(now() - t0), detail: e instanceof Error ? e.message : String(e) }
    }
  }

  async describeModel(): Promise<ModelInfo> {
    const flavor = this.flavor
    const base: ModelInfo = {
      model: this.spec.model,
      api_type: 'openai',
      flavor,
      reasoning: { supported: 'unknown', settings: ['off', 'on', 'low', 'medium', 'high'], note: 'This server does not describe reasoning support; settings other than off are sent only when you choose them.' },
      parameters: PRESET_PARAMS[flavor].map((d) => ({ ...d })),
      defaults: {},
      source: `preset (${flavor})`,
      notes: [],
    }
    switch (flavor) {
      case 'openrouter':
        return this.describeOpenRouter(base)
      case 'openai':
        return this.describeOpenAI(base)
      case 'vllm':
        return this.describeVllm(base)
      case 'llamacpp':
        return this.describeLlamaCpp(base)
      default:
        return this.describeGeneric(base)
    }
  }

  private async openRouterModels(): Promise<OpenRouterModel[] | null> {
    const url = `${this.base}/models`
    const hit = cache.get(url)
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data
    const data = await tryGetJson<{ data?: OpenRouterModel[] }>(this.fetchImpl, url, this.headers(), this.key)
    if (!data?.data) return null
    cache.set(url, { at: Date.now(), data: data.data })
    return data.data
  }

  private async describeOpenRouter(info: ModelInfo): Promise<ModelInfo> {
    const models = await this.openRouterModels()
    const m = models?.find((x) => x.id === this.spec.model)
    if (!m) {
      info.notes.push(models ? `'${this.spec.model}' is not in OpenRouter's model list; showing the generic OpenRouter knobs.` : 'Could not read OpenRouter\'s model list.')
      return info
    }
    info.source = 'openrouter /api/v1/models'
    info.context_length = m.context_length ?? m.top_provider?.context_length
    info.max_output_tokens = m.top_provider?.max_completion_tokens
    const supported = m.supported_parameters ?? []
    info.parameters = supported
      .map((k) => OPENROUTER_PARAM_MAP[k])
      .filter((d): d is ParamDescriptor => Boolean(d))
      .map((d) => ({ ...d, source: 'backend' as const }))
    for (const [k, v] of Object.entries(m.default_parameters ?? {})) {
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') info.defaults[k] = v as ParamValue
    }
    for (const d of info.parameters) if (info.defaults[d.key] !== undefined) d.default = info.defaults[d.key]
    const r = m.reasoning
    if (!supported.includes('reasoning') || !r) {
      info.reasoning = { supported: false, settings: ['off'], default_enabled: false, note: 'OpenRouter lists no reasoning support for this model.' }
    } else {
      const efforts = r.supported_efforts ?? []
      const settings: ReasoningSetting[] = r.mandatory ? [] : ['off']
      settings.push('on')
      for (const lvl of ['low', 'medium', 'high'] as const) if (efforts.length === 0 || efforts.includes(lvl)) settings.push(lvl)
      info.reasoning = {
        supported: true,
        mandatory: Boolean(r.mandatory),
        default_enabled: r.default_enabled ?? Boolean(r.mandatory),
        settings,
        note: r.mandatory ? 'This model always reasons; it cannot be switched off.' : r.default_enabled ? 'Reasons by default; Turbine sends off unless you choose otherwise.' : 'Reasoning is available but off by default.',
      }
    }
    return info
  }

  private async describeOpenAI(info: ModelInfo): Promise<ModelInfo> {
    info.source = 'preset (OpenAI dialect) + /v1/models'
    const reasoningModel = OPENAI_REASONING.test(this.spec.model)
    if (reasoningModel) {
      info.parameters = [OPENAI_STYLE.seed].map((d) => ({ ...d }))
      const offNote = OPENAI_EFFORT_NONE.test(this.spec.model) ? 'off sends reasoning_effort "none".' : 'This model cannot fully disable reasoning; off sends the lowest effort ("minimal").'
      info.reasoning = { supported: true, mandatory: !OPENAI_EFFORT_NONE.test(this.spec.model), default_enabled: true, settings: ['off', 'on', 'low', 'medium', 'high'], note: `${offNote} Sampling parameters are not accepted by reasoning models and are not sent.` }
    } else {
      info.reasoning = { supported: false, settings: ['off'], default_enabled: false, note: 'Not a reasoning model.' }
    }
    const list = await tryGetJson<{ data?: Array<{ id: string }> }>(this.fetchImpl, `${this.base}/models`, this.headers(), this.key)
    if (list?.data && !list.data.some((x) => x.id === this.spec.model)) info.notes.push(`'${this.spec.model}' is not in this account's model list.`)
    return info
  }

  private async describeVllm(info: ModelInfo): Promise<ModelInfo> {
    const list = await tryGetJson<{ data?: Array<{ id: string; max_model_len?: number }> }>(this.fetchImpl, `${this.base}/models`, this.headers(), this.key)
    const m = list?.data?.find((x) => x.id === this.spec.model) ?? list?.data?.[0]
    if (m?.max_model_len) {
      info.context_length = m.max_model_len
      info.source = 'vllm /v1/models (max_model_len)'
    }
    info.reasoning = { supported: 'unknown', settings: ['off', 'on'], note: 'Sent as chat_template_kwargs.enable_thinking, which Qwen3-style templates honor; other templates ignore it.' }
    if (info.context_length && this.spec.ctx_len > info.context_length) info.notes.push(`Your connection's context length (${this.spec.ctx_len.toLocaleString()}) exceeds the server's max_model_len (${info.context_length.toLocaleString()}); requests beyond it will be rejected.`)
    return info
  }

  private async describeLlamaCpp(info: ModelInfo): Promise<ModelInfo> {
    const rootBase = this.base.replace(/\/v1$/, '')
    const props = await tryGetJson<{ default_generation_settings?: { n_ctx?: number; params?: Record<string, unknown> } }>(this.fetchImpl, `${rootBase}/props`, this.headers(), this.key)
    if (props?.default_generation_settings) {
      info.source = 'llama.cpp /props'
      info.context_length = props.default_generation_settings.n_ctx
      const map: Record<string, string> = { temperature: 'temperature', top_k: 'top_k', top_p: 'top_p', min_p: 'min_p', repeat_penalty: 'repetition_penalty', seed: 'seed' }
      for (const [srcKey, ourKey] of Object.entries(map)) {
        const v = props.default_generation_settings.params?.[srcKey]
        if (typeof v === 'number') info.defaults[ourKey] = v
      }
      for (const d of info.parameters) if (info.defaults[d.key] !== undefined) d.default = info.defaults[d.key]
    }
    info.reasoning = { supported: 'unknown', settings: ['off', 'on', 'low', 'medium', 'high'], note: 'Sent as chat_template_kwargs.enable_thinking plus reasoning_effort for levels; effective only for templates that support thinking.' }
    if (info.context_length && this.spec.ctx_len > info.context_length) info.notes.push(`The server was started with a ${info.context_length.toLocaleString()}-token context (-c); your connection assumes ${this.spec.ctx_len.toLocaleString()}.`)
    return info
  }

  private async describeGeneric(info: ModelInfo): Promise<ModelInfo> {
    const list = await tryGetJson<{ data?: Array<{ id: string; max_model_len?: number; context_length?: number }> }>(this.fetchImpl, `${this.base}/models`, this.headers(), this.key)
    const m = list?.data?.find((x) => x.id === this.spec.model)
    const ctx = m?.max_model_len ?? m?.context_length
    if (ctx) {
      info.context_length = ctx
      info.source = 'generic /v1/models'
    }
    return info
  }
}

registerProvider('openai', (spec, key, f) => new OpenAICompatibleProvider(spec, key, f))

