/**
 * Tab identity helpers.
 *
 * Editor tabs are keyed by path. Alongside real files, the editor opens virtual
 * tabs whose path is a scheme URI with no filesystem backing — design copies
 * (`design-copy://`), the `goatcad://terminal/<id>` shells, and the
 * `goatcad://welcome` page. Virtual tabs must never be handed to `fs:read-file`.
 */

import type { TerminalKind } from '../../../preload/terminalTypes'
import type { GitDiffSide } from '../../../preload/gitTypes'
import { parseDesignCopyPath } from './designCopy'

export interface Tab {
  name: string
  path: string
  /**
   * VS Code preview semantics: a tab opened with a single click renders its
   * title in italics and is replaced by the next previewed file. Pinning
   * (double-click, or editing the file) clears the flag. Sessions persist
   * only name/path, so restored tabs always come back pinned.
   */
  preview?: boolean
  /**
   * For a `.kicad_sym` tab, the symbol currently being edited — shown as the
   * tab's title in place of the filename (the editor's working unit is one
   * symbol). Kept off `name`, which still carries the filename that drives the
   * tab icon and file-type detection. Not persisted; the editor re-reports it.
   */
  symbol?: string
}

export const WELCOME_TAB_PATH = 'goatcad://welcome'

export const welcomeTab = (): Tab => ({ name: 'Welcome', path: WELCOME_TAB_PATH })

export const isWelcomeTab = (path: string | null): boolean => path === WELCOME_TAB_PATH

/**
 * Settings editor (`goatcad://settings`) — app preferences as a full tab rather
 * than a sidebar drawer, VS Code style. A path setting needs more width than a
 * ~250px pane affords, and it's the surface every future preference lands on.
 * Only one is ever open; opening it again focuses the existing tab.
 */
export const SETTINGS_TAB_PATH = 'goatcad://settings'

export const settingsTab = (): Tab => ({ name: 'Settings', path: SETTINGS_TAB_PATH })

export const isSettingsTab = (path: string | null): boolean => path === SETTINGS_TAB_PATH

/**
 * Part Search (`goatcad://parts`) — distributor catalog search as a full tab.
 *
 * A tab rather than a sidebar panel because a result row is a table row: photo,
 * MPN, description, package, lifecycle, and one price/stock line per distributor
 * that stocks it. A ~250px drawer cannot hold that.
 * Same single-instance rule as Settings — the activity-bar icon focuses
 * the open tab rather than opening a second.
 */
export const PARTS_TAB_PATH = 'goatcad://parts'

export const partsTab = (): Tab => ({ name: 'Part Search', path: PARTS_TAB_PATH })

export const isPartsTab = (path: string | null): boolean => path === PARTS_TAB_PATH

/**
 * Manufacture mode (`goatcad://manufacture/<encoded .kicad_pcb path>`) — the
 * fab-package surface for one board. Per-board and reachable only from that
 * board's editor (the properties panel's Manufacture button when nothing is
 * selected), so the tab is titled by the PCB's filename and there is no way in
 * without a board. Opening it again for the same board focuses the existing tab.
 */
export const MANUFACTURE_TAB_PREFIX = 'goatcad://manufacture/'

export const manufactureTabPath = (boardPath: string): string =>
  `${MANUFACTURE_TAB_PREFIX}${encodeURIComponent(boardPath)}`

export const isManufactureTab = (path: string | null): boolean =>
  !!path && path.startsWith(MANUFACTURE_TAB_PREFIX)

export const manufactureBoardPath = (path: string): string =>
  decodeURIComponent(path.slice(MANUFACTURE_TAB_PREFIX.length))

/** Basename of the board a manufacture tab targets — used as the tab's title. */
export const manufactureBoardName = (path: string): string => {
  const boardPath = manufactureBoardPath(path)
  return boardPath.split(/[\\/]/).pop() || boardPath
}

export const manufactureTab = (boardPath: string): Tab => ({
  name: boardPath.split(/[\\/]/).pop() || boardPath,
  path: manufactureTabPath(boardPath)
})

/**
 * Schematic Setup (`goatcad://schematic-setup/<encoded root .kicad_sch path>`) —
 * a design's project settings for its schematic: today the ERC's rule
 * severities. Per design and reachable from any of its sheets (the properties
 * panel), so, like the Components tab, it is keyed and titled by the root sheet.
 */
export const SCHEMATIC_SETUP_TAB_PREFIX = 'goatcad://schematic-setup/'

export const schematicSetupTabPath = (rootSheetPath: string): string =>
  `${SCHEMATIC_SETUP_TAB_PREFIX}${encodeURIComponent(rootSheetPath)}`

export const isSchematicSetupTab = (path: string | null): boolean =>
  !!path && path.startsWith(SCHEMATIC_SETUP_TAB_PREFIX)

export const schematicSetupRootPath = (path: string): string =>
  decodeURIComponent(path.slice(SCHEMATIC_SETUP_TAB_PREFIX.length))

export const schematicSetupTab = (rootSheetPath: string): Tab => ({
  name: rootSheetPath.split(/[\\/]/).pop() || rootSheetPath,
  path: schematicSetupTabPath(rootSheetPath)
})

/**
 * Board Setup (`goatcad://board-setup/<encoded .kicad_pcb path>`) — a board's
 * stackup, rules and checks, the board's twin of Schematic Setup. Unlike that
 * page it edits the board itself (the stackup lives in the `.kicad_pcb`), so it
 * is a second view on the board's own document and session, not a document of
 * its own: `tabDocumentPath` names the file behind it, and the tab only lives
 * beside its board's tab (App.vue pairs them).
 */
export const BOARD_SETUP_TAB_PREFIX = 'goatcad://board-setup/'

export const boardSetupTabPath = (boardPath: string): string =>
  `${BOARD_SETUP_TAB_PREFIX}${encodeURIComponent(boardPath)}`

export const isBoardSetupTab = (path: string | null): boolean =>
  !!path && path.startsWith(BOARD_SETUP_TAB_PREFIX)

export const boardSetupBoardPath = (path: string): string =>
  decodeURIComponent(path.slice(BOARD_SETUP_TAB_PREFIX.length))

export const boardSetupTab = (boardPath: string): Tab => ({
  name: boardPath.split(/[\\/]/).pop() || boardPath,
  path: boardSetupTabPath(boardPath)
})

/**
 * The document a tab shows: its own path, except for a view on another tab's
 * file (Board Setup), which reads, dirties and saves that file.
 */
export const tabDocumentPath = (path: string): string =>
  isBoardSetupTab(path) ? boardSetupBoardPath(path) : path

/**
 * The Components table (`goatcad://components/<encoded root .kicad_sch path>`) —
 * every part of one design, across all of its sheets, as an editable table. Per
 * design and reachable only from one of its sheets (the properties panel's
 * Components button when nothing is selected), so the tab is titled by the ROOT
 * schematic's filename whichever sheet opened it. Opening it again for the same
 * design focuses the existing tab. Not to be confused with a `component://` tab,
 * which views one part.
 */
export const COMPONENTS_TAB_PREFIX = 'goatcad://components/'

export const componentsTabPath = (rootSheetPath: string): string =>
  `${COMPONENTS_TAB_PREFIX}${encodeURIComponent(rootSheetPath)}`

export const isComponentsTableTab = (path: string | null): boolean =>
  !!path && path.startsWith(COMPONENTS_TAB_PREFIX)

export const componentsRootPath = (path: string): string =>
  decodeURIComponent(path.slice(COMPONENTS_TAB_PREFIX.length))

export const componentsTab = (rootSheetPath: string): Tab => ({
  name: rootSheetPath.split(/[\\/]/).pop() || rootSheetPath,
  path: componentsTabPath(rootSheetPath)
})

/**
 * A child tab belongs to the tab of one design file, its parent. A view edits
 * the parent's own document: Board Setup, Components and a design copy share
 * its undo, unsaved mark and save. Schematic Setup and Manufacture are not
 * views: one writes the project file, the other reads the saved board. Every
 * child sits after its parent in the strip, closes with it, and brings it along
 * when it opens alone (App.vue).
 */
export interface TabParent {
  path: string
  view: boolean
}

export const tabParent = (path: string): TabParent | null => {
  if (isBoardSetupTab(path)) return { path: boardSetupBoardPath(path), view: true }
  if (isComponentsTableTab(path)) return { path: componentsRootPath(path), view: true }
  const copy = parseDesignCopyPath(path)
  if (copy) return { path: copy.parent, view: true }
  if (isManufactureTab(path)) return { path: manufactureBoardPath(path), view: false }
  if (isSchematicSetupTab(path)) return { path: schematicSetupRootPath(path), view: false }
  return null
}

/**
 * The tabs with each child moved after its parent and the parent's earlier
 * children, every other tab keeping its place. A child whose parent is not
 * open stays where it is.
 */
export const nestChildTabs = <T extends { path: string }>(tabs: readonly T[]): T[] => {
  const open = new Set(tabs.map((tab) => tab.path))
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const tab of tabs) {
    const parent = tabParent(tab.path)?.path
    if (parent === undefined || !open.has(parent)) roots.push(tab)
    else children.set(parent, [...(children.get(parent) ?? []), tab])
  }
  return roots.flatMap((tab) => [tab, ...(children.get(tab.path) ?? [])])
}

/**
 * Diff tabs (`goatcad://diff/<side>/<encoded file path>[/<encoded symbol>]`) —
 * one changed file's diff, or one symbol's out of a changed `.kicad_sym`,
 * opened from the Git pane. The side (`working` | `staged`) rides in the path
 * because the same file can be in both sections at once, and those are two
 * different diffs. Everything else the view needs (untracked, a rename's
 * origin) it reads from the live git status, so a restored or moved tab stays
 * correct.
 */
export const DIFF_TAB_PREFIX = 'goatcad://diff/'

export const diffTabPath = (side: GitDiffSide, filePath: string, symbol?: string): string =>
  `${DIFF_TAB_PREFIX}${side}/${encodeURIComponent(filePath)}` +
  (symbol === undefined ? '' : `/${encodeURIComponent(symbol)}`)

export const isDiffTab = (path: string | null): boolean =>
  !!path && path.startsWith(DIFF_TAB_PREFIX)

export const parseDiffTab = (
  path: string
): { side: GitDiffSide; filePath: string; symbol?: string } | null => {
  if (!isDiffTab(path)) return null
  const [side, file, symbol] = path.slice(DIFF_TAB_PREFIX.length).split('/')
  if ((side !== 'working' && side !== 'staged') || !file) return null
  return {
    side,
    filePath: decodeURIComponent(file),
    ...(symbol !== undefined ? { symbol: decodeURIComponent(symbol) } : {})
  }
}

export const diffTab = (side: GitDiffSide, filePath: string, symbol?: string): Tab => ({
  name: filePath.split(/[\\/]/).pop() || filePath,
  path: diffTabPath(side, filePath, symbol)
})

/**
 * Terminal tabs (`goatcad://terminal/<kind>/<session id>`) — an interactive shell
 * as a full tab, for the CLI work a board still involves: an agent (Claude Code,
 * Codex), a build script, a git command. VS Code puts this in a bottom panel; a
 * tab is the better fit here, because the thing people run in it holds their
 * attention for minutes at a time rather than seconds, and a panel that wants
 * half the window is not a panel.
 *
 * The id is the main-process session (`terminalSessions.ts`), which is what lets
 * a terminal tab move windows and keep its shell. The **kind rides in the path**
 * rather than on the `Tab` object because only the path survives a session
 * record and a cross-window transfer, and the kind is what decides whether a tab
 * is single-instance:
 *
 *   `shell`  — not single-instance. The activity-bar button opens another one
 *              every click, like a terminal emulator's new-tab button; several
 *              at once (a build in one, a log tail in another) is normal use.
 *   `claude` — one per window, focused rather than duplicated. An agent session
 *   `codex`     is a *conversation*, and a second tab of it is not a second
 *              conversation, it is a way to lose track of the first.
 */
export const TERMINAL_TAB_PREFIX = 'goatcad://terminal/'

export const terminalTabPath = (kind: TerminalKind, sessionId: string): string =>
  `${TERMINAL_TAB_PREFIX}${kind}/${encodeURIComponent(sessionId)}`

export const isTerminalTab = (path: string | null): boolean =>
  !!path && path.startsWith(TERMINAL_TAB_PREFIX)

/** Kind of a terminal tab; anything unrecognized reads as a plain shell. */
export const terminalTabKind = (path: string): TerminalKind => {
  const kind = path.slice(TERMINAL_TAB_PREFIX.length).split('/')[0]
  return kind === 'claude' || kind === 'codex' ? kind : 'shell'
}

export const terminalSessionId = (path: string): string =>
  decodeURIComponent(path.slice(TERMINAL_TAB_PREFIX.length).split('/').slice(1).join('/'))

/** Agent tabs are one per window; a plain shell is not. */
export const isSingleTerminalKind = (kind: TerminalKind): boolean => kind !== 'shell'

/**
 * `name` is only the fallback title — the live one comes from what the session
 * is running (`terminalTitle.ts`), which the tab strip resolves per render.
 */
export const terminalTab = (kind: TerminalKind, sessionId: string, name: string): Tab => ({
  name,
  path: terminalTabPath(kind, sessionId)
})

/**
 * Component view tabs (`component://<kind>/<seg>/…`) — a virtual, read-only view
 * opened from the Libraries panel that shows a selected symbol/footprint/3D model
 * alongside its associations (the three-pane "Component" view). Not a file.
 */
export type ComponentKind = 'symbol' | 'footprint' | 'model'

export interface ComponentRef {
  kind: ComponentKind
  segments: string[]
}

export const isComponentTab = (path: string | null): boolean =>
  !!path && path.startsWith('component://')

export const componentTabPath = (kind: ComponentKind, ...segments: string[]): string =>
  `component://${kind}/${segments.map(encodeURIComponent).join('/')}`

/**
 * Read-only library file tab (`readonly-lib://<encoded absolute path>`). Opening a
 * footprint from a system/global library through this scheme (rather than its raw
 * path, which the footprint editor treats as editable) loads it read-only, so a
 * library part can be inspected in the full editor without risking a write back to
 * the shared library. The whole path is percent-encoded into one segment, so
 * slashes never split it. This is the seam the "save where?" chooser will hook
 * into later. Backed by `fs:read-file` on the decoded path — no network.
 */
export const READONLY_LIB_PREFIX = 'readonly-lib://'

export const readonlyLibTabPath = (absPath: string): string =>
  `${READONLY_LIB_PREFIX}${encodeURIComponent(absPath)}`

export const isReadonlyLibTab = (path: string | null): boolean =>
  !!path && path.startsWith(READONLY_LIB_PREFIX)

export const readonlyLibPath = (path: string): string =>
  decodeURIComponent(path.slice(READONLY_LIB_PREFIX.length))

export const parseComponentTab = (path: string): ComponentRef | null => {
  if (!isComponentTab(path)) return null
  const rest = path.slice('component://'.length).split('/')
  const kind = rest[0]
  if (kind !== 'symbol' && kind !== 'footprint' && kind !== 'model') return null
  return { kind, segments: rest.slice(1).map((s) => decodeURIComponent(s)) }
}
