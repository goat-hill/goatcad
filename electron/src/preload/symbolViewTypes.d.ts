/**
 * What the symbol editor draws of the parts a placed instance will not show —
 * `(hide yes)` pins and fields.
 *
 * VIEW preferences, never written to the library file: hiding a pin from the
 * editor changes nothing about the symbol, only whether the canvas is currently
 * showing it. They live in the main-process config store rather than
 * `localStorage` (RULES.md §8) because every window shares one set, and this
 * file lives in preload because that is the one directory both tsconfigs can
 * see (§9).
 *
 * Both default ON. A symbol editor that starts by omitting part of the symbol
 * would let you draw a pin on top of a hidden one without ever seeing it; the
 * switches exist to clear the canvas deliberately, and each rail chip stays
 * unlit while its switch is off so the state is never a surprise.
 *
 * The renderer-side store is `renderer/src/lib/symbolView.ts`; the scene that
 * consumes them is `renderer/src/lib/engine/SchematicScene.ts`.
 */

export interface SymbolViewState {
  /** Draw `(hide yes)` pins, in the hidden gray. */
  showHiddenPins: boolean
  /** Draw `(hide yes)` fields, in the hidden gray. */
  showHiddenFields: boolean
}
