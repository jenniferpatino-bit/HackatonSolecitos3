import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { ApiError } from '../lib/http'

export function Spinner({ label }: { label: string }) {
  return (
    <p role="status" className="p-6 text-dim">
      {label}
    </p>
  )
}

export function ErrorNote({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const locked = error.code === 'CLEARANCE_REQUIRED'
  return (
    <div role="alert" className="card border-danger space-y-2">
      <p className="text-danger">{locked ? 'El Piso de Pruebas sigue cerrado para tu equipo.' : error.message}</p>
      {locked && <Link to="/estado">Ir a /estado para abrirlo</Link>}
      {onRetry && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  )
}

export function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm mb-1">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  )
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 mt-1 rounded bg-ink overflow-hidden">
      <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
    </div>
  )
}

export function Pagination({
  page,
  totalPages,
  size,
  onPage,
  onSize,
}: {
  page: number
  totalPages: number
  size: number
  onPage: (page: number) => void
  onSize: (size: number) => void
}) {
  return (
    <nav aria-label="Paginación" className="flex flex-wrap items-center gap-3">
      <button type="button" className="btn btn-small" disabled={page <= 0} onClick={() => onPage(page - 1)}>
        Anterior
      </button>
      <span className="text-sm">
        Página {totalPages === 0 ? 0 : page + 1} de {totalPages}
      </span>
      <button type="button" className="btn btn-small" disabled={page + 1 >= totalPages} onClick={() => onPage(page + 1)}>
        Siguiente
      </button>
      <label className="text-sm flex items-center gap-2">
        Por página
        <select className="input w-20" value={size} onChange={(e) => onSize(Number(e.target.value))}>
          {[10, 25, 50].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
    </nav>
  )
}

/** Campo de búsqueda: escribe en la URL 300 ms después de la última tecla. */
export function SearchBox({ id, label, value, onCommit }: { id: string; label: string; value: string; onCommit: (value: string) => void }) {
  const [text, setText] = useState(value)
  const commit = useRef(onCommit)
  commit.current = onCommit

  useEffect(() => setText(value), [value])

  useEffect(() => {
    if (text === value) return
    const t = setTimeout(() => commit.current(text), 300)
    return () => clearTimeout(t)
  }, [text, value])

  return (
    <Field id={id} label={label}>
      <input id={id} type="search" className="input" maxLength={60} value={text} onChange={(e) => setText(e.target.value)} />
    </Field>
  )
}
