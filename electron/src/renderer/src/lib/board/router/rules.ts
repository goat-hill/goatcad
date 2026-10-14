/**
 * The router's clearances from the rules resolver (docs/router-behavior.md
 * Terms, S11): what new copper of a net keeps from each item, on a layer —
 * the value DRC checks, custom rules and pad overrides included — rather
 * than one clearance per route.
 *
 * Copper the router itself adds (the route's clicks, pushed tracks, a moved
 * via) is asked as a new item of its net: it has no board index to read.
 */
import type { CopperItem } from '../spatialIndex'
import type { BoardRules } from '../rules/boardRules'
import type { RuleItem } from '../rules/constraints'

export type RoutedKind = 'track' | 'via'

/** What drills a hole: a pad by footprint and index (copper or not), or a via of the index. */
export type HoleOwner = { footprint: number; pad: number } | { item: CopperItem }

export interface RouterRules {
  /** The clearance new copper of `net` keeps from `item` on `layer`, mm. */
  clearance(net: number, kind: RoutedKind, item: CopperItem, layer: string): number
  /** How far a board hole keeps new copper of `net` on `layer` (`hole_clearance`), mm. */
  holeClearance(net: number, kind: RoutedKind, hole: HoleOwner, layer: string): number
  /** How far a new via's hole keeps from `item` on `layer` (`hole_clearance`), mm. */
  viaHoleClearance(net: number, layers: readonly string[], item: CopperItem, layer: string): number
  /** How far a new via's hole keeps from another hole (`hole_to_hole`), mm. */
  holeToHole(net: number, layers: readonly string[], hole: HoleOwner): number
  /** How far new copper of `net` keeps from the board edge (`edge_clearance`), mm. */
  edgeClearance(net: number, kind: RoutedKind, layer: string): number
  /** The largest clearance any pair can ask: how far a search must reach. */
  reach: number
  /** The largest hole clearance or hole-to-hole spacing any pair can ask. */
  holeReach: number
}

/** The board edge, as the rules ask an edge clearance of it (drc/rules/edge.ts). */
export const EDGE_RULE_ITEM: RuleItem = {
  kind: 'graphic',
  label: 'Edge.Cuts',
  layers: ['Edge.Cuts'],
  nonCopper: true
}

export function routerRules(rules: BoardRules): RouterRules {
  const newItems = new Map<string, RuleItem>()
  const newItem = (kind: RoutedKind, net: number, layers: readonly string[]): RuleItem => {
    const key = `${kind}|${net}|${layers.join(',')}`
    let item = newItems.get(key)
    if (!item) newItems.set(key, (item = rules.newItem(kind, net, layers)))
    return item
  }
  const asRuleItem = (item: CopperItem): RuleItem =>
    item.id < 0 || item.ref.index < 0
      ? newItem(item.ref.type === 'via' ? 'via' : 'track', item.net, item.layers)
      : rules.copperItem(item)

  const ownerItem = (hole: HoleOwner): RuleItem =>
    'item' in hole ? asRuleItem(hole.item) : rules.padItem(hole.footprint, hole.pad)
  const ownerKey = (hole: HoleOwner): string =>
    'item' in hole
      ? hole.item.id < 0 || hole.item.ref.index < 0
        ? `n|${hole.item.ref.type}|${hole.item.net}|${hole.item.layers.join(',')}`
        : `i|${hole.item.id}`
      : `p|${hole.footprint}|${hole.pad}`
  const holes = new Map<string, number>()
  const memo = (key: string, value: () => number): number => {
    let v = holes.get(key)
    if (v === undefined) holes.set(key, (v = value()))
    return v
  }
  const minOf = (r: { isNull: boolean; value: { min?: number } }): number =>
    r.isNull ? 0 : (r.value.min ?? 0)

  const base = new WeakMap<CopperItem, Map<string, number>>()
  const overlay = new Map<string, number>()
  return {
    reach: rules.maxClearance,
    holeReach: Math.max(
      rules.resolver.worst('hole_clearance'),
      rules.resolver.worst('hole_to_hole')
    ),
    edgeClearance(net, kind, layer) {
      return memo(`ec|${net}|${kind}|${layer}`, () =>
        minOf(
          rules.resolver.evaluate(
            'edge_clearance',
            EDGE_RULE_ITEM,
            newItem(kind, net, [layer]),
            null
          )
        )
      )
    },
    holeClearance(net, kind, hole, layer) {
      return memo(`hc|${ownerKey(hole)}|${net}|${kind}|${layer}`, () =>
        minOf(
          rules.resolver.evaluate(
            'hole_clearance',
            ownerItem(hole),
            newItem(kind, net, [layer]),
            layer
          )
        )
      )
    },
    viaHoleClearance(net, layers, item, layer) {
      return memo(`vh|${ownerKey({ item })}|${net}|${layers.join(',')}|${layer}`, () =>
        minOf(
          rules.resolver.evaluate(
            'hole_clearance',
            newItem('via', net, layers),
            asRuleItem(item),
            layer
          )
        )
      )
    },
    holeToHole(net, layers, hole) {
      return memo(`hh|${ownerKey(hole)}|${net}|${layers.join(',')}`, () =>
        minOf(
          rules.resolver.evaluate(
            'hole_to_hole',
            newItem('via', net, layers),
            ownerItem(hole),
            null
          )
        )
      )
    },
    clearance(net, kind, item, layer) {
      const added = item.id < 0
      const key = added
        ? `${item.ref.type}|${item.net}|${item.layers.join(',')}|${net}|${kind}|${layer}`
        : `${net}|${kind}|${layer}`
      let memo: Map<string, number> | undefined = overlay
      if (!added) {
        memo = base.get(item)
        if (!memo) base.set(item, (memo = new Map()))
      }
      let value = memo.get(key)
      if (value === undefined) {
        value =
          rules.resolver.evaluate('clearance', newItem(kind, net, [layer]), asRuleItem(item), layer)
            .value.min ?? 0
        memo.set(key, value)
      }
      return value
    }
  }
}
