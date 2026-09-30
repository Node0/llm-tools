/**
 * client/services/nav.ts — the router handle + tiny UI state shared by the shell
 * and the pages. A holder module avoids a main.ts ↔ pages import cycle.
 */
import { DiamondCore, type Router } from '@diamondjs/runtime'

let router: Router | null = null

export type Tab = '' | 'source' | 'prompt' | 'output' | 'connect'

export const ui = DiamondCore.reactive({
  activeTab: '' as Tab,
  /** Transient toast line shown in the shell. */
  toast: '' as string,
})

let toastTimer: ReturnType<typeof setTimeout> | undefined

export const nav = {
  set(r: Router): void {
    router = r
  },
  go(path: string): Promise<void> {
    return router ? router.navigate(path) : Promise.resolve()
  },
  /** `?returnTo=/x` written by the RequireConnection guard's deny(). Only app-relative paths are honored. */
  returnTo(): string | null {
    const q = new URLSearchParams(location.search).get('returnTo')
    return q && q.startsWith('/') && !q.startsWith('//') ? q : null
  },
  toast(message: string, ms = 3500): void {
    ui.toast = message
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      ui.toast = ''
    }, ms)
  },
}
