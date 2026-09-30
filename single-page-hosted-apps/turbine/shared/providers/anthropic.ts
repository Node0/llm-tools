/**
 * shared/providers/anthropic.ts — Anthropic Messages API.
 *
 * System prompt rides in the top-level `system` field, not the messages array.
 * Streaming is SSE with typed events; we only need content_block_delta,
 * message_delta (usage + stop_reason) and error.
 */

import { ProviderError } from '../types.ts'
import type { ChatMessage, ConnectionSpec, GenerateOptions, GenerateResult, HealthResult, Provider } from '../types.ts'
import { type FetchLike, now, readLines, request, trimBase } from './http.ts'
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

  async generate(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    const stream = typeof opts.onToken === 'function'
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const turns = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))
    const body: Record<string, unknown> = {
      model: this.spec.model,
      max_tokens: opts.max_tokens ?? 1024,
      messages: turns,
      stream,
      ...(system ? { system } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.stop ? { stop_sequences: opts.stop } : {}),
      ...(this.spec.options ?? {}),
    }

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
}

registerProvider('anthropic', (spec, key, f) => new AnthropicProvider(spec, key, f))
