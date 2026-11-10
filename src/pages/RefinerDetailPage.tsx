import { Link, useParams } from 'react-router'
import { ErrorNote, Spinner } from '../components/ui'
import { useLumonEvent } from '../lib/events'
import { useFetch } from '../lib/hooks'
import { reconcile } from '../lib/refiners'
import { api, can, useAuth } from '../lib/session'
import type { Refiner } from '../lib/types'
import { BadgeImage } from './RefinersPage'

/** La URL viene del exterior: solo se enlaza si es http(s). */
function safeUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

export default function RefinerDetailPage() {
  const { id } = useParams()
  const { me } = useAuth()
  const { data, error, reload, setData } = useFetch(async (signal) => reconcile(await api<Refiner>(`/refiners/${id}`, { signal })), [id])

  useLumonEvent('refiner.updated', (d) => {
    if (String(d.id) === id) setData(() => reconcile(d.refiner))
  })
  useLumonEvent('stream.reset', reload)

  if (error) return <ErrorNote error={error} onRetry={reload} />
  if (!data) return <Spinner label="Cargando expediente…" />
  const profile = safeUrl(data.profileUrl)

  return (
    <article className="card max-w-2xl mx-auto space-y-3">
      <div className="flex gap-4">
        <BadgeImage refiner={data} size={128} />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{data.fullName}</h1>
          <p>{data.title}</p>
          <p className="text-sm text-dim">{data.department.name} · Anexo {data.extension} · Versión {data.version}</p>
        </div>
      </div>
      <p className="whitespace-pre-wrap break-words">{data.bio}</p>
      {profile && (
        <p>
          <a href={profile} target="_blank" rel="noopener noreferrer">Perfil externo</a>
        </p>
      )}
      <div className="flex gap-3">
        {can(me, 'refiners:write') && <Link className="btn" to={`/refiners/${data.id}/edit`}>Editar</Link>}
        {can(me, 'refiners:write') && can(me, 'media:upload') && <Link className="btn" to={`/refiners/${data.id}/badge`}>Cambiar fotocheck</Link>}
      </div>
    </article>
  )
}
