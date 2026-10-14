/**
 * How the IDE's chrome is sized — the persisted shape of every draggable panel
 * edge and every collapsed section, shared across the process boundary.
 *
 * **Why this exists as one thing.** The app had four different answers to "where
 * does a panel size live": the sidebar's in `WindowSession`, the selection
 * filter's and the 3D view's in the config store, the grid's in `localStorage`
 * (which RULES.md §8 forbids), and every editor right-bar width and every
 * `CollapsiblePanel` height in a plain `ref()` — that is, nowhere. The last
 * group was the one people felt: `EditorArea` keys each editor on the tab path,
 * so switching tabs **destroys** the editor and its refs with it. A width was
 * not lost on restart; it was lost on the next tab click.
 *
 * So: one store, one mechanism, in the main-process config (RULES.md §8) so
 * every window agrees. `renderer/src/lib/panelLayout.ts` holds the reactive
 * side; this file lives in preload because it is the one directory both
 * tsconfigs can see (§9).
 *
 * **Global rather than per-window, deliberately.** A panel size is a
 * *preference* — how you like the IDE laid out — not *window state* like which
 * tabs are open or where the window sits. Two windows showing different
 * Layers-panel heights is a bug report, not a feature. `WindowSession` keeps
 * what is genuinely per-window.
 */

/** The four editors that own a right bar. */
export type PanelLayoutEditor = 'pcb' | 'schematic' | 'symbol' | 'footprint'

/**
 * One collapsible section's state, keyed by the stable id its host passes
 * (`symbol.pins`, `pcb.layers`, …).
 *
 * Both fields are optional so an id that has never been touched stores nothing
 * and falls back to the component's own defaults — which is what lets a panel
 * change its default height in a later release without every existing config
 * pinning the old one.
 */
export interface PanelSectionState {
  /** Height in px. Absent means "use the host's `initialHeight`". */
  height?: number
  /** Absent means "use the host's `defaultCollapsed`". */
  collapsed?: boolean
  /**
   * A panel that can live in the viewport's corner as a pill or in the right
   * bar: true in the bar. Absent means the panel's own default
   * (`panelPinned`, renderer `lib/panelLayout.ts`).
   */
  pinned?: boolean
}

export interface PanelLayoutState {
  /** Left activity-bar drawer width, in px. */
  sidebarWidth?: number
  /** File Explorer section height, in px; the Project section takes the rest. */
  explorerHeight?: number
  /**
   * The right bar's width, in px — one for every tab, so moving between tabs,
   * or focus between split panes, never resizes the panes. (Configs from before
   * kept one per editor as `editorPanelWidth`; `normalizePanelLayout` reads the
   * first of those in its place.)
   */
  railWidth?: number
  /** Every `CollapsiblePanel` that was given an `id`. */
  sections?: Record<string, PanelSectionState>
}
