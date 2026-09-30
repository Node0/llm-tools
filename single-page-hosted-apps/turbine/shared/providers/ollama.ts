/**
 * shared/providers/ollama.ts — Ollama's native /api/chat.
 *
 * Native rather than Ollama's OpenAI shim so `num_ctx` and the rest of the
 * `options` block are honored — that matters for 32k+ windows on a Mac.
 * Streaming is NDJSON, one JSON object per line, `done: true` on the last.
 */

import { ProviderError } from '../types.ts'
import type { ChatMessage, ConnectionSpec, GenerateOptions, GenerateResult, HealthResult, Provider } from '../types.ts'
import { type FetchLike, now, readLines, request, trimBase } from './http.ts'
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

  async generate(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    const stream = typeof opts.onToken === 'function'
    const options: Record<string, unknown> = { ...(this.spec.options ?? {}) }
    // Thinking models (qwen3.x, gemma4, …) put their reasoning in message.thinking and can
    // exhaust num_predict before emitting content. Turbine wants the transformation, not the
    // deliberation, so thinking is OFF unless the connection's options say { think: true }.
    const think = typeof options.think === 'boolean' ? options.think : false
    delete options.think
    if (opts.temperature !== undefined) options.temperature = opts.temperature
    if (opts.max_tokens !== undefined) options.num_predict = opts.max_tokens
    if (opts.num_ctx !== undefined) options.num_ctx = opts.num_ctx
    if (opts.stop) options.stop = opts.stop

    const body = { model: this.spec.model, messages, stream, think, options }
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
}

registerProvider('ollama', (spec, key, f) => new OllamaProvider(spec, key, f))
