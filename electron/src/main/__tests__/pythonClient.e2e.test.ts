import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startPartsMcpServer, type PartsMcpServerHandle } from '../partsMcpServer'
import { createMcpSessions } from '../mcpSessions'
import { buildEndpoint } from '../mcpEndpoint'
import { writeToken } from '../mcpToken'
import type { SecretCipher } from '../partsCredentials'
import { registry } from '../ops'
import { renderPythonClient } from '../ops/pythonClient'
import type { PartsService } from '../ops/context'
import type { McpDesignRequest } from '../../preload/mcpTypes'

/**
 * The one test that proves the whole path.
 *
 * Everything else checks a piece: the generator emits valid Python, the server
 * routes `/v1/ops/<name>`, the registry validates arguments. None of them would
 * catch the client posting to the wrong path, sending the token in the wrong
 * header, or unwrapping the envelope wrongly — and those are exactly the
 * mistakes that make "install the app and start scripting" untrue.
 *
 * **The subprocess must be spawned asynchronously.** `execFileSync` blocks this
 * thread, and the server it is talking to is on this thread, so the request can
 * never be served and the interpreter waits out its whole timeout. That deadlock
 * is invisible in the code and reads exactly like a broken client.
 */
const python = ((): string => {
  for (const candidate of ['python3', 'python']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // Try the next one.
    }
  }
  throw new Error('No python3 or python on PATH: the e2e suite drives the Python client.')
})()

const run = promisify(execFile)

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
  search: async () => ({ ok: false, error: { kind: 'network' } })
}

const TOKEN = 'e2e-token-that-is-long-enough-to-be-real'

/** A session with no keyring: the store holds the token in the clear. */
const noKeyring: SecretCipher = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('no keyring')
  },
  decryptString: () => {
    throw new Error('no keyring')
  }
}

/** A keyring only the app can open — Python sees ciphertext and nothing else. */
const keyring: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from([...plain].reverse().join(''), 'utf8'),
  decryptString: (cipher) => [...cipher.toString('utf8')].reverse().join('')
}

describe('the Python client against a running server', () => {
  let server: PartsMcpServerHandle
  let socketServer: PartsMcpServerHandle
  let configDir: string
  /** A config directory naming a trusted socket, beside a token Python cannot read. */
  let socketDir: string
  /** The workspace each call through the socket named. */
  const named: Array<string | undefined> = []
  /** What reached the window: the design door answers every request with an empty success. */
  const designRequests: McpDesignRequest[] = []
  /** A second config directory whose token store is keyring-encrypted. */
  let encryptedDir: string

  beforeAll(async () => {
    server = await startPartsMcpServer({
      token: TOKEN,
      context: {
        parts: service,
        design: async (request) => {
          designRequests.push(request)
          return { ok: true, payload: { results: [{}, {}], changed: {} } }
        }
      },
      port: 0
    })
    configDir = mkdtempSync(join(tmpdir(), 'goatcad-e2e-'))
    // Exactly what the app writes at startup: the address, the token, and the
    // client itself. If this arrangement is wrong, `connect()` cannot work.
    mkdirSync(join(configDir, 'python'), { recursive: true })
    writeFileSync(
      join(configDir, 'python', 'goatcad.py'),
      renderPythonClient(registry.list(), configDir)
    )
    const endpoint = JSON.stringify(
      buildEndpoint(server.port, '/mcp', '0.0.0', process.pid, Date.now())
    )
    writeToken(configDir, noKeyring, TOKEN)
    writeFileSync(join(configDir, 'goatcad-endpoint.json'), endpoint)
    encryptedDir = mkdtempSync(join(tmpdir(), 'goatcad-e2e-keyring-'))
    writeToken(encryptedDir, keyring, TOKEN)
    writeFileSync(join(encryptedDir, 'goatcad-endpoint.json'), endpoint)

    socketDir = mkdtempSync(join(tmpdir(), 'goatcad-e2e-socket-'))
    const socketPath = join(socketDir, 'goatcad.sock')
    socketServer = await startPartsMcpServer({
      token: TOKEN,
      socketPath,
      trusted: true,
      sessions: createMcpSessions(),
      context: {
        parts: service,
        design: async (_request, caller) => {
          named.push(caller.workspace)
          return { ok: true, payload: {} }
        }
      }
    })
    writeToken(socketDir, keyring, TOKEN)
    writeFileSync(
      join(socketDir, 'goatcad-endpoint.json'),
      JSON.stringify(
        buildEndpoint(server.port, '/mcp', '0.0.0', process.pid, Date.now(), {
          path: socketPath,
          trusted: true
        })
      )
    )
  })

  afterAll(async () => {
    await server?.close()
    await socketServer?.close()
    rmSync(socketDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
    rmSync(encryptedDir, { recursive: true, force: true })
  })

  /** Run a snippet against the live server. The client's own timeout is short
   *  here on purpose: a test that waits out a 30-second default is a test that
   *  reports a hang as a hang, eventually, instead of a failure now. */
  const script = async (body: string, env: Record<string, string> = {}): Promise<string> => {
    const file = join(configDir, 'script.py')
    writeFileSync(
      file,
      [
        'import sys',
        `sys.path.insert(0, ${JSON.stringify(join(configDir, 'python'))})`,
        'from goatcad import connect, NotConnected, Refused',
        body
      ].join('\n')
    )
    // Run from an agent tab, this suite would otherwise inherit the real token.
    const inherited = { ...process.env }
    delete inherited.GOATCAD_MCP_TOKEN
    delete inherited.GOATCAD_URL
    const { stdout } = await run(python, [file], {
      env: { ...inherited, GOATCAD_CONFIG_DIR: configDir, ...env },
      timeout: 5000
    })
    return stdout.trim()
  }

  /** A snippet run with `gc` already connected through the published store. */
  const connected = (body: string): Promise<string> =>
    script(['gc = connect(timeout=3)', body].join('\n'))

  it('reads the token from the environment an agent tab is given', async () => {
    // The store beside the address is encrypted, so only the variable can work.
    const out = await script('print(connect(timeout=3).parts.status()["connectedCount"])', {
      GOATCAD_CONFIG_DIR: encryptedDir,
      GOATCAD_MCP_TOKEN: TOKEN
    })
    expect(out).toBe('1')
  })

  it('says where to get the token when the store is encrypted and none was handed over', async () => {
    const out = await script(
      [
        'try:',
        '    connect(timeout=3)',
        '    print("NO ERROR")',
        'except NotConnected as err:',
        '    print(err)'
      ].join('\n'),
      { GOATCAD_CONFIG_DIR: encryptedDir }
    )
    expect(out).toContain('encrypted')
    expect(out).toContain('GOATCAD_MCP_TOKEN')
    expect(out).toContain('Settings > AI Integrations')
  })

  it('connects through the user-only socket with no token, naming its workspace on each call', async () => {
    const out = await script(
      [
        'gc = connect(workspace="ws_py", timeout=3)',
        'print(gc.parts.status()["connectedCount"])',
        'gc.workspace.save()',
        'gc.workspace.save(workspace="ws_other")'
      ].join('\n'),
      { GOATCAD_CONFIG_DIR: socketDir }
    )
    expect(out).toBe('1')
    expect(named).toEqual(['ws_py', 'ws_other'])
  })

  it('connects with no arguments and calls an operation', async () => {
    // No host, no port and no token in the script: the app published all three.
    expect(await connected('print(gc.parts.status()["connectedCount"])')).toBe('1')
  })

  it('raises a typed error carrying the fix, so a traceback says what to do next', async () => {
    const out = await connected(
      [
        'try:',
        '    gc.parts.search(distributor="digikey", query="")',
        '    print("NO ERROR")',
        'except Refused as err:',
        '    print("fix:" + (err.fix or "")[:24])'
      ].join('\n')
    )
    expect(out).toContain('fix:')
  })

  it('reaches a verb by name even when the generated method is not there', async () => {
    // The escape hatch: an app newer than the client still answers.
    expect(await connected('print(gc.call("parts.status")["connectedCount"])')).toBe('1')
  })

  it('lists the operations it was generated from', async () => {
    expect(await connected('print(len(gc.ops()))')).toBe(String(registry.list().length))
  })

  it('refuses an argument the schema does not declare, from Python as from anywhere', async () => {
    const out = await connected(
      [
        'from goatcad import InvalidArgs',
        'try:',
        '    gc.call("parts.status", {"nope": 1})',
        '    print("NO ERROR")',
        'except InvalidArgs as err:',
        '    print(err.path)'
      ].join('\n')
    )
    expect(out).toBe('/nope')
  })

  it('sends the edits of a board transaction as one board.batch, the board named once', async () => {
    designRequests.length = 0
    const out = await connected(
      [
        'with gc.transaction(board=True, refill=True, action="Move U1") as step:',
        '    gc.items.update(id="U1", record={"at": {"x": 1, "y": 2}}, viewport="viewport-1")',
        '    gc.items.create(kind="track", record={"layer": "F.Cu", "points": ["U1.1", "C1.1"]})',
        'print(len(step.results))',
        'try:',
        '    with gc.transaction(board=True):',
        '        gc.board.refill()',
        'except ValueError as err:',
        '    print("refused")'
      ].join('\n')
    )
    expect(out.split('\n')).toEqual(['2', 'refused'])
    expect(designRequests).toHaveLength(1)
    const [batch] = designRequests
    expect(batch).toMatchObject({
      kind: 'batch-board',
      refill: true,
      viewport: 'viewport-1',
      action: 'Move U1'
    })
    expect((batch as { ops: Array<{ kind: string }> }).ops.map((op) => op.kind)).toEqual([
      'update-board-item',
      'create-board-item'
    ])
  })
})
