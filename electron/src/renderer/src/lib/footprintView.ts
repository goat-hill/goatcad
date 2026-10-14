/**
 * What the footprint editor draws — layer visibility, the active layer, and how
 * the rest of the layers render.
 *
 * Modeled on `pcbView.ts`, for the same reasons: view preferences every window
 * agrees on live in the main-process config store (RULES.md §8), reads fall
 * back to defaults until the first load lands, and a missing bridge degrades to
 * an in-memory copy. The persisted shape, and why this is app-wide where the
 * board's equivalent is per-document, are in
 * `src/preload/footprintViewTypes.d.ts`.
 */

import { computed, reactive, toRaw, type ComputedRef } from 'vue'
import type { FootprintViewState } from '../../../preload/footprintViewTypes'
import { adoptView } from './adoptView'

export type { FootprintViewState }

/**
 * Duplicated by necessity in `main/appConfig.ts`, which owns the persisted
 * value and cannot import the renderer; the test alongside this file asserts
 * the two stay equal.
 */
export const FOOTPRINT_LAYERS = [
  'F.Cu',
  'B.Cu',
  'F.SilkS',
  'B.SilkS',
  'F.Mask',
  'B.Mask',
  'F.Paste',
  'B.Paste',
  'F.CrtYd',
  'B.CrtYd',
  'F.Fab',
  'B.Fab'
] as const

export const defaultFootprintViewState = (): FootprintViewState => ({
  layerVisibility: Object.fromEntries(FOOTPRINT_LAYERS.map((layer) => [layer, true])),
  activeLayer: 'F.SilkS',
  nonActiveDisplay: 'show',
  sketchPads: false,
  sketchGraphics: false,
  sketchText: false
})

const store = reactive<FootprintViewState>(defaultFootprintViewState())

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: Partial<FootprintViewState> | undefined): void => {
  adoptView(store, { ...defaultFootprintViewState(), ...next })
}

/** Load once per window and keep in step with other windows. Idempotent. */
export function loadFootprintView(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.footprintView))
    .catch(() => {
      // A config that cannot be read must not blank the footprint.
    })
  bridge.onConfigChanged((config) => adopt(config.footprintView))
  return loading
}

/** The live options. Reads are defaults until the first load lands. */
export function footprintViewState(): ComputedRef<FootprintViewState> {
  void loadFootprintView()
  return computed(() => ({ ...store }))
}

/** Change one or more of them and persist the whole set. */
export function setFootprintView(patch: Partial<FootprintViewState>): void {
  Object.assign(store, patch)
  const bridge = api()
  // An IPC payload must be plain data: the raw object, not a spread of the
  // proxy, whose nested layerVisibility reads back as a proxy.
  void bridge?.updateConfig({ footprintView: { ...toRaw(store) } })
}

/** Test seam — the module-scope store outlives any one test otherwise. */
export function __resetFootprintViewStore(): void {
  loading = null
  adopt(undefined)
}
