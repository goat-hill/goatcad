/**
 * A net's routed length and propagation delay as KiCad's length rules read
 * them (`LENGTH_DELAY_CALCULATION::CalculateLengthDetails`, KiCad 10): the
 * tracks joined into runs where exactly two meet end to end on one layer,
 * each run's end cut back to the center of the via or pad it starts inside,
 * a via counted as the board thickness between the outermost layers its
 * tracks (and any pad it sits in) reach, and each pad's pad-to-die length.
 *
 * Lengths are KiCad's integers: a straight piece rounded to the nanometer, an
 * arc truncated as it is added. Delays are attoseconds (KiCad's time unit),
 * from the net class's tuning profile. Coordinates are the file's: integer
 * nanometers, y down.
 */
import type { TuningDelays } from '../kicad/project'
import type { KicadBoard } from '../kicad/board'
import { findChildren, getAtomValues, type SExprNode } from '../kicad/sexpr'
import { mmAtomToNm, mmToNm } from '../kicad/coordinates'

export interface NmPt {
  x: number
  y: number
}

export type Piece = { kind: 'seg'; a: NmPt; b: NmPt } | { kind: 'arc'; a: NmPt; m: NmPt; b: NmPt }

export interface LengthLine {
  layer: string
  pieces: Piece[]
}

export interface LengthVia {
  position: NmPt
  /** Its span's outer layers, top then bottom. */
  top: string
  bottom: string
  /** Its copper's radius on a layer, nm. */
  radiusOn: (layer: string) => number
  /** The largest of those radii. */
  maxRadius: number
  /** The side a pad it sits in (connectivity joins them) takes the signal to, if any. */
  padSide: string | null
}

export interface LengthPad {
  position: NmPt
  /** Whether a point lies in the pad's copper on a layer (its edge counts). */
  contains: (p: NmPt, layer: string) => boolean
  /** Whether the pad has copper on a layer. */
  flashed: (layer: string) => boolean
  /** Where a segment from outside the pad to inside it crosses its edge; else found by bisection. */
  crossing?: (outside: NmPt, inside: NmPt, layer: string) => NmPt | null
  dieLength: number
  dieDelay: number
}

export interface LengthInput {
  lines: LengthLine[]
  vias: LengthVia[]
  pads: LengthPad[]
  /** Board thickness between two copper layers, nm (`BOARD_STACKUP::GetLayerDistance`). */
  stackupHeight: (a: string, b: string) => number
  /** The board's copper layers, front to back. */
  copperOrder: readonly string[]
  /** `use_height_for_length_calcs`: vias count their height, and are counted. */
  useHeight: boolean
  /** The net class's tuning profile; none means no delay at all. */
  delays: TuningDelays | null
}

export interface LengthStats {
  /** Tracks, vias and pad-to-die, nm. */
  total: number
  /** The pads' pad-to-die share of `total`, nm. */
  padToDie: number
  /** The same as delay, attoseconds. */
  totalDelay: number
  viaCount: number
}

const key = (p: NmPt): string => `${p.x},${p.y}`
const same = (p: NmPt, q: NmPt): boolean => p.x === q.x && p.y === q.y

const startOf = (line: LengthLine): NmPt => line.pieces[0].a
const endOf = (line: LengthLine): NmPt => line.pieces[line.pieces.length - 1].b

const reversed = (pieces: Piece[]): Piece[] =>
  pieces
    .slice()
    .reverse()
    .map((p) =>
      p.kind === 'seg' ? { kind: 'seg', a: p.b, b: p.a } : { kind: 'arc', a: p.b, m: p.m, b: p.a }
    )

/** A three-point arc's center, radius and signed sweep (through its mid). */
export function arcGeometry(
  a: NmPt,
  m: NmPt,
  b: NmPt
): { cx: number; cy: number; r: number; sweep: number } | null {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y))
  if (Math.abs(d) < 1e-9) return null
  const a2 = a.x * a.x + a.y * a.y
  const m2 = m.x * m.x + m.y * m.y
  const b2 = b.x * b.x + b.y * b.y
  const cx = (a2 * (m.y - b.y) + m2 * (b.y - a.y) + b2 * (a.y - m.y)) / d
  const cy = (a2 * (b.x - m.x) + m2 * (a.x - b.x) + b2 * (m.x - a.x)) / d
  const r = Math.hypot(a.x - cx, a.y - cy)
  const norm = (t: number): number => {
    let v = t % (2 * Math.PI)
    if (v <= -Math.PI) v += 2 * Math.PI
    if (v > Math.PI) v -= 2 * Math.PI
    return v
  }
  const ta = Math.atan2(a.y - cy, a.x - cx)
  const tm = Math.atan2(m.y - cy, m.x - cx)
  const tb = Math.atan2(b.y - cy, b.x - cx)
  return { cx, cy, r, sweep: norm(tm - ta) + norm(tb - tm) }
}

/** An arc's length through its mid; its chord when the points are collinear. */
export function arcPieceLength(a: NmPt, m: NmPt, b: NmPt): number {
  if (same(a, b)) {
    const g = arcGeometry(a, m, b)
    return g ? 2 * Math.PI * g.r : 0
  }
  const g = arcGeometry(a, m, b)
  return g ? Math.abs(g.r * g.sweep) : Math.hypot(b.x - a.x, b.y - a.y)
}

/** KiCad's `SHAPE_LINE_CHAIN::Length`: straight pieces rounded, then each arc added and truncated. */
export function lineLength(pieces: readonly Piece[]): number {
  let l = 0
  for (const p of pieces)
    if (p.kind === 'seg') l += Math.round(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y))
  for (const p of pieces) if (p.kind === 'arc') l = Math.trunc(l + arcPieceLength(p.a, p.m, p.b))
  return l
}

/**
 * Cut a run's first piece back to a center it starts inside: the run then
 * reads center → where it leaves → onward. `inside` says whether a point is
 * within; `crossing` finds where a piece from inside to outside leaves.
 */
function clipStart(
  pieces: Piece[],
  center: NmPt,
  inside: (p: NmPt) => boolean,
  crossing: (from: NmPt, to: NmPt) => NmPt | null,
  arcCrossing: (piece: Extract<Piece, { kind: 'arc' }>) => NmPt | null
): Piece[] {
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]
    if (inside(piece.b)) continue
    const out: Piece[] = [{ kind: 'seg', a: center, b: center }]
    if (piece.kind === 'seg') {
      const x = crossing(piece.b, piece.a)
      if (x) out.push({ kind: 'seg', a: center, b: x }, { kind: 'seg', a: x, b: piece.b })
      else out.push({ kind: 'seg', a: center, b: piece.b })
    } else {
      const x = arcCrossing(piece)
      if (x) {
        // The arc's remainder from where it leaves, as a sub-arc through its own mid.
        const g = arcGeometry(piece.a, piece.m, piece.b)
        out.push({ kind: 'seg', a: center, b: x })
        if (g) {
          const tx = Math.atan2(x.y - g.cy, x.x - g.cx)
          const tb = Math.atan2(piece.b.y - g.cy, piece.b.x - g.cx)
          let d = tb - tx
          if (g.sweep > 0) while (d < 0) d += 2 * Math.PI
          else while (d > 0) d -= 2 * Math.PI
          const tm = tx + d / 2
          out.push({
            kind: 'arc',
            a: x,
            m: { x: g.cx + g.r * Math.cos(tm), y: g.cy + g.r * Math.sin(tm) },
            b: piece.b
          })
        } else out.push({ kind: 'seg', a: x, b: piece.b })
      } else out.push({ kind: 'seg', a: center, b: piece.b })
    }
    return [...out.slice(1), ...pieces.slice(i + 1)]
  }
  return pieces
}

/** Where a segment from inside a circle to outside it crosses it, nearest the outside end. */
function circleCrossing(center: NmPt, r: number, outside: NmPt, insidePt: NmPt): NmPt | null {
  const dx = insidePt.x - outside.x
  const dy = insidePt.y - outside.y
  const fx = outside.x - center.x
  const fy = outside.y - center.y
  const a = dx * dx + dy * dy
  if (a === 0) return null
  const b = 2 * (fx * dx + fy * dy)
  const c = fx * fx + fy * fy - r * r
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const s = Math.sqrt(disc)
  const ts = [(-b - s) / (2 * a), (-b + s) / (2 * a)].filter((t) => t >= 0 && t <= 1)
  if (ts.length === 0) return null
  const t = Math.min(...ts)
  return { x: Math.round(outside.x + t * dx), y: Math.round(outside.y + t * dy) }
}

/** Where a segment leaves a region, found by bisection to the nanometer. */
function boundaryCrossing(inside: (p: NmPt) => boolean, outside: NmPt, insidePt: NmPt): NmPt {
  let lo = 0
  let hi = 1
  const at = (t: number): NmPt => ({
    x: outside.x + (insidePt.x - outside.x) * t,
    y: outside.y + (insidePt.y - outside.y) * t
  })
  const length = Math.hypot(insidePt.x - outside.x, insidePt.y - outside.y)
  for (let i = 0; i < 64 && (hi - lo) * length > 0.25; i++) {
    const mid = (lo + hi) / 2
    if (inside(at(mid))) hi = mid
    else lo = mid
  }
  const p = at(hi)
  return { x: Math.round(p.x), y: Math.round(p.y) }
}

/** Where an arc leaves a region, bisecting along its sweep. */
function arcBoundaryCrossing(
  inside: (p: NmPt) => boolean,
  piece: Extract<Piece, { kind: 'arc' }>
): NmPt | null {
  const g = arcGeometry(piece.a, piece.m, piece.b)
  if (!g) return null
  const t0 = Math.atan2(piece.a.y - g.cy, piece.a.x - g.cx)
  const at = (f: number): NmPt => ({
    x: g.cx + g.r * Math.cos(t0 + g.sweep * f),
    y: g.cy + g.r * Math.sin(t0 + g.sweep * f)
  })
  let lo = 0
  let hi = 1
  for (let i = 0; i < 64 && (hi - lo) * Math.abs(g.sweep) * g.r > 0.25; i++) {
    const mid = (lo + hi) / 2
    if (inside(at(mid))) lo = mid
    else hi = mid
  }
  const p = at(lo)
  return { x: Math.round(p.x), y: Math.round(p.y) }
}

export function netLength(input: LengthInput): LengthStats {
  const { copperOrder, useHeight, delays } = input
  const lines = input.lines.map((line) => ({
    layer: line.layer,
    pieces: line.pieces,
    state: 'unmerged' as 'unmerged' | 'inUse' | 'retired'
  }))

  // Where each run ends, before any is joined.
  const ends = new Map<string, Set<number>>()
  const addEnd = (p: NmPt, i: number): void => {
    const k = key(p)
    const set = ends.get(k) ?? new Set<number>()
    set.add(i)
    ends.set(k, set)
  }
  lines.forEach((line, i) => {
    addEnd(startOf(line), i)
    addEnd(endOf(line), i)
  })

  // Each via reaches the outermost layers its tracks (and a pad it sits in) do.
  const viaSpans = input.vias.map((via) => {
    const reached = new Set<string>()
    for (const [k, set] of ends) {
      const [x, y] = k.split(',').map(Number)
      const dx = x - via.position.x
      const dy = y - via.position.y
      const d2 = dx * dx + dy * dy
      if (d2 > via.maxRadius * via.maxRadius) continue
      for (const i of set) {
        const r = via.radiusOn(lines[i].layer)
        if (d2 === 0 || d2 < r * r) reached.add(lines[i].layer)
      }
    }
    if (via.padSide) reached.add(via.padSide)
    const order = copperOrder.filter((layer) => reached.has(layer))
    return order.length === 0
      ? { from: via.top, to: via.top }
      : { from: order[0], to: order[order.length - 1] }
  })

  // Runs: a track joins the one it meets end to end, where nothing else meets them.
  const dropEnds = (i: number): void => {
    ends.get(key(startOf(lines[i])))?.delete(i)
    ends.get(key(endOf(lines[i])))?.delete(i)
  }
  lines.forEach((primary, i) => {
    if (primary.state !== 'unmerged') return
    dropEnds(i)
    primary.state = 'inUse'
    for (;;) {
      let merged = false
      for (const side of ['start', 'end'] as const) {
        const at = side === 'start' ? startOf(primary) : endOf(primary)
        const set = ends.get(key(at))
        if (!set || set.size !== 1) continue
        const j = [...set][0]
        const other = lines[j]
        if (other.layer !== primary.layer) continue
        other.state = 'retired'
        dropEnds(j)
        if (side === 'start') {
          const pieces = same(endOf(other), at) ? other.pieces : reversed(other.pieces)
          primary.pieces = [...pieces, ...primary.pieces]
        } else {
          const pieces = same(startOf(other), at) ? other.pieces : reversed(other.pieces)
          primary.pieces = [...primary.pieces, ...pieces]
        }
        merged = true
      }
      if (!merged) break
    }
  })
  const runs = lines.filter((line) => line.state === 'inUse')

  // A run starting (or ending) inside a via is measured from the via's center.
  for (const via of input.vias) {
    for (const run of runs) {
      const r = via.radiusOn(run.layer)
      const inside = (p: NmPt): boolean => {
        const dx = p.x - via.position.x
        const dy = p.y - via.position.y
        const d2 = dx * dx + dy * dy
        return d2 === 0 || d2 < r * r
      }
      const clip = (pieces: Piece[]): Piece[] =>
        clipStart(
          pieces,
          via.position,
          inside,
          (outside, insidePt) => circleCrossing(via.position, r, outside, insidePt),
          (piece) => arcBoundaryCrossing(inside, piece)
        )
      if (inside(startOf(run))) run.pieces = clip(run.pieces)
      else if (inside(endOf(run))) run.pieces = reversed(clip(reversed(run.pieces)))
    }
  }

  // And one ending at a pad's anchor, inside its copper, from that anchor.
  for (const pad of input.pads) {
    for (const run of runs) {
      if (!same(startOf(run), pad.position) && !same(endOf(run), pad.position)) continue
      if (!pad.flashed(run.layer)) continue
      const inside = (p: NmPt): boolean => pad.contains(p, run.layer)
      const clip = (pieces: Piece[]): Piece[] =>
        clipStart(
          pieces,
          pad.position,
          inside,
          (outside, insidePt) =>
            pad.crossing
              ? pad.crossing(outside, insidePt, run.layer)
              : boundaryCrossing(inside, outside, insidePt),
          (piece) => arcBoundaryCrossing(inside, piece)
        )
      if (inside(startOf(run))) run.pieces = clip(run.pieces)
      else if (inside(endOf(run))) run.pieces = reversed(clip(reversed(run.pieces)))
    }
  }

  let route = 0
  let routeDelay = 0
  for (const run of runs) {
    const length = lineLength(run.pieces)
    route += length
    const perMm = delays?.timeDomain ? (delays.layers[run.layer] ?? 0) : 0
    routeDelay += Math.trunc(perMm * (length / 1e6))
  }
  let viaLength = 0
  let viaDelay = 0
  let viaCount = 0
  if (useHeight) {
    input.vias.forEach((via, i) => {
      const { from, to } = viaSpans[i]
      viaLength += input.stackupHeight(from, to)
      viaCount++
      if (delays?.timeDomain) viaDelay += viaPropagation(delays, from, to, via, input)
    })
  }
  let padToDie = 0
  let padDelay = 0
  for (const pad of input.pads) {
    padToDie += pad.dieLength
    // A pad's own delay counts wherever the net has a profile, time domain or not.
    if (delays) padDelay += pad.dieDelay
  }
  return {
    total: route + viaLength + padToDie,
    padToDie,
    totalDelay: routeDelay + viaDelay + padDelay,
    viaCount
  }
}

/** A via's delay: the profile's override between these layers, else its delay per mm of height. */
function viaPropagation(
  delays: TuningDelays,
  from: string,
  to: string,
  via: LengthVia,
  input: LengthInput
): number {
  const rank = (layer: string): number => input.copperOrder.indexOf(layer)
  // Each pair front layer first, as the profile stores them.
  const [s1, s2] = rank(from) <= rank(to) ? [from, to] : [to, from]
  const [v1, v2] = rank(via.top) <= rank(via.bottom) ? [via.top, via.bottom] : [via.bottom, via.top]
  const override = delays.overrides.find(
    (o) => o.signalFrom === s1 && o.signalTo === s2 && o.viaFrom === v1 && o.viaTo === v2
  )
  if (override) return override.delay
  return Math.trunc(delays.via * (input.stackupHeight(from, to) / 1e6))
}

/** Copper layers front to back: F.Cu, In1.Cu … In30.Cu, B.Cu. */
export const copperRank = (layer: string): number =>
  layer === 'F.Cu' ? 0 : layer === 'B.Cu' ? 99 : Number(/^In(\d+)\.Cu$/.exec(layer)?.[1] ?? 98)

const isCopper = (name: string): boolean => /^(F|B|In\d+)\.Cu$/.test(name)

/** KiCad's default copper and mask thicknesses, for a board with no stackup of its own. */
const COPPER_DEFAULT = mmToNm(0.035)
const MASK_DEFAULT = mmToNm(0.01)

/**
 * The board thickness between two copper layers, nm, as KiCad's
 * `BOARD_STACKUP::GetLayerDistance` measures it: from the first layer through
 * the second, each end's copper counted whole on an outer layer and half on
 * an inner one. A board with no stackup of its own gets KiCad's default: 35 µm
 * copper, 10 µm mask, and the rest of its thickness shared evenly among the
 * dielectrics.
 */
export function stackupHeights(board: KicadBoard): (a: string, b: string) => number {
  const copper = board.layers
    .map((l) => l.name)
    .filter(isCopper)
    .sort((a, b) => copperRank(a) - copperRank(b))
  // The stackup front to back: each copper layer by name, each dielectric with its sublayers.
  let items: Array<{ copper: string | null; thicknesses: number[] }>
  if (board.stackup) {
    items = board.stackup.layers.flatMap((layer) => {
      if (!isCopper(layer.name) && !/^dielectric/.test(layer.name)) return []
      return [
        { copper: isCopper(layer.name) ? layer.name : null, thicknesses: thicknessesOf(layer._raw) }
      ]
    })
  } else {
    const n = copper.length
    const masks = board.layers.filter((l) => l.name === 'F.Mask' || l.name === 'B.Mask').length
    const total = board.thickness ?? mmToNm(1.6)
    const dielectric = Math.trunc(
      (total - COPPER_DEFAULT * n - MASK_DEFAULT * masks) / Math.max(1, n - 1)
    )
    items = copper.flatMap((name, i) => [
      { copper: name, thicknesses: [COPPER_DEFAULT] },
      ...(i < copper.length - 1 ? [{ copper: null, thicknesses: [dielectric] }] : [])
    ])
  }
  return (a, b) => {
    if (a === b) return 0
    const [first, second] = copperRank(a) <= copperRank(b) ? [a, b] : [b, a]
    const outer = (layer: string): boolean => layer === 'F.Cu' || layer === 'B.Cu'
    let total = 0
    let started = false
    for (const item of items) {
      let half = false
      if (!started) {
        if (item.copper !== first) continue
        started = true
        half = !outer(first)
      }
      if (item.copper === second && !outer(second)) half = true
      for (const t of item.thicknesses) total += half ? Math.trunc(t / 2) : t
      if (item.copper === second) break
    }
    return total
  }
}

/** A stackup item's thickness, and each sublayer's after it (`addsublayer`). */
function thicknessesOf(raw: SExprNode): number[] {
  if (raw.type !== 'list') return []
  return findChildren(raw, 'thickness').flatMap((node) => {
    const value = getAtomValues(node)[0]
    return value !== undefined ? [mmAtomToNm(value)] : []
  })
}
