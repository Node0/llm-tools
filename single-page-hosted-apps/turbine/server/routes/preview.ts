/**
 * server/routes/preview.ts — run the prompt against one selection.
 *
 *   POST /api/preview/messages   render the exact messages a window would get (no model call)
 *   POST /api/preview            stream NDJSON: messages → token* → done | error
 *
 * Preview uses planFromSelection + buildMessages — the same functions the
 * runner uses — so what you see is what a real window gets.
 */

import { Elysia } from 'elysia'
import type { PreviewEvent, PreviewMessages, PreviewRequest } from '../../shared/api.ts'
import { validateJobSpec } from '../../shared/defaults.ts'
import { buildMessages, cleanOutput, estimatePlan, planFromSelection, validateWindow } from '../../shared/engine/index.ts'
import type { JobSpec } from '../../shared/types.ts'
import type { ServerContext } from '../context.ts'
import { badRequest, conflict } from '../errors.ts'
import { sessionTarget, withProvider } from '../inference.ts'
import { errorMessage } from '../log.ts'
import type { Session } from '../sessions.ts'
import { asObject, optInt, optString } from './util.ts'

interface Prepared {
  spec: JobSpec
  text: string
  window: ReturnType<typeof planFromSelection>
  messages: ReturnType<typeof buildMessages>
  focusText: string
}

function prepare(ctx: ServerContext, session: Session, body: unknown): Prepared {
  const b = asObject(body) as Partial<PreviewRequest>
  const docId = optString(b.doc_id, 64)
  if (!docId) throw badRequest('doc_id is required', 'no-doc')
  const doc = ctx.docs.get(session.id, docId)
  const text = ctx.docs.textUnchecked(docId)
  let spec: JobSpec
  try {
    spec = validateJobSpec(b.spec, { max_concurrency: ctx.config.limits.max_concurrency })
  } catch (e) {
    throw badRequest(errorMessage(e), 'invalid-spec')
  }
  if (!spec.sourceName || spec.sourceName === 'document') spec.sourceName = doc.name
  const focus = asObject(b.focus)
  const start = optInt(focus.start)
  const end = optInt(focus.end)
  if (start === undefined || end === undefined || end <= start) throw badRequest('focus must be { start, end } with end > start', 'bad-focus')
  const window = planFromSelection(text, spec.window, { start, end })
  const messages = buildMessages(text, spec, window, { carry: optString(b.carry, 100_000) ?? '', count: 1 })
  return { spec, text, window, messages, focusText: text.slice(window.focusStart, window.focusEnd).trim() }
}

export function previewRoutes(ctx: ServerContext) {
  return new Elysia({ name: 'preview-routes' })
    .derive(({ cookie, request }) => ({ session: ctx.sessions.resolve(cookie, request) }))
    .post('/api/preview/messages', ({ session, body }): PreviewMessages => {
      const target = sessionTarget(ctx, session)
      const p = prepare(ctx, session, body)
      return { messages: p.messages, window: p.window, estimate: estimatePlan([p.window], p.spec, target.connection.ctx_len) }
    })
    .post('/api/preview', async ({ session, body, request }) => {
      const target = sessionTarget(ctx, session)
      if (target.execution === 'browser') {
        throw conflict('this connection is browser-executed; fetch /api/preview/messages and call the backend from the browser', 'browser-executed')
      }
      const p = prepare(ctx, session, body)
      return withProvider(ctx, session, target, undefined, async (provider) => {
        const enc = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (ev: PreviewEvent): void => controller.enqueue(enc.encode(JSON.stringify(ev) + '\n'))
            send({ type: 'messages', messages: p.messages, window: p.window })
            try {
              const result = await provider.generate(p.messages, {
                temperature: p.spec.generation.temperature,
                max_tokens: p.spec.generation.max_tokens,
                num_ctx: p.spec.generation.num_ctx,
                reasoning: p.spec.generation.reasoning ?? 'off',
                params: p.spec.generation.params,
                signal: request.signal,
                onToken: (chunk) => send({ type: 'token', chunk }),
              })
              const output = cleanOutput(result.text)
              send({ type: 'done', output, elapsed_ms: result.elapsed_ms, model: result.model, validation: validateWindow(p.spec.validator, p.focusText, output), usage: result.usage })
            } catch (e) {
              send({ type: 'error', error: errorMessage(e) })
            } finally {
              controller.close()
            }
          },
        })
        return new Response(stream, {
          headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
        })
      })
    })
}
