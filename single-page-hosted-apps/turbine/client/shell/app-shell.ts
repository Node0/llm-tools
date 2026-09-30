/**
 * AppShell — persistent chrome: brand, tab nav, inference badge, key countdown.
 * Mounted once before the router starts; the router only touches <outlet>.
 * Nav links are plain <a href>; the router's link interceptor handles clicks.
 */
import { Component, Pending } from '@diamondjs/runtime'
import * as T from './app-shell.diamond.html'
import { nav, ui } from '../services/nav.ts'
import { session } from '../services/session.ts'

export class AppShell extends Component {
  createTemplate = (T as unknown as { createTemplate: (this: AppShell) => HTMLElement }).createTemplate

  get toast(): string {
    return ui.toast
  }

  get pendingActive(): boolean {
    return Pending.active
  }

  tabClass(tab: string): string {
    return ui.activeTab === tab ? 'tab active' : 'tab'
  }

  get badgeText(): string {
    const s = session.state
    if (!s.ready) return 'Connecting…'
    if (!s.connection) return 'Not connected'
    const label = session.connectionLabel()
    if (s.expired || (!s.connected && s.connection.requires_key)) return `${label} · key expired`
    return label
  }

  get badgeTitle(): string {
    const s = session.state
    if (!s.connection) return 'Choose an inference provider'
    const where = s.execution === 'browser' ? 'Inference runs from this browser tab' : 'Inference runs on the Turbine server'
    return `${where}. Click to change the connection.`
  }

  get badgeClass(): string {
    const s = session.state
    if (!s.connection) return 'badge badge-off'
    if (!s.connected) return 'badge badge-warn'
    return s.connection.locality === 'local' ? 'badge badge-local' : 'badge badge-remote'
  }

  get showCountdown(): boolean {
    const s = session.state
    return Boolean(s.connection) && !s.server_key && (s.countdownMs !== null || s.expired)
  }

  get countdownText(): string {
    const s = session.state
    if (s.expired || s.countdownMs === 0) return 'expired'
    const ms = s.countdownMs ?? 0
    const total = Math.floor(ms / 1000)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const sec = total % 60
    const mm = String(m).padStart(2, '0')
    const ss = String(sec).padStart(2, '0')
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
  }

  get countdownClass(): string {
    const s = session.state
    if (s.expired || s.countdownMs === 0) return 'countdown countdown-expired'
    if ((s.countdownMs ?? Infinity) < 5 * 60_000) return 'countdown countdown-warn'
    return 'countdown'
  }

  get canLock(): boolean {
    const s = session.state
    return s.has_key && !s.server_key
  }

  async lock(): Promise<void> {
    await session.lock()
    nav.toast('The server has forgotten your API key.')
  }
}
