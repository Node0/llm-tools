/**
 * client/services/fingerprint.ts — a multi-signal browser fingerprint, hashed.
 *
 * Used ONLY as a loose "is this the same browser?" hint. It is never key
 * material and never decides first-visit on its own (browser updates change it).
 * Every signal is individually guarded; this function never throws.
 */

let cached: Promise<string> | null = null

async function digest(input: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  // Plain-http LAN origins have no SubtleCrypto: FNV-1a 64-bit as a non-cryptographic fallback.
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0
  }
  return 'fnv-' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function canvasSignal(): string {
  const c = document.createElement('canvas')
  c.width = 220
  c.height = 40
  const ctx = c.getContext('2d')
  if (!ctx) return 'no-2d'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#f60'
  ctx.fillRect(10, 5, 60, 20)
  ctx.fillStyle = '#069'
  ctx.font = '14px "Times New Roman"'
  ctx.fillText('Turbine ✓ 🌀 fingerprint', 4, 24)
  ctx.strokeStyle = 'rgba(102, 204, 0, 0.7)'
  ctx.beginPath()
  ctx.arc(180, 20, 12, 0, Math.PI * 1.5)
  ctx.stroke()
  return c.toDataURL()
}

function webglSignal(): string {
  const c = document.createElement('canvas')
  const gl = (c.getContext('webgl') ?? c.getContext('experimental-webgl')) as WebGLRenderingContext | null
  if (!gl) return 'no-webgl'
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)
  const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  return `${String(vendor)}|${String(renderer)}`
}

export function computeFingerprint(): Promise<string> {
  if (cached) return cached
  cached = (async () => {
    const n = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } }
    const signals = [
      safe(() => n.userAgent, ''),
      safe(() => (n.languages ?? [n.language]).join(','), ''),
      safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone, ''),
      safe(() => `${screen.width}x${screen.height}x${screen.colorDepth}@${devicePixelRatio}`, ''),
      safe(() => String(n.hardwareConcurrency ?? ''), ''),
      safe(() => String(n.deviceMemory ?? ''), ''),
      safe(() => String(n.maxTouchPoints ?? ''), ''),
      safe(() => n.userAgentData?.platform ?? n.platform ?? '', ''),
      safe(canvasSignal, 'canvas-err'),
      safe(webglSignal, 'webgl-err'),
    ]
    try {
      return await digest(signals.join('\u001f'))
    } catch {
      return 'unavailable'
    }
  })()
  return cached
}
