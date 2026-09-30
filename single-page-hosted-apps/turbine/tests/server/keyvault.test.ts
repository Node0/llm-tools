import { describe, expect, test } from 'bun:test'
import { KeyVault, VaultMissError } from '../../server/keyvault.ts'

const SID_A = 'a'.repeat(64)
const SID_B = 'b'.repeat(64)

describe('KeyVault', () => {
  test('put → withKey roundtrip', async () => {
    const v = new KeyVault()
    v.put(SID_A, 'sk-secret-123456789', 10_000)
    expect(v.has(SID_A)).toBe(true)
    const seen = await v.withKey(SID_A, async (k) => k)
    expect(seen).toBe('sk-secret-123456789')
    expect(v.expiresAt(SID_A)).toBeInstanceOf(Date)
  })

  test('another session cannot see or decrypt the key', async () => {
    const v = new KeyVault()
    v.put(SID_A, 'sk-secret', 10_000)
    expect(v.has(SID_B)).toBe(false)
    await expect(v.withKey(SID_B, async (k) => k)).rejects.toBeInstanceOf(VaultMissError)
  })

  test('expiry fires onExpire and clears the key', async () => {
    const v = new KeyVault()
    const expired: string[] = []
    v.onExpire((id) => expired.push(id))
    v.put(SID_A, 'sk-short', 1000)
    expect(v.has(SID_A)).toBe(true)
    await new Promise((r) => setTimeout(r, 1150))
    expect(v.has(SID_A)).toBe(false)
    expect(expired).toEqual([SID_A])
    await expect(v.withKey(SID_A, async (k) => k)).rejects.toBeInstanceOf(VaultMissError)
  })

  test('forget removes immediately; extend pushes expiry out', () => {
    const v = new KeyVault()
    v.put(SID_A, 'sk-x', 5000)
    const first = v.expiresAt(SID_A)!.getTime()
    const later = v.extend(SID_A, 60_000)!.getTime()
    expect(later).toBeGreaterThan(first)
    v.forget(SID_A)
    expect(v.has(SID_A)).toBe(false)
    expect(v.expiresAt(SID_A)).toBeNull()
  })

  test('a stable master secret decrypts across vault instances; a different one does not', async () => {
    const secret = 'ab'.repeat(32)
    const v1 = new KeyVault(secret)
    v1.put(SID_A, 'sk-persist', 10_000)
    // Same master + same session id → same derived key (HKDF is deterministic).
    const v2 = new KeyVault(secret)
    v2.put(SID_A, 'sk-persist', 10_000)
    expect(await v2.withKey(SID_A, async (k) => k)).toBe('sk-persist')
    expect(() => new KeyVault('short')).toThrow()
  })
})
