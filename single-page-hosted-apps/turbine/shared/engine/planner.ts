/**
 * shared/engine/planner.ts — turns a document into a window plan.
 *
 * The plan is computed once, up front, as an array of character offsets.
 * Focus regions tile the document (or the selected range) with NO overlap; the
 * read-only context on either side is what overlaps. Focus boundaries snap to
 * a paragraph break, then a sentence end, then whitespace, then a hard cut.
 */

import type { CharRange, JobSpec, PlanEstimate, SnapMode, WindowOptions, WindowPlan } from '../types.ts'
import { CHARS_PER_TOKEN, estimateTokens, sanitizeCharsPerToken, tokensForChars } from './tokens.ts'

const PARAGRAPH_BREAK = /\n[ \t]*\n+/g
const SENTENCE_END = /[.!?]["'”’)\]]*(?=\s)\s+/g

function nearestBoundary(
  text: string,
  lo: number,
  hi: number,
  target: number,
  re: RegExp,
): number | null {
  // Search a bounded slice; return the absolute offset just AFTER the match closest to target.
  const slice = text.slice(lo, hi)
  let best: number | null = null
  let bestDist = Infinity
  re.lastIndex = 0
  for (const m of slice.matchAll(re)) {
    const abs = lo + (m.index ?? 0) + m[0].length
    if (abs <= lo || abs > hi) continue
    const d = Math.abs(abs - target)
    if (d < bestDist) {
      best = abs
      bestDist = d
    }
  }
  return best
}

function nearestWhitespace(text: string, lo: number, hi: number, target: number): number | null {
  for (let d = 0; d < hi - lo; d++) {
    const a = target + d
    const b = target - d
    if (a < hi && /\s/.test(text[a] ?? '')) return a + 1
    if (b > lo && /\s/.test(text[b] ?? '')) return b + 1
  }
  return null
}

/** Pick where a focus region should end, given a target offset and the snapping policy. */
export function snapBoundary(text: string, target: number, minEnd: number, maxEnd: number, snap: SnapMode, focusChars: number): number {
  if (target >= maxEnd) return maxEnd
  const tolerance = Math.max(80, Math.floor(focusChars * 0.25))
  const lo = Math.max(minEnd, target - tolerance)
  const hi = Math.min(maxEnd, target + tolerance)
  if (snap === 'paragraph' || snap === 'sentence') {
    const p = snap === 'paragraph' ? nearestBoundary(text, lo, hi, target, PARAGRAPH_BREAK) : null
    if (p !== null) return p
    const s = nearestBoundary(text, lo, hi, target, SENTENCE_END)
    if (s !== null) return s
  }
  const w = nearestWhitespace(text, lo, hi, target)
  return w ?? target
}

export function validateWindowOptions(opts: WindowOptions): void {
  if (!Number.isFinite(opts.focusChars) || opts.focusChars < 16) throw new Error('focusChars must be at least 16 characters')
  if (opts.contextBeforeChars < 0 || opts.contextAfterChars < 0) throw new Error('context sizes cannot be negative')
}

/**
 * Tile [range.start, range.end) — or the whole text — into focus regions of
 * roughly opts.focusChars, each wrapped in read-only context that may extend
 * outside the range but never outside the document.
 */
export function planWindows(text: string, opts: WindowOptions, range?: CharRange): WindowPlan[] {
  validateWindowOptions(opts)
  const start = Math.max(0, Math.min(range?.start ?? 0, text.length))
  const end = Math.max(start, Math.min(range?.end ?? text.length, text.length))
  const plans: WindowPlan[] = []
  let pos = start
  while (pos < end) {
    const target = Math.min(pos + opts.focusChars, end)
    // A focus may shrink to no less than half the requested size when snapping.
    const minEnd = Math.min(end, pos + Math.max(16, Math.floor(opts.focusChars / 2)))
    let focusEnd = snapBoundary(text, target, minEnd, end, opts.snap, opts.focusChars)
    if (focusEnd <= pos) focusEnd = Math.min(end, pos + opts.focusChars)
    if (text.slice(pos, focusEnd).trim().length > 0) {
      plans.push({
        index: plans.length,
        ctxStart: Math.max(0, pos - opts.contextBeforeChars),
        focusStart: pos,
        focusEnd,
        ctxEnd: Math.min(text.length, focusEnd + opts.contextAfterChars),
      })
    }
    pos = focusEnd
  }
  return plans
}

/** A single window whose focus is exactly the user's selection — what Preview runs. */
export function planFromSelection(text: string, opts: WindowOptions, selection: CharRange): WindowPlan {
  const focusStart = Math.max(0, Math.min(selection.start, text.length))
  const focusEnd = Math.max(focusStart, Math.min(selection.end, text.length))
  return {
    index: 0,
    ctxStart: Math.max(0, focusStart - opts.contextBeforeChars),
    focusStart,
    focusEnd,
    ctxEnd: Math.min(text.length, focusEnd + opts.contextAfterChars),
  }
}

/** Budget preflight: does the biggest window fit the model's context, and how much work is this? */
export function estimatePlan(windows: WindowPlan[], spec: JobSpec, ctxLen: number, charsPerToken: number = CHARS_PER_TOKEN): PlanEstimate {
  const cpt = sanitizeCharsPerToken(charsPerToken)
  const fixed = estimateTokens(spec.systemPrompt, cpt) + estimateTokens(spec.userTemplate, cpt) + 32
  const carry = spec.mode === 'fold' && spec.carry.kind === 'tail' ? tokensForChars(spec.carry.chars, cpt) : 0
  let maxPrompt = 0
  let sumPrompt = 0
  let sumOut = 0
  let sumFocus = 0
  let maxFocus = 0
  for (const w of windows) {
    const prompt = fixed + carry + tokensForChars(w.ctxEnd - w.ctxStart, cpt)
    const focus = w.focusEnd - w.focusStart
    sumFocus += focus
    sumPrompt += prompt
    sumOut += tokensForChars(focus, cpt)
    if (prompt > maxPrompt) maxPrompt = prompt
    if (focus > maxFocus) maxFocus = focus
  }
  const n = windows.length
  const maxFocusTokens = tokensForChars(maxFocus, cpt)
  const maxOut = n ? Math.min(spec.generation.max_tokens, maxFocusTokens) : 0
  return {
    window_count: n,
    total_focus_chars: sumFocus,
    avg_focus_chars: n ? Math.round(sumFocus / n) : 0,
    max_prompt_tokens: maxPrompt,
    avg_prompt_tokens: n ? Math.round(sumPrompt / n) : 0,
    est_output_tokens: sumOut,
    est_total_tokens: sumPrompt + sumOut,
    fits_context: maxPrompt + maxOut <= ctxLen,
    ctx_len: ctxLen,
    max_focus_chars: maxFocus,
    max_focus_tokens: maxFocusTokens,
    max_tokens_may_truncate: n > 0 && spec.generation.max_tokens < maxFocusTokens,
    chars_per_token: cpt,
  }
}

/** Paragraph offsets for the source viewer: [start, end) per block, split on blank lines. */
export function paragraphOffsets(text: string): CharRange[] {
  const out: CharRange[] = []
  let pos = 0
  PARAGRAPH_BREAK.lastIndex = 0
  for (const m of text.matchAll(PARAGRAPH_BREAK)) {
    const idx = m.index ?? 0
    if (idx > pos) out.push({ start: pos, end: idx })
    pos = idx + m[0].length
  }
  if (pos < text.length) out.push({ start: pos, end: text.length })
  return out
}
