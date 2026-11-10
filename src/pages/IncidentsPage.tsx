import { Link, useSearchParams } from 'react-router'
import { ErrorNote, Pagination, Spinner } from '../components/ui'
import { enumParam, intParam, useFetch } from '../lib/hooks'
import { api, can, useAuth } from '../lib/session'
import type { Incident, Page } from '../lib/types'

const SIZES = [10, 25, 50] as const

export default function IncidentsPage() {
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const page = intParam(params.get('page'), 0, 0)
  const size = enumParam(params.get('size'), SIZES, 10)
  const { data, error, loading, reload } = useFetch((signal) => api<Page<Incident>>(`/incidents?page=${page}&size=${size}`, { signal }), [page, size])

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Incidencias</h1>
        {can(me, 'incidents:create') && can(me, 'media:upload') && <Link className="btn" to="/incidents/new">Nuevo reporte</Link>}
      </div>
      {error && <ErrorNote error={error} onRetry={reload} />}
      {!data && loading && <Spinner label="Cargando reportes…" />}
      {data && (
        <div aria-busy={loading} className="space-y-3">
          {data.content.length === 0 && <p className="card">No hay reportes.</p>}
          {data.content.map((x) => (
            <article key={x.id} className="card space-y-2">
              <h2 className="font-semibold">{x.title}</h2>
              <p className="text-sm text-dim">{x.severity} · {x.createdBy.displayName} · {new Date(x.createdAt).toLocaleString('es-PE')}{x.file ? ` · ${x.file.name}` : ''}</p>
              <p className="whitespace-pre-wrap break-words">{x.description}</p>
              <div className="flex flex-wrap gap-2">
                {x.photos.map((p) => (
                  <img key={p.mediaId} src={p.url} alt={`Foto del reporte ${x.title}`} width={p.width} height={p.height} loading="lazy" decoding="async" className="h-32 w-auto rounded" />
                ))}
              </div>
            </article>
          ))}
          <Pagination page={page} totalPages={data.totalPages} size={size} onPage={(p) => setParams({ page: String(p), size: String(size) })} onSize={(s) => setParams({ size: String(s) })} />
        </div>
      )}
    </div>
  )
}
