/**
 * Reading a changed file's versions for the diff tab (`git:diff`, `git:show`).
 *
 * The text diff is git's own (`git diff`), so the hunking runs in a child
 * process rather than on either UI thread; the renderer only parses it. The
 * visual diff reads whole blobs through `git:show` instead, since it parses the
 * design itself.
 */
import * as fs from 'fs'
import * as path from 'path'
import type {
  GitDiffRequest,
  GitDiffResult,
  GitShowResult,
  GitShowRevision
} from '../preload/gitTypes'
import { runGit } from './gitStatus'

/** A design file's blob or diff can outgrow the status buffer (dense boards run to tens of MB). */
const CONTENT_MAX_BUFFER = 128 * 1024 * 1024

async function repoRootOf(projectPath: string): Promise<string | null> {
  const run = await runGit(['rev-parse', '--show-toplevel'], projectPath)
  return run.ok ? path.normalize(run.stdout.trim()) : null
}

/** Repo-relative `/`-separated path, or null when the file lies outside the repo. */
export function repoRelative(repoRoot: string, absPath: string): string | null {
  const rel = path.relative(repoRoot, absPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/**
 * A unified diff adding every line of `content`, for an untracked file: git has
 * no cross-platform way to diff against nothing (`--no-index /dev/null` is
 * POSIX-only). Pure; exported for tests.
 */
export function addedFileDiff(relPath: string, content: string): string {
  if (content.includes('\0')) {
    return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\nBinary files /dev/null and b/${relPath} differ\n`
  }
  const lines = content.split('\n')
  // A trailing newline ends the last line rather than starting an empty one.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n`
  if (lines.length === 0) return header
  return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`
}

export async function diffFile(projectPath: string, req: GitDiffRequest): Promise<GitDiffResult> {
  if (req.untracked) {
    const repoRoot = await repoRootOf(projectPath)
    const rel = repoRoot ? repoRelative(repoRoot, req.path) : null
    if (!rel) return { success: false, error: 'File is outside the repository' }
    try {
      const content = await fs.promises.readFile(req.path, 'utf8')
      return { success: true, diff: addedFileDiff(rel, content) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  const args = ['diff', '--no-color', '--no-ext-diff', '-U3']
  if (req.side === 'staged') args.push('--cached', '-M')
  else if (req.conflicted) args.push('HEAD')
  args.push('--', ...(req.renamedFrom ? [req.renamedFrom, req.path] : [req.path]))
  const run = await runGit(args, projectPath, { maxBuffer: CONTENT_MAX_BUFFER })
  return run.ok ? { success: true, diff: run.stdout } : { success: false, error: run.message }
}

/** A file's text at HEAD (`HEAD:<path>`) or in the index (`:<path>`). */
export async function showFile(
  projectPath: string,
  absPath: string,
  revision: GitShowRevision
): Promise<GitShowResult> {
  const repoRoot = await repoRootOf(projectPath)
  const rel = repoRoot ? repoRelative(repoRoot, absPath) : null
  if (!rel) return { success: false, error: 'File is outside the repository' }
  const spec = revision === 'HEAD' ? `HEAD:${rel}` : `:${rel}`
  const run = await runGit(['show', spec], projectPath, { maxBuffer: CONTENT_MAX_BUFFER })
  if (run.ok) return { success: true, content: run.stdout }
  // Absent at that revision (a new file, or no commit yet): an empty side, not an error.
  if (
    run.failure === 'exit' &&
    /does not exist|exists on disk, but not in|invalid object name|bad revision|not in the index/i.test(
      run.message
    )
  ) {
    return { success: true, missing: true }
  }
  return { success: false, error: run.message }
}
