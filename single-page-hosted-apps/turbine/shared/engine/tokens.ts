/**
 * shared/engine/tokens.ts — token arithmetic.
 *
 * Everything here is an ESTIMATE from character counts. The default of 4
 * chars per token is the classic English figure; callers that know better
 * (a real tokenizer sample, or the model's own usage numbers from a preview)
 * pass a calibrated chars-per-token instead. Exact counts come from
 * client/services/tokenizer.ts (tiktoken WASM) and from provider usage.
 */

export const CHARS_PER_TOKEN = 4

/** Clamp a calibrated chars-per-token figure to something sane (guards against a bad sample). */
export function sanitizeCharsPerToken(cpt: number | null | undefined): number {
  return typeof cpt === 'number' && Number.isFinite(cpt) && cpt >= 1.5 && cpt <= 12 ? cpt : CHARS_PER_TOKEN
}

export function estimateTokens(text: string, cpt: number = CHARS_PER_TOKEN): number {
  return Math.ceil(text.length / sanitizeCharsPerToken(cpt))
}

export function charsForTokens(tokens: number, cpt: number = CHARS_PER_TOKEN): number {
  return Math.max(0, Math.round(tokens * sanitizeCharsPerToken(cpt)))
}

export function tokensForChars(chars: number, cpt: number = CHARS_PER_TOKEN): number {
  return Math.ceil(Math.max(0, chars) / sanitizeCharsPerToken(cpt))
}

export const WORDS_PER_PAGE = 275

export function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).length
}

export function estimatePages(text: string): number {
  return Math.round(countWords(text) / WORDS_PER_PAGE)
}
