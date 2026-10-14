import { protocol } from 'electron'
import * as fs from 'fs'
import { extname, join, normalize, sep } from 'path'

/**
 * The built renderer is served from goatcad-app:// rather than file://, with
 * the two cross-origin isolation headers: Chromium exposes SharedArrayBuffer
 * only to an isolated page, and the board worker shares the board through it
 * (docs/performance-workstream.md, "The board worker"). Electron's security
 * guide asks for a custom scheme over file:// regardless. The dev server
 * sends the same headers (electron.vite.config.ts). Everything the page embeds
 * must be allowed under them: the media scheme's PDF and HTML frames load as
 * credentialless iframes (PdfViewer.vue, HtmlViewer.vue).
 */

export const APP_SCHEME = 'goatcad-app'
export const APP_URL = `${APP_SCHEME}://app/index.html`

/** The headers that make the page cross-origin isolated. */
export const ISOLATION_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

export const appSchemePrivileges = {
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    codeCache: true
  }
}

/** Call once after app ready; `root` is the built renderer directory. */
export const registerAppProtocolHandler = (root: string): void => {
  protocol.handle(APP_SCHEME, async (request) => {
    const path = normalize(join(root, decodeURIComponent(new URL(request.url).pathname)))
    if (!path.startsWith(root + sep)) return new Response('Not found', { status: 404 })
    try {
      const body = await fs.promises.readFile(path)
      return new Response(body, {
        headers: {
          'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
          ...ISOLATION_HEADERS
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
