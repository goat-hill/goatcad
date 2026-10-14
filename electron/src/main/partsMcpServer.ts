/**
 * The loopback HTTP transport for the parts MCP server.
 *
 * Node's own `http`, no Electron and no dependency — the server takes its token,
 * its port and its message handler, so a test starts one on an ephemeral port
 * and talks to it with `fetch`.
 *
 * **Everything here is a fence.** A loopback listener is reachable by every
 * process on the machine, including a web page in the user's browser that
 * decides to POST at 127.0.0.1 — so this file is mostly the four checks that
 * keep that from being a way to read someone's distributor account:
 *
 * 1. Bind to 127.0.0.1, never 0.0.0.0. Nothing off-machine can even connect.
 * 2. A bearer token on every request, including the ones that look harmless.
 *    There is no unauthenticated endpoint, not even a health check — one is all
 *    it takes to confirm the app is running and start guessing.
 * 3. Reject a browser `Origin`. A page can send a request but cannot forge this
 *    header, which is the standard DNS-rebinding guard for local servers.
 * 4. Cap the body. An unbounded read on a public-ish socket is a way to spend
 *    someone's memory.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { handleMcpMessage, type JsonRpcRequest } from './partsMcp'
import { V1_PREFIX } from './ops/discovery'
import { handleV1 } from './ops/http'
import type { OpContext } from './ops/context'
import { isSessionId, type McpSessions } from './mcpSessions'

/** Fixed by default so a one-time client registration stays valid across
 *  restarts; a random port would turn `claude mcp add` into a ritual. */
export const DEFAULT_MCP_PORT = 8788
export const MCP_PATH = '/mcp'

/** Generous for JSON-RPC, small enough that a runaway body is refused early. */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * How much of a refused upload we will read and throw away before hanging up,
 * and for how long.
 *
 * This is `lingering_close`, the thing every real server does after answering
 * mid-request, and it exists so the refusal is *readable*. Closing a socket
 * that still has unread bytes in its receive buffer makes the OS send a reset,
 * and a reset discards whatever the peer had not read yet — so without this,
 * the client of an oversized POST sees a dead connection instead of the 413
 * that would tell it what to fix. Nothing here is retained: the memory cap is
 * `MAX_BODY_BYTES` above, and these two only bound how long we stay polite.
 */
const LINGER_BYTES = 8 * 1024 * 1024
const LINGER_MS = 2000

/** The header a session id travels in, both ways (Streamable HTTP). */
export const SESSION_HEADER = 'mcp-session-id'

/**
 * How often a held GET stream carries an SSE comment. A client's fetch gives
 * up on a body that stays silent for minutes, and a dropped stream reads as
 * the client leaving.
 */
const STREAM_HEARTBEAT_MS = 25_000

/** Constant-time compare, so a wrong token cannot be narrowed by timing it. */
export const tokensMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Is this `Origin` acceptable?
 *
 * Absent is fine — a CLI sends no Origin. A loopback origin is fine, since a
 * page served from the app itself is not the threat. Anything else is a
 * browser on some other site, which has no business here.
 */
export const originAllowed = (origin: string | undefined): boolean => {
  if (!origin) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
}

export const bearerFrom = (header: string | undefined): string | null => {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/** Thrown past the cap, so the caller can answer 413 rather than guessing. */
class BodyTooLargeError extends Error {}

/**
 * Read the body, refusing past the cap.
 *
 * The refusal deliberately does **not** destroy the socket: killing the request
 * mid-upload means the client sees a connection reset instead of the 413 that
 * would tell it what happened. So the stream is paused, the caller writes the
 * response, and only then is the socket closed — which both answers honestly
 * and stops an unbounded upload from continuing.
 */
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0
    let refused = false
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      if (refused) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        refused = true
        req.pause()
        reject(new BodyTooLargeError('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!refused) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      if (!refused) reject(err)
    })
  })

/**
 * Read and discard the rest of a request we have already answered, then let the
 * socket close on its own.
 *
 * Bounded twice, because the sender is by definition not behaving: it stops at
 * `LINGER_BYTES` or `LINGER_MS`, whichever comes first, and only then resorts to
 * the reset it was avoiding.
 */
const lingeringClose = (req: IncomingMessage): void => {
  let discarded = 0
  const timer = setTimeout(() => req.destroy(), LINGER_MS)
  // Never hold the process open for a client that has stopped talking.
  timer.unref()
  const done = (): void => clearTimeout(timer)
  req.on('data', (chunk: Buffer) => {
    discarded += chunk.length
    if (discarded > LINGER_BYTES) {
      done()
      req.destroy()
    }
  })
  req.on('end', done)
  req.on('error', done)
  req.resume()
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text)
  })
  res.end(text)
}

export interface PartsMcpServerOptions {
  token: string
  context: OpContext
  port?: number
  host?: string
  /** Agent connections (`mcpSessions.ts`). Without it no session id is minted or read. */
  sessions?: McpSessions
}

export interface PartsMcpServerHandle {
  port: number
  close(): Promise<void>
}

/**
 * Handle one HTTP request. Exported so tests can exercise the guards without a
 * socket, and so the guard order is legible: auth before anything is parsed.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: PartsMcpServerOptions,
  /** The held GET streams, which the server ends as it closes. */
  streams?: Set<ServerResponse>
): Promise<void> {
  if (!originAllowed(req.headers.origin)) {
    sendJson(res, 403, { error: 'forbidden origin' })
    return
  }

  const presented = bearerFrom(req.headers.authorization)
  if (!presented || !tokensMatch(presented, options.token)) {
    // No hint about which half was wrong, and the same answer for a missing
    // token as for a bad one.
    res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  const path = (req.url ?? '').split('?')[0]

  // The `/v1` surface (`docs/agent-api.md`): GET to
  // discover, POST to call. Behind the same bearer as everything else — fence 2
  // has no exceptions, and a listing is exactly the confirmation that the app is
  // running which that fence exists to withhold.
  if (path.startsWith(V1_PREFIX)) {
    let parsedBody: unknown = null
    if (req.method === 'POST') {
      let raw: string
      try {
        raw = await readBody(req)
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          res.setHeader('connection', 'close')
          sendJson(res, 413, { error: 'request body too large' })
          lingeringClose(req)
          return
        }
        sendJson(res, 400, { error: 'could not read request body' })
        return
      }
      if (raw.trim()) {
        try {
          parsedBody = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { error: 'request body is not JSON' })
          return
        }
      }
    }
    const answer = await handleV1(
      req.method ?? 'GET',
      path,
      parsedBody,
      withConnection(options.context, sessionOf(req, options))
    )
    sendJson(res, answer?.status ?? 404, answer?.body ?? { error: 'not found' })
    return
  }

  if (path !== MCP_PATH) {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  // Streamable HTTP lets a server decline the SSE stream, and this one sends
  // nothing on it. It holds one open for a session only so that its closing
  // says the client left (`mcpSessions.ts`).
  if (req.method === 'GET') {
    const session = sessionOf(req, options)
    if (!session || !options.sessions || !/text\/event-stream/.test(req.headers.accept ?? '')) {
      sendJson(res, 405, { error: 'this server does not open a server-to-client stream' })
      return
    }
    holdStream(res, session, options.sessions, streams)
    return
  }
  if (req.method === 'DELETE') {
    const session = sessionOf(req, options)
    if (!session) {
      sendJson(res, 400, { error: `${SESSION_HEADER} header required` })
      return
    }
    options.sessions?.end(session)
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }

  let raw: string
  try {
    raw = await readBody(req)
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // Answer, then hang up gracefully. The refusal is the whole point of the
      // cap, so a client has to be able to read it — and destroying the request
      // here cannot deliver that, however well timed: `finish` means the
      // response reached the OS, not the peer, and the reset that follows
      // discards whatever the peer had not read yet.
      res.setHeader('connection', 'close')
      sendJson(res, 413, { error: 'request body too large' })
      lingeringClose(req)
      return
    }
    sendJson(res, 400, { error: 'could not read request body' })
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    })
    return
  }

  // A batch is a JSON-RPC array. Notifications inside it produce nothing, and a
  // batch of only notifications produces no response at all.
  const messages: JsonRpcRequest[] = Array.isArray(parsed)
    ? (parsed as JsonRpcRequest[])
    : [parsed as JsonRpcRequest]

  // An `initialize` starts a session; every later request names it.
  const initializing = messages.some((message) => message?.method === 'initialize')
  const session =
    initializing && options.sessions ? options.sessions.mint() : sessionOf(req, options)
  if (initializing && session) res.setHeader(SESSION_HEADER, session)
  const context = withConnection(options.context, session)

  const responses = (
    await Promise.all(messages.map((message) => handleMcpMessage(message, context)))
  ).filter((entry) => entry !== null)

  if (responses.length === 0) {
    res.writeHead(202)
    res.end()
    return
  }

  sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0])
}

/** The session a request names, when the server keeps sessions and the id is well formed. */
const sessionOf = (req: IncomingMessage, options: PartsMcpServerOptions): string | null => {
  const value = req.headers[SESSION_HEADER]
  return options.sessions && isSessionId(value) ? value : null
}

/** The context an operation runs in: the server's, with the call's connection. */
const withConnection = (context: OpContext, session: string | null): OpContext =>
  session ? { ...context, connection: session } : context

/** Open the SSE stream and hold it, with a heartbeat, until the client drops it. */
const holdStream = (
  res: ServerResponse,
  session: string,
  sessions: McpSessions,
  streams?: Set<ServerResponse>
): void => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    [SESSION_HEADER]: session
  })
  res.flushHeaders()
  const release = sessions.hold(session)
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), STREAM_HEARTBEAT_MS)
  heartbeat.unref()
  streams?.add(res)
  res.on('close', () => {
    clearInterval(heartbeat)
    streams?.delete(res)
    release()
  })
}

/** Start the listener. Rejects if the port is taken — the caller decides
 *  whether to fall back or to tell the user (workstream §11 open decision 2). */
export function startPartsMcpServer(options: PartsMcpServerOptions): Promise<PartsMcpServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? DEFAULT_MCP_PORT

  return new Promise((resolve, reject) => {
    const streams = new Set<ServerResponse>()
    const server: Server = createServer((req, res) => {
      handleRequest(req, res, options, streams).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
        else res.end()
      })
    })

    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : port,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
            for (const stream of streams) stream.end()
            server.closeIdleConnections()
          })
      })
    })
  })
}
