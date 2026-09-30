/**
 * shared/api.ts — the HTTP + WebSocket contract between client and server.
 *
 * Every route, its method, its body and its response type, in one place. The
 * server implements exactly this; the client's api service types against it.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ Session                                                                  │
 * │  POST   /api/session                 SessionCreateRequest → SessionInfo  │
 * │  GET    /api/session                 → SessionInfo                       │
 * │  DELETE /api/session                 → { ok: true }                      │
 * │  POST   /api/session/connect         ConnectRequest → SessionInfo        │
 * │  DELETE /api/session/key             → SessionInfo (forget key now)      │
 * │ Config / providers                                                       │
 * │  GET    /api/config                  → ClientConfig                      │
 * │  GET    /api/providers               → ProvidersInfo                     │
 * │  POST   /api/providers/test          ConnectRequest → ProviderTestResult │
 * │  POST   /api/providers/models        ConnectRequest → { models }         │
 * │  POST   /api/providers/describe      ConnectRequest | {} → ModelInfo (session connection when body is empty) │
 * │ Documents                                                                │
 * │  POST   /api/docs                    multipart{file} | DocCreateJson → DocInfo │
 * │  GET    /api/docs                    → DocInfo[]                          │
 * │  GET    /api/docs/:id                → DocInfo                            │
 * │  GET    /api/docs/:id/text           → text/plain (full document)         │
 * │  GET    /api/docs/:id/slice?start&end → DocSlice                          │
 * │  DELETE /api/docs/:id                → { ok: true }                       │
 * │ Preview                                                                  │
 * │  POST   /api/preview                 PreviewRequest → NDJSON PreviewEvent │
 * │  POST   /api/preview/messages        PreviewRequest → { messages, estimate } │
 * │ Jobs                                                                     │
 * │  POST   /api/jobs                    JobCreateRequest → JobInfo           │
 * │  GET    /api/jobs                    → JobInfo[]                          │
 * │  GET    /api/jobs/:id                → JobInfo                            │
 * │  POST   /api/jobs/:id/start|pause|resume|cancel → JobInfo                 │
 * │  POST   /api/jobs/:id/windows/:i/rerun → JobInfo                          │
 * │  POST   /api/jobs/:id/windows/:i/result  WindowRecord → { ok } (browser-run checkpoint) │
 * │  POST   /api/jobs/:id/finish         JobFinishRequest → JobInfo (browser-run) │
 * │  GET    /api/jobs/:id/windows        → WindowRecord[]                     │
 * │  GET    /api/jobs/:id/output         → text/markdown (attachment)         │
 * │  WS     /api/jobs/:id/events         server→client: JobSocketMessage      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Errors: every non-2xx response is `{ error: string, code?: string }`.
 */

import type { ApiType, ChatMessage, ConnectionSpec, JobSpec, ModelInfo, PlanEstimate, TokenUsage, ValidationResult, WindowEvent, WindowPlan, WindowRecord } from './types.ts'
import type { WindowDefaults } from './defaults.ts'
import type { Preset } from './providers/presets.ts'

export interface ApiError {
  error: string
  code?: string
}

// ─── Session ─────────────────────────────────────────────────────────────────

/** Where a job's inference calls originate. Decided by the server from deployment mode + connection locality. */
export type Execution = 'server' | 'browser'

export interface SessionCreateRequest {
  /** SHA-256 hex of the browser's fingerprint. Optional; only a loose "same browser?" check. */
  fingerprint?: string
}

export interface ConnectRequest {
  /** A full connection composed in the browser, or … */
  connection?: ConnectionSpec
  /** … the name of a server-side connection from config.json (private deployments may attach keys to these). */
  preset?: string
  /** Sent over TLS, held encrypted in memory, dropped at expiry. Never echoed back. */
  api_key?: string
  fingerprint?: string
}

export interface SessionInfo {
  public_deployment: boolean
  ttl_seconds: number
  /** True when a connection is set and, if it needs a key, the key is present and unexpired. */
  connected: boolean
  connection: ConnectionSpec | null
  has_key: boolean
  /** ISO time the server will forget the key; null when no key is held. */
  key_expires_at: string | null
  /** True when the connection's key comes from config.json / env on the server (private deployments). Such keys don't expire. */
  server_key: boolean
  execution: Execution | null
  /** The fingerprint sent this time differs from the one recorded at session creation. */
  fingerprint_changed: boolean
}

// ─── Config / providers ──────────────────────────────────────────────────────

export interface ClientConfig {
  public_deployment: boolean
  ttl_seconds: number
  extend_on_activity: boolean
  max_upload_bytes: number
  max_concurrency: number
  window_defaults: WindowDefaults
  version: string
}

export interface ServerConnectionInfo {
  name: string
  connection: ConnectionSpec
  /** The server holds a key for this connection (from config.json/env). Only ever true in private deployments. */
  has_server_key: boolean
}

export interface ProvidersInfo {
  api_types: ApiType[]
  presets: Preset[]
  connections: ServerConnectionInfo[]
  /** Hosts the server will call on behalf of a public-deployment user. */
  remote_host_allowlist: string[]
  /** Under public deployment, local connections must be driven from the browser. */
  local_execution: Execution
}

/** Response of POST /api/providers/describe. `execution: 'browser'` means the client must call describeModel() itself. */
export interface DescribeResult {
  info: ModelInfo | null
  execution: Execution
}

export interface ProviderTestResult {
  ok: boolean
  detail?: string
  latency_ms?: number
  models?: string[]
  execution: Execution
}

// ─── Documents ───────────────────────────────────────────────────────────────

export interface DocCreateJson {
  name: string
  text: string
}

export interface DocInfo {
  id: string
  name: string
  bytes: number
  chars: number
  words: number
  est_tokens: number
  est_pages: number
  paragraphs: number
  created_at: string
}

export interface DocSlice {
  start: number
  end: number
  text: string
}

// ─── Preview ─────────────────────────────────────────────────────────────────

export interface PreviewRequest {
  doc_id: string
  spec: JobSpec
  /** The selection to treat as the focus. Context is added by spec.window, exactly as a real run would. */
  focus: { start: number; end: number }
  carry?: string
}

export interface PreviewMessages {
  messages: ChatMessage[]
  window: WindowPlan
  estimate: PlanEstimate
}

export type PreviewEvent =
  | { type: 'messages'; messages: ChatMessage[]; window: WindowPlan }
  | { type: 'token'; chunk: string }
  | { type: 'done'; output: string; elapsed_ms: number; model: string; validation: ValidationResult; usage?: TokenUsage }
  | { type: 'error'; error: string }

// ─── Jobs ────────────────────────────────────────────────────────────────────

export type JobStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'key-expired'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'halted'

export interface JobCreateRequest {
  doc_id: string
  spec: JobSpec
}

export interface JobFinishRequest {
  status: Extract<JobStatus, 'completed' | 'cancelled' | 'failed' | 'halted' | 'paused' | 'running' | 'key-expired'>
  error?: string
}

export interface JobInfo {
  id: string
  doc_id: string
  source_name: string
  connection_name: string
  model: string
  execution: Execution
  status: JobStatus
  spec: JobSpec
  plan: WindowPlan[]
  estimate: PlanEstimate
  window_count: number
  done_count: number
  flagged_count: number
  failed_count: number
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  output_filename: string
  /** <stem>__turbine.jsonl, relative to the server's data dir. */
  checkpoint_file: string
}

/** Everything the WS sends. The first frame after connect is always a snapshot. */
export type JobSocketMessage =
  | { type: 'snapshot'; job: JobInfo; windows: WindowRecord[] }
  | { type: 'job'; job: JobInfo }
  | { type: 'event'; event: WindowEvent }
  | { type: 'error'; error: string }

export const API = {
  session: '/api/session',
  sessionConnect: '/api/session/connect',
  sessionKey: '/api/session/key',
  config: '/api/config',
  providers: '/api/providers',
  providersTest: '/api/providers/test',
  providersModels: '/api/providers/models',
  providersDescribe: '/api/providers/describe',
  docs: '/api/docs',
  doc: (id: string) => `/api/docs/${encodeURIComponent(id)}`,
  docText: (id: string) => `/api/docs/${encodeURIComponent(id)}/text`,
  docSlice: (id: string, start: number, end: number) => `/api/docs/${encodeURIComponent(id)}/slice?start=${start}&end=${end}`,
  preview: '/api/preview',
  previewMessages: '/api/preview/messages',
  jobs: '/api/jobs',
  job: (id: string) => `/api/jobs/${encodeURIComponent(id)}`,
  jobAction: (id: string, action: 'start' | 'pause' | 'resume' | 'cancel') => `/api/jobs/${encodeURIComponent(id)}/${action}`,
  jobFinish: (id: string) => `/api/jobs/${encodeURIComponent(id)}/finish`,
  jobWindows: (id: string) => `/api/jobs/${encodeURIComponent(id)}/windows`,
  jobWindowRerun: (id: string, i: number) => `/api/jobs/${encodeURIComponent(id)}/windows/${i}/rerun`,
  jobWindowResult: (id: string, i: number) => `/api/jobs/${encodeURIComponent(id)}/windows/${i}/result`,
  jobOutput: (id: string) => `/api/jobs/${encodeURIComponent(id)}/output`,
  jobEvents: (id: string) => `/api/jobs/${encodeURIComponent(id)}/events`,
} as const
