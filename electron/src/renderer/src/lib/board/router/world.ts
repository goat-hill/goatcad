/**
 * The router's world — a branchable overlay over `BoardSpatialIndex`
 * (PNS `NODE` is the reference).
 *
 * The engine never touches the AST: it reads the base index through a world
 * that can branch. A branch records added items and removed base ids and
 * answers queries as parent-minus-removed-plus-added; abandoning a branch is
 * dropping the reference — that IS the rollback, and a stack of branches IS
 * shove's spring-back. Commit diffs the surviving branch against
 * the base and becomes one `runCommand`.
 *
 * The board edge and keepouts (boundaries.ts) answer every query too, each
 * at its own clearance, so nothing above the world treats them apart except
 * to keep a walk on the board.
 */

import type { BoardSpatialIndex, CopperItem, NearHit } from '../spatialIndex'
import { segmentToShape, shapeOn, shapeToShape } from '../spatialIndex'
import type { CopperShape, Pt } from '../spatialIndex'
import type { RouteCornerMode } from '../pcbTools'
import { pointInRegion, type Region } from '../../geometry/polygon'
import { shapeEntersRegion } from '../keepouts'
import { ROUTER_EPSILON, convexOutline, shapeHulls, type Hull } from './hulls'
import type { Boundary, RouterBounds } from './boundaries'
import { pointInRing, shapeCore } from './geometry'
import type { RoutedKind, RouterRules } from './rules'

export interface ObstacleQuery {
  layer: string
  /** The routed net — its own copper is a target, never an obstacle. */
  excludeNet: number
  /** Optional obstacle filter (shove: immovables-only passes, etc.). */
  filter?: (item: CopperItem) => boolean
  /** What the new copper is, for the rules: a track unless named. */
  kind?: RoutedKind
}

/** Who asks a clearance: new copper of a net, on a layer. */
export type ClearanceAsker = Pick<ObstacleQuery, 'layer' | 'excludeNet' | 'kind'>

/** What a new via's hole comes too close to: a shape it keeps `gap` from, how far it is, and the board copper it is, if any. */
export interface HoleConflict {
  shape: CopperShape
  gap: number
  /** The hole's edge to the shape's, mm; 0 where they overlap. */
  actual: number
  item?: CopperItem
}

/** A via's hole: where it stands, its drill, mm, and the layers it spans. */
export interface ViaHole {
  at: Pt
  drill: number
  net: number
  layers: readonly string[]
}

let overlayIdCounter = -1

/**
 * Bumped by every add or remove in any world. A world's cached overlay list
 * is good while the count has not moved — a change anywhere up its chain
 * moves it too.
 */
let mutations = 0

/** Ids for overlay-added items, disjoint from base ids (which are ≥ 0). */
export const nextOverlayId = (): number => overlayIdCounter--

/** What a push never moves, whatever the settings: pads, holes, keepouts, the edge (KiCad's solids). */
export const isSolid = (item: CopperItem): boolean =>
  item.ref.type !== 'segment' && item.ref.type !== 'tarc' && item.ref.type !== 'via'

const UNBOUNDED: RouterBounds = {
  items: [],
  of: new Map(),
  regions: [],
  reach: 0,
  viaKeepouts: [],
  holes: [],
  viaDrill: () => 0
}

export class RouterWorld {
  private added: CopperItem[] = []
  private removed = new Set<number>()
  private cache: { at: number; items: CopperItem[] } | null = null
  private boundsCache: RouterBounds | null = null
  private rulesCache: RouterRules | null | undefined

  /**
   * `bounds` gives the board edge and keepouts (boundaries.ts), and `rules`
   * each item's clearance (rules.ts), asked for the first time a route needs
   * them: a world is built on every edit. Without rules every item is held
   * to the clearance the caller passes.
   */
  constructor(
    readonly base: BoardSpatialIndex,
    private parent?: RouterWorld,
    private readonly boundsSource?: () => RouterBounds,
    private readonly rulesSource?: () => RouterRules
  ) {}

  branch(): RouterWorld {
    return new RouterWorld(this.base, this)
  }

  /** What holds every route in besides copper (R16); branches share their root's. */
  bounds(): RouterBounds {
    if (this.parent) return this.parent.bounds()
    return (this.boundsCache ??= this.boundsSource?.() ?? UNBOUNDED)
  }

  /** Each item's clearance as the rules resolve it; null when the caller's clearance stands. */
  rules(): RouterRules | null {
    if (this.parent) return this.parent.rules()
    if (this.rulesCache === undefined) this.rulesCache = this.rulesSource?.() ?? null
    return this.rulesCache
  }

  /** The edge or keepout an item is, if it is one. */
  boundary(item: CopperItem): Boundary | undefined {
    return this.bounds().of.get(item.id)
  }

  /**
   * The clearance new copper keeps from an item: a boundary's own; else what
   * the rules give for the asker's net against it on its layer; else
   * `clearance`.
   */
  clearanceFor(item: CopperItem, clearance: number, asker?: ClearanceAsker): number {
    const boundary = this.boundary(item)
    const rules = asker ? this.rules() : null
    if (boundary) {
      if (!rules || !asker) return boundary.clearance
      if (boundary.pad)
        return rules.holeClearance(
          asker.excludeNet,
          asker.kind ?? 'track',
          boundary.pad,
          asker.layer
        )
      // The edge is held at the routed net's own edge clearance, as DRC holds it (R16).
      return boundary.kind !== 'keepout'
        ? rules.edgeClearance(asker.excludeNet, asker.kind ?? 'track', asker.layer)
        : boundary.clearance
    }
    return rules && asker
      ? rules.clearance(asker.excludeNet, asker.kind ?? 'track', item, asker.layer)
      : clearance
  }

  /** How far past its own half width a search for what new copper breaks must reach. */
  reach(clearance: number): number {
    return Math.max(clearance, this.bounds().reach, this.rules()?.reach ?? 0)
  }

  /** The keepouts a via of radius `r` at `at` would reach into on any of `layers` (R16, R24). */
  viaKeepoutsAt(at: Pt, r: number, layers: readonly string[]): Region[] {
    const via = { kind: 'circle' as const, cx: at.x, cy: at.y, r }
    return this.bounds()
      .viaKeepouts.filter(
        (k) =>
          k.layers.some((l) => layers.includes(l)) &&
          shapeEntersRegion(via, k.region, ROUTER_EPSILON)
      )
      .map((k) => k.region)
  }

  /**
   * What the hole of a new via comes too close to (R24), as DRC holds it:
   * every other hole, of any net, at the hole-to-hole spacing — pads', the
   * world's vias', and `others` not in it yet (the route's own) — and other
   * nets' copper on the layers it spans at the hole clearance.
   */
  viaHoleConflicts(via: ViaHole, others: readonly ViaHole[] = []): HoleConflict[] {
    if (via.drill <= 0) return []
    const rules = this.rules()
    const hole = holeShape(via.at, via.drill)
    const reach = via.drill / 2 + Math.max(this.reach(0), rules?.holeReach ?? 0) + ROUTER_EPSILON
    const out: HoleConflict[] = []
    /** The hole's edge to the shape's when it comes nearer than `gap`, else null. */
    const tooClose = (shape: CopperShape, gap: number): number | null => {
      const d = shapeToShape(hole, shape)
      return d <= 0 || d < gap - ROUTER_EPSILON ? Math.max(0, d) : null
    }
    const sharesLayer = (layers: readonly string[]): boolean =>
      layers.some((l) => via.layers.includes(l))

    for (const h of this.bounds().holes) {
      const s = h.shape
      if (
        Math.max(Math.abs(s.x0 - via.at.x), Math.abs(s.y0 - via.at.y)) >
        reach + s.halfWidth + Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
      )
        continue
      const gap = rules?.holeToHole(via.net, via.layers, h) ?? 0
      const actual = tooClose(s, gap)
      if (actual === null) continue
      const pad = this.base.items.find(
        (item) =>
          item.ref.type === 'pad' && item.ref.index === h.footprint && item.ref.pad === h.pad
      )
      out.push({ shape: s, gap, actual, ...(pad ? { item: pad } : {}) })
    }
    for (const item of this.itemsNear(via.at, reach)) {
      if (item.ref.type !== 'via' || item.ref.index < 0 || item.shape.kind !== 'circle') continue
      if (!sharesLayer(item.layers)) continue
      const s = holeShape(
        { x: item.shape.cx, y: item.shape.cy },
        this.bounds().viaDrill(item.ref.index)
      )
      const gap = rules?.holeToHole(via.net, via.layers, { item }) ?? 0
      const actual = tooClose(s, gap)
      if (actual !== null) out.push({ shape: s, gap, actual, item })
    }
    for (const other of others) {
      if (!sharesLayer(other.layers)) continue
      const s = holeShape(other.at, other.drill)
      const owner = viaItem(other)
      const gap = rules?.holeToHole(via.net, via.layers, { item: owner }) ?? 0
      const actual = tooClose(s, gap)
      if (actual !== null) out.push({ shape: s, gap, actual })
    }
    for (const layer of via.layers) {
      for (const item of this.itemsNear(via.at, reach, layer)) {
        if (item.net === via.net || this.boundary(item)) continue
        const gap = rules?.viaHoleClearance(via.net, via.layers, item, layer) ?? 0
        const shape = shapeOn(item, layer)
        const actual = tooClose(shape, gap)
        if (actual !== null && !out.some((c) => c.item === item))
          out.push({ shape, gap, actual, item })
      }
    }
    return out
  }

  /** Whether a point is on the board, or the board has no outline to be off. */
  onBoard(p: Pt): boolean {
    const regions = this.bounds().regions
    return regions.length === 0 || regions.some((r) => pointInRegion(p, r))
  }

  /**
   * The outlines a route's centerline walks round to pass an item at
   * clearance. An area's piece (a notch's, a cutout's, a keepout's) is one
   * convex outline: its inside is closed to the route, not only its edges.
   */
  hullsOf(
    item: CopperItem,
    clearance: number,
    halfWidth: number,
    cornerMode: RouteCornerMode,
    asker?: ClearanceAsker
  ): Hull[] {
    const boundary = this.boundary(item)
    const hulls = shapeHulls(
      item.shape,
      this.clearanceFor(item, clearance, asker),
      halfWidth,
      cornerMode
    )
    if (!boundary || boundary.kind === 'edge') return hulls
    return [convexOutline(hulls.flat(), cornerMode)]
  }

  add(item: CopperItem): void {
    this.added.push(item)
    mutations++
  }

  remove(id: number): void {
    this.removed.add(id)
    mutations++
  }

  /** Whether an item stands in this world: base and not hidden, or added and not removed. */
  has(id: number): boolean {
    if (this.isRemoved(id)) return false
    if (id >= 0) return id < this.base.items.length
    return this.hasAdded(id)
  }

  private hasAdded(id: number): boolean {
    if (this.added.some((item) => item.id === id)) return true
    return this.parent ? this.parent.hasAdded(id) : false
  }

  private isRemoved(id: number): boolean {
    if (this.removed.has(id)) return true
    return this.parent ? this.parent.isRemoved(id) : false
  }

  private overlayItems(): CopperItem[] {
    if (this.cache?.at === mutations) return this.cache.items
    const chain: CopperItem[] = []
    // Parent-first so a child's removals can hide a parent's additions.
    if (this.parent) chain.push(...this.parent.overlayItems())
    chain.push(...this.added)
    const items = chain.filter((item) => !this.removed.has(item.id))
    this.cache = { at: mutations, items }
    return items
  }

  /**
   * Copper within `radius` of a segment, nearest first — the base query with
   * the overlay composed in. Same contract as `BoardSpatialIndex.nearSegment`.
   */
  nearSegment(a: Pt, b: Pt, halfWidth: number, radius: number, q: ObstacleQuery): NearHit[] {
    const hits = this.base
      .nearSegment(a.x, a.y, b.x, b.y, radius + halfWidth, {
        layer: q.layer,
        excludeNet: q.excludeNet
      })
      .filter((h) => !this.isRemoved(h.item.id) && (!q.filter || q.filter(h.item)))
    const r = radius + halfWidth
    for (const item of [...this.overlayItems(), ...this.boundsNear(a, b, r)]) {
      if (!item.layers.includes(q.layer) || item.net === q.excludeNet) continue
      if (q.filter && !q.filter(item)) continue
      const dist = segmentToShape(item.shape, a.x, a.y, b.x, b.y, 0)
      if (dist <= r) hits.push({ item, dist })
    }
    return hits.sort((x, y) => x.dist - y.dist)
  }

  /** Boundary items whose box comes within `r` of segment a→b. */
  private boundsNear(a: Pt, b: Pt, r: number): CopperItem[] {
    const minX = Math.min(a.x, b.x) - r
    const minY = Math.min(a.y, b.y) - r
    const maxX = Math.max(a.x, b.x) + r
    const maxY = Math.max(a.y, b.y) + r
    return this.bounds().items.filter(
      (item) =>
        item.maxX >= minX &&
        item.minX <= maxX &&
        item.maxY >= minY &&
        item.minY <= maxY &&
        !this.isRemoved(item.id)
    )
  }

  /**
   * Items a routed segment breaks clearance to, nearest first: each at the
   * clearance it asks of the query's net (`clearanceFor`), less ε (hulls.ts).
   */
  collisions(a: Pt, b: Pt, halfWidth: number, clearance: number, q: ObstacleQuery): NearHit[] {
    const reach = halfWidth + this.reach(clearance) - ROUTER_EPSILON
    return this.nearSegment(a, b, 0, reach, q).filter(
      (h) => h.dist < halfWidth + this.clearanceFor(h.item, clearance, q) - ROUTER_EPSILON
    )
  }

  /** Items whose copper lies within `radius` of a point (no net filter). */
  itemsNear(p: Pt, radius: number, layer?: string): CopperItem[] {
    const out = this.base
      .near(p.x, p.y, radius, layer !== undefined ? { layer } : {})
      .filter((h) => !this.isRemoved(h.item.id))
      .map((h) => h.item)
    for (const item of [...this.overlayItems(), ...this.boundsNear(p, p, radius)]) {
      if (layer !== undefined && !item.layers.includes(layer)) continue
      if (segmentToShape(item.shape, p.x, p.y, p.x, p.y, 0) <= radius) out.push(item)
    }
    return out
  }

  /**
   * This world's net effect against the BASE index, aggregated across the
   * branch chain: overlay items still alive, and base ids hidden. Both the
   * displaced-copper preview and the commit diff read this.
   */
  delta(): { added: CopperItem[]; removedBaseIds: number[] } {
    const removed = new Set<number>()
    this.collectRemovedBaseIds(removed)
    return { added: this.overlayItems(), removedBaseIds: [...removed] }
  }

  private collectRemovedBaseIds(into: Set<number>): void {
    for (const id of this.removed) if (id >= 0) into.add(id)
    this.parent?.collectRemovedBaseIds(into)
  }

  /**
   * The first obstacle a routed line meets: walk its segments in order and
   * return the nearest colliding item of the earliest colliding segment.
   * Collision runs at `clearance − ε` (hulls are built at full clearance —
   * the PNS ε discipline, hulls.ts).
   */
  firstObstacle(
    path: readonly Pt[],
    halfWidth: number,
    clearance: number,
    q: ObstacleQuery
  ): CopperItem | null {
    return this.firstObstacleFrom(path, halfWidth, clearance, q, 0)?.item ?? null
  }

  /**
   * `firstObstacle` for a path whose first `from` segments are known clear,
   * with the segment it was met on.
   */
  firstObstacleFrom(
    path: readonly Pt[],
    halfWidth: number,
    clearance: number,
    q: ObstacleQuery,
    from: number
  ): { item: CopperItem; segment: number } | null {
    for (let i = from; i < path.length - 1; i++) {
      const a = path[i]
      const b = path[i + 1]
      const colliding = this.collisions(a, b, halfWidth, clearance, q)
      if (colliding.length < 2) {
        if (colliding.length === 1) return { item: colliding[0].item, segment: i }
        continue
      }
      // Several on one segment: the one whose clearance the line enters
      // first — how far it gets from `a` before it is too near each.
      const along = (item: CopperItem): number => {
        const shape = shapeOn(item, q.layer)
        const need = halfWidth + this.clearanceFor(item, clearance, q) - ROUTER_EPSILON
        const reaches = (t: number): boolean =>
          segmentToShape(shape, a.x, a.y, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 0) < need
        if (reaches(0)) return 0
        let lo = 0
        let hi = 1
        const len = Math.hypot(b.x - a.x, b.y - a.y)
        while ((hi - lo) * len > 1e-6) {
          const mid = (lo + hi) / 2
          if (reaches(mid)) hi = mid
          else lo = mid
        }
        return hi
      }
      let first = colliding[0].item
      let firstAt = along(first)
      for (const hit of colliding.slice(1)) {
        const at = along(hit.item)
        if (at < firstAt) {
          first = hit.item
          firstAt = at
        }
      }
      return { item: first, segment: i }
    }
    return null
  }

  /** Whether a single routed segment violates clearance (at clearance − ε). */
  violates(a: Pt, b: Pt, halfWidth: number, clearance: number, q: ObstacleQuery): boolean {
    return this.collisions(a, b, halfWidth, clearance, q).length > 0
  }

  /**
   * Whether other-net copper (or any of `also`) lies in the region a run and
   * its replacement enclose — replacing the one with the other would move the
   * line to the other side of it.
   */
  obstacleBetween(
    from: readonly Pt[],
    to: readonly Pt[],
    q: ObstacleQuery,
    also: readonly CopperShape[] = []
  ): boolean {
    const ring = [...from, ...[...to].reverse().slice(1, -1)]
    if (ring.length < 3) return false
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of ring) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    if (also.some((shape) => shapeCore(shape).some((p) => pointInRing(p, ring)))) return true
    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
    const radius = Math.hypot(maxX - minX, maxY - minY) / 2
    for (const item of this.itemsNear(center, radius, q.layer)) {
      if (item.net === q.excludeNet || (q.filter && !q.filter(item))) continue
      if (shapeCore(item.shape).some((p) => pointInRing(p, ring))) return true
    }
    return false
  }

  /** Whether any segment of a path violates clearance. */
  pathViolates(
    path: readonly Pt[],
    halfWidth: number,
    clearance: number,
    q: ObstacleQuery
  ): boolean {
    for (let i = 0; i < path.length - 1; i++) {
      if (this.violates(path[i], path[i + 1], halfWidth, clearance, q)) return true
    }
    return false
  }
}

const holeShape = (at: Pt, drill: number): Extract<CopperShape, { kind: 'capsule' }> => ({
  kind: 'capsule',
  x0: at.x,
  y0: at.y,
  x1: at.x,
  y1: at.y,
  halfWidth: drill / 2
})

/** A via not on the board yet, as the rules see one. */
const viaItem = (via: ViaHole): CopperItem => ({
  id: -1,
  ref: { type: 'via', index: -1 },
  net: via.net,
  layers: via.layers,
  shape: { kind: 'circle', cx: via.at.x, cy: via.at.y, r: via.drill / 2 },
  minX: via.at.x,
  minY: via.at.y,
  maxX: via.at.x,
  maxY: via.at.y
})
