/**
 * `goatcad mcp`: an MCP client's stdio, relayed to the running app.
 *
 * A client that starts its servers as commands (Claude Code, Codex, most
 * others) registers the GoatCAD executable once, with `mcp`, and this is what
 * runs: no URL, no token in its config, nothing to go stale when the port moves
 * or the token is replaced. It finds the app through the endpoint file
 * (`mcpEndpoint.ts`), preferring the user-only socket, and launches the app with
 * no window (`--background`) when nothing answers, so an agent can work in a
 * project nobody has open.
 *
 * Each line on stdin is a JSON-RPC message, posted to `/mcp` as the HTTP
 * transport would; each answer goes back as one line. The session the
 * `initialize` mints rides on every later call, and a GET stream held for it
 * tells the app when the client is gone. `GOATCAD_WORKSPACE`, set by a GoatCAD
 * terminal tab, attaches the session to that tab's workspace (`workspaces.ts`).
 *
 * Electron-free: the launch and the token are injected, so a test relays to a
 * server on an ephemeral port.
 */
import { readFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { createInterface } from 'node:readline'
import { MCP_PATH, SESSION_HEADER, WORKSPACE_HEADER } from './partsMcpServer'
import { endpointPath, type McpEndpointFile } from './mcpEndpoint'

export interface RelayOptions {
  /** The app's config directory, where it publishes its endpoint. */
  configDir: string
  /** Start the app with no window. */
  launch(): void
  /** The stored token, for a port or pipe that asks for one. */
  token(): Promise<string | null>
  /** A workspace id to attach the session to. */
  workspace?: string
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  log(message: string): void
  /** How long a launched app may take to answer. */
  launchTimeoutMs?: number
}

/** Where the relay talks to the app. */
interface Route {
  socketPath?: string
  port?: number
  token: string | null
}

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

const LAUNCH_TIMEOUT_MS = 30_000
const POLL_MS = 250

const call = (
  route: Route,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        ...(route.socketPath
          ? { socketPath: route.socketPath }
          : { host: '127.0.0.1', port: route.port }),
        method,
        path,
        headers: {
          ...headers,
          ...(route.token ? { authorization: `Bearer ${route.token}` } : {}),
          ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(body)
  })

const readEndpoint = (configDir: string): McpEndpointFile | null => {
  try {
    return JSON.parse(readFileSync(endpointPath(configDir), 'utf8')) as McpEndpointFile
  } catch {
    return null
  }
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export const runRelay = async (options: RelayOptions): Promise<number> => {
  let route: Route | null = null
  let session: string | null = null
  let closing = false
  let launched = false

  /** A route that answers a ping, or null. */
  const probe = async (): Promise<Route | null> => {
    const endpoint = readEndpoint(options.configDir)
    if (!endpoint) return null
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' })
    const candidates: Array<() => Promise<Route>> = []
    if (endpoint.socket)
      candidates.push(async () => ({
        socketPath: endpoint.socket!,
        token: endpoint.socketTrusted ? null : await options.token()
      }))
    candidates.push(async () => ({ port: endpoint.port, token: await options.token() }))
    for (const candidate of candidates) {
      try {
        const next = await candidate()
        const answer = await call(
          next,
          'POST',
          MCP_PATH,
          { 'content-type': 'application/json' },
          ping
        )
        if (answer.status === 200) return next
      } catch {
        // Not this way; try the next.
      }
    }
    return null
  }

  /** The app's route, launching it once when nothing answers. */
  const reach = async (): Promise<Route> => {
    const found = await probe()
    if (found) return found
    if (!launched) {
      launched = true
      options.log('GoatCAD is not running; starting it in the background.')
      options.launch()
    }
    const deadline = Date.now() + (options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS)
    while (Date.now() < deadline) {
      await delay(POLL_MS)
      const next = await probe()
      if (next) return next
    }
    throw new Error('GoatCAD did not start. Open it, then restart this MCP server.')
  }

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(session ? { [SESSION_HEADER]: session } : {}),
    ...(options.workspace ? { [WORKSPACE_HEADER]: options.workspace } : {})
  })

  const write = (message: unknown): void => {
    options.output.write(`${JSON.stringify(message)}\n`)
  }

  /** Post one message, reconnecting once if the app went away (a restart). */
  const post = async (body: string): Promise<Answer> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        route ??= await reach()
        return await call(route, 'POST', MCP_PATH, headers(), body)
      } catch (err) {
        route = null
        if (attempt > 0) throw err
      }
    }
  }

  /** Hold a stream open for the session: its closing tells the app the client left. */
  const hold = async (): Promise<void> => {
    while (!closing && session) {
      try {
        route ??= await reach()
        await call(route, 'GET', MCP_PATH, { ...headers(), accept: 'text/event-stream' })
      } catch {
        route = null
      }
      if (!closing) await delay(1000)
    }
  }

  const relay = async (line: string): Promise<void> => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const id =
      message && typeof message === 'object' && !Array.isArray(message)
        ? ((message as { id?: unknown }).id ?? null)
        : null
    try {
      const answer = await post(line)
      const minted = answer.headers[SESSION_HEADER]
      if (!session && typeof minted === 'string') {
        session = minted
        void hold()
      }
      if (answer.status === 202 || !answer.body) return
      if (answer.status !== 200) {
        if (id !== null)
          write({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: `GoatCAD answered HTTP ${answer.status}: ${answer.body}`
            }
          })
        return
      }
      write(JSON.parse(answer.body))
    } catch (err) {
      if (id !== null)
        write({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) }
        })
    }
  }

  return new Promise((resolve) => {
    const inFlight = new Set<Promise<void>>()
    // The initialize mints the session every later call names, so the rest wait for it.
    let initialized: Promise<void> = Promise.resolve()
    const lines = createInterface({ input: options.input })
    lines.on('line', (line) => {
      if (!line.trim()) return
      const initializing = /"method"\s*:\s*"initialize"/.test(line)
      const job = initializing ? relay(line) : initialized.then(() => relay(line))
      if (initializing) initialized = job
      inFlight.add(job)
      void job.finally(() => inFlight.delete(job))
    })
    lines.on('close', () => {
      closing = true
      void Promise.allSettled([...inFlight]).then(async () => {
        if (session && route)
          await call(route, 'DELETE', MCP_PATH, headers()).catch(() => undefined)
        resolve(0)
      })
    })
  })
}
