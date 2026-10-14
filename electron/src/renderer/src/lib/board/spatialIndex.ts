/**
 * Spatial index over a board's copper — the one geometry query layer routing
 * clearance, ratsnest nearest-point, DRC and zone dirty-detection all stand on
 * (pcb-editor-workstream.md: build once, here).
 *
 * Coordinates are the y-up world of `placement.ts` — the space the 2D scene,
 * the Gerber writers and the 3D board already share — so a routing cursor
 * position queries directly. Distances are **edge separations**: 0 means the
 * point/segment touches or overlaps the item's copper, and a clearance rule
 * `C` is satisfied iff the returned distance is ≥ C.
 *
 * It holds pads (each exactly — a rounded rect, a trapezoid or chamfered
 * polygon, a custom pad's anchor and primitives — on every padstack layer),
 * track segments, track arcs and vias. Zone fills are not indexed: they are
 * recomputed wholesale by the fill engine and would multiply the item count by
 * their vertex count. Copper drawings sit beside it (`drawingItems.ts`), the
 * layers beyond copper in `layerIndex.ts`. The index is rebuilt per command,
 * reusing the shapes of what the command did not touch (`buildFrom`).
 */

import { viaSizeOn, type KicadBoard, type KicadVia } from '../kicad/board'
import { padOnLayer, parseFlag, type KicadPad, isSolidFill } from '../kicad/footprint'
import { findChild, getAtomValues } from '../kicad/sexpr'
import { footprintTransform, tfPoint } from '../schematic/placement'
import { nmToMm, type Nm } from '../kicad/coordinates'
import { isCopperLayer } from '../kicad/layers'
import {
  arcBounds,
  arcCentralSweep,
  circumscribedCircle,
  arcContainsMidCCW
} from '../engine/arcGeometry'
import { PackedRTree } from '../geometry/packedRTree'

export interface Pt {
  x: number
  y: number
}

/** What an indexed item is, addressed the way the editor addresses things. */
export type CopperItemRef =
  | { type: 'segment' | 'tarc' | 'via'; index: number }
  /** `index` is the owning footprint; mirrors BoardItemRef's pad shape. */
  | { type: 'pad'; index: number; pad: number }
  /**
   * A copper drawing (`drawingItems.ts`): `index` into its set's items. Only
   * the checks and connectivity read these; the index itself holds none.
   */
  | { type: 'drawing'; index: number }

export type CopperShape =
  | { kind: 'capsule'; x0: number; y0: number; x1: number; y1: number; halfWidth: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | {
      kind: 'rrect'
      cx: number
      cy: number
      halfW: number
      halfH: number
      cornerR: number
      /** Radians, CCW in world space. */
      rotation: number
    }
  | {
      kind: 'arc'
      x0: number
      y0: number
      mx: number
      my: number
      x1: number
      y1: number
      halfWidth: number
    }
  /**
   * A filled outline: a trapezoid or chamfered pad, a padstack layer's shape,
   * a copper drawing. Its rings are read even-odd — a ring inside another is
   * a hole — with the bounds of them all.
   */
  | {
      kind: 'poly'
      rings: readonly (readonly Pt[])[]
      minX: number
      minY: number
      maxX: number
      maxY: number
      /** For a pad: the rectangle it is drawn in, which spokes and outlines are placed by. */
      frame?: PadFrame
    }
  /**
   * Copper that is several shapes at once: a custom pad's anchor and its
   * primitives. It is wherever any part is, and its distance is the nearest part's.
   */
  | { kind: 'compound'; parts: readonly CopperShape[]; frame?: PadFrame }

/** A pad's own rectangle: its center, size, corner radius and turn, whatever its outline. */
export type PadFrame = Extract<CopperShape, { kind: 'rrect' }>

/** The rectangle a pad is drawn in: the shape itself when it is one, else the frame it carries. */
export function padFrame(shape: CopperShape): PadFrame | null {
  if (shape.kind === 'rrect') return shape
  if (shape.kind === 'poly' || shape.kind === 'compound') return shape.frame ?? null
  return null
}

export interface CopperItem {
  /** Position in `BoardSpatialIndex.items` — a stable per-build handle. */
  id: number
  ref: CopperItemRef
  /** Net number; 0 is KiCad's "no net". */
  net: number
  /** Resolved copper layers occupied ('F.Cu', 'In1.Cu', …) — wildcards and via spans expanded. */
  layers: readonly string[]
  shape: CopperShape
  /**
   * A pad's position, where a track connects to it: its hole, where its copper
   * is offset from that (`padCopperCenter`).
   */
  anchor?: Pt
  /**
   * A padstack's copper on the layers where it differs from `shape`, which is
   * its front (`padOnLayer`, `viaSizeOn`); read an item on a layer through
   * `shapeOn`. The box holds them all.
   */
  shapes?: ReadonlyMap<string, CopperShape>
  /** World-space AABB, inflated by the copper's own half-width. */
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// ---------------------------------------------------------------------------
// Shape distances (pure; exported for tests and for slice-3 clearance checks)
// ---------------------------------------------------------------------------

const segPointDist = (
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): number => {
  const dx = x1 - x0
  const dy = y1 - y0
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(px - x0, py - y0)
  let t = ((px - x0) * dx + (py - y0) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))
}

/** Rotate `p` into the frame of a shape centered at (cx,cy) rotated by `rot` CCW. */
const toLocal = (px: number, py: number, cx: number, cy: number, rot: number): Pt => {
  const cos = Math.cos(-rot)
  const sin = Math.sin(-rot)
  const dx = px - cx
  const dy = py - cy
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos }
}

/** The corners of a rounded rect's core — the rectangle its corner radius sweeps. World space. */
export function rrectCore(shape: Extract<CopperShape, { kind: 'rrect' }>): Pt[] {
  const hw = Math.max(0, shape.halfW - shape.cornerR)
  const hh = Math.max(0, shape.halfH - shape.cornerR)
  const cos = Math.cos(shape.rotation)
  const sin = Math.sin(shape.rotation)
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh]
  ].map(([x, y]) => ({ x: shape.cx + x * cos - y * sin, y: shape.cy + x * sin + y * cos }))
}

/** A polygon shape from its rings, bounds computed. */
export function polyShape(
  rings: readonly (readonly Pt[])[]
): Extract<CopperShape, { kind: 'poly' }> {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ring of rings) {
    for (const p of ring) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  return { kind: 'poly', rings, minX, minY, maxX, maxY }
}

/** Distance from a point to an axis-aligned rounded rect's edge (0 inside). */
const aaRRectDist = (
  lx: number,
  ly: number,
  halfW: number,
  halfH: number,
  cornerR: number
): number => {
  const qx = Math.abs(lx) - (halfW - cornerR)
  const qy = Math.abs(ly) - (halfH - cornerR)
  return Math.max(0, Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - cornerR)
}

/**
 * How far a chord may cut inside an arc's true centerline, mm. KiCad measures
 * arcs exactly and forgives 0.5 µm (its DRC epsilon); at 0.1 µm the chords
 * are well inside that on either side of the arc.
 */
const ARC_TOLERANCE_MM = 0.0001

/**
 * Sample points along a three-point arc's centerline (endpoints included):
 * `samples` chords when given, else as many as keep every chord's sagitta
 * within `ARC_TOLERANCE_MM`.
 */
export function sampleArc(
  x0: number,
  y0: number,
  mx: number,
  my: number,
  x1: number,
  y1: number,
  samples?: number,
  /** Sweep as KiCad's filler reads the arc (`arcCentralSweep`), not through its mid. */
  central = false
): Pt[] {
  const circle = circumscribedCircle(x0, y0, mx, my, x1, y1)
  if (!circle)
    return [
      { x: x0, y: y0 },
      { x: x1, y: y1 }
    ]
  const { cx, cy, r } = circle
  const aStart = Math.atan2(y0 - cy, x0 - cx)
  const aEnd = Math.atan2(y1 - cy, x1 - cx)
  let sweep: number
  let dir: number
  if (central) {
    const signed = arcCentralSweep({ x: x0, y: y0 }, { x: mx, y: my }, { x: x1, y: y1 }, cx, cy)
    sweep = Math.abs(signed)
    dir = signed < 0 ? -1 : 1
  } else {
    const anticlockwise = !arcContainsMidCCW(
      { x: x0, y: y0 },
      { x: mx, y: my },
      { x: x1, y: y1 },
      cx,
      cy
    )
    sweep = anticlockwise ? aStart - aEnd : aEnd - aStart
    if (sweep <= 0) sweep += 2 * Math.PI
    dir = anticlockwise ? -1 : 1
  }
  if (samples === undefined) {
    samples =
      r <= ARC_TOLERANCE_MM
        ? 2
        : Math.max(2, Math.ceil(sweep / (2 * Math.acos(1 - ARC_TOLERANCE_MM / r))))
  }
  const pts: Pt[] = []
  for (let i = 0; i <= samples; i++) {
    const a = aStart + dir * sweep * (i / samples)
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

/** An arc's chords, sampled once per shape: the distance functions ask again and again. */
type ArcShape = Extract<CopperShape, { kind: 'arc' }>

/**
 * An arc's circle and CCW sweep, as KiCad's DRC reads a three-point arc
 * (through its mid; `arcContainsMidCCW`); null for three collinear points,
 * which are the straight start → end.
 */
interface ArcFrame {
  cx: number
  cy: number
  r: number
  /** Where the CCW sweep starts, radians. */
  a0: number
  /** Its length, radians. */
  sweep: number
}
const arcFrames = new WeakMap<ArcShape, ArcFrame | null>()
const arcFrame = (shape: ArcShape): ArcFrame | null => {
  let frame = arcFrames.get(shape)
  if (frame === undefined) {
    const circle = circumscribedCircle(shape.x0, shape.y0, shape.mx, shape.my, shape.x1, shape.y1)
    if (!circle) frame = null
    else {
      const { cx, cy, r } = circle
      const ccw = arcContainsMidCCW(
        { x: shape.x0, y: shape.y0 },
        { x: shape.mx, y: shape.my },
        { x: shape.x1, y: shape.y1 },
        cx,
        cy
      )
      const [from, to] = ccw
        ? [Math.atan2(shape.y0 - cy, shape.x0 - cx), Math.atan2(shape.y1 - cy, shape.x1 - cx)]
        : [Math.atan2(shape.y1 - cy, shape.x1 - cx), Math.atan2(shape.y0 - cy, shape.x0 - cx)]
      frame = { cx, cy, r, a0: from, sweep: turnCCW(from, to) }
    }
    arcFrames.set(shape, frame)
  }
  return frame
}

/** CCW turn from one angle to another, in [0, 2π). */
const turnCCW = (from: number, to: number): number => {
  const d = (to - from) % (2 * Math.PI)
  return d < 0 ? d + 2 * Math.PI : d
}

const inSweep = (frame: ArcFrame, x: number, y: number): boolean =>
  turnCCW(frame.a0, Math.atan2(y - frame.cy, x - frame.cx)) <= frame.sweep + 1e-12

/** Distance from a point to an arc's centerline, exactly. */
function pointToArcLine(shape: ArcShape, x: number, y: number): number {
  const frame = arcFrame(shape)
  if (!frame) return segPointDist(x, y, shape.x0, shape.y0, shape.x1, shape.y1)
  if (inSweep(frame, x, y)) return Math.abs(Math.hypot(x - frame.cx, y - frame.cy) - frame.r)
  return Math.min(Math.hypot(x - shape.x0, y - shape.y0), Math.hypot(x - shape.x1, y - shape.y1))
}

/**
 * Distance from a segment to an arc's centerline, exactly: 0 where the segment
 * crosses the arc; else the nearest of each one's ends to the other, and the
 * segment's point nearest the circle's center where it lies outside the circle
 * within the sweep (the nearest approach of a line and a circle is radial).
 */
function segmentToArcLine(shape: ArcShape, ax: number, ay: number, bx: number, by: number): number {
  const frame = arcFrame(shape)
  if (!frame) return segSegDist(ax, ay, bx, by, shape.x0, shape.y0, shape.x1, shape.y1)
  const { cx, cy, r } = frame
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  // Where the segment crosses the circle: |a + t(b − a) − c| = r.
  const fx = ax - cx
  const fy = ay - cy
  if (len2 > 0) {
    const b = fx * dx + fy * dy
    const disc = b * b - len2 * (fx * fx + fy * fy - r * r)
    if (disc >= 0) {
      const root = Math.sqrt(disc)
      for (const t of [(-b - root) / len2, (-b + root) / len2])
        if (t >= 0 && t <= 1 && inSweep(frame, ax + t * dx, ay + t * dy)) return 0
    }
  }
  let d = Math.min(
    pointToArcLine(shape, ax, ay),
    pointToArcLine(shape, bx, by),
    segPointDist(shape.x0, shape.y0, ax, ay, bx, by),
    segPointDist(shape.x1, shape.y1, ax, ay, bx, by)
  )
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(fx * dx + fy * dy) / len2)) : 0
  const px = ax + t * dx
  const py = ay + t * dy
  const toCenter = Math.hypot(px - cx, py - cy)
  if (toCenter > r && inSweep(frame, px, py)) d = Math.min(d, toCenter - r)
  return d
}

/**
 * Distance between two arcs' centerlines, exactly: 0 where they cross; else
 * each one's ends against the other, and the points where the line through
 * both centers meets both arcs (where two circles come nearest).
 */
function arcToArcLine(a: ArcShape, b: ArcShape): number {
  const fa = arcFrame(a)
  const fb = arcFrame(b)
  if (!fa) return segmentToArcLine(b, a.x0, a.y0, a.x1, a.y1)
  if (!fb) return segmentToArcLine(a, b.x0, b.y0, b.x1, b.y1)
  let d = Math.min(
    pointToArcLine(b, a.x0, a.y0),
    pointToArcLine(b, a.x1, a.y1),
    pointToArcLine(a, b.x0, b.y0),
    pointToArcLine(a, b.x1, b.y1)
  )
  const between = Math.hypot(fb.cx - fa.cx, fb.cy - fa.cy)
  // Crossing circles: a crossing point within both sweeps.
  if (between > 0 && between <= fa.r + fb.r && between >= Math.abs(fa.r - fb.r)) {
    const along = (fa.r * fa.r - fb.r * fb.r + between * between) / (2 * between)
    const h = Math.sqrt(Math.max(0, fa.r * fa.r - along * along))
    const ux = (fb.cx - fa.cx) / between
    const uy = (fb.cy - fa.cy) / between
    const mx = fa.cx + along * ux
    const my = fa.cy + along * uy
    for (const sign of [1, -1]) {
      const x = mx - sign * h * uy
      const y = my + sign * h * ux
      if (inSweep(fa, x, y) && inSweep(fb, x, y)) return 0
    }
  }
  if (between > 0) {
    const ux = (fb.cx - fa.cx) / between
    const uy = (fb.cy - fa.cy) / between
    for (const sa of [1, -1])
      for (const sb of [1, -1]) {
        const pax = fa.cx + sa * fa.r * ux
        const pay = fa.cy + sa * fa.r * uy
        const pbx = fb.cx + sb * fb.r * ux
        const pby = fb.cy + sb * fb.r * uy
        if (inSweep(fa, pax, pay) && inSweep(fb, pbx, pby))
          d = Math.min(d, Math.hypot(pax - pbx, pay - pby))
      }
  }
  return d
}

/** Whether a point is inside a polygon's rings, read even-odd (holes subtract). */
export function pointInPoly(rings: readonly (readonly Pt[])[], x: number, y: number): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]
      const b = ring[j]
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
  }
  return inside
}

/** Every edge of a polygon, as (a, b). */
function forEachEdge(
  rings: readonly (readonly Pt[])[],
  visit: (a: Pt, b: Pt) => boolean | void
): void {
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (visit(ring[j], ring[i]) === true) return
    }
  }
}

/** Edge distance from a point to a shape's copper (0 when inside). */
export function pointToShape(shape: CopperShape, x: number, y: number): number {
  switch (shape.kind) {
    case 'capsule':
      return Math.max(
        0,
        segPointDist(x, y, shape.x0, shape.y0, shape.x1, shape.y1) - shape.halfWidth
      )
    case 'circle':
      return Math.max(0, Math.hypot(x - shape.cx, y - shape.cy) - shape.r)
    case 'rrect': {
      const l = toLocal(x, y, shape.cx, shape.cy, shape.rotation)
      return aaRRectDist(l.x, l.y, shape.halfW, shape.halfH, shape.cornerR)
    }
    case 'arc':
      return Math.max(0, pointToArcLine(shape, x, y) - shape.halfWidth)
    case 'poly': {
      if (pointInPoly(shape.rings, x, y)) return 0
      let d = Infinity
      forEachEdge(shape.rings, (a, b) => {
        d = Math.min(d, segPointDist(x, y, a.x, a.y, b.x, b.y))
      })
      return d
    }
    case 'compound': {
      let d = Infinity
      for (const part of shape.parts) {
        d = Math.min(d, pointToShape(part, x, y))
        if (d === 0) return 0
      }
      return d
    }
  }
}

const segSegDist = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): number => {
  // Proper intersection → 0; else min endpoint-to-segment distance.
  const d1 = cross(bx - ax, by - ay, cx - ax, cy - ay)
  const d2 = cross(bx - ax, by - ay, dx - ax, dy - ay)
  const d3 = cross(dx - cx, dy - cy, ax - cx, ay - cy)
  const d4 = cross(dx - cx, dy - cy, bx - cx, by - cy)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return 0
  }
  return Math.min(
    segPointDist(cx, cy, ax, ay, bx, by),
    segPointDist(dx, dy, ax, ay, bx, by),
    segPointDist(ax, ay, cx, cy, dx, dy),
    segPointDist(bx, by, cx, cy, dx, dy)
  )
}

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx

/**
 * Edge separation between a routed segment of copper (a capsule from a→b with
 * `halfWidth`) and a shape (0 on touch/overlap). This is the routing/DRC
 * clearance primitive: rule `C` holds iff the result is ≥ C.
 */
export function segmentToShape(
  shape: CopperShape,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  halfWidth: number
): number {
  switch (shape.kind) {
    case 'capsule':
      return Math.max(
        0,
        segSegDist(ax, ay, bx, by, shape.x0, shape.y0, shape.x1, shape.y1) -
          shape.halfWidth -
          halfWidth
      )
    case 'circle':
      return Math.max(0, segPointDist(shape.cx, shape.cy, ax, ay, bx, by) - shape.r - halfWidth)
    case 'rrect': {
      // Into the pad's frame, then segment ↔ (rect shrunk by cornerR) ⊕ disc:
      // a rounded rect is exactly that Minkowski sum, so the distance is the
      // shrunk-rect distance minus the corner radius.
      const a = toLocal(ax, ay, shape.cx, shape.cy, shape.rotation)
      const b = toLocal(bx, by, shape.cx, shape.cy, shape.rotation)
      const hw = shape.halfW - shape.cornerR
      const hh = shape.halfH - shape.cornerR
      const inside = (p: Pt): boolean => Math.abs(p.x) <= hw && Math.abs(p.y) <= hh
      if (inside(a) || inside(b)) return 0
      const corners: Pt[] = [
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
        { x: hw, y: hh },
        { x: -hw, y: hh }
      ]
      let d = Infinity
      for (let i = 0; i < 4; i++) {
        const c0 = corners[i]
        const c1 = corners[(i + 1) % 4]
        d = Math.min(d, segSegDist(a.x, a.y, b.x, b.y, c0.x, c0.y, c1.x, c1.y))
      }
      return Math.max(0, d - shape.cornerR - halfWidth)
    }
    case 'arc':
      return Math.max(0, segmentToArcLine(shape, ax, ay, bx, by) - shape.halfWidth - halfWidth)
    case 'poly': {
      if (pointInPoly(shape.rings, ax, ay) || pointInPoly(shape.rings, bx, by)) return 0
      let d = Infinity
      forEachEdge(shape.rings, (c, e) => {
        d = Math.min(d, segSegDist(ax, ay, bx, by, c.x, c.y, e.x, e.y))
        return d === 0
      })
      return Math.max(0, d - halfWidth)
    }
    case 'compound': {
      let d = Infinity
      for (const part of shape.parts) {
        d = Math.min(d, segmentToShape(part, ax, ay, bx, by, halfWidth))
        if (d === 0) return 0
      }
      return d
    }
  }
}

/**
 * Edge separation between two copper shapes (0 on touch/overlap) — the
 * symmetric closure of `pointToShape`/`segmentToShape`. Connectivity's touch
 * predicate and the pad↔pad half of a future DRC clearance check.
 *
 * Capsules/circles/arcs reduce to the segment/point primitives. The one pair
 * neither covers is rrect↔rrect: a rounded rect is (shrunk rect ⊕ disc), so
 * its boundary region is the shrunk rect's four edges swept by the corner
 * radius — exactly a capsule per edge — leaving only the full-containment
 * case, which the mutual center-inside tests catch.
 */
export function shapeToShape(a: CopperShape, b: CopperShape): number {
  if (a.kind === 'compound' || b.kind === 'compound') {
    const [whole, other] =
      a.kind === 'compound' ? [a, b] : [b as typeof a & { kind: 'compound' }, a]
    let d = Infinity
    for (const part of (whole as Extract<CopperShape, { kind: 'compound' }>).parts) {
      d = Math.min(d, shapeToShape(part, other))
      if (d === 0) return 0
    }
    return d
  }
  if (a.kind === 'capsule') return segmentToShape(b, a.x0, a.y0, a.x1, a.y1, a.halfWidth)
  if (b.kind === 'capsule') return segmentToShape(a, b.x0, b.y0, b.x1, b.y1, b.halfWidth)
  if (a.kind === 'circle') return Math.max(0, pointToShape(b, a.cx, a.cy) - a.r)
  if (b.kind === 'circle') return Math.max(0, pointToShape(a, b.cx, b.cy) - b.r)
  if (a.kind === 'arc' || b.kind === 'arc') {
    const arc = a.kind === 'arc' ? a : (b as ArcShape)
    const other = (a.kind === 'arc' ? b : a) as Extract<
      CopperShape,
      { kind: 'arc' | 'rrect' | 'poly' }
    >
    if (other.kind === 'arc')
      return Math.max(0, arcToArcLine(arc, other) - arc.halfWidth - other.halfWidth)
    // The arc reaching inside, else its nearest approach to the other's edges
    // (a rounded rect's are its core's, swept by the corner radius).
    if (pointToShape(other, arc.x0, arc.y0) === 0) return 0
    const edges =
      other.kind === 'poly'
        ? { rings: other.rings, halfWidth: 0 }
        : { rings: [rrectCore(other)], halfWidth: other.cornerR }
    let d = Infinity
    forEachEdge(edges.rings, (c, e) => {
      d = Math.min(d, segmentToArcLine(arc, c.x, c.y, e.x, e.y))
      return d <= arc.halfWidth + edges.halfWidth
    })
    return Math.max(0, d - arc.halfWidth - edges.halfWidth)
  }
  if (a.kind === 'poly' || b.kind === 'poly') {
    const poly = (a.kind === 'poly' ? a : b) as Extract<CopperShape, { kind: 'poly' }>
    const other = (a.kind === 'poly' ? b : a) as Extract<CopperShape, { kind: 'poly' | 'rrect' }>
    // One inside the other, then the nearest pair of edges (the other's edges as
    // capsules: a rounded rect's boundary is its core's edges swept by the radius).
    const first = poly.rings[0]?.[0]
    if (first && pointToShape(other, first.x, first.y) === 0) return 0
    const edgesOf =
      other.kind === 'poly'
        ? { rings: other.rings, halfWidth: 0 }
        : { rings: [rrectCore(other)], halfWidth: other.cornerR }
    const probe = edgesOf.rings[0]?.[0]
    if (probe && pointInPoly(poly.rings, probe.x, probe.y)) return 0
    let d = Infinity
    forEachEdge(edgesOf.rings, (c, e) => {
      d = Math.min(d, segmentToShape(poly, c.x, c.y, e.x, e.y, edgesOf.halfWidth))
      return d === 0
    })
    return d
  }
  // rrect ↔ rrect
  if (pointToShape(a, b.cx, b.cy) === 0 || pointToShape(b, a.cx, a.cy) === 0) return 0
  const cos = Math.cos(a.rotation)
  const sin = Math.sin(a.rotation)
  const hw = a.halfW - a.cornerR
  const hh = a.halfH - a.cornerR
  const corner = (sx: number, sy: number): Pt => ({
    x: a.cx + sx * hw * cos - sy * hh * sin,
    y: a.cy + sx * hw * sin + sy * hh * cos
  })
  const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
  let d = Infinity
  for (let i = 0; i < 4; i++) {
    const c0 = corners[i]
    const c1 = corners[(i + 1) % 4]
    d = Math.min(d, segmentToShape(b, c0.x, c0.y, c1.x, c1.y, a.cornerR))
  }
  return d
}

// ---------------------------------------------------------------------------
// Building items from the board
// ---------------------------------------------------------------------------

const shapeBounds = (
  shape: CopperShape
): { minX: number; minY: number; maxX: number; maxY: number } => {
  switch (shape.kind) {
    case 'capsule': {
      const r = shape.halfWidth
      return {
        minX: Math.min(shape.x0, shape.x1) - r,
        minY: Math.min(shape.y0, shape.y1) - r,
        maxX: Math.max(shape.x0, shape.x1) + r,
        maxY: Math.max(shape.y0, shape.y1) + r
      }
    }
    case 'circle':
      return {
        minX: shape.cx - shape.r,
        minY: shape.cy - shape.r,
        maxX: shape.cx + shape.r,
        maxY: shape.cy + shape.r
      }
    case 'rrect': {
      // Conservative: the rotated rect's circumradius.
      const r = Math.hypot(shape.halfW, shape.halfH)
      return { minX: shape.cx - r, minY: shape.cy - r, maxX: shape.cx + r, maxY: shape.cy + r }
    }
    case 'poly':
      return { minX: shape.minX, minY: shape.minY, maxX: shape.maxX, maxY: shape.maxY }
    case 'compound': {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const part of shape.parts) {
        const box = shapeBounds(part)
        minX = Math.min(minX, box.minX)
        minY = Math.min(minY, box.minY)
        maxX = Math.max(maxX, box.maxX)
        maxY = Math.max(maxY, box.maxY)
      }
      return { minX, minY, maxX, maxY }
    }
    case 'arc': {
      const { minX, minY, maxX, maxY } = arcBounds(
        { x: shape.x0, y: shape.y0 },
        { x: shape.mx, y: shape.my },
        { x: shape.x1, y: shape.y1 }
      )
      const r = shape.halfWidth
      return { minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r }
    }
  }
}

/** Expand a pad's layer list against the board's real copper layers. */
export function resolvePadCopperLayers(pad: KicadPad, copperLayers: readonly string[]): string[] {
  const resolved: string[] = []
  for (const layer of pad.layers) {
    if (layer === '*.Cu') {
      for (const l of copperLayers) if (!resolved.includes(l)) resolved.push(l)
    } else if (layer === 'F&B.Cu') {
      // The outer layers, as KiCad's layer set reads the token.
      for (const l of ['F.Cu', 'B.Cu'])
        if (copperLayers.includes(l) && !resolved.includes(l)) resolved.push(l)
    } else if (isCopperLayer(layer) && !resolved.includes(layer)) {
      resolved.push(layer)
    }
  }
  return resolved
}

/**
 * The copper layers a via spans: every layer between its two endpoints in
 * STACK order (through vias name F.Cu/B.Cu and so span everything). Stack
 * order is the file's layer-table order, NOT the ordinal values: KiCad ≤8
 * numbered the stack monotonically (F.Cu 0 … B.Cu 31) but KiCad 9+ renumbers
 * (F.Cu 0, In1.Cu 4, In2.Cu 6, B.Cu 2), so an ordinal range would read a
 * through via as spanning only the outer layers.
 */
function resolveViaLayers(
  via: KicadVia,
  copperPosByName: Map<string, number>,
  copperLayers: readonly string[]
): string[] {
  const p0 = copperPosByName.get(via.layers[0] ?? 'F.Cu')
  const p1 = copperPosByName.get(via.layers[via.layers.length - 1] ?? 'B.Cu')
  if (p0 === undefined || p1 === undefined) return [...via.layers]
  const lo = Math.min(p0, p1)
  const hi = Math.max(p0, p1)
  return copperLayers.slice(lo, hi + 1)
}

/** A pad's absolute angle as the y-up world's CCW radians — the reading BoardScene.renderPad applies. */
const padRotation = (pad: KicadPad): number =>
  pad.position.angle ? (pad.position.angle * Math.PI) / 180 : 0

/**
 * A pad's outline as a shape: a rounded rect for the standard shapes, a
 * polygon for a trapezoid or chamfered pad, the anchor and primitives of a
 * custom one. `center` is the pad's position — its hole; the copper sits at
 * the drill `offset` from it, turned with the pad (KiCad's `PAD::ShapePos`).
 * Pass `padOnLayer`'s pad for a padstack's other layers.
 */
export function padShape(pad: KicadPad, center: Pt): CopperShape {
  // Domain nm sizes → the index's world mm.
  const halfW = nmToMm(pad.size.w) / 2
  let halfH = nmToMm(pad.size.h) / 2
  let cornerR = 0
  if (pad.shape === 'circle') {
    halfH = halfW
    cornerR = halfW
  } else if (pad.shape === 'oval') {
    cornerR = Math.min(halfW, halfH)
  } else if (pad.shape === 'roundrect' || pad.roundrectRatio) {
    cornerR = 2 * Math.min(halfW, halfH) * (pad.roundrectRatio ?? 0.25)
  }
  const rotation = padRotation(pad)
  const { x: cx, y: cy } = padCopperCenter(pad, center, rotation)
  const frame: PadFrame = { kind: 'rrect', cx, cy, halfW, halfH, cornerR, rotation }
  // Pad-local, y down as the file has it → world, y up, turned with the pad.
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const world = (x: number, y: number): Pt => ({
    x: cx + x * cos + y * sin,
    y: cy + x * sin - y * cos
  })

  const delta = pad.rectDelta
  if (pad.shape === 'trapezoid' && delta && (delta.x !== 0 || delta.y !== 0)) {
    // KiCad's trapezoid: each end widened or narrowed by half the delta.
    const dx = nmToMm(delta.x) / 2
    const dy = nmToMm(delta.y) / 2
    const ring = [
      world(-halfW - dy, halfH + dx),
      world(halfW + dy, halfH - dx),
      world(halfW - dy, -halfH + dx),
      world(-halfW + dy, -halfH - dx)
    ]
    return { ...polyShape([ring]), frame }
  }
  // Any chamfered corner named makes it KiCad's CHAMFERED_RECT, a ratio of 0 included.
  if (pad.chamfer?.length && pad.shape !== 'custom' && pad.shape !== 'trapezoid') {
    const ring = chamferedRing(frame, pad.chamferRatio ?? 0, pad.chamfer)
    if (ring) return { ...polyShape([ring]), frame }
  }
  if (pad.shape === 'custom') {
    // The anchor — a circle unless it says rect — and every primitive, each exactly.
    const anchor: CopperShape = pad.anchor === 'rect' ? frame : { kind: 'circle', cx, cy, r: halfW }
    return { kind: 'compound', parts: [anchor, ...primitiveShapes(pad, world)], frame }
  }
  return frame
}

/**
 * A chamfered rectangle's outline: the named corners cut by the ratio of the
 * shorter side — left sharp at a ratio of 0 — the rest rounded by the corner
 * radius, as KiCad draws it. World space; null when no corner is named.
 */
export function chamferedRing(
  frame: PadFrame,
  ratio: number,
  corners: readonly string[]
): Pt[] | null {
  if (corners.length === 0) return null
  const { cx, cy, halfW: hw, halfH: hh, rotation } = frame
  const c = Math.min(ratio * 2 * Math.min(hw, hh), Math.min(hw, hh))
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const world = (x: number, y: number): Pt => ({
    x: cx + x * cos + y * sin,
    y: cy + x * sin - y * cos
  })
  // Clockwise on screen from the top left; each corner's arc starts at `start` radians (y down).
  const local: Array<[string, number, number, [number, number], [number, number], number]> = [
    ['top_left', -hw, -hh, [0, c], [c, 0], Math.PI],
    ['top_right', hw, -hh, [-c, 0], [0, c], (3 * Math.PI) / 2],
    ['bottom_right', hw, hh, [0, -c], [-c, 0], 0],
    ['bottom_left', -hw, hh, [c, 0], [0, -c], Math.PI / 2]
  ]
  const steps = 32
  const r = frame.cornerR
  const reach = r / Math.cos(Math.PI / 4 / steps)
  const out: Pt[] = []
  for (const [name, x, y, from, to, start] of local) {
    if (corners.includes(name)) {
      if (c > 0) out.push(world(x + from[0], y + from[1]), world(x + to[0], y + to[1]))
      else out.push(world(x, y))
    } else if (r > 0) {
      const ax = x - Math.sign(x) * r
      const ay = y - Math.sign(y) * r
      for (let i = 0; i <= steps; i++) {
        const t = start + ((Math.PI / 2) * i) / steps
        out.push(world(ax + reach * Math.cos(t), ay + reach * Math.sin(t)))
      }
    } else out.push(world(x, y))
  }
  return out
}

/** A custom pad's primitives as shapes, world space: strokes as capsules and arcs, fills as polygons. */
function primitiveShapes(pad: KicadPad, world: (x: number, y: number) => Pt): CopperShape[] {
  const prims = pad.primitives
  if (!prims) return []
  const at = (p: { x: Nm; y: Nm }): Pt => world(nmToMm(p.x), nmToMm(p.y))
  const half = (width: Nm | undefined): number => (width !== undefined ? nmToMm(width) : 0) / 2
  const out: CopperShape[] = []
  const stroke = (points: Pt[], halfWidth: number, closed: boolean): void => {
    const n = closed ? points.length : points.length - 1
    for (let i = 0; i < n; i++) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      out.push({ kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth })
    }
  }
  for (const line of prims.lines)
    stroke([at(line.start), at(line.end)], half(line.strokeWidth), false)
  for (const arc of prims.arcs) {
    const [a, m, b] = [at(arc.start), at(arc.mid), at(arc.end)]
    const halfWidth = half(arc.strokeWidth)
    out.push({ kind: 'arc', x0: a.x, y0: a.y, mx: m.x, my: m.y, x1: b.x, y1: b.y, halfWidth })
  }
  for (const circle of prims.circles) {
    const c = at(circle.center)
    const e = at(circle.end)
    const r = Math.hypot(e.x - c.x, e.y - c.y)
    const w = half(circle.strokeWidth)
    if (isSolidFill(circle.fill) || w === 0) {
      out.push({ kind: 'circle', cx: c.x, cy: c.y, r: r + w })
      continue
    }
    // A ring: two half arcs of the stroke's width.
    const far = { x: 2 * c.x - e.x, y: 2 * c.y - e.y }
    const up = { x: c.x - (e.y - c.y), y: c.y + (e.x - c.x) }
    const down = { x: c.x + (e.y - c.y), y: c.y - (e.x - c.x) }
    out.push({
      kind: 'arc',
      x0: e.x,
      y0: e.y,
      mx: up.x,
      my: up.y,
      x1: far.x,
      y1: far.y,
      halfWidth: w
    })
    out.push({
      kind: 'arc',
      x0: far.x,
      y0: far.y,
      mx: down.x,
      my: down.y,
      x1: e.x,
      y1: e.y,
      halfWidth: w
    })
  }
  for (const rect of prims.rects) {
    const corners = [
      at(rect.start),
      at({ x: rect.end.x, y: rect.start.y }),
      at(rect.end),
      at({ x: rect.start.x, y: rect.end.y })
    ]
    if (isSolidFill(rect.fill)) out.push(polyShape([corners]))
    if (half(rect.strokeWidth) > 0 || !isSolidFill(rect.fill))
      stroke(corners, half(rect.strokeWidth), true)
  }
  for (const poly of prims.polys) {
    const points = poly.points.map(at)
    if (points.length < 2) continue
    // A primitive polygon is filled unless it says otherwise.
    if ((poly.fill === undefined || isSolidFill(poly.fill)) && points.length >= 3)
      out.push(polyShape([points]))
    if (half(poly.strokeWidth) > 0) stroke(points, half(poly.strokeWidth), true)
  }
  return out
}

/** Where a pad's copper is centered: its position plus the drill offset, in world mm. */
export function padCopperCenter(pad: KicadPad, center: Pt, rotation: number): Pt {
  const offset = pad.drill?.offset
  if (!offset || (offset.x === 0 && offset.y === 0)) return center
  // Pad-local nm, y down → world mm, y up, turned with the pad.
  const ox = nmToMm(offset.x)
  const oy = -nmToMm(offset.y)
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return { x: center.x + ox * cos - oy * sin, y: center.y + ox * sin + oy * cos }
}

/**
 * A pad's hole as the index measures copper: a round drill is a zero-length
 * capsule, a slot a capsule along its long axis (KiCad's
 * `GetEffectiveHoleShape`). Null for a pad with no drill.
 */
export function padHoleShape(pad: KicadPad, center: Pt): CopperShape | null {
  const drill = pad.drill
  if (!drill || drill.diameter <= 0) return null
  const w = nmToMm(drill.oval?.width ?? drill.diameter)
  const h = nmToMm(drill.oval?.height ?? drill.diameter)
  if (w <= 0 || h <= 0) return null
  const halfWidth = Math.min(w, h) / 2
  // Pad-local half-length along the slot, y down → world y up, turned with the pad.
  const lx = w / 2 - halfWidth
  const ly = -(h / 2 - halfWidth)
  const rotation = padRotation(pad)
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const dx = lx * cos - ly * sin
  const dy = lx * sin + ly * cos
  return {
    kind: 'capsule',
    x0: center.x - dx,
    y0: center.y - dy,
    x1: center.x + dx,
    y1: center.y + dy,
    halfWidth
  }
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/** Copper this close touches (`boardConnectivity.ts`'s `CONNECT_EPSILON`, which reads this index). */
const CONNECT_EPSILON_MM = 1e-4

/** An item's copper on one layer: a padstack's own shape there, else its shape. */
export const shapeOn = (item: CopperItem, layer: string): CopperShape =>
  item.shapes?.get(layer) ?? item.shape

/**
 * The layer KiCad names when it asks for an item on no layer
 * (`UNDEFINED_LAYER`, as the board-edge test does): a `front_inner_back`
 * padstack is its inner copper there, a `custom` one its front.
 */
export const ANY_LAYER = '*'

/** A copper layer that reads as `ANY_LAYER` does in a padstack of this mode. */
const layerlessProbe = (mode: 'front_inner_back' | 'custom'): string =>
  mode === 'front_inner_back' ? 'In1.Cu' : 'F.Cu'

/** An index item, its box holding its shape and every per-layer one. */
function copperItem(
  id: number,
  ref: CopperItemRef,
  net: number,
  layers: readonly string[],
  shape: CopperShape,
  shapes?: ReadonlyMap<string, CopperShape>,
  anchor?: Pt
): CopperItem {
  const box = shapeBounds(shape)
  for (const other of shapes?.values() ?? []) {
    const b = shapeBounds(other)
    box.minX = Math.min(box.minX, b.minX)
    box.minY = Math.min(box.minY, b.minY)
    box.maxX = Math.max(box.maxX, b.maxX)
    box.maxY = Math.max(box.maxY, b.maxY)
  }
  return {
    id,
    ref,
    net,
    layers,
    shape,
    ...(shapes?.size ? { shapes } : {}),
    ...(anchor ? { anchor } : {}),
    ...box
  }
}

/** A via's copper: a circle its size across, and its padstack's other sizes by layer. */
function viaCopper(
  via: KicadVia,
  layers: readonly string[]
): { shape: CopperShape; shapes?: Map<string, CopperShape> } {
  const circle = (size: Nm): CopperShape => ({
    kind: 'circle',
    cx: nmToMm(via.position.x),
    cy: -nmToMm(via.position.y),
    r: nmToMm(size) / 2
  })
  let shapes: Map<string, CopperShape> | undefined
  if (via.padstack)
    for (const layer of [...layers, ANY_LAYER]) {
      const size = viaSizeOn(via, layer === ANY_LAYER ? layerlessProbe(via.padstack.mode) : layer)
      if (size !== via.size) (shapes ??= new Map()).set(layer, circle(size))
    }
  return { shape: circle(via.size), shapes }
}

/** A pad's copper: its own shape, and its padstack's other layers'. */
function padCopper(
  pad: KicadPad,
  center: Pt,
  layers: readonly string[]
): { shape: CopperShape; shapes?: Map<string, CopperShape> } {
  let shapes: Map<string, CopperShape> | undefined
  if (pad.padstack)
    for (const layer of [...layers, ANY_LAYER]) {
      const onLayer = padOnLayer(
        pad,
        layer === ANY_LAYER ? layerlessProbe(pad.padstack.mode) : layer
      )
      if (onLayer !== pad) (shapes ??= new Map()).set(layer, padShape(onLayer, center))
    }
  return { shape: padShape(pad, center), shapes }
}

export interface NearHit {
  item: CopperItem
  dist: number
}

export class BoardSpatialIndex {
  readonly items: CopperItem[]

  /** The items' boxes in a packed R-tree: each once, so a query needs no deduplication. */
  private readonly tree: PackedRTree

  private constructor(items: CopperItem[], board?: KicadBoard) {
    this.items = items
    const boxes = new Float64Array(items.length * 4)
    items.forEach((item, id) => {
      boxes[id * 4] = item.minX
      boxes[id * 4 + 1] = item.minY
      boxes[id * 4 + 2] = item.maxX
      boxes[id * 4 + 3] = item.maxY
    })
    this.tree = new PackedRTree(boxes, items.length)
    if (board) this.pruneUnusedLayers(board)
  }

  /**
   * KiCad's `PAD::FlashLayer` for a through-hole pad marked
   * `remove_unused_layers`: its copper exists only on the layers something
   * of its net touches it on — a track, an arc, a via or another pad — plus
   * the outer layers when `keep_end_layers` is set and any layer a
   * `zone_layer_connections` entry forces. Zones do not count. Elsewhere the
   * pad is only its hole, which the checks measure separately.
   */
  private pruneUnusedLayers(board: KicadBoard): void {
    const copperLayers = board.layers.filter((l) => isCopperLayer(l.name)).map((l) => l.name)
    const outer = new Set([copperLayers[0], copperLayers[copperLayers.length - 1]])
    for (const item of this.items) {
      if (item.ref.type !== 'pad') continue
      const pad = board.footprints[item.ref.index].footprint.pads[item.ref.pad]
      const raw = pad._raw
      if (!pad.drill || raw.type !== 'list' || !parseFlag(raw, 'remove_unused_layers')) continue
      const kept = new Set<string>()
      if (parseFlag(raw, 'keep_end_layers')) for (const l of outer) kept.add(l)
      const forced = findChild(raw, 'zone_layer_connections')
      if (forced) for (const l of getAtomValues(forced)) kept.add(l)
      for (const other of this.query(item.minX, item.minY, item.maxX, item.maxY)) {
        if (other.id === item.id || other.net !== item.net || item.net === 0) continue
        if (shapeToShape(item.shape, other.shape) > CONNECT_EPSILON_MM) continue
        for (const l of other.layers) if (item.layers.includes(l)) kept.add(l)
      }
      item.layers = item.layers.filter((l) => kept.has(l))
    }
  }

  /** One O(n) pass over the domain arrays; call again after the board changes. */
  static build(board: KicadBoard): BoardSpatialIndex {
    const items: CopperItem[] = []
    const copperLayers = board.layers.filter((l) => isCopperLayer(l.name)).map((l) => l.name)
    // Stack POSITION per name (see resolveViaLayers) — never the ordinal.
    const copperByName = new Map(copperLayers.map((name, pos) => [name, pos]))

    const push = (
      ref: CopperItemRef,
      net: number,
      layers: readonly string[],
      shape: CopperShape,
      shapes?: ReadonlyMap<string, CopperShape>,
      anchor?: Pt
    ): void => {
      items.push(copperItem(items.length, ref, net, layers, shape, shapes, anchor))
    }

    board.segments.forEach((seg, index) => {
      push({ type: 'segment', index }, seg.net, [seg.layer], {
        kind: 'capsule',
        x0: nmToMm(seg.start.x),
        y0: -nmToMm(seg.start.y),
        x1: nmToMm(seg.end.x),
        y1: -nmToMm(seg.end.y),
        halfWidth: nmToMm(seg.width) / 2
      })
    })

    board.trackArcs.forEach((arc, index) => {
      push({ type: 'tarc', index }, arc.net, [arc.layer], {
        kind: 'arc',
        x0: nmToMm(arc.start.x),
        y0: -nmToMm(arc.start.y),
        mx: nmToMm(arc.mid.x),
        my: -nmToMm(arc.mid.y),
        x1: nmToMm(arc.end.x),
        y1: -nmToMm(arc.end.y),
        halfWidth: nmToMm(arc.width) / 2
      })
    })

    board.vias.forEach((via, index) => {
      const layers = resolveViaLayers(via, copperByName, copperLayers)
      const { shape, shapes } = viaCopper(via, layers)
      push({ type: 'via', index }, via.net, layers, shape, shapes)
    })

    board.footprints.forEach((bfp, index) => {
      const tf = footprintTransform(bfp)
      bfp.footprint.pads.forEach((pad, padIndex) => {
        const layers = resolvePadCopperLayers(pad, copperLayers)
        if (layers.length === 0) return // aperture/paste-only pads carry no copper
        const center = tfPoint(tf, pad.position.x, pad.position.y)
        const { shape, shapes } = padCopper(pad, center, layers)
        push(
          { type: 'pad', index, pad: padIndex },
          pad.net?.number ?? 0,
          layers,
          shape,
          shapes,
          center
        )
      })
    })

    return new BoardSpatialIndex(items, board)
  }

  /**
   * Rebuild after one command, reusing the previous index's extracted shapes
   * for every item whose top-level AST node the command did not touch — the
   * expensive half of a build is the per-item extraction (unit conversion,
   * footprint placement transforms), and a typical edit touches a handful of
   * nodes out of tens of thousands. Refs and ids are reassigned positionally
   * exactly as `build` would, so consumers see an identical index; shapes are
   * shared by reference (they are immutable value objects). The reuse key is
   * the AST node's presence in `changedRaws`, never bare object identity —
   * mutators write domain objects in place, so identity survives an edit.
   */
  static buildFrom(
    prev: BoardSpatialIndex,
    prevArrays: {
      segments: ReadonlyArray<{ _raw: unknown }>
      trackArcs: ReadonlyArray<{ _raw: unknown }>
      vias: ReadonlyArray<{ _raw: unknown }>
      footprints: ReadonlyArray<{ _raw: unknown }>
    },
    board: KicadBoard,
    changedRaws: ReadonlySet<unknown>
  ): BoardSpatialIndex {
    // Previous items grouped by owning domain object's AST node.
    const prevByRaw = new Map<unknown, CopperItem[]>()
    const fileUnder = (raw: unknown, item: CopperItem): void => {
      const list = prevByRaw.get(raw)
      if (list) list.push(item)
      else prevByRaw.set(raw, [item])
    }
    for (const item of prev.items) {
      const ref = item.ref
      const owner =
        ref.type === 'segment'
          ? prevArrays.segments[ref.index]
          : ref.type === 'tarc'
            ? prevArrays.trackArcs[ref.index]
            : ref.type === 'via'
              ? prevArrays.vias[ref.index]
              : prevArrays.footprints[ref.index]
      if (owner) fileUnder(owner._raw, item)
    }

    const items: CopperItem[] = []
    const reuse = (raw: unknown, remapRef: (old: CopperItemRef) => CopperItemRef): boolean => {
      if (changedRaws.has(raw)) return false
      const cached = prevByRaw.get(raw)
      if (!cached) return false
      for (const old of cached) {
        items.push({ ...old, id: items.length, ref: remapRef(old.ref) })
      }
      return true
    }

    const copperLayers = board.layers.filter((l) => isCopperLayer(l.name)).map((l) => l.name)
    const copperByName = new Map(copperLayers.map((name, pos) => [name, pos]))
    const push = (
      ref: CopperItemRef,
      net: number,
      layers: readonly string[],
      shape: CopperShape,
      shapes?: ReadonlyMap<string, CopperShape>,
      anchor?: Pt
    ): void => {
      items.push(copperItem(items.length, ref, net, layers, shape, shapes, anchor))
    }

    board.segments.forEach((seg, index) => {
      if (reuse(seg._raw, () => ({ type: 'segment', index }))) return
      push({ type: 'segment', index }, seg.net, [seg.layer], {
        kind: 'capsule',
        x0: nmToMm(seg.start.x),
        y0: -nmToMm(seg.start.y),
        x1: nmToMm(seg.end.x),
        y1: -nmToMm(seg.end.y),
        halfWidth: nmToMm(seg.width) / 2
      })
    })
    board.trackArcs.forEach((arc, index) => {
      if (reuse(arc._raw, () => ({ type: 'tarc', index }))) return
      push({ type: 'tarc', index }, arc.net, [arc.layer], {
        kind: 'arc',
        x0: nmToMm(arc.start.x),
        y0: -nmToMm(arc.start.y),
        mx: nmToMm(arc.mid.x),
        my: -nmToMm(arc.mid.y),
        x1: nmToMm(arc.end.x),
        y1: -nmToMm(arc.end.y),
        halfWidth: nmToMm(arc.width) / 2
      })
    })
    board.vias.forEach((via, index) => {
      if (reuse(via._raw, () => ({ type: 'via', index }))) return
      const layers = resolveViaLayers(via, copperByName, copperLayers)
      const { shape, shapes } = viaCopper(via, layers)
      push({ type: 'via', index }, via.net, layers, shape, shapes)
    })
    board.footprints.forEach((bfp, index) => {
      if (reuse(bfp._raw, (old) => ({ ...old, index }))) return
      const tf = footprintTransform(bfp)
      bfp.footprint.pads.forEach((pad, padIndex) => {
        const layers = resolvePadCopperLayers(pad, copperLayers)
        if (layers.length === 0) return
        const center = tfPoint(tf, pad.position.x, pad.position.y)
        const { shape, shapes } = padCopper(pad, center, layers)
        push(
          { type: 'pad', index, pad: padIndex },
          pad.net?.number ?? 0,
          layers,
          shape,
          shapes,
          center
        )
      })
    })

    return new BoardSpatialIndex(items, board)
  }

  /** Items whose AABB intersects the box (superset — exact tests are the caller's). */
  query(minX: number, minY: number, maxX: number, maxY: number): CopperItem[] {
    const out: CopperItem[] = []
    this.tree.search(minX, minY, maxX, maxY, (id) => out.push(this.items[id]))
    return out
  }

  /**
   * Copper within `radius` of a world point, nearest first. `layer` restricts
   * to items occupying that copper layer; `excludeNet` drops a net (the one
   * being routed — its own copper is a target, not an obstacle).
   */
  near(
    x: number,
    y: number,
    radius: number,
    opts: { layer?: string; net?: number; excludeNet?: number } = {}
  ): NearHit[] {
    const hits: NearHit[] = []
    for (const item of this.query(x - radius, y - radius, x + radius, y + radius)) {
      if (opts.layer !== undefined && !item.layers.includes(opts.layer)) continue
      if (opts.net !== undefined && item.net !== opts.net) continue
      if (opts.excludeNet !== undefined && item.net === opts.excludeNet) continue
      const dist = pointToShape(item.shape, x, y)
      if (dist <= radius) hits.push({ item, dist })
    }
    return hits.sort((a, b) => a.dist - b.dist)
  }

  /**
   * Whether a routed segment (capsule a→b of `halfWidth`) would come closer
   * than `clearance` to any copper the filter admits. THE routing/DRC check:
   * an item violates iff its centerline separation < halfWidth + clearance.
   */
  violatesClearance(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    halfWidth: number,
    clearance: number,
    opts: { layer?: string; excludeNet?: number } = {}
  ): boolean {
    const reach = halfWidth + clearance
    return this.nearSegment(ax, ay, bx, by, reach, opts).some((h) => h.dist < reach)
  }

  /**
   * Copper within `radius` of a world-space segment, nearest first — the
   * candidate set a clearance check runs `segmentToShape` against.
   */
  nearSegment(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    radius: number,
    opts: { layer?: string; excludeNet?: number } = {}
  ): NearHit[] {
    const hits: NearHit[] = []
    const minX = Math.min(ax, bx) - radius
    const minY = Math.min(ay, by) - radius
    const maxX = Math.max(ax, bx) + radius
    const maxY = Math.max(ay, by) + radius
    for (const item of this.query(minX, minY, maxX, maxY)) {
      if (opts.layer !== undefined && !item.layers.includes(opts.layer)) continue
      if (opts.excludeNet !== undefined && item.net === opts.excludeNet) continue
      const dist = segmentToShape(item.shape, ax, ay, bx, by, 0)
      if (dist <= radius) hits.push({ item, dist })
    }
    return hits.sort((a, b) => a.dist - b.dist)
  }
}

/**
 * The points a router magnetically snaps to on an item: pad positions, via
 * centers, track segment/arc endpoints. These are where copper *connects*, which is
 * why the list is short — snapping to arbitrary outline points would fight
 * the grid without improving connectivity.
 */
export function snapPointsOf(item: CopperItem): Pt[] {
  if (item.anchor) return [item.anchor]
  const s = item.shape
  switch (s.kind) {
    case 'capsule':
      return [
        { x: s.x0, y: s.y0 },
        { x: s.x1, y: s.y1 }
      ]
    case 'arc':
      return [
        { x: s.x0, y: s.y0 },
        { x: s.x1, y: s.y1 }
      ]
    case 'circle':
    case 'rrect':
    case 'poly':
      return [shapeCenter(s)]
    case 'compound':
      // A custom pad connects at its anchor, its first part.
      return s.parts.length ? snapPointsOf({ ...item, shape: s.parts[0] }) : []
  }
}

/** A shape's middle: a pad's center, a track's midpoint, an arc's mid, a polygon's box center. */
export function shapeCenter(shape: CopperShape): Pt {
  switch (shape.kind) {
    case 'capsule':
      return { x: (shape.x0 + shape.x1) / 2, y: (shape.y0 + shape.y1) / 2 }
    case 'arc':
      return { x: shape.mx, y: shape.my }
    case 'circle':
    case 'rrect':
      return { x: shape.cx, y: shape.cy }
    case 'poly':
      return { x: (shape.minX + shape.maxX) / 2, y: (shape.minY + shape.maxY) / 2 }
    case 'compound':
      return shape.parts.length ? shapeCenter(shape.parts[0]) : { x: 0, y: 0 }
  }
}

/**
 * Each board's index, built once per board object, so whoever reads a board's
 * copper — the editor's tools, the session's net propagation — shares one.
 * The index snapshots geometry, so a board's index stays its state before
 * any in-place write a later command makes.
 */
const indexes = new WeakMap<KicadBoard, BoardSpatialIndex>()

/** A board's index, if one has been built. */
export const cachedBoardIndex = (board: KicadBoard): BoardSpatialIndex | undefined =>
  indexes.get(board)

/**
 * A board's index, from the index of the board an edit started from where
 * there is one (`BoardSpatialIndex.buildFrom`, `prevArrays` that board's
 * arrays before the edit), else whole.
 */
export function boardIndex(
  board: KicadBoard,
  edit?: {
    from: BoardSpatialIndex
    prevArrays: Parameters<typeof BoardSpatialIndex.buildFrom>[1]
    raws: ReadonlySet<unknown>
  }
): BoardSpatialIndex {
  let index = indexes.get(board)
  if (!index) {
    index = edit
      ? BoardSpatialIndex.buildFrom(edit.from, edit.prevArrays, board, edit.raws)
      : BoardSpatialIndex.build(board)
    indexes.set(board, index)
  }
  return index
}
