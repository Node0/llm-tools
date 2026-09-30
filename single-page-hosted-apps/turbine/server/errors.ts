/**
 * server/errors.ts — one error class for every deliberate HTTP failure.
 *
 * Throw `new HttpError(404, 'job not found', 'not-found')` anywhere in a
 * handler; the global onError in index.ts turns it into `{ error, code }` with
 * the right status. Everything else that reaches onError is a 500.
 */

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code ?? defaultCode(status)
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400: return 'bad-request'
    case 401: return 'unauthorized'
    case 403: return 'forbidden'
    case 404: return 'not-found'
    case 409: return 'conflict'
    case 413: return 'too-large'
    case 503: return 'unavailable'
    default: return 'error'
  }
}

export const badRequest = (msg: string, code?: string): HttpError => new HttpError(400, msg, code)
export const unauthorized = (msg: string, code?: string): HttpError => new HttpError(401, msg, code)
export const forbidden = (msg: string, code?: string): HttpError => new HttpError(403, msg, code)
export const notFound = (msg: string, code?: string): HttpError => new HttpError(404, msg, code)
export const conflict = (msg: string, code?: string): HttpError => new HttpError(409, msg, code)
