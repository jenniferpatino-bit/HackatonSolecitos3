import { Link, useSearchParams } from 'react-router'
import { ErrorNote, Field, Pagination, SearchBox, Spinner } from '../components/ui'
import { useLumonEvent } from '../lib/events'
import { enumParam, intParam, useFetch } from '../lib/hooks'
import { api } from '../lib/session'
import type { FileInfo, Page } from '../lib/types'

const SIZES = [10, 25, 50] as const
const STATUSES = ['', 'ACTIVE', 'COMPLETE'] as const
const SORTS = ['updatedAt,desc', 'name,asc', 'progress,desc'] as const

export default function FilesPage() {
  const [params, setParams] = useSearchParams()
  const page = intParam(params.get('page'), 0, 0)
  const size = enumParam(params.get('size'), SIZES, 10)
  const status = enumParam(params.get('status'), STATUSES, '')
  const sort = enumParam(params.get('sort'), SORTS, 'updatedAt,desc')
  const q = (params.get('q') ?? '').slice(0, 60)

  const { data, error, loading, reload, setData } = useFetch(
    (signal) => {
      const query = new URLSearchParams({ page: String(page), size: String(size), sort })
      if (status) query.set('status', status)
      if (q) query.set('q', q)
      return api<Page<FileInfo>>(`/files?${query}`, { signal })
    },
    [page, size, status, sort, q],
  )

  useLumonEvent('refinement.created', (d) => {
    setData((p) => p && { ...p, content: p.content.map((f) => (f.id === d.fileId && d.progress.overall >= f.progress.overall ? { ...f, progress: d.progress } : f)) })
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
      <h1 className="text-2xl font-semibold">Archivos de datos</h1>
      <div className="grid sm:grid-cols-3 gap-3">
        <SearchBox id="q" label="Buscar por nombre" value={q} onCommit={(v) => update({ q: v })} />
        <Field id="status" label="Estado">
          <select id="status" className="input" value={status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">Todos</option>
            <option value="ACTIVE">Activos</option>
            <option value="COMPLETE">Completos</option>
          </select>
        </Field>
        <Field id="sort" label="Orden">
          <select id="sort" className="input" value={sort} onChange={(e) => update({ sort: e.target.value })}>
            <option value="updatedAt,desc">Recientes</option>
            <option value="name,asc">Nombre</option>
            <option value="progress,desc">Progreso</option>
          </select>
        </Field>
      </div>

      {error && <ErrorNote error={error} onRetry={reload} />}
      {!data && loading && <Spinner label="Cargando archivos…" />}
      {data && (
        <div aria-busy={loading} className={loading ? 'opacity-70' : ''}>
          {data.content.length === 0 ? (
            <p className="card">
              No hay archivos con estos filtros.{' '}
              {page > 0 && (
                <button type="button" className="btn btn-small" onClick={() => update({})}>
                  Ir a la primera página
                </button>
              )}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Archivos de datos</caption>
                <thead>
                  <tr className="border-b border-line">
                    <th className="p-2">Nombre</th>
                    <th className="p-2">Tamaño</th>
                    <th className="p-2">Estado</th>
                    <th className="p-2">Progreso</th>
                    <th className="p-2">Errores</th>
                    <th className="p-2"><span className="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.content.map((f) => (
                    <tr key={f.id} className="border-b border-line">
                      <td className="p-2">{f.name}</td>
                      <td className="p-2">{f.rows} × {f.cols}</td>
                      <td className="p-2">{f.status === 'ACTIVE' ? 'Activo' : 'Completo'}</td>
                      <td className="p-2">{Math.round(f.progress.overall * 100)} %</td>
                      <td className="p-2">{f.mistakes}</td>
                      <td className="p-2">
                        <Link to={`/files/${f.id}/refine`} aria-label={`Abrir ${f.name}`}>Abrir</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3">
            <Pagination page={page} totalPages={data.totalPages} size={size} onPage={(p) => update({ page: String(p) }, false)} onSize={(s) => update({ size: String(s) })} />
          </div>
        </div>
      )}
    </div>
  )
}
