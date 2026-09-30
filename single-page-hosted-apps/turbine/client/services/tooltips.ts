/**
 * client/services/tooltips.ts — plain-language hover help.
 *
 * The text lives in client/tooltips.json, keyed view → component → field, so
 * it can be revised without touching templates. Templates bind
 * `title.to-view="tip('prompt.window.focus_tokens')"`.
 */
import tips from '../tooltips.json'

type Tree = { [k: string]: string | Tree }

export function tip(path: string): string {
  let node: string | Tree | undefined = tips as Tree
  for (const part of path.split('.')) {
    if (!node || typeof node === 'string') return ''
    node = node[part]
  }
  return typeof node === 'string' ? node : ''
}
