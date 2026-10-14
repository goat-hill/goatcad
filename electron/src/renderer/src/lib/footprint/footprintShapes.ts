/**
 * A parsed footprint's graphics as ids and clearance shapes, shared by the
 * checks (`footprintChecks.ts`) and the item layer (`footprintItems.ts`).
 *
 * Ids follow `docs/agent-api.md`: the node's uuid, or
 * `<kind>@x,y` in millimeters for a node the file gave none.
 */
import type { KicadFootprint, KicadPad } from '../kicad/footprint'
import type { SExprNode } from '../kicad/sexpr'
import { mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import { padShape, rotateLocal, type Point, type Shape } from './footprintGeometry'

export type GraphicKind = 'line' | 'arc' | 'circle' | 'rect' | 'poly'

export const positionalId = (kind: string, at: { x: number; y: number }): string =>
  `${kind}@${nmToMm(at.x as Nm)},${nmToMm(at.y as Nm)}`

/** A graphic's id: its uuid, else its kind at its first point. */
export const graphicId = (kind: GraphicKind, uuid: string | undefined, at: Point): string =>
  uuid ?? positionalId(kind, at)

export const padId = (pad: KicadPad): string => pad.uuid ?? positionalId('pad', pad.position)

/** A pad's copper as a shape: KiCad draws it at the pad plus the drill's `offset`, turned with it. */
export const padClearanceShape = (pad: KicadPad, grow = 0): Shape => {
  const angle = pad.position.angle ?? 0
  const offset = pad.drill?.offset
    ? rotateLocal(pad.drill.offset.x, pad.drill.offset.y, angle)
    : null
  return padShape(
    {
      shape: pad.shape,
      position: offset
        ? { x: pad.position.x + offset.x, y: pad.position.y + offset.y, angle }
        : pad.position,
      size: pad.size,
      roundrectRatio: pad.roundrectRatio
    },
    grow
  )
}

/**
 * How far a chord may cut inside the true curve. KiCad measures arcs and
 * circles exactly, so a coarse polyline reads a silk ring round a hole as
 * touching it; at 1 µm the chords are below any clearance a check compares.
 */
const ARC_TOLERANCE: Nm = mmToNm(0.001)

/** Chords for a sweep of `radius` whose sagitta stays within `ARC_TOLERANCE`. */
const chordSteps = (radius: number, sweep: number): number =>
  radius <= ARC_TOLERANCE
    ? 2
    : Math.max(2, Math.ceil(Math.abs(sweep) / (2 * Math.acos(1 - ARC_TOLERANCE / radius))))

/** Three points on a circle → points along the arc from `start` to `end`. */
export const arcPolyline = (start: Point, mid: Point, end: Point, count?: number): Point[] => {
  const d = 2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y))
  if (Math.abs(d) < 1e-9) return [start, end]
  const s2 = start.x ** 2 + start.y ** 2
  const m2 = mid.x ** 2 + mid.y ** 2
  const e2 = end.x ** 2 + end.y ** 2
  const center = {
    x: (s2 * (mid.y - end.y) + m2 * (end.y - start.y) + e2 * (start.y - mid.y)) / d,
    y: (s2 * (end.x - mid.x) + m2 * (start.x - end.x) + e2 * (mid.x - start.x)) / d
  }
  const radius = Math.hypot(start.x - center.x, start.y - center.y)
  const angle = (p: Point): number => Math.atan2(p.y - center.y, p.x - center.x)
  const a0 = angle(start)
  const norm = (a: number): number => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  // Go the way that passes through mid.
  let sweep = norm(angle(end) - a0)
  if (norm(angle(mid) - a0) > sweep) sweep -= 2 * Math.PI
  const steps = count ?? chordSteps(radius, sweep)
  // The ends are the stored points, not trig's approximation of them, so a joint is exact.
  return Array.from({ length: steps + 1 }, (_, i) => {
    if (i === 0) return start
    if (i === steps) return end
    const a = a0 + (sweep * i) / steps
    return { x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) }
  })
}

export const circlePolyline = (
  center: Point,
  radius: number,
  steps = chordSteps(radius, 2 * Math.PI)
): Point[] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = (2 * Math.PI * i) / steps
    return { x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) }
  })

/** One drawn graphic, reduced to what clearance and style checks read. */
export interface Stroke {
  id: string
  kind: GraphicKind
  /** The graphic's AST node: what a finding names it by, for selection. */
  node: SExprNode
  layer: string
  width: number
  /** Consecutive points; a closed outline repeats its first point. */
  path: Point[]
  /** A filled shape's area, as a clearance shape. */
  filled: Shape | null
  closed: boolean
}

const closedPath = (points: Point[]): Point[] => (points.length ? [...points, points[0]] : points)

/** Every graphic of a footprint, in file order by kind. */
export const footprintStrokes = (fp: KicadFootprint): Stroke[] => {
  const out: Stroke[] = []
  for (const line of fp.fpLines) {
    out.push({
      id: graphicId('line', line.uuid, line.start),
      kind: 'line',
      node: line._raw,
      layer: line.layer ?? '',
      width: line.strokeWidth ?? 0,
      path: [line.start, line.end],
      filled: null,
      closed: false
    })
  }
  for (const arc of fp.fpArcs) {
    out.push({
      id: graphicId('arc', arc.uuid, arc.start),
      kind: 'arc',
      node: arc._raw,
      layer: arc.layer ?? '',
      width: arc.strokeWidth ?? 0,
      path: arcPolyline(arc.start, arc.mid, arc.end),
      filled: null,
      // KiCad reads an arc that ends where it starts as a whole circle.
      closed: arc.start.x === arc.end.x && arc.start.y === arc.end.y
    })
  }
  for (const circle of fp.fpCircles) {
    const radius = Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y)
    const solid = circle.fill === 'solid' || circle.fill === 'yes'
    out.push({
      id: graphicId('circle', circle.uuid, circle.center),
      kind: 'circle',
      node: circle._raw,
      layer: circle.layer ?? '',
      width: circle.strokeWidth ?? 0,
      path: circlePolyline(circle.center, radius),
      filled: solid ? { core: [circle.center], radius } : null,
      closed: true
    })
  }
  for (const rect of fp.fpRects) {
    const corners = [
      rect.start,
      { x: rect.end.x, y: rect.start.y },
      rect.end,
      { x: rect.start.x, y: rect.end.y }
    ]
    const solid = rect.fill === 'solid' || rect.fill === 'yes'
    out.push({
      id: graphicId('rect', rect.uuid, rect.start),
      kind: 'rect',
      node: rect._raw,
      layer: rect.layer ?? '',
      width: rect.strokeWidth ?? 0,
      path: closedPath(corners),
      filled: solid ? { core: corners, radius: 0 } : null,
      closed: true
    })
  }
  for (const poly of fp.fpPolys) {
    if (!poly.points.length) continue
    out.push({
      id: graphicId('poly', poly.uuid, poly.points[0]),
      kind: 'poly',
      node: poly._raw,
      layer: poly.layer ?? '',
      width: poly.strokeWidth ?? 0,
      path: closedPath(poly.points),
      // A filled polygon may be concave; its outline stands in for its area.
      filled: null,
      closed: poly.points.length >= 3
    })
  }
  return out
}

/** Whether a copper or mask layer list reaches the given side. */
export const onSide = (layers: string[], side: 'F' | 'B', suffix: string): boolean =>
  layers.some(
    (layer) => layer === `${side}.${suffix}` || layer === `*.${suffix}` || layer === `F&B.${suffix}`
  )
