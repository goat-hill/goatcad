/**
 * Copper shapes → clearance-inflated polygon outlines, for the zone fill
 * engine's boolean pipeline (and, in time, DRC's).
 *
 * This is the one polygonization layer (pcb-editor-workstream.md): the
 * spatial index's exact shapes rendered as polygons, analytically inflated —
 * a capsule grown by `c` is a capsule of radius+c, a rounded rect grows its
 * corner radius — so obstacle clearance needs no generic polygon offsetting.
 *
 * All curved outlines are sampled with the radius pushed OUT to the sampled
 * polygon's circumscribed circle (`r / cos(π/n)` per full turn of n
 * segments), so the polygon always contains the true shape: clearance
 * cuts err on the safe side, never the optimistic one.
 */

import type { CopperShape } from './spatialIndex'
import { sampleArc } from './spatialIndex'

export interface Pt {
  x: number
  y: number
}

/** Segments per quarter turn on sampled caps/corners. */
const SEGS_PER_QUARTER = 6

/** Radius correction so the sampled polygon circumscribes the true arc. */
const overApprox = (r: number, segsPerTurn: number): number =>
  r <= 0 ? r : r / Math.cos(Math.PI / segsPerTurn)

/** Points along a CCW arc about (cx,cy) from a0 to a1 (radians, a1 > a0). */
const arcPoints = (
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  segments: number
): Pt[] => {
  const pts: Pt[] = []
  for (let i = 0; i <= segments; i++) {
    const a = a0 + ((a1 - a0) * i) / segments
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

/**
 * Segments for a full turn of radius `r`: with a `maxError`, as KiCad counts
 * them (`GetArcToSegmentCount`: each chord strays at most that far, rounded up
 * to a multiple of 8, never under 16); else a fixed 24.
 */
export function segmentsPerTurn(r: number, maxError?: number): number {
  if (!maxError || r <= maxError) return SEGS_PER_QUARTER * 4
  const step = 2 * Math.acos(1 - maxError / r)
  const count = Math.max(16, Math.ceil((2 * Math.PI) / step))
  return Math.min(Math.ceil(count / 8) * 8, 720)
}

/**
 * A round cap or corner about (cx,cy) from `a0` sweeping `sweep` (CCW) in
 * `segs` chords that never cut inside the arc, as KiCad's ERROR_OUTSIDE draws
 * it: the ends on the arc itself, so the straight sides meeting them stay
 * exact, and between them vertices pushed out so each chord is tangent to it.
 */
const tangentArc = (
  cx: number,
  cy: number,
  r: number,
  a0: number,
  sweep: number,
  segs: number
): Pt[] => {
  if (r <= 0) return [{ x: cx, y: cy }]
  const step = sweep / segs
  const out = r / Math.cos(step / 2)
  const pts: Pt[] = [{ x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) }]
  for (let k = 0; k < segs; k++) {
    const a = a0 + (k + 0.5) * step
    pts.push({ x: cx + out * Math.cos(a), y: cy + out * Math.sin(a) })
  }
  const a1 = a0 + sweep
  pts.push({ x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) })
  return pts
}

/** Outline of a segment grown to radius `r` — a stadium/capsule polygon. */
export function capsuleOutline(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  maxError?: number
): Pt[] {
  const turn = segmentsPerTurn(r, maxError)
  const segs = turn / 2 // per semicircular cap
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) {
    return arcPoints(x0, y0, overApprox(r, turn), 0, 2 * Math.PI, turn).slice(0, -1)
  }
  const angle = Math.atan2(dy, dx)
  const capA = tangentArc(x1, y1, r, angle - Math.PI / 2, Math.PI, segs)
  const capB = tangentArc(x0, y0, r, angle + Math.PI / 2, Math.PI, segs)
  return [...capA, ...capB]
}

/**
 * Outline of `shape`'s copper inflated by `inflate` (≥ 0). Arcs decompose to
 * a sampled centerline whose steps each grow a capsule — the caller unions
 * rings through the boolean engine anyway, so overlap between steps is free.
 * Returns one or more rings. `maxError` (mm) sets how finely curves are cut,
 * as KiCad cuts them; without it, a fixed 24 segments a turn.
 */
export function shapeOutlines(shape: CopperShape, inflate: number, maxError?: number): Pt[][] {
  switch (shape.kind) {
    case 'circle': {
      const segs = segmentsPerTurn(shape.r + inflate, maxError)
      const r = overApprox(shape.r + inflate, segs)
      return [arcPoints(shape.cx, shape.cy, r, 0, 2 * Math.PI, segs).slice(0, -1)]
    }
    case 'capsule':
      return [
        capsuleOutline(shape.x0, shape.y0, shape.x1, shape.y1, shape.halfWidth + inflate, maxError)
      ]
    case 'rrect': {
      // Grow the corner radius with the shape: the Minkowski sum of a rounded
      // rect and a disc is exactly that. cornerR 0 still gets the inflation's
      // own rounding, which is the true inflated outline of a sharp corner.
      const r = shape.cornerR + inflate
      const segs = segmentsPerTurn(r, maxError) / 4
      const hx = shape.halfW - shape.cornerR
      const hy = shape.halfH - shape.cornerR
      // CCW: each corner's quarter arc starts where the previous side ended.
      const corners: Array<[number, number, number]> = [
        [hx, hy, 0],
        [-hx, hy, Math.PI / 2],
        [-hx, -hy, Math.PI],
        [hx, -hy, (3 * Math.PI) / 2]
      ]
      const local: Pt[] = []
      for (const [cx, cy, a0] of corners)
        local.push(...tangentArc(cx, cy, r, a0, Math.PI / 2, segs))
      const cos = Math.cos(shape.rotation)
      const sin = Math.sin(shape.rotation)
      return [
        local.map((p) => ({
          x: shape.cx + p.x * cos - p.y * sin,
          y: shape.cy + p.x * sin + p.y * cos
        }))
      ]
    }
    case 'arc': {
      // The arc as KiCad's filler reads it (`arcCentralSweep`).
      const pts = sampleArc(
        shape.x0,
        shape.y0,
        shape.mx,
        shape.my,
        shape.x1,
        shape.y1,
        maxError ? undefined : 16,
        true
      )
      const rings: Pt[][] = []
      for (let i = 0; i < pts.length - 1; i++) {
        rings.push(
          capsuleOutline(
            pts[i].x,
            pts[i].y,
            pts[i + 1].x,
            pts[i + 1].y,
            shape.halfWidth + inflate,
            maxError
          )
        )
      }
      return rings
    }
    case 'poly': {
      // The outline itself, and each edge grown into a capsule: the caller
      // unions them, which is the polygon inflated. A hole comes back filled —
      // an obstacle is kept whole, never poured into.
      const rings: Pt[][] = shape.rings.map((ring) => [...ring])
      if (inflate > 0)
        for (const ring of shape.rings)
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
            rings.push(
              capsuleOutline(ring[j].x, ring[j].y, ring[i].x, ring[i].y, inflate, maxError)
            )
      return rings
    }
    case 'compound':
      return shape.parts.flatMap((part) => shapeOutlines(part, inflate, maxError))
  }
}

/** An axis-arbitrary rectangle: center, half extents, rotation (radians). */
export function rotatedRectOutline(
  cx: number,
  cy: number,
  halfLen: number,
  halfWid: number,
  rotation: number
): Pt[] {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const corner = (x: number, y: number): Pt => ({
    x: cx + x * cos - y * sin,
    y: cy + x * sin + y * cos
  })
  return [
    corner(halfLen, halfWid),
    corner(-halfLen, halfWid),
    corner(-halfLen, -halfWid),
    corner(halfLen, -halfWid)
  ]
}
