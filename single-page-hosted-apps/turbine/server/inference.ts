/**
 * server/inference.ts — turn a ConnectRequest into a Provider, safely.
 *
 * Key precedence for one-off calls (test / models / preview):
 *   key in the request body  →  server-owned key (config.json, private only)  →  vault  →  none
 * A connection that requires a key and has none is a 401, not a provider
 * error — the client turns that into "unlock your key".
 */

import type { ConnectRequest, Execution } from '../shared/api.ts'
import { ConnectionValidationError, createProvider, normalizeConnection } from '../shared/providers/index.ts'
import type { ConnectionSpec, Provider } from '../shared/types.ts'
import type { ServerContext } from './context.ts'
import { badRequest, notFound, unauthorized } from './errors.ts'
import { VaultMissError } from './keyvault.ts'
import { assertServerMayCall, decideExecution } from './policy.ts'
import type { Session } from './sessions.ts'

export interface ResolvedTarget {
  connection: ConnectionSpec
  presetName: string | null
  serverKey: string | null
  execution: Execution
}

export function resolveTarget(ctx: ServerContext, body: Partial<ConnectRequest>): ResolvedTarget {
  if (typeof body.preset === 'string' && body.preset) {
    const sc = ctx.config.connections.find((c) => c.name === body.preset)
    if (!sc) throw notFound(`no server connection named '${body.preset}'`, 'unknown-preset')
    return { connection: sc.connection, presetName: sc.name, serverKey: sc.apiKey, execution: decideExecution(ctx.config, sc.connection) }
  }
  if (body.connection) {
    let connection: ConnectionSpec
    try {
      connection = normalizeConnection(body.connection)
    } catch (e) {
      if (e instanceof ConnectionValidationError) throw badRequest(e.message, 'invalid-connection')
      throw e
    }
    return { connection, presetName: null, serverKey: null, execution: decideExecution(ctx.config, connection) }
  }
  throw badRequest('provide either `connection` or `preset`', 'no-target')
}

/** Resolve a target for a session that is already connected (preview, jobs). */
export function sessionTarget(ctx: ServerContext, session: Session): ResolvedTarget {
  if (!session.connection) throw unauthorized('connect to an inference provider first', 'not-connected')
  const sc = ctx.sessions.serverConnection(session)
  return {
    connection: session.connection,
    presetName: session.preset_name,
    serverKey: sc?.apiKey ?? null,
    execution: decideExecution(ctx.config, session.connection),
  }
}

/**
 * Build a Provider for a server-side call and hand it to `fn`. Enforces the
 * SSRF policy and never lets a plaintext key outlive the callback.
 */
export async function withProvider<T>(
  ctx: ServerContext,
  session: Session,
  target: ResolvedTarget,
  bodyKey: string | undefined,
  fn: (provider: Provider) => Promise<T>,
): Promise<T> {
  assertServerMayCall(ctx.config, target.connection)
  const conn = target.connection
  const key = typeof bodyKey === 'string' && bodyKey.trim() ? bodyKey.trim() : null
  if (key) return fn(createProvider(conn, key))
  if (target.serverKey) return fn(createProvider(conn, target.serverKey))
  if (ctx.vault.has(session.id)) {
    try {
      return await ctx.vault.withKey(session.id, (k) => fn(createProvider(conn, k)))
    } catch (e) {
      if (e instanceof VaultMissError) throw unauthorized('your API key expired; unlock it again', 'key-expired')
      throw e
    }
  }
  if (conn.requires_key) throw unauthorized(`connection '${conn.name}' requires an API key`, 'key-required')
  return fn(createProvider(conn, null))
}
