import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type Ref,
} from 'react'
import type { GridStore, WindowRange } from '../../grid/GridStore'
import { BINS, type Bin, type CellRef } from '../../lib/types'

export const CELL = 30
const OVERSCAN = 1
// El límite es 2 500 celdas en el DOM; se deja margen para la celda con foco.
const MAX_CELLS = 2400
const UNREFINED = 46
const BIN_CLASS: Record<number, string> = { 87: 'bin-w', 70: 'bin-f', 68: 'bin-d', 77: 'bin-m' }
const BIN_LABEL: Record<number, Bin> = { 87: 'WO', 70: 'FC', 68: 'DR', 77: 'MA' }

export interface GridHandle {
  goTo: (r: number, c: number) => void
  focus: () => void
  isVisible: (r: number, c: number) => boolean
  cursorLayer: () => HTMLDivElement | null
}

interface GridViewProps {
  store: GridStore
  initial: CellRef
  label: string
  canDrag: () => boolean
  onSelect: (r: number, c: number) => void
  onClear: () => void
  onBin: (bin: Bin) => void
  onPosition: (r: number, c: number) => void
  onPointerCell: (r: number, c: number) => void
  handleRef: Ref<GridHandle>
}

function renderCell(store: GridStore, r: number, c: number, focused: boolean): ReactElement {
  const index = store.cellIndex(r, c)
  const tile = store.tileAt(r, c)
  let className = 'cell'
  let text = ''
  let label = `Fila ${r + 1}, columna ${c + 1}, sin cargar`
  if (tile) {
    const i = (r - tile.originRow) * tile.cols + (c - tile.originCol)
    const tremor = tile.tremor[i]
    const bin = tile.bins[i]
    text = String(tile.digits[i])
    label = text
    if (bin !== UNREFINED) {
      className += ` ${BIN_CLASS[bin]}`
      label = `${text}, refinado en ${BIN_LABEL[bin]}`
    } else if (tremor >= store.rules.tremorThreshold) {
      const span = 101 - store.rules.tremorThreshold
      className += ` scary t${1 + Math.min(3, Math.floor(((tremor - store.rules.tremorThreshold) * 4) / span))}`
      label = `${text}, da miedo, temblor ${tremor}`
    }
  } else {
    className += ' cell-empty'
  }
  const selected = store.isSelected(index)
  const holder = store.holderOf(index)
  if (selected) className += ' cell-sel'
  if (holder) {
    className += ' cell-held'
    label += `, reservado por ${holder.displayName}`
  }
  return (
    <div
      key={c}
      role="gridcell"
      aria-colindex={c + 1}
      aria-selected={selected}
      aria-label={label}
      tabIndex={focused ? 0 : -1}
      data-r={r}
      data-c={c}
      className={className}
      style={{ left: c * CELL }}
      title={holder ? `Reservado por ${holder.displayName}` : undefined}
    >
      {text}
    </div>
  )
}

interface GridRowProps {
  store: GridStore
  r: number
  c0: number
  c1: number
  focusC: number
  /** Solo sirve para que memo detecte cambios en esta fila. */
  rev: number
}

const GridRow = memo(function GridRow({ store, r, c0, c1, focusC }: GridRowProps) {
  const cells: ReactElement[] = []
  if (focusC >= 0 && focusC < c0) cells.push(renderCell(store, r, focusC, true))
  for (let c = c0; c < c1; c++) cells.push(renderCell(store, r, c, c === focusC))
  if (focusC >= c1) cells.push(renderCell(store, r, focusC, true))
  return (
    <div role="row" aria-rowindex={r + 1} className="grid-row" style={{ top: r * CELL }}>
      {cells}
    </div>
  )
})

interface DragState {
  pointerId: number
  startX: number
  startY: number
  active: boolean
  overBin: HTMLElement | null
}

function cellFromTarget(target: EventTarget): CellRef | null {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-r]') : null
  if (!el) return null
  return { r: Number(el.dataset.r), c: Number(el.dataset.c) }
}

export const GridView = memo(function GridView({
  store,
  initial,
  label,
  canDrag,
  onSelect,
  onClear,
  onBin,
  onPosition,
  onPointerCell,
  handleRef,
}: GridViewProps) {
  useSyncExternalStore(store.subscribe, store.getVersion)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const cursorsRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const [win, setWin] = useState<WindowRange>({ r0: 0, r1: 0, c0: 0, c1: 0 })
  const [focus, setFocus] = useState<CellRef>(initial)
  const focusRef = useRef(focus)
  focusRef.current = focus
  const wantDomFocus = useRef(false)
  const raf = useRef(0)
  const dragRef = useRef<DragState | null>(null)
  const suppressClick = useRef(false)
  const lastPointerCell = useRef(-1)
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const compute = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const r0 = Math.max(0, Math.floor(el.scrollTop / CELL) - OVERSCAN)
    const c0 = Math.max(0, Math.floor(el.scrollLeft / CELL) - OVERSCAN)
    let r1 = Math.min(store.rows, Math.ceil((el.scrollTop + el.clientHeight) / CELL) + OVERSCAN)
    let c1 = Math.min(store.cols, Math.ceil((el.scrollLeft + el.clientWidth) / CELL) + OVERSCAN)
    while ((r1 - r0) * (c1 - c0) > MAX_CELLS) {
      if (r1 - r0 > c1 - c0) r1--
      else c1--
    }
    setWin((p) => (p.r0 === r0 && p.r1 === r1 && p.c0 === c0 && p.c1 === c1 ? p : { r0, r1, c0, c1 }))

    // La URL sigue a la posición con replace y con retardo: el scroll no llena el historial.
    if (positionTimer.current) clearTimeout(positionTimer.current)
    positionTimer.current = setTimeout(() => {
      onPosition(Math.floor(el.scrollTop / CELL), Math.floor(el.scrollLeft / CELL))
    }, 300)
  }, [store, onPosition])

  // Posición inicial tomada de la URL.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = initial.r * CELL
    el.scrollLeft = initial.c * CELL
    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (positionTimer.current) clearTimeout(positionTimer.current)
      cancelAnimationFrame(raf.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  // Se espera un instante para no pedir bloques que el scroll solo atraviesa.
  useEffect(() => {
    if (win.r1 === 0) return
    const t = setTimeout(() => store.setWindow(win), 60)
    return () => clearTimeout(t)
  }, [store, win])

  useLayoutEffect(() => {
    if (!wantDomFocus.current) return
    wantDomFocus.current = false
    gridRef.current?.querySelector<HTMLElement>(`[data-r="${focus.r}"][data-c="${focus.c}"]`)?.focus({ preventScroll: true })
  }, [focus, win])

  const revealCell = useCallback(
    (r: number, c: number) => {
      const el = scrollerRef.current
      if (!el) return
      if (r * CELL < el.scrollTop) el.scrollTop = r * CELL
      else if ((r + 1) * CELL > el.scrollTop + el.clientHeight) el.scrollTop = (r + 1) * CELL - el.clientHeight
      if (c * CELL < el.scrollLeft) el.scrollLeft = c * CELL
      else if ((c + 1) * CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = (c + 1) * CELL - el.clientWidth
      compute()
    },
    [compute],
  )

  const moveFocus = useCallback(
    (r: number, c: number) => {
      const next = { r: Math.min(store.rows - 1, Math.max(0, r)), c: Math.min(store.cols - 1, Math.max(0, c)) }
      wantDomFocus.current = true
      revealCell(next.r, next.c)
      setFocus(next)
      onPointerCell(next.r, next.c)
    },
    [store, revealCell, onPointerCell],
  )

  useImperativeHandle(
    handleRef,
    () => ({
      goTo: (r, c) => {
        const el = scrollerRef.current
        if (el) {
          el.scrollTop = Math.max(0, r * CELL - el.clientHeight / 2)
          el.scrollLeft = Math.max(0, c * CELL - el.clientWidth / 2)
        }
        moveFocus(r, c)
      },
      focus: () => {
        wantDomFocus.current = true
        setFocus((f) => ({ ...f }))
      },
      isVisible: (r, c) => {
        const el = scrollerRef.current
        if (!el) return false
        return (
          r * CELL >= el.scrollTop - CELL &&
          r * CELL <= el.scrollTop + el.clientHeight &&
          c * CELL >= el.scrollLeft - CELL &&
          c * CELL <= el.scrollLeft + el.clientWidth
        )
      },
      cursorLayer: () => cursorsRef.current,
    }),
    [moveFocus],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const { r, c } = focusRef.current
    const el = scrollerRef.current
    const page = Math.max(1, Math.floor((el?.clientHeight ?? CELL) / CELL) - 1)
    const binIndex = ['1', '2', '3', '4'].indexOf(e.key)
    if (binIndex >= 0) {
      e.preventDefault()
      onBin(BINS[binIndex])
      return
    }
    switch (e.key) {
      case 'ArrowUp': moveFocus(r - 1, c); break
      case 'ArrowDown': moveFocus(r + 1, c); break
      case 'ArrowLeft': moveFocus(r, c - 1); break
      case 'ArrowRight': moveFocus(r, c + 1); break
      case 'PageUp': moveFocus(r - page, c); break
      case 'PageDown': moveFocus(r + page, c); break
      case 'Home': moveFocus(e.ctrlKey ? 0 : r, 0); break
      case 'End': moveFocus(e.ctrlKey ? store.rows - 1 : r, store.cols - 1); break
      case 'Enter':
      case ' ': onSelect(r, c); break
      case 'Escape': onClear(); break
      default: return
    }
    e.preventDefault()
  }

  const onScroll = () => {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(compute)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const cell = cellFromTarget(e.target)
    if (!cell) return
    wantDomFocus.current = true
    setFocus(cell)
    if (store.isSelected(store.cellIndex(cell.r, cell.c)) && canDrag()) {
      dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, overBin: null }
    }
  }

  const positionGhost = (x: number, y: number) => {
    if (ghostRef.current) ghostRef.current.style.transform = `translate(${x + 12}px, ${y + 12}px)`
  }

  const setOverBin = (drag: DragState, target: HTMLElement | null) => {
    if (drag.overBin === target) return
    drag.overBin?.removeAttribute('data-over')
    target?.setAttribute('data-over', 'true')
    drag.overBin = target
  }

  const binAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-bin]') ?? null

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = scrollerRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      const r = Math.floor((e.clientY - rect.top + el.scrollTop) / CELL)
      const c = Math.floor((e.clientX - rect.left + el.scrollLeft) / CELL)
      const index = r * store.cols + c
      if (index !== lastPointerCell.current && r >= 0 && c >= 0 && r < store.rows && c < store.cols) {
        lastPointerCell.current = index
        onPointerCell(r, c)
      }
    }
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (!drag.active && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4) {
      drag.active = true
      e.currentTarget.setPointerCapture(e.pointerId)
      if (ghostRef.current) ghostRef.current.hidden = false
    }
    if (!drag.active) return
    positionGhost(e.clientX, e.clientY)
    setOverBin(drag, binAt(e.clientX, e.clientY))
  }

  const finishDrag = (e: PointerEvent<HTMLDivElement>, drop: boolean) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || !drag.active) return
    suppressClick.current = true
    if (ghostRef.current) ghostRef.current.hidden = true
    setOverBin(drag, null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const bin = drop ? binAt(e.clientX, e.clientY)?.dataset.bin : undefined
    if (bin) onBin(bin as Bin)
  }

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    const cell = cellFromTarget(e.target)
    if (cell) onSelect(cell.r, cell.c)
  }

  const rowNodes: ReactElement[] = []
  const rowEl = (r: number, c0: number, c1: number) => (
    <GridRow key={r} store={store} r={r} c0={c0} c1={c1} focusC={r === focus.r ? focus.c : -1} rev={store.rowRevs[r]} />
  )
  if (focus.r < win.r0) rowNodes.push(rowEl(focus.r, 0, 0))
  for (let r = win.r0; r < win.r1; r++) rowNodes.push(rowEl(r, win.c0, win.c1))
  if (focus.r >= win.r1) rowNodes.push(rowEl(focus.r, 0, 0))

  return (
    <>
      <div ref={scrollerRef} onScroll={onScroll} className="grid-scroller">
        <div
          ref={gridRef}
          role="grid"
          aria-label={label}
          aria-rowcount={store.rows}
          aria-colcount={store.cols}
          aria-multiselectable="true"
          aria-describedby="grid-help"
          className="grid-surface"
          style={{ width: store.cols * CELL, height: store.rows * CELL }}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finishDrag(e, true)}
          onPointerCancel={(e) => finishDrag(e, false)}
          onClick={onClick}
        >
          {rowNodes}
          <div ref={cursorsRef} className="absolute inset-0 pointer-events-none" aria-hidden="true" />
        </div>
      </div>
      <div ref={ghostRef} hidden className="drag-ghost" aria-hidden="true">
        Soltar en una caja
      </div>
    </>
  )
})
