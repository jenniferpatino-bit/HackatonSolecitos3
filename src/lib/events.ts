import { useEffect, useRef, useSyncExternalStore } from 'react'
import { backoff, env, isAbort, sleep, toApiError } from './http'
import { api, endSession } from './session'
import type { EventMap, StreamTicket } from './types'

/**
 * Stream de eventos compartido por todas las pestañas.
 * Un Web Lock elige una pestaña líder, la única con conexión; las demás reciben los eventos por
 * BroadcastChannel. Si la líder se cierra, el navegador libera el lock y otra pestaña la reemplaza.
 *
 * Se lee con fetch y no con EventSource porque EventSource oculta los comentarios `: hb`, y sin
 * ellos no se distingue una conexión muerta de una sin eventos.
 */
export type StreamStatus = 'off' | 'connecting' | 'open' | 'reconnecting' | 'superseded' | 'locked'

interface WireEvent {
  type: string
  id: number | null
  data: unknown
}

export type Contingency = EventMap['contingency.activated']

type BusMessage =
  | { t: 'event'; event: WireEvent }
  | { t: 'status'; status: StreamStatus }
  | { t: 'hello' }
  | { t: 'contingencies'; items: Contingency[] }

const DEAD_AFTER_MS = 45000
const SEEN_LIMIT = 2000

class EventHub {
  private bus = 'BroadcastChannel' in window ? new BroadcastChannel('lumon-events') : null
  private handlers = new Map<string, Set<(data: never) => void>>()
  private statusListeners = new Set<() => void>()
  private seen = new Set<number>()
  private seenOrder: number[] = []
  private lastId: number | null = null
  private run: AbortController | null = null
  private leader = false
  private status: StreamStatus = 'off'
  private contingencies: Contingency[] = []
  private userId: number | null = null

  constructor() {
    if (this.bus) this.bus.onmessage = (ev: MessageEvent<BusMessage>) => this.onBus(ev.data)
  }

  getStatus = (): StreamStatus => this.status
  getContingencies = (): Contingency[] => this.contingencies

  subscribeState = (l: () => void) => {
    this.statusListeners.add(l)
    return () => {
      this.statusListeners.delete(l)
    }
  }

  private notifyState(): void {
    this.statusListeners.forEach((l) => l())
  }

  on<K extends keyof EventMap>(type: K, handler: (data: EventMap[K]) => void): () => void {
    let set = this.handlers.get(type)
    if (!set) this.handlers.set(type, (set = new Set()))
    const stored = handler as (data: never) => void
    set.add(stored)
    return () => {
      set.delete(stored)
    }
  }

  start(userId: number): void {
    if (this.run) return
    this.userId = userId
    const run = new AbortController()
    this.run = run
    this.bus?.postMessage({ t: 'hello' } satisfies BusMessage)
    const lead = () => this.lead(run.signal)
    if ('locks' in navigator) {
      navigator.locks.request('lumon-events-leader', { signal: run.signal }, lead).catch(() => undefined)
    } else {
      void lead()
    }
  }

  stop(): void {
    this.run?.abort()
    this.run = null
    this.leader = false
    this.lastId = null
    this.contingencies = []
    this.setStatus('off', false)
  }

  /** Reintento manual tras `stream.superseded`. */
  restart(): void {
    if (this.userId === null) return
    const userId = this.userId
    const last = this.lastId
    this.stop()
    this.lastId = last
    this.start(userId)
  }

  private setStatus(status: StreamStatus, share = true): void {
    this.status = status
    this.notifyState()
    if (share && this.leader) this.bus?.postMessage({ t: 'status', status } satisfies BusMessage)
  }

  private onBus(msg: BusMessage): void {
    if (msg.t === 'event') {
      this.deliver(msg.event)
    } else if (msg.t === 'status') {
      if (!this.leader) this.setStatus(msg.status, false)
    } else if (msg.t === 'hello') {
      if (this.leader) this.bus?.postMessage({ t: 'status', status: this.status } satisfies BusMessage)
      if (this.contingencies.length) {
        this.bus?.postMessage({ t: 'contingencies', items: this.contingencies } satisfies BusMessage)
      }
    } else {
      msg.items.forEach((c) => this.addContingency(c))
    }
  }

  private addContingency(c: Contingency): void {
    if (c.userId !== this.userId || this.contingencies.some((x) => x.id === c.id)) return
    this.contingencies = [...this.contingencies, c]
    this.notifyState()
  }

  resolveContingency(id: number): void {
    if (!this.contingencies.some((c) => c.id === id)) return
    this.contingencies = this.contingencies.filter((c) => c.id !== id)
    this.notifyState()
  }

  /** Aplica un evento una sola vez, llegue por la red o por otra pestaña. */
  private deliver(event: WireEvent): void {
    if (event.id !== null) {
      if (this.seen.has(event.id)) return
      this.seen.add(event.id)
      this.seenOrder.push(event.id)
      if (this.seenOrder.length > SEEN_LIMIT) this.seen.delete(this.seenOrder.shift() as number)
      this.lastId = Math.max(this.lastId ?? 0, event.id)
    }
    if (event.type === 'contingency.activated') this.addContingency(event.data as Contingency)
    if (event.type === 'contingency.resolved') this.resolveContingency((event.data as EventMap['contingency.resolved']).id)
    if (event.type === 'session.revoked') {
      const { reason } = event.data as EventMap['session.revoked']
      endSession(reason === 'LOGOUT' ? 'La sesión se cerró.' : 'Tu sesión fue revocada. Por seguridad, vuelve a iniciar sesión.')
    }
    this.handlers.get(event.type)?.forEach((h) => h(event.data as never))
  }

  private emit(event: WireEvent): void {
    this.bus?.postMessage({ t: 'event', event } satisfies BusMessage)
    this.deliver(event)
  }

  /** Corre mientras esta pestaña tenga el lock de líder. */
  private async lead(signal: AbortSignal): Promise<void> {
    this.leader = true
    let attempt = 0
    while (!signal.aborted) {
      this.setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
      try {
        const outcome = await this.connect(signal, () => {
          attempt = 0
        })
        if (outcome.terminal) {
          this.setStatus(outcome.terminal)
          // Se conserva el lock: otra pestaña no debe insistir con la misma condición.
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
          return
        }
        this.setStatus('reconnecting')
        await sleep(Math.max(outcome.retryMs ?? 0, backoff(attempt++, 30000)), signal)
      } catch (e) {
        if (signal.aborted || isAbort(e)) return
        this.setStatus('reconnecting')
        await sleep(backoff(attempt++, 30000), signal).catch(() => undefined)
      }
    }
  }

  private async connect(signal: AbortSignal, onData: () => void): Promise<{ terminal?: StreamStatus; retryMs?: number }> {
    let ticket: string
    try {
      ticket = (await api<StreamTicket>('/events/tickets', { method: 'POST', retries: 0, signal })).ticket
    } catch (e) {
      if ((e as { code?: string }).code === 'CLEARANCE_REQUIRED') return { terminal: 'locked' }
      throw e
    }
    const params = new URLSearchParams({ ticket })
    if (this.lastId !== null) params.set('lastEventId', String(this.lastId))

    const conn = new AbortController()
    const stopConn = () => conn.abort()
    signal.addEventListener('abort', stopConn, { once: true })
    let watchdog = setTimeout(stopConn, DEAD_AFTER_MS)
    try {
      const res = await fetch(`${env.apiBase}/events/stream?${params}`, {
        headers: { Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: conn.signal,
      })
      if (!res.ok || !res.body) {
        const err = await toApiError(res)
        if (err.code === 'CLEARANCE_REQUIRED') return { terminal: 'locked' }
        if (err.code === 'SESSION_REVOKED') {
          endSession('Tu sesión fue revocada. Por seguridad, vuelve a iniciar sesión.')
          return { terminal: 'locked' }
        }
        return {}
      }
      this.setStatus('open')

      let superseded = false
      let retryMs: number | undefined
      const parser = new SseParser((event) => {
        if (event.type === 'stream.superseded') superseded = true
        this.emit(event)
      }, (ms) => {
        retryMs = ms
      })
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        clearTimeout(watchdog)
        watchdog = setTimeout(stopConn, DEAD_AFTER_MS)
        onData()
        parser.push(value)
        if (superseded) {
          void reader.cancel()
          return { terminal: 'superseded' }
        }
      }
      return { retryMs }
    } catch (e) {
      if (signal.aborted) throw e
      return {} // Corte de red o watchdog: el bucle reconecta con espera creciente.
    } finally {
      clearTimeout(watchdog)
      signal.removeEventListener('abort', stopConn)
      conn.abort()
    }
  }
}

/** Parser del formato text/event-stream (id, event, data, retry y comentarios). */
class SseParser {
  private buffer = ''
  private id: number | null = null
  private type = 'message'
  private data: string[] = []
  private onEvent: (e: WireEvent) => void
  private onRetry: (ms: number) => void

  constructor(onEvent: (e: WireEvent) => void, onRetry: (ms: number) => void) {
    this.onEvent = onEvent
    this.onRetry = onRetry
  }

  push(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split(/\r\n|\n|\r/)
    this.buffer = lines.pop() ?? ''
    lines.forEach((line) => this.line(line))
  }

  private line(line: string): void {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'id') this.id = Number(value)
    else if (field === 'event') this.type = value
    else if (field === 'data') this.data.push(value)
    else if (field === 'retry' && /^\d+$/.test(value)) this.onRetry(Number(value))
  }

  private dispatch(): void {
    if (this.data.length) {
      try {
        const id = this.id !== null && Number.isFinite(this.id) ? this.id : null
        this.onEvent({ type: this.type, id, data: JSON.parse(this.data.join('\n')) as unknown })
      } catch {
        // Un evento mal formado no debe tumbar la conexión.
      }
    }
    this.id = null
    this.type = 'message'
    this.data = []
  }
}

export const hub = new EventHub()

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(hub.subscribeState, hub.getStatus)
}

export function useContingencies(): Contingency[] {
  return useSyncExternalStore(hub.subscribeState, hub.getContingencies)
}

/** Suscribe un handler que siempre ve las props y el estado del último render. */
export function useLumonEvent<K extends keyof EventMap>(type: K, handler: (data: EventMap[K]) => void): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => hub.on(type, (data) => ref.current(data)), [type])
}
