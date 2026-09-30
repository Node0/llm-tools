/**
 * server/jobs.ts — the job manager.
 *
 * A job is a JobSpec + a plan + a growing checkpoint file:
 *   <data_dir>/jobs/<id>/job.json                 owner, connection, JobInfo
 *   <data_dir>/jobs/<id>/<stem>__turbine.jsonl    one WindowRecord per line
 *
 * Server-executed jobs drive shared/engine/runner.ts here; browser-executed
 * jobs (public deployment + local backend) run the same engine in the
 * browser and POST each WindowRecord back, so the checkpoint, the output and
 * the provenance log are identical either way. Later JSONL lines override
 * earlier ones for the same index, so a rerun appends rather than rewrites.
 *
 * Key expiry mid-job: the runner's gate asks `pauseReason()` before every
 * window; when the vault no longer holds the session's key the job parks in
 * 'key-expired'. Re-connecting restarts it from the checkpoint with a fresh
 * provider (so a changed key is honored).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Execution, JobFinishRequest, JobInfo, JobSocketMessage, JobStatus } from '../shared/api.ts'
import { validateJobSpec } from '../shared/defaults.ts'
import { assembleOutput, computeStats, estimatePlan, outputFilename, planWindows, randomId, runJob, type RunControl } from '../shared/engine/index.ts'
import { createProvider } from '../shared/providers/index.ts'
import type { ConnectionSpec, Provider, WindowEvent, WindowRecord } from '../shared/types.ts'
import type { TurbineConfig } from './config.ts'
import type { DocStore } from './docs.ts'
import { HttpError, badRequest, conflict, notFound, unauthorized } from './errors.ts'
import { KeyVault, VaultMissError } from './keyvault.ts'
import { errorMessage, log } from './log.ts'
import { assertServerMayCall, decideExecution } from './policy.ts'
import type { Session, SessionStore } from './sessions.ts'

interface Run {
  abort: AbortController
  pausedByUser: boolean
  /** Set when the manager stops a run for its own reasons (restart on key restore); status stays 'paused'. */
  internalStop: boolean
  waiters: Array<() => void>
  done: Promise<void>
}

interface Persisted {
  owner: string
  connection: ConnectionSpec
  preset_name: string | null
  info: JobInfo
}

interface JobState extends Persisted {
  dir: string
  checkpointPath: string
  records: Map<number, WindowRecord> | null
  run: Run | null
  subscribers: Set<(msg: JobSocketMessage) => void>
  tokenBuf: Map<number, string>
  flushTimer: ReturnType<typeof setTimeout> | null
}

const ACTIVE = new Set<JobStatus>(['created', 'running', 'paused', 'key-expired'])
const TERMINAL = new Set<JobStatus>(['completed', 'cancelled', 'failed', 'halted'])
const ID_RE = /^[0-9a-f]{32}$/
const TOKEN_FLUSH_MS = 80

export class JobManager {
  private readonly jobs = new Map<string, JobState>()
  private readonly dir: string

  constructor(
    private readonly config: TurbineConfig,
    private readonly docs: DocStore,
    private readonly vault: KeyVault,
    private readonly sessions: SessionStore,
  ) {
    this.dir = join(config.server.data_dir, 'jobs')
    mkdirSync(this.dir, { recursive: true })
    this.loadFromDisk()
    this.vault.onExpire((sessionId) => this.onKeyExpired(sessionId))
  }

  // ─── persistence ──────────────────────────────────────────────────────────

  private loadFromDisk(): void {
    let n = 0
    for (const id of readdirSync(this.dir)) {
      if (!ID_RE.test(id)) continue
      const file = join(this.dir, id, 'job.json')
      if (!existsSync(file)) continue
      try {
        const p = JSON.parse(readFileSync(file, 'utf8')) as Persisted
        const state = this.stateFrom(p)
        // The process died mid-flight: anything that was running parks as paused, resumable from the checkpoint.
        if (p.info.status === 'running' || p.info.status === 'key-expired') {
          state.info.status = 'paused'
          this.persist(state)
        }
        this.jobs.set(id, state)
        n++
      } catch (e) {
        log('WARNING', `job ${id} unreadable: ${errorMessage(e)}`)
      }
    }
    if (n) log('STATE', `restored ${n} job(s) from ${this.dir}`)
  }

  private stateFrom(p: Persisted): JobState {
    const dir = join(this.dir, p.info.id)
    return {
      ...p,
      dir,
      checkpointPath: join(dir, p.info.checkpoint_file.split('/').pop() ?? 'checkpoint.jsonl'),
      records: null,
      run: null,
      subscribers: new Set(),
      tokenBuf: new Map(),
      flushTimer: null,
    }
  }

  private persist(state: JobState): void {
    const p: Persisted = { owner: state.owner, connection: state.connection, preset_name: state.preset_name, info: state.info }
    const file = join(state.dir, 'job.json')
    mkdirSync(state.dir, { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(p))
    renameSync(`${file}.tmp`, file)
  }

  private recordsOf(state: JobState): Map<number, WindowRecord> {
    if (state.records) return state.records
    const map = new Map<number, WindowRecord>()
    if (existsSync(state.checkpointPath)) {
      const lines = readFileSync(state.checkpointPath, 'utf8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as WindowRecord
          if (Number.isInteger(r.index) && r.index >= 0 && r.index < state.info.window_count) map.set(r.index, r)
        } catch {
          log('WARNING', `job ${state.info.id}: skipping a corrupt checkpoint line`)
        }
      }
    }
    state.records = map
    this.refreshCounts(state)
    return map
  }

  private appendRecord(state: JobState, record: WindowRecord): void {
    const records = this.recordsOf(state)
    records.set(record.index, record)
    appendFileSync(state.checkpointPath, JSON.stringify(record) + '\n')
    this.refreshCounts(state)
  }

  private refreshCounts(state: JobState): void {
    const records = state.records ?? new Map()
    const s = computeStats(records, state.info.window_count, 0)
    state.info.done_count = s.done
    state.info.flagged_count = s.flagged
    state.info.failed_count = s.failed
  }

  // ─── lookup ───────────────────────────────────────────────────────────────

  private owned(owner: string, id: string): JobState {
    const s = ID_RE.test(id) ? this.jobs.get(id) : undefined
    if (!s || s.owner !== owner) throw notFound(`job ${id} not found`)
    return s
  }

  list(owner: string): JobInfo[] {
    return [...this.jobs.values()].filter((j) => j.owner === owner).map((j) => this.snapshot(j)).sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  get(owner: string, id: string): JobInfo {
    return this.snapshot(this.owned(owner, id))
  }

  private snapshot(state: JobState): JobInfo {
    this.recordsOf(state)
    return { ...state.info, spec: state.info.spec, plan: state.info.plan }
  }

  windows(owner: string, id: string): WindowRecord[] {
    return [...this.recordsOf(this.owned(owner, id)).values()].sort((a, b) => a.index - b.index)
  }

  output(owner: string, id: string): { filename: string; text: string } {
    const state = this.owned(owner, id)
    const text = this.docs.textUnchecked(state.info.doc_id)
    return {
      filename: state.info.output_filename,
      text: assembleOutput(this.recordsOf(state), state.info.plan, { joiner: state.info.spec.joiner, text, markPending: true }),
    }
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  create(session: Session, docId: string, specInput: unknown): JobInfo {
    if (!session.connection) throw unauthorized('connect to an inference provider first', 'not-connected')
    if (!this.sessions.isConnected(session)) throw unauthorized('no API key is held for this session; unlock it first', 'key-required')
    const active = [...this.jobs.values()].filter((j) => j.owner === session.id && ACTIVE.has(j.info.status)).length
    if (active >= this.config.limits.max_jobs_per_session) {
      throw conflict(`this session already has ${active} active job(s); the limit is ${this.config.limits.max_jobs_per_session}. Cancel or finish one first.`, 'too-many-jobs')
    }
    const doc = this.docs.get(session.id, docId)
    const text = this.docs.textUnchecked(docId)
    let spec
    try {
      spec = validateJobSpec(specInput, { max_concurrency: this.config.limits.max_concurrency })
    } catch (e) {
      throw badRequest(errorMessage(e), 'invalid-spec')
    }
    if (!spec.sourceName || spec.sourceName === 'document') spec.sourceName = doc.name
    let plan
    try {
      plan = planWindows(text, spec.window, spec.range)
    } catch (e) {
      throw badRequest(errorMessage(e), 'invalid-window')
    }
    if (plan.length === 0) throw badRequest('the plan has zero windows (empty range?)', 'empty-plan')
    const connection = session.connection
    const estimate = estimatePlan(plan, spec, connection.ctx_len)
    const execution: Execution = decideExecution(this.config, connection)
    if (execution === 'server') assertServerMayCall(this.config, connection)
    const id = randomId(16)
    const info: JobInfo = {
      id,
      doc_id: doc.id,
      source_name: doc.name,
      connection_name: connection.name,
      model: connection.model,
      execution,
      status: 'created',
      spec,
      plan,
      estimate,
      window_count: plan.length,
      done_count: 0,
      flagged_count: 0,
      failed_count: 0,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      error: null,
      output_filename: outputFilename(doc.name, 'transformed', 'md'),
      checkpoint_file: `jobs/${id}/${outputFilename(doc.name, 'turbine', 'jsonl')}`,
    }
    const state = this.stateFrom({ owner: session.id, connection, preset_name: session.preset_name, info })
    state.records = new Map()
    mkdirSync(state.dir, { recursive: true })
    writeFileSync(state.checkpointPath, '')
    this.persist(state)
    this.jobs.set(id, state)
    log('STATE', `job ${id} created: ${plan.length} window(s), ${execution}-executed, ${connection.name}/${connection.model}`)
    return this.snapshot(state)
  }

  start(owner: string, id: string): JobInfo {
    const state = this.owned(owner, id)
    if (state.run) throw conflict('job is already running', 'already-running')
    if (TERMINAL.has(state.info.status)) throw conflict(`job is ${state.info.status}; create a new job to run it again`, 'finished')
    if (state.info.execution === 'browser') {
      this.setStatus(state, 'running')
      if (!state.info.started_at) state.info.started_at = new Date().toISOString()
      this.persist(state)
      return this.snapshot(state)
    }
    this.launch(state, undefined)
    return this.snapshot(state)
  }

  pause(owner: string, id: string): JobInfo {
    const state = this.owned(owner, id)
    if (state.info.execution === 'browser') {
      if (state.info.status === 'running') this.setStatus(state, 'paused')
      return this.snapshot(state)
    }
    if (!state.run) throw conflict('job is not running', 'not-running')
    state.run.pausedByUser = true
    this.setStatus(state, 'paused') // in-flight windows still land; new ones wait at the gate
    return this.snapshot(state)
  }

  resume(owner: string, id: string): JobInfo {
    const state = this.owned(owner, id)
    if (TERMINAL.has(state.info.status)) throw conflict(`job is ${state.info.status}`, 'finished')
    if (state.info.execution === 'browser') {
      this.setStatus(state, 'running')
      return this.snapshot(state)
    }
    if (state.run) {
      state.run.pausedByUser = false
      this.wake(state)
      return this.snapshot(state)
    }
    this.launch(state, undefined)
    return this.snapshot(state)
  }

  cancel(owner: string, id: string): JobInfo {
    const state = this.owned(owner, id)
    if (TERMINAL.has(state.info.status)) return this.snapshot(state)
    if (state.run) {
      state.run.abort.abort()
      this.wake(state)
    } else {
      this.setStatus(state, 'cancelled')
      state.info.finished_at = new Date().toISOString()
      this.persist(state)
    }
    return this.snapshot(state)
  }

  rerun(owner: string, id: string, index: number): JobInfo {
    const state = this.owned(owner, id)
    if (!Number.isInteger(index) || index < 0 || index >= state.info.window_count) throw badRequest(`window index ${index} out of range`, 'bad-index')
    if (state.run) throw conflict('job is running; pause or wait for it to finish before re-running a window', 'already-running')
    if (state.info.execution === 'browser') {
      // The browser re-generates and posts a fresh result; drop the stale one so progress reflects reality.
      this.recordsOf(state).delete(index)
      this.refreshCounts(state)
      if (TERMINAL.has(state.info.status)) this.setStatus(state, 'paused')
      this.emit(state, { type: 'job', job: this.snapshot(state) })
      return this.snapshot(state)
    }
    this.launch(state, [index])
    return this.snapshot(state)
  }

  /** Browser-executed jobs post each WindowRecord here; it becomes the checkpoint of record. */
  recordWindow(owner: string, id: string, input: unknown): JobInfo {
    const state = this.owned(owner, id)
    if (state.info.execution !== 'browser') throw conflict('this job is server-executed; the server writes its own checkpoints', 'server-executed')
    if (TERMINAL.has(state.info.status) && state.info.status !== 'completed') throw conflict(`job is ${state.info.status}`, 'finished')
    const record = sanitizeRecord(input, state.info.window_count)
    this.appendRecord(state, record)
    if (state.info.status === 'created') this.setStatus(state, 'running')
    this.emit(state, { type: 'event', event: { type: 'window-done', record } })
    const stats = computeStats(this.recordsOf(state), state.info.window_count, state.info.started_at ? Date.now() - Date.parse(state.info.started_at) : 0)
    this.emit(state, { type: 'event', event: { type: 'progress', stats, eta_ms: null } })
    return this.snapshot(state)
  }

  finish(owner: string, id: string, body: JobFinishRequest): JobInfo {
    const state = this.owned(owner, id)
    if (state.info.execution !== 'browser') throw conflict('this job is server-executed', 'server-executed')
    const allowed: JobStatus[] = ['completed', 'cancelled', 'failed', 'halted', 'paused', 'running', 'key-expired']
    if (!allowed.includes(body.status)) throw badRequest(`invalid status '${String(body.status)}'`, 'bad-status')
    this.setStatus(state, body.status)
    state.info.error = typeof body.error === 'string' ? body.error.slice(0, 2000) : null
    if (TERMINAL.has(body.status)) state.info.finished_at = new Date().toISOString()
    if (body.status === 'running' && !state.info.started_at) state.info.started_at = new Date().toISOString()
    this.persist(state)
    return this.snapshot(state)
  }

  // ─── server-side execution ────────────────────────────────────────────────

  private keyMissing(state: JobState): boolean {
    const serverKey = state.preset_name ? this.config.connections.find((c) => c.name === state.preset_name)?.apiKey : null
    if (serverKey) return false
    if (!state.connection.requires_key) return false
    return !this.vault.has(state.owner)
  }

  private launch(state: JobState, only: number[] | undefined): void {
    assertServerMayCall(this.config, state.connection)
    const conn = state.connection
    const serverKey = state.preset_name ? (this.config.connections.find((c) => c.name === state.preset_name)?.apiKey ?? null) : null
    const run: Run = { abort: new AbortController(), pausedByUser: false, internalStop: false, waiters: [], done: Promise.resolve() }
    state.run = run
    this.setStatus(state, 'running')
    if (!state.info.started_at) state.info.started_at = new Date().toISOString()
    state.info.error = null
    this.persist(state)

    const withProvider = async (): Promise<void> => {
      if (serverKey) return this.drive(state, createProvider(conn, serverKey), only)
      if (this.vault.has(state.owner)) return this.vault.withKey(state.owner, (key) => this.drive(state, createProvider(conn, key), only))
      if (conn.requires_key) throw unauthorized('no API key is held for this session; unlock it first', 'key-required')
      return this.drive(state, createProvider(conn, null), only)
    }
    run.done = withProvider().catch((e: unknown) => {
      const msg = errorMessage(e)
      if (e instanceof VaultMissError || (e instanceof HttpError && e.code === 'key-required')) {
        this.setStatus(state, 'key-expired')
      } else {
        this.setStatus(state, 'failed')
        state.info.finished_at = new Date().toISOString()
      }
      state.info.error = msg
      log('ERROR', `job ${state.info.id}: ${msg}`)
    }).finally(() => {
      state.run = null
      this.persist(state)
      this.flushTokens(state)
      this.emit(state, { type: 'job', job: this.snapshot(state) })
    })
  }

  private async drive(state: JobState, provider: Provider, only: number[] | undefined): Promise<void> {
    const run = state.run
    if (!run) return
    const text = this.docs.textUnchecked(state.info.doc_id)
    const pauseReason = (): string | null => (run.pausedByUser ? 'paused by user' : this.keyMissing(state) ? 'key expired' : null)
    const control: RunControl = {
      signal: run.abort.signal,
      plan: state.info.plan,
      completed: [...this.recordsOf(state)],
      only,
      pauseReason,
      waitUntilResumed: () =>
        new Promise<void>((resolve) => {
          if (!pauseReason() || run.abort.signal.aborted) resolve()
          else run.waiters.push(resolve)
        }),
    }
    for await (const ev of runJob(text, state.info.spec, provider, control)) this.handleEvent(state, run, ev)
  }

  private handleEvent(state: JobState, run: Run, ev: WindowEvent): void {
    switch (ev.type) {
      case 'planned':
        return
      case 'window-token':
        this.bufferToken(state, ev.index, ev.chunk)
        return
      case 'window-done':
        this.appendRecord(state, ev.record)
        this.emit(state, { type: 'event', event: ev })
        return
      case 'paused':
        this.setStatus(state, ev.reason === 'key expired' ? 'key-expired' : 'paused')
        this.persist(state)
        this.emit(state, { type: 'event', event: ev })
        this.emit(state, { type: 'job', job: this.snapshot(state) })
        return
      case 'resumed':
        this.setStatus(state, 'running')
        this.persist(state)
        this.emit(state, { type: 'event', event: ev })
        this.emit(state, { type: 'job', job: this.snapshot(state) })
        return
      case 'halted':
        this.setStatus(state, 'halted')
        state.info.error = ev.error
        state.info.finished_at = new Date().toISOString()
        this.persist(state)
        this.emit(state, { type: 'event', event: ev })
        return
      case 'complete':
        this.setStatus(state, 'completed')
        state.info.finished_at = new Date().toISOString()
        this.persist(state)
        this.emit(state, { type: 'event', event: { type: 'complete', output: '', stats: ev.stats } }) // output is fetched via /output; don't double-ship it
        log('SUCCESS', `job ${state.info.id} completed: ${ev.stats.done}/${ev.stats.total} windows, ${ev.stats.flagged} flagged, ${ev.stats.failed} failed, ${Math.round(ev.stats.elapsed_ms / 1000)}s`)
        return
      case 'cancelled':
        if (run.internalStop) {
          this.setStatus(state, state.info.status === 'key-expired' ? 'key-expired' : 'paused')
        } else {
          this.setStatus(state, 'cancelled')
          state.info.finished_at = new Date().toISOString()
        }
        this.persist(state)
        this.emit(state, { type: 'event', event: ev })
        return
      default:
        this.emit(state, { type: 'event', event: ev })
    }
  }

  private setStatus(state: JobState, status: JobStatus): void {
    if (state.info.status === status) return
    state.info.status = status
    this.emit(state, { type: 'job', job: this.snapshot(state) })
  }

  private wake(state: JobState): void {
    const run = state.run
    if (!run) return
    const w = run.waiters.splice(0)
    for (const r of w) r()
  }

  private onKeyExpired(sessionId: string): void {
    for (const state of this.jobs.values()) {
      if (state.owner !== sessionId || !state.run) continue
      // The gate will park it before the next window; announce it now so the UI reacts immediately.
      this.setStatus(state, 'key-expired')
      this.persist(state)
    }
  }

  /** Called when a session (re)provides its key: restart parked jobs with a fresh provider. */
  async onKeyRestored(sessionId: string): Promise<void> {
    for (const state of this.jobs.values()) {
      if (state.owner !== sessionId || state.info.status !== 'key-expired') continue
      if (state.run) {
        state.run.internalStop = true
        state.run.abort.abort()
        this.wake(state)
        await state.run.done
      }
      if (state.info.execution === 'server') {
        try {
          this.launch(state, undefined)
        } catch (e) {
          log('WARNING', `job ${state.info.id} could not auto-resume: ${errorMessage(e)}`)
        }
      }
    }
  }

  /** Test helper: settle the current run, if any. */
  async waitForIdle(id: string): Promise<void> {
    const state = this.jobs.get(id)
    if (state?.run) await state.run.done
  }

  async stopAll(): Promise<void> {
    for (const state of this.jobs.values()) {
      if (!state.run) continue
      state.run.internalStop = true
      state.run.abort.abort()
      this.wake(state)
      await state.run.done
    }
  }

  // ─── fan-out ──────────────────────────────────────────────────────────────

  subscribe(owner: string, id: string, send: (msg: JobSocketMessage) => void): () => void {
    const state = this.owned(owner, id)
    send({ type: 'snapshot', job: this.snapshot(state), windows: this.windows(owner, id) })
    state.subscribers.add(send)
    return () => state.subscribers.delete(send)
  }

  private emit(state: JobState, msg: JobSocketMessage): void {
    this.flushTokens(state)
    for (const send of state.subscribers) {
      try {
        send(msg)
      } catch (e) {
        log('WARNING', `job ${state.info.id}: subscriber send failed (${errorMessage(e)}); dropping it`)
        state.subscribers.delete(send)
      }
    }
  }

  private bufferToken(state: JobState, index: number, chunk: string): void {
    if (state.subscribers.size === 0) return
    state.tokenBuf.set(index, (state.tokenBuf.get(index) ?? '') + chunk)
    if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => this.flushTokens(state), TOKEN_FLUSH_MS)
      ;(state.flushTimer as { unref?: () => void }).unref?.()
    }
  }

  private flushTokens(state: JobState): void {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer)
      state.flushTimer = null
    }
    if (state.tokenBuf.size === 0) return
    const buffered = [...state.tokenBuf.entries()]
    state.tokenBuf.clear()
    for (const [index, chunk] of buffered) {
      for (const send of state.subscribers) {
        try {
          send({ type: 'event', event: { type: 'window-token', index, chunk } })
        } catch {
          state.subscribers.delete(send)
        }
      }
    }
  }
}

/** Accept only the WindowRecord shape from an untrusted browser-run client. */
export function sanitizeRecord(input: unknown, windowCount: number): WindowRecord {
  if (!input || typeof input !== 'object') throw badRequest('record must be an object', 'bad-record')
  const r = input as Record<string, unknown>
  const index = Number(r.index)
  if (!Number.isInteger(index) || index < 0 || index >= windowCount) throw badRequest(`record.index ${String(r.index)} out of range`, 'bad-index')
  const status = r.status === 'ok' || r.status === 'flagged' || r.status === 'failed' ? r.status : null
  if (!status) throw badRequest(`record.status must be ok|flagged|failed`, 'bad-record')
  if (typeof r.output !== 'string') throw badRequest('record.output must be a string', 'bad-record')
  const v = (r.validation && typeof r.validation === 'object' ? r.validation : {}) as Record<string, unknown>
  const usage = r.usage && typeof r.usage === 'object' ? (r.usage as Record<string, unknown>) : undefined
  const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '')
  return {
    index,
    status,
    output: r.output,
    attempt: Number.isInteger(r.attempt) ? (r.attempt as number) : 1,
    model: str(r.model, 200),
    connection: str(r.connection, 80),
    prompt_hash: str(r.prompt_hash, 64),
    started_at: str(r.started_at, 40) || new Date().toISOString(),
    elapsed_ms: Number.isFinite(Number(r.elapsed_ms)) ? Number(r.elapsed_ms) : 0,
    ...(usage ? { usage: { prompt_tokens: numOrUndef(usage.prompt_tokens), completion_tokens: numOrUndef(usage.completion_tokens) } } : {}),
    validation: {
      ok: Boolean(v.ok),
      kind: v.kind === 'conserve' || v.kind === 'length-ratio' ? v.kind : 'none',
      ...(typeof v.score === 'number' ? { score: v.score } : {}),
      ...(typeof v.reason === 'string' ? { reason: v.reason.slice(0, 500) } : {}),
    },
    ...(typeof r.error === 'string' ? { error: r.error.slice(0, 2000) } : {}),
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
