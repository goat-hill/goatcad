/**
 * The window's git actions and their shared state.
 *
 * One instance per window, created by App and provided under `GIT_KEY`, so the
 * Git pane, a diff tab and App's hotkeys all run the same operations against
 * the same busy flag and error line: a Push pressed on the keyboard shows its
 * progress in the pane, and a stage from a diff tab updates the pane's list.
 * Every op re-fetches status afterwards through `refresh`.
 */
import { computed, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import { diffTabPath, parseDiffTab } from '../tabs'
import type {
  GitDiscardTarget,
  GitFileStatus,
  GitOpResult,
  GitRemoteFailure,
  GitRemoteResult,
  GitStatusResult
} from '../../../../preload/gitTypes'

export type GitRemoteOp = 'push' | 'pull'

/** What the pane's error line says: a remote failure is explained, anything else is git's words. */
export interface GitOpError {
  failure?: GitRemoteFailure
  op?: GitRemoteOp
  /** A commit-all refused because it would mark unresolved conflicts resolved. */
  conflicts?: boolean
  message: string
}

export interface GitOps {
  status: Readonly<Ref<GitStatusResult | null>>
  projectPath: Readonly<Ref<string | null>>
  busy: Readonly<Ref<boolean>>
  /** The remote op in flight, which can outlast a local one by seconds. */
  remote: Readonly<Ref<GitRemoteOp | null>>
  error: Ref<GitOpError | null>
  /** Last remote op that succeeded, for a brief confirmation. Cleared by the next op. */
  lastRemoteSuccess: Readonly<Ref<GitRemoteOp | null>>
  hasStaged: ComputedRef<boolean>
  hasChanges: ComputedRef<boolean>
  /**
   * Set by the focus-commit hotkey, cleared by the pane once it has focused its
   * message box. A flag rather than an event: the hotkey may be what opens the
   * pane, so the request has to outlast the mount.
   */
  commitFocusPending: Ref<boolean>
  requestCommitFocus: () => void
  /** Re-read status (the pane's refresh button; every op already does). */
  refresh: () => Promise<void>
  init: () => Promise<boolean>
  stage: (paths: string[]) => Promise<boolean>
  unstage: (paths: string[]) => Promise<boolean>
  stageAll: () => Promise<boolean>
  discard: (targets: GitDiscardTarget[]) => Promise<boolean>
  /** Add an anchored pattern for this file to the repository's `.gitignore`. */
  ignore: (path: string) => Promise<boolean>
  /** Commit the staged changes — or, when nothing is staged, every change (the smart commit). */
  commit: (message: string) => Promise<boolean>
  push: () => Promise<boolean>
  pull: () => Promise<boolean>
}

export const GIT_KEY: InjectionKey<GitOps> = Symbol('git-ops')

/** Files the Staged section lists. Pure; exported for tests. */
export const stagedFiles = (files: GitFileStatus[]): GitFileStatus[] =>
  files.filter((f) => !f.conflicted && f.index !== null)

/** What "stage everything" means: every listed change and conflict. Pure; exported for tests. */
export const stageableFiles = (files: GitFileStatus[]): GitFileStatus[] => [
  ...conflictedFiles(files),
  ...unstagedFiles(files)
]

/** Files the Changes section lists. Pure; exported for tests. */
export const unstagedFiles = (files: GitFileStatus[]): GitFileStatus[] =>
  files.filter((f) => !f.conflicted && (f.untracked || f.worktree !== null))

/** Files the Merge section lists. Pure; exported for tests. */
export const conflictedFiles = (files: GitFileStatus[]): GitFileStatus[] =>
  files.filter((f) => f.conflicted)

/**
 * Diff tabs whose side has emptied while the other side holds the change — a
 * stage moves a file's whole change from Changes to Staged, an unstage back —
 * each with the tab it becomes, so it follows the change rather than going
 * blank. A file with no change left (a commit, a discard) or one already open
 * on the other side stays put. Pure; exported for tests.
 */
export const followedDiffTabs = (
  tabPaths: readonly string[],
  files: readonly GitFileStatus[]
): Array<[from: string, to: string]> => {
  const open = new Set(tabPaths)
  const moves: Array<[string, string]> = []
  for (const path of tabPaths) {
    const tab = parseDiffTab(path)
    const file = tab && files.find((f) => f.path === tab.filePath)
    if (!tab || !file) continue
    const staged = !file.conflicted && file.index !== null
    const working = file.conflicted || file.untracked || file.worktree !== null
    const [here, there] = tab.side === 'staged' ? [staged, working] : [working, staged]
    if (here || !there) continue
    const next = diffTabPath(tab.side === 'staged' ? 'working' : 'staged', tab.filePath, tab.symbol)
    if (!open.has(next)) moves.push([path, next])
  }
  return moves
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface GitOpsHooks {
  /** Re-read status. */
  refresh: () => Promise<void>
  /** Files changed on disk (a pull, a discard): announce it, which re-reads status too. */
  worktreeChanged: () => Promise<void>
}

export function createGitOps(
  status: Readonly<Ref<GitStatusResult | null>>,
  projectPath: Readonly<Ref<string | null>>,
  hooks: GitOpsHooks
): GitOps {
  const { refresh } = hooks
  const busy = ref(false)
  const remote = ref<GitRemoteOp | null>(null)
  const error = ref<GitOpError | null>(null)
  const lastRemoteSuccess = ref<GitRemoteOp | null>(null)
  const commitFocusPending = ref(false)

  const files = computed(() => (status.value?.state === 'ok' ? status.value.files : []))
  const hasStaged = computed(() => stagedFiles(files.value).length > 0)
  const hasChanges = computed(() => hasStaged.value || stageableFiles(files.value).length > 0)

  /** Run one local op; false when it failed or another op holds the lock. */
  const run = async (
    op: (path: string) => Promise<GitOpResult>,
    touchesWorktree = false
  ): Promise<boolean> => {
    const path = projectPath.value
    if (!path || busy.value) return false
    busy.value = true
    error.value = null
    lastRemoteSuccess.value = null
    try {
      const res = await op(path)
      if (!res.success) error.value = { message: res.error ?? '' }
      return res.success
    } catch (err) {
      error.value = { message: message(err) }
      return false
    } finally {
      busy.value = false
      await (touchesWorktree ? hooks.worktreeChanged() : refresh())
    }
  }

  const runRemote = async (
    op: GitRemoteOp,
    call: (path: string) => Promise<GitRemoteResult>
  ): Promise<boolean> => {
    const path = projectPath.value
    if (!path || busy.value) return false
    busy.value = true
    remote.value = op
    error.value = null
    lastRemoteSuccess.value = null
    let ok = false
    try {
      const res = await call(path)
      ok = res.success
      if (ok) lastRemoteSuccess.value = op
      else error.value = { op, failure: res.failure ?? 'other', message: res.error ?? '' }
    } catch (err) {
      error.value = { op, failure: 'other', message: message(err) }
    } finally {
      busy.value = false
      remote.value = null
      await (ok && op === 'pull' ? hooks.worktreeChanged() : refresh())
    }
    return ok
  }

  return {
    status,
    projectPath,
    busy,
    remote,
    error,
    lastRemoteSuccess,
    hasStaged,
    hasChanges,
    commitFocusPending,
    requestCommitFocus: () => {
      commitFocusPending.value = true
    },
    refresh,
    init: () => run((p) => window.api.gitInit(p)),
    stage: (paths) => run((p) => window.api.gitStage(p, paths)),
    unstage: (paths) => run((p) => window.api.gitUnstage(p, paths)),
    stageAll: () => {
      const paths = stageableFiles(files.value).map((f) => f.path)
      return paths.length === 0 ? Promise.resolve(true) : run((p) => window.api.gitStage(p, paths))
    },
    ignore: (path) => run((p) => window.api.gitIgnore(p, path)),
    discard: (targets) => run((p) => window.api.gitDiscard(p, targets), true),
    commit: async (text) => {
      if (!text.trim() || !hasChanges.value || busy.value) return false
      const all = !hasStaged.value
      // `add -A` would stage a conflicted file as resolved, markers and all.
      if (all && conflictedFiles(files.value).length > 0) {
        error.value = { conflicts: true, message: '' }
        return false
      }
      if (!all) return run((p) => window.api.gitCommit(p, text))
      // Stage what the list shows, then commit — not `add -A`, which would also
      // sweep in what the list leaves out: a nested repository, as a pointer.
      const paths = stageableFiles(files.value).map((f) => f.path)
      if (paths.length === 0) return false
      return run(async (p) => {
        const staged = await window.api.gitStage(p, paths)
        return staged.success ? window.api.gitCommit(p, text) : staged
      })
    },
    push: () => runRemote('push', (p) => window.api.gitPush(p)),
    pull: () => runRemote('pull', (p) => window.api.gitPull(p))
  }
}
