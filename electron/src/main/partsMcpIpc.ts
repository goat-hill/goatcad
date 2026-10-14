/**
 * Electron wiring for the parts MCP server — the split `partsIpc.ts` makes for
 * `parts.ts`, for the same reason: `partsMcp*.ts` stay Electron-free and
 * unit-testable, and everything that needs `app`, `BrowserWindow` or a token on
 * disk lives here.
 *
 * The server is started once, for the process rather than per window: one
 * app, one listener, one quota.
 */
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { partsService } from './partsIpc'
import { outboundFetch } from './outboundFetch'
import { projectIndexRecords, systemIndexRecords } from './libraryIndex'
import {
  abortDesignRequests,
  endAgentConnection,
  registerDesignBridge,
  requestDesign
} from './partsMcpBridge'
import { createMcpSessions } from './mcpSessions'
import {
  adoptDatasheet,
  cachedDatasheet,
  datasheetPath,
  fetchDatasheet
} from './partsMcpDatasheetStore'
import { readDatasheet } from './datasheetLoader'
import { cacheModel, type ModelCacheInput } from './partsMcpModelStore'
import { loadStepFile } from './stepLoader'
import type { OpEffect, WorkspaceService } from './ops/context'
import { resolveWorkspace } from './workspaces'
import {
  DEFAULT_MCP_PORT,
  MCP_PATH,
  startPartsMcpServer,
  type PartsMcpServerHandle,
  type PartsMcpServerOptions
} from './partsMcpServer'
import { loadOrCreateToken, newToken, writeToken } from './mcpToken'
import { MCP_CLIENTS, promptCommand } from './partsMcpClients'
import {
  buildEndpoint,
  clearEndpoint,
  socketPathFor,
  socketTrusted,
  writeEndpoint
} from './mcpEndpoint'
import { scriptingInfo, writePythonClient } from './agentScripting'
import { registry } from './ops'
import { MCP_PROMPTS } from './partsMcp'
import { toolInfo } from './ops/surface'
import type { McpClientInfo, McpServerStatus, McpSurface } from '../preload/mcpTypes'

let handle: PartsMcpServerHandle | null = null
/** The same server on the user-only socket (`mcpEndpoint.ts`). */
let socketHandle: PartsMcpServerHandle | null = null
let socketAt: { path: string; trusted: boolean } | null = null
let activeToken: string | null = null
/** The stored token could not be read at launch and a fresh one replaced it
 *  (`mcpToken.ts`). Shown until the next replacement, since every manual
 *  registration just stopped working and nothing else would say why. */
let tokenReset = false
/** The workspace ops' service. Set by `index.ts`, which owns the windows —
 *  injected rather than imported, so this module does not depend on the module
 *  that imports it. */
let workspaceService: WorkspaceService | undefined

export const setWorkspaceService = (service: WorkspaceService): void => {
  workspaceService = service
}

/**
 * Act on a tool's effect.
 *
 * `parts_open_settings` is the only one, and it is the only write-shaped thing
 * on this surface: an agent cannot install a key — a secret must never cross
 * this interface — so the remedy it can offer is to put the human in front of
 * the form.
 */
const applyEffect = (effect: OpEffect): void => {
  if (effect.kind !== 'open-settings') return
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  // Show before sending: a request to open Settings that lands behind another
  // window has technically succeeded and visibly done nothing.
  if (win.isMinimized()) win.restore()
  win.show()
  win.webContents.send('parts:open-settings', effect.provider)
}

/** Where a client should point. The one place the URL is spelled. */
const liveUrl = (): string | null => (handle ? `http://127.0.0.1:${handle.port}${MCP_PATH}` : null)

/**
 * The server as an agent tab should be told about it (`terminalSessions.ts`):
 * the live URL and token, given on the CLI's command line for that one
 * session. Null while the server is not running, in which case the tab launches
 * without it rather than with a definition that would fail on first use.
 */
export const mcpLaunch = (): { url: string; token: string } | null => {
  const url = liveUrl()
  return url && activeToken ? { url, token: activeToken } : null
}

/**
 * What Settings shows: the server, what it exposes, and the manual path for
 * each client — the line a person registers with in a terminal of their own,
 * outside GoatCAD. Tabs opened inside the app need none of this
 * (`partsMcpClients.ts`).
 */
export function mcpStatus(): McpServerStatus {
  const url = liveUrl()
  const clients: McpClientInfo[] = MCP_CLIENTS.map((client) => ({
    id: client.id,
    name: client.name,
    manual: client.manual,
    manualText:
      url && activeToken
        ? client.manualText({ url, token: activeToken, dev: !app.isPackaged })
        : null,
    configPath: client.configPath()
  }))

  return {
    running: handle !== null,
    port: handle?.port ?? null,
    url,
    clients,
    token: handle ? activeToken : null,
    tokenReset
  }
}

/** What every tool and prompt takes, for Settings' inspector. */
export function mcpSurface(): McpSurface {
  return {
    prompts: MCP_PROMPTS.map((prompt) => ({
      command: promptCommand(prompt.name),
      description: prompt.description,
      arguments: prompt.arguments.map((argument) => ({
        name: argument.name,
        description: argument.description,
        required: argument.required === true
      }))
    })),
    tools: registry.list().map(toolInfo)
  }
}

export function registerPartsMcpIpc(): void {
  registerDesignBridge()

  ipcMain.handle('mcp:status', () => mcpStatus())
  ipcMain.handle('mcp:surface', () => mcpSurface())

  /**
   * Mint a new token and restart the listener with it.
   *
   * Nothing holds the old one for long: an agent tab is handed the token when
   * it launches, so the next launch has the new one, and a running tab keeps
   * working only until its session ends. The manual path is the one thing to
   * redo by hand, and Settings reprints its line.
   */
  ipcMain.handle('mcp:regenerate-token', async () => {
    activeToken = writeToken(app.getPath('userData'), safeStorage, newToken())
    tokenReset = false
    await stopPartsMcp()
    const started = await startPartsMcp()
    if (!started.ok) return { ok: false, detail: started.reason }
    return { ok: true }
  })
}

/** Agent connections; one that ends takes its viewports and its hidden workspaces with it. */
const agentSessions = createMcpSessions()
const endListeners = new Set<() => void>()
agentSessions.onEnd((connection) => {
  endAgentConnection(connection)
  void workspaceService?.release(connection).finally(() => {
    for (const listener of endListeners) listener()
  })
})

/** Run after each agent connection ends and its workspaces are released. */
export const onAgentConnectionEnd = (listener: () => void): void => {
  endListeners.add(listener)
}

/** Agent clients holding a connection open now, for the background launch's idle quit. */
export const activeAgentConnections = (): number => agentSessions.active()

/**
 * Start the server, or report why it could not start.
 *
 * A taken port is returned rather than worked around: silently moving to a
 * random one staleness-breaks the user's one-time client registration, which is
 * worse than saying so.
 */
export async function startPartsMcp(
  port: number = DEFAULT_MCP_PORT
): Promise<
  { ok: true; port: number } | { ok: false; reason: 'port-in-use' | 'failed'; detail?: string }
> {
  if (handle) return { ok: true, port: handle.port }

  if (activeToken === null) {
    const loaded = loadOrCreateToken(app.getPath('userData'), safeStorage)
    activeToken = loaded.token
    tokenReset = loaded.reset
  }
  const token = activeToken

  try {
    const options = {
      token,
      sessions: agentSessions,
      context: {
        parts: partsService(),
        emit: applyEffect,
        project: (caller) => {
          const resolved = resolveWorkspace(caller.workspace)
          return 'workspace' in resolved ? resolved.workspace.root : null
        },
        get workspaces() {
          return workspaceService
        },
        scripting: () => scriptingInfo(app.getPath('userData')),
        // Read-only views of the index the app already maintains; nothing here
        // triggers a scan the Libraries panel would not have triggered anyway.
        library: { system: systemIndexRecords, project: projectIndexRecords },
        design: requestDesign,
        datasheets: {
          cached: cachedDatasheet,
          path: datasheetPath,
          // `Date.now()` is injected at the edge so the store stays testable.
          fetch: (projectPath, mpn, candidates, refresh) =>
            fetchDatasheet(projectPath, mpn, candidates, outboundFetch, Date.now(), refresh),
          adopt: (projectPath, mpn, sourcePath, provenance) =>
            adoptDatasheet(projectPath, mpn, sourcePath, Date.now(), provenance)
        },
        datasheetReader: { read: readDatasheet },
        models: {
          cache: (projectPath: string, input: ModelCacheInput) =>
            cacheModel(projectPath, input, outboundFetch, loadStepFile, Date.now())
        }
      }
    } satisfies PartsMcpServerOptions
    handle = await startPartsMcpServer({ ...options, port })
    socketAt = await startSocket(options)
    // Publish the address and the client together: an agent that finds one and
    // not the other has half a path to scripting the app.
    writePythonClient(app.getPath('userData'))
    writeEndpoint(
      app.getPath('userData'),
      buildEndpoint(handle.port, MCP_PATH, app.getVersion(), process.pid, Date.now(), socketAt)
    )
    return { ok: true, port: handle.port }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EADDRINUSE') return { ok: false, reason: 'port-in-use' }
    return { ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The same server on the user-only socket. Never fatal: the port still serves,
 * and a client falls back to it.
 */
const startSocket = async (
  options: PartsMcpServerOptions
): Promise<{ path: string; trusted: boolean } | null> => {
  const path = socketPathFor(app.getPath('userData'), process.platform)
  if (!path) return null
  const trusted = socketTrusted(process.platform)
  try {
    socketHandle = await startPartsMcpServer({ ...options, socketPath: path, trusted })
    return { path, trusted }
  } catch (err) {
    console.warn('[parts-mcp] no socket:', err instanceof Error ? err.message : String(err))
    return null
  }
}

export async function stopPartsMcp(): Promise<void> {
  const current = handle
  const socket = socketHandle
  handle = null
  socketHandle = null
  socketAt = null
  // Withdraw the published address first: a client that reads it during the
  // close would otherwise connect to a socket that is already going.
  clearEndpoint(app.getPath('userData'))
  // Answer anything in flight before the socket goes: a tool call left hanging
  // on a closing app waits out its whole timeout for no reason.
  abortDesignRequests()
  await Promise.all([current?.close(), socket?.close()])
}
