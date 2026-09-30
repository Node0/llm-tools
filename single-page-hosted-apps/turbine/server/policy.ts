/**
 * server/policy.ts — where inference runs, and what the server may call.
 *
 * Public deployment + local backend  → the BROWSER runs the job (the user's
 * machine is the only thing that can reach their Ollama, and a public server
 * fetching user-supplied URLs is a request-forgery hole).
 * Everything else                    → the server runs it.
 *
 * Under public deployment the server only ever calls hosts on the allowlist,
 * and never anything that classifies as local.
 */

import type { Execution } from '../shared/api.ts'
import { classifyLocality } from '../shared/providers/index.ts'
import type { ConnectionSpec } from '../shared/types.ts'
import type { TurbineConfig } from './config.ts'
import { HttpError } from './errors.ts'

export function decideExecution(config: TurbineConfig, connection: ConnectionSpec): Execution {
  return config.public_deployment && connection.locality === 'local' ? 'browser' : 'server'
}

export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase()
  return allowlist.some((a) => h === a || h.endsWith(`.${a}`))
}

/** Throws 403 'ssrf-blocked' when a public server is asked to call something it must not. */
export function assertServerMayCall(config: TurbineConfig, connection: ConnectionSpec): void {
  if (!config.public_deployment) return
  let host: string
  try {
    host = new URL(connection.base_url).hostname
  } catch {
    throw new HttpError(400, `invalid base_url '${connection.base_url}'`, 'bad-url')
  }
  if (classifyLocality(connection.base_url) === 'local') {
    throw new HttpError(403, `public deployment: the server will not call local address '${host}'; run this connection from the browser`, 'ssrf-blocked')
  }
  if (!hostAllowed(host, config.remote_host_allowlist)) {
    throw new HttpError(403, `public deployment: '${host}' is not in remote_host_allowlist`, 'ssrf-blocked')
  }
}
