import { Component } from '@diamondjs/runtime'
import { ui } from '../services/nav.ts'

export class NotFoundPage extends Component {
  constructor(_params?: Record<string, unknown>) {
    super()
    ui.activeTab = ''
  }
  override createTemplate(): HTMLElement {
    const div = document.createElement('div')
    div.className = 'page narrow'
    const h = document.createElement('h1')
    h.textContent = 'Nothing here'
    const p = document.createElement('p')
    p.className = 'muted'
    p.textContent = 'That address does not match a Turbine view.'
    const a = document.createElement('a')
    a.href = '/source'
    a.textContent = 'Go to Source'
    div.append(h, p, a)
    return div
  }
}
