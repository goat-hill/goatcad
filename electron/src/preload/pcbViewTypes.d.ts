/**
 * What the 2D board view is showing, as persisted state.
 *
 * VIEW preferences — how copper is drawn, never what the board contains — so
 * they are never written to the board file. They live in the main-process
 * config store rather than `localStorage` (RULES.md §8) because every window
 * shares one set, and this file lives in preload because that is the one
 * directory both tsconfigs can see (§9).
 *
 * The renderer-side store is `renderer/src/lib/pcbView.ts`; the scene that
 * consumes them is `renderer/src/lib/engine/BoardScene.ts`. Deliberately not
 * here: the layer visibility table and active layer, which follow the board
 * being edited rather than the app and persist in the project's `.kicad_prl`.
 */

/**
 * When tracks and vias show their clearance outline, from KiCad's display option
 * of that name: the route and its via, those and a track drag, or every track
 * and via on the active layer at all times.
 */
export type TrackClearanceDisplay = 'never' | 'routing' | 'routingAndDragging' | 'always'

export interface PcbViewState {
  /** Draw computed zone fills; off shows outlines + hatch only (KiCad's toggle). */
  zoneFills: boolean
  /** Sketch (outline) mode per copper class — see through dense boards. */
  sketchTracks: boolean
  sketchVias: boolean
  sketchPads: boolean
  /** Draw airwires between unconnected same-net copper (the ratsnest). */
  ratsnest: boolean
  /** Tint the area inside a closed board outline, over the grid. */
  boardArea: boolean
  /**
   * KiCad's footprint-text switches: a footprint's Reference, its Value, and
   * its other fields and texts — drawn, and clickable, only while on.
   */
  fpReferences: boolean
  fpValues: boolean
  fpText: boolean
  /**
   * Outline each pad on the active layer at its own clearance — and a selected
   * pad on every visible copper layer — as KiCad's "Show pad clearance".
   */
  padClearance: boolean
  trackClearance: TrackClearanceDisplay
}
