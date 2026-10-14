/**
 * Manufacturing profiles — the organizing idea behind Board Setup
 * (board-setup-workstream.md).
 *
 * A profile bundles everything a fab needs you to agree to: the physical
 * stackup, the design-rule minimums, and the routing defaults. Applying one
 * seeds all three, so a new board starts *manufacturable* instead of starting
 * blank — KiCad hands you empty constraint fields and expects you to fill them
 * from a datasheet you had to go find.
 *
 * Built-ins are read-only and tiered, because fabs price by tolerance: not one
 * "JLCPCB" but a standard tier and (later) a finer-pitch one. Editing a profile
 * in the UI forks it into a derived "(edited)" state the user may save; that
 * derivation is `deriveProfile` below, and persisting user profiles is a later
 * slice.
 *
 * NOTE ON THE NUMBERS: each vendor's block names the pages its values come
 * from and marks what no page publishes. A profile that claims a tolerance the
 * fab won't hold is worse than no profile, so an unpublished value errs toward margin.
 */

import type { StackupSpec } from './kicad/board'
import type { DesignRules, NetClass, RoutingDefaults } from './kicad/project'
import { defaultNetClass } from './kicad/project'
import { spacingToMm } from './kicad/coordinates'

/**
 * A named build off a fab's menu.
 *
 * Prototype fabs do not let you compose an arbitrary stackup — they publish a
 * fixed catalog and you pick one (JLCPCB's 4-layer builds carry designators
 * like `JLC04161H-7628`). So a stackup is a *catalog item*, and picking one
 * fills every layer at once instead of making you type a construction in. The
 * free-form case — HDI, impedance-controlled, exotic laminates — is out of
 * alpha, and is exactly where a catalog would stop being the right model.
 *
 * A preset that claims a build the fab does not stock is worse than no preset,
 * so each is held to the fab's published stackup table.
 */
export interface StackupPreset {
  id: string
  /** The fab's own designator where it has one, else a descriptive name. */
  name: string
  spec: StackupSpec
}

export interface ManufacturingProfile {
  id: string
  /** Fab name, or "Generic" for the house-agnostic tier. */
  vendor: string
  /** The tier within that vendor — fabs price by tolerance. */
  tier: string
  /** True for the shipped read-only set; false once a user edits or saves one. */
  builtIn: boolean
  /** Set when this profile was derived from a built-in by editing. */
  derivedFrom?: string
  /** This fab's catalog for this tier; the first is the default. */
  stackups: StackupPreset[]
  rules: DesignRules
  defaults: RoutingDefaults
}

/** The build a profile starts a board on. */
export const defaultStackupOf = (profile: ManufacturingProfile): StackupSpec =>
  profile.stackups[0].spec

/** "JLCPCB · 2-layer 1.6 mm" — the picker's display string. */
export const profileLabel = (profile: ManufacturingProfile): string =>
  profile.tier ? `${profile.vendor} · ${profile.tier}` : profile.vendor

/**
 * "JLCPCB · JLC2313 · 1.6 mm FR4" — a build qualified by whose catalog it is
 * from. The stackup picker flattens every vendor into one list, where a bare
 * designator says nothing about who stocks it, so the vendor is part of the
 * name there rather than something the user has to already know.
 */
export const stackupPresetLabel = (profile: ManufacturingProfile, preset: StackupPreset): string =>
  `${profile.vendor} · ${preset.name}`

const FR4 = {
  dielectricMaterial: 'FR4',
  epsilonR: 4.5,
  lossTangent: 0.02
} as const

/**
 * The constraints that are not about the fab: arc approximation, zone fill and
 * length tuning. They are part of a constraint configuration — a profile is a
 * named preset of the whole set, not just the manufacturable subset — but no
 * house varies them, so every built-in carries KiCad's own values and only the
 * fab-dictated minimums above actually differ between tiers.
 */
const SOLVER_CONSTRAINTS = {
  maxError: 0.005,
  zonesAllowExternalFillets: false,
  minResolvedSpokes: 2,
  useHeightForLengthCalcs: true
} as const

/**
 * A house-agnostic tier: rules loose enough that essentially any prototype fab
 * will accept the board. The safe default when the user has not chosen a fab.
 */
const GENERIC_2L: ManufacturingProfile = {
  id: 'generic-2l-1.6',
  vendor: 'Generic',
  tier: '2-layer 1.6 mm',
  builtIn: true,
  stackups: [
    {
      id: 'generic-2l-1.6-fr4',
      name: '2-layer 1.6 mm FR4',
      spec: {
        copperLayers: 2,
        boardThickness: 1.6,
        copperThickness: 0.035,
        ...FR4,
        maskColor: 'Green',
        silkColor: 'White',
        copperFinish: 'HASL'
      }
    }
  ],
  rules: {
    minClearance: 0.2,
    minTrackWidth: 0.2,
    minConnectionWidth: 0.2,
    minViaAnnularWidth: 0.15,
    minViaDiameter: 0.6,
    minCopperHoleClearance: 0.3,
    minCopperEdgeClearance: 0.3,
    minThroughHoleDiameter: 0.3,
    minHoleToHole: 0.5,
    // Loose enough that a house which does offer microvias will hold them; a
    // house which doesn't is not constrained by a rule it never checks.
    minMicroviaDiameter: 0.3,
    minMicroviaDrill: 0.15,
    minSilkClearance: 0.15,
    minTextHeight: 1.0,
    minTextThickness: 0.15,
    ...SOLVER_CONSTRAINTS
  },
  defaults: { trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }
}

/**
 * JLCPCB's standard FR4 builds, at the no-surcharge tier: its capability page
 * prices a 0.15 mm or smaller via hole as an extra, so the drill floor is the
 * 0.2 mm it calls the preferred minimum.
 *
 * Sources: jlcpcb.com/capabilities/pcb-capabilities, and for the 4-layer
 * builds jlcpcb.com/impedance. Marked as CircuitHub's are below: (pub) taken
 * directly, (der) derived from published numbers, (def) a conservative
 * default JLCPCB does not publish.
 */
const jlcpcbRules = (copperLayers: 2 | 4): DesignRules => {
  // 1 oz: 0.10 mm trace and gap on 2 layers, 0.09 mm on 4 (pub).
  const trace = copperLayers === 2 ? 0.1 : 0.09
  return {
    minClearance: trace,
    minTrackWidth: trace,
    minConnectionWidth: trace, // = track width (der)
    // A via's pad 0.15 mm wider than its hole, the page's preferred margin (der).
    // KiCad holds plated pads to the same rule; the page wants 0.18 mm (2-layer)
    // or 0.15 mm (4-layer) on those, which footprint libraries already exceed.
    minViaAnnularWidth: 0.075,
    minViaDiameter: 0.35, // 0.2 mm hole + 0.15 mm (der)
    minCopperHoleClearance: 0.2, // via hole to track (pub)
    minCopperEdgeClearance: 0.2, // to a routed edge; a V-cut wants 0.4 mm (pub)
    minThroughHoleDiameter: 0.2, // preferred min via hole, no surcharge (pub)
    // Via to via (pub). Pad holes want 0.45 mm; one rule holds both, and the
    // tighter would flag every legitimate via pair.
    minHoleToHole: 0.2,
    minMicroviaDiameter: 0.3, // no microvias on the standard build (def)
    minMicroviaDrill: 0.15, // (def)
    minSilkClearance: 0.15, // pad to silkscreen (pub)
    minTextHeight: 1.0, // 40 mil (pub)
    minTextThickness: 0.15, // min legend line width (pub)
    ...SOLVER_CONSTRAINTS
  }
}

const JLCPCB_BUILD = {
  ...FR4,
  maskColor: 'Green',
  silkColor: 'White',
  copperFinish: 'HASL'
} as const

const JLCPCB_2L: ManufacturingProfile = {
  id: 'jlcpcb-2l-1.6',
  vendor: 'JLCPCB',
  tier: '2-layer 1.6 mm',
  builtIn: true,
  // A 2-layer board is one core: JLCPCB's stackup table names no 2-layer build.
  stackups: [
    {
      id: 'jlcpcb-2l-1.6-std',
      name: 'Standard · 1.6 mm FR4',
      spec: { copperLayers: 2, boardThickness: 1.6, copperThickness: 0.035, ...JLCPCB_BUILD }
    },
    {
      id: 'jlcpcb-2l-0.8-std',
      name: 'Standard · 0.8 mm FR4',
      spec: { copperLayers: 2, boardThickness: 0.8, copperThickness: 0.035, ...JLCPCB_BUILD }
    }
  ],
  rules: jlcpcbRules(2),
  defaults: { trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }
}

/**
 * JLCPCB's impedance page: 1 oz outer and 0.5 oz inner foil around a core
 * (εr 4.6) under one prepreg ply a side. The core absorbs the difference
 * between the plies' sum and the 1.6 mm ordered.
 */
const JLCPCB_4L_BUILD = {
  copperLayers: 4,
  boardThickness: 1.6,
  copperThickness: 0.035,
  innerCopperThickness: 0.0152,
  ...JLCPCB_BUILD,
  epsilonR: 4.6
} as const

const JLCPCB_4L: ManufacturingProfile = {
  id: 'jlcpcb-4l-1.6',
  vendor: 'JLCPCB',
  tier: '4-layer 1.6 mm',
  builtIn: true,
  stackups: [
    {
      id: 'jlcpcb-4l-1.6-7628',
      name: 'JLC04161H-7628 · 1.6 mm',
      spec: { ...JLCPCB_4L_BUILD, prepregThickness: 0.2104, prepregEpsilonR: 4.4 }
    },
    {
      id: 'jlcpcb-4l-1.6-3313',
      name: 'JLC04161H-3313 · 1.6 mm',
      spec: { ...JLCPCB_4L_BUILD, prepregThickness: 0.0994, prepregEpsilonR: 4.1 }
    }
  ],
  rules: jlcpcbRules(4),
  defaults: { trackWidth: 0.2, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }
}

/**
 * CircuitHub (Boston, MA) — the launch assembly house (MILESTONES Scope).
 * The rules encode its ProtoBoard spec, the "standard prototyping specs" a
 * 2- or 4-layer board must meet for the quick-turn price; a board outside them
 * still quotes, at standard pricing, so this is the tier to design to.
 *
 * Sources: circuithub.com/capabilities/protoboard and the 3-Day Assembly page
 * it replaced (circuithub.com/deprecate/expedited-pcb-assembly), and the board
 * tab's defaults (docs.circuithub.com/board): 1.6 mm, 1 oz outer and inner,
 * FR4 Tg 130–135, ENIG, black mask, white silk, no blind, buried or filled
 * vias. Marked below: (pub) taken directly, (der) derived from published
 * numbers, (def) a conservative default CircuitHub does not publish.
 */
const CIRCUITHUB_RULES: DesignRules = {
  minClearance: 0.127, // min trace gap (pub)
  minTrackWidth: 0.127, // min trace width (pub)
  minConnectionWidth: 0.127, // = track width (der)
  minViaAnnularWidth: 0.15, // (def)
  minViaDiameter: 0.45, // 0.15 mm drill + 2 × 0.15 mm ring (der)
  minCopperHoleClearance: 0.25, // (def)
  minCopperEdgeClearance: 0.3, // (def)
  minThroughHoleDiameter: 0.15, // min drill (pub)
  minHoleToHole: 0.5, // (def)
  minMicroviaDiameter: 0.3, // no blind or buried vias (pub), so no microvias (def)
  minMicroviaDrill: 0.15, // (def)
  minSilkClearance: 0.15, // (def)
  minTextHeight: 1.0, // (def)
  minTextThickness: 0.15, // (def)
  ...SOLVER_CONSTRAINTS
}

const CIRCUITHUB_BUILD = {
  boardThickness: 1.6,
  copperThickness: 0.035,
  ...FR4,
  maskColor: 'Black',
  silkColor: 'White',
  copperFinish: 'ENIG'
} as const

const CIRCUITHUB_DEFAULTS: RoutingDefaults = {
  trackWidth: 0.25,
  clearance: 0.2,
  viaDiameter: 0.6,
  viaDrill: 0.3
}

const CIRCUITHUB_2L: ManufacturingProfile = {
  id: 'circuithub-2l-1.6',
  vendor: 'CircuitHub',
  tier: '2-layer 1.6 mm',
  builtIn: true,
  stackups: [
    {
      id: 'circuithub-2l-1.6-protoboard',
      name: 'ProtoBoard · 2-layer 1.6 mm FR4',
      spec: { copperLayers: 2, ...CIRCUITHUB_BUILD }
    }
  ],
  rules: { ...CIRCUITHUB_RULES },
  defaults: { ...CIRCUITHUB_DEFAULTS }
}

const CIRCUITHUB_4L: ManufacturingProfile = {
  id: 'circuithub-4l-1.6',
  vendor: 'CircuitHub',
  tier: '4-layer 1.6 mm',
  builtIn: true,
  stackups: [
    {
      id: 'circuithub-4l-1.6-protoboard',
      name: 'ProtoBoard · 4-layer 1.6 mm FR4',
      // 1 oz inner as well as outer: the board tab's default (pub).
      spec: { copperLayers: 4, innerCopperThickness: 0.035, ...CIRCUITHUB_BUILD }
    }
  ],
  rules: { ...CIRCUITHUB_RULES },
  defaults: { ...CIRCUITHUB_DEFAULTS }
}

/**
 * OSH Park (Portland, OR): one fixed build per service, so a profile per
 * service and a catalog of one. ENIG over purple mask on both.
 *
 * Sources: docs.oshpark.com/services/two-layer and /services/four-layer (the
 * stackups, edge keepout and inner-layer hole clearance) and
 * /design-tools/kicad/kicad-design-rules (the KiCad constraints). Marked as
 * CircuitHub's are.
 */
const oshParkRules = (copperLayers: 2 | 4): DesignRules => {
  const two = copperLayers === 2
  return {
    minClearance: spacingToMm(two ? 6 : 5, 'mil'), // (pub)
    minTrackWidth: spacingToMm(two ? 6 : 5, 'mil'), // (pub)
    minConnectionWidth: spacingToMm(two ? 6 : 5, 'mil'), // (pub)
    minViaAnnularWidth: spacingToMm(two ? 5 : 4, 'mil'), // (pub)
    minViaDiameter: spacingToMm(two ? 20 : 18, 'mil'), // (pub)
    // 5 mil on the KiCad page, but the 4-layer service holds a plated hole
    // 10 mil from inner copper, and KiCad's rule spans every layer (pub).
    minCopperHoleClearance: spacingToMm(two ? 5 : 10, 'mil'),
    minCopperEdgeClearance: spacingToMm(15, 'mil'), // board edge keepout (pub)
    minThroughHoleDiameter: spacingToMm(10, 'mil'), // (pub)
    minHoleToHole: spacingToMm(5, 'mil'), // (pub)
    // No blind or buried vias; the KiCad page sets these to a via's own (pub).
    minMicroviaDiameter: spacingToMm(two ? 20 : 18, 'mil'),
    minMicroviaDrill: spacingToMm(10, 'mil'),
    minSilkClearance: 0.15, // left to the user (def)
    minTextHeight: 1.0, // left to the user (def)
    minTextThickness: spacingToMm(5, 'mil'), // (pub)
    ...SOLVER_CONSTRAINTS
  }
}

const OSHPARK_FINISH = { maskColor: 'Purple', silkColor: 'White', copperFinish: 'ENIG' } as const

const OSHPARK_DEFAULTS: RoutingDefaults = {
  trackWidth: 0.25,
  clearance: 0.2,
  viaDiameter: 0.6,
  viaDrill: 0.3
}

const OSHPARK_2L: ManufacturingProfile = {
  id: 'oshpark-2l-1.6',
  vendor: 'OSH Park',
  tier: '2-layer 1.6 mm',
  builtIn: true,
  stackups: [
    {
      id: 'oshpark-2l-1.6-fr4',
      name: '2-layer · 1.6 mm FR4',
      spec: {
        copperLayers: 2,
        boardThickness: 1.6,
        copperThickness: spacingToMm(1.4, 'mil'),
        ...FR4, // Kingboard KB6167F, εr 4.5 (pub)
        ...OSHPARK_FINISH
      }
    }
  ],
  rules: oshParkRules(2),
  defaults: { ...OSHPARK_DEFAULTS }
}

const OSHPARK_4L: ManufacturingProfile = {
  id: 'oshpark-4l-1.6',
  vendor: 'OSH Park',
  tier: '4-layer 1.6 mm',
  builtIn: true,
  stackups: [
    {
      id: 'oshpark-4l-1.6-fr408hr',
      name: '4-layer · 1.6 mm FR408-HR',
      spec: {
        copperLayers: 4,
        boardThickness: 1.6,
        copperThickness: spacingToMm(1.7, 'mil'), // 1 oz clad and plated
        innerCopperThickness: spacingToMm(0.68, 'mil'),
        prepregThickness: spacingToMm(7.87, 'mil'), // 2113
        dielectricMaterial: 'FR408-HR',
        epsilonR: 3.61, // at 1 GHz (pub)
        lossTangent: 0.0092, // Isola's datasheet, at 2 GHz
        ...OSHPARK_FINISH
      }
    }
  ],
  rules: oshParkRules(4),
  defaults: { ...OSHPARK_DEFAULTS }
}

/** The read-only set shipped with the app; the default is first. */
export const BUILT_IN_PROFILES: readonly ManufacturingProfile[] = [
  CIRCUITHUB_2L,
  CIRCUITHUB_4L,
  JLCPCB_2L,
  JLCPCB_4L,
  OSHPARK_2L,
  OSHPARK_4L,
  GENERIC_2L
]

export const DEFAULT_PROFILE_ID = CIRCUITHUB_2L.id

export const findProfile = (id: string): ManufacturingProfile | null =>
  BUILT_IN_PROFILES.find((p) => p.id === id) ?? null

/**
 * Fork a profile into an edited copy. Editing a built-in never mutates it —
 * the user gets a derived profile they may keep for this project or save.
 */
export function deriveProfile(
  base: ManufacturingProfile,
  changes: Partial<Pick<ManufacturingProfile, 'rules' | 'defaults'>>
): ManufacturingProfile {
  return {
    ...base,
    id: `${base.id}+edited`,
    builtIn: false,
    derivedFrom: base.derivedFrom ?? base.id,
    rules: { ...base.rules, ...changes.rules },
    defaults: { ...base.defaults, ...changes.defaults }
  }
}

/** Every catalog build across the built-in profiles, for the stackup picker. */
export const allStackupPresets = (): Array<{ profile: ManufacturingProfile } & StackupPreset> =>
  BUILT_IN_PROFILES.flatMap((profile) => profile.stackups.map((preset) => ({ ...preset, profile })))

export const findStackupPreset = (id: string): StackupPreset | null =>
  allStackupPresets().find((preset) => preset.id === id) ?? null

/**
 * Does this board/project still hold the profile's values? Tells the profile a
 * board was set up with (stored, never inferred) from that profile edited.
 */
export function matchesProfile(
  profile: ManufacturingProfile,
  actual: { rules: DesignRules; classes: readonly NetClass[] }
): boolean {
  // Only the Default class is compared. A profile seeds Default and says
  // nothing about how many classes a design wants, so a board that added a
  // 90-ohm class has not thereby stopped matching its fab.
  const fallback = defaultNetClass(actual.classes)
  return (
    sameValues(profile.rules, actual.rules) &&
    sameValues(profile.defaults, {
      trackWidth: fallback.trackWidth,
      clearance: fallback.clearance,
      viaDiameter: fallback.viaDiameter,
      viaDrill: fallback.viaDrill
    })
  )
}

/**
 * Compare every key of the reference against the actual, driven by the object
 * rather than a hand-written list — so adding a design rule cannot silently
 * stop being checked, which would make an edited board keep claiming a profile
 * it no longer matches.
 */
const sameValues = <T extends object>(reference: T, actual: T): boolean =>
  (Object.keys(reference) as Array<keyof T>).every((key) => reference[key] === actual[key])
