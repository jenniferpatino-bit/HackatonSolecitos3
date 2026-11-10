import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { hub, useContingencies } from '../lib/events'
import { asApiError } from '../lib/http'
import { api } from '../lib/session'

/** Modal que interrumpe en todas las pestañas y solo se cierra al confirmar. */
export function ContingencyHost() {
  const items = useContingencies()
  const current = items[0]
  const dialogRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = current !== undefined
  const currentId = current?.id

  useEffect(() => {
    if (!open) return
    const root = document.getElementById('root')
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root?.setAttribute('inert', '')
    buttonRef.current?.focus()
    return () => {
      root?.removeAttribute('inert')
      previous?.focus()
    }
  }, [open])

  useEffect(() => {
    setError(null)
    buttonRef.current?.focus()
  }, [currentId])

  if (!current) return null

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await api<void>(`/contingency/${current.id}/ack`, { method: 'POST', retries: 0 })
      hub.resolveContingency(current.id)
    } catch (e) {
      setError(`${asApiError(e).message} Vuelve a confirmar.`)
    } finally {
      setBusy(false)
    }
  }

  const trapFocus = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      buttonRef.current?.focus()
    }
    if (e.key === 'Escape') e.preventDefault()
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/90 p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="contingency-title"
        aria-describedby="contingency-message"
        onKeyDown={trapFocus}
        className="card max-w-md w-full space-y-3 text-fg"
      >
        <h2 id="contingency-title" className="text-xl font-semibold">
          Contingencia de horas extra
        </h2>
        <p id="contingency-message">{current.message}</p>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <button ref={buttonRef} type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirm()}>
          {busy ? 'Confirmando…' : 'Confirmar'}
        </button>
      </div>
    </div>,
    document.body,
  )
}
