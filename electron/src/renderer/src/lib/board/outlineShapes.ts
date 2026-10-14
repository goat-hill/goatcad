/**
 * The drawings `outlineValidation.ts` reads, in world millimeters and in file
 * order: the board's Edge.Cuts, and each footprint side's courtyard.
 *
 * The board's outline leaves out a footprint's own closed Edge.Cuts outline
 * that cuts a hole — one with copper outside it, or more than one outline — as
 * KiCad builds its board outline without them; the meeting-contour test still
 * sees them (`outlineProblems`, `board`).
 */
import type { KicadBoard, KicadBoardFootprint } from '../kicad/board'
import {
  rectOutline,
  type KicadFpArc,
  type KicadFpCircle,
  type KicadFpCurve,
  type KicadFpLine,
  type KicadFpPoly,
  type KicadFpRect
} from '../kicad/footprint'
import { mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import type { SExprNode } from '../kicad/sexpr'
import { footprintTransform, tfPoint } from '../schematic/placement'
import { bezierPoints, EDGE_CUTS } from '../engine/board3d/boardOutline'
import { padShape, sampleArc, shapeToShape, type CopperShape } from './spatialIndex'
import { worldOf } from './drc/shared'
import { chainContours, type OutlineShape, type Pt } from './outlineValidation'

type Graphic =
  | { kind: 'segment'; item: KicadFpLine }
  | { kind: 'arc'; item: KicadFpArc }
  | { kind: 'circle'; item: KicadFpCircle }
  | { kind: 'rect'; item: KicadFpRect }
  | { kind: 'poly'; item: KicadFpPoly }
  | { kind: 'bezier'; item: KicadFpCurve }

interface Drawings {
  lines: readonly KicadFpLine[]
  arcs: readonly KicadFpArc[]
  circles: readonly KicadFpCircle[]
  rects: readonly KicadFpRect[]
  polys: readonly KicadFpPoly[]
  curves: readonly KicadFpCurve[]
}

/** A set's drawings on a layer, in the order the file holds them. */
const onLayer = (
  drawings: Drawings,
  layer: string,
  order: (raw: SExprNode) => number
): Graphic[] => {
  const all: Graphic[] = [
    ...drawings.lines.map((item) => ({ kind: 'segment' as const, item })),
    ...drawings.arcs.map((item) => ({ kind: 'arc' as const, item })),
    ...drawings.circles.map((item) => ({ kind: 'circle' as const, item })),
    ...drawings.rects.map((item) => ({ kind: 'rect' as const, item })),
    ...drawings.polys.map((item) => ({ kind: 'poly' as const, item })),
    ...drawings.curves.map((item) => ({ kind: 'bezier' as const, item }))
  ]
  return all
    .filter((g) => g.item.layer === layer)
    .sort((a, b) => order(a.item._raw) - order(b.item._raw))
}

const orderIn = (parent: SExprNode): ((raw: SExprNode) => number) => {
  const index = new Map(parent.type === 'list' ? parent.children.map((c, i) => [c, i]) : [])
  return (raw) => index.get(raw) ?? Number.MAX_SAFE_INTEGER
}

const len = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

/** How far a circle's chords may stray inside it, mm: a board's default maximum error. */
const CIRCLE_ERROR_MM = nmToMm(mmToNm(0.005))

/**
 * A circle as a polygon with a vertex at each quarter turn from the x axis,
 * its chords within the error, as KiCad polygonizes one: where it touches a
 * line square to an axis, a vertex lies on the line.
 */
const circlePath = (center: Pt, r: number): Pt[] => {
  if (r <= 0) return [center]
  const ratio = Math.max(-1, Math.min(1, 1 - CIRCLE_ERROR_MM / r))
  const segments = Math.max(8, Math.ceil(Math.PI / Math.acos(ratio) / 4) * 4)
  return Array.from({ length: segments }, (_, k) => {
    const angle = (2 * Math.PI * k) / segments
    return { x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) }
  })
}

/** One drawing as the validator reads it, `at` placing its points in the world. */
function shapeOf(g: Graphic, at: (p: { x: Nm; y: Nm }) => Pt, id: string): OutlineShape | null {
  switch (g.kind) {
    case 'segment': {
      const start = at(g.item.start)
      const end = at(g.item.end)
      return { id, kind: 'segment', start, end, path: [start, end], size: len(start, end) }
    }
    case 'arc': {
      const start = at(g.item.start)
      const mid = at(g.item.mid)
      const end = at(g.item.end)
      const path = sampleArc(start.x, start.y, mid.x, mid.y, end.x, end.y)
      return { id, kind: 'arc', start, end, path, size: len(mid, start) + len(end, mid) }
    }
    case 'circle': {
      const center = at(g.item.center)
      const rim = at(g.item.end)
      const r = len(center, rim)
      return { id, kind: 'circle', start: center, end: rim, path: circlePath(center, r), size: r }
    }
    case 'rect': {
      const start = at(g.item.start)
      const end = at(g.item.end)
      const outline = rectOutline(g.item)
      const on = (p: { x: number; y: number }): Pt => at(p as { x: Nm; y: Nm })
      const path =
        outline.kind === 'corners'
          ? outline.corners.map(on)
          : outline.arcs.flatMap((arc) => {
              const [s, m, e] = [on(arc.start), on(arc.mid), on(arc.end)]
              return sampleArc(s.x, s.y, m.x, m.y, e.x, e.y)
            })
      return { id, kind: 'rect', start, end, path, size: len(start, end) }
    }
    case 'poly': {
      if (g.item.points.length < 2) return null
      const path = g.item.points.map(at)
      // KiCad's polygon has no start or end of its own: both read as the origin.
      const origin = at({ x: 0 as Nm, y: 0 as Nm })
      return { id, kind: 'poly', start: origin, end: origin, path, size: null }
    }
    case 'bezier': {
      if (g.item.points.length !== 4) return null
      const path = bezierPoints(g.item.points.map(at) as [Pt, Pt, Pt, Pt])
      return { id, kind: 'bezier', start: path[0], end: path[path.length - 1], path, size: null }
    }
  }
}

const shapesOf = (
  graphics: readonly Graphic[],
  at: (p: { x: Nm; y: Nm }) => Pt,
  prefix: string
): OutlineShape[] =>
  graphics.flatMap((g, i) => shapeOf(g, at, g.item.uuid ?? `${prefix}${i}`) ?? [])

const footprintDrawings = (bfp: KicadBoardFootprint): Drawings => ({
  lines: bfp.footprint.fpLines,
  arcs: bfp.footprint.fpArcs,
  circles: bfp.footprint.fpCircles,
  rects: bfp.footprint.fpRects,
  polys: bfp.footprint.fpPolys,
  curves: bfp.footprint.fpCurves
})

/** One footprint's drawings on a layer, placed. */
export function footprintShapes(bfp: KicadBoardFootprint, layer: string): OutlineShape[] {
  const tf = footprintTransform(bfp)
  const graphics = onLayer(footprintDrawings(bfp), layer, orderIn(bfp.footprint._raw))
  return shapesOf(graphics, (p) => tfPoint(tf, p.x, p.y), `${bfp.uuid ?? bfp.reference}:`)
}

/**
 * The board's Edge.Cuts: `all` every drawing (the meeting-contour test reads
 * them all), `outline` without a footprint's hole-cutting outline.
 */
export function boardEdgeShapes(board: KicadBoard): {
  all: OutlineShape[]
  outline: OutlineShape[]
} {
  const own = shapesOf(
    onLayer(
      {
        lines: board.grLines,
        arcs: board.grArcs,
        circles: board.grCircles,
        rects: board.grRects,
        polys: board.grPolys,
        curves: board.grCurves
      },
      EDGE_CUTS,
      orderIn(board._raw)
    ),
    worldOf,
    'edge:'
  )
  const fromFootprints: OutlineShape[] = []
  const kept: OutlineShape[] = []
  for (const bfp of board.footprints) {
    const shapes = footprintShapes(bfp, EDGE_CUTS)
    if (shapes.length === 0) continue
    fromFootprints.push(...shapes)
    if (!cutsHole(bfp, shapes)) kept.push(...shapes)
  }
  return { all: [...own, ...fromFootprints], outline: [...own, ...kept] }
}

/**
 * Whether a footprint's own Edge.Cuts close into a hole in the board: they
 * close, and either make more than one outline or leave a pad's copper
 * wholly outside them.
 */
function cutsHole(bfp: KicadBoardFootprint, shapes: readonly OutlineShape[]): boolean {
  const { contours, open } = chainContours(shapes, 0.01)
  if (open || contours.length === 0) return false
  const rings = contours.map((c) => c.ring).filter((ring) => ring.length >= 3)
  const depth = (i: number): number =>
    rings.filter((other, j) => j !== i && pointIn(other, rings[i][0])).length
  const outlines = rings.filter((_, i) => depth(i) % 2 === 0)
  if (outlines.length > 1) return true
  const tf = footprintTransform(bfp)
  return bfp.footprint.pads.some((pad) => {
    const center = tfPoint(tf, pad.position.x, pad.position.y)
    const copper = padShape(pad, center)
    return !outlines.some((ring) => pointIn(ring, center) || touches(ring, copper))
  })
}

const pointIn = (ring: readonly Pt[], p: Pt): boolean => {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

const touches = (ring: readonly Pt[], copper: CopperShape): boolean =>
  ring.some((p, i) => {
    const q = ring[(i + 1) % ring.length]
    return (
      shapeToShape(copper, {
        kind: 'capsule',
        x0: p.x,
        y0: p.y,
        x1: q.x,
        y1: q.y,
        halfWidth: 0
      }) === 0
    )
  })
