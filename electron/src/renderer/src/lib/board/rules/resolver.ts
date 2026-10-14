/**
 * The one answer to "what limit applies here, and who set it": for a
 * constraint type, a pair of items (or one) and a layer, the value KiCad's DRC
 * would use (`DRC_ENGINE::EvalRules`), which rule set it, and — asked to
 * explain — every rule it weighed and why. DRC, the router, the zone filler
 * and the agent's rule ops all ask here, so none of them can disagree.
 *
 * The walk, in KiCad's order:
 *  1. Pre-emptions. A footprint's net tie makes the clearance between the nets
 *     it joins 0. A pad's or footprint's own clearance wins outright — the
 *     larger of the two sides', floored at the board minimum — over every rule,
 *     the user's included. A pad's own zone connection, thermal gap or spoke
 *     width wins likewise.
 *  2. Every rule with a constraint of the type, implicit ones first and then
 *     the user's in file order. A rule applies when its layers include the
 *     query layer and its condition holds for (A, B) or for (B, A); it
 *     overwrites the fields it sets and becomes the rule that decided, so the
 *     last to match wins, field by field. `clearance` never applies to an item
 *     on no copper or to a keepout area.
 *  3. Unless a user rule decided: a zone's own clearance is maxed in and the
 *     board minimum clearance applied (copper only); a diff-pair gap is floored
 *     at it; zone connection and thermal settings fall back to the footprint's
 *     and the zone's.
 * Values are millimeters.
 */
import {
  CLEARANCE_TYPES,
  DISALLOW,
  MAXIMUM_CLEARANCE,
  type ConditionContext,
  type ConstraintType,
  type ConstraintValue,
  type Rule,
  type RuleItem,
  type RuleSeverity
} from './constraints'

/** One step of an explained resolution, in the order it was taken. */
export interface TrailEvent {
  /** The rule weighed, or null for a pre-emption or a fallback. */
  rule: string | null
  outcome:
    | 'net-tie'
    | 'override'
    | 'board-minimum'
    | 'applied'
    | 'condition-false'
    | 'layer-mismatch'
    | 'not-copper'
    | 'no-hole'
    | 'disallow-mismatch'
    | 'local-clearance'
    | 'fallback'
  /** The value the step set or offered, where it has one. */
  value?: number | string
}

export interface Resolution {
  value: ConstraintValue
  /**
   * Who set the value, as a report prints it: an implicit rule's name, a user
   * rule as `rule '<name>'`, or the override that pre-empted the rules (`pad`,
   * `footprint R1`, `zone`, `board minimum`, `net tie`).
   */
  name: string
  rule: Rule | null
  /** The min came from an implicit rule, even where a later one set another field. */
  implicitMin: boolean
  severity?: RuleSeverity
  /** Nothing applied: the check this answers has nothing to hold the item to. */
  isNull: boolean
  trail?: TrailEvent[]
}

export interface ResolverSettings {
  minClearance: number
  minHoleClearance: number
}

const EMPTY: ConstraintValue = {}

export class ConstraintResolver {
  private readonly byType = new Map<ConstraintType, Rule[]>()

  constructor(
    readonly rules: readonly Rule[],
    private readonly settings: ResolverSettings
  ) {
    for (const rule of rules) {
      for (const type of rule.constraints.keys()) {
        const list = this.byType.get(type) ?? []
        list.push(rule)
        this.byType.set(type, list)
      }
    }
  }

  /** Whether any of the project's own rules carries the type. */
  hasUserRules(type: ConstraintType): boolean {
    return (this.byType.get(type) ?? []).some((rule) => rule.implicit === null)
  }

  /** Whether any rule carries the type (`HasRulesForConstraintType`). */
  hasRules(type: ConstraintType): boolean {
    return (this.byType.get(type)?.length ?? 0) > 0
  }

  /** The largest min any rule sets for the type, conditions ignored: how far a search must reach. */
  worst(type: ConstraintType): number {
    let worst = 0
    for (const rule of this.byType.get(type) ?? []) {
      const min = rule.constraints.get(type)?.min
      if (min !== undefined && min > worst) worst = min
    }
    if (type === 'clearance') worst = Math.max(worst, this.settings.minClearance)
    return Math.min(worst, MAXIMUM_CLEARANCE)
  }

  evaluate(
    type: ConstraintType,
    a: RuleItem,
    b: RuleItem | null,
    layer: string | null,
    explain = false
  ): Resolution {
    const trail: TrailEvent[] | undefined = explain ? [] : undefined
    const note = (event: TrailEvent): void => {
      trail?.push(event)
    }
    const done = (resolution: Omit<Resolution, 'trail'>): Resolution =>
      trail ? { ...resolution, trail } : resolution

    // ---- 1. Pre-emptions -------------------------------------------------------
    if (type === 'clearance' && b && !a.nonCopper && !b.nonCopper) {
      const tied =
        (a.netTies && b.net !== undefined && a.netTies.has(b.net)) ||
        (b.netTies && a.net !== undefined && b.netTies.has(a.net))
      if (tied) {
        note({ rule: null, outcome: 'net-tie', value: 0 })
        return done({
          value: { min: 0 },
          name: 'net tie',
          rule: null,
          implicitMin: false,
          isNull: false
        })
      }
    }
    if (type === 'clearance' || type === 'hole_clearance') {
      const ovA = a.net !== undefined && !(b?.nonCopper ?? false) ? a.clearanceOverride : undefined
      const ovB = b && b.net !== undefined && !a.nonCopper ? b.clearanceOverride : undefined
      let value = 0
      let name = ''
      if (ovA) {
        value = ovA.value
        name = ovA.source
      }
      if (ovB && ovB.value > value) {
        value = ovB.value
        name = ovB.source
      }
      // A zero override is no override: the rules decide.
      if (value !== 0) {
        note({ rule: null, outcome: 'override', value })
        const floor =
          type === 'clearance' ? this.settings.minClearance : this.settings.minHoleClearance
        if (value < floor) {
          note({ rule: null, outcome: 'board-minimum', value: floor })
          value = floor
          name = type === 'clearance' ? 'board minimum' : 'board minimum hole'
        }
        return done({ value: { min: value }, name, rule: null, implicitMin: false, isNull: false })
      }
    }
    const pad = b?.kind === 'pad' ? b : a.kind === 'pad' ? a : null
    const zone = b?.kind === 'zone' ? b : a.kind === 'zone' ? a : null
    if (type === 'zone_connection' && pad?.zone?.padConnection) {
      note({ rule: null, outcome: 'override', value: pad.zone.padConnection })
      return done({
        value: { zoneConnection: pad.zone.padConnection },
        name: 'pad',
        rule: null,
        implicitMin: false,
        isNull: false
      })
    }
    if (type === 'thermal_relief_gap' && (pad?.zone?.padThermalGap ?? 0) > 0) {
      note({ rule: null, outcome: 'override', value: pad!.zone!.padThermalGap })
      return done({
        value: { min: pad!.zone!.padThermalGap },
        name: 'pad',
        rule: null,
        implicitMin: false,
        isNull: false
      })
    }
    if (type === 'thermal_spoke_width' && (pad?.zone?.padSpokeWidth ?? 0) > 0) {
      const own = pad!.zone!.padSpokeWidth!
      const value = Math.max(own, zone?.zoneSettings?.minThickness ?? 0)
      note({ rule: null, outcome: 'override', value })
      return done({
        value: { min: value },
        name: 'pad',
        rule: null,
        implicitMin: false,
        isNull: false
      })
    }

    // ---- 2. The rules, in order ---------------------------------------------------
    const value: ConstraintValue = {}
    let decided: Rule | null = null
    let implicitMin = false
    const context: ConditionContext = { a, b, layer, type }
    const swapped: ConditionContext | null = b ? { a: b, b: a, layer, type } : null
    const holds = (rule: Rule): boolean =>
      !rule.condition || rule.condition(context) || (swapped !== null && rule.condition(swapped))

    for (const rule of this.byType.get(type) ?? []) {
      if (rule.implicit === 'net_class') {
        if (type === 'clearance' && (a.nonCopper || b?.nonCopper)) {
          note({ rule: rule.name, outcome: 'not-copper' })
          continue
        }
        // A class rule that does not hold is passed over silently, as KiCad does.
        if (!holds(rule)) continue
      }
      if (type === 'clearance' && (a.nonCopper || b?.nonCopper)) {
        note({ rule: rule.name, outcome: 'not-copper' })
        continue
      }
      const constraint = rule.constraints.get(type)!
      if (type === 'disallow') {
        const kind = disallowKind(a)
        if (!constraint.disallow || !(constraint.disallow & kind)) {
          note({ rule: rule.name, outcome: 'disallow-mismatch' })
          continue
        }
      }
      if (layer !== null && rule.layers && !rule.layers.has(layer)) {
        note({ rule: rule.name, outcome: 'layer-mismatch' })
        continue
      }
      if (type === 'hole_to_hole' && !(a.hasHole && b?.hasHole)) {
        note({ rule: rule.name, outcome: 'no-hole' })
        continue
      }
      if (rule.implicit !== 'net_class' && !holds(rule)) {
        note({ rule: rule.name, outcome: 'condition-false' })
        continue
      }
      // Apply: the fields this rule sets overwrite the ones before it.
      if (constraint.min !== undefined) {
        value.min = CLEARANCE_TYPES.has(type)
          ? Math.min(constraint.min, MAXIMUM_CLEARANCE)
          : constraint.min
        implicitMin = rule.implicit !== null
      }
      if (constraint.opt !== undefined) value.opt = constraint.opt
      if (constraint.max !== undefined) value.max = constraint.max
      if (constraint.zoneConnection !== undefined) value.zoneConnection = constraint.zoneConnection
      if (constraint.disallow !== undefined) value.disallow = constraint.disallow
      if (constraint.assertion !== undefined) value.assertion = constraint.assertion
      if (constraint.withinDiffPairs !== undefined)
        value.withinDiffPairs = constraint.withinDiffPairs
      decided = rule
      note({ rule: rule.name, outcome: 'applied', value: constraint.min ?? constraint.opt })
    }

    const resolved = (name: string, rule: Rule | null): Resolution =>
      done({
        value: { ...value },
        name,
        rule,
        implicitMin,
        severity: rule?.severity,
        isNull: rule === null
      })

    // ---- 3. After the rules, unless the user's decided ------------------------------
    if (decided && decided.implicit === null) return resolved(decided.name, decided)

    let name = decided?.name ?? ''
    let rule = decided
    if (type === 'clearance') {
      for (const side of [a, b]) {
        const local = side && side.net !== undefined ? side.localClearance : undefined
        if (!local) continue
        note({ rule: null, outcome: 'local-clearance', value: local.value })
        if (local.value > (value.min ?? 0)) {
          value.min = local.value
          name = local.source
          rule = null
        }
      }
      if (
        !a.nonCopper &&
        !(b?.nonCopper ?? false) &&
        (value.min ?? 0) < this.settings.minClearance
      ) {
        note({ rule: null, outcome: 'board-minimum', value: this.settings.minClearance })
        value.min = this.settings.minClearance
        name = 'board minimum'
        rule = null
      }
      return done({
        value: { ...value },
        name,
        rule,
        implicitMin,
        severity: rule?.severity,
        isNull: false
      })
    }
    if (type === 'diff_pair_gap') {
      if ((value.min ?? 0) < this.settings.minClearance) {
        value.min = this.settings.minClearance
        name = 'board minimum'
        rule = null
      }
      return done({
        value: { ...value },
        name,
        rule,
        implicitMin,
        severity: rule?.severity,
        isNull: false
      })
    }
    if (type === 'zone_connection' && !decided) {
      const own = pad?.zone?.footprintConnection
      if (own) {
        note({ rule: null, outcome: 'fallback', value: own })
        return done({
          value: { zoneConnection: own },
          name: 'footprint',
          rule: null,
          implicitMin,
          isNull: false
        })
      }
      if (zone?.zoneSettings) {
        note({ rule: null, outcome: 'fallback', value: zone.zoneSettings.connection })
        return done({
          value: { zoneConnection: zone.zoneSettings.connection },
          name: 'zone',
          rule: null,
          implicitMin,
          isNull: false
        })
      }
    }
    if (
      (type === 'thermal_relief_gap' || type === 'thermal_spoke_width') &&
      !decided &&
      zone?.zoneSettings
    ) {
      const fallback =
        type === 'thermal_relief_gap' ? zone.zoneSettings.thermalGap : zone.zoneSettings.spokeWidth
      note({ rule: null, outcome: 'fallback', value: fallback })
      return done({
        value: { min: fallback },
        name: 'zone',
        rule: null,
        implicitMin,
        isNull: false
      })
    }
    if (!decided) return done({ value: EMPTY, name: '', rule: null, implicitMin, isNull: true })
    return resolved(name, rule)
  }
}

/** The disallow flag an item answers to (from A alone, as KiCad reads it). */
function disallowKind(item: RuleItem): number {
  switch (item.kind) {
    case 'hole':
      return DISALLOW.hole
    case 'via':
      return item.viaType === 'micro'
        ? DISALLOW.microVia
        : item.viaType === 'blind'
          ? DISALLOW.blindVia
          : item.viaType === 'buried'
            ? DISALLOW.buriedVia
            : DISALLOW.throughVia
    case 'track':
    case 'arc':
      return DISALLOW.track
    case 'pad':
      return DISALLOW.pad
    case 'footprint':
      return DISALLOW.footprint
    case 'graphic':
      return DISALLOW.graphic
    case 'text':
    case 'textbox':
    case 'table':
      return DISALLOW.text
    case 'cell':
    case 'dimension':
    case 'leader':
      return 0
    case 'zone':
      return item.teardrop ? DISALLOW.track : DISALLOW.zone
  }
}
