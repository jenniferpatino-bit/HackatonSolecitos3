import { ApiError, asApiError, env, isAbort } from './http'
import { api } from './session'
import type { Media, MediaTicket } from './types'

export type Purpose = 'BADGE' | 'INCIDENT'

export const LIMITS: Record<Purpose, number> = { BADGE: 122880, INCIDENT: 307200 }

export interface PreparedImage {
  blob: Blob
  width: number
  height: number
  sha256: string
}

const QUALITIES = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42, 0.34, 0.26]

function toWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        // Sin soporte, el navegador cae a PNG en lugar de fallar: hay que comprobar el tipo.
        if (blob && blob.type === 'image/webp') resolve(blob)
        else reject(new Error('Este navegador no puede generar imágenes WebP. Usa Chrome, Edge o Firefox actualizados.'))
      },
      'image/webp',
      quality,
    )
  })
}

async function fitBytes(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob | null> {
  for (const q of QUALITIES) {
    const blob = await toWebp(canvas, q)
    if (blob.size <= maxBytes) return blob
  }
  return null
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Decodifica aplicando la orientación EXIF. Lo que sale del canvas ya no lleva metadatos. */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  if (!file.type.startsWith('image/')) throw new Error('El archivo elegido no es una imagen.')
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error('No se pudo leer la imagen. Prueba con otro archivo.')
  }
}

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('El navegador no permite procesar imágenes.')
  ctx.imageSmoothingQuality = 'high'
  return [canvas, ctx]
}

export interface CropBox {
  sx: number
  sy: number
  size: number
}

export async function prepareBadge(bitmap: ImageBitmap, crop: CropBox): Promise<PreparedImage> {
  const [canvas, ctx] = makeCanvas(512, 512)
  ctx.drawImage(bitmap, crop.sx, crop.sy, crop.size, crop.size, 0, 0, 512, 512)
  const blob = await fitBytes(canvas, LIMITS.BADGE)
  if (!blob) throw new Error('No se pudo comprimir el fotocheck por debajo de 120 KB.')
  return { blob, width: 512, height: 512, sha256: await sha256Hex(blob) }
}

export async function prepareIncident(file: Blob): Promise<PreparedImage> {
  const bitmap = await decodeImage(file)
  try {
    const longSide = Math.max(bitmap.width, bitmap.height)
    const first = Math.min(1600, Math.max(800, longSide))
    const sides = [first, 1280, 1024, 800].filter((s, i) => i === 0 || s < first)
    for (const side of sides) {
      const scale = side / longSide
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const [canvas, ctx] = makeCanvas(width, height)
      ctx.drawImage(bitmap, 0, 0, width, height)
      const blob = await fitBytes(canvas, LIMITS.INCIDENT)
      if (blob) return { blob, width, height, sha256: await sha256Hex(blob) }
    }
    throw new Error('No se pudo comprimir la foto por debajo de 300 KB.')
  } finally {
    bitmap.close()
  }
}

interface XhrResult {
  status: number
  text: string
}

function xhrSend(
  url: string,
  body: XMLHttpRequestBodyInit,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v))
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText })
    xhr.onerror = () => reject(new ApiError(0, 'UPLOAD_NETWORK', 'Se cortó la conexión con el storage.'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(body)
  })
}

async function uploadToSupabase(ticket: MediaTicket, blob: Blob, onProgress: (f: number) => void, signal: AbortSignal): Promise<string> {
  const bucket = ticket.bucket ?? env.supabaseBucket
  const path = (ticket.objectPath ?? '').split('/').map(encodeURIComponent).join('/')
  const headers: Record<string, string> = { apikey: env.supabaseKey, 'Content-Type': 'image/webp', 'x-upsert': 'false' }
  // Las claves sb_publishable_ no son JWT: solo van en `apikey`.
  if (!env.supabaseKey.startsWith('sb_')) headers.Authorization = `Bearer ${env.supabaseKey}`
  const { status, text } = await xhrSend(`${env.supabaseUrl}/storage/v1/object/${bucket}/${path}`, blob, headers, onProgress, signal)
  // Un reintento tras un corte puede encontrar el objeto ya subido: no se sobrescribe, se confirma.
  const duplicate = status === 409 || /duplicate|already exists/i.test(text)
  if ((status < 200 || status >= 300) && !duplicate) throw new ApiError(status, 'UPLOAD_FAILED', `El storage rechazó la subida (HTTP ${status}).`)
  return `${env.supabaseUrl}/storage/v1/object/public/${bucket}/${path}`
}

async function uploadToCloudinary(ticket: MediaTicket, blob: Blob, onProgress: (f: number) => void, signal: AbortSignal): Promise<string> {
  const form = new FormData()
  form.append('file', blob)
  form.append('upload_preset', env.uploadPreset)
  form.append('public_id', ticket.uploadPublicId ?? '')
  const { status, text } = await xhrSend(`https://api.cloudinary.com/v1_1/${env.cloudName}/image/upload`, form, {}, onProgress, signal)
  if (status < 200 || status >= 300) throw new ApiError(status, 'UPLOAD_FAILED', `El storage rechazó la subida (HTTP ${status}).`)
  return (JSON.parse(text) as { secure_url: string }).secure_url
}

export function mediaErrorText(e: ApiError): string {
  const details = e.details as { reason?: string } | null
  if (e.code === 'STORAGE_NOT_VERIFIED') return 'El storage del equipo aún no está verificado. Regístralo en /estado.'
  if (e.code === 'CLEARANCE_REQUIRED') return 'El Piso de Pruebas sigue cerrado. Ábrelo desde /estado.'
  if (e.code === 'TICKET_EXPIRED') return 'El permiso de subida venció. Reintenta para pedir otro.'
  if (e.code === 'MEDIA_VERIFICATION_FAILED') return `Lumon rechazó la imagen (${details?.reason ?? 'sin motivo'}). Reintenta o elige otra.`
  return e.message
}

export type UploadStage = 'ticket' | 'uploading' | 'confirming' | 'done' | 'error' | 'cancelled'

export interface UploadState {
  stage: UploadStage
  progress: number
  error: string | null
  media: Media | null
}

/** Ticket → subida → confirmación. Reintentar retoma desde el paso que falló. */
export class UploadJob {
  state: UploadState = { stage: 'ticket', progress: 0, error: null, media: null }
  private ticket: MediaTicket | null = null
  private uploadedUrl: string | null = null
  private controller: AbortController | null = null
  private image: PreparedImage
  private purpose: Purpose
  private onChange: (state: UploadState) => void

  constructor(image: PreparedImage, purpose: Purpose, onChange: (state: UploadState) => void) {
    this.image = image
    this.purpose = purpose
    this.onChange = onChange
  }

  private set(next: Partial<UploadState>): void {
    this.state = { ...this.state, ...next }
    this.onChange(this.state)
  }

  private ticketUsable(): boolean {
    return this.ticket !== null && new Date(this.ticket.expiresAt).getTime() - Date.now() > 30000
  }

  cancel(): void {
    this.controller?.abort()
  }

  async start(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    const { signal } = controller
    try {
      if (!this.ticketUsable()) {
        this.uploadedUrl = null
        this.set({ stage: 'ticket', progress: 0, error: null })
        this.ticket = await api<MediaTicket>('/media/tickets', {
          method: 'POST',
          retries: 3,
          signal,
          body: {
            purpose: this.purpose,
            contentType: 'image/webp',
            bytes: this.image.blob.size,
            sha256: this.image.sha256,
            width: this.image.width,
            height: this.image.height,
          },
        })
      }
      const ticket = this.ticket as MediaTicket
      if (!this.uploadedUrl) {
        this.set({ stage: 'uploading', progress: 0, error: null })
        const upload = ticket.provider === 'SUPABASE' ? uploadToSupabase : uploadToCloudinary
        this.uploadedUrl = await upload(ticket, this.image.blob, (f) => this.set({ progress: f }), signal)
      }
      this.set({ stage: 'confirming', progress: 1, error: null })
      const media = await api<Media>(`/media/tickets/${encodeURIComponent(ticket.ticketId)}/confirm`, {
        method: 'POST',
        retries: 4,
        signal,
        body: { url: this.uploadedUrl },
      })
      this.set({ stage: 'done', media })
    } catch (e) {
      if (isAbort(e) || signal.aborted) {
        this.set({ stage: 'cancelled', error: null })
      } else {
        const err = asApiError(e)
        if (err.code === 'TICKET_EXPIRED') this.ticket = null
        this.set({ stage: 'error', error: mediaErrorText(err) })
      }
    }
  }
}
