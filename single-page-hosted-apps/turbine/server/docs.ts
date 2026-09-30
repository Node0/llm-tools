/**
 * server/docs.ts — uploaded source documents.
 *
 * Text lives at <data_dir>/docs/<id>.txt, metadata + owner at <id>.json.
 * Metadata is loaded at boot; text is read lazily and cached. A session only
 * ever sees its own documents.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DocInfo } from '../shared/api.ts'
import { countWords, estimatePages, estimateTokens, paragraphOffsets } from '../shared/engine/index.ts'
import type { TurbineConfig } from './config.ts'
import { HttpError, notFound } from './errors.ts'
import { log } from './log.ts'

interface DocRecord {
  owner: string
  info: DocInfo
}

const ID_RE = /^[0-9a-f]{24}$/

export function sanitizeName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'document'
  const clean = base.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200)
  return clean || 'document.txt'
}

export function normalizeText(raw: string): string {
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

export class DocStore {
  private readonly dir: string
  private readonly docs = new Map<string, DocRecord>()
  private readonly texts = new Map<string, string>()

  constructor(private readonly config: TurbineConfig) {
    this.dir = join(config.server.data_dir, 'docs')
    mkdirSync(this.dir, { recursive: true })
    let n = 0
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const rec = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as DocRecord
        if (rec?.info?.id && ID_RE.test(rec.info.id) && existsSync(join(this.dir, `${rec.info.id}.txt`))) {
          this.docs.set(rec.info.id, rec)
          n++
        }
      } catch (e) {
        log('WARNING', `doc meta ${f} unreadable: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (n) log('STATE', `restored ${n} document(s) from ${this.dir}`)
  }

  create(owner: string, name: string, rawText: string): DocInfo {
    const text = normalizeText(rawText)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.config.limits.max_upload_bytes) {
      throw new HttpError(413, `document is ${bytes} bytes; limit is ${this.config.limits.max_upload_bytes}`, 'too-large')
    }
    if (!text.trim()) throw new HttpError(400, 'document is empty', 'empty')
    const id = randomBytes(12).toString('hex')
    const info: DocInfo = {
      id,
      name: sanitizeName(name),
      bytes,
      chars: text.length,
      words: countWords(text),
      est_tokens: estimateTokens(text),
      est_pages: estimatePages(text),
      paragraphs: paragraphOffsets(text).length,
      created_at: new Date().toISOString(),
    }
    const rec: DocRecord = { owner, info }
    const txt = join(this.dir, `${id}.txt`)
    writeFileSync(`${txt}.tmp`, text)
    renameSync(`${txt}.tmp`, txt)
    const meta = join(this.dir, `${id}.json`)
    writeFileSync(`${meta}.tmp`, JSON.stringify(rec))
    renameSync(`${meta}.tmp`, meta)
    this.docs.set(id, rec)
    this.texts.set(id, text)
    return info
  }

  list(owner: string): DocInfo[] {
    return [...this.docs.values()].filter((d) => d.owner === owner).map((d) => d.info).sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  /** 404 for unknown OR not-owned — existence is not disclosed across sessions. */
  get(owner: string, id: string): DocInfo {
    const rec = ID_RE.test(id) ? this.docs.get(id) : undefined
    if (!rec || rec.owner !== owner) throw notFound(`document ${id} not found`)
    return rec.info
  }

  text(owner: string, id: string): string {
    this.get(owner, id)
    return this.textUnchecked(id)
  }

  /** For the job manager, which already verified ownership at job creation. */
  textUnchecked(id: string): string {
    const cached = this.texts.get(id)
    if (cached !== undefined) return cached
    const file = join(this.dir, `${id}.txt`)
    if (!existsSync(file)) throw notFound(`document ${id} text is missing on disk`)
    const t = readFileSync(file, 'utf8')
    this.texts.set(id, t)
    return t
  }

  slice(owner: string, id: string, start: number, end: number): { start: number; end: number; text: string } {
    const t = this.text(owner, id)
    const s = Math.max(0, Math.min(Number.isFinite(start) ? Math.floor(start) : 0, t.length))
    const e = Math.max(s, Math.min(Number.isFinite(end) ? Math.floor(end) : t.length, t.length))
    return { start: s, end: e, text: t.slice(s, e) }
  }

  delete(owner: string, id: string): void {
    this.get(owner, id)
    this.docs.delete(id)
    this.texts.delete(id)
    rmSync(join(this.dir, `${id}.txt`), { force: true })
    rmSync(join(this.dir, `${id}.json`), { force: true })
  }
}
