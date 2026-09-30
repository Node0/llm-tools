/**
 * client/services/vault.ts — the browser-side credential vault.
 *
 * localStorage holds the chosen connection (no secret) and, for remote
 * providers, the API key encrypted with AES-256-GCM under a key derived from
 * the user's passphrase (PBKDF2-SHA256, 310k iterations, per-browser random
 * salt). The passphrase is never stored; a wrong passphrase simply fails the
 * GCM tag check.
 *
 * SubtleCrypto exists only in secure contexts (https or localhost). On a
 * plain-http LAN origin `canEncrypt()` is false: the connection is still
 * remembered but the key is not, and must be re-entered each visit.
 */
import type { ConnectionSpec } from '../../shared/types.ts'

const STORAGE_KEY = 'turbine.vault.v1'
const PBKDF2_ITERATIONS = 310_000

export interface VaultRecord {
  version: 1
  /** base64 */
  salt: string
  fingerprint: string | null
  mode: 'local' | 'remote'
  preset_id: string
  connection: ConnectionSpec
  /** Present when a remote key is stored (encrypted). */
  enc?: { iv: string; ct: string }
  /** The key lives on the server (config.json / env) — nothing to store here. */
  server_key?: boolean
  updated_at: string
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

const b64 = {
  enc: (buf: ArrayBuffer | Uint8Array): string => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  },
  dec: (s: string): Uint8Array<ArrayBuffer> => {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  },
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export const vault = {
  canEncrypt(): boolean {
    return Boolean(globalThis.crypto?.subtle) && Boolean(storage())
  },
  exists(): boolean {
    return vault.load() !== null
  },
  load(): VaultRecord | null {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (!raw) return null
    try {
      const rec = JSON.parse(raw) as VaultRecord
      return rec && rec.version === 1 && rec.connection ? rec : null
    } catch {
      return null
    }
  },
  save(rec: VaultRecord): void {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(rec))
  },
  clear(): void {
    storage()?.removeItem(STORAGE_KEY)
  },
  newSalt(): string {
    const s = new Uint8Array(16)
    crypto.getRandomValues(s)
    return b64.enc(s)
  },
  hasEncryptedKey(rec: VaultRecord | null = vault.load()): boolean {
    return Boolean(rec?.enc?.ct)
  },

  async encryptKey(passphrase: string, apiKey: string, salt: string): Promise<{ iv: string; ct: string }> {
    if (!vault.canEncrypt()) throw new VaultError('This page is not a secure context (https or localhost), so the key cannot be encrypted here.')
    const key = await deriveKey(passphrase, b64.dec(salt))
    const iv = new Uint8Array(12)
    crypto.getRandomValues(iv)
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(apiKey))
    return { iv: b64.enc(iv), ct: b64.enc(ct) }
  },

  async decryptKey(passphrase: string, rec: VaultRecord | null = vault.load()): Promise<string> {
    if (!rec?.enc) throw new VaultError('No stored key in this browser.')
    if (!vault.canEncrypt()) throw new VaultError('This page is not a secure context, so the stored key cannot be decrypted here.')
    const key = await deriveKey(passphrase, b64.dec(rec.salt))
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(rec.enc.iv) }, key, b64.dec(rec.enc.ct))
      return new TextDecoder().decode(pt)
    } catch {
      throw new VaultError('That passphrase does not unlock the stored key.')
    }
  },
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
