/**
 * "Why this limit?": what the rules hold one item to, or two items to each
 * other, each limit with the rule that set it and the steps the resolver took
 * to get there (`resolver.ts`, asked to explain). The same answers DRC, the
 * router and the zone filler act on, as KiCad's Inspect → Clearance
 * Resolution and Constraints Resolution report them.
 *
 * Two items: on each copper layer both reach, their clearance (0 between
 * copper of one net), a physical clearance where the project sets one, how a
 * pad joins a zone of its net; and, where they have holes, hole clearance and
 * hole to hole. One item: the sizes its kind is checked for — a track's width;
 * a via's diameter, annular width and hole; a drilled pad's annular width and
 * hole. Millimeters.
 */
import { allZones, type KicadBoard, type KicadBoardZone } from '../../kicad/board'
import { expandLayerToken, isCopperLayer } from '../../kicad/layers'
import { netTieGroups } from '../../footprint/footprintChecks'
import type { BoardItem } from '../boardItems'
import type { BoardSpatialIndex } from '../spatialIndex'
import type { BoardRules } from './boardRules'
import type { ConstraintType, RuleItem } from './constraints'
import type { TrailEvent } from './resolver'

export type ExplainedConstraint = Extract<
  ConstraintType,
  | 'clearance'
  | 'physical_clearance'
  | 'hole_clearance'
  | 'physical_hole_clearance'
  | 'hole_to_hole'
  | 'zone_connection'
  | 'track_width'
  | 'via_diameter'
  | 'annular_width'
  | 'hole_size'
>

export interface ExplainedLimit {
  constraint: ExplainedConstraint
  /** The copper layer it holds on; null where the limit is not a layer's. */
  layer: string | null
  min?: number
  opt?: number
  max?: number
  /** `zone_connection`: how the pad joins, with the relief's gap and spoke width. */
  connection?: { style: 'solid' | 'thermal' | 'none'; gap: number; spokeWidth: number }
  /** Who set it, as a finding names it: a rule, `pad`, `footprint R1`, `board minimum`. */
  source: string
  /** Why the rules were not asked: the two are copper of one net. */
  sameNet?: true
  /** No rule sets one: the check has nothing to hold the item to. */
  unset?: true
  /** The resolver's steps, in order. */
  steps: TrailEvent[]
}

/** An item as the rules read it, with what it owns on the board. */
export interface ExplainTarget {
  rule: RuleItem
  copper: readonly string[]
  zone: KicadBoardZone | null
}

const holed = (t: ExplainTarget): boolean => !!t.rule.hasHole

/** The board's copper layers an item's layer tokens (`*.Cu`, `F&B.Cu`) reach. */
const copperOf = (board: KicadBoard, tokens: readonly string[]): string[] => {
  const copper = board.layers.map((l) => l.name).filter(isCopperLayer)
  return copper.filter((layer) =>
    tokens.some((token) => token === '*.Cu' || expandLayerToken(token).includes(layer))
  )
}

/** A board item by where it sits in the board's arrays, as the editor selects it. */
export interface ExplainRef {
  type: string
  index: number
  /** A pad's index in its footprint, `index` being the footprint's. */
  pad?: number
}

/** The rules' view of an item; null for one the rules hold to nothing (graphics, text). */
export function explainTargetOf(
  board: KicadBoard,
  index: BoardSpatialIndex,
  rules: BoardRules,
  ref: ExplainRef
): ExplainTarget | null {
  const indexed = (type: 'segment' | 'tarc' | 'via'): ExplainTarget | null => {
    const found = index.items.find((c) => c.ref.type === type && c.ref.index === ref.index)
    if (!found) return null
    const rule = rules.copperItem(found)
    return { rule, copper: copperOf(board, rule.layers), zone: null }
  }
  switch (ref.type) {
    case 'pad': {
      // As DRC reads the pad: the index's copper, with the nets its footprint
      // ties to it (`net_tie_pad_groups`), which the resolver holds to 0.
      const found = index.items.find(
        (c) => c.ref.type === 'pad' && c.ref.index === ref.index && c.ref.pad === ref.pad
      )
      if (!found) return null
      const footprint = board.footprints[ref.index].footprint
      const groups = netTieGroups(footprint)
      const group = groups.get(footprint.pads[ref.pad!].number)
      const netTies = new Set<number>()
      if (group !== undefined)
        for (const item of index.items)
          if (
            item.ref.type === 'pad' &&
            item.ref.index === ref.index &&
            item.net > 0 &&
            item.net !== found.net &&
            groups.get(footprint.pads[item.ref.pad].number) === group
          )
            netTies.add(item.net)
      const rule = rules.copperItem(found)
      return {
        rule: netTies.size > 0 ? { ...rule, netTies } : rule,
        copper: copperOf(board, rule.layers),
        zone: null
      }
    }
    case 'segment':
    case 'tarc':
    case 'via':
      return indexed(ref.type)
    case 'zone': {
      const zone = allZones(board)[ref.index]
      return zone && !zone.isKeepout
        ? { rule: rules.zoneItem(zone), copper: copperOf(board, zone.layers), zone }
        : null
    }
    default:
      return null
  }
}

/** The rules' view of an item as the agent names it (`boardItems.ts`). */
export function explainTarget(
  board: KicadBoard,
  index: BoardSpatialIndex,
  rules: BoardRules,
  item: BoardItem
): ExplainTarget | null {
  const at = (list: readonly unknown[], value: unknown): number => list.indexOf(value)
  switch (item.kind) {
    case 'pad':
      return explainTargetOf(board, index, rules, {
        type: 'pad',
        index: at(board.footprints, item.footprint),
        pad: at(item.footprint.footprint.pads, item.pad)
      })
    case 'track': {
      const segment = at(board.segments, item.track)
      return explainTargetOf(
        board,
        index,
        rules,
        segment >= 0
          ? { type: 'segment', index: segment }
          : { type: 'tarc', index: at(board.trackArcs, item.track) }
      )
    }
    case 'via':
      return explainTargetOf(board, index, rules, { type: 'via', index: at(board.vias, item.via) })
    case 'zone':
      return explainTargetOf(board, index, rules, {
        type: 'zone',
        index: at(allZones(board), item.zone)
      })
    default:
      return null
  }
}

/** Every limit the rules set on one item, or between two. */
export function explainLimits(
  rules: BoardRules,
  a: ExplainTarget,
  b?: ExplainTarget | null,
  only?: string
): ExplainedLimit[] {
  const out: ExplainedLimit[] = []
  const resolve = (
    constraint: ExplainedConstraint,
    x: RuleItem,
    y: RuleItem | null,
    layer: string | null
  ): void => {
    const r = rules.resolver.evaluate(constraint, x, y, layer, true)
    out.push({
      constraint,
      layer,
      ...(r.value.min !== undefined ? { min: r.value.min } : {}),
      ...(r.value.opt !== undefined ? { opt: r.value.opt } : {}),
      ...(r.value.max !== undefined ? { max: r.value.max } : {}),
      source: r.name,
      ...(r.isNull ? { unset: true as const } : {}),
      steps: r.trail ?? []
    })
  }
  const pick = (layers: readonly string[]): string[] =>
    only ? layers.filter((layer) => layer === only) : [...layers]

  if (!b) {
    const layer = pick(a.copper)[0] ?? a.copper[0] ?? null
    if (a.rule.kind === 'track' || a.rule.kind === 'arc')
      for (const l of pick(a.copper)) resolve('track_width', a.rule, null, l)
    if (a.rule.kind === 'via') resolve('via_diameter', a.rule, null, layer)
    if ((a.rule.kind === 'via' || a.rule.kind === 'pad') && holed(a)) {
      resolve('annular_width', a.rule, null, layer)
      resolve('hole_size', a.rule, null, null)
    }
    return out
  }

  const shared = pick(a.copper.filter((layer) => b.copper.includes(layer)))
  const net = a.rule.net ?? 0
  const sameNet = net !== 0 && net === (b.rule.net ?? 0)
  const pad = a.rule.kind === 'pad' ? a : b.rule.kind === 'pad' ? b : null
  const zone = a.zone ?? b.zone
  for (const layer of shared) {
    if (sameNet && pad && zone && pad !== (a.zone ? a : b)) {
      const joined = rules.zoneConnection(pad.rule, zone, layer)
      out.push({
        constraint: 'zone_connection',
        layer,
        connection: { style: joined.style, gap: joined.gap, spokeWidth: joined.spokeWidth },
        source: joined.source,
        steps:
          rules.resolver.evaluate('zone_connection', pad.rule, (a.zone ? a : b).rule, layer, true)
            .trail ?? []
      })
    } else if (sameNet) {
      out.push({
        constraint: 'clearance',
        layer,
        min: 0,
        source: 'same net',
        sameNet: true,
        steps: []
      })
    } else {
      resolve('clearance', a.rule, b.rule, layer)
    }
    if (rules.resolver.hasRules('physical_clearance'))
      resolve('physical_clearance', a.rule, b.rule, layer)
  }
  if (holed(a) || holed(b)) {
    const layer = shared[0] ?? null
    if (!sameNet) resolve('hole_clearance', a.rule, b.rule, layer)
    if (rules.resolver.hasRules('physical_hole_clearance'))
      resolve('physical_hole_clearance', a.rule, b.rule, layer)
  }
  if (holed(a) && holed(b)) resolve('hole_to_hole', a.rule, b.rule, null)
  return out
}
