/**
 * shared/providers/params.ts — the knob catalog.
 *
 * Every dialect gets a curated list of parameters Turbine knows how to route,
 * with sane bounds and plain-language help. Discovery (`describeModel`)
 * narrows that list to what the backend says the model accepts and fills in
 * the model's own defaults. Nothing here is sent unless the user sets it: a
 * cleared knob means "let the backend decide".
 */

import type { ParamDescriptor, ParamValue, ProviderFlavor, ReasoningSetting } from '../types.ts'

const D = (d: Omit<ParamDescriptor, 'source'>): ParamDescriptor => ({ ...d, source: 'preset' })

/** Sampling and repetition knobs shared by every OpenAI-style dialect (temperature is in the panel too). */
export const OPENAI_STYLE: Record<string, ParamDescriptor> = {
  temperature: D({ key: 'temperature', label: 'Temperature', kind: 'number', group: 'sampling', min: 0, max: 2, step: 0.05, help: 'How adventurous the model is. 0 is literal and repeatable; higher adds variety. Formatting jobs want it low.' }),
  top_p: D({ key: 'top_p', label: 'Top-p (nucleus)', kind: 'number', group: 'sampling', min: 0, max: 1, step: 0.01, help: 'Only sample from the smallest set of words whose probabilities add up to this. Lower is safer, higher is more varied. Usually leave it and steer with temperature.' }),
  top_k: D({ key: 'top_k', label: 'Top-k', kind: 'integer', group: 'sampling', min: 0, max: 500, step: 1, help: 'Only consider the k most likely next words. 0 disables the cut.' }),
  min_p: D({ key: 'min_p', label: 'Min-p', kind: 'number', group: 'sampling', min: 0, max: 1, step: 0.01, help: 'Drop any word less likely than this fraction of the most likely one. A modern alternative to top-p; 0.05 is typical.' }),
  top_a: D({ key: 'top_a', label: 'Top-a', kind: 'number', group: 'sampling', min: 0, max: 1, step: 0.01, help: 'Adaptive cut based on the top probability squared. Rarely needed.' }),
  frequency_penalty: D({ key: 'frequency_penalty', label: 'Frequency penalty', kind: 'number', group: 'repetition', min: -2, max: 2, step: 0.05, help: 'Discourage words in proportion to how often they already appeared. Positive values reduce repetition.' }),
  presence_penalty: D({ key: 'presence_penalty', label: 'Presence penalty', kind: 'number', group: 'repetition', min: -2, max: 2, step: 0.05, help: 'Discourage any word that has appeared at all, encouraging new topics. Keep near 0 for faithful formatting.' }),
  repetition_penalty: D({ key: 'repetition_penalty', label: 'Repetition penalty', kind: 'number', group: 'repetition', min: 0.5, max: 2, step: 0.01, help: 'Multiplicative penalty on repeated words. 1 is off; 1.05–1.15 gently discourages loops. Too high mangles faithful copies.' }),
  seed: D({ key: 'seed', label: 'Seed', kind: 'integer', group: 'determinism', min: 0, max: 2147483647, step: 1, help: 'Fix the random seed so the same prompt gives the same output (where the backend supports it).' }),
  verbosity: D({ key: 'verbosity', label: 'Verbosity', kind: 'enum', group: 'other', options: ['low', 'medium', 'high'], help: 'How much the model writes when not constrained by the task (OpenAI GPT-5 family).' }),
}

/** Ollama's `options` block. */
export const OLLAMA_OPTIONS: Record<string, ParamDescriptor> = {
  temperature: OPENAI_STYLE.temperature,
  top_p: OPENAI_STYLE.top_p,
  top_k: { ...OPENAI_STYLE.top_k, max: 200 },
  min_p: OPENAI_STYLE.min_p,
  repeat_penalty: D({ key: 'repeat_penalty', label: 'Repeat penalty', kind: 'number', group: 'repetition', min: 0.5, max: 2, step: 0.01, help: 'Multiplicative penalty on repeated words. 1 is off; 1.05–1.15 gently discourages loops. Too high mangles faithful copies.' }),
  repeat_last_n: D({ key: 'repeat_last_n', label: 'Repeat window', kind: 'integer', group: 'repetition', min: -1, max: 4096, step: 1, help: 'How far back the repeat penalty looks, in tokens. -1 means the whole context, 0 disables it.' }),
  presence_penalty: OPENAI_STYLE.presence_penalty,
  frequency_penalty: OPENAI_STYLE.frequency_penalty,
  seed: OPENAI_STYLE.seed,
  num_ctx: D({ key: 'num_ctx', label: 'Context window (num_ctx)', kind: 'integer', group: 'context', min: 512, max: 1048576, step: 1, help: 'How many tokens Ollama loads the model with, prompt and answer together. Turbine sends your connection\'s context length here so the plan and the runtime agree; changing it reloads the model (memory grows with it).' }),
  num_batch: D({ key: 'num_batch', label: 'Batch size (num_batch)', kind: 'integer', group: 'other', min: 1, max: 4096, step: 1, help: 'Prompt-processing batch size. Larger is faster on big prompts if memory allows.' }),
}

/** Dialect → curated keys (the order is the display order). */
export const PRESET_PARAMS: Record<ProviderFlavor, ParamDescriptor[]> = {
  ollama: ['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty', 'repeat_last_n', 'presence_penalty', 'frequency_penalty', 'seed', 'num_ctx', 'num_batch'].map((k) => OLLAMA_OPTIONS[k]),
  openrouter: ['temperature', 'top_p', 'top_k', 'min_p', 'top_a', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed'].map((k) => OPENAI_STYLE[k]),
  openai: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'].map((k) => OPENAI_STYLE[k]),
  vllm: ['temperature', 'top_p', 'top_k', 'min_p', 'repetition_penalty', 'frequency_penalty', 'presence_penalty', 'seed'].map((k) => OPENAI_STYLE[k]),
  llamacpp: ['temperature', 'top_p', 'top_k', 'min_p', 'repetition_penalty', 'seed'].map((k) => OPENAI_STYLE[k]),
  anthropic: ['temperature', 'top_p', 'top_k'].map((k) => OPENAI_STYLE[k]),
  generic: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'].map((k) => OPENAI_STYLE[k]),
}

/** OpenRouter `supported_parameters` names → our descriptors (unknown names are ignored, not invented). */
export const OPENROUTER_PARAM_MAP: Record<string, ParamDescriptor> = {
  temperature: OPENAI_STYLE.temperature,
  top_p: OPENAI_STYLE.top_p,
  top_k: OPENAI_STYLE.top_k,
  min_p: OPENAI_STYLE.min_p,
  top_a: OPENAI_STYLE.top_a,
  frequency_penalty: OPENAI_STYLE.frequency_penalty,
  presence_penalty: OPENAI_STYLE.presence_penalty,
  repetition_penalty: OPENAI_STYLE.repetition_penalty,
  seed: OPENAI_STYLE.seed,
  verbosity: OPENAI_STYLE.verbosity,
}

export const REASONING_SETTINGS: ReasoningSetting[] = ['off', 'on', 'low', 'medium', 'high']

/** Parse Ollama's `parameters` text ("top_p  0.95\ntemperature  1\n…") into typed defaults. */
export function parseOllamaParameters(text: string | undefined): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  if (!text) return out
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(.+)$/)
    if (!m) continue
    const [, key, raw] = m
    const v = raw.trim().replace(/^"(.*)"$/, '$1')
    if (key === 'stop') {
      const prev = out.stop
      out.stop = Array.isArray(prev) ? [...prev, v] : [v]
      continue
    }
    const n = Number(v)
    out[key] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(n) && v !== '' ? n : v
  }
  return out
}

/** Coerce a raw UI value to the descriptor's kind; null means "unset". */
export function coerceParam(d: ParamDescriptor, raw: unknown): ParamValue | null {
  if (raw === null || raw === undefined || raw === '') return null
  switch (d.kind) {
    case 'boolean':
      return raw === true || raw === 'true'
    case 'integer': {
      const n = Math.round(Number(raw))
      if (!Number.isFinite(n)) return null
      return clamp(n, d.min, d.max)
    }
    case 'number': {
      const n = Number(raw)
      if (!Number.isFinite(n)) return null
      return clamp(n, d.min, d.max)
    }
    case 'enum':
      return d.options?.includes(String(raw)) ? String(raw) : null
    default:
      return String(raw).slice(0, 200)
  }
}

function clamp(n: number, lo?: number, hi?: number): number {
  if (lo !== undefined && n < lo) return lo
  if (hi !== undefined && n > hi) return hi
  return n
}

/** Split a params bag into the keys a descriptor list knows (routed) and the rest (passed through as-is). */
export function routeParams(params: Record<string, ParamValue> | undefined, known: readonly ParamDescriptor[]): { known: Record<string, ParamValue>; extra: Record<string, ParamValue> } {
  const keys = new Set(known.map((d) => d.key))
  const out = { known: {} as Record<string, ParamValue>, extra: {} as Record<string, ParamValue> }
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue
    ;(keys.has(k) ? out.known : out.extra)[k] = v
  }
  return out
}

/** Sanitize an untrusted params bag: primitive values only, bounded sizes. */
export function sanitizeParams(input: unknown): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  let n = 0
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(k)) continue
    if (++n > 40) break
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string' && v.length <= 200) out[k] = v
    else if (Array.isArray(v) && v.length <= 16 && v.every((x) => typeof x === 'string' && x.length <= 100)) out[k] = v as string[]
  }
  return out
}
