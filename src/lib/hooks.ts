import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import { ApiError, asApiError, isAbort } from './http'

export interface FetchState<T> {
  data: T | null
  error: ApiError | null
  loading: boolean
  reload: () => void
  setData: (update: (current: T | null) => T | null) => void
}

/**
 * Carga datos cancelando la request anterior cuando cambian las dependencias:
 * una respuesta vieja nunca pisa a una nueva. Mientras carga conserva los datos previos.
 */
export function useFetch<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: DependencyList): FetchState<T> {
  const [data, setDataState] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const latest = useRef(fetcher)

  useEffect(() => {
    latest.current = fetcher
  })

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    latest.current(controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        setDataState(result)
        setLoading(false)
      },
      (e: unknown) => {
        if (controller.signal.aborted || isAbort(e)) return
        setError(asApiError(e))
        setLoading(false)
      },
    )
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const setData = useCallback((update: (current: T | null) => T | null) => setDataState(update), [])
  return { data, error, loading, reload, setData }
}

export function intParam(value: string | null, min: number, fallback: number): number {
  if (value === null || !/^\d{1,9}$/.test(value)) return fallback
  const n = Number(value)
  return n >= min ? n : fallback
}

export function enumParam<T extends string | number>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => String(a) === value) ?? fallback
}

/** Solo rutas internas: evita redirecciones a otros sitios desde `?next=`. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/files'
}

export function fieldErrors(e: ApiError | null): Record<string, string> {
  if (!e) return {}
  const details = e.details as { fields?: Record<string, string>; field?: string } | null
  if (details?.fields) return details.fields
  if (details?.field) return { [details.field]: e.message }
  return {}
}
