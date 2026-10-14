// Groups a scope's flat file list into the folder tree the Git Diff rail shows,
// the way a pull request lists its changed files.
//
// The one behavior worth naming: a directory whose only child is another
// directory is folded into a single `src/renderer/src` row. A changed-file list
// is mostly deep, narrow chains, and a row per empty level is a row that offers
// no choice — it only pushes the names that matter further right.

export interface TreeFile {
  kind: 'file'
  name: string
  path: string
  file: GitFileChange
}

export interface TreeDir {
  kind: 'dir'
  name: string
  /** Full path of the directory — the identity its collapsed state is keyed on. */
  path: string
  children: TreeNode[]
}

export type TreeNode = TreeDir | TreeFile

/** A tree flattened for rendering: one row per visible node, with its indent. */
export type TreeRow =
  | { kind: 'dir'; name: string; path: string; depth: number }
  | { kind: 'file'; name: string; path: string; depth: number; file: GitFileChange }

function sorted(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function fold(nodes: TreeNode[]): TreeNode[] {
  return sorted(nodes).map((node) => {
    if (node.kind === 'file') return node
    let dir = node
    while (dir.children.length === 1 && dir.children[0].kind === 'dir') {
      const only = dir.children[0]
      dir = {
        kind: 'dir',
        name: `${dir.name}/${only.name}`,
        path: only.path,
        children: only.children
      }
    }
    return { ...dir, children: fold(dir.children) }
  })
}

export function buildFileTree(files: GitFileChange[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    const name = parts.pop() ?? file.path
    let dir = root
    let prefix = ''
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part
      const existing = dir.children.find(
        (child): child is TreeDir => child.kind === 'dir' && child.name === part
      )
      if (existing) {
        dir = existing
      } else {
        const created: TreeDir = { kind: 'dir', name: part, path: prefix, children: [] }
        dir.children.push(created)
        dir = created
      }
    }
    dir.children.push({ kind: 'file', name, path: file.path, file })
  }
  return fold(root.children)
}

export function flattenTree(
  nodes: TreeNode[],
  isCollapsed: (path: string) => boolean,
  depth = 0
): TreeRow[] {
  const rows: TreeRow[] = []
  for (const node of nodes) {
    if (node.kind === 'file') {
      rows.push({ kind: 'file', name: node.name, path: node.path, depth, file: node.file })
      continue
    }
    rows.push({ kind: 'dir', name: node.name, path: node.path, depth })
    if (!isCollapsed(node.path)) rows.push(...flattenTree(node.children, isCollapsed, depth + 1))
  }
  return rows
}
