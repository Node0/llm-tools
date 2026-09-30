/**
 * shared/engine/template.ts — mustache-lite prompt templating.
 *
 *   {{name}}                 substitution (whitespace inside the braces is fine)
 *   {{#name}} … {{/name}}    render the block only when `name` is non-empty
 *   {{^name}} … {{/name}}    render the block only when `name` IS empty
 *
 * No logic beyond that, on purpose: the instructions are the user's; Turbine
 * only splices the window into them.
 */

export const TEMPLATE_VARS = [
  'context_before',
  'focus',
  'context_after',
  'carry',
  'window_index',
  'window_count',
  'source_name',
] as const

export type TemplateVar = (typeof TEMPLATE_VARS)[number]
export type TemplateVars = Record<TemplateVar, string | number> & Record<string, string | number>

const SECTION = /\{\{\s*([#^])\s*([\w.-]+)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\2\s*\}\}/g
const VAR = /\{\{\s*([\w.-]+)\s*\}\}/g

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || v === 0 || v === false
}

export function renderTemplate(template: string, vars: Partial<TemplateVars>): string {
  const scope = vars as Record<string, unknown>
  // Sections first (recursively, so nesting works), then plain substitution.
  const withSections = template.replace(SECTION, (_m, kind: string, name: string, body: string) => {
    const present = !isEmpty(scope[name])
    const show = kind === '#' ? present : !present
    return show ? renderTemplate(body, vars) : ''
  })
  return withSections.replace(VAR, (m, name: string) => {
    const v = scope[name]
    return v === undefined ? m : String(v)
  })
}

/** Every variable name the template references, in first-use order. */
export function templateVariables(template: string): string[] {
  const seen = new Set<string>()
  for (const m of template.matchAll(/\{\{\s*[#^/]?\s*([\w.-]+)\s*\}\}/g)) seen.add(m[1])
  return [...seen]
}

/** Names the template uses that Turbine will not supply. Surface these in the UI. */
export function unknownTemplateVariables(template: string): string[] {
  const known = new Set<string>(TEMPLATE_VARS)
  return templateVariables(template).filter((v) => !known.has(v))
}

export const DEFAULT_SYSTEM_PROMPT = `You are a careful copy editor converting a plain-text book into clean Markdown.

Rules:
- Preserve the author's words exactly. Do not paraphrase, summarize, modernize, or "improve" the prose.
- Turn chapter and section titles into Markdown headings.
- Rejoin lines that were hard-wrapped mid-sentence into single paragraphs.
- Keep verse, tables, and lists structured; use Markdown tables for column-aligned data.
- Keep existing _italics_ and footnote markers.
- Output only the transformed text. No preamble, no commentary, no code fences.`

export const DEFAULT_USER_TEMPLATE = `You are transforming ONE section ("focus") of a longer document: {{source_name}}, window {{window_index}} of {{window_count}}.
The surrounding text is provided only for context. Do not repeat it and do not transform it.
{{#carry}}

The tail of the previous window's OUTPUT, so you can continue consistently:
<previous_output_tail>
{{carry}}
</previous_output_tail>
{{/carry}}
{{#context_before}}

<context_before>
{{context_before}}
</context_before>
{{/context_before}}

<focus>
{{focus}}
</focus>
{{#context_after}}

<context_after>
{{context_after}}
</context_after>
{{/context_after}}

Return only the transformed focus text.`
