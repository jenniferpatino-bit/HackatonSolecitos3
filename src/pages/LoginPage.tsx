import { useState, type FormEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { Field, Spinner } from '../components/ui'
import { fieldErrors, safeNext } from '../lib/hooks'
import { ApiError, asApiError } from '../lib/http'
import { login, useAuth } from '../lib/session'

export default function LoginPage() {
  const { status, notice } = useAuth()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  if (status === 'loading') return <Spinner label="Verificando tu sesión…" />
  if (status === 'authenticated') return <Navigate to={next} replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await login(email, password)
    } catch (err) {
      setError(asApiError(err))
    } finally {
      setBusy(false)
    }
  }

  const fields = fieldErrors(error)
  const general = error && !Object.keys(fields).length ? (error.code === 'INVALID_CREDENTIALS' ? 'Correo o contraseña incorrectos.' : error.message) : null

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={(e) => void submit(e)} className="card w-full max-w-sm space-y-3">
        <h1 className="text-2xl font-semibold">Entrar al piso</h1>
        {notice && <p role="alert" className="text-warn">{notice}</p>}
        <Field id="email" label="Correo" error={fields.email}>
          <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field id="password" label="Contraseña" error={fields.password}>
          <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {general && <p role="alert" className="text-danger">{general}</p>}
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
        <p className="text-sm">
          ¿Sin cuadrilla? <Link to="/register">Registrarla</Link>
        </p>
      </form>
    </main>
  )
}
