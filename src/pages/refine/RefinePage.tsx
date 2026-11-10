import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { ErrorNote, ProgressBar, Spinner } from '../../components/ui'
import { FloorClient, type ClaimResult, type FloorMember, type FloorStatus } from '../../grid/FloorClient'
import { GridStore, type Group } from '../../grid/GridStore'
import { useLumonEvent } from '../../lib/events'
import { useFetch, intParam } from '../../lib/hooks'
import { ApiError, asApiError, backoff, isAbort, sleep } from '../../lib/http'
import { api, can, useAuth } from '../../lib/session'
import { BINS, type Bin, type CellRef, type FileInfo, type Me, type Progress, type RefineResult, type Rules } from '../../lib/types'
import { CELL, GridView, type GridHandle } from './GridView'

type ClaimState = 'none' | 'pending' | 'granted' | 'denied'

const FLOOR_LABEL: Record<FloorStatus, string> = {
  connecting: 'Conectando',
  open: 'Conectado',
  reconnecting: 'Reconectando',
  closed: 'Sin conexión',
}

/** Reintenta la misma intención con la misma Idempotency-Key: nunca refina dos veces. */
async function postRefinement(fileId: number, key: string, bin: Bin, cells: CellRef[]): Promise<RefineResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<RefineResult>(`/files/${fileId}/refinements`, {
        method: 'POST',
        retries: 0,
        timeoutMs: 20000,
        headers: { 'Idempotency-Key': key },
        body: { bin, cells },
      })
    } catch (e) {
      const err = asApiError(e)
      const transient = err.status === 0 || err.status === 429 || err.status >= 500
      if (!transient || attempt >= 7) throw err
      await sleep(Math.max(err.retryAfterMs ?? 0, backoff(attempt)))
    }
  }
}

function refineErrorText(err: ApiError, expected: Bin): string {
  const details = err.details as { reason?: string; missing?: number; mistakes?: number; holder?: { displayName: string } } | null
  switch (err.code) {
    case 'WRONG_BIN':
      return `Caja incorrecta: Lumon anotó un error (van ${details?.mistakes ?? '?'}). Según las reglas corresponde ${expected}.`
    case 'ALREADY_REFINED':
      return 'Otra persona ya refinó este grupo. Actualizamos los bloques: elige otro.'
    case 'GROUP_CLAIMED':
      return `${details?.holder?.displayName ?? 'Otro refinador'} tiene este grupo reservado. Espera a que lo libere o elige otro.`
    case 'GROUP_INVALID':
      if (details?.reason === 'INCOMPLETE') return `Al grupo le faltan ${details.missing ?? 'algunas'} celdas. Vuelve a seleccionarlo.`
      if (details?.reason === 'SIZE_OUT_OF_RANGE') return 'Este grupo es ruido: no se puede refinar.'
      if (details?.reason === 'NOT_CONNECTED') return 'Las celdas no forman un solo grupo. Vuelve a seleccionarlo.'
      return 'El grupo ya no es válido. Vuelve a seleccionarlo.'
    case 'FORBIDDEN':
      return 'Tu cuenta no tiene permiso para refinar.'
    default:
      return err.status === 0 || err.status >= 500 ? 'No se pudo confirmar el refinamiento. Reintenta: no se refinará dos veces.' : err.message
  }
}

function Presence({ members, meId, onGo, isVisible }: { members: FloorMember[]; meId: number; onGo: (r: number, c: number) => void; isVisible: (r: number, c: number) => boolean }) {
  // Las posiciones cambian sin parar: la lista se refresca a su ritmo, sin tocar la grilla.
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const t = setInterval(tick, 500)
    return () => clearInterval(t)
  }, [])
  if (!members.length) return <p className="text-sm text-dim">Nadie conectado.</p>
  return (
    <ul className="space-y-1 text-sm">
      {members.map((m) => {
        const located = m.r !== null && m.c !== null
        const away = located && !isVisible(m.r as number, m.c as number)
        return (
          <li key={m.userId} className="flex items-center justify-between gap-2">
            <span className="truncate">
              {m.displayName}
              {m.userId === meId ? ' (tú)' : ''}
            </span>
            {away && m.userId !== meId && (
              <button type="button" className="btn btn-small" onClick={() => onGo(m.r as number, m.c as number)}>
                Fuera de vista: ir
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Workspace({ file, rules, me }: { file: FileInfo; rules: Rules; me: Me }) {
  const [params, setParams] = useSearchParams()
  const setParamsRef = useRef(setParams)
  setParamsRef.current = setParams
  const [store] = useState(() => new GridStore(file, rules))
  const [initial] = useState<CellRef>(() => ({
    r: Math.min(file.rows - 1, intParam(params.get('r'), 0, 0)),
    c: Math.min(file.cols - 1, intParam(params.get('c'), 0, 0)),
  }))
  useSyncExternalStore(store.subscribe, store.getVersion)

  const gridRef = useRef<GridHandle>(null)
  const floorRef = useRef<FloorClient | null>(null)
  const cursors = useRef(new Map<number, HTMLDivElement>())

  const [group, setGroupState] = useState<Group | null>(null)
  const groupRef = useRef<Group | null>(null)
  const anchorRef = useRef<CellRef | null>(null)
  const [resolving, setResolving] = useState(false)
  const selectAbort = useRef<AbortController | null>(null)
  const [claim, setClaim] = useState<ClaimState>('none')
  const [claimText, setClaimText] = useState<string | null>(null)
  const claimTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wantsReclaim = useRef(false)

  const [busy, setBusy] = useState<Bin | null>(null)
  const busyRef = useRef(false)
  const intents = useRef(new Map<string, string>())
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [retryBin, setRetryBin] = useState<Bin | null>(null)

  const [progress, setProgress] = useState<Progress>(file.progress)
  const [mistakes, setMistakes] = useState(file.mistakes)
  const [completed, setCompleted] = useState(file.status === 'COMPLETE')
  const [floorStatus, setFloorStatus] = useState<FloorStatus>(me.clearance.granted ? 'connecting' : 'closed')
  const [floorText, setFloorText] = useState<string | null>(me.clearance.granted ? null : 'El Piso de Pruebas sigue cerrado: se puede refinar sin piso compartido.')
  const [members, setMembers] = useState<FloorMember[]>([])

  const mergeProgress = useCallback((next: Progress) => {
    setProgress((p) => (next.overall >= p.overall ? next : p))
  }, [])

  const setGroup = useCallback((g: Group | null) => {
    groupRef.current = g
    setGroupState(g)
  }, [])

  const stopClaimTimer = () => {
    if (claimTimer.current) clearTimeout(claimTimer.current)
    claimTimer.current = null
  }

  const requestClaim = useCallback(() => {
    const anchor = anchorRef.current
    const floor = floorRef.current
    stopClaimTimer()
    setClaimText(null)
    if (!anchor || !floor?.isOpen) {
      setClaim('none')
      return
    }
    setClaim('pending')
    floor.claim(anchor.r, anchor.c)
    // Con caos la respuesta puede demorar; refinar no debe quedar bloqueado por eso.
    claimTimer.current = setTimeout(() => setClaim((s) => (s === 'pending' ? 'none' : s)), 4000)
  }, [])

  const clearSelection = useCallback(() => {
    selectAbort.current?.abort()
    selectAbort.current = null
    setResolving(false)
    stopClaimTimer()
    wantsReclaim.current = false
    anchorRef.current = null
    store.setSelection([])
    setGroup(null)
    setClaim('none')
    setClaimText(null)
    setRetryBin(null)
    floorRef.current?.release()
  }, [store, setGroup])

  const select = useCallback(
    async (r: number, c: number) => {
      selectAbort.current?.abort()
      const controller = new AbortController()
      selectAbort.current = controller
      setResolving(true)
      setMessage(null)
      try {
        const found = await store.findGroup(r, c, controller.signal)
        if (controller.signal.aborted) return
        setResolving(false)
        if (!found) {
          clearSelection()
          return
        }
        if (groupRef.current?.key === found.key) return
        anchorRef.current = { r, c }
        setRetryBin(null)
        store.setSelection(found.cells)
        setGroup(found)
        if (found.noise || found.refined) {
          floorRef.current?.release()
          setClaim('none')
          setClaimText(null)
        } else {
          requestClaim()
        }
      } catch (e) {
        if (isAbort(e) || controller.signal.aborted) return
        setResolving(false)
        setMessage({ kind: 'error', text: 'No se pudo completar el grupo. Intenta de nuevo.' })
      }
    },
    [store, setGroup, requestClaim, clearSelection],
  )

  // Piso compartido.
  useEffect(() => {
    if (!me.clearance.granted) return
    const drawCursor = (userId: number, r: number, c: number) => {
      if (userId === me.id) return
      const layer = gridRef.current?.cursorLayer()
      if (!layer) return
      let el = cursors.current.get(userId)
      if (!el) {
        el = document.createElement('div')
        el.className = 'remote-cursor'
        el.style.borderColor = `hsl(${(userId * 67) % 360} 90% 65%)`
        const name = document.createElement('span')
        name.textContent = floor.positionOf(userId)?.displayName ?? 'Refinador'
        el.appendChild(name)
        layer.appendChild(el)
        cursors.current.set(userId, el)
      }
      el.style.transform = `translate(${c * CELL}px, ${r * CELL}px)`
    }
    const floor = new FloorClient(file.id, {
      onStatus: (status, text) => {
        setFloorStatus(status)
        setFloorText(text)
        if (status === 'open' && wantsReclaim.current && anchorRef.current) {
          wantsReclaim.current = false
          requestClaim()
        }
      },
      onMembers: setMembers,
      onClaims: (claims) => store.setClaims(claims),
      onCursor: drawCursor,
      onCursorsReset: (list) => {
        cursors.current.forEach((el) => el.remove())
        cursors.current.clear()
        list.forEach((m) => {
          if (m.r !== null && m.c !== null) drawCursor(m.userId, m.r, m.c)
        })
      },
      onClaimResult: (result: ClaimResult) => {
        stopClaimTimer()
        if (result.granted) {
          setClaim('granted')
          setClaimText(null)
        } else {
          setClaim('denied')
          setClaimText(
            result.reason === 'HELD'
              ? `${result.holder?.displayName ?? 'Otro refinador'} tiene este grupo reservado. Reintenta cuando lo libere o elige otro.`
              : 'Este grupo ya no se puede reservar: es ruido o ya fue refinado.',
          )
        }
      },
      onClaimLost: () => {
        const g = groupRef.current
        if (!g || g.noise || g.refined) return
        if (floor.isOpen) requestClaim()
        else {
          wantsReclaim.current = true
          setClaim('none')
        }
      },
    })
    floorRef.current = floor
    const layer = cursors.current
    return () => {
      floor.close()
      floorRef.current = null
      layer.forEach((el) => el.remove())
      layer.clear()
    }
  }, [file.id, me.clearance.granted, me.id, store, requestClaim])

  useEffect(() => () => store.dispose(), [store])

  useLumonEvent('refinement.created', (d) => {
    if (d.fileId !== file.id) return
    store.applyMarks(d.cells, d.bin)
    mergeProgress(d.progress)
    const current = groupRef.current
    if (current && !busyRef.current && d.cells.some((x) => store.cellIndex(x.r, x.c) === current.key)) {
      clearSelection()
      setMessage({ kind: 'error', text: `${d.refinedBy.displayName} acaba de refinar este grupo.` })
    }
  })
  useLumonEvent('file.completed', (d) => {
    if (d.fileId === file.id) setCompleted(true)
  })
  useLumonEvent('stream.reset', () => {
    store.invalidateAll()
    void api<FileInfo>(`/files/${file.id}`).then((f) => {
      mergeProgress(f.progress)
      setMistakes((m) => Math.max(m, f.mistakes))
      if (f.status === 'COMPLETE') setCompleted(true)
    }, () => undefined)
  })

  const heldBy = group?.cells.map((x) => store.holderOf(store.cellIndex(x.r, x.c))).find((h) => h && h.userId !== me.id)
  const allowed = can(me, 'files:refine')
  const canDrop = !!group && !group.noise && !group.refined && !heldBy && claim !== 'pending' && claim !== 'denied' && allowed && !busy
  const canDropRef = useRef(canDrop)
  canDropRef.current = canDrop

  const refine = async (bin: Bin) => {
    const g = groupRef.current
    if (!g || busyRef.current || !canDropRef.current) return
    busyRef.current = true
    setBusy(bin)
    setMessage(null)
    setRetryBin(null)
    // Una clave por intención (grupo + caja): repetirla nunca cuenta dos veces.
    const intent = `${g.key}|${bin}`
    let key = intents.current.get(intent)
    if (!key) {
      key = crypto.randomUUID()
      intents.current.set(intent, key)
    }
    try {
      const result = await postRefinement(file.id, key, bin, g.cells)
      store.applyMarks(g.cells, bin)
      mergeProgress(result.file.progress)
      setMistakes((m) => Math.max(m, result.file.mistakes))
      floorRef.current?.forgetClaim()
      if (groupRef.current?.key === g.key) clearSelection()
      setMessage({ kind: 'ok', text: `Grupo de ${result.size} celdas refinado en ${result.bin}.` })
      if (result.file.status === 'COMPLETE') setCompleted(true)
      gridRef.current?.focus()
    } catch (e) {
      const err = asApiError(e)
      setMessage({ kind: 'error', text: refineErrorText(err, g.expected) })
      if (err.code === 'WRONG_BIN') setMistakes((m) => Math.max(m, (err.details as { mistakes?: number } | null)?.mistakes ?? m))
      if (err.code === 'ALREADY_REFINED') {
        store.invalidate((err.details as { tiles?: [number, number][] } | null)?.tiles ?? [])
        floorRef.current?.forgetClaim()
        clearSelection()
      } else if (err.status === 0 || err.status >= 500) {
        setRetryBin(bin)
      }
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }
  const refineRef = useRef(refine)
  refineRef.current = refine

  const onBin = useCallback((bin: Bin) => void refineRef.current(bin), [])
  const canDrag = useCallback(() => canDropRef.current, [])
  const onSelect = useCallback((r: number, c: number) => void select(r, c), [select])
  const onPosition = useCallback((r: number, c: number) => {
    setParamsRef.current(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('r', String(r))
        next.set('c', String(c))
        return next
      },
      { replace: true },
    )
  }, [])
  const onPointerCell = useCallback((r: number, c: number) => floorRef.current?.moveCursor(r, c), [])
  const goTo = useCallback((r: number, c: number) => gridRef.current?.goTo(r, c), [])
  const isVisible = useCallback((r: number, c: number) => gridRef.current?.isVisible(r, c) ?? false, [])

  if (completed) {
    return (
      <section className="card max-w-xl mx-auto text-center space-y-4">
        <h1 className="text-2xl font-semibold">Archivo completado</h1>
        <p>{file.name} llegó al 100 %. Errores anotados: {mistakes}.</p>
        <Link className="btn btn-primary inline-block" to="/files">
          Volver a los archivos
        </Link>
      </section>
    )
  }

  let summary = 'Elige una celda que dé miedo para seleccionar su grupo.'
  if (resolving) summary = 'Buscando el grupo completo…'
  else if (group?.refined) summary = `Grupo de ${group.size} celdas ya refinado.`
  else if (group?.noise) summary = `Grupo de ${group.size} celdas: es ruido y no se puede refinar.`
  else if (group) summary = `Grupo de ${group.size} celdas. Caja según las reglas: ${group.expected}.`

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">{file.name}</h1>
        <p className="text-sm text-dim">
          {file.rows} × {file.cols} · Errores: {mistakes} · Progreso: {Math.round(progress.overall * 100)} %
          {store.pendingTiles > 0 ? ` · Cargando ${store.pendingTiles} bloques` : ''}
        </p>
      </header>
      <p id="grid-help" className="sr-only">
        Flechas, Inicio, Fin, Re Pág y Av Pág mueven el foco. Enter selecciona el grupo. Las teclas 1 a 4 lo llevan a WO, FC, DR o MA. Escape cancela.
      </p>
      <div className="flex flex-col lg:flex-row gap-3">
        <GridView
          store={store}
          initial={initial}
          label={`Grilla del archivo ${file.name}`}
          canDrag={canDrag}
          onSelect={onSelect}
          onClear={clearSelection}
          onBin={onBin}
          onPosition={onPosition}
          onPointerCell={onPointerCell}
          handleRef={gridRef}
        />
        <aside className="lg:w-72 shrink-0 space-y-3">
          <section className="card space-y-2" aria-label="Grupo seleccionado">
            <p role="status" className="text-sm">{summary}</p>
            {heldBy && <p className="text-sm text-warn">Reservado por {heldBy.displayName}: no se puede llevar a una caja.</p>}
            {claim === 'pending' && <p className="text-sm text-dim">Reservando el grupo…</p>}
            {claimText && (
              <div className="text-sm text-warn space-y-1">
                <p>{claimText}</p>
                <button type="button" className="btn btn-small" onClick={requestClaim}>
                  Reintentar reserva
                </button>
              </div>
            )}
            {group && (
              <button type="button" className="btn btn-small" onClick={clearSelection}>
                Cancelar selección
              </button>
            )}
          </section>

          <section className="card space-y-2" aria-label="Cajas">
            <h2 className="font-semibold">Cajas</h2>
            {!allowed && <p className="text-sm text-dim">Tu cuenta solo puede mirar.</p>}
            {BINS.map((bin, i) => (
              <button key={bin} type="button" data-bin={bin} disabled={!canDrop} className="bin-drop" onClick={() => onBin(bin)}>
                <span className="flex justify-between text-sm">
                  <span>
                    {i + 1}. {bin}
                    {busy === bin ? ' · enviando…' : ''}
                  </span>
                  <span>{Math.round(progress[bin] * 100)} %</span>
                </span>
                <ProgressBar value={progress[bin]} label={`Progreso de ${bin}`} />
              </button>
            ))}
            {message && (
              <p role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-danger' : 'text-accent'}`}>
                {message.text}
              </p>
            )}
            {retryBin && (
              <button type="button" className="btn btn-small" onClick={() => onBin(retryBin)}>
                Reintentar en {retryBin}
              </button>
            )}
          </section>

          <section className="card space-y-2" aria-label="Piso compartido">
            <h2 className="font-semibold">
              Piso compartido: <span className={floorStatus === 'open' ? 'text-accent' : 'text-warn'}>{FLOOR_LABEL[floorStatus]}</span>
            </h2>
            {floorText && <p className="text-sm text-dim">{floorText}</p>}
            <Presence members={members} meId={me.id} onGo={goTo} isVisible={isVisible} />
          </section>
        </aside>
      </div>
    </div>
  )
}

export default function RefinePage() {
  const { id } = useParams()
  const { me } = useAuth()
  const fileId = /^\d{1,9}$/.test(id ?? '') ? Number(id) : 0
  const { data, error, reload } = useFetch(
    async (signal) => {
      if (!fileId) throw new ApiError(404, 'NOT_FOUND', 'Ese archivo no existe.')
      const [file, rules] = await Promise.all([api<FileInfo>(`/files/${fileId}`, { signal }), api<Rules>(`/files/${fileId}/rules`, { signal })])
      return { file, rules }
    },
    [fileId],
  )
  if (error) return <ErrorNote error={error} onRetry={error.status === 404 ? undefined : reload} />
  if (!data || !me || data.file.id !== fileId) return <Spinner label="Abriendo el archivo…" />
  return <Workspace key={data.file.id} file={data.file} rules={data.rules} me={me} />
}
