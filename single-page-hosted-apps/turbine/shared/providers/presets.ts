/**
 * shared/providers/presets.ts — the built-in connection presets and the
 * ConnectionSpec normalizer.
 *
 * Presets are what the Connect page offers as radio/select choices. They are
 * templates, not connections: the user (or config.json) supplies the model,
 * and for local backends the host/port/path.
 */

import type { ApiType, ConnectionSpec, Locality } from '../types.ts'
import { hasProvider } from './registry.ts'

export interface Preset {
  id: string
  label: string
  api_type: ApiType
  base_url: string
  locality: Locality
  requires_key: boolean
  ctx_len: number
  default_model?: string
  headers?: Record<string, string>
  /** Where to obtain a key, shown as a hint. */
  key_url?: string
  notes?: string
}

export const PRESETS: readonly Preset[] = [
  { id: 'ollama', label: 'Ollama', api_type: 'ollama', base_url: 'http://localhost:11434', locality: 'local', requires_key: false, ctx_len: 32768,
    notes: 'Native /api/chat so num_ctx is honored; thinking is disabled unless options.think is true. For browser-run jobs set OLLAMA_ORIGINS to this app\'s origin.' },
  { id: 'vllm', label: 'vLLM', api_type: 'openai', base_url: 'http://localhost:8000/v1', locality: 'local', requires_key: false, ctx_len: 32768,
    notes: 'OpenAI-compatible server. Start vLLM with --served-model-name to control the model id.' },
  { id: 'llamacpp', label: 'llama.cpp server', api_type: 'openai', base_url: 'http://localhost:8080/v1', locality: 'local', requires_key: false, ctx_len: 32768,
    notes: 'llama-server speaks the OpenAI chat API on /v1.' },
  { id: 'openrouter', label: 'OpenRouter', api_type: 'openai', base_url: 'https://openrouter.ai/api/v1', locality: 'remote', requires_key: true, ctx_len: 131072,
    default_model: 'qwen/qwen3-235b-a22b', headers: { 'HTTP-Referer': 'https://github.com/Node0/llm-tools', 'X-Title': 'Turbine' }, key_url: 'https://openrouter.ai/keys' },
  { id: 'openai', label: 'OpenAI', api_type: 'openai', base_url: 'https://api.openai.com/v1', locality: 'remote', requires_key: true, ctx_len: 128000,
    default_model: 'gpt-4o-mini', key_url: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic', api_type: 'anthropic', base_url: 'https://api.anthropic.com', locality: 'remote', requires_key: true, ctx_len: 200000,
    default_model: 'claude-sonnet-5-5', key_url: 'https://console.anthropic.com/settings/keys' },
  { id: 'custom-openai', label: 'Custom OpenAI-compatible', api_type: 'openai', base_url: '', locality: 'remote', requires_key: true, ctx_len: 32768,
    notes: 'Any server exposing /chat/completions. Set the full base URL including /v1 where applicable.' },
]

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id)
}

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|.+\.(local|internal|lan|home|localdomain))$/i

/** Loopback, RFC1918 and .local/.internal hostnames are 'local'; everything else is 'remote'. */
export function classifyLocality(baseUrl: string): Locality {
  try {
    const host = new URL(baseUrl).hostname
    return PRIVATE_HOST.test(host) ? 'local' : 'remote'
  } catch {
    return 'remote'
  }
}

export interface UrlParts {
  scheme: 'http' | 'https'
  host: string
  port: string
  path: string
}

export function parseBaseUrl(url: string): UrlParts | null {
  try {
    const u = new URL(url)
    const scheme = u.protocol === 'https:' ? 'https' : 'http'
    return { scheme, host: u.hostname, port: u.port, path: u.pathname.replace(/\/+$/, '') }
  } catch {
    return null
  }
}

export function buildBaseUrl(parts: UrlParts): string {
  const port = parts.port ? `:${parts.port}` : ''
  const path = parts.path ? (parts.path.startsWith('/') ? parts.path : `/${parts.path}`).replace(/\/+$/, '') : ''
  return `${parts.scheme}://${parts.host}${port}${path}`
}

export class ConnectionValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionValidationError'
  }
}

/**
 * Validate and normalize an untrusted connection object (from the browser or
 * from config.json) into a ConnectionSpec. Locality is always re-derived from
 * the URL — a client cannot declare a public host "local".
 */
export function normalizeConnection(input: unknown): ConnectionSpec {
  if (!input || typeof input !== 'object') throw new ConnectionValidationError('connection must be an object')
  const c = input as Record<string, unknown>
  const api_type = String(c.api_type ?? '')
  if (!hasProvider(api_type)) throw new ConnectionValidationError(`unknown api_type '${api_type}'`)
  const base_url = String(c.base_url ?? '').trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(base_url)
  } catch {
    throw new ConnectionValidationError(`base_url '${base_url}' is not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConnectionValidationError(`base_url must be http(s), got ${parsed.protocol}`)
  }
  const model = String(c.model ?? c.default_model ?? '').trim()
  if (!model) throw new ConnectionValidationError('model is required')
  const ctxRaw = Number(c.ctx_len ?? c.default_ctx_len ?? 32768)
  const ctx_len = Number.isFinite(ctxRaw) && ctxRaw > 0 ? Math.floor(ctxRaw) : 32768
  const name = String(c.name ?? `${api_type}@${parsed.host}`).trim().slice(0, 80) || api_type
  const headers = sanitizeStringRecord(c.headers)
  const options = c.options && typeof c.options === 'object' && !Array.isArray(c.options) ? (c.options as Record<string, unknown>) : undefined
  const timeout = Number(c.timeout_ms)
  const spec: ConnectionSpec = {
    name,
    api_type,
    base_url,
    model,
    ctx_len,
    locality: classifyLocality(base_url),
    requires_key: Boolean(c.requires_key),
    ...(headers ? { headers } : {}),
    ...(options ? { options } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeout_ms: Math.floor(timeout) } : {}),
    ...(typeof c.anthropic_version === 'string' ? { anthropic_version: c.anthropic_version } : {}),
  }
  return spec
}

function sanitizeStringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') continue
    // Never let a caller smuggle auth through the generic headers bag.
    if (/^(authorization|x-api-key|cookie)$/i.test(k)) continue
    out[k] = val
  }
  return Object.keys(out).length ? out : undefined
}

/** Build a ConnectionSpec from a preset plus user overrides (model, base_url, ctx_len, name). */
export function connectionFromPreset(preset: Preset, overrides: Partial<Pick<ConnectionSpec, 'name' | 'base_url' | 'model' | 'ctx_len' | 'options'>>): ConnectionSpec {
  return normalizeConnection({
    name: overrides.name ?? preset.id,
    api_type: preset.api_type,
    base_url: overrides.base_url ?? preset.base_url,
    model: overrides.model ?? preset.default_model ?? '',
    ctx_len: overrides.ctx_len ?? preset.ctx_len,
    requires_key: preset.requires_key,
    headers: preset.headers,
    options: overrides.options,
  })
}
