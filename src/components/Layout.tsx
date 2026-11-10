import { NavLink, Outlet, useNavigate } from 'react-router'
import { hub, useStreamStatus, type StreamStatus } from '../lib/events'
import { can, logout, useAuth } from '../lib/session'
import type { Permission } from '../lib/types'

const LINKS: { to: string; label: string; permission?: Permission }[] = [
  { to: '/files', label: 'Archivos', permission: 'files:read' },
  { to: '/refiners', label: 'Expedientes', permission: 'refiners:read' },
  { to: '/incidents', label: 'Incidencias', permission: 'incidents:read' },
  { to: '/estado', label: 'Estado' },
]

const STREAM_LABEL: Record<StreamStatus, string> = {
  off: 'Eventos apagados',
  connecting: 'Eventos: conectando',
  open: 'Eventos: en vivo',
  reconnecting: 'Eventos: reconectando',
  superseded: 'Eventos: otra conexión tomó el stream',
  locked: 'Eventos: piso cerrado',
}

export function Layout() {
  const { me } = useAuth()
  const stream = useStreamStatus()
  const navigate = useNavigate()

  const signOut = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen flex flex-col">
      <a href="#main" className="sr-only focus:not-sr-only">
        Saltar al contenido
      </a>
      <header className="border-b border-line px-4 py-2 flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="font-semibold tracking-wide">Consola MDR</span>
        <nav aria-label="Principal" className="flex gap-4">
          {LINKS.filter((l) => !l.permission || can(me, l.permission)).map((l) => (
            <NavLink key={l.to} to={l.to}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4 text-sm">
          <span role="status" className={stream === 'open' ? 'text-accent' : 'text-dim'}>
            {STREAM_LABEL[stream]}
          </span>
          {stream === 'superseded' && (
            <button type="button" className="btn btn-small" onClick={() => hub.restart()}>
              Reconectar
            </button>
          )}
          <span>
            {me?.displayName} · {me?.team.code}
          </span>
          <button type="button" className="btn btn-small" onClick={() => void signOut()}>
            Cerrar sesión
          </button>
        </div>
      </header>
      <main id="main" className="flex-1 p-4">
        <Outlet />
      </main>
    </div>
  )
}
