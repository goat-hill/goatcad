/**
 * Fanout — a footprint's pads each taken to a via, so an inner layer or a
 * plane can reach them. Altium's Route ▸ Fanout and Allegro's Create Fanout
 * are the reference; KiCad has none. The pattern is deterministic: which pads,
 * which style and which way are the caller's choices, and the geometry comes
 * from the board's rules — the net class's via and track, its clearance, the
 * board's hole rules. Nothing here loosens a rule to make a via fit: a pad
 * whose via cannot be placed is refused with the measured gap, and left for
 * the person or agent to decide (via-in-pad, a surface route, a smaller via).
 *
 * Styles (Altium's names where they have one):
 * - `dogbone` (Altium's BGA): a pad on a grid gets a via at the center of the
 *   four pads around it, reached by a short diagonal track. The corner is
 *   chosen per pad by `direction` — `out` away from the array's center, `in`
 *   towards it, or a fixed compass corner — which never gives two pads one site.
 * - `under-pads`: the via at the pad's center, no track (via-in-pad; a fab cost).
 * - `inline` / `staggered`: a row of pads (QFN, QFP, SOIC) each gets a track
 *   straight off its end and a via in a ring just clear of the row — every
 *   pad the inner ring first, or every other pad the next ring out, which is
 *   what lets vias wider than the pad pitch fit. Where a via's ring is taken
 *   (a neighbour's via, a part on the other side), it steps out a ring, up to
 *   three, before it is refused.
 * - `auto`: dogbone for a grid, staggered for rows.
 * An exposed pad (much larger than the rest, under the body) gets a via array
 * in any style, which is how it reaches its plane.
 *
 * The via is the net class's, or the caller's override, and nothing else: a
 * pad it does not fit is refused, never given a smaller one. The stub is the
 * class's width, no wider than the pad it leaves and, in a row (QFN, QFP),
 * narrowed to pass its neighbours' vias one pitch away, never under the
 * board's minimum track.
 *
 * Pads with nothing to fan out are skipped with the reason: through-hole (it
 * reaches every layer already), no net, a no-connect net, joined (its own
 * copper already joins the rest of its net: no airwire leaves its cluster),
 * via (its own copper already reaches a via, as a fanned-out pad's does), or
 * one of the outer `surfaceRows` of a grid left for surface routing. Joined
 * and via read the zones' stored fills, as the ratsnest does.
 *
 * The board edge holds each via and stub at the edge clearance DRC asks of
 * them (`drc/rules/edge.ts`), measured against the same Edge.Cuts centerlines.
 *
 * Coordinates: pads are laid out in footprint-local nm (x right, y down,
 * unrotated), checked in world mm (y up) against the spatial index, and
 * written in board nm (y down).
 */
import { mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import type { KicadBoard, KicadBoardFootprint } from '../kicad/board'
import { addSegmentToBoardAST, addViaToBoardAST } from '../kicad/board'
import type { KicadPad } from '../kicad/footprint'
import type { SExprNode } from '../kicad/sexpr'
import { isCopperLayer } from '../kicad/layers'
import { footprintTransform, tfPoint } from '../schematic/placement'
import { netClassForNet, type BoardDesignSettings } from '../kicad/project'
import { boardItems } from './boardItems'
import { clusterOfRef, computeConnectivity } from './boardConnectivity'
import { edgeCutsSegments } from './layerIndex'
import { boardRules, type BoardRules } from './rules/boardRules'
import { EDGE_RULE_ITEM } from './router/rules'
import {
  segmentToShape,
  shapeOn,
  type BoardSpatialIndex,
  type CopperItem,
  type CopperShape,
  type Pt
} from './spatialIndex'

export const FANOUT_STYLES = ['auto', 'dogbone', 'under-pads', 'inline', 'staggered'] as const
export type FanoutStyle = (typeof FANOUT_STYLES)[number]

export const FANOUT_DIRECTIONS = ['out', 'in', 'ne', 'se', 'sw', 'nw'] as const
export type FanoutDirection = (typeof FANOUT_DIRECTIONS)[number]

export interface FanoutOptions {
  /** Pad ids (`U1.A1`) to fan out; absent, every pad with a net. */
  pads?: readonly string[]
  /** Net names to fan out; absent, every net. */
  nets?: readonly string[]
  style?: FanoutStyle
  /** Which way the via sits from its pad. Rows take `out` or `in`; a grid any. Default `out`. */
  direction?: FanoutDirection
  /** A grid's outer rows left for surface routing, no via. Default 0. */
  surfaceRows?: number
  /** Via size and drill, mm; absent, the net class's. */
  via?: { size?: number; drill?: number }
}

/** What the board's rules say, in mm. */
export interface FanoutRules {
  classOf(netName: string): {
    /** The class's name, which the answer names a class's sizes by. */
    name?: string
    clearance: number
    trackWidth: number
    viaDiameter: number
    viaDrill: number
  }
  minClearance: number
  minHoleToHole: number
  minCopperHoleClearance: number
  /** The narrowest a stub may be narrowed to pass its neighbours' vias. */
  minTrackWidth: number
  /**
   * How far new copper of `net` on `layers` keeps from the board edge, as DRC
   * resolves `edge_clearance`; null where no rule holds it there.
   */
  edgeClearance(net: number, kind: 'track' | 'via', layers: readonly string[]): number | null
}

/** Whether a footprint has anything to fan out: SMD copper on a net. */
export const fanoutEligible = (bfp: KicadBoardFootprint): boolean =>
  bfp.footprint.pads.some((pad) => !pad.drill && pad.type === 'smd' && (pad.net?.number ?? 0) > 0)

/** The rules a fanout reads, from the board's project settings and custom rules. */
export const fanoutRulesOf = (settings: BoardDesignSettings, board: KicadBoard): FanoutRules => {
  let rules: BoardRules | null = null
  const ruleSet = (): BoardRules => (rules ??= boardRules(board, settings, settings.customRules))
  const edge = new Map<string, number | null>()
  return {
    classOf: (netName) =>
      netClassForNet(netName, settings.classes, settings.patterns, settings.assignments),
    minClearance: settings.rules.minClearance,
    minHoleToHole: settings.rules.minHoleToHole,
    minCopperHoleClearance: settings.rules.minCopperHoleClearance,
    minTrackWidth: settings.rules.minTrackWidth,
    edgeClearance: (net, kind, layers) => {
      const key = `${kind}|${net}|${layers.join(',')}`
      if (!edge.has(key)) {
        // The edge and the new item, as the edge check asks of them (`drc/rules/edge.ts`).
        const resolved = ruleSet().resolver.evaluate(
          'edge_clearance',
          EDGE_RULE_ITEM,
          ruleSet().newItem(kind, net, layers),
          null
        )
        edge.set(
          key,
          resolved.isNull || resolved.severity === 'ignore' ? null : (resolved.value.min ?? 0)
        )
      }
      return edge.get(key) ?? null
    }
  }
}

/** One via the plan places, and the track to it when there is one. */
export interface FanoutEscape {
  pad: string
  net: number
  netName: string
  /** Board nm, y down. */
  via: { x: Nm; y: Nm }
  size: Nm
  drill: Nm
  track?: { from: { x: Nm; y: Nm }; width: Nm; layer: string }
}

export interface FanoutPlan {
  footprint: string
  /** How the pads were read: a grid (BGA), rows (QFN, QFP, SOIC), or neither. */
  layout: 'grid' | 'rows' | 'other'
  style: Exclude<FanoutStyle, 'auto'>
  /** The copper layer the tracks run on: the footprint's side. */
  layer: string
  /** The via's layer span: through, first copper to last. */
  viaLayers: [string, string]
  escapes: FanoutEscape[]
  surface: string[]
  skipped: { pad: string; reason: string }[]
  refused: { pad: string; reason: string }[]
}

export type FanoutOutcome =
  | { ok: true; plan: FanoutPlan }
  | { ok: false; error: 'not-applicable' | 'pad-not-found'; detail: string; candidates?: string[] }

const TOLERANCE_NM = 2_000
/** How much larger than the median pad an exposed pad is, by area. */
const EXPOSED_PAD_FACTOR = 4
/** A grid pad is round or square; a row pad is long. */
const SQUARE_ASPECT = 1.3
/** An exposed pad's via pitch never goes below this, mm: the common thermal-via spacing. */
const THERMAL_PITCH_MM = 1.0
const EPSILON_MM = 0.0005

const round3 = (value: number): number => Math.round(value * 1000) / 1000
const isNoConnectNet = (name: string): boolean => name.startsWith('unconnected-')

interface Candidate {
  bfpPad: KicadPad
  /** The pad in the copper index. */
  item: CopperItem
  padIndex: number
  id: string
  net: number
  netName: string
  /** Footprint-local nm. */
  local: { x: number; y: number }
  /** Width and height in the footprint's frame, nm. */
  w: number
  h: number
}

/** A via or track the plan has placed, as later placements see it. */
interface Placed {
  shape: CopperShape
  net: number
  /** null for a via: it is on every layer. */
  layer: string | null
  owner: string
  hole?: { c: Pt; r: number }
}

interface Hole {
  c: Pt
  r: number
  net: number
  name: string
}

/** A pad's size in its footprint's frame: turned a quarter, its width is its height. */
const frameSize = (pad: KicadPad, bfp: KicadBoardFootprint): { w: number; h: number } => {
  const relative = ((((pad.position.angle ?? 0) - (bfp.position.angle ?? 0)) % 180) + 180) % 180
  const quarter = Math.abs(relative - 90) < 1
  return quarter ? { w: pad.size.h, h: pad.size.w } : { w: pad.size.w, h: pad.size.h }
}

/** Distinct values within tolerance, sorted. */
const distinct = (values: number[]): number[] => {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  for (const value of sorted)
    if (!out.length || value - out[out.length - 1] > TOLERANCE_NM) out.push(value)
  return out
}

/** The pitch of values on a lattice, or null when they are not on one. */
const latticePitch = (values: number[]): number | null => {
  const steps = distinct(values)
  if (steps.length < 3) return null
  let pitch = Infinity
  for (let i = 1; i < steps.length; i += 1) pitch = Math.min(pitch, steps[i] - steps[i - 1])
  for (let i = 1; i < steps.length; i += 1) {
    const ratio = (steps[i] - steps[0]) / pitch
    if (Math.abs(ratio - Math.round(ratio)) * pitch > TOLERANCE_NM) return null
  }
  return pitch
}

/**
 * Plan a fanout of one footprint. Pure: reads the board and its index,
 * writes nothing — `applyFanout` writes what it answers.
 */
export function planFanout(
  board: KicadBoard,
  index: BoardSpatialIndex,
  footprintIndex: number,
  options: FanoutOptions,
  rules: FanoutRules
): FanoutOutcome {
  const bfp = board.footprints[footprintIndex]
  const items = boardItems(board)
  const footprintId =
    items.find((item) => item.kind === 'footprint' && item.raw === bfp._raw)?.id ??
    bfp.reference ??
    '?'
  const padIds = new Map<KicadPad, string>()
  for (const item of items)
    if (item.kind === 'pad' && item.footprint === bfp && item.pad) padIds.set(item.pad, item.id)

  const copper = board.layers.map((layer) => layer.name).filter(isCopperLayer)
  const side = bfp.layer === 'B.Cu' ? (copper[copper.length - 1] ?? 'B.Cu') : (copper[0] ?? 'F.Cu')
  const viaLayers: [string, string] = [copper[0] ?? 'F.Cu', copper[copper.length - 1] ?? 'B.Cu']

  if (options.pads) {
    const known = new Set(padIds.values())
    const unknown = options.pads.filter((pad) => !known.has(pad))
    if (unknown.length)
      return {
        ok: false,
        error: 'pad-not-found',
        detail: `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a pad of ${footprintId}.`,
        candidates: [...known].slice(0, 24)
      }
  }
  if (
    options.via?.size !== undefined &&
    options.via.drill !== undefined &&
    options.via.drill >= options.via.size
  )
    return {
      ok: false,
      error: 'not-applicable',
      detail: 'A via drill must be smaller than its size.'
    }
  const wantedPads = options.pads ? new Set(options.pads) : null
  const wantedNets = options.nets ? new Set(options.nets) : null

  const skipped: FanoutPlan['skipped'] = []
  const refused: FanoutPlan['refused'] = []
  const surface: string[] = []
  const escapes: FanoutEscape[] = []

  // The pads that are copper on the footprint's side: the ones a fanout reads.
  const sidePads: Candidate[] = []
  bfp.footprint.pads.forEach((pad, padIndex) => {
    const id = padIds.get(pad)
    if (!id) return
    if (pad.drill || pad.type === 'thru_hole' || pad.type === 'np_thru_hole') {
      if (wantedPads?.has(id)) skipped.push({ pad: id, reason: 'through-hole' })
      return
    }
    const indexed = index.items.find(
      (item) =>
        item.ref.type === 'pad' && item.ref.index === footprintIndex && item.ref.pad === padIndex
    )
    if (!indexed?.layers.includes(side)) return
    const { w, h } = frameSize(pad, bfp)
    sidePads.push({
      bfpPad: pad,
      item: indexed,
      padIndex,
      id,
      net: pad.net?.number ?? 0,
      netName: pad.net?.name ?? '',
      local: { x: pad.position.x, y: pad.position.y },
      w,
      h
    })
  })

  // An exposed pad is much larger than the rest; it gets a via array, not a via.
  const areas = sidePads.map((pad) => pad.w * pad.h).sort((a, b) => a - b)
  const median = areas[Math.floor(areas.length / 2)] ?? 0
  const exposed = new Set(
    sidePads.length > 2 ? sidePads.filter((pad) => pad.w * pad.h > median * EXPOSED_PAD_FACTOR) : []
  )
  const signal = sidePads.filter((pad) => !exposed.has(pad))

  const squarish = signal.every(
    (pad) => Math.max(pad.w, pad.h) / Math.max(1, Math.min(pad.w, pad.h)) <= SQUARE_ASPECT
  )
  const pitchX = latticePitch(signal.map((pad) => pad.local.x))
  const pitchY = latticePitch(signal.map((pad) => pad.local.y))
  const layout: FanoutPlan['layout'] =
    signal.length >= 4 && squarish && pitchX && pitchY
      ? 'grid'
      : signal.length >= 2
        ? 'rows'
        : 'other'

  const requested = options.style ?? 'auto'
  const style: FanoutPlan['style'] =
    requested === 'auto'
      ? layout === 'grid'
        ? 'dogbone'
        : layout === 'rows'
          ? 'staggered'
          : 'under-pads'
      : requested
  if (style === 'dogbone' && layout !== 'grid')
    return {
      ok: false,
      error: 'not-applicable',
      detail: `${footprintId}'s pads are not on a grid, so a dogbone has no site between them. Use inline, staggered or under-pads.`
    }
  if ((style === 'inline' || style === 'staggered') && layout === 'grid')
    return {
      ok: false,
      error: 'not-applicable',
      detail: `${footprintId}'s pads are a grid: an inner pad has no end to leave from. Use dogbone or under-pads.`
    }
  const direction = options.direction ?? 'out'
  if ((style === 'inline' || style === 'staggered') && direction !== 'out' && direction !== 'in')
    return {
      ok: false,
      error: 'not-applicable',
      detail: `A row of pads leaves out or in; ${direction} is a corner, which only a grid's dogbone takes.`
    }

  // The array's center and extent, from the signal pads.
  const xs = signal.map((pad) => pad.local.x)
  const ys = signal.map((pad) => pad.local.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }

  const tf = footprintTransform(bfp)
  const world = (local: { x: number; y: number }): Pt =>
    tfPoint(tf, Math.round(local.x) as Nm, Math.round(local.y) as Nm)
  const toBoard = (p: Pt): { x: Nm; y: Nm } => ({ x: mmToNm(round3(p.x)), y: mmToNm(round3(-p.y)) })

  // Holes on the board, for hole-to-hole and copper-to-hole.
  const holes: Hole[] = []
  const nameOfVia = new Map<number, string>()
  const nameOfSegment = new Map<number, string>()
  const nameOfArc = new Map<number, string>()
  const idByRaw = new Map<SExprNode, string>()
  for (const item of items) idByRaw.set(item.raw, item.id)
  board.vias.forEach((via, i) => {
    const name = idByRaw.get(via._raw) ?? `via ${i}`
    nameOfVia.set(i, name)
    holes.push({
      c: { x: nmToMm(via.position.x), y: -nmToMm(via.position.y) },
      r: nmToMm(via.drill) / 2,
      net: via.net,
      name
    })
  })
  board.segments.forEach((seg, i) => nameOfSegment.set(i, idByRaw.get(seg._raw) ?? `track ${i}`))
  board.trackArcs.forEach((arc, i) => nameOfArc.set(i, idByRaw.get(arc._raw) ?? `arc ${i}`))
  for (const item of items) {
    if (item.kind !== 'pad' || !item.pad?.drill || !item.footprint) continue
    const ftf = footprintTransform(item.footprint)
    const at = tfPoint(ftf, item.pad.position.x, item.pad.position.y)
    const drill = item.pad.drill
    const size = drill.oval ? Math.min(drill.oval.width, drill.oval.height) : drill.diameter
    holes.push({ c: at, r: nmToMm(size as Nm) / 2, net: item.pad.net?.number ?? 0, name: item.id })
  }

  const nameOf = (ref: (typeof index.items)[number]['ref']): string => {
    switch (ref.type) {
      case 'pad': {
        const pad = board.footprints[ref.index]?.footprint.pads[ref.pad]
        return (
          (pad && padIds.get(pad)) ??
          items.find((i) => i.kind === 'pad' && i.pad === pad)?.id ??
          'a pad'
        )
      }
      case 'via':
        return nameOfVia.get(ref.index) ?? 'a via'
      case 'segment':
        return nameOfSegment.get(ref.index) ?? 'a track'
      case 'tarc':
        return nameOfArc.get(ref.index) ?? 'a track arc'
      default:
        return 'copper'
    }
  }

  // The board edge as the edge check measures it: every Edge.Cuts centerline.
  const edges = edgeCutsSegments(board).map(([a, b]) => ({
    a,
    b,
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y)
  }))

  const placed: Placed[] = []
  const netNames = new Map(board.nets.map((net) => [net.number, net.name]))
  const clearanceBetween = (a: number, b: number): number =>
    Math.max(
      rules.minClearance,
      rules.classOf(netNames.get(a) ?? '').clearance,
      rules.classOf(netNames.get(b) ?? '').clearance
    )

  /** The first rule a via (and its track) would break, as a sentence; null when it fits. */
  const conflict = (
    net: number,
    via: Pt,
    viaR: number,
    drillR: number,
    track: { from: Pt; half: number } | null
  ): string | null => {
    const fmt = (gap: number): string => `${round3(Math.max(0, gap))} mm`
    // Copper: the via on every copper layer, the track on the footprint's side.
    const shapes: { what: string; a: Pt; b: Pt; half: number; layers: readonly string[] }[] = [
      { what: 'via', a: via, b: via, half: viaR, layers: copper }
    ]
    if (track)
      shapes.push({ what: 'track', a: track.from, b: via, half: track.half, layers: [side] })
    for (const probe of shapes) {
      const reach = probe.half + Math.max(rules.minClearance, rules.classOf('').clearance) + 1
      for (const layer of probe.layers) {
        for (const hit of index.nearSegment(probe.a.x, probe.a.y, probe.b.x, probe.b.y, reach, {
          layer,
          excludeNet: net
        })) {
          const need = clearanceBetween(net, hit.item.net)
          const gap =
            segmentToShape(
              shapeOn(hit.item, layer),
              probe.a.x,
              probe.a.y,
              probe.b.x,
              probe.b.y,
              0
            ) - probe.half
          if (gap < need - EPSILON_MM)
            return `${probe.what} ${fmt(gap)} from ${nameOf(hit.item.ref)} on ${layer}; the rule is ${round3(need)} mm`
        }
      }
      for (const other of placed) {
        // Another net's copper, and another via of this one: two vias whose
        // rings overlap add almost nothing to one, and fabs flag the sliver.
        // Same-net tracks may touch, as a route does.
        const viaPair = probe.what === 'via' && other.layer === null
        if (other.net === net && !viaPair) continue
        if (other.layer && !probe.layers.includes(other.layer)) continue
        const need = clearanceBetween(net, other.net)
        const gap =
          segmentToShape(other.shape, probe.a.x, probe.a.y, probe.b.x, probe.b.y, 0) - probe.half
        if (gap < need - EPSILON_MM)
          return `${probe.what} ${fmt(gap)} from the ${other.layer ? 'track' : 'via'} for ${other.owner}; the rule is ${round3(need)} mm`
      }
      // The edge: touching it fails even where the clearance is 0, as DRC holds it.
      const edgeNeed = edges.length
        ? rules.edgeClearance(net, probe.what === 'via' ? 'via' : 'track', probe.layers)
        : null
      if (edgeNeed !== null) {
        const shape: CopperShape =
          probe.what === 'via'
            ? { kind: 'circle', cx: via.x, cy: via.y, r: viaR }
            : {
                kind: 'capsule',
                x0: probe.a.x,
                y0: probe.a.y,
                x1: probe.b.x,
                y1: probe.b.y,
                halfWidth: probe.half
              }
        const reach = probe.half + edgeNeed + EPSILON_MM
        const minX = Math.min(probe.a.x, probe.b.x) - reach
        const minY = Math.min(probe.a.y, probe.b.y) - reach
        const maxX = Math.max(probe.a.x, probe.b.x) + reach
        const maxY = Math.max(probe.a.y, probe.b.y) + reach
        for (const edge of edges) {
          if (edge.maxX < minX || edge.minX > maxX || edge.maxY < minY || edge.minY > maxY) continue
          const gap = segmentToShape(shape, edge.a.x, edge.a.y, edge.b.x, edge.b.y, 0)
          if (gap <= 0 || gap < edgeNeed - EPSILON_MM)
            return `${probe.what} ${fmt(gap)} from the board edge; the rule is ${round3(edgeNeed)} mm`
        }
      }
    }
    // Holes: ours to every other, and copper of another net to ours and theirs.
    const allHoles: Hole[] = [
      ...holes,
      ...placed.flatMap((other) =>
        other.hole
          ? [
              {
                c: other.hole.c,
                r: other.hole.r,
                net: other.net,
                name: `the via for ${other.owner}`
              }
            ]
          : []
      )
    ]
    for (const hole of allHoles) {
      const centers = Math.hypot(hole.c.x - via.x, hole.c.y - via.y)
      const between = centers - hole.r - drillR
      // Two holes in one spot are one hole drilled twice: never a fit.
      if (centers <= EPSILON_MM) return `drill on ${hole.name}'s, in the same spot`
      if (between < rules.minHoleToHole - EPSILON_MM)
        return `drill ${fmt(between)} from ${hole.name}'s; the hole-to-hole rule is ${round3(rules.minHoleToHole)} mm`
      if (hole.net === net) continue
      const copperGap = centers - hole.r - viaR
      if (copperGap < rules.minCopperHoleClearance - EPSILON_MM)
        return `via ${fmt(copperGap)} from ${hole.name}'s hole; the copper-to-hole rule is ${round3(rules.minCopperHoleClearance)} mm`
      if (track) {
        const trackGap =
          segmentToShape(
            { kind: 'circle', cx: hole.c.x, cy: hole.c.y, r: hole.r },
            track.from.x,
            track.from.y,
            via.x,
            via.y,
            0
          ) - track.half
        if (trackGap < rules.minCopperHoleClearance - EPSILON_MM)
          return `track ${fmt(trackGap)} from ${hole.name}'s hole; the copper-to-hole rule is ${round3(rules.minCopperHoleClearance)} mm`
      }
    }
    return null
  }

  type Via = { size: number; drill: number }
  /** The pad's via: the override where given, else its net class's. */
  const viaFor = (netName: string): Via => {
    const cls = rules.classOf(netName)
    return { size: options.via?.size ?? cls.viaDiameter, drill: options.via?.drill ?? cls.viaDrill }
  }
  /** The stub's width: the class's, no wider than the pad's narrow side, never under the board's minimum. */
  const trackFor = (pad: Candidate): number =>
    Math.max(
      rules.minTrackWidth,
      Math.min(rules.classOf(pad.netName).trackWidth, nmToMm(Math.min(pad.w, pad.h) as Nm))
    )

  /**
   * Place the pad's via at `site` (footprint-local nm), with a stub `width`
   * mm wide when one is given; answers the rule it would break instead.
   */
  const tryPlace = (
    pad: Candidate,
    site: { x: number; y: number },
    width?: number
  ): string | null => {
    const sizes = viaFor(pad.netName)
    const from = world(pad.local)
    const track = width !== undefined ? { from, half: width / 2 } : null
    const via = world(site)
    const problem = conflict(pad.net, via, sizes.size / 2, sizes.drill / 2, track)
    if (problem) return problem
    placed.push({
      shape: { kind: 'circle', cx: via.x, cy: via.y, r: sizes.size / 2 },
      net: pad.net,
      layer: null,
      owner: pad.id,
      hole: { c: via, r: sizes.drill / 2 }
    })
    if (track)
      placed.push({
        shape: {
          kind: 'capsule',
          x0: from.x,
          y0: from.y,
          x1: via.x,
          y1: via.y,
          halfWidth: track.half
        },
        net: pad.net,
        layer: side,
        owner: pad.id
      })
    escapes.push({
      pad: pad.id,
      net: pad.net,
      netName: pad.netName,
      via: toBoard(via),
      size: mmToNm(sizes.size),
      drill: mmToNm(sizes.drill),
      ...(width !== undefined
        ? { track: { from: toBoard(from), width: mmToNm(width), layer: side } }
        : {})
    })
    return null
  }

  // Each pad is judged on its own cluster. The ratsnest spans a split net's
  // clusters, so one stray piece of the net leaves every cluster an airwire:
  // the via test is what keeps a re-run from stacking a second via.
  const connectivity = computeConnectivity(
    board,
    index,
    new Set(sidePads.map((pad) => pad.net).filter((net) => net > 0))
  )
  /** Per net, the clusters an airwire leaves and the clusters holding a via. */
  const clusters = new Map<number, { wired: Set<number>; vias: Set<number> }>()
  const clustersOf = (net: number): { wired: Set<number>; vias: Set<number> } => {
    let known = clusters.get(net)
    if (!known) {
      known = { wired: new Set(), vias: new Set() }
      const conn = connectivity.nets.get(net)
      for (const wire of conn?.airwires ?? [])
        for (const end of [wire.fromRef, wire.toRef]) {
          const cluster = conn && clusterOfRef(conn, index, end)
          if (cluster !== undefined) known.wired.add(cluster)
        }
      for (const [id, cluster] of conn?.clusterOfItem ?? [])
        if (index.items[id]?.ref.type === 'via') known.vias.add(cluster)
      clusters.set(net, known)
    }
    return known
  }
  const clusterOf = (pad: Candidate): number | undefined =>
    connectivity.nets.get(pad.net)?.clusterOfItem.get(pad.item.id)
  /** Joined: no airwire leaves the pad's own copper. */
  const joined = (pad: Candidate): boolean => {
    const cluster = clusterOf(pad)
    return cluster !== undefined && !clustersOf(pad.net).wired.has(cluster)
  }
  /** The pad's own copper already reaches a via, as a fanned-out pad's does. */
  const hasVia = (pad: Candidate): boolean => {
    const cluster = clusterOf(pad)
    return cluster !== undefined && clustersOf(pad.net).vias.has(cluster)
  }

  /** Whether a pad is asked for, and has something to fan out; records why not. */
  const eligible = (pad: Candidate): boolean => {
    if (wantedPads && !wantedPads.has(pad.id)) return false
    if (wantedNets && !wantedNets.has(pad.netName)) return false
    if (pad.net === 0) return (skipped.push({ pad: pad.id, reason: 'no net' }), false)
    if (isNoConnectNet(pad.netName))
      return (skipped.push({ pad: pad.id, reason: 'no-connect' }), false)
    if (joined(pad)) return (skipped.push({ pad: pad.id, reason: 'joined' }), false)
    if (hasVia(pad)) return (skipped.push({ pad: pad.id, reason: 'via' }), false)
    return true
  }

  // --- the signal pads -----------------------------------------------------
  if (layout === 'grid' && pitchX && pitchY) {
    const ring = (pad: Candidate): number =>
      Math.min(
        Math.round((pad.local.x - minX) / pitchX),
        Math.round((maxX - pad.local.x) / pitchX),
        Math.round((pad.local.y - minY) / pitchY),
        Math.round((maxY - pad.local.y) / pitchY)
      )
    // Rows top to bottom, then left to right: the order a person reads the ball map.
    const ordered = [...signal].sort((a, b) => a.local.y - b.local.y || a.local.x - b.local.x)
    for (const pad of ordered) {
      if (!eligible(pad)) continue
      if (ring(pad) < (options.surfaceRows ?? 0)) {
        surface.push(pad.id)
        continue
      }
      if (style === 'under-pads') {
        const problem = tryPlace(pad, pad.local)
        if (problem) refused.push({ pad: pad.id, reason: problem })
        continue
      }
      const away = (value: number, mid: number): number => (value < mid - TOLERANCE_NM ? -1 : 1)
      // Local y runs down: north is -y.
      const fixed: Record<string, [number, number]> = {
        ne: [1, -1],
        se: [1, 1],
        sw: [-1, 1],
        nw: [-1, -1]
      }
      let [sx, sy] = fixed[direction] ?? [away(pad.local.x, center.x), away(pad.local.y, center.y)]
      if (direction === 'in') {
        sx = -sx
        sy = -sy
      }
      // A compass corner is what was asked for. Out and in are a preference:
      // where that corner is taken, the two beside it and then the opposite
      // one are tried, as Altium's Towards Center does — on an odd grid the
      // center ball's corner inward is always another ball's.
      const corners: [number, number][] = fixed[direction]
        ? [[sx, sy]]
        : [
            [sx, sy],
            [sx, -sy],
            [-sx, sy],
            [-sx, -sy]
          ]
      let first: string | null = null
      for (const [cx, cy] of corners) {
        const site = { x: pad.local.x + (cx * pitchX) / 2, y: pad.local.y + (cy * pitchY) / 2 }
        const problem = tryPlace(pad, site, trackFor(pad))
        if (!problem) {
          first = null
          break
        }
        first ??= problem
      }
      if (first) refused.push({ pad: pad.id, reason: first })
    }
  } else if (layout === 'rows' || layout === 'other') {
    const halfW = Math.max(1, (maxX - minX) / 2)
    const halfH = Math.max(1, (maxY - minY) / 2)
    // Each side's pads in order along it, so staggering alternates along the row.
    const sideOf = (pad: Candidate): { axis: 'x' | 'y'; sign: number } => {
      const dx = (pad.local.x - center.x) / halfW
      const dy = (pad.local.y - center.y) / halfH
      return Math.abs(dx) >= Math.abs(dy)
        ? { axis: 'x', sign: dx < 0 ? -1 : 1 }
        : { axis: 'y', sign: dy < 0 ? -1 : 1 }
    }
    const groups = new Map<string, Candidate[]>()
    for (const pad of signal) {
      const s = sideOf(pad)
      const key = `${s.axis}${s.sign}`
      groups.set(key, [...(groups.get(key) ?? []), pad])
    }
    for (const [key, pads] of groups) {
      const along = key.startsWith('x') ? 'y' : 'x'
      pads.sort((a, b) => a.local[along] - b.local[along])
      // The row's pitch, and each pad's place in it: the stagger follows the
      // pad's position, not how many pads before it were fanned out, so two
      // neighbours never land on one ring because a no-connect sat between.
      const steps = pads
        .slice(1)
        .map((pad, i) => pad.local[along] - pads[i].local[along])
        .filter((step) => step > TOLERANCE_NM)
      const pitchNm = steps.length ? Math.min(...steps) : 0
      const slot = (pad: Candidate): number =>
        pitchNm ? Math.round((pad.local[along] - pads[0].local[along]) / pitchNm) : 0
      const live = pads.filter((pad) => eligible(pad))
      if (style === 'under-pads') {
        for (const pad of live) {
          const problem = tryPlace(pad, pad.local)
          if (problem) refused.push({ pad: pad.id, reason: problem })
        }
        continue
      }
      // Each stub runs one pitch from its neighbours' vias, so a via's radius,
      // the clearance and the stub's half-width share that pitch: each stub is
      // the widest that clears the vias of the neighbours it actually has.
      const pitch = nmToMm(pitchNm as Nm)
      const neighbours = (pad: Candidate): Candidate[] =>
        live.filter((other) => Math.abs(slot(other) - slot(pad)) === 1)
      const clearanceOf = (pad: Candidate): number => clearanceBetween(pad.net, 0)
      const stubs = new Map<Candidate, number>()
      for (const pad of live) {
        const nearest = Math.max(0, ...neighbours(pad).map((other) => viaFor(other.netName).size))
        const room = pitch ? 2 * (pitch - clearanceOf(pad) - nearest / 2) : Infinity
        stubs.set(pad, Math.max(rules.minTrackWidth, Math.min(trackFor(pad), room)))
      }
      const largest = Math.max(0, ...live.map((pad) => viaFor(pad.netName).size))
      for (const pad of live) {
        const { axis, sign } = sideOf(pad)
        const outward = direction === 'in' ? -sign : sign
        const extent = nmToMm((axis === 'x' ? pad.w : pad.h) as Nm) / 2
        const clearance = clearanceOf(pad)
        // Rings of vias off the row's ends, spaced by the row's largest via.
        // Staggered takes the inner ring for every other pad and the next for
        // the rest; either falls back to the other ring, then further out,
        // where something on the other side of the board sits in the way.
        const ringStep = largest + clearance
        const via = viaFor(pad.netName)
        const siteAt = (ring: number): { x: number; y: number } => {
          const offset = mmToNm(extent + clearance + via.size / 2 + ring * ringStep)
          return axis === 'x'
            ? { x: pad.local.x + outward * offset, y: pad.local.y }
            : { x: pad.local.x, y: pad.local.y + outward * offset }
        }
        const preferred = style === 'staggered' && slot(pad) % 2 === 1 ? 1 : 0
        const rings = [preferred, 1 - preferred, 2, 3]
        let problem: string | null = null
        for (const ring of rings) {
          const tried = tryPlace(pad, siteAt(ring), stubs.get(pad))
          if (!tried) {
            problem = null
            break
          }
          problem ??= tried
        }
        if (problem) refused.push({ pad: pad.id, reason: problem })
      }
    }
  }

  // --- exposed pads: a via array ------------------------------------------
  for (const pad of exposed) {
    if (!eligible(pad)) continue
    const sizes = viaFor(pad.netName)
    const pitch = Math.max(THERMAL_PITCH_MM, sizes.size, sizes.drill + rules.minHoleToHole)
    const w = nmToMm(pad.w as Nm)
    const h = nmToMm(pad.h as Nm)
    const nx = Math.max(1, Math.floor((w - sizes.size) / pitch) + 1)
    const ny = Math.max(1, Math.floor((h - sizes.size) / pitch) + 1)
    let refusedHere: string | null = null
    let placedHere = 0
    for (let iy = 0; iy < ny; iy += 1)
      for (let ix = 0; ix < nx; ix += 1) {
        const site = {
          x: pad.local.x + mmToNm((ix - (nx - 1) / 2) * pitch),
          y: pad.local.y + mmToNm((iy - (ny - 1) / 2) * pitch)
        }
        const problem = tryPlace(pad, site)
        if (problem) refusedHere ??= problem
        else placedHere += 1
      }
    if (!placedHere && refusedHere) refused.push({ pad: pad.id, reason: refusedHere })
  }

  return {
    ok: true,
    plan: {
      footprint: footprintId,
      layout,
      style,
      layer: side,
      viaLayers,
      escapes,
      surface,
      skipped,
      refused
    }
  }
}

/**
 * Write a plan's tracks and vias into the board's AST. Returns each escape's
 * via node, in the plan's order, so a caller can name what it made once the
 * board is re-read.
 */
export function applyFanout(board: KicadBoard, plan: FanoutPlan): SExprNode[] {
  const root = board._raw as { children: SExprNode[] }
  const vias: SExprNode[] = []
  for (const escape of plan.escapes) {
    if (escape.track)
      addSegmentToBoardAST(board, {
        start: escape.track.from,
        end: escape.via,
        width: escape.track.width,
        layer: escape.track.layer,
        net: escape.net
      })
    addViaToBoardAST(board, {
      position: escape.via,
      size: escape.size,
      drill: escape.drill,
      layers: [...plan.viaLayers],
      net: escape.net
    })
    vias.push(root.children[root.children.length - 1])
  }
  return vias
}
