/**
 * PromptPage — write the instructions, tune the window, preview against any
 * selection, launch the job. All fields forward to services/prompt.ts so the
 * draft survives tab changes; the page itself is rebuilt on every navigation.
 */
import { Component, reactive } from '@diamondjs/runtime'
import { Print } from '@diamondjs/primafacie'
import * as T from './prompt.diamond.html'
import type { ChatMessage, WindowPlan } from '../../../shared/types.ts'
import type { PreviewEvent } from '../../../shared/api.ts'
import { planFromSelection } from '../../../shared/engine/planner.ts'
import { buildMessages, cleanOutput } from '../../../shared/engine/runner.ts'
import { TEMPLATE_VARS } from '../../../shared/engine/template.ts'
import { validateWindow } from '../../../shared/engine/validators.ts'
import { SourceViewer } from '../../components/source-viewer.ts'
import { TailFollower } from '../../components/tail-follower.ts'
import { ModelParamsForm } from '../../components/model-params.ts'
import { api } from '../../services/api.ts'
import { documents } from '../../services/documents.ts'
import { job } from '../../services/job.ts'
import { nav, ui } from '../../services/nav.ts'
import { prompt } from '../../services/prompt.ts'
import { session } from '../../services/session.ts'
import { tip as tipText } from '../../services/tooltips.ts'

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export class PromptPage extends Component {
  createTemplate = (T as unknown as { createTemplate: (this: PromptPage) => HTMLElement }).createTemplate
  private viewer = new SourceViewer({ compact: true })
  private paramsForm = new ModelParamsForm()
  private tail = new TailFollower()
  private previewAbort: AbortController | null = null
  private lastUserTemplateEl: HTMLTextAreaElement | null = null
  private genTimer: ReturnType<typeof setInterval> | undefined
  private promptChars = 0

  @reactive previewing = false
  @reactive previewOutput = ''
  @reactive previewMessages = ''
  @reactive previewError = ''
  @reactive previewMeta = ''
  @reactive startError = ''
  @reactive starting = false
  @reactive genTokens = 0
  @reactive genExact = false
  @reactive genFinal = ''

  readonly templateVars: string[] = [...TEMPLATE_VARS].map((v) => `{{${v}}}`)

  constructor(_params?: Record<string, unknown>) {
    super()
    ui.activeTab = 'prompt'
  }

  override mount(host: HTMLElement): void {
    super.mount(host)
    const root = this.getElement()
    const slot = root?.querySelector<HTMLElement>('.viewer-host')
    if (slot) this.viewer.mount(slot)
    const paramsSlot = root?.querySelector<HTMLElement>('.params-host')
    if (paramsSlot) this.paramsForm.mount(paramsSlot)
    // The second textarea is the user template; remember it for caret insertion.
    const areas = root?.querySelectorAll<HTMLTextAreaElement>('textarea') ?? []
    this.lastUserTemplateEl = areas[1] ?? null
    const focus = prompt.previewFocus()
    if (focus) this.viewer.scrollToOffset(focus.start)
    this.tail.follow(root?.querySelector<HTMLElement>('.preview-out') ?? null)
  }

  override unmount(): void {
    this.previewAbort?.abort()
    this.stopGenTimer()
    this.tail.detach()
    this.paramsForm.unmount()
    this.viewer.unmount()
    super.unmount()
  }

  tip(path: string): string {
    return tipText(path)
  }

  // ── prompt text ──────────────────────────────────────────────────────────
  get systemPrompt(): string {
    return prompt.state.spec.systemPrompt
  }
  set systemPrompt(v: unknown) {
    prompt.state.spec.systemPrompt = String(v ?? '')
  }
  get userTemplate(): string {
    return prompt.state.spec.userTemplate
  }
  set userTemplate(v: unknown) {
    prompt.state.spec.userTemplate = String(v ?? '')
  }
  get unknownVars(): string {
    return prompt.state.unknownVars.join(', ')
  }
  insertVar(v: string): void {
    const el = this.lastUserTemplateEl
    const current = prompt.state.spec.userTemplate
    if (!el) {
      prompt.state.spec.userTemplate = current + v
      return
    }
    const start = el.selectionStart ?? current.length
    const end = el.selectionEnd ?? start
    prompt.state.spec.userTemplate = current.slice(0, start) + v + current.slice(end)
    queueMicrotask(() => {
      el.focus()
      el.setSelectionRange(start + v.length, start + v.length)
    })
  }
  resetPrompts(): void {
    prompt.resetPrompts()
  }

  // ── window ───────────────────────────────────────────────────────────────
  get focusTokens(): number {
    return prompt.state.focusTokens
  }
  set focusTokens(v: unknown) {
    prompt.setFocusTokens(v)
  }
  get ctxBeforeTokens(): number {
    return prompt.state.ctxBeforeTokens
  }
  set ctxBeforeTokens(v: unknown) {
    prompt.setCtxBeforeTokens(v)
  }
  get ctxAfterTokens(): number {
    return prompt.state.ctxAfterTokens
  }
  set ctxAfterTokens(v: unknown) {
    prompt.setCtxAfterTokens(v)
  }
  get snap(): string {
    return prompt.state.spec.window.snap
  }
  set snap(v: unknown) {
    prompt.state.spec.window.snap = v === 'sentence' ? 'sentence' : v === 'none' ? 'none' : 'paragraph'
  }
  get onlySelection(): boolean {
    return prompt.state.onlySelection
  }
  toggleOnlySelection(e: Event): void {
    prompt.setOnlySelection((e.target as HTMLInputElement).checked)
  }

  // ── run settings ─────────────────────────────────────────────────────────
  get mode(): string {
    return prompt.state.spec.mode
  }
  set mode(v: unknown) {
    prompt.state.spec.mode = v === 'fold' ? 'fold' : 'map'
  }
  get isMap(): boolean {
    return prompt.state.spec.mode === 'map'
  }
  get isFold(): boolean {
    return prompt.state.spec.mode === 'fold'
  }
  get maxConcurrency(): number {
    return session.state.config?.max_concurrency ?? 8
  }
  get concurrency(): number {
    return prompt.state.spec.concurrency
  }
  set concurrency(v: unknown) {
    prompt.state.spec.concurrency = Math.max(1, Math.min(this.maxConcurrency, Math.round(num(v, 1))))
  }
  get carryKind(): string {
    return prompt.state.spec.carry.kind
  }
  set carryKind(v: unknown) {
    prompt.state.spec.carry.kind = v === 'none' ? 'none' : 'tail'
  }
  get showCarryChars(): boolean {
    return this.isFold && prompt.state.spec.carry.kind === 'tail'
  }
  get carryChars(): number {
    return prompt.state.spec.carry.chars
  }
  set carryChars(v: unknown) {
    prompt.state.spec.carry.chars = Math.max(0, Math.round(num(v, 0)))
  }
  get maxTokens(): number {
    return prompt.state.spec.generation.max_tokens
  }
  set maxTokens(v: unknown) {
    prompt.state.spec.generation.max_tokens = Math.max(16, Math.round(num(v, 2048)))
  }
  get maxTokensAuto(): boolean {
    return prompt.state.maxTokensAuto
  }
  toggleMaxTokensAuto(e: Event): void {
    prompt.setMaxTokensAuto((e.target as HTMLInputElement).checked)
  }
  get autoMaxTokensNote(): string {
    void prompt.state.planVersion
    const e = prompt.state.estimate
    if (!prompt.state.maxTokensAuto) return 'set by hand'
    return e ? `1.5× the largest slice (${e.max_focus_tokens.toLocaleString()} tok) + margin` : '1.5× the largest slice + margin'
  }
  get mayTruncate(): boolean {
    void prompt.state.planVersion
    return Boolean(prompt.state.estimate?.max_tokens_may_truncate)
  }
  get truncateNote(): string {
    const e = prompt.state.estimate
    if (!e) return ''
    return `Max output tokens (${prompt.state.spec.generation.max_tokens.toLocaleString()}) is below the largest slice (≈${e.max_focus_tokens.toLocaleString()} tokens): that window's output may be cut off. Raise it or tick Auto.`
  }
  get cptNote(): string {
    void prompt.state.planVersion
    return prompt.cptLabel()
  }
  get validatorKind(): string {
    return prompt.state.spec.validator.kind
  }
  set validatorKind(v: unknown) {
    prompt.state.spec.validator.kind = v === 'conserve' ? 'conserve' : v === 'length-ratio' ? 'length-ratio' : 'none'
  }
  get isConserve(): boolean {
    return prompt.state.spec.validator.kind === 'conserve'
  }
  get isRatio(): boolean {
    return prompt.state.spec.validator.kind === 'length-ratio'
  }
  get threshold(): number {
    return prompt.state.spec.validator.threshold ?? 0.95
  }
  set threshold(v: unknown) {
    prompt.state.spec.validator.threshold = Math.max(0, Math.min(1, num(v, 0.95)))
  }
  get minRatio(): number {
    return prompt.state.spec.validator.minRatio ?? 0.5
  }
  set minRatio(v: unknown) {
    prompt.state.spec.validator.minRatio = Math.max(0, num(v, 0.5))
  }
  get maxRatio(): number {
    return prompt.state.spec.validator.maxRatio ?? 2
  }
  set maxRatio(v: unknown) {
    prompt.state.spec.validator.maxRatio = Math.max(0, num(v, 2))
  }
  get maxAttempts(): number {
    return prompt.state.spec.retry.maxAttempts
  }
  set maxAttempts(v: unknown) {
    prompt.state.spec.retry.maxAttempts = Math.max(1, Math.min(10, Math.round(num(v, 3))))
  }

  // ── model parameters ─────────────────────────────────────────────────────
  get modelName(): string {
    return session.state.connection?.model ?? ''
  }
  get modelLoading(): boolean {
    return prompt.state.modelInfoStatus === 'loading'
  }
  get refreshLabel(): string {
    return this.modelLoading ? 'Refreshing…' : 'Refresh from backend'
  }
  get modelFacts(): string {
    const i = prompt.state.modelInfo
    if (!i) return ''
    const parts: string[] = []
    if (i.context_length) parts.push(`context ${i.context_length.toLocaleString()} tok`)
    if (i.max_output_tokens) parts.push(`max output ${i.max_output_tokens.toLocaleString()} tok`)
    const ctx = session.state.connection?.ctx_len
    if (ctx && i.context_length && ctx < i.context_length) parts.push(`connection budgets ${ctx.toLocaleString()}`)
    return parts.join(' · ')
  }
  get modelSource(): string {
    const i = prompt.state.modelInfo
    if (!i) return prompt.state.modelInfoStatus === 'idle' ? '' : ''
    const n = i.parameters.length
    return `Discovered via ${i.source}: ${n} adjustable parameter${n === 1 ? '' : 's'}${i.capabilities?.length ? ` · capabilities: ${i.capabilities.join(', ')}` : ''}.`
  }
  get modelError(): string {
    return prompt.state.modelInfoStatus === 'error' ? prompt.state.modelInfoError : ''
  }
  get modelNotes(): string[] {
    return prompt.state.modelInfo?.notes ?? []
  }
  async refreshModel(): Promise<void> {
    await prompt.discoverModel(true)
  }
  resetModelParams(): void {
    prompt.resetModelParams()
  }

  // ── plan ─────────────────────────────────────────────────────────────────
  get hasDoc(): boolean {
    return documents.state.doc !== null
  }
  get windowCount(): string {
    void prompt.state.planVersion
    return (prompt.state.estimate?.window_count ?? 0).toLocaleString()
  }
  get avgPrompt(): string {
    return (prompt.state.estimate?.avg_prompt_tokens ?? 0).toLocaleString()
  }
  get maxPrompt(): string {
    return (prompt.state.estimate?.max_prompt_tokens ?? 0).toLocaleString()
  }
  get ctxLen(): string {
    return (prompt.state.estimate?.ctx_len ?? session.state.connection?.ctx_len ?? 0).toLocaleString()
  }
  get totalTokens(): string {
    return (prompt.state.estimate?.est_total_tokens ?? 0).toLocaleString()
  }
  get overBudget(): boolean {
    const e = prompt.state.estimate
    return Boolean(e && !e.fits_context)
  }
  get eta(): string {
    void prompt.state.planVersion
    return fmtDuration(prompt.etaMs())
  }
  get etaNote(): string {
    return prompt.state.measuredCps
      ? `Time estimate uses the last preview's measured speed (${Math.round(prompt.state.measuredCps)} chars/s).`
      : 'Time estimate assumes ~20 s per window until a preview measures the real speed.'
  }
  get canStart(): boolean {
    return this.hasDoc && !this.starting && !this.overBudget && (prompt.state.estimate?.window_count ?? 0) > 0 && session.state.connected && !job.isActive
  }
  get startLabel(): string {
    if (this.starting) return 'Starting…'
    if (job.isActive) return 'A job is already running (see Output)'
    return 'Start job'
  }
  async startJob(): Promise<void> {
    this.startError = ''
    this.starting = true
    try {
      await job.create()
      await job.start()
      await nav.go('/output')
    } catch (e) {
      this.startError = e instanceof Error ? e.message : String(e)
    } finally {
      this.starting = false
    }
  }

  // ── selection + preview ──────────────────────────────────────────────────
  get hasSelection(): boolean {
    return documents.state.selection !== null
  }
  get selStart(): string {
    return (documents.state.selection?.start ?? 0).toLocaleString()
  }
  get selEnd(): string {
    return (documents.state.selection?.end ?? 0).toLocaleString()
  }
  clearSelection(): void {
    documents.setSelection(null)
  }
  get focusTokensText(): string {
    void prompt.state.planVersion
    const focus = prompt.previewFocus()
    if (!focus) return ''
    const c = prompt.tokenCount(documents.text().slice(focus.start, focus.end))
    return `${c.exact ? '' : '≈ '}${c.tokens.toLocaleString()} tokens`
  }
  get focusCharsText(): string {
    const s = documents.state.selection
    if (!s) return ''
    return `${(s.end - s.start).toLocaleString()} chars · positions ${s.start.toLocaleString()}–${s.end.toLocaleString()}`
  }
  get genTokensText(): string {
    if (this.genFinal) return this.genFinal
    if (!this.previewing && this.genTokens === 0) return ''
    return `${this.genExact ? '' : '≈ '}${this.genTokens.toLocaleString()} tokens`
  }
  private startGenTimer(): void {
    this.stopGenTimer()
    const tick = (): void => {
      const c = prompt.tokenCount(this.previewOutput)
      this.genTokens = c.tokens
      this.genExact = c.exact
    }
    this.genTimer = setInterval(tick, 1000)
  }
  private stopGenTimer(): void {
    if (this.genTimer !== undefined) clearInterval(this.genTimer)
    this.genTimer = undefined
  }
  get canPreview(): boolean {
    void prompt.state.planVersion
    return this.hasDoc && !this.previewing && session.state.connected && prompt.previewFocus() !== null
  }
  get previewWhere(): string {
    const ex = session.state.execution
    if (!ex) return ''
    return ex === 'browser' ? 'runs from this browser' : 'runs on the server'
  }

  private renderMessages(messages: ChatMessage[]): string {
    return messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n')
  }

  async runPreview(): Promise<void> {
    const doc = documents.state.doc
    const focus = prompt.previewFocus()
    if (!doc || !focus) return
    this.previewing = true
    this.previewError = ''
    this.previewOutput = ''
    this.previewMeta = ''
    this.genTokens = 0
    this.genExact = false
    this.genFinal = ''
    this.promptChars = 0
    this.tail.reset()
    this.startGenTimer()
    this.previewAbort = new AbortController()
    const signal = this.previewAbort.signal
    const spec = prompt.specSnapshot()
    const t0 = performance.now()
    try {
      if (session.state.execution === 'browser') {
        const text = documents.text()
        const w: WindowPlan = planFromSelection(text, spec.window, focus)
        const messages = buildMessages(text, spec, w, { carry: '', count: Math.max(1, prompt.windows().length) })
        this.previewMessages = this.renderMessages(messages)
        this.promptChars = messages.reduce((n, m) => n + m.content.length, 0)
        const provider = session.providerForBrowser()
        const result = await provider.generate(messages, {
          temperature: spec.generation.temperature,
          max_tokens: spec.generation.max_tokens,
          num_ctx: spec.generation.num_ctx,
          reasoning: spec.generation.reasoning ?? 'off',
          params: spec.generation.params,
          signal,
          onToken: (chunk) => {
            this.previewOutput += chunk
            this.tail.stick()
          },
        })
        const output = cleanOutput(result.text)
        this.previewOutput = output
        this.tail.stick()
        const validation = validateWindow(spec.validator, text.slice(w.focusStart, w.focusEnd).trim(), output)
        this.finishPreview(output, result.elapsed_ms, result.model, validation.ok ? `validation ok${validation.score !== undefined ? ` (${validation.score})` : ''}` : `validation FAILED: ${validation.reason}`, result.usage)
      } else {
        await api.preview.stream(
          { doc_id: doc.id, spec, focus },
          (ev: PreviewEvent) => {
            switch (ev.type) {
              case 'messages':
                this.previewMessages = this.renderMessages(ev.messages)
                this.promptChars = ev.messages.reduce((n, m) => n + m.content.length, 0)
                break
              case 'token':
                this.previewOutput += ev.chunk
                this.tail.stick()
                break
              case 'done':
                this.previewOutput = ev.output
                this.tail.stick()
                this.finishPreview(ev.output, ev.elapsed_ms, ev.model, ev.validation.ok ? `validation ok${ev.validation.score !== undefined ? ` (${ev.validation.score})` : ''}` : `validation FAILED: ${ev.validation.reason}`, ev.usage)
                break
              case 'error':
                this.previewError = ev.error
                break
              default:
                break
            }
          },
          signal,
        )
      }
    } catch (e) {
      if (!signal.aborted) this.previewError = e instanceof Error ? e.message : String(e)
      else this.previewMeta = `stopped after ${fmtDuration(performance.now() - t0)}`
    } finally {
      this.stopGenTimer()
      if (!this.genFinal) {
        const c = prompt.tokenCount(this.previewOutput)
        this.genTokens = c.tokens
        this.genExact = c.exact
      }
      this.previewing = false
      this.previewAbort = null
    }
  }

  private finishPreview(output: string, elapsedMs: number, model: string, validationNote: string, usage?: { prompt_tokens?: number; completion_tokens?: number }): void {
    prompt.recordMeasurement(output.length, elapsedMs)
    prompt.recordUsage(this.promptChars, usage?.prompt_tokens)
    const out = usage?.completion_tokens
    const inn = usage?.prompt_tokens
    if (out || inn) {
      this.genFinal = `${(out ?? 0).toLocaleString()} tokens out · ${(inn ?? 0).toLocaleString()} in (model count)`
      if (out) {
        this.genTokens = out
        this.genExact = true
      }
    }
    const tps = out && elapsedMs > 0 ? ` · ${(out / (elapsedMs / 1000)).toFixed(1)} tok/s` : ''
    this.previewMeta = `${model} · ${fmtDuration(elapsedMs)}${tps} · ${output.length.toLocaleString()} chars · ${validationNote}`
    Print('SUCCESS', `preview done in ${Math.round(elapsedMs)} ms`)
  }

  stopPreview(): void {
    this.previewAbort?.abort()
  }
}
