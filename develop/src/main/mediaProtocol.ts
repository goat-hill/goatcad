import { protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import { extname, resolve, sep } from 'node:path'

// Content types where the element (or iframe) needs the header to render the
// bytes correctly; net.fetch on file: usually sets it, this is the backstop.
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogv': 'video/ogg',
  '.html': 'text/html',
  '.htm': 'text/html'
}

// goatherd-media:// streams the bytes of workspace files (.goatherd/) to the
// renderer, so images and — crucially — videos load and seek natively instead
// of crossing IPC as base64. The renderer only ever points <img>/<video>/<iframe>
// src at URLs built from a listWorkspace result; the .goatherd path check below
// is the second fence so a stray URL can never read outside a workspace dir.
//
// The matching URL encoder is `workspaceMediaUrl` in the renderer's
// workspace.ts — change the two together.
export const WORKSPACE_SCHEME = 'goatherd-media'

/** Must run before app 'ready' (module load time). */
export function registerWorkspaceSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WORKSPACE_SCHEME,
      // corsEnabled is what lets the renderer fetch() this scheme cross-origin
      // (the app is served from file:/localhost, the media is a different origin).
      // Without it the fetch fails as "Failed to fetch" before any response header
      // is read — which left the Workspace markdown/text preview blank. <img>/
      // <video> aren't CORS-gated, so they always loaded.
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/** Must run after app 'ready'. */
export function registerWorkspaceProtocol(): void {
  protocol.handle(WORKSPACE_SCHEME, async (request) => {
    const url = new URL(request.url)
    let path = decodeURIComponent(url.pathname)
    // Windows drive paths arrive as /C:/… — drop the URL's leading slash.
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
    const abs = resolve(path)
    if (!abs.split(sep).includes('.goatherd')) {
      return new Response('forbidden', { status: 403 })
    }
    // net.fetch on a file: URL honors the forwarded Range header, so <video>
    // seeking works without loading the whole clip.
    const response = await net.fetch(pathToFileURL(abs).toString(), { headers: request.headers })
    const headers = new Headers(response.headers)
    const mime = MIME_TYPES[extname(abs).toLowerCase()]
    if (mime && !headers.get('content-type')) headers.set('content-type', mime)
    // A renderer fetch() of this standard scheme is a cross-origin request; with
    // no Access-Control-Allow-Origin the browser rejects it as "Failed to fetch"
    // (that's what left the Workspace markdown/text preview blank — <img>/<video>
    // aren't CORS-gated, so they loaded fine, but WorkspaceView reads .md/.txt via
    // fetch). Allow it; these bytes are already fenced to .goatherd/ dirs above.
    headers.set('access-control-allow-origin', '*')
    // Preserve status (206 for range) and the streaming body.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  })
}
