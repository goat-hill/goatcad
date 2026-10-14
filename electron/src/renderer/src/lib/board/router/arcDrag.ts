/**
 * Arc drag (docs/router-behavior.md D15): `D` on a track arc changes its
 * radius, the arc kept tangent to the lines either side, as KiCad's arc drag
 * does (`LINE::DragArc`).
 *
 * The two lines the arc joins are its tangents: where a straight track of
 * the line meets it running along that tangent, the track; else the arc's
 * own tangent from its end. They meet at the corner the arc rounds. The
 * dragged arc stays tangent to both, its middle where the cursor lies along
 * the corner's bisector: nearer the corner, a tighter arc. The tracks either
 * side are stretched or trimmed to the new tangent points; an end with no
 * track along its tangent keeps where it was, joined to the arc by a new
 * straight run — so it can only tighten. Pulled into the corner the arc
 * goes, and the corner is sharp.
 *
 * The collision mode applies as to a segment drag (KiCad's arc drag goes
 * through the same push and walk): Highlight marks what the arc comes too
 * near, and a drop that violates is refused (D9); Push pushes it aside with
 * the arc and its runs as the head, both far ends held; Avoid walks the line
 * round it. Where the push or walk bends the arc itself, the line lands as
 * straight track (P11's rule for a bent arc); elsewhere the arc is kept.
 */

import type { CopperItem, Pt } from '../spatialIndex'
import type { RouteCornerMode } from '../pcbTools'
import type { ObstacleQuery, RouterWorld } from './world'
import { arcPolyline, clearanceMarks, type RouteMode, type ViolationMark } from './engine'
import { samePt, tidyPath } from './geometry'
import { ShoveSession, type DisplacedPreview, type ShoveDelta, type ShoveOptions } from './shove'
import { walkAround } from './walkaround'

/** Chords an arc is judged, pushed and walked as. */
const ARC_PIECES = 16

/** What a drag leaves of the arc and its neighbours, scene mm. */
export interface ArcDragResult {
  /** The arc, or null where it closed up into the corner. */
  arc: { start: Pt; mid: Pt; end: Pt } | null
  /** The tracks either side, by board index, with their new ends. */
  neighbours: Array<{ index: number; start: Pt; end: Pt }>
  /** New straight runs from an end with no track along its tangent. */
  added: Array<{ start: Pt; end: Pt }>
}

/** The dragged line as it lands, far end to far end. */
export interface ArcDragLine {
  /** From the first far end to the arc; the whole line where the arc did not survive. */
  before: Pt[]
  /** The arc, where it is kept; null where it closed up or a push or walk bent it. */
  arc: { start: Pt; mid: Pt; end: Pt } | null
  /** From the arc to the second far end; empty where the arc did not survive. */
  after: Pt[]
}

export interface ArcDragUpdate {
  /** The drag's geometry with nothing pushed or walked: what Highlight and Ignore land. */
  result: ArcDragResult
  /** The line as the mode resolved it. */
  line: ArcDragLine
  /** The line, as straight pieces to draw. */
  pieces: Array<{ x0: number; y0: number; x1: number; y1: number; violation: boolean }>
  blocked: boolean
  violators: Array<{ type: string; index: number }>
  marks: ViolationMark[]
  /** The arc, its runs and what was pushed, hidden where they were. */
  hiddenRefs: Array<{ type: string; index: number }>
  /** Pushed copper, where it would go. */
  preview: DisplacedPreview
}

interface Side {
  /** The arc's end on this side. */
  end: Pt
  /** The track along the tangent here: its board index, and its far end. */
  track?: { index: number; far: Pt }
}

/** No arc of this central angle or more drags: its tangents do not meet ahead of it. */
const MAX_SWEEP = Math.PI - 1e-3

export class ArcDragSession {
  readonly net: number
  readonly width: number
  readonly layer: string
  private readonly world: RouterWorld
  private readonly corner: Pt | null
  private readonly sides: [Side, Side] | null
  /** Unit directions from the corner along each tangent, toward the arc. */
  private readonly dirs: [Pt, Pt] | null
  private readonly half: number
  private readonly shove: ShoveSession
  private last: ArcDragUpdate | null = null

  constructor(
    baseWorld: RouterWorld,
    readonly arc: CopperItem,
    private readonly clearance: number,
    options: ShoveOptions = {}
  ) {
    this.net = arc.net
    this.layer = arc.layers[0]
    const shape = arc.shape
    this.width = shape.kind === 'arc' ? shape.halfWidth * 2 : 0
    this.world = baseWorld.branch()
    this.world.remove(arc.id)
    this.shove = new ShoveSession(this.world, options)
    this.corner = null
    this.sides = null
    this.dirs = null
    this.half = 0
    if (shape.kind !== 'arc') return
    const p0 = { x: shape.x0, y: shape.y0 }
    const p1 = { x: shape.x1, y: shape.y1 }
    const mid = { x: shape.mx, y: shape.my }
    const c = circleThrough(p0, mid, p1)
    if (!c) return
    if (sweepOf(p0, mid, p1, c) >= MAX_SWEEP) return
    // The arc's own tangent at each end, pointing away from the arc.
    const out0 = tangentAway(p0, c, mid)
    const out1 = tangentAway(p1, c, mid)
    const side = (end: Pt, out: Pt): Side => {
      for (const item of baseWorld.itemsNear(end, this.width / 2, this.layer)) {
        const s = item.shape
        if (item.id === arc.id || item.net !== arc.net || item.ref.type !== 'segment') continue
        if (s.kind !== 'capsule' || Math.abs(s.halfWidth - this.width / 2) > 1e-6) continue
        const a = { x: s.x0, y: s.y0 }
        const b = { x: s.x1, y: s.y1 }
        const far = samePt(a, end) ? b : samePt(b, end) ? a : null
        if (!far) continue
        const along = unit({ x: far.x - end.x, y: far.y - end.y })
        if (
          Math.abs(along.x * out.y - along.y * out.x) < 1e-3 &&
          along.x * out.x + along.y * out.y > 0
        )
          return { end, track: { index: item.ref.index, far } }
      }
      return { end }
    }
    const s0 = side(p0, out0)
    const s1 = side(p1, out1)
    const t = lineMeet(p0, out0, p1, out1)
    if (!t) return
    this.corner = t
    this.sides = [s0, s1]
    this.dirs = [unit({ x: p0.x - t.x, y: p0.y - t.y }), unit({ x: p1.x - t.x, y: p1.y - t.y })]
    const cos = this.dirs[0].x * this.dirs[1].x + this.dirs[0].y * this.dirs[1].y
    this.half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2
    for (const s of this.sides)
      if (s.track) this.world.remove(this.trackId(baseWorld, s.track.index))
  }

  get valid(): boolean {
    return this.corner !== null
  }

  update(
    cursor: Pt,
    mode: RouteMode = 'highlight',
    cornerMode: RouteCornerMode = '45'
  ): ArcDragUpdate {
    const result = this.geometry(cursor)
    const q: ObstacleQuery = { layer: this.layer, excludeNet: this.net }
    const drawn = this.lineOf(result)
    const flat = flatten(drawn)
    let path = flat
    let world: RouterWorld = this.world
    if (mode === 'shove' && flat.length >= 2) {
      const r = this.shove.proposePath(
        [...flat],
        { layer: this.layer, width: this.width, clearance: this.clearance, net: this.net },
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
    } else {
      this.shove.dropHead()
      if (mode === 'walkaround' && flat.length >= 2) path = this.walk(flat, cornerMode) ?? flat
    }
    const line = path === flat ? drawn : survivingArc(path, drawn)
    const runs: Pt[][] = line.arc
      ? [
          line.before,
          arcPolyline(line.arc.start, line.arc.mid, line.arc.end, ARC_PIECES),
          line.after
        ]
      : [line.before]
    const violators = new Map<number, CopperItem>()
    const pieces: ArcDragUpdate['pieces'] = []
    for (const run of runs)
      for (let k = 0; k < run.length - 1; k++) {
        const hits = world.collisions(run[k], run[k + 1], this.width / 2, this.clearance, q)
        for (const h of hits) violators.set(h.item.id, h.item)
        pieces.push({
          x0: run[k].x,
          y0: run[k].y,
          x1: run[k + 1].x,
          y1: run[k + 1].y,
          violation: hits.length > 0
        })
      }
    const preview = this.shove.displaced()
    const update: ArcDragUpdate = {
      result,
      line,
      pieces,
      blocked: pieces.some((p) => p.violation),
      violators: [...violators.values()]
        .filter((item) => item.ref.index >= 0)
        .map((item) => ({ type: item.ref.type, index: item.ref.index })),
      marks: clearanceMarks(world, [...violators.values()], this.clearance, q),
      hiddenRefs: [...this.ownRefs(), ...preview.hiddenRefs],
      preview
    }
    this.last = update
    return update
  }

  /** Whether the last update left everything where it was (D7). */
  unchanged(): boolean {
    const last = this.last
    const s = this.arc.shape
    if (!last || !this.sides || s.kind !== 'arc') return true
    if (last.preview.segments.length > 0 || (last.preview.vias?.length ?? 0) > 0) return false
    const { arc, before, after } = last.line
    const p0 = { x: s.x0, y: s.y0 }
    const p1 = { x: s.x1, y: s.y1 }
    const run = (side: Side, end: Pt): Pt[] => (side.track ? [side.track.far, end] : [end])
    const same = (a: readonly Pt[], b: readonly Pt[]): boolean =>
      a.length === b.length && a.every((p, i) => samePt(p, b[i]))
    return (
      arc !== null &&
      samePt(arc.start, p0) &&
      samePt(arc.end, p1) &&
      same(before, run(this.sides[0], p0)) &&
      same(after, [...run(this.sides[1], p1)].reverse())
    )
  }

  /**
   * The last update's geometry with nothing pushed or walked, for the commit
   * of a Highlight or Ignore drag; null before one. `routerDelta` is the
   * commit in every mode.
   */
  delta(): (ArcDragResult & { blocked: boolean }) | null {
    return this.last ? { ...this.last.result, blocked: this.last.blocked } : null
  }

  /**
   * The commit in every mode, as a router diff: the arc and its runs replaced
   * by the line as it lands, and what was pushed; null before an update.
   */
  routerDelta(): (ShoveDelta & { blocked: boolean }) | null {
    const last = this.last
    if (!last) return null
    const pushed = this.shove.delta()
    const added = [...pushed.added]
    for (const run of [last.line.before, last.line.after])
      for (let k = 0; k < run.length - 1; k++)
        added.push({
          start: { ...run[k] },
          end: { ...run[k + 1] },
          width: this.width,
          layer: this.layer,
          net: this.net
        })
    const arcs = [...(pushed.addedArcs ?? [])]
    if (last.line.arc)
      arcs.push({ ...last.line.arc, width: this.width, layer: this.layer, net: this.net })
    return {
      removed: [...this.ownRefs(), ...pushed.removed],
      added,
      ...(arcs.length > 0 ? { addedArcs: arcs } : {}),
      movedVias: pushed.movedVias,
      blocked: last.blocked
    }
  }

  /** The arc and the tracks along its tangents, as board refs. */
  private ownRefs(): Array<{ type: string; index: number }> {
    return [
      { type: this.arc.ref.type, index: this.arc.ref.index },
      ...(this.sides ?? []).flatMap((s) =>
        s.track ? [{ type: 'segment', index: s.track.index }] : []
      )
    ]
  }

  /** The drag's geometry as a line, far end to far end. */
  private lineOf(result: ArcDragResult): ArcDragLine {
    const sides = this.sides
    if (!sides) return { before: [], arc: null, after: [] }
    const corner = this.corner ?? sides[0].end
    const pin = (side: Side): Pt => side.track?.far ?? side.end
    const before = dedupe([pin(sides[0]), result.arc?.start ?? corner])
    const after = dedupe([result.arc?.end ?? corner, pin(sides[1])])
    return result.arc
      ? { before, arc: result.arc, after }
      : { before: tidyPath([...before, ...after]), arc: null, after: [] }
  }

  /** Avoid: the line walked round what it meets, both far ends held; null when it cannot be. */
  private walk(path: Pt[], cornerMode: RouteCornerMode): Pt[] | null {
    const halfWidth = this.width / 2
    const q: ObstacleQuery = { layer: this.layer, excludeNet: this.net }
    if (!this.world.pathViolates(path, halfWidth, this.clearance, q)) {
      return path
    }
    const r = walkAround(this.world, path, {
      ...q,
      halfWidth,
      clearance: this.clearance,
      cornerMode
    })
    if (r.status !== 'done') return null
    const walked = tidyPath(r.path)
    if (!samePt(walked[walked.length - 1], path[path.length - 1])) return null
    return walked
  }

  /** The arc tangent to both lines whose middle lies where the cursor projects onto the bisector. */
  private geometry(cursor: Pt): ArcDragResult {
    const corner = this.corner
    const sides = this.sides
    const dirs = this.dirs
    const shape = this.arc.shape
    if (!corner || !sides || !dirs || shape.kind !== 'arc')
      return { arc: null, neighbours: [], added: [] }
    const bis = unit({ x: dirs[0].x + dirs[1].x, y: dirs[0].y + dirs[1].y })
    // How far the arc's middle lies from the corner, for a tangent length t:
    // t·(1 − sin h)/cos h, h the half-angle between the tangents.
    const perT = (1 - Math.sin(this.half)) / Math.cos(this.half)
    const along = (cursor.x - corner.x) * bis.x + (cursor.y - corner.y) * bis.y
    let t = Math.max(0, along) / perT
    // The tangent points stay on their lines: within a track's far end, or
    // no further from the corner than an end with no track along it.
    for (let i = 0; i < 2; i++) {
      const s = sides[i]
      const reach = s.track
        ? Math.hypot(s.track.far.x - corner.x, s.track.far.y - corner.y)
        : Math.hypot(s.end.x - corner.x, s.end.y - corner.y)
      t = Math.min(t, reach)
    }
    const at = (i: 0 | 1): Pt => ({ x: corner.x + dirs[i].x * t, y: corner.y + dirs[i].y * t })
    const q0 = at(0)
    const q1 = at(1)
    const neighbours: ArcDragResult['neighbours'] = []
    const added: ArcDragResult['added'] = []
    sides.forEach((s, i) => {
      const q = i === 0 ? q0 : q1
      if (s.track) neighbours.push({ index: s.track.index, start: s.track.far, end: q })
      else if (!samePt(s.end, q)) added.push({ start: s.end, end: q })
    })
    if (t < 1e-4) return { arc: null, neighbours, added }
    const r = t * Math.tan(this.half)
    const centerDist = t / Math.cos(this.half)
    const c = { x: corner.x + bis.x * centerDist, y: corner.y + bis.y * centerDist }
    const mid = { x: c.x - bis.x * r, y: c.y - bis.y * r }
    // Kept in the arc's own direction, start to end.
    return { arc: { start: q0, mid, end: q1 }, neighbours, added }
  }

  private trackId(world: RouterWorld, index: number): number {
    return (
      world.base.items.find((it) => it?.ref.type === 'segment' && it.ref.index === index)?.id ?? -1
    )
  }
}

/** A line as one polyline, its arc as chords. */
function flatten(line: ArcDragLine): Pt[] {
  if (!line.arc) return [...line.before]
  const chords = arcPolyline(line.arc.start, line.arc.mid, line.arc.end, ARC_PIECES)
  return dedupe([...line.before, ...chords, ...line.after])
}

/**
 * A pushed or walked line: where the arc's chords come through it unchanged,
 * the arc is kept and the line runs straight either side of it; where they do
 * not, the whole line is straight track.
 */
function survivingArc(path: Pt[], drawn: ArcDragLine): ArcDragLine {
  const arc = drawn.arc
  if (arc) {
    const chords = arcPolyline(arc.start, arc.mid, arc.end, ARC_PIECES)
    for (let i = 0; i + chords.length <= path.length; i++) {
      if (!chords.every((p, k) => samePt(p, path[i + k]))) continue
      return { before: path.slice(0, i + 1), arc, after: path.slice(i + chords.length - 1) }
    }
  }
  return { before: path, arc: null, after: [] }
}

const dedupe = (path: readonly Pt[]): Pt[] =>
  path.filter((p, i) => i === 0 || !samePt(p, path[i - 1]))

const unit = (v: Pt): Pt => {
  const l = Math.hypot(v.x, v.y) || 1
  return { x: v.x / l, y: v.y / l }
}

function circleThrough(a: Pt, b: Pt, c: Pt): Pt | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-12) return null
  const a2 = a.x * a.x + a.y * a.y
  const b2 = b.x * b.x + b.y * b.y
  const c2 = c.x * c.x + c.y * c.y
  return {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  }
}

/** The angle an arc a→mid→b sweeps about its center. */
function sweepOf(a: Pt, mid: Pt, b: Pt, c: Pt): number {
  const ang = (p: Pt): number => Math.atan2(p.y - c.y, p.x - c.x)
  const norm = (x: number): number => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const toMid = norm(ang(mid) - ang(a))
  const toEnd = norm(ang(b) - ang(a))
  return toMid <= toEnd ? toEnd : 2 * Math.PI - toEnd
}

/** The tangent at an arc's end, pointing away from the arc (away from its middle). */
function tangentAway(end: Pt, c: Pt, mid: Pt): Pt {
  const radial = { x: end.x - c.x, y: end.y - c.y }
  const t = unit({ x: -radial.y, y: radial.x })
  const toMid = { x: mid.x - end.x, y: mid.y - end.y }
  return t.x * toMid.x + t.y * toMid.y > 0 ? { x: -t.x, y: -t.y } : t
}

/** Where the lines through `a` along `u` and through `b` along `v` meet, behind both ends. */
function lineMeet(a: Pt, u: Pt, b: Pt, v: Pt): Pt | null {
  const denom = u.x * v.y - u.y * v.x
  if (Math.abs(denom) < 1e-12) return null
  const s = ((b.x - a.x) * v.y - (b.y - a.y) * v.x) / denom
  return { x: a.x + u.x * s, y: a.y + u.y * s }
}
