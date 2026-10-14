/**
 * Asking a window to read or edit the open design.
 *
 * The premise, stated once here
 * because every write tool depends on it: **main cannot do this itself.** The
 * KiCad AST layer (`lib/kicad/schematic.ts` and friends) lives in the renderer,
 * main holds only the lite parsers the index needs, dirty buffers have never
 * crossed IPC (ARCHITECTURE §3.9), and RULES.md §8 requires mutations to flow
 * through the undo/redo command layer. A tool that wrote `.kicad_sch` from main
 * would therefore need a second serializer, would silently fight an unsaved
 * buffer, and would leave nothing to undo.
 *
 * So a design tool is a **request to a window of the caller's workspace**
 * (`workspaces.ts`), and the edit arrives as an ordinary undoable command on a
 * dirty tab. That is also the whole consent story: the change is visible once a
 * window shows it and Ctrl+Z reverses it, which is a better guarantee than a
 * confirmation dialog an agent would only learn to expect.
 *
 * This module is the Electron half — the transport, the correlation and the
 * timeout. The ops that use it stay pure in `ops/`.
 */
import { BrowserWindow, ipcMain } from 'electron'
import type { McpDesignReply, McpDesignRequest, McpOpenViewportRequest } from '../preload/mcpTypes'
import { pickDesignWindow, type DesignWindowState } from './designWindow'
import { createAgentViewportRoutes } from './agentViewportRoutes'
import { resolveWorkspace, workspaces, type Workspace } from './workspaces'
import type { Caller } from './ops/context'

/**
 * How long a window gets to answer.
 *
 * Generous on purpose: a request may have to open a tab, and opening a tab
 * parses the sheet plus every sheet in its hierarchy. The failure this guards is
 * a wedged or crashed renderer, not a slow one, and answering "timeout" to a
 * request that was about to succeed is the worse mistake.
 */
export const DESIGN_TIMEOUT_MS = 30_000

export type DesignOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; error: string; detail?: string; candidates?: string[] }

interface Pending {
  resolve: (outcome: DesignOutcome) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()
let nextId = 0

/** What each window has open, supplied by the window manager; absent in tests
 *  and until it registers. */
let windowStates: (() => DesignWindowState[]) | null = null

export function setDesignWindowSource(source: () => DesignWindowState[]): void {
  windowStates = source
}

/** Which window holds each agent viewport, and each connection's one. */
const viewportRoutes = createAgentViewportRoutes()

const liveWindow = (id: number | null): BrowserWindow | null => {
  const win = id === null ? null : BrowserWindow.fromId(id)
  return win && !win.isDestroyed() ? win : null
}

type Target = { win: BrowserWindow; workspace: Workspace } | DesignOutcome

/** Which window answers: the one holding the viewport a request names, else
 *  the window of the caller's workspace that holds the document
 *  (`designWindow.ts`). Never the focused one. */
const targetWindow = (request: McpDesignRequest, caller: Caller): Target => {
  const resolved = resolveWorkspace(caller.workspace)
  if (!('workspace' in resolved)) return { ok: false, ...resolved }
  const { workspace } = resolved
  const viewport = (request as { viewport?: unknown }).viewport
  const holding =
    typeof viewport === 'string' ? liveWindow(viewportRoutes.windowOf(viewport)) : null
  if (holding && workspace.windows.includes(holding.id)) return { win: holding, workspace }
  const states = windowStates?.() ?? []
  const picked = pickDesignWindow(
    request as unknown as Record<string, unknown>,
    workspace.id,
    states
  )
  if (picked && 'refused' in picked)
    return {
      ok: false,
      error: picked.refused,
      detail: picked.detail,
      candidates: picked.candidates
    }
  const win =
    liveWindow(picked?.window ?? null) ??
    workspace.windows.map(liveWindow).find((live) => live !== null)
  return win ? { win, workspace } : NO_WINDOW
}

/** A `window` names where a tab goes; it is main's to read, not the renderer's. */
const withoutWindow = (request: McpDesignRequest): McpDesignRequest => {
  if (!('window' in request)) return request
  const copy: Record<string, unknown> = { ...request }
  delete copy.window
  return copy as unknown as McpDesignRequest
}

/**
 * New windows whose renderer has not yet said it answers. A request sent before
 * its listener exists is lost, and an agent asks the moment it starts a
 * workspace, so sends to such a window wait (`mcp:design-ready`).
 */
const unready = new Map<number, { ready: Promise<void>; resolve: () => void }>()

/** A window was just created: hold its requests until its renderer is ready. */
export function expectDesignWindow(window: number): void {
  let resolve = (): void => {}
  const ready = new Promise<void>((done) => (resolve = done))
  unready.set(window, { ready, resolve })
}

/** The renderer answers from now on, or the window is gone. */
export function designWindowReady(window: number): void {
  unready.get(window)?.resolve()
  unready.delete(window)
}

/** Resolves when the window answers, or after the request timeout, whichever is first. */
const whenReady = (window: number): Promise<void> => {
  const entry = unready.get(window)
  if (!entry) return Promise.resolve()
  return new Promise((done) => {
    const timer = setTimeout(done, DESIGN_TIMEOUT_MS)
    void entry.ready.then(() => {
      clearTimeout(timer)
      done()
    })
  })
}

const settle = (id: string, outcome: DesignOutcome): void => {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  clearTimeout(entry.timer)
  entry.resolve(outcome)
}

export function registerDesignBridge(): void {
  ipcMain.on('mcp:design-ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) designWindowReady(win.id)
  })
  ipcMain.on('mcp:design-reply', (_event, reply: McpDesignReply) => {
    if (!reply || typeof reply.id !== 'string') return
    settle(
      reply.id,
      reply.ok
        ? { ok: true, payload: reply.payload }
        : {
            ok: false,
            error: reply.error ?? 'renderer-failed',
            detail: reply.detail,
            ...(reply.candidates ? { candidates: reply.candidates } : {})
          }
    )
  })
}

/**
 * Send one request and await the window's answer.
 *
 * Never throws: a dead window, a timeout and a refusal all come back as typed
 * outcomes, because the caller is a tool result an agent has to act on.
 */
export async function requestDesign(
  request: McpDesignRequest,
  caller: Caller = {}
): Promise<DesignOutcome> {
  const gone = closedWindowViewport(request)
  if (gone) return gone
  const target = targetWindow(request, caller)
  if ('ok' in target) return target
  if (request.kind === 'open-viewport' && request.viewport === undefined)
    return openViewport(request, target.win, target.workspace)
  return send(target.win, withoutWindow(request))
}

/** Ask one window directly, for the workspace service (`workspaceService.ts`). */
export const askWindow = (window: number, request: McpDesignRequest): Promise<DesignOutcome> => {
  const win = liveWindow(window)
  return win ? send(win, request) : Promise.resolve(NO_WINDOW)
}

/** A viewport whose window closed went with it; another window would only answer that it never knew it. */
const closedWindowViewport = (request: McpDesignRequest): DesignOutcome | null => {
  const viewport = (request as { viewport?: unknown }).viewport
  if (typeof viewport !== 'string') return null
  const window = viewportRoutes.windowOf(viewport)
  if (window === null || liveWindow(window)) return null
  return {
    ok: false,
    error: 'viewport-closed',
    detail: `Viewport ${viewport} closed. Its window was closed.`
  }
}

const NO_WINDOW: DesignOutcome = {
  ok: false,
  error: 'no-window',
  detail: 'The workspace has no live window, so there is no design to read or edit.'
}

/**
 * `viewport.open` without an id: the connection's own viewport when it has
 * one, relabeled and moved, else a new one. One held by another window
 * closes there first, and opens here under the same id.
 */
const openViewport = async (
  request: McpOpenViewportRequest,
  win: BrowserWindow,
  workspace: Workspace
): Promise<DesignOutcome> => {
  const { connection, ...rest } = request
  const id = viewportRoutes.idFor(connection, workspace.id)
  const holder = liveWindow(viewportRoutes.windowOf(id))
  if (connection !== undefined && holder && holder.id !== win.id)
    await send(holder, {
      kind: 'close-viewport',
      viewport: id,
      reason: 'viewport_open moved it to another window.'
    })
  const outcome = await send(win, { ...rest, id })
  const answered = outcome.ok ? (outcome.payload as { viewport?: unknown } | null) : null
  if (typeof answered?.viewport === 'string')
    viewportRoutes.opened(answered.viewport, win.id, connection, workspace.id)
  return outcome
}

/**
 * An agent connection ended (`mcpSessions.ts`): its viewports close, and
 * any routing in them ends.
 */
export function endAgentConnection(connection: string): void {
  for (const held of viewportRoutes.end(connection)) {
    const win = liveWindow(held.window)
    if (win)
      void send(win, {
        kind: 'close-viewport',
        viewport: held.id,
        reason: 'Its client disconnected.'
      })
  }
}

const send = async (win: BrowserWindow, request: McpDesignRequest): Promise<DesignOutcome> => {
  // A shown workspace's window is made visible before sending: an edit the user
  // cannot see is an edit they cannot undo. Visible, not *in front*: an agent
  // calls this dozens of times, and `show()` on macOS activates the app on every
  // one of them, yanking focus from the terminal they are typing in. A minimized
  // window is restored (the one case where nothing is on screen); otherwise it
  // is shown without activation. A workspace with no window keeps its renderer
  // unseen until someone opens one on it.
  if (!workspaces.ofWindow(win.id)?.hidden) {
    if (win.isMinimized()) win.restore()
    else if (!win.isVisible()) win.showInactive()
  }

  if (unready.has(win.id)) {
    await whenReady(win.id)
    if (win.isDestroyed()) return NO_WINDOW
  }
  const id = `design-${++nextId}`
  return new Promise<DesignOutcome>((resolve) => {
    const timer = setTimeout(() => {
      settle(id, {
        ok: false,
        error: 'timeout',
        detail: `The window did not answer within ${DESIGN_TIMEOUT_MS / 1000}s. It may be busy with a large file; do not retry blindly.`
      })
    }, DESIGN_TIMEOUT_MS)
    pending.set(id, { resolve, timer })

    try {
      win.webContents.send('mcp:design-request', { id, request })
    } catch (err) {
      settle(id, {
        ok: false,
        error: 'send-failed',
        detail: err instanceof Error ? err.message : String(err)
      })
    }
  })
}

/** Fail every in-flight request. Called on quit so a pending tool call gets an
 *  answer rather than hanging until its timeout on a process that has gone. */
export function abortDesignRequests(): void {
  for (const id of [...pending.keys()]) {
    settle(id, { ok: false, error: 'app-closing', detail: 'GoatCAD is shutting down.' })
  }
}
