import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { ErrorNote, Field, ProgressBar } from '../components/ui'
import { fieldErrors } from '../lib/hooks'
import { ApiError, asApiError } from '../lib/http'
import { prepareIncident, UploadJob, type UploadState } from '../lib/media'
import { api } from '../lib/session'
import type { Severity } from '../lib/types'

const MAX_PHOTOS = 3

interface Photo {
  id: number
  name: string
  job: UploadJob | null
  state: UploadState | null
  error: string | null
}

export default function IncidentNewPage() {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('MEDIUM')
  const [fileId, setFileId] = useState('')
  const [photos, setPhotos] = useState<Photo[]>([])
  const counter = useRef(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<ApiError | null>(null)

  const patchPhoto = (id: number, patch: Partial<Photo>) => setPhotos((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  const addPhoto = async (file: File, id: number) => {
    try {
      const prepared = await prepareIncident(file)
      const job = new UploadJob(prepared, 'INCIDENT', (state) => patchPhoto(id, { state }))
      patchPhoto(id, { job })
      void job.start()
    } catch (e) {
      patchPhoto(id, { error: (e as Error).message })
    }
  }

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const free = MAX_PHOTOS - photos.length
    const files = [...(e.target.files ?? [])].slice(0, free)
    e.target.value = ''
    const added = files.map((f) => ({ file: f, photo: { id: ++counter.current, name: f.name, job: null, state: null, error: null } as Photo }))
    setPhotos((list) => [...list, ...added.map((a) => a.photo)])
    added.forEach((a) => void addPhoto(a.file, a.photo.id))
  }

  const remove = (photo: Photo) => {
    photo.job?.cancel()
    setPhotos((list) => list.filter((p) => p.id !== photo.id))
  }

  const mediaIds = photos.flatMap((p) => (p.state?.media ? [p.state.media.mediaId] : []))
  const ready = photos.length >= 1 && mediaIds.length === photos.length

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await api('/incidents', {
        method: 'POST',
        retries: 0,
        body: { title, description, severity, mediaIds, ...(fileId ? { fileId: Number(fileId) } : {}) },
      })
      navigate('/incidents')
    } catch (err) {
      setError(asApiError(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const fields = fieldErrors(error)

  return (
    <form onSubmit={(e) => void submit(e)} className="card max-w-2xl mx-auto space-y-3">
      <h1 className="text-2xl font-semibold">Nuevo reporte de incidencia</h1>
      <Field id="title" label="Título" error={fields.title}>
        <input id="title" className="input" required minLength={3} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field id="description" label="Descripción" error={fields.description}>
        <textarea id="description" className="input" rows={4} required maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field id="severity" label="Severidad" error={fields.severity}>
        <select id="severity" className="input" value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
          <option value="LOW">Baja</option>
          <option value="MEDIUM">Media</option>
          <option value="HIGH">Alta</option>
          <option value="CRITICAL">Crítica</option>
        </select>
      </Field>
      <Field id="fileId" label="Id del archivo relacionado (opcional)" error={fields.fileId}>
        <input id="fileId" className="input" inputMode="numeric" pattern="[0-9]*" value={fileId} onChange={(e) => setFileId(e.target.value)} />
      </Field>
      <Field id="photos" label={`Fotos (1 a ${MAX_PHOTOS})`} error={fields.mediaIds}>
        <input id="photos" type="file" accept="image/*" multiple disabled={photos.length >= MAX_PHOTOS} onChange={onFiles} />
      </Field>
      <ul className="space-y-2">
        {photos.map((p) => {
          const active = p.state && ['ticket', 'uploading', 'confirming'].includes(p.state.stage)
          const failed = p.state?.stage === 'error' || p.state?.stage === 'cancelled'
          const text = p.error ?? p.state?.error ?? (p.state ? { ticket: 'Pidiendo permiso…', uploading: 'Subiendo…', confirming: 'Comprobando…', done: 'Confirmada', error: 'Falló', cancelled: 'Cancelada' }[p.state.stage] : 'Preparando…')
          return (
            <li key={p.id} className="border border-line rounded p-2 space-y-1">
              <div className="flex justify-between gap-2 text-sm">
                <span className="truncate">{p.name}</span>
                <span role="status" className={p.error || p.state?.error ? 'text-danger' : ''}>{text}</span>
              </div>
              <ProgressBar value={p.state?.progress ?? 0} label={`Progreso de ${p.name}`} />
              <div className="flex gap-2">
                {active && <button type="button" className="btn btn-small" onClick={() => p.job?.cancel()}>Cancelar</button>}
                {failed && <button type="button" className="btn btn-small" onClick={() => void p.job?.start()}>Reintentar</button>}
                {!active && <button type="button" className="btn btn-small" onClick={() => remove(p)}>Quitar</button>}
              </div>
            </li>
          )
        })}
      </ul>
      {error && !Object.keys(fields).length && <ErrorNote error={error} />}
      {!ready && <p className="text-sm text-dim">El reporte se puede enviar cuando todas las fotos estén confirmadas.</p>}
      <div className="flex gap-3">
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>{busy ? 'Enviando…' : 'Enviar reporte'}</button>
        <Link className="btn" to="/incidents">Volver</Link>
      </div>
    </form>
  )
}
