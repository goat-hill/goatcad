/**
 * The `workspace.*` ops' half in main: starting, attaching, retargeting and
 * closing workspaces and their windows (`workspaces.ts`, `ops/workspace/`).
 *
 * Electron-free: `index.ts`, which owns the windows, supplies them as
 * `WorkspaceWindows`, and a window's unsaved work is asked of its renderer,
 * since main holds no dirty state (ARCHITECTURE §3.0).
 */
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { McpDesignRequest } from '../preload/mcpTypes'
import type { Caller, DesignOutcome, WorkspaceService } from './ops/context'
import {
  callerWorkspace,
  samePath,
  type Workspace,
  type WorkspaceRow,
  type Workspaces
} from './workspaces'

export interface WorkspaceWindows {
  /**
   * A renderer on a folder and project: a new workspace's, or another window of
   * `join`. Answers its BrowserWindow id; the registry knows it on return.
   */
  open(
    init: { root: string | null; project: string | null; tabs: string[] },
    options: { hidden: boolean; join?: string }
  ): number
  show(window: number): void
  /** The paths of the window's open tabs. */
  tabs(window: number): string[]
  /** Close without asking about unsaved work: the caller has asked. */
  close(window: number): void
  removeTab(window: number, path: string): void
  ask(window: number, request: McpDesignRequest): Promise<DesignOutcome>
  /** A connection left its workspace: its viewport closes. */
  leave(connection: string): void
}

type Refusal = { ok: false; error: string; detail?: string; candidates?: string[] }

const refuse = (error: string, detail: string, candidates?: string[]): Refusal => ({
  ok: false,
  error,
  detail,
  ...(candidates ? { candidates } : {})
})

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export const createWorkspaceService = (
  registry: Workspaces,
  windows: WorkspaceWindows
): WorkspaceService => {
  const row = (workspace: Workspace): WorkspaceRow => registry.row(workspace, windows.tabs)

  const notFound = (id: string): Refusal =>
    refuse(
      'workspace-not-found',
      `No workspace is called ${id}.`,
      registry.all().map((workspace) => workspace.id)
    )

  /** A folder and project checked, the folder defaulting to the project's. */
  const place = (
    root: string | undefined,
    project: string | undefined,
    self: Workspace | null
  ): { root: string | null; project: string | null } | Refusal => {
    if (project !== undefined && (!/\.kicad_pro$/i.test(project) || !isFile(project)))
      return refuse('file-not-found', `${project} is not a .kicad_pro file.`)
    const folder = root ?? (project !== undefined ? dirname(project) : undefined)
    if (folder !== undefined && !isDirectory(folder))
      return refuse('file-not-found', `${folder} is not a folder.`)
    for (const path of [project, folder]) {
      const holder = path === undefined ? null : registry.holding(path)
      if (holder && holder !== self)
        return refuse('project-in-workspace', `${path} is in workspace ${holder.id}.`, [holder.id])
    }
    return { root: folder ?? null, project: project ?? null }
  }

  const attachTo = (caller: Caller, workspace: Workspace): void => {
    if (caller.connection === undefined) return
    const before = registry.attachedTo(caller.connection)
    if (before && before !== workspace) windows.leave(caller.connection)
    registry.attach(caller.connection, workspace.id)
  }

  /** Every unsaved document in these windows, asked of each renderer. */
  const unsaved = async (ids: readonly number[]): Promise<string[]> => {
    const paths: string[] = []
    for (const id of ids) {
      const answer = await windows.ask(id, { kind: 'unsaved-files' })
      if (answer.ok) paths.push(...((answer.payload as { unsaved?: string[] }).unsaved ?? []))
    }
    return paths
  }

  const unsavedRefusal = (paths: string[]): Refusal =>
    refuse('unsaved-edits', `Unsaved edits in ${paths.join(', ')}.`, paths)

  return {
    list: () => registry.all().map(row),

    attached(caller) {
      const workspace = callerWorkspace(caller, registry)
      return workspace ? row(workspace) : null
    },

    async start(caller, args) {
      const placed = place(args.root, args.project, null)
      if ('ok' in placed) return placed
      const window = windows.open({ ...placed, tabs: [] }, { hidden: !args.openWindow })
      const workspace = registry.ofWindow(window)
      if (!workspace) return refuse('no-window', 'The new workspace has no window.')
      attachTo(caller, workspace)
      return { ok: true, value: row(workspace) }
    },

    attach(caller, id) {
      const workspace = registry.get(id)
      if (!workspace) return notFound(id)
      if (caller.connection === undefined)
        return refuse(
          'no-connection',
          'This client sends no session id, so it cannot be attached to anything.'
        )
      attachTo(caller, workspace)
      return { ok: true, value: row(workspace) }
    },

    async update(args) {
      const workspace = registry.get(args.workspace)
      if (!workspace) return notFound(args.workspace)
      const placed = place(
        args.root ?? (args.project === undefined ? (workspace.root ?? undefined) : undefined),
        args.project,
        workspace
      )
      if ('ok' in placed) return placed
      if (!placed.root) return refuse('invalid-args', 'Name a folder or a project.')
      const dirty = await unsaved(workspace.windows)
      if (dirty.length) return unsavedRefusal(dirty)
      registry.set(workspace.id, placed)
      for (const id of workspace.windows) {
        const answer = await windows.ask(id, {
          kind: 'set-workspace',
          root: placed.root,
          project: placed.project
        })
        if (!answer.ok) return answer
        // The window's own pick when the project was left to detection.
        const set = answer.payload as { project?: string | null }
        if (!placed.project && set.project)
          registry.set(workspace.id, { ...placed, project: set.project })
      }
      return { ok: true, value: row(workspace) }
    },

    async close(id, discard) {
      const workspace = registry.get(id)
      if (!workspace) return notFound(id)
      if (!discard) {
        const dirty = await unsaved(workspace.windows)
        if (dirty.length) return unsavedRefusal(dirty)
      }
      for (const window of [...workspace.windows]) windows.close(window)
      return { ok: true, value: { closed: id } }
    },

    async openWindow(id, files) {
      const workspace = registry.get(id)
      if (!workspace) return notFound(id)
      if (workspace.hidden) {
        const window = workspace.windows[0]
        windows.show(window)
        registry.reveal(id)
        return { ok: true, value: { id: registry.windowKey(window), files: windows.tabs(window) } }
      }
      const moving: { from: number; path: string }[] = []
      for (const path of files) {
        const from = workspace.windows.find((window) =>
          windows.tabs(window).some((open) => samePath(open, path))
        )
        if (from === undefined)
          return refuse('file-not-open', `${path} is not open in this workspace.`, [
            ...new Set(workspace.windows.flatMap(windows.tabs))
          ])
        moving.push({ from, path })
      }
      const dirty = await unsaved([...new Set(moving.map((entry) => entry.from))])
      const lost = dirty.filter((path) => moving.some((entry) => samePath(entry.path, path)))
      if (lost.length) return unsavedRefusal(lost)
      const window = windows.open(
        {
          root: workspace.root,
          project: workspace.project,
          tabs: moving.map((entry) => entry.path)
        },
        { hidden: false, join: id }
      )
      for (const entry of moving) windows.removeTab(entry.from, entry.path)
      return {
        ok: true,
        value: { id: registry.windowKey(window), files: moving.map((entry) => entry.path) }
      }
    },

    async closeWindow(key, discard) {
      const window = registry.windowById(key)
      const workspace = window === null ? null : registry.ofWindow(window)
      if (window === null || !workspace || workspace.hidden)
        return refuse('window-not-found', `No window is called ${key}.`)
      if (!discard) {
        const dirty = await unsaved([window])
        if (dirty.length) return unsavedRefusal(dirty)
      }
      const last = workspace.windows.length === 1
      windows.close(window)
      return { ok: true, value: { closed: key, workspaceClosed: last } }
    }
  }
}
