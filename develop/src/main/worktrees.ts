import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { countWorkspace, WORKSPACE_DIR } from './workspace'

const run = promisify(execFile)

function git(repo: string, args: string[]): Promise<{ stdout: string }> {
  return run('git', ['-C', repo, ...args])
}

// A workstream's display name is per-worktree state, so it lives in that worktree's
// own scratch dir — as a dotfile, which the Workspace listing skips. Renaming never
// touches the branch; the branch stays the identity, the name is just the label.
const META_FILE = '.meta.json'

interface WorktreeMeta {
  name?: string
}

function metaPath(worktreePath: string): string {
  return join(worktreePath, WORKSPACE_DIR, META_FILE)
}

function readMeta(worktreePath: string): WorktreeMeta {
  try {
    const parsed: unknown = JSON.parse(readFileSync(metaPath(worktreePath), 'utf8'))
    if (parsed && typeof parsed === 'object') return parsed as WorktreeMeta
  } catch {
    // no metadata (the common case) or unreadable — the branch name stands in
  }
  return {}
}

/** Set a workstream's display name; an empty name clears it back to the branch. */
export function setWorktreeName(worktreePath: string, name: string): void {
  const meta = readMeta(worktreePath)
  const trimmed = name.trim()
  if (trimmed) meta.name = trimmed
  else delete meta.name
  mkdirSync(join(worktreePath, WORKSPACE_DIR), { recursive: true })
  writeFileSync(metaPath(worktreePath), `${JSON.stringify(meta, null, 2)}\n`)
}

export async function currentBranch(repo: string): Promise<string> {
  const { stdout } = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return stdout.trim()
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const { stdout } = await git(repo, ['worktree', 'list', '--porcelain'])
  const worktrees: Worktree[] = []
  const blocks = stdout.split('\n\n')
  const promises = blocks.map(async (block) => {
    const lines = block.split('\n').filter((line) => line.length > 0)
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
    if (!path) return null
    const head = lines.find((line) => line.startsWith('HEAD '))?.slice('HEAD '.length) ?? ''
    const branchRef = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length)
    const branch = branchRef?.replace('refs/heads/', '') ?? '(detached)'

    let commitsAhead = 0
    try {
      const { stdout: countOut } = await git(path, ['rev-list', '--count', 'master..HEAD'])
      commitsAhead = parseInt(countOut.trim(), 10) || 0
    } catch {
      // ignore
    }

    let hasUncommitted = false
    try {
      const { stdout: statusOut } = await git(path, ['status', '--porcelain'])
      hasUncommitted = statusOut.trim().length > 0
    } catch {
      // ignore
    }

    return {
      path,
      branch,
      name: readMeta(path).name,
      head: head.slice(0, 7),
      isMain: false,
      commitsAhead,
      hasUncommitted,
      workspaceCount: countWorkspace(path)
    }
  })

  const results = await Promise.all(promises)
  for (const wt of results) {
    if (wt) {
      worktrees.push(wt)
    }
  }

  if (worktrees.length > 0) {
    worktrees[0].isMain = true
  }

  return worktrees
}

/** Create a worktree under .claude/worktrees/ (where Claude Code keeps its own), on a new or existing branch. */
export async function addWorktree(repo: string, branch: string): Promise<string> {
  const dir = join(repo, '.claude', 'worktrees', branch.replace(/[^\w.-]+/g, '-'))
  const branchExists = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false)
  await git(
    repo,
    branchExists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', dir, '-b', branch]
  )
  return dir
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', path])
}
