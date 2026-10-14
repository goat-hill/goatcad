import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AppConfig,
  AppTheme,
  RecentEntry,
  TabState,
  WindowInit,
  WindowSession
} from '../main/appConfig'
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
  McpActionResult,
  McpDesignEnvelope,
  McpDesignReply,
  McpServerStatus,
  McpSurface
} from './mcpTypes'
import type { IndexLibrary, IndexRecord } from '../main/libraryIndexTypes'
import type { SystemCheckResult } from '../main/launchChecks'
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
  TerminalKind,
  TerminalSession,
  TerminalSnapshot,
  TerminalState
} from './terminalTypes'

interface LibraryConfig {
  nickname: string
  path: string
  type: 'local' | 'remote'
  readOnly?: boolean
}

/** A registered `.kicad_sym` library — `path` points at the file itself. */
interface SymbolLibraryConfig {
  nickname: string
  path: string
  type: 'local'
  readOnly?: boolean
  /** Provisioned from the standard KiCad libraries (detected install or download). */
  source?: 'standard'
}

/** Standard library sets GoatCAD can provision. */
type LibrarySet = 'symbols' | 'footprints' | 'packages3d'

/** A detected local KiCad install's standard library directories. */
interface DetectedLibraries {
  root: string
  symbols?: string
  footprints?: string
  models3d?: string
}

interface GoatCADAPI {
  /** True under the screenshot/record harness (GOATCAD_TEST_HOOKS=1). */
  testHooks: boolean
  getWindowId: () => Promise<number | null>
  getWindowInit: () => Promise<WindowInit>
  updateSession: (session: WindowSession) => void
  /** The theme the window was created under, readable before the config load. */
  initialTheme: AppTheme
  getConfig: () => Promise<AppConfig>
  updateConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>
  addRecent: (project: RecentEntry) => Promise<RecentEntry[]>
  removeRecent: (path: string) => Promise<RecentEntry[]>
  clearRecents: () => Promise<RecentEntry[]>
  openDirectory: () => Promise<{ path: string; name: string; files: unknown[] } | null>
  openProjectDialog: () => Promise<{
    projectFilePath: string
    path: string
    name: string
    files: unknown[]
  } | null>
  openFileDialog: () => Promise<{
    filePath: string
    fileName: string
    projectPath: string
    projectName: string
    files: unknown[]
  } | null>
  createProject: () => Promise<{ path: string; name: string; files: unknown[] } | null>
  listSamples: () => Promise<SampleListResult>
  openSample: (dir: string) => Promise<SampleOpenResult>
  saveFileDialog: (defaultPath?: string) => Promise<string | null>
  pickModelFile: (defaultPath?: string) => Promise<string | null>
  pickDirectory: (title?: string, defaultPath?: string) => Promise<string | null>
  readDirectory: (path: string) => Promise<unknown[]>
  createFile: (path: string, content: string) => Promise<{ success: boolean; error?: string }>
  readFile: (path: string) => Promise<{ success: boolean; content?: string; error?: string }>
  pickSymbolLibraryFile: (title?: string) => Promise<string | null>
  pickFile: (options?: {
    title?: string
    buttonLabel?: string
    filters?: { name: string; extensions: string[] }[]
  }) => Promise<string | null>
  chooseDialog: (prompt: {
    message: string
    detail?: string
    buttons: string[]
    cancelId?: number
  }) => Promise<number>
  findProjects: (root: string, maxDepth?: number) => Promise<string[]>
  readProjectLibTable: (
    projectPath: string,
    fileName: string
  ) => Promise<{ content: string | null; dir: string | null }>
  writeProjectLibTable: (
    projectPath: string,
    fileName: string,
    content: string
  ) => Promise<{ success: boolean; error?: string }>
  renamePath: (fromPath: string, toPath: string) => Promise<{ success: boolean; error?: string }>
  deletePath: (path: string) => Promise<{ success: boolean; error?: string }>
  createDirectory: (path: string) => Promise<{ success: boolean; error?: string }>
  copyPath: (fromPath: string, toPath: string) => Promise<{ success: boolean; error?: string }>
  pathExists: (path: string) => Promise<boolean>
  revealPath: (path: string) => Promise<void>
  exportFabPackage: (payload: FabExportPayload) => Promise<FabExportResult>
  readFileBase64: (path: string) => Promise<{ success: boolean; data?: string; error?: string }>
  /** Write base64-encoded bytes to `path` (an exported PNG). */
  writeFileBase64: (path: string, data: string) => Promise<{ success: boolean; error?: string }>
  statFile: (
    path: string
  ) => Promise<{ success: boolean; size?: number; modifiedMs?: number; error?: string }>
  loadStepModel: (path: string) => Promise<StepLoadResult>
  resolveModelPath: (
    modelPath: string,
    footprintFilePath: string | null,
    projectPath: string | null
  ) => Promise<ModelResolveResult>
  getGitStatus: (projectPath: string) => Promise<GitStatusResult>
  gitInit: (projectPath: string) => Promise<GitOpResult>
  gitStage: (projectPath: string, paths: string[]) => Promise<GitOpResult>
  gitUnstage: (projectPath: string, paths: string[]) => Promise<GitOpResult>
  gitDiscard: (projectPath: string, targets: GitDiscardTarget[]) => Promise<GitOpResult>
  gitCommit: (projectPath: string, message: string) => Promise<GitOpResult>
  gitDiff: (projectPath: string, req: GitDiffRequest) => Promise<GitDiffResult>
  gitShow: (projectPath: string, path: string, revision: GitShowRevision) => Promise<GitShowResult>
  gitIgnore: (projectPath: string, path: string) => Promise<GitOpResult>
  gitPush: (projectPath: string) => Promise<GitRemoteResult>
  gitPull: (projectPath: string) => Promise<GitRemoteResult>
  gitBranches: (projectPath: string) => Promise<GitBranchListResult>
  gitCheckout: (projectPath: string, name: string, create: boolean) => Promise<GitOpResult>
  /** A new window, with these tabs open in it: a dragged-out tab and the tabs nested with it. */
  newWindow: (projectPath?: string, tabs?: { name: string; path: string }[]) => Promise<void>
  platform: NodeJS.Platform
  homeDir: string
  setNativeMenu: (template: NativeMenuTemplate) => void
  onMenuCommand: (callback: (id: string) => void) => () => void
  closeWindow: () => void
  onConfirmClose: (callback: () => void) => () => void
  confirmWindowClose: (proceed: boolean) => void
  confirmUnsaved: (prompt: UnsavedPrompt) => Promise<UnsavedChoice>
  minimizeWindow: () => void
  maximizeWindow: () => void
  toggleDevTools: () => void
  getAppVersion: () => Promise<string>
  openSourceCode: () => Promise<void>
  openThirdPartyNotices: () => Promise<boolean>
  canCheckForUpdates: () => Promise<boolean>
  checkForUpdatesNow: () => Promise<UpdateCheckOutcome>
  getFeedbackSystemInfo: () => Promise<FeedbackSystemInfo>
  captureFeedbackScreenshot: () => Promise<string | null>
  copyFeedbackScreenshot: () => Promise<boolean>
  discardFeedbackScreenshot: () => Promise<void>
  openFeedbackIssue: (url: string) => Promise<boolean>
  transferTab: (sourceWindowId: number, targetWindowId: number, tabData: unknown) => Promise<void>
  onConfigChanged: (callback: (config: AppConfig) => void) => () => void
  tabHeldElsewhere: (path: string) => Promise<boolean>
  notifyCrossProbe: (probe: CrossProbe) => void
  onCrossProbe: (callback: (probe: CrossProbe) => void) => () => void
  notifyProjectChange: (batch: ProjectChangeBatch) => void
  watchProject: (root: string | null) => void
  onProjectChanged: (callback: (batch: ProjectChangeBatch) => void) => () => void
  onWindowFocusChanged: (callback: (focused: boolean) => void) => () => void
  onTabRemove: (callback: (path: string) => void) => () => void
  onTabAdd: (callback: (tabData: unknown) => void) => () => void
  getLibraries: () => Promise<{ libraries: LibraryConfig[] }>
  saveLibraries: (tableData: {
    libraries: LibraryConfig[]
  }) => Promise<{ success: boolean; error?: string }>
  scanLibraryDirectory: (
    dirPath: string
  ) => Promise<{ category: string; footprints: { name: string; path: string }[] }[]>
  downloadOfficialLibrary: (
    sets?: LibrarySet[]
  ) => Promise<{ success: boolean; error?: string; registered?: string[] }>
  detectSystemLibraries: () => Promise<DetectedLibraries | null>
  runSystemChecks: () => Promise<SystemCheckResult[]>
  listDir: (dirPath: string) => Promise<{ name: string; path: string; isDir: boolean }[]>
  getLibraryIndex: () => Promise<{ records: IndexRecord[]; libraries: IndexLibrary[] }>
  rebuildLibraryIndex: () => Promise<{ records: IndexRecord[]; libraries: IndexLibrary[] }>
  getProjectIndex: (projectPath: string) => Promise<{
    records: IndexRecord[]
    assignments: { symbol: string; footprint: string }[]
    libraries: IndexLibrary[]
  }>
  onIndexProgress: (
    callback: (p: { scope: string; done: number; total: number; complete?: boolean }) => void
  ) => () => void
  resetStandardLibraries: () => Promise<{ success: boolean; error?: string }>
  onDownloadProgress: (callback: (message: string) => void) => () => void
  getSymbolLibraries: () => Promise<{ libraries: SymbolLibraryConfig[] }>
  saveSymbolLibraries: (tableData: {
    libraries: SymbolLibraryConfig[]
  }) => Promise<{ success: boolean; error?: string }>
  scanSymbolLibraryDirectory: (dirPath: string) => Promise<{ nickname: string; path: string }[]>
  readSymbolLibrary: (
    filePath: string
  ) => Promise<{ success: boolean; content?: string; error?: string }>
  readProjectSymbolLibTable: (
    projectPath: string
  ) => Promise<{ content: string | null; dir: string | null }>

  // --- Distributor part search. Deliberately no credential *getter*: secrets
  // travel one way into main, and the renderer only ever reads back a status.
  partsProviders: () => Promise<PartsProviderInfo[]>
  partsCredentialStatus: () => Promise<PartsCredentialStatus[]>
  partsUsage: () => Promise<PartsUsage[]>
  partsSetCredentials: (
    provider: PartsProviderId,
    credentials: Record<string, string>
  ) => Promise<PartsResult<PartsCredentialStatus>>
  partsRemoveCredentials: (provider: PartsProviderId) => Promise<PartsCredentialStatus | null>
  partsTestCredentials: (provider: PartsProviderId) => Promise<PartsResult<PartsCredentialStatus>>
  partsSearch: (
    provider: PartsProviderId,
    keyword: string,
    limit?: number,
    offset?: number,
    categoryId?: number,
    filters?: PartsFilterState,
    sort?: PartsSort | null
  ) => Promise<PartsResult<PartSearchResult>>
  partsCategories: (provider: PartsProviderId) => Promise<PartsResult<PartCategory[]>>
  partsDetail: (provider: PartsProviderId, partId: string) => Promise<PartRecord | null>
  partsSearchAll: (
    keyword: string,
    limit?: number,
    filters?: PartsFilterState
  ) => Promise<PartsUniversalResult>
  partsImage: (url: string) => Promise<string | null>
  partsCad: (provider: PartsProviderId, partId: string) => Promise<PartsResult<PartCadAvailability>>
  partsOpenRegistration: (provider: PartsProviderId) => Promise<boolean>
  partsOpenExternal: (url: string) => Promise<boolean>
  mcpStatus: () => Promise<McpServerStatus>
  mcpSurface: () => Promise<McpSurface>
  mcpRegenerateToken: () => Promise<McpActionResult>
  onMcpDesignRequest: (callback: (envelope: McpDesignEnvelope) => void) => () => void
  mcpDesignReady: () => void
  openInHoldingWorkspace: (root: string, file?: string) => Promise<boolean>
  sendMcpDesignReply: (reply: McpDesignReply) => void
  onPartsOpenSettings: (callback: (provider: PartsProviderId | null) => void) => () => void
  onPartsCredentialsChanged: (callback: (statuses: PartsCredentialStatus[]) => void) => () => void
  readClipboardText: () => Promise<string>
  writeClipboardText: (text: string, primary?: boolean) => void
  startTerminal: (cwd: string, kind?: TerminalKind) => Promise<TerminalSession>
  attachTerminal: (id: string) => Promise<TerminalSession | null>
  terminalSnapshot: (id: string) => Promise<TerminalSnapshot>
  disposeTerminal: (id: string) => Promise<void>
  terminalStates: (ids: string[]) => Promise<Record<string, TerminalState>>
  terminalInput: (id: string, data: string) => void
  terminalResize: (id: string, cols: number, rows: number) => void
  onTerminalData: (callback: (id: string, data: string, offset: number) => void) => () => void
  onTerminalExit: (callback: (id: string, exitCode: number) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: GoatCADAPI
  }
}

export type { AppConfig, RecentEntry, TabState, WindowInit, WindowSession }
