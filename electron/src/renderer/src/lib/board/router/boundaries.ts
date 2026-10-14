/**
 * What bounds a route besides copper (docs/router-behavior.md R16): the board
 * edge at its edge clearance, and the keepouts that forbid tracks. None of
 * them moves or belongs to a net. The edge is held to the routed net's own
 * edge clearance where the world has rules (world.ts), else to the one
 * given here; a keepout to none. The keepouts that forbid vias are kept
 * apart: they bound only the vias a route places (R24).
 *
 * The board's outer edge is the straight run of its convex hull, as lines
 * with no width, as DRC measures them (drc/rules/edge.ts); each notch the
 * board leaves in that hull, each cutout and each keepout is an area, in
 * convex pieces that tile it (KiCad's router triangulates its keepouts).
 * Collision reaches an area's inside, and the route walks round each piece,
 * so it goes into a recess of any of them wide enough for it; the walk
 * never takes a side that leaves the board (walkaround.ts).
 *
 * A pad's hole is a boundary too on the copper layers its pad has no copper
 * on (a mounting hole, a pad not flashed there), held at the hole clearance
 * the rules give (R24). Every drilled hole, flashed or not, is listed for
 * the hole-to-hole spacing a via keeps.
 */

import type { KicadBoard } from '../../kicad/board'
import { isCopperLayer } from '../../kicad/layers'
import { ShapeUtils, Vector2 } from 'three'
import { buildBoardOutline, type OutlineRegion } from '../../engine/board3d/boardOutline'
import type { Region } from '../../geometry/polygon'
import { boardKeepouts } from '../keepouts'
import { footprintTransform, tfPoint } from '../../schematic/placement'
import { nmToMm } from '../../kicad/coordinates'
import {
  padHoleShape,
  polyShape,
  resolvePadCopperLayers,
  type BoardSpatialIndex,
  type CopperItem,
  type CopperShape,
  type Pt
} from '../spatialIndex'
import { nextOverlayId } from './world'

export type BoundaryKind = 'edge' | 'notch' | 'cutout' | 'keepout' | 'hole'

export interface Boundary {
  kind: BoundaryKind
  /** How far the route's copper keeps from it without rules: the edge clearance, a hole's, or 0 for a keepout. */
  clearance: number
  /** A hole's pad, which the rules ask its own clearance of. */
  pad?: { footprint: number; pad: number }
}

/** A pad's drilled hole. */
export interface RouterHole {
  shape: Extract<CopperShape, { kind: 'capsule' }>
  net: number
  footprint: number
  pad: number
}

export interface RouterBounds {
  items: CopperItem[]
  /** Each item's boundary, by id. */
  of: ReadonlyMap<number, Boundary>
  /** The board's pieces; none when it has no closed outline, and then nothing is off it. */
  regions: readonly OutlineRegion[]
  /** The largest clearance any of them asks. */
  reach: number
  /** Keepouts that forbid vias, on the copper layers they apply to. */
  viaKeepouts: ReadonlyArray<{ region: Region; layers: readonly string[] }>
  /** Every pad's hole, flashed or not. */
  holes: readonly RouterHole[]
  /** A board via's drill by its index, mm. */
  viaDrill: (index: number) => number
}

/**
 * The edge, track keepouts and unflashed holes of a board, for its router
 * world. `index` says which layers each pad has copper on; without it, the
 * layers its file names.
 */
export function routerBounds(
  board: KicadBoard,
  edgeClearance: number,
  { holeClearance = 0, index }: { holeClearance?: number; index?: BoardSpatialIndex } = {}
): RouterBounds {
  const copper = board.layers.filter((l) => isCopperLayer(l.name)).map((l) => l.name)
  const items: CopperItem[] = []
  const of = new Map<number, Boundary>()
  const add = (
    shape: CopperShape,
    layers: readonly string[],
    boundary: Boundary,
    net = -1
  ): void => {
    const item = boundaryItem(shape, layers, net)
    items.push(item)
    of.set(item.id, boundary)
  }

  const outline = buildBoardOutline(board)
  // A stand-in box is no edge: routing is not held to a shape the board lacks.
  const regions = outline.fallback ? [] : outline.regions
  const edge: Boundary = { kind: 'edge', clearance: edgeClearance }
  const notch: Boundary = { kind: 'notch', clearance: edgeClearance }
  const cutout: Boundary = { kind: 'cutout', clearance: edgeClearance }
  const line = (a: Pt, b: Pt): void => {
    if (a.x !== b.x || a.y !== b.y)
      add({ kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth: 0 }, copper, edge)
  }
  const area = (ring: readonly Pt[], boundary: Boundary): void => {
    for (const piece of convexPieces({ outer: [...ring], holes: [] }))
      add(polyShape([piece]), copper, boundary)
  }
  for (const region of regions) {
    const ring = region.outer
    const corners = hullIndices(ring)
    for (let k = 0; k < corners.length; k++) {
      const from = corners[k]
      const to = corners[(k + 1) % corners.length]
      const run: Pt[] = []
      for (let i = from; ; i = (i + 1) % ring.length) {
        run.push(ring[i])
        if (i === to) break
      }
      // A run that leaves the hull and comes back is a notch.
      if (run.length > 2 && Math.abs(signedArea(run)) > NOTCH_MIN_AREA) area(run, notch)
      else for (let i = 0; i < run.length - 1; i++) line(run[i], run[i + 1])
    }
    for (const hole of region.holes) if (hole.length >= 3) area(hole, cutout)
  }

  const viaKeepouts: Array<{ region: Region; layers: readonly string[] }> = []
  for (const keepout of boardKeepouts(board)) {
    const layers = keepout.layers.filter((l) => copper.includes(l))
    if (layers.length === 0) continue
    if (!keepout.rules.vias) viaKeepouts.push({ region: keepout.region, layers })
    if (keepout.rules.tracks) continue
    for (const piece of convexPieces(keepout.region))
      add(polyShape([piece]), layers, { kind: 'keepout', clearance: 0 })
  }

  const flashed = new Map<string, readonly string[]>()
  for (const item of index?.items ?? [])
    if (item.ref.type === 'pad') flashed.set(`${item.ref.index}|${item.ref.pad}`, item.layers)
  const holes: RouterHole[] = []
  board.footprints.forEach((bfp, footprint) => {
    const tf = footprintTransform(bfp)
    bfp.footprint.pads.forEach((pad, padIndex) => {
      const shape = padHoleShape(pad, tfPoint(tf, pad.position.x, pad.position.y))
      if (!shape || shape.kind !== 'capsule') return
      const net = pad.net?.number ?? 0
      holes.push({ shape, net, footprint, pad: padIndex })
      const onCopper = index
        ? (flashed.get(`${footprint}|${padIndex}`) ?? [])
        : resolvePadCopperLayers(pad, copper)
      const bare = copper.filter((l) => !onCopper.includes(l))
      if (bare.length === 0) return
      add(
        shape,
        bare,
        { kind: 'hole', clearance: holeClearance, pad: { footprint, pad: padIndex } },
        net
      )
    })
  })

  const reach = Math.max(0, ...[...of.values()].map((b) => b.clearance))
  const viaDrill = (i: number): number => nmToMm(board.vias[i]?.drill ?? 0)
  return { items, of, regions, reach, viaKeepouts, holes, viaDrill }
}

/** Below this (mm²) a run off the hull is rounding, not a notch. */
const NOTCH_MIN_AREA = 1e-6

/**
 * The ring's points on its convex hull, in ring order — those along a
 * straight side too, where a notch leaves it.
 */
function hullIndices(ring: readonly Pt[]): number[] {
  const order = ring.map((_, i) => i).sort((a, b) => ring[a].x - ring[b].x || ring[a].y - ring[b].y)
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (ids: readonly number[]): number[] => {
    const out: number[] = []
    for (const i of ids) {
      while (
        out.length >= 2 &&
        cross(ring[out[out.length - 2]], ring[out[out.length - 1]], ring[i]) < 0
      )
        out.pop()
      out.push(i)
    }
    out.pop()
    return out
  }
  return [...new Set([...half(order), ...half([...order].reverse())])].sort((a, b) => a - b)
}

/**
 * An area as convex pieces that tile it: its triangles, each merged with a
 * neighbour across a shared side while the two stay convex (Hertel and
 * Mehlhorn's), so a rectangle stays one piece.
 */
export function convexPieces(region: Region): Pt[][] {
  const contour = region.outer.map((p) => new Vector2(p.x, p.y))
  const holes = region.holes
    .filter((h) => h.length >= 3)
    .map((h) => h.map((p) => new Vector2(p.x, p.y)))
  const faces = ShapeUtils.triangulateShape(contour, holes)
  // triangulateShape drops a closing duplicate from the rings it is given,
  // so the vertex list is read back from them afterwards.
  const points: Pt[] = [contour, ...holes].flat().map((v) => ({ x: v.x, y: v.y }))
  const pieces: number[][] = faces.map((f) =>
    signedArea(f.map((i) => points[i])) < 0 ? [...f].reverse() : [...f]
  )
  for (let merged = true; merged;) {
    merged = false
    for (let i = 0; i < pieces.length && !merged; i++) {
      for (let j = i + 1; j < pieces.length && !merged; j++) {
        const joined = mergeAcross(pieces[i], pieces[j])
        if (!joined || !isConvex(joined.map((k) => points[k]))) continue
        pieces[i] = joined
        pieces.splice(j, 1)
        merged = true
      }
    }
  }
  return pieces.map((piece) => piece.map((k) => points[k]))
}

/** Two counterclockwise rings sharing a side, as one ring without it; null when they share none. */
function mergeAcross(a: readonly number[], b: readonly number[]): number[] | null {
  for (let i = 0; i < a.length; i++) {
    const from = a[i]
    const to = a[(i + 1) % a.length]
    const j = b.findIndex((v, k) => v === to && b[(k + 1) % b.length] === from)
    if (j < 0) continue
    const out: number[] = []
    for (let k = 1; k <= a.length; k++) out.push(a[(i + k) % a.length])
    for (let k = 2; k < b.length; k++) out.push(b[(j + k) % b.length])
    return out
  }
  return null
}

function isConvex(ring: readonly Pt[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    const o = ring[i]
    const a = ring[(i + 1) % ring.length]
    const b = ring[(i + 2) % ring.length]
    if ((a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) < -1e-12) return false
  }
  return true
}

/** Positive counterclockwise. */
function signedArea(ring: readonly Pt[]): number {
  let area = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    area += ring[j].x * ring[i].y - ring[i].x * ring[j].y
  return area / 2
}

function boundaryItem(shape: CopperShape, layers: readonly string[], net: number): CopperItem {
  const box =
    shape.kind === 'capsule'
      ? {
          minX: Math.min(shape.x0, shape.x1) - shape.halfWidth,
          minY: Math.min(shape.y0, shape.y1) - shape.halfWidth,
          maxX: Math.max(shape.x0, shape.x1) + shape.halfWidth,
          maxY: Math.max(shape.y0, shape.y1) + shape.halfWidth
        }
      : shape.kind === 'poly'
        ? { minX: shape.minX, minY: shape.minY, maxX: shape.maxX, maxY: shape.maxY }
        : { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity }
  // A net of −1 is none: no route's own net ever matches it. A hole keeps
  // its pad's, since a hole does not hold its own net's copper off. Its ref
  // names nothing on the board, so it is never reported or hidden as a board item.
  return {
    id: nextOverlayId(),
    ref: { type: 'drawing', index: -1 },
    net,
    layers,
    shape,
    ...box
  }
}
