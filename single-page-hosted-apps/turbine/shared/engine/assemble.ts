/**
 * shared/engine/assemble.ts — stitch window outputs back into one document.
 *
 * Failed windows pass the ORIGINAL focus text through (a pump should never
 * drop text on the floor) behind an HTML comment marker; pending windows get
 * a marker only. Flagged windows are emitted as-is — the flag lives in the
 * record for the UI.
 */

import type { WindowPlan, WindowRecord } from '../types.ts'

export interface AssembleOptions {
  joiner: string
  /** The source text; needed to pass failed windows through verbatim. */
  text?: string
  /** Mark windows that have no record yet. Default true (progressive view). */
  markPending?: boolean
}

export function assembleOutput(records: ReadonlyMap<number, WindowRecord>, windows: readonly WindowPlan[], opts: AssembleOptions): string {
  const parts: string[] = []
  for (const w of windows) {
    const r = records.get(w.index)
    if (!r) {
      if (opts.markPending !== false) parts.push(`<!-- turbine: window ${w.index + 1} pending -->`)
      continue
    }
    if (r.status === 'failed') {
      const original = opts.text ? opts.text.slice(w.focusStart, w.focusEnd).trim() : ''
      parts.push(`<!-- turbine: window ${w.index + 1} failed (${(r.error ?? 'unknown error').replace(/-->/g, '- >')}); original text follows -->` + (original ? `\n${original}` : ''))
      continue
    }
    parts.push(r.output)
  }
  return parts.join(opts.joiner)
}

/** `<stem>__transformed.md` — Crystallizer's double-underscore convention. */
export function outputFilename(sourceName: string, suffix = 'transformed', ext = 'md'): string {
  const stem = sourceName.replace(/\.[^./\\]+$/, '').replace(/[^\w.-]+/g, '_') || 'document'
  return `${stem}__${suffix}.${ext}`
}
