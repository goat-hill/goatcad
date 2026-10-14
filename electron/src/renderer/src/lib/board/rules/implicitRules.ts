/**
 * The rules a board has before any `.kicad_dru`: its design settings and its
 * net classes, as KiCad synthesizes them (`DRC_ENGINE::loadImplicitRules`).
 * Their order is part of their meaning — a later match overwrites an earlier
 * one (`resolver.ts`) — so it is KiCad's: board setup, the micro-via rule,
 * then the net-class rules, clearances sorted smallest first so a pair in two
 * classes resolves to the larger, then the per-item class rules. Their names
 * are what a finding prints. The tuning profiles' rules follow the net
 * classes' (`tuningProfileRules`). Keepout rule areas stay with the keepout check
 * until the disallow rules move here.
 */
import type { BoardDesignSettings, DesignRules, NetClass } from '../../kicad/project'
import { effectiveClassName } from '../../kicad/project'
import { isCoupledDiffPair, inDiffPair } from './diffPairs'
import type {
  ConstraintType,
  ConstraintValue,
  Rule,
  RuleCondition,
  RuleItem,
  RuleSeverity
} from './constraints'

const SILK_LAYERS: ReadonlySet<string> = new Set(['F.SilkS', 'B.SilkS'])

const rule = (
  name: string,
  constraints: Array<[ConstraintType, ConstraintValue]>,
  extra: Partial<Pick<Rule, 'condition' | 'layers'>> = {}
): Rule => ({
  name,
  implicit: 'board_setup',
  layers: extra.layers ?? null,
  condition: extra.condition ?? null,
  constraints: new Map(constraints)
})

const isMicro: RuleCondition = ({ a }) => a.viaType === 'micro'
/** `A.Via_Type != 'Micro'`: false for anything but a via, as an undefined property compares. */
const isNotMicroVia: RuleCondition = ({ a }) => a.viaType !== undefined && a.viaType !== 'micro'

/** The board setup's own rules, in KiCad's order. */
export function boardSetupRules(rules: DesignRules): Rule[] {
  return [
    rule('board setup constraints', [
      ['track_width', { min: rules.minTrackWidth }],
      ['connection_width', { min: rules.minConnectionWidth }],
      ['hole_size', { min: rules.minThroughHoleDiameter }],
      ['annular_width', { min: rules.minViaAnnularWidth }],
      ['via_diameter', { min: rules.minViaDiameter }],
      ['hole_to_hole', { min: rules.minHoleToHole }]
    ]),
    rule('board setup constraints zone fill strategy', [
      ['min_resolved_spokes', { min: rules.minResolvedSpokes }]
    ]),
    rule('board setup constraints silk', [['silk_clearance', { min: rules.minSilkClearance }]], {
      layers: SILK_LAYERS
    }),
    rule(
      'board setup constraints silk text height',
      [['text_height', { min: rules.minTextHeight }]],
      {
        layers: SILK_LAYERS
      }
    ),
    rule(
      'board setup constraints silk text thickness',
      [['text_thickness', { min: rules.minTextThickness }]],
      { layers: SILK_LAYERS }
    ),
    rule('board setup constraints hole', [
      ['hole_clearance', { min: rules.minCopperHoleClearance }]
    ]),
    rule('board setup constraints edge', [
      ['edge_clearance', { min: rules.minCopperEdgeClearance }]
    ]),
    // KiCad's courtyard rule sets no min (it is written to the wrong constraint):
    // courtyards may not overlap or touch, and nothing more.
    rule('board setup constraints courtyard', [['courtyard_clearance', {}]]),
    rule(
      'board setup constraints micro-via',
      [
        ['hole_size', { min: rules.minMicroviaDrill }],
        ['via_diameter', { min: rules.minMicroviaDiameter }]
      ],
      { condition: isMicro }
    )
  ]
}

/**
 * One rule per field a class sets, conditioned on an item's effective class
 * being exactly that class (`A.hasExactNetclass`). `classes` are the named
 * classes, Default first, and then every composite some net resolves to;
 * `netNames` is the board's nets, which the diff-pair conditions need.
 */
export function netClassRules(
  rules: DesignRules,
  classes: readonly NetClass[],
  netNames: ReadonlySet<string>
): Rule[] {
  const clearanceBucket: Array<{ key: number; rule: Rule }> = []
  const itemBucket: Rule[] = []
  for (const netClass of classes) {
    const exact = effectiveClassName(netClass)
    const has = (field: keyof NetClass): boolean =>
      !netClass.unset?.includes(field as never) && typeof netClass[field] === 'number'
    const supplier = (field: keyof NetClass): string =>
      (
        netClass.sources?.[field as keyof NonNullable<NetClass['sources']>] ?? netClass.name
      ).replace(/'/g, "\\'")
    const inClass: RuleCondition = ({ a }) => a.netClass === exact
    const make = (
      name: string,
      constraints: Array<[ConstraintType, ConstraintValue]>,
      condition: RuleCondition
    ): Rule => ({
      name,
      implicit: 'net_class',
      layers: null,
      condition,
      constraints: new Map(constraints)
    })

    if (has('clearance')) {
      clearanceBucket.push({
        key: netClass.clearance,
        rule: make(
          `netclass '${supplier('clearance')}'`,
          [['clearance', { min: netClass.clearance }]],
          inClass
        )
      })
    }
    if (has('trackWidth')) {
      clearanceBucket.push({
        key: rules.minTrackWidth,
        rule: make(
          `netclass '${supplier('trackWidth')}'`,
          [['track_width', { min: rules.minTrackWidth, opt: netClass.trackWidth }]],
          inClass
        )
      })
    }
    if (has('diffPairWidth')) {
      itemBucket.push(
        make(
          `netclass '${supplier('diffPairWidth')}' (diff pair)`,
          [['track_width', { min: rules.minTrackWidth, opt: netClass.diffPairWidth }]],
          (context) => inClass(context) && inDiffPair(context.a.netName, '*', netNames)
        )
      )
    }
    if (has('diffPairGap')) {
      itemBucket.push(
        make(
          `netclass '${supplier('diffPairGap')}' (diff pair)`,
          [['diff_pair_gap', { min: rules.minClearance, opt: netClass.diffPairGap }]],
          inClass
        )
      )
      // A pair's two halves may sit closer than the class's clearance.
      if (has('clearance') && netClass.diffPairGap < netClass.clearance) {
        itemBucket.push(
          make(
            `netclass '${supplier('diffPairGap')}' (diff pair)`,
            [['clearance', { min: netClass.diffPairGap }]],
            (context) => inClass(context) && isCoupledDiffPair(context, netNames)
          )
        )
      }
    }
    if (has('viaDiameter')) {
      itemBucket.push(
        make(
          `netclass '${supplier('viaDiameter')}'`,
          [['via_diameter', { min: rules.minViaDiameter, opt: netClass.viaDiameter }]],
          (context) => inClass(context) && isNotMicroVia(context)
        )
      )
    }
    if (has('viaDrill')) {
      itemBucket.push(
        make(
          `netclass '${supplier('viaDrill')}'`,
          [['hole_size', { min: rules.minThroughHoleDiameter, opt: netClass.viaDrill }]],
          (context) => inClass(context) && isNotMicroVia(context)
        )
      )
    }
    if (has('microviaDiameter')) {
      // KiCad sets the class's micro-via diameter as the min, not the preferred size.
      itemBucket.push(
        make(
          `netclass '${supplier('microviaDiameter')}' (uvia)`,
          [['via_diameter', { min: netClass.microviaDiameter }]],
          (context) => inClass(context) && isMicro(context)
        )
      )
    }
    if (has('microviaDrill')) {
      itemBucket.push(
        make(
          `netclass '${supplier('microviaDrill')}' (uvia)`,
          [['hole_size', { min: rules.minMicroviaDrill, opt: netClass.microviaDrill }]],
          (context) => inClass(context) && isMicro(context)
        )
      )
    }
  }
  // Smallest first, so the last class to match — the larger — wins.
  clearanceBucket.sort((a, b) => a.key - b.key)
  return [...clearanceBucket.map((entry) => entry.rule), ...itemBucket]
}

/** `A.Layer`: a track's layer, a pad's footprint's side; a via has none. */
const layerOf = (item: RuleItem): string | undefined =>
  item.kind === 'via' ? undefined : item.kind === 'pad' ? item.footprintLayer : item.layers[0]

/**
 * The rules a class's tuning profile sets on each signal layer it gives a
 * width (KiCad 10, `tuning profile '<name>'`): the track width exactly, and a
 * differential profile's pair gap and, where that is under the class's
 * clearance, the pair's clearance. They carry the project's severity for
 * `tuning_profile_track_geometries`, ignore unless it says otherwise, so by
 * default a track they match is held to no width at all. A composite takes the
 * profile of its highest-priority class that names one, else Default's.
 */
export function tuningProfileRules(
  rules: DesignRules,
  classes: readonly NetClass[],
  tuning: BoardDesignSettings['tuning'],
  netNames: ReadonlySet<string>,
  severity: RuleSeverity
): Rule[] {
  if (!tuning?.geometries) return []
  const defaultProfile = tuning.classProfiles.Default
  const out: Rule[] = []
  for (const netClass of classes) {
    const profileName = netClass.constituents
      ? (netClass.constituents.map((name) => tuning.classProfiles[name]).find(Boolean) ??
        defaultProfile)
      : tuning.classProfiles[netClass.name]
    const profile = profileName ? tuning.geometries[profileName] : undefined
    if (!profile) continue
    const exact = effectiveClassName(netClass)
    for (const { layer, width, gap } of profile.layers) {
      if (width <= 0 || (profile.differential && gap <= 0)) continue
      const onLayer: RuleCondition = ({ a }) => a.netClass === exact && layerOf(a) === layer
      const make = (
        constraints: Array<[ConstraintType, ConstraintValue]>,
        condition: RuleCondition
      ): Rule => ({
        name: `tuning profile '${profileName}'`,
        implicit: 'tuning_profile',
        layers: null,
        condition,
        severity,
        constraints: new Map(constraints)
      })
      const exactWidth: [ConstraintType, ConstraintValue] = [
        'track_width',
        { min: Math.max(rules.minTrackWidth, width), opt: width, max: width }
      ]
      if (!profile.differential) {
        out.push(make([exactWidth], onLayer))
        continue
      }
      const paired: RuleCondition = (context) =>
        onLayer(context) && inDiffPair(context.a.netName, '*', netNames)
      out.push(make([exactWidth], paired))
      out.push(
        make(
          [['diff_pair_gap', { min: Math.max(rules.minClearance, gap), opt: gap, max: gap }]],
          paired
        )
      )
      // A narrower gap overrides the class clearance between the pair's halves.
      if (gap < netClass.clearance)
        out.push(
          make(
            [['clearance', { min: gap }]],
            (context) => onLayer(context) && isCoupledDiffPair(context, netNames)
          )
        )
    }
  }
  return out
}
