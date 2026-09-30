/** Tiny body helpers — routes validate by hand so empty bodies and text/plain uploads behave. */

export type Obj = Record<string, unknown>

export function asObject(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
}

export function optString(v: unknown, max = 100_000): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined
}

export function optInt(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? Math.floor(n) : undefined
}
