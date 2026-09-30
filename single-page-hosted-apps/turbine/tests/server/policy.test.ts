import { describe, expect, test } from 'bun:test'
import { HttpError } from '../../server/errors.ts'
import { assertServerMayCall, decideExecution, hostAllowed } from '../../server/policy.ts'
import { LOCAL_CONNECTION, REMOTE_CONNECTION, testConfig } from './helpers.ts'

describe('execution policy', () => {
  test('private deployment: everything runs on the server', () => {
    const cfg = testConfig({ public_deployment: false }, 'policy-private')
    expect(decideExecution(cfg, LOCAL_CONNECTION)).toBe('server')
    expect(decideExecution(cfg, REMOTE_CONNECTION)).toBe('server')
    expect(() => assertServerMayCall(cfg, LOCAL_CONNECTION)).not.toThrow()
    expect(() => assertServerMayCall(cfg, { ...REMOTE_CONNECTION, base_url: 'https://example.org/v1' })).not.toThrow()
  })

  test('public deployment: local → browser, allowlisted remote → server', () => {
    const cfg = testConfig({ public_deployment: true }, 'policy-public')
    expect(decideExecution(cfg, LOCAL_CONNECTION)).toBe('browser')
    expect(decideExecution(cfg, REMOTE_CONNECTION)).toBe('server')
    expect(() => assertServerMayCall(cfg, REMOTE_CONNECTION)).not.toThrow()
  })

  test('public deployment: server refuses local addresses and unknown hosts', () => {
    const cfg = testConfig({ public_deployment: true }, 'policy-ssrf')
    const local = (): void => assertServerMayCall(cfg, LOCAL_CONNECTION)
    expect(local).toThrow(HttpError)
    try {
      local()
    } catch (e) {
      expect((e as HttpError).code).toBe('ssrf-blocked')
      expect((e as HttpError).status).toBe(403)
    }
    const rfc1918 = (): void => assertServerMayCall(cfg, { ...REMOTE_CONNECTION, base_url: 'http://10.0.0.5:8000/v1' })
    expect(rfc1918).toThrow(HttpError)
    const unknown = (): void => assertServerMayCall(cfg, { ...REMOTE_CONNECTION, base_url: 'https://evil.example.com/v1' })
    expect(unknown).toThrow(HttpError)
  })

  test('public deployment: config keys on disk are ignored', () => {
    const cfg = testConfig({ public_deployment: true }, 'policy-keys')
    expect(cfg.connections.find((c) => c.name === 'openrouter')?.apiKey).toBeNull()
    const priv = testConfig({ public_deployment: false }, 'policy-keys-private')
    expect(priv.connections.find((c) => c.name === 'openrouter')?.apiKey).toBe('sk-or-server-key-0123456789')
  })

  test('hostAllowed matches exact and subdomain only', () => {
    expect(hostAllowed('openrouter.ai', ['openrouter.ai'])).toBe(true)
    expect(hostAllowed('api.openrouter.ai', ['openrouter.ai'])).toBe(true)
    expect(hostAllowed('notopenrouter.ai', ['openrouter.ai'])).toBe(false)
    expect(hostAllowed('openrouter.ai.evil.com', ['openrouter.ai'])).toBe(false)
  })
})
