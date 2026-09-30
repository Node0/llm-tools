/**
 * client/services/api.ts — typed HTTP + WebSocket access to the Turbine server,
 * one function per route in shared/api.ts.
 */
import type { WindowRecord } from '../../shared/types.ts'
import {
  API,
  type ApiError,
  type ClientConfig,
  type ConnectRequest,
  type DocInfo,
  type JobCreateRequest,
  type JobFinishRequest,
  type JobInfo,
  type JobSocketMessage,
  type PreviewEvent,
  type PreviewMessages,
  type PreviewRequest,
  type ProviderTestResult,
  type ProvidersInfo,
  type SessionCreateRequest,
  type SessionInfo,
  type DescribeResult,
} from '../../shared/api.ts'

export class ApiRequestError extends Error {
  readonly status: number
  readonly code: string | undefined
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

async function parseError(res: Response): Promise<ApiRequestError> {
  let message = `${res.status} ${res.statusText}`
  let code: string | undefined
  try {
    const body = (await res.json()) as Partial<ApiError>
    if (body && typeof body.error === 'string') message = body.error
    if (body && typeof body.code === 'string') code = body.code
  } catch {
    /* non-JSON error body */
  }
  return new ApiRequestError(res.status, message, code)
}

async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...((init.headers as Record<string, string>) ?? {}) }
  let payload: BodyInit | undefined
  if (body instanceof FormData) payload = body
  else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(url, { ...init, method, headers, body: payload, credentials: 'same-origin' })
  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as T
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return (await res.json()) as T
  return (await res.text()) as unknown as T
}

export const api = {
  session: {
    create: (body: SessionCreateRequest) => request<SessionInfo>('POST', API.session, body),
    get: () => request<SessionInfo>('GET', API.session),
    destroy: () => request<{ ok: true }>('DELETE', API.session),
    connect: (body: ConnectRequest) => request<SessionInfo>('POST', API.sessionConnect, body),
    forgetKey: () => request<SessionInfo>('DELETE', API.sessionKey),
  },
  config: () => request<ClientConfig>('GET', API.config),
  providers: {
    info: () => request<ProvidersInfo>('GET', API.providers),
    test: (body: ConnectRequest) => request<ProviderTestResult>('POST', API.providersTest, body),
    models: (body: ConnectRequest) => request<{ models: string[] }>('POST', API.providersModels, body),
    describe: (body: Partial<ConnectRequest> = {}) => request<DescribeResult>('POST', API.providersDescribe, body),
  },
  docs: {
    list: () => request<DocInfo[]>('GET', API.docs),
    get: (id: string) => request<DocInfo>('GET', API.doc(id)),
    text: (id: string) => request<string>('GET', API.docText(id), undefined, { headers: { accept: 'text/plain' } }),
    remove: (id: string) => request<{ ok: true }>('DELETE', API.doc(id)),
    upload(input: File | { name: string; text: string }): Promise<DocInfo> {
      const form = new FormData()
      const file = input instanceof File ? input : new File([input.text], input.name, { type: 'text/plain' })
      form.append('file', file, file.name)
      return request<DocInfo>('POST', API.docs, form)
    },
  },
  preview: {
    messages: (body: PreviewRequest) => request<PreviewMessages>('POST', API.previewMessages, body),
    stream: (body: PreviewRequest, onEvent: (ev: PreviewEvent) => void, signal?: AbortSignal) =>
      streamNdjson<PreviewEvent>(API.preview, body, onEvent, signal),
  },
  jobs: {
    create: (body: JobCreateRequest) => request<JobInfo>('POST', API.jobs, body),
    list: () => request<JobInfo[]>('GET', API.jobs),
    get: (id: string) => request<JobInfo>('GET', API.job(id)),
    action: (id: string, action: 'start' | 'pause' | 'resume' | 'cancel') => request<JobInfo>('POST', API.jobAction(id, action)),
    finish: (id: string, body: JobFinishRequest) => request<JobInfo>('POST', API.jobFinish(id), body),
    windows: (id: string) => request<WindowRecord[]>('GET', API.jobWindows(id)),
    rerun: (id: string, i: number) => request<JobInfo>('POST', API.jobWindowRerun(id, i)),
    postResult: (id: string, i: number, record: WindowRecord) => request<{ ok: true }>('POST', API.jobWindowResult(id, i), record),
    outputUrl: (id: string) => API.jobOutput(id),
  },
}

/** POST a JSON body and consume an NDJSON response line by line. */
export async function streamNdjson<T>(url: string, body: unknown, onEvent: (ev: T) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  })
  if (!res.ok) throw await parseError(res)
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const handle = (line: string): void => {
    const t = line.trim()
    if (!t) return
    try {
      onEvent(JSON.parse(t) as T)
    } catch {
      /* ignore a torn frame */
    }
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  buf += decoder.decode()
  handle(buf)
}

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface JobSocket {
  close(): void
}

/** Subscribe to a job's event stream with exponential-backoff reconnect (capped at 15 s). */
export function openJobSocket(
  jobId: string,
  onMessage: (m: JobSocketMessage) => void,
  onStatus?: (s: SocketStatus) => void,
): JobSocket {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${location.host}${API.jobEvents(jobId)}`
  let ws: WebSocket | null = null
  let closed = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const connect = (): void => {
    if (closed) return
    onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting')
    ws = new WebSocket(url)
    ws.onopen = () => {
      attempt = 0
      onStatus?.('open')
    }
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)) as JobSocketMessage)
      } catch {
        /* ignore malformed frame */
      }
    }
    ws.onclose = () => {
      ws = null
      if (closed) {
        onStatus?.('closed')
        return
      }
      attempt++
      const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5))
      timer = setTimeout(connect, delay)
    }
    ws.onerror = () => {
      /* onclose follows */
    }
  }
  connect()
  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      ws?.close()
      ws = null
      onStatus?.('closed')
    },
  }
}
