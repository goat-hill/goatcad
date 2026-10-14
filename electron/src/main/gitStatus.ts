/**
 * Read-only git status over the system git binary (`git:status` IPC channel).
 *
 * No git library: two `execFile` calls per refresh — `rev-parse --show-toplevel`
 * to find the repo root (and to classify no-git / not-a-repo), then
 * `status --porcelain=v2 -z --branch`. Every failure maps to a `state` value on
 * `GitStatusResult`; nothing throws across IPC. Refresh is event-driven from the
 * renderer (no polling, no fs.watch), so main stays stateless apart from
 * coalescing concurrent invokes per project path.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type {
  GitBranch,
  GitBranchListResult,
  GitCode,
  GitDiscardTarget,
  GitFileStatus,
  GitOpResult,
  GitStatusResult
} from '../preload/gitTypes'

const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER = 20 * 1024 * 1024
/** Soft cap protecting IPC/UI from a pathological untracked flood. */
export const MAX_STATUS_FILES = 1000

export type GitRunResult =
  | { ok: true; stdout: string }
  | { ok: false; failure: 'no-git' | 'exit' | 'other'; exitCode?: number; message: string }

/**
 * Run one git command in `cwd`. The reusable exec seam for future `git:*`
 * channels (diff, stage, …). `--no-optional-locks` is prepended so read-only
 * queries never write `index.lock` under a concurrent CLI git.
 */
export interface GitRunOptions {
  timeoutMs?: number
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
  /** Exit codes that still mean success — `git diff --no-index` exits 1 when files differ. */
  okExitCodes?: number[]
}

export function runGit(
  args: string[],
  cwd: string,
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      {
        cwd,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
        windowsHide: true,
        ...(options.env ? { env: options.env } : {})
      },
      (error, stdout, stderr) => {
        const exit: unknown = error ? (error as NodeJS.ErrnoException).code : 0
        if (!error || (typeof exit === 'number' && options.okExitCodes?.includes(exit))) {
          resolve({ ok: true, stdout })
          return
        }
        const code = exit
        if (code === 'ENOENT') {
          resolve({ ok: false, failure: 'no-git', message: 'git executable not found' })
        } else if (typeof code === 'number') {
          resolve({
            ok: false,
            failure: 'exit',
            exitCode: code,
            message: stderr.trim() || error.message
          })
        } else {
          resolve({ ok: false, failure: 'other', message: stderr.trim() || error.message })
        }
      }
    )
  })
}

/**
 * macOS: /usr/bin/git is a shim that pops the OS "Install developer tools?"
 * dialog when the Command Line Tools are missing. Probe `xcode-select -p`
 * (silent, never triggers the dialog) before the first git spawn; a success is
 * cached for the process lifetime, a failure is re-probed on the next call so
 * installing CLT mid-session recovers without a restart.
 */
let darwinCltConfirmed = false
function gitSpawnIsSafe(): Promise<boolean> {
  if (process.platform !== 'darwin' || darwinCltConfirmed) return Promise.resolve(true)
  return new Promise((resolve) => {
    execFile('xcode-select', ['-p'], { timeout: 5_000, windowsHide: true }, (error) => {
      if (!error) darwinCltConfirmed = true
      resolve(!error)
    })
  })
}

type ParsedStatus = Pick<
  GitStatusResult,
  'branch' | 'detached' | 'ahead' | 'behind' | 'files' | 'truncated'
>

function codeFrom(letter: string): GitCode | null {
  switch (letter) {
    case '.':
      return null
    case 'T': // typechange reads as a modification everywhere we surface it
      return 'M'
    case 'M':
    case 'A':
    case 'D':
    case 'R':
    case 'C':
    case 'U':
      return letter
    default:
      return 'M'
  }
}

/**
 * Parse `git status --porcelain=v2 -z --branch` output. Pure; exported for
 * tests. `-z` framing means NUL-terminated records with no path quoting; a
 * rename record (`2 …`) is followed by one extra NUL token holding the
 * original path.
 */
export function parsePorcelainV2(stdout: string, repoRoot: string): ParsedStatus {
  let oid = ''
  let branch: string | undefined
  let detached: boolean | undefined
  let ahead: number | undefined
  let behind: number | undefined
  const files: GitFileStatus[] = []

  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '') continue
    if (token.startsWith('# branch.oid ')) {
      oid = token.slice('# branch.oid '.length)
    } else if (token.startsWith('# branch.head ')) {
      const head = token.slice('# branch.head '.length)
      if (head === '(detached)') {
        detached = true
      } else {
        branch = head
      }
    } else if (token.startsWith('# branch.ab ')) {
      const match = /^\+(\d+) -(\d+)$/.exec(token.slice('# branch.ab '.length))
      if (match) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
    } else if (token.startsWith('1 ')) {
      const parts = token.split(' ')
      const xy = parts[1] ?? '..'
      pushFile(files, repoRoot, parts.slice(8).join(' '), xy, {
        conflicted: false,
        untracked: false
      })
    } else if (token.startsWith('2 ')) {
      const parts = token.split(' ')
      const xy = parts[1] ?? '..'
      const origPath = tokens[++i] ?? ''
      pushFile(files, repoRoot, parts.slice(9).join(' '), xy, {
        conflicted: false,
        untracked: false,
        renamedFrom: path.resolve(repoRoot, origPath)
      })
    } else if (token.startsWith('u ')) {
      const parts = token.split(' ')
      const xy = parts[1] ?? 'UU'
      pushFile(files, repoRoot, parts.slice(10).join(' '), xy, {
        conflicted: true,
        untracked: false
      })
    } else if (token.startsWith('? ')) {
      // A `dir/` entry is a nested repository (KiCad's `.history`): not a file,
      // and git can only add a pointer to it, so the list leaves it out.
      if (!token.endsWith('/')) {
        pushFile(files, repoRoot, token.slice(2), '..', { conflicted: false, untracked: true })
      }
    }
    // '! ' (ignored) entries are not requested and skipped defensively.
  }

  if (detached && oid && oid !== '(initial)') branch = oid.slice(0, 7)
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  const truncated = files.length > MAX_STATUS_FILES
  return {
    branch,
    detached,
    ahead,
    behind,
    files: truncated ? files.slice(0, MAX_STATUS_FILES) : files,
    truncated: truncated || undefined
  }
}

function pushFile(
  files: GitFileStatus[],
  repoRoot: string,
  relPath: string,
  xy: string,
  extra: { conflicted: boolean; untracked: boolean; renamedFrom?: string }
): void {
  if (!relPath) return
  files.push({
    path: path.resolve(repoRoot, relPath),
    relPath,
    index: codeFrom(xy[0] ?? '.'),
    worktree: codeFrom(xy[1] ?? '.'),
    ...extra
  })
}

// ---- Mutations (the commit loop) ------------------------------------------
// All take absolute file paths (GitFileStatus.path); git accepts absolute
// pathspecs anywhere inside the repo. The renderer re-fetches status after
// every op, so these return only success/error.

function opFromRun(run: GitRunResult): GitOpResult {
  return run.ok ? { success: true } : { success: false, error: run.message }
}

export async function stageFiles(projectPath: string, paths: string[]): Promise<GitOpResult> {
  if (paths.length === 0) return { success: true }
  return opFromRun(await runGit(['add', '--', ...paths], projectPath))
}

export async function unstageFiles(projectPath: string, paths: string[]): Promise<GitOpResult> {
  if (paths.length === 0) return { success: true }
  const run = await runGit(['restore', '--staged', '--', ...paths], projectPath)
  if (run.ok) return { success: true }
  // Before the first commit there is no HEAD for `restore --staged` to copy
  // from; dropping the index entries is the unstage. Only on that specific
  // failure — `rm --cached` on a HEAD-tracked file would stage a deletion.
  if (run.failure === 'exit' && run.message.includes('HEAD')) {
    const fallback = await runGit(['rm', '-q', '--cached', '-r', '--', ...paths], projectPath)
    if (fallback.ok) return { success: true }
  }
  return opFromRun(run)
}

/** Split discard targets into restore (tracked) vs delete (untracked) sets. Pure; exported for tests. */
export function discardPlan(targets: GitDiscardTarget[]): { restore: string[]; remove: string[] } {
  const restore: string[] = []
  const remove: string[] = []
  for (const t of targets) (t.untracked ? remove : restore).push(t.path)
  return { restore, remove }
}

export async function discardChanges(
  projectPath: string,
  targets: GitDiscardTarget[]
): Promise<GitOpResult> {
  const { restore, remove } = discardPlan(targets)
  if (restore.length > 0) {
    const run = await runGit(['restore', '--', ...restore], projectPath)
    if (!run.ok) return opFromRun(run)
  }
  if (remove.length > 0) {
    const run = await runGit(['clean', '-f', '-q', '--', ...remove], projectPath)
    if (!run.ok) return opFromRun(run)
  }
  return { success: true }
}

export async function commitStaged(projectPath: string, message: string): Promise<GitOpResult> {
  const trimmed = message.trim()
  if (!trimmed) return { success: false, error: 'Commit message is empty' }
  return opFromRun(await runGit(['commit', '-m', trimmed], projectPath))
}

// ---- .gitignore -----------------------------------------------------------

/**
 * `.gitignore` text with one more pattern, or null when it already has it.
 * The pattern is appended on a line of its own, keeping whatever line ending
 * the file already uses. Pure; exported for tests.
 */
export function gitignoreWithPattern(existing: string, pattern: string): string | null {
  const lines = existing.split(/\r?\n/).map((line) => line.trim())
  if (lines.includes(pattern)) return null
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const lead = existing.length > 0 && !existing.endsWith('\n') ? eol : ''
  return `${existing}${lead}${pattern}${eol}`
}

/**
 * Ignore exactly one file: an anchored pattern (`/hw/out.pdf`) in the
 * repository root's `.gitignore`, created when absent. Anchored so it ignores
 * the file clicked, not every same-named file in the tree.
 */
export async function ignorePath(projectPath: string, absPath: string): Promise<GitOpResult> {
  const rootRun = await runGit(['rev-parse', '--show-toplevel'], projectPath)
  if (!rootRun.ok) return opFromRun(rootRun)
  const repoRoot = path.normalize(rootRun.stdout.trim())
  const rel = path.relative(repoRoot, absPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { success: false, error: 'Path is outside the repository' }
  }
  const pattern = `/${rel.split(path.sep).join('/')}`
  const file = path.join(repoRoot, '.gitignore')
  try {
    const existing = fs.existsSync(file) ? await fs.promises.readFile(file, 'utf8') : ''
    const next = gitignoreWithPattern(existing, pattern)
    if (next !== null) await fs.promises.writeFile(file, next, 'utf8')
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---- Repository creation --------------------------------------------------

/**
 * `git init` in the project folder — the pane's way out of the `not-a-repo`
 * state, so a freshly created project does not need the CLI to get a repo.
 */
export async function initRepo(projectPath: string): Promise<GitOpResult> {
  if (!projectPath) return { success: false, error: 'No project folder is open' }
  return opFromRun(await runGit(['init'], projectPath))
}

// ---- Branches -------------------------------------------------------------

const BRANCH_FORMAT = '%(HEAD)%00%(refname:short)'

/**
 * Parse `git branch --list --format=<BRANCH_FORMAT>` output. Pure; exported
 * for tests. In a detached-HEAD state git emits a pseudo-entry whose short
 * name is parenthesized ("(HEAD detached at abc1234)") — filtered out; the
 * status bar already shows the short oid for that case.
 */
export function parseBranchList(stdout: string): GitBranch[] {
  const branches: GitBranch[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const sep = line.indexOf('\0')
    if (sep < 0) continue
    const name = line.slice(sep + 1)
    if (!name || name.startsWith('(')) continue
    branches.push({ name, current: line.slice(0, sep) === '*' })
  }
  return branches
}

export async function listBranches(projectPath: string): Promise<GitBranchListResult> {
  const run = await runGit(
    ['branch', '--list', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`],
    projectPath
  )
  if (!run.ok) return { success: false, error: run.message, branches: [] }
  return { success: true, branches: parseBranchList(run.stdout) }
}

/** Switch to a branch, or create it from HEAD first (`git switch [-c]`). */
export async function checkoutBranch(
  projectPath: string,
  name: string,
  create: boolean
): Promise<GitOpResult> {
  const trimmed = name.trim()
  if (!trimmed) return { success: false, error: 'Branch name is empty' }
  const args = create ? ['switch', '-c', trimmed] : ['switch', trimmed]
  return opFromRun(await runGit(args, projectPath))
}

/** In-flight coalescing: a second invoke for the same path joins the first. */
const inflight = new Map<string, Promise<GitStatusResult>>()

export function getGitStatus(projectPath: string): Promise<GitStatusResult> {
  const pending = inflight.get(projectPath)
  if (pending) return pending
  const run = computeGitStatus(projectPath).finally(() => inflight.delete(projectPath))
  inflight.set(projectPath, run)
  return run
}

async function computeGitStatus(projectPath: string): Promise<GitStatusResult> {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { state: 'error', files: [], errorMessage: 'Project folder does not exist' }
  }
  if (!(await gitSpawnIsSafe())) return { state: 'no-git', files: [] }

  const rootRun = await runGit(['rev-parse', '--show-toplevel'], projectPath)
  if (!rootRun.ok) {
    if (rootRun.failure === 'no-git') return { state: 'no-git', files: [] }
    if (rootRun.failure === 'exit') return { state: 'not-a-repo', files: [] }
    return { state: 'error', files: [], errorMessage: rootRun.message }
  }
  // git prints '/'-separated even on Windows; normalize to platform separators
  const repoRoot = path.normalize(rootRun.stdout.trim())

  const statusRun = await runGit(
    ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'],
    projectPath
  )
  if (!statusRun.ok) {
    if (statusRun.failure === 'no-git') return { state: 'no-git', files: [] }
    return { state: 'error', files: [], errorMessage: statusRun.message }
  }

  return { state: 'ok', repoRoot, ...parsePorcelainV2(statusRun.stdout, repoRoot) }
}
