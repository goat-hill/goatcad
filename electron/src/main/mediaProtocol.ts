import { protocol } from 'electron'
import * as fs from 'fs'
import { Readable } from 'stream'

/**
 * goatcad-media:// — a streaming file protocol for the document viewer tabs
 * (PDF and rendered HTML). The renderer points an <iframe> at a media URL and
 * Chromium loads the bytes from here, so nothing large ever crosses IPC (the
 * image viewer's base64 round-trip would be a disaster for a 300 MB
 * datasheet). Range requests are honored, which lets Chromium's built-in PDF
 * viewer fetch only the byte ranges of the pages actually viewed.
 *
 * The URL grammar is `goatcad-media://local/<percent-encoded path segments>`
 * (a Windows drive segment like `C:` stands in for the leading slash). It is
 * produced by `mediaUrlForPath` in renderer `lib/documentFiles.ts` and decoded
 * by `pathForMediaUrl` here — change the two together. The scheme is
 * registered as `standard` so relative subresource URLs inside an HTML
 * document resolve against it naturally.
 *
 * Only extensions in MEDIA_MIME_TYPES are served: the documents themselves
 * plus the static subresources an HTML datasheet legitimately pulls in
 * (images, stylesheets, fonts). Notably no scripts — the HTML viewer's iframe
 * is fully sandboxed and this list is the second fence.
 */

export const MEDIA_SCHEME = 'goatcad-media'
const MEDIA_HOST = 'local'

const MEDIA_MIME_TYPES: Record<string, string> = {
  // Documents
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  // HTML subresources
  css: 'text/css',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf'
}

/** Must run before app ready — Electron rejects late scheme registration. */
export const registerMediaSchemePrivileges = (others: Electron.CustomScheme[] = []): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    },
    ...others
  ])
}

/**
 * Media URL → absolute filesystem path, or null for anything that isn't a
 * well-formed media URL. Chromium normalizes `..` in standard-scheme URLs
 * before we ever see them, but the explicit dot-segment check keeps the
 * decoder safe on its own.
 */
export const pathForMediaUrl = (url: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== MEDIA_HOST) return null
  const segments = parsed.pathname.split('/').filter((s) => s !== '')
  if (segments.length === 0) return null
  let decoded: string[]
  try {
    decoded = segments.map(decodeURIComponent)
  } catch {
    return null
  }
  if (decoded.some((s) => s === '.' || s === '..')) return null
  const isWindowsDrive = /^[a-zA-Z]:$/.test(decoded[0])
  return (isWindowsDrive ? '' : '/') + decoded.join('/')
}

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** MIME type the protocol serves this path as, or null when it refuses to. */
export const mediaMimeType = (path: string): string | null =>
  MEDIA_MIME_TYPES[extensionOf(path)] ?? null

export interface ByteRange {
  start: number
  end: number // inclusive, per HTTP Range semantics
}

/**
 * Parse a single-range `Range: bytes=…` header against a known body size.
 * Returns the clamped range, 'unsatisfiable' (→ 416), or null to serve the
 * whole body (no header, or a form — like multipart ranges — we don't
 * support; ignoring Range and answering 200 is spec-legal).
 */
export const parseByteRange = (
  header: string | null,
  size: number
): ByteRange | 'unsatisfiable' | null => {
  if (!header || size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, startStr, endStr] = match
  if (startStr === '' && endStr === '') return null
  if (startStr === '') {
    // Suffix range: last N bytes.
    const suffix = Number(endStr)
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startStr)
  if (start >= size) return 'unsatisfiable'
  const end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

const notFound = (): Response => new Response('Not found', { status: 404 })

const handleMediaRequest = async (request: Request): Promise<Response> => {
  const filePath = pathForMediaUrl(request.url)
  if (!filePath) return notFound()
  const mime = mediaMimeType(filePath)
  if (!mime) return notFound()

  let stats: fs.Stats
  try {
    stats = await fs.promises.stat(filePath)
  } catch {
    return notFound()
  }
  if (!stats.isFile()) return notFound()

  const range = parseByteRange(request.headers.get('range'), stats.size)
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${stats.size}` }
    })
  }

  const headers = new Headers({
    'Content-Type': mime,
    'Accept-Ranges': 'bytes'
  })
  const stream = (opts?: { start: number; end: number }): BodyInit =>
    Readable.toWeb(fs.createReadStream(filePath, opts)) as unknown as BodyInit

  if (range) {
    headers.set('Content-Length', String(range.end - range.start + 1))
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`)
    return new Response(stream(range), { status: 206, headers })
  }
  headers.set('Content-Length', String(stats.size))
  return new Response(stream(), { status: 200, headers })
}

/** Call once after app ready. */
export const registerMediaProtocolHandler = (): void => {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest)
}
