/**
 * Meanders for length tuning (docs/router-behavior.md T1–T6), as KiCad's
 * length tuner lays them (`MEANDERED_LINE::MeanderSegment`,
 * `MEANDER_PLACER_BASE::tuneLineLength`): along each straight stretch of a
 * line, from its start, a row of U-shaped bumps square to it, each as tall as
 * clearance lets it be up to the largest amplitude, sliding on past a place
 * none fits; arcs pass through. Bumps are laid until the line would reach its
 * target, and then lowered together, each by an even share of the overshoot.
 * Pure: the caller says whether a bump fits.
 */

import type { Pt } from '../spatialIndex'

export interface MeanderSettings {
  /** No bump lower than this; one that cannot be is left out. */
  minAmplitude: number
  maxAmplitude: number
  /** Between the legs of a bump, and between one bump and the next. */
  spacing: number
  /** Rounded corners' radius, as a percentage of half the spacing (KiCad's); 0 square. */
  cornerRadiusPercent: number
  /** Every bump on one side; else they alternate. */
  singleSided: boolean
  /** The side the first bump goes to: +1 the stretch's left, −1 its right. */
  side: 1 | -1
}

/** KiCad's defaults (`MEANDER_SETTINGS`). */
export const DEFAULT_MEANDER: MeanderSettings = {
  minAmplitude: 0.2,
  maxAmplitude: 1,
  spacing: 0.6,
  cornerRadiusPercent: 80,
  singleSided: false,
  side: 1
}

/** One piece of a meandered stretch: straight, or an arc through `mid`. */
export interface MeanderPiece {
  a: Pt
  b: Pt
  mid?: Pt
}

export interface Meandered {
  pieces: MeanderPiece[]
  /** Each part's pieces, in the parts' order (`meanderParts`). */
  perPart: MeanderPiece[][]
  /** The length the bumps add over the line's own. */
  added: number
  /** Bumps laid. */
  bumps: number
}

/** What the meandered line is: its track's width, and (a pair's centerline) how far each half lies off it, mm. */
export interface MeanderLine {
  width: number
  offset?: number
  /**
   * How far apart the line's own centerlines must stay, mm (its width and
   * clearance, a pair's also twice its offset): a bump keeps this far from the
   * rest of the line and the bumps of its other stretches.
   */
  selfClearance?: number
}

/** How far a stretch's next place is tried past one where no bump fits, beyond its corners (KiCad's `m_step`). */
const SLIDE_STEP = 0.05

const unit = (v: Pt): Pt => {
  const l = Math.hypot(v.x, v.y) || 1
  return { x: v.x / l, y: v.y / l }
}
const at = (p: Pt, d: Pt, k: number): Pt => ({ x: p.x + d.x * k, y: p.y + d.y * k })

/** A bump standing on `[t, t + spacing]` along its stretch, `y` tall (signed by side; + the left). */
interface Slot {
  t: number
  y: number
}

interface Stretch {
  from: Pt
  to: Pt
  len: number
  u: Pt
  left: Pt
  slots: Slot[]
}

const stretchOf = (from: Pt, to: Pt): Stretch => {
  const u = unit({ x: to.x - from.x, y: to.y - from.y })
  return {
    from,
    to,
    len: Math.hypot(to.x - from.x, to.y - from.y),
    u,
    left: { x: -u.y, y: u.x },
    slots: []
  }
}

/**
 * Meander the stretch `from`→`to` to add as near `extra` (mm) as the bumps
 * that fit allow — every bump at its tallest, with no target (`Infinity`).
 * `fits` says whether a bump's centerline (its legs and top) keeps clear.
 */
export function meander(
  from: Pt,
  to: Pt,
  extra: number,
  settings: MeanderSettings,
  fits: (bump: Pt[]) => boolean,
  line: MeanderLine = { width: 0 }
): Meandered {
  return meanderParts([{ a: from, b: to }], extra, settings, fits, line)
}

/**
 * Meander a line given as its pieces in order (or stretches apart, a pair's
 * coupled runs), to add as near `extra` (mm)
 * as the bumps that fit allow: each straight piece longer than two spacings
 * takes bumps, an arc passes through, and the bumps share the target.
 *
 * A bump stands a spacing wide. Single-sided, a spacing of flat track lies
 * between each two, so each is a U that comes back to the line (KiCad's
 * `MT_SINGLE`); otherwise they touch and alternate sides, one serpentine
 * whose legs cross the line (KiCad's `MT_START`, `MT_TURN`, `MT_FINISH`),
 * starting again past a place none fits.
 */
export function meanderParts(
  parts: readonly MeanderPiece[],
  extra: number,
  settings: MeanderSettings,
  fits: (bump: Pt[]) => boolean,
  line: MeanderLine = { width: 0 },
  /** Each part's first side, where they differ (the cursor's side of each, KiCad's); else the settings'. */
  sides?: ReadonlyArray<1 | -1>
): Meandered {
  const s = settings.spacing
  const stretches = parts.map((p) => (p.mid ? null : stretchOf(p.a, p.b)))
  const own = parts.reduce((sum, p) => sum + piecesLength([p]), 0)
  let need = extra
  stretches.forEach((st, i) => {
    if (!st || st.len <= 2 * s || need <= 1e-9) return
    const clear = (bump: Pt[]): boolean =>
      fits(bump) && clearOfLine(bump, i, parts, stretches, settings, line)
    st.slots = laySlots(st, sides ? { ...settings, side: sides[i] } : settings, line, clear, need)
    need -= addedBy(st, settings, line)
  })
  if (Number.isFinite(extra)) fitToTarget(stretches, extra, settings, line)
  const perPart = parts.map((p, i) => {
    const st = stretches[i]
    return st ? shape(st, settings, line) : [{ ...p }]
  })
  const pieces = perPart.flat()
  return {
    pieces,
    perPart,
    added: piecesLength(pieces) - own,
    bumps: stretches.reduce((n, st) => n + (st?.slots.length ?? 0), 0)
  }
}

/**
 * Bumps along one stretch, from its start, each as tall as fits, until they
 * add `budget`: a place none fits is passed by a spacing less its corners and
 * a step (KiCad's), and a serpentine turns at each bump that touches the last.
 */
function laySlots(
  st: Stretch,
  settings: MeanderSettings,
  line: MeanderLine,
  fits: (bump: Pt[]) => boolean,
  budget: number
): Slot[] {
  const s = settings.spacing
  const single = settings.singleSided
  // The first corner's arc stays on the stretch, as the last one's, and a pair's halves turn on it too.
  const r0 = Math.max(cornerRadius(settings.maxAmplitude, s, settings, line), line.offset ?? 0)
  const end = st.len - r0
  const slide = Math.max(s - 2 * r0, 0) + SLIDE_STEP
  const step = Math.max(settings.minAmplitude / 4, 0.01)
  const tryAt = (t: number, sd: number): number | null => {
    const n = { x: st.left.x * sd, y: st.left.y * sd }
    const base = at(st.from, st.u, t)
    for (let h = settings.maxAmplitude; h >= settings.minAmplitude - 1e-9; h -= step) {
      const bump = [base, at(base, n, h), at(at(base, st.u, s), n, h), at(base, st.u, s)]
      if (fits(bump)) return h
    }
    return null
  }
  let side: number = settings.side
  let added = 0
  let pos = r0
  while (pos + s <= end + 1e-9 && budget - added > 1e-9) {
    const prev = st.slots[st.slots.length - 1]
    const touching = !single && !!prev && Math.abs(prev.t + s - pos) < 1e-9
    const sides = touching ? [-Math.sign(prev.y)] : single ? [side] : [side, -side]
    let y = 0
    for (const sd of sides) {
      const h = tryAt(pos, sd)
      if (h !== null) {
        y = sd * h
        break
      }
    }
    if (y === 0) {
      // Past a bump, the next stands a spacing of flat track on, so their corners never meet.
      pos = Math.max(pos + slide, prev ? prev.t + 2 * s : 0)
      continue
    }
    st.slots.push({ t: pos, y })
    if (!single) side = -Math.sign(y)
    added = addedBy(st, settings, line)
    pos += single ? 2 * s : s
  }
  return st.slots
}

/**
 * The bumps brought to the target, as KiCad's `tuneLineLength`: a last bump
 * that overshoots even with every bump at its least is left out, and the
 * overshoot is then taken off every bump in turn, an even share of what is
 * left each, none under the least amplitude.
 */
function fitToTarget(
  stretches: ReadonlyArray<Stretch | null>,
  extra: number,
  settings: MeanderSettings,
  line: MeanderLine
): void {
  const laid = stretches.filter((st): st is Stretch => !!st && st.slots.length > 0)
  const total = (): number => laid.reduce((sum, st) => sum + addedBy(st, settings, line), 0)
  if (total() - extra <= 1e-9) return
  const least = settings.minAmplitude
  const heights = laid.map((st) => st.slots.map((sl) => sl.y))
  for (const st of laid) for (const sl of st.slots) sl.y = Math.sign(sl.y) * least
  const last = laid[laid.length - 1]
  const atLeast = total()
  laid.forEach((st, i) => st.slots.forEach((sl, j) => (sl.y = heights[i][j])))
  const count = laid.reduce((n, st) => n + st.slots.length, 0)
  if (atLeast - extra > 1e-9 && count > 1) last.slots.pop()

  let reduction = total() - extra
  const bumps = laid.flatMap((st) => st.slots.map((sl) => ({ st, sl })))
  let left = bumps.length
  for (const { st, sl } of bumps) {
    if (reduction <= 1e-9) break
    const share = reduction / left--
    const before = addedBy(st, settings, line)
    const goal = before - share
    const sd = Math.sign(sl.y)
    let lo = least
    let hi = Math.abs(sl.y)
    if (hi - lo <= 1e-9) continue
    sl.y = sd * lo
    if (addedBy(st, settings, line) < goal) {
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2
        sl.y = sd * mid
        if (addedBy(st, settings, line) < goal) lo = mid
        else hi = mid
      }
      sl.y = sd * hi
    }
    reduction -= before - addedBy(st, settings, line)
  }
}

/**
 * Whether a bump on stretch `i` keeps its line's self-clearance from the rest
 * of the line and the bumps of its other stretches. Beside a piece that meets
 * the stretch, only the bump's part that stands clear of the line counts, so
 * a piece running on in line, or bending away, never turns a bump away.
 */
function clearOfLine(
  bump: Pt[],
  i: number,
  parts: readonly MeanderPiece[],
  stretches: ReadonlyArray<Stretch | null>,
  settings: MeanderSettings,
  line: MeanderLine
): boolean {
  const gap = line.selfClearance ?? 0
  if (gap <= 0 || parts.length < 2) return true
  const [base, up, up2, base2] = bump
  const h = Math.hypot(up.x - base.x, up.y - base.y)
  const lift = (from: Pt, to: Pt): Pt =>
    h > gap
      ? { x: from.x + ((to.x - from.x) * gap) / h, y: from.y + ((to.y - from.y) * gap) / h }
      : to
  const raised = [lift(base, up), up, up2, lift(base2, up2)]
  for (let j = 0; j < parts.length; j++) {
    if (j === i) continue
    const other = stretches[j]
    const p = parts[j]
    const path = other?.slots.length
      ? shapePath(other, settings, line)
      : p.mid
        ? [p.a, p.mid, p.b]
        : [p.a, p.b]
    if (pathDistance(Math.abs(j - i) === 1 ? raised : bump, path) < gap - 1e-9) return false
  }
  return true
}

/** The least distance between two polylines; a lone point counts as itself. */
function pathDistance(a: readonly Pt[], b: readonly Pt[]): number {
  if (b.length === 0) return Infinity
  const segs = (path: readonly Pt[]): Array<[Pt, Pt]> =>
    path.length === 1 ? [[path[0], path[0]]] : path.slice(1).map((q, k) => [path[k], q])
  let best = Infinity
  for (const [p, q] of segs(a))
    for (const [r, t] of segs(b)) best = Math.min(best, segmentDistance(p, q, r, t))
  return best
}

function segmentDistance(p: Pt, q: Pt, r: Pt, t: Pt): number {
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const d1 = cross(r, t, p)
  const d2 = cross(r, t, q)
  const d3 = cross(p, q, r)
  const d4 = cross(p, q, t)
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0
  return Math.min(
    pointSegment(p, r, t),
    pointSegment(q, r, t),
    pointSegment(r, p, q),
    pointSegment(t, p, q)
  )
}

function pointSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(a.x + dx * k - p.x, a.y + dy * k - p.y)
}

/** The square path a stretch's bumps take, for keeping other bumps clear of it. */
function shapePath(st: Stretch, settings: MeanderSettings, line: MeanderLine): Pt[] {
  const square = shape(st, { ...settings, cornerRadiusPercent: 0 }, line)
  return square.length ? [square[0].a, ...square.map((p) => p.b)] : [st.from, st.to]
}

const addedBy = (st: Stretch, settings: MeanderSettings, line: MeanderLine): number =>
  piecesLength(shape(st, settings, line)) - st.len

/**
 * A stretch through its bumps: up or down a leg wherever the height changes,
 * along each bump at its height, back to the stretch after each that the next
 * does not touch, every corner rounded at its bump's radius.
 */
function shape(st: Stretch, settings: MeanderSettings, line: MeanderLine): MeanderPiece[] {
  const { from, to, u, left, slots } = st
  const s = settings.spacing
  const point = (t: number, y: number): Pt => at(at(from, u, t), left, y)
  // Corners as (along, height, radius); a corner on the stretch takes the radius of the bump it climbs to.
  const corners: Array<{ t: number; y: number; r: number }> = []
  const radius = (y: number): number => cornerRadius(Math.abs(y), s, settings, line)
  let level = 0
  const climb = (t: number, y: number): void => {
    if (Math.abs(y - level) < 1e-12) return
    corners.push({ t, y: level, r: radius(level === 0 ? y : level) })
    corners.push({ t, y, r: radius(y === 0 ? level : y) })
    level = y
  }
  slots.forEach((sl, i) => {
    climb(sl.t, sl.y)
    const next = slots[i + 1]
    const touching = !settings.singleSided && !!next && Math.abs(next.t - (sl.t + s)) < 1e-9
    if (!touching) climb(sl.t + s, 0)
  })
  // Two corners never round past each other: where their run is short, both tighten.
  for (let i = 0; i + 1 < corners.length; i++) {
    const a = corners[i]
    const b = corners[i + 1]
    const run = Math.hypot(b.t - a.t, b.y - a.y)
    if (a.r + b.r > run + 1e-12) {
      const k = run / (a.r + b.r)
      a.r *= k
      b.r *= k
    }
  }

  const pieces: MeanderPiece[] = []
  let cursor = { ...from }
  let prev = from
  corners.forEach((c, i) => {
    const p = point(c.t, c.y)
    const next = i + 1 < corners.length ? corners[i + 1] : null
    const q = next ? point(next.t, next.y) : to
    if (c.r <= 1e-9) {
      pieces.push(...straight(cursor, p))
      cursor = p
    } else {
      const din = unit({ x: p.x - prev.x, y: p.y - prev.y })
      const dout = unit({ x: q.x - p.x, y: q.y - p.y })
      const a = at(p, din, -c.r)
      const b = at(p, dout, c.r)
      // The arc's center sits r in from both legs; its middle r from the center toward the corner.
      const center = at(a, dout, c.r)
      const toCorner = unit({ x: p.x - center.x, y: p.y - center.y })
      pieces.push(...straight(cursor, a))
      pieces.push({ a, b, mid: at(center, toCorner, c.r) })
      cursor = b
    }
    prev = p
  })
  pieces.push(...straight(cursor, to))
  return pieces
}

const straight = (a: Pt, b: Pt): MeanderPiece[] =>
  Math.hypot(b.x - a.x, b.y - a.y) > 1e-9 ? [{ a: { ...a }, b: { ...b } }] : []

/**
 * A bump's corner radius, KiCad's (`MEANDER_SHAPE::cornerRadius`): a share of
 * half the spacing, no tighter than a pair's inner half turning at its own
 * half width, nor wider than half the spacing or (so a bump's two corners
 * share its leg) half its height. Where those cross the widest wins, and a
 * pair's inner half turns sharp, as KiCad's does.
 */
const cornerRadius = (
  h: number,
  s: number,
  settings: MeanderSettings,
  line: MeanderLine
): number => {
  if (settings.cornerRadiusPercent <= 0 || h <= 0) return 0
  const least = (line.offset ?? 0) + line.width / 2
  const most = Math.min(h / 2, s / 2)
  return most < least
    ? most
    : Math.min(Math.max((s * settings.cornerRadiusPercent) / 200, least), most)
}

/** The length of meandered pieces, arcs by their sweep. */
export function piecesLength(pieces: readonly MeanderPiece[]): number {
  let sum = 0
  for (const p of pieces) {
    if (!p.mid) {
      sum += Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y)
      continue
    }
    const chord = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y)
    const sag = Math.hypot(p.mid.x - (p.a.x + p.b.x) / 2, p.mid.y - (p.a.y + p.b.y) / 2)
    if (sag < 1e-12) {
      sum += chord
      continue
    }
    const r = (chord * chord) / (8 * sag) + sag / 2
    // An arc past a half turn bulges beyond its chord's circle: its sweep is the long way.
    const half = Math.asin(Math.min(1, chord / (2 * r)))
    sum += 2 * r * (sag > r ? Math.PI - half : half)
  }
  return sum
}
