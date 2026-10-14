/**
 * The selection filter: which kinds of item a click or a rubber-band sweep is
 * allowed to land on, per editor.
 *
 * This is the switch panel feeding the walk-up rule in `selectionResolve.ts` —
 * not a second selection mechanism. `SELECTABLE_KINDS` says what an editor is
 * *capable* of selecting; this says what the user currently *wants* it to. The
 * two compose in `allowsHitFor` and nothing else needs to know a filter exists.
 *
 * State persists in the main-process config store rather than `localStorage`
 * (RULES.md §8), so every window shares one filter. The persisted shape lives
 * in `src/preload/selectionFilterTypes.d.ts`.
 */

import { computed, reactive, type ComputedRef } from 'vue'
import {
  allowsKindFor,
  resolveHit,
  SELECTABLE_KINDS,
  type AllowsHit,
  type HitCandidate
} from './selectionResolve'
import type {
  SelectionFilterConfig,
  SelectionFilterEditor,
  SelectionFilterState
} from '../../../preload/selectionFilterTypes'

export type { SelectionFilterEditor, SelectionFilterState }

/** Nothing excluded, locked items selectable — today's behavior exactly. */
export const defaultFilterState = (): SelectionFilterState => ({
  excludedKinds: [],
  allowLocked: true
})

export const isDefaultFilterState = (state: SelectionFilterState): boolean =>
  state.excludedKinds.length === 0 && state.allowLocked

/**
 * The predicate an editor hands to `resolveHit` / `resolveSweep`.
 *
 * Both halves are AND-ed: a kind must be one the editor can select at all AND
 * one the user has left switched on. Excluding a kind the editor never selects
 * is therefore harmless, which matters because the stored exclusion list
 * outlives any particular version of `SELECTABLE_KINDS`.
 */
export function allowsHitFor(
  editor: SelectionFilterEditor | string,
  state: SelectionFilterState
): AllowsHit {
  const editorAllows = allowsKindFor(editor)
  const excluded = new Set(state.excludedKinds)
  return (level) => {
    if (!editorAllows(level)) return false
    if (excluded.has(level.kind)) return false
    return state.allowLocked || !level.locked
  }
}

/** The kinds an editor's panel offers, in the order `SELECTABLE_KINDS` lists them. */
export function filterableKinds(editor: SelectionFilterEditor | string): readonly string[] {
  return SELECTABLE_KINDS[editor] ?? []
}

/**
 * Whether this editor's documents carry a lock flag at all.
 *
 * `(locked yes)` is a board and footprint notion; KiCad has no locked wire,
 * symbol or pin. Offering the switch in the schematic or symbol editor would be
 * a checkbox that does nothing, which is the same defect as listing a kind no
 * scene produces — so the panel asks this before drawing the row.
 */
export function supportsLocked(editor: SelectionFilterEditor | string): boolean {
  return editor === 'pcb' || editor === 'footprint'
}

// ---------------------------------------------------------------------------
// Shared store
// ---------------------------------------------------------------------------

const store = reactive<SelectionFilterConfig>({})

/**
 * Whether the config round-trip is wired up. Until the first load lands, reads
 * return defaults — which is the right way round: an editor mounted before the
 * config arrives selects everything, rather than nothing.
 */
let loaded = false
let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: SelectionFilterConfig | undefined): void => {
  for (const key of Object.keys(store) as SelectionFilterEditor[]) delete store[key]
  Object.assign(store, next ?? {})
}

/**
 * Load the filter once per window and keep it in step with the other windows.
 *
 * Safe to call repeatedly — every editor mount does — and safe to call with no
 * `window.api` at all, which is how the unit tests and any non-Electron host
 * see it. A missing bridge degrades to an in-memory filter rather than throwing
 * (RULES.md §8).
 */
export function loadSelectionFilter(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) {
    loaded = true
    return (loading = Promise.resolve())
  }
  loading = bridge
    .getConfig()
    .then((config) => {
      adopt(config.selectionFilter)
      loaded = true
    })
    .catch(() => {
      // A config that cannot be read must not disable selection.
      loaded = true
    })
  bridge.onConfigChanged((config) => adopt(config.selectionFilter))
  return loading
}

/**
 * One editor's live filter state. Reads fall back to the default until loaded.
 *
 * Kicks off the load itself rather than relying on app startup to do it: the
 * call is idempotent, and a viewport that mounted without one would silently
 * run on defaults forever.
 */
export function selectionFilterState(
  editor: SelectionFilterEditor
): ComputedRef<SelectionFilterState> {
  void loadSelectionFilter()
  return computed(() => store[editor] ?? defaultFilterState())
}

/** One editor's composed predicate, recomputed when the filter changes. */
export function useSelectionFilter(editor: SelectionFilterEditor): {
  state: ComputedRef<SelectionFilterState>
  allows: ComputedRef<AllowsHit>
  isDefault: ComputedRef<boolean>
} {
  const state = selectionFilterState(editor)
  return {
    state,
    allows: computed(() => allowsHitFor(editor, state.value)),
    isDefault: computed(() => isDefaultFilterState(state.value))
  }
}

const persist = (): void => {
  const bridge = api()
  if (!bridge) return
  // Structured-clone the reactive proxy: an IPC payload must be plain data.
  void bridge.updateConfig({ selectionFilter: JSON.parse(JSON.stringify(store)) })
}

/** Replace one editor's filter and persist the whole map. */
export function setSelectionFilter(
  editor: SelectionFilterEditor,
  state: SelectionFilterState
): void {
  store[editor] = { excludedKinds: [...state.excludedKinds], allowLocked: state.allowLocked }
  persist()
}

export function setKindAllowed(
  editor: SelectionFilterEditor,
  kind: string,
  allowed: boolean
): void {
  const current = store[editor] ?? defaultFilterState()
  const excluded = new Set(current.excludedKinds)
  if (allowed) excluded.delete(kind)
  else excluded.add(kind)
  setSelectionFilter(editor, { ...current, excludedKinds: [...excluded] })
}

export function setLockedAllowed(editor: SelectionFilterEditor, allowed: boolean): void {
  const current = store[editor] ?? defaultFilterState()
  setSelectionFilter(editor, { ...current, allowLocked: allowed })
}

/** Switch everything on, locked included — the badge's one-click escape from a
 *  filter that has made clicks stop working. */
export function resetSelectionFilter(editor: SelectionFilterEditor): void {
  setSelectionFilter(editor, defaultFilterState())
}

/**
 * Switch every kind on or off at once — the panel's "All items" row.
 *
 * Locked is left alone in both directions: it is a state, not a kind, so
 * folding it in would make one checkbox labelled "All items" mean two different
 * things. (`resetSelectionFilter` is the one that clears everything, because
 * "put it all back" is a different promise from "tick every item.")
 */
export function setAllKindsAllowed(editor: SelectionFilterEditor, allowed: boolean): void {
  const current = store[editor] ?? defaultFilterState()
  setSelectionFilter(editor, {
    ...current,
    excludedKinds: allowed ? [] : [...filterableKinds(editor)]
  })
}

/** Whether no kind is switched off — the "All items" checked state. */
export function allKindsAllowed(
  editor: SelectionFilterEditor,
  state: SelectionFilterState
): boolean {
  return !filterableKinds(editor).some((kind) => state.excludedKinds.includes(kind))
}

// ---------------------------------------------------------------------------
// A click the filter turned away
// ---------------------------------------------------------------------------

/** What a filter miss names: a kind switched off, or `LOCKED_TARGET`. */
export const LOCKED_TARGET = 'locked'

/**
 * Why a click selected nothing, when the filter is the reason: the kind of the
 * best-ranked item under it the editor could have selected but the user
 * switched off, or `LOCKED_TARGET` when that item is locked and locked items
 * are off. Null when the click selects something, or when nothing under it was
 * selectable anyway.
 */
export function filterMissTarget<T>(
  editor: SelectionFilterEditor,
  state: SelectionFilterState,
  candidates: Array<HitCandidate<T>>
): string | null {
  if (resolveHit(candidates, allowsHitFor(editor, state)) !== null) return null
  const editorAllows = allowsKindFor(editor)
  const excluded = new Set(state.excludedKinds)
  for (const candidate of candidates) {
    for (const level of candidate.levels) {
      if (!editorAllows(level)) continue
      if (excluded.has(level.kind)) return level.kind
      if (level.locked && !state.allowLocked) return LOCKED_TARGET
    }
  }
  return null
}

export interface FilterMiss {
  target: string
  /** Bumped per miss, so the same target twice still flashes twice. */
  seq: number
}

const misses = reactive<Partial<Record<SelectionFilterEditor, FilterMiss>>>({})

/**
 * A left click selected nothing: if the filter is why, say so to whatever
 * shows the filter — its pill flashes, or, open or pinned, the row that
 * turned the click away.
 */
export function noteFilterMiss<T>(
  editor: SelectionFilterEditor,
  candidates: Array<HitCandidate<T>>
): void {
  const target = filterMissTarget(editor, store[editor] ?? defaultFilterState(), candidates)
  if (target === null) return
  misses[editor] = { target, seq: (misses[editor]?.seq ?? 0) + 1 }
}

/** The latest filter miss in an editor, for its pill and panel to flash on. */
export function filterMiss(editor: SelectionFilterEditor): ComputedRef<FilterMiss | null> {
  return computed(() => misses[editor] ?? null)
}

/** Test seam: drop the loaded state so a suite can start from a known filter. */
export function __resetSelectionFilterStore(): void {
  adopt({})
  for (const key of Object.keys(misses) as SelectionFilterEditor[]) delete misses[key]
  loaded = false
  loading = null
}

/** Whether the first config read has completed (diagnostics and tests). */
export const selectionFilterLoaded = (): boolean => loaded
