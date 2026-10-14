/**
 * The router's entry point: what the head should look like for a cursor
 * position (docs/router-behavior.md). One `RouteSession` lives while a trace
 * is drawn; the preview and the click both ask it, so they cannot disagree
 * (R18) — a click with the cursor the preview last saw gets that very
 * proposal back.
 *
 * The session carries from one frame to the next only what KiCad's does: no
 * side round anything (R8), but
 *
 * - the posture the mouse set when it left the last click (R4);
 * - the pushes of each committed click (shove.ts).
 *
 * `proposeRoute` is the stateless form, for callers with no frame before:
 * tests, the replay runner.
 */

import {
  polyShape,
  segmentToShape,
  shapeOn,
  type CopperItem,
  type CopperShape,
  type Pt
} from '../spatialIndex'
import type { Region } from '../../geometry/polygon'
import { routeElbow, type RouteCornerMode } from '../pcbTools'
import {
  isSolid,
  type RouterWorld,
  type ObstacleQuery,
  type ClearanceAsker,
  type HoleConflict,
  type ViaHole
} from './world'
import { convexOutline, shapeHulls, ROUTER_EPSILON } from './hulls'
import { walkAround, type Side } from './walkaround'
import { cornerCost, smoothPath } from './optimize'
import { padExit, padExits } from './padExit'
import { arcPolyline, pathLength, pointInRing, samePt, tidyPath } from './geometry'
import {
  ShoveSession,
  type DisplacedPreview,
  type PendingCopper,
  type ShoveDelta,
  type ShoveOptions
} from './shove'

export type RouteMode = 'highlight' | 'walkaround' | 'shove'

/**
 * Something a proposal violates, as the scene shows it (F2): copper lit over
 * the halo its clearance draws round it, or a hole's halo, or an area's
 * outline (a keepout, the board edge). Scene mm, y up.
 */
export interface ViolationMark {
  shape: CopperShape
  /** The copper layer it is met on: its color lights it. */
  layer: string
  /** How far the route must keep off it, drawn as a halo round it; 0 for an area. */
  clearance: number
  /** How far the route keeps off it, edge to edge, where measured; 0 where they touch. */
  actual?: number
  /** Board copper, lit; false for a hole or an area, which show their halo or outline alone. */
  copper: boolean
  /** The board item's handle into the index (`CopperItem.id`): its copper, or the pad or via whose hole it is. */
  id?: number
}

export interface RouteRequest {
  mode: RouteMode
  tail: Pt
  cursor: Pt
  cornerMode: RouteCornerMode
  /** The head's corners are rounded into tangent arcs (KiCad's Arc 45 / Arc 90, R3). */
  rounded?: boolean
  /**
   * The posture: diagonal (in 90° mode, horizontal) leg first. With
   * `autoPosture` it is instead a flip of the posture the mouse set.
   */
  diagFirst: boolean
  /** Take the posture from how the mouse left the tail (R4). */
  autoPosture?: boolean
  /**
   * The posture was forced with `/` (R4) since the last click: pad exits are
   * not fitted (R38), as KiCad turns smart pads off once the posture is
   * flipped by hand.
   */
  postureForced?: boolean
  layer: string
  width: number
  clearance: number
  net: number
  /**
   * A second net that is the route's own too: a differential pair's other
   * half, whose copper the pair's centerline passes as its own (PR1).
   */
  alsoNet?: number
  /**
   * The narrowest legal size on the net's list: when the head is blocked, the
   * proposal says whether that would get through (K1). Never laid on its own.
   */
  narrowestWidth?: number
  /**
   * An armed via (R24): it lands where the head ends, on every layer it
   * spans, and the proposal is judged with it — its hole too, given a drill.
   */
  via?: { size: number; drill?: number; layers: readonly string[] }
}

export interface ProposedSegment {
  x0: number
  y0: number
  x1: number
  y1: number
  /** An arc from its start to its end through this point, where a corner was rounded (R3). */
  mid?: Pt
  violation: boolean
}

/** What the router is doing with the head, for the keys the hint teaches (K1). */
export type RouteState = 'clear' | 'walking' | 'pushing' | 'blocked' | 'violating'

export interface RouteProposal {
  segments: ProposedSegment[]
  /** Where the trace's tail lands if this proposal is committed. */
  endsAt: Pt
  /** True when the geometry bends away from the plain elbow. */
  walked: boolean
  /** True when any proposed segment still violates clearance. */
  blocked: boolean
  state: RouteState
  /** The posture the head was drawn in. */
  diagFirst: boolean
  /** Other-net copper the proposal violates (F2), as base refs. */
  violators: Array<{ type: string; index: number }>
  /** The same copper as handles into the world's index (`CopperItem.id`), nearest first where it can tell. */
  violatorIds: number[]
  /** What the head goes round or stops at nearest its end, as a handle into the index (S11). */
  huggingId?: number
  /** What the proposal violates, to show (F2). */
  marks: ViolationMark[]
  /** Blocked, and the narrowest legal size does not get through either (K1). */
  narrowerFails?: boolean
  /** The armed via where the head ends, and whether it breaks clearance or a keepout there (R24, R16). */
  via?: { at: Pt; violation: boolean }
}

/**
 * R39: a way round no longer than this multiple of the plain bend is taken
 * whole. A longer one is not where the person is heading: the head follows
 * it only as far as `HUG_REACH` times the bend, and stops there at its point
 * nearest the cursor — at the obstacle, short of going round it. KiCad's
 * figures: its walkaround hug threshold (1.5), the whole way round below twice that.
 */
const DETOUR_LIMIT = 3
const HUG_REACH = 1.5
/** Past this multiple a walk gives up: no way round worth showing, and the head is blocked (R14). */
const WALK_LENGTH_LIMIT = 10

/** R4: within this many track widths of the tail (at least 0.3 mm) the posture is not read yet. */
const POSTURE_NEAR = 3
/** ...and past this many (at least 3 mm) it is settled, so a far cursor does not flutter it. */
const POSTURE_SETTLE = 25
/** One bend is the mouse's once its trail keeps this much nearer it than the other. */
const TRAIL_MARGIN = 0.7

/**
 * The direction the route arrives at its tail along its last clicked segment,
 * or null where there is none to keep to: no segment yet, or a via there,
 * after which the route goes on on another layer.
 */
function inboundAt(tail: Pt, pending: PendingCopper): Pt | null {
  if (pending.vias.some((v) => samePt(v, tail))) return null
  const last = pending.segments[pending.segments.length - 1]
  if (!last || !samePt({ x: last.x1, y: last.y1 }, tail)) return null
  const dx = last.x1 - last.x0
  const dy = last.y1 - last.y0
  const len = Math.hypot(dx, dy)
  return len > 0 ? { x: dx / len, y: dy / len } : null
}

/** A head walked round what it meets: R7's choice of the two windings. */
interface HeadWalk {
  path: Pt[]
  /** What it went round. */
  walked: number[]
  /** It gets to where it was going. */
  reached: boolean
  /** It stops short, hugging the way round (R39). */
  hugged: boolean
}

/** How a route session routes, besides how it pushes; read live, as `ShoveOptions` are. */
export interface RouteOptions extends ShoveOptions {
  /** Routes leave and enter pads by their exits (R38); off, any bend leaves them. Default on. */
  smartPads?: boolean
  /** The posture follows the mouse (R4). Default on. */
  autoPosture?: boolean
  /** Without auto posture, the posture `/` flips: the diagonal first. Default off. */
  startDiagonal?: boolean
}

/** What a request's own copper is not: the obstacles' query for its net (and a pair's other half). */
export function ownQuery(req: Pick<RouteRequest, 'layer' | 'net' | 'alsoNet'>): ObstacleQuery {
  const also = req.alsoNet
  return {
    layer: req.layer,
    excludeNet: req.net,
    ...(also !== undefined ? { filter: (item: CopperItem) => item.net !== also } : {})
  }
}

export function proposeRoute(world: RouterWorld, req: RouteRequest): RouteProposal {
  return new RouteSession(world).propose(req)
}

export class RouteSession {
  readonly shove: ShoveSession
  private posture: {
    tail: Pt
    /** Where the cursor has been since it left the tail. */
    trail: Pt[]
    diagFirst: boolean | null
    settled: boolean
  } | null = null
  private last: { key: string; proposal: RouteProposal } | null = null
  /** The direction each pad was last left or entered by, held while it stays near enough (R38). */
  private exits = new Map<number, number>()
  private readonly options: RouteOptions

  constructor(
    readonly world: RouterWorld,
    options: RouteOptions = {}
  ) {
    this.options = options
    this.shove = new ShoveSession(world, options)
  }

  /** Esc: forget everything, pushes included. */
  reset(): void {
    this.shove.reset()
    this.posture = null
    this.last = null
    this.exits.clear()
  }

  /** A click landed: its pushes stay, and the next head starts fresh. */
  markClick(): void {
    this.shove.markClick()
    this.last = null
  }

  /** The armed via landed after the click (R24): what it pushed lands as a step of its own. */
  markVia(): void {
    this.shove.markVia()
    this.last = null
  }

  /** Backspace: the last click's pushes spring back. */
  undoClick(): void {
    this.shove.undoClick()
    this.last = null
  }

  /** The head in progress will not land (a finish, a via): its pushes spring back. */
  dropHead(): void {
    this.shove.dropHead()
    this.last = null
  }

  /** Fold the last `n` clicks into one (a finish that took several rounds). */
  mergeClicks(n: number): void {
    this.shove.mergeClicks(n)
  }

  displaced(): DisplacedPreview {
    return this.shove.displaced()
  }

  delta(): ShoveDelta {
    return this.shove.delta()
  }

  propose(req: RouteRequest, pending: PendingCopper = { segments: [], vias: [] }): RouteProposal {
    const key = JSON.stringify([req, pending.segments.length, pending.vias.length])
    if (this.last?.key === key) return this.last.proposal

    const diagFirst = this.postureFor(req, inboundAt(req.tail, pending))
    let proposal = this.solve(req, diagFirst, pending)
    const narrowest = req.narrowestWidth
    if (proposal.state === 'blocked' && narrowest !== undefined && narrowest < req.width - 1e-9) {
      if (this.narrowerFails(req, narrowest, diagFirst, pending))
        proposal = { ...proposal, narrowerFails: true }
    }
    if (req.via) proposal = this.withVia(req, req.via, proposal, pending, diagFirst)
    if (req.rounded && req.cornerMode !== 'free') proposal = this.rounded(req, proposal)
    this.last = { key, proposal }
    return proposal
  }

  /**
   * R24: the via lands where the head ends. Push pushes what it hits on every
   * layer it spans. Avoid — and Push where nothing more can move — puts no
   * violating via on screen (R14): the via goes to the legal spot nearest
   * the cursor, the head walked to it (as R11 aims a head out of an
   * obstacle), or else back along the head to the last place it fits.
   * Highlight marks it where it is, and lands it only with DRC violations allowed.
   */
  private withVia(
    req: RouteRequest,
    via: NonNullable<RouteRequest['via']>,
    proposal: RouteProposal,
    pending: PendingCopper,
    diagFirst: boolean
  ): RouteProposal {
    const at = proposal.endsAt
    if (
      req.mode === 'shove' &&
      !proposal.blocked &&
      this.world.viaKeepoutsAt(at, via.size / 2, via.layers).length === 0
    ) {
      const head = proposal.segments.map((s) => ({
        ...s,
        width: req.width,
        layer: req.layer
      }))
      const landed = this.shove.proposeVia(
        at,
        via.size,
        via.layers,
        { clearance: req.clearance, net: req.net },
        { segments: [...pending.segments, ...head], vias: pending.vias },
        req.cornerMode
      )
      // Holes do not move: copper the via pushed is judged where it went.
      if (
        landed &&
        this.holeConflicts(this.shove.currentWorld(), at, req, via, pending).length === 0
      )
        return { ...proposal, via: { at, violation: false } }
      this.shove.dropVia()
    }
    if (req.mode !== 'highlight') {
      const placed = this.placeVia(req, via, proposal, pending, diagFirst)
      if (placed) return placed
    }
    return this.refuseVia(req, via, proposal, pending)
  }

  /**
   * R3's rounded modes: each corner of the head becomes a tangent arc, as
   * large as the legs either side allow — a leg between two corners shared
   * between them, an end leg whole — so the bend from the tail is a straight
   * run and one arc, as KiCad's Arc 45 and Arc 90 draw it. An arc that would
   * break clearance is tried at half and a quarter of that, else the corner
   * stays sharp. Never the corner a pad exit makes (R38).
   */
  private rounded(req: RouteRequest, proposal: RouteProposal): RouteProposal {
    if (proposal.segments.length < 2 || proposal.blocked) return proposal
    const path = pointsOfSegments(proposal.segments)
    const world = proposal.state === 'pushing' ? this.shove.currentWorld() : this.shove.floor()
    const q = ownQuery(req)
    const halfWidth = req.width / 2
    // Only where exits are fitted does a pad's first corner belong to one.
    const exits = this.smartPads(req)
    const exitCorner = exits && this.padAt(req, path[0]) ? 1 : -1
    const entryCorner = exits && this.padAt(req, path[path.length - 1]) ? path.length - 2 : -1
    type Piece = { a: Pt; b: Pt; mid?: Pt }
    // Where each segment's straight part starts and ends once its corners are rounded.
    const starts = path.slice(0, -1).map((p) => ({ ...p }))
    const ends = path.slice(1).map((p) => ({ ...p }))
    const arcs: Array<{ at: number; a: Pt; mid: Pt; b: Pt } | null> = path.map(() => null)
    for (let i = 1; i < path.length - 1; i++) {
      if (i === exitCorner || i === entryCorner) continue
      const p = path[i]
      const u = unitOf(path[i - 1], p)
      const v = unitOf(p, path[i + 1])
      const cos = u.x * v.x + u.y * v.y
      if (cos > 1 - 1e-9 || cos < -1 + 1e-6) continue
      const lenIn = Math.hypot(p.x - starts[i - 1].x, p.y - starts[i - 1].y)
      const lenOut = Math.hypot(path[i + 1].x - p.x, path[i + 1].y - p.y)
      const share = (len: number, shared: boolean): number => (shared ? len / 2 : len)
      let t = Math.min(lenIn, share(lenOut, i + 1 < path.length - 1))
      const theta = Math.acos(Math.max(-1, Math.min(1, cos)))
      for (let tries = 0; tries < 3 && t > 1e-4; tries++, t /= 2) {
        const a = { x: p.x - u.x * t, y: p.y - u.y * t }
        const b = { x: p.x + v.x * t, y: p.y + v.y * t }
        const mid = filletMid(a, p, u, v, t, theta)
        if (world.pathViolates(arcPolyline(a, mid, b), halfWidth, req.clearance, q)) continue
        arcs[i] = { at: i, a, mid, b }
        ends[i - 1] = a
        starts[i] = b
        break
      }
    }
    if (arcs.every((arc) => arc === null)) return proposal
    const pieces: Piece[] = []
    for (let i = 0; i < path.length - 1; i++) {
      const arc = arcs[i]
      if (arc) pieces.push({ a: arc.a, b: arc.b, mid: arc.mid })
      if (Math.hypot(ends[i].x - starts[i].x, ends[i].y - starts[i].y) > 1e-6)
        pieces.push({ a: starts[i], b: ends[i] })
    }
    return {
      ...proposal,
      segments: pieces.map((piece) => ({
        x0: piece.a.x,
        y0: piece.a.y,
        x1: piece.b.x,
        y1: piece.b.y,
        ...(piece.mid ? { mid: piece.mid } : {}),
        violation: false
      }))
    }
  }

  /** Avoid's via: where it fits nearest the cursor, the head walked there; null when nowhere on the head will do. */
  private placeVia(
    req: RouteRequest,
    via: NonNullable<RouteRequest['via']>,
    proposal: RouteProposal,
    pending: PendingCopper,
    diagFirst: boolean
  ): RouteProposal | null {
    const fits = (p: Pt): boolean => this.viaFits(p, req, via, pending)
    const landed = (p: RouteProposal): RouteProposal => ({
      ...p,
      via: { at: p.endsAt, violation: false }
    })
    if (!proposal.blocked && fits(proposal.endsAt)) return landed(proposal)
    let head = proposal
    const target = this.viaEscape(req.cursor, req, via, pending)
    if (!samePt(target, req.cursor)) {
      const walked = this.solve({ ...req, mode: 'walkaround', cursor: target }, diagFirst, pending)
      if (!walked.blocked) {
        if (fits(walked.endsAt)) return landed(walked)
        head = walked
      }
    }
    if (head.blocked) return null
    const back = backOff(head, fits, via.size / 4)
    return back ? landed(back) : null
  }

  /** Whether a via of the request's size stands clear at `p`: every layer it spans, its hole, keepouts, the board. */
  private viaFits(
    p: Pt,
    req: RouteRequest,
    via: NonNullable<RouteRequest['via']>,
    pending: PendingCopper
  ): boolean {
    const world = this.shove.currentWorld()
    const r = via.size / 2
    if (!world.onBoard(p) || this.world.viaKeepoutsAt(p, r, via.layers).length > 0) return false
    return (
      via.layers.every(
        (layer) =>
          world.collisions(p, p, r, req.clearance, { layer, excludeNet: req.net, kind: 'via' })
            .length === 0
      ) && this.holeConflicts(world, p, req, via, pending).length === 0
    )
  }

  /** What the via's hole at `at` comes too close to (R24); nothing without a drill. */
  private holeConflicts(
    world: RouterWorld,
    at: Pt,
    req: RouteRequest,
    via: NonNullable<RouteRequest['via']>,
    pending: PendingCopper
  ): HoleConflict[] {
    if (!via.drill) return []
    const others: ViaHole[] = pending.vias.map((v) => ({
      at: { x: v.x, y: v.y },
      drill: v.drill ?? via.drill ?? 0,
      net: req.net,
      layers: v.layers ?? via.layers
    }))
    return world.viaHoleConflicts(
      { at, drill: via.drill, net: req.net, layers: via.layers },
      others
    )
  }

  /** The point nearest `cursor` where a via stands clear, as `escape` finds one for the head. */
  private viaEscape(
    cursor: Pt,
    req: RouteRequest,
    via: NonNullable<RouteRequest['via']>,
    pending: PendingCopper
  ): Pt {
    return viaSpotNear(this.shove.currentWorld(), cursor, {
      radius: via.size / 2,
      clearance: req.clearance,
      net: req.net,
      layers: via.layers,
      holes: (at) => this.holeConflicts(this.shove.currentWorld(), at, req, via, pending),
      drill: via.drill
    })
  }

  /** A via that cannot land: marked where it is, and the click refused (Highlight; with DRC violations allowed it lands). */
  private refuseVia(
    req: RouteRequest,
    via: NonNullable<RouteRequest['via']>,
    proposal: RouteProposal,
    pending: PendingCopper
  ): RouteProposal {
    const at = proposal.endsAt
    const r = via.size / 2
    const keepouts = this.world.viaKeepoutsAt(at, r, via.layers)
    const judge = this.shove.currentWorld()
    const violators = new Map<number, CopperItem>()
    const marks: ViolationMark[] = []
    for (const layer of via.layers) {
      const asker: ObstacleQuery = { layer, excludeNet: req.net, kind: 'via' }
      const hits = judge.collisions(at, at, r, req.clearance, asker)
      const fresh = hits.filter((h) => !violators.has(h.item.id))
      for (const h of fresh) violators.set(h.item.id, h.item)
      const gaps = new Map(fresh.map((h) => [h.item.id, Math.max(0, h.dist - r)]))
      marks.push(
        ...clearanceMarks(
          judge,
          fresh.map((h) => h.item),
          req.clearance,
          asker,
          gaps
        )
      )
    }
    const holes = this.holeConflicts(judge, at, req, via, pending)
    for (const hole of holes) {
      if (hole.item) violators.set(hole.item.id, hole.item)
      marks.push(holeMark(hole, req.layer))
    }
    for (const region of keepouts) marks.push(areaMark(region, req.layer))
    const violation =
      violators.size > 0 || holes.length > 0 || keepouts.length > 0 || !judge.onBoard(at)
    if (!violation) return { ...proposal, via: { at, violation } }
    const named = [...violators.values()].filter((item) => item.ref.index >= 0)
    return {
      ...proposal,
      blocked: true,
      state: 'violating',
      violators: [
        ...proposal.violators,
        ...named.map((item) => ({ type: item.ref.type, index: item.ref.index }))
      ],
      violatorIds: [...proposal.violatorIds, ...named.map((item) => item.id)],
      marks: [...proposal.marks, ...marks],
      via: { at, violation }
    }
  }

  /** K1: whether the head, blocked, is blocked at `narrowest` too. */
  private narrowerFails(
    req: RouteRequest,
    narrowest: number,
    diagFirst: boolean,
    pending: PendingCopper
  ): boolean {
    const narrow = this.solve({ ...req, mode: 'walkaround', width: narrowest }, diagFirst, pending)
    return narrow.state !== 'clear' && narrow.state !== 'walking'
  }

  // -------------------------------------------------------------------------

  /**
   * R4: the posture follows the way the mouse went from the tail: of the two
   * bends to the cursor, the one its trail keeps nearer, once clearly nearer,
   * held otherwise. It is settled once the cursor is well clear of the tail
   * and unsettled when it comes back. Leaving a click, the head carries on
   * straight where one posture lets it, and turns the gentler way where the
   * mouse's would turn a right angle or sharper.
   */
  private postureFor(req: RouteRequest, inbound: Pt | null): boolean {
    if (!req.autoPosture || req.cornerMode === 'free') return req.diagFirst
    // Auto posture off: the posture the settings start from, `/` flipping it.
    if (this.options.autoPosture === false)
      return this.options.startDiagonal ? !req.diagFirst : req.diagFirst
    if (!this.posture || !samePt(this.posture.tail, req.tail)) {
      this.posture = { tail: { ...req.tail }, trail: [], diagFirst: null, settled: false }
    }
    const posture = this.posture
    const dx = req.cursor.x - req.tail.x
    const dy = req.cursor.y - req.tail.y
    const dist = Math.hypot(dx, dy)
    const fromDirection = (): boolean => {
      if (req.cornerMode === '90') return Math.abs(dx) >= Math.abs(dy)
      const a = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI
      return a >= 22.5 && a <= 67.5
    }
    const bend = (diag: boolean): Pt[] =>
      tidyPath([req.tail, ...routeElbow(req.cornerMode, diag, req.tail, req.cursor)])
    let auto: boolean
    if (dist < Math.max(req.width * POSTURE_NEAR, 0.3)) {
      posture.trail = []
      posture.diagFirst = null
      posture.settled = false
      auto = fromDirection()
    } else {
      if (!posture.settled) {
        const last = posture.trail[posture.trail.length - 1]
        if (!last || !samePt(last, req.cursor)) posture.trail.push({ ...req.cursor })
        const diag = trailOffset(posture.trail, bend(true))
        const straight = trailOffset(posture.trail, bend(false))
        if (diag < straight * TRAIL_MARGIN) posture.diagFirst = true
        else if (straight < diag * TRAIL_MARGIN) posture.diagFirst = false
        else posture.diagFirst ??= fromDirection()
        if (dist >= Math.max(req.width * POSTURE_SETTLE, 3)) posture.settled = true
      }
      auto = posture.diagFirst ?? fromDirection()
    }
    // Leaving a click: on straight, or the gentler turn.
    if (inbound) {
      const turn = (diag: boolean): number => {
        const path = bend(diag)
        if (path.length < 2) return 0
        const ux = path[1].x - path[0].x
        const uy = path[1].y - path[0].y
        const cos = (ux * inbound.x + uy * inbound.y) / (Math.hypot(ux, uy) || 1)
        return Math.acos(Math.max(-1, Math.min(1, cos)))
      }
      const mine = turn(auto)
      const other = turn(!auto)
      const straightOn = other < 1e-6 && mine > 1e-6
      if (straightOn || (mine > Math.PI / 2 - 1e-6 && other < mine - 1e-6)) auto = !auto
    }
    // `diagFirst` is the person's flip (`/`), default off.
    return req.diagFirst ? !auto : auto
  }

  private solve(req: RouteRequest, diagFirst: boolean, pending: PendingCopper): RouteProposal {
    const ignored = this.startingInside(req)
    const proposal = this.solveHead(req, diagFirst, pending, ignored)
    // What push mode can move, it pushed rather than passed through.
    const passed =
      req.mode === 'shove' && proposal.state === 'pushing'
        ? new Set([...ignored].filter((id) => !this.movable(this.world.base.items[id])))
        : ignored
    return passed.size > 0 && req.mode !== 'highlight'
      ? this.leaveStart(req, diagFirst, pending, proposal, passed)
      : proposal
  }

  /**
   * R2: the head was solved passing through what the tail starts inside. It
   * may do so only on its way out: past the point it first leaves their
   * clearance, they are obstacles like any other. A head that comes back to
   * one, or that leaves through its copper rather than away from it, is
   * solved again from where it gets out — the shortest way out, when the
   * head's own way went through the copper.
   */
  private leaveStart(
    req: RouteRequest,
    diagFirst: boolean,
    pending: PendingCopper,
    proposal: RouteProposal,
    ignored: ReadonlySet<number>
  ): RouteProposal {
    const path = proposal.segments.length > 0 ? pointsOfSegments(proposal.segments) : [req.tail]
    const halfWidth = req.width / 2
    const asker = ownQuery(req)
    const items = [...ignored]
      .map((id) => this.world.base.items[id])
      .filter((item): item is CopperItem => item !== undefined)
    const hulls = items.flatMap((item) =>
      this.world.hullsOf(item, req.clearance, halfWidth, req.cornerMode, asker)
    )
    const inside = (p: Pt): boolean => hulls.some((h) => pointInRing(p, h))
    const touches = (a: Pt, b: Pt): boolean =>
      items.some(
        (item) =>
          segmentToShape(shapeOn(item, req.layer), a.x, a.y, b.x, b.y, halfWidth) < ROUTER_EPSILON
      )
    // A tail already on their copper has no way out to find: it violates as it stands.
    if (touches(req.tail, req.tail)) return proposal

    // Where the head first gets out of every outline the tail starts in, along
    // its own way, unless that way goes through their copper first.
    let prefix: Pt[] | null = null
    let rest: Pt[] = []
    let through = false
    for (let i = 0; i < path.length - 1 && !prefix && !through; i++) {
      const a = path[i]
      const b = path[i + 1]
      if (inside(b)) {
        through = touches(a, b)
        continue
      }
      let lo = 0
      let hi = 1
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      while ((hi - lo) * len > 1e-5) {
        const mid = (lo + hi) / 2
        if (inside(lerp(a, b, mid))) lo = mid
        else hi = mid
      }
      const out = lerp(a, b, hi)
      through = touches(a, out)
      if (!through) {
        prefix = tidyPath([...path.slice(0, i + 1), out])
        rest = [out, ...path.slice(i + 1)]
      }
    }
    if (prefix) {
      // Out on its own way: nothing to do unless it comes back to them.
      const back = this.shove.currentWorld().pathViolates(rest, halfWidth, req.clearance, {
        ...asker,
        filter: (item) => ignored.has(item.id)
      })
      if (!back) return proposal
    } else if (through) {
      // Its own way out went through the copper: the shortest way out instead.
      let at = { ...req.tail }
      for (let round = 0; round < 6; round++) {
        const ring = hulls.find((h) => pointInRing(at, h))
        if (!ring) break
        at = outsideOf(ring, at, (p) => this.world.onBoard(p))
      }
      prefix = [{ ...req.tail }, at]
    } else {
      return proposal // still on its way out
    }
    const from = prefix[prefix.length - 1]

    // Solved again from where the head gets out, with nothing passed through;
    // the way out rides along as copper the head has laid (P6).
    const out: PendingCopper = {
      segments: [
        ...pending.segments,
        ...prefix.slice(1).map((p, i) => ({
          x0: prefix[i].x,
          y0: prefix[i].y,
          x1: p.x,
          y1: p.y,
          width: req.width,
          layer: req.layer
        }))
      ],
      vias: pending.vias
    }
    const sub = this.solveHead({ ...req, tail: from }, diagFirst, out, new Set())
    const subPath = sub.segments.length > 0 ? pointsOfSegments(sub.segments) : [from]
    const joined = tidyPath([...prefix.slice(0, -1), ...subPath])
    const state = sub.state === 'violating' ? 'clear' : sub.state
    const result = this.result(joined, req, diagFirst, state, true)
    return sub.huggingId === undefined ? result : { ...result, huggingId: sub.huggingId }
  }

  private solveHead(
    req: RouteRequest,
    diagFirst: boolean,
    pending: PendingCopper,
    ignored: ReadonlySet<number>
  ): RouteProposal {
    // Only push mode pushes: a mode switched mid-route leaves no stale
    // pushes on screen or in the commit.
    if (req.mode !== 'shove') this.shove.dropHead()
    const halfWidth = req.width / 2
    const q = this.queryFor(req, ignored)
    // R11: a cursor inside something the head may not enter is aimed at the
    // nearest point of its outline; the walk then reaches it the shorter way.
    const target =
      req.mode === 'highlight' ? req.cursor : this.escape(req.cursor, req, q, req.mode === 'shove')
    const elbow = this.headPath(req, diagFirst, target)
    if (elbow.length < 2) return this.result([req.tail], req, diagFirst, 'clear', false)

    if (req.mode === 'highlight') {
      const head = this.snapToObstacle(req, diagFirst, elbow, q)
      const violating = this.world.pathViolates(head, halfWidth, req.clearance, q)
      return this.result(head, req, diagFirst, violating ? 'violating' : 'clear', false)
    }

    if (req.mode === 'shove') {
      // P5: what can never move is walked round first, as Avoid walks it;
      // the rest is pushed. A push that cannot be done walks the head round
      // everything instead (KiCad's `rhShoveOnly`, then `rhWalkOnly`).
      // R2 passes through what the tail starts in only where it cannot be
      // pushed; a pair's other half is never in its way (PR3).
      const pushQ: ObstacleQuery = {
        ...q,
        filter: (item) => item.net !== req.alsoNet && (!ignored.has(item.id) || this.movable(item))
      }
      const solidQ: ObstacleQuery = {
        ...pushQ,
        filter: (item) => pushQ.filter!(item) && isSolid(item)
      }
      const floor = this.shove.floor()
      const solids = this.walkHead(floor, elbow, req, solidQ)
      if (solids.path.length >= 2 && (solids.reached || solids.hugged)) {
        const r = this.shove.proposePath(
          solids.path,
          { layer: req.layer, width: req.width, clearance: req.clearance, net: req.net },
          pending,
          { cornerMode: req.cornerMode, filter: pushQ.filter }
        )
        if (r.status === 'clear') return this.walk(floor, elbow, req, diagFirst, solidQ, solids)
        if (r.status === 'shoved') {
          // R6: what it walked round, hugged as Avoid hugs it — over the pushes,
          // so a shortcut never runs into copper this frame moved.
          const around = [...solids.walked, ...r.walked]
          const path =
            around.length > 0 ? this.smooth(this.shove.currentWorld(), r.path, req, pushQ) : r.path
          const state = solids.hugged ? 'walking' : 'pushing'
          return this.hugging(this.result(path, req, diagFirst, state, true), around)
        }
      }
      this.shove.dropHead()
      // Aimed as Avoid aims, out of what turned out not to move as well (R11).
      const walkTarget = this.escape(req.cursor, req, q, false)
      if (!samePt(walkTarget, target)) {
        const walkElbow = this.headPath(req, diagFirst, walkTarget)
        if (walkElbow.length >= 2)
          return this.walk(this.shove.floor(), walkElbow, req, diagFirst, q)
      }
    }

    return this.walk(this.shove.floor(), elbow, req, diagFirst, q)
  }

  /**
   * Highlight: a head that runs into something ends on that obstacle's
   * clearance outline instead when the cursor is within half a track width
   * of it, inside or out — so a track can be laid as tight as clearance
   * allows without anything moving (KiCad's mark-obstacles mode, which snaps
   * to the first obstacle's hull; its bounding box in 90° mode).
   */
  private snapToObstacle(
    req: RouteRequest,
    diagFirst: boolean,
    elbow: Pt[],
    q: ObstacleQuery
  ): Pt[] {
    const halfWidth = req.width / 2
    const hit = this.world.firstObstacle(elbow, halfWidth, req.clearance, q)
    if (!hit) return elbow
    const c = req.cursor
    let best: { at: Pt; dist: number } | null = null
    for (const hull of this.world.hullsOf(hit, req.clearance, halfWidth, req.cornerMode, q)) {
      let at: Pt
      if (req.cornerMode === '90') {
        const xs = hull.map((p) => p.x)
        const ys = hull.map((p) => p.y)
        at = {
          x: Math.min(Math.max(c.x, Math.min(...xs)), Math.max(...xs)),
          y: Math.min(Math.max(c.y, Math.min(...ys)), Math.max(...ys))
        }
      } else {
        at = closestOn(c, hull[hull.length - 1], hull[0])
        for (let i = 0; i < hull.length - 1; i++) {
          const p = closestOn(c, hull[i], hull[i + 1])
          if (Math.hypot(p.x - c.x, p.y - c.y) < Math.hypot(at.x - c.x, at.y - c.y)) at = p
        }
      }
      const dist = Math.hypot(at.x - c.x, at.y - c.y)
      if (!best || dist < best.dist) best = { at, dist }
    }
    if (!best || best.dist >= halfWidth || samePt(best.at, c)) return elbow
    const snapped = this.headPath(req, diagFirst, best.at)
    return snapped.length >= 2 ? snapped : elbow
  }

  /** R3's bend from the tail to `target`, leaving and entering pads along their axes (R38). */
  private headPath(req: RouteRequest, diagFirst: boolean, target: Pt): Pt[] {
    const exit = this.padExitAt(req, req.tail, target)
    const from = exit ?? req.tail
    const entry = this.padExitAt(req, target, from)
    const to = entry ?? target
    return tidyPath([
      req.tail,
      ...(exit ? [exit] : []),
      ...routeElbow(req.cornerMode, diagFirst, from, to),
      ...(entry ? [{ ...target }] : [])
    ])
  }

  /** A pad of the route's net on its layer anchored at `at`. */
  private padAt(req: RouteRequest, at: Pt): CopperItem | undefined {
    return this.world.base
      .near(at.x, at.y, 1e-6, { layer: req.layer, net: req.net })
      .find((h) => h.item.ref.type === 'pad' && h.item.anchor && samePt(h.item.anchor, at))?.item
  }

  /** Where the route crosses the edge of a pad of its net anchored at `at`, heading for `toward`. */
  private padExitAt(req: RouteRequest, at: Pt, toward: Pt): Pt | null {
    if (!this.smartPads(req)) return null
    const pad = this.padAt(req, at)
    if (!pad) return null
    const exit = padExit(pad, at, toward, this.exits.get(pad.id))
    if (exit) this.exits.set(pad.id, exit.direction)
    return exit?.at ?? null
  }

  /**
   * R38: pad exits are fitted only in 45° modes (rounded 45° too), and not
   * once the posture is forced with `/` — as KiCad's smart pads, off in its
   * 90° modes and for a hand-flipped posture.
   */
  private smartPads(req: RouteRequest): boolean {
    return this.options.smartPads !== false && req.cornerMode === '45' && !req.postureForced
  }

  /** What the head may not touch: other nets' copper, less what the tail starts inside (R2). */
  private queryFor(
    req: RouteRequest,
    ignored: ReadonlySet<number> = this.startingInside(req)
  ): ObstacleQuery {
    const also = req.alsoNet
    return {
      layer: req.layer,
      excludeNet: req.net,
      filter:
        ignored.size > 0 || also !== undefined
          ? (item) => !ignored.has(item.id) && item.net !== also
          : undefined
    }
  }

  /** What a push may move (P1, P11). */
  private movable(item: CopperItem): boolean {
    if (this.options.isFixed?.(item)) return false
    if (item.ref.type === 'segment' && item.shape.kind === 'capsule') return true
    if (item.ref.type === 'tarc' && item.shape.kind === 'arc') return true
    return (this.options.pushVias ?? true) && item.ref.type === 'via'
  }

  /**
   * The point nearest `cursor` outside every obstacle outline it lies in —
   * in push mode, only the outlines of what cannot move — and on the board.
   */
  private escape(cursor: Pt, req: RouteRequest, q: ObstacleQuery, pushing: boolean, from?: Pt): Pt {
    const world = this.shove.floor()
    const reach = (req.width / 2 + world.reach(req.clearance)) * 1.1 + 0.01
    let at = world.onBoard(cursor) ? { ...cursor } : ontoBoard(world, cursor)
    for (let round = 0; round < 6; round++) {
      let inside: Pt[] | null = null
      for (const item of world.itemsNear(at, reach, req.layer)) {
        if (item.net === req.net || (q.filter && !q.filter(item))) continue
        if (pushing && this.movable(item)) continue
        const hull = world
          .hullsOf(item, req.clearance, req.width / 2, req.cornerMode, q)
          .find((h) => pointInRing(at, h))
        if (hull) {
          inside = hull
          break
        }
      }
      if (!inside) return at
      at = outsideOf(inside, at, (p) => world.onBoard(p), from)
    }
    return at
  }

  private walk(
    world: RouterWorld,
    elbow: Pt[],
    req: RouteRequest,
    diagFirst: boolean,
    q: ObstacleQuery,
    walk: HeadWalk = this.walkHead(world, elbow, req, q)
  ): RouteProposal {
    const { path, reached } = walk
    if (walk.walked.length === 0 && reached)
      return this.result(path, req, diagFirst, 'clear', false, world)
    const proposal = this.result(
      path.length >= 2 ? path : [req.tail],
      req,
      diagFirst,
      reached || walk.hugged ? 'walking' : 'blocked',
      true,
      world
    )
    const stop = reached ? null : world.firstObstacle(elbow, req.width / 2, req.clearance, q)
    return this.hugging(proposal, [...walk.walked, ...(stop ? [stop.id] : [])])
  }

  /**
   * R7, R39: the head walked round what it meets both ways, every obstacle
   * clockwise and every obstacle anticlockwise (KiCad's `rhWalkBase`). The
   * shorter that arrives within DETOUR_LIMIT times the plain bend is taken
   * whole. Else each way is cut at its point nearest the cursor within
   * HUG_REACH times the bend, and the one that ends nearer the cursor taken.
   */
  private walkHead(world: RouterWorld, elbow: Pt[], req: RouteRequest, q: ObstacleQuery): HeadWalk {
    const halfWidth = req.width / 2
    if (!world.pathViolates(elbow, halfWidth, req.clearance, q))
      return { path: elbow, walked: [], reached: true, hugged: false }
    const opts = {
      ...q,
      halfWidth,
      clearance: req.clearance,
      cornerMode: req.cornerMode,
      lengthFactorLimit: WALK_LENGTH_LIMIT
    }
    const end = elbow[elbow.length - 1]
    const plain = pathLength(elbow)
    const ways = ([true, false] as Side[]).map((winding) =>
      walkAround(world, elbow, { ...opts, winding })
    )
    let best: HeadWalk | null = null
    for (const way of ways) {
      if (way.status !== 'done') continue
      const path = this.smooth(world, way.path, req, q)
      if (path.length < 2 || !samePt(path[path.length - 1], end)) continue
      if (!best || pathLength(path) < pathLength(best.path))
        best = { path, walked: way.walked, reached: true, hugged: false }
    }
    if (best && pathLength(best.path) <= plain * DETOUR_LIMIT) return best
    let nearest: { walk: HeadWalk; dist: number } | null = null
    for (const way of ways) {
      if (way.status === 'stuck') continue
      const cut = cleanPrefix(
        world,
        clipTowardCursor(cutAtLength(way.path, plain * HUG_REACH), req.cursor),
        halfWidth,
        req.clearance,
        q
      )
      if (cut.length < 2) continue
      const path = this.smooth(world, cut, req, q)
      const at = path[path.length - 1]
      const dist = Math.hypot(at.x - req.cursor.x, at.y - req.cursor.y)
      const reached = samePt(at, end)
      if (!nearest || dist < nearest.dist)
        nearest = { walk: { path, walked: way.walked, reached, hugged: !reached }, dist }
    }
    if (nearest) return nearest.walk
    const path = cleanPrefix(world, elbow, halfWidth, req.clearance, q)
    return { path, walked: [], reached: false, hugged: false }
  }

  /** S11: of the board copper the head went round or stopped at, the nearest its end. */
  private hugging(proposal: RouteProposal, ids: Iterable<number>): RouteProposal {
    const end = proposal.endsAt
    let best: { id: number; dist: number } | null = null
    for (const id of ids) {
      const item = id >= 0 ? this.world.base.items[id] : undefined
      if (!item) continue
      const dist = segmentToShape(item.shape, end.x, end.y, end.x, end.y, 0)
      if (!best || dist < best.dist) best = { id, dist }
    }
    return best ? { ...proposal, huggingId: best.id } : proposal
  }

  /** Pull the walked route taut without changing which side of anything it passes. */
  private smooth(world: RouterWorld, path: Pt[], req: RouteRequest, q: ObstacleQuery): Pt[] {
    const halfWidth = req.width / 2
    const smoothed = smoothPath(path, req.cornerMode, {
      collides: (run) => world.pathViolates(run, halfWidth, req.clearance, q),
      crosses: (from, to) => world.obstacleBetween(from, to, q)
    })
    return this.fitPadExits(world, tidyPath(smoothed), req, q)
  }

  /**
   * R38: a route leaves and enters a pad of its net by one of the pad's exits
   * (padExits), whichever leaves the route as drawn with the fewest, gentlest
   * corners — legal, and passing everything on the side it did. On a tie the
   * exit it had last frame, then the longer. Where no exit is legal the route
   * stays as it is.
   */
  private fitPadExits(world: RouterWorld, path: Pt[], req: RouteRequest, q: ObstacleQuery): Pt[] {
    if (path.length < 2 || !this.smartPads(req)) return path
    let out = path
    for (const atEnd of [false, true]) {
      const line = atEnd ? [...out].reverse() : out
      const pad = this.padAt(req, line[0])
      if (!pad) continue
      const fitted = this.fitExit(world, line, pad, req, q)
      if (fitted) out = atEnd ? fitted.reverse() : fitted
    }
    return out
  }

  private fitExit(
    world: RouterWorld,
    line: readonly Pt[],
    pad: CopperItem,
    req: RouteRequest,
    q: ObstacleQuery
  ): Pt[] | null {
    const exits = padExits(pad, line[0])
    if (exits.length === 0) return null
    const halfWidth = req.width / 2
    const onPad = (p: Pt): boolean => segmentToShape(pad.shape, p.x, p.y, p.x, p.y, 0) <= 0
    const kept = this.exits.get(pad.id)
    type Fit = { path: Pt[]; cost: number; exit: number; direction: number; length: number }
    let best: Fit | null = null
    const better = (a: Fit, b: Fit | null): boolean =>
      !b ||
      a.cost < b.cost ||
      (a.cost === b.cost &&
        ((a.direction === kept) !== (b.direction === kept)
          ? a.direction === kept
          : a.exit > b.exit + 1e-9 || (Math.abs(a.exit - b.exit) <= 1e-9 && a.length < b.length)))
    for (const exit of exits) {
      const from = exit.points[exit.points.length - 1]
      const exitLength = pathLength(exit.points)
      // Joined to one of the next few corners of the route as drawn.
      for (let k = 1; k <= Math.min(4, line.length - 1); k++) {
        if (onPad(line[k]) && k < line.length - 1) continue
        for (const diag of [true, false]) {
          const head = tidyPath([
            ...exit.points,
            ...routeElbow(req.cornerMode, diag, from, line[k])
          ])
          if (head.length < 2 || !samePt(head[head.length - 1], line[k])) continue
          if (world.pathViolates(head, halfWidth, req.clearance, q)) continue
          if (world.obstacleBetween(line.slice(0, k + 1), head, q)) continue
          const path = tidyPath([...head, ...line.slice(k + 1)])
          // Still leaving along the exit, however the bend after it merged.
          if (path.length < 2 || !sameHeading(path[0], path[1], exit.points[0], exit.points[1]))
            continue
          const fit = {
            path,
            cost: cornerCost(path),
            exit: exitLength,
            direction: exit.direction,
            length: pathLength(path)
          }
          if (better(fit, best)) best = fit
        }
      }
    }
    if (!best) return null
    this.exits.set(pad.id, best.direction)
    return best.path
  }

  /**
   * R2: obstacles whose clearance area the tail already stands in — a
   * fine-pitch neighbor pad. The head may leave them by the shortest way
   * out; they are still marked if the committed copper really violates.
   */
  private startingInside(req: RouteRequest): Set<number> {
    const reach = req.width / 2 + this.world.reach(req.clearance)
    const asker = ownQuery(req)
    const out = new Set<number>()
    // The outlines the head is walked round, which in 45° and 90° modes reach
    // past the clearance at their corners: a tail in that margin cannot walk.
    for (const item of this.world.itemsNear(req.tail, reach * 2, req.layer)) {
      if (item.net === req.net || item.net === req.alsoNet) continue
      const hulls = this.world.hullsOf(item, req.clearance, req.width / 2, req.cornerMode, asker)
      for (const hull of hulls) {
        if (pointInRing(req.tail, hull)) out.add(item.id)
      }
    }
    return out
  }

  private result(
    path: readonly Pt[],
    req: RouteRequest,
    diagFirst: boolean,
    state: RouteState,
    walked: boolean,
    world: RouterWorld = this.shove.floor()
  ): RouteProposal {
    const halfWidth = req.width / 2
    const q = ownQuery(req)
    // Violations are judged against the world the head was resolved in —
    // with this frame's pushes when it pushed.
    const judge = state === 'pushing' ? this.shove.currentWorld() : world
    const violators = new Map<number, CopperItem>()
    const gaps = new Map<number, number>()
    const segments: ProposedSegment[] = []
    for (let i = 0; i < path.length - 1; i++) {
      const hits = judge.collisions(path[i], path[i + 1], halfWidth, req.clearance, q)
      for (const h of hits) {
        violators.set(h.item.id, h.item)
        const gap = Math.max(0, h.dist - halfWidth)
        gaps.set(h.item.id, Math.min(gap, gaps.get(h.item.id) ?? gap))
      }
      segments.push({
        x0: path[i].x,
        y0: path[i].y,
        x1: path[i + 1].x,
        y1: path[i + 1].y,
        violation: hits.length > 0
      })
    }
    const blocked = segments.some((s) => s.violation)
    return {
      segments,
      endsAt: { ...path[path.length - 1] },
      walked,
      blocked,
      state: blocked ? 'violating' : state,
      diagFirst,
      violators: [...violators.values()]
        .filter((item) => item.ref.index >= 0)
        .map((item) => ({ type: item.ref.type, index: item.ref.index })),
      violatorIds: [...violators.values()]
        .filter((item) => item.ref.index >= 0)
        .map((item) => item.id),
      marks: clearanceMarks(judge, [...violators.values()], req.clearance, q, gaps)
    }
  }
}

/**
 * Each item met, with the clearance the rules give it against the asker: what
 * F2 shows of it. `gaps` holds how far the asker keeps off each, by item id.
 */
export function clearanceMarks(
  world: RouterWorld,
  items: readonly CopperItem[],
  clearance: number,
  asker?: ClearanceAsker,
  gaps?: ReadonlyMap<number, number>
): ViolationMark[] {
  return items.map((item) => {
    const layer = asker?.layer ?? item.layers[0]
    const actual = gaps?.get(item.id)
    return {
      shape: asker ? shapeOn(item, layer) : item.shape,
      layer,
      clearance: world.clearanceFor(item, clearance, asker),
      ...(actual !== undefined ? { actual } : {}),
      copper: item.ref.index >= 0,
      ...(item.ref.index >= 0 ? { id: item.id } : {})
    }
  })
}

/** A hole met too near (R24): its halo, at the gap the rules ask. */
export function holeMark(hole: HoleConflict, layer: string): ViolationMark {
  const id = hole.item && hole.item.ref.index >= 0 ? hole.item.id : undefined
  return {
    shape: hole.shape,
    layer,
    clearance: hole.gap,
    actual: hole.actual,
    copper: false,
    ...(id !== undefined ? { id } : {})
  }
}

/** An area met (a keepout): its outline. */
export function areaMark(region: Region, layer: string): ViolationMark {
  return { shape: polyShape([region.outer, ...region.holes]), layer, clearance: 0, copper: false }
}

/** What a via is, to find where it stands clear (`viaSpotNear`). */
export interface ViaSpot {
  radius: number
  clearance: number
  net: number
  layers: readonly string[]
  drill?: number
  /** What its hole at a point comes too near (R24). */
  holes: (at: Pt) => HoleConflict[]
  /** Where it last stood: of an outline, only the side facing there is a way out. */
  from?: Pt
}

/**
 * The point nearest `cursor` where a via stands clear on every layer it
 * spans, of its hole's spacing, keepouts and the board edge — as `escape`
 * finds one for the head (R11, R24).
 */
export function viaSpotNear(world: RouterWorld, cursor: Pt, via: ViaSpot): Pt {
  const r = via.radius
  const reach = (r + world.reach(via.clearance)) * 1.1 + 0.01
  let at = world.onBoard(cursor) ? { ...cursor } : ontoBoard(world, cursor)
  for (let round = 0; round < 8; round++) {
    let inside: Pt[] | null = null
    for (const layer of via.layers) {
      const asker: ObstacleQuery = { layer, excludeNet: via.net, kind: 'via' }
      for (const item of world.itemsNear(at, reach, layer)) {
        if (item.net === via.net) continue
        inside =
          world.hullsOf(item, via.clearance, r, 'free', asker).find((h) => pointInRing(at, h)) ??
          null
        if (inside) break
      }
      if (inside) break
    }
    if (!inside) {
      const hole = via.holes(at)[0]
      if (hole) inside = shapeHulls(hole.shape, hole.gap, (via.drill ?? 0) / 2, 'free')[0] ?? null
    }
    if (!inside) {
      for (const region of world.viaKeepoutsAt(at, r, via.layers)) {
        const outline = convexOutline(
          shapeHulls(polyShape([region.outer]), 0, r, 'free').flat(),
          'free'
        )
        if (pointInRing(at, outline)) inside = outline
      }
    }
    if (!inside) return at
    at = outsideOf(inside, at, (p) => world.onBoard(p), via.from)
  }
  return at
}

/**
 * The nearest point of a ring's boundary to `p`, nudged just outside it —
 * the nearest that `allowed` accepts, when any does. Given `from`, only the
 * edges facing it are ways out, while any is.
 */
function outsideOf(ring: readonly Pt[], p: Pt, allowed: (q: Pt) => boolean, from?: Pt): Pt {
  const nudge = 1e-4
  type Candidate = { at: Pt; dist: number; nx: number; ny: number }
  let best: Candidate | null = null
  let fallback: Candidate | null = null
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
    const at = { x: a.x + t * dx, y: a.y + t * dy }
    const dist = Math.hypot(at.x - p.x, at.y - p.y)
    const len = Math.sqrt(l2) || 1
    // Clockwise ring: the outside is to the left of each edge.
    const candidate = { at, dist, nx: -dy / len, ny: dx / len }
    if (!fallback || dist < fallback.dist) fallback = candidate
    const out = { x: at.x + candidate.nx * nudge, y: at.y + candidate.ny * nudge }
    const facing =
      !from || (from.x - at.x) * candidate.nx + (from.y - at.y) * candidate.ny > -ROUTER_EPSILON
    if (facing && allowed(out) && (!best || dist < best.dist)) best = candidate
  }
  const pick = best ?? fallback
  if (!pick) return { ...p }
  return { x: pick.at.x + pick.nx * nudge, y: pick.at.y + pick.ny * nudge }
}

/** The nearest point on the board's outline to a point off the board, just inside it. */
function ontoBoard(world: RouterWorld, p: Pt): Pt {
  let best: { at: Pt; dist: number } | null = null
  for (const region of world.bounds().regions) {
    for (const ring of [region.outer, ...region.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const at = closestOn(p, ring[i], ring[(i + 1) % ring.length])
        const dist = Math.hypot(at.x - p.x, at.y - p.y)
        if (!best || dist < best.dist) best = { at, dist }
      }
    }
  }
  if (!best || best.dist < 1e-9) return { ...p }
  // A step past the outline, away from the cursor; the edge's own outline
  // then moves it to clearance (escape).
  const step = 1e-4 / best.dist
  const inside = {
    x: best.at.x + (best.at.x - p.x) * step,
    y: best.at.y + (best.at.y - p.y) * step
  }
  return world.onBoard(inside) ? inside : best.at
}

function closestOn(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return { x: a.x + t * dx, y: a.y + t * dy }
}

/** The first `length` of a path. */
function cutAtLength(path: readonly Pt[], length: number): Pt[] {
  const out: Pt[] = [{ ...path[0] }]
  let left = length
  for (let i = 0; i < path.length - 1; i++) {
    const seg = Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y)
    if (seg >= left) {
      if (left > 1e-9) out.push(lerp(path[i], path[i + 1], left / seg))
      return out
    }
    out.push({ ...path[i + 1] })
    left -= seg
  }
  return out
}

/** The walked path up to its point nearest the cursor (R11, R14). */
function clipTowardCursor(path: readonly Pt[], cursor: Pt): Pt[] {
  let best: { path: Pt[]; dist: number } | null = null
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]
    const b = path[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const t =
      l2 > 0 ? Math.max(0, Math.min(1, ((cursor.x - a.x) * dx + (cursor.y - a.y) * dy) / l2)) : 0
    const proj = { x: a.x + t * dx, y: a.y + t * dy }
    const dist = Math.hypot(proj.x - cursor.x, proj.y - cursor.y)
    // Ties go to the later point: the head goes as far as it can.
    if (!best || dist <= best.dist + 1e-9) best = { path: [...path.slice(0, i + 1), proj], dist }
  }
  return best ? tidyPath(best.path) : [...path]
}

/** How far along `a`→`b` a segment from `a` stays legal, as a fraction, to a hundredth of a micron. */
function cleanFraction(
  world: RouterWorld,
  a: Pt,
  b: Pt,
  halfWidth: number,
  clearance: number,
  q: ObstacleQuery
): number {
  let lo = 0
  let hi = 1
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  while ((hi - lo) * len > 1e-5) {
    const mid = (lo + hi) / 2
    if (world.violates(a, lerp(a, b, mid), halfWidth, clearance, q)) hi = mid
    else lo = mid
  }
  return lo
}

/** Whether a→b and c→d head the same way. */
function sameHeading(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const ux = b.x - a.x
  const uy = b.y - a.y
  const vx = d.x - c.x
  const vy = d.y - c.y
  const lu = Math.hypot(ux, uy)
  const lv = Math.hypot(vx, vy)
  return lu > 0 && lv > 0 && Math.abs(ux * vy - uy * vx) <= 1e-9 * lu * lv && ux * vx + uy * vy > 0
}

/** How far a mouse trail keeps, on average, from a path. */
function trailOffset(trail: readonly Pt[], path: readonly Pt[]): number {
  if (trail.length === 0 || path.length < 2) return 0
  let sum = 0
  for (const p of trail) {
    let best = Infinity
    for (let i = 0; i < path.length - 1; i++) {
      const at = closestOn(p, path[i], path[i + 1])
      best = Math.min(best, Math.hypot(at.x - p.x, at.y - p.y))
    }
    sum += best
  }
  return sum / trail.length
}

const unitOf = (a: Pt, b: Pt): Pt => {
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
}

/** The midpoint of the arc tangent to a leg into `corner` at `a`, `t` before it, and to the leg out the same `t` after. */
function filletMid(a: Pt, corner: Pt, u: Pt, v: Pt, t: number, theta: number): Pt {
  const r = t / Math.tan(theta / 2)
  // Toward the inside of the turn from `a`.
  const turn = u.x * v.y - u.y * v.x >= 0 ? 1 : -1
  const n = { x: -u.y * turn, y: u.x * turn }
  const c = { x: a.x + n.x * r, y: a.y + n.y * r }
  const toCorner = unitOf(c, corner)
  return { x: c.x + toCorner.x * r, y: c.y + toCorner.y * r }
}

/**
 * Segments with arcs among them (R3's rounded corners) as straight chords
 * only: what a world, a clearance outline or a straight-only drawing takes.
 */
export function chordsOf<T extends { x0: number; y0: number; x1: number; y1: number; mid?: Pt }>(
  segments: readonly T[],
  pieces = 12
): Array<Omit<T, 'mid'>> {
  const out: Array<Omit<T, 'mid'>> = []
  for (const s of segments) {
    const { mid, ...rest } = s
    if (!mid) {
      out.push(rest)
      continue
    }
    const run = arcPolyline({ x: s.x0, y: s.y0 }, mid, { x: s.x1, y: s.y1 }, pieces)
    for (let k = 0; k < run.length - 1; k++)
      out.push({ ...rest, x0: run[k].x, y0: run[k].y, x1: run[k + 1].x, y1: run[k + 1].y })
  }
  return out
}

/** A proposal's segments as the path they run along. */
const pointsOfSegments = (segments: readonly ProposedSegment[]): Pt[] => [
  { x: segments[0].x0, y: segments[0].y0 },
  ...segments.map((s) => ({ x: s.x1, y: s.y1 }))
]

const lerp = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t
})

/** The longest start of a path that is legal: where the head stops (R14). */
function cleanPrefix(
  world: RouterWorld,
  path: readonly Pt[],
  halfWidth: number,
  clearance: number,
  q: ObstacleQuery
): Pt[] {
  const out: Pt[] = [{ ...path[0] }]
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]
    const b = path[i + 1]
    if (!world.violates(a, b, halfWidth, clearance, q)) {
      out.push({ ...b })
      continue
    }
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const lo = cleanFraction(world, a, b, halfWidth, clearance, q)
    if (lo * len > 1e-4) out.push({ x: a.x + (b.x - a.x) * lo, y: a.y + (b.y - a.y) * lo })
    break
  }
  return tidyPath(out)
}

/**
 * The head cut back from its end to the last point a via fits (R14), looked
 * for `step` apart: the proposal up to there, stopped short of the cursor;
 * null when not even its start will do.
 */
function backOff(
  proposal: RouteProposal,
  fits: (p: Pt) => boolean,
  step: number
): RouteProposal | null {
  const segs = proposal.segments
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]
    const a = { x: s.x0, y: s.y0 }
    const b = { x: s.x1, y: s.y1 }
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    // From b back toward a a step at a time, then halved down to a tenth of a micron.
    const steps = Math.max(1, Math.ceil(len / step))
    let bad = 1
    for (let k = steps - 1; k >= 0; k--) {
      const t = k / steps
      if (!fits(lerp(a, b, t))) {
        bad = t
        continue
      }
      let good = t
      while ((bad - good) * len > 1e-4) {
        const mid = (good + bad) / 2
        if (fits(lerp(a, b, mid))) good = mid
        else bad = mid
      }
      const end = lerp(a, b, good)
      const kept = segs.slice(0, i)
      if (good * len > 1e-6) kept.push({ ...s, x1: end.x, y1: end.y })
      return { ...proposal, segments: kept, endsAt: end, state: 'blocked' }
    }
  }
  return null
}

export { arcPolyline, pathLength }
