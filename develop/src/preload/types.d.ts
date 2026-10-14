// Ambient types shared by the main process, preload, and renderer.
// This file has no imports/exports on purpose: both tsconfig projects include it,
// so these names are global in every process.

type PtyKind = 'claude' | 'app' | 'web' | 'goatherd' | 'setup' | 'shell'

type ClaudeStatus = 'working' | 'waiting' | 'idle'

interface Worktree {
  path: string
  branch: string
  /** User-given display name (never the branch, which stays the identity); unset = show the branch. */
  name?: string
  head: string
  isMain: boolean
  commitsAhead?: number
  hasUncommitted?: boolean
  /** Number of files in the worktree's .goatherd/ demo dir (for the Workspace badge). */
  workspaceCount?: number
}

type WorkspaceKind = 'image' | 'video' | 'markdown' | 'html' | 'text' | 'other'

/** One file dropped in a worktree's .goatherd/ dir, surfaced by the Workspace viewer. */
interface WorkspaceEntry {
  name: string
  /** Path relative to the .goatherd/ root (may include subfolders). */
  relPath: string
  /** Absolute path — the input to the renderer's workspaceMediaUrl encoder. */
  path: string
  kind: WorkspaceKind
  size: number
  modifiedMs: number
}

// ---- Git Diff view (a workstream's branch reviewed against its base) ----

/** What a Git Diff tab is showing: the whole branch, the working tree, or one commit. */
type GitDiffScope = { kind: 'branch' } | { kind: 'working' } | { kind: 'commit'; sha: string }

interface GitCommit {
  sha: string
  shortSha: string
  /** First parent is the one a commit's diff is taken against; a root commit has none. */
  parents: string[]
  author: string
  /** ISO author date. */
  date: string
  subject: string
  /** The whole message, subject line included — what the diff view prints above the files. */
  message: string
  adds: number
  dels: number
  files: number
}

type GitFileStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked'

interface GitFileChange {
  path: string
  /** Pre-rename path; passing it back keeps git pairing the rename in the patch. */
  oldPath?: string
  status: GitFileStatus
  adds: number
  dels: number
  binary: boolean
}

interface GitFileListing {
  files: GitFileChange[]
  /** Untracked files past the listing cap, so the view can say what it dropped. */
  untrackedTruncated: number
  error?: string
}

interface GitDiffOverview {
  base: string
  /** Local branches for the base picker, most recently committed first. */
  branches: string[]
  /** Empty when the base is missing or shares no history — the view says so. */
  mergeBase: string
  commits: GitCommit[]
  /** Files the working tree changes (staged, unstaged, and untracked). */
  workingCount: number
  error?: string
}

interface GitDiffRequest {
  worktree: string
  base: string
  scope: GitDiffScope
}

interface GitPatchRequest extends GitDiffRequest {
  path: string
  oldPath?: string
  /** An untracked file is in no revision, so it is diffed against nothing. */
  untracked?: boolean
  /** Lines of context: the packed/whole-file switch (whole file = more than any file has). */
  context: number
}

interface GitPatchResult {
  patch: string
  error?: string
}

interface PtyStartRequest {
  worktree: string
  branch: string
  kind: PtyKind
}

interface PtyStartResult {
  id: string
  port?: number
}

interface PtySnapshot {
  data: string
  offset: number
}

/** One rate-limit window from the /usage endpoint (session = 5h, weekly_all, weekly_scoped…). */
interface QuotaWindow {
  kind: string
  percent: number
  severity: string
  resetsAt: string
  /** Set for model-scoped windows, e.g. "Fable". */
  model?: string
}

interface QuotaStatus {
  windows: QuotaWindow[]
  fetchedAt: number
  error?: string
}

interface ClaudeStatusEvent {
  cwd: string
  status: ClaudeStatus
  event: string
  sessionId: string
  message?: string
}

/** What the terminals' right-click menu can ask the renderer to do. */
type TerminalMenuAction = 'copy' | 'paste' | 'selectAll'

interface GoatherdApi {
  info(): Promise<{ repoRoot: string; hookPort: number; instanceBranch: string }>
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<void>
  openInVSCode(path: string): Promise<void>
  listWorkspace(worktreePath: string): Promise<WorkspaceEntry[]>
  minimizeWindow(): void
  maximizeWindow(): void
  closeWindow(): void
  /** Decides who draws the menu and the window controls — macOS uses neither. */
  platform: NodeJS.Platform
  /** macOS only: the live font-size readout for the native View menu. */
  setZoomLabel(label: string): void
  /**
   * Whether this window is the active one, from main — the page's own focus
   * events track the focused element, not the window (see `window:focus-changed`).
   */
  onWindowFocus(callback: (focused: boolean) => void): () => void
  /** The system clipboard, served by main: a renderer has no `clipboard` module since Electron 44. */
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
  /** Linux PRIMARY selection — what middle-click pastes. A no-op elsewhere. */
  writePrimarySelection(text: string): void
  /** Pops the terminals' native right-click menu; resolves null if it was dismissed. */
  showTerminalMenu(hasSelection: boolean): Promise<TerminalMenuAction | null>
  /** macOS only: an Edit-menu clipboard command, for the renderer to route (appMenu.ts). */
  onClipboardCommand(callback: (action: TerminalMenuAction) => void): () => void
  listWorktrees(): Promise<Worktree[]>
  /** Commit rail for the Git Diff view: what the branch adds over `base`, plus the working tree. */
  gitOverview(worktree: string, base: string): Promise<GitDiffOverview>
  gitFiles(request: GitDiffRequest): Promise<GitFileListing>
  gitPatch(request: GitPatchRequest): Promise<GitPatchResult>
  addWorktree(branch: string): Promise<string>
  removeWorktree(path: string): Promise<void>
  /** Label only — the git branch is untouched. An empty name clears it back to the branch. */
  renameWorktree(path: string, name: string): Promise<void>
  startPty(request: PtyStartRequest): Promise<PtyStartResult>
  disposePty(id: string): Promise<void>
  ptySnapshot(id: string): Promise<PtySnapshot>
  ptyInput(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void
  getPtyProcess(id: string): Promise<string | null>
  onPtyData(callback: (id: string, data: string, offset: number) => void): () => void
  onPtyExit(callback: (id: string, exitCode: number) => void): () => void
  /** A dev server bound to a different port than we asked for (ours was taken). */
  onPtyPort(callback: (id: string, port: number) => void): () => void
  onClaudeStatus(callback: (event: ClaudeStatusEvent) => void): () => void
  /** force skips the main process's freshness check (still coalesced/throttled there). */
  getQuota(force?: boolean): Promise<QuotaStatus>
  onQuota(callback: (status: QuotaStatus) => void): () => void
  /**
   * Terminal zoom driven from the main process: the Ctrl/Cmd+Shift +/-/0 combos are
   * browser-reserved (page zoom), so main intercepts them at before-input-event —
   * cancelling the native zoom — and forwards the intent here for the font store.
   */
  onZoom(callback: (action: ZoomAction) => void): () => void
}

type ZoomAction = 'in' | 'out' | 'reset'
