/**
 * Track drag (docs/router-behavior.md D1–D10).
 *
 * A drag re-draws the grabbed part of a line the way routing would have
 * drawn it, between points that stay put: the corners past the grabbed
 * segment's two neighbors (D1). Segment drag keeps the segment's direction
 * and re-draws the neighbors to meet it (D2); corner drag re-draws both
 * sides as bends through the cursor (D5). Every result is tidied — no
 * zero-length pieces, no reversals, no loops — so a drag can shrink a
 * segment to nothing but never flip it into a bow tie (D3).
 *
 * Collisions then go through the same machinery routing uses, with both
 * ends held: highlight marks, avoid bends the dragged part round
 * what it meets, push moves other copper aside (D8).
 */

import type { CopperItem, Pt } from '../spatialIndex'
import type { RouteCornerMode } from '../pcbTools'
import { routeElbow } from '../pcbTools'
import type { RouterWorld, ObstacleQuery } from './world'
import { assembleLine, type AssembledLine } from './lines'
import {
  followEnd,
  ShoveSession,
  type DisplacedPreview,
  type ShoveDelta,
  type ShoveOptions
} from './shove'
import { walkAround } from './walkaround'
import { AXIS_NORMALS, OCTILINEAR_NORMALS, samePt, tidyPath } from './geometry'
import { smoothPath } from './optimize'
import { clearanceMarks, type RouteMode, type ViolationMark } from './engine'

export interface DragGrab {
  kind: 'corner' | 'segment' | 'end'
  /**
   * Corner: index into the line's path. Segment: index of path[i]→path[i+1].
   * End: 0 or the last index, a free end of the line (D12).
   */
  index: number
}

/** How a drag draws, besides how it pushes; read live, as `ShoveOptions` are. */
export interface DragOptions extends ShoveOptions {
  /** The cursor snaps the dragged part into line with its neighbours (D11). Default on. */
  smoothDragged?: boolean
  /** The whole dragged line is tidied, not only what the drag re-drew (D10). Default off. */
  optimizeDragged?: boolean
}

export interface DragUpdate {
  /** The dragged line's proposed geometry. */
  path: Pt[]
  /** True when the proposal violates and no mode could resolve it. */
  blocked: boolean
  /** Per segment of `path`: whether it violates. */
  violations: boolean[]
  /** Other-net copper the proposal violates, as base refs (F2). */
  violators: Array<{ type: string; index: number }>
  /** Clearance outlines of that copper (F2). */
  marks: ViolationMark[]
  /** Scene suppression + displaced copper (includes the dragged original). */
  preview: DisplacedPreview
}

export class DragSession {
  readonly line: AssembledLine
  readonly grab: DragGrab
  private readonly world: RouterWorld
  private readonly shove: ShoveSession
  private lastGeometry: Pt[]
  private lastUpdate: DragUpdate | null = null

  constructor(
    baseWorld: RouterWorld,
    seed: CopperItem,
    grabPoint: Pt,
    private readonly clearance: number,
    private readonly options: DragOptions = {}
  ) {
    // The dragged line must not obstruct itself: branch with it removed.
    const line = assembleLine(baseWorld, seed)
    this.line = line
    this.world = baseWorld.branch()
    for (const id of line.ids) this.world.remove(id)
    this.shove = new ShoveSession(this.world, options)
    // An end nothing else of the net meets — no pad, via or other track — is
    // free to drag (D12). The line itself is out of this world already.
    const free = (p: Pt): boolean =>
      this.world.itemsNear(p, line.width / 2).every((item) => item.net !== line.net)
    const n = line.path.length
    this.grab = inferGrab(line, grabPoint, {
      start: n >= 2 && free(line.path[0]),
      end: n >= 2 && free(line.path[n - 1])
    })
    this.lastGeometry = line.path.map((p) => ({ ...p }))
  }

  get net(): number {
    return this.line.net
  }

  /** Whether the session found something draggable at all. */
  get valid(): boolean {
    return this.line.path.length >= 2
  }

  update(cursor: Pt, mode: RouteMode, cornerMode: RouteCornerMode = '45'): DragUpdate {
    // D11: within half a width in Push, a quarter in Avoid and Highlight (KiCad's dragger).
    const at =
      this.options.smoothDragged === false || cornerMode === 'free'
        ? cursor
        : snapDragCursor(
            this.line.path,
            this.grab,
            cursor,
            this.line.width / (mode === 'shove' ? 2 : 4)
          )
    const drawn = dragGeometry(this.line.path, this.grab, at, cornerMode)
    // A drag with no legal shape for this cursor holds the last one (D3).
    const dragged = drawn ?? this.lastGeometry
    this.lastGeometry = dragged
    const halfWidth = this.line.width / 2
    const q: ObstacleQuery = { layer: this.line.layer, excludeNet: this.line.net }

    let path = dragged
    let world: RouterWorld = this.world
    if (mode === 'shove') {
      const r = this.shove.proposePath(
        [...dragged],
        {
          layer: this.line.layer,
          width: this.line.width,
          clearance: this.clearance,
          net: this.line.net
        },
        { segments: [], vias: [] },
        { cornerMode, keepEnd: true }
      )
      if (r.status === 'shoved') {
        path = r.path
        world = this.shove.currentWorld()
      } else if (r.status === 'failed') {
        // A push that cannot be settled refuses the drag where it stands,
        // marked, as KiCad's dragger does: never quietly walked round (D8).
        this.shove.dropHead()
      }
    } else if (mode === 'walkaround') {
      path = this.walk(dragged, cornerMode) ?? dragged
    }
    if (this.options.optimizeDragged && mode !== 'highlight')
      path = this.optimize(path, world, at, cornerMode)

    const violators = new Map<number, CopperItem>()
    const violations: boolean[] = []
    for (let i = 0; i < path.length - 1; i++) {
      const hits = world.collisions(path[i], path[i + 1], halfWidth, this.clearance, q)
      for (const h of hits) violators.set(h.item.id, h.item)
      violations.push(hits.length > 0)
    }

    const displaced = this.shove.displaced()
    const update: DragUpdate = {
      path,
      blocked: violations.some(Boolean),
      violations,
      violators: [...violators.values()]
        .filter((item) => item.ref.index >= 0)
        .map((item) => ({ type: item.ref.type, index: item.ref.index })),
      marks: clearanceMarks(world, [...violators.values()], this.clearance, q),
      preview: displaced
    }
    this.lastUpdate = update
    return update
  }

  /**
   * True while the board would be untouched: no update yet, or the cursor
   * returned the line to its original geometry with nothing displaced (D7).
   */
  unchanged(): boolean {
    const last = this.lastUpdate
    if (!last) return true
    if (last.preview.segments.length > 0 || (last.preview.vias?.length ?? 0) > 0) return false
    return (
      last.path.length === this.line.path.length &&
      last.path.every((p, i) => samePt(p, this.line.path[i]))
    )
  }

  /** The commit diff for the last update (pushes + the line). */
  delta(): (ShoveDelta & { blocked: boolean }) | null {
    const last = this.lastUpdate
    if (!last) return null
    const shoveDelta = this.shove.delta()
    const added = [...shoveDelta.added]
    for (let i = 0; i < last.path.length - 1; i++) {
      added.push({
        start: { ...last.path[i] },
        end: { ...last.path[i + 1] },
        width: this.line.width,
        layer: this.line.layer,
        net: this.line.net
      })
    }
    return { ...shoveDelta, added, blocked: last.blocked }
  }

  /**
   * D10 with the whole line tidied: smoothed on either side of where it is
   * held — the point of it nearest the cursor stays — never to the other side
   * of anything, and its ends kept.
   */
  private optimize(path: Pt[], world: RouterWorld, cursor: Pt, cornerMode: RouteCornerMode): Pt[] {
    if (path.length < 3) return path
    const halfWidth = this.line.width / 2
    const q: ObstacleQuery = { layer: this.line.layer, excludeNet: this.line.net }
    const checks = {
      collides: (run: readonly Pt[]) => world.pathViolates(run, halfWidth, this.clearance, q),
      crosses: (from: readonly Pt[], to: readonly Pt[]) => world.obstacleBetween(from, to, q)
    }
    // The segment nearest the cursor is what the person holds.
    let held = 0
    let best = Infinity
    for (let i = 0; i < path.length - 1; i++) {
      const d = segDist(cursor, path[i], path[i + 1])
      if (d < best) {
        best = d
        held = i
      }
    }
    const before = path.slice(0, held + 1)
    const after = path.slice(held + 1)
    const smooth = (part: Pt[], context: { before?: Pt; after?: Pt }): Pt[] =>
      part.length >= 3
        ? smoothPath(part, cornerMode, checks, 200, { ...context, holdEnds: true })
        : part
    return tidyPath([
      ...smooth(before, { after: after[0] }),
      ...smooth(after, { before: before[before.length - 1] })
    ])
  }

  /** Walk the dragged part round what it meets, both ends held; null when it cannot. */
  private walk(dragged: Pt[], cornerMode: RouteCornerMode): Pt[] | null {
    const halfWidth = this.line.width / 2
    const q = { layer: this.line.layer, excludeNet: this.line.net }
    if (!this.world.pathViolates(dragged, halfWidth, this.clearance, q)) {
      return dragged
    }
    const r = walkAround(this.world, dragged, {
      ...q,
      halfWidth,
      clearance: this.clearance,
      cornerMode
    })
    if (r.status !== 'done') return null
    const path = tidyPath(r.path)
    if (!samePt(path[path.length - 1], dragged[dragged.length - 1])) return null
    return path
  }
}

/**
 * Corner when the grab lands within half a width of an interior corner; the
 * end, when it lands that near a free end (D12); else the segment.
 */
function inferGrab(
  line: AssembledLine,
  grabPoint: Pt,
  free: { start: boolean; end: boolean } = { start: false, end: false }
): DragGrab {
  const path = line.path
  const grabRadius = Math.max(line.width / 2, 0.05)
  const last = path.length - 1
  const near = (p: Pt): boolean => Math.hypot(p.x - grabPoint.x, p.y - grabPoint.y) <= grabRadius
  if (free.end && last > 0 && near(path[last])) return { kind: 'end', index: last }
  if (free.start && last > 0 && near(path[0])) return { kind: 'end', index: 0 }
  for (let i = 1; i < path.length - 1; i++) {
    if (Math.hypot(path[i].x - grabPoint.x, path[i].y - grabPoint.y) <= grabRadius) {
      return { kind: 'corner', index: i }
    }
  }
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const d = segDist(grabPoint, path[i], path[i + 1])
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return { kind: 'segment', index: best }
}

const segDist = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

const unit = (v: Pt): Pt => {
  const len = Math.hypot(v.x, v.y)
  return len < 1e-12 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len }
}

const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y
const crossP = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x

/** The directions a re-drawn neighbor may take in a corner mode. */
function directionsFor(mode: RouteCornerMode, original: Pt | null, u: Pt): Pt[] {
  if (mode === 'free')
    return original
      ? [original]
      : [
          { x: -u.y, y: u.x },
          { x: u.y, y: -u.x }
        ]
  // Travel directions: the normals' set is the same eight (four) directions.
  return (mode === '90' ? AXIS_NORMALS : OCTILINEAR_NORMALS).map((d) => ({ ...d }))
}

/** Where the ray from `p` along `d` meets the line through `c` along `u`; `s` along the ray. */
function rayToLine(p: Pt, d: Pt, c: Pt, u: Pt): { at: Pt; s: number } | null {
  const denom = crossP(d, u)
  if (Math.abs(denom) < 1e-12) return null
  const s = crossP({ x: c.x - p.x, y: c.y - p.y }, u) / denom
  return { at: { x: p.x + d.x * s, y: p.y + d.y * s }, s }
}

/**
 * The neighbor re-drawn from pin `p` to the line through `c` along `u`:
 * its original direction while that still works (it stretches), else the
 * shortest direction the corner mode allows. `into` is the side it meets
 * the line from: +1 the neighbor runs into the segment's start (the corner
 * it makes must not be acute going on along u), −1 its end.
 */
function neighborTo(
  p: Pt,
  original: Pt | null,
  c: Pt,
  u: Pt,
  mode: RouteCornerMode,
  into: 1 | -1
): { at: Pt; dir: Pt } | null {
  const ok = (d: Pt): { at: Pt; s: number } | null => {
    const hit = rayToLine(p, d, c, u)
    if (!hit || hit.s < -1e-9) return null
    // Arriving along d then leaving along u (or the mirror at the far end):
    // anything sharper than a right angle doubles back.
    if (into * dot(d, u) < -1e-9) return null
    return hit
  }
  if (original) {
    const hit = ok(original)
    if (hit) return { at: hit.at, dir: original }
  }
  let best: { at: Pt; dir: Pt; s: number; obtuse: boolean } | null = null
  for (const d of directionsFor(mode, original, u)) {
    const hit = ok(d)
    if (!hit) continue
    const obtuse = into * dot(d, u) > 1e-9
    // Prefer a gentle (obtuse) corner, then the shorter neighbor.
    if (!best || (obtuse && !best.obtuse) || (obtuse === best.obtuse && hit.s < best.s - 1e-9)) {
      best = { at: hit.at, dir: d, s: hit.s, obtuse }
    }
  }
  return best ? { at: best.at, dir: best.dir } : null
}

/**
 * The dragged line's geometry for a cursor, before collisions; null when no
 * legal shape exists (the caller holds the last one).
 */
export function dragGeometry(
  path: readonly Pt[],
  grab: DragGrab,
  cursor: Pt,
  cornerMode: RouteCornerMode = '45'
): Pt[] | null {
  if (grab.kind === 'corner') return cornerDrag(path, grab.index, cursor, cornerMode)
  if (grab.kind === 'end') {
    // D12: the free end follows the cursor, its last bend re-drawn from the
    // corner before it.
    if (grab.index === 0) return [...followEnd([...path].reverse(), cursor, cornerMode)].reverse()
    return followEnd(path, cursor, cornerMode)
  }
  const k = grab.index
  const a = path[k]
  const b = path[k + 1]
  const u = unit({ x: b.x - a.x, y: b.y - a.y })

  // Pins: the far ends of the neighbors, or the segment's own end when it
  // is the line's end (then a stub is drawn from it, D4).
  const hasPrev = k > 0
  const hasNext = k + 2 < path.length
  const pinA = hasPrev ? path[k - 1] : a
  const pinB = hasNext ? path[k + 2] : b
  const prevDir = hasPrev ? unit({ x: a.x - pinA.x, y: a.y - pinA.y }) : null
  // Measured from the far pin back toward the segment.
  const nextDir = hasNext ? unit({ x: b.x - pinB.x, y: b.y - pinB.y }) : null

  const head = hasPrev ? path.slice(0, k) : [path[0]]
  const tail = hasNext ? path.slice(k + 2) : [path[path.length - 1]]

  const na = neighborTo(pinA, prevDir, cursor, u, cornerMode, 1)
  const nb = neighborTo(pinB, nextDir, cursor, u, cornerMode, -1)
  if (!na || !nb) return null

  if (dot({ x: nb.at.x - na.at.x, y: nb.at.y - na.at.y }, u) > 1e-6) {
    return tidyPath([...head, na.at, nb.at, ...tail])
  }
  // The segment would reverse: it collapses and the neighbors meet (D3).
  const denom = crossP(na.dir, nb.dir)
  if (Math.abs(denom) < 1e-12) return null
  const s = crossP({ x: pinB.x - pinA.x, y: pinB.y - pinA.y }, nb.dir) / denom
  const t = crossP({ x: pinB.x - pinA.x, y: pinB.y - pinA.y }, na.dir) / denom
  if (s < -1e-9 || t < -1e-9) return null
  const corner = { x: pinA.x + na.dir.x * s, y: pinA.y + na.dir.y * s }
  return tidyPath([...head, corner, ...tail])
}

/**
 * Corner drag (D5): both sides re-drawn as bends through the cursor, each
 * keeping the direction it left its pin in where the corner mode allows.
 */
function cornerDrag(path: readonly Pt[], i: number, cursor: Pt, mode: RouteCornerMode): Pt[] {
  const p = path[i - 1]
  const q = path[i + 1]
  if (mode === 'free') {
    return tidyPath([...path.slice(0, i), cursor, ...path.slice(i + 1)])
  }
  const fromPin = (pin: Pt, original: Pt): Pt[] => {
    const want = unit({ x: original.x - pin.x, y: original.y - pin.y })
    let chosen: Pt[] | null = null
    for (const diagFirst of [true, false]) {
      const bend = routeElbow(mode, diagFirst, pin, cursor)
      const first = unit({ x: bend[0].x - pin.x, y: bend[0].y - pin.y })
      if (Math.abs(first.x - want.x) < 1e-6 && Math.abs(first.y - want.y) < 1e-6) {
        chosen = bend
        break
      }
      chosen ??= bend
    }
    return chosen ?? [{ ...cursor }]
  }
  const toCursor = fromPin(p, path[i])
  const fromCursor = [...fromPin(q, path[i])].reverse().slice(1)
  return tidyPath([...path.slice(0, i), ...toCursor, ...fromCursor, { ...q }, ...path.slice(i + 2)])
}

/**
 * D11: the cursor of a drag pulled onto where the line already runs, within
 * `reach`. A dragged segment snaps into line with the segment beyond either
 * neighbour, where that runs the same way, so the neighbour between closes
 * up; a dragged corner snaps onto where two nearby segments' lines meet at a
 * gentle (135°) corner.
 */
export function snapDragCursor(path: readonly Pt[], grab: DragGrab, cursor: Pt, reach: number): Pt {
  const lineDistance = (p: Pt, a: Pt, b: Pt): number => {
    const u = unit({ x: b.x - a.x, y: b.y - a.y })
    return Math.abs(crossP({ x: p.x - a.x, y: p.y - a.y }, u))
  }
  if (grab.kind === 'segment') {
    const k = grab.index
    const u = unit({ x: path[k + 1].x - path[k].x, y: path[k + 1].y - path[k].y })
    let best: { at: Pt; d: number } | null = null
    for (const j of [k - 2, k + 2]) {
      if (j < 0 || j + 1 >= path.length) continue
      const v = unit({ x: path[j + 1].x - path[j].x, y: path[j + 1].y - path[j].y })
      if (Math.abs(crossP(u, v)) > 1e-6) continue
      const d = lineDistance(cursor, path[j], path[j + 1])
      if (d <= reach && (!best || d < best.d)) {
        // Onto that line, where the cursor is along it.
        const t = dot({ x: cursor.x - path[j].x, y: cursor.y - path[j].y }, v)
        best = { at: { x: path[j].x + v.x * t, y: path[j].y + v.y * t }, d }
      }
    }
    return best ? best.at : cursor
  }
  if (grab.kind === 'corner') {
    const i = grab.index
    let best: { at: Pt; d: number } | null = null
    for (let a = Math.max(0, i - 2); a <= Math.min(path.length - 2, i + 1); a++)
      for (let b = Math.max(0, i - 2); b < a; b++) {
        const ua = unit({ x: path[a + 1].x - path[a].x, y: path[a + 1].y - path[a].y })
        const ub = unit({ x: path[b + 1].x - path[b].x, y: path[b + 1].y - path[b].y })
        // Travelling one then the other turns 45°: a gentle corner.
        if (Math.abs(dot(ua, ub) - Math.SQRT1_2) > 1e-6) continue
        const hit = rayToLine(path[b], ub, path[a], ua)
        if (!hit) continue
        const d = Math.hypot(hit.at.x - cursor.x, hit.at.y - cursor.y)
        if (d <= reach && (!best || d < best.d)) best = { at: hit.at, d }
      }
    return best ? best.at : cursor
  }
  return cursor
}
