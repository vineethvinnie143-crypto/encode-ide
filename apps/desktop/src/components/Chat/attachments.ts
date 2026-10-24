/**
 * What the chat box attaches to a message (ADR 0113): the open file or a project file as text, and from the computer
 * pictures (pasted, dropped or picked), PDFs and text files. A picture is made smaller here, before it travels: a model
 * reads about 1,568 pixels a side at most, and a screenshot of a large screen weighs megabytes.
 */
import type { AgentStartInput, AttachedMedia } from '@shared/types'

export type PictureType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export type ComposerAttachment =
  | { id: string; kind: 'file'; path: string; content: string }
  | { id: string; kind: 'picture'; name: string; mediaType: PictureType; data: string; preview: string; width: number; height: number }
  | { id: string; kind: 'pdf'; name: string; data: string; bytes: number }

/** Pictures and PDFs one message takes; the agent host refuses more (`MAX_MEDIA` in core's host-api). */
export const MAX_MEDIA = 10
/** The longest side a picture is sent at, and its thumbnail. */
export const PICTURE_EDGE = 1568
const PREVIEW_EDGE = 240
/** A picture kept as it is, when no side is too long: under this it needs no new encoding. */
const KEEP_BYTES = 3.5 * 1024 * 1024
/** The most a file from the computer may weigh to be read at all. */
export const MAX_PICTURE_BYTES = 40 * 1024 * 1024
export const MAX_PDF_BYTES = 10 * 1024 * 1024
export const MAX_TEXT_BYTES = 1024 * 1024

const PICTURES: Record<string, PictureType | 'image/bmp'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}
/** Types a browser gives files that are text, beside `text/*`. */
const TEXT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-javascript',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-httpd-php',
  'application/x-python-code',
  'image/svg+xml',
])

const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''

/** What a file from the computer is to the chat box. Text files are told by their contents once read (`looksBinary`). */
export function kindOf(file: { name: string; type: string }): 'picture' | 'pdf' | 'text' | 'other' {
  const type = file.type.toLowerCase()
  const extension = extensionOf(file.name)
  if (Object.values(PICTURES).includes(type as PictureType) || (!type && PICTURES[extension])) return 'picture'
  if (type === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (!type || type.startsWith('text/') || TEXT_TYPES.has(type)) return 'text'
  return 'other'
}

/** A NUL byte, or bytes that are not UTF-8: not a text file. */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, 8_000).includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return false
  } catch {
    return true
  }
}

/** The size a picture is drawn at so that no side is longer than `edge`; never larger than it is. */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height, 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** The name a picture gets: a pasted screenshot comes as "image.png", so it is numbered instead. */
export function pictureName(name: string, pasted: boolean, count: number): string {
  if (!pasted && name) return name
  return /^image\.[a-z]+$/i.test(name) || !name ? `Screenshot ${count}.png` : name
}

/** The size of a file, as a person reads it. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Where the attachments go in the request: text as files, pictures and PDFs as media. */
export function startInput(attachments: readonly ComposerAttachment[]): Pick<AgentStartInput, 'attachments' | 'media'> {
  const files = attachments.flatMap((item) => (item.kind === 'file' ? [{ path: item.path, content: item.content }] : []))
  const media = attachments.flatMap((item): AttachedMedia[] => {
    if (item.kind === 'picture') return [{ name: item.name, mediaType: item.mediaType, data: item.data, preview: item.preview }]
    if (item.kind === 'pdf') return [{ name: item.name, mediaType: 'application/pdf', data: item.data }]
    return []
  })
  return { ...(files.length ? { attachments: files } : {}), ...(media.length ? { media } : {}) }
}

/** The name an attachment shows. */
export function attachmentName(item: ComposerAttachment): string {
  return item.kind === 'file' ? (item.path.split(/[\\/]/).pop() ?? item.path) : item.name
}

// ------------------------------------------------------------- in the page

/** Base64 of a blob, without the data: prefix. */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'))
    reader.readAsDataURL(blob)
  })
}

function canvasOf(bitmap: ImageBitmap, size: { width: number; height: number }, background?: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The picture could not be drawn.')
  if (background) {
    context.fillStyle = background
    context.fillRect(0, 0, size.width, size.height)
  }
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, size.width, size.height)
  return canvas
}

const blobOf = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The picture could not be made smaller.'))), type, quality))

/**
 * A picture ready to send: as it is when it is small enough and of a type every model takes, else drawn again with no
 * side longer than `PICTURE_EDGE`, as PNG so that text stays sharp, or JPEG when the PNG is still heavy. Null when the
 * bytes are no picture the page can open.
 */
export async function preparePicture(blob: Blob, declared: string): Promise<{ mediaType: PictureType; data: string; preview: string; width: number; height: number } | null> {
  const bitmap = await createImageBitmap(blob).catch(() => null)
  if (!bitmap) return null
  try {
    const fitted = fitWithin(bitmap.width, bitmap.height, PICTURE_EDGE)
    const preview = canvasOf(bitmap, fitWithin(bitmap.width, bitmap.height, PREVIEW_EDGE), '#000').toDataURL('image/jpeg', 0.82)
    const type = declared.toLowerCase()
    const kept = type === 'image/png' || type === 'image/jpeg' || type === 'image/gif' || type === 'image/webp'
    if (kept && fitted.width === bitmap.width && blob.size <= KEEP_BYTES) return { mediaType: type, data: await base64Of(blob), preview, ...fitted }
    const canvas = canvasOf(bitmap, fitted)
    let out = await blobOf(canvas, 'image/png')
    let mediaType: PictureType = 'image/png'
    if (out.size > KEEP_BYTES) {
      out = await blobOf(canvasOf(bitmap, fitted, '#fff'), 'image/jpeg', 0.9)
      mediaType = 'image/jpeg'
    }
    return { mediaType, data: await base64Of(out), preview, ...fitted }
  } finally {
    bitmap.close()
  }
}

/** A PDF's bytes as base64. */
export const pdfData = (blob: Blob): Promise<string> => base64Of(blob)
