/**
 * What the board check modules share (`drc/context.ts`, `drc/rules/`): KiCad's
 * DRC constants, the shapes a finding names things by, and the geometry the
 * rules measure with. World space: millimeters, y up.
 */
import type { KicadBoardZone, KicadVia } from '../../kicad/board'
import { type KicadPad, isSolidFill } from '../../kicad/footprint'
import { mmToNm, nmToMm, type Nm } from '../../kicad/coordinates'
import type { CheckResult } from '../../schematic/checks'
import {
  pointToShape,
  sampleArc,
  shapeCenter,
  type PadFrame,
  shapeToShape,
  type CopperItem,
  type CopperShape,
  type Pt
} from '../spatialIndex'
import { type AirwireRef } from '../boardConnectivity'
import { capsuleOutline, shapeOutlines } from '../shapeOutline'
import { union, type ClipRegion } from '../../geometry/clip'
import { YStripes } from '../../geometry/yStripes'
import { arcContainsMidCCW, circumscribedCircle } from '../../engine/arcGeometry'
import type { FootprintCourtyard } from '../courtyards'
import type { DrawingKind } from '../boardDrawings'
import type { RuleItem, RuleSeverity } from '../rules/constraints'
import {
  boxesTouch,
  regionsOverlap,
  ringBox,
  segmentDistance,
  segmentsCrossing,
  type Box,
  type Region
} from '../../geometry/polygon'

/**
 * KiCad's `m_DRCEpsilon` (mm): a gap that short of the rule still passes, so
 * copper drawn exactly at the clearance is not a violation by float noise.
 */
export const DRC_EPSILON = nmToMm(mmToNm(0.0005))

/**
 * KiCad deflates each courtyard by its `maxError` (5 µm) before testing, so
 * touching courtyards are legal; an overlap has to reach past both.
 */
export const COURTYARD_TOUCH = nmToMm(mmToNm(0.01))

/** Items between yields of the cooperative run. */
export const STEP = 64

/** How a finding names a copper drawing of each kind. */
export const DRAWING_NAMES: Record<DrawingKind, string> = {
  graphic: 'graphic',
  text: 'text',
  textbox: 'text box',
  table: 'table',
  cell: 'table cell',
  dimension: 'dimension',
  leader: 'leader'
}

/**
 * The drawings KiCad's pad pass tests (`testPadAgainstItem`): all but graphics,
 * which test pads from their own side, and text boxes, which neither does.
 */
export const PAD_TESTED: ReadonlySet<DrawingKind> = new Set([
  'text',
  'table',
  'cell',
  'dimension',
  'leader'
])

/** Longest a fill loop runs between yields, ms. */
export const SLICE_MS = 4

export const round = (mm: number): number => Math.round(mm * 1e4) / 1e4
export const fmt = (mm: number): string => `${round(mm).toFixed(4)} mm`

/** A world point as the finding's position: board mm, y down. */
export const at = (p: Pt): { x: number; y: number } => ({ x: round(p.x), y: round(-p.y) })

export const worldOf = (p: { x: Nm; y: Nm }): Pt => ({ x: nmToMm(p.x), y: -nmToMm(p.y) })

/** `<kind>@x,y` for an item the file gave no uuid, in board mm. */
export const positional = (kind: string, p: Pt): string => `${kind}@${round(p.x)},${round(-p.y)}`

/** A finding's own severity from the rule that decided it, where that rule sets one. */
export const ownSeverity = (severity: RuleSeverity | undefined): { ruleSeverity?: RuleSeverity } =>
  severity ? { ruleSeverity: severity } : {}

/** What a finding says about one thing on the board. */
export interface Subject {
  /** What an agent reads: the item's id as `items_get` takes it (`boardItemIds`). */
  item: string
  /**
   * Which item the rules take it for, where that is not `item`: a pad by its
   * footprint and number, so two pads of one number are one pad (`keyOf`).
   */
  key?: string
  /** What a person reads: `R1.2`, `track GND`. */
  name: string
  /** The uuids the editor selects: a pad's footprint, a track's own. */
  targets: string[]
  /** KiCad's identity for the item, where it is not `targets`: a pad's own uuid. */
  ids?: string[]
}

/** Which item the rules take a subject for: what they compare and order by. */
export const keyOf = (subject: Subject): string => subject.key ?? subject.item

/** The KiCad item ids a subject stands for, as a KiCad exclusion names them. */
export const idsOf = (subject: Subject): string[] => subject.ids ?? subject.targets

/** An indexed copper item with what the rules need to know about it. */
export interface Copper {
  ref: CopperItem
  subject: Subject
  /** The footprint this pad belongs to; null for tracks and vias. */
  footprint: number | null
  padNumber: string | null
  /** False for an unplated hole with no copper ring, and for pads edge rules skip. */
  copper: boolean
  /** Whether the edge rule tests it: castellated and edge-connector pads sit on the edge. */
  edgeTested: boolean
}

export type Capsule = Extract<CopperShape, { kind: 'capsule' }>

/** A drilled hole, whether or not its pad has copper. */
export interface Hole {
  shape: Capsule
  /** The copper layers the hole passes: every one for a pad, the span for a via. */
  layers: readonly string[]
  net: number
  subject: Subject
  footprint: number | null
  plated: boolean
  micro: boolean
  /** The index item this hole belongs to, when it has copper. */
  item: CopperItem | null
  /** The pad drilled, for the rules that read its properties; null for a via. */
  pad: KicadPad | null
  box: Box
  center: Pt
}

export const capsuleBox = (shape: Capsule): Box => ({
  minX: Math.min(shape.x0, shape.x1) - shape.halfWidth,
  minY: Math.min(shape.y0, shape.y1) - shape.halfWidth,
  maxX: Math.max(shape.x0, shape.x1) + shape.halfWidth,
  maxY: Math.max(shape.y0, shape.y1) + shape.halfWidth
})

export const samplesAlong = (x0: number, y0: number, x1: number, y1: number, count = 16): Pt[] =>
  Array.from({ length: count + 1 }, (_, i) => ({
    x: x0 + ((x1 - x0) * i) / count,
    y: y0 + ((y1 - y0) * i) / count
  }))

/** The point of a shape's centerline nearest another shape — where a marker goes. */
export const nearestPoint = (shape: CopperShape, other: CopperShape): Pt => {
  if (shape.kind === 'compound') {
    const part = shape.parts.reduce((best, p) =>
      shapeToShape(p, other) < shapeToShape(best, other) ? p : best
    )
    return nearestPoint(part, other)
  }
  const candidates: Pt[] =
    shape.kind === 'capsule'
      ? samplesAlong(shape.x0, shape.y0, shape.x1, shape.y1)
      : shape.kind === 'arc'
        ? sampleArc(shape.x0, shape.y0, shape.mx, shape.my, shape.x1, shape.y1)
        : [shapeCenter(shape)]
  const distances = candidates.map((p) => pointToShape(other, p.x, p.y))
  const best = Math.min(...distances)
  // Parallel copper is nearest along a whole span: mark its middle, not its first point.
  const nearest = candidates.filter((_, i) => distances[i] <= best + 1e-9)
  return nearest[Math.floor((nearest.length - 1) / 2)]
}

/** Midway between the two nearest centerline points: KiCad's "nearby location" for a pair. */
export const between = (a: CopperShape, b: CopperShape): Pt => {
  const pa = nearestPoint(a, b)
  const pb = nearestPoint(b, a)
  return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }
}

/**
 * KiCad's `FlashLayer` for an unplated hole: a round or oval pad whose drill
 * is at least its size has no copper ring, only a hole.
 */
export const npthWithoutRing = (pad: KicadPad): boolean => {
  if (pad.type !== 'np_thru_hole' || !pad.drill) return false
  if (pad.drill.offset && (pad.drill.offset.x !== 0 || pad.drill.offset.y !== 0)) return false
  if (pad.shape === 'circle' && !pad.drill.oval) return pad.drill.diameter >= pad.size.w
  if (pad.shape === 'oval' && pad.drill.oval)
    return pad.drill.oval.width >= pad.size.w && pad.drill.oval.height >= pad.size.h
  return false
}

/** The finished drill of a via as the index measures copper. */
export const viaHole = (via: KicadVia): Capsule => {
  const p = worldOf(via.position)
  return { kind: 'capsule', x0: p.x, y0: p.y, x1: p.x, y1: p.y, halfWidth: nmToMm(via.drill) / 2 }
}

export const capsuleCenter = (c: Capsule): Pt => ({ x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2 })
export const isRound = (c: Capsule): boolean => c.x0 === c.x1 && c.y0 === c.y1

export const byCodeThenItems = (a: CheckResult, b: CheckResult): number =>
  a.code.localeCompare(b.code) || a.items.join(',').localeCompare(b.items.join(','))

export const unionBox = (a: Box, b: Box): Box => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY)
})

/** The first overlap between any region of one side and any of the other. */
export const overlapOf = (a: readonly Region[], b: readonly Region[]): Pt | null => {
  for (const ra of a) {
    const boxA = ringBox(ra.outer)
    for (const rb of b) {
      if (!boxesTouch(boxA, ringBox(rb.outer))) continue
      const hit = regionsOverlap(ra, rb, COURTYARD_TOUCH)
      if (hit) return hit
    }
  }
  return null
}

/** A point inside a piece of copper: where its marker goes when nothing nearer is known. */
export interface EdgeIndexed {
  ring: Pt[]
  stripes: YStripes
}

/** Every edge of `ring` near the segment `p`→`q`, as the stripes index finds it. */
export const edgesNear = (
  target: EdgeIndexed,
  p: Pt,
  q: Pt,
  reach: number,
  visit: (c: Pt, d: Pt) => boolean
): boolean =>
  target.stripes.someEdgeInYRange(
    Math.min(p.y, q.y) - reach,
    Math.max(p.y, q.y) + reach,
    (c, d) =>
      Math.max(c.x, d.x) >= Math.min(p.x, q.x) - reach &&
      Math.min(c.x, d.x) <= Math.max(p.x, q.x) + reach &&
      Math.max(c.y, d.y) >= Math.min(p.y, q.y) - reach &&
      Math.min(c.y, d.y) <= Math.max(p.y, q.y) + reach &&
      visit(c, d)
  )

/**
 * The first place two rings' edges come closer than `limit`, compared in
 * whole nanometers as KiCad's zone-to-zone test compares them; null when none.
 */
export const ringsWithin = (
  a: EdgeIndexed,
  b: EdgeIndexed,
  limit: number
): { actual: number; at: Pt } | null => {
  const limitNm = mmToNm(limit)
  const reach = ringBox(b.ring)
  for (let i = 0, j = a.ring.length - 1; i < a.ring.length; j = i++) {
    const p = a.ring[j]
    const q = a.ring[i]
    if (
      Math.max(p.x, q.x) < reach.minX - limit ||
      Math.min(p.x, q.x) > reach.maxX + limit ||
      Math.max(p.y, q.y) < reach.minY - limit ||
      Math.min(p.y, q.y) > reach.maxY + limit
    )
      continue
    let hit: { actual: number; at: Pt } | null = null
    edgesNear(b, p, q, limit, (c, d) => {
      const actual = segmentDistance(p, q, c, d)
      if (mmToNm(actual) >= limitNm) return false
      const mid = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 }
      const along = nearestPoint(
        { kind: 'capsule', x0: p.x, y0: p.y, x1: q.x, y1: q.y, halfWidth: 0 },
        {
          kind: 'circle',
          cx: mid.x,
          cy: mid.y,
          r: 0
        }
      )
      hit = { actual, at: along }
      return true
    })
    if (hit) return hit
  }
  return null
}

/** Where two outlines meet — touching counts, as KiCad's polygon collision has it; null when apart. */
export const outlinesMeet = (
  a: EdgeIndexed & { box: Box },
  b: EdgeIndexed & { box: Box }
): Pt | null => {
  if (!boxesTouch(a.box, b.box)) return null
  const inB = a.ring.find((p) => b.stripes.contains(p))
  if (inB) return inB
  const inA = b.ring.find((p) => a.stripes.contains(p))
  if (inA) return inA
  for (let i = 0, j = a.ring.length - 1; i < a.ring.length; j = i++) {
    const p = a.ring[j]
    const q = a.ring[i]
    if (edgesNear(b, p, q, 1e-9, (c, d) => segmentDistance(p, q, c, d) <= 1e-9)) return q
  }
  return null
}

/** Where two segments meet, their ends included; null when apart or collinear. */
export const segmentsMeet = (p: Pt, q: Pt, c: Pt, d: Pt): Pt | null => {
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const d1 = cross(p, q, c)
  const d2 = cross(p, q, d)
  const d3 = cross(c, d, p)
  const d4 = cross(c, d, q)
  if (d1 * d2 > 0 || d3 * d4 > 0 || (d1 === 0 && d2 === 0)) return null
  return segmentsCrossing(p, q, c, d)
}

/**
 * Distinct points where an island's edges cross a closed ring, as KiCad's
 * `SHAPE_LINE_CHAIN::Intersect` counts them — through one of the ring's
 * vertices too, which a proper-crossing test would miss. At a vertex it counts
 * only a crossing: an edge that merely grazes the vertex depends on where
 * each engine happened to place it.
 */
export const ringCrossings = (ring: Pt[], island: EdgeIndexed): number => {
  const points: Pt[] = []
  const side = (c: Pt, d: Pt, o: Pt): number =>
    (d.x - c.x) * (o.y - c.y) - (d.y - c.y) * (o.x - c.x)
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n]
    const q = ring[i]
    const next = ring[(i + 1) % n]
    edgesNear(island, p, q, 0, (c, d) => {
      const x = segmentsMeet(p, q, c, d)
      if (!x) return false
      // A vertex belongs to the edge it ends: its start is the previous edge's end.
      if (Math.hypot(x.x - p.x, x.y - p.y) < 1e-9) return false
      if (Math.hypot(x.x - q.x, x.y - q.y) < 1e-9 && side(c, d, p) * side(c, d, next) >= 0)
        return false
      if (!points.some((o) => Math.hypot(o.x - x.x, o.y - x.y) < 1e-6)) points.push(x)
      return false
    })
  }
  return points.length
}

/**
 * A custom pad's outline grown by `inflate`, in world mm: its anchor and its
 * primitives — a filled one plus its own stroke width, as the Gerber writer
 * plots it (`plotCustomPad`) — unioned by the geometry engine. The first
 * outline, as KiCad's thermal check reads `Outline(0)`; null for any other
 * pad, or before the engine has loaded.
 */
export const customPadRing = (
  pad: KicadPad,
  shape: PadFrame | null,
  inflate: number
): Pt[] | null => customPadRegions(pad, shape, inflate)?.[0]?.outer ?? null

/**
 * A custom pad's anchor and primitives merged (`MergePrimitivesAsPolygon`),
 * grown by `inflate`: one region when they join, more when they do not; null
 * for any other pad, or before the geometry engine has loaded.
 */
export const customPadRegions = (
  pad: KicadPad,
  shape: PadFrame | null,
  inflate: number
): ClipRegion[] | null => {
  if (pad.shape !== 'custom' || !shape) return null
  const cos = Math.cos(shape.rotation)
  const sin = Math.sin(shape.rotation)
  // Pad-local nm, y down → world mm, y up, turned with the pad.
  const at = (p: { x: Nm; y: Nm }): Pt => {
    const x = nmToMm(p.x)
    const y = nmToMm(p.y)
    return { x: shape.cx + x * cos + y * sin, y: shape.cy + x * sin - y * cos }
  }
  const pieces: ClipRegion[] = []
  const piece = (outer: Pt[]): number => pieces.push({ outer, holes: [] })
  const stroke = (points: Pt[], width: Nm | undefined, closed: boolean): void => {
    const r = (width !== undefined ? nmToMm(width) : 0) / 2 + inflate
    const n = closed ? points.length : points.length - 1
    for (let i = 0; i < n; i++) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      piece(capsuleOutline(a.x, a.y, b.x, b.y, r))
    }
  }
  for (const ring of shapeOutlines(
    pad.anchor === 'rect'
      ? shape
      : { kind: 'circle', cx: shape.cx, cy: shape.cy, r: nmToMm(pad.size.w) / 2 },
    inflate
  ))
    piece(ring)
  const prims = pad.primitives
  for (const line of prims?.lines ?? [])
    stroke([at(line.start), at(line.end)], line.strokeWidth, false)
  for (const arc of prims?.arcs ?? []) {
    const [a, m, b] = [at(arc.start), at(arc.mid), at(arc.end)]
    stroke(sampleArc(a.x, a.y, m.x, m.y, b.x, b.y), arc.strokeWidth, false)
  }
  for (const circle of prims?.circles ?? []) {
    const c = at(circle.center)
    const e = at(circle.end)
    const radius = Math.hypot(e.x - c.x, e.y - c.y)
    const w = circle.strokeWidth !== undefined ? nmToMm(circle.strokeWidth) : 0
    if (isSolidFill(circle.fill))
      piece(shapeOutlines({ kind: 'circle', cx: c.x, cy: c.y, r: radius }, w / 2 + inflate)[0])
    else
      piece(shapeOutlines({ kind: 'circle', cx: c.x, cy: c.y, r: 0 }, radius + w / 2 + inflate)[0])
  }
  for (const rect of prims?.rects ?? []) {
    const corners = [
      at(rect.start),
      at({ x: rect.end.x, y: rect.start.y }),
      at(rect.end),
      at({ x: rect.start.x, y: rect.end.y })
    ]
    if (isSolidFill(rect.fill)) piece(corners)
    stroke(corners, rect.strokeWidth, true)
  }
  for (const poly of prims?.polys ?? []) {
    const points = poly.points.map(at)
    if (points.length < 2) continue
    if (isSolidFill(poly.fill) && points.length >= 3) piece(points)
    stroke(points, poly.strokeWidth, true)
  }
  return union(pieces, [])
}

export const refKey = (ref: AirwireRef): string =>
  ref.type === 'pad' ? `pad:${ref.index}:${ref.pad}` : `${ref.type}:${ref.index}`

/** One side of a clearance pair, as the rules see it. */
export type Side = RuleItem

/** A zone's stored fill on one layer: one island, its edges indexed. */
export interface FillRing {
  zone: KicadBoardZone
  zoneIndex: number
  /** Its index in the zone's `filledPolys`. */
  polyIndex: number
  layer: string
  net: number
  ring: Pt[]
  /** The ring's edges indexed by y, built when first read. */
  readonly stripes: YStripes
  box: Box
  subject: Subject
  side: Side
  teardrop: boolean
}

/** A footprint's courtyards with how a finding names it. */
export interface Courtyard extends FootprintCourtyard {
  subject: Subject
}

/** A finding with the rule module that made it and the boxes of what it involves. */
export interface Finding {
  result: CheckResult
  rule: string
  boxes: readonly Box[]
}

/** The length of an arc through three points, the way through its mid; a chord when they are collinear. */
export const arcLength = (a: Pt, m: Pt, b: Pt): number => {
  const circle = circumscribedCircle(a.x, a.y, m.x, m.y, b.x, b.y)
  if (!circle) return Math.hypot(b.x - a.x, b.y - a.y)
  const { cx, cy, r } = circle
  const ccw = arcContainsMidCCW(a, m, b, cx, cy)
  const [from, to] = ccw ? [a, b] : [b, a]
  let sweep = Math.atan2(to.y - cy, to.x - cx) - Math.atan2(from.y - cy, from.x - cx)
  if (sweep < 0) sweep += 2 * Math.PI
  return r * sweep
}

/** Shrinks a shape by a nanometer, so shapes that only touch no longer meet. */
const shrunk = (shape: CopperShape): CopperShape => {
  const by = 1e-6
  switch (shape.kind) {
    case 'capsule':
    case 'arc':
      return { ...shape, halfWidth: Math.max(0, shape.halfWidth - by) }
    case 'circle':
      return { ...shape, r: Math.max(0, shape.r - by) }
    case 'rrect':
      return {
        ...shape,
        halfW: Math.max(0, shape.halfW - by),
        halfH: Math.max(0, shape.halfH - by),
        cornerR: Math.max(0, shape.cornerR - by)
      }
    case 'poly':
      return shape
    case 'compound':
      return { ...shape, parts: shape.parts.map(shrunk) }
  }
}

/** A shape whose edge is its core: a polygon, a square-cornered rectangle, a line of no width. */
const hardEdged = (shape: CopperShape): boolean =>
  shape.kind === 'poly' ||
  (shape.kind === 'rrect' && shape.cornerR === 0) ||
  ((shape.kind === 'capsule' || shape.kind === 'arc') && shape.halfWidth === 0)

/**
 * Whether two shapes come closer than a clearance, as KiCad's shape collision
 * reads it in whole nanometers. At a clearance of 0 an overlap collides; so
 * does a touch between two hard edges (polygons, square rectangles), whose
 * outlines meet at no distance at all — but not a touch involving a stroke or
 * a circle, whose edge is its core's distance plus its width.
 */
export const collides = (a: CopperShape, b: CopperShape, clearance: number): boolean => {
  if (clearance > 0) return mmToNm(shapeToShape(a, b)) < mmToNm(clearance)
  const partsA = a.kind === 'compound' ? a.parts : [a]
  const partsB = b.kind === 'compound' ? b.parts : [b]
  return partsA.some((pa) =>
    partsB.some((pb) =>
      hardEdged(pa) && hardEdged(pb)
        ? Math.round(mmToNm(shapeToShape(pa, pb))) === 0
        : shapeToShape(shrunk(pa), shrunk(pb)) === 0
    )
  )
}

/** What an outline problem is, as a finding says it (`outlineValidation.ts`). */
export const OUTLINE_PROBLEM = {
  small: 'has a drawing too small to see',
  gap: 'is not closed',
  branch: 'branches',
  crossing: 'crosses itself'
} as const
