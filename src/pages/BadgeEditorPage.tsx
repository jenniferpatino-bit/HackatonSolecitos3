import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ErrorNote, ProgressBar, Spinner } from '../components/ui'
import { useFetch } from '../lib/hooks'
import { ApiError, asApiError } from '../lib/http'
import { decodeImage, prepareBadge, UploadJob, type UploadState } from '../lib/media'
import { etagOf, reconcile } from '../lib/refiners'
import { apiResponse } from '../lib/session'
import type { Refiner } from '../lib/types'

const FRAME = 320
const MAX_ZOOM = 5
const STAGE_TEXT: Record<UploadState['stage'], string> = {
  ticket: 'Pidiendo permiso…',
  uploading: 'Subiendo…',
  confirming: 'Lumon está comprobando la imagen…',
  done: 'Imagen confirmada.',
  error: 'La subida falló.',
  cancelled: 'Subida cancelada.',
}

export default function BadgeEditorPage() {
  const { id } = useParams()
  const loaded = useFetch(
    async (signal) => {
      const res = await apiResponse(`/refiners/${id}`, { signal })
      const refiner = (await res.json()) as Refiner
      return { refiner: reconcile(refiner), etag: res.headers.get('ETag') ?? etagOf(refiner.version) }
    },
    [id],
  )
  const etagRef = useRef('')
  useEffect(() => {
    if (loaded.data) etagRef.current = loaded.data.etag
  }, [loaded.data])

  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [pickError, setPickError] = useState<string | null>(null)
  const [upload, setUpload] = useState<UploadState | null>(null)
  const jobRef = useRef<UploadJob | null>(null)
  const [mediaId, setMediaId] = useState<number | null>(null)
  const [patchError, setPatchError] = useState<ApiError | null>(null)
  const [conflictVersion, setConflictVersion] = useState<number | null>(null)
  const [patching, setPatching] = useState(false)
  const [result, setResult] = useState<Refiner | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  useEffect(() => () => { if (src) URL.revokeObjectURL(src) }, [src])

  const baseScale = bitmap ? FRAME / Math.min(bitmap.width, bitmap.height) : 1
  const scale = baseScale * zoom

  const clamp = (x: number, y: number, s = scale) => {
    if (!bitmap) return { x: 0, y: 0 }
    const maxX = (bitmap.width * s - FRAME) / 2
    const maxY = (bitmap.height * s - FRAME) / 2
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) }
  }

  const applyZoom = (next: number) => {
    const z = Math.min(MAX_ZOOM, Math.max(1, next))
    setZoom(z)
    setOffset((o) => clamp(o.x, o.y, baseScale * z))
  }
  const zoomRef = useRef(applyZoom)
  zoomRef.current = applyZoom
  const currentZoom = useRef(zoom)
  currentZoom.current = zoom

  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomRef.current(currentZoom.current * (e.deltaY < 0 ? 1.08 : 0.92))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [bitmap])

  const pick = async (file: File | undefined | null) => {
    if (!file) return
    setPickError(null)
    setUpload(null)
    setMediaId(null)
    setResult(null)
    try {
      const decoded = await decodeImage(file)
      setBitmap(decoded)
      setSrc(URL.createObjectURL(file))
      setZoom(1)
      setOffset({ x: 0, y: 0 })
    } catch (e) {
      setPickError((e as Error).message)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    void pick(e.dataTransfer.files[0])
  }
  const onPaste = (e: ClipboardEvent) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
    if (file) void pick(file)
  }

  const onFrameKey = (e: KeyboardEvent) => {
    const step = 8
    if (e.key === 'ArrowLeft') setOffset((o) => clamp(o.x + step, o.y))
    else if (e.key === 'ArrowRight') setOffset((o) => clamp(o.x - step, o.y))
    else if (e.key === 'ArrowUp') setOffset((o) => clamp(o.x, o.y + step))
    else if (e.key === 'ArrowDown') setOffset((o) => clamp(o.x, o.y - step))
    else if (e.key === '+' || e.key === '=') applyZoom(zoom * 1.1)
    else if (e.key === '-') applyZoom(zoom / 1.1)
    else return
    e.preventDefault()
  }

  const onFrameDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onFrameMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d) setOffset(clamp(d.ox + e.clientX - d.x, d.oy + e.clientY - d.y))
  }

  const applyBadge = async (id2: number) => {
    setPatching(true)
    setPatchError(null)
    setConflictVersion(null)
    try {
      const res = await apiResponse(`/refiners/${id}`, { method: 'PATCH', body: { badgeMediaId: id2 }, headers: { 'If-Match': etagRef.current }, retries: 0 })
      setResult(reconcile((await res.json()) as Refiner))
    } catch (e) {
      const err = asApiError(e)
      if (err.code === 'VERSION_CONFLICT') {
        const current = (err.details as { current: Refiner }).current
        reconcile(current)
        // El ETag nuevo solo se usa cuando el usuario decide aplicar sobre la versión actual.
        etagRef.current = err.etag ?? etagOf(current.version)
        setConflictVersion(current.version)
      } else {
        setPatchError(err)
      }
    } finally {
      setPatching(false)
    }
  }

  const startUpload = async () => {
    if (!bitmap) return
    setPickError(null)
    try {
      const size = FRAME / scale
      const prepared = await prepareBadge(bitmap, {
        sx: bitmap.width / 2 - offset.x / scale - size / 2,
        sy: bitmap.height / 2 - offset.y / scale - size / 2,
        size,
      })
      const job = new UploadJob(prepared, 'BADGE', (state) => {
        setUpload(state)
        if (state.stage === 'done' && state.media) {
          setMediaId(state.media.mediaId)
          void applyBadge(state.media.mediaId)
        }
      })
      jobRef.current = job
      void job.start()
    } catch (e) {
      setPickError((e as Error).message)
    }
  }

  if (loaded.error) return <ErrorNote error={loaded.error} onRetry={loaded.reload} />
  if (!loaded.data) return <Spinner label="Cargando expediente…" />

  const uploading = upload !== null && ['ticket', 'uploading', 'confirming'].includes(upload.stage)

  return (
    <section className="card max-w-2xl mx-auto space-y-4" onPaste={onPaste}>
      <h1 className="text-2xl font-semibold">Fotocheck de {loaded.data.refiner.fullName}</h1>
      <div onDragOver={(e) => e.preventDefault()} onDrop={onDrop} className="border border-dashed border-line rounded p-4 space-y-2">
        <label htmlFor="file" className="block">Elige una imagen, arrástrala aquí o pégala desde el portapapeles.</label>
        <input id="file" type="file" accept="image/*" onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
      {pickError && <p role="alert" className="text-danger">{pickError}</p>}

      {bitmap && src && (
        <div className="space-y-3">
          <div
            ref={frameRef}
            role="group"
            tabIndex={0}
            aria-label="Recorte: las flechas mueven la imagen; más y menos cambian el zoom"
            onKeyDown={onFrameKey}
            onPointerDown={onFrameDown}
            onPointerMove={onFrameMove}
            onPointerUp={() => { drag.current = null }}
            className="relative overflow-hidden rounded bg-ink touch-none cursor-move"
            style={{ width: FRAME, height: FRAME }}
          >
            <img
              src={src}
              alt=""
              draggable={false}
              className="absolute max-w-none select-none pointer-events-none"
              style={{
                width: bitmap.width * scale,
                height: bitmap.height * scale,
                left: FRAME / 2 - (bitmap.width * scale) / 2 + offset.x,
                top: FRAME / 2 - (bitmap.height * scale) / 2 + offset.y,
              }}
            />
          </div>
          <label className="block text-sm">
            Zoom
            <input type="range" className="block w-80 max-w-full" min={1} max={MAX_ZOOM} step={0.01} value={zoom} onChange={(e) => applyZoom(Number(e.target.value))} />
          </label>
          {!upload && (
            <button type="button" className="btn btn-primary" onClick={() => void startUpload()}>
              Procesar y subir
            </button>
          )}
        </div>
      )}

      {upload && (
        <div className="space-y-2">
          <p role="status">{STAGE_TEXT[upload.stage]}</p>
          <ProgressBar value={upload.progress} label="Progreso de la subida" />
          {upload.error && <p role="alert" className="text-danger">{upload.error}</p>}
          <div className="flex gap-3">
            {uploading && <button type="button" className="btn btn-small" onClick={() => jobRef.current?.cancel()}>Cancelar</button>}
            {(upload.stage === 'error' || upload.stage === 'cancelled') && <button type="button" className="btn btn-small" onClick={() => void jobRef.current?.start()}>Reintentar</button>}
          </div>
        </div>
      )}

      {patching && <p role="status">Actualizando el expediente…</p>}
      {conflictVersion !== null && mediaId !== null && (
        <div role="alert" className="text-warn space-y-2">
          <p>El expediente cambió mientras subías la imagen (ahora versión {conflictVersion}). Revisa y confirma para poner el fotocheck sobre esa versión.</p>
          <button type="button" className="btn btn-small" onClick={() => void applyBadge(mediaId)}>Aplicar sobre la versión actual</button>
        </div>
      )}
      {patchError && mediaId !== null && <ErrorNote error={patchError} onRetry={() => void applyBadge(mediaId)} />}
      {result?.badge && (
        <div role="status" className="space-y-2">
          <p className="text-accent">Fotocheck actualizado.</p>
          <img src={result.badge.url} alt={`Fotocheck de ${result.fullName}`} width={160} height={160} className="rounded" />
        </div>
      )}
      <Link to={`/refiners/${id}`}>Volver al expediente</Link>
    </section>
  )
}
