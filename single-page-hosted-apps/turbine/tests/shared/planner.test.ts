import { describe, expect, it } from 'bun:test'
import { estimatePlan, paragraphOffsets, planFromSelection, planWindows } from '../../shared/engine/planner.ts'
import { defaultJobSpec } from '../../shared/defaults.ts'

const para = (i: number): string => `Paragraph ${i}. ` + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(5)
const doc = Array.from({ length: 20 }, (_, i) => para(i + 1)).join('\n\n')

describe('planWindows', () => {
  it('tiles the whole document contiguously with no overlap in focus regions', () => {
    const plan = planWindows(doc, { focusChars: 600, contextBeforeChars: 100, contextAfterChars: 100, snap: 'paragraph' })
    expect(plan.length).toBeGreaterThan(3)
    expect(plan[0].focusStart).toBe(0)
    expect(plan.at(-1)?.focusEnd).toBe(doc.length)
    for (let i = 1; i < plan.length; i++) expect(plan[i].focusStart).toBe(plan[i - 1].focusEnd)
    plan.forEach((w, i) => expect(w.index).toBe(i))
  })

  it('snaps focus boundaries to paragraph breaks when asked', () => {
    const plan = planWindows(doc, { focusChars: 600, contextBeforeChars: 0, contextAfterChars: 0, snap: 'paragraph' })
    for (const w of plan.slice(0, -1)) {
      // The character just before the boundary must be a newline (end of a blank-line break).
      expect(doc[w.focusEnd - 1]).toBe('\n')
      expect(doc.slice(w.focusStart, w.focusStart + 9)).toBe('Paragraph')
    }
  })

  it('falls back to sentence ends when no paragraph break is near', () => {
    const one = 'Sentence one is here. Sentence two is here. Sentence three is here. Sentence four is here. Sentence five is here.'
    const plan = planWindows(one, { focusChars: 45, contextBeforeChars: 0, contextAfterChars: 0, snap: 'paragraph' })
    for (const w of plan.slice(0, -1)) expect(one.slice(w.focusEnd - 2, w.focusEnd)).toBe('. ')
  })

  it('keeps context inside the document but lets it reach outside a selected range', () => {
    const range = { start: 500, end: 1500 }
    const plan = planWindows(doc, { focusChars: 400, contextBeforeChars: 300, contextAfterChars: 300, snap: 'sentence' }, range)
    expect(plan[0].focusStart).toBe(500)
    expect(plan.at(-1)?.focusEnd).toBe(1500)
    expect(plan[0].ctxStart).toBe(200)
    expect(plan.at(-1)!.ctxEnd).toBeGreaterThan(1500)
    for (const w of plan) {
      expect(w.ctxStart).toBeGreaterThanOrEqual(0)
      expect(w.ctxEnd).toBeLessThanOrEqual(doc.length)
    }
  })

  it('returns no windows for empty or whitespace text and one window for tiny text', () => {
    expect(planWindows('', { focusChars: 100, contextBeforeChars: 0, contextAfterChars: 0, snap: 'paragraph' })).toEqual([])
    expect(planWindows('   \n\n  ', { focusChars: 100, contextBeforeChars: 0, contextAfterChars: 0, snap: 'paragraph' })).toEqual([])
    const p = planWindows('hello', { focusChars: 100, contextBeforeChars: 0, contextAfterChars: 0, snap: 'paragraph' })
    expect(p).toEqual([{ index: 0, ctxStart: 0, focusStart: 0, focusEnd: 5, ctxEnd: 5 }])
  })

  it('rejects absurd window options', () => {
    expect(() => planWindows(doc, { focusChars: 2, contextBeforeChars: 0, contextAfterChars: 0, snap: 'none' })).toThrow()
  })
})

describe('planFromSelection / estimatePlan / paragraphOffsets', () => {
  it('builds a single window around a selection with clamped context', () => {
    const w = planFromSelection(doc, { focusChars: 999, contextBeforeChars: 50, contextAfterChars: 50, snap: 'none' }, { start: 10, end: 40 })
    expect(w).toEqual({ index: 0, ctxStart: 0, focusStart: 10, focusEnd: 40, ctxEnd: 90 })
  })

  it('estimates budget and flags context overflow', () => {
    const spec = defaultJobSpec('doc.md')
    spec.window = { focusChars: 600, contextBeforeChars: 100, contextAfterChars: 100, snap: 'paragraph' }
    const plan = planWindows(doc, spec.window)
    const ok = estimatePlan(plan, spec, 32768)
    expect(ok.window_count).toBe(plan.length)
    expect(ok.fits_context).toBe(true)
    expect(ok.max_prompt_tokens).toBeGreaterThan(0)
    const tight = estimatePlan(plan, spec, 200)
    expect(tight.fits_context).toBe(false)
  })

  it('splits paragraphs on blank lines and reports exact offsets', () => {
    const text = 'A\n\nB B\n\n\nC'
    expect(paragraphOffsets(text)).toEqual([{ start: 0, end: 1 }, { start: 3, end: 6 }, { start: 9, end: 10 }])
    expect(paragraphOffsets(doc).length).toBe(20)
  })
})

describe('estimatePlan — calibrated chars-per-token and truncation flag', () => {
  it('uses the supplied chars-per-token and flags a max_tokens that is below the largest focus', () => {
    const spec = defaultJobSpec('doc.md')
    spec.window = { focusChars: 2000, contextBeforeChars: 0, contextAfterChars: 0, snap: 'none' }
    const plan = planWindows(doc, spec.window)
    const at4 = estimatePlan(plan, spec, 32768, 4)
    const at5 = estimatePlan(plan, spec, 32768, 5)
    expect(at4.chars_per_token).toBe(4)
    expect(at5.chars_per_token).toBe(5)
    expect(at5.max_prompt_tokens).toBeLessThan(at4.max_prompt_tokens)
    expect(at4.max_focus_tokens).toBe(Math.ceil(at4.max_focus_chars / 4))
    expect(at4.max_tokens_may_truncate).toBe(false) // default max_tokens 2048 > 500-token focus
    spec.generation.max_tokens = 100
    expect(estimatePlan(plan, spec, 32768, 4).max_tokens_may_truncate).toBe(true)
  })
  it('ignores an absurd chars-per-token figure', () => {
    const spec = defaultJobSpec('doc.md')
    const plan = planWindows(doc, spec.window)
    expect(estimatePlan(plan, spec, 32768, 0).chars_per_token).toBe(4)
    expect(estimatePlan(plan, spec, 32768, 99).chars_per_token).toBe(4)
  })
})
