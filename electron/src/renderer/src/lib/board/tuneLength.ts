/**
 * Routed lengths as KiCad's length tuner reads them (docs/router-behavior.md
 * T2; `MEANDER_PLACER_BASE::lineLength` through `LENGTH_DELAY_CALCULATION`):
 * tracks and arcs, each via's height through the stackup between the layers
 * its tracks join, and each end pad's pad-to-die length. Via heights count
 * only where the board says so (`use_height_for_length_calcs`, KiCad's default
 * on); the stackup is the board's, else KiCad's default (`stackupHeights`).
 *
 * The tuner measures the tuned track's path between its two pads
 * (`tunedPathLength`); a net's whole routed length (`routedNetLength`) is what
 * a track's Properties and a live route read.
 *
 * Both read a track ending on a pad's anchor from the anchor to where it
 * leaves the pad, and one ending inside a via from the via's center, as
 * KiCad's `OptimiseTraceInPad` and `OptimiseTraceInVia` do: the sum is the
 * length calculator's (`netLength.ts`), the same as DRC's.
 */
import { viaSizeOn, type KicadBoard } from '../kicad/board'
import { padOnLayer, type KicadPad } from '../kicad/footprint'
import { findChild, getAtomValues } from '../kicad/sexpr'
import { isCopperLayer } from '../kicad/layers'
import { mmAtomToNm, mmToNm } from '../kicad/coordinates'
import { footprintTransform, tfPoint } from '../schematic/placement'
import { inPolygon, padPolygon } from './padPolygon'
import type { TuningDelays } from '../kicad/project'
import {
  arcPieceLength,
  copperRank,
  netLength,
  stackupHeights,
  type LengthPad,
  type LengthStats,
  type LengthVia,
  type NmPt,
  type Piece
} from './netLength'

export interface TuneLengthOptions {
  /** `use_height_for_length_calcs`: vias add their height through the board. */
  useHeight: boolean
  /** The board's max error, mm: how finely a pad is outlined to find a via in it. */
  maxError: number
}

/** A track or arc of the board. */
export interface TrackRef {
  type: 'segment' | 'tarc'
  index: number
}

/** A pad's `(die_length …)`, nm, or `(die_delay …)`, attoseconds (the file's scale times a million); 0 where it has none. */
function dieValue(pad: KicadPad, token: 'die_length' | 'die_delay'): number {
  const node = pad._raw.type === 'list' ? findChild(pad._raw, token) : null
  const value = node ? getAtomValues(node)[0] : undefined
  return value !== undefined ? mmAtomToNm(value) : 0
}

/** The net's routed length, nm: tracks, arcs, via heights and pad-to-die. */
export function routedNetLength(board: KicadBoard, net: number, opts: TuneLengthOptions): number {
  return netLengthStats(board, net, opts).total
}

/** The net's length as `routedNetLength` reads it, with the pads' pad-to-die share apart. */
export function netLengthStats(
  board: KicadBoard,
  net: number,
  opts: TuneLengthOptions
): LengthStats {
  const c = netCopper(board, net, opts)
  return measure(board, c, c.tracks, c.vias, c.pads, opts)
}

/**
 * The tuned track's length, nm, as KiCad's tuner reads it (T2; KiCad's
 * `TOPOLOGY::AssembleTuningPath`): the line through `start`, followed out of
 * each end through vias and in-line pads, the longest way where it branches,
 * to the pad (or dead end) it arrives at; with the vias it passes and the two
 * end pads' pad-to-die.
 */
export function tunedPathLength(
  board: KicadBoard,
  start: TrackRef,
  opts: TuneLengthOptions
): number {
  return tunedPathStats(board, start, opts, null)?.total ?? 0
}

/**
 * `tunedPathLength`'s path measured whole: its length, nm, and with the net's
 * tuning profile its propagation delay, attoseconds (KiCad's time-domain
 * tuning). Null where the track is not on the board.
 */
export function tunedPathStats(
  board: KicadBoard,
  start: TrackRef,
  opts: TuneLengthOptions,
  delays: TuningDelays | null
): LengthStats | null {
  const track =
    start.type === 'segment' ? board.segments[start.index] : board.trackArcs[start.index]
  if (!track) return null
  const c = netCopper(board, track.net, opts)
  const seed = c.tracks.findIndex((t) => t.ref.type === start.type && t.ref.index === start.index)
  if (seed < 0) return null
  const path = tuningPath(c, seed)
  return measure(
    board,
    c,
    path.tracks.map((i) => c.tracks[i]),
    path.vias.map((i) => c.vias[i]),
    path.pads.map((i) => c.pads[i]),
    opts,
    delays
  )
}

interface NetTrack {
  ref: TrackRef
  layer: string
  piece: Piece
}

interface NetPad {
  pad: KicadPad
  /** The side a via in it carries the signal to. */
  side: string
  position: NmPt
  /** Whether a point lies in its copper on a layer. */
  contains: (p: NmPt, layer: string) => boolean
}

interface NetCopper {
  tracks: NetTrack[]
  vias: LengthVia[]
  pads: NetPad[]
  copperOrder: string[]
}

/** Whether a pad has copper on a layer. */
const padHas = (pad: KicadPad, layer: string): boolean =>
  pad.layers.some(
    (l) => l === layer || l === '*.Cu' || (l === 'F&B.Cu' && (layer === 'F.Cu' || layer === 'B.Cu'))
  )

/** A net's tracks, arcs, vias and pads, in the file's coordinates. */
function netCopper(board: KicadBoard, net: number, opts: TuneLengthOptions): NetCopper {
  const nm = (p: { x: number; y: number }): NmPt => ({ x: p.x, y: p.y })
  const copperOrder = board.layers
    .map((l) => l.name)
    .filter(isCopperLayer)
    .sort((a, b) => copperRank(a) - copperRank(b))
  const maxError = mmToNm(opts.maxError)

  const tracks: NetTrack[] = []
  board.segments.forEach((s, index) => {
    if (s.net === net)
      tracks.push({
        ref: { type: 'segment', index },
        layer: s.layer,
        piece: { kind: 'seg', a: nm(s.start), b: nm(s.end) }
      })
  })
  board.trackArcs.forEach((a, index) => {
    if (a.net === net)
      tracks.push({
        ref: { type: 'tarc', index },
        layer: a.layer,
        piece: { kind: 'arc', a: nm(a.start), m: nm(a.mid), b: nm(a.end) }
      })
  })

  // The net's pads, at their anchors in the file's coordinates.
  const pads: NetPad[] = []
  for (const bfp of board.footprints) {
    const tf = footprintTransform(bfp)
    for (const pad of bfp.footprint.pads) {
      if ((pad.net?.number ?? 0) !== net) continue
      const c = tfPoint(tf, pad.position.x, pad.position.y)
      const smd = pad.type === 'smd' || pad.type === 'connect'
      const position = { x: Math.round(c.x * 1e6), y: Math.round(-c.y * 1e6) }
      const rings = new Map<string, NmPt[] | null>()
      const ringOn = (layer: string): NmPt[] | null => {
        if (!rings.has(layer))
          rings.set(layer, padPolygon(padOnLayer(pad, layer), position, maxError))
        return rings.get(layer) ?? null
      }
      pads.push({
        pad,
        side: smd ? (copperOrder.find((l) => pad.layers.includes(l)) ?? bfp.layer) : bfp.layer,
        position,
        contains: (p, layer) => {
          if (!padHas(pad, layer)) return false
          if (p.x === position.x && p.y === position.y) return true
          const ring = ringOn(layer)
          return ring !== null && inPolygon(ring, p)
        }
      })
    }
  }

  const vias: LengthVia[] = board.vias
    .filter((v) => v.net === net)
    .map((v) => {
      const radiusOn = (layer: string): number => viaSizeOn(v, layer) / 2
      // A via in a pad carries the signal on to the pad's side.
      const host = pads.find((p) => p.contains(v.position, p.side))
      return {
        position: nm(v.position),
        top: v.layers[0],
        bottom: v.layers[v.layers.length - 1],
        radiusOn,
        maxRadius: Math.max(...v.layers.map(radiusOn), v.size / 2),
        padSide: host?.side ?? null
      }
    })

  return { tracks, vias, pads, copperOrder }
}

/**
 * Tracks, vias and pads summed as the length calculator sums them
 * (`netLength.ts`): every pad of the net cuts back a track ending on its
 * anchor, and the pads in `diePads` add their pad-to-die length.
 */
function measure(
  board: KicadBoard,
  c: NetCopper,
  tracks: readonly NetTrack[],
  vias: LengthVia[],
  diePads: readonly NetPad[],
  opts: TuneLengthOptions,
  delays: TuningDelays | null = null
): LengthStats {
  const lengthPads: LengthPad[] = c.pads.map((p) => ({
    position: p.position,
    contains: p.contains,
    flashed: (layer) => padHas(p.pad, layer),
    dieLength: diePads.includes(p) ? dieValue(p.pad, 'die_length') : 0,
    dieDelay: delays && diePads.includes(p) ? dieValue(p.pad, 'die_delay') : 0
  }))
  return netLength({
    lines: tracks.map((t) => ({ layer: t.layer, pieces: [t.piece] })),
    vias,
    pads: lengthPads,
    stackupHeight: stackupHeights(board),
    copperOrder: c.copperOrder,
    useHeight: opts.useHeight,
    delays
  })
}

const samePt = (p: NmPt, q: NmPt): boolean => p.x === q.x && p.y === q.y
const pieceLength = (p: Piece): number =>
  p.kind === 'seg' ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) : arcPieceLength(p.a, p.m, p.b)

/** How many steps a walk may take: KiCad bounds its own by time (`m_FollowBranchTimeout`). */
const WALK_BUDGET = 4096

/** The tracks, vias and end pads of the path the tuner measures through track `seed`. */
function tuningPath(
  c: NetCopper,
  seed: number
): { tracks: number[]; vias: number[]; pads: number[] } {
  const endsAt = new Map<string, number[]>()
  const endKey = (layer: string, p: NmPt): string => `${layer}:${p.x},${p.y}`
  c.tracks.forEach((t, i) => {
    for (const p of [t.piece.a, t.piece.b]) {
      const k = endKey(t.layer, p)
      endsAt.set(k, [...(endsAt.get(k) ?? []), i])
    }
  })
  // A line runs on through a corner only its two tracks meet at, as KiCad's `AssembleLine`.
  const corner = (layer: string, p: NmPt): boolean =>
    endsAt.get(endKey(layer, p))?.length === 2 &&
    !c.vias.some((v) => samePt(v.position, p)) &&
    !c.pads.some((pad) => samePt(pad.position, p))
  const line = (from: number): { tracks: number[]; ends: [NmPt, NmPt]; length: number } => {
    const tracks = [from]
    const layer = c.tracks[from].layer
    const ends: [NmPt, NmPt] = [c.tracks[from].piece.a, c.tracks[from].piece.b]
    for (const side of [0, 1] as const) {
      for (;;) {
        const at = ends[side]
        if (!corner(layer, at)) break
        const next = endsAt.get(endKey(layer, at))!.find((i) => !tracks.includes(i))
        if (next === undefined) break
        tracks.push(next)
        const p = c.tracks[next].piece
        ends[side] = samePt(p.a, at) ? p.b : p.a
      }
    }
    const length = tracks.reduce((sum, i) => sum + pieceLength(c.tracks[i].piece), 0)
    return { tracks, ends, length }
  }

  interface Step {
    at: NmPt
    layer: string
    tracks: number[]
    vias: number[]
    length: number
    visited: Set<string>
  }
  interface Walked {
    tracks: number[]
    vias: number[]
    pad: number | null
    length: number
  }
  // KiCad's `walkTuningPath`: on from one end of the line, keeping the longest way found.
  const walk = (from: NmPt, layer: string, visited: Set<string>): Walked => {
    let best: Walked = { tracks: [], vias: [], pad: null, length: -1 }
    const reached = (s: Step, pad: number | null, vias = s.vias): void => {
      if (s.length > best.length) best = { tracks: s.tracks, vias, pad, length: s.length }
    }
    const stack: Step[] = [{ at: from, layer, tracks: [], vias: [], length: 0, visited }]
    // Each line leaving where `touches` says, walked from its near end to its far one.
    const onward = (s: Step, touches: (layer: string, end: NmPt) => boolean): void => {
      c.tracks.forEach((t, i) => {
        if (s.visited.has(`t${i}`) || !(touches(t.layer, t.piece.a) || touches(t.layer, t.piece.b)))
          return
        const l = line(i)
        const far = touches(t.layer, l.ends[0]) ? l.ends[1] : l.ends[0]
        const visited = new Set(s.visited)
        for (const j of l.tracks) visited.add(`t${j}`)
        stack.push({
          at: far,
          layer: t.layer,
          tracks: [...s.tracks, ...l.tracks],
          vias: s.vias,
          length: s.length + l.length,
          visited
        })
      })
    }
    for (let budget = WALK_BUDGET; stack.length > 0 && budget > 0; budget--) {
      const s = stack.pop()!
      const pad = c.pads.findIndex((p, i) => !s.visited.has(`p${i}`) && p.contains(s.at, s.layer))
      if (pad >= 0) {
        reached(s, pad)
        // On through an in-line pad, so the tune spans the whole run.
        s.visited.add(`p${pad}`)
        onward(s, (layer, end) => c.pads[pad].contains(end, layer))
        continue
      }
      const via = c.vias.findIndex(
        (v, i) =>
          !s.visited.has(`v${i}`) &&
          Math.hypot(s.at.x - v.position.x, s.at.y - v.position.y) <= v.radiusOn(s.layer)
      )
      if (via < 0) {
        reached(s, null)
        continue
      }
      const v = c.vias[via]
      s.visited.add(`v${via}`)
      const before = stack.length
      onward(
        { ...s, vias: [...s.vias, via] },
        (layer, end) => Math.hypot(end.x - v.position.x, end.y - v.position.y) <= v.radiusOn(layer)
      )
      if (stack.length === before) reached(s, null, [...s.vias, via])
    }
    return best
  }

  const l = line(seed)
  const visited = new Set(l.tracks.map((i) => `t${i}`))
  const layer = c.tracks[seed].layer
  const left = walk(l.ends[0], layer, new Set(visited))
  const right = walk(l.ends[1], layer, new Set(visited))
  return {
    tracks: [...new Set([...left.tracks, ...l.tracks, ...right.tracks])],
    vias: [...new Set([...left.vias, ...right.vias])],
    pads: [...new Set([left.pad, right.pad].filter((p): p is number => p !== null))]
  }
}
