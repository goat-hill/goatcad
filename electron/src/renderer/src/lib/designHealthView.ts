/**
 * How the editors show their findings on the canvas — the switch behind the
 * findings drawer's gear, one for all four editors. Modeled on
 * `schematicView.ts`; the persisted shape is in
 * `src/preload/designHealthViewTypes.d.ts`.
 */

import { computed, reactive, toRaw, type ComputedRef } from 'vue'
import type { DesignHealthViewState } from '../../../preload/designHealthViewTypes'
import { adoptView } from './adoptView'

export type { DesignHealthViewState }

export const defaultDesignHealthViewState = (): DesignHealthViewState => ({
  showMarkers: false,
  errorsOnly: false
})

const store = reactive<DesignHealthViewState>(defaultDesignHealthViewState())

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: Partial<DesignHealthViewState> | undefined): void => {
  adoptView(store, { ...defaultDesignHealthViewState(), ...next })
}

/** Load once per window and keep in step with other windows. Idempotent. */
export function loadDesignHealthView(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.designHealthView))
    .catch(() => {
      // A config that cannot be read leaves the defaults on screen.
    })
  bridge.onConfigChanged((config) => adopt(config.designHealthView))
  return loading
}

/** The live options. Reads are defaults until the first load lands. */
export function designHealthViewState(): ComputedRef<DesignHealthViewState> {
  void loadDesignHealthView()
  return computed(() => ({ ...store }))
}

/** Change one or more switches and persist the whole set. */
export function setDesignHealthView(patch: Partial<DesignHealthViewState>): void {
  Object.assign(store, patch)
  const bridge = api()
  // An IPC payload must be plain data: the raw object, not a spread of the
  // proxy, whose nested values read back as proxies (see pcbRouter.ts).
  if (bridge) void bridge.updateConfig({ designHealthView: { ...toRaw(store) } })
}

/** Test seam: drop the loaded state so a suite can start from the defaults. */
export function __resetDesignHealthViewStore(): void {
  adopt(undefined)
  loading = null
}
