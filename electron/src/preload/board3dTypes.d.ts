/**
 * What the 3D board view is showing, as persisted state.
 *
 * These are VIEW preferences — which physical layers and which classes of part
 * are drawn — so they are never written to the board file. They live in the
 * main-process config store rather than `localStorage` (RULES.md §8) because
 * every window shares one set, and this file lives in preload because that is
 * the one directory both tsconfigs can see (§9).
 *
 * The renderer-side store is `renderer/src/lib/board3dView.ts`; the scene that
 * consumes them is `renderer/src/lib/engine/board3d/BoardScene3D.ts`.
 */

/**
 * How the 3D pane presents the board, beside what it draws: its own config
 * key, `board3dPresentation`, so the switches below stay what the scene and
 * the agent's `show` read. A picture exported from the pane carries all three.
 */
export interface Board3DPresentation {
  /** Orthographic keeps one scale; perspective is the lens. */
  projection: Board3DProjection
  /** A preset of the board rig (`engine/board3d/boardLighting.ts`). */
  lighting: Board3DLighting
  /** A scale on every light of the preset; 1 is the preset as tuned. */
  exposure: number
  /** Behind the board: the theme's ground, nothing (a checkerboard in the
   *  pane, alpha in a PNG), or flat white or black. */
  background: Board3DBackground
}
export type Board3DProjection = 'perspective' | 'orthographic'
export type Board3DLighting = 'studio' | 'soft' | 'flat' | 'dramatic'
export type Board3DBackground = 'theme' | 'transparent' | 'white' | 'black'

export interface Board3DViewState {
  /** The extruded substrate. Off leaves the copper and parts floating. */
  boardBody: boolean
  /** Tracks, zone fills, via annuli and pads. */
  copper: boolean
  /** Solder mask over the copper — off exposes bare metal on every track. */
  solderMask: boolean
  solderPaste: boolean
  silkscreen: boolean
  /** `Dwgs.User` / `Cmts.User` / the ECO layers, floating above the board. */
  drawings: boolean
  /** Drilled holes: cut through the substrate, with plated barrels. */
  holes: boolean
  /** Master switch for placed component models. */
  models: boolean
  modelsThroughHole: boolean
  modelsSmd: boolean
  modelsUnspecified: boolean
  /** Parts marked `(attr dnp)`. Off by default — they are not fitted. */
  modelsDnp: boolean
  /**
   * Footprints marked `(attr exclude_from_pos_files)` — mounting holes,
   * fiducials, logos. Off by default: nothing is placed there.
   */
  modelsNotInPosFiles: boolean
  /** A world-axis indicator at the board's near corner. */
  axes: boolean
  /** The dimension gauge around the board — `engine/extentGauge.ts`. */
  gauge: boolean
}
