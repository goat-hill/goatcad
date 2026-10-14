import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'node:os'
import { electronAPI } from '@electron-toolkit/preload'
import type { AppConfig, RecentEntry, WindowInit, WindowSession } from '../main/appConfig'
import type { StepLoadResult, ModelResolveResult } from './modelTypes'
import type { NativeMenuTemplate } from './menuTypes'
import type { UnsavedChoice, UnsavedPrompt } from './dialogTypes'
import type { ProjectChangeBatch } from './projectChangeTypes'
import type { CrossProbe } from './crossProbeTypes'
import type { SampleListResult, SampleOpenResult } from './sampleTypes'
import type { FabExportPayload, FabExportResult } from './fabTypes'
import type { UpdateCheckOutcome } from '../main/updater'
import type { FeedbackSystemInfo } from './feedbackTypes'
import type {
  GitBranchListResult,
  GitDiffRequest,
  GitDiffResult,
  GitDiscardTarget,
  GitOpResult,
  GitRemoteResult,
  GitShowResult,
  GitShowRevision,
  GitStatusResult
} from './gitTypes'
import type {
  PartCadAvailability,
  PartCategory,
  PartRecord,
  PartSearchResult,
  PartsCredentialStatus,
  PartsFilterState,
  PartsProviderId,
  PartsSort,
  PartsProviderInfo,
  PartsResult,
  PartsUniversalResult,
  PartsUsage
} from './partsTypes'
import type {
  McpActionResult,
  McpDesignEnvelope,
  McpDesignReply,
  McpServerStatus,
  McpSurface
} from './mcpTypes'
import type {
  TerminalKind,
  TerminalSession,
  TerminalSnapshot,
  TerminalState
} from './terminalTypes'

// Custom APIs for renderer
const api = {
  /**
   * True when launched by the screenshot/record harness (GOATCAD_TEST_HOOKS=1).
   * Gates the window.__goatcad automation bridge; false in a normal session.
   */
  testHooks: process.env.GOATCAD_TEST_HOOKS === '1',
  getWindowId: (): Promise<number | null> => ipcRenderer.invoke('window:get-id'),
  getWindowInit: (): Promise<WindowInit> => ipcRenderer.invoke('window:get-init'),
  updateSession: (session: WindowSession): void => ipcRenderer.send('session:update', session),
  initialTheme: process.argv.includes('--goatcad-theme=light') ? 'light' : 'dark',
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  updateConfig: (patch: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke('config:update', patch),
  addRecent: (project: RecentEntry): Promise<RecentEntry[]> =>
    ipcRenderer.invoke('config:add-recent', project),
  removeRecent: (path: string): Promise<RecentEntry[]> =>
    ipcRenderer.invoke('config:remove-recent', path),
  clearRecents: (): Promise<RecentEntry[]> => ipcRenderer.invoke('config:clear-recents'),
  openDirectory: (): Promise<{ path: string; name: string; files: unknown[] } | null> =>
    ipcRenderer.invoke('dialog:open-directory'),
  /** Picks a `.kicad_pro`; the workspace is its containing folder. */
  openProjectDialog: (): Promise<{
    projectFilePath: string
    path: string
    name: string
    files: unknown[]
  } | null> => ipcRenderer.invoke('dialog:open-project'),
  openFileDialog: (): Promise<{
    filePath: string
    fileName: string
    projectPath: string
    projectName: string
    files: unknown[]
  } | null> => ipcRenderer.invoke('dialog:open-file'),
  createProject: (): Promise<{ path: string; name: string; files: unknown[] } | null> =>
    ipcRenderer.invoke('dialog:create-project'),
  /** The sample repo's catalog, fetched now — the only call that reaches GitHub for it. */
  listSamples: (): Promise<SampleListResult> => ipcRenderer.invoke('samples:list'),
  /** Download (or reuse) a sample from the last listed catalog into temp. */
  openSample: (dir: string): Promise<SampleOpenResult> => ipcRenderer.invoke('samples:open', dir),
  /** Native Save As target picker; resolves to the chosen path or null. */
  saveFileDialog: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:save-file', defaultPath),
  /** Native 3D-model file picker (.step/.stp/.wrl); resolves to a path or null. */
  pickModelFile: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pick-model-file', defaultPath),
  /** Native directory picker for settings paths (not treated as a project). */
  pickDirectory: (title?: string, defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pick-directory', title, defaultPath),
  readDirectory: (path: string): Promise<unknown[]> =>
    ipcRenderer.invoke('fs:read-directory', path),
  createFile: (path: string, content: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:create-file', path, content),
  readFile: (path: string): Promise<{ success: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('fs:read-file', path),
  /** Rename/move; fails with `EEXIST` rather than overwriting the target. */
  renamePath: (fromPath: string, toPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:rename', fromPath, toPath),
  /** Delete to the OS trash (recoverable) — file ops have no undo. */
  deletePath: (path: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:delete', path),
  createDirectory: (path: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:mkdir', path),
  /** Copy a file or directory; fails with `EEXIST` rather than overwriting. */
  copyPath: (fromPath: string, toPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:copy', fromPath, toPath),
  pathExists: (path: string): Promise<boolean> => ipcRenderer.invoke('fs:exists', path),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('fs:reveal', path),
  /** Write a fab package's files, and a zip of some of them, into one folder. */
  exportFabPackage: (payload: FabExportPayload): Promise<FabExportResult> =>
    ipcRenderer.invoke('fab:export', payload),
  /** Base64 binary read (image viewer); build a data: URL on the renderer side. */
  readFileBase64: (path: string): Promise<{ success: boolean; data?: string; error?: string }> =>
    ipcRenderer.invoke('fs:read-file-base64', path),
  /** File metadata for the file-info tab shown for types GoatCAD won't open. */
  /** Base64 binary write (an exported PNG); the bytes land as-is. */
  writeFileBase64: (path: string, data: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:write-file-base64', path, data),
  statFile: (
    path: string
  ): Promise<{ success: boolean; size?: number; modifiedMs?: number; error?: string }> =>
    ipcRenderer.invoke('fs:stat', path),
  loadStepModel: (path: string): Promise<StepLoadResult> => ipcRenderer.invoke('step:load', path),
  /** Resolve a footprint (model ...) path to an absolute file, or report not-found. */
  resolveModelPath: (
    modelPath: string,
    footprintFilePath: string | null,
    projectPath: string | null
  ): Promise<ModelResolveResult> =>
    ipcRenderer.invoke('model:resolve', modelPath, footprintFilePath, projectPath),
  /** Read-only git status of the project's repository; failures come back as a `state` value. */
  getGitStatus: (projectPath: string): Promise<GitStatusResult> =>
    ipcRenderer.invoke('git:status', projectPath),
  /** `git init` in the project folder, for a folder that is not a repo yet. */
  gitInit: (projectPath: string): Promise<GitOpResult> =>
    ipcRenderer.invoke('git:init', projectPath),
  gitStage: (projectPath: string, paths: string[]): Promise<GitOpResult> =>
    ipcRenderer.invoke('git:stage', projectPath, paths),
  gitUnstage: (projectPath: string, paths: string[]): Promise<GitOpResult> =>
    ipcRenderer.invoke('git:unstage', projectPath, paths),
  gitDiscard: (projectPath: string, targets: GitDiscardTarget[]): Promise<GitOpResult> =>
    ipcRenderer.invoke('git:discard', projectPath, targets),
  gitCommit: (projectPath: string, message: string): Promise<GitOpResult> =>
    ipcRenderer.invoke('git:commit', projectPath, message),
  /** One file's unified diff for the diff tab. */
  gitDiff: (projectPath: string, req: GitDiffRequest): Promise<GitDiffResult> =>
    ipcRenderer.invoke('git:diff', projectPath, req),
  /** One file's text at HEAD or in the index; `missing` when it is absent there. */
  gitShow: (projectPath: string, path: string, revision: GitShowRevision): Promise<GitShowResult> =>
    ipcRenderer.invoke('git:show', projectPath, path, revision),
  /** Add an anchored pattern for this file to the repository's `.gitignore`. */
  gitIgnore: (projectPath: string, path: string): Promise<GitOpResult> =>
    ipcRenderer.invoke('git:ignore', projectPath, path),
  /** Push the current branch, publishing it with `-u` when it has no upstream. Never prompts. */
  gitPush: (projectPath: string): Promise<GitRemoteResult> =>
    ipcRenderer.invoke('git:push', projectPath),
  /** Fast-forward-only pull. Never prompts. */
  gitPull: (projectPath: string): Promise<GitRemoteResult> =>
    ipcRenderer.invoke('git:pull', projectPath),
  gitBranches: (projectPath: string): Promise<GitBranchListResult> =>
    ipcRenderer.invoke('git:branches', projectPath),
  gitCheckout: (projectPath: string, name: string, create: boolean): Promise<GitOpResult> =>
    ipcRenderer.invoke('git:checkout', projectPath, name, create),
  newWindow: (projectPath?: string, tabs?: { name: string; path: string }[]): Promise<void> =>
    ipcRenderer.invoke('window:new', projectPath, tabs),
  /** Decides who draws the menu and the window controls — macOS uses neither. */
  platform: process.platform,
  /** For abbreviating paths as `~/…` in the UI. A constant, so not a channel. */
  homeDir: homedir(),
  /** macOS only: hand main the menu tree to render in the system menu bar. */
  setNativeMenu: (template: NativeMenuTemplate): void =>
    ipcRenderer.send('menu:set-template', template),
  /** A command id chosen from that native menu, matching the in-window ids. */
  onMenuCommand: (callback: (id: string) => void): (() => void) => {
    const listener = (_event: unknown, id: string): void => callback(id)
    ipcRenderer.on('menu:select', listener)
    return (): void => {
      ipcRenderer.removeListener('menu:select', listener)
    }
  },
  closeWindow: (): void => ipcRenderer.send('window:close'),
  /**
   * Main vetoes every window close and fires this so the renderer — the only
   * side that knows which tabs are dirty — can resolve the unsaved work first.
   * Answer with `confirmWindowClose`, or the window never closes.
   */
  onConfirmClose: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('window:confirm-close', listener)
    return (): void => {
      ipcRenderer.removeListener('window:confirm-close', listener)
    }
  },
  /** The verdict on that request: `true` lets the close through. */
  confirmWindowClose: (proceed: boolean): void =>
    ipcRenderer.send('window:close-confirmed', proceed),
  /** Native Save / Don't Save / Cancel box; the caller supplies translated copy. */
  confirmUnsaved: (prompt: UnsavedPrompt): Promise<UnsavedChoice> =>
    ipcRenderer.invoke('dialog:confirm-unsaved', prompt),
  minimizeWindow: (): void => ipcRenderer.send('window:minimize'),
  maximizeWindow: (): void => ipcRenderer.send('window:maximize'),
  /**
   * View ▸ Toggle Developer Tools. Only main can open them, and the F12 that
   * `optimizer.watchWindowShortcuts` answers is dev-only — so this is the menu's
   * real path, not a shortcut replay.
   */
  toggleDevTools: (): void => ipcRenderer.send('window:toggle-dev-tools'),
  /** The packaged app version, for the About dialog. */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  /** Settings ▸ About: the GitHub repository, in the browser. */
  openSourceCode: (): Promise<void> => ipcRenderer.invoke('app:open-source-code'),
  /** Settings ▸ About: the bundled THIRD_PARTY_NOTICES.txt; false when nothing could open it. */
  openThirdPartyNotices: (): Promise<boolean> => ipcRenderer.invoke('app:open-third-party-notices'),
  /** Whether this install updates itself (main/updater.ts); Check now is disabled where not. */
  canCheckForUpdates: (): Promise<boolean> => ipcRenderer.invoke('updater:can-check'),
  /** Settings ▸ About's Check now: one update check at once, whatever the setting. */
  checkForUpdatesNow: (): Promise<UpdateCheckOutcome> => ipcRenderer.invoke('updater:check'),
  /** Share app feedback (main/feedback.ts): the install, OS and build the issue reports. */
  getFeedbackSystemInfo: (): Promise<FeedbackSystemInfo> =>
    ipcRenderer.invoke('feedback:system-info'),
  /** Screenshots this window for the issue; a thumbnail data URL, or null when it could not. */
  captureFeedbackScreenshot: (): Promise<string | null> => ipcRenderer.invoke('feedback:capture'),
  /** Puts that screenshot on the clipboard, full size, to paste into the issue. */
  copyFeedbackScreenshot: (): Promise<boolean> => ipcRenderer.invoke('feedback:copy-screenshot'),
  /** Drops the held screenshot as the dialog closes. */
  discardFeedbackScreenshot: (): Promise<void> => ipcRenderer.invoke('feedback:discard'),
  /** Opens the prefilled new-issue link in the default browser; false if main refused or failed. */
  openFeedbackIssue: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('feedback:open-issue', url),
  transferTab: (sourceWindowId: number, targetWindowId: number, tabData: unknown): Promise<void> =>
    ipcRenderer.invoke('tab:transfer', sourceWindowId, targetWindowId, tabData),
  /** Fires in every window whenever any window changes the global config. */
  onConfigChanged: (callback: (config: AppConfig) => void): (() => void) => {
    const listener = (_event: unknown, config: AppConfig): void => callback(config)
    ipcRenderer.on('config:changed', listener)
    return (): void => {
      ipcRenderer.removeListener('config:changed', listener)
    }
  },
  /**
   * Announce committed file changes so the *other* windows holding this project
   * invalidate too (projects.md §9). Send, not invoke: the
   * emitter has already handled its own batch and is not waiting on an answer.
   */
  notifyProjectChange: (batch: ProjectChangeBatch): void =>
    ipcRenderer.send('project:notify-change', batch),
  /** True when another window has this file open (a file is open once per app). */
  tabHeldElsewhere: (path: string): Promise<boolean> =>
    ipcRenderer.invoke('tab:held-elsewhere', path),
  /** Relay a schematic↔board cross-select to the other windows. */
  notifyCrossProbe: (probe: CrossProbe): void => ipcRenderer.send('crossprobe:notify', probe),
  onCrossProbe: (callback: (probe: CrossProbe) => void): (() => void) => {
    const listener = (_event: unknown, probe: CrossProbe): void => callback(probe)
    ipcRenderer.on('crossprobe:probe', listener)
    return (): void => {
      ipcRenderer.removeListener('crossprobe:probe', listener)
    }
  },
  /** Declare the workspace this window is looking at, for main to watch. */
  watchProject: (root: string | null): void => ipcRenderer.send('project:watch', root),
  /** The receiving half: batches another window emitted into the same project. */
  onProjectChanged: (callback: (batch: ProjectChangeBatch) => void): (() => void) => {
    const listener = (_event: unknown, batch: ProjectChangeBatch): void => callback(batch)
    ipcRenderer.on('project:changed', listener)
    return (): void => {
      ipcRenderer.removeListener('project:changed', listener)
    }
  },
  /**
   * Whether this window is the active one, from main — the page's own
   * focus/blur cannot be used, see `sendWindowFocus` in main.
   */
  onWindowFocusChanged: (callback: (focused: boolean) => void): (() => void) => {
    const listener = (_event: unknown, focused: boolean): void => callback(focused)
    ipcRenderer.on('window:focus-changed', listener)
    return (): void => {
      ipcRenderer.removeListener('window:focus-changed', listener)
    }
  },
  onTabRemove: (callback: (path: string) => void): (() => void) => {
    const listener = (_event: unknown, path: string): void => callback(path)
    ipcRenderer.on('tab:remove', listener)
    return (): void => {
      ipcRenderer.removeListener('tab:remove', listener)
    }
  },
  onTabAdd: (callback: (tabData: unknown) => void): (() => void) => {
    const listener = (_event: unknown, tabData: unknown): void => callback(tabData)
    ipcRenderer.on('tab:add', listener)
    return (): void => {
      ipcRenderer.removeListener('tab:add', listener)
    }
  },
  getLibraries: (): Promise<{ libraries: unknown[] }> => ipcRenderer.invoke('libraries:get-table'),
  saveLibraries: (tableData: unknown): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('libraries:save-table', tableData),
  scanLibraryDirectory: (
    dirPath: string
  ): Promise<{ category: string; footprints: { name: string; path: string }[] }[]> =>
    ipcRenderer.invoke('libraries:scan-directory', dirPath),
  downloadOfficialLibrary: (
    sets?: ('symbols' | 'footprints' | 'packages3d')[]
  ): Promise<{ success: boolean; error?: string; registered?: string[] }> =>
    ipcRenderer.invoke('libraries:download-official', sets),
  detectSystemLibraries: (): Promise<{
    root: string
    symbols?: string
    footprints?: string
    models3d?: string
  } | null> => ipcRenderer.invoke('libraries:detect-system'),
  /** Re-run the launch-time system probes; see main/launchChecks.ts. */
  runSystemChecks: (): Promise<
    { id: string; detail: string | null; added?: number; error?: string }[]
  > => ipcRenderer.invoke('system:run-checks'),
  listDir: (dirPath: string): Promise<{ name: string; path: string; isDir: boolean }[]> =>
    ipcRenderer.invoke('libraries:list-dir', dirPath),
  getLibraryIndex: (): Promise<unknown> => ipcRenderer.invoke('index:get-system'),
  rebuildLibraryIndex: (): Promise<unknown> => ipcRenderer.invoke('index:rebuild-system'),
  getProjectIndex: (projectPath: string): Promise<unknown> =>
    ipcRenderer.invoke('index:get-project', projectPath),
  onIndexProgress: (
    callback: (p: { scope: string; done: number; total: number; complete?: boolean }) => void
  ): (() => void) => {
    const listener = (_event: unknown, p: unknown): void =>
      callback(p as { scope: string; done: number; total: number; complete?: boolean })
    ipcRenderer.on('index:progress', listener)
    return (): void => {
      ipcRenderer.off('index:progress', listener)
    }
  },
  resetStandardLibraries: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('libraries:reset-standard'),
  onDownloadProgress: (callback: (message: string) => void) => {
    const listener = (_event: unknown, message: string): void => callback(message)
    ipcRenderer.on('libraries:download-progress', listener)
    return (): void => {
      ipcRenderer.off('libraries:download-progress', listener)
    }
  },
  getSymbolLibraries: (): Promise<{ libraries: unknown[] }> =>
    ipcRenderer.invoke('symbol-libraries:get-table'),
  saveSymbolLibraries: (tableData: unknown): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('symbol-libraries:save-table', tableData),
  scanSymbolLibraryDirectory: (dirPath: string): Promise<{ nickname: string; path: string }[]> =>
    ipcRenderer.invoke('symbol-libraries:scan-directory', dirPath),
  /** Native picker filtered to `.kicad_sym` (footprint libs are directories). */
  pickSymbolLibraryFile: (title?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pick-symbol-library-file', title),
  /** Generic single-file picker for data an editor imports (pin-table CSV). */
  pickFile: (options?: {
    title?: string
    buttonLabel?: string
    filters?: { name: string; extensions: string[] }[]
  }): Promise<string | null> => ipcRenderer.invoke('dialog:pick-file', options),
  /** Native "pick one" box; resolves to the chosen button index. Copy is
   *  translated by the caller — main has no vue-i18n. */
  chooseDialog: (prompt: {
    message: string
    detail?: string
    buttons: string[]
    cancelId?: number
  }): Promise<number> => ipcRenderer.invoke('dialog:choose', prompt),
  /** Every `.kicad_pro` at or below `root`, to a bounded depth (default 2). */
  findProjects: (root: string, maxDepth?: number): Promise<string[]> =>
    ipcRenderer.invoke('project:find', root, maxDepth),
  /** Project-tier `sym-lib-table` / `fp-lib-table`, by file name. */
  readProjectLibTable: (
    projectPath: string,
    fileName: string
  ): Promise<{ content: string | null; dir: string | null }> =>
    ipcRenderer.invoke('libraries:read-project-table', projectPath, fileName),
  writeProjectLibTable: (
    projectPath: string,
    fileName: string,
    content: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('libraries:write-project-table', projectPath, fileName, content),
  readSymbolLibrary: (
    filePath: string
  ): Promise<{ success: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('symbol-libraries:read-library', filePath),
  readProjectSymbolLibTable: (
    projectPath: string
  ): Promise<{ content: string | null; dir: string | null }> =>
    ipcRenderer.invoke('symbol-libraries:read-project-table', projectPath),

  // --- Distributor part search (docs/parts-sourcing-workstream.md).
  // Note what is *not* here: there is no way to read a stored API key back.
  // Secrets go one way, into main; the renderer only ever sees a status.
  partsProviders: (): Promise<PartsProviderInfo[]> => ipcRenderer.invoke('parts:providers'),
  partsCredentialStatus: (): Promise<PartsCredentialStatus[]> =>
    ipcRenderer.invoke('parts:credential-status'),
  partsUsage: (): Promise<PartsUsage[]> => ipcRenderer.invoke('parts:usage'),
  partsSetCredentials: (
    provider: PartsProviderId,
    credentials: Record<string, string>
  ): Promise<PartsResult<PartsCredentialStatus>> =>
    ipcRenderer.invoke('parts:set-credentials', provider, credentials),
  partsRemoveCredentials: (provider: PartsProviderId): Promise<PartsCredentialStatus | null> =>
    ipcRenderer.invoke('parts:remove-credentials', provider),
  partsTestCredentials: (provider: PartsProviderId): Promise<PartsResult<PartsCredentialStatus>> =>
    ipcRenderer.invoke('parts:test-credentials', provider),
  partsSearch: (
    provider: PartsProviderId,
    keyword: string,
    limit?: number,
    offset?: number,
    categoryId?: number,
    filters?: PartsFilterState,
    sort?: PartsSort | null
  ): Promise<PartsResult<PartSearchResult>> =>
    ipcRenderer.invoke('parts:search', provider, keyword, limit, offset, categoryId, filters, sort),
  /** The distributor's category tree; main fetches it at most once a session. */
  partsCategories: (provider: PartsProviderId): Promise<PartsResult<PartCategory[]>> =>
    ipcRenderer.invoke('parts:categories', provider),
  partsDetail: (provider: PartsProviderId, partId: string): Promise<PartRecord | null> =>
    ipcRenderer.invoke('parts:detail', provider, partId),
  /** Universal search across every configured distributor. */
  partsSearchAll: (
    keyword: string,
    limit?: number,
    filters?: PartsFilterState
  ): Promise<PartsUniversalResult> =>
    ipcRenderer.invoke('parts:search-all', keyword, limit, filters),
  /** A product photo as a `data:` URL; main fetches so the CSP stays closed. */
  partsImage: (url: string): Promise<string | null> => ipcRenderer.invoke('parts:image', url),
  partsCad: (
    provider: PartsProviderId,
    partId: string
  ): Promise<PartsResult<PartCadAvailability>> => ipcRenderer.invoke('parts:cad', provider, partId),
  /** Opens the vendor's own key-registration page. Main supplies the URL from
   *  its registry — the app never registers an account or submits anything. */
  partsOpenRegistration: (provider: PartsProviderId): Promise<boolean> =>
    ipcRenderer.invoke('parts:open-registration', provider),
  /** Datasheet / product / model links. Main enforces https-only. */
  partsOpenExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('parts:open-external', url),
  // --- MCP integration ---
  mcpStatus: (): Promise<McpServerStatus> => ipcRenderer.invoke('mcp:status'),
  /** Every tool and prompt the server exposes, with what each takes. */
  mcpSurface: (): Promise<McpSurface> => ipcRenderer.invoke('mcp:surface'),
  mcpRegenerateToken: (): Promise<McpActionResult> => ipcRenderer.invoke('mcp:regenerate-token'),

  /** An MCP client asked to read or edit the open design. Main cannot do either
   *  itself — the KiCad AST layer and the undo stack are both in here — so the
   *  window answers (`main/partsMcpBridge.ts`). */
  onMcpDesignRequest: (callback: (envelope: McpDesignEnvelope) => void): (() => void) => {
    const listener = (_event: unknown, envelope: McpDesignEnvelope): void => callback(envelope)
    ipcRenderer.on('mcp:design-request', listener)
    return (): void => {
      ipcRenderer.off('mcp:design-request', listener)
    }
  },
  /** Reply to one request. `send`, not `invoke`: the window is the responder
   *  here, and main is already holding the promise keyed on the envelope id. */
  sendMcpDesignReply: (reply: McpDesignReply): void => {
    ipcRenderer.send('mcp:design-reply', reply)
  },

  /** An MCP client asked GoatCAD to show the distributor-key form. Carries no
   *  data beyond which provider to focus — a secret never crosses that surface,
   *  so putting the human in front of the form is the whole remedy. */
  onPartsOpenSettings: (callback: (provider: PartsProviderId | null) => void): (() => void) => {
    const listener = (_event: unknown, provider: PartsProviderId | null): void => callback(provider)
    ipcRenderer.on('parts:open-settings', listener)
    return (): void => {
      ipcRenderer.off('parts:open-settings', listener)
    }
  },

  /** Fires in every window when any window adds, replaces or removes a key. */
  onPartsCredentialsChanged: (
    callback: (statuses: PartsCredentialStatus[]) => void
  ): (() => void) => {
    const listener = (_event: unknown, statuses: PartsCredentialStatus[]): void =>
      callback(statuses)
    ipcRenderer.on('parts:credentials-changed', listener)
    return (): void => {
      ipcRenderer.off('parts:credentials-changed', listener)
    }
  },

  /** The system clipboard. Canvas-drawn selections (the terminal) need this —
   *  the browser's own copy/paste only knows about DOM text. */
  readClipboardText: (): Promise<string> => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (text: string, primary = false): void =>
    ipcRenderer.send('clipboard:write-text', text, primary),

  // --- Terminal tabs (ARCHITECTURE.md §3.12) ---
  /** Start a login shell in `cwd`, optionally running one named agent CLI in it.
   *  A *kind*, never a command line — see terminalTypes.d.ts. */
  startTerminal: (cwd: string, kind: TerminalKind = 'shell'): Promise<TerminalSession> =>
    ipcRenderer.invoke('terminal:start', cwd, kind),
  /** Claim a running session for this window — a tab that moved windows. */
  attachTerminal: (id: string): Promise<TerminalSession | null> =>
    ipcRenderer.invoke('terminal:attach', id),
  terminalSnapshot: (id: string): Promise<TerminalSnapshot> =>
    ipcRenderer.invoke('terminal:snapshot', id),
  /** Kills the shell. Only a tab the user closed gets here. */
  disposeTerminal: (id: string): Promise<void> => ipcRenderer.invoke('terminal:dispose', id),
  /** One round trip answers for every open terminal; see `states` in terminalSessions.ts. */
  terminalStates: (ids: string[]): Promise<Record<string, TerminalState>> =>
    ipcRenderer.invoke('terminal:states', ids),
  /** `send`, not `invoke`: a keystroke has no answer and must not await one. */
  terminalInput: (id: string, data: string): void => ipcRenderer.send('terminal:input', id, data),
  terminalResize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('terminal:resize', id, cols, rows),
  onTerminalData: (callback: (id: string, data: string, offset: number) => void): (() => void) => {
    const listener = (_event: unknown, id: string, data: string, offset: number): void =>
      callback(id, data, offset)
    ipcRenderer.on('terminal:data', listener)
    return (): void => {
      ipcRenderer.off('terminal:data', listener)
    }
  },
  onTerminalExit: (callback: (id: string, exitCode: number) => void): (() => void) => {
    const listener = (_event: unknown, id: string, exitCode: number): void => callback(id, exitCode)
    ipcRenderer.on('terminal:exit', listener)
    return (): void => {
      ipcRenderer.off('terminal:exit', listener)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
