/**
 * server/config.ts — load and validate config.json.
 *
 * The file is Turbine's (deployment mode, session TTL, limits, window
 * defaults, named inference connections). DiamondJS's own run_mode lives in
 * app/config/config.json and is read by the Parcel transformer, not here.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ClientConfig } from '../shared/api.ts'
import { FALLBACK_WINDOW_DEFAULTS, type WindowDefaults } from '../shared/defaults.ts'
import { classifyLocality, normalizeConnection } from '../shared/providers/index.ts'
import type { ConnectionSpec } from '../shared/types.ts'
import { log } from './log.ts'

export const TURBINE_ROOT = resolve(import.meta.dir, '..')

export interface ServerConnection {
  name: string
  connection: ConnectionSpec
  /** Resolved from api_key / api_key_env. Always null under public deployment. */
  apiKey: string | null
}

export interface TurbineConfig {
  public_deployment: boolean
  server: {
    host: string
    port: number
    static_dir: string
    data_dir: string
    trust_proxy: boolean
  }
  session: {
    ttl_seconds: number
    extend_on_activity: boolean
    cookie_name: string
  }
  limits: {
    max_upload_bytes: number
    max_concurrency: number
    max_jobs_per_session: number
  }
  window_defaults: WindowDefaults
  remote_host_allowlist: string[]
  connections: ServerConnection[]
  version: string
  /** Absolute path the config was loaded from (or '<defaults>'). */
  source: string
}

type Raw = Record<string, unknown>

const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d: string): string => (typeof v === 'string' && v.length ? v : d)
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)

export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(TURBINE_ROOT, 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Build a TurbineConfig from an already-parsed object (tests use this directly). */
export function configFromObject(raw: unknown, source = '<object>', env: Record<string, string | undefined> = process.env): TurbineConfig {
  const r = obj(raw)
  const server = obj(r.server)
  const session = obj(r.session)
  const limits = obj(r.limits)
  const wd = obj(r.window_defaults)
  const publicDeployment = bool(r.public_deployment, false)
  const baseDir = source.startsWith('<') ? TURBINE_ROOT : dirname(source)
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(baseDir, p))

  const carry = obj(wd.carry)
  const validator = obj(wd.validator)
  const window_defaults: WindowDefaults = {
    focus_tokens: num(wd.focus_tokens, FALLBACK_WINDOW_DEFAULTS.focus_tokens),
    context_before_tokens: num(wd.context_before_tokens, FALLBACK_WINDOW_DEFAULTS.context_before_tokens),
    context_after_tokens: num(wd.context_after_tokens, FALLBACK_WINDOW_DEFAULTS.context_after_tokens),
    snap: wd.snap === 'sentence' || wd.snap === 'none' ? wd.snap : 'paragraph',
    mode: wd.mode === 'fold' ? 'fold' : 'map',
    concurrency: num(wd.concurrency, FALLBACK_WINDOW_DEFAULTS.concurrency),
    carry: { kind: carry.kind === 'none' ? 'none' : 'tail', chars: num(carry.chars, FALLBACK_WINDOW_DEFAULTS.carry.chars) },
    temperature: num(wd.temperature, FALLBACK_WINDOW_DEFAULTS.temperature),
    max_tokens: num(wd.max_tokens, FALLBACK_WINDOW_DEFAULTS.max_tokens),
    validator: {
      kind: validator.kind === 'conserve' || validator.kind === 'length-ratio' ? validator.kind : 'none',
      ...(typeof validator.threshold === 'number' ? { threshold: validator.threshold } : {}),
      ...(typeof validator.minRatio === 'number' ? { minRatio: validator.minRatio } : {}),
      ...(typeof validator.maxRatio === 'number' ? { maxRatio: validator.maxRatio } : {}),
    },
    joiner: typeof wd.joiner === 'string' ? wd.joiner : FALLBACK_WINDOW_DEFAULTS.joiner,
  }

  const allow = Array.isArray(r.remote_host_allowlist)
    ? (r.remote_host_allowlist as unknown[]).filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase())
    : ['openrouter.ai', 'api.openai.com', 'api.anthropic.com']

  const connections: ServerConnection[] = []
  for (const [name, val] of Object.entries(obj(r.inference_service_connections))) {
    const c = obj(val)
    try {
      const base_url = str(c.base_url, '')
      const locality = classifyLocality(base_url)
      const requires_key = typeof c.requires_key === 'boolean' ? c.requires_key : locality === 'remote'
      const connection = normalizeConnection({ ...c, name, model: c.model ?? c.default_model, ctx_len: c.ctx_len ?? c.default_ctx_len, requires_key })
      let apiKey: string | null = null
      const literal = typeof c.api_key === 'string' && c.api_key.trim() ? c.api_key.trim() : null
      const envName = typeof c.api_key_env === 'string' && c.api_key_env.trim() ? c.api_key_env.trim() : null
      if (publicDeployment) {
        if (literal || envName) {
          log('WARNING', `config connection '${name}': api_key/api_key_env ignored because public_deployment is true — users supply their own keys`)
        }
      } else {
        apiKey = literal ?? (envName ? env[envName]?.trim() || null : null)
        if (envName && !apiKey && !literal) log('WARNING', `config connection '${name}': env ${envName} is not set; the connection will need a key from the browser`)
      }
      connections.push({ name, connection, apiKey })
    } catch (e) {
      log('WARNING', `config connection '${name}' skipped: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    public_deployment: publicDeployment,
    server: {
      host: str(server.host, '0.0.0.0'),
      port: num(server.port, 7331),
      static_dir: abs(str(server.static_dir, 'dist/client')),
      data_dir: abs(str(server.data_dir, 'data')),
      trust_proxy: bool(server.trust_proxy, false),
    },
    session: {
      ttl_seconds: Math.max(30, num(session.ttl_seconds, 3600)),
      extend_on_activity: bool(session.extend_on_activity, false),
      cookie_name: str(session.cookie_name, 'turbine_sid'),
    },
    limits: {
      max_upload_bytes: num(limits.max_upload_bytes, 26_214_400),
      max_concurrency: Math.max(1, num(limits.max_concurrency, 8)),
      max_jobs_per_session: Math.max(1, num(limits.max_jobs_per_session, 4)),
    },
    window_defaults,
    remote_host_allowlist: allow,
    connections,
    version: readVersion(),
    source,
  }
}

export function loadConfig(path?: string): TurbineConfig {
  const file = path ?? process.env.TURBINE_CONFIG ?? join(TURBINE_ROOT, 'config.json')
  if (!existsSync(file)) {
    log('WARNING', `config file ${file} not found — running with built-in defaults (private deployment, no connections)`)
    return configFromObject({}, '<defaults>')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`config file ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  return configFromObject(parsed, resolve(file))
}

export function clientConfig(config: TurbineConfig): ClientConfig {
  return {
    public_deployment: config.public_deployment,
    ttl_seconds: config.session.ttl_seconds,
    extend_on_activity: config.session.extend_on_activity,
    max_upload_bytes: config.limits.max_upload_bytes,
    max_concurrency: config.limits.max_concurrency,
    window_defaults: config.window_defaults,
    version: config.version,
  }
}
