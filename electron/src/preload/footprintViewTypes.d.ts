/**
 * What the footprint editor draws — its layer visibility, the layer being
 * edited, and how the other layers render.
 *
 * VIEW preferences, never written to the `.kicad_mod`: hiding the courtyard
 * changes nothing about the footprint. They live in the main-process config
 * store rather than `localStorage` (RULES.md §8) because every window shares
 * one set, and this file lives in preload because that is the one directory
 * both tsconfigs can see (§9).
 *
 * App-wide rather than per-document, unlike the board's equivalent
 * (`renderer/src/lib/board/boardViewStore.ts`), and for the reason KiCad splits
 * them the same way: a board carries its own layer table, so its visibility
 * belongs to that board's project, while every footprint has the same twelve
 * layers and there is no project to hold them — KiCad keeps these in its
 * app-level `fpedit.json`.
 *
 * The renderer-side store is `renderer/src/lib/footprintView.ts`.
 */

/**
 * The same three states as `NonActiveLayerDisplay` in
 * `renderer/src/lib/board/layerPresets.ts`, which the editors share. Repeated
 * rather than imported: this is the persisted shape, and preload cannot see the
 * renderer (RULES.md §5 cross-reference rule, §9 for why the type lives here).
 */
export type FootprintNonActiveDisplay = 'show' | 'dim' | 'hide'

export interface FootprintViewState {
  /** Layer name → drawn. Keyed by the fixed footprint layer set. */
  layerVisibility: Record<string, boolean>
  /** The layer new geometry lands on. */
  activeLayer: string
  /** How layers other than the active one render: normally, faded, or not at all. */
  nonActiveDisplay: FootprintNonActiveDisplay
  /**
   * Outline-only drawing, per item class — KiCad's footprint-editor left
   * toolbar toggles. Pads outline their copper; graphics draw strokes as
   * outlines and leave fills empty; text outlines its strokes.
   */
  sketchPads: boolean
  sketchGraphics: boolean
  sketchText: boolean
}
