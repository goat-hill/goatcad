// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * The vocabulary of design rules: constraint types, their values, and a rule.
 *
 * A rule is KiCad's (`pcbnew/drc/drc_rule.h`, `.kicad_dru`): a name, an
 * optional condition, the layers it applies on, an optional severity, and at
 * most one constraint per type. The board's own settings become rules too —
 * implicit ones (`implicitRules.ts`) — so every limit, whoever set it, is
 * resolved by one walk (`resolver.ts`). Values are millimeters, as the rest
 * of the board engine measures; counts are plain numbers.
 */
import type { CopperShape, Pt } from '../spatialIndex'

/** Every constraint a rule can carry, by its `.kicad_dru` keyword. */
export type ConstraintType =
  | 'clearance'
  | 'hole_clearance'
  | 'hole_to_hole'
  | 'edge_clearance'
  | 'physical_clearance'
  | 'physical_hole_clearance'
  | 'courtyard_clearance'
  | 'silk_clearance'
  | 'creepage'
  | 'track_width'
  | 'track_segment_length'
  | 'track_angle'
  | 'connection_width'
  | 'via_diameter'
  | 'hole_size'
  | 'annular_width'
  | 'text_height'
  | 'text_thickness'
  | 'diff_pair_gap'
  | 'diff_pair_uncoupled'
  | 'length'
  | 'skew'
  | 'via_count'
  | 'zone_connection'
  | 'thermal_relief_gap'
  | 'thermal_spoke_width'
  | 'min_resolved_spokes'
  | 'solder_mask_expansion'
  | 'solder_paste_abs_margin'
  | 'solder_paste_rel_margin'
  | 'disallow'
  | 'assertion'
  | 'bridged_mask'
  | 'via_dangling'
  | 'solder_mask_sliver'

/** The clearance family: a min that is clamped to KiCad's 500 mm ceiling when applied. */
export const CLEARANCE_TYPES: ReadonlySet<ConstraintType> = new Set([
  'clearance',
  'hole_clearance',
  'edge_clearance',
  'courtyard_clearance',
  'silk_clearance',
  'physical_clearance',
  'physical_hole_clearance'
])

/** KiCad's `MAXIMUM_CLEARANCE`, mm. */
export const MAXIMUM_CLEARANCE = 500

/** How a pad joins a zone: KiCad's zone connection styles. */
export type ZoneConnectionStyle = 'solid' | 'thermal_reliefs' | 'none' | 'thru_hole_only'

/** The item kinds a `disallow` constraint names, as flags. */
export const DISALLOW = {
  throughVia: 1 << 0,
  microVia: 1 << 1,
  blindVia: 1 << 2,
  buriedVia: 1 << 3,
  track: 1 << 4,
  pad: 1 << 5,
  zone: 1 << 6,
  text: 1 << 7,
  graphic: 1 << 8,
  hole: 1 << 9,
  footprint: 1 << 10
} as const
export const DISALLOW_ANY_VIA =
  DISALLOW.throughVia | DISALLOW.microVia | DISALLOW.blindVia | DISALLOW.buriedVia

/**
 * One constraint's value. Each field is set or not — several checks ask
 * "is there a min" rather than "is it above 0" — so an unset field is absent,
 * never 0. The payload fields serve the types that carry no number.
 */
export interface ConstraintValue {
  min?: number
  opt?: number
  max?: number
  zoneConnection?: ZoneConnectionStyle
  disallow?: number
  /** `assertion`: the expression, compiled. */
  assertion?: RuleCondition
  /** `skew`: the `within_diff_pairs` option. */
  withinDiffPairs?: boolean
  /** `length`, `skew`: the values are times (ps), held to propagation delay, not length. */
  timeDomain?: boolean
}

/** A rule's severity override; `undefined` leaves the check's own. */
export type RuleSeverity = 'error' | 'warning' | 'ignore' | 'exclusion'

/** Where an implicit rule came from; a user rule has none. */
export type ImplicitSource = 'board_setup' | 'net_class' | 'tuning_profile' | 'keepout'

/** What a condition is asked about: the pair, the layer, the constraint. */
export interface ConditionContext {
  a: RuleItem
  b: RuleItem | null
  /** The query layer; null for a query about no layer in particular. */
  layer: string | null
  type: ConstraintType
}

/** A compiled condition: true when the rule applies to the context as given (A, B). */
export type RuleCondition = (context: ConditionContext) => boolean

export interface Rule {
  /** As a report prints it: implicit rules verbatim, a user rule as `rule '<name>'`. */
  name: string
  implicit: ImplicitSource | null
  /** The layers the rule applies on; null for every layer. */
  layers: ReadonlySet<string> | null
  /** As written in the file, for messages (`(layer "inner")`). */
  layerSource?: string
  condition: RuleCondition | null
  /** The condition's text, for the explain trail; implicit rules have none to show. */
  conditionText?: string
  severity?: RuleSeverity
  constraints: ReadonlyMap<ConstraintType, ConstraintValue>
}

/**
 * An item as rules see it. The board engine's items (tracks, pads, zones…)
 * are adapted to this (`ruleItems.ts`), so the resolver knows nothing of the
 * file model and a rule's condition reads only what is here.
 */
export interface RuleItem {
  kind:
    | 'track'
    | 'arc'
    | 'via'
    | 'pad'
    | 'zone'
    | 'footprint'
    | 'graphic'
    | 'text'
    | 'textbox'
    | 'table'
    | 'cell'
    | 'dimension'
    | 'leader'
    | 'hole'
  /** How findings and the explain trail name it: `R1.2`, `track GND`. */
  label: string
  /** Net number; 0 is no net. Absent for items that carry none (graphics, footprints). */
  net?: number
  netName?: string
  /** The name of the net's effective class (`effectiveClassName`), when it has a net. */
  netClass?: string
  layers: readonly string[]
  /** On no copper layer, or a keepout rule area: `clearance` never applies to it. */
  nonCopper: boolean
  viaType?: 'through' | 'blind' | 'buried' | 'micro'
  /** A pad's or its footprint's own clearance, and which one set it (`pad`, `footprint R1`). */
  clearanceOverride?: { value: number; source: string }
  /** A zone's own clearance, maxed in after the rules. */
  localClearance?: { value: number; source: string }
  /** Whether the item has a hole (a via, a drilled pad, or a hole proxy). */
  hasHole?: boolean
  /** A zone that is a teardrop: rules match it as a track. */
  teardrop?: boolean
  /** Pad-level and footprint-level zone settings, for the zone rules' pre-emptions and fallbacks. */
  zone?: {
    padConnection?: ZoneConnectionStyle
    footprintConnection?: ZoneConnectionStyle
    padThermalGap?: number
    padSpokeWidth?: number
    plated?: boolean
  }
  /** A zone's own settings, when the item is one. */
  zoneSettings?: {
    connection: ZoneConnectionStyle
    thermalGap: number
    spokeWidth: number
    minThickness: number
  }
  /** The nets a footprint's net ties join to this item's net, when it is a pad or its footprint's. */
  netTies?: ReadonlySet<number>
  /** The footprint the item belongs to, by reference; for net ties and footprint inheritance. */
  footprint?: string
  /** A pad's footprint's side: what `A.Layer` reads on a pad, which has no layer of its own. */
  footprintLayer?: string
  /** Its footprint's library id (`Resistor_SMD:R_0603…`), for `memberOfFootprint`. */
  footprintLibId?: string
  /** The sheet path its footprint (or it, a footprint) was placed from: `memberOfSheet`. */
  sheetName?: string
  /** Its footprint's component classes, each once, in KiCad's order (`hasComponentClass`). */
  componentClasses?: readonly string[]
  /** A footprint's fields by name, for `getField`; nothing else answers. */
  fields?: ReadonlyMap<string, string>
  /** Which item it is on the board (`pad:<fp>:<pad>`, `segment:<i>`, `zone:<i>`…): what `fromTo` finds. */
  itemKey?: string
  /** The file's uuid for it, and its footprint's: what a group lists as its members. */
  uuid?: string
  ownerUuid?: string
  /**
   * Where it is, for the geometric conditions (`intersectsArea`,
   * `intersectsCourtyard`): its copper, or a zone's outline. World millimeters, y up.
   */
  geometry?: {
    shape?: CopperShape
    ring?: readonly Pt[]
    /** A zone's fill, each piece on its layer: what an area test reads it by. */
    fills?: ReadonlyArray<{ layer: string; ring: readonly Pt[] }>
  }
  /**
   * A zone being filled: KiCad reads a zone's area by its fill
   * (`collidesWithArea`), and while it is refilled it has none, so to its own
   * rules it is in no area. Courtyard tests still read its outline.
   */
  unfilled?: boolean
  /** The zone it is, so an area never tests against itself. */
  zoneId?: string
  /** Its footprint's properties, which it falls back on for what it has not of its own. */
  ownerProperty?: (name: string) => string | number | null | undefined
  /** Everything else an expression may read, by KiCad's property name (`Via_Type`, `Pad_Type`). */
  property?: (name: string) => string | number | null | undefined
}
