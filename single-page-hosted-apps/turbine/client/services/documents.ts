/**
 * client/services/documents.ts — the source document.
 *
 * The full text and the paragraph offset table are module variables, NOT
 * reactive state: a 1000-page book is ~30k paragraphs and proxying them would
 * cost more than it buys. `state.docVersion` bumps whenever they change, so
 * effects can depend on that.
 */
import { DiamondCore, Pending } from '@diamondjs/runtime'
import { Print } from '@diamondjs/primafacie'
import type { CharRange } from '../../shared/types.ts'
import type { DocInfo } from '../../shared/api.ts'
import { paragraphOffsets } from '../../shared/engine/planner.ts'
import { api } from './api.ts'

const STORAGE_KEY = 'turbine.doc'

export interface DocumentsState {
  doc: DocInfo | null
  docVersion: number
  selection: CharRange | null
  uploading: boolean
  loading: boolean
  error: string | null
}

export const state = DiamondCore.reactive<DocumentsState>({
  doc: null,
  docVersion: 0,
  selection: null,
  uploading: false,
  loading: false,
  error: null,
})

let text = ''
let paragraphs: CharRange[] = []

function setDoc(info: DocInfo | null, content: string): void {
  text = content
  paragraphs = content ? paragraphOffsets(content) : []
  state.selection = null
  state.doc = info
  state.docVersion++
}

function remember(id: string | null): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable */
  }
}

export const documents = {
  state,
  text: (): string => text,
  paragraphs: (): readonly CharRange[] => paragraphs,

  async upload(input: File | { name: string; text: string }): Promise<DocInfo> {
    state.uploading = true
    state.error = null
    try {
      const local = input instanceof File ? await input.text() : input.text
      const info = await Pending.until(api.docs.upload(input), 'upload')
      // Offsets must agree byte-for-byte with what the server stored (server-run
      // jobs plan from its copy). If the server normalized anything, take its text.
      const canonical = info.chars === local.length ? local : await api.docs.text(info.id)
      setDoc(info, canonical)
      remember(info.id)
      Print('SUCCESS', `document loaded: ${info.name} (${info.words.toLocaleString()} words)`)
      return info
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      state.uploading = false
    }
  },

  /** On boot: re-open the last document if the server still has it. */
  async restore(): Promise<void> {
    let id: string | null = null
    try {
      id = localStorage.getItem(STORAGE_KEY)
    } catch {
      return
    }
    if (!id) return
    state.loading = true
    try {
      const info = await api.docs.get(id)
      const content = await api.docs.text(id)
      setDoc(info, content)
    } catch {
      remember(null)
    } finally {
      state.loading = false
    }
  },

  clear(): void {
    const id = state.doc?.id
    setDoc(null, '')
    remember(null)
    if (id) void api.docs.remove(id).catch(() => undefined)
  },

  setSelection(range: CharRange | null): void {
    if (!range || range.end <= range.start) {
      state.selection = null
      return
    }
    state.selection = { start: Math.max(0, range.start), end: Math.min(text.length, range.end) }
  },

  selectedText(): string {
    const s = state.selection
    return s ? text.slice(s.start, s.end) : ''
  },
}
