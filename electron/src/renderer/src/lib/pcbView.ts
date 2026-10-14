/**
 * What the 2D board view shows — the persisted display toggles behind the
 * board editor's left view toolbar (zone fills, copper sketch modes) and the
 * clearance outlines in Settings ▸ Board editor.
 *
 * Modeled on `board3dView.ts`, for the same reasons: view preferences every
 * window agrees on live in the main-process config store (RULES.md §8),
 * reads fall back to defaults until the first load lands, and a missing
 * bridge degrades to an in-memory copy. The persisted shape is in
 * `src/preload/pcbViewTypes.d.ts`.
 */

import { computed, reactive, toRaw, type ComputedRef } from 'vue'
import type { PcbViewState, TrackClearanceDisplay } from '../../../preload/pcbViewTypes'
import { adoptView } from './adoptView'

export type { PcbViewState, TrackClearanceDisplay }

export const defaultPcbViewState = (): PcbViewState => ({
  zoneFills: true,
  sketchTracks: false,
  sketchVias: false,
  sketchPads: false,
  ratsnest: true,
  boardArea: true,
  fpReferences: true,
  fpValues: true,
  fpText: true,
  padClearance: true,
  trackClearance: 'routing'
})

/** Every track clearance display, in the order Settings lists them. Duplicated in main/appConfig.ts. */
export const TRACK_CLEARANCE_DISPLAYS: readonly TrackClearanceDisplay[] = [
  'never',
  'routing',
  'routingAndDragging',
  'always'
]

/** Whether a route in progress, and the via it carries, shows its clearance. */
export const showsRouteClearance = (mode: TrackClearanceDisplay): boolean => mode !== 'never'
export const showsDragClearance = (mode: TrackClearanceDisplay): boolean =>
  mode === 'routingAndDragging' || mode === 'always'

const store = reactive<PcbViewState>(defaultPcbViewState())

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: Partial<PcbViewState> | undefined): void => {
  const merged = { ...defaultPcbViewState(), ...next }
  // A main process older than this renderer can hand on a mode it no longer offers.
  if (!TRACK_CLEARANCE_DISPLAYS.includes(merged.trackClearance))
    merged.trackClearance = defaultPcbViewState().trackClearance
  adoptView(store, merged)
}

/** Load once per window and keep in step with other windows. Idempotent. */
export function loadPcbView(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.pcbView))
    .catch(() => {
      // A config that cannot be read must not blank the board.
    })
  bridge.onConfigChanged((config) => adopt(config.pcbView))
  return loading
}

/** The live options. Reads are defaults until the first load lands. */
export function pcbViewState(): ComputedRef<PcbViewState> {
  void loadPcbView()
  return computed(() => ({ ...store }))
}

/** Change one or more switches and persist the whole set. */
export function setPcbView(patch: Partial<PcbViewState>): void {
  Object.assign(store, patch)
  const bridge = api()
  // An IPC payload must be plain data: the raw object, not a spread of the
  // proxy, whose nested values read back as proxies (see pcbRouter.ts).
  if (bridge) void bridge.updateConfig({ pcbView: { ...toRaw(store) } })
}

/** Test seam: drop the loaded state so a suite can start from the defaults. */
export function __resetPcbViewStore(): void {
  adopt(undefined)
  loading = null
}
