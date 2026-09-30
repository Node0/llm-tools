/**
 * server/routes/jobs.ts — job lifecycle + the event socket.
 *
 *   POST /api/jobs                          create
 *   GET  /api/jobs, /api/jobs/:id
 *   POST /api/jobs/:id/start|pause|resume|cancel
 *   POST /api/jobs/:id/windows/:i/rerun
 *   POST /api/jobs/:id/windows/:i/result    browser-run checkpoint
 *   POST /api/jobs/:id/finish               browser-run terminal status
 *   GET  /api/jobs/:id/windows              WindowRecord[]
 *   GET  /api/jobs/:id/output               text/markdown (?download=1 → attachment)
 *   WS   /api/jobs/:id/events               snapshot, then live JobSocketMessages
 */

import { Elysia } from 'elysia'
import type { JobFinishRequest } from '../../shared/api.ts'
import type { ServerContext } from '../context.ts'
import { badRequest } from '../errors.ts'
import { errorMessage } from '../log.ts'
import { asObject, optInt, optString } from './util.ts'

export function jobRoutes(ctx: ServerContext) {
  const subscriptions = new Map<string, () => void>()
  return new Elysia({ name: 'job-routes' })
    .derive(({ cookie, request }) => ({ session: ctx.sessions.resolve(cookie, request) }))
    .post('/api/jobs', ({ session, body }) => {
      const b = asObject(body)
      const docId = optString(b.doc_id, 64)
      if (!docId) throw badRequest('doc_id is required', 'no-doc')
      return ctx.jobs.create(session, docId, b.spec)
    })
    .get('/api/jobs', ({ session }) => ctx.jobs.list(session.id))
    .get('/api/jobs/:id', ({ session, params }) => ctx.jobs.get(session.id, params.id))
    .post('/api/jobs/:id/start', ({ session, params }) => ctx.jobs.start(session.id, params.id))
    .post('/api/jobs/:id/pause', ({ session, params }) => ctx.jobs.pause(session.id, params.id))
    .post('/api/jobs/:id/resume', ({ session, params }) => ctx.jobs.resume(session.id, params.id))
    .post('/api/jobs/:id/cancel', ({ session, params }) => ctx.jobs.cancel(session.id, params.id))
    .post('/api/jobs/:id/windows/:i/rerun', ({ session, params }) => {
      const i = optInt(params.i)
      if (i === undefined) throw badRequest('window index must be an integer', 'bad-index')
      return ctx.jobs.rerun(session.id, params.id, i)
    })
    .post('/api/jobs/:id/windows/:i/result', ({ session, params, body }) => {
      const i = optInt(params.i)
      if (i === undefined) throw badRequest('window index must be an integer', 'bad-index')
      const record = { ...asObject(body), index: i }
      ctx.jobs.recordWindow(session.id, params.id, record)
      return { ok: true }
    })
    .post('/api/jobs/:id/finish', ({ session, params, body }) => {
      const b = asObject(body)
      return ctx.jobs.finish(session.id, params.id, { status: b.status as JobFinishRequest['status'], error: optString(b.error, 2000) })
    })
    .get('/api/jobs/:id/windows', ({ session, params }) => ctx.jobs.windows(session.id, params.id))
    .get('/api/jobs/:id/output', ({ session, params, query }) => {
      const { filename, text } = ctx.jobs.output(session.id, params.id)
      const headers: Record<string, string> = { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' }
      if (query.download === '1' || query.download === 'true') headers['content-disposition'] = `attachment; filename="${filename}"`
      return new Response(text, { headers })
    })
    .ws('/api/jobs/:id/events', {
      open(ws) {
        const session = ctx.sessions.fromCookieHeader(ws.data.request.headers.get('cookie'))
        const id = ws.data.params.id
        if (!session) {
          ws.send({ type: 'error', error: 'no session; call POST /api/session first' })
          ws.close()
          return
        }
        try {
          const unsubscribe = ctx.jobs.subscribe(session.id, id, (msg) => ws.send(msg))
          subscriptions.set(ws.id, unsubscribe)
        } catch (e) {
          ws.send({ type: 'error', error: errorMessage(e) })
          ws.close()
        }
      },
      message() {
        /* the socket is server → client only; client frames are ignored */
      },
      close(ws) {
        subscriptions.get(ws.id)?.()
        subscriptions.delete(ws.id)
      },
    })
}
