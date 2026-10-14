import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { startPartsMcpServer, type PartsMcpServerHandle } from '../partsMcpServer'
import { createMcpSessions } from '../mcpSessions'
import { buildEndpoint, endpointPath } from '../mcpEndpoint'
import { runRelay } from '../mcpRelay'
import type { PartsService } from '../ops/context'

const service: PartsService = {
  credentialStatus: () => [],
  usage: () => [],
  categories: async () => ({ ok: true, value: [] }),
  search: async () => ({ ok: false, error: { kind: 'network' } })
}

const TOKEN = 'relay-token-that-is-long-enough-to-be-real'

describe('the stdio relay', () => {
  let dir: string
  let socketServer: PartsMcpServerHandle
  let portServer: PartsMcpServerHandle
  const attached: Array<[string, string]> = []
  const ended: string[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'goatcad-relay-'))
    const sessions = createMcpSessions({ graceMs: 10 })
    sessions.onEnd((id) => void ended.push(id))
    const options = {
      token: TOKEN,
      sessions,
      attach: (connection: string, workspace: string) =>
        void attached.push([connection, workspace]),
      context: { parts: service }
    }
    socketServer = await startPartsMcpServer({
      ...options,
      socketPath: join(dir, 'goatcad.sock'),
      trusted: true
    })
    portServer = await startPartsMcpServer({ ...options, port: 0 })
  })

  afterAll(async () => {
    await socketServer.close()
    await portServer.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Relay these lines, then answer every line written back. */
  const relayed = async (
    lines: unknown[],
    options: { socket: boolean; launch?: () => void }
  ): Promise<{ answers: unknown[]; launched: number }> => {
    writeFileSync(
      endpointPath(dir),
      JSON.stringify(
        buildEndpoint(
          portServer.port,
          '/mcp',
          '0.0.0',
          process.pid,
          Date.now(),
          options.socket ? { path: join(dir, 'goatcad.sock'), trusted: true } : null
        )
      )
    )
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
    let launched = 0
    const done = runRelay({
      configDir: dir,
      launch: () => {
        launched += 1
        options.launch?.()
      },
      token: async () => TOKEN,
      workspace: 'ws_tab',
      input,
      output,
      log: () => {},
      launchTimeoutMs: 2000
    })
    for (const line of lines) input.write(`${JSON.stringify(line)}\n`)
    input.end()
    expect(await done).toBe(0)
    return {
      answers: text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
      launched
    }
  }

  const session = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'parts_status', arguments: {} } }
  ]

  it('relays a session over the socket, attaching it to the workspace it names', async () => {
    const { answers, launched } = await relayed(session, { socket: true })
    expect(launched).toBe(0)
    // Two answers: the notification has none.
    expect(answers).toHaveLength(2)
    expect(answers[0]).toMatchObject({ id: 1, result: { serverInfo: { name: 'goatcad' } } })
    expect(answers[1]).toMatchObject({ id: 2, result: { isError: false } })
    const [connection, workspace] = attached.at(-1)!
    expect(workspace).toBe('ws_tab')
    // stdin closing ends the session.
    await new Promise((done) => setTimeout(done, 30))
    expect(ended).toContain(connection)
  })

  it('falls back to the port with the token when there is no socket', async () => {
    const { answers } = await relayed(session, { socket: false })
    expect(answers[1]).toMatchObject({ id: 2, result: { isError: false } })
  })

  it('launches the app once when nothing answers, and says so per call when it never comes', async () => {
    rmSync(endpointPath(dir), { force: true })
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
    let launched = 0
    const done = runRelay({
      configDir: join(dir, 'nowhere'),
      launch: () => void (launched += 1),
      token: async () => null,
      input,
      output,
      log: () => {},
      launchTimeoutMs: 300
    })
    input.write(`${JSON.stringify(session[0])}\n`)
    input.end()
    await done
    expect(launched).toBe(1)
    expect(JSON.parse(text.trim())).toMatchObject({ id: 1, error: { code: -32603 } })
  })
})
