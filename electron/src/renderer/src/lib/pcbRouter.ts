/**
 * How the board's router meets other copper — the mode behind the router pill
 * (`components/pcb/CollisionModeControl.vue`).
 *
 * Modeled on `pcbView.ts`, for the same reasons: preferences every window
 * agrees on live in the main-process config store (RULES.md §8), reads fall
 * back to defaults until the first load lands, and a missing bridge degrades
 * to an in-memory copy. The persisted shape is in
 * `src/preload/pcbRouterTypes.d.ts`.
 */

import { computed, reactive, toRaw, type ComputedRef } from 'vue'
import type {
  PcbRouterCorner,
  PcbRouterMode,
  PcbRouterSettings,
  PcbRouterState
} from '../../../preload/pcbRouterTypes'
import type { RouteCornerMode } from './board/pcbTools'

export type { PcbRouterCorner, PcbRouterMode, PcbRouterSettings, PcbRouterState }

/**
 * KiCad's defaults (`ROUTING_SETTINGS`). *Use starting track width* is not one:
 * KiCad keeps it per project, in the `.kicad_prl` (`boardViewStore.ts`).
 * Duplicated keys: PCB_ROUTER_SETTING_KEYS in main/appConfig.ts.
 */
export const ROUTER_SETTING_DEFAULTS: Readonly<PcbRouterSettings> = {
  shoveVias: true,
  jumpOverObstacles: false,
  removeLoops: true,
  smartPads: true,
  smoothDragged: true,
  optimizeDragged: false,
  autoPosture: true,
  startDiagonal: false,
  fixAllSegments: true,
  allowViolations: false,
  freeAngle: false
}

/** The settings in force: what was changed, KiCad's default for the rest. */
export const routerSettings = (state: PcbRouterState): PcbRouterSettings => ({
  ...ROUTER_SETTING_DEFAULTS,
  ...state.settings
})

/** Change one router setting and persist it. */
export function setRouterSetting<K extends keyof PcbRouterSettings>(
  key: K,
  value: PcbRouterSettings[K]
): void {
  setPcbRouter({ settings: { ...store.settings, [key]: value } })
}

/** Walkaround, KiCad's default mode. Duplicated: defaultPcbRouter in main/appConfig.ts. */
export const defaultPcbRouterState = (): PcbRouterState => ({ mode: 'walkaround' })

/** Every mode, in the order the pill's menu lists them and `Alt+R` steps through them. */
export const ROUTER_MODES: readonly PcbRouterMode[] = ['shove', 'walkaround', 'highlight']

export const nextRouterMode = (mode: PcbRouterMode): PcbRouterMode =>
  ROUTER_MODES[(ROUTER_MODES.indexOf(mode) + 1) % ROUTER_MODES.length]

/**
 * Whether a click or a drop commits copper that breaks clearance: only in
 * Highlight with *Allow DRC violations* on, as KiCad's. Push and Avoid propose
 * none, and Highlight otherwise refuses it (R19, D9).
 */
export const commitsViolations = (state: PcbRouterState): boolean =>
  state.mode === 'highlight' && routerSettings(state).allowViolations

/** KiCad's corner modes, in the order `Ctrl+/` steps them (R3). */
export const ROUTER_CORNERS: readonly PcbRouterCorner[] = ['45', 'arc45', '90', 'arc90']

export const nextRouterCorner = (corner: PcbRouterCorner): PcbRouterCorner =>
  ROUTER_CORNERS[(ROUTER_CORNERS.indexOf(corner) + 1) % ROUTER_CORNERS.length]

/**
 * The corners a route is drawn with (R3): the corner mode's, else one free
 * segment while *Free angle mode* is on in Highlight — the only mode KiCad
 * reads it in.
 */
export function routeCorner(state: PcbRouterState): {
  cornerMode: RouteCornerMode
  rounded: boolean
} {
  const corner = state.corner ?? '45'
  if (state.mode === 'highlight' && routerSettings(state).freeAngle)
    return { cornerMode: 'free', rounded: false }
  return {
    cornerMode: corner === '90' || corner === 'arc90' ? '90' : '45',
    rounded: corner !== '45' && corner !== '90'
  }
}

/** The corners a drag re-draws with: the corner mode's angle, never free (KiCad's dragger). */
export const dragCorner = (state: PcbRouterState): RouteCornerMode => {
  const corner = state.corner ?? '45'
  return corner === '90' || corner === 'arc90' ? '90' : '45'
}

const store = reactive<PcbRouterState>(defaultPcbRouterState())

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: Partial<PcbRouterState> | undefined): void => {
  // The optional fields are absent when unset, so a reset elsewhere must clear them here too.
  Object.assign(
    store,
    defaultPcbRouterState(),
    { corner: undefined, settings: undefined },
    next ?? {}
  )
}

/** Load once per window and keep in step with other windows. Idempotent. */
export function loadPcbRouter(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.pcbRouter))
    .catch(() => {
      // A config that cannot be read leaves the defaults in force.
    })
  bridge.onConfigChanged((config) => adopt(config.pcbRouter))
  return loading
}

/** The live settings. Reads are defaults until the first load lands. */
export function pcbRouterState(): ComputedRef<PcbRouterState> {
  void loadPcbRouter()
  return computed(() => ({ ...store }))
}

/** Change the settings and persist the whole set. */
export function setPcbRouter(patch: Partial<PcbRouterState>): void {
  Object.assign(store, patch)
  const bridge = api()
  // An IPC payload must be plain data. A spread of the proxy is not: its
  // nested settings read back as a proxy, which cannot be cloned. The raw
  // object holds what was assigned, unwrapped.
  if (bridge) void bridge.updateConfig({ pcbRouter: { ...toRaw(store) } })
}

/** Test seam: drop the loaded state so a suite can start from the defaults. */
export function __resetPcbRouterStore(): void {
  adopt(undefined)
  loading = null
}
