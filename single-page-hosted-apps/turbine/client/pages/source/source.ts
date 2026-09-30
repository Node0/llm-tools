/** SourcePage — upload the document, see its shape, pick a selection. */
import { Component, reactive } from '@diamondjs/runtime'
import * as T from './source.diamond.html'
import { SourceViewer } from '../../components/source-viewer.ts'
import { documents } from '../../services/documents.ts'
import { ui } from '../../services/nav.ts'
import { prompt } from '../../services/prompt.ts'
import { tip as tipText } from '../../services/tooltips.ts'
import { tokenizerState } from '../../services/tokenizer.ts'

export class SourcePage extends Component {
  createTemplate = (T as unknown as { createTemplate: (this: SourcePage) => HTMLElement }).createTemplate
  private viewer = new SourceViewer()
  @reactive dragging = false

  constructor(_params?: Record<string, unknown>) {
    super()
    ui.activeTab = 'source'
  }

  override mount(host: HTMLElement): void {
    super.mount(host)
    const slot = this.getElement()?.querySelector<HTMLElement>('.viewer-host')
    if (slot) this.viewer.mount(slot)
  }

  override unmount(): void {
    this.viewer.unmount()
    super.unmount()
  }

  get dropClass(): string {
    return this.dragging ? 'panel upload dragging' : 'panel upload'
  }
  get uploading(): boolean {
    return documents.state.uploading
  }
  get loading(): boolean {
    return documents.state.loading
  }
  get error(): string {
    return documents.state.error ?? ''
  }
  get hasDoc(): boolean {
    return documents.state.doc !== null
  }
  get docName(): string {
    return documents.state.doc?.name ?? ''
  }
  get chars(): string {
    return (documents.state.doc?.chars ?? 0).toLocaleString()
  }
  get words(): string {
    return (documents.state.doc?.words ?? 0).toLocaleString()
  }
  /** Whole-document tokens: the calibrated estimate (exact per-document counting of a 3 MB book is not worth the wait). */
  get tokens(): string {
    void tokenizerState.version
    return prompt.tokenCount('').exact || prompt.state.cptSource !== 'default'
      ? Math.ceil((documents.state.doc?.chars ?? 0) / prompt.state.charsPerToken).toLocaleString()
      : (documents.state.doc?.est_tokens ?? 0).toLocaleString()
  }
  get tokensLabel(): string {
    return prompt.state.cptSource === 'default' ? '≈ Tokens' : `≈ Tokens (${prompt.state.charsPerToken.toFixed(1)} chars/tok)`
  }
  tip(path: string): string {
    return tipText(path)
  }
  get pages(): string {
    return (documents.state.doc?.est_pages ?? 0).toLocaleString()
  }
  get paragraphs(): string {
    return (documents.state.doc?.paragraphs ?? 0).toLocaleString()
  }
  get hasSelection(): boolean {
    return documents.state.selection !== null
  }
  get selStart(): string {
    return (documents.state.selection?.start ?? 0).toLocaleString()
  }
  get selEnd(): string {
    return (documents.state.selection?.end ?? 0).toLocaleString()
  }
  get selTokensText(): string {
    const c = prompt.tokenCount(documents.selectedText())
    return `${c.exact ? '' : '≈ '}${c.tokens.toLocaleString()} tokens`
  }
  get selCharsText(): string {
    const s = documents.state.selection
    if (!s) return ''
    return `${(s.end - s.start).toLocaleString()} chars · positions ${s.start.toLocaleString()}–${s.end.toLocaleString()}`
  }

  onDragOver(e: Event): void {
    e.preventDefault()
    this.dragging = true
  }
  onDragLeave(): void {
    this.dragging = false
  }
  async onDrop(e: Event): Promise<void> {
    e.preventDefault()
    this.dragging = false
    const file = (e as DragEvent).dataTransfer?.files?.[0]
    if (file) await this.load(file)
  }
  async onFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) await this.load(file)
    input.value = ''
  }
  private async load(file: File): Promise<void> {
    try {
      await documents.upload(file)
    } catch {
      /* documents.state.error carries the message */
    }
  }
  clearDoc(): void {
    documents.clear()
  }
  clearSelection(): void {
    documents.setSelection(null)
  }
}
