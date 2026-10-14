import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  bearerFrom,
  handleRequest,
  MCP_PATH,
  originAllowed,
  startPartsMcpServer,
  tokensMatch,
  type PartsMcpServerHandle
} from '../partsMcpServer'
import type { Caller, PartsService } from '../ops/context'
import { createMcpSessions } from '../mcpSessions'
import type { McpDesignRequest } from '../../preload/mcpTypes'
import type { JsonRpcResponse } from '../partsMcp'

const service: PartsService = {
  credentialStatus: () => [
    {
      provider: 'digikey',
      configured: true,
      hint: 'abc',
      lastVerifiedAt: null,
      encryptionAvailable: true
    }
  ],
  usage: () => [
    {
      provider: 'digikey',
      minute: { used: 0, limit: 120 },
      day: { used: 0, limit: 1000, resetsAt: 0 },
      lastSuccessAt: null
    }
  ],
  categories: async () => ({ ok: true, value: [] }),
  search: async () => ({
    ok: true,
    value: {
      parts: [],
      total: 0,
      facets: { manufacturers: [], packaging: [], status: [], series: [], parametric: [] }
    }
  })
}

const TOKEN = 'test-token-that-is-long-enough-to-be-real'
let server: PartsMcpServerHandle
let url: string

beforeAll(async () => {
  // Port 0 → the OS picks a free one, so the suite never collides with a real
  // GoatCAD instance or with a parallel run.
  server = await startPartsMcpServer({ token: TOKEN, context: { parts: service }, port: 0 })
  url = `http://127.0.0.1:${server.port}/mcp`
})

afterAll(async () => {
  await server.close()
})

const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })

/**
 * Drive `handleRequest` directly — no listener, no socket.
 *
 * The guards, the routing and the body cap are decisions this one function
 * makes, and a TCP connection adds nothing to testing them except timing. It
 * subtracts something, in fact: the oversized-body case was flaky for exactly
 * that reason, because it was asserting on a race between a response being
 * flushed and a socket being torn down rather than on the refusal itself.
 * `startPartsMcpServer` is still exercised end to end below, on the happy path,
 * which is what an integration test is for.
 */
interface Answer {
  status: number
  headers: Record<string, unknown>
  body: string
}

const direct = async (options: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string | Readable
  auth?: boolean
}): Promise<{ answer: Answer; request: Readable }> => {
  const source =
    options.body instanceof Readable
      ? options.body
      : Readable.from([Buffer.from(options.body ?? '')])
  const request = Object.assign(source, {
    method: options.method ?? 'POST',
    url: options.url ?? MCP_PATH,
    headers: {
      ...(options.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...options.headers
    }
  }) as unknown as IncomingMessage

  const answer: Answer = { status: 0, headers: {}, body: '' }
  const response = {
    headersSent: false,
    setHeader(name: string, value: unknown): void {
      answer.headers[name.toLowerCase()] = value
    },
    writeHead(status: number, headers?: Record<string, unknown>): unknown {
      answer.status = status
      for (const [key, value] of Object.entries(headers ?? {})) {
        answer.headers[key.toLowerCase()] = value
      }
      response.headersSent = true
      return response
    },
    end(chunk?: string): unknown {
      if (chunk) answer.body += chunk
      return response
    }
  }

  await handleRequest(request, response as unknown as ServerResponse, {
    token: TOKEN,
    context: { parts: service }
  })
  return { answer, request: source }
}

const rpc = (method: string): string => JSON.stringify({ jsonrpc: '2.0', id: 1, method })

describe('the fences', () => {
  it('refuses a request with no token', async () => {
    const { answer } = await direct({ body: rpc('tools/list'), auth: false })
    expect(answer.status).toBe(401)
  })

  it('refuses a wrong token, and says no more than that', async () => {
    const { answer } = await direct({
      body: rpc('tools/list'),
      headers: { authorization: 'Bearer wrong' }
    })
    expect(answer.status).toBe(401)
    expect(JSON.parse(answer.body)).toEqual({ error: 'unauthorized' })
  })

  it('authenticates even the harmless-looking calls', async () => {
    // There is no unauthenticated endpoint on purpose: one is all it takes to
    // confirm the app is running and start guessing.
    const { answer } = await direct({ body: '{}', auth: false })
    expect(answer.status).toBe(401)
  })

  it('refuses a browser Origin', async () => {
    const { answer } = await direct({
      body: rpc('tools/list'),
      headers: { origin: 'https://evil.invalid' }
    })
    expect(answer.status).toBe(403)
  })

  it('allows a loopback Origin and an absent one', async () => {
    expect(originAllowed(undefined)).toBe(true)
    expect(originAllowed('http://127.0.0.1:5173')).toBe(true)
    expect(originAllowed('http://localhost:5173')).toBe(true)
    expect(originAllowed('https://example.invalid')).toBe(false)
    expect(originAllowed('not a url')).toBe(false)
  })

  it('404s a path that is not the MCP endpoint', async () => {
    const { answer } = await direct({ url: '/admin', body: '{}' })
    expect(answer.status).toBe(404)
  })

  it('declines a GET stream rather than hanging one open', async () => {
    const { answer } = await direct({ method: 'GET' })
    expect(answer.status).toBe(405)
  })

  it('refuses an oversized body with an answer the client can read', async () => {
    // The cap is only useful if the refusal arrives. Closing a socket that
    // still has unread bytes on it makes the OS send a reset, and a reset
    // discards whatever the peer had not read — so the server answers, then
    // drains what is still coming before hanging up (`lingeringClose`). What
    // is asserted here is that policy: a 413, `connection: close`, and a
    // request that was read to the end rather than torn down.
    const oversized = Readable.from(Array.from({ length: 4 }, () => Buffer.alloc(512 * 1024, 'x')))
    const { answer, request } = await direct({ body: oversized })
    expect(answer.status).toBe(413)
    expect(answer.headers.connection).toBe('close')
    expect(JSON.parse(answer.body).error).toBe('request body too large')

    await new Promise((resolve) => setImmediate(resolve))
    expect(request.readableEnded).toBe(true)
  })

  it('keeps nothing of a body it refused', async () => {
    // The point of the cap is memory, and lingering must not quietly undo it:
    // the drained bytes are discarded, never handed to the handler.
    const { answer } = await direct({
      body: Readable.from([Buffer.alloc(2 * 1024 * 1024, 'x')])
    })
    expect(answer.body).not.toContain('xxxx')
  })
})

describe('discovery', () => {
  // `docs/agent-api.md`. These are the endpoints a Python
  // client or the CLI reads instead of MCP's tools/list, and they sit behind
  // the same bearer — fence 2 has no exceptions, because a listing is exactly
  // the confirmation that the app is running which that fence withholds.
  it('refuses an unauthenticated listing, like everything else', async () => {
    const { answer } = await direct({ method: 'GET', url: '/v1/ops', auth: false })
    expect(answer.status).toBe(401)
  })

  it('lists the operations', async () => {
    const { answer } = await direct({ method: 'GET', url: '/v1/ops' })
    expect(answer.status).toBe(200)
    const body = JSON.parse(answer.body) as { ops: Array<{ name: string }> }
    expect(body.ops.map((op) => op.name)).toContain('schematic.place_symbol')
  })

  it('serves one operation and its schema', async () => {
    const { answer } = await direct({ method: 'GET', url: '/v1/ops/parts.status' })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body).mcpName).toBe('parts_status')
  })

  it('answers an unknown operation with candidates, not an empty 200', async () => {
    const { answer } = await direct({ method: 'GET', url: '/v1/ops/parts.staus' })
    expect(answer.status).toBe(404)
    expect(JSON.parse(answer.body).error.candidates).toContain('parts.status')
  })

  it('publishes the whole schema at one address', async () => {
    const { answer } = await direct({ method: 'GET', url: '/v1/schema' })
    expect(JSON.parse(answer.body).schemaVersion).toBe('1.0.0')
  })

  it('takes GET only on the collection — a call names an operation', async () => {
    const { answer } = await direct({ method: 'POST', url: '/v1/ops', body: '{}' })
    expect(answer.status).toBe(405)
  })
})

describe('calling an operation over HTTP', () => {
  // The rule that lets a client parse one shape: an operation
  // failure is 200 with the envelope, and only transport and auth are HTTP
  // errors. A 404 here means "no such route", never "that pin does not exist".
  it('runs an operation and answers with its value', async () => {
    const { answer } = await direct({
      method: 'POST',
      url: '/v1/ops/parts.status',
      body: '{}'
    })
    expect(answer.status).toBe(200)
    const body = JSON.parse(answer.body)
    expect(body.ok).toBe(true)
    expect(body.value.connectedCount).toBe(1)
  })

  it('accepts the wire name as readily as the registry name', async () => {
    const { answer } = await direct({ method: 'POST', url: '/v1/ops/parts_status', body: '{}' })
    expect(JSON.parse(answer.body).ok).toBe(true)
  })

  it('reports a refused operation as 200 with the envelope, not as an HTTP error', async () => {
    const { answer } = await direct({
      method: 'POST',
      url: '/v1/ops/parts_search',
      body: JSON.stringify({ distributor: 'digikey', query: '' })
    })
    expect(answer.status).toBe(200)
    const body = JSON.parse(answer.body)
    expect(body.ok).toBe(false)
    expect(body.error.fix).toBeTruthy()
  })

  it('404s a name that is not an operation, which is a missing route', async () => {
    const { answer } = await direct({ method: 'POST', url: '/v1/ops/parts.staus', body: '{}' })
    expect(answer.status).toBe(404)
    expect(JSON.parse(answer.body).error.candidates).toContain('parts.status')
  })

  it('treats an empty body as no arguments', async () => {
    const { answer } = await direct({ method: 'POST', url: '/v1/ops/parts.status' })
    expect(JSON.parse(answer.body).ok).toBe(true)
  })

  it('refuses a body that is not JSON, before an operation sees it', async () => {
    const { answer } = await direct({
      method: 'POST',
      url: '/v1/ops/parts.status',
      body: '{ not json'
    })
    expect(answer.status).toBe(400)
  })

  it('is behind the bearer, like everything else', async () => {
    const { answer } = await direct({
      method: 'POST',
      url: '/v1/ops/parts.status',
      body: '{}',
      auth: false
    })
    expect(answer.status).toBe(401)
  })
})

describe('over the wire', () => {
  it('completes an initialize handshake', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' }
      }
    })
    const body = await res.json()
    expect(body.result.serverInfo.name).toBe('goatcad')
    expect(body.result.capabilities).toHaveProperty('tools')
    expect(body.result.instructions).toContain('parts_status')
  })

  it('answers a notification with 202 and an empty body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('runs a tool end to end', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'parts_status', arguments: {} }
    })
    const body = await res.json()
    const payload = JSON.parse(body.result.content[0].text)
    expect(payload.connectedCount).toBe(1)
  })

  it('answers a batch as an array, and drops the notifications inside it', async () => {
    const res = await post([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' }
    ])
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
    expect((body as JsonRpcResponse[]).map((entry) => entry.id)).toEqual([1, 2])
  })

  it('reports malformed JSON as a parse error rather than a 500', async () => {
    const res = await post('{ not json')
    expect(res.status).toBe(200)
    expect((await res.json()).error.code).toBe(-32700)
  })
})

describe('agent connections', () => {
  const asked: McpDesignRequest[] = []
  const callers: Caller[] = []
  const ended: string[] = []
  let sessions: ReturnType<typeof createMcpSessions>
  let held: PartsMcpServerHandle
  let base: string

  beforeAll(async () => {
    sessions = createMcpSessions({ graceMs: 20 })
    sessions.onEnd((id) => void ended.push(id))
    held = await startPartsMcpServer({
      token: TOKEN,
      port: 0,
      sessions,
      context: {
        parts: service,
        design: async (request, caller) => {
          asked.push(request)
          callers.push(caller)
          return { ok: true, payload: { viewport: 'viewport-1' } }
        }
      }
    })
    base = `http://127.0.0.1:${held.port}`
  })

  afterAll(async () => {
    await held.close()
  })

  const auth = { authorization: `Bearer ${TOKEN}` }
  const openViewport = (headers: Record<string, string>): Promise<Response> =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth, ...headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'viewport_open', arguments: { board: 'b.kicad_pcb', label: 'x' } }
      })
    })

  it('mints a session on initialize, and an op hears it as its connection', async () => {
    const init = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    })
    const session = init.headers.get('mcp-session-id')
    expect(session).toMatch(/^[0-9a-f-]{36}$/)
    await openViewport({ 'mcp-session-id': session! })
    expect(asked.at(-1)).toMatchObject({ kind: 'open-viewport', connection: session })
    // No session, no connection: the open is anonymous.
    await openViewport({})
    expect(asked.at(-1)).not.toHaveProperty('connection')
  })

  it('names the workspace its client sends on every call, and lets the argument win', async () => {
    await openViewport({ 'mcp-session-id': 'tab-1', 'x-goatcad-workspace': 'ws_tab' })
    expect(callers.at(-1)).toEqual({ connection: 'tab-1', workspace: 'ws_tab' })
    await openViewport({ 'x-goatcad-workspace': 'ws_tab' })
    expect(callers.at(-1)).toEqual({ workspace: 'ws_tab' })
    await fetch(`${base}/v1/ops/viewport.open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth, 'x-goatcad-workspace': 'ws_tab' },
      body: JSON.stringify({ board: 'b.kicad_pcb', label: 'x', workspace: 'ws_mine' })
    })
    expect(callers.at(-1)).toEqual({ workspace: 'ws_mine' })
  })

  it('takes a client-made id over /v1 as its connection', async () => {
    await fetch(`${base}/v1/ops/viewport.open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth, 'mcp-session-id': 'py-1' },
      body: JSON.stringify({ board: 'b.kicad_pcb', label: 'x' })
    })
    expect(asked.at(-1)).toMatchObject({ connection: 'py-1' })
  })

  it('ends a session on DELETE', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { ...auth, 'mcp-session-id': 'py-1' }
    })
    expect(res.status).toBe(204)
    expect(ended).toContain('py-1')
    const bare = await fetch(`${base}/mcp`, { method: 'DELETE', headers: auth })
    expect(bare.status).toBe(400)
  })

  it('holds a GET stream for a session, and ends the session once it stays closed', async () => {
    const abort = new AbortController()
    const res = await fetch(`${base}/mcp`, {
      headers: { ...auth, accept: 'text/event-stream', 'mcp-session-id': 'cli-1' },
      signal: abort.signal
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(ended).not.toContain('cli-1')
    abort.abort()
    await new Promise((done) => setTimeout(done, 80))
    expect(ended).toContain('cli-1')
  })

  it('closes with a stream still held', async () => {
    const res = await fetch(`${base}/mcp`, {
      headers: { ...auth, accept: 'text/event-stream', 'mcp-session-id': 'cli-2' }
    })
    expect(res.status).toBe(200)
    // afterAll's close() ends it rather than waiting on it.
  })

  it('declines a GET stream with no session', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { ...auth, accept: 'text/event-stream' } })
    expect(res.status).toBe(405)
  })
})

describe('header parsing and comparison', () => {
  it('reads a bearer token case-insensitively', () => {
    expect(bearerFrom('Bearer abc')).toBe('abc')
    expect(bearerFrom('bearer abc')).toBe('abc')
    expect(bearerFrom('Basic abc')).toBeNull()
    expect(bearerFrom(undefined)).toBeNull()
  })

  it('compares without leaking length-independent timing', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true)
    expect(tokensMatch('abc', 'abd')).toBe(false)
    expect(tokensMatch('abc', 'abcd')).toBe(false)
  })
})
