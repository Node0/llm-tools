/**
 * server/log.ts — Print (primafacie) plus a belt-and-braces secret scrubber.
 *
 * Provider errors are already scrubbed at the source with the exact key
 * (shared/providers/http.ts). This layer catches the shapes of keys we never
 * saw — bearer tokens, sk-… strings, x-api-key headers — before anything is
 * logged or returned to a client from a generic error path.
 */

import { Print, type LogType } from '@diamondjs/primafacie'

const PATTERNS: Array<[RegExp, string]> = [
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/\b(sk-[A-Za-z0-9_-]{6,})/g, 'sk-[REDACTED]'],
  [/\b(sk-ant-[A-Za-z0-9_-]{6,})/g, 'sk-ant-[REDACTED]'],
  [/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]'],
  [/(authorization["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]'],
  [/("api_key"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2'],
]

export function scrubLikelySecrets(text: string): string {
  let out = text
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  return out
}

export function log(type: LogType, message: string): void {
  Print(type, scrubLikelySecrets(message))
}

export function errorMessage(e: unknown): string {
  return scrubLikelySecrets(e instanceof Error ? e.message : String(e))
}
