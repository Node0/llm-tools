/**
 * Wire-format tests: what each provider actually puts on the wire for a
 * normalized reasoning setting + params bag, and how discovery parses real
 * endpoint shapes. A fake fetch captures request bodies; no network.
 */
import { describe, expect, it } from 'bun:test'
import { AnthropicProvider, OllamaProvider, OpenAICompatibleProvider, anthropicFamily, normalizeConnection, ollamaThink, parseOllamaParameters, sanitizeParams } from '../../shared/providers/index.ts'
import type { ConnectionSpec } from '../../shared/types.ts'

type Captured = { url: string; body: Record<string, unknown> | null; headers: Record<string, string> }

function fakeFetch(routes: Record<string, unknown>, captured: Captured[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    captured.push({ url, body, headers: (init?.headers as Record<string, string>) ?? {} })
    const key = Object.keys(routes).find((k) => url.endsWith(k) || url.includes(k))
    if (!key) return new Response(JSON.stringify({ error: { message: `no route for ${url}` } }), { status: 404 })
    const payload = routes[key]
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const conn = (over: Partial<ConnectionSpec> & { api_type: ConnectionSpec['api_type']; base_url: string; name?: string }): ConnectionSpec =>
  normalizeConnection({ name: over.name ?? over.api_type, model: 'm', ctx_len: 32768, ...over })

const msgs = [{ role: 'system' as const, content: 'S' }, { role: 'user' as const, content: 'U' }]

describe('Ollama wire format', () => {
  it('sends num_ctx from the connection, think=false by default, and routes params into options', async () => {
    const cap: Captured[] = []
    const p = new OllamaProvider(conn({ api_type: 'ollama', base_url: 'http://localhost:11434', model: 'qwen3.6:35b', ctx_len: 65536 }), null,
      fakeFetch({ '/api/chat': { message: { content: 'ok' }, done: true, eval_count: 1, prompt_eval_count: 2 } }, cap))
    await p.generate(msgs, { temperature: 0.1, max_tokens: 64, params: { top_p: 0.9, min_p: 0.05, seed: 7, custom_knob: 3 } })
    const b = cap[0].body!
    expect(b.think).toBe(false)
    expect(b.options).toMatchObject({ num_ctx: 65536, temperature: 0.1, num_predict: 64, top_p: 0.9, min_p: 0.05, seed: 7, custom_knob: 3 })
  })
  it('lets an explicit num_ctx or a num_ctx knob override the connection', async () => {
    const cap: Captured[] = []
    const p = new OllamaProvider(conn({ api_type: 'ollama', base_url: 'http://localhost:11434', model: 'gemma4', ctx_len: 65536 }), null,
      fakeFetch({ '/api/chat': { message: { content: 'ok' }, done: true } }, cap))
    await p.generate(msgs, { params: { num_ctx: 16384 } })
    expect((cap[0].body!.options as Record<string, unknown>).num_ctx).toBe(16384)
    await p.generate(msgs, { num_ctx: 8192, params: { num_ctx: 16384 } })
    expect((cap[1].body!.options as Record<string, unknown>).num_ctx).toBe(8192)
  })
  it('maps reasoning to think (levels only for gpt-oss)', () => {
    expect(ollamaThink('qwen3.6', 'off')).toBe(false)
    expect(ollamaThink('qwen3.6', 'on')).toBe(true)
    expect(ollamaThink('qwen3.6', 'high')).toBe(true)
    expect(ollamaThink('gpt-oss:20b', 'high')).toBe('high')
  })
  it('describeModel reads capabilities, modelfile defaults and context length from /api/show', async () => {
    const show = {
      parameters: 'top_p                          0.95\nmin_p                          0\npresence_penalty               1.5\nrepeat_penalty                 1\ntemperature                    1\ntop_k                          20\nstop                           "<|im_end|>"',
      capabilities: ['completion', 'vision', 'thinking', 'tools'],
      details: { family: 'qwen3_5_moe', parameter_size: '35B', quantization_level: 'mxfp8' },
      model_info: { 'general.architecture': 'qwen3_5_moe', 'qwen3_5_moe.context_length': 262144 },
    }
    const p = new OllamaProvider(conn({ api_type: 'ollama', base_url: 'http://localhost:11434', model: 'qwen3.6:35b', ctx_len: 65536 }), null, fakeFetch({ '/api/show': show }))
    const info = await p.describeModel()
    expect(info.source).toBe('ollama /api/show')
    expect(info.context_length).toBe(262144)
    expect(info.reasoning).toMatchObject({ supported: true, settings: ['off', 'on'] })
    expect(info.defaults).toMatchObject({ top_p: 0.95, temperature: 1, top_k: 20, presence_penalty: 1.5, stop: ['<|im_end|>'] })
    const numCtx = info.parameters.find((d) => d.key === 'num_ctx')!
    expect(numCtx.default).toBe(65536)
    expect(numCtx.max).toBe(262144)
    expect(info.parameters.find((d) => d.key === 'top_p')?.default).toBe(0.95)
  })
  it('describeModel degrades to the preset list when /api/show fails', async () => {
    const p = new OllamaProvider(conn({ api_type: 'ollama', base_url: 'http://localhost:11434', model: 'x' }), null, fakeFetch({}))
    const info = await p.describeModel()
    expect(info.source).toContain('preset')
    expect(info.parameters.length).toBeGreaterThan(5)
    expect(info.reasoning.supported).toBe('unknown')
  })
  it('parses ollama parameter text', () => {
    expect(parseOllamaParameters('num_ctx  4096\nuse_mmap true\nstop "a"\nstop "b"')).toEqual({ num_ctx: 4096, use_mmap: true, stop: ['a', 'b'] })
  })
})

describe('OpenAI-compatible wire format by flavor', () => {
  it('openrouter: reasoning off → { enabled:false }, levels → { effort }, params top-level, max_tokens', async () => {
    const cap: Captured[] = []
    const p = new OpenAICompatibleProvider(conn({ api_type: 'openai', name: 'openrouter', base_url: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-235b-a22b', requires_key: true }), 'sk-or-test',
      fakeFetch({ '/chat/completions': { choices: [{ message: { content: 'ok' } }] } }, cap))
    expect(p.flavor).toBe('openrouter')
    await p.generate(msgs, { temperature: 0.2, max_tokens: 100, params: { top_k: 40, repetition_penalty: 1.05 } })
    expect(cap[0].body).toMatchObject({ reasoning: { enabled: false }, max_tokens: 100, temperature: 0.2, top_k: 40, repetition_penalty: 1.05 })
    expect(cap[0].headers.authorization).toBe('Bearer sk-or-test')
    await p.generate(msgs, { reasoning: 'high' })
    expect(cap[1].body!.reasoning).toEqual({ effort: 'high' })
    await p.generate(msgs, { reasoning: 'on' })
    expect(cap[2].body!.reasoning).toEqual({ enabled: true })
  })
  it('openai: reasoning models get reasoning_effort + max_completion_tokens and lose sampling params', async () => {
    const cap: Captured[] = []
    const p = new OpenAICompatibleProvider(conn({ api_type: 'openai', name: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-5.1', requires_key: true }), 'k',
      fakeFetch({ '/chat/completions': { choices: [{ message: { content: 'ok' } }] } }, cap))
    await p.generate(msgs, { temperature: 0.2, max_tokens: 50, params: { top_p: 0.9, seed: 3 } })
    expect(cap[0].body).toMatchObject({ reasoning_effort: 'none', max_completion_tokens: 50, seed: 3 })
    expect(cap[0].body!.temperature).toBeUndefined()
    expect(cap[0].body!.top_p).toBeUndefined()
    expect(cap[0].body!.max_tokens).toBeUndefined()
    const p2 = new OpenAICompatibleProvider(conn({ api_type: 'openai', name: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', requires_key: true }), 'k',
      fakeFetch({ '/chat/completions': { choices: [{ message: { content: 'ok' } }] } }, cap))
    await p2.generate(msgs, { temperature: 0.2, max_tokens: 50 })
    expect(cap[1].body).toMatchObject({ temperature: 0.2, max_completion_tokens: 50 })
    expect(cap[1].body!.reasoning_effort).toBeUndefined()
  })
  it('vllm / llamacpp: chat_template_kwargs.enable_thinking; generic sends nothing for off', async () => {
    const cap: Captured[] = []
    const mk = (name: string, url: string) => new OpenAICompatibleProvider(conn({ api_type: 'openai', name, base_url: url, model: 'm' }), null, fakeFetch({ '/chat/completions': { choices: [{ message: { content: 'ok' } }] } }, cap))
    await mk('vllm', 'http://gpu.internal:8000/v1').generate(msgs, {})
    expect(cap[0].body!.chat_template_kwargs).toEqual({ enable_thinking: false })
    await mk('llamacpp', 'http://localhost:8080/v1').generate(msgs, { reasoning: 'medium' })
    expect(cap[1].body).toMatchObject({ chat_template_kwargs: { enable_thinking: true }, reasoning_effort: 'medium' })
    await mk('custom-openai', 'https://llm.example.com/v1').generate(msgs, {})
    expect(cap[2].body!.reasoning).toBeUndefined()
    expect(cap[2].body!.reasoning_effort).toBeUndefined()
    expect(cap[2].body!.chat_template_kwargs).toBeUndefined()
  })
  it('openrouter discovery uses supported_parameters, context_length and the reasoning descriptor', async () => {
    const list = { data: [
      { id: 'qwen/qwen3-235b-a22b-thinking-2507', context_length: 131072, supported_parameters: ['frequency_penalty', 'include_reasoning', 'logprobs', 'max_tokens', 'presence_penalty', 'reasoning', 'repetition_penalty', 'response_format', 'seed', 'stop', 'temperature', 'tool_choice', 'tools', 'top_k', 'top_logprobs', 'top_p'], top_provider: { context_length: 131072, max_completion_tokens: 117964 }, default_parameters: { temperature: null, top_p: null }, reasoning: { mandatory: false, default_enabled: true, default_effort: 'medium', supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'] } },
      { id: 'meta-llama/llama-3.3-70b-instruct', context_length: 131072, supported_parameters: ['max_tokens', 'min_p', 'repetition_penalty', 'seed', 'temperature', 'top_k', 'top_p'], top_provider: { max_completion_tokens: 16384 }, reasoning: null },
      { id: 'deepseek/deepseek-r1', context_length: 64000, supported_parameters: ['reasoning', 'temperature', 'top_k'], top_provider: {}, reasoning: { mandatory: true } },
    ] }
    const mk = (model: string) => new OpenAICompatibleProvider(conn({ api_type: 'openai', name: 'openrouter', base_url: 'https://openrouter.ai/api/v1', model, requires_key: true }), 'k', fakeFetch({ '/models': list }))
    const q = await mk('qwen/qwen3-235b-a22b-thinking-2507').describeModel()
    expect(q.source).toBe('openrouter /api/v1/models')
    expect(q.context_length).toBe(131072)
    expect(q.max_output_tokens).toBe(117964)
    expect(q.parameters.map((d) => d.key).sort()).toEqual(['frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed', 'temperature', 'top_k', 'top_p'])
    expect(q.reasoning).toMatchObject({ supported: true, mandatory: false, settings: ['off', 'on', 'low', 'medium', 'high'] })
    const l = await mk('meta-llama/llama-3.3-70b-instruct').describeModel()
    expect(l.reasoning).toMatchObject({ supported: false, settings: ['off'] })
    expect(l.parameters.map((d) => d.key)).toContain('min_p')
    const r = await mk('deepseek/deepseek-r1').describeModel()
    expect(r.reasoning).toMatchObject({ supported: true, mandatory: true })
    expect(r.reasoning.settings).not.toContain('off')
    const missing = await mk('nope/nothing').describeModel()
    expect(missing.source).toContain('preset')
    expect(missing.notes[0]).toContain('not in OpenRouter')
  })
  it('vllm discovery reads max_model_len', async () => {
    const p = new OpenAICompatibleProvider(conn({ api_type: 'openai', name: 'vllm', base_url: 'http://gpu.internal:8000/v1', model: 'llama' }), null, fakeFetch({ '/models': { data: [{ id: 'llama', max_model_len: 40960 }] } }))
    const info = await p.describeModel()
    expect(info.context_length).toBe(40960)
    expect(info.source).toContain('vllm')
  })
  it('llama.cpp discovery reads /props', async () => {
    const p = new OpenAICompatibleProvider(conn({ api_type: 'openai', name: 'llamacpp', base_url: 'http://localhost:8080/v1', model: 'gguf' }), null,
      fakeFetch({ '/props': { default_generation_settings: { n_ctx: 8192, params: { temperature: 0.8, top_k: 40, min_p: 0.05, repeat_penalty: 1.1, seed: -1 } } } }))
    const info = await p.describeModel()
    expect(info.context_length).toBe(8192)
    expect(info.defaults).toMatchObject({ temperature: 0.8, top_k: 40, repetition_penalty: 1.1 })
    expect(info.notes.some((n) => n.includes('-c'))).toBe(true) // 32768 > 8192
  })
})

describe('Anthropic wire format by generation', () => {
  it('classifies model ids', () => {
    expect(anthropicFamily('claude-opus-5-5')).toMatchObject({ adaptive: true, off: 'always', sampling: false })
    expect(anthropicFamily('claude-sonnet-5-5')).toMatchObject({ adaptive: true, off: 'between_tools' })
    expect(anthropicFamily('claude-opus-4-7')).toMatchObject({ adaptive: true, off: 'disabled', sampling: false })
    expect(anthropicFamily('claude-opus-4-6')).toMatchObject({ adaptive: true, off: 'disabled', sampling: true })
    expect(anthropicFamily('claude-haiku-4-5')).toMatchObject({ adaptive: false, off: 'omit', sampling: true })
    expect(anthropicFamily('claude-fable-5-1')).toMatchObject({ off: 'always' })
  })
  it('sends the right thinking shape and only sends sampling where accepted', async () => {
    const cap: Captured[] = []
    const mk = (model: string) => new AnthropicProvider(conn({ api_type: 'anthropic', base_url: 'https://api.anthropic.com', model, requires_key: true }), 'k',
      fakeFetch({ '/v1/messages': { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } }, cap))
    await mk('claude-opus-4-6').generate(msgs, { temperature: 0.2, max_tokens: 100, params: { top_k: 5 } })
    expect(cap[0].body).toMatchObject({ thinking: { type: 'disabled' }, temperature: 0.2, top_k: 5, max_tokens: 100, system: 'S' })
    await mk('claude-opus-4-7').generate(msgs, { temperature: 0.2, max_tokens: 100, reasoning: 'high' })
    expect(cap[1].body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
    expect(cap[1].body!.temperature).toBeUndefined()
    await mk('claude-sonnet-5-5').generate(msgs, { max_tokens: 100 })
    expect(cap[2].body!.thinking).toEqual({ type: 'between_tools' })
    await mk('claude-opus-5-5').generate(msgs, { max_tokens: 100 })
    expect(cap[3].body!.thinking).toBeUndefined()
    expect(cap[3].body!.output_config).toEqual({ effort: 'low' })
    await mk('claude-haiku-4-5').generate(msgs, { temperature: 0.2, max_tokens: 100, reasoning: 'medium' })
    expect(cap[4].body!.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(cap[4].body!.max_tokens).toBe(8192 + 1024)
    expect(cap[4].body!.temperature).toBeUndefined() // must be 1 with a thinking budget → not sent
    await mk('claude-haiku-4-5').generate(msgs, { temperature: 0.2, max_tokens: 100 })
    expect(cap[5].body!.thinking).toBeUndefined()
    expect(cap[5].body!.temperature).toBe(0.2)
    expect(cap[5].headers['x-api-key']).toBe('k')
  })
  it('describeModel merges /v1/models facts with generation rules', async () => {
    const p = new AnthropicProvider(conn({ api_type: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude-opus-5-5', requires_key: true }), 'k',
      fakeFetch({ '/v1/models/claude-opus-5-5': { id: 'claude-opus-5-5', max_input_tokens: 1000000, max_tokens: 128000 } }))
    const info = await p.describeModel()
    expect(info.context_length).toBe(1000000)
    expect(info.max_output_tokens).toBe(128000)
    expect(info.reasoning.mandatory).toBe(true)
    expect(info.parameters).toEqual([])
  })
})

describe('sanitizeParams', () => {
  it('keeps primitives and short string lists, drops junk', () => {
    expect(sanitizeParams({ top_p: 0.9, seed: 1, ok: true, name: 'x', stop: ['a', 'b'], nested: { a: 1 }, fn: () => 1, 'bad key!': 1, long: 'y'.repeat(300) }))
      .toEqual({ top_p: 0.9, seed: 1, ok: true, name: 'x', stop: ['a', 'b'] })
    expect(sanitizeParams(null)).toEqual({})
  })
})
