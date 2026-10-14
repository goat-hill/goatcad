/**
 * The per-editor grid's persisted shape, shared across the process boundary.
 *
 * The grid is a VIEW preference — never written to the design file, matching
 * KiCad — so it lives in the main-process config store rather than
 * `localStorage` (RULES.md §8) and every window shares one. This file lives in
 * preload because that is the one directory both tsconfigs can see (§9).
 *
 * **Duplicated by necessity, so cross-referenced** (RULES.md §7): the fields
 * below must match `GridSettings` in
 * `renderer/src/lib/engine/ViewportEngine.ts`, which is the renderer-side type
 * the viewports actually consume. The engine type cannot be imported here — it
 * pulls in Three.js — and preload types cannot be imported by the engine, so
 * the two are kept in step by hand and by `gridPreferences.ts`, which is the
 * only place they meet.
 */

/** Editors that keep their own grid. Matches `GridEditorKind`. */
export type GridEditorKind = 'symbol' | 'footprint' | 'pcb' | 'schematic'

/** Mirrors `GridSettings` — see the note above before changing either. */
export interface GridSettingsState {
  spacing: number
  unit: 'mm' | 'mil' | 'in'
  visible: boolean
  snap: boolean
}

export type GridPreferencesConfig = Partial<Record<GridEditorKind, GridSettingsState>>
