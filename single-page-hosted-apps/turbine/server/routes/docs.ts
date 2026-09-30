/**
 * server/routes/docs.ts — source documents.
 *
 *   POST   /api/docs                multipart {file[, name]} | JSON {name, text} | text/plain?name=
 *   GET    /api/docs                DocInfo[]
 *   GET    /api/docs/:id            DocInfo
 *   GET    /api/docs/:id/text       text/plain
 *   GET    /api/docs/:id/slice      ?start&end → DocSlice
 *   DELETE /api/docs/:id
 */

import { Elysia } from 'elysia'
import type { ServerContext } from '../context.ts'
import { HttpError, badRequest } from '../errors.ts'
import { asObject, optInt, optString } from './util.ts'

export function docRoutes(ctx: ServerContext) {
  return new Elysia({ name: 'doc-routes' })
    .derive(({ cookie, request }) => ({ session: ctx.sessions.resolve(cookie, request) }))
    .post('/api/docs', async ({ session, body, request, query }) => {
      const declared = Number(request.headers.get('content-length') ?? 0)
      if (declared > ctx.config.limits.max_upload_bytes * 1.05 + 4096) {
        throw new HttpError(413, `upload is ${declared} bytes; limit is ${ctx.config.limits.max_upload_bytes}`, 'too-large')
      }
      let name: string | undefined
      let text: string | undefined
      if (typeof body === 'string') {
        text = body
        name = optString(query.name, 200)
      } else {
        const b = asObject(body)
        const file = b.file
        if (file instanceof Blob) {
          if (file.size > ctx.config.limits.max_upload_bytes) throw new HttpError(413, `file is ${file.size} bytes; limit is ${ctx.config.limits.max_upload_bytes}`, 'too-large')
          text = await file.text()
          name = optString(b.name, 200) ?? (file as File).name ?? 'document.txt'
        } else {
          text = optString(b.text, ctx.config.limits.max_upload_bytes * 2)
          name = optString(b.name, 200)
        }
      }
      if (typeof text !== 'string') throw badRequest('send a multipart `file`, JSON {name, text}, or a text/plain body', 'no-document')
      return ctx.docs.create(session.id, name ?? 'document.txt', text)
    })
    .get('/api/docs', ({ session }) => ctx.docs.list(session.id))
    .get('/api/docs/:id', ({ session, params }) => ctx.docs.get(session.id, params.id))
    .get('/api/docs/:id/text', ({ session, params }) => {
      const text = ctx.docs.text(session.id, params.id)
      return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
    })
    .get('/api/docs/:id/slice', ({ session, params, query }) => {
      const start = optInt(query.start) ?? 0
      const end = optInt(query.end) ?? Number.MAX_SAFE_INTEGER
      return ctx.docs.slice(session.id, params.id, start, end)
    })
    .delete('/api/docs/:id', ({ session, params }) => {
      ctx.docs.delete(session.id, params.id)
      return { ok: true }
    })
}
