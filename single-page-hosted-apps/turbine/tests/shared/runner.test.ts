import { describe, expect, it } from 'bun:test'
import { ProviderError } from '../../shared/types.ts'
import type { ChatMessage, ConnectionSpec, GenerateOptions, GenerateResult, JobSpec, ModelInfo, Provider, WindowEvent, WindowRecord } from '../../shared/types.ts'
import { assembleOutput, outputFilename } from '../../shared/engine/assemble.ts'
import { planWindows } from '../../shared/engine/planner.ts'
import { buildMessages, carryFrom, cleanOutput, runJob } from '../../shared/engine/runner.ts'
import { defaultJobSpec } from '../../shared/defaults.ts'

const spec0: ConnectionSpec = { name: 'fake', api_type: 'openai', base_url: 'http://fake', model: 'fake-1', ctx_len: 8192, locality: 'local', requires_key: false }

interface FakeOpts {
  transform?: (focus: string, messages: ChatMessage[]) => string
  delayMs?: number
  failIndexes?: Map<number, Error>
  onCall?: (messages: ChatMessage[]) => void
}

class FakeProvider implements Provider {
  readonly spec = spec0
  calls = 0
  inFlight = 0
  maxInFlight = 0
  constructor(private o: FakeOpts = {}) {}
  async generate(messages: ChatMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    this.calls++
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    this.o.onCall?.(messages)
    try {
      const user = messages.find((m) => m.role === 'user')?.content ?? ''
      const focus = user.match(/<focus>\n([\s\S]*?)\n<\/focus>/)?.[1] ?? user
      const idx = Number(user.match(/window (\d+) of/)?.[1] ?? 1) - 1
      await new Promise((r) => setTimeout(r, this.o.delayMs ?? 5))
      if (opts.signal?.aborted) throw new ProviderError('aborted', { retryable: false })
      const err = this.o.failIndexes?.get(idx)
      if (err) throw err
      const text = (this.o.transform ?? ((f) => f.toUpperCase()))(focus, messages)
      for (const piece of text.match(/.{1,7}/gs) ?? []) opts.onToken?.(piece)
      return { text, model: 'fake-1', usage: { prompt_tokens: 10, completion_tokens: 5 }, elapsed_ms: 1 }
    } finally {
      this.inFlight--
    }
  }
  async listModels(): Promise<string[]> { return ['fake-1'] }
  async health() { return { ok: true } }
  async describeModel(): Promise<ModelInfo> {
    return { model: 'fake-1', api_type: 'openai', flavor: 'generic', reasoning: { supported: false, settings: ['off'] }, parameters: [], defaults: {}, source: 'fake', notes: [] }
  }
}

const doc = Array.from({ length: 6 }, (_, i) => `Para ${i + 1} alpha beta gamma delta epsilon zeta eta theta iota kappa.`).join('\n\n')

function spec(mode: 'map' | 'fold' = 'map', over: Partial<JobSpec> = {}): JobSpec {
  const s = defaultJobSpec('book.txt')
  s.window = { focusChars: 70, contextBeforeChars: 30, contextAfterChars: 30, snap: 'paragraph' }
  s.mode = mode
  s.concurrency = 3
  s.generation = { temperature: 0.4, max_tokens: 100 }
  s.retry = { maxAttempts: 3, temperatureDecay: 0.5 }
  return { ...s, ...over }
}

async function collect(gen: AsyncGenerator<WindowEvent>): Promise<WindowEvent[]> {
  const out: WindowEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('runJob — map mode', () => {
  it('transforms every window, streams tokens, runs concurrently, and assembles in index order', async () => {
    const p = new FakeProvider({ delayMs: 20 })
    const events = await collect(runJob(doc, spec('map'), p))
    const planned = events.find((e) => e.type === 'planned')
    expect(planned?.type).toBe('planned')
    const n = planned!.type === 'planned' ? planned!.windows.length : 0
    expect(n).toBe(6)
    const done = events.filter((e) => e.type === 'window-done')
    expect(done.length).toBe(n)
    expect(events.some((e) => e.type === 'window-token')).toBe(true)
    expect(p.maxInFlight).toBeGreaterThan(1)
    expect(p.maxInFlight).toBeLessThanOrEqual(3)
    const complete = events.at(-1)
    expect(complete?.type).toBe('complete')
    if (complete?.type === 'complete') {
      expect(complete.output.split('\n\n')).toEqual(doc.split('\n\n').map((s) => s.toUpperCase()))
      expect(complete.stats).toMatchObject({ done: n, flagged: 0, failed: 0, total: n })
      expect(complete.stats.prompt_tokens).toBe(10 * n)
    }
  })

  it('retries validation failures at lower temperature and flags after the last attempt', async () => {
    const temps: number[] = []
    const p = new FakeProvider({ transform: () => 'x' }) // always too short for length-ratio
    const origGenerate = p.generate.bind(p)
    p.generate = (m, o) => { temps.push(o?.temperature ?? -1); return origGenerate(m, o) }
    const events = await collect(runJob('One two three four five six seven eight nine ten.', spec('map', { validator: { kind: 'length-ratio', minRatio: 0.5, maxRatio: 2 } }), p))
    const fails = events.filter((e) => e.type === 'window-failed')
    expect(fails.length).toBe(3)
    expect(fails.at(-1)).toMatchObject({ final: true })
    const done = events.find((e) => e.type === 'window-done')
    expect(done?.type === 'window-done' && done.record.status).toBe('flagged')
    expect(temps).toEqual([0.4, 0.2, 0.1])
    const complete = events.at(-1)
    expect(complete?.type === 'complete' && complete.stats.flagged).toBe(1)
  })

  it('marks a window failed on a non-retryable provider error and passes the original text through', async () => {
    const p = new FakeProvider({ failIndexes: new Map([[1, new ProviderError('400 bad request', { status: 400, retryable: false })]]) })
    const events = await collect(runJob(doc, spec('map'), p))
    const rec = events.find((e) => e.type === 'window-done' && e.record.index === 1)
    expect(rec?.type === 'window-done' && rec.record.status).toBe('failed')
    const complete = events.at(-1)
    expect(complete?.type).toBe('complete')
    if (complete?.type === 'complete') {
      expect(complete.output).toContain('window 2 failed')
      expect(complete.output).toContain('Para 2 alpha')
      expect(complete.stats.failed).toBe(1)
    }
    expect(p.calls).toBe(6) // no retry on a terminal error
  })

  it('halts the whole job on an auth failure', async () => {
    const p = new FakeProvider({ delayMs: 15, failIndexes: new Map([[0, new ProviderError('401 unauthorized', { status: 401 })]]) })
    const events = await collect(runJob(doc, spec('map'), p))
    const last = events.at(-1)
    expect(last?.type).toBe('halted')
    expect(last?.type === 'halted' && last.reason).toBe('auth')
    expect(p.calls).toBeLessThan(6)
  })

  it('cancels promptly via AbortSignal', async () => {
    const p = new FakeProvider({ delayMs: 30 })
    const ac = new AbortController()
    const events: WindowEvent[] = []
    for await (const e of runJob(doc, spec('map', { concurrency: 1 }), p, { signal: ac.signal })) {
      events.push(e)
      if (e.type === 'window-done') ac.abort()
    }
    expect(events.at(-1)?.type).toBe('cancelled')
    expect(events.filter((e) => e.type === 'window-done').length).toBe(1)
  })

  it('resumes: completed records are skipped and reruns replace their record', async () => {
    const p = new FakeProvider()
    const plan = planWindows(doc, spec().window)
    const completed: Array<[number, WindowRecord]> = plan.slice(0, 4).map((w) => [w.index, {
      index: w.index, status: 'ok', output: `DONE${w.index}`, attempt: 1, model: 'fake-1', connection: 'fake', prompt_hash: 'h',
      started_at: new Date().toISOString(), elapsed_ms: 1, validation: { ok: true, kind: 'none' },
    }])
    const events = await collect(runJob(doc, spec(), p, { completed, plan }))
    expect(p.calls).toBe(2)
    const complete = events.at(-1)
    expect(complete?.type === 'complete' && complete.output.startsWith('DONE0\n\nDONE1')).toBe(true)

    const p2 = new FakeProvider()
    const events2 = await collect(runJob(doc, spec(), p2, { completed, plan, only: [1] }))
    expect(p2.calls).toBe(1)
    const c2 = events2.at(-1)
    if (c2?.type === 'complete') {
      const parts = c2.output.split('\n\n')
      expect(parts[0]).toBe('DONE0')
      expect(parts[1]).toBe(doc.split('\n\n')[1].toUpperCase())
      expect(parts[3]).toBe('DONE3')
      expect(parts.length).toBe(4) // windows 4–5 were never run in this pass; complete() omits pending windows
    }
  })

  it('pauses and resumes through the gate', async () => {
    const p = new FakeProvider({ delayMs: 5 })
    let paused = true
    let release: () => void = () => {}
    const resumed = new Promise<void>((r) => { release = r })
    const gen = runJob(doc, spec('map', { concurrency: 2 }), p, {
      pauseReason: () => (paused ? 'test pause' : null),
      waitUntilResumed: () => resumed,
    })
    const first = await gen.next() // planned
    expect(first.value?.type).toBe('planned')
    const second = await gen.next()
    expect(second.value?.type).toBe('paused')
    expect(p.calls).toBe(0)
    paused = false
    release()
    const rest = await collect(gen)
    expect(rest[0]?.type).toBe('resumed')
    expect(rest.at(-1)?.type).toBe('complete')
    expect(p.calls).toBe(6)
  })
})

describe('runJob — fold mode', () => {
  it('runs sequentially and carries the previous OUTPUT tail into the next prompt', async () => {
    const seen: string[] = []
    const p = new FakeProvider({ delayMs: 5, onCall: (m) => seen.push(m.find((x) => x.role === 'user')!.content) })
    const events = await collect(runJob(doc, spec('fold', { carry: { kind: 'tail', chars: 20 } }), p))
    expect(p.maxInFlight).toBe(1)
    expect(seen[0]).not.toContain('previous_output_tail')
    expect(seen[1]).toContain('previous_output_tail')
    const firstOut = doc.split('\n\n')[0].toUpperCase()
    expect(seen[1]).toContain(firstOut.slice(-20).trimStart())
    expect(events.at(-1)?.type).toBe('complete')
  })
})

describe('helpers', () => {
  it('buildMessages trims and fills all variables; system omitted when blank', () => {
    const s = spec()
    const plan = planWindows(doc, s.window)
    const m = buildMessages(doc, s, plan[1], { carry: '', count: plan.length })
    expect(m[0].role).toBe('system')
    expect(m[1].content).toContain('window 2 of 6')
    expect(m[1].content).toContain('<context_before>')
    s.systemPrompt = '  '
    expect(buildMessages(doc, s, plan[0], { carry: '', count: 1 })[0].role).toBe('user')
  })
  it('carryFrom only applies to fold+tail', () => {
    expect(carryFrom('abcdef', spec('map', { carry: { kind: 'tail', chars: 3 } }))).toBe('')
    expect(carryFrom('abcdef', spec('fold', { carry: { kind: 'tail', chars: 3 } }))).toBe('def')
    expect(carryFrom('abcdef', spec('fold', { carry: { kind: 'none', chars: 3 } }))).toBe('')
  })
  it('cleanOutput strips a whole-output fence and echoed focus tags', () => {
    expect(cleanOutput('```markdown\n# Hi\n```')).toBe('# Hi')
    expect(cleanOutput('<focus>text</focus>')).toBe('text')
    expect(cleanOutput('a ```b``` c')).toBe('a ```b``` c')
  })
  it('assembleOutput marks pending windows and names files with __', () => {
    const plan = planWindows('aaaa bbbb\n\ncccc dddd', { focusChars: 16, contextBeforeChars: 0, contextAfterChars: 0, snap: 'paragraph' })
    const out = assembleOutput(new Map(), plan, { joiner: '\n\n' })
    expect(out).toContain('window 1 pending')
    expect(outputFilename('Middlemarch (1872).md')).toBe('Middlemarch_1872_.md'.replace('.md', '__transformed.md'))
    expect(outputFilename('darwin-origin-1st-ed.md', 'turbine', 'jsonl')).toBe('darwin-origin-1st-ed__turbine.jsonl')
  })
})
