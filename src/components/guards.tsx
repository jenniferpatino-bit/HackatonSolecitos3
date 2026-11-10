import type { ReactElement } from 'react'
import { Link, Navigate, useLocation } from 'react-router'
import { bootstrap, can, useAuth } from '../lib/session'
import type { Permission } from '../lib/types'
import { Spinner } from './ui'

export function RequireAuth({ children }: { children: ReactElement }) {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <Spinner label="Verificando tu sesión…" />
  if (status === 'unavailable') {
    return (
      <div className="card m-6 space-y-2" role="alert">
        <p>No pudimos restaurar tu sesión.</p>
        <button type="button" className="btn" onClick={() => void bootstrap()}>
          Reintentar
        </button>
      </div>
    )
  }
  if (status === 'anonymous') {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  }
  return children
}

export function Perm({ permissions, children }: { permissions: Permission[]; children: ReactElement }) {
  const { me } = useAuth()
  if (permissions.every((p) => can(me, p))) return children
  return (
    <section className="card max-w-lg mx-auto space-y-2">
      <h1 className="text-xl font-semibold">Sin permiso</h1>
      <p>Tu rol no tiene acceso a esta sección.</p>
      <Link to="/">Volver al inicio</Link>
    </section>
  )
}

export function NotFound() {
  return (
    <section className="card max-w-lg mx-auto space-y-2">
      <h1 className="text-xl font-semibold">Página no encontrada</h1>
      <p>Esa ruta no existe en el piso.</p>
      <Link to="/">Volver al inicio</Link>
    </section>
  )
}
