/**
 * shared/engine/validators.ts — pluggable output checks.
 *
 *   none          accept anything
 *   conserve      the output, with Markdown syntax stripped, must still read as
 *                 the input text (word-sequence similarity ≥ threshold). This is
 *                 the guard for formatting passes over an embeddings corpus:
 *                 you want Darwin's words, not the formatting model's.
 *   length-ratio  output length / focus length must fall inside [min, max]
 */

import type { ValidationResult, ValidatorSpec } from '../types.ts'

export function stripMarkdown(s: string): string {
  return s
    .replace(/```[\w-]*\n?/g, '') // fences
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // bullets
    .replace(/^\s*\d+[.)]\s+/gm, '') // numbered lists
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '') // table rules
    .replace(/\|/g, ' ') // table pipes
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links
    .replace(/\[\^[^\]]*\]/g, '') // footnote refs
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italics
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/<[^>]+>/g, '') // stray tags
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1') // escapes
}

const QUOTES: Record<string, string> = { '“': '"', '”': '"', '‘': "'", '’': "'", '—': '-', '–': '-', '…': '...' }

/** Lowercase, unify quotes/dashes, drop everything but letters, digits and spaces. */
export function normalizeForCompare(s: string): string {
  return s
    .replace(/[“”‘’—–…]/g, (c) => QUOTES[c] ?? c)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 2·LCS / (|a| + |b|) over word arrays — order-sensitive, insertion/deletion
 * tolerant. Two-row DP, bounded so a pathological window can't hang a worker.
 */
export function sequenceSimilarity(a: string[], b: string[], cap = 12_000): number {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  const x = a.length > cap ? a.slice(0, cap) : a
  const y = b.length > cap ? b.slice(0, cap) : b
  let prev = new Uint32Array(y.length + 1)
  let cur = new Uint32Array(y.length + 1)
  for (let i = 1; i <= x.length; i++) {
    const xi = x[i - 1]
    for (let j = 1; j <= y.length; j++) {
      cur[j] = xi === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    ;[prev, cur] = [cur, prev]
  }
  const lcs = prev[y.length]
  return (2 * lcs) / (x.length + y.length)
}

export function conserveScore(focus: string, output: string): number {
  const a = normalizeForCompare(focus).split(' ').filter(Boolean)
  const b = normalizeForCompare(stripMarkdown(output)).split(' ').filter(Boolean)
  return sequenceSimilarity(a, b)
}

export function validateWindow(spec: ValidatorSpec, focus: string, output: string): ValidationResult {
  switch (spec.kind) {
    case 'none':
      return { ok: true, kind: 'none' }
    case 'conserve': {
      const threshold = spec.threshold ?? 0.95
      const score = conserveScore(focus, output)
      const ok = score >= threshold
      return { ok, kind: 'conserve', score: round(score), reason: ok ? undefined : `text similarity ${round(score)} < ${threshold}` }
    }
    case 'length-ratio': {
      const min = spec.minRatio ?? 0.5
      const max = spec.maxRatio ?? 2.0
      const ratio = focus.length === 0 ? 1 : output.length / focus.length
      const ok = ratio >= min && ratio <= max
      return { ok, kind: 'length-ratio', score: round(ratio), reason: ok ? undefined : `length ratio ${round(ratio)} outside [${min}, ${max}]` }
    }
    default:
      return { ok: true, kind: 'none', reason: `unknown validator '${String((spec as { kind: unknown }).kind)}' treated as none` }
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
