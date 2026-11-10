import { ApiError, asApiError, backoff, isAbort } from '../lib/http'
import { api } from '../lib/session'
import type { Bin, CellRef, FileInfo, Rules, TileDto } from '../lib/types'

export const BIN_CHAR: Record<Bin, string> = { WO: 'W', FC: 'F', DR: 'D', MA: 'M' }
const UNREFINED = '.'.charCodeAt(0)

const MAX_IN_FLIGHT = 6
// El límite del servidor es 40 bloques cada 10 s por sesión; se deja un margen.
const BUDGET = 36
const BUDGET_WINDOW_MS = 10000

export interface LoadedTile {
  key: number
  originRow: number
  originCol: number
  rows: number
  cols: number
  digits: Uint8Array
  tremor: Uint8Array
  bins: Uint8Array
  version: number
}

export interface Group {
  key: number
  cells: CellRef[]
  size: number
  noise: boolean
  refined: boolean
  expected: Bin
}

export interface Holder {
  userId: number
  displayName: string
}

export interface WindowRange {
  r0: number
  r1: number
  c0: number
  c1: number
}

interface QueueEntry {
  key: number
  attempts: number
  notBefore: number
}

interface Waiter {
  resolve: () => void
  reject: (e: unknown) => void
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function asciiBytes(text: string, subtract = 0): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) - subtract
  return bytes
}

/**
 * Estado de la grilla fuera de React. Guarda los bloques en caché, coordina su descarga y lleva
 * una revisión por fila para que React vuelva a pintar solo las filas que cambiaron.
 */
export class GridStore {
  readonly fileId: number
  readonly rows: number
  readonly cols: number
  readonly tileSize: number
  readonly rules: Rules
  readonly tileRows: number
  readonly tileCols: number
  readonly rowRevs: Uint32Array

  private tiles = new Map<number, LoadedTile>()
  /** Celdas refinadas conocidas: se reaplican a un bloque que llegue con datos más viejos. */
  private marks = new Map<number, number>()
  private selection = new Set<number>()
  private holders = new Map<number, Holder>()

  private queue = new Map<number, QueueEntry>()
  private inFlight = new Map<number, AbortController>()
  private visible = new Set<number>()
  private pins = new Map<number, number>()
  private waiters = new Map<number, Waiter[]>()
  private stale = new Set<number>()
  private failed = new Set<number>()
  private starts: number[] = []
  private blockedUntil = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  private version = 0
  private listeners = new Set<() => void>()
  private notifyQueued = false

  constructor(file: FileInfo, rules: Rules) {
    this.fileId = file.id
    this.rows = file.rows
    this.cols = file.cols
    this.tileSize = file.tileSize
    this.rules = rules
    this.tileRows = Math.ceil(file.rows / file.tileSize)
    this.tileCols = Math.ceil(file.cols / file.tileSize)
    this.rowRevs = new Uint32Array(file.rows)
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion = (): number => this.version

  private notify(): void {
    this.version++
    if (this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      this.listeners.forEach((l) => l())
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.inFlight.forEach((c) => c.abort())
    this.inFlight.clear()
    this.queue.clear()
  }

  private tileKey(tileRow: number, tileCol: number): number {
    return tileRow * this.tileCols + tileCol
  }

  cellIndex(r: number, c: number): number {
    return r * this.cols + c
  }

  tileAt(r: number, c: number): LoadedTile | undefined {
    return this.tiles.get(this.tileKey(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)))
  }

  isSelected(index: number): boolean {
    return this.selection.has(index)
  }

  holderOf(index: number): Holder | undefined {
    return this.holders.get(index)
  }

  get pendingTiles(): number {
    return this.queue.size
  }

  private bumpRows(from: number, to: number): void {
    for (let r = from; r < to && r < this.rows; r++) this.rowRevs[r]++
  }

  private bumpIndexes(indexes: Iterable<number>): void {
    for (const index of indexes) this.rowRevs[Math.floor(index / this.cols)]++
  }

  setSelection(cells: CellRef[]): void {
    this.bumpIndexes(this.selection)
    this.selection = new Set(cells.map((x) => this.cellIndex(x.r, x.c)))
    this.bumpIndexes(this.selection)
    this.notify()
  }

  setClaims(claims: { userId: number; displayName: string; cells: CellRef[] }[]): void {
    this.bumpIndexes(this.holders.keys())
    this.holders = new Map()
    for (const claim of claims) {
      for (const cell of claim.cells) {
        this.holders.set(this.cellIndex(cell.r, cell.c), { userId: claim.userId, displayName: claim.displayName })
      }
    }
    this.bumpIndexes(this.holders.keys())
    this.notify()
  }

  /** Marca celdas como refinadas sin volver a pedir la grilla. Es idempotente. */
  applyMarks(cells: CellRef[], bin: Bin): void {
    const char = BIN_CHAR[bin].charCodeAt(0)
    for (const { r, c } of cells) {
      this.marks.set(this.cellIndex(r, c), char)
      const tile = this.tileAt(r, c)
      if (tile) tile.bins[(r - tile.originRow) * tile.cols + (c - tile.originCol)] = char
      this.rowRevs[r]++
    }
    this.notify()
  }

  /** Bloques a mostrar ahora. Lo que ya no se ve se cancela, salvo si lo necesita un grupo. */
  setWindow({ r0, r1, c0, c1 }: WindowRange): void {
    const next = new Set<number>()
    for (let tr = Math.floor(r0 / this.tileSize); tr <= Math.floor((r1 - 1) / this.tileSize); tr++) {
      for (let tc = Math.floor(c0 / this.tileSize); tc <= Math.floor((c1 - 1) / this.tileSize); tc++) {
        if (tr >= 0 && tc >= 0 && tr < this.tileRows && tc < this.tileCols) next.add(this.tileKey(tr, tc))
      }
    }
    this.visible = next
    this.dropUnwanted()
    next.forEach((key) => this.want(key))
    this.pump()
  }

  private dropUnwanted(): void {
    const wanted = (key: number) => this.visible.has(key) || this.pins.has(key)
    this.inFlight.forEach((controller, key) => {
      if (wanted(key)) return
      controller.abort()
      this.inFlight.delete(key)
    })
    this.queue.forEach((_entry, key) => {
      if (!wanted(key)) this.queue.delete(key)
    })
  }

  private want(key: number): void {
    if (this.queue.has(key) || this.inFlight.has(key) || this.failed.has(key)) return
    if (this.tiles.has(key) && !this.stale.has(key)) return
    this.queue.set(key, { key, attempts: 0, notBefore: 0 })
  }

  /** Vuelve a pedir bloques concretos (por ejemplo tras un 409), conservando lo pintado. */
  invalidate(tiles: [number, number][]): void {
    for (const [tr, tc] of tiles) {
      const key = this.tileKey(tr, tc)
      this.stale.add(key)
      if (this.visible.has(key)) this.want(key)
    }
    this.pump()
  }

  /** `stream.reset`: el estado local dejó de ser confiable. */
  invalidateAll(): void {
    this.tiles.forEach((_tile, key) => {
      if (this.visible.has(key)) {
        this.stale.add(key)
        this.want(key)
      } else {
        this.tiles.delete(key)
      }
    })
    this.pump()
  }

  /** Devuelve cuando el bloque esté en caché, aunque esté fuera de la vista. */
  private async ensure(key: number, signal: AbortSignal): Promise<void> {
    if (this.tiles.has(key)) return
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1)
    try {
      this.failed.delete(key)
      this.want(key)
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
        const list = this.waiters.get(key) ?? []
        list.push({ resolve, reject })
        this.waiters.set(key, list)
        this.pump()
      })
    } finally {
      const count = (this.pins.get(key) ?? 1) - 1
      if (count > 0) this.pins.set(key, count)
      else this.pins.delete(key)
      this.dropUnwanted()
    }
  }

  /** Único punto que lanza requests: respeta Retry-After, presupuesto y concurrencia. */
  private pump(): void {
    if (this.disposed) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const now = Date.now()
    if (now < this.blockedUntil) {
      if (this.queue.size) this.timer = setTimeout(() => this.pump(), this.blockedUntil - now + 20)
      return
    }
    this.starts = this.starts.filter((t) => now - t < BUDGET_WINDOW_MS)

    const ready = [...this.queue.values()]
      .filter((q) => q.notBefore <= now && !this.inFlight.has(q.key))
      .sort((a, b) => Number(this.pins.has(b.key)) - Number(this.pins.has(a.key)))
    for (const entry of ready) {
      if (this.inFlight.size >= MAX_IN_FLIGHT || this.starts.length >= BUDGET) break
      this.starts.push(now)
      void this.fetchTile(entry)
    }

    let wake = Infinity
    for (const q of this.queue.values()) {
      if (!this.inFlight.has(q.key)) wake = Math.min(wake, Math.max(q.notBefore, now))
    }
    if (wake === Infinity) return
    if (this.starts.length >= BUDGET) wake = Math.max(wake, this.starts[0] + BUDGET_WINDOW_MS)
    if (this.inFlight.size >= MAX_IN_FLIGHT) return // Al terminar una request se vuelve a llamar a pump.
    this.timer = setTimeout(() => this.pump(), Math.max(20, wake - now))
  }

  private async fetchTile(entry: QueueEntry): Promise<void> {
    const { key } = entry
    const controller = new AbortController()
    this.inFlight.set(key, controller)
    const tileRow = Math.floor(key / this.tileCols)
    const tileCol = key % this.tileCols
    try {
      const dto = await api<TileDto>(`/files/${this.fileId}/tiles/${tileRow}/${tileCol}`, {
        signal: controller.signal,
        retries: 0,
        timeoutMs: 20000,
      })
      if (this.inFlight.get(key) !== controller) return
      this.inFlight.delete(key)
      this.queue.delete(key)
      this.ingest(key, dto)
      this.settle(key)
    } catch (e) {
      if (isAbort(e) || this.inFlight.get(key) !== controller) return
      this.inFlight.delete(key)
      this.onTileError(entry, asApiError(e))
    }
    this.pump()
  }

  private onTileError(entry: QueueEntry, err: ApiError): void {
    const now = Date.now()
    if (err.status === 429) {
      this.blockedUntil = Math.max(this.blockedUntil, now + (err.retryAfterMs ?? 2000))
      entry.notBefore = this.blockedUntil
    } else if (err.status === 0 || err.status >= 500) {
      entry.attempts++
      entry.notBefore = now + Math.max(err.retryAfterMs ?? 0, backoff(entry.attempts))
    } else {
      this.queue.delete(entry.key)
      this.failed.add(entry.key)
      this.settle(entry.key, err)
    }
  }

  private settle(key: number, error?: unknown): void {
    const list = this.waiters.get(key)
    if (!list) return
    this.waiters.delete(key)
    list.forEach((w) => (error === undefined ? w.resolve() : w.reject(error)))
  }

  private ingest(key: number, dto: TileDto): void {
    this.stale.delete(key)
    const existing = this.tiles.get(key)
    if (existing && dto.version < existing.version) return
    const bins = asciiBytes(dto.bins)
    for (let i = 0; i < bins.length; i++) {
      if (bins[i] !== UNREFINED) continue
      const r = dto.originRow + Math.floor(i / dto.cols)
      const c = dto.originCol + (i % dto.cols)
      const mark = this.marks.get(this.cellIndex(r, c))
      if (mark !== undefined) bins[i] = mark
    }
    this.tiles.set(key, {
      key,
      originRow: dto.originRow,
      originCol: dto.originCol,
      rows: dto.rows,
      cols: dto.cols,
      digits: asciiBytes(dto.values, 48),
      tremor: decodeBase64(dto.tremor),
      bins,
      version: dto.version,
    })
    this.bumpRows(dto.originRow, dto.originRow + dto.rows)
    this.notify()
  }

  /**
   * Componente conexo de la celda: búsqueda en profundidad sobre el caché que, al llegar a un
   * bloque sin cargar, aparta esas celdas, lo pide y continúa.
   */
  async findGroup(startR: number, startC: number, signal: AbortSignal): Promise<Group | null> {
    const { tremorThreshold: threshold, connectivity } = this.rules
    const deltas =
      connectivity === 8
        ? [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
        : [[-1, 0], [0, -1], [0, 1], [1, 0]]
    const start = this.cellIndex(startR, startC)
    const seen = new Set<number>([start])
    let stack = [start]
    const cells: CellRef[] = []
    let sum = 0
    let maxDigit = 0
    let refined = false

    while (stack.length) {
      const deferred: number[] = []
      const missing = new Set<number>()
      while (stack.length) {
        const index = stack.pop() as number
        const r = Math.floor(index / this.cols)
        const c = index % this.cols
        const tile = this.tileAt(r, c)
        if (!tile) {
          deferred.push(index)
          missing.add(this.tileKey(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)))
          continue
        }
        const i = (r - tile.originRow) * tile.cols + (c - tile.originCol)
        if (tile.tremor[i] < threshold) continue
        cells.push({ r, c })
        sum += tile.digits[i]
        maxDigit = Math.max(maxDigit, tile.digits[i])
        if (tile.bins[i] !== UNREFINED) refined = true
        for (const [dr, dc] of deltas) {
          const nr = r + dr
          const nc = c + dc
          if (nr < 0 || nc < 0 || nr >= this.rows || nc >= this.cols) continue
          const next = this.cellIndex(nr, nc)
          if (seen.has(next)) continue
          seen.add(next)
          stack.push(next)
        }
      }
      if (missing.size) await Promise.all([...missing].map((key) => this.ensure(key, signal)))
      stack = deferred
    }

    if (!cells.length) return null
    const { strategy, order } = this.rules.binning
    const size = cells.length
    return {
      key: Math.min(...cells.map((x) => this.cellIndex(x.r, x.c))),
      cells,
      size,
      noise: size < this.rules.minGroupSize || size > this.rules.maxGroupSize,
      refined,
      expected: order[(strategy === 'DIGIT_SUM_MOD' ? sum : maxDigit) % 4],
    }
  }
}
