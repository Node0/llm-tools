/**
 * server/routes/session.ts — identity, connection choice, and the key handoff.
 *
 *   POST   /api/session          create/refresh; record fingerprint
 *   GET    /api/session          SessionInfo
 *   DELETE /api/session          forget everything about this browser
 *   POST   /api/session/connect  choose a connection; hand over a key (server-executed only)
 *   DELETE /api/session/key      forget the key now
 */

import { Elysia } from 'elysia'
import type { ConnectRequest, SessionInfo } from '../../shared/api.ts'
import type { ServerContext } from '../context.ts'
import { badRequest, unauthorized } from '../errors.ts'
import { resolveTarget } from '../inference.ts'
import { log } from '../log.ts'
import { assertServerMayCall } from '../policy.ts'
import type { Session } from '../sessions.ts'
import { asObject, optString } from './util.ts'

const MAX_KEY_LENGTH = 4096

export async function connectSession(ctx: ServerContext, session: Session, body: unknown): Promise<SessionInfo> {
  const b = asObject(body) as Partial<ConnectRequest>
  ctx.sessions.recordFingerprint(session, optString(b.fingerprint, 128))
  const target = resolveTarget(ctx, b)
  const apiKey = optString(b.api_key, MAX_KEY_LENGTH + 1)?.trim() || undefined
  if (apiKey && apiKey.length > MAX_KEY_LENGTH) throw badRequest('api_key is too long', 'bad-key')
  const ttlMs = ctx.config.session.ttl_seconds * 1000
  let keyRestored = false

  if (target.execution === 'server') {
    assertServerMayCall(ctx.config, target.connection)
    if (target.serverKey) {
      // Server-owned key (private deployment): nothing to hold for this browser.
      ctx.vault.forget(session.id)
      keyRestored = true
    } else if (apiKey) {
      ctx.vault.put(session.id, apiKey, ttlMs)
      keyRestored = true
    } else if (target.connection.requires_key && !ctx.vault.has(session.id)) {
      throw unauthorized(`connection '${target.connection.name}' requires an api_key`, 'key-required')
    }
  } else {
    // Browser-executed (public deployment + local backend): the browser keeps its own key. Never hold it here.
    ctx.vault.forget(session.id)
  }

  ctx.sessions.setConnection(session, target.connection, target.presetName)
  log('STATE', `session ${session.id.slice(0, 8)}… connected to ${target.connection.name} (${target.connection.api_type} @ ${new URL(target.connection.base_url).host}, ${target.execution}-executed)`)
  if (keyRestored) void ctx.jobs.onKeyRestored(session.id)
  return ctx.sessions.toInfo(session)
}

export function sessionRoutes(ctx: ServerContext) {
  return new Elysia({ name: 'session-routes' })
    .derive(({ cookie, request }) => ({ session: ctx.sessions.resolve(cookie, request) }))
    .get('/api/session', ({ session }) => ctx.sessions.toInfo(session))
    .post('/api/session', ({ session, body }) => {
      ctx.sessions.recordFingerprint(session, optString(asObject(body).fingerprint, 128))
      return ctx.sessions.toInfo(session)
    })
    .delete('/api/session', ({ session, cookie }) => {
      ctx.sessions.destroy(session, cookie)
      return { ok: true }
    })
    .post('/api/session/connect', ({ session, body }) => connectSession(ctx, session, body))
    .delete('/api/session/key', ({ session }) => {
      ctx.vault.forget(session.id)
      return ctx.sessions.toInfo(session)
    })
}
