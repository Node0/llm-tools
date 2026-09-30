import { describe, expect, it } from 'bun:test'
import { sha256, sha256Hex } from '../../shared/engine/hash.ts'

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

describe('sha256 fallback', () => {
  it('matches known vectors and WebCrypto for varied lengths', async () => {
    expect(hex(sha256(new TextEncoder().encode('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4097]) {
      const s = 'x'.repeat(n) + '✓'
      const data = new TextEncoder().encode(s)
      const ref = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
      expect(hex(sha256(data))).toBe(ref)
      expect(await sha256Hex(s)).toBe(ref)
    }
  })
})
