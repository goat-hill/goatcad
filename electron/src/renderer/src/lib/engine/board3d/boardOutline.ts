/**
 * The board outline: `Edge.Cuts` graphics → extrudable regions.
 *
 * KiCad does not store the board shape as a polygon. It stores whatever lines,
 * arcs, circles, rectangles and polygons the designer drew on `Edge.Cuts`, in
 * no particular order and pointing in no particular direction, and the outline
 * is whatever closed rings those pieces happen to form. Recovering the rings is
 * therefore the first thing any 3D view of a board has to do, and it is also
 * the part most likely to meet a file that does not quite close — hence the
 * tolerance, and hence `fallback`, which reports that no ring was found rather
 * than rendering nothing at all.
 *
 * Output is world space (millimeters, y-up); see `kicad/placement.ts`.
 */

import type { KicadBoard } from '../../kicad/board'
import type {
  KicadFpArc,
  KicadFpCircle,
  KicadFpCurve,
  KicadFpLine,
  KicadFpPoly,
  KicadFpRect
} from '../../kicad/footprint'
import {
  footprintTransform,
  tfPoint,
  worldPoint,
  type FpTransform
} from '../../schematic/placement'
import type { Nm } from '../../kicad/coordinates'
import { rectOutline } from '../../kicad/footprint'
import { arcPolyline } from '../arcGeometry'
import { pointInPolygon, signedArea, type Pt } from './flatMesh'

export const EDGE_CUTS = 'Edge.Cuts'

/** How far apart two edge endpoints may be and still count as the same corner. */
const JOIN_TOLERANCE_MM = 0.01

/** Segments in a tessellated `Edge.Cuts` circle — board corners read as curves. */
const CIRCLE_SEGMENTS = 64

/** One extrudable piece of board: an outer ring and the cutouts inside it. */
export interface OutlineRegion {
  outer: Pt[]
  holes: Pt[][]
}

export interface BoardOutline {
  regions: OutlineRegion[]
  /**
   * True when no closed ring could be built and `regions` is a bounding box
   * standing in for one. Callers surface this — a board rendered at the wrong
   * shape with no explanation is worse than one that says why.
   */
  fallback: boolean
  /** Rings that were left open, for the same reason. */
  openCount: number
  /** Pairs of Edge.Cuts segments that cross, between contours or within one: KiCad's self-intersection. */
  crossings: number
}

/** Steps along a cubic Bézier edge: its ends exact, as chaining needs, the curve within a few µm. */
const BEZIER_STEPS = 32

/** A cubic Bézier (start, two controls, end) as points along it, both ends included. */
export function bezierPoints([p0, p1, p2, p3]: readonly [Pt, Pt, Pt, Pt]): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i <= BEZIER_STEPS; i++) {
    const t = i / BEZIER_STEPS
    const u = 1 - t
    const a = u * u * u
    const b = 3 * u * u * t
    const c = 3 * u * t * t
    const d = t * t * t
    out.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    })
  }
  return out
}

/**
 * A piece of outline to chain, by its two ends: a line, or an arc or stroke
 * carrying the points between them. Shapes join end to end, as KiCad chains
 * them — never chord by chord, where an arc's last short chord would have
 * both its ends within the join tolerance.
 */
export type Edge = [Pt, Pt] | [Pt, Pt, Pt[]]

const isEdgeCuts = (layer: string | undefined): boolean => layer === EDGE_CUTS

/**
 * Every `Edge.Cuts` piece as either a ready-made ring (circle, rect, polygon)
 * or a loose edge to be chained (line, arc). Exported for the tests.
 */
export function collectEdgeCutsGeometry(board: KicadBoard): { rings: Pt[][]; edges: Edge[] } {
  const rings: Pt[][] = []
  const edges: Edge[] = []

  // A footprint-level Edge.Cuts graphic defines board shape too — mounting-hole
  // and board-outline footprints are how many designs carry their edge.
  const addGraphics = (
    lines: readonly KicadFpLine[],
    arcs: readonly KicadFpArc[],
    circles: readonly KicadFpCircle[],
    rects: readonly KicadFpRect[],
    polys: readonly KicadFpPoly[],
    curves: readonly KicadFpCurve[],
    tf: FpTransform | null
  ): void => {
    const at = (p: { x: Nm; y: Nm }): Pt => (tf ? tfPoint(tf, p.x, p.y) : worldPoint(p))

    for (const line of lines) {
      if (!isEdgeCuts(line.layer)) continue
      edges.push([at(line.start), at(line.end)])
    }
    for (const arc of arcs) {
      if (!isEdgeCuts(arc.layer)) continue
      const points = arcPolyline(at(arc.start), at(arc.mid), at(arc.end), CIRCLE_SEGMENTS)
      if (points.length >= 2) edges.push([points[0], points[points.length - 1], points])
    }
    for (const circle of circles) {
      if (!isEdgeCuts(circle.layer)) continue
      const center = at(circle.center)
      const edge = at(circle.end)
      const r = Math.hypot(edge.x - center.x, edge.y - center.y)
      if (r <= 0) continue
      const ring: Pt[] = []
      for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2
        ring.push({ x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) })
      }
      rings.push(ring)
    }
    for (const rect of rects) {
      if (!isEdgeCuts(rect.layer)) continue
      const outline = rectOutline(rect)
      const on = (p: { x: number; y: number }): Pt => at(p as { x: Nm; y: Nm })
      if (outline.kind === 'corners') {
        rings.push(outline.corners.map(on))
        continue
      }
      // Rounded corners: each quarter arc as chords; the sides join one arc's end to the next's start.
      const ring: Pt[] = []
      for (const arc of outline.arcs) {
        ring.push(...arcPolyline(on(arc.start), on(arc.mid), on(arc.end), CIRCLE_SEGMENTS / 4))
      }
      rings.push(ring)
    }
    for (const poly of polys) {
      if (!isEdgeCuts(poly.layer) || poly.points.length < 3) continue
      rings.push(poly.points.map(at))
    }
    for (const curve of curves) {
      if (!isEdgeCuts(curve.layer) || curve.points.length !== 4) continue
      const points = bezierPoints(curve.points.map(at) as [Pt, Pt, Pt, Pt])
      edges.push([points[0], points[points.length - 1], points])
    }
  }

  addGraphics(
    board.grLines,
    board.grArcs,
    board.grCircles,
    board.grRects,
    board.grPolys,
    board.grCurves,
    null
  )
  for (const bfp of board.footprints) {
    const fp = bfp.footprint
    addGraphics(
      fp.fpLines,
      fp.fpArcs,
      fp.fpCircles,
      fp.fpRects,
      fp.fpPolys,
      fp.fpCurves,
      footprintTransform(bfp)
    )
  }

  return { rings, edges }
}

/**
 * Chain loose edges into closed rings.
 *
 * Endpoints are bucketed on a grid of the join tolerance so a corner shared by
 * two segments is found without comparing every endpoint to every other — the
 * outline of a routed board can run to thousands of arc-tessellation edges.
 */
export function chainEdges(
  edges: readonly Edge[],
  tolerance = JOIN_TOLERANCE_MM
): { rings: Pt[][]; open: Pt[][] } {
  const rings: Pt[][] = []
  const open: Pt[][] = []
  if (edges.length === 0) return { rings, open }

  const key = (p: Pt): string => `${Math.round(p.x / tolerance)},${Math.round(p.y / tolerance)}`

  /** Endpoint bucket → the indices of the edges that touch it. */
  const buckets = new Map<string, number[]>()
  const push = (p: Pt, index: number): void => {
    const k = key(p)
    const list = buckets.get(k)
    if (list) list.push(index)
    else buckets.set(k, [index])
  }
  edges.forEach((edge, index) => {
    push(edge[0], index)
    push(edge[1], index)
  })

  // Exactly the bucket size: two points closer than this can land at most one
  // bucket apart on either axis, which is what makes the ±1 neighbor scan below
  // an exhaustive search rather than a heuristic.
  const near = (a: Pt, b: Pt): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance

  const used = new Array<boolean>(edges.length).fill(false)

  /** An unused edge with an endpoint at `p`, and the points it adds walking away from `p`. */
  const takeNext = (p: Pt): { index: number; points: Pt[]; distance: number } | null => {
    // A point can land on either side of a bucket boundary, so the neighbors
    // are checked too — cheaper than a spatial index and exact enough here.
    // The nearest end within tolerance, as KiCad picks it: a piece shorter than
    // the tolerance has both ends in reach, and the far one is the wrong one.
    const kx = Math.round(p.x / tolerance)
    const ky = Math.round(p.y / tolerance)
    let best: { index: number; reversed: boolean; distance: number } | null = null
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const index of buckets.get(`${kx + dx},${ky + dy}`) ?? []) {
          if (used[index]) continue
          const [a, b] = edges[index]
          const da = Math.hypot(a.x - p.x, a.y - p.y)
          const db = Math.hypot(b.x - p.x, b.y - p.y)
          const distance = Math.min(da, db)
          if (distance > tolerance || (best && best.distance <= distance)) continue
          best = { index, reversed: db < da, distance }
        }
      }
    }
    if (!best) return null
    const [a, b, path] = edges[best.index]
    const forward = path ?? [a, b]
    return {
      index: best.index,
      points: best.reversed ? [...forward].reverse().slice(1) : forward.slice(1),
      distance: best.distance
    }
  }

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue
    used[start] = true
    const [from, to, through] = edges[start]
    const path: Pt[] = through ? [...through] : [from, to]
    let head = to
    for (;;) {
      // Close back on the start only when no unused piece is nearer.
      const step = takeNext(head)
      const closing = path.length > 2 && near(head, path[0])
      if (closing && (!step || step.distance >= Math.hypot(head.x - path[0].x, head.y - path[0].y)))
        break
      if (!step) break
      used[step.index] = true
      path.push(...step.points)
      head = path[path.length - 1]
    }
    if (path.length > 3 && near(head, path[0])) {
      // Drop the duplicated closing point; a ring is implicitly closed.
      rings.push(path.slice(0, -1))
    } else if (path.length >= 2) {
      open.push(path)
    }
  }

  return { rings, open }
}

/**
 * Nest rings into regions: a ring inside an odd number of others is a cutout of
 * the one directly containing it, anything else is board. This is what makes a
 * slot inside a cutout inside a board come out as board again, and it is why
 * depth is counted rather than "biggest ring wins".
 */
export function nestRings(rings: readonly Pt[][]): OutlineRegion[] {
  const valid = rings.filter((ring) => ring.length >= 3 && Math.abs(signedArea(ring)) > 1e-9)
  const area = valid.map((ring) => Math.abs(signedArea(ring)))

  /** Index of the smallest ring strictly containing `i`, or -1. */
  const parent = valid.map((ring, i) => {
    let best = -1
    for (let j = 0; j < valid.length; j++) {
      if (i === j || area[j] <= area[i]) continue
      if (!pointInPolygon(ring[0], valid[j])) continue
      if (best === -1 || area[j] < area[best]) best = j
    }
    return best
  })

  const depth = valid.map((_, i) => {
    let d = 0
    for (let at = parent[i]; at !== -1; at = parent[at]) d++
    return d
  })

  const regions: OutlineRegion[] = []
  const regionOf = new Map<number, number>()
  valid.forEach((ring, i) => {
    if (depth[i] % 2 !== 0) return
    regionOf.set(i, regions.length)
    regions.push({ outer: ring, holes: [] })
  })
  valid.forEach((ring, i) => {
    if (depth[i] % 2 === 0) return
    const region = regionOf.get(parent[i])
    if (region !== undefined) regions[region].holes.push(ring)
  })
  return regions
}

/** Axis-aligned world-space extent of everything that could sit on the board. */
export function boardContentBounds(
  board: KicadBoard
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const expand = (p: Pt): void => {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }

  for (const seg of board.segments) {
    expand(worldPoint(seg.start))
    expand(worldPoint(seg.end))
  }
  for (const via of board.vias) expand(worldPoint(via.position))
  for (const zone of board.zones) for (const p of zone.points) expand(worldPoint(p))
  for (const bfp of board.footprints) {
    const tf = footprintTransform(bfp)
    expand({ x: tf.tx, y: tf.ty })
    for (const pad of bfp.footprint.pads) {
      const c = tfPoint(tf, pad.position.x, pad.position.y)
      const reach = Math.max(pad.size.w, pad.size.h) / 2
      expand({ x: c.x - reach, y: c.y - reach })
      expand({ x: c.x + reach, y: c.y + reach })
    }
  }

  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

/** Margin around the fallback rectangle, so parts do not sit on the edge. */
const FALLBACK_MARGIN_MM = 1

export function buildBoardOutline(board: KicadBoard): BoardOutline {
  const { rings, edges } = collectEdgeCutsGeometry(board)
  const chained = chainEdges(edges)
  const regions = nestRings([...rings, ...chained.rings])

  const crossings = countCrossings([...rings, ...chained.rings])
  if (regions.length > 0) {
    return { regions, fallback: false, openCount: chained.open.length, crossings }
  }

  const bounds = boardContentBounds(board)
  if (!bounds) return { regions: [], fallback: true, openCount: chained.open.length, crossings }
  const m = FALLBACK_MARGIN_MM
  return {
    regions: [
      {
        outer: [
          { x: bounds.minX - m, y: bounds.minY - m },
          { x: bounds.maxX + m, y: bounds.minY - m },
          { x: bounds.maxX + m, y: bounds.maxY + m },
          { x: bounds.minX - m, y: bounds.maxY + m }
        ],
        holes: []
      }
    ],
    fallback: true,
    openCount: chained.open.length,
    crossings
  }
}

/**
 * How many pairs of segments cross properly among closed contours — touching
 * at an end or running along one another does not count, as KiCad's outline
 * check reads it. Adjacent segments of one ring share a corner and are skipped.
 */
function countCrossings(rings: readonly Pt[][]): number {
  const segments: Array<{ a: Pt; b: Pt; ring: number; index: number; size: number }> = []
  rings.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++)
      segments.push({
        a: ring[i],
        b: ring[(i + 1) % ring.length],
        ring: r,
        index: i,
        size: ring.length
      })
  })
  const side = (p: Pt, q: Pt, s: Pt): number =>
    Math.sign((q.x - p.x) * (s.y - p.y) - (q.y - p.y) * (s.x - p.x))
  // Sweep by x so only segments whose spans overlap are compared.
  segments.sort((s, t) => Math.min(s.a.x, s.b.x) - Math.min(t.a.x, t.b.x))
  let count = 0
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    const sMaxX = Math.max(s.a.x, s.b.x)
    for (let j = i + 1; j < segments.length; j++) {
      const t = segments[j]
      if (Math.min(t.a.x, t.b.x) > sMaxX) break
      if (s.ring === t.ring) {
        const gap = Math.abs(s.index - t.index)
        if (gap <= 1 || gap === s.size - 1) continue
      }
      const d1 = side(s.a, s.b, t.a)
      const d2 = side(s.a, s.b, t.b)
      const d3 = side(t.a, t.b, s.a)
      const d4 = side(t.a, t.b, s.b)
      if (d1 * d2 < 0 && d3 * d4 < 0) count++
    }
  }
  return count
}
