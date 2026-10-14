/**
 * Layer visibility presets the user saved, by name.
 *
 * App-wide, not per-board, and not written to any KiCad file — a named view is
 * the user's working habit ("just the front", "copper and outline"), so it
 * should follow them from board to board rather than be re-made on each one.
 * KiCad splits it the same way: its own presets live in the app-level
 * `pcbnew.json`, and only the board's *current* visibility is project state.
 *
 * A preset names the layers it was saved from and nothing else, so applying one
 * to a document with a different layer table sets what both have in common and
 * leaves the rest alone. The panel only offers a preset whose layers this
 * document actually has, which is what keeps a board's presets out of the
 * footprint editor's list and a Gerber set's out of both.
 *
 * The renderer-side store is `renderer/src/lib/board/layerPresetStore.ts`.
 */

export interface SavedLayerPreset {
  /** What the user called it, and its identity: saving the same name replaces it. */
  name: string
  /** Layer name → drawn, exactly as it stood when the preset was saved. */
  visibility: Record<string, boolean>
}
