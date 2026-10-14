/**
 * Whether the symbol editor draws hidden pins and fields — the two switches on
 * its left view rail.
 *
 * Modeled on `pcbView.ts`, for the same reasons: view preferences every window
 * agrees on live in the main-process config store (RULES.md §8), reads fall
 * back to defaults until the first load lands, and a missing bridge degrades to
 * an in-memory copy. The persisted shape and the default-on rationale are in
 * `src/preload/symbolViewTypes.d.ts`.
 */

import { computed, reactive, toRaw, type ComputedRef } from 'vue'
import type { SymbolViewState } from '../../../preload/symbolViewTypes'
import { adoptView } from './adoptView'

export type { SymbolViewState }

export const defaultSymbolViewState = (): SymbolViewState => ({
  showHiddenPins: true,
  showHiddenFields: true
})

const store = reactive<SymbolViewState>(defaultSymbolViewState())

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: Partial<SymbolViewState> | undefined): void => {
  adoptView(store, { ...defaultSymbolViewState(), ...next })
}

/** Load once per window and keep in step with other windows. Idempotent. */
export function loadSymbolView(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.symbolView))
    .catch(() => {
      // A config that cannot be read must not blank half the symbol.
    })
  bridge.onConfigChanged((config) => adopt(config.symbolView))
  return loading
}

/** The live options. Reads are defaults until the first load lands. */
export function symbolViewState(): ComputedRef<SymbolViewState> {
  void loadSymbolView()
  return computed(() => ({ ...store }))
}

/** Change one or more switches and persist the whole set. */
export function setSymbolView(patch: Partial<SymbolViewState>): void {
  Object.assign(store, patch)
  const bridge = api()
  // An IPC payload must be plain data: the raw object, not a spread of the
  // proxy, whose nested values read back as proxies (see pcbRouter.ts).
  if (bridge) void bridge.updateConfig({ symbolView: { ...toRaw(store) } })
}

/** Test seam: drop the loaded state so a suite can start from the defaults. */
export function __resetSymbolViewStore(): void {
  adopt(undefined)
  loading = null
}
