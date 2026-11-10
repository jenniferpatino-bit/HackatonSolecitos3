import { useEffect, useState, type FormEvent } from 'react'
import { ErrorNote, Field, Spinner } from '../components/ui'
import { useFetch } from '../lib/hooks'
import { ApiError, asApiError, BUILD, env, rawFetch } from '../lib/http'
import { api, can, refreshMe, useAuth } from '../lib/session'
import type { Check, Clearance, DeployChallenge, IntegrationStatus, Roster, RosterMember } from '../lib/types'

function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="text-sm space-y-1">
      {checks.map((c) => (
        <li key={c.name}>
          <span className={c.passed ? 'text-accent' : 'text-danger'}>{c.passed ? 'OK' : 'Falla'}</span> {c.name}: {c.detail}
        </li>
      ))}
    </ul>
  )
}

function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(asApiError(e))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function RosterForm({ roster, onSaved }: { roster: Roster; onSaved: () => void }) {
  const [members, setMembers] = useState<RosterMember[]>(() => [0, 1, 2].map((i) => roster.members[i] ?? { name: '', code: '' }))
  const action = useAction()
  const set = (i: number, patch: Partial<RosterMember>) => setMembers(members.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void action.run(async () => {
      await api<Roster>('/team/roster', { method: 'PUT', body: { members } })
      onSaved()
    })
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      {members.map((m, i) => (
        <div key={i} className="grid grid-cols-2 gap-2">
          <Field id={`name-${i}`} label={`Integrante ${i + 1}`}>
            <input id={`name-${i}`} className="input" required disabled={roster.locked} value={m.name} onChange={(e) => set(i, { name: e.target.value })} />
          </Field>
          <Field id={`code-${i}`} label="Código">
            <input id={`code-${i}`} className="input" required disabled={roster.locked} value={m.code} onChange={(e) => set(i, { code: e.target.value })} />
          </Field>
        </div>
      ))}
      {action.error && <ErrorNote error={action.error} />}
      <button type="submit" className="btn" disabled={action.busy || roster.locked}>{action.busy ? 'Guardando…' : 'Guardar integrantes'}</button>
      {roster.locked && <p className="text-sm text-dim">El roster ya está bloqueado por un sorteo.</p>}
    </form>
  )
}

function DeploySection({ onVerified }: { onVerified: () => void }) {
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
  const [origin, setOrigin] = useState(isLocal ? '' : window.location.origin)
  const [challenge, setChallenge] = useState<DeployChallenge | null>(null)
  const action = useAction()
  return (
    <div className="space-y-2">
      <Field id="origin" label="Origen de producción (https://...)">
        <input id="origin" className="input" value={origin} onChange={(e) => setOrigin(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <button type="button" className="btn" disabled={action.busy} onClick={() => void action.run(async () => setChallenge(await api<DeployChallenge>('/integrations/deploy/challenge', { method: 'POST', body: { origin } })))}>
          1. Pedir token
        </button>
        <button type="button" className="btn" disabled={action.busy} onClick={() => void action.run(async () => { await api('/integrations/deploy/verify', { method: 'POST' }); onVerified() })}>
          2. Verificar
        </button>
      </div>
      {challenge && (
        <p className="text-sm break-all">
          Publica este texto en <code>{challenge.wellKnownPath}</code>: <code>{challenge.token}</code>
        </p>
      )}
      {action.error && <ErrorNote error={action.error} />}
    </div>
  )
}

function StorageSection({ onDone }: { onDone: () => void }) {
  const [checks, setChecks] = useState<Check[] | null>(null)
  const action = useAction()
  const body =
    env.storageProvider === 'CLOUDINARY'
      ? { provider: 'CLOUDINARY', cloudName: env.cloudName, uploadPreset: env.uploadPreset }
      : { provider: 'SUPABASE', projectUrl: env.supabaseUrl, bucket: env.supabaseBucket, publicKey: env.supabaseKey }
  const register = () =>
    action.run(async () => {
      try {
        const result = await api<{ checks: Check[] }>('/integrations/storage', { method: 'PUT', body })
        setChecks(result.checks)
        onDone()
      } catch (e) {
        const err = asApiError(e)
        const details = err.details as { checks?: Check[] } | null
        if (details?.checks) setChecks(details.checks)
        throw err
      }
    })
  return (
    <div className="space-y-2">
      <p className="text-sm text-dim">Proveedor configurado: {env.storageProvider || 'ninguno'}</p>
      <button type="button" className="btn" disabled={action.busy} onClick={() => void register()}>{action.busy ? 'Probando…' : 'Registrar y verificar storage'}</button>
      {action.error && <ErrorNote error={action.error} />}
      {checks && <Checks checks={checks} />}
    </div>
  )
}

export default function EstadoPage() {
  const { me } = useAuth()
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking')
  const integrations = useFetch((signal) => api<IntegrationStatus>('/integrations/status', { signal }), [])
  const clearance = useFetch((signal) => api<Clearance>('/clearance', { signal }), [])
  const [checks, setChecks] = useState<Check[] | null>(null)
  const open = useAction()
  const chaos = useAction()

  useEffect(() => {
    rawFetch('/meta/health', { signal: AbortSignal.timeout(20000) }).then(
      (r) => setHealth(r.ok ? 'ok' : 'down'),
      () => setHealth('down'),
    )
  }, [])

  const reloadAll = () => {
    integrations.reload()
    clearance.reload()
  }

  const runCheck = () =>
    open.run(async () => {
      const result = await api<{ granted: boolean; checks: Check[] }>('/clearance/check', { method: 'POST', retries: 0 })
      setChecks(result.checks)
      if (result.granted) await refreshMe()
      reloadAll()
    })

  const setChaos = (level: number) =>
    chaos.run(async () => {
      await api('/workspace/chaos', { method: 'PUT', body: { level } })
      clearance.reload()
    })

  const shownChecks = checks ?? clearance.data?.checks ?? []
  const deploy = integrations.data?.deploy
  const storage = integrations.data?.storage

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold">Estado</h1>

      <section className="card space-y-1">
        <h2 className="font-semibold">Sistema</h2>
        <p>Build desplegado: <code>{BUILD}</code></p>
        <p role="status">API: {health === 'checking' ? 'comprobando…' : health === 'ok' ? 'responde' : 'no responde'}</p>
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">Piso de Pruebas</h2>
        <p>Estado: {me?.clearance.granted ? 'abierto' : 'cerrado'}</p>
        <button type="button" className="btn btn-primary" disabled={open.busy} onClick={() => void runCheck()}>
          {open.busy ? 'Revisando…' : 'Abrir el Piso de Pruebas'}
        </button>
        {open.error && <ErrorNote error={open.error} />}
        {shownChecks.length > 0 && <Checks checks={shownChecks} />}
        {clearance.error && <ErrorNote error={clearance.error} onRetry={clearance.reload} />}
        {clearance.data && (
          <label className="text-sm flex items-center gap-2">
            Modo caos
            <select className="input w-24" value={clearance.data.workspace.chaosLevel} disabled={chaos.busy} onChange={(e) => void setChaos(Number(e.target.value))}>
              <option value={0}>0</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
        )}
        {chaos.error && <ErrorNote error={chaos.error} />}
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">Integraciones</h2>
        {integrations.error && <ErrorNote error={integrations.error} onRetry={integrations.reload} />}
        {!integrations.data && !integrations.error && <Spinner label="Cargando…" />}
        {deploy && <p>Dominio: {deploy.origin ?? 'sin verificar'} · Último build visto: {deploy.lastBuildSeen ?? 'ninguno'}</p>}
        {storage && <p>Storage: {storage.verifiedAt ? `${storage.provider} verificado` : 'sin verificar'}</p>}
        <h3 className="font-semibold pt-2">Verificar dominio</h3>
        <DeploySection onVerified={reloadAll} />
        <h3 className="font-semibold pt-2">Storage</h3>
        <StorageSection onDone={reloadAll} />
      </section>

      {can(me, 'team:manage') && clearance.data && (
        <section className="card space-y-2">
          <h2 className="font-semibold">Integrantes</h2>
          <RosterForm key={clearance.data.roster.members.map((m) => m.code).join()} roster={clearance.data.roster} onSaved={clearance.reload} />
        </section>
      )}
    </div>
  )
}
