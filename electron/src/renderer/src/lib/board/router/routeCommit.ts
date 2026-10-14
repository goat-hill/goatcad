/**
 * What a finished route writes to the board beyond its own segments
 * (router-behavior.md R26, R27, R32), as KiCad's line placer tidies a fixed
 * line: the tracks and track arcs it tees into split at the junction, so
 * every junction is a track end; the old connection between its two ends
 * removed (`removeLoops`); a dead end of old copper the route now lies over,
 * or a piece of the route lying over old copper to a dead end, removed
 * (`simplifyNewLine`); and straight runs merged where two tracks of one width
 * meet end to end, the route's with each other and with the copper it
 * continues (`MERGE_COLINEAR`).
 *
 * Board coordinates, integer nm: a junction is where two ends coincide.
 */

import type { Nm } from '../../kicad/coordinates'

export interface NmPt {
  x: Nm
  y: Nm
}

export interface TrackLine {
  start: NmPt
  end: NmPt
  width: Nm
  layer: string
}

export interface BoardTrack extends TrackLine {
  /** Its index in the board's segments. */
  index: number
  net: number
  locked?: boolean
}

export interface BoardArc {
  start: NmPt
  mid: NmPt
  end: NmPt
  layer: string
  /** Its width; an arc without one never continues a run of another width's track (R27). */
  width?: Nm
  /** Its index in the board's track arcs. */
  index: number
  net: number
  locked?: boolean
}

export interface ArcPiece {
  start: NmPt
  mid: NmPt
  end: NmPt
}

/** A segment the commit adds: the route's own, or (`from`) a piece cut off a board track. */
export interface AddedTrack extends TrackLine {
  /** The board track it was cut from, beyond that track's first piece. */
  from?: number
}

export interface RouteCommitPlan {
  /** The segments to add: the route's, tidied, then the pieces cut off board tracks. */
  add: AddedTrack[]
  /** Board tracks that keep their node with new ends: cut short, or lengthened by a straight run. */
  update: Array<{ index: number; start: NmPt; end: NmPt }>
  /** Board track arcs cut where the route meets them, as pieces from `start`: the first keeps the arc, the rest are added. */
  arcSplits: Array<{ index: number; pieces: ArcPiece[] }>
  /** Board tracks and track arcs the commit removes, by index: made redundant (R27), or lain over. */
  remove: { segments: number[]; arcs: number[] }
}

export interface RouteCommitOptions {
  /** Remove the old connection between the route's ends (R27, KiCad's *Remove redundant tracks*). */
  removeLoops?: boolean
}

/**
 * Whether a pad or via sits at a point on a layer: a string names it, so
 * every point within one pad or via is one place; `true` says only that one
 * does.
 */
export type Anchored = (p: NmPt, layer: string) => boolean | string

/** How far off a track's centerline a junction may round and still lie on it. */
const ON_LINE_NM = 2

const same = (a: NmPt, b: NmPt): boolean => a.x === b.x && a.y === b.y

/** Whether b→c carries straight on from a→b, the same way. */
const straightOn = (a: NmPt, b: NmPt, c: NmPt): boolean => {
  const ux = b.x - a.x
  const uy = b.y - a.y
  const vx = c.x - b.x
  const vy = c.y - b.y
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
  if (len === 0) return false
  return (
    Math.abs(ux * vy - uy * vx) <= ON_LINE_NM * Math.max(Math.hypot(ux, uy), Math.hypot(vx, vy)) &&
    ux * vx + uy * vy > 0
  )
}

/** Where along a→b the point lies (0..1), or null when it is off the line or at an end. */
const inside = (a: NmPt, b: NmPt, p: NmPt): number | null => {
  const ex = b.x - a.x
  const ey = b.y - a.y
  const len2 = ex * ex + ey * ey
  if (len2 === 0) return null
  const t = ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2
  const along = t * Math.sqrt(len2)
  if (along <= ON_LINE_NM || along >= Math.sqrt(len2) - ON_LINE_NM) return null
  const off = Math.abs((p.x - a.x) * ey - (p.y - a.y) * ex) / Math.sqrt(len2)
  return off <= ON_LINE_NM ? t : null
}

/** Whether a point lies on a→b, its ends included. */
const onLine = (a: NmPt, b: NmPt, p: NmPt): boolean =>
  same(a, p) || same(b, p) || inside(a, b, p) !== null

/**
 * One piece of the net's copper as the commit leaves it: a board track or a
 * piece cut from one (`index`), a track arc or a piece of one, or the route's
 * own (`index` -1).
 */
interface Piece {
  kind: 's' | 'a'
  index: number
  start: NmPt
  end: NmPt
  width: Nm
  layer: string
  /** Never removed or merged: a locked track's or arc's, or a piece of a split arc. */
  fixed: boolean
  /** Changed by this commit, so a straight run through its ends merges (KiCad's line through the new copper). */
  touched: boolean
  gone?: true
  /** Its two places, as `NetCopper.place` keys them; cleared when an end moves. */
  places?: [{ key: string; anchored: boolean }, { key: string; anchored: boolean }]
}

/**
 * Plan the commit of `route` (its segments in order, as clicked) on `net`.
 * `anchored` says whether a point on a layer holds a pad or via, where two
 * tracks meeting end to end stay two.
 */
export function planRouteCommit(
  route: readonly TrackLine[],
  board: readonly BoardTrack[],
  net: number,
  anchored: Anchored,
  arcs: readonly BoardArc[] = [],
  options: RouteCommitOptions = {}
): RouteCommitPlan {
  const routed = route.filter((seg) => !same(seg.start, seg.end))
  const tracks = board.filter((t) => t.net === net)

  // Tees: a route end on the middle of a track of the net cuts it there.
  const cuts = new Map<number, NmPt[]>()
  const ends = routed.flatMap((seg) => [
    { p: seg.start, layer: seg.layer },
    { p: seg.end, layer: seg.layer }
  ])
  for (const { p, layer } of ends) {
    for (const track of tracks) {
      if (track.locked || track.layer !== layer || inside(track.start, track.end, p) === null)
        continue
      const list = cuts.get(track.index) ?? []
      if (!list.some((q) => same(q, p))) list.push(p)
      cuts.set(track.index, list)
    }
  }

  const arcSplits: RouteCommitPlan['arcSplits'] = []
  const ourArcs = arcs.filter((a) => a.net === net)
  for (const arc of ourArcs) {
    if (arc.locked) continue
    const frame = arcFrame(arc)
    if (!frame) continue
    const at: number[] = []
    for (const { p, layer } of ends) {
      if (layer !== arc.layer) continue
      const t = frame.inside(p)
      if (t !== null && !at.some((u) => Math.abs(u - t) * frame.r <= ON_LINE_NM)) at.push(t)
    }
    if (at.length === 0) continue
    const stops = [0, ...at.sort((a, b) => a - b), frame.sweep]
    const point = (t: number, i: number): NmPt =>
      i === 0 ? arc.start : i === stops.length - 1 ? arc.end : frame.at(t)
    const pieces: ArcPiece[] = []
    for (let i = 0; i < stops.length - 1; i++) {
      pieces.push({
        start: point(stops[i], i),
        mid: frame.at((stops[i] + stops[i + 1]) / 2),
        end: point(stops[i + 1], i + 1)
      })
    }
    arcSplits.push({ index: arc.index, pieces })
  }

  // The net's copper as it stands once the route lands, before it is tidied.
  const pieces: Piece[] = []
  for (const t of tracks) {
    const at = cuts.get(t.index)
    const along = (p: NmPt): number => inside(t.start, t.end, p) ?? 0
    const stops = [t.start, ...[...(at ?? [])].sort((a, b) => along(a) - along(b)), t.end]
    for (let i = 0; i < stops.length - 1; i++) {
      pieces.push({
        kind: 's',
        index: t.index,
        start: stops[i],
        end: stops[i + 1],
        width: t.width,
        layer: t.layer,
        fixed: t.locked ?? false,
        touched: at !== undefined
      })
    }
  }
  const splitArcs = new Map(arcSplits.map((sp) => [sp.index, sp.pieces]))
  for (const a of ourArcs) {
    const split = splitArcs.get(a.index)
    for (const sp of split ?? [a]) {
      pieces.push({
        kind: 'a',
        index: a.index,
        start: sp.start,
        end: sp.end,
        width: a.width ?? (0 as Nm),
        layer: a.layer,
        fixed: (a.locked ?? false) || split !== undefined,
        touched: false
      })
    }
  }
  for (const seg of routed) {
    pieces.push({ kind: 's', index: -1, ...seg, fixed: false, touched: true })
  }

  const copper = new NetCopper(pieces, anchored)
  if ((options.removeLoops ?? true) && routed.length > 0) {
    const first = routed[0]
    const last = routed[routed.length - 1]
    removeRedundant(
      copper,
      { p: first.start, layer: first.layer },
      { p: last.end, layer: last.layer }
    )
  }
  removeCovered(copper)
  mergeStraight(copper)

  // What changed, track by track: a track keeps its node for its first piece
  // left, and its other pieces are added; a track with none left goes.
  const live = pieces.filter((p) => !p.gone)
  const plan: RouteCommitPlan = {
    add: live
      .filter((p) => p.index === -1)
      .map(({ start, end, width, layer }) => ({ start, end, width, layer })),
    update: [],
    arcSplits,
    remove: { segments: [], arcs: [] }
  }
  const left = new Map<string, Piece[]>()
  for (const p of live) {
    const key = `${p.kind}${p.index}`
    const list = left.get(key)
    if (list) list.push(p)
    else left.set(key, [p])
  }
  for (const t of tracks) {
    const [first, ...rest] = left.get(`s${t.index}`) ?? []
    if (!first) {
      plan.remove.segments.push(t.index)
      continue
    }
    if (!same(first.start, t.start) || !same(first.end, t.end))
      plan.update.push({ index: t.index, start: first.start, end: first.end })
    for (const p of rest)
      plan.add.push({ start: p.start, end: p.end, width: t.width, layer: t.layer, from: t.index })
  }
  for (const a of ourArcs) if (!left.has(`a${a.index}`)) plan.remove.arcs.push(a.index)
  return plan
}

/**
 * The net's copper by place: a pad or via is one place wherever on it a
 * track ends, any other point one place per layer. Asked again after each
 * change, as the pieces' ends move.
 */
class NetCopper {
  private readonly anchors = new Map<string, boolean | string>()

  constructor(
    readonly pieces: Piece[],
    private readonly anchored: Anchored
  ) {}

  /** A place's key, and whether a pad or via holds it. */
  place(p: NmPt, layer: string): { key: string; anchored: boolean } {
    const point = `${p.x},${p.y},${layer}`
    let a = this.anchors.get(point)
    if (a === undefined) {
      a = this.anchored(p, layer)
      this.anchors.set(point, a)
    }
    return typeof a === 'string' ? { key: a, anchored: true } : { key: point, anchored: a }
  }

  /** The pieces at each place, and each piece's two places. */
  map(): { at: Map<string, Piece[]>; ends: Map<Piece, [string, string]>; held: Set<string> } {
    const at = new Map<string, Piece[]>()
    const ends = new Map<Piece, [string, string]>()
    const held = new Set<string>()
    for (const piece of this.pieces) {
      if (piece.gone) continue
      const [a, b] = (piece.places ??= [
        this.place(piece.start, piece.layer),
        this.place(piece.end, piece.layer)
      ])
      ends.set(piece, [a.key, b.key])
      for (const place of [a, b]) {
        if (place.anchored) held.add(place.key)
        const list = at.get(place.key) ?? []
        list.push(piece)
        at.set(place.key, list)
      }
    }
    return { at, ends, held }
  }
}

/**
 * R27, KiCad's `LINE_PLACER::removeLoops`: the old connection the route
 * makes redundant. From the route's start, the net's other copper is followed
 * piece by piece through points where only two pieces of one width meet (a
 * width change ends a line, as KiCad's `JOINT::IsLineCorner` has it); a
 * chain that arrives at the route's end, with no pad, via or branch between,
 * joined the same two places the route now joins, and goes. A chain through a
 * via stays, as KiCad's does, and so does one with a locked piece or a piece
 * of a split arc.
 */
function removeRedundant(
  copper: NetCopper,
  from: { p: NmPt; layer: string },
  to: { p: NmPt; layer: string }
): void {
  const { at, ends, held } = copper.map()
  const start = copper.place(from.p, from.layer).key
  const goal = copper.place(to.p, to.layer).key
  if (start === goal) return
  const taken = new Set<Piece>()
  for (const first of at.get(start) ?? []) {
    if (first.index === -1 || taken.has(first)) continue
    const chain: Piece[] = []
    let piece = first
    let place = start
    for (;;) {
      chain.push(piece)
      const [a, b] = ends.get(piece)!
      place = a === place ? b : a
      if (place === goal || held.has(place)) break
      const next = (at.get(place) ?? []).filter((p) => p !== piece)
      if (next.length !== 1) break
      const [n] = next
      if (n.index === -1 || chain.includes(n) || n.width !== piece.width) break
      piece = n
    }
    if (place !== goal || chain.some((p) => p.fixed)) continue
    for (const p of chain) {
      taken.add(p)
      p.gone = true
    }
  }
}

/**
 * KiCad's `LINE_PLACER::simplifyNewLine` cleanup: where a piece of the route
 * and a piece of old copper of its width meet at a point that is not a plain
 * corner between the two, and one lies wholly along the other, the one whose
 * far end leads nowhere goes — the stub of a track the route was started on
 * short of its end and then ran over, or a piece of the route doubled over old
 * copper to a dead end. Old copper the route lies over end to end, the same
 * two places joined twice, goes too, which KiCad leaves where the route turns
 * off the track rather than ending on an item.
 */
function removeCovered(copper: NetCopper): void {
  const { at, ends, held } = copper.map()
  const deadEnd = (piece: Piece, place: string): boolean =>
    !held.has(place) && (at.get(place) ?? []).every((p) => p === piece || p.gone)
  for (const r of copper.pieces) {
    if (r.index !== -1 || r.gone) continue
    for (const end of [r.start, r.end]) {
      const joint = copper.place(end, r.layer).key
      const there = (at.get(joint) ?? []).filter((p) => !p.gone)
      // Two of one width meeting end to end are a corner, which KiCad leaves.
      if (there.length === 2 && there[0].width === there[1].width) continue
      for (const o of there) {
        if (o === r || o.gone || r.gone || o.index === -1 || o.kind !== 's' || o.fixed) continue
        if (o.width !== r.width || !(same(o.start, end) || same(o.end, end))) continue
        const [oa, ob] = ends.get(o)!
        const [ra, rb] = ends.get(r)!
        const oFar = oa === joint ? ob : oa
        const rFar = ra === joint ? rb : ra
        if (onLine(r.start, r.end, o.start) && onLine(r.start, r.end, o.end)) {
          if (deadEnd(o, oFar) || oFar === rFar) o.gone = true
        } else if (onLine(o.start, o.end, r.start) && onLine(o.start, o.end, r.end)) {
          if (deadEnd(r, rFar)) r.gone = true
        }
      }
    }
  }
}

/**
 * R26, KiCad's `MERGE_COLINEAR` over the line through the new copper: where
 * exactly two straight pieces of one width meet end to end, off any pad or
 * via, carrying straight on, and the commit changed either, they become one.
 * A board track keeps its node through a merge; the route's pieces join it.
 */
function mergeStraight(copper: NetCopper): void {
  for (;;) {
    const { at, held } = copper.map()
    let merged = false
    for (const [place, there] of at) {
      if (held.has(place) || there.length !== 2) continue
      const [p, q] = there
      if (p === q || p.kind !== 's' || q.kind !== 's' || p.fixed || q.fixed) continue
      if (p.width !== q.width || !(p.touched || q.touched)) continue
      const joint = [p.start, p.end].find((e) => same(e, q.start) || same(e, q.end))
      if (!joint) continue
      const pFar = same(p.end, joint) ? p.start : p.end
      const qFar = same(q.end, joint) ? q.start : q.end
      if (!straightOn(pFar, joint, qFar)) continue
      // A board track over the route's piece; the earlier of two.
      const [keep, drop] = p.index === -1 && q.index !== -1 ? [q, p] : [p, q]
      const dropFar = drop === p ? pFar : qFar
      if (same(keep.end, joint)) keep.end = dropFar
      else keep.start = dropFar
      keep.touched = true
      keep.places = undefined
      drop.gone = true
      merged = true
      break
    }
    if (!merged) return
  }
}

/**
 * An arc as a circle and a sweep from its start toward its mid: where a point
 * lies along it, and the point at a sweep. Null for an arc too flat to have
 * a center.
 */
function arcFrame(arc: BoardArc): {
  r: number
  sweep: number
  inside: (p: NmPt) => number | null
  at: (t: number) => NmPt
} | null {
  const ax = arc.start.x
  const ay = arc.start.y
  const bx = arc.mid.x
  const by = arc.mid.y
  const cx = arc.end.x
  const cy = arc.end.y
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-9) return null
  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy
  const ox = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const oy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  const r = Math.hypot(ax - ox, ay - oy)
  const a0 = Math.atan2(ay - oy, ax - ox)
  // +1 when the arc turns counterclockwise from start through mid.
  const dir = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0 ? 1 : -1
  const along = (p: NmPt): number => {
    let t = dir * (Math.atan2(p.y - oy, p.x - ox) - a0)
    while (t < 0) t += 2 * Math.PI
    while (t >= 2 * Math.PI) t -= 2 * Math.PI
    return t
  }
  const sweep = along(arc.end) || 2 * Math.PI
  return {
    r,
    sweep,
    inside: (p) => {
      if (Math.abs(Math.hypot(p.x - ox, p.y - oy) - r) > ON_LINE_NM) return null
      const t = along(p)
      return t * r > ON_LINE_NM && (sweep - t) * r > ON_LINE_NM ? t : null
    },
    at: (t) => ({
      x: Math.round(ox + r * Math.cos(a0 + dir * t)) as Nm,
      y: Math.round(oy + r * Math.sin(a0 + dir * t)) as Nm
    })
  }
}
