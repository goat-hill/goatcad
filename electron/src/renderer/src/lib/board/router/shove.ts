/**
 * Push: move other nets' tracks and vias out of the head's way
 * (docs/router-behavior.md P1–P9).
 *
 * Displaced copper never mutates the board. Each click's pushes are a world
 * (a `RouterWorld` branch) on a stack of floors; the head's pushes are
 * worked out afresh every frame on top of the last floor. So pushed copper
 * springs back the moment the head no longer presses on it (P4), and a
 * click, Backspace or Esc is a push or pop of a floor (R21, R22).
 *
 * An attempt, per frame:
 *
 * 1. The head meets its first obstacle. Something movable is pushed: a track
 *    walks around the head's hulls, keeping its ends and taking the
 *    shortest way that clears (P2); a via steps straight out by what
 *    clearance needs and its tracks re-draw to follow (P7).
 * 2. Something that cannot move — a pad, a locked item — is walked round by
 *    the head the shorter way, as KiCad's shove walks a line round a solid.
 * 3. Displaced copper then settles its own collisions in turn (P3): each
 *    item pushed ranks one below its pusher, and meeting anything of equal
 *    or higher rank it walks round it instead; the head stands in the world
 *    at the top rank meanwhile. A push that cannot be done, a chain that
 *    cannot settle or one that runs out of work fails the attempt, and the
 *    caller walks the head round everything, as KiCad's does (P5).
 */

import type { CopperItem, Pt } from '../spatialIndex'
import { segmentToShape, shapeOn, type CopperShape } from '../spatialIndex'
import type { RouteCornerMode } from '../pcbTools'
import { routeElbow } from '../pcbTools'
import { RouterWorld, nextOverlayId, type ClearanceAsker, type ObstacleQuery } from './world'
import type { RoutedKind } from './rules'
import { segmentHull, shapeHulls, ROUTER_EPSILON, type Hull } from './hulls'
import { walkPathAroundHull } from './hullWalk'
import {
  AXIS_NORMALS,
  OCTILINEAR_NORMALS,
  arcPolyline,
  boundByDirections,
  pathLength,
  pointInRing,
  samePt,
  tidyPath
} from './geometry'
import { assembleLine, type LineArc } from './lines'
import { smoothPath } from './optimize'
import { clusterSide, walkObstacle, type Walked } from './walkaround'

const HEAD_RANK = 100000
const ITERATION_LIMIT = 100
/**
 * The work an attempt may do, counted in segment-steps (a segment checked
 * or bent round an outline). A push that cannot settle within it is
 * impossible (P5, Q1). Counted, not timed, so the answer is the same on any
 * machine (Q2).
 */
const WORK_BUDGET = 8000
/**
 * A head that keeps going back round the same obstacle is circling a pocket
 * it cannot leave; past this many walks round one item the attempt fails.
 */
const REWALK_LIMIT = 3
/**
 * A head walked round what it cannot push to more than this multiple of its
 * own length is not pushing any more: the attempt fails and the caller walks
 * it, where the long way round stops short (router-behavior.md R39; the
 * same limit as DETOUR_LIMIT in engine.ts).
 */
const HEAD_DETOUR_LIMIT = 3
/** How many times a pushed line goes round its pusher's outlines before it is judged. */
const HULL_PASSES = 3

/** The routed head's physical parameters, independent of how it was drawn. */
export interface HeadGeom {
  layer: string
  width: number
  clearance: number
  net: number
  /** A via is pushed with as well as a track (R24). */
  kind?: RoutedKind
}

export interface PendingCopper {
  /** Of the routed net, unless `net` names another (several lines dragged at once). */
  segments: Array<{
    x0: number
    y0: number
    x1: number
    y1: number
    width: number
    layer: string
    net?: number
  }>
  /** A via spans `layers`, F.Cu to B.Cu when not named. */
  vias: Array<{
    x: number
    y: number
    size: number
    drill?: number
    layers?: readonly string[]
    net?: number
  }>
}

export interface PreviewSegment {
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  layer: string
  violation?: boolean
}

export interface DisplacedPreview {
  /** Base item refs whose paint the scene should suppress. */
  hiddenRefs: Array<{ type: string; index: number }>
  /** The displaced copper to draw instead. */
  segments: PreviewSegment[]
  /** Pushed vias (board index), where they would go. */
  vias?: Array<{ index: number; x: number; y: number; size: number }>
}

export interface ShoveDelta {
  /** Base items to delete at commit (their current refs): tracks and track arcs. */
  removed: Array<{ type: string; index: number }>
  /** Segments to add at commit (KiCad-space conversion is the caller's). */
  added: Array<{
    start: Pt
    end: Pt
    width: number
    layer: string
    net: number
  }>
  /** Track arcs to add at commit: a pushed line's arcs that kept their shape (P11). */
  addedArcs?: Array<{ start: Pt; mid: Pt; end: Pt; width: number; layer: string; net: number }>
  /** Base vias that moved, by board index, to their new centers. */
  movedVias?: Array<{ index: number; x: number; y: number }>
}

/**
 * How a session pushes. Read each time they are needed, never kept, so an
 * object of getters over the live settings is followed mid-gesture.
 */
export interface ShoveOptions {
  /** Whether vias may be pushed (P1). */
  pushVias?: boolean
  /** Pushed copper meeting what cannot move goes on round it, behind it (P10). */
  jumpOverObstacles?: boolean
  /** Items that must never move: locked tracks and vias. */
  isFixed?: (item: CopperItem) => boolean
  /** The work an attempt may do, in segment-steps; `WORK_BUDGET` when not given (tests lower it). */
  workBudget?: number
}

/** What the head's walk needs from the router session. */
export interface HeadWalkContext {
  cornerMode: RouteCornerMode
  /** The head's far end is pinned too (a dragged line), not only its start. */
  keepEnd?: boolean
  /** Copper of the net moving with the head on its layer: what the head pushes keeps clear of it too. */
  companions?: CopperShape[]
  /** What the head may meet at all: it passes through the rest (R2, what its tail starts inside). */
  filter?: (item: CopperItem) => boolean
}

/**
 * One of several pieces moved at once, its ends pinned: a dragged via and its
 * tracks, or several lines dragged together (D14), each of its own net.
 */
export interface GroupHead {
  path: Pt[]
  width: number
  layer: string
  kind: RoutedKind
  /** Its net, where the pieces are of several; else the group's. */
  net?: number
  /** A net it passes as its own: the other half of a pair (PR3). */
  alsoNet?: number
}

export interface ShoveResult {
  status: 'clear' | 'shoved' | 'failed'
  path: Pt[]
  /** What the head walked round. */
  walked: number[]
}

interface Entry {
  path: Pt[]
  halfWidth: number
  net: number
  kind: RoutedKind
  layer: string
  rank: number
  /** Overlay ids currently standing for this entry's copper. */
  ids: number[]
}

type Attempt = { kind: 'ok'; world: RouterWorld; head: Pt[]; walked: number[] } | { kind: 'fail' }

/** Hulls fitted so a pushed track stays in 45° shapes (P2). */
const pushedHull = (hull: Hull, mode: RouteCornerMode): Hull =>
  mode === 'free'
    ? hull
    : boundByDirections(hull, mode === '90' ? AXIS_NORMALS : OCTILINEAR_NORMALS)

/**
 * One interactive push session: lives while a trace is drawn or a track
 * dragged, dies with it. The base world is never touched.
 */
export class ShoveSession {
  /** One world per committed click, each over the one before. */
  private floors: RouterWorld[] = []
  /** This frame's pushes over the top floor; null when the head pushes nothing. */
  private current: RouterWorld | null = null
  /** The pushes of a via at the head's end, over `current` (R24); null when it pushes nothing. */
  private via: RouterWorld | null = null
  /** Overlay copper standing for the head and what moves with it: never displaced copper. */
  private readonly own = new Set<number>()

  constructor(
    private readonly baseWorld: RouterWorld,
    private readonly options: ShoveOptions = {}
  ) {}

  private get pushVias(): boolean {
    return this.options.pushVias ?? true
  }

  private isFixed(item: CopperItem): boolean {
    return this.options.isFixed?.(item) ?? false
  }

  reset(): void {
    this.own.clear()
    this.floors = []
    this.current = null
    this.via = null
  }

  /** The world a head is resolved against: every committed click's pushes. */
  floor(): RouterWorld {
    return this.floors.length > 0 ? this.floors[this.floors.length - 1] : this.baseWorld
  }

  /**
   * A click landed: the head's pushes become part of the floor. A via's
   * stay pending over it, for `markVia`.
   */
  markClick(): void {
    this.floors.push(this.current ?? this.floor())
    this.current = null
  }

  /** The via at the head's end landed: its pushes are a floor of their own, so Backspace takes them back with it. */
  markVia(): void {
    this.floors.push(this.via ?? this.floor())
    this.current = null
    this.via = null
  }

  /**
   * Copper a click laid, for the floor it landed on: what later heads meet
   * and pushed copper keeps clear of, never moved (a pair's halves, PR6).
   * Backspace takes it back with the click.
   */
  landOwn(items: readonly CopperItem[]): void {
    const floor = this.floor().branch()
    for (const item of items) {
      floor.add(item)
      this.own.add(item.id)
    }
    if (this.floors.length > 0) this.floors[this.floors.length - 1] = floor
    else this.floors.push(floor)
  }

  /** Backspace: the last click's pushes spring back. */
  undoClick(): void {
    this.floors.pop()
    this.current = null
    this.via = null
  }

  /** The head in progress will not land: its pushes spring back. */
  dropHead(): void {
    this.current = null
    this.via = null
  }

  /** The via at the head's end will not land there: its pushes spring back. */
  dropVia(): void {
    this.via = null
  }

  /** Fold the last `n` clicks into one, for a gesture that made several at once. */
  mergeClicks(n: number): void {
    // Each floor branches off the one below, so dropping the ones between
    // keeps every push: the top still sees through to them.
    if (n > 1 && this.floors.length >= n) this.floors.splice(this.floors.length - n, n - 1)
  }

  private top(): RouterWorld {
    return this.via ?? this.current ?? this.floor()
  }

  /** The world with this frame's pushes in it. */
  currentWorld(): RouterWorld {
    return this.top()
  }

  /**
   * Resolve a head path (a cursor bend, a dragged line) by pushing. 'clear':
   * nothing in the way; 'shoved': displacements (now current) make the
   * returned path legal; 'failed': nothing this mode can do — the caller
   * walks the head round everything as if nothing could move.
   */
  proposePath(
    headPath: Pt[],
    geom: HeadGeom,
    pending: PendingCopper,
    ctx: HeadWalkContext
  ): ShoveResult {
    this.current = null
    this.via = null
    const halfWidth = geom.width / 2
    const q: ObstacleQuery = {
      layer: geom.layer,
      excludeNet: geom.net,
      kind: geom.kind,
      filter: ctx.filter
    }
    const base = this.floor()
    if (headPath.length < 2 || !base.pathViolates(headPath, halfWidth, geom.clearance, q)) {
      return { status: 'clear', path: headPath, walked: [] }
    }
    const r = this.attempt(base, headPath, geom, pending, ctx)
    if (r.kind === 'fail') return { status: 'failed', path: headPath, walked: [] }
    this.current = r.world
    return { status: 'shoved', path: tidyPath(r.head), walked: r.walked }
  }

  /**
   * A via landing at `at` (R24): on each layer it spans, what it presses on
   * is pushed as the head pushes, over this frame's pushes. A via cannot go
   * round anything, so what cannot move refuses it. True when it lands
   * clear; its pushes are then this frame's too, until `markVia` lands them.
   */
  proposeVia(
    at: Pt,
    size: number,
    layers: readonly string[],
    geom: Pick<HeadGeom, 'clearance' | 'net'>,
    pending: PendingCopper,
    cornerMode: RouteCornerMode
  ): boolean {
    this.via = null
    const start = this.top()
    let world = start
    let withPending = true
    for (const layer of layers) {
      const head: HeadGeom = { ...geom, layer, width: size, kind: 'via' }
      const q: ObstacleQuery = { layer, excludeNet: geom.net, kind: 'via' }
      if (!world.violates(at, at, size / 2, geom.clearance, q)) continue
      const r = this.attempt(
        world,
        [at, at],
        head,
        withPending ? pending : { segments: [], vias: [] },
        { cornerMode, keepEnd: true }
      )
      if (r.kind === 'fail') return false
      world = r.world
      withPending = false
    }
    if (world !== start) this.via = world
    return true
  }

  /**
   * Push for several pieces of one net at once, each with both ends held: a
   * dragged via (a point path per layer it spans) and the tracks it carries
   * (D6). Each pushes in turn over the pushes of those before it, and keeps
   * clear of the others. 'failed' when one cannot be made legal; a track may
   * walk round what it cannot push (P5), a via never.
   */
  proposeGroup(
    heads: readonly GroupHead[],
    geom: Pick<HeadGeom, 'clearance' | 'net'>,
    cornerMode: RouteCornerMode
  ): { status: ShoveResult['status']; paths: Pt[][] } {
    this.current = null
    this.via = null
    let world = this.floor()
    const paths = heads.map((h) => [...h.path])
    const viaLayers = heads.filter((h) => h.kind === 'via').map((h) => h.layer)
    let pushed = false
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i]
      const net = h.net ?? geom.net
      const q: ObstacleQuery = { layer: h.layer, excludeNet: net, kind: h.kind }
      if (!world.pathViolates(paths[i], h.width / 2, geom.clearance, q)) continue
      const others: PendingCopper = { segments: [], vias: [] }
      heads.forEach((o, j) => {
        if (j === i) return
        const path = paths[j]
        const oNet = o.net ?? geom.net
        if (o.kind === 'via')
          others.vias.push({ ...path[0], size: o.width, layers: viaLayers, net: oNet })
        for (let k = 0; k < path.length - 1; k++)
          others.segments.push({
            x0: path[k].x,
            y0: path[k].y,
            x1: path[k + 1].x,
            y1: path[k + 1].y,
            width: o.width,
            layer: o.layer,
            net: oNet
          })
      })
      const head: HeadGeom = { ...geom, net, layer: h.layer, width: h.width, kind: h.kind }
      // Pieces of the same net moving with it: what it pushes keeps clear of them too.
      const companions = heads.flatMap((o, j) =>
        j === i || o.layer !== h.layer || (o.net ?? geom.net) !== net
          ? []
          : capsulesOf(paths[j], o.width / 2)
      )
      const also = h.alsoNet
      const landed = this.attempt(world, paths[i], head, others, {
        cornerMode,
        keepEnd: true,
        companions,
        ...(also !== undefined ? { filter: (item: CopperItem) => item.net !== also } : {})
      })
      if (landed.kind === 'fail') return { status: 'failed', paths }
      world = landed.world
      if (h.kind === 'track') paths[i] = tidyPath(landed.head)
      pushed = true
    }
    if (pushed) this.current = world
    return { status: pushed ? 'shoved' : 'clear', paths }
  }

  /** What the scene should hide and draw for the current pushes. */
  displaced(): DisplacedPreview {
    const { hidden, segments, arcs, vias } = this.collect()
    // An arc is drawn as its chords.
    const arcChords = arcs.flatMap((a) => {
      const run = arcPolyline(a.start, a.mid, a.end, 12)
      return run.slice(1).map((p, k) => ({ start: run[k], end: p, width: a.width, layer: a.layer }))
    })
    return {
      hiddenRefs: hidden,
      segments: [...segments, ...arcChords].map((s) => ({
        x0: s.start.x,
        y0: s.start.y,
        x1: s.end.x,
        y1: s.end.y,
        width: s.width,
        layer: s.layer
      })),
      vias
    }
  }

  /** The commit diff for the current pushes (world y-up space). */
  delta(): ShoveDelta {
    const { hidden, segments, arcs, vias } = this.collect()
    return {
      removed: hidden.filter((ref) => ref.type === 'segment' || ref.type === 'tarc'),
      added: segments,
      ...(arcs.length > 0 ? { addedArcs: arcs } : {}),
      movedVias: vias.map((v) => ({ index: v.index, x: v.x, y: v.y }))
    }
  }

  private collect(): {
    hidden: Array<{ type: string; index: number }>
    segments: ShoveDelta['added']
    arcs: NonNullable<ShoveDelta['addedArcs']>
    vias: Array<{ index: number; x: number; y: number; size: number }>
  } {
    const { added, removedBaseIds } = this.top().delta()
    const base = this.baseWorld.base
    const segments: ShoveDelta['added'] = []
    const arcs: NonNullable<ShoveDelta['addedArcs']> = []
    const vias: Array<{ index: number; x: number; y: number; size: number }> = []
    // An arc a push carried along unchanged is no change at all: neither
    // removed nor added, so the file keeps it as it was.
    const kept = new Set<number>()
    for (const item of added) {
      if (this.own.has(item.id)) continue
      const s = item.shape
      if (s.kind !== 'arc' || item.ref.type !== 'tarc') continue
      const same = removedBaseIds.find((id) => {
        const b = base.items[id]
        const bs = b?.shape
        return (
          b?.ref.type === 'tarc' &&
          bs?.kind === 'arc' &&
          samePt({ x: bs.x0, y: bs.y0 }, { x: s.x0, y: s.y0 }) &&
          samePt({ x: bs.x1, y: bs.y1 }, { x: s.x1, y: s.y1 }) &&
          samePt({ x: bs.mx, y: bs.my }, { x: s.mx, y: s.my })
        )
      })
      if (same !== undefined) {
        kept.add(same)
        kept.add(item.id)
      }
    }
    const hidden = removedBaseIds
      .filter((id) => !kept.has(id))
      .map((id) => base.items[id]?.ref)
      .filter((ref): ref is CopperItem['ref'] => ref !== undefined)
      .map((ref) => ({ type: ref.type, index: ref.index }))
    for (const item of added) {
      // The pending trace and what moves with it, not displaced copper. By
      // id, not net: in a group push one dragged net pushes another's copper.
      if (this.own.has(item.id) || kept.has(item.id)) continue
      if (item.shape.kind === 'arc' && item.ref.type === 'tarc') {
        const a = item.shape
        arcs.push({
          start: { x: a.x0, y: a.y0 },
          mid: { x: a.mx, y: a.my },
          end: { x: a.x1, y: a.y1 },
          width: a.halfWidth * 2,
          layer: item.layers[0],
          net: item.net
        })
      } else if (item.shape.kind === 'capsule') {
        segments.push({
          start: { x: item.shape.x0, y: item.shape.y0 },
          end: { x: item.shape.x1, y: item.shape.y1 },
          width: item.shape.halfWidth * 2,
          layer: item.layers[0],
          net: item.net
        })
      } else if (item.shape.kind === 'circle' && item.ref.type === 'via' && item.ref.index >= 0) {
        vias.push({
          index: item.ref.index,
          x: item.shape.cx,
          y: item.shape.cy,
          size: item.shape.r * 2
        })
      }
    }
    return { hidden, segments, arcs, vias }
  }

  // -------------------------------------------------------------------------

  private attempt(
    base: RouterWorld,
    initialHead: Pt[],
    geom: HeadGeom,
    pending: PendingCopper,
    ctx: HeadWalkContext
  ): Attempt {
    const halfWidth = geom.width / 2
    const clearance = geom.clearance
    const world = base.branch()
    const rank = new Map<number, number>()
    const work = { spent: 0 }

    // The committed clicks ride along as head-rank copper so displaced
    // copper keeps clear of them too (P6).
    for (const s of pending.segments) {
      const item = overlaySegment(
        { x: s.x0, y: s.y0 },
        { x: s.x1, y: s.y1 },
        s.width,
        s.layer,
        s.net ?? geom.net
      )
      rank.set(item.id, HEAD_RANK)
      this.own.add(item.id)
      world.add(item)
    }
    for (const v of pending.vias) {
      const item = overlayVia(
        { x: v.x, y: v.y },
        v.size / 2,
        v.layers ?? ['F.Cu', 'B.Cu'],
        v.net ?? geom.net,
        -1
      )
      rank.set(item.id, HEAD_RANK)
      this.own.add(item.id)
      world.add(item)
    }

    const movable = (item: CopperItem, pusherRank: number): boolean => {
      if ((rank.get(item.id) ?? -1) >= pusherRank || this.isFixed(item) || this.own.has(item.id))
        return false
      if (item.ref.type === 'segment' && item.shape.kind === 'capsule') return true
      // A track arc is pushed with its line (P11).
      if (item.ref.type === 'tarc' && item.shape.kind === 'arc') return true
      return this.pushVias && item.ref.type === 'via' && item.shape.kind === 'circle'
    }

    const asker: ObstacleQuery = {
      layer: geom.layer,
      excludeNet: geom.net,
      kind: geom.kind,
      filter: ctx.filter
    }
    let head = [...initialHead]
    // The head stands in the world at its rank while what it pushed settles,
    // so copper pushed on by copper it pushed never lands on it (P3).
    let headIds: number[] = []
    const placeHead = (): void => {
      for (const id of headIds) world.remove(id)
      headIds = addLine(world, rank, head, geom.width, geom.layer, geom.net, HEAD_RANK)
      for (const id of headIds) this.own.add(id)
    }
    placeHead()
    const headShapes = (): CopperShape[] => [
      ...capsulesOf(head, halfWidth),
      ...(ctx.companions ?? [])
    ]
    const ctxPush: PushContext = {
      work,
      world,
      rank,
      clearance,
      layer: geom.layer,
      cornerMode: ctx.cornerMode,
      movable,
      head: { shapes: headShapes(), asker },
      jumpOver: this.options.jumpOverObstacles ?? false
    }

    const walked: Walked = new Map()
    const walks = new Map<number, number>()
    const worklist: Entry[] = []
    const headLimit = Math.max(pathLength(initialHead), halfWidth * 2) * HEAD_DETOUR_LIMIT

    for (let iter = 0; iter < ITERATION_LIMIT; iter++) {
      if (work.spent > (this.options.workBudget ?? WORK_BUDGET)) return { kind: 'fail' }
      work.spent += head.length

      // What the head pushed settles first, pushing what lies beyond it, so
      // the head meets copper further out only once that has moved (P3).
      const obstacle =
        worklist.length > 0 ? null : world.firstObstacle(head, halfWidth, clearance, asker)
      if (obstacle) {
        if (movable(obstacle, HEAD_RANK)) {
          const pusher = {
            path: head,
            halfWidth,
            asker,
            rank: HEAD_RANK,
            companions: ctx.companions
          }
          if (!this.displace(ctxPush, obstacle, pusher, worklist)) return { kind: 'fail' }
          continue
        }
        // A via stands where it is placed: what it cannot push refuses it.
        if (geom.kind === 'via') return { kind: 'fail' }
        const times = (walks.get(obstacle.id) ?? 0) + 1
        if (times > REWALK_LIMIT) return { kind: 'fail' }
        walks.set(obstacle.id, times)
        const hulls = world.hullsOf(obstacle, clearance, halfWidth, ctx.cornerMode, asker)
        work.spent += 2 * head.length * hulls.length
        const bent = walkObstacle(world, head, hulls, clusterSide(hulls, obstacle.id, walked))
        if (!bent || !samePt(bent.path[0], head[0])) return { kind: 'fail' }
        walked.set(obstacle.id, { side: bent.side, hulls })
        head = bent.path
        if (!ctx.keepEnd && pathLength(head) > headLimit) return { kind: 'fail' }
        placeHead()
        ctxPush.head = { shapes: headShapes(), asker }
        continue
      }

      const entry = worklist.pop()
      if (!entry) {
        // A head that did not get where it was going is not a push: the caller
        // walks it, aimed out of what it could not push (R11).
        const end = initialHead[initialHead.length - 1]
        if (!samePt(head[head.length - 1], end)) return { kind: 'fail' }
        return { kind: 'ok', world, head, walked: [...walked.keys()] }
      }
      if (entry.ids.some((id) => !world.has(id))) continue // superseded by a later push
      const q: ObstacleQuery = { layer: entry.layer, excludeNet: entry.net, kind: entry.kind }
      work.spent += entry.path.length
      const hit = world.firstObstacle(entry.path, entry.halfWidth, clearance, q)
      if (!hit) continue
      if (movable(hit, entry.rank)) {
        // What it pushes keeps clear of the vias its ends stand on too: one
        // piece of copper with it.
        const pusher = {
          path: entry.path,
          halfWidth: entry.halfWidth,
          asker: q,
          rank: entry.rank,
          companions: entry.kind === 'track' ? viasAtEnds(world, entry) : undefined
        }
        if (!this.displace(ctxPush, hit, pusher, worklist)) return { kind: 'fail' }
        worklist.push(entry)
        continue
      }
      // Something it may not push: a displaced via cannot step aside twice,
      // and a track reflects the push back to the head (P10) — unless it may
      // jump over, when it walks on round it, keeping its ends.
      if (
        !this.options.jumpOverObstacles ||
        entry.path.length < 2 ||
        samePt(entry.path[0], entry.path[entry.path.length - 1])
      ) {
        return { kind: 'fail' }
      }
      const rewalked = walkKeepingEnds(
        world,
        entry.path,
        hit,
        entry.halfWidth,
        clearance,
        q,
        ctx.cornerMode,
        (o) => !movable(o, entry.rank)
      )
      if (!rewalked) return { kind: 'fail' }
      for (const id of entry.ids) world.remove(id)
      const ids = addLine(
        world,
        rank,
        rewalked,
        entry.halfWidth * 2,
        entry.layer,
        entry.net,
        entry.rank
      )
      worklist.push({ ...entry, path: rewalked, ids })
    }
    return { kind: 'fail' }
  }

  private displace(
    ctx: PushContext,
    obstacle: CopperItem,
    pusher: Pusher,
    worklist: Entry[]
  ): boolean {
    return obstacle.ref.type === 'via'
      ? displaceVia(ctx, obstacle, pusher, worklist)
      : displaceLine(ctx, obstacle, pusher, worklist)
  }
}

/** What presses on the copper being pushed: the head, or copper it pushed. */
interface Pusher {
  path: readonly Pt[]
  halfWidth: number
  /** Its net and kind, on the layer it presses on: what the rules ask of the gap. */
  asker: ClearanceAsker
  rank: number
  /** Copper moving with it, which what it pushes goes round as well. */
  companions?: CopperShape[]
}

interface PushContext {
  /** Work done so far this attempt, in segment-steps (see WORK_BUDGET). */
  work: { spent: number }
  world: RouterWorld
  rank: Map<number, number>
  clearance: number
  /** The head's layer. */
  layer: string
  cornerMode: RouteCornerMode
  movable: (item: CopperItem, pusherRank: number) => boolean
  /** The head as it stands, with what moves with it: no smoothed push may come nearer it than clearance. */
  head: { shapes: CopperShape[]; asker: ClearanceAsker }
  /** Pushed copper may go on round what cannot move (P10). */
  jumpOver: boolean
}

const octilinear = (a: Pt, b: Pt): boolean => {
  const dx = Math.abs(b.x - a.x)
  const dy = Math.abs(b.y - a.y)
  const tol = 1e-9 * Math.max(dx, dy, 1)
  return dx <= tol || dy <= tol || Math.abs(dx - dy) <= tol
}

const capsulesOf = (path: readonly Pt[], halfWidth: number): CopperShape[] => {
  const out: CopperShape[] = []
  for (let i = 0; i < path.length - 1; i++) {
    out.push({
      kind: 'capsule',
      x0: path[i].x,
      y0: path[i].y,
      x1: path[i + 1].x,
      y1: path[i + 1].y,
      halfWidth
    })
  }
  if (path.length === 1) {
    out.push({
      kind: 'capsule',
      x0: path[0].x,
      y0: path[0].y,
      x1: path[0].x,
      y1: path[0].y,
      halfWidth
    })
  }
  return out
}

/** Whether a path of `halfWidth` keeps `need` clear of every pusher shape. */
const clearOf = (path: readonly Pt[], shapes: readonly CopperShape[], need: number): boolean => {
  for (let i = 0; i < Math.max(1, path.length - 1); i++) {
    const a = path[i]
    const b = path[Math.min(i + 1, path.length - 1)]
    for (const shape of shapes) {
      if (segmentToShape(shape, a.x, a.y, b.x, b.y, 0) < need - ROUTER_EPSILON) return false
    }
  }
  return true
}

/** Push a track's line aside: the shortest walk round the pusher that keeps its ends. */
function displaceLine(
  ctx: PushContext,
  obstacle: CopperItem,
  pusher: Pusher,
  worklist: Entry[]
): boolean {
  const { world } = ctx
  const { path: pusherPath, halfWidth: pusherHalfWidth, rank: pusherRank } = pusher
  const gap = world.clearanceFor(obstacle, ctx.clearance, pusher.asker)
  const line = assembleLine(world, obstacle, { arcs: true })
  if (line.path.length < 2) return false
  const obsHalfWidth = line.width / 2
  const lineMode: RouteCornerMode = ctx.cornerMode === 'free' ? 'free' : '45'

  const pusherSegs = pusherPath.length >= 2 ? pusherPath : [pusherPath[0], pusherPath[0]]
  const reach = pusherHalfWidth + gap + obsHalfWidth
  const segmentHulls = new Map<number, Hull>()
  const companionHulls: Hull[] = []
  for (const shape of pusher.companions ?? []) {
    for (const hull of shapeHulls(shape, gap, obsHalfWidth, lineMode))
      companionHulls.push(pushedHull(hull, lineMode))
  }
  // Only the pusher's segments that can reach the line as it now lies bend
  // it; the rest would cost a walk each and change nothing. Asked again each
  // pass, since a line bent round one segment can come within reach of the
  // next.
  const hullsReaching = (path: readonly Pt[]): Hull[] => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of path) {
      minX = Math.min(minX, p.x - reach)
      minY = Math.min(minY, p.y - reach)
      maxX = Math.max(maxX, p.x + reach)
      maxY = Math.max(maxY, p.y + reach)
    }
    const hulls: Hull[] = []
    for (let i = 0; i < pusherSegs.length - 1; i++) {
      const a = pusherSegs[i]
      const b = pusherSegs[i + 1]
      if (
        Math.max(a.x, b.x) < minX ||
        Math.min(a.x, b.x) > maxX ||
        Math.max(a.y, b.y) < minY ||
        Math.min(a.y, b.y) > maxY
      )
        continue
      let hull = segmentHulls.get(i)
      if (!hull) {
        // A pusher segment at another angle (a pushed line keeps its own
        // slant) is walked round by its own outline, as KiCad's segment hull
        // is: bounded to 45° it would be a box over its whole run, reaching
        // copper the segment never comes near (P3, the fan of slanted tracks).
        const own = segmentHull(a, b, reach)
        hull = octilinear(a, b) ? pushedHull(own, lineMode) : own
        segmentHulls.set(i, hull)
      }
      hulls.push(hull)
    }
    return [...hulls, ...companionHulls]
  }
  const pusherShapes = [...capsulesOf(pusherPath, pusherHalfWidth), ...(pusher.companions ?? [])]
  const newRank = pusherRank - 1

  // What the line was: its unchanged segments were legal and need no check.
  const original = new Set<string>()
  for (let i = 0; i < line.path.length - 1; i++)
    original.add(segKey(line.path[i], line.path[i + 1]))
  let best: Pt[] | null = null
  let candidateWorld: RouterWorld | null = null
  // Every way round the pusher that keeps the line's ends, shortest first:
  // the first one that is also legal is the push (P2).
  const candidates: Pt[][] = []
  for (const reverse of [false, true]) {
    for (const cw of [true, false]) {
      // Walking round one of the pusher's outlines can carry the line back
      // into another where they meet at a bend: go round them all again
      // until a pass changes nothing.
      let path: Pt[] | null = [...line.path]
      for (let pass = 0; pass < HULL_PASSES && path; pass++) {
        const before: Pt[] = path
        const hulls = hullsReaching(path)
        for (const hull of reverse ? [...hulls].reverse() : hulls) {
          ctx.work.spent += path.length
          path = walkPathAroundHull(path, hull, cw)
          if (!path) break
        }
        if (path) path = tidyPath(path)
        if (path && samePath(path, before)) break
      }
      if (!path || path.length < 2) continue
      const endsHeld =
        samePt(path[0], line.path[0]) &&
        samePt(path[path.length - 1], line.path[line.path.length - 1])
      if (endsHeld) candidates.push(path)
    }
  }
  candidates.sort((x, y) => pathLength(x) - pathLength(y))

  // With jump-over, a way round that only runs into what cannot move is kept
  // back: pushed that way, the line then walks on round what it meets, behind
  // it (P10). Without, it is no way round, and the push reflects to the head.
  let walkable: Pt[] | null = null
  for (const path of candidates) {
    if (best && samePath(path, best)) continue
    if (wrapsBehind(line.path, path, pusherPath[0])) continue
    if (!clearOf(path, pusherShapes, gap + obsHalfWidth)) continue
    candidateWorld ??= (() => {
      const w = world.branch()
      for (const id of line.ids) w.remove(id)
      return w
    })()
    // Clear of everything it may not push later on.
    let blocker: CopperItem | null = null
    for (let i = 0; i < path.length - 1 && !blocker; i++) {
      if (original.has(segKey(path[i], path[i + 1]))) continue
      ctx.work.spent++
      blocker = candidateWorld.firstObstacle([path[i], path[i + 1]], obsHalfWidth, ctx.clearance, {
        layer: line.layer,
        excludeNet: line.net,
        filter: (item) => !ctx.movable(item, newRank)
      })
    }
    if (!blocker) {
      best = path
      break
    }
    if (ctx.jumpOver && !walkable) walkable = path
  }
  best ??= walkable
  if (!best) return false
  const headGap = world.clearanceFor(obstacle, ctx.clearance, ctx.head.asker)
  best = smoothPushed(
    ctx,
    candidateWorld ?? world,
    line,
    best,
    { shapes: pusherShapes, gap },
    headGap,
    (item) => !ctx.movable(item, newRank)
  )

  for (const id of line.ids) world.remove(id)
  const ids = addLine(
    world,
    ctx.rank,
    best,
    line.width,
    line.layer,
    line.net,
    newRank,
    keptArcs(line.path, line.arcs ?? [], best)
  )
  worklist.push({
    path: best,
    halfWidth: obsHalfWidth,
    net: line.net,
    kind: 'track',
    layer: line.layer,
    rank: newRank,
    ids
  })
  return true
}

/**
 * Whether a push would take a line round behind where its pusher starts —
 * the start of the route, which is pinned — rather than ahead of it: the
 * start lies between the line as it was and as it would be.
 */
function wrapsBehind(before: readonly Pt[], after: readonly Pt[], start: Pt): boolean {
  if (before.some((p) => samePt(p, start)) || after.some((p) => samePt(p, start))) return false
  const ring = [...before, ...[...after].reverse().slice(1, -1)]
  return ring.length >= 3 && pointInRing(start, ring)
}

/**
 * P2: the stretch of a pushed line that moved, smoothed as a walked route is
 * (optimize.ts): walked round the pusher it hugs every corner of the
 * pusher's outline, and smoothing leaves it the fewest, gentlest bends that
 * keep clearance — a 45° bulge round the head, not a box. Only the moved
 * stretch and the corner either side of it change; the rest of the line
 * keeps its geometry. It stays clear of the pusher and the head, and on the
 * same side of everything.
 */
function smoothPushed(
  ctx: PushContext,
  world: RouterWorld,
  line: { path: Pt[]; width: number; layer: string; net: number },
  pushed: Pt[],
  pusher: { shapes: readonly CopperShape[]; gap: number },
  headGap: number,
  /** What the line may not touch: what it pushes in turn, it may. */
  stays: (item: CopperItem) => boolean
): Pt[] {
  // A corner of the line as it was bounds the stretch: a bend from it leaves
  // along the segment it already had.
  let first = -1
  let last = -1
  pushed.forEach((p, i) => {
    if (line.path.some((q) => samePt(p, q))) return
    if (first < 0) first = i
    last = i
  })
  if (first < 0) return pushed
  const lo = Math.max(0, first - 1)
  const hi = Math.min(pushed.length - 1, last + 1)
  if (hi - lo < 2) return pushed
  const halfWidth = line.width / 2
  const q: ObstacleQuery = { layer: line.layer, excludeNet: line.net, filter: stays }
  const head = line.layer === ctx.head.asker.layer ? ctx.head.shapes : []
  const stretch = smoothPath(
    pushed.slice(lo, hi + 1),
    ctx.cornerMode === 'free' ? 'free' : '45',
    {
      collides: (run) => {
        ctx.work.spent += run.length
        return (
          world.pathViolates(run, halfWidth, ctx.clearance, q) ||
          !clearOf(run, pusher.shapes, pusher.gap + halfWidth) ||
          !clearOf(run, head, headGap + halfWidth)
        )
      },
      // Never to the other side of anything, what it may push included.
      crosses: (from, to) =>
        world.obstacleBetween(from, to, { ...q, filter: undefined }, [...pusher.shapes, ...head])
    },
    100,
    { before: pushed[lo - 1], after: pushed[hi + 1], holdEnds: true }
  )
  return tidyPath([...pushed.slice(0, lo), ...stretch, ...pushed.slice(hi + 1)])
}

/**
 * Push a via: it steps straight away from the pusher by what clearance
 * needs, and every track ending on it re-draws its last bend to follow (P7).
 * On every layer it spans, what the via and its tracks then meet is pushed
 * on in turn, as KiCad's shove pushes a via's fanout; what cannot move
 * refuses the push.
 */
function displaceVia(
  ctx: PushContext,
  via: CopperItem,
  pusher: Pusher,
  worklist: Entry[]
): boolean {
  const { world, clearance } = ctx
  const { path: pusherPath, halfWidth: pusherHalfWidth, rank: pusherRank } = pusher
  if (via.shape.kind !== 'circle') return false
  const r = via.shape.r
  const c = { x: via.shape.cx, y: via.shape.cy }
  const gap = world.clearanceFor(via, clearance, pusher.asker)
  const need = pusherHalfWidth + gap + r
  const segs = pusherPath.length >= 2 ? pusherPath : [pusherPath[0], pusherPath[0]]

  let at = { ...c }
  for (let k = 0; k < 8; k++) {
    let worst: { d: number; foot: Pt; i: number } | null = null
    for (let i = 0; i < segs.length - 1; i++) {
      const foot = closestOnSegment(at, segs[i], segs[i + 1])
      const d = Math.hypot(at.x - foot.x, at.y - foot.y)
      if (d < need - ROUTER_EPSILON && (!worst || d < worst.d)) worst = { d, foot, i }
    }
    if (!worst) break
    let dx = at.x - worst.foot.x
    let dy = at.y - worst.foot.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) {
      // Dead on the pusher's centerline: step to the side the via started on.
      const a = segs[worst.i]
      const b = segs[worst.i + 1]
      const sx = -(b.y - a.y)
      const sy = b.x - a.x
      const sl = Math.hypot(sx, sy) || 1
      const sgn = (c.x - a.x) * sx + (c.y - a.y) * sy >= 0 ? 1 : -1
      dx = (sgn * sx) / sl
      dy = (sgn * sy) / sl
    } else {
      dx /= len
      dy /= len
    }
    at = { x: worst.foot.x + dx * (need + 1e-4), y: worst.foot.y + dy * (need + 1e-4) }
  }
  if (!clearOf([at, at], capsulesOf(pusherPath, pusherHalfWidth), gap + r)) return false

  // Tracks of the via's net ending on it, on any layer.
  const attached = world
    .itemsNear(c, r)
    .filter(
      (item) =>
        item.ref.type === 'segment' &&
        item.shape.kind === 'capsule' &&
        item.net === via.net &&
        (samePt({ x: item.shape.x0, y: item.shape.y0 }, c) ||
          samePt({ x: item.shape.x1, y: item.shape.y1 }, c))
    )
  const newRank = pusherRank - 1
  const redrawn: Array<{ ids: number[]; path: Pt[]; width: number; layer: string }> = []
  const seen = new Set<number>()
  for (const seg of attached) {
    if (seen.has(seg.id)) continue
    if (ctx.movable(seg, pusherRank) === false) return false
    const line = assembleLine(world, seg)
    line.ids.forEach((id) => seen.add(id))
    const path = samePt(line.path[line.path.length - 1], c)
      ? [...line.path]
      : [...line.path].reverse()
    redrawn.push({ ids: line.ids, path: followEnd(path, at), width: line.width, layer: line.layer })
  }

  const moved = overlayVia(at, r, via.layers, via.net, via.ref.index)
  const candidate = world.branch()
  candidate.remove(via.id)
  for (const line of redrawn) for (const id of line.ids) candidate.remove(id)
  // What can be pushed gets its turn on the worklist; what cannot refuses.
  const settlesLater = (item: CopperItem): boolean => ctx.movable(item, newRank)
  for (const layer of via.layers) {
    const hit = candidate.firstObstacle([at, at], r, clearance, {
      layer,
      excludeNet: via.net,
      kind: 'via',
      filter: (item) => !settlesLater(item)
    })
    if (hit) return false
  }
  for (const line of redrawn) {
    const hit = candidate.firstObstacle(line.path, line.width / 2, clearance, {
      layer: line.layer,
      excludeNet: via.net,
      filter: (item) => !settlesLater(item)
    })
    if (hit) return false
  }
  // Holes never move, and copper at clearance can still leave this one's hole
  // too near another (R24): then it is not pushed at all.
  const holes = candidate.viaHoleConflicts({
    at,
    drill: world.bounds().viaDrill(via.ref.index),
    net: via.net,
    layers: via.layers
  })
  if (holes.length > 0) return false

  world.remove(via.id)
  world.add(moved)
  ctx.rank.set(moved.id, newRank)
  // On each layer it spans, the moved via settles what it now presses on.
  for (const layer of via.layers)
    worklist.push({
      path: [at, at],
      halfWidth: r,
      net: via.net,
      kind: 'via',
      layer,
      rank: newRank,
      ids: [moved.id]
    })
  for (const line of redrawn) {
    for (const id of line.ids) world.remove(id)
    const ids = addLine(world, ctx.rank, line.path, line.width, line.layer, via.net, newRank)
    worklist.push({
      path: line.path,
      halfWidth: line.width / 2,
      net: via.net,
      kind: 'track',
      layer: line.layer,
      rank: newRank,
      ids
    })
  }
  return true
}

/**
 * Move a line's last point to `to`, re-drawing only its last bend: the last
 * pinned corner stays, and the bend to the new end keeps the direction it
 * left that corner in when it can.
 */
export function followEnd(path: readonly Pt[], to: Pt, cornerMode: RouteCornerMode = '45'): Pt[] {
  if (path.length < 2) return [{ ...to }]
  if (cornerMode === 'free') return tidyPath([...path.slice(0, -1), { ...to }])
  const from = path.length >= 3 ? path[path.length - 3] : path[0]
  const keep = path.length >= 3 ? path.slice(0, path.length - 2) : [path[0]]
  const oldDir = path.length >= 3 ? dirOf(from, path[path.length - 2]) : null
  let best: Pt[] | null = null
  for (const diagFirst of [true, false]) {
    const bend = routeElbow(cornerMode, diagFirst, from, to)
    if (oldDir && samePt(dirOf(from, bend[0]), oldDir)) {
      best = bend
      break
    }
    best ??= bend
  }
  return tidyPath([...keep, ...(best ?? [{ ...to }])])
}

const dirOf = (a: Pt, b: Pt): Pt => {
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return {
    x: Math.round(((b.x - a.x) / l) * 1e4) / 1e4,
    y: Math.round(((b.y - a.y) / l) * 1e4) / 1e4
  }
}

/**
 * Walk a displaced line round an item it may not push, keeping both ends: the
 * shorter side that runs into nothing else it may not push, else the shorter.
 */
function walkKeepingEnds(
  world: RouterWorld,
  path: readonly Pt[],
  item: CopperItem,
  halfWidth: number,
  clearance: number,
  asker: ObstacleQuery,
  cornerMode: RouteCornerMode,
  fixed: (item: CopperItem) => boolean
): Pt[] | null {
  const mode = cornerMode === 'free' ? 'free' : '45'
  const hulls = world.hullsOf(item, clearance, halfWidth, mode, asker)
  const ways: Pt[][] = []
  for (const cw of [true, false]) {
    const bent = walkObstacle(world, path, hulls, cw, true)?.path
    if (!bent || !samePt(bent[0], path[0]) || !samePt(bent[bent.length - 1], path[path.length - 1]))
      continue
    ways.push(tidyPath(bent))
  }
  ways.sort((a, b) => pathLength(a) - pathLength(b))
  const blocked = (way: Pt[]): boolean =>
    world.pathViolates(way, halfWidth, clearance, {
      ...asker,
      filter: (o) => o.id !== item.id && fixed(o)
    })
  return ways.find((way) => !blocked(way)) ?? ways[0] ?? null
}

/** The shapes, on the entry's layer, of vias of its net that its line ends on. */
function viasAtEnds(world: RouterWorld, entry: Entry): CopperShape[] {
  const out: CopperShape[] = []
  for (const end of [entry.path[0], entry.path[entry.path.length - 1]])
    for (const item of world.itemsNear(end, 1e-6, entry.layer))
      if (
        item.ref.type === 'via' &&
        item.net === entry.net &&
        item.shape.kind === 'circle' &&
        samePt({ x: item.shape.cx, y: item.shape.cy }, end)
      )
        out.push(shapeOn(item, entry.layer))
  return out
}

/**
 * P11: the arcs of a pushed line that kept their shape — their chords still
 * in its new path, one after another — as where they now run in it.
 */
function keptArcs(
  before: readonly Pt[],
  arcs: readonly LineArc[],
  after: readonly Pt[]
): Array<{ from: number; to: number; mid: Pt }> {
  const out: Array<{ from: number; to: number; mid: Pt }> = []
  for (const arc of arcs) {
    const chords = before.slice(arc.from, arc.to + 1)
    const k = after.findIndex((p) => samePt(p, chords[0]))
    if (k < 0 || k + chords.length > after.length) continue
    if (chords.every((p, i) => samePt(p, after[k + i])))
      out.push({ from: k, to: k + chords.length - 1, mid: arc.mid })
  }
  return out
}

function addLine(
  world: RouterWorld,
  rank: Map<number, number>,
  path: readonly Pt[],
  width: number,
  layer: string,
  net: number,
  lineRank: number,
  /** Stretches of the path that are an arc's chords: added as the arc (P11). */
  arcs: ReadonlyArray<{ from: number; to: number; mid: Pt }> = []
): number[] {
  const ids: number[] = []
  for (let i = 0; i < path.length - 1; i++) {
    const arc = arcs.find((a) => a.from === i)
    const item = arc
      ? overlayArc(path.slice(arc.from, arc.to + 1), arc.mid, width, layer, net)
      : overlaySegment(path[i], path[i + 1], width, layer, net)
    if (arc) i = arc.to - 1
    rank.set(item.id, lineRank)
    world.add(item)
    ids.push(item.id)
  }
  return ids
}

/** A track arc in a world's overlay, of no board index: from its first chord point to its last, through `mid`. */
function overlayArc(
  chords: readonly Pt[],
  mid: Pt,
  width: number,
  layer: string,
  net: number
): CopperItem {
  const halfWidth = width / 2
  const a = chords[0]
  const b = chords[chords.length - 1]
  return {
    id: nextOverlayId(),
    ref: { type: 'tarc', index: -1 },
    net,
    layers: [layer],
    shape: { kind: 'arc', x0: a.x, y0: a.y, mx: mid.x, my: mid.y, x1: b.x, y1: b.y, halfWidth },
    minX: Math.min(...chords.map((p) => p.x)) - halfWidth,
    minY: Math.min(...chords.map((p) => p.y)) - halfWidth,
    maxX: Math.max(...chords.map((p) => p.x)) + halfWidth,
    maxY: Math.max(...chords.map((p) => p.y)) + halfWidth
  }
}

/** A track segment in a world's overlay, of no board index. */
export function overlaySegment(
  a: Pt,
  b: Pt,
  width: number,
  layer: string,
  net: number
): CopperItem {
  const halfWidth = width / 2
  return {
    id: nextOverlayId(),
    ref: { type: 'segment', index: -1 },
    net,
    layers: [layer],
    shape: { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth },
    minX: Math.min(a.x, b.x) - halfWidth,
    minY: Math.min(a.y, b.y) - halfWidth,
    maxX: Math.max(a.x, b.x) + halfWidth,
    maxY: Math.max(a.y, b.y) + halfWidth
  }
}

/** A via in the overlay; `index` keeps a moved base via's board index (−1 for new). */
function overlayVia(
  at: Pt,
  r: number,
  layers: readonly string[],
  net: number,
  index: number
): CopperItem {
  return {
    id: nextOverlayId(),
    ref: { type: 'via', index },
    net,
    layers,
    shape: { kind: 'circle', cx: at.x, cy: at.y, r },
    minX: at.x - r,
    minY: at.y - r,
    maxX: at.x + r,
    maxY: at.y + r
  }
}

const segKey = (a: Pt, b: Pt): string => `${a.x},${a.y},${b.x},${b.y}`

const samePath = (a: readonly Pt[], b: readonly Pt[]): boolean =>
  a.length === b.length && a.every((p, i) => samePt(p, b[i]))

function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return { ...a }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return { x: a.x + t * dx, y: a.y + t * dy }
}
