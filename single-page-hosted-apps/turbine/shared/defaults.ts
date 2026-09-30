/**
 * shared/defaults.ts — the JobSpec defaults, derived from config.json's
 * window_defaults (server) or the /api/config payload (browser).
 */

import type { CarrySpec, JobSpec, ReasoningSetting, RunMode, SnapMode, ValidatorSpec } from './types.ts'
import { sanitizeParams } from './providers/params.ts'
import { charsForTokens } from './engine/tokens.ts'
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE } from './engine/template.ts'

/** The shape of config.json → window_defaults. Token-denominated where the UI is. */
export interface WindowDefaults {
  focus_tokens: number
  context_before_tokens: number
  context_after_tokens: number
  snap: SnapMode
  mode: RunMode
  concurrency: number
  carry: CarrySpec
  temperature: number
  max_tokens: number
  validator: ValidatorSpec
  joiner: string
}

export const FALLBACK_WINDOW_DEFAULTS: WindowDefaults = {
  focus_tokens: 1500,
  context_before_tokens: 400,
  context_after_tokens: 400,
  snap: 'paragraph',
  mode: 'map',
  concurrency: 2,
  carry: { kind: 'tail', chars: 1200 },
  temperature: 0.2,
  max_tokens: 2048,
  validator: { kind: 'none' },
  joiner: '\n\n',
}

export function defaultJobSpec(sourceName: string, d: WindowDefaults = FALLBACK_WINDOW_DEFAULTS): JobSpec {
  return {
    sourceName,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userTemplate: DEFAULT_USER_TEMPLATE,
    window: {
      focusChars: charsForTokens(d.focus_tokens),
      contextBeforeChars: charsForTokens(d.context_before_tokens),
      contextAfterChars: charsForTokens(d.context_after_tokens),
      snap: d.snap,
    },
    mode: d.mode,
    concurrency: d.concurrency,
    carry: { ...d.carry },
    generation: { temperature: d.temperature, max_tokens: d.max_tokens, reasoning: 'off', params: {} },
    validator: { ...d.validator },
    retry: { maxAttempts: 3, temperatureDecay: 0.5 },
    joiner: d.joiner,
  }
}

/** Validate an untrusted JobSpec (from the browser). Throws with a readable message. */
export function validateJobSpec(input: unknown, limits: { max_concurrency: number }): JobSpec {
  if (!input || typeof input !== 'object') throw new Error('spec must be an object')
  const s = input as Record<string, unknown>
  const str = (k: string, max = 200_000): string => {
    const v = s[k]
    if (typeof v !== 'string') throw new Error(`spec.${k} must be a string`)
    if (v.length > max) throw new Error(`spec.${k} is too long`)
    return v
  }
  const num = (v: unknown, k: string, lo: number, hi: number): number => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be a number in [${lo}, ${hi}]`)
    return n
  }
  const win = (s.window ?? {}) as Record<string, unknown>
  const gen = (s.generation ?? {}) as Record<string, unknown>
  const carry = (s.carry ?? {}) as Record<string, unknown>
  const val = (s.validator ?? {}) as Record<string, unknown>
  const retry = (s.retry ?? {}) as Record<string, unknown>
  const range = s.range as Record<string, unknown> | undefined
  const mode = s.mode === 'fold' ? 'fold' : 'map'
  const snap: SnapMode = win.snap === 'sentence' ? 'sentence' : win.snap === 'none' ? 'none' : 'paragraph'
  const vkind: ValidatorSpec['kind'] = val.kind === 'conserve' ? 'conserve' : val.kind === 'length-ratio' ? 'length-ratio' : 'none'
  return {
    sourceName: str('sourceName', 512) || 'document',
    systemPrompt: str('systemPrompt'),
    userTemplate: str('userTemplate'),
    window: {
      focusChars: Math.floor(num(win.focusChars, 'window.focusChars', 16, 2_000_000)),
      contextBeforeChars: Math.floor(num(win.contextBeforeChars ?? 0, 'window.contextBeforeChars', 0, 2_000_000)),
      contextAfterChars: Math.floor(num(win.contextAfterChars ?? 0, 'window.contextAfterChars', 0, 2_000_000)),
      snap,
    },
    mode,
    concurrency: Math.floor(num(s.concurrency ?? 1, 'concurrency', 1, limits.max_concurrency)),
    carry: { kind: carry.kind === 'tail' ? 'tail' : 'none', chars: Math.floor(num(carry.chars ?? 0, 'carry.chars', 0, 200_000)) },
    generation: {
      temperature: num(gen.temperature ?? 0.2, 'generation.temperature', 0, 2),
      max_tokens: Math.floor(num(gen.max_tokens ?? 2048, 'generation.max_tokens', 16, 1_000_000)),
      ...(gen.num_ctx !== undefined && gen.num_ctx !== null && gen.num_ctx !== '' ? { num_ctx: Math.floor(num(gen.num_ctx, 'generation.num_ctx', 256, 10_000_000)) } : {}),
      reasoning: (['off', 'on', 'low', 'medium', 'high'] as ReasoningSetting[]).includes(gen.reasoning as ReasoningSetting) ? (gen.reasoning as ReasoningSetting) : 'off',
      params: sanitizeParams(gen.params),
    },
    validator: {
      kind: vkind,
      ...(val.threshold !== undefined ? { threshold: num(val.threshold, 'validator.threshold', 0, 1) } : {}),
      ...(val.minRatio !== undefined ? { minRatio: num(val.minRatio, 'validator.minRatio', 0, 100) } : {}),
      ...(val.maxRatio !== undefined ? { maxRatio: num(val.maxRatio, 'validator.maxRatio', 0, 100) } : {}),
    },
    retry: {
      maxAttempts: Math.floor(num(retry.maxAttempts ?? 3, 'retry.maxAttempts', 1, 10)),
      temperatureDecay: num(retry.temperatureDecay ?? 0.5, 'retry.temperatureDecay', 0, 1),
    },
    joiner: typeof s.joiner === 'string' && s.joiner.length <= 16 ? s.joiner : '\n\n',
    ...(range && typeof range === 'object'
      ? { range: { start: Math.floor(num(range.start, 'range.start', 0, 1e9)), end: Math.floor(num(range.end, 'range.end', 0, 1e9)) } }
      : {}),
  }
}
