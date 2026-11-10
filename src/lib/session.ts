import { useSyncExternalStore } from 'react'
import { ApiError, asApiError, backoff, isAbort, rawFetch, sleep, toApiError } from './http'
import type { Me, Permission, TokenPair } from './types'

/**
 * Sesión:
 * - El access token vive solo en esta variable (nunca en storage).
 * - El refresh token es de un solo uso y se guarda en localStorage. Solo se lee y rota dentro
 *   del Web Lock "lumon-refresh", así dos pestañas jamás presentan el mismo token.
 * - El access token nuevo se reparte a las demás pestañas por BroadcastChannel.
 */
const REFRESH_KEY = 'lumon.refresh'

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'unavailable'

export interface AuthState {
  status: AuthStatus
  me: Me | null
  notice: string | null
}

type SessionMessage = { t: 'tokens'; access: string } | { t: 'ended'; notice: string | null }

let access: string | null = null
let refreshing: Promise<string> | null = null
let state: AuthState = { status: 'loading', me: null, notice: null }
const listeners = new Set<() => void>()
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('lumon-session') : null

function setState(next: Partial<AuthState>): void {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, () => state)
}

export const getAuth = (): AuthState => state

export function can(me: Me | null, permission: Permission): boolean {
  return me?.permissions.includes(permission) ?? false
}

function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  if ('locks' in navigator) return navigator.locks.request('lumon-refresh', fn) as Promise<T>
  return fn()
}

function applySessionEnd(notice: string | null): void {
  access = null
  localStorage.removeItem(REFRESH_KEY)
  setState({ status: 'anonymous', me: null, notice })
}

/** Cierra la sesión localmente y en todas las pestañas. */
export function endSession(notice: string | null): void {
  applySessionEnd(notice)
  channel?.postMessage({ t: 'ended', notice } satisfies SessionMessage)
}

function storeTokens(pair: TokenPair): void {
  access = pair.accessToken
  localStorage.setItem(REFRESH_KEY, pair.refreshToken)
  channel?.postMessage({ t: 'tokens', access: pair.accessToken } satisfies SessionMessage)
}

const REVOKED_NOTICE = 'Tu sesión fue revocada. Por seguridad, vuelve a iniciar sesión.'

/**
 * Consigue un access token distinto de `stale`. Un solo refresh por pestaña (promesa compartida)
 * y uno por navegador (lock): quien espera el lock usa el token que ya rotó otra pestaña.
 */
export function refreshAccess(stale: string | null): Promise<string> {
  if (refreshing) return refreshing
  refreshing = withRefreshLock(async () => {
    if (access && access !== stale) return access
    const refreshToken = localStorage.getItem(REFRESH_KEY)
    if (!refreshToken) {
      applySessionEnd(null)
      throw new ApiError(401, 'NO_SESSION', 'No hay sesión.')
    }
    const res = await rawFetch('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) {
      const err = await toApiError(res)
      if (res.status === 401) {
        endSession(err.code === 'REFRESH_INVALID' ? 'Tu sesión venció. Inicia sesión de nuevo.' : REVOKED_NOTICE)
      }
      throw err
    }
    const pair = (await res.json()) as TokenPair
    storeTokens(pair)
    return pair.accessToken
  }).finally(() => {
    refreshing = null
  })
  return refreshing
}

export interface ApiOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Reintentos ante 429, 503 o red. Por defecto 3 en GET y 0 en lo demás. */
  retries?: number
  timeoutMs?: number
  /** false en rutas públicas: no manda Authorization. */
  auth?: boolean
}

/** Hace la request con el token vigente, el refresh coordinado y un único reintento tras renovar. */
export async function apiResponse(path: string, options: ApiOptions = {}): Promise<Response> {
  const { method = 'GET', body, signal, auth = true, timeoutMs = 25000 } = options
  const retries = options.retries ?? (method === 'GET' ? 3 : 0)
  let refreshed = false
  let attempt = 0

  for (;;) {
    const token = auth ? (access ?? (await refreshAccess(null))) : null
    const headers: Record<string, string> = { ...options.headers }
    if (token) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    let res: Response
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      res = await rawFetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (e) {
      if (signal?.aborted || (isAbort(e) && !timeout.aborted)) throw e
      if (attempt >= retries) throw asApiError(e)
      await sleep(backoff(attempt++), signal)
      continue
    }
    if (res.ok) return res

    const err = await toApiError(res)
    if (res.status === 401 && err.code === 'TOKEN_EXPIRED' && !refreshed && token) {
      refreshed = true
      await refreshAccess(token)
      continue
    }
    if (res.status === 401 && (err.code === 'TOKEN_INVALID' || err.code === 'SESSION_REVOKED')) {
      endSession(REVOKED_NOTICE)
      throw err
    }
    if ((res.status === 503 || res.status === 429) && attempt < retries) {
      await sleep(Math.max(err.retryAfterMs ?? 0, backoff(attempt++)), signal)
      continue
    }
    throw err
  }
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const res = await apiResponse(path, options)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function loadMe(): Promise<void> {
  const me = await api<Me>('/auth/me')
  setState({ status: 'authenticated', me, notice: null })
}

/** Vuelve a leer permisos y clearance, por ejemplo tras abrir el Piso de Pruebas. */
export const refreshMe = (): Promise<void> => loadMe()

export async function bootstrap(): Promise<void> {
  if (!localStorage.getItem(REFRESH_KEY)) {
    setState({ status: 'anonymous' })
    return
  }
  setState({ status: 'loading' })
  try {
    if (!access) await refreshAccess(null)
    await loadMe()
  } catch (e) {
    // Un 401 ya cerró la sesión. Otro fallo no la borra: se ofrece reintentar a mano, sin
    // repetir sola el refresh, porque el servidor pudo haber consumido el token.
    if (asApiError(e).status !== 401) setState({ status: 'unavailable' })
  }
}

async function publicPost<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body, auth: false })
}

export async function login(email: string, password: string): Promise<void> {
  storeTokens(await publicPost<TokenPair>('/auth/login', { email, password }))
  await loadMe()
}

export async function register(teamName: string, email: string, password: string): Promise<void> {
  storeTokens(await publicPost<TokenPair>('/auth/register', { teamName, email, password }))
  await loadMe()
}

export async function logout(): Promise<void> {
  const refreshToken = await withRefreshLock(async () => {
    const token = localStorage.getItem(REFRESH_KEY)
    endSession(null)
    return token
  })
  if (!refreshToken) return
  await publicPost<void>('/auth/logout', { refreshToken }).catch(() => undefined)
}

if (channel) {
  channel.onmessage = (ev: MessageEvent<SessionMessage>) => {
    const msg = ev.data
    if (msg.t === 'ended') {
      applySessionEnd(msg.notice)
    } else {
      access = msg.access
      if (state.status !== 'authenticated') void loadMe().catch(() => undefined)
    }
  }
}

// Respaldo por si BroadcastChannel no entrega: el refresh token desapareció en otra pestaña.
window.addEventListener('storage', (ev) => {
  if (ev.key === REFRESH_KEY && ev.newValue === null && state.status === 'authenticated') applySessionEnd(null)
})
