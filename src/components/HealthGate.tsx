import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { backoff, rawFetch } from '../lib/http'

/** Bloquea la app hasta que /meta/health responda, reintentando con espera creciente. */
export function HealthGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [failedOnce, setFailedOnce] = useState(false)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const check = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    try {
      const res = await rawFetch('/meta/health', { signal: AbortSignal.timeout(20000) })
      if (res.ok) {
        setReady(true)
        return
      }
    } catch {
      // Se trata igual que una respuesta fallida.
    }
    setFailedOnce(true)
    timer.current = setTimeout(() => void check(), backoff(attempt.current++, 30000))
  }, [])

  useEffect(() => {
    void check()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [check])

  if (ready) return children
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div role="status" className="card text-center space-y-3">
        <h1 className="text-xl font-semibold">Conectando con Lumon…</h1>
        {failedOnce && (
          <button type="button" className="btn" onClick={() => void check()}>
            Reintentar ahora
          </button>
        )}
      </div>
    </main>
  )
}
