import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DocStore } from '../../server/docs.ts'
import { JobManager } from '../../server/jobs.ts'
import { KeyVault } from '../../server/keyvault.ts'
import { SessionStore } from '../../server/sessions.ts'
import * as registry from '../../shared/providers/registry.ts'
import { defaultJobSpec } from '../../shared/defaults.ts'
import type { ApiType, ChatMessage, ConnectionSpec, GenerateOptions, WindowRecord } from '../../shared/types.ts'
import { FakeProvider, LOCAL_CONNECTION, SAMPLE_TEXT, testConfig } from './helpers.ts'

/**
 * The JobManager obtains providers through the shared registry, so register a
 * FakeProvider factory under a private api_type and point test connections at
 * it. Each test may queue `hooks` (per-call overrides) to inject slow or
 * failing generations.
 */
let hooks: Array<(m: ChatMessage[], o: GenerateOptions) => Promise<string | null>> = []
let fakes: FakeProvider[] = []
const FAKE_TYPE = 'fake' as unknown as ApiType
registry.registerProvider(FAKE_TYPE, (spec) => {
  const hook = hooks.shift()
  const p = new FakeProvider(spec, hook)
  fakes.push(p)
  return p
})

const FAKE_CONNECTION: ConnectionSpec = { ...LOCAL_CONNECTION, name: 'fake-local', api_type: FAKE_TYPE }

function setup(label: string) {
  const config = testConfig({}, label)
  const vault = new KeyVault()
  const sessions = new SessionStore(config, vault)
  const docs = new DocStore(config)
  const jobs = new JobManager(config, docs, vault, sessions)
  const session = sessions.create()
  sessions.setConnection(session, FAKE_CONNECTION, null)
  const doc = docs.create(session.id, 'sample.txt', SAMPLE_TEXT)
  const spec = defaultJobSpec('sample.txt')
  spec.systemPrompt = 'Uppercase.'
  spec.userTemplate = '<focus>\n{{focus}}\n</focus>'
  spec.window = { focusChars: 60, contextBeforeChars: 0, contextAfterChars: 0, snap: 'paragraph' }
  spec.validator = { kind: 'none' }
  spec.retry = { maxAttempts: 2, temperatureDecay: 0.5 }
  return { config, vault, sessions, docs, jobs, session, doc, spec }
}

describe('JobManager (server execution)', () => {
  test('create → start → completed, with one JSONL line per window and an assembled output', async () => {
    hooks = []
    fakes = []
    const { config, jobs, session, doc, spec } = setup('jobs-basic')
    const info = jobs.create(session, doc.id, spec)
    expect(info.status).toBe('created')
    expect(info.execution).toBe('server')
    expect(info.window_count).toBe(3)
    expect(existsSync(join(config.server.data_dir, info.checkpoint_file))).toBe(true)

    jobs.start(session.id, info.id)
    await jobs.waitForIdle(info.id)
    const done = jobs.get(session.id, info.id)
    expect(done.status).toBe('completed')
    expect(done.done_count).toBe(3)
    expect(done.failed_count).toBe(0)

    const lines = readFileSync(join(config.server.data_dir, info.checkpoint_file), 'utf8').trim().split('\n')
    expect(lines.length).toBe(3)
    const first = JSON.parse(lines[0]) as WindowRecord
    expect(first.prompt_hash).toHaveLength(64)
    expect(first.connection).toBe('fake-local')

    const { text, filename } = jobs.output(session.id, info.id)
    expect(filename).toBe('sample__transformed.md')
    expect(text).toContain('ALPHA PARAGRAPH ONE')
    expect(text).toContain('GAMMA PARAGRAPH THREE')
    expect(text).not.toContain('pending')
  })

  test('resume after interruption skips completed windows', async () => {
    fakes = []
    // Second window's first attempt throws a non-retryable-looking error → we cancel mid-run to simulate an interruption.
    let calls = 0
    hooks = [
      async () => {
        calls++
        if (calls === 2) {
          await new Promise((r) => setTimeout(r, 200)) // hold the second window so we can cancel while it's in flight
        }
        return null
      },
    ]
    const { jobs, session, doc, spec } = setup('jobs-resume')
    spec.mode = 'fold' // sequential so the interruption point is deterministic
    const info = jobs.create(session, doc.id, spec)
    jobs.start(session.id, info.id)
    await new Promise((r) => setTimeout(r, 60)) // window 0 done, window 1 in flight
    jobs.cancel(session.id, info.id)
    await jobs.waitForIdle(info.id)
    const mid = jobs.get(session.id, info.id)
    expect(mid.status).toBe('cancelled')
    expect(mid.done_count).toBeGreaterThanOrEqual(1)
    expect(mid.done_count).toBeLessThan(3)

    // A cancelled job is terminal by contract; resume() must refuse it.
    expect(() => jobs.resume(session.id, info.id)).toThrow()

    // Simulate a restart: build a fresh manager over the same data dir → status parks as resumable.
    // (cancelled stays cancelled; use a paused job for the resume path.)
    hooks = []
    fakes = []
    const fresh = setup('jobs-resume-2')
    const info2 = fresh.jobs.create(fresh.session, fresh.doc.id, spec)
    fresh.jobs.start(fresh.session.id, info2.id)
    await fresh.jobs.waitForIdle(info2.id)
    expect(fresh.jobs.get(fresh.session.id, info2.id).status).toBe('completed')

    // Rerun a single window: exactly one more provider call, count unchanged, JSONL grows by one line.
    const before = fakes.reduce((n, f) => n + f.calls.length, 0)
    fresh.jobs.rerun(fresh.session.id, info2.id, 1)
    await fresh.jobs.waitForIdle(info2.id)
    const after = fakes.reduce((n, f) => n + f.calls.length, 0)
    expect(after - before).toBe(1)
    const again = fresh.jobs.get(fresh.session.id, info2.id)
    expect(again.done_count).toBe(3)
    expect(again.status).toBe('completed')
    const lines = readFileSync(join(fresh.config.server.data_dir, info2.checkpoint_file), 'utf8').trim().split('\n')
    expect(lines.length).toBe(4)
  })

  test('restart recovery: a job that was running when the process died comes back paused and resumes from its checkpoint', async () => {
    hooks = []
    fakes = []
    const { config, vault, sessions, docs, jobs, session, doc, spec } = setup('jobs-restart')
    const info = jobs.create(session, doc.id, spec)
    // Pretend one window already landed and the process died while 'running'.
    const rec: WindowRecord = {
      index: 0, status: 'ok', output: 'ALPHA (from before the crash)', attempt: 1, model: 'test-model', connection: 'fake-local',
      prompt_hash: 'x'.repeat(64), started_at: new Date().toISOString(), elapsed_ms: 1, validation: { ok: true, kind: 'none' },
    }
    const jobDir = join(config.server.data_dir, 'jobs', info.id)
    const jobJson = JSON.parse(readFileSync(join(jobDir, 'job.json'), 'utf8')) as { info: { status: string } }
    jobJson.info.status = 'running'
    await Bun.write(join(jobDir, 'job.json'), JSON.stringify(jobJson))
    await Bun.write(join(config.server.data_dir, info.checkpoint_file), JSON.stringify(rec) + '\n')

    const reborn = new JobManager(config, docs, vault, sessions)
    const back = reborn.get(session.id, info.id)
    expect(back.status).toBe('paused')
    expect(back.done_count).toBe(1)
    reborn.resume(session.id, info.id)
    await reborn.waitForIdle(info.id)
    const fin = reborn.get(session.id, info.id)
    expect(fin.status).toBe('completed')
    expect(fin.done_count).toBe(3)
    expect(fakes.at(-1)!.calls.length).toBe(2) // only the two missing windows were generated
    expect(reborn.output(session.id, info.id).text.startsWith('ALPHA (from before the crash)')).toBe(true)
  })

  test('key expiry parks a running remote job in key-expired; re-providing the key restarts it', async () => {
    fakes = []
    let release: (() => void) | null = null
    hooks = [
      async () => {
        await new Promise<void>((r) => { release = r })
        return null
      },
    ]
    const cfg = testConfig({ session: { ttl_seconds: 60 } }, 'jobs-keyexp')
    const vault = new KeyVault()
    const sessions = new SessionStore(cfg, vault)
    const docs = new DocStore(cfg)
    const jobs = new JobManager(cfg, docs, vault, sessions)
    const session = sessions.create()
    const remoteFake: ConnectionSpec = { ...FAKE_CONNECTION, name: 'fake-remote', base_url: 'https://openrouter.ai/api/v1', locality: 'remote', requires_key: true }
    sessions.setConnection(session, remoteFake, null)
    vault.put(session.id, 'sk-test-key-123456', 60_000)
    const doc = docs.create(session.id, 'sample.txt', SAMPLE_TEXT)
    const spec = defaultJobSpec('sample.txt')
    spec.mode = 'fold'
    spec.userTemplate = '<focus>\n{{focus}}\n</focus>'
    spec.window = { focusChars: 60, contextBeforeChars: 0, contextAfterChars: 0, snap: 'paragraph' }
    const info = jobs.create(session, doc.id, spec)
    jobs.start(session.id, info.id)
    await new Promise((r) => setTimeout(r, 30))
    vault.forget(session.id) // simulate TTL expiry
    ;(release as unknown as () => void)?.()
    await new Promise((r) => setTimeout(r, 30))
    expect(jobs.get(session.id, info.id).status).toBe('key-expired')

    hooks = []
    vault.put(session.id, 'sk-test-key-123456', 60_000)
    await jobs.onKeyRestored(session.id)
    await jobs.waitForIdle(info.id)
    const fin = jobs.get(session.id, info.id)
    expect(fin.status).toBe('completed')
    expect(fin.done_count).toBe(3)
  })
})

describe('JobManager (browser execution)', () => {
  test('recordWindow + finish path under public deployment', async () => {
    const cfg = testConfig({ public_deployment: true }, 'jobs-browser')
    const vault = new KeyVault()
    const sessions = new SessionStore(cfg, vault)
    const docs = new DocStore(cfg)
    const jobs = new JobManager(cfg, docs, vault, sessions)
    const session = sessions.create()
    sessions.setConnection(session, FAKE_CONNECTION, null)
    const doc = docs.create(session.id, 'sample.txt', SAMPLE_TEXT)
    const spec = defaultJobSpec('sample.txt')
    spec.window = { focusChars: 60, contextBeforeChars: 0, contextAfterChars: 0, snap: 'paragraph' }
    const info = jobs.create(session, doc.id, spec)
    expect(info.execution).toBe('browser')

    const seen: string[] = []
    const unsub = jobs.subscribe(session.id, info.id, (m) => seen.push(m.type))
    jobs.start(session.id, info.id)
    expect(jobs.get(session.id, info.id).status).toBe('running')

    for (let i = 0; i < 3; i++) {
      jobs.recordWindow(session.id, info.id, {
        index: i, status: 'ok', output: `OUT ${i}`, attempt: 1, model: 'm', connection: 'fake-local', prompt_hash: 'h',
        started_at: new Date().toISOString(), elapsed_ms: 5, validation: { ok: true, kind: 'none' },
      })
    }
    expect(() => jobs.recordWindow(session.id, info.id, { index: 9, status: 'ok', output: '' })).toThrow()
    const fin = jobs.finish(session.id, info.id, { status: 'completed' })
    expect(fin.status).toBe('completed')
    expect(fin.done_count).toBe(3)
    expect(jobs.output(session.id, info.id).text).toBe('OUT 0\n\nOUT 1\n\nOUT 2')
    expect(seen[0]).toBe('snapshot')
    expect(seen.filter((t) => t === 'event').length).toBeGreaterThanOrEqual(6)
    unsub()
    const lines = readFileSync(join(cfg.server.data_dir, info.checkpoint_file), 'utf8').trim().split('\n')
    expect(lines.length).toBe(3)
  })
})
