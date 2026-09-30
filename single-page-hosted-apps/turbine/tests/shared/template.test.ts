import { describe, expect, it } from 'bun:test'
import { DEFAULT_USER_TEMPLATE, renderTemplate, templateVariables, unknownTemplateVariables } from '../../shared/engine/template.ts'

describe('renderTemplate', () => {
  it('substitutes variables, tolerating whitespace inside braces', () => {
    expect(renderTemplate('a {{focus}} b {{ window_index }} c', { focus: 'X', window_index: 3 })).toBe('a X b 3 c')
  })
  it('leaves unknown variables intact so the user can see the typo', () => {
    expect(renderTemplate('{{nope}}', { focus: 'x' })).toBe('{{nope}}')
  })
  it('renders sections only when the variable is non-empty, and inverted sections when empty', () => {
    const t = '{{#carry}}[C:{{carry}}]{{/carry}}{{^carry}}[none]{{/carry}}'
    expect(renderTemplate(t, { carry: 'tail' })).toBe('[C:tail]')
    expect(renderTemplate(t, { carry: '' })).toBe('[none]')
  })
  it('handles nested sections', () => {
    const t = '{{#focus}}F{{#carry}}+C{{/carry}}{{/focus}}'
    expect(renderTemplate(t, { focus: 'x', carry: 'y' })).toBe('F+C')
    expect(renderTemplate(t, { focus: 'x', carry: '' })).toBe('F')
    expect(renderTemplate(t, { focus: '', carry: 'y' })).toBe('')
  })
  it('the default template omits empty context blocks entirely', () => {
    const out = renderTemplate(DEFAULT_USER_TEMPLATE, { context_before: '', focus: 'FOCUS', context_after: '', carry: '', window_index: 1, window_count: 1, source_name: 's' })
    expect(out).toContain('<focus>\nFOCUS\n</focus>')
    expect(out).not.toContain('<context_before>')
    expect(out).not.toContain('<context_after>')
    expect(out).not.toContain('previous_output_tail')
  })
})

describe('templateVariables', () => {
  it('lists variables in first-use order including section heads', () => {
    expect(templateVariables('{{#carry}}{{carry}}{{/carry}} {{focus}} {{focus}} {{bogus}}')).toEqual(['carry', 'focus', 'bogus'])
  })
  it('reports variables Turbine will not supply', () => {
    expect(unknownTemplateVariables(DEFAULT_USER_TEMPLATE)).toEqual([])
    expect(unknownTemplateVariables('{{focus}} {{style_guide}}')).toEqual(['style_guide'])
  })
})
