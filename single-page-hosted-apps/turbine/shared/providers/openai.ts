/**
 * shared/providers/openai.ts — the OpenAI-compatible chat/completions backend.
 *
 * Serves OpenAI, OpenRouter, vLLM and llama.cpp's server: all speak
 * POST {base_url}/chat/completions with a bearer token (optional for local
 * servers) and SSE streaming with `data: {...}` / `data: [DONE]`.
 */

import { ProviderError } from '../types.ts'
import type { ChatMessage, ConnectionSpec, GenerateOptions, GenerateResult, HealthResult, Provider } from '../types.ts'
import { type FetchLike, now, readLines, request, trimBase } from './http.ts'
import { registerProvider } from './registry.ts'

interface ChatChunk {
  choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  model?: string
  error?: { message?: string }
}

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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(this.spec.headers ?? {}) }
    if (this.key) h['authorization'] = `Bearer ${this.key}`
    return h
  }

  async generate(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    const stream = typeof opts.onToken === 'function'
    const body: Record<string, unknown> = {
      model: this.spec.model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
      stop: opts.stop,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(this.spec.options ?? {}),
    }
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k]

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
}

registerProvider('openai', (spec, key, f) => new OpenAICompatibleProvider(spec, key, f))
