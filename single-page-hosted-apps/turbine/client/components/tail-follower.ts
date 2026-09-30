/**
 * TailFollower — "follow the stream while I'm at the bottom" scrolling.
 *
 * While the user is within a few pixels of the bottom of a scrolling element,
 * every content change keeps it pinned to the newest text. Scrolling up
 * releases the pin; scrolling back to the bottom re-engages it.
 */
export class TailFollower {
  private el: HTMLElement | null = null
  private following = true
  private raf = 0
  private readonly slack: number

  constructor(slackPx = 32) {
    this.slack = slackPx
  }

  private readonly onScroll = (): void => {
    const el = this.el
    if (!el) return
    this.following = el.scrollHeight - el.scrollTop - el.clientHeight <= this.slack
  }

  /** Attach to `el` (re-attaching if the element changed). */
  follow(el: HTMLElement | null): void {
    if (el === this.el) return
    this.detach()
    if (!el) return
    this.el = el
    this.following = true
    el.addEventListener('scroll', this.onScroll, { passive: true })
  }

  /** Re-engage following (call when a new stream starts). */
  reset(): void {
    this.following = true
    this.stick()
  }

  /** Call after content changed; scrolls on the next frame if the user is at the tail. */
  stick(): void {
    if (!this.el || !this.following) return
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(() => {
      const el = this.el
      if (el && this.following) el.scrollTop = el.scrollHeight
    })
  }

  get isFollowing(): boolean {
    return this.following
  }

  detach(): void {
    cancelAnimationFrame(this.raf)
    this.el?.removeEventListener('scroll', this.onScroll)
    this.el = null
  }
}
