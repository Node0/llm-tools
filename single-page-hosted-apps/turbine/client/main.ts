/**
 * client/main.ts — boot: session → shell → router.
 * The session is resolved BEFORE the router starts so the RequireConnection
 * guard sees the truth on the very first URL.
 */
import { Router } from '@diamondjs/runtime'
import { Print } from '@diamondjs/primafacie'
import { AppShell } from './shell/app-shell.ts'
import { routes } from './app.routes.ts'
import { nav } from './services/nav.ts'
import { session } from './services/session.ts'
import { documents } from './services/documents.ts'
import { prompt } from './services/prompt.ts'
import { job } from './services/job.ts'
import { loadTokenizer } from './services/tokenizer.ts'

async function boot(): Promise<void> {
  const host = document.getElementById('app')
  if (!host) throw new Error('#app not found')

  await session.init()
  prompt.init()
  // Best-effort restores; neither blocks the first paint for long.
  await Promise.allSettled([documents.restore(), job.restore()])

  const shell = new AppShell()
  shell.mount(host)

  const router = new Router(routes)
  nav.set(router)
  await router.start()
  void loadTokenizer() // ~2 MB, cached; token counts switch from estimates to exact when it lands
  Print('SUCCESS', `Turbine ready — ${session.state.connected ? session.connectionLabel() : 'no connection yet'}`)
}

boot().catch((e: unknown) => {
  Print('CRITICAL', `boot failed: ${e instanceof Error ? e.message : String(e)}`)
  const host = document.getElementById('app')
  if (host) host.textContent = `Turbine failed to start: ${e instanceof Error ? e.message : String(e)}`
})
