/**
 * What the schematic editor's canvas shows, as persisted state — the switches
 * behind its left view rail. The two hidden-item switches default
 * off, as KiCad's do: a placed symbol shows what its instance shows.
 *
 * VIEW preferences, never written to the schematic file. They live in the
 * main-process config store rather than `localStorage` (RULES.md §8) because
 * every window shares one set, and this file lives in preload because that is
 * the one directory both tsconfigs can see (§9). The grid's visibility is not
 * here: it belongs to the editor's grid settings (`gridTypes.d.ts`).
 *
 * The renderer-side store is `renderer/src/lib/schematicView.ts`; the viewport
 * that consumes it is `renderer/src/components/schematic/SchematicViewport2D.vue`.
 */

export interface SchematicViewState {
  /** Light the net under the pointer across the sheet (the hover highlight). */
  netHighlight: boolean
  /** Draw placed symbols' `(hide yes)` pins, dimmed, as KiCad's "Show hidden pins". */
  showHiddenPins: boolean
  /** Draw placed symbols' `(hide yes)` fields, dimmed, as KiCad's "Show hidden fields". */
  showHiddenFields: boolean
}
