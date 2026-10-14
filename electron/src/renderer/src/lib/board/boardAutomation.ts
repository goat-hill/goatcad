/**
 * How a board's zone fill and design checks run on their own, set per board
 * behind the findings drawer's gear (`BoardAutomationSettings.vue`).
 *
 * - `greedy` (checks only) does the least work that gives the whole answer:
 *   the region round an edit, the whole board only where nothing smaller will
 *   do (a load, an undo, new rules).
 * - `full` does the whole board after every edit.
 * - `off` runs nothing on its own; the manual refill (`B`) and re-run still do.
 *
 * The zone fill has no greedy mode: a partial refill cannot yet tell every
 * zone an edit changes (BACKLOG.md, "Partial zone refill").
 *
 * Kept by file path in the config store (`AppConfig.boardAutomation`), like
 * the panel layout and for its reasons (`panelLayout.ts`): every window
 * agrees, and the editor a tab switch destroys finds it again. A board on the
 * defaults stores nothing.
 */
import { computed, reactive, type ComputedRef } from 'vue'
import type {
  AutoMode,
  BoardAutomationConfig,
  BoardAutomationState,
  ZoneFillMode
} from '../../../../preload/boardAutomationTypes'

export type { AutoMode, ZoneFillMode }

export const DRC_MODES: readonly AutoMode[] = ['greedy', 'full', 'off']
export const ZONE_FILL_MODES: readonly ZoneFillMode[] = ['full', 'off']

export interface BoardAutomation {
  zoneFill: ZoneFillMode
  drc: AutoMode
}

export const DEFAULT_AUTOMATION: Readonly<BoardAutomation> = { zoneFill: 'full', drc: 'greedy' }

const store = reactive<BoardAutomationConfig>({})
let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: BoardAutomationConfig | undefined): void => {
  for (const key of Object.keys(store)) delete store[key]
  Object.assign(store, next ?? {})
}

/** Load once per window and follow the other windows; with no bridge, in memory only. */
export function loadBoardAutomation(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.boardAutomation))
    .catch(() => undefined)
  bridge.onConfigChanged((config) => adopt(config.boardAutomation))
  return loading
}

/** A board's settings, the defaults where it has none. */
export function boardAutomationFor(path: () => string): ComputedRef<BoardAutomation> {
  void loadBoardAutomation()
  return computed(() => ({ ...DEFAULT_AUTOMATION, ...store[path()] }))
}

export function setBoardAutomation(path: string, patch: Partial<BoardAutomation>): void {
  if (!path) return
  const next: BoardAutomationState = { ...store[path], ...patch }
  for (const key of Object.keys(next) as Array<keyof BoardAutomation>) {
    if (next[key] === DEFAULT_AUTOMATION[key]) delete next[key]
  }
  // Re-inserted, so the store's order is by last change and the oldest are dropped first.
  delete store[path]
  if (Object.keys(next).length > 0) store[path] = next
  void api()?.updateConfig({ boardAutomation: JSON.parse(JSON.stringify(store)) })
}

/** Test seam. */
export function resetBoardAutomation(): void {
  adopt({})
  loading = null
}
