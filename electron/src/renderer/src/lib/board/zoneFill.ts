/**
 * Zone fill computation — copper pours over the Clipper2 kernel, in the y-up
 * world space the spatial index and board outline share — as KiCad's filler
 * computes them (`ZONE_FILLER::fillCopperZone`, set out in
 * docs/design-health-workstream.md). Per zone layer:
 *
 *   1. The start: the outline less its cutouts, joined with the outlines of
 *      the same-net zones it overlaps (so a shared border keeps no dent),
 *      clipped to the board and smoothed; the final trim is that envelope cut
 *      back to the outline, and the pour starts at most `min_thickness` past it.
 *   2. Pads of the zone's net by their connection: a thermal pad's gap is cut
 *      (no margin), a pad set to none is cut by the zone's own clearance, a
 *      solid pad is poured over. Same-net tracks and vias are poured over too.
 *   3. The clearance cuts: foreign copper and holes grown by their clearance
 *      (plus KiCad's 0.5 µm margin), the board edge by the edge clearance,
 *      copper-pour keepouts exactly.
 *   4. Spokes: four per thermal pad, from the center of its unrotated box to
 *      past its gap; a spoke is kept only when its tip lands in copper that
 *      survives the cuts and the minimum width.
 *   5. The minimum width: shrink by half of it less 1 µm (square corners),
 *      drop what is smaller than it both ways, grow back with round corners;
 *      then the trim to the envelope and the cuts again, and each thermal
 *      pad's bare hole.
 *   6. Zones that outrank it: another net's fill, grown by its clearance, cut
 *      and the minimum width pruned again; its own net's fill, cut as is.
 *
 * Then, over all the zone's layers, islands (pieces no pad of its net reaches
 * through copper) go by its removal mode, and pieces mostly off the board go.
 *
 * Exposed as a generator of cooperative steps so the caller can yield the
 * main thread between boolean passes (the 3D renderer's layerClips pattern).
 */

import { difference, intersection, merged, offset, union, type ClipRegion } from '../geometry/clip'
import { buildBoardOutline } from '../engine/board3d/boardOutline'
import type { KicadBoard, KicadBoardZone } from '../kicad/board'
import { allZones, isTeardropZone } from '../kicad/board'
import { padOnLayer, parseFlag, type KicadPad } from '../kicad/footprint'
import { findChild, findChildren, getAtomValues, getNumericValue } from '../kicad/sexpr'
import {
  BoardSpatialIndex,
  padFrame,
  padHoleShape,
  shapeCenter,
  shapeOn,
  shapeToShape,
  type CopperItem,
  type CopperShape,
  type PadFrame
} from './spatialIndex'
import { boardKeepouts } from './keepouts'
import { boardCourtyards, COURTYARD_SHRINK } from './courtyards'
import { copperDrawings, type BoardDrawing } from './boardDrawings'
import {
  connectFill,
  fillHasPoint,
  itemTouchesFill,
  itemsConnect,
  type ZoneFill
} from './boardConnectivity'
import type { BoardRules } from './rules/boardRules'
import {
  capsuleOutline,
  rotatedRectOutline,
  segmentsPerTurn,
  shapeOutlines,
  type Pt
} from './shapeOutline'
import { isCopperLayer } from '../kicad/layers'
import { mmToNm, NM_PER_MM, nmToMm, type Nm } from '../kicad/coordinates'
import { footprintTransform, tfPoint } from '../schematic/placement'

/**
 * What a zone's copper keeps from: an item in the index, a pad the index holds
 * no copper for, or a copper drawing (`boardDrawings.ts`).
 */
export type FillObstacle = CopperItem | { fp: number; pad: number } | BoardDrawing

export interface ZoneFillOptions {
  /**
   * The clearance (mm) the pour keeps from an obstacle on a layer — the rules'
   * answer for (this zone, that item), so a pad's own clearance and the zone's
   * `connect_pads` clearance count as DRC counts them (`rules/resolver.ts`).
   */
  clearanceTo: (other: FillObstacle | KicadBoardZone, layer: string) => number
  /**
   * How far (mm) the pour keeps from a footprint's courtyard on a layer, where a
   * `physical_clearance` rule holds the two apart; null where none does. Absent,
   * no courtyard is cut.
   */
  courtyardClearance?: (fp: number, layer: string) => number | null
  /** The clearance (mm) from the pour to an obstacle's hole; absent, none past `clearanceTo`. */
  holeClearanceTo?: (other: FillObstacle, layer: string) => number
  /** The largest clearance any obstacle can ask for, mm: how far to look. */
  maxClearance: number
  /** Copper-to-board-edge clearance (mm); the rules' minCopperEdgeClearance. */
  edgeClearance: number
  /** How far a curve's chords may stray from it, mm: the board's `max_error`. */
  maxError?: number
  /** The project's text variables, which copper text resolves `${NAME}` from. */
  textVariables?: Readonly<Record<string, string>>
  /**
   * How a pad of the zone's net joins it on a layer: its own style, gap and
   * spoke width before the zone's (`BoardRules.zoneConnection`). Absent, every
   * pad takes the zone's settings.
   */
  padConnection?: (
    pad: CopperItem,
    layer: string
  ) => { style: 'solid' | 'thermal' | 'none'; gap: number; spokeWidth: number }
  /**
   * Another zone's fill on a layer, world space. Absent, the fill stored in the
   * board; a caller refilling several zones passes the ones it has just made,
   * filling the zones that outrank the others first (`fillOrder`).
   */
  fillOf?: (zone: KicadBoardZone, layer: string) => ClipRegion[] | undefined
}

export interface ZoneLayerFill {
  layer: string
  /** Fractured single-outline polygons, domain space (integer nm, y down). */
  polys: Array<Array<{ x: Nm; y: Nm }>>
}

/** KiCad's `ExtraFillMargin`: every clearance cut is this much wider, mm. */
const EXTRA_MARGIN = 0.0005
/** The minimum-width pass keeps copper this much under the minimum, mm. */
const WIDTH_EPSILON = 0.001

const ring = (points: Pt[]): ClipRegion => ({ outer: points, holes: [] })

// Domain nm (y-down) → clipper world mm (y-up).
const toWorld = (p: { x: number; y: number }): Pt => ({ x: p.x / NM_PER_MM, y: -p.y / NM_PER_MM })

/** The copper layers a zone pours on, wildcards resolved against the board. */
export function resolveZoneLayers(zone: KicadBoardZone, board: KicadBoard): string[] {
  const copper = board.layers.filter((l) => isCopperLayer(l.name)).map((l) => l.name)
  const out: string[] = []
  for (const layer of zone.layers) {
    if (layer === '*.Cu') {
      for (const l of copper) if (!out.includes(l)) out.push(l)
    } else if (isCopperLayer(layer) && !out.includes(layer)) {
      out.push(layer)
    }
  }
  return out
}

/**
 * Whether zone `a` outranks zone `b` (`ZONE::HigherPriority`): a teardrop
 * outranks any pour, then the higher priority, and at equal priority the
 * larger uuid — so two zones of different nets never both claim an overlap.
 */
export function outranks(a: KicadBoardZone, b: KicadBoardZone): boolean {
  const ta = isTeardropZone(a)
  if (ta !== isTeardropZone(b)) return ta
  const pa = a.priority ?? 0
  const pb = b.priority ?? 0
  if (pa !== pb) return pa > pb
  return (a.uuid ?? '') > (b.uuid ?? '')
}

/** Zones in the order to fill them so each meets the fills of those that outrank it. */
export function fillOrder(zones: readonly KicadBoardZone[]): KicadBoardZone[] {
  return [...zones].sort((a, b) => (outranks(a, b) ? -1 : outranks(b, a) ? 1 : 0))
}

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const boxOf = (points: readonly Pt[]): Box => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

const boxesMeet = (a: Box, b: Box, margin = 0): boolean =>
  a.minX <= b.maxX + margin &&
  b.minX <= a.maxX + margin &&
  a.minY <= b.maxY + margin &&
  b.minY <= a.maxY + margin

/** Grow (or shrink) regions with round corners, chords within `maxError`. */
const grow = (regions: ClipRegion[], by: number, maxError: number): ClipRegion[] =>
  by === 0 || regions.length === 0
    ? regions
    : offset(regions, by, { join: 'round', arcTolerance: maxError })

/**
 * The first half of KiCad's minimum-width pass: shrunk by `half` with square
 * corners, and each piece whose box is then under the minimum both ways — a
 * blob, not a web — dropped.
 */
function shrinkForWidth(regions: ClipRegion[], half: number, minThickness: number): ClipRegion[] {
  return offset(regions, -half, { join: 'square' }).filter((region) => {
    const box = boxOf(region.outer)
    return Math.max(box.maxX - box.minX, box.maxY - box.minY) >= minThickness
  })
}

/**
 * KiCad's bridging of pieces the shrink split (`ZONE_FILLER::connect_nearby_polys`):
 * each convex corner, in outline order, paired with the nearest other convex
 * corner under `dist` away — on another outline, or far enough along its own
 * that the two are across a neck, not neighbours — the two corners on either
 * side of both then taken, so one neck gets one bridge. KiCad splices each
 * pair in as a zero-width spur, which the round regrowth widens into a bridge.
 */
function nearbyBridges(regions: readonly ClipRegion[], dist: number): Array<[Pt, Pt]> {
  interface Corner {
    ring: number
    i: number
    p: Pt
    along: number
  }
  const rings: Array<{ points: readonly Pt[]; length: number }> = []
  const corners: Corner[][] = []
  for (const region of regions) {
    const outerCcw = ringArea2(region.outer) > 0
    for (const points of [region.outer, ...region.holes]) {
      const n = points.length
      if (n < 3) continue
      // Convex as the copper sees it: a hole's convex corners are its ring's reflex ones.
      const ccw = ringArea2(points) > 0
      const sign = (points === region.outer ? ccw : ccw !== outerCcw ? ccw : !ccw) ? 1 : -1
      const ring = rings.length
      const list: Corner[] = []
      let along = 0
      for (let i = 0; i < n; i++) {
        const a = points[(i + n - 1) % n]
        const v = points[i]
        const b = points[(i + 1) % n]
        if (i > 0) along += Math.hypot(v.x - a.x, v.y - a.y)
        const turn = (v.x - a.x) * (b.y - v.y) - (v.y - a.y) * (b.x - v.x)
        if (turn * sign > 0) list.push({ ring, i, p: v, along })
      }
      const n0 = points[n - 1]
      rings.push({ points, length: along + Math.hypot(points[0].x - n0.x, points[0].y - n0.y) })
      corners.push(list)
    }
  }
  const cell = (x: number): number => Math.floor(x / dist)
  const grid = new Map<string, Corner[]>()
  for (const list of corners)
    for (const corner of list) {
      const key = `${cell(corner.p.x)},${cell(corner.p.y)}`
      const bucket = grid.get(key)
      if (bucket) bucket.push(corner)
      else grid.set(key, [corner])
    }
  const visited = new Set<string>()
  const id = (ring: number, i: number): string => `${ring}:${i}`
  const takeAround = (c: Corner): void => {
    const n = rings[c.ring].points.length
    for (const d of [-2, -1, 1, 2]) visited.add(id(c.ring, (c.i + d + n) % n))
  }
  const pairs: Array<[Pt, Pt]> = []
  const limit = dist * dist
  for (const list of corners) {
    for (const c of list) {
      if (visited.has(id(c.ring, c.i))) continue
      let best: Corner | null = null
      let bestD = limit
      const cx = cell(c.p.x)
      const cy = cell(c.p.y)
      for (let gx = cx - 1; gx <= cx + 1; gx++)
        for (let gy = cy - 1; gy <= cy + 1; gy++)
          for (const q of grid.get(`${gx},${gy}`) ?? []) {
            if (q.ring === c.ring) {
              const direct = Math.abs(q.along - c.along)
              if (Math.min(direct, rings[c.ring].length - direct) < dist) continue
            }
            const d = (q.p.x - c.p.x) ** 2 + (q.p.y - c.p.y) ** 2
            if (d > 0 && d < bestD) {
              bestD = d
              best = q
            }
          }
      if (!best) continue
      visited.add(id(c.ring, c.i))
      if (visited.has(id(best.ring, best.i))) continue
      pairs.push([c.p, best.p])
      takeAround(c)
      takeAround(best)
      visited.add(id(best.ring, best.i))
    }
  }
  return pairs
}

/**
 * KiCad's minimum-width pass over a fill (`ZONE_FILLER::fillCopperZone`): the
 * fill shrunk by half the minimum width less 1 µm, with square corners; each
 * piece that is then smaller than the minimum on both axes dropped; pieces the
 * shrink split across a neck bridged; the rest grown back by the same amount
 * with round corners, to `maxError`.
 */
function minimumWidth(regions: ClipRegion[], minThickness: number, maxError: number): ClipRegion[] {
  const half = minThickness / 2 - WIDTH_EPSILON
  if (half <= WIDTH_EPSILON || regions.length === 0) return regions
  const shrunk = shrinkForWidth(regions, half, minThickness)
  if (shrunk.length === 0) return []
  const grown = grow(shrunk, half, maxError)
  const bridges = nearbyBridges(shrunk, minThickness).map(([a, b]) =>
    ring(capsuleOutline(a.x, a.y, b.x, b.y, half, maxError))
  )
  return bridges.length > 0 ? union(grown, bridges) : grown
}

/**
 * KiCad's corner smoothing (`SHAPE_POLY_SET::Chamfer`/`Fillet`): every
 * corner, holes' included, cut or rounded by `radius`, each cut held to half
 * of either edge beside it; a straight run is left alone.
 */
export function smoothRegions(
  regions: readonly ClipRegion[],
  style: 'chamfer' | 'fillet',
  radius: number,
  maxError: number
): ClipRegion[] {
  const smoothRing = (points: readonly Pt[]): Pt[] => {
    const out: Pt[] = []
    const n = points.length
    for (let i = 0; i < n; i++) {
      const p = points[(i + n - 1) % n]
      const v = points[i]
      const q = points[(i + 1) % n]
      const ax = p.x - v.x
      const ay = p.y - v.y
      const bx = q.x - v.x
      const by = q.y - v.y
      const la = Math.hypot(ax, ay)
      const lb = Math.hypot(bx, by)
      const cos = la > 0 && lb > 0 ? (ax * bx + ay * by) / (la * lb) : -1
      if (cos <= -1 + 1e-12) {
        out.push(v)
        continue
      }
      if (style === 'chamfer') {
        const d = Math.min(radius, la / 2, lb / 2)
        out.push({ x: v.x + (ax / la) * d, y: v.y + (ay / la) * d })
        out.push({ x: v.x + (bx / lb) * d, y: v.y + (by / lb) * d })
        continue
      }
      // A fillet tangent to both edges: its tangent points lie `t` from the
      // corner, held to half of each edge, which caps the radius with them.
      const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2
      const t = Math.min(radius / Math.tan(half), la / 2, lb / 2)
      const r = t * Math.tan(half)
      const a0 = { x: v.x + (ax / la) * t, y: v.y + (ay / la) * t }
      const a1 = { x: v.x + (bx / lb) * t, y: v.y + (by / lb) * t }
      const bis = { x: ax / la + bx / lb, y: ay / la + by / lb }
      const bl = Math.hypot(bis.x, bis.y)
      const dist = r / Math.sin(half)
      const c = { x: v.x + (bis.x / bl) * dist, y: v.y + (bis.y / bl) * dist }
      const s0 = Math.atan2(a0.y - c.y, a0.x - c.x)
      let sweep = Math.atan2(a1.y - c.y, a1.x - c.x) - s0
      while (sweep > Math.PI) sweep -= 2 * Math.PI
      while (sweep < -Math.PI) sweep += 2 * Math.PI
      const step = r > maxError ? 2 * Math.acos(1 - maxError / r) : Math.PI
      const count = Math.max(1, Math.ceil(Math.abs(sweep) / step))
      for (let k = 0; k <= count; k++) {
        const a = s0 + (sweep * k) / count
        out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })
      }
    }
    return out
  }
  return union(
    regions.map((region) => ({
      outer: smoothRing(region.outer),
      holes: region.holes.map(smoothRing)
    })),
    []
  )
}
const ringArea2 = (ring: readonly Pt[]): number => {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j].x * ring[i].y - ring[i].x * ring[j].y
  }
  return sum
}

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx

/**
 * Whether the direction +x, leaving ring vertex `v` (between `p` and `n`),
 * points into the polygon. A vertex a bridge already passes through sits in
 * the ring twice, and only one of the two corners there opens toward the hole
 * being bridged.
 */
const opensRight = (v: Pt, p: Pt, n: Pt, ccw: boolean): boolean => {
  // Interior is the sweep from the outgoing edge round to the incoming one,
  // counter-clockwise for a counter-clockwise ring.
  let from = { x: n.x - v.x, y: n.y - v.y }
  let to = { x: p.x - v.x, y: p.y - v.y }
  if (!ccw) [from, to] = [to, from]
  const fromSide = cross(from.x, from.y, 1, 0)
  const toSide = cross(1, 0, to.x, to.y)
  return cross(from.x, from.y, to.x, to.y) >= 0
    ? fromSide >= 0 && toSide >= 0
    : fromSide >= 0 || toSide >= 0
}

/** A vertex of the ring being fractured; its edge runs to `next`. */
interface RingNode {
  p: Pt
  next: RingNode
  prev: RingNode
  /** Increases along the ring from its first vertex: ties between hits go to the earlier. */
  label: number
}

/** The label gap a relabel leaves between neighbors. */
const LABEL_GAP = 2 ** 32

/**
 * Merge holes into their outer ring through zero-width bridges — the
 * self-touching single outline KiCad writes for zone fills, built the way its
 * `SHAPE_POLY_SET::Fracture` builds it. Holes are taken left to right, and each
 * bridges from its leftmost vertex along a horizontal ray to the first thing the
 * ray meets. Everything to a hole's left is by then part of the ring, so that
 * first meeting is visible from the hole and the bridge crosses nothing; a
 * bridge to the merely NEAREST vertex can run straight through a neighboring
 * hole, and the outline then overlaps itself wherever it is triangulated.
 *
 * The ring is a linked list with its edges bucketed by y, so a ray tests only
 * the edges at its height and a bridge splices in place: a pour with thousands
 * of holes is not quadratic in them. Equal hits go to the earlier edge or
 * vertex in ring order, as a scan of the ring from its first vertex meets them.
 */
export function fractureRegion(region: ClipRegion): Pt[] {
  const outer = region.outer
  const ccw = ringArea2(outer) > 0
  const leftmost = (hole: readonly Pt[]): number => {
    let best = 0
    for (let h = 1; h < hole.length; h++) if (hole[h].x < hole[best].x) best = h
    return best
  }
  const holes = region.holes
    .filter((hole) => hole.length >= 3)
    // A hole winds against its outer ring, or the merged outline would cross
    // itself at every bridge.
    .map((hole) => (ringArea2(hole) > 0 === ccw ? hole.slice().reverse() : hole))
    .map((hole) => ({ hole, start: leftmost(hole) }))
    .sort((a, b) => a.hole[a.start].x - b.hole[b.start].x)
  if (holes.length === 0 || outer.length === 0) return outer.slice()

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let total = outer.length
  const extend = (p: Pt): void => {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  outer.forEach(extend)
  for (const { hole } of holes) {
    total += hole.length + 3
    hole.forEach(extend)
  }
  // Square cells holding a few edges each; an edge is listed in every cell its
  // segment crosses, so a ray reads the cells to its left, nearest first.
  const cell = Math.max(Math.sqrt(((maxX - minX) * (maxY - minY)) / total) * 2, 1e-9)
  const rows = Math.min(2048, Math.floor((maxY - minY) / cell) + 1)
  const cols = Math.min(2048, Math.floor((maxX - minX) / cell) + 1)
  const cellH = (maxY - minY) / rows || 1
  const cellW = (maxX - minX) / cols || 1
  const cells: RingNode[][] = []
  const rowOf = (y: number): number =>
    Math.max(0, Math.min(rows - 1, Math.floor((y - minY) / cellH)))
  const colOf = (x: number): number =>
    Math.max(0, Math.min(cols - 1, Math.floor((x - minX) / cellW)))
  // A node is listed where its edge runs when it is made. A later split only
  // shortens that edge, so the lists stay a superset, and each candidate is
  // tested against its edge as it is now.
  const bucket = (node: RingNode): void => {
    const a = node.p
    const b = node.next.p
    const r0 = rowOf(Math.min(a.y, b.y))
    const r1 = rowOf(Math.max(a.y, b.y))
    for (let r = r0; r <= r1; r++) {
      // The segment's x-range within this row's band, padded against rounding.
      let x0 = Math.min(a.x, b.x)
      let x1 = Math.max(a.x, b.x)
      if (r0 !== r1) {
        const at = (y: number): number => a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x)
        const yLo = Math.max(Math.min(a.y, b.y), minY + r * cellH)
        const yHi = Math.min(Math.max(a.y, b.y), minY + (r + 1) * cellH)
        x0 = Math.max(x0, Math.min(at(yLo), at(yHi)))
        x1 = Math.min(x1, Math.max(at(yLo), at(yHi)))
      }
      const pad = cellW * 1e-6
      const c1 = colOf(x1 + pad)
      for (let c = colOf(x0 - pad); c <= c1; c++) (cells[r * cols + c] ??= []).push(node)
    }
  }

  const nodes: RingNode[] = outer.map((p, i) => ({ p, label: i * LABEL_GAP }) as RingNode)
  nodes.forEach((node, i) => {
    node.next = nodes[(i + 1) % nodes.length]
    node.prev = nodes[(i + nodes.length - 1) % nodes.length]
  })
  const head = nodes[0]
  nodes.forEach(bucket)

  const relabel = (): void => {
    let node = head
    let label = 0
    do {
      node.label = label
      label += LABEL_GAP
      node = node.next
    } while (node !== head)
  }
  /** Splice `points` in after `after`, in order; returns the new nodes. */
  const insertAfter = (after: RingNode, points: readonly Pt[]): RingNode[] => {
    const following = after.next
    let hi = following === head ? after.label + LABEL_GAP : following.label
    if ((hi - after.label) / (points.length + 1) < 1) {
      relabel()
      hi = following === head ? after.label + LABEL_GAP : following.label
    }
    const step = (hi - after.label) / (points.length + 1)
    const made: RingNode[] = []
    let prev = after
    points.forEach((p, k) => {
      const node = { p, prev, label: after.label + step * (k + 1) } as RingNode
      prev.next = node
      made.push(node)
      prev = node
    })
    prev.next = following
    following.prev = prev
    return made
  }

  for (const { hole, start } of holes) {
    const hp = hole[start]
    // Where each candidate meets the ray, if it does: a vertex the ray lands on
    // exactly (which no strictly-spanning edge reports), or an edge it passes
    // through. Only the nearest can win, so ring order is consulted among those
    // tied there alone.
    const meets = (node: RingNode): number => {
      const a = node.p
      const b = node.next.p
      if (a.y === hp.y) return a.x <= hp.x ? a.x : -Infinity
      if (b.y === hp.y || a.y < hp.y === b.y < hp.y) return -Infinity
      const x = a.x + ((hp.y - a.y) / (b.y - a.y)) * (b.x - a.x)
      return x <= hp.x ? x : -Infinity
    }
    const row = rowOf(hp.y) * cols
    const from = colOf(hp.x)
    let nearest = -Infinity
    let c = from
    for (; c >= 0; c--) {
      for (const node of cells[row + c] ?? []) nearest = Math.max(nearest, meets(node))
      // A hit in this cell is right of everything the cells further left hold.
      if (nearest >= minX + c * cellW) break
    }
    if (nearest === -Infinity) continue // a hole outside its ring: nothing to cut
    const tied = new Set<RingNode>()
    for (let k = Math.max(0, c - 1); k <= from; k++)
      for (const node of cells[row + k] ?? []) if (meets(node) === nearest) tied.add(node)
    const ordered = [...tied].sort((a, b) => a.label - b.label)
    // The ring-order scan over the tied: an earlier edge keeps the hit; a
    // vertex takes it from an earlier vertex only where that one's corner does
    // not open toward the hole and its own does.
    let hitX = -Infinity
    let hitEdge: RingNode | null = null
    let hitVertex: RingNode | null = null
    for (const node of ordered) {
      const a = node.p
      if (a.y === hp.y) {
        const better =
          a.x > hitX ||
          (hitVertex !== null &&
            !opensRight(hitVertex.p, hitVertex.prev.p, hitVertex.next.p, ccw) &&
            opensRight(a, node.prev.p, node.next.p, ccw))
        if (better) {
          hitX = a.x
          hitVertex = node
          hitEdge = null
        }
      } else if (nearest > hitX) {
        hitX = nearest
        hitEdge = node
        hitVertex = null
      }
    }

    const loop = [...hole.slice(start), ...hole.slice(0, start + 1)]
    let made: RingNode[]
    if (hitVertex) {
      made = insertAfter(hitVertex, [...loop, hitVertex.p])
    } else {
      const at = { x: hitX, y: hp.y }
      made = insertAfter(hitEdge!, [at, ...loop, at])
    }
    for (const node of made) bucket(node)
  }

  const ring: Pt[] = []
  let node = head
  do {
    ring.push(node.p)
    node = node.next
  } while (node !== head)
  return ring
}

const fractureCache = new WeakMap<ClipRegion, Pt[]>()

/** A region fractured once: the island pass and the result both need it. */
function fractured(region: ClipRegion): Pt[] {
  let points = fractureCache.get(region)
  if (!points) fractureCache.set(region, (points = fractureRegion(region)))
  return points
}

/** A thermal connection: a pad, or in a hatched pour a via (`pad` null). */
interface ThermalPad {
  item: CopperItem
  pad: KicadPad | null
  gap: number
  spokeWidth: number
}

/** One pad of the board with the index's copper for it, when it has copper. */
interface BoardPad {
  fp: number
  pad: KicadPad
  center: Pt
  item: CopperItem | null
}

/**
 * The spokes KiCad draws for a thermal pad (`ZONE_FILLER::buildThermalSpokes`):
 * four, from the center of the pad's box as if unrotated, a quarter turn
 * apart from its spoke angle, out to that box grown by the gap, the max error
 * and half the minimum width. A round pad's are built on the axes and turned
 * whole; another's run at the angle and end square to the side they reach.
 * Each comes with its tip, the point that decides whether it is kept.
 */
function thermalSpokes(
  thermal: ThermalPad,
  minThickness: number,
  /** How far past the gap a spoke reaches: half the minimum width, or half a hatched pour's web. */
  reach: number,
  maxError: number,
  boardVersion: number | undefined
): Array<{ outline: Pt[]; tip: Pt }> {
  const { item, pad, gap } = thermal
  const frame: PadFrame | null =
    item.shape.kind === 'circle'
      ? {
          kind: 'rrect',
          cx: item.shape.cx,
          cy: item.shape.cy,
          halfW: item.shape.r,
          halfH: item.shape.r,
          cornerR: item.shape.r,
          rotation: 0
        }
      : padFrame(item.shape)
  if (!frame) return []
  const width = Math.min(thermal.spokeWidth, 2 * frame.halfW, 2 * frame.halfH)
  if (width < minThickness) return []
  // The pad's box in its own frame (y up), whatever its outline.
  const cos = Math.cos(frame.rotation)
  const sin = Math.sin(frame.rotation)
  let local: Box = { minX: -frame.halfW, minY: -frame.halfH, maxX: frame.halfW, maxY: frame.halfH }
  if (item.shape.kind !== 'rrect' && item.shape.kind !== 'circle') {
    const points = shapeOutlines(item.shape, 0, maxError)
      .flat()
      .map((p) => {
        const dx = p.x - frame.cx
        const dy = p.y - frame.cy
        return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos }
      })
    local = boxOf(points)
  }
  // A custom pad's own spoke templates (`gr_vector` primitives) replace the four.
  const templates = pad
    ? spokeTemplates(pad, frame, item.shape, gap, width, minThickness, maxError)
    : null
  if (templates) return templates
  const grown = gap + maxError + reach
  const halfX = (local.maxX - local.minX) / 2 + grown
  const halfY = (local.maxY - local.minY) / 2 + grown
  const origin = { x: (local.minX + local.maxX) / 2, y: (local.minY + local.maxY) / 2 }
  // A via's spokes run on the axes; a round pad's are built there and turned.
  const round =
    !pad || pad.shape === 'circle' || (pad.shape === 'oval' && pad.size.w === pad.size.h)
  const angleNode =
    pad && pad._raw.type === 'list' ? findChild(pad._raw, 'thermal_bridge_angle') : null
  const degrees = !pad
    ? 0
    : angleNode
      ? getNumericValue(angleNode)
      : pad.shape === 'circle' ||
          (pad.shape === 'custom' &&
            pad.anchor !== 'rect' &&
            (boardVersion === undefined || boardVersion > 20211014))
        ? 45
        : 90
  // The file's angles turn clockwise in its y-down frame: counter-clockwise here is its negative.
  const angle = (-degrees * Math.PI) / 180
  const half = width / 2
  const spokes: Array<{ outline: Pt[]; tip: Pt }> = []
  for (let k = 0; k < 4; k++) {
    const direction = (round ? 0 : angle) + (k * Math.PI) / 2
    const dx = Math.cos(direction)
    const dy = Math.sin(direction)
    let outline: Pt[]
    let tip: Pt
    const vertical =
      Math.abs(dy) < 1e-9 || (Math.abs(dx) > 1e-9 && halfX / Math.abs(dx) <= halfY / Math.abs(dy))
    if (vertical) {
      // Reaches a side x = ±halfX: both ends cut parallel to it.
      const x = Math.sign(dx) * halfX
      const y = (dy / dx) * x
      const o = half / Math.abs(dx)
      outline = [
        { x: 0, y: -o },
        { x: 0, y: o },
        { x, y: y + o },
        { x, y: y - o }
      ]
      tip = { x, y }
    } else {
      const y = Math.sign(dy) * halfY
      const x = (dx / dy) * y
      const o = half / Math.abs(dy)
      outline = [
        { x: -o, y: 0 },
        { x: o, y: 0 },
        { x: x + o, y },
        { x: x - o, y }
      ]
      tip = { x, y }
    }
    const turn = round ? angle : 0
    const place = (p: Pt): Pt => {
      // Round pads turn their axis spokes by the angle; then all turn with the pad.
      const tx = p.x * Math.cos(turn) - p.y * Math.sin(turn) + origin.x
      const ty = p.x * Math.sin(turn) + p.y * Math.cos(turn) + origin.y
      return { x: frame.cx + tx * cos - ty * sin, y: frame.cy + tx * sin + ty * cos }
    }
    spokes.push({ outline: outline.map(place), tip: place(tip) })
  }
  return spokes
}

/**
 * A custom pad's spokes from its templates (`(gr_vector …)` among its
 * primitives), one a template (`ZONE_FILLER::buildThermalSpokes`): run from the
 * template's end inside the pad, across the pad's edge, out to where it meets
 * the pad grown by the gap and the max error, and a minimum width on. A
 * template with neither end in the pad, or that never leaves it, gives none.
 * Null when the pad has no templates.
 */
function spokeTemplates(
  pad: KicadPad,
  frame: PadFrame,
  shape: CopperShape,
  gap: number,
  width: number,
  minThickness: number,
  maxError: number
): Array<{ outline: Pt[]; tip: Pt }> | null {
  const primitives = pad._raw.type === 'list' ? findChild(pad._raw, 'primitives') : null
  const vectors = primitives ? findChildren(primitives, 'gr_vector') : []
  if (vectors.length === 0) return null
  const cos = Math.cos(frame.rotation)
  const sin = Math.sin(frame.rotation)
  // Pad-local mm, y down as the file has it → world, y up, turned with the pad.
  const world = (node: ReturnType<typeof findChild>): Pt | null => {
    const atoms = node ? getAtomValues(node) : []
    if (atoms.length < 2) return null
    const x = Number(atoms[0])
    const y = Number(atoms[1])
    return { x: frame.cx + x * cos + y * sin, y: frame.cy + x * sin - y * cos }
  }
  const copper = union(shapeOutlines(shape, 0, maxError).map(ring), [])
  const relief = grow(copper, gap + maxError, maxError)
  const inside = (p: Pt): boolean => copper.some((region) => pointInRegion(p, region))
  /** How far along the ray from `from` along `dir` it first meets a ring's edge. */
  const firstHit = (from: Pt, dir: Pt, regions: ClipRegion[]): number | null => {
    let best: number | null = null
    for (const region of regions)
      for (const pts of [region.outer, ...region.holes])
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const a = pts[j]
          const e = { x: pts[i].x - a.x, y: pts[i].y - a.y }
          const denom = dir.x * e.y - dir.y * e.x
          if (Math.abs(denom) < 1e-12) continue
          const t = ((a.x - from.x) * e.y - (a.y - from.y) * e.x) / denom
          const u = ((a.x - from.x) * dir.y - (a.y - from.y) * dir.x) / denom
          if (t > 1e-9 && u >= 0 && u <= 1 && (best === null || t < best)) best = t
        }
    return best
  }
  const spokes: Array<{ outline: Pt[]; tip: Pt }> = []
  if (width < minThickness) return spokes
  for (const vector of vectors) {
    let start = world(findChild(vector, 'start'))
    let end = world(findChild(vector, 'end'))
    if (!start || !end) continue
    if (!inside(start)) {
      if (!inside(end)) continue
      ;[start, end] = [end, start]
    }
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    if (length === 0) continue
    const dir = { x: (end.x - start.x) / length, y: (end.y - start.y) / length }
    if (firstHit(start, dir, copper) === null) continue
    const out = firstHit(start, dir, relief)
    if (out === null) continue
    const reach = out + minThickness
    const tip = { x: start.x + dir.x * reach, y: start.y + dir.y * reach }
    const side = { x: (-dir.y * width) / 2, y: (dir.x * width) / 2 }
    spokes.push({
      outline: [
        { x: start.x + side.x, y: start.y + side.y },
        { x: tip.x + side.x, y: tip.y + side.y },
        { x: tip.x - side.x, y: tip.y - side.y },
        { x: start.x - side.x, y: start.y - side.y }
      ],
      tip
    })
  }
  return spokes
}

/**
 * Whether a net-tie footprint's drawing touches, on the layer, a pad of the
 * net or a pad tied to one (`net_tie_pad_groups`) — copper the pour of that
 * net may cover (`ZONE_FILLER::buildCopperItemClearances`).
 */
function tieTouchesNet(
  board: KicadBoard,
  index: BoardSpatialIndex,
  drawing: BoardDrawing,
  net: number,
  layer: string
): boolean {
  const bfp = board.footprints[drawing.fp!]
  const raw = bfp.footprint._raw
  const groupsNode = raw.type === 'list' ? findChild(raw, 'net_tie_pad_groups') : null
  if (!groupsNode || net <= 0) return false
  const groups = getAtomValues(groupsNode).map((group) => group.split(',').map((n) => n.trim()))
  const pads = bfp.footprint.pads
  const ofNet = new Set(pads.filter((pad) => pad.net?.number === net).map((pad) => pad.number))
  const tied = new Set(ofNet)
  for (const group of groups) if (group.some((n) => ofNet.has(n))) group.forEach((n) => tied.add(n))
  return index
    .query(drawing.minX, drawing.minY, drawing.maxX, drawing.maxY)
    .some(
      (item) =>
        item.ref.type === 'pad' &&
        item.ref.index === drawing.fp &&
        item.layers.includes(layer) &&
        tied.has(pads[item.ref.pad].number) &&
        shapeToShape(item.shape, drawing.shape) <= 1e-6
    )
}

/**
 * The ring a hatched pour draws round each thermal connection
 * (`ZONE_FILLER::buildHatchZoneThermalRings`): a spoke's width wide, just past
 * the gap — an annulus round a round pad or via, else the pad grown by the gap
 * and the width less the pad grown by the gap — clipped to the pour's outline.
 * A spoke width under the minimum draws none.
 */
function thermalRings(
  thermals: readonly ThermalPad[],
  minThickness: number,
  outline: ClipRegion[],
  maxError: number
): ClipRegion[] {
  const rings: ClipRegion[] = []
  for (const { item, pad, gap, spokeWidth } of thermals) {
    const shape = item.shape
    const frame = shape.kind === 'circle' ? null : padFrame(shape)
    const width = Math.min(
      spokeWidth,
      shape.kind === 'circle' ? 2 * shape.r : frame ? 2 * Math.min(frame.halfW, frame.halfH) : 0
    )
    if (width < minThickness) continue
    const round =
      !pad || pad.shape === 'circle' || (pad.shape === 'oval' && pad.size.w === pad.size.h)
    let outer: Pt[][]
    let inner: Pt[][]
    if (round) {
      const [cx, cy, r] =
        shape.kind === 'circle'
          ? [shape.cx, shape.cy, shape.r]
          : [frame!.cx, frame!.cy, frame!.halfW]
      const disc = (radius: number): CopperShape => ({ kind: 'circle', cx, cy, r: radius })
      outer = shapeOutlines(disc(r + gap + width), 0, maxError)
      inner = shapeOutlines(disc(r + gap), 0, maxError)
    } else {
      outer = shapeOutlines(shape, gap + width, maxError)
      inner = shapeOutlines(shape, gap, maxError)
    }
    rings.push(...difference(union(outer.map(ring), []), inner.map(ring)))
  }
  return rings.length > 0 ? intersection(rings, outline) : []
}

/**
 * The holes of a hatched pour (`ZONE_FILLER::addHatchFillTypeOnZone`), cut
 * while the fill is shrunk for its minimum width. A grid of squares a gap and
 * a minimum width across, a web apart, anchored to the board's origin and
 * turned by the hatch's orientation, corners chamfered or rounded by its
 * smoothing; kept only inside the fill shrunk by what the web adds past the
 * minimum (the solid border) and the outline shrunk by the minimum; too small a
 * remnant dropped, and any hole that would swallow a thermal ring, a clearance
 * cut or a solidly joined via whole dropped, so that stays on the webbing.
 */
function hatchHoles(
  shrunk: ClipRegion[],
  hatch: NonNullable<KicadBoardZone['hatchFill']>,
  zoneRing: ClipRegion,
  protect: readonly ClipRegion[],
  minThickness: number,
  boardMaxError: number
): ClipRegion[] {
  if (shrunk.length === 0 || hatch.gap <= 0) return []
  const web = Math.max(hatch.thickness, minThickness + 0.001)
  const side = hatch.gap + minThickness
  // The grid in integer nm, as KiCad lays it: its remainder truncates toward zero.
  const pitch = mmToNm(web + hatch.gap) as number
  let maxError = boardMaxError
  let base: ClipRegion[] = [
    ring([
      { x: 0, y: 0 },
      { x: side, y: 0 },
      { x: side, y: side },
      { x: 0, y: side }
    ])
  ]
  if (hatch.smoothingLevel > 0) {
    let value = nmToMm(Math.round(mmToNm((hatch.gap * hatch.smoothingValue) / 2)) as Nm)
    if (value > 0.02) {
      let level = hatch.smoothingLevel
      if (value < 0.04 && level > 1) level = 1
      value = Math.min(value + minThickness / 2, hatch.gap / 2)
      maxError = Math.max(maxError * 2, value / 20)
      if (level === 1) base = smoothRegions(base, 'chamfer', value, maxError)
      else {
        if (hatch.smoothingLevel > 2) maxError /= 2
        base = smoothRegions(base, 'fillet', value, maxError)
      }
    }
  }
  const minArea = side * side * hatch.minHoleArea
  const angle = (hatch.orientation * Math.PI) / 180
  const turn = (p: Pt, by: number): Pt => ({
    x: p.x * Math.cos(by) - p.y * Math.sin(by),
    y: p.x * Math.sin(by) + p.y * Math.cos(by)
  })
  // The fill's box turned back by the orientation, in the file's frame (y down).
  const box = boxOf(shrunk.flatMap((region) => region.outer.map((p) => turn(p, -angle))))
  const left = Math.round(mmToNm(box.minX))
  const top = Math.round(mmToNm(-box.maxY))
  const right = Math.round(mmToNm(box.maxX))
  const bottom = Math.round(mmToNm(-box.minY))
  const startX = left - (left % pitch) - pitch
  const startY = top - (top % pitch) - pitch
  const holes: ClipRegion[] = []
  for (let x = startX; x <= right; x += pitch) {
    for (let y = startY; y <= bottom; y += pitch) {
      const ox = nmToMm(x as Nm)
      const oy = nmToMm(y as Nm)
      // A square from (x, y) down and right in the file's frame: y up here.
      const place = (p: Pt): Pt => turn({ x: ox + p.x, y: -(oy + p.y) }, angle)
      holes.push({ outer: base[0].outer.map(place), holes: [] })
    }
  }
  const border = Math.max(hatch.thickness - minThickness, 2 * maxError)
  let kept = intersection(holes, offset(shrunk, -border, { join: 'square' }))
  kept = intersection(kept, offset([zoneRing], -minThickness, { join: 'square' }))
  kept = kept.filter((hole) => Math.abs(ringArea2(hole.outer)) / 2 >= minArea)
  const guarded = protect.map((region) => ({ outer: region.outer, box: boxOf(region.outer) }))
  return kept.filter((hole) => {
    const holeBox = boxOf(hole.outer)
    return !guarded.some(({ outer, box }) => {
      if (box.minX < holeBox.minX || box.maxX > holeBox.maxX) return false
      if (box.minY < holeBox.minY || box.maxY > holeBox.maxY) return false
      const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
      if (!pointInRing(center, hole.outer) || !pointInRing(outer[0], hole.outer)) return false
      return !ringsCross(outer, hole.outer)
    })
  })
}

/** Whether two rings' edges cross or touch anywhere. */
function ringsCross(a: readonly Pt[], b: readonly Pt[]): boolean {
  const side = (p: Pt, q: Pt, r: Pt): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    for (let k = 0, l = b.length - 1; k < b.length; l = k++) {
      const d1 = side(b[l], b[k], a[j])
      const d2 = side(b[l], b[k], a[i])
      const d3 = side(a[j], a[i], b[l])
      const d4 = side(a[j], a[i], b[k])
      if (d1 * d2 <= 0 && d3 * d4 <= 0) return true
    }
  }
  return false
}

/**
 * Whether a via drops its ring on a layer while the pour is made (KiCad's
 * `PCB_VIA::FlashLayer` after the filler's first pass): a via that removes its
 * unused layers keeps one where it must — its ends, with `keep_end_layers` —
 * where the highest-priority zone containing it is of its net, and where
 * copper of its net joins it.
 */
function viaFlashed(
  board: KicadBoard,
  index: BoardSpatialIndex,
  item: CopperItem,
  layer: string
): boolean {
  if (item.ref.type !== 'via') return true
  const via = board.vias[item.ref.index]
  const raw = via._raw
  if (raw.type !== 'list') return true
  const ends = [via.layers[0], via.layers[via.layers.length - 1]]
  if (parseFlag(raw, 'start_end_only')) return ends.includes(layer)
  if (!parseFlag(raw, 'remove_unused_layers')) return true
  if (parseFlag(raw, 'keep_end_layers') && ends.includes(layer)) return true
  if (item.net <= 0) return false
  let answers = viaFlashCache.get(index)
  if (!answers) viaFlashCache.set(index, (answers = new Map()))
  const key = `${item.id}:${layer}`
  const known = answers.get(key)
  if (known !== undefined) return known
  const center = shapeCenter(item.shape)
  // The filler's first pass: the zone that claims the via's center.
  let best: KicadBoardZone | null = null
  for (const claim of zoneClaims(board)) {
    const { zone, box } = claim
    if (center.x < box.minX || center.x > box.maxX || center.y < box.minY || center.y > box.maxY)
      continue
    if (!claim.layers.includes(layer) || !pointInRing(center, claim.ring)) continue
    const sameNet = zone.net === item.net
    const bestSame = best?.net === item.net
    if (
      !best ||
      (sameNet && !bestSame) ||
      (sameNet === bestSame && (zone.priority ?? 0) > (best.priority ?? 0))
    )
      best = zone
  }
  const flashed =
    best?.net === item.net ||
    index
      .query(item.minX, item.minY, item.maxX, item.maxY)
      .some(
        (other) =>
          other.id !== item.id &&
          other.net === item.net &&
          other.layers.includes(layer) &&
          itemsConnect(board, item, other).length > 0
      )
  answers.set(key, flashed)
  return flashed
}

const viaFlashCache = new WeakMap<BoardSpatialIndex, Map<string, boolean>>()
const zoneClaimCache = new WeakMap<
  KicadBoard,
  Array<{ zone: KicadBoardZone; ring: Pt[]; box: Box; layers: string[] }>
>()

/** The board's pours, each with its outline and layers, for the filler's first pass. */
function zoneClaims(
  board: KicadBoard
): Array<{ zone: KicadBoardZone; ring: Pt[]; box: Box; layers: string[] }> {
  let claims = zoneClaimCache.get(board)
  if (!claims) {
    claims = board.zones
      .filter((zone) => !zone.isKeepout && zone.points.length >= 3)
      .map((zone) => {
        const ring = zone.points.map(toWorld)
        return { zone, ring, box: boxOf(ring), layers: resolveZoneLayers(zone, board) }
      })
    zoneClaimCache.set(board, claims)
  }
  return claims
}

/**
 * Compute one zone's fills, one cooperative step at a time; the generator's
 * return value is the result. The Clipper engine must already be loaded
 * (`await loadClipper()`), and the index must be built from the same board.
 */
interface BoardFillContext {
  outline: ReturnType<typeof buildBoardOutline>
  keepouts: ReturnType<typeof boardKeepouts>
  /** Every pad, placed, with its hole's radius (mm) where it has one. */
  pads: Array<{ fp: number; p: number; pad: KicadPad; center: Pt; drillR: number | null }>
}

/**
 * What every zone of one board revision reads alike, built once per revision
 * rather than per zone: a refill of hundreds of small zones (teardrops) paid
 * for the whole board each time.
 */
const fillContexts = new WeakMap<KicadBoard, BoardFillContext>()
function boardFillContext(board: KicadBoard): BoardFillContext {
  let ctx = fillContexts.get(board)
  if (ctx) return ctx
  const pads: BoardFillContext['pads'] = []
  board.footprints.forEach((bfp, fp) => {
    const tf = footprintTransform(bfp)
    bfp.footprint.pads.forEach((pad, p) => {
      const drill = pad.drill
      const drillR = drill
        ? nmToMm(Math.max(drill.diameter, drill.oval?.width ?? 0, drill.oval?.height ?? 0) as Nm)
        : null
      pads.push({ fp, p, pad, center: tfPoint(tf, pad.position.x, pad.position.y), drillR })
    })
  })
  ctx = { outline: buildBoardOutline(board), keepouts: boardKeepouts(board), pads }
  fillContexts.set(board, ctx)
  return ctx
}

export function* computeZoneFillSteps(
  board: KicadBoard,
  index: BoardSpatialIndex,
  zone: KicadBoardZone,
  opts: ZoneFillOptions
): Generator<void, ZoneLayerFill[]> {
  if (zone.isKeepout || zone.points.length < 3) return []
  // The outline less its cutouts.
  const zoneRing: ClipRegion = {
    outer: zone.points.map(toWorld),
    holes: (zone.holes ?? []).map((hole) => hole.map(toWorld))
  }
  const { outline, keepouts, pads } = boardFillContext(board)
  const teardrop = isTeardropZone(zone)
  const zoneNet = zone.net ?? 0
  const maxError = opts.maxError ?? 0.005
  const minThickness = zone.minThickness !== undefined ? nmToMm(zone.minThickness) : 0.25
  const thermalGap = zone.thermalGap !== undefined ? nmToMm(zone.thermalGap) : 0.5
  const spokeWidth = zone.thermalBridgeWidth !== undefined ? nmToMm(zone.thermalBridgeWidth) : 0.5
  const padConnection = zone.padConnection ?? 'thermal'
  const zoneClearance = zone.padClearance !== undefined ? nmToMm(zone.padClearance) : 0
  const hatch = zone.hatchFill
  const half = minThickness / 2 - WIDTH_EPSILON
  const opening = half > WIDTH_EPSILON
  const holeClearanceTo = opts.holeClearanceTo ?? (() => 0)
  const zoneBox = boxOf(zoneRing.outer)
  const reach = Math.max(opts.maxClearance, thermalGap) + 1

  const fillOf = opts.fillOf
    ? (other: KicadBoardZone, layer: string): ClipRegion[] =>
        opts.fillOf!(other, layer) ?? storedFillOf(other, layer)
    : storedFillOf

  // The pads near the zone, with the index's copper for each where it has any:
  // a hole on no copper layer (a bare mounting hole) still keeps the pour off.
  const padsNear: BoardPad[] = []
  const padItems = new Map<string, CopperItem>()
  for (const item of index.query(
    zoneBox.minX - reach,
    zoneBox.minY - reach,
    zoneBox.maxX + reach,
    zoneBox.maxY + reach
  )) {
    if (item.ref.type === 'pad') padItems.set(`${item.ref.index}:${item.ref.pad}`, item)
  }
  for (const { fp, p, pad, center, drillR } of pads) {
    const item = padItems.get(`${fp}:${p}`) ?? null
    if (!item) {
      if (drillR === null) continue
      const box = {
        minX: center.x - drillR,
        minY: center.y - drillR,
        maxX: center.x + drillR,
        maxY: center.y + drillR
      }
      if (!boxesMeet(zoneBox, box, reach)) continue
    }
    padsNear.push({ fp, pad, center, item })
  }

  const results: Array<{ layer: string; regions: ClipRegion[] }> = []
  for (const layer of resolveZoneLayers(zone, board)) {
    yield
    // 1. The envelope: the outline and the same-net zones it overlaps, on the
    // board, smoothed. The pour may start `min_thickness` past the outline and
    // is trimmed back to it at the end.
    let envelope: ClipRegion[] = [zoneRing]
    if (!teardrop && zoneNet > 0) {
      const joined = allZones(board).filter(
        (other) =>
          other !== zone &&
          !other.isKeepout &&
          other.points.length >= 3 &&
          !isTeardropZone(other) &&
          other.net === zoneNet &&
          resolveZoneLayers(other, board).includes(layer) &&
          boxesMeet(zoneBox, boxOf(other.points.map(toWorld)), 0.001)
      )
      if (joined.length > 0) {
        const others = joined.map((other) => ({
          outer: other.points.map(toWorld),
          holes: (other.holes ?? []).map((hole) => hole.map(toWorld))
        }))
        // Colliding, as KiCad asks it: an outline that only meets this one along
        // an edge joins too.
        const touching = others.filter(
          (o) => intersection([zoneRing], grow([o], 0.0005, maxError)).length > 0
        )
        if (touching.length > 0) envelope = union([zoneRing, ...touching], [])
      }
    }
    if (!outline.fallback) envelope = intersection(envelope, outline.regions)
    const preSmooth = envelope
    if (zone.smoothing && zone.smoothingRadius && !teardrop && envelope.length > 0)
      envelope = smoothRegions(envelope, zone.smoothing, nmToMm(zone.smoothingRadius), maxError)
    const maxExtents = intersection(envelope, [zoneRing])
    let filled = intersection(
      envelope,
      intersection(grow([zoneRing], minThickness, maxError), preSmooth)
    )
    if (filled.length === 0) continue

    // 2–3. The cuts: what the pads of the zone's net take (their thermal gap,
    // or the zone's clearance for a pad it must not join), and the clearance
    // cuts (`clearances`) every other thing takes, which bind the spokes too.
    yield
    const padCuts: ClipRegion[] = []
    const clearances: ClipRegion[] = []
    const thermals: ThermalPad[] = []
    const solidVias: Array<Extract<CopperShape, { kind: 'circle' }>> = []
    const cut = (into: ClipRegion[], shape: CopperShape, by: number): void => {
      for (const outlineRing of shapeOutlines(shape, by, maxError)) into.push(ring(outlineRing))
    }
    const circle = (cx: number, cy: number, r: number): CopperShape => ({
      kind: 'circle',
      cx,
      cy,
      r
    })
    // A padstack as it is on this layer: the rest of the fill reads its shape there.
    const views = new Map<CopperItem, CopperItem>()
    const onLayer = (item: CopperItem): CopperItem => {
      if (!item.shapes) return item
      let view = views.get(item)
      if (!view) views.set(item, (view = { ...item, shape: shapeOn(item, layer) }))
      return view
    }

    for (const found of index.query(
      zoneBox.minX - reach,
      zoneBox.minY - reach,
      zoneBox.maxX + reach,
      zoneBox.maxY + reach
    )) {
      if (found.ref.type === 'pad' || !found.layers.includes(layer)) continue
      const item = onLayer(found)
      const sameNet = item.net === zoneNet && (zoneNet > 0 || teardrop)
      if (sameNet && hatch && item.ref.type === 'via' && item.shape.kind === 'circle') {
        // A hatched pour relieves its vias as it does pads: thermal, or solid on the webbing.
        const connection = opts.padConnection?.(item, layer) ?? {
          style: padConnection === 'thermal' ? ('thermal' as const) : ('solid' as const),
          gap: thermalGap,
          spokeWidth
        }
        if (connection.style === 'thermal' && connection.gap > 0) {
          cut(padCuts, item.shape, connection.gap)
          thermals.push({ item, pad: null, gap: connection.gap, spokeWidth: connection.spokeWidth })
        } else if (connection.style === 'solid') solidVias.push(item.shape)
        continue
      }
      if (sameNet) continue // tracks and vias of the zone's net are poured over
      const clearance = opts.clearanceTo(item, layer)
      if (item.ref.type !== 'via' || item.shape.kind !== 'circle') {
        cut(clearances, item.shape, clearance + EXTRA_MARGIN)
        continue
      }
      // A via: its ring where it has one, and its hole wherever.
      const via = board.vias[item.ref.index]
      const { cx, cy } = item.shape
      if (viaFlashed(board, index, item, layer) && clearance > 0)
        cut(clearances, item.shape, clearance + EXTRA_MARGIN)
      const holeGap = Math.max(clearance, holeClearanceTo(item, layer))
      cut(clearances, circle(cx, cy, nmToMm(via.drill) / 2), holeGap + EXTRA_MARGIN)
    }

    // Copper drawings and text: another net's, or no net's, keep clear.
    for (const drawing of copperDrawings(board, opts.textVariables).get(layer) ?? []) {
      if (!drawing.inFill || !boxesMeet(zoneBox, drawing, reach)) continue
      if (drawing.net === zoneNet && zoneNet > 0) continue
      // A net tie's copper joins its pads: the pour keeps off none of it that
      // touches a pad of the zone's net or one tied to such a pad.
      if (drawing.fp !== undefined && tieTouchesNet(board, index, drawing, zoneNet, layer)) continue
      const box = drawing.shape
      if (drawing.drawing === 'text' && drawing.knockout) {
        // Knockout text: the pour keeps off its glyphs alone, with no clearance.
        for (const glyph of drawing.glyphs ?? []) cut(clearances, glyph, 0)
        continue
      }
      const gap = opts.clearanceTo(drawing, layer) + EXTRA_MARGIN
      if (drawing.fill) {
        // A text box's or table's own pieces: an area as it is, a border grown.
        for (const piece of drawing.fill)
          cut(clearances, piece.shape, piece.grows ? gap + (piece.extra ?? 0) : 0)
        continue
      }
      if (drawing.glyphs && box.kind === 'rrect') {
        // KiCad draws the glyphs' round ends outside the arc, and then grows
        // them by the max error besides, before it takes their box.
        const glyph = drawing.glyphs?.[0]
        const pen = glyph?.kind === 'capsule' ? glyph.halfWidth : 0
        const turn = segmentsPerTurn(pen, maxError)
        const outward = maxError + (pen > 0 ? pen / Math.cos(Math.PI / turn) - pen : 0)
        const grow = gap + outward
        clearances.push(
          ring(rotatedRectOutline(box.cx, box.cy, box.halfW + grow, box.halfH + grow, box.rotation))
        )
      } else cut(clearances, drawing.shape, gap)
    }

    // How a pad of the zone's net joins it: its own style, else the zone's.
    const connectionOf = (
      item: CopperItem | null,
      pad: KicadPad,
      at: string
    ): { style: 'solid' | 'thermal' | 'none'; gap: number; spokeWidth: number } =>
      teardrop
        ? { style: 'solid', gap: thermalGap, spokeWidth }
        : item
          ? (opts.padConnection?.(item, at) ?? {
              style:
                padConnection === 'solid' ||
                (padConnection === 'thru_hole_only' && pad.type !== 'thru_hole')
                  ? 'solid'
                  : padConnection === 'none'
                    ? 'none'
                    : 'thermal',
              gap: thermalGap,
              spokeWidth
            })
          : { style: 'none', gap: thermalGap, spokeWidth }

    for (const near of padsNear) {
      const item = near.item && onLayer(near.item)
      const pad = padOnLayer(near.pad, layer)
      const flashed = !!item && item.layers.includes(layer) && !npthWithoutRing(pad)
      const hole = padHoleShape(pad, near.center)
      if (!flashed && !hole) continue
      const net = item?.net ?? pad.net?.number ?? 0
      const obstacle: FillObstacle = item ?? {
        fp: near.fp,
        pad: board.footprints[near.fp].footprint.pads.indexOf(pad)
      }
      const plated = pad.type !== 'np_thru_hole'
      let noConnection = net !== zoneNet || (!teardrop && zoneNet === 0)
      let connection = noConnection ? null : connectionOf(item, pad, layer)
      // A thermal pad with no copper on the layer has nothing to join: none.
      if (connection?.style === 'thermal' && !flashed) connection = { ...connection, style: 'none' }
      // A hatched pour keeps its full clearance from a pad it must not join.
      if (hatch && connection?.style === 'none') noConnection = true
      if (noConnection) {
        let gap = flashed || (plated && hole) ? opts.clearanceTo(obstacle, layer) : 0
        if (flashed && item) cut(clearances, item.shape, gap + EXTRA_MARGIN)
        if (hole) {
          if (!plated) gap = 0 // an unplated hole keeps only its hole clearance
          gap = Math.max(gap, holeClearanceTo(obstacle, layer))
          cut(clearances, hole, gap + EXTRA_MARGIN)
        }
        continue
      }
      if (!connection || connection.style === 'solid') continue
      if (connection.style === 'thermal' && item) {
        cut(padCuts, item.shape, connection.gap)
        thermals.push({ item, pad, gap: connection.gap, spokeWidth: connection.spokeWidth })
        continue
      }
      // None: only the zone's own clearance keeps the pour off its own pad.
      if (flashed && item) cut(padCuts, item.shape, zoneClearance)
      else if (hole) cut(padCuts, hole, zoneClearance)
    }

    // The board edge, each piece of it grown by the edge clearance. A guessed
    // outline (no closed edge) has no edge to keep from.
    if (!outline.fallback) {
      for (const region of outline.regions) {
        for (const pts of [region.outer, ...region.holes]) {
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i]
            const b = pts[(i + 1) % pts.length]
            clearances.push(
              ring(capsuleOutline(a.x, a.y, b.x, b.y, opts.edgeClearance + EXTRA_MARGIN, maxError))
            )
          }
        }
      }
    }
    // Copper-pour keepouts, exactly; a teardrop ignores them.
    if (!teardrop) {
      for (const keepout of keepouts) {
        if (!keepout.rules.copperpour && keepout.layers.includes(layer))
          clearances.push({ outer: keepout.region.outer, holes: keepout.region.holes ?? [] })
      }
    }
    // Courtyards a physical clearance rule keeps the pour from, grown by it
    // (KiCad's `knockoutCourtyardClearance`): the layer's side, or on an inner
    // layer the footprint's own.
    if (opts.courtyardClearance) {
      for (const court of boardCourtyards(board)) {
        if (!court.box || !boxesMeet(zoneBox, court.box, reach)) continue
        const gap = opts.courtyardClearance(court.fp, layer)
        if (gap === null || gap < 0) continue
        const back =
          layer === 'B.Cu' || (layer !== 'F.Cu' && board.footprints[court.fp].layer === 'B.Cu')
        const regions = offset(
          (back ? court.back : court.front).map((r) => ({ outer: r.outer, holes: r.holes ?? [] })),
          -COURTYARD_SHRINK,
          { join: 'miter', arcTolerance: maxError }
        )
        clearances.push(...grow(regions, gap, maxError))
      }
    }

    // Zones of another net that outrank this one: their fills, grown by the clearance.
    const zoneCuts: ClipRegion[] = []
    const sameNetAbove: ClipRegion[] = []
    const refilled = refillRevisits(board, zone, layer, fillOf, reach)
    let reachRegion: ClipRegion[] | null = null
    const reachOf = (): ClipRegion[] =>
      (reachRegion ??= grow(
        [zoneRing],
        opts.maxClearance + EXTRA_MARGIN + maxError + minThickness,
        maxError
      ))
    for (const other of allZones(board)) {
      if (other === zone || other.isKeepout || other.points.length < 3) continue
      if (!outranks(other, zone)) continue
      if (!resolveZoneLayers(other, board).includes(layer)) continue
      if (!boxesMeet(zoneBox, boxOf(other.points.map(toWorld)), reach)) continue
      const theirs = fillOf(other, layer)
      // Zones compare by net code, no net included: two zones of no net are of one net.
      if ((other.net ?? 0) === zoneNet) {
        // A teardrop never carves its own net. KiCad's first pass cuts the
        // outlines of its net's zones of strictly higher priority; its refill,
        // where it revisits this zone, cuts their fills instead, and at equal
        // priority the larger uuid's too (`refilled`, above).
        if (isTeardropZone(other)) continue
        // A hatched zone carves by its solid extent, not through its holes:
        // its fill's outlines, holes filled.
        if (refilled && theirs.length > 0)
          sameNetAbove.push(
            ...(other.hatchFill
              ? theirs.map((region) => ({ outer: region.outer, holes: [] }))
              : theirs)
          )
        else if ((other.priority ?? 0) > (zone.priority ?? 0))
          sameNetAbove.push({
            outer: other.points.map(toWorld),
            holes: (other.holes ?? []).map((hole) => hole.map(toWorld))
          })
        continue
      }
      if (theirs.length === 0) continue
      // Another net's zone cuts only where its outline comes within reach of
      // this one's (`zoneKnockoutMayInteract`), else the cut and its prune never run.
      if (intersection([{ outer: other.points.map(toWorld), holes: [] }], reachOf()).length === 0)
        continue
      const clearance = Math.max(0, opts.clearanceTo(other, layer))
      zoneCuts.push(...grow(theirs, clearance + EXTRA_MARGIN + maxError, maxError))
    }

    yield
    if (padCuts.length > 0) filled = difference(filled, padCuts)
    // A hatched pour rings each thermal connection, so the hatch cannot cut it off.
    const rings = hatch ? thermalRings(thermals, minThickness, envelope, maxError) : []
    if (rings.length > 0) filled = union(filled, rings)
    // Used three times over: merged once.
    const cuts = merged(clearances)

    // 4. Spokes: kept where the tip lands in copper that survives the cuts and
    // the minimum width.
    const spokes: ClipRegion[] = []
    if (thermals.length > 0 && filled.length > 0) {
      yield
      let survives = difference(filled, [...cuts, ...zoneCuts])
      if (opening && survives.length > 0)
        survives = offset(offset(survives, -half, { join: 'square' }), half, { join: 'square' })
      const candidates = thermals.flatMap((thermal) =>
        thermalSpokes(
          thermal,
          minThickness,
          (hatch ? hatch.thickness : minThickness) / 2,
          maxError,
          board.version
        ).map((spoke) => ({
          ...spoke,
          box: boxOf(spoke.outline)
        }))
      )
      for (const spoke of candidates) {
        // Kept where its tip lands in copper — or where it meets another pad's
        // spoke tip to tip, each tip inside the other (pads too close for pour between).
        const kept =
          survives.some((region) => pointInRegion(spoke.tip, region)) ||
          candidates.some(
            (other) =>
              other !== spoke &&
              boxesMeet(spoke.box, other.box) &&
              pointInRing(spoke.tip, other.outline) &&
              pointInRing(other.tip, spoke.outline)
          )
        if (kept) spokes.push(ring(spoke.outline))
      }
    }
    if (spokes.length > 0) filled = union(filled, spokes)
    if (cuts.length > 0) filled = difference(filled, cuts)
    if (filled.length === 0) continue

    // 5. The minimum width, then the trim to the envelope, the cuts again and
    // each thermal pad's bare hole.
    yield
    let preHatch: ClipRegion[] = []
    if (hatch) {
      // Hatched: the minimum width's shrink, the hatch holes cut while shrunk,
      // the regrowth, and the thermal rings (shrunk the same) put back.
      const shrunkRings =
        opening && rings.length > 0 ? offset(rings, -half, { join: 'square' }) : rings
      let shrunk = opening ? shrinkForWidth(filled, half, minThickness) : filled
      const protect = [
        ...shrunkRings,
        ...cuts,
        ...intersection(
          solidVias.map((via) => ring(shapeOutlines(via, 0, maxError)[0])),
          envelope
        )
      ]
      // The solid extent before the hatch: where a border goes back round a cut (step 6).
      preHatch = difference(
        intersection(opening ? grow(shrunk, half, maxError) : shrunk, maxExtents),
        cuts
      )
      const holes = hatchHoles(shrunk, hatch, zoneRing, protect, minThickness, maxError)
      if (holes.length > 0) shrunk = difference(shrunk, holes)
      filled = opening ? grow(shrunk, half, maxError) : shrunk
      if (shrunkRings.length > 0) filled = union(filled, shrunkRings)
    } else filled = minimumWidth(filled, minThickness, maxError)
    const bareHoles: ClipRegion[] = []
    for (const thermal of thermals) {
      // A thermal pad's bare hole; a via's hole the fill covers.
      if (!thermal.pad) continue
      const hole = padHoleShape(thermal.pad, padCenter(board, thermal.item, thermal.pad))
      if (hole) cut(bareHoles, hole, 0)
    }
    filled = difference(intersection(filled, maxExtents), [...cuts, ...bareHoles])

    // 6. The zones that outrank it.
    if (zoneCuts.length > 0 && filled.length > 0) {
      yield
      const before = filled
      filled = difference(filled, zoneCuts)
      if (opening && filled.length > 0)
        filled = intersection(minimumWidth(filled, minThickness, maxError), before)
    }
    if (sameNetAbove.length > 0 && filled.length > 0) filled = difference(filled, sameNetAbove)
    // A hatched pour carved by a zone above it keeps a solid border along the
    // cut, a minimum width wide, within its own solid extent (KiCad's refill).
    if (hatch && filled.length > 0 && (zoneCuts.length > 0 || sameNetAbove.length > 0)) {
      const knocked = merged([...zoneCuts, ...sameNetAbove])
      const border = intersection(
        difference(grow(knocked, minThickness, maxError), knocked),
        preHatch
      )
      if (border.length > 0) filled = union(filled, border)
    }
    results.push({ layer, regions: filled })
  }

  // Islands, over all the zone's layers at once, then what lies mostly off the board.
  yield
  const kept = removeIslands(board, index, zone, results, fillOf)
  const onBoard = outline.regions
  const floor = 3 * minThickness * minThickness
  return kept
    .map(({ layer, regions }) => ({
      layer,
      regions: regions.filter(
        (region) =>
          onBoard.length === 0 ||
          regionArea(region) < floor ||
          areaOf(intersection([region], onBoard)) * 2 >= regionArea(region)
      )
    }))
    .filter(({ regions }) => regions.length > 0)
    .concat(yield* nonCopperFills(board, zone, zoneRing, outline, keepouts, minThickness, maxError))
    .map(({ layer, regions }) => ({
      layer,
      polys: regions.map((region) =>
        fractured(region).map((p) => ({ x: mmToNm(p.x), y: mmToNm(-p.y) }))
      )
    }))
}

/**
 * A zone's fill on its layers that are not copper — a mask opening, a silk
 * area — as KiCad fills one (`ZONE_FILLER::fillNonCopperZone`): the outline on
 * the board, smoothed, less the rule areas that keep pours out; shrunk by half
 * the minimum width less 1 µm whatever that is (a width under 4 µm grows it),
 * hatched while shrunk, grown back when there is width to grow. No clearances,
 * no islands: nothing on those layers conducts.
 */
function* nonCopperFills(
  board: KicadBoard,
  zone: KicadBoardZone,
  zoneRing: ClipRegion,
  outline: ReturnType<typeof buildBoardOutline>,
  keepouts: ReturnType<typeof boardKeepouts>,
  minThickness: number,
  maxError: number
): Generator<void, Array<{ layer: string; regions: ClipRegion[] }>> {
  const names = board.layers.map((l) => l.name)
  const layers = zone.layers.flatMap((layer) =>
    isCopperLayer(layer) || layer.endsWith('.Cu')
      ? []
      : layer.startsWith('*.')
        ? names.filter((name) => name.endsWith(layer.slice(1)))
        : [layer]
  )
  const out: Array<{ layer: string; regions: ClipRegion[] }> = []
  const half = minThickness / 2 - WIDTH_EPSILON
  for (const layer of layers) {
    yield
    let fill: ClipRegion[] = outline.fallback
      ? [zoneRing]
      : intersection([zoneRing], outline.regions)
    if (zone.smoothing && zone.smoothingRadius && fill.length > 0)
      fill = smoothRegions(fill, zone.smoothing, nmToMm(zone.smoothingRadius), maxError)
    const areas = keepouts
      .filter((keepout) => !keepout.rules.copperpour && keepout.layers.includes(layer))
      .map((keepout) => ({ outer: keepout.region.outer, holes: keepout.region.holes ?? [] }))
    if (areas.length > 0) fill = difference(fill, areas)
    if (fill.length === 0) continue
    fill = offset(fill, -half, { join: 'square' })
    if (zone.hatchFill)
      fill = difference(
        fill,
        hatchHoles(fill, zone.hatchFill, zoneRing, [], minThickness, maxError)
      )
    if (half > WIDTH_EPSILON) fill = grow(fill, half, maxError)
    if (fill.length > 0) out.push({ layer, regions: fill })
  }
  return out
}

/**
 * Whether KiCad's refill revisits a zone on a layer (`ZONE_FILLER::Fill`,
 * iterative refill), so that its own net's zones carve it by their fills
 * rather than their outlines. The refill starts from the zones under a same-net
 * zone of strictly higher priority, both filled there, and revisits each of
 * them, the same-net zones beside one, and the zones one outranks and reaches.
 * (It starts too from zones that lost islands, which a fill in isolation
 * cannot know.)
 */
function refillRevisits(
  board: KicadBoard,
  zone: KicadBoardZone,
  layer: string,
  fillOf: (zone: KicadBoardZone, layer: string) => ClipRegion[],
  reach: number
): boolean {
  const pours = allZones(board).filter(
    (z) =>
      !z.isKeepout &&
      z.points.length >= 3 &&
      resolveZoneLayers(z, board).includes(layer) &&
      fillOf(z, layer).length > 0
  )
  const boxes = new Map(pours.map((z) => [z, boxOf(z.points.map(toWorld))]))
  // A footprint's zone is never refilled, so never revisited.
  const seeds = pours.filter(
    (lower) =>
      lower.footprint === undefined &&
      !isTeardropZone(lower) &&
      pours.some(
        (higher) =>
          higher !== lower &&
          !isTeardropZone(higher) &&
          (higher.net ?? 0) === (lower.net ?? 0) &&
          (higher.priority ?? 0) > (lower.priority ?? 0) &&
          boxesMeet(boxes.get(lower)!, boxes.get(higher)!)
      )
  )
  const box = boxOf(zone.points.map(toWorld))
  return seeds.some(
    (seed) =>
      seed === zone ||
      (boxesMeet(boxes.get(seed)!, box, reach) &&
        ((seed.net ?? 0) === (zone.net ?? 0) || outranks(seed, zone)))
  )
}

const storedFillCache = new WeakMap<KicadBoardZone, Map<string, ClipRegion[]>>()

/** A zone's fill on a layer as the board stores it, world space, unioned once per zone. */
function storedFillOf(zone: KicadBoardZone, layer: string): ClipRegion[] {
  let byLayer = storedFillCache.get(zone)
  if (!byLayer) storedFillCache.set(zone, (byLayer = new Map()))
  let regions = byLayer.get(layer)
  if (!regions) {
    const polys = zone.filledPolys.filter((p) => (p.layer ?? zone.layers[0]) === layer)
    regions =
      polys.length === 0
        ? []
        : union(
            polys.map((p) => ring(p.points.map(toWorld))),
            []
          )
    byLayer.set(layer, regions)
  }
  return regions
}

const padCenter = (board: KicadBoard, item: CopperItem, pad: KicadPad): Pt => {
  if (item.ref.type !== 'pad') return shapeCenter(item.shape)
  const bfp = board.footprints[item.ref.index]
  return tfPoint(footprintTransform(bfp), pad.position.x, pad.position.y)
}

/**
 * KiCad's `FlashLayer` for an unplated hole: a round or oval pad whose drill
 * is at least its size has no copper ring, only a hole.
 */
function npthWithoutRing(pad: KicadPad): boolean {
  if (pad.type !== 'np_thru_hole' || !pad.drill) return false
  if (pad.drill.offset && (pad.drill.offset.x !== 0 || pad.drill.offset.y !== 0)) return false
  if (pad.shape === 'circle' && !pad.drill.oval) return pad.drill.diameter >= pad.size.w
  if (pad.shape === 'oval' && pad.drill.oval)
    return pad.drill.oval.width >= pad.size.w && pad.drill.oval.height >= pad.size.h
  return false
}

const ringArea = (points: readonly Pt[]): number => Math.abs(ringArea2(points)) / 2
const regionArea = (region: ClipRegion): number =>
  ringArea(region.outer) - region.holes.reduce((sum, hole) => sum + ringArea(hole), 0)
const areaOf = (regions: readonly ClipRegion[]): number =>
  regions.reduce((sum, region) => sum + regionArea(region), 0)

/**
 * KiCad's island removal (`ZONE_FILLER::Fill`, `CN_CLUSTER::IsOrphaned`): a
 * piece is an island unless copper of the zone's net joins it to a pad of that
 * net — through tracks, vias, other zones' fills and the zone's own pieces on
 * other layers; a via or track alone anchors nothing. A layer whose every
 * piece is an island keeps them all. A zone of no net is not in
 * connectivity at all, and KiCad counts only its first piece on each layer an
 * island. Mode 0 removes islands, 1 keeps them, 2 removes those under
 * `island_area_min` (mm²).
 */
function removeIslands(
  board: KicadBoard,
  index: BoardSpatialIndex,
  zone: KicadBoardZone,
  layers: Array<{ layer: string; regions: ClipRegion[] }>,
  fillOf: (zone: KicadBoardZone, layer: string) => ClipRegion[]
): Array<{ layer: string; regions: ClipRegion[] }> {
  const mode = zone.islandRemovalMode ?? 0
  if (mode === 1) return layers
  const net = zone.net ?? 0
  const islands: boolean[][] =
    net > 0
      ? islandPieces(board, index, zone, layers, fillOf)
      : layers.map(({ regions }) => {
          const first = firstPiece(regions)
          return regions.map((_, i) => i === first)
        })
  // A layer whose every piece is an island is an unconnected pour, kept whole
  // (KiCad 10.0; later KiCad clears it when another layer connects).
  const minArea = zone.minIslandArea ?? 10
  return layers.map(({ layer, regions }, l) => ({
    layer,
    regions: islands[l].every(Boolean)
      ? regions
      : regions.filter(
          (region, i) => !islands[l][i] || (mode === 2 && regionArea(region) >= minArea)
        )
  }))
}

/**
 * Which piece KiCad's fill lists first — the one it counts an island in a zone
 * of no net. Its pieces come in the order Clipper emits them in the file's
 * frame (y down), so they are put through Clipper there and the first one out
 * matched back.
 */
function firstPiece(regions: readonly ClipRegion[]): number {
  if (regions.length < 2) return 0
  const flip = (points: readonly Pt[]): Pt[] => points.map((p) => ({ x: p.x, y: -p.y }))
  const ordered = union(
    regions.map((region) => ({ outer: flip(region.outer), holes: region.holes.map(flip) })),
    []
  )
  if (ordered.length === 0) return 0
  const probe = ordered[0].outer[0]
  const at = { x: probe.x, y: -probe.y }
  const match = regions.findIndex((region) => pointNearRing(at, region.outer))
  return match < 0 ? 0 : match
}

/** Whether a point lies on a ring, to a micrometre. */
function pointNearRing(p: Pt, ring: readonly Pt[]): boolean {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]
    const b = ring[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t =
      len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    if (Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) < 0.001) return true
  }
  return false
}

/** A net's items grouped as their copper joins them, and which groups hold a pad. */
interface NetGroups {
  items: CopperItem[]
  /** Each item's group (a representative position in `items`). */
  group: Int32Array
  anchored: Set<number>
}

const netGroupCache = new WeakMap<BoardSpatialIndex, Map<number, NetGroups>>()

function netGroups(board: KicadBoard, index: BoardSpatialIndex, net: number): NetGroups {
  let byNet = netGroupCache.get(index)
  if (!byNet) netGroupCache.set(index, (byNet = new Map()))
  const cached = byNet.get(net)
  if (cached) return cached
  const items = index.items.filter((item) => item.net === net)
  const position = new Map<number, number>()
  items.forEach((item, i) => position.set(item.id, i))
  const parent = items.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  for (const item of items) {
    for (const other of index.query(item.minX, item.minY, item.maxX, item.maxY)) {
      if (other.id <= item.id || other.net !== net) continue
      const a = find(position.get(item.id)!)
      const b = find(position.get(other.id)!)
      if (a !== b && itemsConnect(board, item, other).length > 0) parent[a] = b
    }
  }
  const group = Int32Array.from(items, (_, i) => find(i))
  const anchored = new Set<number>()
  items.forEach((item, i) => {
    if (item.ref.type !== 'pad') return
    const pad = board.footprints[item.ref.index].footprint.pads[item.ref.pad]
    const free = pad.pinType === 'free' && (pad.net?.name ?? '').startsWith('unconnected-')
    if (!free) anchored.add(group[i])
  })
  const groups = { items, group, anchored }
  byNet.set(net, groups)
  return groups
}

/** A zone's stored fill rings as connectivity probes them, built once per zone. */
const storedPieceCache = new WeakMap<KicadBoardZone, ZoneFill[]>()

/**
 * For each layer's pieces, which are islands: the net's item groups (above)
 * joined through the pieces that touch them — these pieces and the other
 * zones' fills of the net, each probed as connectivity probes a fill.
 */
function islandPieces(
  board: KicadBoard,
  index: BoardSpatialIndex,
  zone: KicadBoardZone,
  layers: Array<{ layer: string; regions: ClipRegion[] }>,
  fillOf: (zone: KicadBoardZone, layer: string) => ClipRegion[]
): boolean[][] {
  const net = zone.net ?? 0
  const groups = netGroups(board, index, net)
  const n = groups.items.length
  const parent = Array.from(groups.group)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const join = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  const pieces: ZoneFill[] = []
  const add = (fill: ZoneFill): number => {
    parent.push(n + pieces.length)
    pieces.push(fill)
    return n + pieces.length - 1
  }
  const own = layers.map(({ layer, regions }) =>
    regions.map((region) => add(connectFill(fractured(region), net, layer)))
  )
  for (const other of allZones(board)) {
    if (other === zone || other.isKeepout || other.net !== net) continue
    const fresh = resolveZoneLayers(other, board).flatMap((layer) =>
      fillOf === storedFillOf
        ? []
        : fillOf(other, layer).map((region) => connectFill(fractured(region), net, layer))
    )
    let fills = fresh
    if (fillOf === storedFillOf || fresh.length === 0) {
      fills = storedPieceCache.get(other) ?? []
      if (!storedPieceCache.has(other)) {
        fills = other.filledPolys
          .filter((poly) => poly.points.length >= 3)
          .map((poly) => connectFill(poly.points.map(toWorld), net, poly.layer ?? other.layers[0]))
        storedPieceCache.set(other, fills)
      }
    }
    for (const fill of fills) add(fill)
  }
  pieces.forEach((fill, f) => {
    groups.items.forEach((item, i) => {
      if (find(i) === find(n + f)) return
      if (item.ref.type === 'via' && !viaFlashed(board, index, item, fill.layer)) return
      if (itemTouchesFill(item, fill)) join(i, n + f)
    })
    // Overlapping fills of the net join (any vertex of one inside the other).
    for (let g = 0; g < f; g++) {
      const other = pieces[g]
      if (fill.layer !== other.layer || find(n + f) === find(n + g)) continue
      if (
        fill.maxX < other.minX ||
        fill.minX > other.maxX ||
        fill.maxY < other.minY ||
        fill.minY > other.maxY
      )
        continue
      if (
        fill.points.some((p) => fillHasPoint(other, p)) ||
        other.points.some((p) => fillHasPoint(fill, p))
      )
        join(n + f, n + g)
    }
  })
  const anchoredRoots = new Set([...groups.anchored].map(find))
  return own.map((ids) => ids.map((id) => !anchoredRoots.has(find(id))))
}

/**
 * The options that fill a zone as DRC will check it: every clearance the
 * rules' answer for (this zone, that item) (`rules/resolver.ts`).
 */
export function zoneFillOptions(rules: BoardRules, zone: KicadBoardZone): ZoneFillOptions {
  // A zone being filled has no fill yet, and a rule's area test reads a zone by
  // its fill (KiCad's `collidesWithArea`): to its own rules it is in no area.
  const zoneItem = { ...rules.zoneItem(zone), unfilled: true }
  const ruleItem = (other: FillObstacle): ReturnType<BoardRules['copperItem']> =>
    'ref' in other
      ? rules.copperItem(other)
      : 'drawing' in other
        ? {
            kind: other.drawing,
            label: other.drawing,
            net: other.net,
            layers: [other.layer],
            nonCopper: false
          }
        : rules.padItem(other.fp, other.pad)
  return {
    clearanceTo: (other, layer) => {
      const otherItem = 'points' in other ? rules.zoneItem(other) : ruleItem(other)
      return rules.resolver.evaluate('clearance', zoneItem, otherItem, layer).value.min ?? 0
    },
    holeClearanceTo: (other, layer) =>
      rules.resolver.evaluate('hole_clearance', zoneItem, ruleItem(other), layer).value.min ?? 0,
    maxClearance: rules.maxClearance,
    // The zone against the board edge, as KiCad asks it of an Edge.Cuts item.
    edgeClearance:
      rules.resolver.evaluate(
        'edge_clearance',
        { kind: 'graphic', label: 'Edge.Cuts', layers: ['Edge.Cuts'], nonCopper: true },
        zoneItem,
        null
      ).value.min ?? 0,
    ...(rules.resolver.hasRules('physical_clearance')
      ? {
          courtyardClearance: (fp: number, layer: string): number | null => {
            const r = rules.resolver.evaluate(
              'physical_clearance',
              zoneItem,
              rules.footprintItem(fp),
              layer
            )
            return r.isNull ? null : (r.value.min ?? 0)
          }
        }
      : {}),
    maxError: rules.maxError,
    textVariables: rules.textVariables,
    padConnection: (pad, layer) => rules.zoneConnection(rules.copperItem(pad), zone, layer)
  }
}

/**
 * A `fillOf` for a caller refilling zones one after another: the fills it has
 * just made, else the stored ones. Record each result with `set`.
 */
export function freshFills(): {
  fillOf: NonNullable<ZoneFillOptions['fillOf']>
  set: (zone: KicadBoardZone, fill: ZoneLayerFill[]) => void
} {
  const made = new Map<KicadBoardZone, ZoneLayerFill[]>()
  const regions = new Map<KicadBoardZone, Map<string, ClipRegion[]>>()
  return {
    fillOf: (zone, layer) => {
      const fill = made.get(zone)
      if (!fill) return undefined
      let byLayer = regions.get(zone)
      if (!byLayer) regions.set(zone, (byLayer = new Map()))
      let out = byLayer.get(layer)
      if (!out) {
        const polys = fill.filter((f) => f.layer === layer).flatMap((f) => f.polys)
        out =
          polys.length === 0
            ? []
            : union(
                polys.map((points) => ring(points.map(toWorld))),
                []
              )
        byLayer.set(layer, out)
      }
      return out
    },
    set: (zone, fill) => {
      made.set(zone, fill)
      regions.delete(zone)
    }
  }
}

/** Convenience wrapper: run every step in one go (tests, small boards). */
export function computeZoneFill(
  board: KicadBoard,
  index: BoardSpatialIndex,
  zone: KicadBoardZone,
  opts: ZoneFillOptions
): ZoneLayerFill[] {
  const gen = computeZoneFillSteps(board, index, zone, opts)
  let step = gen.next()
  while (!step.done) step = gen.next()
  return step.value
}

function pointInRing(p: Pt, pts: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]
    const b = pts[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

function pointInRegion(p: Pt, region: ClipRegion): boolean {
  if (!pointInRing(p, region.outer)) return false
  for (const hole of region.holes) if (pointInRing(p, hole)) return false
  return true
}
