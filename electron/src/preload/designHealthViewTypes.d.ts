/**
 * How every editor shows its checks' findings on the canvas, as persisted
 * state: one set for all four editors, behind the findings drawer's gear.
 *
 * A VIEW preference, never written to a design file. It lives in the
 * main-process config store (RULES.md §8) because every window shares it, and
 * in preload because both tsconfigs see this directory (§9). The renderer-side
 * store is `renderer/src/lib/designHealthView.ts`.
 */

export interface DesignHealthViewState {
  /** Draw a marker at each finding on the canvas (design-health-workstream.md). */
  showMarkers: boolean
  /** With markers shown, mark errors only, warnings unmarked; the list and pill keep both. */
  errorsOnly: boolean
}
