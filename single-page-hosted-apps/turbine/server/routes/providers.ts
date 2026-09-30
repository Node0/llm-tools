/**
 * server/routes/providers.ts — what can be connected to, and does it work.
 *
 *   GET  /api/config             ClientConfig
 *   GET  /api/providers          ProvidersInfo (presets + config connections, never keys)
 *   POST /api/providers/test     ProviderTestResult
 *   POST /api/providers/models   { models }
 *   POST /api/providers/describe DescribeResult — what the model accepts (context, reasoning, knobs);
 *                                 empty body = the session's current connection
 */

import { Elysia } from 'elysia'
import type { ConnectRequest, DescribeResult, ProviderTestResult, ProvidersInfo } from '../../shared/api.ts'
import { PRESETS, registeredApiTypes } from '../../shared/providers/index.ts'
import { clientConfig } from '../config.ts'
import type { ServerContext } from '../context.ts'
import { HttpError } from '../errors.ts'
import { resolveTarget, sessionTarget, withProvider } from '../inference.ts'
import { errorMessage } from '../log.ts'
import { asObject, optString } from './util.ts'

export function providerRoutes(ctx: ServerContext) {
  return new Elysia({ name: 'provider-routes' })
    .derive(({ cookie, request }) => ({ session: ctx.sessions.resolve(cookie, request) }))
    .get('/api/config', () => clientConfig(ctx.config))
    .get('/api/providers', (): ProvidersInfo => ({
      api_types: registeredApiTypes(),
      presets: [...PRESETS],
      connections: ctx.config.connections.map((c) => ({ name: c.name, connection: c.connection, has_server_key: Boolean(c.apiKey) })),
      remote_host_allowlist: ctx.config.remote_host_allowlist,
      local_execution: ctx.config.public_deployment ? 'browser' : 'server',
    }))
    .post('/api/providers/test', async ({ session, body }): Promise<ProviderTestResult> => {
      const b = asObject(body) as Partial<ConnectRequest>
      const target = resolveTarget(ctx, b)
      if (target.execution === 'browser') {
        return { ok: false, execution: 'browser', detail: 'This connection is local to your machine; the browser tests it directly.' }
      }
      try {
        return await withProvider(ctx, session, target, optString(b.api_key), async (p) => {
          const health = await p.health()
          let models: string[] | undefined
          if (health.ok) {
            try {
              models = await p.listModels()
            } catch {
              models = undefined
            }
          }
          return { ok: health.ok, detail: health.detail, latency_ms: health.latency_ms, models, execution: 'server' as const }
        })
      } catch (e) {
        if (e instanceof HttpError && e.status !== 401) throw e
        return { ok: false, execution: 'server', detail: errorMessage(e) }
      }
    })
    .post('/api/providers/models', async ({ session, body }) => {
      const b = asObject(body) as Partial<ConnectRequest>
      const target = resolveTarget(ctx, b)
      if (target.execution === 'browser') return { models: [] as string[], execution: 'browser' as const }
      const models = await withProvider(ctx, session, target, optString(b.api_key), (p) => p.listModels())
      return { models, execution: 'server' as const }
    })
    .post('/api/providers/describe', async ({ session, body }): Promise<DescribeResult> => {
      const b = asObject(body) as Partial<ConnectRequest>
      const target = b.connection || b.preset ? resolveTarget(ctx, b) : sessionTarget(ctx, session)
      if (target.execution === 'browser') return { info: null, execution: 'browser' }
      const info = await withProvider(ctx, session, target, optString(b.api_key), (p) => p.describeModel())
      return { info, execution: 'server' }
    })
}
