/**
 * Normalized Gerber geometry. The parser reduces every RS-274X construct —
 * flashes of standard and macro apertures, stroked draws/arcs, region fills —
 * to this small set of shapes, all in millimeters, y-up (Gerber's own axis
 * convention, which matches the viewport world space; no flip needed).
 *
 * Each shape maps 1:1 onto an engine primitive: capsule/rect/circle/ring/arc
 * are PrimitiveBatch SDF instances, poly is an earcut-filled mesh. Keeping the
 * mapping analytic (no CPU tessellation except polygon outlines) is what lets
 * a full board layer render as a couple of draw calls.
 */

import type { Pt } from '../schematic/placement'

export interface GerberPoint {
  x: number
  y: number
}

/** Stroked segment with round caps; also obround (oval) flashes. */
export interface GerberCapsule {
  kind: 'capsule'
  x0: number
  y0: number
  x1: number
  y1: number
  halfWidth: number
}

/** Rectangle flash / macro line primitive. `rotation` radians CCW about center. */
export interface GerberRect {
  kind: 'rect'
  cx: number
  cy: number
  halfW: number
  halfH: number
  rotation: number
}

export interface GerberCircle {
  kind: 'circle'
  cx: number
  cy: number
  r: number
}

/** Annulus: circle aperture with a concentric hole, moiré rings. */
export interface GerberRing {
  kind: 'ring'
  cx: number
  cy: number
  radius: number
  halfStroke: number
}

/** Stroked circular arc with round caps. `sweep` is signed (CCW positive). */
export interface GerberArc {
  kind: 'arc'
  cx: number
  cy: number
  radius: number
  halfWidth: number
  startAngle: number
  sweep: number
}

/** Filled polygon: regions, macro outlines/polygons, holed flashes. */
export interface GerberPoly {
  kind: 'poly'
  outline: GerberPoint[]
  holes: GerberPoint[][]
}

export type GerberShape =
  GerberCapsule | GerberRect | GerberCircle | GerberRing | GerberArc | GerberPoly

/**
 * `clear` erases everything painted before it on the same layer (LPC polarity
 * and macro exposure-off) — rendering is strictly in item order.
 */
export type GerberPolarity = 'dark' | 'clear'

export interface GerberItem {
  polarity: GerberPolarity
  shape: GerberShape
}

export interface GerberBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const expand = (b: GerberBounds, x: number, y: number, pad: number): void => {
  if (x - pad < b.minX) b.minX = x - pad
  if (y - pad < b.minY) b.minY = y - pad
  if (x + pad > b.maxX) b.maxX = x + pad
  if (y + pad > b.maxY) b.maxY = y + pad
}

/** Accumulate a shape's extent into `bounds` (conservative for rotated rects). */
export function expandBoundsByShape(bounds: GerberBounds, shape: GerberShape): void {
  switch (shape.kind) {
    case 'capsule':
      expand(bounds, shape.x0, shape.y0, shape.halfWidth)
      expand(bounds, shape.x1, shape.y1, shape.halfWidth)
      break
    case 'rect':
      expand(bounds, shape.cx, shape.cy, Math.hypot(shape.halfW, shape.halfH))
      break
    case 'circle':
      expand(bounds, shape.cx, shape.cy, shape.r)
      break
    case 'ring':
      expand(bounds, shape.cx, shape.cy, shape.radius + shape.halfStroke)
      break
    case 'arc':
      expand(bounds, shape.cx, shape.cy, shape.radius + shape.halfWidth)
      break
    case 'poly':
      for (const p of shape.outline) expand(bounds, p.x, p.y, 0)
      break
  }
}

export function emptyBounds(): GerberBounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
}

export function boundsValid(b: GerberBounds): boolean {
  return b.minX <= b.maxX && b.minY <= b.maxY
}

/**
 * Points along a circular arc, endpoints included. Segment count keeps the
 * chord sag below `sag` mm so tessellated region edges stay visually smooth.
 */
export function tessellateArc(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  sweep: number,
  sag = 0.005
): GerberPoint[] {
  const maxStep = radius > sag ? 2 * Math.acos(1 - sag / radius) : Math.PI / 8
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / maxStep))
  const points: GerberPoint[] = []
  for (let i = 0; i <= steps; i++) {
    const a = startAngle + (sweep * i) / steps
    points.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) })
  }
  return points
}

const TAU = Math.PI * 2

/**
 * Outline of a stroked segment — the rectangle body with a round cap at each
 * end — as a single closed ring. What a Gerber draw (D01 with a circular
 * aperture) covers, for boolean work on plotted strokes.
 */
export function capsuleOutline(p0: Pt, p1: Pt, halfWidth: number, capSegments = 12): Pt[] {
  const dx = p1.x - p0.x
  const dy = p1.y - p0.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-9) {
    return tessellateArc(p0.x, p0.y, halfWidth, 0, TAU_INTERNAL).slice(0, -1)
  }
  const angle = Math.atan2(dy, dx)
  const outline: Pt[] = []
  for (let i = 0; i <= capSegments; i++) {
    const theta = angle - Math.PI / 2 + (i / capSegments) * Math.PI
    outline.push({ x: p1.x + halfWidth * Math.cos(theta), y: p1.y + halfWidth * Math.sin(theta) })
  }
  for (let i = 0; i <= capSegments; i++) {
    const theta = angle + Math.PI / 2 + (i / capSegments) * Math.PI
    outline.push({ x: p0.x + halfWidth * Math.cos(theta), y: p0.y + halfWidth * Math.sin(theta) })
  }
  return outline
}

const TAU_INTERNAL = Math.PI * 2

/**
 * Tessellate the circular arc through three points (start, mid, end) into a
 * polyline. Chooses the sweep direction that passes through `m`. Degenerate
 * (collinear) input falls back to the chord. Shared by the Gerber writer (stroked
 * arcs) and the CPL preview (board-outline arcs).
 */
export function arcThroughPoints(a: Pt, m: Pt, b: Pt): Pt[] {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y))
  if (Math.abs(d) < 1e-9) return [a, b]
  const a2 = a.x * a.x + a.y * a.y
  const m2 = m.x * m.x + m.y * m.y
  const b2 = b.x * b.x + b.y * b.y
  const cx = (a2 * (m.y - b.y) + m2 * (b.y - a.y) + b2 * (a.y - m.y)) / d
  const cy = (a2 * (b.x - m.x) + m2 * (a.x - b.x) + b2 * (m.x - a.x)) / d
  const r = Math.hypot(a.x - cx, a.y - cy)
  const start = Math.atan2(a.y - cy, a.x - cx)
  const midA = Math.atan2(m.y - cy, m.x - cx)
  const end = Math.atan2(b.y - cy, b.x - cx)
  const norm = (v: number): number => ((v % TAU) + TAU) % TAU
  const ccwMid = norm(midA - start)
  const ccwEnd = norm(end - start)
  const sweep = ccwMid <= ccwEnd ? ccwEnd : ccwEnd - TAU
  return tessellateArc(cx, cy, r, start, sweep)
}

/** Closed circle outline (for polygon holes cut into flashed shapes). */
export function circleOutline(cx: number, cy: number, r: number, segments = 48): GerberPoint[] {
  const points: GerberPoint[] = []
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return points
}

/** Closed outline of a rectangle, rotated about its center. */
export function rectOutline(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  rotation: number
): GerberPoint[] {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const corners: Array<[number, number]> = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH]
  ]
  return corners.map(([x, y]) => ({ x: cx + x * cos - y * sin, y: cy + x * sin + y * cos }))
}

/** Closed outline of an obround (stadium) flash spanning w × h at (cx, cy). */
export function obroundOutline(
  cx: number,
  cy: number,
  w: number,
  h: number,
  segments = 24
): GerberPoint[] {
  const r = Math.min(w, h) / 2
  // Cap centers along the long axis
  const dx = Math.max(0, w / 2 - r)
  const dy = Math.max(0, h / 2 - r)
  const points: GerberPoint[] = []
  const cap = (ccx: number, ccy: number, from: number): void => {
    for (let i = 0; i <= segments; i++) {
      const a = from + (Math.PI * i) / segments
      points.push({ x: ccx + r * Math.cos(a), y: ccy + r * Math.sin(a) })
    }
  }
  if (dx >= dy) {
    cap(cx + dx, cy, -Math.PI / 2)
    cap(cx - dx, cy, Math.PI / 2)
  } else {
    cap(cx, cy + dy, 0)
    cap(cx, cy - dy, Math.PI)
  }
  return points
}
