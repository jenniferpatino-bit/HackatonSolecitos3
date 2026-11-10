import { Link, useSearchParams } from 'react-router'
import { ErrorNote, Field, Pagination, SearchBox, Spinner } from '../components/ui'
import { useLumonEvent } from '../lib/events'
import { enumParam, intParam, useFetch } from '../lib/hooks'
import { reconcile } from '../lib/refiners'
import { api } from '../lib/session'
import type { Department, Page, Refiner } from '../lib/types'

const SIZES = [10, 25, 50] as const

export function BadgeImage({ refiner, size }: { refiner: Refiner; size: number }) {
  if (!refiner.badge) {
    return (
      <div className="flex items-center justify-center rounded bg-ink text-dim text-xs" style={{ width: size, height: size }}>
        Sin foto
      </div>
    )
  }
  return <img src={refiner.badge.url} alt={`Fotocheck de ${refiner.fullName}`} width={size} height={size} loading="lazy" decoding="async" className="rounded object-cover" style={{ width: size, height: size }} />
}

export default function RefinersPage() {
  const [params, setParams] = useSearchParams()
  const page = intParam(params.get('page'), 0, 0)
  const size = enumParam(params.get('size'), SIZES, 10)
  const departmentId = intParam(params.get('departmentId'), 1, 0)
  const q = (params.get('q') ?? '').slice(0, 60)

  const departments = useFetch((signal) => api<Department[]>('/departments', { signal }), [])
  const { data, error, loading, reload, setData } = useFetch(
    async (signal) => {
      const query = new URLSearchParams({ page: String(page), size: String(size) })
      if (departmentId) query.set('departmentId', String(departmentId))
      if (q) query.set('q', q)
      const result = await api<Page<Refiner>>(`/refiners?${query}`, { signal })
      return { ...result, content: result.content.map(reconcile) }
    },
    [page, size, departmentId, q],
  )

  useLumonEvent('refiner.updated', (d) => {
    const newest = reconcile(d.refiner)
    setData((p) => p && { ...p, content: p.content.map((r) => (r.id === newest.id ? newest : r)) })
  })
  useLumonEvent('stream.reset', reload)

  const update = (changes: Record<string, string>, resetPage = true) => {
    const next = new URLSearchParams(params)
    Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)))
    if (resetPage) next.delete('page')
    setParams(next)
  }

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <h1 className="text-2xl font-semibold">Expedientes</h1>
      <div className="grid sm:grid-cols-2 gap-3">
        <SearchBox id="q" label="Buscar por nombre, título o anexo" value={q} onCommit={(v) => update({ q: v })} />
        <Field id="department" label="Departamento">
          <select id="department" className="input" value={departmentId || ''} onChange={(e) => update({ departmentId: e.target.value })}>
            <option value="">Todos</option>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </Field>
      </div>
      {error && <ErrorNote error={error} onRetry={reload} />}
      {!data && loading && <Spinner label="Cargando expedientes…" />}
      {data && (
        <div aria-busy={loading} className={loading ? 'opacity-70' : ''}>
          {data.content.length === 0 && <p className="card">No hay expedientes con estos filtros.</p>}
          <ul className="grid sm:grid-cols-2 gap-3">
            {data.content.map((r) => (
              <li key={r.id} className="card flex gap-3">
                <BadgeImage refiner={r} size={72} />
                <div className="min-w-0">
                  <h2 className="font-semibold truncate">
                    <Link to={`/refiners/${r.id}`}>{r.fullName}</Link>
                  </h2>
                  <p className="text-sm text-dim truncate">{r.title}</p>
                  <p className="text-sm text-dim">{r.department.name} · Anexo {r.extension}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Pagination page={page} totalPages={data.totalPages} size={size} onPage={(p) => update({ page: String(p) }, false)} onSize={(s) => update({ size: String(s) })} />
          </div>
        </div>
      )}
    </div>
  )
}
