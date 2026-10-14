/**
 * Where the server is listening, published for programs rather than people.
 *
 * The bearer token has always been on disk (`partsMcpServer.ts`); the *address*
 * has not. Settings shows a human the URL and a ready-made `claude mcp add`
 * command, which is enough for a client someone registers by hand — but the
 * Python client connects with no arguments, and a library cannot read a
 * settings pane. Without this file it would have to assume the default port,
 * and the one situation where that assumption is wrong is exactly the one the
 * app already handles deliberately: the port was taken, so the server is
 * somewhere else.
 *
 * Not a secret, unlike the token beside it: it names a loopback port, which any
 * local process could have found by scanning. It is written on start and removed
 * on stop, so its presence is a claim that the app is up — a claim a client
 * still has to verify, because a crash leaves the file behind. `pid` is there to
 * make that cheap; a refused connection is the real answer.
 *
 * Beside the loopback port it names a socket only this user can open (`socket`):
 * the same handlers, without the token on Linux and macOS, where the file's
 * mode is the fence. A Windows named pipe takes the token like the port.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ENDPOINT_FILE = 'goatcad-endpoint.json'

/** Past this a Unix socket path does not fit `sockaddr_un` on every platform. */
const MAX_SOCKET_PATH = 100

/**
 * Where the user-only socket listens: a file in the config directory, or on
 * Windows a pipe named for it, so a harness with its own config directory has
 * its own. Null when the path would not fit.
 */
export const socketPathFor = (dir: string, platform: NodeJS.Platform): string | null => {
  if (platform === 'win32')
    return `\\\\.\\pipe\\goatcad-${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`
  const path = join(dir, 'goatcad.sock')
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH ? path : null
}

/** Whether a socket of `socketPathFor` lets its caller in without the token. */
export const socketTrusted = (platform: NodeJS.Platform): boolean => platform !== 'win32'

export interface McpEndpointFile {
  /** Full URL of the MCP endpoint, including the path. */
  url: string
  port: number
  /** The base a REST client joins `/v1/...` onto. */
  baseUrl: string
  /** The app process, so a client can tell a stale file from a live server
   *  without opening a socket. */
  pid: number
  /** App version, so a client can say what it is talking to when versions
   *  disagree. */
  appVersion: string
  startedAt: number
  /** The user-only socket serving the same paths, or null without one. */
  socket: string | null
  /** Whether the socket takes calls without the token. */
  socketTrusted: boolean
}

export const endpointPath = (dir: string): string => join(dir, ENDPOINT_FILE)

export const buildEndpoint = (
  port: number,
  path: string,
  appVersion: string,
  pid: number,
  now: number,
  socket: { path: string; trusted: boolean } | null = null
): McpEndpointFile => ({
  url: `http://127.0.0.1:${port}${path}`,
  baseUrl: `http://127.0.0.1:${port}`,
  port,
  pid,
  appVersion,
  startedAt: now,
  socket: socket?.path ?? null,
  socketTrusted: socket?.trusted ?? false
})

/** Publish the address. Never throws: a client that cannot find us is a
 *  degraded experience, and taking the app down over it would be worse. */
export const writeEndpoint = (dir: string, endpoint: McpEndpointFile): void => {
  try {
    const target = endpointPath(dir)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(endpoint, null, 2)}\n`, 'utf8')
  } catch {
    // Nothing to do about it, and nothing that depends on it having worked.
  }
}

/** Withdraw the claim that we are listening. */
export const clearEndpoint = (dir: string): void => {
  try {
    rmSync(endpointPath(dir), { force: true })
  } catch {
    // Same: a stale file is a client's problem to detect, not a reason to fail.
  }
}
