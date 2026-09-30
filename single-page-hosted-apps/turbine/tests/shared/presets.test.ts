import { describe, expect, it } from 'bun:test'
import { buildBaseUrl, classifyLocality, connectionFromPreset, normalizeConnection, parseBaseUrl, presetById } from '../../shared/providers/index.ts'
import { scrubSecret } from '../../shared/providers/http.ts'

describe('classifyLocality', () => {
  it('treats loopback, RFC1918 and .local/.internal as local', () => {
    for (const u of ['http://localhost:11434', 'http://127.0.0.1:8000/v1', 'http://10.0.0.5:8080', 'http://192.168.1.20:11434', 'http://172.16.4.4', 'http://gpu-box.internal:8000', 'http://mac.local:11434', 'http://[::1]:11434'])
      expect(classifyLocality(u)).toBe('local')
  })
  it('treats public hosts as remote', () => {
    for (const u of ['https://openrouter.ai/api/v1', 'https://api.openai.com/v1', 'http://172.32.0.1', 'https://example.com'])
      expect(classifyLocality(u)).toBe('remote')
  })
})

describe('normalizeConnection', () => {
  it('accepts Crystallizer-style default_* fields and re-derives locality', () => {
    const c = normalizeConnection({ name: 'x', api_type: 'ollama', base_url: 'http://localhost:11434/', default_model: 'm', default_ctx_len: 4096, locality: 'remote' })
    expect(c).toMatchObject({ base_url: 'http://localhost:11434', model: 'm', ctx_len: 4096, locality: 'local', requires_key: false })
  })
  it('rejects bad input', () => {
    expect(() => normalizeConnection({ api_type: 'nope', base_url: 'http://x', model: 'm' })).toThrow(/api_type/)
    expect(() => normalizeConnection({ api_type: 'openai', base_url: 'not a url', model: 'm' })).toThrow(/URL/)
    expect(() => normalizeConnection({ api_type: 'openai', base_url: 'ftp://x', model: 'm' })).toThrow(/http/)
    expect(() => normalizeConnection({ api_type: 'openai', base_url: 'http://x', model: '' })).toThrow(/model/)
  })
  it('never lets auth ride in the generic headers bag', () => {
    const c = normalizeConnection({ api_type: 'openai', base_url: 'https://api.openai.com/v1', model: 'm', headers: { Authorization: 'Bearer leak', 'X-Title': 'ok' } })
    expect(c.headers).toEqual({ 'X-Title': 'ok' })
  })
})

describe('presets & urls', () => {
  it('round-trips base urls through parts', () => {
    const parts = parseBaseUrl('http://localhost:11434')!
    expect(parts).toEqual({ scheme: 'http', host: 'localhost', port: '11434', path: '' })
    expect(buildBaseUrl({ ...parts, path: '/v1/' })).toBe('http://localhost:11434/v1')
    expect(buildBaseUrl({ scheme: 'https', host: 'openrouter.ai', port: '', path: 'api/v1' })).toBe('https://openrouter.ai/api/v1')
  })
  it('builds a connection from a preset with overrides', () => {
    const c = connectionFromPreset(presetById('vllm')!, { base_url: 'http://gpu.internal:8000/v1', model: 'llama' })
    expect(c).toMatchObject({ api_type: 'openai', model: 'llama', locality: 'local', requires_key: false, name: 'vllm' })
    const r = connectionFromPreset(presetById('openrouter')!, { model: 'qwen/qwen3-235b-a22b' })
    expect(r.requires_key).toBe(true)
    expect(r.headers?.['X-Title']).toBe('Turbine')
  })
})

describe('scrubSecret', () => {
  it('redacts raw and url-encoded forms and ignores short/empty secrets', () => {
    expect(scrubSecret('key sk-abc/def failed; enc sk-abc%2Fdef', 'sk-abc/def')).toBe('key [REDACTED] failed; enc [REDACTED]')
    expect(scrubSecret('nothing', null)).toBe('nothing')
    expect(scrubSecret('ab ab', 'ab')).toBe('ab ab')
  })
})
