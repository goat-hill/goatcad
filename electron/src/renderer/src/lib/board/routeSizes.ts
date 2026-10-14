/**
 * The sizes a route draws with (docs/router-behavior.md S1–S9): what the
 * rules give a net, the list a person picks from, and how `W` / `'` step it,
 * on KiCad's model — a row of each list, kept until changed. Millimeters
 * throughout.
 */
import type { NetClass, ViaSize } from '../kicad/project'
import type { BoardRules } from './rules/boardRules'

/** A size rule's answer for one net on one layer: the size to draw, its limits, and who set it. */
export interface SizeRule<T> {
  value: T
  min: T
  max?: number
  source: string
}

/** Two sizes this close are one size: a nanometer, the files' own resolution. */
const EPS = 1e-6
const same = (a: number, b: number): boolean => Math.abs(a - b) < EPS

/**
 * The width the rules give a new track of `net` on `layer`: the preferred
 * width held inside min and max, and never under the board's minimum.
 */
export function resolveTrackWidth(
  rules: BoardRules,
  net: number,
  layer: string,
  boardMin: number
): SizeRule<number> {
  const r = rules.resolver.evaluate(
    'track_width',
    rules.newItem('track', net, [layer]),
    null,
    layer
  )
  const min = Math.max(r.value.min ?? 0, boardMin)
  const max = r.value.max
  const value = Math.min(Math.max(r.value.opt ?? min, min), max ?? Infinity)
  return { value, min, ...(max !== undefined ? { max } : {}), source: r.name }
}

/**
 * The width and gap the rules give a pair's halves `p` and `n` on `layer`
 * (S13, KiCad's `ImportSizes`): `track_width` and `diff_pair_gap` asked of the
 * one half beside the other, each never under the board's minimum width and
 * clearance. The via gap is the gap.
 */
export function resolvePairSizes(
  rules: BoardRules,
  nets: { p: number; n: number },
  layer: string,
  boardMin: { width: number; clearance: number }
): { width: SizeRule<number>; gap: SizeRule<number> } {
  const a = rules.newItem('track', nets.p, [layer])
  const b = rules.newItem('track', nets.n, [layer])
  const ask = (type: 'track_width' | 'diff_pair_gap', floor: number): SizeRule<number> => {
    const r = rules.resolver.evaluate(type, a, b, layer)
    const min = Math.max(r.value.min ?? 0, floor)
    const max = r.value.max
    // The board's floor wins over a rule's max, as KiCad's std::max( minimum, opt ) does.
    const value = Math.max(Math.min(Math.max(r.value.opt ?? min, min), max ?? Infinity), floor)
    return { value, min, ...(max !== undefined ? { max } : {}), source: r.name }
  }
  return {
    width: ask('track_width', boardMin.width),
    gap: ask('diff_pair_gap', boardMin.clearance)
  }
}

/** The tuning profile a size rule's source names (S12), as KiCad names its rules; null for any other. */
export const tuningProfileOf = (source: string): string | null =>
  /^tuning profile '(.*)'$/.exec(source)?.[1] ?? null

/** The via the rules give `net` between `layers`, as `resolveTrackWidth` does a width. */
export function resolveVia(
  rules: BoardRules,
  net: number,
  layers: readonly string[],
  boardMin: ViaSize
): SizeRule<ViaSize> {
  const item = rules.newItem('via', net, layers)
  const d = rules.resolver.evaluate('via_diameter', item, null, layers[0] ?? null)
  const h = rules.resolver.evaluate('hole_size', item, null, layers[0] ?? null)
  const min = {
    diameter: Math.max(d.value.min ?? 0, boardMin.diameter),
    drill: Math.max(h.value.min ?? 0, boardMin.drill)
  }
  return {
    value: {
      diameter: Math.max(d.value.opt ?? min.diameter, min.diameter),
      drill: Math.max(h.value.opt ?? min.drill, min.drill)
    },
    min,
    source: d.name
  }
}

/**
 * One row of the size list (S4): KiCad's list — the net's own size first (its
 * "netclass width", which the rules resolve), then the project's extra sizes.
 */
export interface SizeEntry<T> {
  size: T
  /** The first row: the size the rules give the net. */
  netClass: boolean
  /** Outside what the rules allow this net: listed, drawn and flagged, never clipped (S7). */
  outOfRule: 'below' | 'above' | null
}

/** The extra sizes in order of size, each once. */
const extraRows = <T>(
  extras: readonly T[],
  measure: (size: T) => number,
  isSame: (a: T, b: T) => boolean
): T[] =>
  [...extras]
    .sort((a, b) => measure(a) - measure(b))
    .filter((size, i, sorted) => i === 0 || !isSame(sorted[i - 1], size))

/** The widths `W` steps through for a net under `rule` (S4, S5). */
export function widthList(
  rule: SizeRule<number>,
  extras: readonly number[]
): Array<SizeEntry<number>> {
  const outOfRule = (w: number): SizeEntry<number>['outOfRule'] =>
    w < rule.min - EPS ? 'below' : rule.max !== undefined && w > rule.max + EPS ? 'above' : null
  return [
    { size: rule.value, netClass: true, outOfRule: null },
    ...extraRows(extras, (w) => w, same).map((size) => ({
      size,
      netClass: false,
      outOfRule: outOfRule(size)
    }))
  ]
}

export const sameVia = (a: ViaSize, b: ViaSize): boolean =>
  same(a.diameter, b.diameter) && same(a.drill, b.drill)

/** The vias `'` steps through, as `widthList` the widths. */
export function viaList(
  rule: SizeRule<ViaSize>,
  extras: readonly ViaSize[]
): Array<SizeEntry<ViaSize>> {
  const below = (v: ViaSize): boolean =>
    v.diameter < rule.min.diameter - EPS || v.drill < rule.min.drill - EPS
  return [
    { size: rule.value, netClass: true, outOfRule: null },
    ...extraRows(extras, (v) => v.diameter + v.drill / 1000, sameVia).map((size) => ({
      size,
      netClass: false,
      outOfRule: below(size) ? ('below' as const) : null
    }))
  ]
}

/** One step through a list of `length` rows, wrapping at either end (KiCad's W / Shift+W). */
export const stepIndex = (length: number, index: number, dir: 1 | -1): number =>
  length <= 0 ? 0 : (((index + dir) % length) + length) % length

/**
 * What the route tool draws with, as KiCad keeps it: a row of each list, a
 * typed custom size over both, and whether this route has left the width of
 * the track it started from.
 */
export interface RouteSizeChoice {
  widthIndex: number
  viaIndex: number
  /** KiCad's Custom Track/Via Size: one typed width and via, in force until a row is picked. */
  custom: { width: number; via: ViaSize } | null
  /** This route's width was changed, so the started-from track's no longer holds (R1). Per route. */
  override: boolean
}

export const initialSizeChoice = (): RouteSizeChoice => ({
  widthIndex: 0,
  viaIndex: 0,
  custom: null,
  override: false
})

export type WidthSource = 'rules' | 'track' | 'list' | 'custom'

/**
 * The width a click lays (S1, R1): the started-from track's while *Use
 * starting track width* holds and nothing has overridden it, else the custom
 * size, else the list's row.
 */
export function widthInForce(
  list: ReadonlyArray<SizeEntry<number>>,
  choice: RouteSizeChoice,
  inherited: number | null,
  useConnected: boolean
): { width: number; source: WidthSource } {
  if (useConnected && !choice.override && inherited !== null)
    return { width: inherited, source: 'track' }
  if (choice.custom) return { width: choice.custom.width, source: 'custom' }
  const row = list[choice.widthIndex] ?? list[0]
  return { width: row.size, source: row.netClass ? 'rules' : 'list' }
}

/** The via a click places: the custom size, else the list's row. */
export function viaInForce(
  list: ReadonlyArray<SizeEntry<ViaSize>>,
  choice: RouteSizeChoice
): { via: ViaSize; source: Exclude<WidthSource, 'track'> } {
  if (choice.custom) return { via: choice.custom.via, source: 'custom' }
  const row = list[choice.viaIndex] ?? list[0]
  return { via: row.size, source: row.netClass ? 'rules' : 'list' }
}

/**
 * `W` / `Shift+W` (S5): the next row, wrapping. On a width `carried` from the
 * track the route started on, the first press leaves it for the row already
 * chosen rather than stepping (KiCad's). Either way a custom size gives way
 * to the list.
 */
export function stepWidthChoice(
  choice: RouteSizeChoice,
  length: number,
  dir: 1 | -1,
  carried: boolean
): RouteSizeChoice {
  if (carried) return { ...choice, custom: null, override: true }
  return { ...choice, widthIndex: stepIndex(length, choice.widthIndex, dir), custom: null }
}

/** `'` / `\`: the next via row, wrapping; a custom size gives way. */
export const stepViaChoice = (
  choice: RouteSizeChoice,
  length: number,
  dir: 1 | -1
): RouteSizeChoice => ({
  ...choice,
  viaIndex: stepIndex(length, choice.viaIndex, dir),
  custom: null
})

/** A size as the list and the corner pills print it: millimeters, no trailing zeros. */
export const formatSize = (mm: number): string => String(Number(mm.toFixed(4)))

export const formatVia = (via: ViaSize): string =>
  `${formatSize(via.diameter)} / ${formatSize(via.drill)}`

/**
 * The lists a selection's sizes step through (S9): the Default class's size
 * first, whatever the item's net, then the project's extra sizes, as KiCad's
 * (`BOARD_EDITOR_CONTROL::TrackWidthInc`, `ViaSizeInc`).
 */
export function selectionSizeLists(
  defaultClass: Pick<NetClass, 'name' | 'trackWidth' | 'viaDiameter' | 'viaDrill'>,
  extras: { tracks: readonly number[]; vias: readonly ViaSize[] }
): { widths: Array<SizeEntry<number>>; vias: Array<SizeEntry<ViaSize>> } {
  const source = `netclass '${defaultClass.name}'`
  const via = { diameter: defaultClass.viaDiameter, drill: defaultClass.viaDrill }
  return {
    widths: widthList({ value: defaultClass.trackWidth, min: 0, source }, extras.tracks),
    vias: viaList({ value: via, min: { diameter: 0, drill: 0 }, source }, extras.vias)
  }
}

/**
 * One step of a drawn track's width or via's size (S9, KiCad's): the nearest
 * size of the list past the item's own, or its own at the list's end.
 */
export function stepDrawn<T>(
  list: ReadonlyArray<SizeEntry<T>>,
  measure: (size: T) => number,
  current: T,
  dir: 1 | -1
): T {
  const at = measure(current)
  const next = list
    .filter((row) => (measure(row.size) - at) * dir > EPS)
    .sort((a, b) => (measure(a.size) - measure(b.size)) * dir)[0]
  return next ? next.size : current
}

/**
 * The width a route started on a pad or via carries (R1, KiCad's connected
 * track width): of the tracks ending there, the one on the start layer whose
 * far end is nearest the cursor, else the narrowest on any layer.
 */
export function connectedTrackWidth(
  tracks: ReadonlyArray<{
    a: { x: number; y: number }
    b: { x: number; y: number }
    width: number
    layer: string
  }>,
  at: { x: number; y: number },
  layer: string,
  cursor: { x: number; y: number }
): number | null {
  const near = (p: { x: number; y: number }): boolean => Math.hypot(p.x - at.x, p.y - at.y) < EPS
  const joined = tracks.filter((t) => near(t.a) || near(t.b))
  if (joined.length === 0) return null
  const farEnd = (t: (typeof joined)[number]): { x: number; y: number } => (near(t.a) ? t.b : t.a)
  const onLayer = joined.filter((t) => t.layer === layer)
  if (onLayer.length > 0) {
    const d = (t: (typeof joined)[number]): number =>
      Math.hypot(farEnd(t).x - cursor.x, farEnd(t).y - cursor.y)
    return onLayer.reduce((best, t) => (d(t) < d(best) ? t : best)).width
  }
  return Math.min(...joined.map((t) => t.width))
}
