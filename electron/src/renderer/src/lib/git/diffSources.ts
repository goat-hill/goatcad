/**
 * Both versions of one changed file, as text, for the views that parse the
 * design itself (the visual diff, a symbol's diff). Which versions a diff
 * compares follows git's two views of a change: `working` is the index
 * against the working tree, `staged` is HEAD against the index. A side the
 * file does not exist on (added since, or deleted) is null.
 */
import type { GitDiffSide } from '../../../../preload/gitTypes'

export interface DiffSourceRequest {
  /** Where git runs: the repo root or the project folder. */
  cwd: string
  filePath: string
  side: GitDiffSide
  untracked: boolean
  deleted: boolean
}

const shown = async (
  cwd: string,
  filePath: string,
  revision: 'HEAD' | 'index'
): Promise<string | null> => {
  const res = await window.api.gitShow(cwd, filePath, revision)
  if (!res.success) throw new Error(res.error)
  return res.missing ? null : (res.content ?? '')
}

export async function readDiffVersions(
  req: DiffSourceRequest
): Promise<{ before: string | null; after: string | null }> {
  const before = req.untracked
    ? Promise.resolve(null)
    : shown(req.cwd, req.filePath, req.side === 'staged' ? 'HEAD' : 'index')
  const after = req.deleted
    ? Promise.resolve(null)
    : req.side === 'staged'
      ? shown(req.cwd, req.filePath, 'index')
      : window.api.readFile(req.filePath).then((res) => {
          if (!res.success) throw new Error(res.error)
          return res.content ?? ''
        })
  const [was, now] = await Promise.all([before, after])
  return { before: was, after: now }
}
