/**
 * ModelParamsForm — the "Model parameters" knobs, built from what the backend
 * reported for the current model (prompt.state.modelInfo).
 *
 * Hand-written createTemplate: the field set is data-driven (kind, bounds,
 * options differ per knob), which is easier to express directly against
 * DiamondCore than through a compiled template. The form is rebuilt whenever
 * the discovered ModelInfo changes; each input is two-way bound to the
 * prompt service so "Reset defaults" and persistence flow back into the UI.
 */
import { Component, DiamondCore } from '@diamondjs/runtime'
import type { ModelInfo, ParamDescriptor, ParamGroup, ReasoningSetting } from '../../shared/types.ts'
import { coerceParam } from '../../shared/providers/params.ts'
import { prompt } from '../services/prompt.ts'
import { tip } from '../services/tooltips.ts'

const GROUP_LABELS: Record<ParamGroup, string> = {
  sampling: 'Sampling',
  repetition: 'Repetition',
  determinism: 'Determinism',
  context: 'Context',
  other: 'Other',
}

const REASONING_LABELS: Record<ReasoningSetting, string> = {
  off: 'Off — answer directly (Turbine default)',
  on: 'On — backend default depth',
  low: 'Low effort',
  medium: 'Medium effort',
  high: 'High effort',
}

export class ModelParamsForm extends Component {
  private root: HTMLElement | null = null
  private teardown: (() => void) | null = null

  override createTemplate(): HTMLElement {
    const root = document.createElement('div')
    root.className = 'params-form'
    this.root = root
    // Rebuild when the discovered model info (identity) or its status changes.
    const stop = DiamondCore.effect(() => {
      const info = prompt.state.modelInfo
      const status = prompt.state.modelInfoStatus
      this.rebuild(info, status)
    })
    this.registerCleanup(stop)
    this.registerCleanup(() => this.teardown?.())
    return root
  }

  private rebuild(info: ModelInfo | null, status: string): void {
    const root = this.root
    if (!root) return
    this.teardown?.()
    this.teardown = null
    root.replaceChildren()
    const { cleanup } = DiamondCore.captureScope(() => this.build(root, info, status))
    this.teardown = cleanup
  }

  private build(root: HTMLElement, info: ModelInfo | null, status: string): void {
    if (status === 'loading' && !info) {
      root.appendChild(this.note('Asking the backend what this model accepts…', 'muted'))
      return
    }
    if (!info) {
      root.appendChild(this.note(status === 'error' ? 'Discovery failed; connect first or press Refresh.' : 'Connect to a backend to see its parameters.', 'muted'))
      return
    }
    root.appendChild(this.reasoningRow(info))
    const groups = new Map<ParamGroup, ParamDescriptor[]>()
    for (const d of info.parameters) {
      const list = groups.get(d.group) ?? []
      list.push(d)
      groups.set(d.group, list)
    }
    if (groups.size === 0) root.appendChild(this.note('This model exposes no adjustable sampling parameters beyond reasoning.', 'muted'))
    for (const [group, list] of groups) {
      const section = document.createElement('div')
      section.className = 'params-group'
      const h = document.createElement('h3')
      h.textContent = GROUP_LABELS[group]
      section.appendChild(h)
      const grid = document.createElement('div')
      grid.className = 'params-grid'
      for (const d of list) grid.appendChild(this.knob(d))
      section.appendChild(grid)
      root.appendChild(section)
    }
  }

  private note(text: string, cls: string): HTMLElement {
    const p = document.createElement('p')
    p.className = cls
    p.textContent = text
    return p
  }

  private reasoningRow(info: ModelInfo): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'params-group'
    const h = document.createElement('h3')
    h.textContent = 'Reasoning'
    wrap.appendChild(h)
    const grid = document.createElement('div')
    grid.className = 'params-grid'
    const label = document.createElement('label')
    label.className = 'param'
    label.title = tip('prompt.model.reasoning')
    const name = document.createElement('span')
    name.className = 'lbl'
    name.textContent = 'Thinking / reasoning'
    label.appendChild(name)
    const select = document.createElement('select')
    const settings = info.reasoning.settings.length ? info.reasoning.settings : (['off'] as ReasoningSetting[])
    for (const s of settings) {
      const o = document.createElement('option')
      o.value = s
      o.textContent = REASONING_LABELS[s]
      select.appendChild(o)
    }
    const supported = info.reasoning.supported
    select.disabled = supported === false
    DiamondCore.bind(select, 'value', () => prompt.state.spec.generation.reasoning ?? 'off', (v) => prompt.setReasoning(String(v) as ReasoningSetting))
    label.appendChild(select)
    const hint = document.createElement('span')
    hint.className = 'param-hint'
    hint.textContent = supported === false
      ? (info.reasoning.note ?? 'Not a reasoning model.')
      : `${info.reasoning.mandatory ? 'Always on for this model. ' : ''}${info.reasoning.note ?? ''}`.trim()
    label.appendChild(hint)
    grid.appendChild(label)
    wrap.appendChild(grid)
    return wrap
  }

  private knob(d: ParamDescriptor): HTMLElement {
    const label = document.createElement('label')
    label.className = 'param'
    label.title = d.help
    const name = document.createElement('span')
    name.className = 'lbl'
    name.textContent = d.label
    label.appendChild(name)

    if (d.kind === 'boolean') {
      const input = document.createElement('input')
      input.type = 'checkbox'
      DiamondCore.bind(input, 'checked', () => prompt.paramValue(d.key) === true, (v) => prompt.setParam(d.key, Boolean(v)))
      label.appendChild(input)
    } else if (d.kind === 'enum') {
      const select = document.createElement('select')
      const blank = document.createElement('option')
      blank.value = ''
      blank.textContent = d.default !== undefined ? `backend default (${String(d.default)})` : 'backend default'
      select.appendChild(blank)
      for (const opt of d.options ?? []) {
        const o = document.createElement('option')
        o.value = opt
        o.textContent = opt
        select.appendChild(o)
      }
      DiamondCore.bind(select, 'value', () => String(prompt.paramValue(d.key) ?? ''), (v) => prompt.setParam(d.key, coerceParam(d, v)))
      label.appendChild(select)
    } else {
      const row = document.createElement('div')
      row.className = 'param-row'
      const input = document.createElement('input')
      input.type = d.kind === 'text' ? 'text' : 'number'
      if (d.kind !== 'text') {
        if (d.min !== undefined) input.min = String(d.min)
        if (d.max !== undefined) input.max = String(d.max)
        input.step = d.kind === 'integer' ? '1' : 'any'
      }
      input.placeholder = d.default !== undefined ? `default ${String(d.default)}` : 'backend default'
      DiamondCore.bind(
        input,
        'value',
        () => {
          const v = prompt.paramValue(d.key)
          return v === undefined || v === null ? '' : String(v)
        },
        (v) => prompt.setParam(d.key, coerceParam(d, v)),
        'change',
      )
      row.appendChild(input)
      if (d.key !== 'temperature') {
        const clear = document.createElement('button')
        clear.type = 'button'
        clear.className = 'btn btn-ghost btn-xs'
        clear.textContent = '×'
        clear.title = tip('prompt.model.knob_clear')
        DiamondCore.on(clear, 'click', () => prompt.setParam(d.key, null))
        DiamondCore.bind(clear, 'hidden', () => prompt.paramValue(d.key) === undefined)
        row.appendChild(clear)
      }
      label.appendChild(row)
    }
    const hint = document.createElement('span')
    hint.className = 'param-hint'
    const parts: string[] = []
    if (d.default !== undefined && d.key !== 'temperature') parts.push(`model default ${String(d.default)}`)
    if (d.min !== undefined && d.max !== undefined) parts.push(`${d.min}–${d.max}`)
    parts.push(d.source === 'backend' ? 'reported by backend' : 'curated for this dialect')
    hint.textContent = parts.join(' · ')
    label.appendChild(hint)
    return label
  }
}
