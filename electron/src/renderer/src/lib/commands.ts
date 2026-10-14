/** Command metadata shared by every menu surface; dispatch remains in App.vue. */
import type { LabelSegment, MenuNode } from './menu'
import type { HotkeyActionId } from './hotkeys'
import { tk, type MessageKey } from './messageKey'

/** Translator, injected so the builders stay pure and testable. */
export type Translate = (key: string) => string

export type CommandId =
  | 'new:schematic'
  | 'new:board'
  | 'new:symbol-library'
  | 'new:footprint-library'
  | 'new:symbol'
  | 'new:footprint'
  | 'library:add-symbol'
  | 'library:add-footprint'
  | 'file:open'
  | 'file:reveal'
  | 'file:copy-path'
  | 'file:rename'
  | 'file:delete'

/** The file or folder a surface is acting on, when it has one. */
export interface CommandTarget {
  name: string
  path: string
  isDirectory: boolean
}

/**
 * What a command is enabled against. Kept to what actually gates something: a
 * context field nobody reads is a field that silently rots.
 */
export interface CommandContext {
  /**
   * The window's active `.kicad_pro`, or null. "Project open" is §4.1's
   * enablement rule for every create — not "a folder is open", which is what the
   * app used to mean by it (projects.md).
   */
  projectPath: string | null
  /** The clicked row, the active library, whatever the surface is targeting. */
  target?: CommandTarget | null
}

export interface Command {
  id: CommandId
  /** Plain string, or segments when part of the label is a literal filename. */
  label: (t: Translate) => string | LabelSegment[]
  /** The accelerator to display; resolved by the surface, so it stays honest. */
  hotkey?: HotkeyActionId
  enabledWhen: (ctx: CommandContext) => boolean
  /** Why it is off right now — the item's tooltip (§4.2's `⊘`). */
  disabledReason: (t: Translate, ctx: CommandContext) => string
}

const hasExtension = (target: CommandTarget | null | undefined, extension: string): boolean =>
  !!target && target.name.toLowerCase().endsWith(extension)

const projectOpen = (ctx: CommandContext): boolean => ctx.projectPath !== null
const needsProject = (t: Translate): string => t('titleBar.menu.needsProject')

/** A create's label, plus the "needs a project" rule every one of them shares. */
const create = (
  id: CommandId,
  label: MessageKey | Command['label'],
  hotkey?: HotkeyActionId
): Command => ({
  id,
  label: typeof label === 'function' ? label : (t) => t(label),
  ...(hotkey ? { hotkey } : {}),
  enabledWhen: projectOpen,
  disabledReason: needsProject
})

/**
 * "Add symbol library `.kicad_sym`…" — the extension renders as code, which is
 * shorter and more precise than prose describing the file type, and it teaches
 * what the picker will ask for (BRAND.md "In-app UI copy").
 */
const withExtension =
  (verbKey: MessageKey, extensionKey: MessageKey) =>
  (t: Translate): LabelSegment[] => [
    { text: `${t(verbKey)} ` },
    { text: t(extensionKey), code: true },
    { text: '…' }
  ]

export const COMMANDS: readonly Command[] = [
  create('new:schematic', tk('sidebar.fileMenu.newSchematic'), 'app.newSchematic'),
  create('new:board', tk('sidebar.fileMenu.newBoard')),
  create('new:symbol-library', tk('sidebar.fileMenu.newSymbolLibrary')),
  create('new:footprint-library', tk('sidebar.fileMenu.newFootprintLibrary')),
  create(
    'library:add-symbol',
    withExtension(tk('libraryBrowser.add.addSymbolLibrary'), tk('libraryBrowser.add.symbolExt'))
  ),
  create(
    'library:add-footprint',
    withExtension(
      tk('libraryBrowser.add.addFootprintLibrary'),
      tk('libraryBrowser.add.footprintExt')
    )
  ),
  // Container creates: these need a *target library* in hand, not a target
  // folder, which is exactly why §4.1 keeps them separate from the file creates.
  {
    id: 'new:symbol',
    label: (t) => t('sidebar.fileMenu.newSymbol'),
    enabledWhen: (ctx) => hasExtension(ctx.target, '.kicad_sym'),
    disabledReason: (t) => t('sidebar.fileMenu.needsSymbolLibrary')
  },
  {
    id: 'new:footprint',
    label: (t) => t('sidebar.fileMenu.newFootprint'),
    enabledWhen: (ctx) => !!ctx.target?.isDirectory && hasExtension(ctx.target, '.pretty'),
    disabledReason: (t) => t('sidebar.fileMenu.needsFootprintLibrary')
  },
  // Target commands. A directory has nothing to open, so Open is the one that
  // narrows further than "something is selected".
  {
    id: 'file:open',
    label: (t) => t('sidebar.fileMenu.open'),
    enabledWhen: (ctx) => !!ctx.target && !ctx.target.isDirectory,
    disabledReason: (t) => t('sidebar.fileMenu.needsFile')
  },
  {
    id: 'file:reveal',
    label: (t) => t('sidebar.fileMenu.reveal'),
    enabledWhen: (ctx) => !!ctx.target,
    disabledReason: (t) => t('sidebar.fileMenu.needsFile')
  },
  {
    id: 'file:copy-path',
    label: (t) => t('sidebar.fileMenu.copyPath'),
    enabledWhen: (ctx) => !!ctx.target,
    disabledReason: (t) => t('sidebar.fileMenu.needsFile')
  },
  {
    id: 'file:rename',
    label: (t) => t('sidebar.fileMenu.rename'),
    enabledWhen: (ctx) => !!ctx.target,
    disabledReason: (t) => t('sidebar.fileMenu.needsFile')
  },
  {
    id: 'file:delete',
    label: (t) => t('sidebar.fileMenu.delete'),
    enabledWhen: (ctx) => !!ctx.target,
    disabledReason: (t) => t('sidebar.fileMenu.needsFile')
  }
]

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]))

export const commandById = (id: CommandId): Command | undefined => BY_ID.get(id)

export interface MenuBuildOptions {
  /**
   * Resolve a command's accelerator for display. Injected rather than imported
   * so the builder stays pure — and so a surface with no room for shortcuts (a
   * group-header flyout) can simply omit them.
   */
  hotkeyLabel?: (id: HotkeyActionId) => string | undefined
  /**
   * Drop disabled commands instead of graying them. The File menu grays them for
   * discoverability (§4.2); a context menu built around one clicked row shows
   * only what that row can do.
   */
  omitDisabled?: boolean
}

/**
 * Render command ids as menu nodes. `null` in the list is a divider, so a
 * surface expresses its grouping inline rather than assembling two structures.
 */
export function buildCommandMenu(
  ids: readonly (CommandId | null)[],
  ctx: CommandContext,
  t: Translate,
  options: MenuBuildOptions = {}
): MenuNode[] {
  const nodes: MenuNode[] = []
  for (const id of ids) {
    if (id === null) {
      nodes.push({ divider: true })
      continue
    }
    const command = BY_ID.get(id)
    if (!command) continue
    const enabled = command.enabledWhen(ctx)
    if (!enabled && options.omitDisabled) continue
    const shortcut = command.hotkey ? options.hotkeyLabel?.(command.hotkey) : undefined
    nodes.push({
      id,
      label: command.label(t),
      ...(shortcut ? { shortcut } : {}),
      ...(enabled ? {} : { disabled: true, disabledReason: command.disabledReason(t, ctx) })
    })
  }
  // A divider that ended up first, last, or beside another divider separates
  // nothing — which is what happens as soon as `omitDisabled` empties a group.
  return trimDividers(nodes)
}

const isDividerNode = (node: MenuNode): boolean => 'divider' in node

export function trimDividers(nodes: MenuNode[]): MenuNode[] {
  const out: MenuNode[] = []
  for (const node of nodes) {
    if (isDividerNode(node) && (out.length === 0 || isDividerNode(out[out.length - 1]))) continue
    out.push(node)
  }
  while (out.length > 0 && isDividerNode(out[out.length - 1])) out.pop()
  return out
}

/**
 * The **file** creates — a new file in a folder. These are what `New ▸` means
 * everywhere: they need only a project, never a particular clicked row, so the
 * list is the same from the File menu, the explorer, and the header `＋`.
 *
 * `new:footprint-library` is deliberately absent. It is a create, but a
 * *directory* create whose name is fixed at registration (§9: the nickname is
 * the name, and nickname-rename is out for alpha), so it cannot use the
 * create-then-rename flow the others share — it needs the name up front, and the
 * only surface with that prompt is the Project view's library group. Listing it
 * here would put a row in three menus that two of them cannot carry out.
 */
export const NEW_FILE_IDS: readonly (CommandId | null)[] = [
  'new:schematic',
  'new:board',
  null,
  'new:symbol-library'
]

/**
 * The File menu's `New ▸`, which additionally lists the **container** creates.
 * They are grayed there — a menu with no clicked row has no target library — and
 * that is deliberate: File ▸ New is where a command is discovered, and §4.2 asks
 * for them to appear with a tooltip saying which target is missing. Surfaces
 * that act on a row omit them instead, and promote the one the row supports.
 */
export const NEW_SUBMENU_IDS: readonly (CommandId | null)[] = [
  ...NEW_FILE_IDS,
  null,
  'new:symbol',
  'new:footprint'
]
