/**
 * Workspaces: what a person has open, and which one each agent connection
 * acts in (docs/agent-api.md, "Workspaces").
 *
 * A workspace is a folder, a project in it, both or neither, and the windows
 * showing it. A window belongs to exactly one, and a file is open in one window
 * of one workspace, so a project is in one workspace. A workspace with no window
 * shown still has one renderer, hidden, holding its documents; its first window
 * is that renderer shown, so undo and unsaved edits carry over.
 *
 * A call acts in the workspace it names (`workspace`, or a client's
 * `X-GoatCAD-Workspace` header), else in the only one open; with several open
 * and none named it is refused (`resolveWorkspace`). Nothing here reads focus:
 * which window the person is looking at never decides where an agent writes.
 *
 * Pure and Electron-free: `index.ts` owns the windows and tells this module what
 * they hold; `partsMcpBridge.ts` asks it where a request goes.
 */
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'

export interface Workspace {
  /** `ws_…`, unique for one app run; read from answers, never built. */
  id: string
  /** The folder: tree, search, git. */
  root: string | null
  /** The active `.kicad_pro`. */
  project: string | null
  /** BrowserWindow ids, oldest first. */
  windows: number[]
  /** Its one renderer is not shown: the workspace has no window. */
  hidden: boolean
}

export interface WindowRow {
  /** `win_…`, unique for one app run. */
  id: string
  files: string[]
}

export interface WorkspaceRow {
  id: string
  root: string | null
  project: { path: string; name: string } | null
  /** Empty when the workspace has no window. */
  windows: WindowRow[]
}

export interface Workspaces {
  /** A new workspace holding one renderer, shown or not. */
  create(init: {
    root: string | null
    project: string | null
    window: number
    hidden?: boolean
  }): Workspace
  /** Another window joins a workspace. */
  join(id: string, window: number): void
  /** A window closed. Answers its workspace when that was its last window, which ends it. */
  leave(window: number): Workspace | null
  /**
   * A window's renderer says which folder and project it has open. A sole
   * window changes its workspace; one of several moves to a new workspace of
   * its own, since a folder belongs to one.
   */
  report(window: number, open: { root: string | null; project: string | null }): void
  /** The hidden renderer is shown: the workspace has its first window. */
  reveal(id: string): void
  /** Set a workspace's folder and project ahead of its windows' reports (`workspace.update`). */
  set(id: string, open: { root: string | null; project: string | null }): void
  ofWindow(window: number): Workspace | null
  get(id: string): Workspace | null
  all(): Workspace[]
  /** The workspace holding a folder or project, if one does. */
  holding(path: string): Workspace | null
  /** The BrowserWindow id behind a `win_…` id. */
  windowById(id: string): number | null
  windowKey(window: number): string
  /** The connection that started a workspace owns it; a hidden one goes when that connection does. */
  own(id: string, connection: string): void
  ownedBy(connection: string): Workspace[]
  row(workspace: Workspace, files: (window: number) => string[]): WorkspaceRow
}

const shortId = (prefix: string): string => `${prefix}_${randomBytes(3).toString('hex')}`

/** Paths compared as the OS spells them case-insensitively, the way `designWindow.ts` does. */
export const samePath = (a: string, b: string): boolean =>
  a
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase() ===
  b
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()

/** Is `path` the folder `dir` or inside it? */
export const isWithin = (path: string, dir: string): boolean => {
  const inner = path.replace(/[\\/]+/g, '/').toLowerCase()
  const outer = dir
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
  return inner === outer || inner.startsWith(`${outer}/`)
}

export const createWorkspaces = (
  options: { newId?: (prefix: string) => string } = {}
): Workspaces => {
  const newId = options.newId ?? shortId
  const byId = new Map<string, Workspace>()
  const byWindow = new Map<number, Workspace>()
  const windowKeys = new Map<number, string>()
  const owners = new Map<string, string>()

  const windowKey = (window: number): string => {
    let key = windowKeys.get(window)
    if (!key) {
      key = newId('win')
      windowKeys.set(window, key)
    }
    return key
  }

  const create: Workspaces['create'] = ({ root, project, window, hidden }) => {
    const workspace: Workspace = {
      id: newId('ws'),
      root,
      project,
      windows: [window],
      hidden: hidden === true
    }
    byId.set(workspace.id, workspace)
    byWindow.set(window, workspace)
    windowKey(window)
    return workspace
  }

  const end = (workspace: Workspace): void => {
    byId.delete(workspace.id)
    owners.delete(workspace.id)
  }

  return {
    create,
    join(id, window) {
      const workspace = byId.get(id)
      if (!workspace || workspace.windows.includes(window)) return
      workspace.windows.push(window)
      byWindow.set(window, workspace)
      windowKey(window)
    },
    leave(window) {
      const workspace = byWindow.get(window)
      byWindow.delete(window)
      windowKeys.delete(window)
      if (!workspace) return null
      workspace.windows = workspace.windows.filter((id) => id !== window)
      if (workspace.windows.length > 0) return null
      end(workspace)
      return workspace
    },
    report(window, open) {
      const workspace = byWindow.get(window)
      if (!workspace) return
      const sameRoot =
        open.root === workspace.root ||
        (open.root !== null && workspace.root !== null && samePath(open.root, workspace.root))
      if (sameRoot || workspace.windows.length === 1) {
        workspace.root = open.root
        workspace.project = open.project
        return
      }
      workspace.windows = workspace.windows.filter((id) => id !== window)
      create({ root: open.root, project: open.project, window })
    },
    reveal(id) {
      const workspace = byId.get(id)
      if (workspace) workspace.hidden = false
    },
    set(id, open) {
      const workspace = byId.get(id)
      if (!workspace) return
      workspace.root = open.root
      workspace.project = open.project
    },
    ofWindow: (window) => byWindow.get(window) ?? null,
    get: (id) => byId.get(id) ?? null,
    all: () => [...byId.values()],
    holding(path) {
      let best: Workspace | null = null
      for (const workspace of byId.values()) {
        if (workspace.project && samePath(workspace.project, path)) return workspace
        // The innermost folder wins: a project nested in another's folder is its own.
        if (workspace.root && isWithin(path, workspace.root))
          if (!best?.root || workspace.root.length > best.root.length) best = workspace
      }
      return best
    },
    windowById(id) {
      for (const [window, key] of windowKeys) if (key === id) return window
      return null
    },
    windowKey,
    own(id, connection) {
      if (byId.has(id)) owners.set(id, connection)
    },
    ownedBy: (connection) =>
      [...owners].flatMap(([id, owner]) => {
        const workspace = owner === connection ? byId.get(id) : undefined
        return workspace ? [workspace] : []
      }),
    row(workspace, files) {
      return {
        id: workspace.id,
        root: workspace.root,
        project: workspace.project
          ? {
              path: workspace.project,
              name: basename(workspace.project).replace(/\.kicad_pro$/i, '')
            }
          : null,
        windows: workspace.hidden
          ? []
          : workspace.windows.map((window) => ({ id: windowKey(window), files: files(window) }))
      }
    }
  }
}

/** The app's workspaces, one set per process. */
export const workspaces = createWorkspaces()

/**
 * The workspace a call acts in: the one it names, else the only one open. Two
 * or more open and none named is refused rather than guessed, since one of them
 * may be the person's own.
 */
export const resolveWorkspace = (
  named: string | undefined,
  registry: Workspaces = workspaces
): { workspace: Workspace } | { error: string; detail: string; candidates: string[] } => {
  const open = registry.all()
  const ids = open.map((workspace) => workspace.id)
  if (named !== undefined) {
    const workspace = registry.get(named)
    return workspace
      ? { workspace }
      : {
          error: 'workspace-not-found',
          detail: `No workspace is called ${named}.`,
          candidates: ids
        }
  }
  if (open.length === 1) return { workspace: open[0] }
  const listed = open
    .map((workspace) => `${workspace.id} (${workspace.project ?? workspace.root ?? 'no folder'})`)
    .join(', ')
  return open.length === 0
    ? { error: 'no-workspace', detail: 'No workspace is open.', candidates: [] }
    : {
        error: 'workspace-required',
        detail: `${open.length} workspaces are open: ${listed}. Pass workspace.`,
        candidates: ids
      }
}
