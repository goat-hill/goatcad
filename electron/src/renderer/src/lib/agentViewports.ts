/**
 * The agents' viewports in this window: labeled boxes on the person's canvas
 * that show where an agent works (docs/agent-api.md, "The agent
 * viewport"). The door for `viewport.open` / `viewport.close`, and the
 * registry the board and sheet doors move a box through when a render, a
 * layout edit or a routing session names one.
 *
 * Main gives each viewport its id, unique across windows, and keeps one per
 * agent connection (`main/agentViewportRoutes.ts`): an open that carries the
 * id of one this window holds relabels and moves it. A viewport closes on
 * `viewport.close` (from main as well, when its client disconnects),
 * after `VIEWPORT_IDLE_MS` unused, when its document's tab closes, or on the
 * person's ×; a call that names it later is told which (`viewport-closed`), as
 * a routing session's late caller is. Listeners hear every close, so the board
 * door ends the routing in it.
 */
import type {
  McpCloseViewportRequest,
  McpDesignRequest,
  McpOpenViewportRequest
} from '../../../preload/mcpTypes'
import type { AgentViewportShown, ViewportFrame } from './agentViewportView'

/** A viewport nobody named this long closes. */
export const VIEWPORT_IDLE_MS = 10 * 60_000

/** How often live viewports are checked for a closed tab or an idle timeout. */
const VIEWPORT_SWEEP_MS = 30_000

/** Closed viewports whose reason a late call is still told. */
const CLOSED_MEMORY = 16

export type ViewportDocument = 'board' | 'sheet'

export interface AgentViewport {
  id: string
  path: string
  document: ViewportDocument
  label: string
  frame: ViewportFrame | null
  lastUsed: number
}

/** A refusal, as every door answers one. */
export interface ViewportRefusal {
  error: string
  detail?: string
  candidates?: string[]
}

export type ViewportRequest = McpOpenViewportRequest | McpCloseViewportRequest

export const isViewportRequest = (request: McpDesignRequest): request is ViewportRequest =>
  request.kind === 'open-viewport' || request.kind === 'close-viewport'

/** What the registry reads through. The window supplies the real ones; a test, fakes. */
export interface AgentViewportsContext {
  /** Whether a tab holds the document; a viewport on one that none does closes. */
  isOpen(path: string): boolean
  /** Resolve a file an agent named to a project path, or null. */
  resolve?(name: string): string | null
  /** Files like a name that missed, for its refusal. */
  candidates?(name: string): string[]
  /** Open the document's tab behind the active one, when none holds it. */
  open?(path: string): Promise<void>
  /** Show the live viewports on the canvases (`agentViewportView.ts`). */
  show?(list: readonly AgentViewportShown[]): void
  now?(): number
}

/** Why `viewport.close` closes one; its answer tells the agent what the close ended. */
export const CLOSED_BY_AGENT = 'viewport_close closed it.'

/** A routing session a close ended, and what it landed from what it had clicked. */
export interface EndedRouteSession {
  session: string
  landed?: { tracks: string[]; vias: string[] }
  changed?: { created: string[]; updated: string[]; deleted: string[] }
}

/** What a close tells its listeners; one answers with the routing session it ended. */
export type ViewportCloseListener = (
  viewport: AgentViewport,
  reason: string
) => string | EndedRouteSession | void

export interface AgentViewports {
  dispatch(request: ViewportRequest): Promise<unknown>
  /** The live viewport an op names, touched; with `path`, it must be on that document. */
  find(id: string, path?: string): AgentViewport | ViewportRefusal
  /** Open a viewport on a document the caller already resolved; `id` is main's, else one is made. */
  open(path: string, label: string, id?: string): AgentViewport
  /** Move a viewport's box or relabel it; an absent frame or label keeps the last. */
  update(id: string, patch: { frame?: ViewportFrame | null; label?: string }): void
  /**
   * Run an op in a viewport: refused before it runs when `at.viewport` names
   * none on `path`; after, the box frames what `frameOf` reads from the answer
   * (by default a picture's `frame`), takes the call's `action` as its label,
   * and the answer names the viewport. Without a viewport, just runs it.
   */
  framed(
    at: { viewport?: string; action?: string },
    path: string,
    run: () => Promise<unknown>,
    frameOf?: (answer: Record<string, unknown>) => ViewportFrame | null
  ): Promise<unknown>
  /** Close a viewport; answers the routing sessions its listeners ended. */
  close(id: string, reason: string): EndedRouteSession[]
  /** The person's × on the canvas. */
  closeByPerson(id: string): void
  onClose(listener: ViewportCloseListener): () => void
  /** Close viewports whose tab closed or that sat idle. */
  sweep(): void
  live(): readonly AgentViewport[]
}

const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** What a picture framed. */
const pictureFrame = (answer: Record<string, unknown>): ViewportFrame | null =>
  (answer.frame as ViewportFrame | undefined) ?? null

/** Ids of a write's answer: what it created and updated, and what it deleted. */
const writtenIds = (answer: Record<string, unknown>): { now: string[]; gone: string[] } => {
  const changed = answer.changed as
    { created?: string[]; updated?: string[]; deleted?: string[] } | undefined
  return {
    now: [...(changed?.created ?? []), ...(changed?.updated ?? [])],
    gone: changed?.deleted ?? []
  }
}

/**
 * The frame round what a write changed: each id's box where it is now, or,
 * for a deleted one, where it was, grown by `margin` mm. Null when none is found.
 */
export const changedFrame = (
  answer: Record<string, unknown>,
  boxes: {
    now: (id: string) => ViewportFrame | undefined
    was: (id: string) => ViewportFrame | undefined
  },
  margin: number
): ViewportFrame | null => {
  const ids = writtenIds(answer)
  const found = [
    ...ids.now.map((id) => boxes.now(id) ?? boxes.was(id)),
    ...ids.gone.map((id) => boxes.was(id))
  ].filter((box): box is ViewportFrame => box !== undefined)
  if (!found.length) return null
  const minX = Math.min(...found.map((box) => box.x)) - margin
  const minY = Math.min(...found.map((box) => box.y)) - margin
  const maxX = Math.max(...found.map((box) => box.x + box.width)) + margin
  const maxY = Math.max(...found.map((box) => box.y + box.height)) + margin
  const round = (value: number): number => Math.round(value * 1000) / 1000
  return { x: round(minX), y: round(minY), width: round(maxX - minX), height: round(maxY - minY) }
}

const documentOf = (path: string): ViewportDocument | null => {
  const lower = path.toLowerCase()
  return lower.endsWith('.kicad_pcb') ? 'board' : lower.endsWith('.kicad_sch') ? 'sheet' : null
}

/** How an answer names the viewport's document: `board` or `sheet`, `{path, name}`. */
const documentRef = (viewport: AgentViewport): Record<string, { path: string; name: string }> => ({
  [viewport.document]: { path: viewport.path, name: nameOf(viewport.path) }
})

export const createAgentViewports = (ctx: AgentViewportsContext): AgentViewports => {
  const now = (): number => ctx.now?.() ?? Date.now()
  const viewports = new Map<string, AgentViewport>()
  /** Why each recently closed viewport closed, for a caller that still holds its id. */
  const closed = new Map<string, string>()
  const listeners = new Set<ViewportCloseListener>()
  let count = 0
  let timer: ReturnType<typeof setInterval> | null = null

  const publish = (): void =>
    ctx.show?.(
      [...viewports.values()].map((viewport) => ({
        id: viewport.id,
        path: viewport.path,
        label: viewport.label,
        frame: viewport.frame
      }))
    )

  const close = (id: string, reason: string): EndedRouteSession[] => {
    const viewport = viewports.get(id)
    if (!viewport) return []
    viewports.delete(id)
    closed.set(id, reason)
    if (closed.size > CLOSED_MEMORY) closed.delete(closed.keys().next().value!)
    if (viewports.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
    const ended: EndedRouteSession[] = []
    for (const listener of listeners) {
      const session = listener(viewport, reason)
      if (session) ended.push(typeof session === 'string' ? { session } : session)
    }
    publish()
    return ended
  }

  const sweep = (): void => {
    const at = now()
    for (const viewport of [...viewports.values()])
      if (!ctx.isOpen(viewport.path)) close(viewport.id, 'Its tab was closed.')
      else if (at - viewport.lastUsed > VIEWPORT_IDLE_MS)
        close(viewport.id, 'It sat idle for 10 minutes.')
  }

  const find = (id: string, path?: string): AgentViewport | ViewportRefusal => {
    sweep()
    const viewport = viewports.get(id)
    if (!viewport) {
      const reason = closed.get(id)
      return reason
        ? { error: 'viewport-closed', detail: `Viewport ${id} closed. ${reason}` }
        : {
            error: 'viewport-not-found',
            detail: `No viewport ${id} is open.`,
            candidates: [...viewports.keys()]
          }
    }
    if (path !== undefined && viewport.path !== path)
      return {
        error: 'invalid-args',
        detail: `Viewport ${id} is on ${nameOf(viewport.path)}, not ${nameOf(path)}.`
      }
    viewport.lastUsed = now()
    return viewport
  }

  const open = (path: string, label: string, id?: string): AgentViewport => {
    if (id !== undefined) closed.delete(id)
    const viewport: AgentViewport = {
      id: id ?? `viewport-${++count}`,
      path,
      document: documentOf(path) ?? 'board',
      label,
      frame: null,
      lastUsed: now()
    }
    viewports.set(viewport.id, viewport)
    timer ??= setInterval(sweep, VIEWPORT_SWEEP_MS)
    publish()
    return viewport
  }

  const answer = (viewport: AgentViewport, guidance?: string): Record<string, unknown> => ({
    viewport: viewport.id,
    ...documentRef(viewport),
    label: viewport.label,
    ...(viewport.frame ? { frame: viewport.frame } : {}),
    ...(guidance ? { guidance } : {})
  })

  const openViewport = async (request: McpOpenViewportRequest): Promise<unknown> => {
    let path: string | undefined
    if (request.board !== undefined && request.sheet !== undefined)
      return { error: 'invalid-args', detail: 'Pass board or sheet, not both.' }
    const named = request.board ?? request.sheet
    if (named !== undefined) {
      const resolved = ctx.resolve?.(named) ?? null
      if (!resolved)
        return {
          error: 'file-not-found',
          detail: `No file called ${named} is in this project.`,
          candidates: ctx.candidates?.(named) ?? []
        }
      const kind = documentOf(resolved)
      if (kind !== (request.board !== undefined ? 'board' : 'sheet'))
        return {
          error: 'invalid-args',
          detail: `${nameOf(resolved)} is not a ${request.board !== undefined ? 'board' : 'schematic sheet'}.`
        }
      path = resolved
    }
    if (request.viewport !== undefined) {
      const found = find(request.viewport, path)
      if ('error' in found) return found
      found.label = request.label
      publish()
      return answer(found)
    }
    if (path === undefined)
      return { error: 'invalid-args', detail: 'Pass board or sheet, or viewport to relabel one.' }
    const held = request.id !== undefined ? viewports.get(request.id) : undefined
    if (held?.path === path) {
      held.label = request.label
      held.lastUsed = now()
      publish()
      return answer(held, 'Your connection holds one viewport: this relabeled it.')
    }
    if (held) close(held.id, `viewport_open moved it to ${nameOf(path)}.`)
    if (!ctx.isOpen(path)) await ctx.open?.(path)
    return answer(
      open(path, request.label, request.id),
      held
        ? `Your connection holds one viewport: this moved it to ${nameOf(path)}.`
        : 'Pass viewport, and an action saying what the call does, to every render and layout edit on this document; the box shows once one frames something.'
    )
  }

  const closeViewport = async (request: McpCloseViewportRequest): Promise<unknown> => {
    const found = find(request.viewport)
    if ('error' in found) return found
    const ended = close(found.id, request.reason ?? CLOSED_BY_AGENT)
    const landed = ended.find((row) => row.landed)
    return {
      closed: found.id,
      ...(ended.length ? { endedSessions: ended.map((row) => row.session) } : {}),
      // A session ends as Esc ends a route: what it had clicked lands (router-behavior.md R21).
      ...(landed ? { landed: landed.landed, changed: landed.changed } : {})
    }
  }

  return {
    dispatch: (request) =>
      request.kind === 'open-viewport' ? openViewport(request) : closeViewport(request),
    find,
    open,
    update(id, patch) {
      const viewport = viewports.get(id)
      if (!viewport) return
      if (patch.frame) viewport.frame = patch.frame
      if (patch.label) viewport.label = patch.label
      viewport.lastUsed = now()
      publish()
    },
    async framed(at, path, run, frameOf = pictureFrame) {
      if (at.viewport === undefined) return run()
      const found = find(at.viewport, path)
      if ('error' in found) return found
      const answer = await run()
      if (!answer || typeof answer !== 'object') return answer
      const done = answer as Record<string, unknown>
      if (typeof done.error === 'string') return answer
      const frame = frameOf(done)
      if ((frame || at.action) && viewports.has(found.id)) {
        if (frame) found.frame = frame
        // Each call says what is happening now, in place of the last label.
        if (at.action) found.label = at.action
        found.lastUsed = now()
        publish()
      }
      return { ...done, viewport: found.id }
    },
    close,
    closeByPerson: (id) => void close(id, 'The user closed it from the canvas.'),
    onClose(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sweep,
    live: () => [...viewports.values()]
  }
}
