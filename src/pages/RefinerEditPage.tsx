import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ErrorNote, Field, Spinner } from '../components/ui'
import { useLumonEvent } from '../lib/events'
import { fieldErrors, useFetch } from '../lib/hooks'
import { ApiError, asApiError } from '../lib/http'
import { etagOf, reconcile } from '../lib/refiners'
import { api, apiResponse } from '../lib/session'
import type { Department, Refiner } from '../lib/types'

interface Form {
  title: string
  extension: string
  bio: string
  departmentId: number
}

type FieldKey = keyof Form

const FIELDS: { key: FieldKey; label: string }[] = [
  { key: 'title', label: 'Título' },
  { key: 'extension', label: 'Anexo' },
  { key: 'bio', label: 'Biografía' },
  { key: 'departmentId', label: 'Departamento' },
]

const toForm = (r: Refiner): Form => ({ title: r.title, extension: r.extension, bio: r.bio, departmentId: r.department.id })

interface Base {
  refiner: Refiner
  etag: string
}

interface Conflict extends Base {
  choices: Partial<Record<FieldKey, 'mine' | 'server'>>
}

export default function RefinerEditPage() {
  const { id } = useParams()
  const departments = useFetch((signal) => api<Department[]>('/departments', { signal }), [])
  const loaded = useFetch(
    async (signal): Promise<Base> => {
      const res = await apiResponse(`/refiners/${id}`, { signal })
      const refiner = (await res.json()) as Refiner
      reconcile(refiner)
      return { refiner, etag: res.headers.get('ETag') ?? etagOf(refiner.version) }
    },
    [id],
  )
  const [base, setBase] = useState<Base | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [remote, setRemote] = useState<Refiner['version'] | null>(null)
  const [remoteBy, setRemoteBy] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!loaded.data) return
    setBase(loaded.data)
    setForm(toForm(loaded.data.refiner))
    setRemote(null)
    setConfirming(false)
  }, [loaded.data])

  useLumonEvent('refiner.updated', (d) => {
    if (String(d.id) !== id) return
    reconcile(d.refiner)
    if (base && d.version > base.refiner.version) {
      setRemote(d.version)
      setRemoteBy(d.updatedBy.displayName)
    }
  })

  if (loaded.error && !base) return <ErrorNote error={loaded.error} onRetry={loaded.reload} />
  if (!base || !form) return <Spinner label="Cargando expediente…" />

  const deptName = (deptId: number) => departments.data?.find((d) => d.id === deptId)?.name ?? String(deptId)
  const show = (key: FieldKey, value: Form) => (key === 'departmentId' ? deptName(value.departmentId) : String(value[key]))

  const diff = (from: Form, to: Form): Partial<Form> => {
    const body: Partial<Form> = {}
    if (to.title !== from.title) body.title = to.title
    if (to.extension !== from.extension) body.extension = to.extension
    if (to.bio !== from.bio) body.bio = to.bio
    if (to.departmentId !== from.departmentId) body.departmentId = to.departmentId
    return body
  }

  const patch = async (body: Partial<Form>, etag: string, mine: Form) => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const res = await apiResponse(`/refiners/${id}`, { method: 'PATCH', body, headers: { 'If-Match': etag }, retries: 0 })
      const refiner = (await res.json()) as Refiner
      reconcile(refiner)
      setBase({ refiner, etag: res.headers.get('ETag') ?? etagOf(refiner.version) })
      setForm(toForm(refiner))
      setConflict(null)
      setRemote(null)
      setConfirming(false)
      setSaved(true)
    } catch (e) {
      const err = asApiError(e)
      if (err.code === 'VERSION_CONFLICT') {
        const current = (err.details as { current: Refiner }).current
        reconcile(current)
        const serverForm = toForm(current)
        const choices: Conflict['choices'] = {}
        FIELDS.forEach(({ key }) => {
          if (mine[key] !== serverForm[key]) choices[key] = 'mine'
        })
        setConflict({ refiner: current, etag: err.etag ?? etagOf(current.version), choices })
        setConfirming(false)
      } else {
        setError(err)
      }
    } finally {
      setBusy(false)
    }
  }

  const adoptLatest = () => loaded.reload()

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const body = diff(toForm(base.refiner), form)
    if (!Object.keys(body).length) {
      setError(new ApiError(0, 'NO_CHANGES', 'No hay cambios que guardar.'))
      return
    }
    if (remote !== null && !confirming) {
      setConfirming(true)
      return
    }
    void patch(body, base.etag, form)
  }

  if (conflict) {
    const server = toForm(conflict.refiner)
    const keys = Object.keys(conflict.choices) as FieldKey[]
    const resolve = () => {
      const merged: Form = { ...server }
      if (conflict.choices.title === 'mine') merged.title = form.title
      if (conflict.choices.extension === 'mine') merged.extension = form.extension
      if (conflict.choices.bio === 'mine') merged.bio = form.bio
      if (conflict.choices.departmentId === 'mine') merged.departmentId = form.departmentId
      const body = diff(server, merged)
      setBase({ refiner: conflict.refiner, etag: conflict.etag })
      setForm(merged)
      if (Object.keys(body).length) void patch(body, conflict.etag, merged)
      else {
        setConflict(null)
        setRemote(null)
      }
    }
    return (
      <section className="card max-w-3xl mx-auto space-y-3">
        <h1 className="text-2xl font-semibold">Conflicto de versión</h1>
        <p>Alguien cambió este expediente mientras lo editabas (ahora va en la versión {conflict.refiner.version}). Elige qué conservar en cada campo.</p>
        {keys.map((key) => {
          const label = FIELDS.find((f) => f.key === key)?.label ?? key
          const pick = (value: 'mine' | 'server') => setConflict({ ...conflict, choices: { ...conflict.choices, [key]: value } })
          return (
            <fieldset key={key} className="border border-line rounded p-3 space-y-2">
              <legend className="px-1 font-semibold">{label}</legend>
              <label className="flex gap-2 items-start">
                <input type="radio" name={key} checked={conflict.choices[key] === 'mine'} onChange={() => pick('mine')} />
                <span><strong>Lo que escribiste:</strong> <span className="whitespace-pre-wrap break-words">{show(key, form)}</span></span>
              </label>
              <label className="flex gap-2 items-start">
                <input type="radio" name={key} checked={conflict.choices[key] === 'server'} onChange={() => pick('server')} />
                <span><strong>Lo que hay ahora:</strong> <span className="whitespace-pre-wrap break-words">{show(key, server)}</span></span>
              </label>
            </fieldset>
          )
        })}
        {!keys.length && <p>Tus valores coinciden con los del servidor.</p>}
        {error && <ErrorNote error={error} />}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={resolve}>
          {busy ? 'Guardando…' : 'Guardar con esta selección'}
        </button>
      </section>
    )
  }

  const fields = fieldErrors(error)
  const set = (patchForm: Partial<Form>) => {
    setSaved(false)
    setForm({ ...form, ...patchForm })
  }

  return (
    <form onSubmit={save} className="card max-w-2xl mx-auto space-y-3">
      <h1 className="text-2xl font-semibold">Editar a {base.refiner.fullName}</h1>
      {remote !== null && (
        <div role="alert" className="text-warn space-y-2">
          <p>{remoteBy} cambió este expediente mientras lo editabas (versión {remote}).</p>
          <button type="button" className="btn btn-small" onClick={adoptLatest}>
            Descartar mis cambios y cargar lo nuevo
          </button>
        </div>
      )}
      <Field id="title" label="Título" error={fields.title}>
        <input id="title" className="input" required maxLength={200} value={form.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <Field id="extension" label="Anexo (3 a 6 dígitos)" error={fields.extension}>
        <input id="extension" className="input" required pattern="[0-9]{3,6}" value={form.extension} onChange={(e) => set({ extension: e.target.value })} />
      </Field>
      <Field id="departmentId" label="Departamento" error={fields.departmentId}>
        <select id="departmentId" className="input" value={form.departmentId} onChange={(e) => set({ departmentId: Number(e.target.value) })}>
          {!departments.data && <option value={form.departmentId}>{base.refiner.department.name}</option>}
          {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
      <Field id="bio" label="Biografía" error={fields.bio}>
        <textarea id="bio" className="input" rows={6} maxLength={2000} value={form.bio} onChange={(e) => set({ bio: e.target.value })} />
      </Field>
      {error && !Object.keys(fields).length && <ErrorNote error={error} />}
      {saved && <p role="status" className="text-accent">Expediente guardado.</p>}
      {confirming && <p role="alert" className="text-warn">El expediente cambió: al guardar verás qué campos chocan antes de sobrescribir nada. Pulsa guardar otra vez para continuar.</p>}
      <div className="flex gap-3">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>
        <Link className="btn" to={`/refiners/${base.refiner.id}`}>Volver</Link>
      </div>
    </form>
  )
}
