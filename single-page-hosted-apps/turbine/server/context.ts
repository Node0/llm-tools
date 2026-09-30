/** The shared server context handed to every routes module. */
import type { TurbineConfig } from './config.ts'
import type { DocStore } from './docs.ts'
import type { JobManager } from './jobs.ts'
import type { KeyVault } from './keyvault.ts'
import type { SessionStore } from './sessions.ts'

export interface ServerContext {
  config: TurbineConfig
  vault: KeyVault
  sessions: SessionStore
  docs: DocStore
  jobs: JobManager
}
