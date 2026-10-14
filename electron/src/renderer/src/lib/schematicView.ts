/**
 * What the schematic canvas shows — the persisted switches behind the
 * schematic editor's left view rail (the net hover highlight and the
 * hidden pins and fields).
 *
 * Modeled on `pcbView.ts`, for the same reasons: view preferences every window
 * agrees on live in the main-process config store (RULES.md §8), reads fall
 * back to defaults until the first load lands, and a missing bridge degrades to
 * an in-memory copy. The persisted shape is in
 * `src/preload/schematicViewTypes.d.ts`.
 */

import { computed, reactive, toRaw, type ComputedRef } from 'vue'
import type { SchematicViewState } from '../../../preload/schematicViewTypes'
import { adoptView } from './adoptView'

export type { SchematicViewState }

export const defaultSchematicViewState = (): SchematicViewState => ({
  netHighlight: true,
  showHiddenPins: false,
  showHiddenFields: false
})

const store = reactive<SchematicViewState>(defaultSchematicViewState())

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: Partial<SchematicViewState> | undefined): void => {
  adoptView(store, { ...defaultSchematicViewState(), ...next })
}

/** Load once per window and keep in step with other windows. Idempotent. */
export function loadSchematicView(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.schematicView))
    .catch(() => {
      // A config that cannot be read leaves the defaults on screen.
    })
  bridge.onConfigChanged((config) => adopt(config.schematicView))
  return loading
}

/** The live options. Reads are defaults until the first load lands. */
export function schematicViewState(): ComputedRef<SchematicViewState> {
  void loadSchematicView()
  return computed(() => ({ ...store }))
}

/** Change one or more switches and persist the whole set. */
export function setSchematicView(patch: Partial<SchematicViewState>): void {
  Object.assign(store, patch)
  const bridge = api()
  // An IPC payload must be plain data: the raw object, not a spread of the
  // proxy, whose nested values read back as proxies (see pcbRouter.ts).
  if (bridge) void bridge.updateConfig({ schematicView: { ...toRaw(store) } })
}

/** Test seam: drop the loaded state so a suite can start from the defaults. */
export function __resetSchematicViewStore(): void {
  adopt(undefined)
  loading = null
}
