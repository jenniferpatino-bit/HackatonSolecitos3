declare const __LUMON_BUILD__: string

export const BUILD = __LUMON_BUILD__

export const env = {
  apiBase: String(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, ''),
  wsBase: String(import.meta.env.VITE_WS_BASE_URL ?? '').replace(/\/$/, ''),
  storageProvider: String(import.meta.env.VITE_STORAGE_PROVIDER ?? ''),
  supabaseUrl: String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, ''),
  supabaseKey: String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? ''),
  supabaseBucket: String(import.meta.env.VITE_SUPABASE_BUCKET ?? ''),
  cloudName: String(import.meta.env.VITE_CLOUDINARY_CLOUD_NAME ?? ''),
  uploadPreset: String(import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET ?? ''),
}

export class ApiError extends Error {
  status: number
  code: string
  details: unknown
  retryAfterMs: number | null
  etag: string | null

  constructor(status: number, code: string, message: string, details: unknown = null, retryAfterMs: number | null = null, etag: string | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    this.retryAfterMs = retryAfterMs
    this.etag = etag
  }
}

export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError'

export function asApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e
  return new ApiError(0, 'NETWORK', 'No se pudo conectar con Lumon. Revisa la red e inténtalo de nuevo.')
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Espera creciente con jitter: 500 ms, 1 s, 2 s... hasta `cap`. */
export function backoff(attempt: number, cap = 16000): number {
  const base = Math.min(cap, 500 * 2 ** attempt)
  return base / 2 + Math.random() * (base / 2)
}

/** fetch con la URL base y X-Lumon-Build, presente en todas las requests de la app. */
export function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-Lumon-Build', BUILD)
  return fetch(env.apiBase + path, { ...init, headers, cache: 'no-store' })
}

export async function toApiError(res: Response): Promise<ApiError> {
  const header = res.headers.get('Retry-After')
  const seconds = header === null ? NaN : Number(header)
  const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : null
  let code = `HTTP_${res.status}`
  let message = `La API respondió ${res.status}.`
  let details: unknown = null
  try {
    const body = (await res.json()) as { error?: string; message?: string; details?: unknown }
    code = body.error ?? code
    message = body.message ?? message
    details = body.details ?? null
  } catch {
    // Cuerpo no JSON: se queda el código HTTP.
  }
  return new ApiError(res.status, code, message, details, retryAfterMs, res.headers.get('ETag'))
}
