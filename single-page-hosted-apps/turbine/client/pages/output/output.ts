/** OutputPage — watch the pump run, save what it has produced at any time. */
import { Component, DiamondCore, reactive } from '@diamondjs/runtime'
import * as T from './output.diamond.html'
import { job, type ChipVM } from '../../services/job.ts'
import { nav, ui } from '../../services/nav.ts'
import { tip as tipText } from '../../services/tooltips.ts'
import { TailFollower } from '../../components/tail-follower.ts'
import { SlideToConfirm } from '../../components/slide-to-confirm.ts'

function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export class OutputPage extends Component {
  createTemplate = (T as unknown as { createTemplate: (this: OutputPage) => HTMLElement }).createTemplate

  private liveTail = new TailFollower()
  private outTail = new TailFollower()
  private slider = new SlideToConfirm({ label: 'Slide right to clear output', onConfirm: () => this.clearNow() })
  @reactive confirmClear = false

  constructor(_params?: Record<string, unknown>) {
    super()
    ui.activeTab = 'output'
  }

  override mount(host: HTMLElement): void {
    super.mount(host)
    // Follow the newest text in the Live and Output panes while the reader is at the bottom.
    const cleanup = DiamondCore.effect(() => {
      void job.liveText()
      void job.state.outputVersion
      const root = this.getElement()
      this.liveTail.follow(root?.querySelector<HTMLElement>('.live') ?? null)
      this.liveTail.stick()
      this.outTail.follow(root?.querySelector<HTMLElement>('.output-text') ?? null)
      this.outTail.stick()
    })
    this.registerCleanup(cleanup)
    // The confirmation banner is hidden with a class rather than `if`, so its slider host always exists.
    const slideHost = this.getElement()?.querySelector<HTMLElement>('.slide-host')
    if (slideHost) this.slider.mount(slideHost)
  }

  override unmount(): void {
    this.slider.unmount()
    this.liveTail.detach()
    this.outTail.detach()
    super.unmount()
  }

  // ── clear output (guarded) ───────────────────────────────────────────────
  get canClear(): boolean {
    return job.canClear
  }
  get clearBannerClass(): string {
    return this.confirmClear ? 'banner danger' : 'banner danger hidden'
  }
  askClear(): void {
    if (!job.canClear) return
    this.confirmClear = true
    this.slider.reset()
    requestAnimationFrame(() => this.getElement()?.querySelector<HTMLElement>('.slide-knob')?.focus())
  }
  keepOutput(): void {
    this.confirmClear = false
    this.slider.reset()
  }
  clearNow(): void {
    try {
      job.clear()
      this.confirmClear = false
      nav.toast('Output cleared. The job\'s checkpoint stays on the server under data/jobs.')
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : String(e))
    }
  }

  tip(path: string): string {
    return tipText(path)
  }

  get hasJob(): boolean {
    return job.state.job !== null
  }
  get chips(): ChipVM[] {
    return job.state.chips
  }
  get sourceName(): string {
    return job.state.job?.source_name ?? ''
  }
  get statusText(): string {
    return job.state.status
  }
  get statusClass(): string {
    return `status status-${job.state.status}`
  }
  get doneCount(): number {
    return job.state.stats?.done ?? 0
  }
  get totalCount(): number {
    return job.state.stats?.total ?? job.state.job?.window_count ?? 0
  }
  get progressText(): string {
    const s = job.state.stats
    const total = this.totalCount
    if (!s) return `0 / ${total} windows`
    const extras = [s.flagged ? `${s.flagged} flagged` : '', s.failed ? `${s.failed} failed` : ''].filter(Boolean).join(', ')
    return `${s.done} / ${total} windows${extras ? ` (${extras})` : ''}`
  }
  get etaText(): string {
    const st = job.state.status
    const s = job.state.stats
    if (st === 'completed') return `finished in ${fmtDuration(s?.elapsed_ms ?? null)}`
    if (st !== 'running') return ''
    return `elapsed ${fmtDuration(s?.elapsed_ms ?? null)} · ETA ${fmtDuration(job.state.etaMs)}`
  }
  get tokensText(): string {
    const s = job.state.stats
    if (!s || (!s.prompt_tokens && !s.completion_tokens)) return ''
    return `${s.prompt_tokens.toLocaleString()} in / ${s.completion_tokens.toLocaleString()} out tokens`
  }
  get whereText(): string {
    const j = job.state.job
    if (!j) return ''
    return j.execution === 'browser' ? `${j.connection_name} · ${j.model} · from this browser` : `${j.connection_name} · ${j.model} · on the server`
  }
  get socketText(): string {
    if (!job.isServerRun) return ''
    const s = job.state.socket
    return s === 'open' ? '' : `events: ${s}`
  }
  get keyExpired(): boolean {
    return job.state.status === 'key-expired'
  }
  get lastError(): string {
    return job.state.lastError ?? ''
  }
  get canPause(): boolean {
    return job.state.status === 'running'
  }
  get canResume(): boolean {
    const s = job.state.status
    return s === 'paused' || s === 'halted' || (s === 'created' && !job.state.busy)
  }
  get canCancel(): boolean {
    const s = job.state.status
    return s === 'running' || s === 'paused' || s === 'key-expired'
  }
  get hasOutput(): boolean {
    void job.state.outputVersion
    return job.records().size > 0
  }
  get output(): string {
    return job.assembledOutput()
  }
  get outputChars(): string {
    return job.assembledOutput().length.toLocaleString()
  }
  get outputName(): string {
    return job.outputName()
  }
  get liveText(): string {
    return job.liveText()
  }
  get hasLive(): boolean {
    return job.liveText().length > 0
  }

  chipClass(c: ChipVM): string {
    return `chip-w ${c.status}`
  }

  async pause(): Promise<void> {
    await job.pause()
  }
  async resume(): Promise<void> {
    if (job.state.status === 'created') await job.start()
    else await job.resume()
  }
  async cancel(): Promise<void> {
    if (confirm('Cancel this job? Completed windows are kept.')) await job.cancel()
  }
  save(): void {
    job.save()
  }
  async copy(): Promise<void> {
    await job.copy()
  }
  async rerun(c: ChipVM): Promise<void> {
    if (c.status === 'running') return
    if (!confirm(`Run window ${c.index + 1} again?`)) return
    try {
      await job.rerun(c.index)
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : String(e))
    }
  }
  goConnect(): void {
    void nav.go('/connect?returnTo=/output')
  }
}
