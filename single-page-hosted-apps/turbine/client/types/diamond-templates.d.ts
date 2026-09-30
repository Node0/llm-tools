/**
 * Compiled DiamondJS templates. `import * as T from './x.diamond.html'` yields
 * a module whose createTemplate() is an instance method body — bind it as a
 * class field: `createTemplate = (T as unknown as TemplateModule<this>).createTemplate`.
 */
declare module '*.diamond.html' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createTemplate(this: any): HTMLElement
}
