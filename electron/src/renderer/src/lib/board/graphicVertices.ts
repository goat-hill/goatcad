/**
 * The points a board graphic is reshaped by — where its handles sit, and what
 * dragging one does to the shape.
 *
 * Kept apart from both the scene that draws the handles and the editor that
 * commits the drag so the two read one table: a handle drawn at index `i` is
 * the point `moveShapeVertex(shape, i, …)` moves.
 *
 * Domain space throughout (integer nm, y down).
 */

import type { KicadBoard, KicadTuningPattern } from '../kicad/board'
import { nm, type Nm } from '../kicad/coordinates'
import type { PcbToolShape } from './pcbTools'

type Pt = { x: Nm; y: Nm }

/** A reshapable item's geometry, by the points its file node stores. */
export type VertexShape =
  | { kind: 'line'; start: Pt; end: Pt }
  | { kind: 'arc'; start: Pt; mid: Pt; end: Pt }
  | { kind: 'circle'; center: Pt; end: Pt }
  | { kind: 'rect'; start: Pt; end: Pt }
  | { kind: 'poly'; points: Pt[] }
  /**
   * A tuning pattern (router-behavior.md T4), by KiCad's four handles
   * (`PCB_TUNING_PATTERN::MakeEditPoints`): where its meanders start and end
   * along its base line, how far out and to which side they reach, and
   * their spacing, 1.5 spacings along from the amplitude handle. `base` is
   * the line the handles stand on as a polyline, an arc through its middle:
   * a pair's centerline, its tuned half's line being `tuned`. `reach` is how
   * far past the largest amplitude the amplitude handle sits, mm: KiCad's
   * half a track width, and a track width and the gap more on a pair.
   */
  | {
      kind: 'tuning'
      origin: Pt
      end: Pt
      amplitude: Pt
      spacing: Pt
      base: Pt[]
      reach: number
      tuned?: Pt[]
    }

/** Board item types that carry handles. A zone reshapes as the polygon it is. */
export const VERTEX_ITEM_TYPES = [
  'gr_line',
  'gr_arc',
  'gr_circle',
  'gr_rect',
  'gr_poly',
  'zone',
  'tuning_pattern'
] as const
export type VertexItemType = (typeof VERTEX_ITEM_TYPES)[number]

export const isVertexItemType = (type: string): type is VertexItemType =>
  (VERTEX_ITEM_TYPES as readonly string[]).includes(type)

const copy = (p: Pt): Pt => ({ x: p.x, y: p.y })

/** The shape of one board item, copied so a drag can work on it freely. */
export function boardVertexShape(
  board: KicadBoard,
  type: VertexItemType,
  index: number
): VertexShape | null {
  switch (type) {
    case 'gr_line': {
      const line = board.grLines[index]
      return line ? { kind: 'line', start: copy(line.start), end: copy(line.end) } : null
    }
    case 'gr_arc': {
      const arc = board.grArcs[index]
      return arc
        ? { kind: 'arc', start: copy(arc.start), mid: copy(arc.mid), end: copy(arc.end) }
        : null
    }
    case 'gr_circle': {
      const circle = board.grCircles[index]
      return circle ? { kind: 'circle', center: copy(circle.center), end: copy(circle.end) } : null
    }
    case 'gr_rect': {
      const rect = board.grRects[index]
      return rect ? { kind: 'rect', start: copy(rect.start), end: copy(rect.end) } : null
    }
    case 'gr_poly': {
      const poly = board.grPolys[index]
      return poly ? { kind: 'poly', points: poly.points.map(copy) } : null
    }
    case 'zone': {
      const zone = board.zones[index]
      return zone ? { kind: 'poly', points: zone.points.map(copy) } : null
    }
    case 'tuning_pattern': {
      const pattern = board.tuningPatterns[index]
      if (!pattern) return null
      const side = pattern.initialSide === 'right' ? -1 : 1
      const flat = (line: KicadTuningPattern['baseLine']): Pt[] =>
        line.flatMap((p) => (p.mid ? [copy(p.mid), copy(p)] : [copy(p)]))
      const own = flat(pattern.baseLine)
      const tuned = own.length >= 2 ? own : [copy(pattern.origin), copy(pattern.end)]
      const coupled = pattern.mode === 'diff_pair' ? flat(pattern.baseLineCoupled ?? []) : []
      const pair = coupled.length >= 2
      // A pair's handles stand between its halves, as KiCad's `centerlineOffset` puts them.
      const base = pair ? tuned.map((p) => midway(p, onBase(coupled, p).at)) : tuned
      const at = (p: Pt): Pt => (pair ? snapped(onBase(base, p).at) : copy(p))
      const origin = at(pattern.origin)
      const end = at(pattern.end)
      const w = pattern.lastTrackWidth
      const reach = w / 2 + (pair ? w + pattern.lastDiffPairGap : 0)
      const amplitude = amplitudePoint(base, origin, end, side * (pattern.maxAmplitude + reach))
      const along = baseDirection(base, origin, end)
      const spread = 1.5 * pattern.minSpacing * 1e6
      return {
        kind: 'tuning',
        origin,
        end,
        amplitude,
        spacing: { x: nm(amplitude.x + along.x * spread), y: nm(amplitude.y + along.y * spread) },
        base,
        reach,
        ...(pair ? { tuned } : {})
      }
    }
  }
}

const midway = (a: Pt, b: { x: number; y: number }): Pt => ({
  x: nm((a.x + b.x) / 2),
  y: nm((a.y + b.y) / 2)
})

const snapped = (p: { x: number; y: number }): Pt => ({ x: nm(p.x), y: nm(p.y) })

/**
 * The tuner's side +1, its stretch's left as the board is drawn (y up), in
 * the file's y-down terms: square to a → b.
 */
function leftNormal(a: Pt, b: Pt): { x: number; y: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { x: dy / len, y: -dx / len }
}

/**
 * The point of a polyline nearest `p`: where, its stretch, and how far along
 * the line. The line runs on past its two ends, onto the leads beyond the meanders.
 */
function onBase(
  base: readonly Pt[],
  p: Pt
): { at: { x: number; y: number }; i: number; s: number } {
  let best: { at: { x: number; y: number }; i: number; s: number; d: number } = {
    at: { x: base[0].x, y: base[0].y },
    i: 0,
    s: 0,
    d: Infinity
  }
  let run = 0
  for (let i = 0; i + 1 < base.length; i++) {
    const a = base[i]
    const b = base[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    const raw = len > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / (len * len) : 0
    const t = Math.min(i + 2 === base.length ? Infinity : 1, Math.max(i === 0 ? -Infinity : 0, raw))
    const at = { x: a.x + dx * t, y: a.y + dy * t }
    const d = Math.hypot(at.x - p.x, at.y - p.y)
    if (d < best.d) best = { at, i, s: run + len * t, d }
    run += len
  }
  return best
}

/** The point `s` along a polyline, and its stretch. */
function alongBase(base: readonly Pt[], s: number): { at: { x: number; y: number }; i: number } {
  let run = 0
  for (let i = 0; i + 1 < base.length; i++) {
    const a = base[i]
    const b = base[i + 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (s <= run + len || i + 2 === base.length) {
      const t = len > 0 ? Math.max(0, Math.min(1, (s - run) / len)) : 0
      return { at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, i }
    }
    run += len
  }
  return { at: { x: base[0].x, y: base[0].y }, i: 0 }
}

/** Halfway along the base line between the pattern's ends, and the stretch there. */
const baseMiddle = (
  base: readonly Pt[],
  origin: Pt,
  end: Pt
): { at: { x: number; y: number }; i: number } =>
  alongBase(base, (onBase(base, origin).s + onBase(base, end).s) / 2)

/**
 * Where the amplitude handle sits: halfway along the base line between the
 * ends, `reach` mm out to its left. **Differs from KiCad:** KiCad's stands
 * beside the base line's first point, which on a line that bends before the
 * meanders is off the pattern.
 */
function amplitudePoint(base: readonly Pt[], origin: Pt, end: Pt, reach: number): Pt {
  const mid = baseMiddle(base, origin, end)
  const n = leftNormal(base[mid.i], base[mid.i + 1])
  return { x: nm(mid.at.x + n.x * reach * 1e6), y: nm(mid.at.y + n.y * reach * 1e6) }
}

/** The unit direction of the base line's stretch at the pattern's middle, origin toward end. */
function baseDirection(base: readonly Pt[], origin: Pt, end: Pt): { x: number; y: number } {
  const { i } = baseMiddle(base, origin, end)
  const dx = base[i + 1].x - base[i].x
  const dy = base[i + 1].y - base[i].y
  const len = Math.hypot(dx, dy) || 1
  return { x: dx / len, y: dy / len }
}

/** KiCad's handles set an amplitude or a spacing in hundredths of a millimeter. */
const toHundredth = (mm: number): number => Math.round(mm * 100) / 100

/**
 * A tuning pattern's handles read back (`UpdateFromEditPoints`): its ends
 * (a pair's on its tuned half), its largest amplitude and first side, and its
 * spacing, mm.
 */
export function tuningFromShape(shape: Extract<VertexShape, { kind: 'tuning' }>): {
  origin: Pt
  end: Pt
  maxAmplitude: number
  side: 1 | -1
  spacing: number
} {
  const { base, tuned } = shape
  const mid = baseMiddle(base, shape.origin, shape.end)
  const n = leftNormal(base[mid.i], base[mid.i + 1])
  const along = baseDirection(base, shape.origin, shape.end)
  const off = ((shape.amplitude.x - mid.at.x) * n.x + (shape.amplitude.y - mid.at.y) * n.y) / 1e6
  const apart =
    ((shape.spacing.x - shape.amplitude.x) * along.x +
      (shape.spacing.y - shape.amplitude.y) * along.y) /
    1e6
  const onTuned = (p: Pt): Pt => (tuned ? snapped(onBase(tuned, p).at) : p)
  return {
    origin: onTuned(shape.origin),
    end: onTuned(shape.end),
    maxAmplitude: toHundredth(Math.max(0, Math.abs(off) - shape.reach)),
    side: off < 0 ? -1 : 1,
    spacing: toHundredth(Math.abs(apart) / 1.5)
  }
}

/**
 * Where a shape's handles sit, in handle-index order.
 *
 * A rectangle stores two corners and is reshaped by four: a designer pulls the
 * corner nearest the change, whichever pair the file happens to hold. They run
 * start → clockwise on screen: (sx, sy), (ex, sy), (ex, ey), (sx, ey).
 */
export function shapeVertices(shape: VertexShape): Pt[] {
  switch (shape.kind) {
    case 'line':
      return [shape.start, shape.end]
    case 'arc':
      return [shape.start, shape.mid, shape.end]
    case 'circle':
      return [shape.center, shape.end]
    case 'rect':
      return [
        shape.start,
        { x: shape.end.x, y: shape.start.y },
        shape.end,
        { x: shape.start.x, y: shape.end.y }
      ]
    case 'poly':
      return shape.points
    case 'tuning':
      return [shape.origin, shape.end, shape.amplitude, shape.spacing]
  }
}

/**
 * The shape with handle `vertex` moved by (dx, dy). Every handle moves the one
 * point it sits on, with one exception: a circle's center carries the rim point
 * with it, since dragging a center means "move the circle", not "resize it
 * from the far side".
 */
export function moveShapeVertex(shape: VertexShape, vertex: number, dx: Nm, dy: Nm): VertexShape {
  const moved = (p: Pt): Pt => ({ x: nm(p.x + dx), y: nm(p.y + dy) })
  switch (shape.kind) {
    case 'line':
      return vertex === 0
        ? { ...shape, start: moved(shape.start) }
        : { ...shape, end: moved(shape.end) }
    case 'arc':
      if (vertex === 0) return { ...shape, start: moved(shape.start) }
      if (vertex === 1) return { ...shape, mid: moved(shape.mid) }
      return { ...shape, end: moved(shape.end) }
    case 'circle':
      return vertex === 0
        ? { ...shape, center: moved(shape.center), end: moved(shape.end) }
        : { ...shape, end: moved(shape.end) }
    case 'rect': {
      // Corners 0 and 3 lie on start.x, 0 and 1 on start.y; the rest on end's.
      const onStartX = vertex === 0 || vertex === 3
      const onStartY = vertex === 0 || vertex === 1
      return {
        kind: 'rect',
        start: {
          x: onStartX ? nm(shape.start.x + dx) : shape.start.x,
          y: onStartY ? nm(shape.start.y + dy) : shape.start.y
        },
        end: {
          x: onStartX ? shape.end.x : nm(shape.end.x + dx),
          y: onStartY ? shape.end.y : nm(shape.end.y + dy)
        }
      }
    }
    case 'poly':
      return { kind: 'poly', points: shape.points.map((p, i) => (i === vertex ? moved(p) : p)) }
    case 'tuning': {
      // The spacing handle keeps its place beside the amplitude one, as KiCad re-seats it.
      if (vertex === 2)
        return { ...shape, amplitude: moved(shape.amplitude), spacing: moved(shape.spacing) }
      if (vertex === 3) return { ...shape, spacing: moved(shape.spacing) }
      // An end slides along the base line, round its bends, as KiCad's handles do.
      const { at } = onBase(shape.base, moved(vertex === 0 ? shape.origin : shape.end))
      const on = { x: nm(at.x), y: nm(at.y) }
      return vertex === 0 ? { ...shape, origin: on } : { ...shape, end: on }
    }
  }
}

/**
 * A rectangle dragged past its own opposite corner, put back in the
 * (min, min) → (max, max) order the rectangle tool writes.
 */
export function normalizedShape(shape: VertexShape): VertexShape {
  if (shape.kind !== 'rect') return shape
  const { start, end } = shape
  return {
    kind: 'rect',
    start: { x: nm(Math.min(start.x, end.x)), y: nm(Math.min(start.y, end.y)) },
    end: { x: nm(Math.max(start.x, end.x)), y: nm(Math.max(start.y, end.y)) }
  }
}

/** The shape as the tool pipeline draws it — what a drag's ghost is made of. */
export function vertexShapeGhost(shape: VertexShape): PcbToolShape {
  switch (shape.kind) {
    case 'line':
      return { kind: 'lines', segments: [{ start: shape.start, end: shape.end }] }
    case 'arc':
      return { kind: 'arc', start: shape.start, mid: shape.mid, end: shape.end }
    case 'circle':
      return { kind: 'circle', center: shape.center, end: shape.end }
    case 'rect': {
      const rect = normalizedShape(shape) as Extract<VertexShape, { kind: 'rect' }>
      return { kind: 'rect', start: rect.start, end: rect.end }
    }
    case 'poly':
      return { kind: 'poly', points: shape.points }
    case 'tuning': {
      // The base line between the ends, as it runs, the amplitude handle's reach off it, and the spacing.
      const { base, origin, end } = shape
      const a = onBase(base, origin)
      const b = onBase(base, end)
      const [lo, hi] = a.s <= b.s ? [a, b] : [b, a]
      const path: Pt[] = [
        { x: nm(lo.at.x), y: nm(lo.at.y) },
        ...base.slice(lo.i + 1, hi.i + 1),
        { x: nm(hi.at.x), y: nm(hi.at.y) }
      ]
      const middle = baseMiddle(base, origin, end).at
      return {
        kind: 'lines',
        segments: [
          ...path.slice(1).map((p, i) => ({ start: path[i], end: p })),
          { start: snapped(middle), end: shape.amplitude },
          { start: shape.amplitude, end: shape.spacing }
        ]
      }
    }
  }
}
