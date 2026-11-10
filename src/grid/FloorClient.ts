import { asApiError, backoff, env, isAbort, sleep } from '../lib/http'
import { api } from '../lib/session'
import type { CellRef, StreamTicket } from '../lib/types'

export type FloorStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface FloorMember {
  userId: number
  displayName: string
  r: number | null
  c: number | null
}

export interface FloorClaim {
  claimId: string
  userId: number
  displayName: string
  cells: CellRef[]
  expiresAt: string
}

type HolderInfo = { userId: number; displayName: string } | null

type ServerMessage =
  | { type: 'snapshot'; seq: number; members: FloorMember[]; claims: FloorClaim[] }
  | { type: 'member.joined' | 'member.left'; seq: number; userId: number; displayName: string }
  | { type: 'cursor'; userId: number; r: number; c: number }
  | ({ type: 'claim.granted'; seq: number; requestId: string } & FloorClaim)
  | ({ type: 'claim.updated'; seq: number } & FloorClaim)
  | { type: 'claim.released'; seq?: number; claimId: string }
  | { type: 'claim.denied'; requestId: string; reason: 'HELD' | 'NOT_A_GROUP'; holder: HolderInfo }
  | { type: 'pong'; t: number }

export type ClaimResult = { granted: true } | { granted: false; reason: 'HELD' | 'NOT_A_GROUP'; holder: HolderInfo }

export interface FloorHandlers {
  onStatus: (status: FloorStatus, message: string | null) => void
  onMembers: (members: FloorMember[]) => void
  onClaims: (claims: FloorClaim[]) => void
  onCursor: (userId: number, r: number, c: number) => void
  onCursorsReset: (members: FloorMember[]) => void
  onClaimResult: (result: ClaimResult) => void
  /** La reserva propia se perdió (venció o se cortó la conexión). */
  onClaimLost: () => void
}

const PING_MS = 10000
const RENEW_MS = 5000
const CURSOR_MS = 120

/** Piso compartido: una conexión por pestaña, con un ticket nuevo en cada intento. */
export class FloorClient {
  private fileId: number
  private h: FloorHandlers
  private ws: WebSocket | null = null
  private closedByUser = new AbortController()
  private attempt = 0
  private ticketFailures = 0
  private lastSeq = 0
  private resyncing = false
  private members = new Map<number, FloorMember>()
  private claims = new Map<string, FloorClaim>()
  private pendingRequest: string | null = null
  private myClaimId: string | null = null
  private requestCounter = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private renewTimer: ReturnType<typeof setInterval> | null = null
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  private lastCursorAt = 0
  private nextCursor: CellRef | null = null
  private missedPongs = 0
  private awaitingPong = false

  constructor(fileId: number, handlers: FloorHandlers) {
    this.fileId = fileId
    this.h = handlers
    void this.connectLoop(0)
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  positionOf(userId: number): FloorMember | undefined {
    return this.members.get(userId)
  }

  close(): void {
    this.release()
    this.closedByUser.abort()
    this.teardown()
    this.ws?.close(1000)
    this.ws = null
  }

  private teardown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.renewTimer) clearInterval(this.renewTimer)
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    this.pingTimer = this.renewTimer = this.cursorTimer = null
  }

  private async connectLoop(delayMs: number): Promise<void> {
    const { signal } = this.closedByUser
    try {
      if (delayMs) await sleep(delayMs, signal)
      this.h.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting', null)
      const { ticket } = await api<StreamTicket>('/floor/tickets', {
        method: 'POST',
        body: { fileId: this.fileId },
        retries: 2,
        signal,
      })
      if (signal.aborted) return
      this.open(ticket)
    } catch (e) {
      if (signal.aborted || isAbort(e)) return
      const err = asApiError(e)
      if (err.code === 'CLEARANCE_REQUIRED') return this.finish('El Piso de Pruebas sigue cerrado: se puede refinar sin piso compartido.')
      if (err.status === 401 || err.status === 403 || err.status === 404) return this.finish('No se pudo entrar al piso compartido.')
      void this.connectLoop(backoff(this.attempt++, 30000))
    }
  }

  private finish(message: string): void {
    this.dropRemoteState()
    this.h.onStatus('closed', message)
  }

  /** Sin conexión no hay presencia ni reservas confiables. */
  private dropRemoteState(): void {
    this.members.clear()
    this.claims.clear()
    this.h.onMembers([])
    this.h.onClaims([])
    this.h.onCursorsReset([])
    this.pendingRequest = null
    if (this.myClaimId) {
      this.myClaimId = null
      this.h.onClaimLost()
    }
  }

  private open(ticket: string): void {
    const ws = new WebSocket(`${env.wsBase}/floor/ws?ticket=${encodeURIComponent(ticket)}`)
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.h.onStatus('open', null)
      this.missedPongs = 0
      this.awaitingPong = false
      this.pingTimer = setInterval(() => this.ping(ws), PING_MS)
      this.ping(ws)
    }
    ws.onmessage = (ev) => {
      if (this.ws === ws && typeof ev.data === 'string') this.onMessage(JSON.parse(ev.data) as ServerMessage)
    }
    ws.onclose = (ev) => {
      if (this.ws === ws) this.onClosed(ev.code)
    }
  }

  private ping(ws: WebSocket): void {
    if (this.awaitingPong && ++this.missedPongs >= 2) {
      // Conexión muerta: se suelta sin esperar a un onclose que puede tardar.
      this.ws = null
      ws.onclose = null
      ws.close()
      this.onClosed(1006)
      return
    }
    this.awaitingPong = true
    this.send({ type: 'ping', t: Date.now() })
  }

  private onClosed(code: number): void {
    this.teardown()
    this.ws = null
    if (this.closedByUser.signal.aborted) return
    this.dropRemoteState()

    const definitive: Record<number, string> = {
      4400: 'El piso compartido rechazó un mensaje de la app. Recarga la página.',
      4403: 'Este origen no tiene permiso para entrar al piso compartido.',
      4404: 'El archivo ya no existe en el piso compartido.',
      4423: 'El Piso de Pruebas sigue cerrado: se puede refinar sin piso compartido.',
    }
    if (definitive[code]) return this.finish(definitive[code])
    if (code === 4401 && ++this.ticketFailures >= 2) return this.finish('No se pudo validar el acceso al piso compartido.')

    let delay = backoff(this.attempt++, 30000)
    if (code === 4429) delay = Math.max(delay, 10000)
    if (code === 4401 || code === 4408) delay = 300
    this.h.onStatus('reconnecting', null)
    void this.connectLoop(delay)
  }

  private send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  /** Limitado a menos de 10 por segundo. Una pestaña oculta no envía nada. */
  moveCursor(r: number, c: number): void {
    if (document.hidden || !this.isOpen) return
    this.nextCursor = { r, c }
    if (this.cursorTimer) return
    const wait = Math.max(0, this.lastCursorAt + CURSOR_MS - Date.now())
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null
      if (!this.nextCursor || document.hidden) return
      this.lastCursorAt = Date.now()
      this.send({ type: 'cursor', ...this.nextCursor })
      this.nextCursor = null
    }, wait)
  }

  claim(r: number, c: number): void {
    const requestId = `c-${++this.requestCounter}`
    this.pendingRequest = requestId
    this.send({ type: 'claim', requestId, r, c })
  }

  release(): void {
    this.pendingRequest = null
    if (this.renewTimer) clearInterval(this.renewTimer)
    this.renewTimer = null
    if (!this.myClaimId) return
    this.send({ type: 'release', claimId: this.myClaimId })
    this.myClaimId = null
  }

  /** Tras refinar, el servidor ya liberó la reserva. */
  forgetClaim(): void {
    if (this.renewTimer) clearInterval(this.renewTimer)
    this.renewTimer = null
    this.myClaimId = null
    this.pendingRequest = null
  }

  private publishMembers(): void {
    this.h.onMembers([...this.members.values()])
  }

  private publishClaims(): void {
    this.h.onClaims([...this.claims.values()].filter((x) => x.claimId !== this.myClaimId))
  }

  /** Devuelve false si hay un salto de `seq` y el mensaje no debe aplicarse. */
  private acceptSeq(seq: number): boolean {
    if (this.resyncing || seq <= this.lastSeq) return false
    if (seq !== this.lastSeq + 1) {
      this.resyncing = true
      this.send({ type: 'resync' })
      return false
    }
    this.lastSeq = seq
    return true
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'snapshot': {
        this.resyncing = false
        this.lastSeq = msg.seq
        this.attempt = 0
        this.ticketFailures = 0
        this.members = new Map(msg.members.map((m) => [m.userId, m]))
        this.claims = new Map(msg.claims.map((x) => [x.claimId, x]))
        if (this.myClaimId && !this.claims.has(this.myClaimId)) {
          this.forgetClaim()
          this.h.onClaimLost()
        }
        this.publishMembers()
        this.publishClaims()
        this.h.onCursorsReset(msg.members)
        break
      }
      case 'member.joined':
        if (!this.acceptSeq(msg.seq)) return
        this.members.set(msg.userId, { userId: msg.userId, displayName: msg.displayName, r: null, c: null })
        this.publishMembers()
        break
      case 'member.left':
        if (!this.acceptSeq(msg.seq)) return
        this.members.delete(msg.userId)
        this.publishMembers()
        this.h.onCursorsReset([...this.members.values()])
        break
      case 'cursor': {
        const member = this.members.get(msg.userId)
        if (member) {
          member.r = msg.r
          member.c = msg.c
        }
        this.h.onCursor(msg.userId, msg.r, msg.c)
        break
      }
      case 'claim.granted':
        this.acceptSeq(msg.seq) // La respuesta a la petición propia cuenta aunque haya salto.
        if (msg.requestId !== this.pendingRequest) {
          // Llegó tarde: el usuario ya cambió de grupo o canceló.
          if (this.pendingRequest === null && !this.myClaimId) this.send({ type: 'release', claimId: msg.claimId })
          return
        }
        this.pendingRequest = null
        this.myClaimId = msg.claimId
        this.claims.set(msg.claimId, msg)
        if (this.renewTimer) clearInterval(this.renewTimer)
        this.renewTimer = setInterval(() => this.send({ type: 'renew', claimId: msg.claimId }), RENEW_MS)
        this.h.onClaimResult({ granted: true })
        this.publishClaims()
        break
      case 'claim.denied':
        if (msg.requestId !== this.pendingRequest) return
        this.pendingRequest = null
        this.h.onClaimResult({ granted: false, reason: msg.reason, holder: msg.holder })
        break
      case 'claim.updated':
        if (!this.acceptSeq(msg.seq)) return
        this.claims.set(msg.claimId, msg)
        this.publishClaims()
        break
      case 'claim.released': {
        if (msg.seq !== undefined && !this.acceptSeq(msg.seq)) return
        this.claims.delete(msg.claimId)
        if (msg.claimId === this.myClaimId) {
          this.forgetClaim()
          this.h.onClaimLost()
        }
        this.publishClaims()
        break
      }
      case 'pong':
        this.awaitingPong = false
        this.missedPongs = 0
        break
    }
  }
}
