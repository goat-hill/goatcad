// Keyboard navigation for the File Explorer tree.
//
// The tree renders recursively (FileTreeNode), but arrow keys move through what
// the user actually SEES — a flat list of visible rows in top-to-bottom order,
// with collapsed subtrees absent entirely. These helpers produce that list and
// move a selection through it, so Sidebar's keydown handler stays a lookup
// rather than a second tree walk.
//
// A `.kicad_sym` is a row that expands like a folder: its children are symbol
// names, not files, and a symbol row is addressed by (path, symbol) because it
// has no path of its own.

export interface TreeNavItem {
  name: string
  path: string
  isDirectory: boolean
  children?: TreeNavItem[]
}

/** One visible row. `symbol` is set only for a symbol leaf inside a library. */
export interface VisibleRow {
  path: string
  symbol?: string
  depth: number
  /** Row can expand: a directory, or a `.kicad_sym` library. */
  expandable: boolean
  expanded: boolean
  /** Path of the row that contains this one, for Left-arrow "step out". */
  parentPath: string | null
}

/** A selected row: a file/folder path, or a symbol inside a `.kicad_sym`. */
export interface TreeSelection {
  path: string
  symbol?: string
}

export const isSymbolLibraryPath = (name: string): boolean => name.endsWith('.kicad_sym')

/**
 * First file whose name ends with `ext`, depth-first. Used to land a freshly
 * scaffolded project on its root schematic rather than an empty explorer.
 */
export const findFileByExt = (nodes: TreeNavItem[], ext: string): TreeNavItem | null => {
  for (const node of nodes) {
    if (node.isDirectory) {
      const hit = node.children ? findFileByExt(node.children, ext) : null
      if (hit) return hit
    } else if (node.name.toLowerCase().endsWith(ext)) {
      return node
    }
  }
  return null
}

const sameRow = (row: VisibleRow, selection: TreeSelection | null): boolean =>
  !!selection && row.path === selection.path && (row.symbol ?? undefined) === selection.symbol

/**
 * Flatten the tree to the rows currently on screen, in display order.
 * `symbolChildren` supplies a library's symbol names; a library with none
 * loaded yet contributes no child rows (the Sidebar fills them on first expand).
 */
export function flattenVisibleRows(
  files: TreeNavItem[],
  expandedPaths: Record<string, boolean>,
  symbolChildren: Record<string, string[]> = {}
): VisibleRow[] {
  const rows: VisibleRow[] = []
  const walk = (items: TreeNavItem[], depth: number, parentPath: string | null): void => {
    for (const item of items) {
      const isLibrary = !item.isDirectory && isSymbolLibraryPath(item.name)
      const expandable = item.isDirectory || isLibrary
      const expanded = expandable && !!expandedPaths[item.path]
      rows.push({ path: item.path, depth, expandable, expanded, parentPath })
      if (!expanded) continue
      if (item.isDirectory) {
        if (item.children) walk(item.children, depth + 1, item.path)
      } else {
        for (const symbol of symbolChildren[item.path] ?? []) {
          rows.push({
            path: item.path,
            symbol,
            depth: depth + 1,
            expandable: false,
            expanded: false,
            parentPath: item.path
          })
        }
      }
    }
  }
  walk(files, 0, null)
  return rows
}

/** Index of `selection` among `rows`, or -1. */
export function indexOfSelection(rows: VisibleRow[], selection: TreeSelection | null): number {
  return rows.findIndex((row) => sameRow(row, selection))
}

/**
 * Move the selection by `delta` rows. With nothing selected, Down lands on the
 * first row and Up on the last, so the keyboard works before any click. Stops
 * at the ends rather than wrapping — a tree is a list, not a carousel.
 */
export function moveSelection(
  rows: VisibleRow[],
  selection: TreeSelection | null,
  delta: number
): TreeSelection | null {
  if (rows.length === 0) return null
  const current = indexOfSelection(rows, selection)
  if (current === -1) {
    const row = delta > 0 ? rows[0] : rows[rows.length - 1]
    return { path: row.path, symbol: row.symbol }
  }
  const next = Math.min(rows.length - 1, Math.max(0, current + delta))
  const row = rows[next]
  return { path: row.path, symbol: row.symbol }
}

export type HorizontalMove =
  | { kind: 'expand'; path: string }
  | { kind: 'collapse'; path: string }
  | { kind: 'select'; selection: TreeSelection }
  | { kind: 'none' }

/**
 * Left/Right, following the tree convention: Right expands a collapsed row then
 * steps into it; Left collapses an expanded row, else steps out to its parent.
 * Returning an intent rather than mutating keeps expansion state owned by the
 * caller (it lives in the Sidebar, shared with mouse clicks).
 */
export function horizontalMove(
  rows: VisibleRow[],
  selection: TreeSelection | null,
  direction: 'left' | 'right'
): HorizontalMove {
  const index = indexOfSelection(rows, selection)
  if (index === -1) return { kind: 'none' }
  const row = rows[index]
  if (direction === 'right') {
    if (row.expandable && !row.expanded) return { kind: 'expand', path: row.path }
    const next = rows[index + 1]
    // Only step in when the next row really is this row's child.
    if (row.expanded && next && next.parentPath === row.path) {
      return { kind: 'select', selection: { path: next.path, symbol: next.symbol } }
    }
    return { kind: 'none' }
  }
  if (row.expandable && row.expanded && !row.symbol) return { kind: 'collapse', path: row.path }
  if (row.parentPath) return { kind: 'select', selection: { path: row.parentPath } }
  return { kind: 'none' }
}

/** Depth-first lookup of the tree node at `path`, or null. */
export function findFileNode<T extends TreeNavItem>(items: T[], path: string): T | null {
  for (const item of items) {
    if (item.path === path) return item
    const found = item.children ? findFileNode(item.children as T[], path) : null
    if (found) return found
  }
  return null
}
