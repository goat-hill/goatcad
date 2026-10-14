/**
 * The library chooser's recent picks, per kind — shared by every window through
 * the main-process config store (RULES.md §8), as `symbolView.ts` keeps its
 * switches. The persisted shape is `src/preload/libraryRecentTypes.d.ts`.
 */
import { reactive } from 'vue'
import type { LibraryRecents } from '../../../preload/libraryRecentTypes'
import { withRecent, type ChooserKind } from './libraryChooser'

const empty = (): LibraryRecents => ({ symbol: [], power: [], footprint: [] })

const store = reactive<LibraryRecents>(empty())

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: Partial<LibraryRecents> | undefined): void => {
  Object.assign(store, empty(), next ?? {})
}

/** Load once per window and keep in step with other windows. Idempotent. */
export function loadLibraryRecents(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.libraryRecents))
    .catch(() => {
      // No recents is a chooser that still works.
    })
  bridge.onConfigChanged((config) => adopt(config.libraryRecents))
  return loading
}

/** This kind's recent picks, newest first. */
export function libraryRecents(kind: ChooserKind): readonly string[] {
  void loadLibraryRecents()
  return store[kind]
}

/** Record a pick and persist the whole set. */
export function noteLibraryPick(kind: ChooserKind, id: string): void {
  store[kind] = withRecent(store[kind], id)
  const bridge = api()
  if (bridge)
    void bridge.updateConfig({
      libraryRecents: {
        symbol: [...store.symbol],
        power: [...store.power],
        footprint: [...store.footprint]
      }
    })
}
