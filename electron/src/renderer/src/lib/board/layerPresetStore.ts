/**
 * The layer presets the user saved, shared by every editor that shows a layers
 * panel and by every window.
 *
 * Modeled on `pcbView.ts`, for the same reasons: view preferences everybody
 * agrees on live in the main-process config store (RULES.md §8), reads fall
 * back to defaults until the first load lands, and a missing bridge degrades to
 * an in-memory copy. Why these are app-wide rather than per-board, and what a
 * preset does when the layer tables differ, is in
 * `src/preload/layerPresetTypes.d.ts`.
 */

import { computed, ref, type ComputedRef } from 'vue'
import type { SavedLayerPreset } from '../../../../preload/layerPresetTypes'

export type { SavedLayerPreset }

const store = ref<SavedLayerPreset[]>([])

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: SavedLayerPreset[] | undefined): void => {
  store.value = next ?? []
}

/** Load once per window and keep in step with other windows. Idempotent. */
export function loadLayerPresets(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.layerPresets))
    .catch(() => {
      // A config that cannot be read costs the saved presets, not the panel.
    })
  bridge.onConfigChanged((config) => adopt(config.layerPresets))
  return loading
}

/** The saved presets. Empty until the first load lands. */
export function savedLayerPresets(): ComputedRef<SavedLayerPreset[]> {
  void loadLayerPresets()
  return computed(() => store.value)
}

const persist = (next: SavedLayerPreset[]): void => {
  store.value = next
  // Plain data across the bridge: the store's entries are Vue proxies, which
  // fail to clone (RULES.md §9), so a save never reached the config.
  void api()?.updateConfig({ layerPresets: JSON.parse(JSON.stringify(next)) })
}

/**
 * Save a named preset, replacing one of the same name. Overwrite rather than a
 * second entry: typing a name that exists is how a preset gets updated, and two
 * rows reading the same is a list nobody can choose from.
 */
export function saveLayerPreset(name: string, visibility: Record<string, boolean>): void {
  const trimmed = name.trim()
  if (!trimmed) return
  persist([
    ...store.value.filter((preset) => preset.name !== trimmed),
    { name: trimmed, visibility: { ...visibility } }
  ])
}

export function deleteLayerPreset(name: string): void {
  persist(store.value.filter((preset) => preset.name !== name))
}

/** Test seam — the module-scope store outlives any one test otherwise. */
export function __resetLayerPresetStore(): void {
  loading = null
  store.value = []
}
