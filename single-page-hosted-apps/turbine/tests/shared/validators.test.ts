import { describe, expect, it } from 'bun:test'
import { conserveScore, normalizeForCompare, sequenceSimilarity, stripMarkdown, validateWindow } from '../../shared/engine/validators.ts'

describe('stripMarkdown / normalizeForCompare', () => {
  it('removes formatting but keeps words', () => {
    const md = '## Chapter I\n\nIt was the **best** of _times_, [link](http://x)\n\n- a\n- b\n\n| c | d |\n|---|---|\n| 1 | 2 |'
    expect(normalizeForCompare(stripMarkdown(md))).toBe('chapter i it was the best of times link a b c d 1 2')
  })
  it('unifies curly quotes and dashes', () => {
    expect(normalizeForCompare('“Hello” — it’s')).toBe(normalizeForCompare('"Hello" - it\'s'))
  })
})

describe('sequenceSimilarity', () => {
  it('is 1 for identical, 0 for disjoint, symmetric otherwise', () => {
    expect(sequenceSimilarity(['a', 'b'], ['a', 'b'])).toBe(1)
    expect(sequenceSimilarity(['a'], ['b'])).toBe(0)
    const s1 = sequenceSimilarity('the quick brown fox'.split(' '), 'the brown fox'.split(' '))
    const s2 = sequenceSimilarity('the brown fox'.split(' '), 'the quick brown fox'.split(' '))
    expect(s1).toBeCloseTo(s2)
    expect(s1).toBeCloseTo(6 / 7)
  })
})

describe('validateWindow', () => {
  const focus = 'CHAPTER IV.\n\nIt was the best of times, it was the worst of\ntimes, it was the age of wisdom.'
  it('conserve accepts formatting-only changes', () => {
    const out = '## Chapter IV.\n\nIt was the best of times, it was the worst of times, it was the age of _wisdom_.'
    const r = validateWindow({ kind: 'conserve' }, focus, out)
    expect(r.ok).toBe(true)
    expect(r.score).toBe(1)
  })
  it('conserve rejects paraphrase and truncation', () => {
    expect(validateWindow({ kind: 'conserve' }, focus, 'Times were both great and terrible, and wise.').ok).toBe(false)
    expect(validateWindow({ kind: 'conserve' }, focus, 'CHAPTER IV. It was the best of times.').ok).toBe(false)
    expect(conserveScore(focus, '')).toBe(0)
  })
  it('length-ratio bounds', () => {
    expect(validateWindow({ kind: 'length-ratio' }, 'abcd', 'abcdef').ok).toBe(true)
    expect(validateWindow({ kind: 'length-ratio', maxRatio: 1.2 }, 'abcd', 'abcdefghij').ok).toBe(false)
    expect(validateWindow({ kind: 'length-ratio' }, 'abcdefgh', 'a').ok).toBe(false)
  })
  it('none accepts anything', () => {
    expect(validateWindow({ kind: 'none' }, 'x', '').ok).toBe(true)
  })
})
