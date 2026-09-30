/**
 * server/index.ts — Turbine's Elysia application.
 *
 *   bun server/index.ts            serve config.json's host:port
 *   TURBINE_CONFIG=/x/y.json …     alternate config
 *   TURBINE_MASTER_SECRET=<hex>    stable vault secret (optional; default is random per boot)
 *
 * Route modules live in server/routes/*; state in server/{sessions,docs,jobs,keyvault}.ts.
 * The client bundle (dist/client) is served statically with an SPA fallback so
 * /source, /prompt, /output and /connect deep-link and reload correctly.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { Elysia } from 'elysia'
import { loadConfig, type TurbineConfig } from './config.ts'
import type { ServerContext } from './context.ts'
import { DocStore } from './docs.ts'
import { HttpError } from './errors.ts'
import { JobManager } from './jobs.ts'
import { KeyVault } from './keyvault.ts'
import { errorMessage, log } from './log.ts'
import { docRoutes } from './routes/docs.ts'
import { jobRoutes } from './routes/jobs.ts'
import { previewRoutes } from './routes/preview.ts'
import { providerRoutes } from './routes/providers.ts'
import { sessionRoutes } from './routes/session.ts'
import { SessionStore } from './sessions.ts'

export interface BuildOptions {
  vault?: KeyVault
}

export async function buildApp(config: TurbineConfig, opts: BuildOptions = {}) {
  mkdirSync(config.server.data_dir, { recursive: true })
  const vault = opts.vault ?? KeyVault.fromEnv()
  const sessions = new SessionStore(config, vault)
  const docs = new DocStore(config)
  const jobs = new JobManager(config, docs, vault, sessions)
  const ctx: ServerContext = { config, vault, sessions, docs, jobs }
  const indexHtml = join(resolve(config.server.static_dir), 'index.html')

  const app = new Elysia()
    .onRequest(({ request, set }) => {
      set.headers['x-content-type-options'] = 'nosniff'
      set.headers['referrer-policy'] = 'no-referrer'
      if (new URL(request.url).pathname.startsWith('/api')) set.headers['cache-control'] = 'no-store'
    })
    // `as: 'global'` so this also catches the NotFoundError the static plugin throws inside its own scope
    // (otherwise deep links like /prompt fall through as bare 404s once dist/client exists).
    .onError({ as: 'global' }, ({ code, error, set, request }) => {
      const path = new URL(request.url).pathname
      if (error instanceof HttpError) {
        set.status = error.status
        if (error.status >= 500) log('ERROR', `${request.method} ${path} → ${error.status} ${error.message}`)
        return { error: error.message, code: error.code }
      }
      switch (code) {
        case 'NOT_FOUND':
          set.status = 404
          return { error: `no route for ${request.method} ${path}`, code: 'not-found' }
        case 'VALIDATION':
        case 'PARSE':
          set.status = 400
          return { error: errorMessage(error).split('\n')[0], code: code === 'PARSE' ? 'bad-body' : 'validation' }
        default: {
          const msg = errorMessage(error)
          log('ERROR', `${request.method} ${path} → 500 ${msg}`)
          set.status = 500
          return { error: msg, code: 'internal' }
        }
      }
    })
    .use(sessionRoutes(ctx))
    .use(providerRoutes(ctx))
    .use(docRoutes(ctx))
    .use(previewRoutes(ctx))
    .use(jobRoutes(ctx))
    .get('/api/*', () => {
      throw new HttpError(404, 'unknown API route', 'not-found')
    })

  // Static client + SPA fallback. Deliberately hand-rolled: every non-/api GET is either a
  // file under static_dir (hashed Parcel assets → immutable cache) or the SPA's index.html
  // (/source, /prompt, /output, /connect must deep-link and reload). Path traversal is
  // rejected by resolving inside staticRoot and checking the prefix.
  const staticRoot = resolve(config.server.static_dir)
  if (!existsSync(staticRoot)) log('WARNING', `static dir ${staticRoot} does not exist yet — API only until you run \`bun run build\``)
  const notBuilt = (): Response =>
    new Response('Turbine client bundle not built. Run `bun run build` (or `bun run dev`) and reload.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  // Vendor assets the client loads lazily: tiktoken's Rust→WASM tokenizer and its BPE ranks.
  // Served straight from node_modules so no copy step is needed in dev or prod builds.
  const vendorRoot = resolve(import.meta.dir, '..', 'node_modules', 'tiktoken')
  const vendorFiles: Record<string, { path: string; type: string }> = {
    'tiktoken_bg.wasm': { path: join(vendorRoot, 'lite', 'tiktoken_bg.wasm'), type: 'application/wasm' },
    'tiktoken_bg.js': { path: join(vendorRoot, 'lite', 'tiktoken_bg.js'), type: 'text/javascript; charset=utf-8' },
    'cl100k_base.json': { path: join(vendorRoot, 'encoders', 'cl100k_base.json'), type: 'application/json' },
    'o200k_base.json': { path: join(vendorRoot, 'encoders', 'o200k_base.json'), type: 'application/json' },
  }
  app.get('/vendor/tiktoken/:file', ({ params }) => {
    const f = vendorFiles[params.file]
    if (!f || !existsSync(f.path)) throw new HttpError(404, `no vendor asset ${params.file}`, 'not-found')
    return new Response(Bun.file(f.path), { headers: { 'content-type': f.type, 'cache-control': 'public, max-age=86400' } })
  })

  app.get('/*', ({ request, path }) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method not allowed', 'method')
    let rel: string
    try {
      rel = decodeURIComponent(path)
    } catch {
      throw new HttpError(400, 'bad path encoding', 'bad-path')
    }
    const candidate = resolve(staticRoot, '.' + rel)
    if (candidate === staticRoot || candidate.startsWith(staticRoot + sep)) {
      try {
        if (statSync(candidate).isFile()) {
          const hashed = /\.[0-9a-f]{8}\.[a-z0-9]+$/i.test(candidate)
          return new Response(Bun.file(candidate), {
            headers: { 'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' },
          })
        }
      } catch {
        /* not a file → fall through to the SPA */
      }
    }
    // Looks like an asset request (has an extension) but no such file → real 404, not index.html.
    if (/\.[a-z0-9]{1,8}$/i.test(rel) && !rel.endsWith('.html')) throw new HttpError(404, `no such file ${rel}`, 'not-found')
    if (!existsSync(indexHtml)) return notBuilt()
    return new Response(Bun.file(indexHtml), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
  })

  return { app, ctx }
}

if (import.meta.main) {
  const config = loadConfig()
  const { app, ctx } = await buildApp(config)
  app.listen({ hostname: config.server.host, port: config.server.port })
  const shown = config.server.host === '0.0.0.0' ? 'localhost' : config.server.host
  log('STARTING', `Turbine v${config.version} listening on http://${shown}:${config.server.port}  (config: ${config.source})`)
  log('STATE', `deployment: ${config.public_deployment ? 'PUBLIC — local backends run in the browser, server calls only allowlisted hosts' : 'private — server calls any backend, including LAN/localhost'}`)
  log('STATE', `key TTL: ${config.session.ttl_seconds}s${config.session.extend_on_activity ? ' (sliding on activity)' : ' (fixed)'}; data dir: ${config.server.data_dir}`)
  for (const c of config.connections) {
    log('INFO', `connection '${c.name}': ${c.connection.api_type} @ ${c.connection.base_url} model=${c.connection.model}${c.apiKey ? ' [server key]' : c.connection.requires_key ? ' [needs browser key]' : ''}`)
  }
  const shutdown = async (sig: string): Promise<void> => {
    log('STATE', `${sig}: stopping jobs and wiping the key vault`)
    await ctx.jobs.stopAll()
    ctx.vault.clear()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}
