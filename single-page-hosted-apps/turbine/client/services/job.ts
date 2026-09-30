/**
 * client/services/job.ts — one job at a time, page-independent.
 *
 * Two execution paths feed ONE store:
 *   server  → POST start, subscribe to the WebSocket, mirror events
 *   browser → drive shared/engine runJob() against the user's own local
 *             backend, checkpoint each window to the server, mirror events
 *
 * The output view re-assembles from the window records at most ~4×/s.
 */
import { DiamondCore } from '@diamondjs/runtime'
import { Print } from '@diamondjs/primafacie'
import type { JobStats, WindowEvent, WindowPlan, WindowRecord } from '../../shared/types.ts'
import type { JobInfo, JobSocketMessage, JobStatus } from '../../shared/api.ts'
import { assembleOutput, outputFilename } from '../../shared/engine/assemble.ts'
import { runJob, type RunControl } from '../../shared/engine/runner.ts'
import { api, openJobSocket, type JobSocket, type SocketStatus } from './api.ts'
import { documents } from './documents.ts'
import { nav } from './nav.ts'
import { prompt } from './prompt.ts'
import { session } from './session.ts'

const STORAGE_KEY = 'turbine.job'

export type ChipStatus = 'pending' | 'running' | 'ok' | 'flagged' | 'failed'

export interface ChipVM {
  index: number
  status: ChipStatus
  attempt: number
  detail: string
}

export interface JobState {
  job: JobInfo | null
  status: JobStatus | 'idle'
  chips: ChipVM[]
  stats: JobStats | null
  etaMs: number | null
  lastError: string | null
  creating: boolean
  busy: boolean
  socket: SocketStatus
  outputVersion: number
  liveVersion: number
  paused: boolean
}

export const state = DiamondCore.reactive<JobState>({
  job: null,
  status: 'idle',
  chips: [],
  stats: null,
  etaMs: null,
  lastError: null,
  creating: false,
  busy: false,
  socket: 'closed',
  outputVersion: 0,
  liveVersion: 0,
  paused: false,
})

// Non-reactive bulk data.
let records = new Map<number, WindowRecord>()
let live = new Map<number, string>()
let plan: WindowPlan[] = []
let socket: JobSocket | null = null
let assembledCache: { version: number; text: string } | null = null

// Browser-run control.
let abort: AbortController | null = null
let pausedFlag = false
let resumeWaiters: Array<() => void> = []
let browserRunning = false

let outputTimer: ReturnType<typeof setTimeout> | undefined
let liveTimer: ReturnType<typeof setTimeout> | undefined

function bumpOutput(): void {
  if (outputTimer) return
  outputTimer = setTimeout(() => {
    outputTimer = undefined
    state.outputVersion++
  }, 250)
}

function bumpLive(): void {
  if (liveTimer) return
  liveTimer = setTimeout(() => {
    liveTimer = undefined
    state.liveVersion++
  }, 200)
}

function remember(id: string | null): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable */
  }
}

function buildChips(): void {
  state.chips = plan.map((w) => {
    const r = records.get(w.index)
    return DiamondCore.reactive<ChipVM>({
      index: w.index,
      status: r ? r.status : 'pending',
      attempt: r?.attempt ?? 0,
      detail: r ? chipDetail(r) : '',
    })
  })
}

function chipDetail(r: WindowRecord): string {
  const parts = [`window ${r.index + 1}: ${r.status}`]
  if (r.validation.kind !== 'none') parts.push(`${r.validation.kind}${r.validation.score !== undefined ? ` ${r.validation.score}` : ''}`)
  if (r.error) parts.push(r.error)
  parts.push(`${r.attempt} attempt(s), ${Math.round(r.elapsed_ms / 1000)}s`)
  return parts.join(' · ')
}

function setJob(job: JobInfo | null): void {
  state.job = job
  state.status = job?.status ?? 'idle'
  plan = job?.plan ?? []
  if (job) {
    state.lastError = job.error
    remember(job.id)
  } else remember(null)
  assembledCache = null
  bumpOutput()
}

function applyRecords(list: WindowRecord[]): void {
  records = new Map(list.map((r) => [r.index, r]))
  live = new Map()
  buildChips()
  assembledCache = null
  bumpOutput()
  bumpLive()
}

function handleEvent(ev: WindowEvent): void {
  switch (ev.type) {
    case 'planned':
      plan = ev.windows
      if (state.chips.length !== plan.length) buildChips()
      break
    case 'window-start': {
      const c = state.chips[ev.index]
      if (c) {
        c.status = 'running'
        c.attempt = ev.attempt
      }
      live.set(ev.index, '')
      bumpLive()
      break
    }
    case 'window-token':
      live.set(ev.index, (live.get(ev.index) ?? '') + ev.chunk)
      bumpLive()
      break
    case 'window-done': {
      records.set(ev.record.index, ev.record)
      live.delete(ev.record.index)
      const c = state.chips[ev.record.index]
      if (c) {
        c.status = ev.record.status
        c.attempt = ev.record.attempt
        c.detail = chipDetail(ev.record)
      }
      assembledCache = null
      bumpOutput()
      bumpLive()
      break
    }
    case 'window-failed': {
      const c = state.chips[ev.index]
      if (c) c.detail = `attempt ${ev.attempt}: ${ev.error}`
      if (ev.final) state.lastError = `window ${ev.index + 1}: ${ev.error}`
      break
    }
    case 'progress':
      state.stats = ev.stats
      state.etaMs = ev.eta_ms
      break
    case 'paused':
      state.status = 'paused'
      state.paused = true
      break
    case 'resumed':
      state.status = 'running'
      state.paused = false
      break
    case 'halted':
      state.status = 'halted'
      state.lastError = ev.error
      break
    case 'complete':
      state.status = 'completed'
      state.stats = ev.stats
      state.etaMs = 0
      break
    case 'cancelled':
      state.status = 'cancelled'
      state.stats = ev.stats
      break
    default:
      break
  }
}

function closeSocket(): void {
  socket?.close()
  socket = null
}

function openSocket(jobId: string): void {
  closeSocket()
  socket = openJobSocket(
    jobId,
    (m: JobSocketMessage) => {
      switch (m.type) {
        case 'snapshot':
          state.job = m.job
          state.status = m.job.status
          plan = m.job.plan
          state.lastError = m.job.error
          applyRecords(m.windows)
          break
        case 'job':
          state.job = m.job
          state.status = m.job.status
          state.lastError = m.job.error
          if (m.job.status === 'completed' || m.job.status === 'cancelled' || m.job.status === 'failed') {
            live.clear()
            bumpLive()
          }
          break
        case 'event':
          handleEvent(m.event)
          break
        case 'error':
          state.lastError = m.error
          break
        default:
          break
      }
    },
    (s) => {
      state.socket = s
    },
  )
}

async function safeFinish(id: string, status: JobStatus, error?: string): Promise<void> {
  try {
    if (status === 'completed' || status === 'cancelled' || status === 'failed' || status === 'halted' || status === 'paused' || status === 'running' || status === 'key-expired') {
      const job = await api.jobs.finish(id, { status, ...(error ? { error } : {}) })
      state.job = job
    }
  } catch (e) {
    Print('WARNING', `finish(${status}) not recorded: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function runInBrowser(only?: number[]): Promise<void> {
  const job = state.job
  if (!job || browserRunning) return
  const text = documents.text()
  if (!text) throw new Error('The document text is not loaded in this browser; re-upload it to run a browser-side job.')
  const provider = session.providerForBrowser()
  abort = new AbortController()
  pausedFlag = false
  browserRunning = true
  state.status = 'running'
  state.paused = false
  state.lastError = null
  try {
    await api.jobs.action(job.id, 'start')
  } catch {
    await safeFinish(job.id, 'running')
  }
  const control: RunControl = {
    signal: abort.signal,
    plan,
    completed: [...records.entries()],
    only,
    pauseReason: () => (pausedFlag ? 'paused by user' : null),
    waitUntilResumed: () =>
      new Promise<void>((resolve) => {
        if (!pausedFlag) resolve()
        else resumeWaiters.push(resolve)
      }),
  }
  let terminal: JobStatus = 'completed'
  let terminalError: string | undefined
  try {
    for await (const ev of runJob(text, job.spec, provider, control)) {
      handleEvent(ev)
      if (ev.type === 'window-done') {
        void api.jobs.postResult(job.id, ev.record.index, ev.record).catch((e: unknown) => {
          Print('WARNING', `checkpoint for window ${ev.record.index + 1} failed: ${e instanceof Error ? e.message : String(e)}`)
        })
      } else if (ev.type === 'cancelled') terminal = 'cancelled'
      else if (ev.type === 'halted') {
        terminal = 'halted'
        terminalError = ev.error
      }
    }
  } catch (e) {
    terminal = 'failed'
    terminalError = e instanceof Error ? e.message : String(e)
    state.status = 'failed'
    state.lastError = terminalError
  } finally {
    browserRunning = false
    abort = null
    live.clear()
    bumpLive()
  }
  await safeFinish(job.id, terminal, terminalError)
}

function resumeBrowserWaiters(): void {
  const waiters = resumeWaiters
  resumeWaiters = []
  for (const w of waiters) w()
}

export const job = {
  state,
  plan: (): readonly WindowPlan[] => plan,
  records: (): ReadonlyMap<number, WindowRecord> => records,

  get isServerRun(): boolean {
    return state.job?.execution === 'server'
  },

  get isActive(): boolean {
    return state.status === 'running' || state.status === 'paused' || state.status === 'key-expired'
  },

  /** Create a job from the current document + prompt draft. Does not start it. */
  async create(): Promise<JobInfo> {
    const doc = documents.state.doc
    if (!doc) throw new Error('Upload a document first.')
    state.creating = true
    try {
      closeSocket()
      records = new Map()
      live = new Map()
      state.stats = null
      state.etaMs = null
      state.lastError = null
      const created = await api.jobs.create({ doc_id: doc.id, spec: prompt.specSnapshot() })
      setJob(created)
      buildChips()
      return created
    } finally {
      state.creating = false
    }
  },

  async start(): Promise<void> {
    const j = state.job
    if (!j) throw new Error('No job to start.')
    state.busy = true
    try {
      if (j.execution === 'server') {
        openSocket(j.id)
        const updated = await api.jobs.action(j.id, 'start')
        state.job = updated
        state.status = updated.status
      } else {
        void runInBrowser().catch((e: unknown) => {
          state.status = 'failed'
          state.lastError = e instanceof Error ? e.message : String(e)
        })
      }
    } finally {
      state.busy = false
    }
  },

  async pause(): Promise<void> {
    const j = state.job
    if (!j) return
    if (j.execution === 'server') {
      const updated = await api.jobs.action(j.id, 'pause')
      state.job = updated
      state.status = updated.status
    } else {
      pausedFlag = true
      state.paused = true
      state.status = 'paused'
      await safeFinish(j.id, 'paused')
    }
  },

  async resume(): Promise<void> {
    const j = state.job
    if (!j) return
    if (j.execution === 'server') {
      if (!socket) openSocket(j.id)
      const updated = await api.jobs.action(j.id, 'resume')
      state.job = updated
      state.status = updated.status
    } else if (browserRunning) {
      pausedFlag = false
      state.paused = false
      state.status = 'running'
      resumeBrowserWaiters()
    } else {
      // Resuming after a reload: the checkpointed records are already loaded; run the rest.
      await runInBrowser()
    }
  },

  async cancel(): Promise<void> {
    const j = state.job
    if (!j) return
    if (j.execution === 'server') {
      const updated = await api.jobs.action(j.id, 'cancel')
      state.job = updated
      state.status = updated.status
    } else {
      pausedFlag = false
      resumeBrowserWaiters()
      abort?.abort()
      if (!browserRunning) {
        state.status = 'cancelled'
        await safeFinish(j.id, 'cancelled')
      }
    }
  },

  async rerun(index: number): Promise<void> {
    const j = state.job
    if (!j) return
    const c = state.chips[index]
    if (c) {
      c.status = 'pending'
      c.detail = ''
    }
    if (j.execution === 'server') {
      if (!socket) openSocket(j.id)
      const updated = await api.jobs.rerun(j.id, index)
      state.job = updated
      state.status = updated.status
    } else {
      records.delete(index)
      await runInBrowser([index])
    }
  },

  /** Everything finished so far, in document order, with pending/failed markers. */
  assembledOutput(): string {
    const v = state.outputVersion
    if (assembledCache && assembledCache.version === v) return assembledCache.text
    const j = state.job
    const joiner = j?.spec.joiner ?? '\n\n'
    const text = assembleOutput(records, plan, { joiner, text: documents.text() || undefined, markPending: true })
    assembledCache = { version: v, text }
    return text
  },

  /** Streaming text of windows currently in flight. */
  liveText(): string {
    void state.liveVersion
    const parts: string[] = []
    for (const [i, t] of [...live.entries()].sort((a, b) => a[0] - b[0])) {
      parts.push(`── window ${i + 1} ──\n${t}`)
    }
    return parts.join('\n\n')
  },

  outputName(): string {
    return outputFilename(state.job?.source_name ?? documents.state.doc?.name ?? 'document')
  },

  save(): void {
    const text = job.assembledOutput()
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = job.outputName()
    a.rel = 'noopener'
    // A blob: URL is same-origin, so DiamondJS's document-level link interceptor would treat this
    // click as SPA navigation and land on not-found (Node0/diamondjs#14). The anchor stays detached
    // and the click stops at the element, so the interceptor never sees it.
    a.addEventListener('click', (e) => e.stopPropagation(), { once: true })
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
    nav.toast(`Saved ${job.outputName()}`)
  },

  /** Can the Output view be cleared right now? Never while the job is running, paused or waiting on a key. */
  get canClear(): boolean {
    return state.job !== null && !job.isActive
  },

  /**
   * Forget this job in this browser and empty the Output view. The server keeps the job and its
   * checkpoint file under data/jobs; only the browser's memory of it goes away.
   */
  clear(): void {
    if (!state.job) return
    if (job.isActive) throw new Error('Pause or cancel the job before clearing its output.')
    closeSocket()
    abort?.abort()
    abort = null
    browserRunning = false
    pausedFlag = false
    resumeWaiters = []
    setJob(null)
    applyRecords([])
    state.stats = null
    state.etaMs = null
    state.lastError = null
    state.busy = false
    state.paused = false
    state.socket = 'closed'
  },

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(job.assembledOutput())
      nav.toast('Output copied to the clipboard.')
    } catch (e) {
      nav.toast(`Copy failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  },

  /** On boot: reattach to the last job if the server still knows it. */
  async restore(): Promise<void> {
    let id: string | null = null
    try {
      id = localStorage.getItem(STORAGE_KEY)
    } catch {
      return
    }
    if (!id) return
    try {
      const j = await api.jobs.get(id)
      setJob(j)
      const list = await api.jobs.windows(id)
      applyRecords(list)
      state.stats = {
        done: list.length,
        flagged: list.filter((r) => r.status === 'flagged').length,
        failed: list.filter((r) => r.status === 'failed').length,
        total: j.window_count,
        elapsed_ms: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
      }
      if (j.execution === 'server' && (j.status === 'running' || j.status === 'paused' || j.status === 'key-expired')) openSocket(id)
      if (j.execution === 'browser' && j.status === 'running') {
        // The tab that was running it is gone; what's checkpointed is what we have.
        state.status = 'paused'
        state.paused = true
      }
    } catch {
      remember(null)
    }
  },

  detach(): void {
    closeSocket()
    abort?.abort()
    setJob(null)
    records = new Map()
    live = new Map()
    state.chips = []
    state.stats = null
    state.etaMs = null
  },
}
