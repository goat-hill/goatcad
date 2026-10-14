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
 * So a design tool is a **request to the window in front of the user**, and the
 * edit arrives as an ordinary undoable command on a dirty tab. That is also the
 * whole consent story: the change is visible the moment it lands and Ctrl+Z
 * reverses it, which is a better guarantee than a confirmation dialog an agent
 * would only learn to expect.
 *
 * This module is the Electron half — the transport, the correlation and the
 * timeout. The ops that use it stay pure in `ops/`.
 */
import { BrowserWindow, ipcMain } from 'electron'
import type { McpDesignReply, McpDesignRequest, McpOpenViewportRequest } from '../preload/mcpTypes'
import { pickDesignWindow, type DesignWindowState } from './designWindow'
import { createAgentViewportRoutes } from './agentViewportRoutes'

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
 *  and until it registers, which leaves the focused-window default. */
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

/** Which window answers. One that holds the viewport a request names does;
 *  otherwise the focused one, which is the one the user is looking at, so
 *  it is the one whose tabs an agent means; a background window is the fallback
 *  for a request arriving while the app is not frontmost. The exception is a
 *  document held open by another window only (`designWindow.ts`). */
const targetWindow = (request: McpDesignRequest): BrowserWindow | null => {
  const viewport = (request as { viewport?: unknown }).viewport
  const holding =
    typeof viewport === 'string' ? liveWindow(viewportRoutes.windowOf(viewport)) : null
  if (holding) return holding
  const holder = windowStates
    ? pickDesignWindow(request as unknown as Record<string, unknown>, windowStates())
    : null
  if (holder !== null) {
    const win = BrowserWindow.fromId(holder)
    if (win && !win.isDestroyed()) return win
  }
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null
}

const settle = (id: string, outcome: DesignOutcome): void => {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  clearTimeout(entry.timer)
  entry.resolve(outcome)
}

export function registerDesignBridge(): void {
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
export async function requestDesign(request: McpDesignRequest): Promise<DesignOutcome> {
  const gone = closedWindowViewport(request)
  if (gone) return gone
  const win = targetWindow(request)
  if (!win) return NO_WINDOW
  if (request.kind === 'open-viewport' && request.viewport === undefined)
    return openViewport(request, win)
  return send(win, request)
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
  detail: 'GoatCAD is running but has no open window, so there is no design to read or edit.'
}

/**
 * `viewport.open` without an id: the connection's own viewport when it has
 * one, relabeled and moved, else a new one. One held by another window
 * closes there first, and opens here under the same id.
 */
const openViewport = async (
  request: McpOpenViewportRequest,
  win: BrowserWindow
): Promise<DesignOutcome> => {
  const { connection, ...rest } = request
  const id = viewportRoutes.idFor(connection)
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
    viewportRoutes.opened(answered.viewport, win.id, connection)
  return outcome
}

/**
 * An agent connection ended (`mcpSessions.ts`): its viewport closes, and
 * any routing in it ends.
 */
export function endAgentConnection(connection: string): void {
  const held = viewportRoutes.end(connection)
  const win = held ? liveWindow(held.window) : null
  if (held && win)
    void send(win, {
      kind: 'close-viewport',
      viewport: held.id,
      reason: 'Its client disconnected.'
    })
}

const send = (win: BrowserWindow, request: McpDesignRequest): Promise<DesignOutcome> => {
  // Visible before sending, for the same reason `parts_open_settings` does: an
  // edit the user cannot see is an edit they cannot undo, and a hidden window
  // makes the tool's whole safety story false. Visible, not *in front*: an
  // agent working alongside the user calls this dozens of times, and `show()`
  // on macOS activates the app on every one of them, yanking focus from the
  // terminal they are typing in. A minimized window is restored (the one case
  // where nothing is on screen); otherwise it is shown without activation.
  if (win.isMinimized()) win.restore()
  else if (!win.isVisible()) win.showInactive()

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
