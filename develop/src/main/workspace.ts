import { readdirSync, statSync, type Dirent } from 'node:fs'
import { extname, join, relative } from 'node:path'

// The per-worktree scratch dir agents drop demos into (screenshots, recordings,
// and any wrapping .md/.html). Meant to be gitignored — GoatHerd only reads it.
export const WORKSPACE_DIR = '.goatherd'

// How deep to descend so an agent can group a demo in its own subfolder without
// GoatHerd wandering into an accidentally-huge tree.
const MAX_DEPTH = 4

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv'])
const MARKDOWN_EXTS = new Set(['.md', '.markdown'])
const HTML_EXTS = new Set(['.html', '.htm'])
const TEXT_EXTS = new Set(['.txt', '.log', '.json'])

function classify(name: string): WorkspaceKind {
  const ext = extname(name).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (HTML_EXTS.has(ext)) return 'html'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'other'
}

function walk(root: string, dir: string, depth: number, out: WorkspaceEntry[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // missing/unreadable .goatherd degrades to an empty list
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // skip .gitignore and other dotfiles
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) walk(root, abs, depth + 1, out)
    } else if (entry.isFile()) {
      let size = 0
      let modifiedMs = 0
      try {
        const stat = statSync(abs)
        size = stat.size
        modifiedMs = stat.mtimeMs
      } catch {
        // keep the entry with zeroed stats rather than dropping it
      }
      out.push({
        name: entry.name,
        relPath: relative(root, abs),
        path: abs,
        kind: classify(entry.name),
        size,
        modifiedMs
      })
    }
  }
}

/** Newest-first list of every file under `<worktree>/.goatherd/`. */
export function listWorkspace(worktreePath: string): WorkspaceEntry[] {
  const root = join(worktreePath, WORKSPACE_DIR)
  const out: WorkspaceEntry[] = []
  walk(root, root, 0, out)
  out.sort((a, b) => b.modifiedMs - a.modifiedMs)
  return out
}

/** File count for the sidebar/button badge, without shipping the whole listing. */
export function countWorkspace(worktreePath: string): number {
  const out: WorkspaceEntry[] = []
  const root = join(worktreePath, WORKSPACE_DIR)
  walk(root, root, 0, out)
  return out.length
}
