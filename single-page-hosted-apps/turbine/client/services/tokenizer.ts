/**
 * client/services/tokenizer.ts — exact token counts in the browser.
 *
 * tiktoken's Rust→WASM core (cl100k_base ranks) loads lazily on first use:
 * ~1 MB of WASM plus ~1 MB of ranks, both served by the Turbine server from
 * node_modules and cached by the browser. Until it is ready, callers get
 * `null` and fall back to the chars-per-token estimate.
 *
 * cl100k_base is not any local model's exact vocabulary, but every modern
 * BPE tokenizer lands within a few percent of it on English prose, and the
 * model's own usage numbers (reported after a preview) recalibrate the plan.
 */
import { DiamondCore } from '@diamondjs/runtime'
import { Print } from '@diamondjs/primafacie'
import type { Tiktoken } from 'tiktoken/lite'

/** The wasm-bindgen glue module (tiktoken/lite/tiktoken_bg.js) as the browser sees it. */
interface GlueModule {
  Tiktoken: new (ranks: string, special: Record<string, number>, pat: string) => Tiktoken
  __wbg_set_wasm(exports: WebAssembly.Exports): void
}

/**
 * Import a module by URL at runtime, invisible to the bundler. tiktoken's glue
 * uses `export *` re-exports that Parcel's scope hoisting mangles inside a
 * lazy chunk, so the browser loads the file straight from /vendor instead.
 */
const runtimeImport = new Function('u', 'return import(u)') as (url: string) => Promise<unknown>

export const tokenizerState = DiamondCore.reactive({
  ready: false,
  loading: false,
  error: '',
  name: 'cl100k_base',
  /** Bumped when the tokenizer becomes usable, so cached counts recompute. */
  version: 0,
})

let enc: Tiktoken | null = null
let pending: Promise<boolean> | null = null

export function loadTokenizer(): Promise<boolean> {
  if (enc) return Promise.resolve(true)
  if (pending) return pending
  tokenizerState.loading = true
  pending = (async () => {
    try {
      const t0 = performance.now()
      const [glue, wasmRes, ranksRes] = await Promise.all([
        runtimeImport('/vendor/tiktoken/tiktoken_bg.js') as Promise<GlueModule>,
        fetch('/vendor/tiktoken/tiktoken_bg.wasm'),
        fetch('/vendor/tiktoken/cl100k_base.json'),
      ])
      if (!wasmRes.ok || !ranksRes.ok) throw new Error(`tokenizer assets unavailable (${wasmRes.status}/${ranksRes.status})`)
      const wasmBytes = await wasmRes.arrayBuffer()
      // Same handshake as tiktoken/lite/init.js: the glue is the wasm's import object and receives its exports.
      const { instance } = await WebAssembly.instantiate(wasmBytes, { './tiktoken_bg.js': glue as unknown as WebAssembly.ModuleImports })
      glue.__wbg_set_wasm(instance.exports)
      const ranks = (await ranksRes.json()) as { bpe_ranks: string; special_tokens: Record<string, number>; pat_str: string }
      enc = new glue.Tiktoken(ranks.bpe_ranks, ranks.special_tokens, ranks.pat_str)
      tokenizerState.ready = true
      tokenizerState.version++
      Print('SUCCESS', `tokenizer ready (tiktoken/cl100k_base, WASM) in ${Math.round(performance.now() - t0)} ms`)
      return true
    } catch (e) {
      tokenizerState.error = e instanceof Error ? e.message : String(e)
      Print('WARNING', `tokenizer unavailable, using character estimates: ${tokenizerState.error}`)
      return false
    } finally {
      tokenizerState.loading = false
    }
  })()
  return pending
}

/** Exact token count, or null while the tokenizer is not loaded. Never throws. */
export function countTokens(text: string): number | null {
  if (!enc) return null
  try {
    return enc.encode_ordinary(text).length
  } catch {
    return null
  }
}

/** Tiny memo for hot getters: the last few (text → count) pairs by identity. */
const memo = new Map<string, number>()
export function countTokensMemo(text: string): number | null {
  if (!enc) return null
  const hit = memo.get(text)
  if (hit !== undefined) return hit
  const n = countTokens(text)
  if (n === null) return null
  if (memo.size > 8) memo.delete(memo.keys().next().value as string)
  memo.set(text, n)
  return n
}

/**
 * Chars-per-token measured on up to ~200k characters sampled evenly across
 * the text, so a whole book calibrates in tens of milliseconds.
 */
export function sampleCharsPerToken(text: string): number | null {
  if (!enc || text.length === 0) return null
  const SLICE = 25_000
  const SLICES = 8
  let chars = 0
  let tokens = 0
  if (text.length <= SLICE * SLICES) {
    const n = countTokens(text)
    if (n === null || n === 0) return null
    return text.length / n
  }
  const stride = Math.floor((text.length - SLICE) / (SLICES - 1))
  for (let i = 0; i < SLICES; i++) {
    const piece = text.slice(i * stride, i * stride + SLICE)
    const n = countTokens(piece)
    if (n === null) return null
    chars += piece.length
    tokens += n
  }
  return tokens > 0 ? chars / tokens : null
}
