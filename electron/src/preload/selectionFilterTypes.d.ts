/**
 * The selection filter's persisted shape, shared across the process boundary.
 *
 * The filter is a VIEW preference — which kinds of item a click or a rubber-band
 * sweep is allowed to land on — so it is never written to the design file. It
 * lives in the main-process config store rather than `localStorage` (RULES.md
 * §8) because every window shares one, and this file lives in preload because
 * that is the one directory both tsconfigs can see (§9).
 *
 * The rule it feeds is in `renderer/src/lib/selectionResolve.ts`; the store and
 * the composed predicate are in `renderer/src/lib/selectionFilter.ts`.
 */

/** Editors that keep their own filter — the keys of `SELECTABLE_KINDS`. */
export type SelectionFilterEditor = 'pcb' | 'schematic' | 'symbol' | 'footprint'

export interface SelectionFilterState {
  /**
   * Kinds the user has switched OFF.
   *
   * Stored as *exclusions* rather than as the allowed set on purpose: a kind
   * added to `SELECTABLE_KINDS` in a later release must default to selectable.
   * Persisting the allowed set would make every existing config silently
   * un-selectable for anything new, which is the failure mode that reads as
   * "the new feature doesn't work".
   */
  excludedKinds: string[]
  /**
   * Whether a click may land on an item the document marks `(locked yes)`.
   *
   * Defaults to `true`, matching KiCad and preserving today's behavior: if
   * locked items were unselectable by default there would be no way to select
   * one in order to unlock it.
   */
  allowLocked: boolean
}

export type SelectionFilterConfig = Partial<Record<SelectionFilterEditor, SelectionFilterState>>
