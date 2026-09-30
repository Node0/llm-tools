import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { configFromObject, type TurbineConfig } from '../../server/config.ts'
import type { ChatMessage, ConnectionSpec, GenerateOptions, GenerateResult, ModelInfo, Provider } from '../../shared/types.ts'

export const SCRATCH = '/private/tmp/claude-501/-Users-joehacobian-my-repos-llm-tools/cbeeb49d-0f04-445f-acad-45e73e5e6246/scratchpad'

export function tempDataDir(label: string): string {
  return mkdtempSync(join(SCRATCH, `turbine-test-${label}-`))
}

export function testConfig(overrides: Record<string, unknown> = {}, label = 'cfg'): TurbineConfig {
  const data_dir = tempDataDir(label)
  return configFromObject(
    {
      public_deployment: false,
      server: { host: '127.0.0.1', port: 0, static_dir: join(data_dir, 'no-static'), data_dir },
      session: { ttl_seconds: 60, extend_on_activity: false, cookie_name: 'turbine_sid' },
      limits: { max_upload_bytes: 1_000_000, max_concurrency: 4, max_jobs_per_session: 4 },
      inference_service_connections: {
        'ollama-local': { api_type: 'ollama', base_url: 'http://localhost:11434', default_model: 'test-model', default_ctx_len: 8192 },
        'openrouter': { api_type: 'openai', base_url: 'https://openrouter.ai/api/v1', default_model: 'x/y', api_key: 'sk-or-server-key-0123456789' },
      },
      ...overrides,
    },
    `<test:${label}>`,
    {},
  )
}

export const LOCAL_CONNECTION: ConnectionSpec = {
  name: 'ollama-local',
  api_type: 'ollama',
  base_url: 'http://localhost:11434',
  model: 'test-model',
  ctx_len: 8192,
  locality: 'local',
  requires_key: false,
}

export const REMOTE_CONNECTION: ConnectionSpec = {
  name: 'openrouter',
  api_type: 'openai',
  base_url: 'https://openrouter.ai/api/v1',
  model: 'x/y',
  ctx_len: 131072,
  locality: 'remote',
  requires_key: true,
}

/** In-memory provider: uppercases the <focus> body; optional per-call hook for failure injection. */
export class FakeProvider implements Provider {
  calls: ChatMessage[][] = []
  constructor(
    readonly spec: ConnectionSpec = LOCAL_CONNECTION,
    private readonly hook?: (messages: ChatMessage[], opts: GenerateOptions) => Promise<string | null>,
  ) {}
  async generate(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    this.calls.push(messages)
    const user = messages.find((m) => m.role === 'user')?.content ?? ''
    const m = user.match(/<focus>\n([\s\S]*?)\n<\/focus>/)
    const focus = m ? m[1] : user
    const hooked = this.hook ? await this.hook(messages, opts) : null
    const text = hooked ?? focus.toUpperCase()
    opts.onToken?.(text)
    return { text, model: this.spec.model, usage: { prompt_tokens: 10, completion_tokens: 5 }, elapsed_ms: 1 }
  }
  async listModels(): Promise<string[]> {
    return [this.spec.model]
  }
  async health() {
    return { ok: true, detail: 'fake', latency_ms: 0 }
  }
  async describeModel(): Promise<ModelInfo> {
    return { model: this.spec.model, api_type: this.spec.api_type, flavor: 'generic', reasoning: { supported: false, settings: ['off'] }, parameters: [], defaults: {}, source: 'fake', notes: [] }
  }
}

export const SAMPLE_TEXT = [
  'Alpha paragraph one. It has a couple of sentences in it.',
  'Beta paragraph two. Also a couple of sentences here.',
  'Gamma paragraph three. And this is the last one.',
].join('\n\n')

export function cookieFrom(res: Response): string {
  const set = res.headers.get('set-cookie') ?? ''
  return set.split(';')[0]
}

export async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T
}
