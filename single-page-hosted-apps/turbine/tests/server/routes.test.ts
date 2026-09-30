import { describe, expect, test } from 'bun:test'
import { buildApp } from '../../server/index.ts'
import type { DocInfo, SessionInfo } from '../../shared/api.ts'
import { LOCAL_CONNECTION, REMOTE_CONNECTION, SAMPLE_TEXT, cookieFrom, json, testConfig } from './helpers.ts'

const H = { 'content-type': 'application/json' }

describe('HTTP routes (private deployment)', () => {
  test('session cookie, docs, slice, job auth, connect', async () => {
    const { app } = await buildApp(testConfig({}, 'routes-private'))
    const req = (path: string, init: RequestInit = {}, cookie?: string) =>
      app.handle(new Request(`http://localhost${path}`, { ...init, headers: { ...H, ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } }))

    const s1 = await req('/api/session', { method: 'POST', body: JSON.stringify({ fingerprint: 'fp-1' }) })
    expect(s1.status).toBe(200)
    const setCookie = s1.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('turbine_sid=')
    expect(setCookie.toLowerCase()).toContain('httponly')
    expect(setCookie.toLowerCase()).toContain('samesite=strict')
    expect(s1.headers.get('cache-control')).toBe('no-store')
    expect(s1.headers.get('x-content-type-options')).toBe('nosniff')
    const cookie = cookieFrom(s1)
    const info1 = await json<SessionInfo>(s1)
    expect(info1.connected).toBe(false)
    expect(info1.public_deployment).toBe(false)

    // Same cookie → same session; a changed fingerprint is reported.
    const s2 = await req('/api/session', { method: 'POST', body: JSON.stringify({ fingerprint: 'fp-2' }) }, cookie)
    expect(s2.headers.get('set-cookie')).toBeNull()
    expect((await json<SessionInfo>(s2)).fingerprint_changed).toBe(true)

    // Config + providers are public.
    const cfg = await req('/api/config', {}, cookie)
    expect(cfg.status).toBe(200)
    const prov = await json<{ presets: unknown[]; connections: Array<{ name: string; has_server_key: boolean }> }>(await req('/api/providers', {}, cookie))
    expect(prov.presets.length).toBeGreaterThan(3)
    expect(prov.connections.find((c) => c.name === 'openrouter')?.has_server_key).toBe(true)

    // Docs: create, get, slice, ownership.
    const d = await req('/api/docs', { method: 'POST', body: JSON.stringify({ name: 'sample.txt', text: SAMPLE_TEXT }) }, cookie)
    expect(d.status).toBe(200)
    const doc = await json<DocInfo>(d)
    expect(doc.paragraphs).toBe(3)
    expect(doc.words).toBeGreaterThan(20)
    const slice = await json<{ text: string }>(await req(`/api/docs/${doc.id}/slice?start=0&end=5`, {}, cookie))
    expect(slice.text).toBe('Alpha')
    const other = await req('/api/session', { method: 'POST', body: '{}' })
    const otherCookie = cookieFrom(other)
    expect((await req(`/api/docs/${doc.id}`, {}, otherCookie)).status).toBe(404)
    const tooBig = await req('/api/docs', { method: 'POST', body: JSON.stringify({ name: 'big.txt', text: 'x'.repeat(1_000_001) }) }, cookie)
    expect(tooBig.status).toBe(413)

    // Jobs require a connection.
    const noConn = await req('/api/jobs', { method: 'POST', body: JSON.stringify({ doc_id: doc.id, spec: {} }) }, cookie)
    expect(noConn.status).toBe(401)
    expect((await json<{ code: string }>(noConn)).code).toBe('not-connected')

    // Connect to the config's local Ollama entry → server-executed, no key needed.
    const c1 = await req('/api/session/connect', { method: 'POST', body: JSON.stringify({ preset: 'ollama-local' }) }, cookie)
    expect(c1.status).toBe(200)
    const ci = await json<SessionInfo>(c1)
    expect(ci.connected).toBe(true)
    expect(ci.execution).toBe('server')
    expect(ci.has_key).toBe(false)

    // A remote connection composed in the browser needs a key …
    const c2 = await req('/api/session/connect', { method: 'POST', body: JSON.stringify({ connection: REMOTE_CONNECTION }) }, cookie)
    expect(c2.status).toBe(401)
    expect((await json<{ code: string }>(c2)).code).toBe('key-required')
    // … and with one, the vault holds it with an expiry; the key is never echoed.
    const c3 = await req('/api/session/connect', { method: 'POST', body: JSON.stringify({ connection: REMOTE_CONNECTION, api_key: 'sk-or-browser-key-987654321' }) }, cookie)
    const ci3 = await json<SessionInfo>(c3)
    expect(ci3.connected).toBe(true)
    expect(ci3.has_key).toBe(true)
    expect(ci3.key_expires_at).not.toBeNull()
    expect(JSON.stringify(ci3)).not.toContain('987654321')
    // Forget the key → disconnected again.
    const k = await json<SessionInfo>(await req('/api/session/key', { method: 'DELETE' }, cookie))
    expect(k.has_key).toBe(false)
    expect(k.connected).toBe(false)

    // The config's openrouter entry carries a server key in private mode → connected without a browser key.
    const c4 = await json<SessionInfo>(await req('/api/session/connect', { method: 'POST', body: JSON.stringify({ preset: 'openrouter' }) }, cookie))
    expect(c4.connected).toBe(true)
    expect(c4.server_key).toBe(true)

    // Unknown API route is JSON 404; unknown page route is the SPA fallback (503 here since no bundle exists).
    expect((await req('/api/nope', {}, cookie)).status).toBe(404)
    const page = await app.handle(new Request('http://localhost/output'))
    expect(page.status).toBe(503)
  })
})

describe('HTTP routes (public deployment)', () => {
  test('local connection → browser execution and no key held; remote non-allowlisted → 403', async () => {
    const { app } = await buildApp(testConfig({ public_deployment: true }, 'routes-public'))
    const s = await app.handle(new Request('http://localhost/api/session', { method: 'POST', headers: H, body: '{}' }))
    const cookie = cookieFrom(s)
    const req = (path: string, body: unknown) => app.handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { ...H, cookie }, body: JSON.stringify(body) }))

    const local = await json<SessionInfo>(await req('/api/session/connect', { connection: LOCAL_CONNECTION, api_key: 'should-not-be-stored' }))
    expect(local.execution).toBe('browser')
    expect(local.connected).toBe(true)
    expect(local.has_key).toBe(false)

    const test = await json<{ ok: boolean; execution: string }>(await req('/api/providers/test', { connection: LOCAL_CONNECTION }))
    expect(test.ok).toBe(false)
    expect(test.execution).toBe('browser')

    const evil = await req('/api/session/connect', { connection: { ...REMOTE_CONNECTION, base_url: 'https://evil.example.com/v1' }, api_key: 'sk-x-123456789' })
    expect(evil.status).toBe(403)
    expect((await json<{ code: string }>(evil)).code).toBe('ssrf-blocked')

    // Server-side config keys are ignored in public mode → the preset needs a browser key.
    const pre = await req('/api/session/connect', { preset: 'openrouter' })
    expect(pre.status).toBe(401)
  })
})
