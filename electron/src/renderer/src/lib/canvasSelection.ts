/**
 * What a click, a band, the pointer and Select Other select — once, for every
 * 2D editor. Each editor's scene answers two questions in the one shape
 * (`HitCandidate`, lib/selectionResolve.ts): what is near a point, ranked best
 * first, and what a band takes. Everything else is the same everywhere: the
 * editor's policy and the user's filter resolve both (`resolveHit` for a
 * click, `resolveSweep` for a band or a list), a plain click replaces and a
 * modified one toggles, a band replaces, and "near" is the engine's 10 px.
 *
 * What differs between editors stays in the scene — how candidates rank, what
 * a band leaves out (a footprint's pads, a symbol's fields), which items can
 * be locked — or in the editor's `active` gate.
 */
import { shallowRef, type ShallowRef } from 'vue'
import type * as THREE from 'three'
import type { ViewportEngine } from './engine/ViewportEngine'
import { resolveHit, resolveSweep, type AllowsHit, type HitCandidate } from './selectionResolve'
import { isMultiSelect, isRemoveSelect, toggleSelection } from './viewportSelection'
import { noteFilterMiss, type SelectionFilterEditor } from './selectionFilter'

/** A band in engine world space (mm, y up). */
export interface BoxBounds {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

/** A band over everything: what Select All sweeps. */
export const EVERYWHERE: BoxBounds = {
  xMin: -Infinity,
  xMax: Infinity,
  yMin: -Infinity,
  yMax: Infinity
}

export interface CanvasSelectionSource<T> {
  engine: () => ViewportEngine | null
  /** Everything within `radius` of a world point, best first. */
  pointCandidates: (point: THREE.Vector2, radius: number) => Array<HitCandidate<T>>
  /** Everything a band takes: touching it when `crossing`, inside it otherwise. */
  boxCandidates: (bounds: BoxBounds, crossing: boolean) => Array<HitCandidate<T>>
  /** The editor's policy and the user's filter together. */
  allows: () => AllowsHit
  /** One string per item, for equality and de-duplication. */
  key: (item: T) => string
  selected: () => readonly T[]
  select: (items: T[]) => void
  /** Whether the canvas selects right now: the select tool armed, an interactive view. */
  active: () => boolean
  /** Whose selection filter `allows` applies: a click it turns away is reported (`noteFilterMiss`). */
  filterEditor?: SelectionFilterEditor
  /** The item behind the engine's `(type, index)` token; `{ type, index }` itself when absent. */
  fromEngine?: (type: string, index: number) => T | null
}

/** An open Select Other list. */
export interface SelectOtherState<T> {
  x: number
  y: number
  items: T[]
  /** The selection to put back when the list closes without a pick. */
  before: T[]
}

export interface CanvasSelection<T> {
  /** What a click at a world point selects. */
  hitAt: (point: THREE.Vector2, radius?: number) => T | null
  /**
   * What a click under the pointer would select, under the filter — what a
   * key acts on when nothing is selected (KiCad's hover selection). `accept`
   * narrows it the way KiCad's collector filters do. Null off the canvas.
   */
  itemAtCursor: (accept?: (item: T) => boolean) => T | null
  itemsInBox: (bounds: BoxBounds, crossing: boolean) => T[]
  /** A band over everything. */
  selectAll: () => T[]
  selectOther: ShallowRef<SelectOtherState<T> | null>
  /** Select Other at a client point: the canvas menu's, where it was opened. */
  selectOtherAt: (client: { x: number; y: number }) => void
  /** A row of the list focused (its items) or left (null). */
  previewSelectOther: (items: T[] | null) => void
  /** The list closed: on a pick, or (no items) put back as it was. */
  closeSelectOther: (items?: T[]) => void
  /** Hand the engine the click, band and hold handlers. */
  install: (engine: ViewportEngine) => void
}

export function useCanvasSelection<T>(source: CanvasSelectionSource<T>): CanvasSelection<T> {
  const same = (a: T, b: T): boolean => source.key(a) === source.key(b)
  const radiusOr = (radius: number | undefined): number =>
    radius ?? source.engine()?.hitRadius() ?? 0

  const hitAt = (point: THREE.Vector2, radius?: number): T | null =>
    resolveHit(source.pointCandidates(point, radiusOr(radius)), source.allows())

  const itemAtCursor = (accept: (item: T) => boolean = () => true): T | null => {
    const engine = source.engine()
    const point = engine?.pointerWorld()
    if (!engine || !point) return null
    const candidates = source
      .pointCandidates(point, engine.hitRadius())
      .map((candidate) => ({ levels: candidate.levels.filter((level) => accept(level.ref)) }))
    return resolveHit(candidates, source.allows())
  }

  const itemsInBox = (bounds: BoxBounds, crossing: boolean): T[] =>
    resolveSweep(source.boxCandidates(bounds, crossing), source.allows(), source.key)

  // ---- Select Other: everything under the pointer, as a list (SelectOtherMenu).

  const selectOther = shallowRef<SelectOtherState<T> | null>(null)
  /** The selection when the last left press began: what a cancelled hold restores. */
  let pressSelection: T[] | null = null

  const openSelectOther = (
    point: THREE.Vector2,
    radius: number,
    client: { x: number; y: number }
  ): void => {
    const before = pressSelection ?? [...source.selected()]
    pressSelection = null
    if (!source.active()) return
    const items = resolveSweep(source.pointCandidates(point, radius), source.allows(), source.key)
    if (items.length === 0) return
    // One item is no choice: take it.
    if (items.length === 1) {
      source.select(items)
      return
    }
    selectOther.value = { x: client.x, y: client.y, items, before }
  }

  /** The list at a client point — where the canvas menu was opened. */
  const selectOtherAt = (client: { x: number; y: number }): void => {
    pressSelection = null
    source.engine()?.selectOtherAt(client)
  }

  const previewSelectOther = (items: T[] | null): void =>
    source.select(items ?? selectOther.value?.before ?? [])

  const closeSelectOther = (items?: T[]): void => {
    source.select(items ?? selectOther.value?.before ?? [])
    selectOther.value = null
  }

  const install = (engine: ViewportEngine): void => {
    engine.onPressCapture((e) => {
      if (e.button !== 0) return
      pressSelection = [...source.selected()]
      // Ctrl/Cmd+press is a pan until it proves to be a click.
      if (!source.filterEditor || e.ctrlKey || e.metaKey || !source.active()) return
      const candidates = source.pointCandidates(engine.clientToWorld(e), engine.hitRadius())
      noteFilterMiss(source.filterEditor, candidates)
    })
    engine.onSelectOther(openSelectOther)
    engine.onSelect((type, index, e) => {
      if (!source.active()) return
      if (type === null || index === null) {
        if (!isMultiSelect(e)) source.select([])
        return
      }
      const item = source.fromEngine ? source.fromEngine(type, index) : ({ type, index } as T)
      if (item === null) {
        if (!isMultiSelect(e)) source.select([])
        return
      }
      if (isRemoveSelect(e)) {
        source.select(source.selected().filter((held) => !same(held, item)))
        return
      }
      source.select(toggleSelection(source.selected(), item, isMultiSelect(e), same))
    })
    engine.onBoxSelect((bounds, crossing, e) => {
      if (!source.active()) return
      const swept = itemsInBox(bounds, crossing)
      if (!isMultiSelect(e)) {
        source.select(swept)
        return
      }
      const held = source.selected()
      // Ctrl+Shift / Cmd+Shift: the band takes what it swept out.
      if (isRemoveSelect(e)) {
        const out = new Set(swept.map(source.key))
        source.select(held.filter((item) => !out.has(source.key(item))))
        return
      }
      // A modified band adds to the selection, as a modified click does.
      const keys = new Set(held.map(source.key))
      source.select([...held, ...swept.filter((item) => !keys.has(source.key(item)))])
    })
  }

  return {
    hitAt,
    itemAtCursor,
    itemsInBox,
    selectAll: () => itemsInBox(EVERYWHERE, true),
    selectOther,
    selectOtherAt,
    previewSelectOther,
    closeSelectOther,
    install
  }
}
