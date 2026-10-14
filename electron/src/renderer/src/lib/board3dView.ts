/**
 * What the 3D board view shows — the shared, persisted set of layer and
 * component switches behind `Pcb3DOptionsPanel`, and how the pane presents
 * them: projection, light and background.
 *
 * Modeled on `selectionFilter.ts`, and for the same reasons: the state is a
 * view preference every window agrees on, so it lives in the main-process
 * config store rather than `localStorage` (RULES.md §8), reads fall back to
 * the defaults until the first load lands, and a missing bridge degrades to an
 * in-memory copy rather than throwing. The persisted shape is in
 * `src/preload/board3dTypes.d.ts`.
 */

import { computed, reactive, toRaw, type ComputedRef } from 'vue'
import type { Board3DPresentation, Board3DViewState } from '../../../preload/board3dTypes'
import { adoptView } from './adoptView'

export type { Board3DPresentation, Board3DViewState }
export type {
  Board3DBackground,
  Board3DLighting,
  Board3DProjection
} from '../../../preload/board3dTypes'

/** Each setting's choices, in the order offered. Main's
 *  `BOARD3D_PRESENTATION_CHOICES` (`appConfig.ts`) lists the same. */
export const BOARD3D_PRESENTATION_CHOICES: {
  [K in Exclude<keyof Board3DPresentation, 'exposure'>]: ReadonlyArray<Board3DPresentation[K]>
} = {
  projection: ['perspective', 'orthographic'],
  lighting: ['studio', 'soft', 'flat', 'dramatic'],
  background: ['theme', 'transparent', 'white', 'black']
}

/** Main's `BOARD3D_EXPOSURE_RANGE` (`appConfig.ts`) holds the same. */
export const BOARD3D_EXPOSURE_RANGE = { min: 0.2, max: 4 } as const

/** Agrees with main's `defaultBoard3DPresentation`. */
export const defaultBoard3DPresentation = (): Board3DPresentation => ({
  projection: 'perspective',
  lighting: 'studio',
  exposure: 1,
  background: 'theme'
})

/**
 * Matches KiCad's 3D viewer defaults, with two deliberate departures: the
 * comment/drawing layers stay off (they are annotation, not board), and parts
 * marked `(attr dnp)` stay hidden, because the point of the flag is that they
 * will not be on the finished assembly.
 */
export const defaultBoard3DViewState = (): Board3DViewState => ({
  boardBody: true,
  copper: true,
  solderMask: true,
  solderPaste: true,
  silkscreen: true,
  drawings: false,
  holes: true,
  models: true,
  modelsThroughHole: true,
  modelsSmd: true,
  modelsUnspecified: true,
  modelsDnp: false,
  modelsNotInPosFiles: false,
  axes: false,
  gauge: false
})

const store = reactive<Board3DViewState>(defaultBoard3DViewState())
const presentation = reactive<Board3DPresentation>(defaultBoard3DPresentation())

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (
  next: Partial<Board3DViewState> | undefined,
  nextPresentation?: Partial<Board3DPresentation>
): void => {
  adoptView(store, { ...defaultBoard3DViewState(), ...next })
  adoptView(presentation, { ...defaultBoard3DPresentation(), ...nextPresentation })
}

/**
 * Load the options once per window and keep them in step with other windows.
 * Idempotent — every viewport mount calls it.
 */
export function loadBoard3DView(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.board3dView, config.board3dPresentation))
    .catch(() => {
      // A config that cannot be read must not blank the board.
    })
  bridge.onConfigChanged((config) => adopt(config.board3dView, config.board3dPresentation))
  return loading
}

/** The live options. Reads are defaults until the first load lands. */
export function board3dViewState(): ComputedRef<Board3DViewState> {
  void loadBoard3DView()
  return computed(() => ({ ...store }))
}

/** Change one or more switches and persist the whole set. */
export function setBoard3DView(patch: Partial<Board3DViewState>): void {
  Object.assign(store, patch)
  const bridge = api()
  // An IPC payload must be plain data: the raw object, not a spread of the
  // proxy, whose nested values read back as proxies (see pcbRouter.ts).
  if (bridge) void bridge.updateConfig({ board3dView: { ...toRaw(store) } })
}

/** Put every switch back, for the panel's reset. */
export function resetBoard3DView(): void {
  setBoard3DView(defaultBoard3DViewState())
}

export const isDefaultBoard3DView = (state: Board3DViewState): boolean => {
  const defaults = defaultBoard3DViewState()
  return (Object.keys(defaults) as Array<keyof Board3DViewState>).every(
    (key) => defaults[key] === state[key]
  )
}

/** Projection, light and background. Defaults until the first load lands. */
export function board3dPresentation(): ComputedRef<Board3DPresentation> {
  void loadBoard3DView()
  return computed(() => ({ ...presentation }))
}

export function setBoard3DPresentation(patch: Partial<Board3DPresentation>): void {
  Object.assign(presentation, patch)
  void api()?.updateConfig({ board3dPresentation: { ...toRaw(presentation) } })
}

/** Put every presentation setting back, for its section's reset. */
export function resetBoard3DPresentation(): void {
  setBoard3DPresentation(defaultBoard3DPresentation())
}

export const isDefaultBoard3DPresentation = (shown: Board3DPresentation): boolean => {
  const defaults = defaultBoard3DPresentation()
  return (Object.keys(defaults) as Array<keyof Board3DPresentation>).every(
    (key) => defaults[key] === shown[key]
  )
}

/** Test seam: drop the loaded state so a suite can start from the defaults. */
export function __resetBoard3DViewStore(): void {
  adopt(undefined)
  loading = null
}
