/**
 * What an operation is handed, and what it is allowed to reach.
 *
 * Deliberately Electron-free, structural interfaces only: a test drives the
 * whole registry with object literals, the same split as `parts.ts` /
 * `partsIpc.ts`. Nothing here knows what a window is — the app decides that when
 * it builds the context in `partsMcpIpc.ts`.
 *
 * Design: `docs/agent-api.md`.
 */
import type {
  PartCategory,
  PartsCredentialStatus,
  PartsFilterState,
  PartsProviderId,
  PartSearchResult,
  PartsResult,
  PartsSort,
  PartsUsage
} from '../../preload/partsTypes'
import type { IndexRecord } from '../libraryIndexTypes'
import type { McpDesignRequest } from '../../preload/mcpTypes'
import type { DatasheetAttempt, DatasheetCandidate, DatasheetRecord } from '../partsMcpDatasheets'
import type { DatasheetReadRequest, DatasheetReadResult } from '../datasheetReader'
import type { ModelCacheInput, ModelCacheOutcome } from '../partsMcpModelStore'
import type { WindowRow, WorkspaceRow } from '../workspaces'

/**
 * What these operations need from `PartsService` — a structural subset, so a
 * test passes an object literal and nothing drags Electron in.
 */
export interface PartsService {
  credentialStatus(): PartsCredentialStatus[]
  usage(): PartsUsage[]
  categories(provider: PartsProviderId): Promise<PartsResult<PartCategory[]>>
  search(
    provider: PartsProviderId,
    keyword: string,
    limit?: number,
    offset?: number,
    categoryId?: number,
    filters?: PartsFilterState,
    sort?: PartsSort | null
  ): Promise<PartsResult<PartSearchResult>>
}

/** Opening the Settings pane is the only *action* that is not an edit. It
 *  carries no data: a credential must never cross this surface in either
 *  direction, so the remedy an agent can offer is to put the human in front of
 *  the form. */
export type OpEffect = { kind: 'open-settings'; provider: PartsProviderId | null }

/** A datasheet in the project. `sharedWith` names the part whose file this
 *  one reuses — a series datasheet serves every part in it. */
export interface DatasheetSaved {
  ok: true
  record: DatasheetRecord
  path: string
  attempts: DatasheetAttempt[]
  sharedWith?: string
}

export type DatasheetFetchOutcome = DatasheetSaved | { ok: false; attempts: DatasheetAttempt[] }

export type DatasheetAdoptOutcome =
  DatasheetSaved | { ok: false; error: 'not-pdf' | 'too-large' | 'unreadable'; detail: string }

/** Mirrors `partsMcpBridge.ts`'s outcome, restated structurally so this tree
 *  keeps importing no Electron-touching code. */
export type DesignOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; error: string; detail?: string; candidates?: string[] }

/** Who is calling: the connection, and the workspace a call named for itself. */
export interface Caller {
  /** The agent connection the call came on (`mcpSessions.ts`): its MCP session, or
   *  the Python client's id. Absent when the caller sends none. */
  connection?: string
  /** The workspace the call names: its `workspace` argument (`ops/registry.ts`),
   *  else the client's `X-GoatCAD-Workspace` header (`partsMcpServer.ts`). Absent,
   *  the only open workspace is meant (`workspaces.ts`, `resolveWorkspace`). */
  workspace?: string
}

export const callerOf = (ctx: OpContext): Caller => ({
  ...(ctx.connection !== undefined ? { connection: ctx.connection } : {}),
  ...(ctx.workspace !== undefined ? { workspace: ctx.workspace } : {})
})

/** A workspace op's answer: its value, or a refusal shaped like a window's (`ops/design.ts`). */
export type WorkspaceOutcome<T> =
  { ok: true; value: T } | { ok: false; error: string; detail?: string; candidates?: string[] }

/** What the workspace ops reach (`workspaces.ts`); the app serves it, since it owns the windows. */
export interface WorkspaceService {
  list(): WorkspaceRow[]
  /** A new workspace, owned by `owner`, the starting connection: one with no
   *  window goes when that connection ends (`release`). */
  start(
    args: { root?: string; project?: string; openWindow: boolean },
    owner?: string
  ): Promise<WorkspaceOutcome<WorkspaceRow>>
  /** A connection ended: each workspace with no window it started closes, or
   *  shows its window when it holds unsaved edits. */
  release(connection: string): Promise<void>
  /** The workspace a call acts in, or why it has none (`resolveWorkspace`). */
  resolve(caller: Caller): WorkspaceOutcome<WorkspaceRow>
  update(args: {
    workspace: string
    root?: string
    project?: string
  }): Promise<WorkspaceOutcome<WorkspaceRow>>
  close(workspace: string, discard: boolean): Promise<WorkspaceOutcome<{ closed: string }>>
  openWindow(workspace: string, files: string[]): Promise<WorkspaceOutcome<WindowRow>>
  closeWindow(
    window: string,
    discard: boolean
  ): Promise<WorkspaceOutcome<{ closed: string; workspaceClosed: boolean }>>
}

export interface OpContext extends Caller {
  parts: PartsService
  /** Raised for the app to act on. Collected rather than performed here so this
   *  tree stays pure and the server decides what a "window" even is. */
  emit?: (effect: OpEffect) => void
  /** The folder of the caller's workspace, null when it has none or none
   *  resolves. Injected for the same reason `emit` is. */
  project?: (caller: Caller) => string | null
  workspaces?: WorkspaceService
  /** The library index, already built and already incrementally maintained by
   *  `libraryIndex.ts`. Read, never rebuilt from here. */
  library?: {
    system: () => Promise<IndexRecord[]>
    project: (projectPath: string) => IndexRecord[]
  }
  /** Ask the window to read or edit the open design (`partsMcpBridge.ts`). The
   *  one capability that cannot be served from main at all — see that module
   *  for why the AST layer's living in the renderer decides this. */
  design?: (request: McpDesignRequest, caller: Caller) => Promise<DesignOutcome>
  /** Where the Python client was written, and how to import it
   *  (`agentScripting.ts`). Injected because the path is Electron's to know. */
  scripting?: () => {
    pythonPath: string
    modulePath: string
    examplePath: string
    boardExamplePath: string
    guidePath: string
    snippet: string
    operationCount: number
  } | null
  /** The project's datasheet folder (`partsMcpDatasheetStore.ts`). Injected so
   *  this tree keeps touching no `fs`. */
  datasheets?: {
    cached: (projectPath: string, mpn: string) => DatasheetRecord | null
    path: (projectPath: string, record: DatasheetRecord) => string
    /** `refresh` downloads even when another part saved one of the links. */
    fetch: (
      projectPath: string,
      mpn: string,
      candidates: readonly DatasheetCandidate[],
      refresh: boolean
    ) => Promise<DatasheetFetchOutcome>
    adopt: (
      projectPath: string,
      mpn: string,
      sourcePath: string,
      provenance: Pick<DatasheetRecord, 'source' | 'distributor' | 'url'>
    ) => DatasheetAdoptOutcome
  }
  /** PDF reading through the pdfium worker (`datasheetLoader.ts`); absent in
   *  a build without it, and stubbed in tests. */
  datasheetReader?: {
    read: (request: DatasheetReadRequest) => Promise<DatasheetReadResult>
  }
  /** The project's 3D model folder (`partsMcpModelStore.ts`), injected for the
   *  reason `datasheets` is: this tree touches no `fs` and no network. */
  models?: {
    cache: (projectPath: string, input: ModelCacheInput) => Promise<ModelCacheOutcome>
  }
}
