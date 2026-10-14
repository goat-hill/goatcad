/**
 * Persistent grid settings, shared across editor instances and windows.
 *
 * Grid is a VIEW preference, never written to the design file (matching KiCad):
 * each editor kind (symbol / footprint / pcb / schematic) keeps its own grid,
 * remembered across tab switches (a module-scope reactive store) and across app
 * restarts (the main-process config store). All open instances of a kind share
 * one source, so changing the grid in one place updates them all.
 *
 * **It used to be `localStorage`, which RULES.md §8 forbids** — persisted state
 * belongs in the main-process config store precisely so that multiple windows
 * share it, and `localStorage` is per-renderer, so two windows quietly kept
 * two grids and the last one closed won. The store below is now the same shape
 * `selectionFilter.ts` and `panelLayout.ts` use: reads fall back to defaults
 * until the first load lands, and a missing bridge degrades to an in-memory copy
 * rather than throwing. A grid saved by the old build is promoted once, so
 * nobody's spacing resets on the release that moves it.
 */

import { reactive, toRef, watch, type Ref } from 'vue'
import type { GridSettings } from './engine/ViewportEngine'
import { matchesHotkey } from './hotkeys'
import type { GridEditorKind, GridPreferencesConfig } from '../../../preload/gridTypes'

export type { GridEditorKind }

export type GridUnit = GridSettings['unit']

export type GridUnitSpacings = Record<GridUnit, number>

/** The key the pre-config build wrote. Read once, then removed. */
const LEGACY_STORAGE_KEY = 'goatcad.gridSettings.v1'

const store = reactive<GridPreferencesConfig>({})

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

/**
 * Whatever the old `localStorage` build left behind, once.
 *
 * Removed on read rather than left in place: leaving it would mean a user who
 * downgrades and comes back gets the stale grid rather than the one they have
 * been using, and the key is dead weight in every renderer otherwise.
 */
const takeLegacyGrids = (): GridPreferencesConfig => {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return {}
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    return JSON.parse(raw) as GridPreferencesConfig
  } catch {
    return {}
  }
}

let loading: Promise<void> | null = null
/** Suppresses the persist watcher while the loaded config is being adopted. */
let adopting = false

const adopt = (next: GridPreferencesConfig | undefined): void => {
  adopting = true
  // The LOCAL store wins over an incoming config for keys it already has: an
  // editor may well have seeded its defaults (or the user changed the grid)
  // before the round trip landed, and clobbering that would move the grid under
  // them a second after the window opened.
  for (const [kind, grid] of Object.entries(next ?? {})) {
    if (!store[kind as GridEditorKind]) store[kind as GridEditorKind] = grid
  }
  void Promise.resolve().then(() => (adopting = false))
}

/**
 * Load once per window and keep in step with the others. Idempotent, and safe
 * with no `window.api` — which is how the unit tests see it.
 */
export function loadGridPreferences(): Promise<void> {
  if (loading) return loading
  const legacy = takeLegacyGrids()
  const bridge = api()
  if (!bridge) {
    adopt(legacy)
    return (loading = Promise.resolve())
  }
  loading = bridge
    .getConfig()
    .then((config) => {
      // Legacy first, so a stored config still wins over a stale localStorage
      // copy for any kind it carries.
      adopt(config.gridPreferences)
      adopt(legacy)
      if (Object.keys(legacy).length) persist()
    })
    .catch(() => adopt(legacy))
  bridge.onConfigChanged((config) => adopt(config.gridPreferences))
  return loading
}

const persist = (): void => {
  // The store is a reactive proxy; what crosses the bridge must be plain.
  void api()?.updateConfig({ gridPreferences: JSON.parse(JSON.stringify(store)) })
}

/**
 * The imperial unit each kind last showed, so Ctrl/Cmd+U returns to inches
 * rather than mils for someone who works in inches (KiCad's m_imperialUnit).
 * A window's memory, as KiCad's is its session's.
 */
const lastImperial: Partial<Record<GridEditorKind, 'mil' | 'in'>> = {}

// Synchronous, so a switch through mm is seen however quickly it is undone.
watch(
  store,
  () => {
    for (const [kind, grid] of Object.entries(store)) {
      if (grid && grid.unit !== 'mm') lastImperial[kind as GridEditorKind] = grid.unit
    }
  },
  { deep: true, flush: 'sync' }
)

// One writer for the whole store — persists any editor's change. Not while a
// load is being adopted, which would echo the config straight back at itself.
watch(
  store,
  () => {
    if (!adopting) persist()
  },
  { deep: true }
)

/**
 * A grid-settings ref for an editor kind. Backed by the shared store, so it
 * persists across remounts/restarts and stays in sync between instances. On
 * first use it seeds from `defaults` (merged under any saved value, so a saved
 * grid wins but new fields still get a default).
 */
/** The schematic editor's grid: KiCad's 50 mil default, wires and pins snap to it. */
export const SCHEMATIC_GRID_DEFAULTS: GridSettings = {
  spacing: 50,
  unit: 'mil',
  visible: true,
  snap: true
}

/** The board editor's grid: finer than the footprint editor's, as boards route on 0.25 mm. */
export const PCB_GRID_DEFAULTS: GridSettings = {
  spacing: 0.25,
  unit: 'mm',
  visible: true,
  snap: true
}

/**
 * The symbol editor's grid: KiCad's 50 mil, the pitch pins sit on to connect in
 * the schematic. With no project, the symbol checks measure pins against it.
 */
export const SYMBOL_GRID_DEFAULTS: GridSettings = {
  spacing: 50,
  unit: 'mil',
  visible: true,
  snap: true
}

/** Each editor's own spacing per unit: where a unit switch lands, and fast grid 1. */
export const SCHEMATIC_UNIT_SPACINGS: GridUnitSpacings = { mm: 1.27, mil: 50, in: 0.05 }
export const SYMBOL_UNIT_SPACINGS: GridUnitSpacings = { mm: 1.27, mil: 50, in: 0.05 }
export const FOOTPRINT_UNIT_SPACINGS: GridUnitSpacings = { mm: 1, mil: 50, in: 0.05 }
export const PCB_UNIT_SPACINGS: GridUnitSpacings = { mm: 0.25, mil: 10, in: 0.01 }

/**
 * The grid sizes the panel offers and N / Shift+N step through, per unit:
 * metric grids for board work, imperial for schematic and symbol.
 */
export const GRID_PRESETS: Record<GridUnit, readonly number[]> = {
  mm: [0.05, 0.1, 0.25, 0.5, 1.0, 1.27, 2.54],
  mil: [1, 2, 5, 10, 25, 50, 100],
  in: [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1]
}

/** The unit's presets, ascending, with the current spacing among them when it is not one. */
export function gridSpacingsFor(settings: Pick<GridSettings, 'unit' | 'spacing'>): number[] {
  const base = GRID_PRESETS[settings.unit]
  const list = base.includes(settings.spacing) ? [...base] : [...base, settings.spacing]
  return list.sort((a, b) => a - b)
}

/**
 * KiCad's Switch to Next Grid (N) and Previous (Shift+N): next is the finer
 * grid, as KiCad's list runs coarse to fine, and both wrap around its ends.
 */
export function steppedGridSpacing(
  settings: Pick<GridSettings, 'unit' | 'spacing'>,
  direction: 'next' | 'previous'
): number {
  const list = gridSpacingsFor(settings)
  const at = list.indexOf(settings.spacing)
  const step = direction === 'next' ? -1 : 1
  return list[(at + step + list.length) % list.length]
}

/**
 * KiCad's fast grids (Alt+1, Alt+2, Alt+4 cycles between them): the first is
 * the editor's own grid in the unit on screen, the second the next finer
 * preset, as KiCad seeds them from its default grid and the one after it.
 */
export function fastGridSpacing(
  settings: Pick<GridSettings, 'unit' | 'spacing'>,
  which: 1 | 2 | 'cycle',
  unitSpacings: GridUnitSpacings
): number {
  const first = unitSpacings[settings.unit]
  const list = gridSpacingsFor({ unit: settings.unit, spacing: first })
  const second = list[Math.max(0, list.indexOf(first) - 1)]
  if (which === 1) return first
  if (which === 2) return second
  return settings.spacing === first ? second : first
}

/** KiCad's Switch Units (Ctrl/Cmd+U): metric to the imperial unit last shown, imperial to mm. */
export function toggledGridUnit(unit: GridUnit, imperial: 'mil' | 'in' = 'mil'): GridUnit {
  return unit === 'mm' ? imperial : 'mm'
}

/** The unit Ctrl/Cmd+U switches this editor kind to. */
export function toggledUnitFor(kind: GridEditorKind, unit: GridUnit): GridUnit {
  return toggledGridUnit(unit, lastImperial[kind])
}

/**
 * The grid change a key asks for — N / Shift+N, the fast grids, Ctrl/Cmd+U —
 * or null when the key is none of them. The editor applies it as it applies a
 * change from the grid pill, so a unit switch converts the same way.
 */
export function gridKeyUpdate(
  event: KeyboardEvent,
  kind: GridEditorKind,
  settings: GridSettings,
  unitSpacings: GridUnitSpacings
): Partial<GridSettings> | null {
  if (matchesHotkey(event, 'editor.gridNext'))
    return { spacing: steppedGridSpacing(settings, 'next') }
  if (matchesHotkey(event, 'editor.gridPrevious'))
    return { spacing: steppedGridSpacing(settings, 'previous') }
  if (matchesHotkey(event, 'editor.gridFast1'))
    return { spacing: fastGridSpacing(settings, 1, unitSpacings) }
  if (matchesHotkey(event, 'editor.gridFast2'))
    return { spacing: fastGridSpacing(settings, 2, unitSpacings) }
  if (matchesHotkey(event, 'editor.gridFastCycle'))
    return { spacing: fastGridSpacing(settings, 'cycle', unitSpacings) }
  if (matchesHotkey(event, 'editor.toggleUnits'))
    return { unit: toggledUnitFor(kind, settings.unit) }
  return null
}

export function useGridSettings(kind: GridEditorKind, defaults: GridSettings): Ref<GridSettings> {
  void loadGridPreferences()
  store[kind] = { ...defaults, ...(store[kind] ?? {}) }
  return toRef(store, kind) as Ref<GridSettings>
}

/**
 * Applies a grid-panel edit. Editors keep their preferred starting spacing for
 * each unit, rather than reinterpreting the previous numeric value on a unit
 * switch (for example, a PCB returns to its 0.25 mm routing grid).
 */
export function updateGridSettings(
  current: GridSettings,
  update: Partial<GridSettings>,
  unitSpacings: GridUnitSpacings
): GridSettings {
  const next = { ...current, ...update }
  if (update.unit && update.unit !== current.unit) next.spacing = unitSpacings[update.unit]
  return next
}
