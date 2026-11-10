import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router'
import { Field } from '../components/ui'
import { fieldErrors } from '../lib/hooks'
import { ApiError, asApiError } from '../lib/http'
import { register, useAuth } from '../lib/session'

export default function RegisterPage() {
  const { status } = useAuth()
  const [teamName, setTeamName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  if (status === 'authenticated') return <Navigate to="/files" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await register(teamName, email, password)
    } catch (err) {
      setError(asApiError(err))
    } finally {
      setBusy(false)
    }
  }

  const fields = fieldErrors(error)
  const general = error && !Object.keys(fields).length ? error.message : (fields._ ?? null)

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={(e) => void submit(e)} className="card w-full max-w-sm space-y-3">
        <h1 className="text-2xl font-semibold">Registrar la cuadrilla</h1>
        <Field id="teamName" label="Nombre del equipo" error={fields.teamName}>
          <input id="teamName" className="input" required minLength={3} maxLength={40} value={teamName} onChange={(e) => setTeamName(e.target.value)} />
        </Field>
        <Field id="email" label="Correo" error={fields.email}>
          <input id="email" className="input" type="email" autoComplete="username" required maxLength={120} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field id="password" label="Contraseña (mínimo 8 caracteres)" error={fields.password}>
          <input id="password" className="input" type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {general && <p role="alert" className="text-danger">{general}</p>}
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? 'Registrando…' : 'Registrar y entrar'}
        </button>
        <p className="text-sm">
          ¿Ya tienes cuenta? <Link to="/login">Entrar</Link>
        </p>
      </form>
    </main>
  )
}
