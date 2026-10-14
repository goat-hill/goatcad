/**
 * The library chooser's recent picks, per kind, newest first
 * (docs/libraries-workstream.md §3). A preference every window shares, so
 * it lives in the main-process config store (RULES.md §8); the renderer store is
 * `renderer/src/lib/libraryRecents.ts`.
 */
export interface LibraryRecents {
  symbol: string[]
  power: string[]
  footprint: string[]
}
