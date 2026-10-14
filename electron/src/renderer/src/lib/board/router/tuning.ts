/**
 * Length and skew tuning (docs/router-behavior.md T1–T6), as KiCad's tuner
 * works (`MEANDER_PLACER`, `DP_MEANDER_PLACER`, `MEANDER_SKEW_PLACER`, and the
 * tuning pattern it saves): along the line through the clicked track, from
 * where it was clicked to where the cursor lies along it, meanders on the
 * cursor's side of each straight stretch bring the net to its target length —
 * a pair's two halves together over each stretch they run coupled, by its
 * longer half, or the shorter half of a pair to its partner (skew). Arcs pass
 * through as they are.
 */

import type { CopperItem, Pt } from '../spatialIndex'
import { nextOverlayId, type ObstacleQuery, type RouterWorld } from './world'
import { clearanceMarks, type ViolationMark } from './engine'
import { offsetPath } from './diffPair'
import { assembleLine } from './lines'
import { meanderParts, piecesLength, type MeanderPiece, type MeanderSettings } from './meander'

export type TuneMode = 'single' | 'pair' | 'skew'

/** A target as KiCad's constraints give it, mm: a length, or (skew) a difference between halves. */
export interface TuneTarget {
  min: number
  opt: number
  max: number
}

/** What the tuner reads as the result, as KiCad's pattern records it. */
export type TuneStatus = 'tuned' | 'too_short' | 'too_long'

/** A point of a line's path; with `mid`, the arc to it from the point before runs through `mid`. */
export interface LinePoint {
  x: number
  y: number
  mid?: Pt
}

export interface TunedLine {
  net: number
  width: number
  layer: string
  /** The board tracks and arcs this replaces: those of its line the tune reaches. */
  replaces: Array<{ type: string; index: number }>
  pieces: MeanderPiece[]
  /** The pieces the pattern holds, `[from, to)`: the leads either side stay plain track, as KiCad's do. */
  span: [number, number]
  violations: boolean[]
}

export interface TuneUpdate {
  /** The tuned net. */
  net: number
  /** Each line the tune rewrites: the tuned one, and a pair's other half. None where nothing is laid. */
  lines: TunedLine[]
  /** The net's length after, mm (a pair: its longer half's, as KiCad's; skew: the tuned half's). */
  length: number
  /** Skew mode: the tuned half less its partner after, mm. */
  skew?: number
  target: TuneTarget
  status: TuneStatus
  blocked: boolean
  violators: Array<{ type: string; index: number }>
  marks: ViolationMark[]
  /** What KiCad's `tuning_pattern` records of where the meanders lie. */
  pattern: {
    origin: Pt
    end: Pt
    base: LinePoint[]
    baseCoupled?: LinePoint[]
    side: 'left' | 'right'
  }
}

/** A line the tuner works along: its pieces in order, and the board track each one is. */
export interface TuneLine {
  net: number
  width: number
  layer: string
  parts: MeanderPiece[]
  /** Each part's board track; null where it is not on the board (a pattern's run, re-tuned). */
  refs: Array<{ type: string; index: number } | null>
  /** The world's ids of its tracks. */
  ids: number[]
}

/** The line through a track (KiCad's `AssembleLine`), through the arcs it meets; null for no track. */
export function tuneLineOf(world: RouterWorld, seed: CopperItem): TuneLine | null {
  const s = seed.shape
  const straight = seed.ref.type === 'segment' && s.kind === 'capsule'
  if (!straight && !(seed.ref.type === 'tarc' && s.kind === 'arc')) return null
  const line = assembleLine(world, seed, { arcs: true })
  if (line.path.length < 2) return null
  const arcs = new Map((line.arcs ?? []).map((arc) => [arc.from, arc]))
  const parts: MeanderPiece[] = []
  for (let k = 0; k < line.path.length - 1;) {
    const arc = arcs.get(k)
    if (arc) {
      parts.push({ a: line.path[k], b: line.path[arc.to], mid: arc.mid })
      k = arc.to
    } else {
      parts.push({ a: line.path[k], b: line.path[k + 1] })
      k++
    }
  }
  const refs = parts.map((p, i) => {
    const probe = p.mid ?? { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }
    const item = world.itemsNear(probe, 1e-3, line.layer).find((it) => it.id === line.ids[i])
    return item && item.ref.index >= 0 ? { type: item.ref.type, index: item.ref.index } : null
  })
  return {
    net: seed.net,
    width: s.halfWidth * 2,
    layer: line.layer,
    parts,
    refs,
    ids: line.ids
  }
}

/** A line given as its path: a pattern's run, re-tuned, which is on the board nowhere. */
export function tuneLineFrom(
  path: readonly LinePoint[],
  net: number,
  width: number,
  layer: string
): TuneLine {
  const parts = path.slice(1).map((p, i) => ({
    a: { x: path[i].x, y: path[i].y },
    b: { x: p.x, y: p.y },
    ...(p.mid ? { mid: p.mid } : {})
  }))
  return { net, width, layer, parts, refs: parts.map(() => null), ids: [] }
}

// --- Walking a line by how far along it a point lies (its arcs by their sweep).

interface ArcGeom {
  c: Pt
  r: number
  a0: number
  sweep: number
}

function arcGeom(p: MeanderPiece): ArcGeom {
  const { a, b } = p
  const m = p.mid!
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y))
  const sa = a.x * a.x + a.y * a.y
  const sm = m.x * m.x + m.y * m.y
  const sb = b.x * b.x + b.y * b.y
  const c = {
    x: (sa * (m.y - b.y) + sm * (b.y - a.y) + sb * (a.y - m.y)) / d,
    y: (sa * (b.x - m.x) + sm * (a.x - b.x) + sb * (m.x - a.x)) / d
  }
  const ang = (q: Pt): number => Math.atan2(q.y - c.y, q.x - c.x)
  const norm = (x: number): number => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const a0 = ang(a)
  // The way round that passes the middle.
  const ccw = norm(ang(b) - a0)
  const sweep = norm(ang(m) - a0) <= ccw ? ccw : ccw - 2 * Math.PI
  return { c, r: Math.hypot(a.x - c.x, a.y - c.y), a0, sweep }
}

const partLength = (p: MeanderPiece): number => piecesLength([p])

/** Where along a part `t` mm from its start lies. */
function pointOnPart(p: MeanderPiece, t: number): Pt {
  if (!p.mid) {
    const l = partLength(p) || 1
    return { x: p.a.x + ((p.b.x - p.a.x) * t) / l, y: p.a.y + ((p.b.y - p.a.y) * t) / l }
  }
  const g = arcGeom(p)
  const angle = g.a0 + (g.sweep * t) / (Math.abs(g.sweep) * g.r || 1)
  return { x: g.c.x + g.r * Math.cos(angle), y: g.c.y + g.r * Math.sin(angle) }
}

/** How far along a part, mm, the point on it nearest `q` lies, and how far off it `q` is. */
function projectOnPart(p: MeanderPiece, q: Pt): { t: number; d: number } {
  if (!p.mid) {
    const dx = p.b.x - p.a.x
    const dy = p.b.y - p.a.y
    const l = Math.hypot(dx, dy) || 1
    const t = Math.max(0, Math.min(l, ((q.x - p.a.x) * dx + (q.y - p.a.y) * dy) / l))
    const at = pointOnPart(p, t)
    return { t, d: Math.hypot(at.x - q.x, at.y - q.y) }
  }
  const g = arcGeom(p)
  let rel = Math.atan2(q.y - g.c.y, q.x - g.c.x) - g.a0
  const dir = Math.sign(g.sweep) || 1
  rel = ((((rel * dir) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * dir
  const len = Math.abs(g.sweep) * g.r
  // Past either end, the nearer one.
  let t = (rel / g.sweep) * len
  if (t > len) {
    const toEnd = Math.abs(rel) - Math.abs(g.sweep)
    t = toEnd < 2 * Math.PI - Math.abs(rel) ? len : 0
  }
  const at = pointOnPart(p, t)
  return { t, d: Math.hypot(at.x - q.x, at.y - q.y) }
}

/** Each part's start, mm along the line, and the line's length last. */
function starts(line: TuneLine): number[] {
  const out = [0]
  for (const p of line.parts) out.push(out[out.length - 1] + partLength(p))
  return out
}

/** How far along the line, mm, the point on it nearest `q` lies. */
function projectOnLine(line: TuneLine, at: readonly number[], q: Pt): number {
  let best = { s: 0, d: Infinity }
  line.parts.forEach((p, i) => {
    const { t, d } = projectOnPart(p, q)
    if (d < best.d - 1e-12) best = { s: at[i] + t, d }
  })
  return best.s
}

/** The part `s` mm along the line lies on, and how far along it; at a joint, the part `prefer` says. */
function locate(
  at: readonly number[],
  s: number,
  prefer: 'next' | 'prev'
): { i: number; t: number } {
  const n = at.length - 1
  for (let i = 0; i < n; i++) {
    const inside =
      prefer === 'next' ? s < at[i + 1] - 1e-9 || i === n - 1 : s <= at[i + 1] + 1e-9 || i === n - 1
    if (inside) return { i, t: Math.max(0, Math.min(at[i + 1] - at[i], s - at[i])) }
  }
  return { i: n - 1, t: at[n] - at[n - 1] }
}

/** The line's own pieces between `s0` and `s1` mm along it; an arc is taken whole where it is met. */
function between(line: TuneLine, at: readonly number[], s0: number, s1: number): MeanderPiece[] {
  const out: MeanderPiece[] = []
  line.parts.forEach((p, i) => {
    const lo = Math.max(s0, at[i])
    const hi = Math.min(s1, at[i + 1])
    if (hi - lo <= 1e-9) return
    if (p.mid) out.push({ ...p })
    else out.push({ a: pointOnPart(p, lo - at[i]), b: pointOnPart(p, hi - at[i]) })
  })
  return out
}

/** `s` moved out of any arc it lies inside, to the arc's start (`'start'`) or end. */
function offArcs(line: TuneLine, at: readonly number[], s: number, to: 'start' | 'end'): number {
  for (let i = 0; i < line.parts.length; i++)
    if (line.parts[i].mid && s > at[i] + 1e-9 && s < at[i + 1] - 1e-9)
      return to === 'start' ? at[i] : at[i + 1]
  return s
}

/** What a tune lays over a stretch of its line, `s0` to `s1` mm along it. */
interface Replacement {
  s0: number
  s1: number
  pieces: MeanderPiece[]
}

/**
 * A line with its replacements laid in: the tracks they reach, rewritten from
 * the first such track's start to the last one's end, the stretches between
 * as they were; the pattern holds the first replacement to the last.
 */
function splice(
  line: TuneLine,
  at: readonly number[],
  reps: readonly Replacement[]
): Pick<TunedLine, 'pieces' | 'span' | 'replaces'> & { added: number } {
  const sorted = [...reps].sort((a, b) => a.s0 - b.s0)
  const first = locate(at, sorted[0].s0, 'next').i
  const last = locate(at, sorted[sorted.length - 1].s1, 'prev').i
  const pieces: MeanderPiece[] = []
  let s = at[first]
  let from = -1
  let added = 0
  for (const rep of sorted) {
    pieces.push(...between(line, at, s, rep.s0))
    if (from < 0) from = pieces.length
    pieces.push(...rep.pieces)
    added += piecesLength(rep.pieces) - piecesLength(between(line, at, rep.s0, rep.s1))
    s = rep.s1
  }
  const to = pieces.length
  pieces.push(...between(line, at, s, at[last + 1]))
  const replaces = line.refs
    .slice(first, last + 1)
    .filter((r): r is { type: string; index: number } => r !== null)
  return { pieces, span: [from, to], replaces, added }
}

/** A line's path as KiCad's pattern records its base line: points, an arc's through its middle. */
const pathOf = (pieces: readonly MeanderPiece[]): LinePoint[] =>
  pieces.length === 0
    ? []
    : [
        { x: pieces[0].a.x, y: pieces[0].a.y },
        ...pieces.map((p) => ({ x: p.b.x, y: p.b.y, ...(p.mid ? { mid: p.mid } : {}) }))
      ]

/** Which side of a straight part a point lies: +1 its left. */
const sideOf = (p: MeanderPiece, q: Pt): 1 | -1 =>
  (p.b.x - p.a.x) * (q.y - p.a.y) - (p.b.y - p.a.y) * (q.x - p.a.x) >= 0 ? 1 : -1

/** A pair's two lines run coupled over a stretch: the seed's, and its partner's beside it. */
interface Coupled {
  /** The seed's part, and how far along the seed's line the stretch runs. */
  part: number
  s0: number
  s1: number
  /** The stretch on the partner's line, mm along it. */
  m0: number
  m1: number
  /** From the seed's line to the centerline between the two. */
  shift: Pt
}

export class TuneSession {
  private readonly line: TuneLine | null
  private readonly mateLine: TuneLine | null
  private readonly at: number[]
  private readonly mateAt: number[]
  private readonly origin: number
  /** A pair: half the distance between its two lines' centers. */
  private readonly offset: number
  private readonly world: RouterWorld
  private settings: MeanderSettings

  constructor(
    baseWorld: RouterWorld,
    seed: CopperItem | null,
    grab: Pt,
    private readonly opts: {
      mode: TuneMode
      settings: MeanderSettings
      target: TuneTarget
      clearance: number
      /** The tuned track's length now, mm, as T2 measures it (pair: the seed's half). */
      length: number
      /** Pair and skew: the other half's track beside this one, and its net's length. */
      mate?: CopperItem
      mateLength?: number
      /** The side the first bump takes, held (a pattern re-tuned); else the cursor's (T1). */
      side?: 1 | -1
      /** The line to tune, and a pair's other, where they are not the board's (a pattern re-tuned). */
      line?: TuneLine
      mateLine?: TuneLine
    }
  ) {
    this.world = baseWorld.branch()
    this.line = opts.line ?? (seed ? tuneLineOf(this.world, seed) : null)
    this.mateLine =
      opts.mode !== 'pair'
        ? null
        : (opts.mateLine ?? (opts.mate ? tuneLineOf(this.world, opts.mate) : null))
    this.at = this.line ? starts(this.line) : [0]
    this.mateAt = this.mateLine ? starts(this.mateLine) : [0]
    this.origin = this.line ? projectOnLine(this.line, this.at, grab) : 0
    for (const id of [...(this.line?.ids ?? []), ...(this.mateLine?.ids ?? [])])
      this.world.remove(id)
    this.offset = this.line && this.mateLine ? this.pairOffset(grab) : 0
    this.settings = opts.settings
  }

  get valid(): boolean {
    if (!this.line) return false
    if (this.opts.mode === 'single') return true
    if (this.opts.mode === 'skew')
      return this.opts.mate !== undefined || this.opts.mateLength !== undefined
    return this.mateLine !== null && this.offset > 0
  }

  get net(): number {
    return this.line?.net ?? 0
  }

  get layer(): string {
    return this.line?.layer ?? ''
  }

  /** What the meanders bring the net to from here on (T6's in-tool settings). */
  get target(): TuneTarget {
    return this.opts.target
  }
  set target(target: TuneTarget) {
    this.opts.target = target
  }

  /** The meanders' shape from here on (T1's keys, T6). */
  get meanderSettings(): MeanderSettings {
    return this.settings
  }
  set meanderSettings(settings: MeanderSettings) {
    this.settings = settings
  }

  /** The least spacing the meanders take: the track's width plus clearance. */
  get spacingFloor(): number {
    return (this.line?.width ?? 0) + this.opts.clearance
  }

  update(cursor: Pt): TuneUpdate {
    const line = this.line!
    const end = projectOnLine(line, this.at, cursor)
    const lo = offArcs(line, this.at, Math.min(this.origin, end), 'start')
    const hi = offArcs(line, this.at, Math.max(this.origin, end), 'end')
    return this.opts.mode === 'pair'
      ? this.pair(line, this.mateLine!, lo, hi, cursor)
      : this.single(line, lo, hi, cursor)
  }

  /** The first side of each part's bumps: held, else the cursor's side of it (KiCad's). */
  private sides(parts: readonly MeanderPiece[], cursor: Pt): Array<1 | -1> {
    return parts.map((p) => this.opts.side ?? (p.mid ? 1 : sideOf(p, cursor)))
  }

  private single(line: TuneLine, lo: number, hi: number, cursor: Pt): TuneUpdate {
    const { target, clearance } = this.opts
    const settings = this.settings
    const skew = this.opts.mode === 'skew'
    const now = skew ? this.opts.length - (this.opts.mateLength ?? 0) : this.opts.length
    const extra = Number.isFinite(target.opt) ? target.opt - now : Infinity
    const q: ObstacleQuery = { layer: line.layer, excludeNet: line.net }
    const spacing = Math.max(settings.spacing, line.width + clearance)
    const tuned = between(line, this.at, lo, hi)
    const sides = this.sides(tuned, cursor)
    const m =
      extra > 1e-9
        ? meanderParts(
            tuned,
            extra,
            {
              ...settings,
              spacing,
              // KiCad's: a rounded bump at least a track width tall, so its corners fit.
              minAmplitude:
                settings.cornerRadiusPercent > 0
                  ? Math.max(settings.minAmplitude, line.width)
                  : settings.minAmplitude
            },
            (bump) => !this.world.pathViolates(bump, line.width / 2, clearance, q),
            { width: line.width, selfClearance: line.width + clearance },
            sides
          )
        : { pieces: tuned, perPart: tuned.map((p) => [p]), added: 0, bumps: 0 }
    const spliced = splice(line, this.at, [{ s0: lo, s1: hi, pieces: m.pieces }])
    const judged = this.judge(spliced.pieces, line.width, q)
    const after = now + spliced.added
    const origin = pointOnPart(
      line.parts[locate(this.at, lo, 'next').i],
      locate(this.at, lo, 'next').t
    )
    const endAt = locate(this.at, hi, 'prev')
    return {
      net: line.net,
      lines: [
        {
          net: line.net,
          width: line.width,
          layer: line.layer,
          replaces: spliced.replaces,
          pieces: spliced.pieces,
          span: spliced.span,
          violations: judged.flags
        }
      ],
      length: skew ? this.opts.length + (after - now) : after,
      ...(skew ? { skew: after } : {}),
      target,
      status: statusOf(after, target),
      blocked: judged.flags.some(Boolean),
      violators: judged.violators,
      marks: judged.marks,
      pattern: {
        origin,
        end: pointOnPart(line.parts[endAt.i], endAt.t),
        base: pathOf(tuned),
        side: (sides[0] ?? 1) === 1 ? 'left' : 'right'
      }
    }
  }

  /** Half the distance between a pair's lines where it was grabbed: each half's offset from the centerline. */
  private pairOffset(grab: Pt): number {
    const line = this.line!
    const mate = this.mateLine!
    const at = locate(this.at, projectOnLine(line, this.at, grab), 'next')
    const p = line.parts[at.i]
    if (p.mid) return 0
    const here = pointOnPart(p, at.t)
    // Square across to each parallel track of the partner's, wherever along it that lands.
    const there = mate.parts
      .filter((m) => !m.mid && parallel(p, m))
      .map((m) => {
        const l = partLength(m) || 1
        return Math.abs(
          ((here.x - m.a.x) * (m.b.y - m.a.y) - (here.y - m.a.y) * (m.b.x - m.a.x)) / l
        )
      })
      .sort((a, b) => a - b)[0]
    return there !== undefined ? there / 2 : 0
  }

  /** The stretches of the seed's line between `lo` and `hi` its partner runs beside, at the pair's distance. */
  private coupled(line: TuneLine, mate: TuneLine, lo: number, hi: number): Coupled[] {
    const d2 = 2 * this.offset
    const out: Coupled[] = []
    line.parts.forEach((p, i) => {
      if (p.mid) return
      const s0 = Math.max(lo, this.at[i])
      const s1 = Math.min(hi, this.at[i + 1])
      if (s1 - s0 <= 1e-9) return
      const len = partLength(p)
      const u = { x: (p.b.x - p.a.x) / len, y: (p.b.y - p.a.y) / len }
      const along = (q: Pt): number => this.at[i] + (q.x - p.a.x) * u.x + (q.y - p.a.y) * u.y
      const runs: Array<{ a: number; b: number; shift: Pt }> = []
      mate.parts.forEach((m) => {
        if (m.mid || !parallel(p, m)) return
        const off = (m.a.x - p.a.x) * -u.y + (m.a.y - p.a.y) * u.x
        if (Math.abs(Math.abs(off) - d2) > 1e-3) return
        const a = Math.max(s0, Math.min(along(m.a), along(m.b)))
        const b = Math.min(s1, Math.max(along(m.a), along(m.b)))
        if (b - a > 1e-9) runs.push({ a, b, shift: { x: (-u.y * off) / 2, y: (u.x * off) / 2 } })
      })
      runs.sort((x, y) => x.a - y.a)
      // A partner split into tracks in line runs on as one stretch.
      const merged: typeof runs = []
      for (const r of runs) {
        const prev = merged[merged.length - 1]
        if (prev && r.a - prev.b < 1e-6) prev.b = Math.max(prev.b, r.b)
        else merged.push({ ...r })
      }
      for (const r of merged) {
        const from = pointOnPart(p, r.a - this.at[i])
        const to = pointOnPart(p, r.b - this.at[i])
        const mfrom = { x: from.x + 2 * r.shift.x, y: from.y + 2 * r.shift.y }
        const mto = { x: to.x + 2 * r.shift.x, y: to.y + 2 * r.shift.y }
        const m0 = projectOnLine(mate, this.mateAt, mfrom)
        const m1 = projectOnLine(mate, this.mateAt, mto)
        out.push({ part: i, s0: r.a, s1: r.b, m0, m1, shift: r.shift })
      }
    })
    return out
  }

  /** PR + T5: the pair's centerline meandered over each stretch it runs coupled, each half its offset. */
  private pair(line: TuneLine, mate: TuneLine, lo: number, hi: number, cursor: Pt): TuneUpdate {
    const { target, clearance } = this.opts
    const settings = this.settings
    const d = this.offset
    const stretches = this.coupled(line, mate, lo, hi)
    // The pair is as long as its longer half (KiCad's `DP_MEANDER_PLACER`).
    const before = Math.max(this.opts.length, this.opts.mateLength ?? 0)
    const extra = Number.isFinite(target.opt) ? target.opt - before : Infinity
    const qP: ObstacleQuery = {
      layer: line.layer,
      excludeNet: line.net,
      filter: (i) => i.net !== mate.net
    }
    // KiCad's (`MEANDER_SHAPE::spacing`): the halves of neighboring legs a track and clearance apart.
    const spacing = Math.max(settings.spacing, line.width + clearance + 2 * d)
    const rounded = settings.cornerRadiusPercent > 0
    // Tall enough that a bump's corners, each at least the offset, share its leg.
    const centerSettings = {
      ...settings,
      spacing,
      minAmplitude: Math.max(settings.minAmplitude, 2 * d)
    }
    const centers = stretches.map((c) => {
      const p = line.parts[c.part]
      const a = pointOnPart(p, c.s0 - this.at[c.part])
      const b = pointOnPart(p, c.s1 - this.at[c.part])
      return {
        a: { x: a.x + c.shift.x, y: a.y + c.shift.y },
        b: { x: b.x + c.shift.x, y: b.y + c.shift.y }
      }
    })
    // Each stretch's halves: the seed's toward −shift from the centerline.
    const seedSides = stretches.map((c, k) => {
      const u = { x: centers[k].b.x - centers[k].a.x, y: centers[k].b.y - centers[k].a.y }
      return u.x * -c.shift.y - u.y * -c.shift.x >= 0 ? 1 : -1
    })
    const m =
      extra > 1e-9 && centers.length > 0
        ? meanderParts(
            centers,
            extra,
            centerSettings,
            // Either half of the bump, each held at the wider track's width.
            (bump) =>
              [d, -d].every(
                (off) =>
                  !this.world.pathViolates(
                    offsetPath(bump, off),
                    Math.max(line.width, mate.width) / 2,
                    clearance,
                    qP
                  )
              ),
            { width: line.width, offset: d, selfClearance: line.width + clearance + 2 * d },
            this.sides(centers, cursor)
          )
        : { pieces: centers, perPart: centers.map((c) => [c]), added: 0, bumps: 0 }
    // Rounded, each half runs concentric with the centerline's arcs (KiCad's);
    // square, its corners are mitred.
    const halfOf = (pieces: MeanderPiece[], off: number): MeanderPiece[] =>
      rounded
        ? offsetPieces(pieces, off)
        : asPieces(offsetPath([pieces[0].a, ...pieces.map((p) => p.b)], off))
    const seedReps: Replacement[] = []
    const mateReps: Replacement[] = []
    stretches.forEach((c, i) => {
      const center = m.perPart[i]
      seedReps.push({ s0: c.s0, s1: c.s1, pieces: halfOf(center, seedSides[i] * d) })
      const half = halfOf(center, -seedSides[i] * d)
      // The partner's line may run the other way.
      const forward = c.m1 >= c.m0
      mateReps.push({
        s0: Math.min(c.m0, c.m1),
        s1: Math.max(c.m0, c.m1),
        pieces: forward ? half : reversed(half)
      })
    })
    const origin = pointOnPart(
      line.parts[locate(this.at, lo, 'next').i],
      locate(this.at, lo, 'next').t
    )
    const endAt = locate(this.at, hi, 'prev')
    const end = pointOnPart(line.parts[endAt.i], endAt.t)
    const side = (this.sides(centers, cursor)[0] ?? 1) === 1 ? 'left' : 'right'
    if (stretches.length === 0)
      return {
        net: line.net,
        lines: [],
        length: before,
        target,
        status: statusOf(before, target),
        blocked: false,
        violators: [],
        marks: [],
        pattern: { origin, end, base: pathOf(between(line, this.at, lo, hi)), side }
      }
    const seedOut = splice(line, this.at, seedReps)
    const mateOut = splice(mate, this.mateAt, mateReps)
    const js = this.judge(seedOut.pieces, line.width, qP)
    const jm = this.judge(mateOut.pieces, mate.width, {
      ...qP,
      excludeNet: mate.net,
      filter: (i) => i.net !== line.net
    })
    const after = Math.max(
      this.opts.length + seedOut.added,
      (this.opts.mateLength ?? 0) + mateOut.added
    )
    const mLo = Math.min(...mateReps.map((r) => r.s0))
    const mHi = Math.max(...mateReps.map((r) => r.s1))
    return {
      net: line.net,
      lines: [
        {
          net: line.net,
          width: line.width,
          layer: line.layer,
          pieces: seedOut.pieces,
          span: seedOut.span,
          replaces: seedOut.replaces,
          violations: js.flags
        },
        {
          net: mate.net,
          width: mate.width,
          layer: mate.layer,
          pieces: mateOut.pieces,
          span: mateOut.span,
          replaces: mateOut.replaces,
          violations: jm.flags
        }
      ],
      length: after,
      target,
      status: statusOf(after, target),
      blocked: [...js.flags, ...jm.flags].some(Boolean),
      violators: [...js.violators, ...jm.violators],
      marks: [...js.marks, ...jm.marks],
      pattern: {
        origin,
        end,
        base: pathOf(between(line, this.at, lo, hi)),
        baseCoupled: pathOf(between(mate, this.mateAt, mLo, mHi)),
        side
      }
    }
  }

  private judge(
    pieces: readonly MeanderPiece[],
    width: number,
    q: ObstacleQuery
  ): { flags: boolean[]; violators: TuneUpdate['violators']; marks: ViolationMark[] } {
    const hits = new Map<number, CopperItem>()
    const flags = pieces.map((p) => {
      const h = this.world.collisions(p.a, p.mid ?? p.b, width / 2, this.opts.clearance, q)
      const h2 = p.mid ? this.world.collisions(p.mid, p.b, width / 2, this.opts.clearance, q) : []
      for (const x of [...h, ...h2]) hits.set(x.item.id, x.item)
      return h.length + h2.length > 0
    })
    const items = [...hits.values()]
    return {
      flags,
      violators: items
        .filter((i) => i.ref.index >= 0)
        .map((i) => ({ type: i.ref.type, index: i.ref.index })),
      marks: clearanceMarks(this.world, items, this.opts.clearance, q)
    }
  }
}

const parallel = (p: MeanderPiece, m: MeanderPiece): boolean => {
  const lp = partLength(p) || 1
  const lm = partLength(m) || 1
  const cross =
    ((p.b.x - p.a.x) / lp) * ((m.b.y - m.a.y) / lm) -
    ((p.b.y - p.a.y) / lp) * ((m.b.x - m.a.x) / lm)
  return Math.abs(cross) < 1e-6
}

const asPieces = (path: Pt[]): MeanderPiece[] => path.slice(1).map((p, i) => ({ a: path[i], b: p }))

const reversed = (pieces: readonly MeanderPiece[]): MeanderPiece[] =>
  [...pieces].reverse().map((p) => ({ a: p.b, b: p.a, ...(p.mid ? { mid: p.mid } : {}) }))

/** A run a tuning pattern replaced, scene mm: its net's track back where the meanders were. */
export interface PatternRun {
  net: number
  layer: string
  width: number
  /** Its path, an arc's point carrying its middle. */
  path: LinePoint[]
  /** The tuned length through this run in place of the pattern's tracks, mm (T2). */
  length: number
}

/** What a pattern on the board is re-tuned from (T4). */
export interface PatternRetune {
  mode: TuneMode
  /** The pattern's tracks, taken off before it is laid again. */
  tracks: readonly CopperItem[]
  /** The tuned half's run first; a pair's other half's second. */
  runs: readonly PatternRun[]
  /** Skew: the partner track, which the tune measures against and leaves alone. */
  mate?: CopperItem
  mateLength?: number
  /** Where the meanders run from and to, along the run. */
  origin: Pt
  end: Pt
  side: 1 | -1
  settings: MeanderSettings
  target: TuneTarget
  clearance: number
}

/**
 * A tuning pattern laid again, as KiCad regenerates one when its settings or
 * handles change (T4): its tracks taken back to the run they replaced, and
 * the tuner run over it from the pattern's origin to its end, on its side.
 * Null when the run is not one the tuner takes.
 */
export function retunePattern(world: RouterWorld, r: PatternRetune): TuneUpdate | null {
  const [run, coupled] = r.runs
  if (!run || run.path.length < 2 || (r.mode === 'pair' && (!coupled || coupled.path.length < 2)))
    return null
  const branch = world.branch()
  for (const track of r.tracks) branch.remove(track.id)
  const line = tuneLineFrom(run.path, run.net, run.width, run.layer)
  const mateLine = coupled
    ? tuneLineFrom(coupled.path, coupled.net, coupled.width, coupled.layer)
    : undefined
  const session = new TuneSession(branch, null, r.origin, {
    mode: r.mode,
    settings: r.settings,
    target: r.target,
    clearance: r.clearance,
    length: run.length,
    side: r.side,
    line,
    ...(mateLine ? { mateLine, mateLength: coupled!.length } : {}),
    ...(r.mode === 'skew' ? { mate: r.mate, mateLength: r.mateLength ?? 0 } : {})
  })
  return session.valid ? session.update(r.end) : null
}

/** The tolerance either side of a target nothing else bounds, mm (KiCad's `DEFAULT_LENGTH_TOLERANCE`). */
const TYPED_TOLERANCE = 0.1

/**
 * The target a tune works to (T2, T5), as KiCad's tuner picks it: the net's
 * rule, unless *override custom rules* is on or there is none; then a typed
 * value; else none — every bump as tall as it may be, or a skew of nothing.
 * A rule is read as KiCad's `MEANDER_SETTINGS` reads a constraint: its opt,
 * else its min, else nothing (a max alone sets no target), and either side it
 * leaves open 0.1 mm from that opt (`DEFAULT_LENGTH_TOLERANCE`).
 */
export function tuneTargetOf(
  mode: TuneMode,
  typed: number | null,
  rule: TuneRule | null,
  overrideCustomRules = false,
  time: TuneTimeScale | null = null
): TuneTarget {
  const ruled =
    rule !== null &&
    (rule.opt !== undefined || rule.min !== undefined || rule.max !== undefined) &&
    // A rule in ps is held through the layer's delay; with none to read it by, no rule.
    (!rule.timeDomain || time !== null)
  // KiCad's dialog: a typed target that is the rule's own opt keeps the rule's bounds.
  const typedIsRule =
    ruled &&
    !rule.timeDomain &&
    typed !== null &&
    Math.abs(typed - (rule.opt ?? rule.min ?? 0)) < 1e-9
  if (!ruled || (overrideCustomRules && !typedIsRule)) {
    if (typed !== null)
      return { min: typed - TYPED_TOLERANCE, opt: typed, max: typed + TYPED_TOLERANCE }
    return mode === 'skew'
      ? { min: -TYPED_TOLERANCE, opt: 0, max: TYPED_TOLERANCE }
      : { min: 0, opt: Infinity, max: Infinity }
  }
  // KiCad's delay tolerance is 0.1 ps where its length one is 0.1 mm (`DEFAULT_DELAY_TOLERANCE`).
  const opt = rule.opt ?? rule.min ?? 0
  const bounds = {
    min: rule.min ?? opt - TYPED_TOLERANCE,
    opt,
    max: rule.max ?? opt + TYPED_TOLERANCE
  }
  if (!rule.timeDomain || !time) return bounds
  return {
    min: lengthAt(time, bounds.min),
    opt: lengthAt(time, opt),
    max: lengthAt(time, bounds.max)
  }
}

/** A length or skew rule as the tuner reads it: mm, or ps where `timeDomain`. */
export interface TuneRule {
  min?: number
  opt?: number
  max?: number
  timeDomain?: boolean
}

/**
 * How the tuned quantity's delay follows its length (KiCad's time-domain
 * tuning, `calculateTimeDomainTargets`): `length` mm is now `delay` ps, and
 * each mm the meanders add on the tuned layer adds `psPerMm`.
 */
export interface TuneTimeScale {
  length: number
  delay: number
  psPerMm: number
}

/** The length, mm, at which the tuned quantity's delay is `ps`. */
export const lengthAt = (t: TuneTimeScale, ps: number): number =>
  t.length + (ps - t.delay) / t.psPerMm

/** The delay, ps, of the tuned quantity at `mm`. */
export const delayAt = (t: TuneTimeScale, mm: number): number =>
  t.delay + (mm - t.length) * t.psPerMm

/**
 * Pieces offset `k` to their left (negative: right), each arc concentric with
 * its own. The pieces must turn smoothly (every corner an arc), as rounded
 * meanders do, so the offsets meet end to end.
 */
export function offsetPieces(pieces: readonly MeanderPiece[], k: number): MeanderPiece[] {
  return pieces.flatMap((p) => {
    if (!p.mid) {
      const l = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) || 1
      const n = { x: -(p.b.y - p.a.y) / l, y: (p.b.x - p.a.x) / l }
      return [
        {
          a: { x: p.a.x + n.x * k, y: p.a.y + n.y * k },
          b: { x: p.b.x + n.x * k, y: p.b.y + n.y * k }
        }
      ]
    }
    const c = circleThrough(p.a, p.mid, p.b)
    // Turning left the center lies on the left: the left offset is toward it.
    const leftTurn =
      (p.mid.x - p.a.x) * (p.b.y - p.mid.y) - (p.mid.y - p.a.y) * (p.b.x - p.mid.x) > 0
    const r = Math.hypot(p.a.x - c.x, p.a.y - c.y)
    const scale = Math.max(0, r + (leftTurn ? -k : k)) / r
    const move = (q: Pt): Pt => ({ x: c.x + (q.x - c.x) * scale, y: c.y + (q.y - c.y) * scale })
    // An inner half the offset takes to the center turns sharp there, as KiCad's may.
    return scale < 1e-9 ? [] : [{ a: move(p.a), b: move(p.b), mid: move(p.mid) }]
  })
}

/** The center of the circle through three points. */
function circleThrough(a: Pt, b: Pt, c: Pt): Pt {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  const sa = a.x * a.x + a.y * a.y
  const sb = b.x * b.x + b.y * b.y
  const sc = c.x * c.x + c.y * c.y
  return {
    x: (sa * (b.y - c.y) + sb * (c.y - a.y) + sc * (a.y - b.y)) / d,
    y: (sa * (c.x - b.x) + sb * (a.x - c.x) + sc * (b.x - a.x)) / d
  }
}

/** A length held to the nanometer, as KiCad's settings are. */
const toNm = (mm: number): number => Math.round(mm * 1e6) / 1e6

/** KiCad's step for the tuner's spacing and amplitude keys, mm (`MEANDER_SETTINGS::m_step`). */
const MEANDER_STEP = 0.05

/**
 * T1's keys mid-tune, as KiCad's (`1`/`2` spacing, `3`/`4` amplitude): one
 * step up or down, the largest amplitude never under the least, the spacing
 * never under the track's width plus clearance.
 */
export function stepMeander(
  settings: MeanderSettings,
  what: 'spacing' | 'amplitude',
  sign: 1 | -1,
  spacingFloor: number
): MeanderSettings {
  if (what === 'amplitude')
    return {
      ...settings,
      maxAmplitude: Math.max(
        toNm(settings.maxAmplitude + sign * MEANDER_STEP),
        settings.minAmplitude
      )
    }
  return {
    ...settings,
    spacing: Math.max(toNm(settings.spacing + sign * MEANDER_STEP), spacingFloor)
  }
}

/** T4: within the target's range tuned, under it too short, over it too long. */
export function statusOf(length: number, target: TuneTarget): TuneStatus {
  if (length < target.min - 1e-6) return 'too_short'
  if (length > target.max + 1e-6) return 'too_long'
  return 'tuned'
}

/**
 * A run's longest straight stretch as the router sees a track, for finding a
 * skew pattern's partner beside it; null for a run of arcs alone.
 */
export function patternRunItem(run: PatternRun): CopperItem | null {
  let best: { a: LinePoint; b: LinePoint } | null = null
  for (let i = 1; i < run.path.length; i++) {
    const a = run.path[i - 1]
    const b = run.path[i]
    if (b.mid) continue
    if (
      !best ||
      Math.hypot(b.x - a.x, b.y - a.y) > Math.hypot(best.b.x - best.a.x, best.b.y - best.a.y)
    )
      best = { a, b }
  }
  if (!best) return null
  const { a, b } = best
  const h = run.width / 2
  return {
    id: nextOverlayId(),
    ref: { type: 'segment', index: -1 },
    net: run.net,
    layers: [run.layer],
    shape: { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth: h },
    minX: Math.min(a.x, b.x) - h,
    minY: Math.min(a.y, b.y) - h,
    maxX: Math.max(a.x, b.x) + h,
    maxY: Math.max(a.y, b.y) + h
  }
}
