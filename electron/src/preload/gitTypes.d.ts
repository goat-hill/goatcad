/**
 * Git status data shared across the process boundary.
 *
 * The main process shells out to the system git binary (`src/main/gitStatus.ts`)
 * and the renderer receives these plain structures over `git:status`. The file
 * lives in preload because it is the one directory both tsconfig.node.json and
 * tsconfig.web.json can see.
 */

/** One porcelain-v2 status letter. `T` (typechange) is collapsed to `M` upstream. */
export type GitCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U'

export interface GitFileStatus {
  /** Absolute path with platform separators (`resolve(repoRoot, relPath)`). */
  path: string
  /** Repo-root-relative path exactly as git reported it (`/`-separated). */
  relPath: string
  /** Staged (index) column, or null when unchanged there. */
  index: GitCode | null
  /** Worktree column, or null when unchanged there. */
  worktree: GitCode | null
  /** True for unmerged (conflict) entries. */
  conflicted: boolean
  /** True for untracked files. */
  untracked: boolean
  /** Absolute original path when the entry is a rename/copy. */
  renamedFrom?: string
}

/** Result of a git mutation (stage/unstage/discard/commit/checkout). */
export interface GitOpResult {
  success: boolean
  error?: string
}

export interface GitBranch {
  name: string
  current: boolean
}

export interface GitBranchListResult {
  success: boolean
  error?: string
  /** Local branches, most recently committed first. */
  branches: GitBranch[]
}

/** One file to discard: untracked files are deleted, tracked ones restored. */
export interface GitDiscardTarget {
  /** Absolute path (GitFileStatus.path). */
  path: string
  untracked: boolean
}

export interface GitStatusResult {
  /**
   * `ok` — parsed status below. `not-a-repo` — the project folder is not inside
   * a git work tree. `no-git` — no usable git binary (missing from PATH, or on
   * macOS the Xcode CLT shim is uninstalled). `error` — git exists but the
   * status run failed; see `errorMessage`.
   */
  state: 'ok' | 'not-a-repo' | 'no-git' | 'error'
  repoRoot?: string
  /** Branch name, or the short HEAD oid when detached. Absent before any commit resolves it. */
  branch?: string
  detached?: boolean
  /** Commits ahead of / behind upstream; undefined when there is no upstream. */
  ahead?: number
  behind?: number
  /** Changed files, sorted by relPath; empty unless state is `ok`. */
  files: GitFileStatus[]
  /** True when the file list was capped (pathological change counts). */
  truncated?: boolean
  errorMessage?: string
}

/**
 * Which pair of versions a diff compares, VS Code's two views of a change:
 * `working` is the index against the working tree (the Changes section),
 * `staged` is HEAD against the index (Staged Changes).
 */
export type GitDiffSide = 'working' | 'staged'

/** A revision `git:show` can read a file at: the last commit, or the staging area. */
export type GitShowRevision = 'HEAD' | 'index'

export interface GitDiffRequest {
  /** Absolute path of the file (GitFileStatus.path). */
  path: string
  side: GitDiffSide
  /** Untracked files have no index copy to diff against; the whole file is the change. */
  untracked?: boolean
  /** Absolute original path of a rename, so the diff pairs the two names. */
  renamedFrom?: string
  /**
   * An unmerged file: diffed against HEAD, since the index holds its conflict
   * stages and a plain `git diff` would print the combined (`@@@`) format.
   */
  conflicted?: boolean
}

export interface GitDiffResult {
  success: boolean
  error?: string
  /** `git diff` unified output (no color), or a synthesized all-added diff for an untracked file. */
  diff?: string
}

export interface GitShowResult {
  success: boolean
  error?: string
  /** The file's text at the revision. */
  content?: string
  /** The file does not exist at the revision (added since, or never staged). */
  missing?: boolean
}

/**
 * Why a push or pull failed, for copy that says what to do next. `other`
 * carries git's own message in `error`.
 */
export type GitRemoteFailure =
  'no-remote' | 'no-upstream' | 'auth' | 'diverged' | 'rejected' | 'network' | 'other'

export interface GitRemoteResult {
  success: boolean
  failure?: GitRemoteFailure
  /** git's own message, trimmed. */
  error?: string
}
