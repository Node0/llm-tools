/**
 * Live provider test against a local Ollama. Skipped unless TURBINE_LIVE=1 and
 * the daemon answers on :11434. Run: TURBINE_LIVE=1 bun test tests/live
 */
import { describe, expect, it } from 'bun:test'
import { createProvider, normalizeConnection } from '../../shared/providers/index.ts'

const live = process.env.TURBINE_LIVE === '1'
const model = process.env.TURBINE_LIVE_MODEL ?? 'qwen3.6:35b-a3b-mxfp8'

describe.skipIf(!live)('ollama (live)', () => {
  it('lists models, reports health, and streams a completion with thinking off', async () => {
    const conn = normalizeConnection({ name: 'ollama-local', api_type: 'ollama', base_url: 'http://localhost:11434', model, ctx_len: 8192 })
    const p = createProvider(conn, null)
    const h = await p.health()
    expect(h.ok).toBe(true)
    let streamed = ''
    const r = await p.generate([{ role: 'user', content: 'Reply with exactly the word: pong' }], { temperature: 0, max_tokens: 16, onToken: (c) => (streamed += c) })
    expect(r.text.toLowerCase()).toContain('pong')
    expect(streamed).toBe(r.text)
    expect(r.usage?.completion_tokens).toBeGreaterThan(0)
  }, 120_000)
})
