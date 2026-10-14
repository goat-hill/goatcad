/**
 * Pure derivation of file-explorer git decorations from a `GitStatusResult`.
 *
 * Built once per status refresh (Sidebar provides the result under
 * `GIT_DECORATIONS_KEY`; the recursive FileTreeNode injects it, so the tree
 * needs no extra props). Map keys are absolute paths normalized to `/`
 * separators so lookups work identically on Windows.
 */
import type { ComputedRef, InjectionKey } from 'vue'
import type { GitFileStatus } from '../../../preload/gitTypes'

export type GitDecorClass = 'git-modified' | 'git-added' | 'git-deleted' | 'git-conflict'

export interface GitDecoration {
  /** Status letter shown as the row badge (VSCode-style). */
  letter: 'M' | 'A' | 'D' | 'U' | 'R' | '!'
  cls: GitDecorClass
}

export interface GitTreeDecorations {
  /** Per-file decoration, keyed by normalized absolute path. */
  files: ReadonlyMap<string, GitDecoration>
  /** Tint for directories containing changed files, keyed the same way. */
  dirs: ReadonlyMap<string, GitDecorClass>
}

export const EMPTY_GIT_DECORATIONS: GitTreeDecorations = {
  files: new Map(),
  dirs: new Map()
}

export const GIT_DECORATIONS_KEY: InjectionKey<ComputedRef<GitTreeDecorations>> =
  Symbol('gitDecorations')

export const normalizeFsPath = (p: string): string => p.replace(/\\/g, '/')

/**
 * Collapse a file's two-sided status into the single letter/color the explorer
 * shows: conflict > untracked > staged-add > rename > modified/deleted.
 */
export function decorationFor(f: GitFileStatus): GitDecoration {
  if (f.conflicted) return { letter: '!', cls: 'git-conflict' }
  if (f.untracked) return { letter: 'U', cls: 'git-added' }
  if (f.index === 'A') return { letter: 'A', cls: 'git-added' }
  if (f.index === 'R' || f.index === 'C') return { letter: 'R', cls: 'git-modified' }
  const code = f.worktree ?? f.index
  if (code === 'D') return { letter: 'D', cls: 'git-deleted' }
  return { letter: 'M', cls: 'git-modified' }
}

export function buildTreeDecorations(
  projectPath: string,
  files: readonly GitFileStatus[]
): GitTreeDecorations {
  const fileMap = new Map<string, GitDecoration>()
  const dirMap = new Map<string, GitDecorClass>()
  const projectPrefix = `${normalizeFsPath(projectPath).replace(/\/+$/, '')}/`

  for (const f of files) {
    const abs = normalizeFsPath(f.path)
    const deco = decorationFor(f)
    fileMap.set(abs, deco)

    // Tint every ancestor directory strictly below the project root. Conflicts
    // promote the tint to red; everything else reads as "contains changes".
    if (!abs.startsWith(projectPrefix)) continue
    const dirCls: GitDecorClass = deco.cls === 'git-conflict' ? 'git-conflict' : 'git-modified'
    let end = abs.lastIndexOf('/')
    while (end > projectPrefix.length - 1) {
      const dir = abs.slice(0, end)
      if (dirMap.get(dir) !== 'git-conflict') dirMap.set(dir, dirCls)
      end = abs.lastIndexOf('/', end - 1)
    }
  }
  return { files: fileMap, dirs: dirMap }
}
