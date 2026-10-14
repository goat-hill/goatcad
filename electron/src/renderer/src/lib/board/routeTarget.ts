/**
 * Which copper the cursor means to a route, and where on it it connects
 * (router-behavior.md R28–R30): the target a route starts on, and the one it
 * arrives at. Pure — the viewport supplies what the person can point at and
 * the grid.
 */

import { arcContainsMidCCW, circumscribedCircle } from '../engine/arcGeometry'
import { shapeCenter, type CopperItem, type CopperShape, type NearHit } from './spatialIndex'

export interface Pt {
  x: number
  y: number
}

export interface RouteTargetOptions {
  /** How far off copper the cursor may be and still mean it, from its outline (mm): KiCad's, the grid step. */
  reach: number
  /** Mid-route, the layer being routed: only copper on it is a target (R30). */
  layer?: string
  /** The active layer, whose copper outranks other layers' (R28). */
  activeLayer?: string
  /** The layers of an item the person can point at — none on a hidden or dimmed-away layer. */
  pointable: (item: CopperItem) => readonly string[]
  /** The grid point nearest a point, or null with the grid off. */
  grid: (p: Pt) => Pt | null
}

export interface RouteTarget {
  item: CopperItem
  /** Where the route connects to it (R29). */
  point: Pt
  /** Its layers the person can point at. */
  layers: readonly string[]
}

const isTrack = (item: CopperItem): boolean =>
  item.ref.type === 'segment' || item.ref.type === 'tarc'

/**
 * How far the cursor is from what picks an item among its rank (KiCad's
 * `pickSingleItem`): a pad's or via's center, a track's nearer end.
 */
const pickDistance = (item: CopperItem, cursor: Pt): number => {
  const s = item.shape
  if (isTrack(item) && (s.kind === 'capsule' || s.kind === 'arc'))
    return Math.min(
      Math.hypot(cursor.x - s.x0, cursor.y - s.y0),
      Math.hypot(cursor.x - s.x1, cursor.y - s.y1)
    )
  const c = item.anchor ?? shapeCenter(s)
  return Math.hypot(cursor.x - c.x, cursor.y - c.y)
}

/**
 * The target among `hits` (copper near the cursor, with its distance from
 * the outline: 0 when the cursor is on it), as KiCad picks it (R28): copper
 * under the cursor outranks copper near it; among either, the active layer's
 * pad or via, then its track, then another layer's pad or via, then its
 * track; within a rank, the nearest center or track end.
 */
export function routeTarget(
  hits: readonly NearHit[],
  cursor: Pt,
  opts: RouteTargetOptions
): RouteTarget | null {
  const candidates = hits.flatMap((hit) => {
    const layers = opts.pointable(hit.item)
    if (layers.length === 0) return []
    if (opts.layer !== undefined && !hit.item.layers.includes(opts.layer)) return []
    if (hit.dist > opts.reach) return []
    return [{ ...hit, layers, pick: pickDistance(hit.item, cursor) }]
  })
  const under = candidates.filter((c) => c.dist === 0)
  const pool = under.length > 0 ? under : candidates
  const rank = (c: (typeof pool)[number]): number => {
    const offActive =
      opts.activeLayer !== undefined && !c.item.layers.includes(opts.activeLayer) ? 2 : 0
    return offActive + (isTrack(c.item) ? 1 : 0)
  }
  let best: (typeof pool)[number] | null = null
  for (const c of pool) {
    if (!best || rank(c) < rank(best) || (rank(c) === rank(best) && c.pick < best.pick)) best = c
  }
  if (!best) return null
  return { item: best.item, point: entryPoint(best.item, cursor, opts.grid), layers: best.layers }
}

/**
 * A grid-snapped pointer held to the route start's axes (R47): each
 * coordinate of `grid` (the grid point nearest `raw`) takes `start`'s where
 * that is nearer `raw`. KiCad's router sets its grid helper's aux axes at the
 * start snap point (`GRID_HELPER::Align`), so a route from an off-grid pad
 * runs straight out along its axis.
 */
export function alignToStartAxes(raw: Pt, grid: Pt, start: Pt | null): Pt {
  if (!start) return grid
  return {
    x: Math.abs(start.x - raw.x) < Math.abs(grid.x - raw.x) ? start.x : grid.x,
    y: Math.abs(start.y - raw.y) < Math.abs(grid.y - raw.y) ? start.y : grid.y
  }
}

/**
 * Where a route enters an item (R29): a pad at its position, a via at its
 * center, a track at its end when the cursor is within its half width of it,
 * else where the grid crosses its centerline nearest the cursor.
 */
export function entryPoint(item: CopperItem, cursor: Pt, grid: (p: Pt) => Pt | null): Pt {
  const s = item.shape
  if (item.anchor) return item.anchor
  if (s.kind === 'capsule' || s.kind === 'arc') {
    const a = { x: s.x0, y: s.y0 }
    const b = { x: s.x1, y: s.y1 }
    for (const end of [a, b]) {
      if (Math.hypot(cursor.x - end.x, cursor.y - end.y) <= s.halfWidth) return end
    }
    const g = grid(cursor)
    const crossings =
      s.kind === 'capsule'
        ? g
          ? segmentGridCrossings(a, b, g)
          : []
        : g
          ? arcGridCrossings(s, g)
          : []
    const options = crossings.length > 0 ? [...crossings, a, b] : [nearestOnCenterline(s, cursor)]
    return nearest(options, cursor)
  }
  return shapeCenter(s)
}

const nearest = (points: readonly Pt[], to: Pt): Pt =>
  points.reduce((best, p) =>
    Math.hypot(p.x - to.x, p.y - to.y) < Math.hypot(best.x - to.x, best.y - to.y) ? p : best
  )

/** The four lines through a grid point a route may run along: its row, its column and both diagonals. */
const gridLines = (g: Pt): Array<{ p: Pt; d: Pt }> => [
  { p: g, d: { x: 1, y: 0 } },
  { p: g, d: { x: 0, y: 1 } },
  { p: g, d: { x: 1, y: 1 } },
  { p: g, d: { x: 1, y: -1 } }
]

/** Where the lines through `g` cross the segment a→b. */
export function segmentGridCrossings(a: Pt, b: Pt, g: Pt): Pt[] {
  const out: Pt[] = []
  const ex = b.x - a.x
  const ey = b.y - a.y
  for (const { p, d } of gridLines(g)) {
    const denom = ex * d.y - ey * d.x
    if (Math.abs(denom) < 1e-12) continue
    const t = ((p.x - a.x) * d.y - (p.y - a.y) * d.x) / denom
    if (t < 0 || t > 1) continue
    out.push({ x: a.x + t * ex, y: a.y + t * ey })
  }
  return out
}

type ArcLike = { x0: number; y0: number; mx: number; my: number; x1: number; y1: number }

/** The arc's circle and a test for whether a point's direction lies in its sweep; null when straight. */
function arcCircle(
  s: ArcLike
): { cx: number; cy: number; r: number; within: (p: Pt) => boolean } | null {
  const c = circumscribedCircle(s.x0, s.y0, s.mx, s.my, s.x1, s.y1)
  if (!c) return null
  const start = { x: s.x0, y: s.y0 }
  const mid = { x: s.mx, y: s.my }
  const end = { x: s.x1, y: s.y1 }
  const ccw = arcContainsMidCCW(start, mid, end, c.cx, c.cy)
  const [from, to] = ccw ? [start, end] : [end, start]
  const turn = (p: Pt): number => {
    const t =
      (Math.atan2(p.y - c.cy, p.x - c.cx) - Math.atan2(from.y - c.cy, from.x - c.cx)) %
      (2 * Math.PI)
    return t < 0 ? t + 2 * Math.PI : t
  }
  const sweep = turn(to)
  return { ...c, within: (p) => turn(p) <= sweep + 1e-12 }
}

/** Where the lines through `g` cross an arc's centerline. */
export function arcGridCrossings(s: ArcLike, g: Pt): Pt[] {
  const circle = arcCircle(s)
  if (!circle) return segmentGridCrossings({ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 }, g)
  const out: Pt[] = []
  for (const { p, d } of gridLines(g)) {
    // |p + t·d − c|² = r²
    const fx = p.x - circle.cx
    const fy = p.y - circle.cy
    const A = d.x * d.x + d.y * d.y
    const B = 2 * (fx * d.x + fy * d.y)
    const C = fx * fx + fy * fy - circle.r * circle.r
    const disc = B * B - 4 * A * C
    if (disc < 0) continue
    for (const sign of [-1, 1]) {
      const t = (-B + sign * Math.sqrt(disc)) / (2 * A)
      const q = { x: p.x + t * d.x, y: p.y + t * d.y }
      if (circle.within(q)) out.push(q)
    }
  }
  return out
}

/** The point of a track's centerline nearest `p`, for a grid that is off. */
function nearestOnCenterline(s: Extract<CopperShape, { kind: 'capsule' | 'arc' }>, p: Pt): Pt {
  const a = { x: s.x0, y: s.y0 }
  const b = { x: s.x1, y: s.y1 }
  const circle = s.kind === 'arc' ? arcCircle(s) : null
  if (circle) {
    const len = Math.hypot(p.x - circle.cx, p.y - circle.cy)
    if (len > 0) {
      const q = {
        x: circle.cx + ((p.x - circle.cx) / len) * circle.r,
        y: circle.cy + ((p.y - circle.cy) / len) * circle.r
      }
      if (circle.within(q)) return q
    }
    return nearest([a, b], p)
  }
  const ex = b.x - a.x
  const ey = b.y - a.y
  const len2 = ex * ex + ey * ey
  if (len2 === 0) return a
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2))
  return { x: a.x + t * ex, y: a.y + t * ey }
}
