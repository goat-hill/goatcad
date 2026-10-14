import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// A branch's aggregate patch runs to megabytes; the default 1 MB buffer would
// truncate it into a parse error rather than failing loudly.
const MAX_BUFFER = 64 * 1024 * 1024

// Record/field separators for the one-pass commit log. Both are control
// characters git never emits inside a subject or author name.
const REC = '\x1e'
const FIELD = '\x1f'

// Untracked files are listed individually, so a worktree full of build output
// can't turn one selection into an unbounded listing. The overflow is reported
// rather than silently dropped.
const UNTRACKED_LIMIT = 200

// Above this, an untracked file's line count isn't worth reading it for.
const UNTRACKED_STAT_LIMIT = 2 * 1024 * 1024

interface GitFailure {
  code?: number | string
  stdout?: string
  stderr?: string
}

async function git(repo: string, args: string[]): Promise<string> {
  // --no-ext-diff keeps a user's configured difftool out of the patch we parse.
  const { stdout } = await run('git', ['-C', repo, '--no-pager', ...args], {
    maxBuffer: MAX_BUFFER
  })
  return stdout
}

/**
 * `git diff --no-index` reports "the files differ" as exit 1, with the patch on
 * stdout — the one place a non-zero exit is the success path.
 */
async function gitTolerating1(repo: string, args: string[]): Promise<string> {
  try {
    return await git(repo, args)
  } catch (err) {
    const failure = err as GitFailure
    if (failure.code === 1 && typeof failure.stdout === 'string') return failure.stdout
    throw err
  }
}

function gitMessage(err: unknown): string {
  const failure = err as GitFailure
  const stderr = failure?.stderr?.trim()
  return stderr || String(err)
}

// ---- pure parsers (the reason this module is testable without a repo) ----

export interface NumstatEntry {
  path: string
  oldPath?: string
  adds: number
  dels: number
  binary: boolean
}

/**
 * `--numstat -z` records: `adds<TAB>dels<TAB>path<NUL>`, or, for a rename or
 * copy, an empty path field followed by two more NUL-terminated paths. Counts
 * read `-` for binary files.
 */
export function parseNumstat(out: string): NumstatEntry[] {
  const tokens = out.split('\0')
  const entries: NumstatEntry[] = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i++]
    if (!token) continue
    const parts = token.split('\t')
    if (parts.length < 3) continue
    const [addsRaw, delsRaw] = parts
    // A path may itself contain a tab; -z writes it verbatim, so re-join the tail.
    let path = parts.slice(2).join('\t')
    let oldPath: string | undefined
    if (path === '') {
      oldPath = tokens[i++] ?? ''
      path = tokens[i++] ?? ''
    }
    entries.push({
      path,
      oldPath,
      adds: addsRaw === '-' ? 0 : Number(addsRaw) || 0,
      dels: delsRaw === '-' ? 0 : Number(delsRaw) || 0,
      binary: addsRaw === '-' && delsRaw === '-'
    })
  }
  return entries
}

export interface NameStatusEntry {
  path: string
  oldPath?: string
  status: GitFileStatus
}

function toStatus(code: string): GitFileStatus {
  switch (code[0]) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    default:
      return 'modified'
  }
}

/**
 * `--name-status -z` records: `status<NUL>path<NUL>`, with renames and copies
 * carrying a similarity score (`R075`) and two paths instead of one.
 */
export function parseNameStatus(out: string): NameStatusEntry[] {
  const tokens = out.split('\0')
  const entries: NameStatusEntry[] = []
  let i = 0
  while (i < tokens.length) {
    const code = tokens[i++]
    if (!code) continue
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = tokens[i++] ?? ''
      entries.push({ status: toStatus(code), oldPath, path: tokens[i++] ?? '' })
    } else {
      entries.push({ status: toStatus(code), path: tokens[i++] ?? '' })
    }
  }
  return entries
}

/**
 * `git status --porcelain -z` records: two status letters, a space, then the
 * path. A renamed entry carries its origin as an extra NUL-terminated field,
 * which has to be consumed even though only the untracked ones are wanted —
 * skipping it would misalign every record after it.
 */
export function parseStatusPorcelain(out: string): { entries: string[]; untracked: string[] } {
  const tokens = out.split('\0')
  const entries: string[] = []
  const untracked: string[] = []
  let i = 0
  while (i < tokens.length) {
    const entry = tokens[i++]
    if (entry.length < 4) continue
    const [x, y] = entry
    const path = entry.slice(3)
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++
    entries.push(path)
    if (x === '?' && y === '?') untracked.push(path)
  }
  return { entries, untracked }
}

/**
 * One `git log --numstat` pass over the range: a record per commit, its numstat
 * lines trailing it. Merges contribute no numstat lines, so they read as
 * zero-change commits — which is what a merge is, next to its first parent.
 *
 * Fields are split on FIELD rather than by line because the message (`%B`) is
 * itself multi-line: a line-oriented parse would read its body as numstat and
 * lose it. The format ends with a FIELD after the message, so whatever follows
 * that separator is the numstat block and nothing else.
 */
export function parseCommitLog(out: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const record of out.split(REC)) {
    if (!record.trim()) continue
    const fields = record.split(FIELD)
    if (fields.length < 7) continue
    let adds = 0
    let dels = 0
    let files = 0
    for (const line of (fields[7] ?? '').split('\n')) {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(line)
      if (!match) continue
      files++
      if (match[1] !== '-') adds += Number(match[1])
      if (match[2] !== '-') dels += Number(match[2])
    }
    commits.push({
      sha: fields[0],
      shortSha: fields[1],
      parents: fields[2].split(' ').filter(Boolean),
      author: fields[3],
      date: fields[4],
      subject: fields[5],
      message: fields[6].trimEnd(),
      adds,
      dels,
      files
    })
  }
  return commits
}

// ---- git invocations ----

/**
 * The subcommand and revision arguments that select a scope's change set. A
 * commit is read against its first parent (so a merge shows what it brought in);
 * a root commit has no parent to diff against, which is what `show` is for.
 */
interface DiffTarget {
  cmd: 'diff' | 'show'
  lead: string[]
  revs: string[]
}

async function targetFor(worktree: string, base: string, scope: GitDiffScope): Promise<DiffTarget> {
  if (scope.kind === 'working') return { cmd: 'diff', lead: [], revs: ['HEAD'] }
  // Three-dot: everything HEAD added since it forked from base, never base's own work.
  if (scope.kind === 'branch') return { cmd: 'diff', lead: [], revs: [`${base}...HEAD`] }
  const parents = (await git(worktree, ['log', '-1', '--format=%P', scope.sha]))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return parents[0]
    ? { cmd: 'diff', lead: [], revs: [parents[0], scope.sha] }
    : { cmd: 'show', lead: ['--format='], revs: [scope.sha] }
}

const FIND_RENAMES = ['--find-renames', '--no-ext-diff']

/** Line count and binary-ness of an untracked file, without spawning a git per file. */
function untrackedStats(worktree: string, path: string): { adds: number; binary: boolean } {
  try {
    const abs = join(worktree, path)
    if (statSync(abs).size > UNTRACKED_STAT_LIMIT) return { adds: 0, binary: true }
    const text = readFileSync(abs)
    if (text.subarray(0, 8192).includes(0)) return { adds: 0, binary: true }
    if (text.length === 0) return { adds: 0, binary: false }
    const newlines = text.filter((byte) => byte === 0x0a).length
    // A file not ending in a newline still has a final line.
    return { adds: text[text.length - 1] === 0x0a ? newlines : newlines + 1, binary: false }
  } catch {
    return { adds: 0, binary: false }
  }
}

async function trackedChanges(
  worktree: string,
  target: DiffTarget
): Promise<Map<string, GitFileChange>> {
  const args = (mode: string): string[] => [
    target.cmd,
    ...target.lead,
    mode,
    '-z',
    ...FIND_RENAMES,
    ...target.revs
  ]
  const [numstat, nameStatus] = await Promise.all([
    git(worktree, args('--numstat')),
    git(worktree, args('--name-status'))
  ])
  const statuses = new Map(parseNameStatus(nameStatus).map((entry) => [entry.path, entry]))
  const changes = new Map<string, GitFileChange>()
  for (const entry of parseNumstat(numstat)) {
    changes.set(entry.path, {
      path: entry.path,
      oldPath: entry.oldPath,
      status: statuses.get(entry.path)?.status ?? 'modified',
      adds: entry.adds,
      dels: entry.dels,
      binary: entry.binary
    })
  }
  // A mode-only change (chmod, symlink swap) has no numstat record of its own.
  for (const entry of statuses.values()) {
    if (changes.has(entry.path)) continue
    changes.set(entry.path, {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      adds: 0,
      dels: 0,
      binary: false
    })
  }
  return changes
}

/** Every file a scope touches, ordered by path. */
export async function listGitFiles(request: GitDiffRequest): Promise<GitFileListing> {
  const { worktree, base, scope } = request
  try {
    const target = await targetFor(worktree, base, scope)
    const changes = await trackedChanges(worktree, target)
    let untrackedTruncated = 0
    if (scope.kind === 'working') {
      const { untracked } = parseStatusPorcelain(
        await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      )
      untrackedTruncated = Math.max(0, untracked.length - UNTRACKED_LIMIT)
      for (const path of untracked.slice(0, UNTRACKED_LIMIT)) {
        const { adds, binary } = untrackedStats(worktree, path)
        changes.set(path, { path, status: 'untracked', adds, dels: 0, binary })
      }
    }
    const files = [...changes.values()].sort((a, b) => a.path.localeCompare(b.path))
    return { files, untrackedTruncated }
  } catch (err) {
    return { files: [], untrackedTruncated: 0, error: gitMessage(err) }
  }
}

/**
 * The unified diff for one file. `context` is the packed/whole-file switch — the
 * whole file is just a diff with more context than any file has lines, which
 * keeps one patch parser serving both modes.
 */
export async function readGitPatch(request: GitPatchRequest): Promise<GitPatchResult> {
  const { worktree, base, scope, path, oldPath, context } = request
  try {
    if (request.untracked) {
      // An untracked file is in no revision, so it is diffed against nothing.
      return {
        patch: await gitTolerating1(worktree, [
          'diff',
          '--no-index',
          '--no-ext-diff',
          `-U${context}`,
          '--',
          '/dev/null',
          path
        ])
      }
    }
    const target = await targetFor(worktree, base, scope)
    // Both sides of a rename are passed, or git stops pairing them and reports
    // the file as an unrelated delete plus add.
    const paths = oldPath && oldPath !== path ? [oldPath, path] : [path]
    return {
      patch: await git(worktree, [
        target.cmd,
        ...target.lead,
        '-p',
        `-U${context}`,
        ...FIND_RENAMES,
        ...target.revs,
        '--',
        ...paths
      ])
    }
  } catch (err) {
    return { patch: '', error: gitMessage(err) }
  }
}

/** Local branches, for the base picker. Ordered by most recent commit, not alphabetically. */
async function listBranches(worktree: string): Promise<string[]> {
  try {
    const out = await git(worktree, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads'
    ])
    return out.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** The commit rail's contents: what this branch adds over its base, plus the working tree. */
export async function gitDiffOverview(worktree: string, base: string): Promise<GitDiffOverview> {
  const branches = await listBranches(worktree)
  const empty: GitDiffOverview = { base, branches, mergeBase: '', commits: [], workingCount: 0 }
  try {
    await git(worktree, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  } catch {
    return { ...empty, error: `no such branch or commit: ${base}` }
  }
  try {
    const [mergeBase, log, status] = await Promise.all([
      git(worktree, ['merge-base', base, 'HEAD']),
      git(worktree, [
        'log',
        '--numstat',
        ...FIND_RENAMES,
        // The trailing FIELD closes the multi-line message; see parseCommitLog.
        `--format=${REC}%H${FIELD}%h${FIELD}%P${FIELD}%an${FIELD}%aI${FIELD}%s${FIELD}%B${FIELD}`,
        `${base}..HEAD`
      ]),
      git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    ])
    return {
      base,
      branches,
      mergeBase: mergeBase.trim(),
      commits: parseCommitLog(log),
      workingCount: parseStatusPorcelain(status).entries.length
    }
  } catch (err) {
    return { ...empty, error: gitMessage(err) }
  }
}
