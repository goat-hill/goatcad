/**
 * Differential pairs (docs/router-behavior.md PR1–PR6), as KiCad's router
 * routes them (`DIFF_PAIR_PLACER`, `DP_GATEWAYS`, `DIFF_PAIR`).
 *
 * A pair is built between gateways: two anchor points, one per half, at the
 * pair's pitch, each reached from its copper by a short entry. Every frame
 * the copper the pair goes on from (its start, or the last click's ending
 * segments or vias) offers gateways, and so does the cursor or the pair's
 * far end. Each start and end gateway is joined by a two-segment trace per
 * half, in both postures; a candidate whose joints turn sharper than the
 * gateway allows, whose halves come nearer than the pitch, or cross, is
 * refused, and the best scored of the rest is the head (PR2).
 *
 * The head then meets the board as the mode says (PR3): Highlight marks it;
 * Avoid walks one half round what it meets and pushes the other to the gap
 * from it, in both orders, keeping the best; Push walks round what never
 * moves that way, then pushes the rest with both halves as heads. A click
 * lays the head; its ending segments are where the next head starts (PR6).
 *
 * The builders work in KiCad's frame (y down), so candidates are made, and
 * ties settled, in KiCad's order; everything else is the scene's (y up).
 */

import type { CopperItem, Pt } from '../spatialIndex'
import { padFrame, shapeOn } from '../spatialIndex'
import { RouterWorld, isSolid, nextOverlayId, type ObstacleQuery } from './world'
import { clearanceMarks, type RouteMode, type RouteState, type ViolationMark } from './engine'
import type { RouteOptions } from './engine'
import { segmentHull, ROUTER_EPSILON, type Hull } from './hulls'
import { walkPathAroundHull } from './hullWalk'
import { walkAround } from './walkaround'
import { mergeColinear, pathLength, removeLoops, samePt, tidyPath } from './geometry'
import { ShoveSession, overlaySegment, type DisplacedPreview, type ShoveDelta } from './shove'

/** What the pair is drawn with. */
export interface PairSizes {
  width: number
  gap: number
}

/** The vias a pair ends in (PR5): the route's via, the pair's via gap, the layers it spans. */
export interface PairViaSpec {
  size: number
  drill: number
  gap: number
  layers: readonly string[]
}

/**
 * The copper a pair half goes on from (KiCad's `DP_PRIMITIVE_PAIR` member):
 * a pad, by how far its fan-out reaches (null for a round one); a via; a
 * track, by its two ends in file order.
 */
export type PairPrimitive =
  | { kind: 'pad'; fan: { ortho: number; diag: number } | null }
  | { kind: 'via'; layers: readonly string[] }
  | { kind: 'track'; a: Pt; b: Pt }

/** Both halves' copper at one end of a pair, and the points the halves leave from. */
export interface PrimitivePair {
  anchorP: Pt
  anchorN: Pt
  p: PairPrimitive
  n: PairPrimitive
}

export interface PairRequest {
  mode: RouteMode
  layer: string
  sizes: PairSizes
  clearance: number
  nets: { p: number; n: number }
  cursor: Pt
  /** `/` has flipped the posture (pressed an odd number of times). */
  postureFlipped: boolean
  /** `V` armed: the head ends in a via pair (PR5). */
  via?: PairViaSpec
}

export interface PairProposal {
  /** Each half's path, from where it goes on from; empty where no head fits. */
  p: Pt[]
  n: Pt[]
  /** The via pair the head ends in, when armed. */
  vias: { p: Pt; n: Pt; spec: PairViaSpec } | null
  /** Per segment of each half: whether it violates. */
  pViolations: boolean[]
  nViolations: boolean[]
  blocked: boolean
  state: RouteState
  /** Over the pair's far end, and fitting (PR4): the click finishes. */
  arrived: boolean
  violators: Array<{ type: string; index: number }>
  marks: ViolationMark[]
}

// -------------------------------------------------------------------------
// KiCad's 45° directions (`DIRECTION_45`).

/** A nanometre: KiCad's unit, the tolerance where it compares integers. */
const NM = 1e-6

const ANG_OBTUSE = 0x01
const ANG_RIGHT = 0x02
const ANG_ACUTE = 0x04
const ANG_STRAIGHT = 0x08
const ANG_HALF_FULL = 0x10
const ANG_UNDEFINED = 0x20

/** A direction's nearest of the eight, 0–7, or −1 for none. */
function dir45(v: Pt): number {
  if (Math.hypot(v.x, v.y) < NM) return -1
  const k = Math.round(Math.atan2(v.y, v.x) / (Math.PI / 4))
  return ((k % 8) + 8) % 8
}

function angle45(a: Pt, b: Pt): number {
  const da = dir45(a)
  const db = dir45(b)
  if (da < 0 || db < 0) return ANG_UNDEFINED
  const d = Math.abs(da - db)
  if (d === 1 || d === 7) return ANG_OBTUSE
  if (d === 2 || d === 6) return ANG_RIGHT
  if (d === 3 || d === 5) return ANG_ACUTE
  if (d === 4) return ANG_HALF_FULL
  return ANG_STRAIGHT
}

const isDiagonal = (v: Pt): boolean => dir45(v) % 2 === 1

/** A direction's nearest of the eight, as a unit vector. */
function unit45(v: Pt): Pt {
  const a = (dir45(v) * Math.PI) / 4
  return { x: Math.cos(a), y: Math.sin(a) }
}

/** KiCad's `BuildInitialTrace`, mitred: one 45° bend from `a` to `b`, the diagonal first or last. */
export function initialTrace(a: Pt, b: Pt, startDiagonal: boolean): Pt[] {
  const w = Math.abs(b.x - a.x)
  const h = Math.abs(b.y - a.y)
  const sw = Math.sign(b.x - a.x)
  const sh = Math.sign(b.y - a.y)
  if (w < NM || h < NM || Math.abs(w - h) < NM) return [{ ...a }, { ...b }]
  const mp0 = w > h ? { x: (w - h) * sw, y: 0 } : { x: 0, y: sh * (h - w) }
  const mp1 = w > h ? { x: h * sw, y: h * sh } : { x: sw * w, y: sh * w }
  const mid = startDiagonal ? mp1 : mp0
  return [{ ...a }, { x: a.x + mid.x, y: a.y + mid.y }, { ...b }]
}

// -------------------------------------------------------------------------
// Vectors and segments.

const add = (a: Pt, b: Pt, k = 1): Pt => ({ x: a.x + b.x * k, y: a.y + b.y * k })
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const scale = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k })
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y
const norm = (a: Pt): number => Math.hypot(a.x, a.y)
/** KiCad's `VECTOR2::Perpendicular`. */
const perp = (v: Pt): Pt => ({ x: -v.y, y: v.x })
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const near = (a: Pt, b: Pt): boolean => norm(sub(a, b)) < NM
/** The y-flip between the scene and KiCad's frame: its own inverse. */
const flip = (p: Pt): Pt => ({ x: p.x, y: -p.y })

function resize(v: Pt, len: number): Pt {
  const l = norm(v)
  return l < NM ? { x: 0, y: 0 } : scale(v, len / l)
}

/** KiCad's `makeGapVector`: along `dir`, half of `length`, so twice it spans the gap. */
const gapVector = (dir: Pt, length: number): Pt => resize(dir, length / 2)

interface Seg {
  a: Pt
  b: Pt
}

const segsOf = (path: readonly Pt[]): Seg[] => path.slice(1).map((b, i) => ({ a: path[i], b }))

function pointSegDistance(p: Pt, s: Seg): number {
  const d = sub(s.b, s.a)
  const l2 = dot(d, d)
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, s.a), d) / l2)) : 0
  return norm(sub(p, add(s.a, d, t)))
}

const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x

function segsIntersect(s: Seg, t: Seg): boolean {
  const d1 = cross(sub(t.b, t.a), sub(s.a, t.a))
  const d2 = cross(sub(t.b, t.a), sub(s.b, t.a))
  const d3 = cross(sub(s.b, s.a), sub(t.a, s.a))
  const d4 = cross(sub(s.b, s.a), sub(t.b, s.a))
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true
  return (
    pointSegDistance(s.a, t) < NM ||
    pointSegDistance(s.b, t) < NM ||
    pointSegDistance(t.a, s) < NM ||
    pointSegDistance(t.b, s) < NM
  )
}

function segDistance(s: Seg, t: Seg): number {
  if (segsIntersect(s, t)) return 0
  return Math.min(
    pointSegDistance(s.a, t),
    pointSegDistance(s.b, t),
    pointSegDistance(t.a, s),
    pointSegDistance(t.b, s)
  )
}

/** KiCad's `SEG::ApproxParallel`: the other's ends lie the same distance from this one's line. */
function approxParallel(s: Seg, t: Seg, threshold = NM): boolean {
  const d = sub(s.b, s.a)
  const l = norm(d)
  if (l < NM) return false
  const off = (p: Pt): number => cross(d, sub(p, s.a)) / l
  return Math.abs(off(t.a) - off(t.b)) <= threshold * 2
}

/** A point projected onto a segment's line. */
function lineProject(s: Seg, p: Pt): Pt {
  const d = sub(s.b, s.a)
  const l2 = dot(d, d)
  return l2 > 0 ? add(s.a, d, dot(sub(p, s.a), d) / l2) : { ...s.a }
}

/** Where two lines cross; null for parallel ones. */
function intersectLines(a: Pt, da: Pt, b: Pt, db: Pt): Pt | null {
  const den = cross(da, db)
  if (Math.abs(den) < 1e-12) return null
  return add(a, da, cross(sub(b, a), db) / den)
}

/** Consecutive repeated points dropped, as a line chain's append drops them. */
function joined(...parts: Pt[][]): Pt[] {
  const out: Pt[] = []
  for (const part of parts)
    for (const p of part) if (!out.length || !near(out[out.length - 1], p)) out.push(p)
  return out
}

// -------------------------------------------------------------------------
// Gateways (KiCad's `DP_GATEWAY`, `DP_GATEWAYS`), in KiCad's frame.

interface Gateway {
  p: Pt
  n: Pt
  diagonal: boolean
  /** The joint angles allowed where the pair leaves its entry. */
  angles: number
  priority: number
  /** Each half's run from its copper to its anchor; absent where the anchors are the copper. */
  entry?: { p: Pt[]; n: Pt[] }
}

const gateway = (p: Pt, n: Pt, diagonal: boolean, angles = ANG_OBTUSE, priority = 0): Gateway => ({
  p,
  n,
  diagonal,
  angles,
  priority
})

/** Two points on a line of 45° steps: level, plumb or diagonal (`checkDiagonalAlignment`). */
function aligned45(a: Pt, b: Pt): boolean {
  const dx = Math.abs(a.x - b.x)
  const dy = Math.abs(a.y - b.y)
  return (dx < NM && dy >= NM) || Math.abs(dx - dy) < NM || (dy < NM && dx >= NM)
}

/** The generic exits from two points (`BuildGeneric`): midpoint, side by side, and where 45° lines meet. */
function buildGeneric(
  out: Gateway[],
  p0p: Pt,
  p0n: Pt,
  gap: number,
  buildEntries: boolean,
  viaMode = false
): void {
  const from = out.length
  const padDist = norm(sub(p0n, p0p))
  const padToGapThreshold = 3
  const H = { x: 1, y: 0 }
  const V = { x: 0, y: 1 }
  const D0 = { x: 1, y: 1 }
  const D1 = { x: -1, y: 1 }
  const st = [H, V]
  const d = [D0, D1]
  const onLine = (a: Pt, da: Pt, b: Pt): boolean => Math.abs(cross(da, sub(b, a))) / norm(da) < NM

  // Midpoint exit and side-by exits.
  for (let i = 0; i < 2; i++) {
    const straightColl = onLine(p0p, st[i], p0n)
    const diagColl = onLine(p0p, d[i], p0n)
    if (straightColl || diagColl) {
      let dir = gapVector(sub(p0n, p0p), gap / 2)
      const m = mid(p0p, p0n)
      const prio = padDist > padToGapThreshold * gap ? 2 : 1
      if (!viaMode) {
        out.push(gateway(sub(m, dir), add(m, dir), diagColl, ANG_RIGHT, prio))
        dir = gapVector(sub(p0n, p0p), 2 * gap)
        out.push(gateway(sub(p0p, dir), add(sub(p0p, dir), perp(dir)), diagColl))
        out.push(gateway(sub(p0p, dir), sub(sub(p0p, dir), perp(dir)), diagColl))
        out.push(gateway(add(add(p0n, dir), perp(dir)), add(p0n, dir), diagColl))
        out.push(gateway(sub(add(p0n, dir), perp(dir)), add(p0n, dir), diagColl))
      }
    }
  }

  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      // Diagonal with diagonal, straight with straight: pads on one line.
      const same: Array<Pt | null> = [
        i === j ? null : intersectLines(p0n, d[i], p0p, d[j]),
        i === j ? null : intersectLines(p0p, st[i], p0n, st[j])
      ]
      for (let k = 0; k < 2; k++) {
        const m = same[k]
        if (m && !near(m, p0p) && !near(m, p0n)) {
          const prio = padDist > padToGapThreshold * gap ? 10 : 20
          const gp = resize(sub(p0p, m), gap * Math.SQRT1_2)
          const gn = resize(sub(p0n, m), gap * Math.SQRT1_2)
          out.push(gateway(add(m, gp), add(m, gn), k === 0, ANG_OBTUSE, prio))
        }
      }
      // Diagonal with straight: the "weirder" exits.
      const mixed: Array<Pt | null> = [
        intersectLines(p0n, st[i], p0p, d[j]),
        intersectLines(p0p, st[i], p0n, d[j])
      ]
      for (let k = 0; k < 2; k++) {
        const m = mixed[k]
        if (m && !viaMode && !near(m, p0p) && !near(m, p0n)) {
          let gp = resize(sub(p0p, m), gap * Math.SQRT2)
          let gn = resize(sub(p0n, m), gap)
          if (angle45(gp, gn) !== ANG_ACUTE) out.push(gateway(add(m, gp), add(m, gn), true))
          gp = resize(sub(p0p, m), gap)
          gn = resize(sub(p0n, m), gap * Math.SQRT2)
          if (angle45(gp, gn) !== ANG_ACUTE) out.push(gateway(add(m, gp), add(m, gn), true))
        }
      }
    }
  }

  if (buildEntries) {
    for (let k = from; k < out.length; k++) {
      const g = out[k]
      if (g.entry) continue
      g.entry = {
        p: initialTrace(g.p, p0p, g.diagonal).reverse(),
        n: initialTrace(g.n, p0n, g.diagonal).reverse()
      }
    }
  }
}

/** The way a track runs out of its end at `at` (`anchorDirection`). */
function outward(prim: Extract<PairPrimitive, { kind: 'track' }>, at: Pt): Pt {
  return near(prim.a, at) ? sub(prim.a, prim.b) : sub(prim.b, prim.a)
}

/** Going on from two track ends (`buildDpContinuation`): the ends themselves, and one end a little further for a 45° turn. */
function buildContinuation(
  out: Gateway[],
  pair: PrimitivePair,
  diagonal: boolean,
  gap: number
): void {
  out.push(gateway(pair.anchorP, pair.anchorN, diagonal, ANG_OBTUSE, 100))
  if (pair.p.kind !== 'track' || pair.n.kind !== 'track') return
  const dirP = unit45(outward(pair.p, pair.anchorP))
  const dirN = unit45(outward(pair.n, pair.anchorN))
  const angled = (length: number, priority: number): void => {
    const endP = add(pair.anchorP, dirP, length)
    out.push({
      ...gateway(endP, pair.anchorN, diagonal, ANG_OBTUSE, priority),
      entry: { p: [pair.anchorP, endP], n: [] }
    })
    const endN = add(pair.anchorN, dirN, length)
    out.push({
      ...gateway(pair.anchorP, endN, diagonal, ANG_OBTUSE, priority),
      entry: { p: [], n: [pair.anchorN, endN] }
    })
  }
  const delta = sub(pair.anchorP, pair.anchorN)
  const eps = 5e-6
  if (Math.abs(delta.x) < eps || Math.abs(delta.y) < eps || Math.abs(delta.x - delta.y) < eps) {
    angled(gap * 0.38268, 20)
    // KiCad's wiggle room where sin 22.5° does not quite fit (its issue 12459).
    angled(gap * 0.39875, 5)
  }
}

/** The gateways a pair end offers (`BuildFromPrimitivePair`), in KiCad's frame. */
function buildFromPrimitives(
  out: Gateway[],
  pair: PrimitivePair,
  preferDiagonal: boolean,
  gap: number
): void {
  const padOrVia = (k: PairPrimitive['kind']): boolean => k === 'pad' || k === 'via'
  if (pair.p.kind === 'track' && pair.n.kind === 'track') {
    buildContinuation(out, pair, preferDiagonal, gap)
    return
  }
  if (!padOrVia(pair.p.kind) || !padOrVia(pair.n.kind)) return
  const p0p = pair.anchorP
  const p0n = pair.anchorN
  const fan = pair.p.kind === 'pad' ? pair.p.fan : null
  if (!fan) {
    buildGeneric(out, p0p, p0n, gap, true)
    return
  }
  const major = perp(sub(p0p, p0n))
  if (aligned45(p0p, p0n)) {
    const padDist = norm(sub(p0p, p0n))
    for (let k = 0; k < 2; k++) {
      const dir = gapVector(major, k === 0 ? fan.ortho : fan.diag)
      const dd = Math.max(0, padDist - gap)
      const dp = gapVector(dir, dd)
      const dv = gapVector(sub(p0n, p0p), dd)
      for (const sign of [1, -1]) {
        const out1 = scale(add(dir, dp), sign)
        const gwP = add(add(p0p, out1), dv)
        const gwN = sub(add(p0n, out1), dv)
        out.push({
          ...gateway(gwP, gwN, false, ANG_OBTUSE, 100 - k),
          entry: {
            p: [p0p, add(p0p, dir, sign), gwP],
            n: [p0n, add(p0n, dir, sign), gwN]
          }
        })
      }
    }
  }
  buildGeneric(out, p0p, p0n, gap, true)
}

/** Gateways at the cursor (`BuildForCursor`): four straight, four diagonal; via pairs when fitting vias. */
function buildForCursor(
  out: Gateway[],
  c: Pt,
  gap: number,
  vias: { size: number; gap: number } | null
): void {
  const g = vias ? vias.gap + vias.size : gap
  for (const diagonal of [false, true]) {
    for (let i = 0; i < 4; i++) {
      let dir: Pt
      if (!diagonal) {
        dir = gapVector({ x: g, y: g }, g)
        if (i % 2 === 0) dir = { x: -dir.x, y: dir.y }
        if (Math.floor(i / 2) === 0) dir = { x: dir.x, y: -dir.y }
      } else {
        const half = (g / 2) * (i % 2 ? -1 : 1)
        dir = Math.floor(i / 2) === 0 ? { x: half, y: 0 } : { x: 0, y: half }
      }
      if (vias) buildGeneric(out, add(c, dir), sub(c, dir), gap, true, true)
      else out.push(gateway(add(c, dir), sub(c, dir), diagonal))
    }
  }
}

/** Gateways whose halves lie along `ref` (`FilterByOrientation`) dropped. */
const filterByOrientation = (gws: Gateway[], mask: number, ref: Pt): Gateway[] =>
  gws.filter((g) => (angle45(sub(g.p, g.n), ref) & mask) === 0)

/** Where a pair heads from its end, toward the cursor (`CursorOrientation`), KiCad's frame. */
function cursorOrientation(pair: PrimitivePair, cursor: Pt): { mid: Pt; dir: Pt } {
  let aP = pair.anchorP
  let aN = pair.anchorN
  if (pair.p.kind === 'track' && pair.n.kind === 'track') {
    aP = pair.p.b
    aN = pair.n.b
    const segP = { a: pair.p.a, b: pair.p.b }
    const segN = { a: pair.n.a, b: pair.n.b }
    if (!near(segP.a, segP.b) && !near(segN.a, segN.b) && approxParallel(segP, segN)) {
      return { mid: mid(aP, aN), dir: resize(sub(segP.b, segP.a), norm(sub(aP, aN))) }
    }
  }
  const m = mid(aP, aN)
  let dir = perp(sub(aP, aN))
  if (dot(dir, sub(cursor, m)) < 0) dir = scale(dir, -1)
  return { mid: m, dir }
}

const flipPrimitive = (prim: PairPrimitive): PairPrimitive =>
  prim.kind === 'track' ? { kind: 'track', a: flip(prim.a), b: flip(prim.b) } : prim

const flipPair = (pair: PrimitivePair): PrimitivePair => ({
  anchorP: flip(pair.anchorP),
  anchorN: flip(pair.anchorN),
  p: flipPrimitive(pair.p),
  n: flipPrimitive(pair.n)
})

// -------------------------------------------------------------------------
// Fitting a pair between gateways (`DIFF_PAIR::BuildInitial`, `FitGateways`).

/** Each half's path. */
export interface PairTrace {
  p: Pt[]
  n: Pt[]
}

/** The joint where `b` goes on from `a` turns as `mask` allows, on both halves. */
function connectionAngleOk(a: PairTrace, b: PairTrace, mask: number): boolean {
  const ok = (x: Pt[], y: Pt[]): boolean => {
    if (x.length < 2 || y.length < 2) return true
    const s0 = sub(x[x.length - 1], x[x.length - 2])
    const s1 = sub(y[1], y[0])
    return (angle45(s0, s1) & mask) !== 0
  }
  return ok(a.p, b.p) && ok(a.n, b.n)
}

/**
 * KiCad's `checkGap`: no segment of one half nearer the other than the
 * pitch, except near the entry, where a narrower start (a neck-down) may
 * widen out.
 */
function checkGap(
  p: Pt[],
  n: Pt[],
  gap: number,
  entryGap: number,
  entryMid: Pt,
  radius: number
): boolean {
  const limit = gap - 1e-4
  const relax = entryGap >= 0 && entryGap < gap
  const entryLimit = relax ? entryGap - 1e-4 : limit
  for (const sp of segsOf(p)) {
    const pNear = relax && norm(sub(mid(sp.a, sp.b), entryMid)) <= radius
    for (const sn of segsOf(n)) {
      const nNear = pNear && norm(sub(mid(sn.a, sn.b), entryMid)) <= radius
      if (segDistance(sp, sn) < (nNear ? entryLimit : limit)) return false
    }
  }
  return true
}

function selfIntersecting(path: Pt[]): boolean {
  const segs = segsOf(path)
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (j === i + 1) {
        const d = angle45(sub(segs[i].b, segs[i].a), sub(segs[j].b, segs[j].a))
        if (d === ANG_HALF_FULL) return true
      } else if (segsIntersect(segs[i], segs[j])) return true
    }
  }
  return false
}

function pathsIntersect(a: Pt[], b: Pt[]): boolean {
  for (const s of segsOf(a)) for (const t of segsOf(b)) if (segsIntersect(s, t)) return true
  return false
}

function buildInitial(
  entry: Gateway,
  target: Gateway,
  prefDiagonal: boolean,
  gap: number
): PairTrace | null {
  const p = initialTrace(entry.p, target.p, prefDiagonal)
  const n = initialTrace(entry.n, target.n, prefDiagonal)
  let out: PairTrace = { p, n }
  let mask = entry.angles | ANG_STRAIGHT | ANG_OBTUSE
  if (entry.entry) {
    if (!connectionAngleOk(entry.entry, out, mask)) return null
    out = { p: joined(entry.entry.p, p), n: joined(entry.entry.n, n) }
  }
  mask = target.angles | ANG_STRAIGHT | ANG_OBTUSE
  if (target.entry) {
    const t = { p: [...target.entry.p].reverse(), n: [...target.entry.n].reverse() }
    if (!connectionAngleOk(out, t, mask)) return null
    out = { p: joined(out.p, t.p), n: joined(out.n, t.n) }
  }
  const entryGap = norm(sub(entry.p, entry.n))
  if (!checkGap(p, n, gap, entryGap, mid(entry.p, entry.n), 4 * gap)) return null
  if (selfIntersecting(p) || selfIntersecting(n)) return null
  if (pathsIntersect(p, n)) return null
  return out
}

/** The best pair between any entry and any target, in both postures (`FitGateways`). */
function fitGateways(
  entries: Gateway[],
  targets: Gateway[],
  prefDiagonal: boolean,
  gap: number
): PairTrace | null {
  let best: PairTrace | null = null
  let bestScore = -1000
  for (const e of entries) {
    for (const t of targets) {
      for (const preferred of [false, true]) {
        const score = (preferred ? 0 : -3) + e.priority + t.priority
        if (score < bestScore) continue
        const built = buildInitial(e, t, preferred ? prefDiagonal : !prefDiagonal, gap)
        if (built) {
          best = built
          bestScore = score
        }
      }
    }
  }
  return best
}

// -------------------------------------------------------------------------
// Coupling (`DIFF_PAIR::CoupledLength`).

/** Within KiCad's tolerance of the pair's gap (its `m_gapConstraint`, ±10 µm). */
const gapMatches = (dist: number, gap: number): boolean => Math.abs(dist - gap) <= 0.01

/** Where two parallel segments run side by side, as lengths along the first (`commonParallelProjection`). */
function commonProjection(p: Seg, n: Seg): number {
  const d = sub(p.b, p.a)
  const l = norm(d)
  if (l < NM) return 0
  const t = (q: Pt): number => dot(sub(q, p.a), d) / l
  const ta = Math.min(t(n.a), t(n.b))
  const tb = Math.max(t(n.a), t(n.b))
  if (l <= ta || 0 >= tb) return 0
  const sorted = [0, l, ta, tb].sort((x, y) => x - y)
  return sorted[2] - sorted[1]
}

function coupledLength(p: readonly Pt[], n: readonly Pt[], width: number, gap: number): number {
  let total = 0
  for (const sp of segsOf(p as Pt[])) {
    for (const sn of segsOf(n as Pt[])) {
      const dist = Math.abs(segDistance(sp, sn) - width)
      if (approxParallel(sp, sn) && gapMatches(dist, gap)) total += commonProjection(sp, sn)
    }
  }
  return total
}

// -------------------------------------------------------------------------
// The pair against the board.

interface Judge {
  world: RouterWorld
  layer: string
  width: number
  clearance: number
  gap: number
  nets: { p: number; n: number }
}

const queryFor = (j: Judge, net: number, solidsOnly: boolean): ObstacleQuery => ({
  layer: j.layer,
  excludeNet: net,
  ...(solidsOnly ? { filter: isSolid } : {})
})

/** A half running into anything (or, `solidsOnly`, anything that never moves): `CheckColliding`. */
const collides = (j: Judge, path: readonly Pt[], net: number, solidsOnly = false): boolean =>
  j.world.pathViolates(path, j.width / 2, j.clearance, queryFor(j, net, solidsOnly))

/** One half walked round what it meets the shorter way (`WP_SHORTEST`); null when it cannot arrive. */
function walkHalf(j: Judge, path: Pt[], net: number, solidsOnly: boolean): Pt[] | null {
  if (path.length < 2) return null
  const r = walkAround(j.world, path, {
    ...queryFor(j, net, solidsOnly),
    halfWidth: j.width / 2,
    clearance: j.clearance,
    cornerMode: '45'
  })
  if (r.status !== 'done') return null
  return mergeColinear(r.path)
}

/**
 * The other half pushed out to the gap from a walked one, its ends held
 * (`SHOVE::ShoveObstacleLine` with the pair's gap forced): round the walked
 * half's outline, the shorter way that clears it.
 */
function shoveToGap(head: Pt[], line: Pt[], width: number, gap: number): Pt[] | null {
  const d = gap + width
  const clear = (path: Pt[]): boolean =>
    segsOf(path).every((s) => segsOf(head).every((h) => segDistance(s, h) >= d - ROUTER_EPSILON))
  if (clear(line)) return line
  const hulls: Hull[] = segsOf(head).map((s) => segmentHull(s.a, s.b, d))
  let best: Pt[] | null = null
  for (const cw of [true, false]) {
    let bent: Pt[] | null = [...line]
    for (const hull of hulls) {
      bent = walkPathAroundHull(bent, hull, cw)
      if (!bent) break
    }
    if (!bent) continue
    const tidy = removeLoops(mergeColinear(bent))
    if (!samePt(tidy[0], line[0]) || !samePt(tidy[tidy.length - 1], line[line.length - 1])) continue
    if (!clear(tidy)) continue
    if (!best || pathLength(tidy) < pathLength(best)) best = tidy
  }
  return best
}

/** One walk of the pair (`attemptWalk`): a half walked, the other pushed to the gap from it, in turn. */
function attemptWalk(
  j: Judge,
  cur: PairTrace,
  pFirst: boolean,
  solidsOnly: boolean
): PairTrace | null {
  let pair = cur
  let currentIsP = pFirst
  let iter = 0
  do {
    const walkNet = currentIsP ? j.nets.p : j.nets.n
    const shoveNet = currentIsP ? j.nets.n : j.nets.p
    const preWalk = currentIsP ? pair.p : pair.n
    const preShove = currentIsP ? pair.n : pair.p
    if (!collides(j, preWalk, walkNet, solidsOnly)) {
      currentIsP = !currentIsP
      if (!collides(j, preShove, shoveNet, solidsOnly)) break
      continue
    }
    const postWalk = walkHalf(j, preWalk, walkNet, solidsOnly)
    if (!postWalk) return null
    const postShove = shoveToGap(postWalk, preShove, j.width, j.gap - 2e-5)
    if (!postShove) return null
    pair = currentIsP ? { p: postWalk, n: postShove } : { p: postShove, n: postWalk }
    currentIsP = !currentIsP
    if (!collides(j, postShove, shoveNet, solidsOnly)) break
    iter++
  } while (iter < 3)
  return iter === 3 ? null : pair
}

/**
 * Walk the pair (`tryWalkDp`): each half first in turn, kept by KiCad's
 * score (coupled length and three times the skew, the least), then tidied
 * as a pair. Null where no walk arrives: the head shows nothing.
 */
function walkPair(j: Judge, trace: PairTrace, solidsOnly: boolean): PairTrace | null {
  let best: PairTrace | null = null
  let bestScore = Infinity
  for (const pFirst of [false, true]) {
    const walked = attemptWalk(j, trace, pFirst, solidsOnly)
    if (!walked) continue
    const skew = pathLength(walked.p) - pathLength(walked.n)
    const score = 1 + coupledLength(walked.p, walked.n, j.width, j.gap) + Math.abs(skew) * 3
    if (score < bestScore) {
      bestScore = score
      best = walked
    }
  }
  return best ? optimizePair(j, best) : null
}

// -------------------------------------------------------------------------
// KiCad's pair optimizer (`OPTIMIZER::mergeDpSegments`).

/** `SHAPE_LINE_CHAIN::Replace`: points `from`…`to` replaced by `line`. */
const replacePoints = (path: Pt[], from: number, to: number, line: Pt[]): Pt[] =>
  joined(path.slice(0, from), line, path.slice(to + 1))

/** The halves clear of each other at clearance, and of the board (`verifyDpBypass`). */
function verifyBypass(j: Judge, refIsP: boolean, ref: Pt[], coupled: Pt[]): boolean {
  const d = j.clearance + j.width - ROUTER_EPSILON
  for (const s of segsOf(ref))
    for (const t of segsOf(coupled)) if (segDistance(s, t) < d) return false
  const [p, n] = refIsP ? [ref, coupled] : [coupled, ref]
  return !collides(j, p, j.nets.p) && !collides(j, n, j.nets.n)
}

/** The other half's vertices at the gap from `vertex`, beside a segment parallel to `orig` (`findCoupledVertices`). */
function coupledVertices(j: Judge, vertex: Pt, orig: Seg, coupled: Pt[]): number[] {
  const out: number[] = []
  segsOf(coupled).forEach((s, i) => {
    if (!approxParallel(s, orig)) return
    const dist = norm(sub(lineProject(s, vertex), vertex)) - j.width
    if (gapMatches(dist, j.gap)) out.push(i)
  })
  return out
}

/** The other half given a matching bypass where one half took one (`coupledBypass`). */
function coupledBypass(
  j: Judge,
  refIsP: boolean,
  ref: Pt[],
  refBypass: Pt[],
  coupled: Pt[]
): Pt[] | null {
  const starts = coupledVertices(j, refBypass[0], { a: refBypass[0], b: refBypass[1] }, coupled)
  const diagonal = isDiagonal(sub(refBypass[1], refBypass[0]))
  let best: Pt[] | null = null
  let bestLength = -1
  for (const si of starts) {
    for (let k = 1; k < coupled.length - 1; k++) {
      if (Math.abs(si - k) <= 1) continue
      const bypass = initialTrace(coupled[si], coupled[k], diagonal)
      const length = coupledLength(ref, bypass, j.width, j.gap)
      const next =
        si < k
          ? replacePoints(coupled, si, k, bypass)
          : replacePoints(coupled, k, si, [...bypass].reverse())
      if (length > bestLength && verifyBypass(j, refIsP, ref, next)) {
        best = next
        bestLength = length
      }
    }
  }
  return best
}

function mergeStep(j: Judge, pair: PairTrace, tryP: boolean, step: number): PairTrace | null {
  const current = tryP ? pair.p : pair.n
  const coupled = tryP ? pair.n : pair.p
  const nSegs = current.length - 2
  const before = coupledLength(current, coupled, j.width, j.gap)
  const budget = before / 10
  const set = (ref: Pt[], other: Pt[]): PairTrace =>
    tryP
      ? { p: mergeColinear(ref), n: mergeColinear(other) }
      : { p: mergeColinear(other), n: mergeColinear(ref) }
  for (let n = 1; n < nSegs - step; n++) {
    const s1 = { a: current[n], b: current[n + 1] }
    const s2 = { a: current[n + step], b: current[n + step + 1] }
    if (angle45(sub(s1.b, s1.a), sub(s2.b, s2.a)) !== ANG_OBTUSE) continue
    const bypass = initialTrace(s1.a, s2.b, isDiagonal(sub(s1.b, s1.a)))
    const ref = replacePoints(current, n, n + step, bypass)
    const uni = coupledLength(ref, coupled, j.width, j.gap) - before + budget
    const other = coupledBypass(j, tryP, ref, bypass, coupled)
    if (other) {
      if (coupledLength(ref, other, j.width, j.gap) - before + budget >= 0) return set(ref, other)
    } else if (uni >= 0 && verifyBypass(j, tryP, ref, coupled)) return set(ref, coupled)
  }
  return null
}

function optimizePair(j: Judge, trace: PairTrace): PairTrace {
  let pair = trace
  let stepP = pair.p.length - 3
  let stepN = pair.n.length - 3
  for (;;) {
    stepP = Math.min(stepP, pair.p.length - 3)
    stepN = Math.min(stepN, pair.n.length - 3)
    if (stepP < 1 && stepN < 1) break
    let found = false
    if (stepP > 1) {
      const next = mergeStep(j, pair, true, stepP)
      if (next) {
        pair = next
        found = true
      }
    }
    if (stepN > 1) {
      const next = mergeStep(j, pair, false, stepN)
      if (next) {
        pair = next
        found = true
      }
    }
    if (!found) {
      stepP--
      stepN--
    }
  }
  return pair
}

// -------------------------------------------------------------------------
// The cursor pushed out of what the pair cannot reach (`propagateDpHeadForces`).

/** KiCad's virtual via has no net: every net's copper is in its way. */
const NO_NET = -1

/**
 * Where the head aims: the cursor moved out of what a circle as wide as the
 * pair (as the via pair, when fitting vias) would hit, as KiCad's virtual
 * via is. Highlight aims at the cursor; Push only out of what never moves.
 * Null where it cannot get out.
 */
function headForces(
  world: RouterWorld,
  at: Pt,
  mode: RouteMode,
  r: number,
  layers: readonly string[],
  clearance: number
): Pt | null {
  if (mode === 'highlight') return at
  const solidsOnly = mode === 'shove'
  let pos = { ...at }
  let force = { x: 0, y: 0 }
  const handled = new Set<number>()
  let collided = false
  const maxIter = 40
  let iter = 0
  for (; iter < maxIter; iter++) {
    let hit: CopperItem | null = null
    for (const layer of layers) {
      const h = world
        .collisions(pos, pos, r, clearance, {
          layer,
          excludeNet: NO_NET,
          ...(solidsOnly ? { filter: isSolid } : {})
        })
        .map((x) => x.item)[0]
      if (h) {
        hit = h
        break
      }
    }
    if (!hit || handled.has(hit.id)) break
    collided = false
    for (const layer of layers) {
      if (!hit.layers.includes(layer)) continue
      const push = pushOut(world, hit, pos, r, clearance, layer)
      if (push) {
        collided = true
        if (norm(push) > norm(force)) force = push
      }
    }
    if (collided) pos = add(pos, force)
    handled.add(hit.id)
  }
  return !collided || iter !== maxIter ? add(at, force) : null
}

/** The least move that takes a circle at `at` clear of an item. */
function pushOut(
  world: RouterWorld,
  item: CopperItem,
  at: Pt,
  r: number,
  clearance: number,
  layer: string
): Pt | null {
  const asker = { layer, excludeNet: NO_NET }
  let best: Pt | null = null
  for (const hull of world.hullsOf(item, clearance, r, 'free', asker)) {
    if (!pointInHull(at, hull)) continue
    for (let i = 0; i < hull.length; i++) {
      const s = { a: hull[i], b: hull[(i + 1) % hull.length] }
      const q = lineProjectClamped(s, at)
      const v = sub(q, at)
      const move = resize(v, norm(v) + ROUTER_EPSILON)
      if (!best || norm(move) < norm(best)) best = move
    }
  }
  return best
}

function lineProjectClamped(s: Seg, p: Pt): Pt {
  const d = sub(s.b, s.a)
  const l2 = dot(d, d)
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, s.a), d) / l2)) : 0
  return add(s.a, d, t)
}

function pointInHull(p: Pt, ring: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const a = ring[i]
    const b = ring[k]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside
  }
  return inside
}

// -------------------------------------------------------------------------
// The tool's session.

/**
 * The copper a pad offers a pair from (PR2): how far its fan-out goes, from
 * its shape as KiCad's router sees it — a rectangle by its long side, an
 * oval by its straight run, anything else by its box; null when round.
 */
export function padFan(item: CopperItem, layer: string): { ortho: number; diag: number } | null {
  const shape = shapeOn(item, layer)
  if (shape.kind === 'circle') return null
  if (shape.kind === 'capsule') {
    const len = Math.hypot(shape.x1 - shape.x0, shape.y1 - shape.y0)
    if (len < NM) return null
    return { ortho: shape.halfWidth * 2 + len, diag: len }
  }
  const frame = padFrame(shape)
  let w: number
  let h: number
  if (frame) {
    const c = Math.abs(Math.cos(frame.rotation))
    const s = Math.abs(Math.sin(frame.rotation))
    const square = c < NM || s < NM
    w = square ? frame.halfW * 2 : 2 * (frame.halfW * c + frame.halfH * s)
    h = square ? frame.halfH * 2 : 2 * (frame.halfW * s + frame.halfH * c)
    if (square && s > c) [w, h] = [h, w]
  } else {
    w = item.maxX - item.minX
    h = item.maxY - item.minY
  }
  if (w < h) [w, h] = [h, w]
  return { ortho: (w * 3) / 2, diag: w - h }
}

/** What a click laid, kept for Backspace. */
interface Laid {
  prev: PrimitivePair
  initialDiagonal: boolean
  flipBase: boolean
}

/**
 * One pair route: lives while the pair is drawn. It goes on from its start,
 * then from each click's ending segments or vias; the clicks' copper and
 * pushes stand in its world as floors (shove.ts).
 */
export class DiffPairSession {
  readonly shove: ShoveSession
  private prev: PrimitivePair | null = null
  /** The posture each head starts in: after a click, the one its last bend leaves (KiCad's). */
  private initialDiagonal = false
  /** The request's flip at the last click: `/` flips from there. */
  private flipBase = false
  /** The last head that fitted: kept while no gateway does (`m_currentTrace`). */
  private last: PairTrace | null = null
  private history: Laid[] = []

  constructor(
    readonly world: RouterWorld,
    options: RouteOptions = {}
  ) {
    this.shove = new ShoveSession(world, options)
  }

  /** Start from a pair's copper (PR1). */
  begin(start: PrimitivePair, flipped = false): void {
    this.shove.reset()
    this.prev = start
    this.initialDiagonal = false
    this.flipBase = flipped
    this.last = null
    this.history = []
  }

  /** What the pair goes on from now: its start, the last click's segments, or its vias. */
  from(): PrimitivePair | null {
    return this.prev
  }

  /** The layer may change mid-pair only where it goes on from vias that span it (`SetLayer`). */
  canSwitchTo(layer: string): boolean {
    const prim = this.prev?.p
    return prim?.kind === 'via' && prim.layers.includes(layer)
  }

  propose(req: PairRequest, target?: PrimitivePair): PairProposal {
    const prev = this.prev
    if (!prev) throw new Error('DiffPairSession.propose before begin')
    if (req.mode !== 'shove') this.shove.dropHead()
    const pitch = req.sizes.gap + req.sizes.width
    const startDiagonal = this.initialDiagonal !== (req.postureFlipped !== this.flipBase)
    const floor = this.shove.floor()

    // Gateways, in KiCad's frame.
    const entries: Gateway[] = []
    buildFromPrimitives(entries, flipPair(prev), startDiagonal, pitch)
    const targets: Gateway[] = []
    let aimed = true
    if (target) {
      buildFromPrimitives(targets, flipPair(target), startDiagonal, pitch)
    } else {
      const via = req.via
      const r = via ? (via.gap + 2 * via.size) / 2 : (req.sizes.gap + 2 * req.sizes.width) / 2
      const fp = headForces(
        floor,
        req.cursor,
        req.mode,
        r,
        via ? via.layers : [req.layer],
        req.clearance
      )
      if (!fp) aimed = false
      else {
        const kfp = flip(fp)
        const o = cursorOrientation(flipPair(prev), kfp)
        const proj = lineProject({ a: o.mid, b: add(o.mid, o.dir) }, kfp)
        const fit = via ? { size: via.size, gap: via.gap } : null
        // Far from the line the pair runs on, a 45° turn; near it, straight on (PR2).
        if (norm(sub(proj, kfp)) > pitch / 2) buildForCursor(targets, kfp, pitch, fit)
        else {
          buildForCursor(targets, proj, pitch, fit)
          targets.splice(
            0,
            targets.length,
            ...filterByOrientation(targets, ANG_STRAIGHT | ANG_HALF_FULL, o.dir)
          )
        }
      }
    }
    const fitted = aimed ? fitGateways(entries, targets, startDiagonal, pitch) : null
    const fresh = fitted ? { p: fitted.p.map(flip), n: fitted.n.map(flip) } : null
    if (fresh) this.last = fresh
    const trace = fresh ?? this.last
    const judge: Judge = {
      world: floor,
      layer: req.layer,
      width: req.sizes.width,
      clearance: req.clearance,
      gap: req.sizes.gap,
      nets: req.nets
    }
    if (!trace) return this.empty()

    let head: PairTrace | null = trace
    let fitOk = false
    let world = floor
    if (req.mode === 'highlight') {
      fitOk = true
    } else if (req.mode === 'walkaround') {
      head = walkPair(judge, trace, false)
      fitOk = head !== null
    } else {
      head = walkPair(judge, trace, true)
      if (head) {
        const via = req.via
        const heads = [
          {
            path: head.p,
            width: req.sizes.width,
            layer: req.layer,
            kind: 'track' as const,
            net: req.nets.p,
            alsoNet: req.nets.n
          },
          {
            path: head.n,
            width: req.sizes.width,
            layer: req.layer,
            kind: 'track' as const,
            net: req.nets.n,
            alsoNet: req.nets.p
          },
          ...(via
            ? via.layers.flatMap((layer) => [
                {
                  path: [head!.p[head!.p.length - 1]],
                  width: via.size,
                  layer,
                  kind: 'via' as const,
                  net: req.nets.p,
                  alsoNet: req.nets.n
                },
                {
                  path: [head!.n[head!.n.length - 1]],
                  width: via.size,
                  layer,
                  kind: 'via' as const,
                  net: req.nets.n,
                  alsoNet: req.nets.p
                }
              ])
            : [])
        ]
        const r = this.shove.proposeGroup(
          heads,
          { clearance: req.clearance, net: req.nets.p },
          '45'
        )
        if (r.status !== 'failed') {
          head = { p: tidyPath(r.paths[0]), n: tidyPath(r.paths[1]) }
          world = this.shove.currentWorld()
          fitOk = true
        } else this.shove.dropHead()
      }
    }
    if (!head) return this.empty()

    const vias = req.via
      ? { p: head.p[head.p.length - 1], n: head.n[head.n.length - 1], spec: req.via }
      : null
    // Judged against the board, the clicks laid and the pushes made.
    const flagsOf = (path: Pt[], net: number): { flags: boolean[]; hits: CopperItem[] } => {
      const q: ObstacleQuery = { layer: req.layer, excludeNet: net }
      const flags: boolean[] = []
      const hits: CopperItem[] = []
      for (let i = 0; i < path.length - 1; i++) {
        const h = world.collisions(path[i], path[i + 1], req.sizes.width / 2, req.clearance, q)
        hits.push(...h.map((x) => x.item))
        flags.push(h.length > 0)
      }
      return { flags, hits }
    }
    const jp = flagsOf(head.p, req.nets.p)
    const jn = flagsOf(head.n, req.nets.n)
    const viaHits: CopperItem[] = []
    if (vias) {
      for (const [at, net] of [
        [vias.p, req.nets.p],
        [vias.n, req.nets.n]
      ] as const)
        for (const layer of vias.spec.layers)
          viaHits.push(
            ...world
              .collisions(at, at, vias.spec.size / 2, req.clearance, {
                layer,
                excludeNet: net,
                kind: 'via'
              })
              .map((x) => x.item)
          )
    }
    const violators = new Map<number, CopperItem>()
    for (const item of [...jp.hits, ...jn.hits, ...viaHits]) violators.set(item.id, item)
    const violating = violators.size > 0
    if (violating) fitOk = false
    const state: RouteState = !fitOk
      ? 'violating'
      : req.mode === 'shove' && this.shove.delta().removed.length > 0
        ? 'pushing'
        : req.mode === 'highlight'
          ? 'clear'
          : 'walking'
    return {
      p: head.p,
      n: head.n,
      vias,
      pViolations: jp.flags,
      nViolations: jn.flags,
      blocked: !fitOk,
      state,
      arrived: !!target && fitOk,
      violators: [...violators.values()]
        .filter((item) => item.ref.index >= 0)
        .map((item) => ({ type: item.ref.type, index: item.ref.index })),
      marks: clearanceMarks(world, [...violators.values()], req.clearance, {
        layer: req.layer,
        excludeNet: req.nets.p
      })
    }
  }

  private empty(): PairProposal {
    return {
      p: [],
      n: [],
      vias: null,
      pViolations: [],
      nViolations: [],
      blocked: true,
      state: 'blocked',
      arrived: false,
      violators: [],
      marks: []
    }
  }

  /**
   * A click lays the head (`FixRoute`): all of it arriving, ending in vias
   * or with *Fix all segments* on, else all but each half's last segment.
   * Null when there is nothing to lay. The next head goes on from its end.
   */
  fix(
    proposal: PairProposal,
    req: Pick<PairRequest, 'postureFlipped' | 'layer' | 'sizes' | 'nets'>,
    opts: { fixAll: boolean; finish?: boolean }
  ): PairTrace | null {
    let { p, n } = proposal
    if (p.length < 2 || n.length < 2 || !this.prev) return null
    const prevInitial = this.initialDiagonal
    if (p.length > 2) this.initialDiagonal = !isDiagonal(sub(p[p.length - 2], p[p.length - 3]))
    if (
      !proposal.arrived &&
      !proposal.vias &&
      !opts.finish &&
      !opts.fixAll &&
      p.length > 2 &&
      n.length > 2
    ) {
      p = p.slice(0, -1)
      n = n.slice(0, -1)
    }
    this.history.push({ prev: this.prev, initialDiagonal: prevInitial, flipBase: this.flipBase })
    this.shove.markClick()
    const laid: CopperItem[] = []
    for (const [path, net] of [
      [p, req.nets.p],
      [n, req.nets.n]
    ] as const)
      for (let i = 0; i < path.length - 1; i++)
        laid.push(overlaySegment(path[i], path[i + 1], req.sizes.width, req.layer, net))
    const v = proposal.vias
    if (v) {
      for (const [at, net] of [
        [v.p, req.nets.p],
        [v.n, req.nets.n]
      ] as const)
        laid.push({
          id: nextOverlayId(),
          ref: { type: 'via', index: -1 },
          net,
          layers: [...v.spec.layers],
          shape: { kind: 'circle', cx: at.x, cy: at.y, r: v.spec.size / 2 },
          minX: at.x - v.spec.size / 2,
          minY: at.y - v.spec.size / 2,
          maxX: at.x + v.spec.size / 2,
          maxY: at.y + v.spec.size / 2
        })
    }
    this.shove.landOwn(laid)
    this.prev = v
      ? {
          anchorP: v.p,
          anchorN: v.n,
          p: { kind: 'via', layers: v.spec.layers },
          n: { kind: 'via', layers: v.spec.layers }
        }
      : {
          anchorP: p[p.length - 1],
          anchorN: n[n.length - 1],
          p: { kind: 'track', a: p[p.length - 2], b: p[p.length - 1] },
          n: { kind: 'track', a: n[n.length - 2], b: n[n.length - 1] }
        }
    this.flipBase = req.postureFlipped
    this.last = null
    return { p, n }
  }

  /** Backspace: the last click is taken back, with its vias and pushes; false with nothing to take. */
  undoClick(): boolean {
    const last = this.history.pop()
    if (!last) return false
    this.shove.undoClick()
    this.prev = last.prev
    this.initialDiagonal = last.initialDiagonal
    this.flipBase = last.flipBase
    this.last = null
    return true
  }

  /** What the scene hides and draws for the pushes. */
  displaced(): DisplacedPreview {
    return this.shove.displaced()
  }

  /** The pushes, the head dropped first: what lands with the pair. */
  pushes(): ShoveDelta {
    this.shove.dropHead()
    return this.shove.delta()
  }

  reset(): void {
    this.shove.reset()
    this.prev = null
    this.last = null
    this.history = []
  }
}

/**
 * A path offset `dist` to its left (negative: right), its corners mitred
 * where the offset runs meet; a run the offset swallows (the inside of a
 * tight bend) is cut out. The tuners' pair meanders use it.
 */
export function offsetPath(path: readonly Pt[], dist: number): Pt[] {
  if (path.length < 2) return path.map((p) => ({ ...p }))
  const normals: Pt[] = []
  for (let i = 0; i < path.length - 1; i++) {
    const u = resize(sub(path[i + 1], path[i]), 1)
    normals.push({ x: -u.y, y: u.x })
  }
  const out: Pt[] = [add(path[0], normals[0], dist)]
  for (let i = 1; i < path.length - 1; i++) {
    const a = add(path[i - 1], normals[i - 1], dist)
    const b = add(path[i], normals[i - 1], dist)
    const c = add(path[i], normals[i], dist)
    const d = add(path[i + 1], normals[i], dist)
    out.push(intersectLines(a, sub(b, a), c, sub(d, c)) ?? b)
  }
  out.push(add(path[path.length - 1], normals[normals.length - 1], dist))
  return removeLoops(tidyPath(out))
}

export { coupledLength as pairCoupledLength }
