/**
 * What the Update / Change sheet was last left with, per part kind and verb
 * (docs/libraries-workstream.md §5), as KiCad keeps its dialogs' ticks between uses. A
 * preference every window shares, so it lives in the main-process config store
 * (RULES.md §8); the renderer store is `renderer/src/lib/partUpdatePreferences.ts`.
 */
export type PartUpdateKind = 'symbol' | 'footprint'
export type PartUpdateVerb = 'update' | 'change'

export interface PartUpdateChoices {
  /** Each option's tick, by the option's key. */
  options: Record<string, boolean>
  /** Of the fields listed unticked to begin with (Reference, Value), those ticked. */
  fieldsOn: string[]
}

export type PartUpdatePreferences = Partial<
  Record<PartUpdateKind, Partial<Record<PartUpdateVerb, PartUpdateChoices>>>
>
