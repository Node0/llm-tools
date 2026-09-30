/**
 * shared/providers/anthropic.ts — Anthropic Messages API.
 *
 * System prompt rides in the top-level `system` field, not the messages array.
 * Streaming is SSE with typed events; we only need content_block_delta,
 * message_delta (usage + stop_reason) and error.
 *
 * Reasoning maps onto the `thinking` parameter, whose shape depends on the
 * model generation:
 *   4.6 and newer   thinking: { type: 'adaptive' } + output_config.effort for levels;
 *                   off is { type: 'disabled' } where accepted, { type: 'between_tools' }
 *                   on Sonnet 5.5, and simply omitted on models that always think
 *   Haiku 4.5, 4.5 and older   thinking: { type: 'enabled', budget_tokens } / omitted for off
 * Sampling knobs (temperature, top_p, top_k) are rejected by 4.7 and newer, so
 * they are only sent to older generations.
 */

import { ProviderError } from '../types.ts'
import type { ChatMessage, ConnectionSpec, GenerateOptions, GenerateResult, HealthResult, ModelInfo, Provider, ReasoningSetting } from '../types.ts'
import { type FetchLike, now, readLines, request, trimBase, tryGetJson } from './http.ts'
import { OPENAI_STYLE, routeParams } from './params.ts'
import { registerProvider } from './registry.ts'

interface AnthropicEvent {
  type?: string
  delta?: { type?: string; text?: string; stop_reason?: string }
  message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } }
  usage?: { input_tokens?: number; output_tokens?: number }
  content?: Array<{ type?: string; text?: string }>
  model?: string
  stop_reason?: string
  error?: { message?: string }
}

export interface AnthropicFamily {
  /** Thinking is configured with adaptive + effort (4.6+) rather than a token budget. */
  adaptive: boolean
  /** How "off" is expressed. */
  off: 'disabled' | 'between_tools' | 'omit' | 'always'
  /** Whether temperature / top_p / top_k are accepted at all. */
  sampling: boolean
  label: string
}

/** Classify a model id into the generation that decides the thinking and sampling wire format. */
export function anthropicFamily(model: string): AnthropicFamily {
  const m = model.toLowerCase()
  if (/claude-(fable|mythos)/.test(m)) return { adaptive: true, off: 'always', sampling: false, label: 'Fable/Mythos: thinking is always on; depth via effort' }
  if (/claude-opus-5-5/.test(m)) return { adaptive: true, off: 'always', sampling: false, label: 'Opus 5.5: thinking is always on; depth via effort' }
  if (/claude-sonnet-5-5/.test(m)) return { adaptive: true, off: 'between_tools', sampling: false, label: 'Sonnet 5.5: off sends thinking.type=between_tools' }
  if (/claude-(opus-5|opus-4-8|opus-4-7|sonnet-5)(?![.\d-]*5)/.test(m) || /claude-(opus-5|opus-4-[78]|sonnet-5)($|-\d{8}|$)/.test(m)) return { adaptive: true, off: 'disabled', sampling: false, label: 'adaptive thinking; sampling parameters are rejected' }
  if (/claude-(opus|sonnet)-4-6/.test(m)) return { adaptive: true, off: 'disabled', sampling: true, label: '4.6: adaptive thinking; sampling still accepted' }
  return { adaptive: false, off: 'omit', sampling: true, label: 'budget_tokens generation' }
}

const BUDGETS: Record<Exclude<ReasoningSetting, 'off'>, number> = { on: 4096, low: 2048, medium: 8192, high: 24576 }

export class AnthropicProvider implements Provider {
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
    return {
      'content-type': 'application/json',
      'anthropic-version': this.spec.anthropic_version ?? '2023-06-01',
      // Required for calling Anthropic straight from a browser (browser-run jobs).
      'anthropic-dangerous-direct-browser-access': 'true',
      ...(this.spec.headers ?? {}),
      ...(this.key ? { 'x-api-key': this.key } : {}),
    }
  }

  /** The request body for one call. Tests inspect this through a fake fetch. */
  buildBody(messages: ChatMessage[], opts: GenerateOptions): Record<string, unknown> {
    const stream = typeof opts.onToken === 'function'
    const fam = anthropicFamily(this.spec.model)
    const r: ReasoningSetting = opts.reasoning ?? 'off'
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const turns = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))
    const { known, extra } = routeParams(opts.params, [OPENAI_STYLE.temperature, OPENAI_STYLE.top_p, OPENAI_STYLE.top_k])
    let maxTokens = opts.max_tokens ?? 1024
    const body: Record<string, unknown> = {
      model: this.spec.model,
      messages: turns,
      stream,
      ...(system ? { system } : {}),
      ...(opts.stop ? { stop_sequences: opts.stop } : {}),
      ...(this.spec.options ?? {}),
      ...extra,
    }
    // Thinking
    if (fam.adaptive) {
      if (r === 'off') {
        if (fam.off === 'disabled') body.thinking = { type: 'disabled' }
        else if (fam.off === 'between_tools') body.thinking = { type: 'between_tools' }
        // 'always': omit — the model thinks regardless; lowest effort keeps it short.
        if (fam.off === 'always') body.output_config = { effort: 'low' }
      } else {
        body.thinking = { type: 'adaptive' }
        if (r !== 'on') body.output_config = { effort: r }
      }
    } else if (r !== 'off') {
      const budget = BUDGETS[r]
      if (maxTokens <= budget) maxTokens = budget + 1024
      body.thinking = { type: 'enabled', budget_tokens: budget }
    }
    body.max_tokens = maxTokens
    // Sampling: only where the generation accepts it, and never alongside a thinking budget (temperature must be 1 there).
    const thinkingOn = body.thinking !== undefined && (body.thinking as { type: string }).type !== 'disabled' && (body.thinking as { type: string }).type !== 'between_tools'
    if (fam.sampling && !(thinkingOn && !fam.adaptive)) {
      if (opts.temperature !== undefined) body.temperature = opts.temperature
      Object.assign(body, known)
    }
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k]
    return body
  }

  async generate(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    const stream = typeof opts.onToken === 'function'
    const body = this.buildBody(messages, opts)
    const t0 = now()
    const res = await request(
      this.fetchImpl,
      `${this.base}/v1/messages`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: opts.signal, timeout_ms: this.spec.timeout_ms },
      this.key,
    )

    if (!stream) {
      const data = (await res.json()) as AnthropicEvent
      const text = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
      return {
        text,
        model: data.model ?? this.spec.model,
        usage: { prompt_tokens: data.usage?.input_tokens, completion_tokens: data.usage?.output_tokens },
        finish_reason: data.stop_reason,
        elapsed_ms: Math.round(now() - t0),
      }
    }

    let text = ''
    let model = this.spec.model
    let input: number | undefined
    let output: number | undefined
    let stop: string | undefined
    for await (const line of readLines(res)) {
      let ev: AnthropicEvent
      try {
        ev = JSON.parse(line) as AnthropicEvent
      } catch {
        continue
      }
      switch (ev.type) {
        case 'message_start':
          model = ev.message?.model ?? model
          input = ev.message?.usage?.input_tokens
          break
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            text += ev.delta.text
            opts.onToken?.(ev.delta.text)
          }
          break
        case 'message_delta':
          output = ev.usage?.output_tokens ?? output
          stop = ev.delta?.stop_reason ?? stop
          break
        case 'error':
          throw new ProviderError(`${this.spec.name}: ${ev.error?.message ?? 'stream error'}`)
        default:
          break
      }
    }
    return { text, model, usage: { prompt_tokens: input, completion_tokens: output }, finish_reason: stop, elapsed_ms: Math.round(now() - t0) }
  }

  async listModels(): Promise<string[]> {
    const res = await request(this.fetchImpl, `${this.base}/v1/models?limit=100`, { headers: this.headers(), timeout_ms: 15_000 }, this.key)
    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').sort()
  }

  async health(): Promise<HealthResult> {
    const t0 = now()
    try {
      const models = await this.listModels()
      return { ok: true, latency_ms: Math.round(now() - t0), detail: `${models.length} model(s) listed` }
    } catch (e) {
      return { ok: false, latency_ms: Math.round(now() - t0), detail: e instanceof Error ? e.message : String(e) }
    }
  }

  /** GET /v1/models/{id}: context window and output cap; thinking/sampling rules from the model generation. */
  async describeModel(): Promise<ModelInfo> {
    const fam = anthropicFamily(this.spec.model)
    const info: ModelInfo = {
      model: this.spec.model,
      api_type: 'anthropic',
      flavor: 'anthropic',
      reasoning: fam.off === 'always'
        ? { supported: true, mandatory: true, default_enabled: true, settings: ['on', 'low', 'medium', 'high'], note: `${fam.label}. "off" is not available; low effort is the closest.` }
        : fam.adaptive
          ? { supported: true, mandatory: false, default_enabled: fam.off !== 'disabled', settings: ['off', 'on', 'low', 'medium', 'high'], note: fam.label }
          : { supported: true, mandatory: false, default_enabled: false, settings: ['off', 'on', 'low', 'medium', 'high'], note: `${fam.label}: levels become budget_tokens (2k / 4k / 8k / 24k).` },
      parameters: fam.sampling ? [OPENAI_STYLE.temperature, OPENAI_STYLE.top_p, OPENAI_STYLE.top_k].map((d) => ({ ...d })) : [],
      defaults: {},
      source: 'preset (Anthropic model generation rules)',
      notes: fam.sampling ? [] : ['This generation rejects temperature, top_p and top_k; they are not sent.'],
    }
    const m = await tryGetJson<{ id?: string; max_input_tokens?: number; max_tokens?: number; capabilities?: unknown }>(this.fetchImpl, `${this.base}/v1/models/${encodeURIComponent(this.spec.model)}`, this.headers(), this.key)
    if (m?.id) {
      info.source = 'anthropic /v1/models + generation rules'
      if (typeof m.max_input_tokens === 'number') info.context_length = m.max_input_tokens
      if (typeof m.max_tokens === 'number') info.max_output_tokens = m.max_tokens
      if (Array.isArray(m.capabilities)) info.capabilities = m.capabilities.map(String)
    }
    return info
  }
}

registerProvider('anthropic', (spec, key, f) => new AnthropicProvider(spec, key, f))
