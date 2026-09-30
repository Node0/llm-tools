#!/usr/bin/env bun
/**
 * fetch_corpus.ts — build the 3×3 embeddings-profiler corpus.
 *
 * Tiers × genres:  {250, 500, 1000 pages} × {neuroscience, adjacent science, literary control}
 * A "page" is 275 words. Every title is US public domain (published before 1931).
 *
 * Stage 0: download (Project Gutenberg plain text, or psychclassics HTML for Pavlov)
 * Stage 1: deterministic normalization to markdown (no LLM):
 *          strip PG boilerplate, unwrap hard-wrapped paragraphs, promote headings,
 *          keep verse/tables/indented blocks line-broken. PG's _italics_ are already markdown.
 * Stage 2: (not here) Turbine "conserve" pass for whatever Stage 1 leaves messy.
 *
 * Usage:
 *   bun run fetch_corpus.ts                 # everything → ./corpus
 *   bun run fetch_corpus.ts --out ~/corpus  # custom output dir
 *   bun run fetch_corpus.ts --only pavlov-conditioned-reflexes,middlemarch
 *
 * Output per book:  <out>/<tier>/<slug>.raw.txt   (untouched source text)
 *                   <out>/<tier>/<slug>.md        (Stage 1 markdown)
 * Plus <out>/manifest.json with word counts, token estimates, page estimates and tier fit.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Corpus definition ───────────────────────────────────────────────────────

export const WORDS_PER_PAGE = 275;

type Tier = "p250" | "p500" | "p1000";
type Genre = "neuroscience" | "adjacent-science" | "literary-control";

interface Book {
  slug: string;
  title: string;
  author: string;
  year: number;
  tier: Tier;
  genre: Genre;
  source: { kind: "gutenberg"; id: number } | { kind: "psychclassics-pavlov" };
  notes?: string;
}

export const TIER_RANGES: Record<Tier, [number, number]> = {
  p250: [55_000, 95_000],   // nominal  68,750 words
  p500: [115_000, 175_000], // nominal 137,500 words
  p1000: [240_000, 340_000], // nominal 275,000 words
};

export const BOOKS: Book[] = [
  // ~250 pages
  { slug: "mosso-fear", title: "Fear", author: "Angelo Mosso", year: 1896,
    tier: "p250", genre: "neuroscience", source: { kind: "gutenberg", id: 59901 },
    notes: "Physiology of emotion; Kiesow & Lough translation" },
  { slug: "james-talks-to-teachers", title: "Talks to Teachers on Psychology", author: "William James", year: 1899,
    tier: "p250", genre: "adjacent-science", source: { kind: "gutenberg", id: 16287 } },
  { slug: "shelley-frankenstein-1818", title: "Frankenstein (1818 text)", author: "Mary Shelley", year: 1818,
    tier: "p250", genre: "literary-control", source: { kind: "gutenberg", id: 41445 } },

  // ~500 pages
  { slug: "pavlov-conditioned-reflexes", title: "Conditioned Reflexes", author: "Ivan Pavlov (tr. G. V. Anrep)", year: 1927,
    tier: "p500", genre: "neuroscience", source: { kind: "psychclassics-pavlov" },
    notes: "HTML lectures with tables; completeness of all 23 lectures unverified — check the report" },
  { slug: "darwin-origin-1st-ed", title: "On the Origin of Species (1st ed.)", author: "Charles Darwin", year: 1859,
    tier: "p500", genre: "adjacent-science", source: { kind: "gutenberg", id: 1228 } },
  { slug: "stoker-dracula", title: "Dracula", author: "Bram Stoker", year: 1897,
    tier: "p500", genre: "literary-control", source: { kind: "gutenberg", id: 345 } },

  // ~1000 pages
  { slug: "james-principles-vol1", title: "The Principles of Psychology, Vol. 1", author: "William James", year: 1890,
    tier: "p1000", genre: "neuroscience", source: { kind: "gutenberg", id: 57628 },
    notes: "Ch. 2–3 are the brain-function / neurophysiology chapters; has figures" },
  { slug: "darwin-descent-2nd-ed", title: "The Descent of Man (2nd ed.)", author: "Charles Darwin", year: 1874,
    tier: "p1000", genre: "adjacent-science", source: { kind: "gutenberg", id: 2300 } },
  { slug: "eliot-middlemarch", title: "Middlemarch", author: "George Eliot", year: 1872,
    tier: "p1000", genre: "literary-control", source: { kind: "gutenberg", id: 145 } },
];

// ─── Fetching ────────────────────────────────────────────────────────────────

const UA = "fetch_corpus.ts (embeddings-profiler corpus builder)";

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

async function fetchGutenberg(id: number): Promise<string> {
  // The cache path serves UTF-8 plain text; fall back to the files path.
  const urls = [
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
    `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
  ];
  let lastErr: unknown;
  for (const u of urls) {
    try { return await getText(u); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

interface PavlovResult { text: string; warnings: string[] }

async function fetchPavlov(): Promise<PavlovResult> {
  const warnings: string[] = [];
  const parts: string[] = [];
  const lectureWords: number[] = [];
  for (let n = 1; n <= 23; n++) {
    const url = `https://psychclassics.yorku.ca/Pavlov/lecture${n}.htm`;
    try {
      const html = await getText(url);
      const md = htmlToMarkdown(html);
      parts.push(`# Lecture ${n}\n\n${md}`);
      lectureWords.push(countWords(md));
    } catch (e) {
      warnings.push(`lecture ${n}: ${(e as Error).message}`);
      lectureWords.push(0);
    }
    await Bun.sleep(400); // be polite to a small academic server
  }
  // Flag lectures far shorter than the median — likely truncated on the source site.
  const sorted = lectureWords.filter(Boolean).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  lectureWords.forEach((w, i) => {
    if (w > 0 && w < median * 0.4) warnings.push(`lecture ${i + 1}: only ${w} words (median ${median}) — possibly truncated`);
  });
  return { text: parts.join("\n\n"), warnings };
}

// ─── Stage 1 normalization ───────────────────────────────────────────────────

const PG_START = /\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG E(?:BOOK|TEXT)[^*]*\*{3}/i;
const PG_END = /\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG E(?:BOOK|TEXT)[^*]*\*{3}/i;

export function stripGutenbergBoilerplate(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const s = text.match(PG_START);
  if (s?.index !== undefined) text = text.slice(s.index + s[0].length);
  const e = text.match(PG_END);
  if (e?.index !== undefined) text = text.slice(0, e.index);
  // Transcriber / producer credits that sit right after the START marker.
  text = text.replace(/^\s*(Produced by|E-text prepared by|Transcribed from)[^\n]*(\n[^\n]+)*\n/i, "");
  return text.trim();
}

const HEADING_WORD = /^(CHAPTER|LECTURE|BOOK|PART|VOLUME|LETTER|PREFACE|INTRODUCTION|CONTENTS|APPENDIX|INDEX|PRELUDE|FINALE|CONCLUSION|RECAPITULATION|GLOSSARY)\b/i;
const ROMAN_ONLY = /^[IVXLCDM]+\.?$/;

function isAllCapsLine(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length > 0.85;
}

function isHeadingBlock(lines: string[]): boolean {
  if (lines.length > 2) return false;
  const joined = lines.map((l) => l.trim()).join(" ");
  if (joined.length > 90) return false;
  return HEADING_WORD.test(joined) || ROMAN_ONLY.test(joined) || isAllCapsLine(joined);
}

/** Verse, tables, tables of contents, letters' address blocks: keep line breaks. */
function isPreformattedBlock(lines: string[]): boolean {
  if (lines.length < 2) return false;
  const indented = lines.filter((l) => /^\s{2,}\S/.test(l)).length;
  const short = lines.filter((l) => l.trim().length < 45).length;
  const tabular = lines.filter((l) => /\S\s{3,}\S/.test(l.trim())).length;
  return indented / lines.length > 0.6 || tabular / lines.length > 0.5 || (short / lines.length > 0.75 && lines.length >= 3);
}

export function normalizeToMarkdown(text: string, title?: string): string {
  const blocks = text.split(/\n[ \t]*\n+/).map((b) => b.split("\n")).filter((b) => b.some((l) => l.trim()));
  const out: string[] = [];
  if (title) out.push(`# ${title}`);

  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i];
    if (isHeadingBlock(lines)) {
      let heading = lines.map((l) => l.trim()).join(" ");
      // "CHAPTER IV." followed by a short title block → merge into one heading.
      const next = blocks[i + 1];
      if ((HEADING_WORD.test(heading) || ROMAN_ONLY.test(heading)) && next && next.length <= 2 &&
          next.join(" ").trim().length < 80 && !/[.!?]["”’]?$/.test(next.join(" ").trim().replace(/\.$/, "")) ) {
        const nextText = next.map((l) => l.trim()).join(" ");
        if (isAllCapsLine(nextText) || nextText.length < 60) { heading = `${heading} ${nextText}`; i++; }
      }
      out.push(`## ${heading.replace(/\s+/g, " ")}`);
    } else if (isPreformattedBlock(lines)) {
      const tabular = lines.filter((l) => /\S\s{3,}\S/.test(l.trim())).length / lines.length > 0.5;
      out.push(tabular
        ? "```text\n" + lines.map((l) => l.replace(/\s+$/, "")).join("\n") + "\n```" // column-aligned: keep exact spacing
        : lines.map((l) => l.trim()).join("  \n"));                                  // verse/addresses: hard line breaks
    } else {
      out.push(lines.map((l) => l.trim()).join(" ").replace(/\s{2,}/g, " "));
    }
  }
  return out.join("\n\n") + "\n";
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", deg: "°", times: "×", eacute: "é",
};

export function htmlToMarkdown(html: string): string {
  let s = html.replace(/\r\n?/g, "\n");
  s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "");
  // Tables → markdown tables. Rows are joined with \u0001 so paragraph collapsing below leaves them intact.
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, body: string) => {
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()));
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => "| " + Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ") + " |";
    return "\n\n" + [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\u0001") + "\n\n";
  });
  s = s.replace(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, (_, t) => `\n\n## ${t.replace(/<[^>]+>/g, "").trim()}\n\n`);
  s = s.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, t) => `\n\n### ${t.replace(/<[^>]+>/g, "").trim()}\n\n`);
  s = s.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, "_$2_").replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<sup>\s*(\d+)\s*<\/sup>/gi, "[^$1]");
  s = s.replace(/<\/(p|div|blockquote|table|ul|ol)>|<br\s*\/?>/gi, "\n\n");
  s = s.replace(/<li[^>]*>/gi, "\n\n- ");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s.split(/\n[ \t]*\n+/).map((b) => b.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean).join("\n\n").replace(/\u0001/g, "\n");
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export function countWords(s: string): number {
  return (s.match(/\S+/g) ?? []).length;
}

/** Rough English estimate (~4 chars/token). Replace with the profiler's real tokenizer later. */
export function estimateTokens(s: string): number {
  return Math.round(s.length / 4);
}

function tierFit(tier: Tier, words: number): "in-range" | "short" | "long" {
  const [lo, hi] = TIER_RANGES[tier];
  return words < lo ? "short" : words > hi ? "long" : "in-range";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : "./corpus";
  const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
  const books = only ? BOOKS.filter((b) => only.has(b.slug)) : BOOKS;

  const manifest: Record<string, unknown>[] = [];
  for (const book of books) {
    const dir = join(outDir, book.tier);
    await mkdir(dir, { recursive: true });
    process.stdout.write(`→ ${book.slug} … `);
    try {
      let raw: string, body: string, md: string, warnings: string[] = [];
      if (book.source.kind === "gutenberg") {
        raw = await fetchGutenberg(book.source.id);
        body = stripGutenbergBoilerplate(raw);
        md = normalizeToMarkdown(body, `${book.title} — ${book.author} (${book.year})`);
      } else {
        const p = await fetchPavlov();
        raw = p.text; warnings = p.warnings;
        md = `# ${book.title} — ${book.author} (${book.year})\n\n${p.text}\n`;
      }
      await writeFile(join(dir, `${book.slug}.raw.txt`), raw);
      await writeFile(join(dir, `${book.slug}.md`), md);

      const words = countWords(md);
      const entry = {
        ...book, words, est_tokens: estimateTokens(md),
        est_pages: Math.round(words / WORDS_PER_PAGE), tier_fit: tierFit(book.tier, words),
        md_path: join(dir, `${book.slug}.md`), warnings,
      };
      manifest.push(entry);
      console.log(`${words.toLocaleString()} words ≈ ${entry.est_pages} pp [${entry.tier_fit}]${warnings.length ? `  ⚠ ${warnings.length} warning(s)` : ""}`);
      warnings.forEach((w) => console.log(`    ⚠ ${w}`));
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message}`);
      manifest.push({ ...book, error: (e as Error).message });
    }
    await Bun.sleep(1000); // Gutenberg asks for gentle automated access
  }
  await writeFile(join(outDir, "manifest.json"), JSON.stringify({ words_per_page: WORDS_PER_PAGE, tier_ranges: TIER_RANGES, books: manifest }, null, 2));
  console.log(`\nManifest → ${join(outDir, "manifest.json")}`);
}

if (import.meta.main) await main();
