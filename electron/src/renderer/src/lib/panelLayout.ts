/**
 * How the IDE's chrome is sized — the one store behind every draggable panel
 * edge and every collapsed section.
 *
 * Modeled on `selectionFilter.ts`, and for the same reasons: the state is a view
 * preference every window agrees on, so it lives in the main-process config
 * store rather than `localStorage` (RULES.md §8), reads fall back to defaults
 * until the first load lands, and a missing bridge degrades to an in-memory copy
 * rather than throwing. The persisted shape and the "why one store" argument are
 * in `src/preload/panelLayoutTypes.d.ts`.
 *
 * **The bug this fixes is not the one people report.** Panel sizes were said to
 * be "lost on restart"; they were lost far more often than that. `EditorArea`
 * keys each editor on the active tab path with one instance mounted at a time,
 * so switching tabs DESTROYS the editor — and with it every `ref()` holding a
 * right-bar width or a `CollapsiblePanel` height. Anything that survives a tab
 * switch has to live outside the component, which is what this is.
 */

import { computed, reactive, type ComputedRef } from 'vue'
import type {
  PanelLayoutEditor,
  PanelLayoutState,
  PanelSectionState
} from '../../../preload/panelLayoutTypes'
import type { TabFileType } from './tabFileType'

export type { PanelLayoutEditor, PanelSectionState }

/**
 * Bounds every panel size is held to.
 *
 * One pair per axis rather than per call site: the three right bars had already
 * drifted (280 px in one editor, 300 in two others, a fourth not resizable at
 * all), and a shared constant is what stops that happening again. Applied on
 * WRITE, so a hand-edited config is corrected the first time it is dragged
 * rather than being silently clamped on read — `normalizePanelLayout` drops an
 * insane stored value instead, and the component default takes over.
 */
export const PANEL_WIDTH_MIN = 220
export const PANEL_WIDTH_MAX = 600
export const PANEL_SECTION_MIN = 60

/** Default right-bar width. */
export const DEFAULT_PANEL_WIDTH = 300

const clamp = (value: number, min: number, max: number): number =>
  Math.round(Math.max(min, Math.min(max, value)))

// ---------------------------------------------------------------------------
// Shared store
// ---------------------------------------------------------------------------

const store = reactive<PanelLayoutState>({})

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: PanelLayoutState | undefined): void => {
  for (const key of Object.keys(store) as Array<keyof PanelLayoutState>) delete store[key]
  Object.assign(store, next ?? {})
}

/**
 * Load the layout once per window and keep it in step with the other windows.
 *
 * Safe to call repeatedly — every panel mount does — and safe to call with no
 * `window.api`, which is how the unit tests see it.
 */
export function loadPanelLayout(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.panelLayout))
    // A config that cannot be read must not leave the IDE unusable: the
    // defaults below are all sane sizes.
    .catch(() => undefined)
  bridge.onConfigChanged((config) => adopt(config.panelLayout))
  return loading
}

/**
 * Persist the store.
 *
 * Called on drag END rather than per mousemove — one config write and one
 * cross-window broadcast per drag, not one per pixel. The local store is
 * already updated, so the drag itself stays at 60fps regardless.
 */
const persist = (): void => {
  // Spread: the store is a reactive proxy, and what crosses the IPC bridge has
  // to be a plain structured-cloneable object.
  void api()?.updateConfig({ panelLayout: JSON.parse(JSON.stringify(store)) })
}

// ---------------------------------------------------------------------------
// Editor right bars
// ---------------------------------------------------------------------------

/**
 * The right bar's width: one for every tab and every window, whichever editor
 * fills the bar. Per editor, focusing the other pane of a split between a
 * schematic and its board resized both panes, and both canvases, on every
 * click.
 */
export function panelWidth(): ComputedRef<number> {
  void loadPanelLayout()
  return computed(() => Math.round(store.railWidth ?? DEFAULT_PANEL_WIDTH))
}

/** The tab kinds that put panels in the rail. */
const RAIL_TABS: ReadonlySet<TabFileType> = new Set([
  'schematic',
  'pcb',
  'library-symbol',
  'library-footprint',
  'gerber'
])

/**
 * How wide the shared context rail will be once this tab's editor has filled it,
 * and 0 for a tab that puts nothing there.
 *
 * The rail's width IS its content's, and an editor teleports nothing until it has
 * read its file and parsed it — most of a board's open. `EditorArea` holds this
 * as a floor across that gap: without it, opening a design beside another one
 * collapses the rail and springs it back, resizing both panes and re-rendering
 * both canvases for the length of the load.
 */
export function contextRailWidth(type: TabFileType): number {
  if (!RAIL_TABS.has(type)) return 0
  void loadPanelLayout()
  return Math.round(store.railWidth ?? DEFAULT_PANEL_WIDTH)
}

/** Set the right bar's width. `commit` writes it through to the config store. */
export function setPanelWidth(width: number, commit = false): void {
  store.railWidth = Math.round(clamp(width, PANEL_WIDTH_MIN, PANEL_WIDTH_MAX))
  if (commit) persist()
}

// ---------------------------------------------------------------------------
// Collapsible sections
// ---------------------------------------------------------------------------

/** One section's stored state; `{}` for an id nothing has touched. */
export function sectionState(id: string): ComputedRef<PanelSectionState> {
  void loadPanelLayout()
  return computed(() => store.sections?.[id] ?? {})
}

const patchSection = (id: string, patch: PanelSectionState, commit: boolean): void => {
  if (!store.sections) store.sections = {}
  store.sections[id] = { ...store.sections[id], ...patch }
  if (commit) persist()
}

export function setSectionHeight(id: string, height: number, commit = false): void {
  patchSection(id, { height: Math.round(Math.max(PANEL_SECTION_MIN, height)) }, commit)
}

/** Collapsing is a click rather than a drag, so it always commits. */
export function setSectionCollapsed(id: string, collapsed: boolean): void {
  patchSection(id, { collapsed }, true)
}

// ---------------------------------------------------------------------------
// Pinnable panels
// ---------------------------------------------------------------------------

/**
 * A panel that lives in one of two places: a pill in the viewport's
 * bottom-right corner that opens it as a popover, or pinned into the right
 * bar, where its pill is gone. Properties is always in the bar and is not one.
 */
export type PinnablePanel = 'layers' | 'filter' | 'grid' | 'health'

/** The bar's order below Properties, whatever order they were pinned in. */
export const PINNABLE_PANELS: readonly PinnablePanel[] = ['layers', 'filter', 'grid', 'health']

/** Layers started in the bar, so it stays there until someone unpins it. */
const PINNED_BY_DEFAULT: ReadonlySet<PinnablePanel> = new Set(['layers'])

/**
 * The section id a pinnable panel keeps its pin, height and fold under. Layers'
 * is the `pcb.layers` / `footprint.layers` it has always had, so a stored
 * height carries over.
 */
export const pinnedPanelId = (editor: PanelLayoutEditor, panel: PinnablePanel): string =>
  `${editor}.${panel}`

export function panelPinned(editor: PanelLayoutEditor, panel: PinnablePanel): ComputedRef<boolean> {
  const state = sectionState(pinnedPanelId(editor, panel))
  return computed(() => state.value.pinned ?? PINNED_BY_DEFAULT.has(panel))
}

/** Pinning is a click, so it always commits. */
export function setPanelPinned(
  editor: PanelLayoutEditor,
  panel: PinnablePanel,
  pinned: boolean
): void {
  patchSection(pinnedPanelId(editor, panel), { pinned }, true)
}

// ---------------------------------------------------------------------------
// The left bar
// ---------------------------------------------------------------------------

/**
 * The sidebar's two sizes. They keep named accessors rather than joining
 * `sections` because neither is a `CollapsiblePanel`: the sidebar predates that
 * component and stacks its own accordions, so an id here would imply a
 * uniformity that is not there.
 */
export const DEFAULT_SIDEBAR_WIDTH = 260
export const DEFAULT_EXPLORER_HEIGHT = 250

export function sidebarWidth(): ComputedRef<number> {
  void loadPanelLayout()
  return computed(() => Math.round(store.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH))
}

export function setSidebarWidth(width: number, commit = false): void {
  store.sidebarWidth = Math.round(clamp(width, 180, 500))
  if (commit) persist()
}

export function explorerHeight(): ComputedRef<number> {
  void loadPanelLayout()
  return computed(() => store.explorerHeight ?? DEFAULT_EXPLORER_HEIGHT)
}

export function setExplorerHeight(height: number, commit = false): void {
  store.explorerHeight = Math.round(Math.max(50, height))
  if (commit) persist()
}

/** Test seam: drop everything, as a fresh config would. */
export function resetPanelLayoutForTest(): void {
  adopt({})
  loading = null
}
