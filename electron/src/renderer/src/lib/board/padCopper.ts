/**
 * A pad's copper, all of it — the anchor shape AND the `(primitives …)` a
 * custom pad carries — as pieces the rest of the app can measure and draw.
 *
 * Every consumer before this resolved a pad to the rounded rect its `size`
 * describes and stopped there, which is most of a custom pad's copper missing:
 * a SOT-89's tab is 3.1 × 1.7 mm beside a 1.475 × 0.9 anchor. KiCad keeps the
 * whole shape instead (`PAD::MergePrimitivesAsPolygon`: anchor ∪ primitives
 * through Clipper, cached as `m_effectivePolygons`), and plotting, ODB++,
 * IPC-2581, the zone filler and DRC all read it. This is that, in two layers:
 *
 *   - `padCopperPieces` — the exact pieces, no boolean engine involved, for
 *     anything measuring distance to copper.
 *   - `padOutline` — those pieces unioned into one outline, for anything
 *     drawing them. Two shapes sharing an edge are two antialiased silhouettes
 *     composited over the background, and the background survives in the seam;
 *     one silhouette has no seam to survive in.
 *
 * Only a pad with primitives needs either (`padHasPrimitives`): an ordinary pad
 * IS its anchor, and drawing it as a polygon would trade the batch's analytic
 * edge for a tessellated one for nothing.
 *
 * Coordinates are the data space the scenes and the spatial index share:
 * millimetres, y up, with the pad's placement already applied. KiCad's
 * pad-local primitives are y down, which is the one flip this file performs.
 */

import type { KicadPad } from '../kicad/footprint'
import { nmToMm, type Nm } from '../kicad/coordinates'
import { pointToShape, type CopperShape, type Pt } from './spatialIndex'
import { shapeOutlines } from './shapeOutline'
import { distanceToSegment } from '../geometry/distance'
import { union, type ClipRegion } from '../geometry/clip'
import { isSolidFill } from '../kicad/footprint'

/** mm: what a primitive with no width of its own has always been drawn with. */
const DEFAULT_STROKE_MM = 0.1

/** Segments a sampled circle gets — `shapeOutline.ts`'s own quarter count × 4. */
const CIRCLE_SEGMENTS = 24

/**
 * One piece of a pad's copper. A `fill` is a polygon the boolean engine takes
 * as it stands; everything else is an exact `CopperShape`, which is what lets
 * clearance stay analytic (`shapeOutline.ts`) rather than sampled.
 */
export type PadPiece =
  { kind: 'shape'; shape: CopperShape } | { kind: 'fill'; points: Pt[]; holes?: Pt[][] }

/** The rounded rect a pad's own `size`/`shape` describes — its anchor. */
export const padAnchorShape = (pad: KicadPad, center: Pt, rotation: number): CopperShape => {
  const w = nmToMm(pad.size.w)
  const h = nmToMm(pad.size.h)
  const halfW = w / 2
  let halfH = h / 2
  let cornerR = 0
  // A custom pad's `size` describes its ANCHOR, whose shape comes from
  // `(options (anchor …))` and is a circle when the pad names none.
  if (pad.shape === 'circle' || (pad.shape === 'custom' && pad.anchor !== 'rect')) {
    halfH = halfW
    cornerR = halfW
  } else if (pad.shape === 'oval') {
    cornerR = Math.min(halfW, halfH)
  } else if (pad.shape === 'roundrect' || pad.roundrectRatio) {
    // KiCad's rratio is a fraction of the SHORTER side.
    cornerR = Math.min(w, h) * (pad.roundrectRatio ?? 0.25)
  }
  return { kind: 'rrect', cx: center.x, cy: center.y, halfW, halfH, cornerR, rotation }
}

/** Whether a pad is more than its anchor — the only pads worth merging. */
export const padHasPrimitives = (pad: KicadPad): boolean => {
  const p = pad.primitives
  if (!p) return false
  return p.polys.length + p.rects.length + p.lines.length + p.circles.length + p.arcs.length > 0
}

/** A sampled circle, CCW, first point not repeated. */
const circleRing = (cx: number, cy: number, r: number): Pt[] =>
  Array.from({ length: CIRCLE_SEGMENTS }, (_, i) => {
    const a = (2 * Math.PI * i) / CIRCLE_SEGMENTS
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })

/**
 * Every piece of copper the pad owns, placed.
 *
 * A primitive's `(width w)` applies to a FILLED shape too — KiCad draws the
 * polygon and strokes its outline, so a 2 × 1 filled rect at width 0.2 comes
 * back 2.2 × 1.2 — which is why a filled piece with a width yields both its
 * fill and a capsule per edge. The reading is `lib/gerber/write.ts`'s, taken
 * from KiCad's own aperture macros.
 */
export const padCopperPieces = (pad: KicadPad, center: Pt, rotation: number): PadPiece[] => {
  const pieces: PadPiece[] = [{ kind: 'shape', shape: padAnchorShape(pad, center, rotation) }]
  const prims = pad.primitives
  if (!prims) return pieces

  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  // Pad-local nm, y down → data space mm, y up, at the pad's placement.
  const at = (x: Nm, y: Nm): Pt => {
    const lx = nmToMm(x)
    const ly = -nmToMm(y)
    return { x: center.x + lx * cos - ly * sin, y: center.y + lx * sin + ly * cos }
  }
  const halfOf = (width: Nm | undefined, fallback = 0): number =>
    width !== undefined ? nmToMm(width) / 2 : fallback
  const stroke = (a: Pt, b: Pt, halfWidth: number): void => {
    if (halfWidth <= 0) return
    pieces.push({
      kind: 'shape',
      shape: { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth }
    })
  }
  const strokeRing = (points: Pt[], halfWidth: number): void => {
    for (let i = 0; i < points.length; i++) {
      stroke(points[i], points[(i + 1) % points.length], halfWidth)
    }
  }

  for (const poly of prims.polys) {
    if (poly.points.length < 2) continue
    const points = poly.points.map((p) => at(p.x, p.y))
    if (isSolidFill(poly.fill) && points.length >= 3) pieces.push({ kind: 'fill', points })
    strokeRing(points, halfOf(poly.strokeWidth))
  }

  for (const rect of prims.rects) {
    const corners = [
      at(rect.start.x, rect.start.y),
      at(rect.end.x, rect.start.y),
      at(rect.end.x, rect.end.y),
      at(rect.start.x, rect.end.y)
    ]
    if (isSolidFill(rect.fill)) pieces.push({ kind: 'fill', points: corners })
    strokeRing(corners, halfOf(rect.strokeWidth))
  }

  for (const line of prims.lines) {
    stroke(
      at(line.start.x, line.start.y),
      at(line.end.x, line.end.y),
      halfOf(line.strokeWidth, DEFAULT_STROKE_MM / 2)
    )
  }

  for (const circle of prims.circles) {
    const c = at(circle.center.x, circle.center.y)
    const edge = at(circle.end.x, circle.end.y)
    const r = Math.hypot(edge.x - c.x, edge.y - c.y)
    if (r <= 0) continue
    const halfWidth = halfOf(circle.strokeWidth, DEFAULT_STROKE_MM / 2)
    if (isSolidFill(circle.fill)) {
      // Filled, plus its own outline: one disc of r + halfWidth says both.
      pieces.push({ kind: 'shape', shape: { kind: 'circle', cx: c.x, cy: c.y, r: r + halfWidth } })
    } else if (r - halfWidth > 0) {
      // A ring is the stroke alone, so the middle is not copper — a hole the
      // union has to keep, or an unfilled circle would plate its own center.
      pieces.push({
        kind: 'fill',
        points: circleRing(c.x, c.y, r + halfWidth),
        holes: [circleRing(c.x, c.y, r - halfWidth).reverse()]
      })
    } else {
      pieces.push({ kind: 'shape', shape: { kind: 'circle', cx: c.x, cy: c.y, r: r + halfWidth } })
    }
  }

  for (const arc of prims.arcs) {
    const a = at(arc.start.x, arc.start.y)
    const m = at(arc.mid.x, arc.mid.y)
    const b = at(arc.end.x, arc.end.y)
    pieces.push({
      kind: 'shape',
      shape: {
        kind: 'arc',
        x0: a.x,
        y0: a.y,
        mx: m.x,
        my: m.y,
        x1: b.x,
        y1: b.y,
        halfWidth: halfOf(arc.strokeWidth, DEFAULT_STROKE_MM / 2)
      }
    })
  }

  return pieces
}

/**
 * The pad's copper as one outline, holes and all — KiCad's merged pad polygon.
 * Null for a pad with no copper, or one whose pieces will not merge.
 */
export const padOutline = (pieces: readonly PadPiece[]): ClipRegion[] | null => {
  const regions: ClipRegion[] = []
  for (const piece of pieces) {
    if (piece.kind === 'fill') {
      regions.push({ outer: piece.points, holes: piece.holes ?? [] })
      continue
    }
    for (const ring of shapeOutlines(piece.shape, 0)) regions.push({ outer: ring, holes: [] })
  }
  if (regions.length === 0) return null
  try {
    const merged = union(regions, [])
    return merged.length ? merged : null
  } catch {
    return null
  }
}

/**
 * Edge separation from a point to the pad's copper — 0 on or inside it.
 *
 * The pieces, not the merged outline: each piece answers exactly (a capsule is
 * a capsule, not a sampled polygon), the minimum over them is the distance to
 * their union, and nothing here needs the boolean engine to have loaded.
 */
export const padPointDistance = (pieces: readonly PadPiece[], x: number, y: number): number => {
  let best = Infinity
  for (const piece of pieces) {
    if (piece.kind === 'shape') {
      best = Math.min(best, pointToShape(piece.shape, x, y))
    } else {
      best = Math.min(best, pointToPolygon(piece.points, piece.holes ?? [], x, y))
    }
    if (best <= 0) return 0
  }
  return best
}

/** 0 inside the ring and outside its holes, else the distance to the nearest edge. */
const pointToPolygon = (
  outer: readonly Pt[],
  holes: readonly Pt[][],
  x: number,
  y: number
): number => {
  let best = edgeDistance(outer, x, y)
  for (const hole of holes) best = Math.min(best, edgeDistance(hole, x, y))
  if (!contains(outer, x, y)) return best
  for (const hole of holes) if (contains(hole, x, y)) return best
  return 0
}

const edgeDistance = (ring: readonly Pt[], x: number, y: number): number => {
  let best = Infinity
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, distanceToSegment({ x, y }, ring[i], ring[(i + 1) % ring.length]))
  }
  return best
}

/** Crossing count, winding-agnostic — the rings here come from KiCad and Clipper alike. */
const contains = (ring: readonly Pt[], x: number, y: number): boolean => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
