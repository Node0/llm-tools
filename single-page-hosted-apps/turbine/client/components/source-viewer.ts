/**
 * SourceViewer — a scrollable, incrementally rendered view of the document
 * whose native text selection maps back to character offsets.
 *
 * Hand-written createTemplate (no .diamond.html): the paragraph list is built
 * in batches of 300 <p data-offset data-end> nodes as the sentinel scrolls
 * into view, so a 30k-paragraph book never renders all at once. Selection is
 * captured on mouseup/keyup and written to documents.state.selection; the
 * covered paragraphs get a `.sel` class so the choice survives clicks.
 */
import { Component, DiamondCore } from '@diamondjs/runtime'
import type { CharRange } from '../../shared/types.ts'
import { documents } from '../services/documents.ts'

const BATCH = 300

export class SourceViewer extends Component {
  private scroller!: HTMLDivElement
  private list!: HTMLDivElement
  private sentinel!: HTMLDivElement
  private status!: HTMLSpanElement
  private jumpInput!: HTMLInputElement
  private rendered = 0
  private observer: IntersectionObserver | null = null
  private readonly compact: boolean

  constructor(opts: { compact?: boolean } = {}) {
    super()
    this.compact = Boolean(opts.compact)
  }

  override createTemplate(): HTMLElement {
    const root = document.createElement('div')
    root.className = this.compact ? 'viewer viewer-compact' : 'viewer'

    const toolbar = document.createElement('div')
    toolbar.className = 'viewer-toolbar'
    this.status = document.createElement('span')
    this.status.className = 'viewer-status muted'
    const jumpLabel = document.createElement('label')
    jumpLabel.className = 'viewer-jump'
    jumpLabel.textContent = 'Jump to % '
    this.jumpInput = document.createElement('input')
    this.jumpInput.type = 'number'
    this.jumpInput.min = '0'
    this.jumpInput.max = '100'
    this.jumpInput.placeholder = '0–100'
    jumpLabel.appendChild(this.jumpInput)
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'btn btn-ghost btn-sm'
    go.textContent = 'Go'
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'btn btn-ghost btn-sm'
    more.textContent = 'Load more'
    toolbar.append(this.status, jumpLabel, go, more)

    this.scroller = document.createElement('div')
    this.scroller.className = 'viewer-scroll'
    this.list = document.createElement('div')
    this.list.className = 'viewer-list'
    this.sentinel = document.createElement('div')
    this.sentinel.className = 'viewer-sentinel'
    this.scroller.append(this.list, this.sentinel)

    root.append(toolbar, this.scroller)

    this.registerCleanup(DiamondCore.on(go, 'click', () => this.jumpToPercent(Number(this.jumpInput.value))))
    this.registerCleanup(DiamondCore.on(this.jumpInput, 'keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.jumpToPercent(Number(this.jumpInput.value))
    }))
    this.registerCleanup(DiamondCore.on(more, 'click', () => this.renderBatch()))
    this.registerCleanup(DiamondCore.on(this.scroller, 'mouseup', () => this.captureSelection()))
    this.registerCleanup(DiamondCore.on(this.scroller, 'keyup', () => this.captureSelection()))
    return root
  }

  override mount(host: HTMLElement): void {
    super.mount(host)
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) this.renderBatch()
      },
      { root: this.scroller, rootMargin: '600px 0px' },
    )
    this.observer.observe(this.sentinel)
    this.registerCleanup(() => this.observer?.disconnect())

    // Rebuild when the document changes.
    this.registerCleanup(
      DiamondCore.effect(() => {
        void documents.state.docVersion
        this.reset()
      }),
    )
    // Re-highlight when the selection changes.
    this.registerCleanup(
      DiamondCore.effect(() => {
        const sel = documents.state.selection
        this.applyHighlight(sel ? { start: sel.start, end: sel.end } : null)
      }),
    )
  }

  private reset(): void {
    this.list.replaceChildren()
    this.rendered = 0
    this.scroller.scrollTop = 0
    this.renderBatch()
  }

  private renderBatch(count = BATCH): void {
    const paragraphs = documents.paragraphs()
    const text = documents.text()
    if (this.rendered >= paragraphs.length) {
      this.updateStatus()
      return
    }
    const frag = document.createDocumentFragment()
    const end = Math.min(paragraphs.length, this.rendered + count)
    const sel = documents.state.selection
    for (let i = this.rendered; i < end; i++) {
      const p = paragraphs[i]
      const el = document.createElement('p')
      el.dataset.offset = String(p.start)
      el.dataset.end = String(p.end)
      el.dataset.index = String(i)
      el.textContent = text.slice(p.start, p.end)
      if (sel && p.end > sel.start && p.start < sel.end) el.classList.add('sel')
      frag.appendChild(el)
    }
    this.rendered = end
    this.list.appendChild(frag)
    this.updateStatus()
  }

  private updateStatus(): void {
    const total = documents.paragraphs().length
    if (total === 0) {
      this.status.textContent = documents.state.doc ? 'Empty document' : 'No document loaded'
      return
    }
    this.status.textContent = this.rendered >= total
      ? `${total.toLocaleString()} paragraphs`
      : `showing ${this.rendered.toLocaleString()} of ${total.toLocaleString()} paragraphs — scroll for more`
  }

  private ensureRenderedThrough(paragraphIndex: number): void {
    while (this.rendered <= paragraphIndex && this.rendered < documents.paragraphs().length) this.renderBatch(BATCH * 4)
  }

  private paragraphIndexAt(offset: number): number {
    const ps = documents.paragraphs()
    let lo = 0
    let hi = ps.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ps[mid].start <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Scroll so the paragraph containing `offset` is at the top of the viewer. */
  scrollToOffset(offset: number): void {
    const ps = documents.paragraphs()
    if (ps.length === 0) return
    const idx = this.paragraphIndexAt(Math.max(0, Math.min(offset, documents.text().length - 1)))
    this.ensureRenderedThrough(idx)
    const el = this.list.querySelector<HTMLElement>(`p[data-index="${idx}"]`)
    el?.scrollIntoView({ block: 'start' })
  }

  jumpToPercent(pct: number): void {
    if (!Number.isFinite(pct)) return
    const clamped = Math.max(0, Math.min(100, pct))
    this.scrollToOffset(Math.floor((clamped / 100) * documents.text().length))
  }

  private applyHighlight(sel: CharRange | null): void {
    for (const el of this.list.querySelectorAll<HTMLElement>('p[data-offset]')) {
      const start = Number(el.dataset.offset)
      const end = Number(el.dataset.end)
      el.classList.toggle('sel', Boolean(sel && end > sel.start && start < sel.end))
    }
  }

  private paragraphOf(node: Node | null): HTMLElement | null {
    if (!node) return null
    const el = node instanceof Element ? node : node.parentElement
    return (el?.closest('p[data-offset]') as HTMLElement | null) ?? null
  }

  private offsetWithin(p: HTMLElement, node: Node, off: number): number {
    const r = document.createRange()
    r.selectNodeContents(p)
    try {
      r.setEnd(node, off)
    } catch {
      return 0
    }
    return r.toString().length
  }

  private captureSelection(): void {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    if (!this.scroller.contains(range.commonAncestorContainer)) return
    const paragraphs = [...this.list.querySelectorAll<HTMLElement>('p[data-offset]')]
    let startP = this.paragraphOf(range.startContainer)
    let endP = this.paragraphOf(range.endContainer)
    let startOff: number
    let endOff: number
    if (startP) startOff = this.offsetWithin(startP, range.startContainer, range.startOffset)
    else {
      startP = paragraphs.find((p) => range.intersectsNode(p)) ?? null
      startOff = 0
    }
    if (endP) endOff = this.offsetWithin(endP, range.endContainer, range.endOffset)
    else {
      endP = [...paragraphs].reverse().find((p) => range.intersectsNode(p)) ?? null
      endOff = endP ? Number(endP.dataset.end) - Number(endP.dataset.offset) : 0
    }
    if (!startP || !endP) return
    const start = Number(startP.dataset.offset) + startOff
    const end = Number(endP.dataset.offset) + endOff
    if (end > start) documents.setSelection({ start, end })
  }
}
