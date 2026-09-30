/**
 * shared/providers/http.ts — the tiny HTTP substrate every backend shares.
 *
 * - One fetch wrapper with timeout + abort composition.
 * - SSE / NDJSON line readers for streaming bodies.
 * - Secret scrubbing so a key can never leak through an error message, a log
 *   line, or an echoed response body.
 */

import { ProviderError } from '../types.ts'

export type FetchLike = typeof fetch

/** Replace every occurrence of `secret` (and its URL-encoded form) in `text`. */
export function scrubSecret(text: string, secret: string | null | undefined): string {
  if (!secret || secret.length < 6) return text
  const forms = [secret, encodeURIComponent(secret)]
  let out = text
  for (const f of forms) {
    if (f && out.includes(f)) out = out.split(f).join('[REDACTED]')
  }
  return out
}

/** Strip a trailing slash so `${base}/path` never doubles up. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, '')
}

export interface RequestInitEx extends RequestInit {
  timeout_ms?: number
}

/**
 * fetch with a timeout that composes with a caller-supplied AbortSignal.
 * Throws ProviderError on non-2xx with the (scrubbed) body attached.
 */
export async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInitEx,
  secret: string | null,
): Promise<Response> {
  const controller = new AbortController()
  const outer = init.signal
  const onOuterAbort = (): void => controller.abort(outer?.reason)
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason)
    else outer.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timeout = init.timeout_ms ?? 120_000
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeout}ms`)), timeout)
  try {
    let res: Response
    try {
      res = await fetchImpl(url, { ...init, signal: controller.signal })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const aborted = controller.signal.aborted
      throw new ProviderError(scrubSecret(`request to ${url} failed: ${msg}`, secret), {
        retryable: !aborted || /timeout/i.test(msg),
        cause: e,
      })
    }
    if (!res.ok) {
      const body = scrubSecret(await safeText(res), secret)
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500
      throw new ProviderError(`${res.status} ${res.statusText} from ${url}: ${truncate(body, 600)}`, {
        status: res.status,
        retryable,
        body,
      })
    }
    return res
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onOuterAbort)
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * Iterate a streaming body line by line. Handles both SSE (`data: {...}`) and
 * NDJSON (`{...}` per line); yields the payload string with any `data:` prefix
 * removed and blank/comment lines dropped.
 */
export async function* readLines(res: Response): AsyncGenerator<string> {
  const body = res.body
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        const line = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim()
        if (!line || line.startsWith(':')) continue
        yield line
      }
    }
    buf += decoder.decode()
    const tail = buf.trim()
    if (tail) yield tail.startsWith('data:') ? tail.slice(5).trim() : tail
  } finally {
    reader.releaseLock()
  }
}

export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** GET JSON, or null on any failure — discovery must never break a connection. */
export async function tryGetJson<T>(fetchImpl: FetchLike, url: string, headers: Record<string, string>, secret: string | null, timeoutMs = 15_000): Promise<T | null> {
  try {
    const res = await request(fetchImpl, url, { headers, timeout_ms: timeoutMs }, secret)
    return (await res.json()) as T
  } catch {
    return null
  }
}
