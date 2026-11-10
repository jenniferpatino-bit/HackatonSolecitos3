import { lazy, Suspense, useEffect, type ReactElement } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { ContingencyHost } from './components/ContingencyHost'
import { ErrorBoundary } from './components/ErrorBoundary'
import { HealthGate } from './components/HealthGate'
import { Layout } from './components/Layout'
import { NotFound, Perm, RequireAuth } from './components/guards'
import { Spinner } from './components/ui'
import { hub } from './lib/events'
import { bootstrap, useAuth } from './lib/session'
import type { Permission } from './lib/types'

const Login = lazy(() => import('./pages/LoginPage'))
const Register = lazy(() => import('./pages/RegisterPage'))
const Files = lazy(() => import('./pages/FilesPage'))
const Refine = lazy(() => import('./pages/refine/RefinePage'))
const Refiners = lazy(() => import('./pages/RefinersPage'))
const RefinerDetail = lazy(() => import('./pages/RefinerDetailPage'))
const RefinerEdit = lazy(() => import('./pages/RefinerEditPage'))
const BadgeEditor = lazy(() => import('./pages/BadgeEditorPage'))
const Incidents = lazy(() => import('./pages/IncidentsPage'))
const IncidentNew = lazy(() => import('./pages/IncidentNewPage'))
const Estado = lazy(() => import('./pages/EstadoPage'))

const guarded = (permissions: Permission[], page: ReactElement) => <Perm permissions={permissions}>{page}</Perm>

function Screens() {
  const { me, status } = useAuth()
  const { pathname } = useLocation()

  useEffect(() => {
    void bootstrap()
  }, [])

  // El stream solo existe con sesión y con el Piso de Pruebas abierto.
  const streamUser = status === 'authenticated' && me?.clearance.granted ? me.id : null
  useEffect(() => {
    if (streamUser === null) return
    hub.start(streamUser)
    return () => hub.stop()
  }, [streamUser])

  return (
    <ErrorBoundary resetKey={pathname}>
      <Suspense fallback={<Spinner label="Cargando…" />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Navigate to="/files" replace />} />
            <Route path="/files" element={guarded(['files:read'], <Files />)} />
            <Route path="/files/:id/refine" element={guarded(['files:read'], <Refine />)} />
            <Route path="/refiners" element={guarded(['refiners:read'], <Refiners />)} />
            <Route path="/refiners/:id" element={guarded(['refiners:read'], <RefinerDetail />)} />
            <Route path="/refiners/:id/edit" element={guarded(['refiners:write'], <RefinerEdit />)} />
            <Route path="/refiners/:id/badge" element={guarded(['refiners:write', 'media:upload'], <BadgeEditor />)} />
            <Route path="/incidents" element={guarded(['incidents:read'], <Incidents />)} />
            <Route path="/incidents/new" element={guarded(['incidents:create', 'media:upload'], <IncidentNew />)} />
            <Route path="/estado" element={<Estado />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
      <ContingencyHost />
    </ErrorBoundary>
  )
}

export default function App() {
  return (
    <HealthGate>
      <Screens />
    </HealthGate>
  )
}
