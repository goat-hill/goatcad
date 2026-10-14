/**
 * The right-click menu over a row — a **view over the command registry**
 * (lib/commands.ts), not its own command set. The clicked row *is* the
 * context, so the registry's `enabledWhen` decides what appears: a directory
 * offers no Open, a `.kicad_sym` offers New Symbol, a `.pretty` offers New
 * Footprint (docs/projects.md §7.2, §4.6).
 *
 * Unlike the File menu this omits what it cannot run rather than graying it: the
 * File menu grays for discoverability, but a menu opened *on a row* would just
 * be listing the other row types.
 *
 * Two scopes share it. The **explorer** shows the filesystem: Reveal and Copy
 * Path belong there, and a row borrows its folder's `New ▸` because the tree
 * *is* folders. The **Project view** shows the design — sheets, libraries, the
 * footprints inside them — where a row is a part of the board that happens to
 * live in a file. So that scope drops both the filesystem pair and the generic
 * `New ▸`, and what remains is what the row itself can hold: New Symbol on a
 * symbol library, New Footprint on a `.pretty`, nothing on a leaf. Everything
 * that acts on the design appears in both.
 */
import type { ComputedRef, InjectionKey } from 'vue'
import {
  buildCommandMenu,
  trimDividers,
  NEW_FILE_IDS,
  type CommandContext,
  type Translate
} from './commands'
import type { MenuNode } from './menu'

export type { Translate }

export interface FileMenuTarget {
  name: string
  isDirectory: boolean
}

/** Which surface the menu was opened on; see the module note. */
export type FileMenuScope = 'explorer' | 'project'

const isFootprintLibrary = (target: FileMenuTarget): boolean =>
  target.isDirectory && target.name.toLowerCase().endsWith('.pretty')

export function buildFileTreeMenu(
  target: FileMenuTarget,
  t: Translate,
  ctx: Pick<CommandContext, 'projectPath'> = { projectPath: null },
  scope: FileMenuScope = 'explorer'
): MenuNode[] {
  // A file's `New ▸` targets the folder that contains it, so both rows offer it;
  // the container creates below key off the row itself.
  const commandCtx: CommandContext = {
    projectPath: ctx.projectPath,
    target: { ...target, path: '' }
  }
  const only = { omitDisabled: true }

  return trimDividers([
    // Both container creates are promoted on the row that can carry them: a
    // `.kicad_sym` offers New Symbol, a `.pretty` offers New Footprint. Each is
    // omitted on every other row rather than grayed, so the menu never lists
    // what this row is not.
    ...buildCommandMenu(['file:open', 'new:symbol', 'new:footprint'], commandCtx, t, only),
    { divider: true },
    // **A row's creates are what can live inside that row.** The generic `New ▸`
    // is a folder's menu: in the explorer a file row borrows it for the folder
    // that contains it, which is the tree's own geometry. The Project view has
    // no such geometry — a footprint is a part of the design, not a place — so
    // offering New ▸ Schematic there reads as "a schematic goes inside this
    // footprint". The container creates above already say what each row can
    // hold, and each group header carries its own `+` for the rest.
    //
    // A `.pretty` drops it in both scopes for the same reason: it holds
    // footprints and nothing else, and New Footprint is the whole answer.
    ...(scope === 'project' || isFootprintLibrary(target)
      ? []
      : [
          {
            // The file creates stay listed and merely gray without a project: an
            // empty `New ▸` would read as "this folder can't hold anything", when
            // the real answer is "make a project first".
            id: 'new',
            label: t('sidebar.fileMenu.new'),
            children: buildCommandMenu(NEW_FILE_IDS, commandCtx, t)
          }
        ]),
    { divider: true },
    // The filesystem pair, in the pane that is about the filesystem.
    ...(scope === 'explorer'
      ? buildCommandMenu(['file:reveal', 'file:copy-path'], commandCtx, t, only)
      : []),
    { divider: true },
    // No F2/Del accelerators yet: the explorer has no selected-row concept for a
    // bare keypress to act on, and advertising a shortcut that does nothing is
    // worse than omitting it. They arrive with tree selection.
    ...buildCommandMenu(['file:rename', 'file:delete'], commandCtx, t, only)
  ])
}

/**
 * Inline-rename state reaches the tree by injection for the same reason git
 * decorations do: FileTreeNode is recursive, so a prop would have to be
 * re-threaded at every depth.
 */
export interface RenameSession {
  /** Path of the row currently being renamed, or null. */
  path: ComputedRef<string | null>
  /** Validation failure for the text typed so far; null while it is valid. */
  error: ComputedRef<NameError | null>
  onInput: (value: string) => void
  commit: () => void
  cancel: () => void
}

export const RENAME_SESSION_KEY: InjectionKey<RenameSession> = Symbol('rename-session')

/**
 * The sibling of `RenameSession` for renaming a **symbol** inside a `.kicad_sym`
 * (a synthesized tree leaf, not a file). Same inline-input primitive, keyed by
 * `<libPath>#<symbol>` since a symbol has no filesystem path of its own.
 */
export interface SymbolRenameSession {
  /** `<libPath>#<symbol>` of the leaf being renamed, or null. */
  key: ComputedRef<string | null>
  draft: ComputedRef<string>
  /** True when the typed name is empty or clashes with a sibling symbol. */
  invalid: ComputedRef<boolean>
  onInput: (value: string) => void
  commit: () => void
  cancel: () => void
}

export const SYMBOL_RENAME_SESSION_KEY: InjectionKey<SymbolRenameSession> =
  Symbol('symbol-rename-session')

export interface FileTreeItem {
  name: string
  path: string
  isDirectory: boolean
  children?: FileTreeItem[]
}

/**
 * Names alongside `path` in the tree, excluding the node itself — the sibling
 * set a create or rename must not collide with. Walks the loaded tree rather
 * than hitting the filesystem so validation can run per keystroke.
 */
export function siblingNames(roots: FileTreeItem[], path: string): string[] {
  const search = (nodes: FileTreeItem[]): string[] | null => {
    if (nodes.some((node) => node.path === path)) {
      return nodes.filter((node) => node.path !== path).map((node) => node.name)
    }
    for (const node of nodes) {
      if (node.children) {
        const found = search(node.children)
        if (found) return found
      }
    }
    return null
  }
  return search(roots) ?? []
}

/**
 * Names the filesystem will not take, or that collide with a sibling. Checked
 * before anything is written — a create or rename never overwrites, and the
 * case-only clash matters because macOS/Windows resolve `Board` and `board`
 * onto one file while Linux does not.
 */
export type NameError = 'empty' | 'separator' | 'reserved' | 'dots' | 'exists'

const RESERVED_WINDOWS_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)
])

export function validateFileName(
  name: string,
  siblings: string[],
  currentName?: string
): NameError | null {
  const trimmed = name.trim()
  if (trimmed.length === 0) return 'empty'
  if (/[\\/]/.test(trimmed)) return 'separator'
  if (trimmed.startsWith('.') && trimmed.length === 1) return 'dots'
  if (trimmed.endsWith('.') || trimmed !== name) return 'dots'

  const stem = trimmed.split('.')[0].toLowerCase()
  if (RESERVED_WINDOWS_NAMES.has(stem)) return 'reserved'

  const lower = trimmed.toLowerCase()
  // Renaming a file to a different case of its own name is legal.
  if (currentName !== undefined && lower === currentName.toLowerCase()) return null
  if (siblings.some((sibling) => sibling.toLowerCase() === lower)) return 'exists'

  return null
}
