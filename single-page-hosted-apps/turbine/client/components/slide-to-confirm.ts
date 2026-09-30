/**
 * SlideToConfirm — a destructive action that cannot be tapped by accident.
 *
 * A red knob sits at the left of a channel. Dragging it (pointer or touch)
 * all the way to the right fires `onConfirm` once; letting go earlier snaps
 * it back. Keyboard users focus the knob and press End, or ArrowRight
 * repeatedly, to reach the end. Hand-written: the geometry-driven drag is
 * simpler against the DOM than through a compiled template.
 */
import { Component, DiamondCore } from '@diamondjs/runtime'

export interface SlideToConfirmOptions {
  label: string
  onConfirm: () => void
  /** Fraction of the channel the knob must cross (default 0.92). */
  threshold?: number
}

export class SlideToConfirm extends Component {
  private track: HTMLElement | null = null
  private knob: HTMLElement | null = null
  private progress = 0
  private dragging = false
  private startX = 0
  private startProgress = 0

  constructor(private readonly opts: SlideToConfirmOptions) {
    super()
  }

  override createTemplate(): HTMLElement {
    const track = document.createElement('div')
    track.className = 'slide-track'
    const fill = document.createElement('div')
    fill.className = 'slide-fill'
    const label = document.createElement('span')
    label.className = 'slide-label'
    label.textContent = this.opts.label
    const knob = document.createElement('button')
    knob.type = 'button'
    knob.className = 'slide-knob'
    knob.setAttribute('aria-label', `${this.opts.label} (drag to the right, or press End)`)
    knob.setAttribute('role', 'slider')
    knob.setAttribute('aria-valuemin', '0')
    knob.setAttribute('aria-valuemax', '100')
    knob.setAttribute('aria-valuenow', '0')
    knob.textContent = '›'
    track.append(fill, label, knob)
    this.track = track
    this.knob = knob

    const onDown = (e: Event): void => {
      const pe = e as PointerEvent
      if (pe.button !== undefined && pe.button !== 0) return
      this.dragging = true
      this.startX = pe.clientX
      this.startProgress = this.progress
      knob.setPointerCapture?.(pe.pointerId)
      track.classList.add('dragging')
    }
    const onMove = (e: Event): void => {
      if (!this.dragging) return
      const pe = e as PointerEvent
      const range = this.range()
      if (range <= 0) return
      this.setProgress(this.startProgress + (pe.clientX - this.startX) / range)
    }
    const onUp = (): void => {
      if (!this.dragging) return
      this.dragging = false
      track.classList.remove('dragging')
      if (this.progress >= (this.opts.threshold ?? 0.92)) this.fire()
      else this.setProgress(0, true)
    }
    const onKey = (e: Event): void => {
      const ke = e as KeyboardEvent
      if (ke.key === 'ArrowRight') {
        ke.preventDefault()
        this.setProgress(this.progress + 0.1)
        if (this.progress >= 0.999) this.fire()
      } else if (ke.key === 'ArrowLeft') {
        ke.preventDefault()
        this.setProgress(this.progress - 0.1)
      } else if (ke.key === 'End') {
        ke.preventDefault()
        this.setProgress(1)
        this.fire()
      } else if (ke.key === 'Home' || ke.key === 'Escape') {
        this.setProgress(0, true)
      }
    }
    DiamondCore.on(knob, 'pointerdown', onDown)
    DiamondCore.on(knob, 'pointermove', onMove)
    DiamondCore.on(knob, 'pointerup', onUp)
    DiamondCore.on(knob, 'pointercancel', onUp)
    DiamondCore.on(knob, 'keydown', onKey)
    return track
  }

  private range(): number {
    if (!this.track || !this.knob) return 0
    return this.track.clientWidth - this.knob.offsetWidth - 8
  }

  private setProgress(p: number, animate = false): void {
    this.progress = Math.max(0, Math.min(1, p))
    if (!this.knob || !this.track) return
    const px = Math.round(this.progress * this.range())
    this.knob.style.transition = animate ? 'transform 180ms ease-out' : 'none'
    this.knob.style.transform = `translateX(${px}px)`
    this.knob.setAttribute('aria-valuenow', String(Math.round(this.progress * 100)))
    const fill = this.track.querySelector<HTMLElement>('.slide-fill')
    if (fill) fill.style.width = `${px + (this.knob.offsetWidth / 2)}px`
    this.track.classList.toggle('armed', this.progress >= (this.opts.threshold ?? 0.92))
  }

  private fire(): void {
    this.setProgress(1)
    const done = (): void => {
      this.opts.onConfirm()
      this.setProgress(0, true)
    }
    // Let the knob visibly reach the end before the action lands.
    setTimeout(done, 120)
  }

  /** Reset the knob (e.g. when the confirmation banner is dismissed). */
  reset(): void {
    this.dragging = false
    this.setProgress(0, true)
  }
}
