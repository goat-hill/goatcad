// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * KiCad project (.kicad_pro) support. The project file is JSON; every key
 * other than the patched one round-trips untouched. A project file is never
 * created here — a schematic opened without one keeps its table settings in
 * memory only, matching KiCad's standalone behavior.
 *
 * Three areas are modeled:
 *  - Symbol Fields Table presets under schematic.bom_settings (KiCad 8 shape).
 *  - The connection grid under schematic.connection_grid_size, read only.
 *  - Board **design rules** and **routing defaults** (P0.4). These live here,
 *    not in the .kicad_pcb: modern KiCad moved net classes out of the board
 *    file ("the net class section has been moved out of the board file into the
 *    design rules file"), because a net class is shared between the schematic
 *    and the board. Only the physical stackup stays in the board (board.ts).
 *    A project-less board therefore has no persisted rules at all — KiCad falls
 *    back to compiled-in defaults, which DEFAULT_DESIGN_RULES mirrors.
 *  - Rule **severities** for the DRC and the ERC, in KiCad's own
 *    `rule_severities` (lib/ruleSeverity.ts).
 *  - The length tuners' defaults (`tuning_pattern_settings`) and the
 *    differential pair sizes (`diff_pair_dimensions`) the router reads.
 *  - **Migration** to KiCad 10 (`migrateProjectFile`): the sections KiCad's
 *    schematic editor fills on its first save, and the sheet list.
 */
import { extractTeardropSettings, type TeardropSettings } from '../board/teardrop/params'
import { mmToNm, mmToSpacing, nmToMm, spacingToMm, type Nm } from './coordinates'
import { cssColor, parseCssColor, type Rgba } from './color'
import { isRuleSeverity, type RuleSeverity, type SeverityMap } from '../ruleSeverity'
import { extractExclusions, type KicadExclusion } from '../kicadExclusions'
import { KICAD10_ERC_DEFAULTS, KICAD10_SCHEMATIC_DEFAULTS } from './projectDefaults'

export interface BomFieldSetting {
  name: string
  label: string
  show: boolean
  group_by: boolean
}

export interface BomSettings {
  fields_ordered: BomFieldSetting[]
  group_symbols: boolean
  sort_field: string
  sort_asc: boolean
  filter_string: string
  exclude_dnp: boolean
}

/** KiCad's internal names for the flag columns in fields_ordered. */
export const BOM_FIELD_DNP = '${DNP}'
export const BOM_FIELD_EXCLUDE_FROM_BOM = '${EXCLUDE_FROM_BOM}'
export const BOM_FIELD_EXCLUDE_FROM_BOARD = '${EXCLUDE_FROM_BOARD}'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseFieldSetting = (value: unknown): BomFieldSetting | null => {
  if (!isRecord(value) || typeof value.name !== 'string') return null
  return {
    name: value.name,
    label: typeof value.label === 'string' ? value.label : value.name,
    show: value.show !== false,
    group_by: value.group_by === true
  }
}

/** Read schematic.bom_settings out of project JSON; null when absent or malformed. */
export function extractBomSettings(projectJsonText: string): BomSettings | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root) || !isRecord(root.schematic)) return null
  const settings = root.schematic.bom_settings
  if (!isRecord(settings)) return null
  const fields = Array.isArray(settings.fields_ordered)
    ? settings.fields_ordered
        .map(parseFieldSetting)
        .filter((field): field is BomFieldSetting => field !== null)
    : []
  return {
    fields_ordered: fields,
    group_symbols: settings.group_symbols === true,
    sort_field: typeof settings.sort_field === 'string' ? settings.sort_field : 'Reference',
    sort_asc: settings.sort_asc !== false,
    filter_string: typeof settings.filter_string === 'string' ? settings.filter_string : '',
    exclude_dnp: settings.exclude_dnp === true
  }
}

/**
 * Replace schematic.bom_settings in project JSON, leaving all sibling keys
 * untouched (key order is preserved by JSON.parse/stringify). Returns null
 * for malformed input instead of clobbering the file.
 */
export function patchBomSettings(projectJsonText: string, settings: BomSettings): string | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  const schematic = isRecord(root.schematic) ? root.schematic : {}
  root.schematic = { ...schematic, bom_settings: settings }
  return `${JSON.stringify(root, null, 2)}\n`
}

/**
 * The project's connection grid (Schematic Setup › Formatting), which KiCad's
 * ERC measures off-grid ends against. KiCad writes it in mils
 * (`schematic.connection_grid_size`); null when the project does not set it.
 */
export function extractConnectionGrid(projectJsonText: string): Nm | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root) || !isRecord(root.schematic)) return null
  const mils = root.schematic.connection_grid_size
  if (typeof mils !== 'number' || !Number.isFinite(mils) || mils <= 0) return null
  return mmToNm(spacingToMm(mils, 'mil'))
}

/**
 * How the project writes a unit after a reference (`schematic.subpart_id_separator`
 * and `subpart_first_id`, character codes; `SubReference` in `symbolUnits.ts`);
 * null when the file sets neither.
 */
export function extractSubpartSettings(
  projectJsonText: string
): { separator: number; firstId: number } | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root) || !isRecord(root.schematic)) return null
  const { subpart_id_separator: separator, subpart_first_id: firstId } = root.schematic
  const code = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
  if (separator === undefined && firstId === undefined) return null
  return { separator: code(separator, 0), firstId: code(firstId, 65) || 65 }
}

/** The project's text variables (`text_variables`), by name; null when it has none. */
export function extractTextVariables(projectJsonText: string): Record<string, string> | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root) || !isRecord(root.text_variables)) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(root.text_variables)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** The names of the project's net classes (`net_settings.classes`); null when it lists none. */
export function extractNetclassNames(projectJsonText: string): string[] | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root) || !isRecord(root.net_settings)) return null
  const classes = root.net_settings.classes
  if (!Array.isArray(classes)) return null
  return classes.flatMap((entry) =>
    isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : []
  )
}

/**
 * The project's ERC pin conflict map (Schematic Setup › Pin Conflicts Map), a
 * 12×12 grid of 0 / 1 / 2 by pin type; null when the project does not set a
 * well-formed one, and KiCad's default applies.
 */
export function extractPinMap(projectJsonText: string): number[][] | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root) || !isRecord(root.erc)) return null
  const map = root.erc.pin_map
  const wellFormed =
    Array.isArray(map) &&
    map.length === 12 &&
    map.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 12 &&
        row.every((cell) => cell === 0 || cell === 1 || cell === 2)
    )
  return wellFormed ? (map as number[][]) : null
}

// ---------------------------------------------------------------------------
// Board design rules + routing defaults (P0.4)
// ---------------------------------------------------------------------------

/**
 * The rule minimums DRC (P0.5) checks against. Millimeters throughout.
 *
 * KiCad's Constraints page in full, grouped the way KiCad groups it. Every
 * field maps 1:1 onto a key KiCad already writes, so the names here are KiCad's
 * semantics in camelCase and nothing is invented.
 *
 * Most live in `board.design_settings.rules`; `zonesAllowExternalFillets` is
 * the one exception, a sibling of `rules` one level up in `design_settings`.
 * That asymmetry is KiCad's, and the writer honors it rather than relocating
 * the key into a tidier place KiCad would not read.
 */
export interface DesignRules {
  // Copper
  minClearance: number
  minTrackWidth: number
  minConnectionWidth: number
  minViaAnnularWidth: number
  minViaDiameter: number
  minCopperHoleClearance: number
  minCopperEdgeClearance: number
  // Holes
  minThroughHoleDiameter: number
  minHoleToHole: number
  // Microvias
  minMicroviaDiameter: number
  minMicroviaDrill: number
  // Silkscreen
  minSilkClearance: number
  minTextHeight: number
  minTextThickness: number
  // Arc/circle approximation
  maxError: number
  // Zone fill strategy
  zonesAllowExternalFillets: boolean
  minResolvedSpokes: number
  // Length tuning
  useHeightForLengthCalcs: boolean
}

/**
 * The four values a manufacturing profile seeds into the **Default** net class.
 * Not a net class itself — a fab tells you what it can hold, not how many
 * classes your design wants, so a profile only ever touches Default.
 */
export interface RoutingDefaults {
  trackWidth: number
  clearance: number
  viaDiameter: number
  viaDrill: number
}

/**
 * One net class: the geometry every net in it is routed and checked with.
 *
 * These are the PCB-side fields. A class also carries schematic properties
 * (`wire_width`, `bus_width`, `line_style`) and colors — which is exactly why
 * net classes live in the `.kicad_pro` rather than the board (§2 of the
 * workstream) — plus a `priority` that decides which pattern wins. None of that
 * is edited here, and all of it round-trips untouched: the writer patches a
 * class by name and preserves every key it did not set.
 */
export interface NetClass {
  name: string
  clearance: number
  trackWidth: number
  viaDiameter: number
  viaDrill: number
  microviaDiameter: number
  microviaDrill: number
  diffPairWidth: number
  diffPairGap: number
  /** KiCad's `priority`: lower wins when several classes apply to a net. Default's is INT_MAX. */
  priority?: number
  /** KiCad's `pcb_color`, absent where transparent (the layer's own); Default never has one. */
  pcbColor?: Rgba
  /**
   * The schematic's styling of the class's wires and buses (KiCad's
   * `schematic_color`, `wire_width` and `bus_width` in mils, `line_style`):
   * each absent where the class leaves it to the next, then Default, then
   * KiCad's own (`SCHEMATIC_CLASS_DEFAULTS`). A wire's own stroke wins over all
   * of them (`SCH_LINE::GetLineColor`).
   */
  schematicColor?: Rgba
  /** mm */
  wireWidth?: number
  /** mm */
  busWidth?: number
  lineStyle?: ClassLineStyle
  /** KiCad 10's `tuning_profile`: the profile the class's nets take; absent for none. */
  tuningProfile?: string
  /**
   * Fields the file leaves unset. KiCad takes each from the next class that
   * sets it, then Default; the value here is Default's, for display, and the
   * writer leaves the key out so the class keeps inheriting.
   */
  unset?: readonly NetClassField[]
  /** On a net's effective class: the class each field came from, where it is not `name`. */
  sources?: Partial<Record<NetClassField, string>>
  /**
   * On a composite: every class that applies, in priority order. KiCad names
   * the composite by joining them with commas, and a rule's `hasExactNetclass`
   * matches that name.
   */
  constituents?: readonly string[]
}

/** KiCad's `LINE_STYLE`, by its number in the file, as the stroke type the file's items name. */
export const CLASS_LINE_STYLES = ['solid', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'] as const
export type ClassLineStyle = (typeof CLASS_LINE_STYLES)[number]

/** What KiCad's Default class draws with (`NETCLASS` defaults: 6 and 12 mil, solid). */
export const SCHEMATIC_CLASS_DEFAULTS = {
  wireWidth: spacingToMm(6, 'mil'),
  busWidth: spacingToMm(12, 'mil'),
  lineStyle: 'solid' as ClassLineStyle
}

/** The name KiCad gives a net's effective class: the class, or a composite's constituents joined. */
export const effectiveClassName = (netClass: NetClass): string =>
  netClass.constituents?.join(',') ?? netClass.name

/** The geometry fields of a class, each of which a class may leave to another. */
export type NetClassField =
  | 'clearance'
  | 'trackWidth'
  | 'viaDiameter'
  | 'viaDrill'
  | 'microviaDiameter'
  | 'microviaDrill'
  | 'diffPairWidth'
  | 'diffPairGap'

/** Each field's key in `net_settings.classes`. */
export const NET_CLASS_KEYS: Readonly<Record<NetClassField, string>> = {
  clearance: 'clearance',
  trackWidth: 'track_width',
  viaDiameter: 'via_diameter',
  viaDrill: 'via_drill',
  microviaDiameter: 'microvia_diameter',
  microviaDrill: 'microvia_drill',
  diffPairWidth: 'diff_pair_width',
  diffPairGap: 'diff_pair_gap'
}

const NET_CLASS_FIELDS = Object.keys(NET_CLASS_KEYS) as NetClassField[]

/**
 * Assigns nets to a class by pattern, e.g. `GND` or `/*USB_*` → `usbdiff`.
 * This is KiCad's `netclass_patterns`.
 */
/** A via's copper diameter and drill, mm. */
export interface ViaSize {
  diameter: number
  drill: number
}

export interface NetClassPattern {
  pattern: string
  netClass: string
}

/**
 * One net's explicit class: KiCad's `netclass_assignments`, which the
 * schematic writes for a net a directive flag or label field puts in a class
 * (`patchNetclassAssignments`). Read for the router and the checks, never
 * edited by hand (board-setup-workstream.md).
 */
export interface NetClassAssignment {
  net: string
  netClass: string
}

export interface BoardDesignSettings {
  rules: DesignRules
  /** The Board Setup presets the user picked; Custom where none is stored. */
  setupChoice?: BoardSetupChoice
  /** Every class in the project. `Default` always exists and is always first. */
  classes: NetClass[]
  patterns: NetClassPattern[]
  assignments: NetClassAssignment[]
  /** The DRC's `rule_severities`; a caller with no project leaves KiCad's defaults. */
  severities?: SeverityMap
  /** The findings a KiCad user excluded (`drc_exclusions`), read-only. */
  exclusions?: KicadExclusion[]
  /** The length tuners' meander defaults (`tuning_pattern_settings`); KiCad's where unread. */
  tuningPatterns?: TuningPatternSettings
  /** The teardrop defaults and Edit teardrops' targets (`teardrop_parameters`, `teardrop_options`). */
  teardrops?: TeardropSettings
  /**
   * The project's custom rules: its `.kicad_dru`, beside the `.kicad_pro`, as
   * text. Read here; written a rule at a time (`lib/board/rules/druRules.ts`).
   */
  customRules?: string
  /** The project's `text_variables`, which board text resolves `${NAME}` from after the board's own. */
  textVariables?: Record<string, string>
  /**
   * The route tool's sizes beyond the net classes' (`track_widths`,
   * `via_dimensions`, mm). KiCad writes a zero first entry for "use the net
   * class"; it is not read as a size.
   */
  extraSizes?: { tracks: number[]; vias: ViaSize[] }
  /**
   * The project's differential pair sizes beyond the net classes'
   * (`diff_pair_dimensions`, mm), which `W` steps while a pair is routed.
   * Read, never written: the file keeps them as they are.
   */
  pairSizes?: Array<{ width: number; gap: number; viaGap: number }>
  /**
   * KiCad 10's tuning profiles: the one each net class names, and the names
   * the project defines (`tuning_profiles`).
   */
  tuning?: {
    classProfiles: Record<string, string>
    profiles: string[]
    /** Each profile whole, as Board Setup's Tuning profiles page edits it. */
    definitions?: TuningProfile[]
    /** Each profile's propagation delays, for time-domain length rules. */
    delays?: Record<string, TuningDelays>
    /** Each profile's track geometry per signal layer, for its implicit rules. */
    geometries?: Record<string, TuningGeometry>
  }
  /**
   * KiCad 10's component class assignments (`component_class_settings`): the
   * classes the board gives footprints by their reference, library, side,
   * rotation, a field, the sheet or an expression, beside those their symbols gave.
   */
  componentClasses?: ComponentClassSettings
}

export interface ComponentClassSettings {
  assignments: Array<{
    className: string
    /** Whether every condition must hold, or any one. */
    all: boolean
    conditions: Array<{ type: string; primary: string; secondary: string }>
  }>
  /** Give each footprint a class named for its sheet (root aside). */
  sheetClasses: boolean
}

/**
 * A tuning profile's track geometry: the width (and a differential profile's
 * gap) it gives each signal layer, mm; zero where it gives none.
 */
export interface TuningGeometry {
  differential: boolean
  layers: Array<{ layer: string; width: number; gap: number }>
}

/**
 * A tuning profile's propagation delays, in attoseconds per millimeter
 * (KiCad's time unit): per signal layer, through a via, and a via's own
 * override between layers. Zero unless the profile tunes in the time domain.
 */
export interface TuningDelays {
  timeDomain: boolean
  layers: Record<string, number>
  via: number
  overrides: Array<{
    signalFrom: string
    signalTo: string
    viaFrom: string
    viaTo: string
    delay: number
  }>
}

/**
 * One signal layer of a tuning profile (KiCad 10's
 * `DELAY_PROFILE_TRACK_PROPAGATION_ENTRY`): the planes it is referenced to,
 * empty for none; its width and pair gap, mm, zero for none; its unit delay,
 * attoseconds per millimeter.
 */
export interface TuningProfileLayer {
  layer: string
  topReference: string
  bottomReference: string
  width: number
  gap: number
  delay: number
}

/** A tuning profile whole (KiCad 10's `TUNING_PROFILE`), as the project saves it. */
export interface TuningProfile {
  name: string
  differential: boolean
  /** Ohms; zero for none. */
  targetImpedance: number
  timeDomain: boolean
  layers: TuningProfileLayer[]
  /** Attoseconds per millimeter of via height. */
  viaDelay: number
  overrides: TuningDelays['overrides']
}

/** KiCad's name for the class every unassigned net falls back to. */
export const DEFAULT_CLASS_NAME = 'Default'

/**
 * INT_MAX — KiCad's priority for Default. Priority is "lower number wins", so
 * parking Default at the top of the range makes every custom class outrank it.
 */
const DEFAULT_CLASS_PRIORITY = 2147483647

/** The Default class, or a synthesised one — it is guaranteed to exist. */
export const defaultNetClass = (classes: readonly NetClass[]): NetClass =>
  classes.find((c) => c.name === DEFAULT_CLASS_NAME) ?? makeNetClass(DEFAULT_CLASS_NAME)

/**
 * Whether a net-class pattern matches a net name, as KiCad matches one
 * (`CTX_NETCLASS`): as a regular expression anchored at both ends, or as a
 * shell wildcard (`*` any run, `?` one character, the rest literal and
 * case-sensitive) anchored the same way. So `/Plug|/Socket` and `+*` both
 * work. The regex is anchored by prepending `^` and appending `$` to the text,
 * not by grouping it, and a match counts only when it starts at the name's
 * first character — which is how KiCad reads an alternation.
 */
export function matchesNetPattern(pattern: string, name: string): boolean {
  return matchesWildcard(pattern, name) || matchesAnchoredRegex(pattern, name)
}

/** Classic two-pointer glob with `*` backtracking. */
function matchesWildcard(pattern: string, name: string): boolean {
  let p = 0
  let n = 0
  let starP = -1
  let starN = 0
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) {
      p++
      n++
    } else if (p < pattern.length && pattern[p] === '*') {
      starP = p++
      starN = n
    } else if (starP >= 0) {
      p = starP + 1
      n = ++starN
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

/** Compiled patterns; null for text that is not a valid expression. */
const patternRegexes = new Map<string, RegExp | null>()

function matchesAnchoredRegex(pattern: string, name: string): boolean {
  let regex = patternRegexes.get(pattern)
  if (regex === undefined) {
    const source = `${pattern.startsWith('^') ? '' : '^'}${pattern}${pattern.endsWith('$') ? '' : '$'}`
    try {
      regex = new RegExp(source)
    } catch {
      regex = null
    }
    patternRegexes.set(pattern, regex)
  }
  if (!regex) return false
  const match = regex.exec(name)
  return match !== null && match.index === 0
}

const classPriority = (netClass: NetClass, index: number): number =>
  netClass.name === DEFAULT_CLASS_NAME ? DEFAULT_CLASS_PRIORITY : (netClass.priority ?? index)

/** Resolved classes per net, for as long as the inputs are the same arrays. */
const effectiveCache = new WeakMap<
  readonly NetClass[],
  {
    patterns: readonly NetClassPattern[]
    assignments: readonly NetClassAssignment[]
    byNet: Map<string, NetClass>
  }
>()

/**
 * The class a net routes and is checked with, composed as KiCad composes it
 * (`NET_SETTINGS::GetEffectiveNetClass`): every class the net is assigned
 * (`netclass_assignments`) or whose pattern matches it, ordered by priority
 * (lower wins, then name); each field comes from the first of them that sets
 * it, and a field none sets comes from Default. A net matching nothing, and
 * the empty net, is Default. A class named but not defined contributes
 * nothing. The result is the matching class itself when one class supplies
 * everything; otherwise a composite named for the class that outranks the
 * rest, whose `sources` name the class behind each field.
 */
export function netClassForNet(
  netName: string,
  classes: readonly NetClass[],
  patterns: readonly NetClassPattern[],
  assignments: readonly NetClassAssignment[] = []
): NetClass {
  let cache = effectiveCache.get(classes)
  if (!cache || cache.patterns !== patterns || cache.assignments !== assignments) {
    cache = { patterns, assignments, byNet: new Map() }
    effectiveCache.set(classes, cache)
  }
  const cached = cache.byNet.get(netName)
  if (cached) return cached
  const resolved = composeNetClass(netName, classes, patterns, assignments)
  cache.byNet.set(netName, resolved)
  return resolved
}

function composeNetClass(
  netName: string,
  classes: readonly NetClass[],
  patterns: readonly NetClassPattern[],
  assignments: readonly NetClassAssignment[]
): NetClass {
  const fallback = defaultNetClass(classes)
  if (netName === '') return fallback
  const matched = new Set<string>()
  for (const { net, netClass } of assignments) if (net === netName) matched.add(netClass)
  for (const { pattern, netClass } of patterns) {
    if (matchesNetPattern(pattern, netName)) matched.add(netClass)
  }
  // A class named by an assignment or pattern but never defined is KiCad's
  // implicit class: it sets nothing, but the net is in it (`hasNetclass`).
  const implicit = [...matched]
    .filter((name) => !classes.some((c) => c.name === name))
    .map((name) => ({
      netClass: {
        ...fallback,
        name,
        unset: NET_CLASS_FIELDS,
        priority: DEFAULT_CLASS_PRIORITY - 1
      },
      priority: DEFAULT_CLASS_PRIORITY - 1
    }))
  const constituents = [
    ...classes.map((netClass, index) => ({ netClass, priority: classPriority(netClass, index) })),
    ...implicit
  ]
    .filter(({ netClass }) => matched.has(netClass.name))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.netClass.name < b.netClass.name ? -1 : a.netClass.name > b.netClass.name ? 1 : 0)
    )
    .map(({ netClass }) => netClass)
  if (constituents.length === 0) return fallback
  const primary = constituents[0]
  if (constituents.length === 1 && !primary.unset?.length) return primary

  const composed: NetClass = { ...primary, sources: {} }
  delete composed.unset
  // KiCad adds Default when it filled a field, and names the composite for all of them.
  const fromDefault = NET_CLASS_FIELDS.some((field) =>
    constituents.every((c) => c.unset?.includes(field))
  )
  composed.constituents = [
    ...constituents.map((c) => c.name),
    ...(fromDefault ? [fallback.name] : [])
  ]
  for (const field of NET_CLASS_FIELDS) {
    const from = constituents.find((c) => !c.unset?.includes(field)) ?? fallback
    composed[field] = from[field]
    if (from !== primary) composed.sources![field] = from.name
  }
  // KiCad's makeEffectiveNetclass: each of these from the first class in priority order that
  // has it, then Default.
  for (const key of ['pcbColor', 'schematicColor', 'wireWidth', 'busWidth', 'lineStyle'] as const) {
    const value = (constituents.find((c) => c[key] !== undefined) ?? fallback)[key]
    if (value !== undefined) Object.assign(composed, { [key]: value })
    else delete composed[key]
  }
  return composed
}

/**
 * What a board gets when nothing is persisted — the project-less case, and the
 * fallback for keys a hand-edited project omits. Deliberately a set a standard
 * 2-layer fab can hold (rather than KiCad's mostly-zero factory rules, where 0
 * means "unconstrained"), so DRC has real numbers to check from the first open.
 */
export const DEFAULT_DESIGN_RULES: DesignRules = {
  minClearance: 0.2,
  minTrackWidth: 0.2,
  minConnectionWidth: 0.2,
  minViaAnnularWidth: 0.13,
  minViaDiameter: 0.6,
  minCopperHoleClearance: 0.25,
  minCopperEdgeClearance: 0.3,
  minThroughHoleDiameter: 0.3,
  minHoleToHole: 0.5,
  minMicroviaDiameter: 0.3,
  minMicroviaDrill: 0.15,
  minSilkClearance: 0.15,
  // KiCad's own silkscreen floors, which every prototype fab clears.
  minTextHeight: 0.8,
  minTextThickness: 0.15,
  // Solver settings rather than fab limits, so these are KiCad's own defaults
  // verbatim — nothing here is a judgement about what a house can hold.
  maxError: 0.005,
  zonesAllowExternalFillets: false,
  minResolvedSpokes: 2,
  useHeightForLengthCalcs: true
}

/** Matches the Default net class the new-project template writes. */
export const DEFAULT_ROUTING_DEFAULTS: RoutingDefaults = {
  trackWidth: 0.2,
  clearance: 0.2,
  viaDiameter: 0.6,
  viaDrill: 0.3
}

/** KiCad's own microvia and diff-pair defaults, for a class the file omits. */
const CLASS_FALLBACKS = {
  microviaDiameter: 0.3,
  microviaDrill: 0.1,
  diffPairWidth: 0.2,
  diffPairGap: 0.25
} as const

/** A new class, seeded from the Default-class values a profile supplies. */
export const makeNetClass = (
  name: string,
  seed: RoutingDefaults = DEFAULT_ROUTING_DEFAULTS
): NetClass => ({ name, ...seed, ...CLASS_FALLBACKS })

/** What a project with no `net_settings` gets: just Default. */
export const DEFAULT_NET_CLASSES: NetClass[] = [makeNetClass(DEFAULT_CLASS_NAME)]

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

/**
 * Read every net class out of project JSON, Default first.
 *
 * Default is synthesised when the file has none, because the rest of the app
 * treats it as always present — an unassigned net has to route with something.
 * Ordering is normalized here rather than trusted: KiCad writes Default first,
 * but a hand-edited file need not.
 */
function readNetClasses(root: Record<string, unknown>): NetClass[] {
  const netSettings = isRecord(root.net_settings) ? root.net_settings : {}
  const raw = Array.isArray(netSettings.classes) ? netSettings.classes.filter(isRecord) : []
  const r = DEFAULT_ROUTING_DEFAULTS
  const f = CLASS_FALLBACKS

  // Default sets every field (GoatCAD's defaults fill a hand-edited one);
  // another class may leave any to Default, and shows Default's value there.
  const defaultEntry = raw.find((entry) => str(entry.name) === DEFAULT_CLASS_NAME)
  const builtIn: Record<NetClassField, number> = { ...r, ...f }
  const inherited = {} as Record<NetClassField, number>
  for (const field of NET_CLASS_FIELDS) {
    inherited[field] = num(defaultEntry?.[NET_CLASS_KEYS[field]], builtIn[field])
  }

  const classes = raw.map((entry, index): NetClass => {
    // An unnamed class is unaddressable — pattern assignment is by name — so
    // give it a stable placeholder rather than dropping the user's geometry.
    const name = str(entry.name) || `Class ${index + 1}`
    const isDefault = name === DEFAULT_CLASS_NAME
    const netClass = { name } as NetClass
    const unset: NetClassField[] = []
    for (const field of NET_CLASS_FIELDS) {
      const value = entry[NET_CLASS_KEYS[field]]
      const given = typeof value === 'number' && Number.isFinite(value)
      if (!given && !isDefault) unset.push(field)
      netClass[field] = given ? value : isDefault ? builtIn[field] : inherited[field]
    }
    if (typeof entry.priority === 'number') netClass.priority = entry.priority
    const pcbColor = isDefault ? null : parseCssColor(entry.pcb_color)
    if (pcbColor) netClass.pcbColor = pcbColor
    const schematicColor = parseCssColor(entry.schematic_color)
    if (schematicColor) netClass.schematicColor = schematicColor
    const mils = (key: string): number | undefined =>
      typeof entry[key] === 'number' && Number.isFinite(entry[key])
        ? spacingToMm(entry[key] as number, 'mil')
        : undefined
    const wireWidth = mils('wire_width')
    const busWidth = mils('bus_width')
    const lineStyle =
      typeof entry.line_style === 'number' ? CLASS_LINE_STYLES[entry.line_style] : undefined
    if (wireWidth !== undefined) netClass.wireWidth = wireWidth
    if (busWidth !== undefined) netClass.busWidth = busWidth
    if (lineStyle !== undefined) netClass.lineStyle = lineStyle
    if (typeof entry.tuning_profile === 'string' && entry.tuning_profile)
      netClass.tuningProfile = entry.tuning_profile
    if (unset.length) netClass.unset = unset
    return netClass
  })

  const defaultIndex = classes.findIndex((c) => c.name === DEFAULT_CLASS_NAME)
  if (defaultIndex < 0) return [makeNetClass(DEFAULT_CLASS_NAME), ...classes]
  return [classes[defaultIndex], ...classes.filter((_, i) => i !== defaultIndex)]
}

/**
 * `netclass_assignments`: `{ "<net>": ["<class>", …] }`, one entry per class
 * named — or `{ "<net>": "<class>" }`, the single class older files write.
 */
function readNetClassAssignments(root: Record<string, unknown>): NetClassAssignment[] {
  const netSettings = isRecord(root.net_settings) ? root.net_settings : {}
  const raw = isRecord(netSettings.netclass_assignments) ? netSettings.netclass_assignments : {}
  return Object.entries(raw).flatMap(([net, classes]) =>
    (Array.isArray(classes) ? classes : [classes])
      .filter((c): c is string => typeof c === 'string' && c !== '')
      .map((netClass) => ({ net, netClass }))
  )
}

function readNetClassPatterns(root: Record<string, unknown>): NetClassPattern[] {
  const netSettings = isRecord(root.net_settings) ? root.net_settings : {}
  const raw = Array.isArray(netSettings.netclass_patterns)
    ? netSettings.netclass_patterns.filter(isRecord)
    : []
  return raw
    .map((entry) => ({ pattern: str(entry.pattern), netClass: str(entry.netclass) }))
    .filter((entry) => entry.pattern !== '' && entry.netClass !== '')
}

/**
 * Read design rules and net classes out of project JSON, filling any key the
 * file omits from the defaults above. Null only for malformed input — a
 * well-formed project with no rules yields the defaults, matching KiCad's
 * fall-back-to-built-ins behavior.
 */
export function extractDesignSettings(projectJsonText: string): BoardDesignSettings | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null

  const board = isRecord(root.board) ? root.board : {}
  const designSettings = isRecord(board.design_settings) ? board.design_settings : {}
  const rules = isRecord(designSettings.rules) ? designSettings.rules : {}
  const d = DEFAULT_DESIGN_RULES

  const choice = extractBoardSetupChoice(root)
  return {
    ...(choice.profile || choice.stackup ? { setupChoice: choice } : {}),
    rules: {
      minClearance: num(rules.min_clearance, d.minClearance),
      minTrackWidth: num(rules.min_track_width, d.minTrackWidth),
      minConnectionWidth: num(rules.min_connection, d.minConnectionWidth),
      minViaAnnularWidth: num(rules.min_via_annular_width, d.minViaAnnularWidth),
      minViaDiameter: num(rules.min_via_diameter, d.minViaDiameter),
      minCopperHoleClearance: num(rules.min_hole_clearance, d.minCopperHoleClearance),
      minCopperEdgeClearance: num(rules.min_copper_edge_clearance, d.minCopperEdgeClearance),
      minThroughHoleDiameter: num(rules.min_through_hole_diameter, d.minThroughHoleDiameter),
      minHoleToHole: num(rules.min_hole_to_hole, d.minHoleToHole),
      minMicroviaDiameter: num(rules.min_microvia_diameter, d.minMicroviaDiameter),
      minMicroviaDrill: num(rules.min_microvia_drill, d.minMicroviaDrill),
      minSilkClearance: num(rules.min_silk_clearance, d.minSilkClearance),
      minTextHeight: num(rules.min_text_height, d.minTextHeight),
      minTextThickness: num(rules.min_text_thickness, d.minTextThickness),
      maxError: num(rules.max_error, d.maxError),
      // The one key that is NOT under `rules` — KiCad keeps it a level up.
      zonesAllowExternalFillets: bool(
        designSettings.zones_allow_external_fillets,
        d.zonesAllowExternalFillets
      ),
      minResolvedSpokes: num(rules.min_resolved_spokes, d.minResolvedSpokes),
      useHeightForLengthCalcs: bool(rules.use_height_for_length_calcs, d.useHeightForLengthCalcs)
    },
    classes: readNetClasses(root),
    patterns: readNetClassPatterns(root),
    assignments: readNetClassAssignments(root),
    severities: readSeverities(designSettings.rule_severities),
    exclusions: extractExclusions(projectJsonText, 'drc'),
    // Only where the project saves them; a reader takes KiCad's defaults otherwise.
    ...(isRecord(designSettings.tuning_pattern_settings)
      ? { tuningPatterns: extractTuningPatternSettings(projectJsonText) ?? undefined }
      : {}),
    ...(Array.isArray(designSettings.teardrop_parameters) ||
    Array.isArray(designSettings.teardrop_options)
      ? { teardrops: extractTeardropSettings(projectJsonText) }
      : {}),
    textVariables: extractTextVariables(projectJsonText) ?? undefined,
    ...readExtraSizes(designSettings),
    ...readTuning(root),
    ...readComponentClasses(root)
  }
}

const readExtraSizes = (
  designSettings: Record<string, unknown>
): Pick<BoardDesignSettings, 'extraSizes' | 'pairSizes'> => {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const tracks = list(designSettings.track_widths).flatMap((w) =>
    typeof w === 'number' && w > 0 ? [w] : []
  )
  const vias = list(designSettings.via_dimensions).flatMap((v) =>
    isRecord(v) && typeof v.diameter === 'number' && typeof v.drill === 'number' && v.diameter > 0
      ? [{ diameter: v.diameter, drill: v.drill }]
      : []
  )
  const pairs = list(designSettings.diff_pair_dimensions).flatMap((p) =>
    isRecord(p) && typeof p.width === 'number' && typeof p.gap === 'number' && p.width > 0
      ? [{ width: p.width, gap: p.gap, viaGap: typeof p.via_gap === 'number' ? p.via_gap : p.gap }]
      : []
  )
  return {
    ...(tracks.length > 0 || vias.length > 0 ? { extraSizes: { tracks, vias } } : {}),
    ...(pairs.length > 0 ? { pairSizes: pairs } : {})
  }
}

/** The project's component class assignments, where it has any. */
const readComponentClasses = (
  root: Record<string, unknown>
): Pick<BoardDesignSettings, 'componentClasses'> => {
  const settings = root.component_class_settings
  if (!isRecord(settings)) return {}
  const assignments = (Array.isArray(settings.assignments) ? settings.assignments : []).flatMap(
    (entry) => {
      if (!isRecord(entry) || typeof entry.component_class !== 'string') return []
      const conditions = isRecord(entry.conditions)
        ? Object.entries(entry.conditions).flatMap(([type, value]) =>
            isRecord(value)
              ? [
                  {
                    type,
                    primary: typeof value.primary === 'string' ? value.primary : '',
                    secondary: typeof value.secondary === 'string' ? value.secondary : ''
                  }
                ]
              : []
          )
        : []
      return [
        { className: entry.component_class, all: entry.conditions_operator === 'ALL', conditions }
      ]
    }
  )
  const sheets = isRecord(settings.sheet_component_classes) ? settings.sheet_component_classes : {}
  const sheetClasses = sheets.enabled === true
  return assignments.length > 0 || sheetClasses
    ? { componentClasses: { assignments, sheetClasses } }
    : {}
}

/** Each tuning profile the project saves (`tuning_profiles`), in its order. */
const readTuningProfiles = (root: Record<string, unknown>): TuningProfile[] => {
  const tuning = isRecord(root.tuning_profiles) ? root.tuning_profiles : {}
  const list = tuning.tuning_profiles_impedance_geometric
  const layerName = (value: unknown): string => (str(value) === 'UNDEFINED' ? '' : str(value))
  return (Array.isArray(list) ? list : []).flatMap((profile): TuningProfile[] => {
    if (!isRecord(profile) || typeof profile.profile_name !== 'string' || !profile.profile_name)
      return []
    const layers = (Array.isArray(profile.layer_entries) ? profile.layer_entries : []).flatMap(
      (entry): TuningProfileLayer[] =>
        isRecord(entry) && typeof entry.signal_layer === 'string'
          ? [
              {
                layer: entry.signal_layer,
                topReference: layerName(entry.top_reference_layer),
                bottomReference: layerName(entry.bottom_reference_layer),
                // Stored in KiCad's internal units, nanometers.
                width: nmToMm(num(entry.width, 0) as Nm),
                gap: nmToMm(num(entry.diff_pair_gap, 0) as Nm),
                delay: num(entry.delay, 0)
              }
            ]
          : []
    )
    const overrides = (Array.isArray(profile.via_overrides) ? profile.via_overrides : []).flatMap(
      (entry) =>
        isRecord(entry) && typeof entry.signal_layer_from === 'string'
          ? [
              {
                signalFrom: String(entry.signal_layer_from),
                signalTo: String(entry.signal_layer_to ?? ''),
                viaFrom: String(entry.via_layer_from ?? ''),
                viaTo: String(entry.via_layer_to ?? ''),
                delay: num(entry.delay, 0)
              }
            ]
          : []
    )
    return [
      {
        name: profile.profile_name,
        differential: num(profile.type, 0) !== 0,
        targetImpedance: num(profile.target_impedance, 0),
        timeDomain: profile.enable_time_domain_tuning === true,
        layers,
        viaDelay: num(profile.via_prop_delay, 0),
        overrides
      }
    ]
  })
}

/**
 * What the checks and the router read of the profiles: which one each class
 * names, the names, each one's delays and its geometry per layer.
 */
export function tuningSettingsOf(
  definitions: readonly TuningProfile[],
  classProfiles: Record<string, string>
): NonNullable<BoardDesignSettings['tuning']> {
  const delays: Record<string, TuningDelays> = {}
  const geometries: Record<string, TuningGeometry> = {}
  for (const profile of definitions) {
    delays[profile.name] = {
      timeDomain: profile.timeDomain,
      layers: Object.fromEntries(profile.layers.map((l) => [l.layer, l.delay])),
      via: profile.viaDelay,
      overrides: profile.overrides.map((o) => ({ ...o }))
    }
    geometries[profile.name] = {
      differential: profile.differential,
      layers: profile.layers.map(({ layer, width, gap }) => ({ layer, width, gap }))
    }
  }
  return {
    classProfiles: { ...classProfiles },
    profiles: definitions.map((p) => p.name),
    // Copied field by field: the page hands reactive proxies, which structuredClone refuses.
    definitions: definitions.map((p) => ({
      ...p,
      layers: p.layers.map((l) => ({ ...l })),
      overrides: p.overrides.map((o) => ({ ...o }))
    })),
    delays,
    geometries
  }
}

/** Which tuning profile each class names, and which profiles exist. */
const readTuning = (root: Record<string, unknown>): Pick<BoardDesignSettings, 'tuning'> => {
  const netSettings = isRecord(root.net_settings) ? root.net_settings : {}
  const classProfiles: Record<string, string> = {}
  for (const cls of Array.isArray(netSettings.classes) ? netSettings.classes : []) {
    if (isRecord(cls) && typeof cls.name === 'string' && typeof cls.tuning_profile === 'string')
      classProfiles[cls.name] = cls.tuning_profile
  }
  const definitions = readTuningProfiles(root)
  return Object.values(classProfiles).some(Boolean) || definitions.length
    ? { tuning: tuningSettingsOf(definitions, classProfiles) }
    : {}
}

/** Which checker's severities: the board's DRC or the schematic's ERC. */
export type SeverityScope = 'drc' | 'erc'

const readSeverities = (value: unknown): SeverityMap => {
  const out: Record<string, RuleSeverity> = {}
  if (!isRecord(value)) return out
  for (const [key, severity] of Object.entries(value)) {
    if (isRuleSeverity(severity)) out[key] = severity
  }
  return out
}

const severityParent = (
  root: Record<string, unknown>,
  scope: SeverityScope
): Record<string, unknown> => {
  if (scope === 'erc') return isRecord(root.erc) ? root.erc : {}
  const board = isRecord(root.board) ? root.board : {}
  return isRecord(board.design_settings) ? board.design_settings : {}
}

/** A project's rule severities, keyed by KiCad violation key. Null for malformed JSON. */
export function extractRuleSeverities(
  projectJsonText: string,
  scope: SeverityScope
): SeverityMap | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  return readSeverities(severityParent(root, scope).rule_severities)
}

/**
 * Set rule severities where KiCad keeps them, leaving every other key —
 * including the other rules' severities — untouched. Null for malformed JSON.
 */
export function patchRuleSeverities(
  projectJsonText: string,
  scope: SeverityScope,
  changes: SeverityMap
): string | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  const parent = severityParent(root, scope)
  const existing = isRecord(parent.rule_severities) ? parent.rule_severities : {}
  const patched = { ...parent, rule_severities: { ...existing, ...changes } }
  if (scope === 'erc') {
    root.erc = patched
  } else {
    const board = isRecord(root.board) ? root.board : {}
    root.board = { ...board, design_settings: patched }
  }
  return `${JSON.stringify(root, null, 2)}\n`
}

/**
 * Write the schematic's net class assignments (`net_settings.netclass_assignments`)
 * as KiCad saves them: each net, sorted, to its classes, sorted; null when there
 * are none. The text comes back unchanged when they are already what it says.
 */
export function patchNetclassAssignments(
  text: string,
  assignments: readonly NetClassAssignment[]
): string | null {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  // KiCad's map of sets: nets in order, each net's classes in order.
  const normal = (list: readonly NetClassAssignment[]): Record<string, string[]> | null => {
    const byNet = new Map<string, Set<string>>()
    for (const { net, netClass } of list) {
      let set = byNet.get(net)
      if (!set) byNet.set(net, (set = new Set()))
      set.add(netClass)
    }
    const nets = [...byNet.keys()].sort()
    return nets.length === 0
      ? null
      : Object.fromEntries(nets.map((net) => [net, [...byNet.get(net)!].sort()]))
  }
  const next = normal(assignments)
  if (JSON.stringify(normal(readNetClassAssignments(root))) === JSON.stringify(next)) return text
  const netSettings = isRecord(root.net_settings) ? root.net_settings : {}
  root.net_settings = { ...netSettings, netclass_assignments: next }
  return `${JSON.stringify(root, null, 2)}\n`
}

/**
 * Write design rules into board.design_settings.rules and the net classes and
 * their assignment patterns into net_settings, leaving every sibling key — at
 * every level, and every key of a class this editor does not own — untouched.
 * Returns null for malformed input instead of clobbering the file.
 *
 * The class list is written as given, so a class removed from the model is
 * removed from the file. Patterns are the caller's responsibility to keep
 * consistent (`applyBoardSetupEdit` drops a removed class's patterns with it) —
 * a pattern naming a class that no longer exists is config KiCad cannot honor.
 */
/** What Board Setup writes back; explicit net assignments are the schematic's to write. */
export type WritableDesignSettings = Omit<
  BoardDesignSettings,
  'assignments' | 'customRules' | 'textVariables'
>

export function patchDesignSettings(
  projectJsonText: string,
  settings: WritableDesignSettings
): string | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null

  const { rules, classes, patterns } = settings
  const board = isRecord(root.board) ? root.board : {}
  const designSettings = isRecord(board.design_settings) ? board.design_settings : {}
  const existingRules = isRecord(designSettings.rules) ? designSettings.rules : {}
  root.board = {
    ...board,
    design_settings: {
      ...designSettings,
      // Sibling of `rules`, not a member of it — KiCad reads it from here.
      zones_allow_external_fillets: rules.zonesAllowExternalFillets,
      rules: {
        ...existingRules,
        min_clearance: rules.minClearance,
        min_track_width: rules.minTrackWidth,
        min_connection: rules.minConnectionWidth,
        min_via_annular_width: rules.minViaAnnularWidth,
        min_via_diameter: rules.minViaDiameter,
        min_hole_clearance: rules.minCopperHoleClearance,
        min_copper_edge_clearance: rules.minCopperEdgeClearance,
        min_through_hole_diameter: rules.minThroughHoleDiameter,
        min_hole_to_hole: rules.minHoleToHole,
        min_microvia_diameter: rules.minMicroviaDiameter,
        min_microvia_drill: rules.minMicroviaDrill,
        min_silk_clearance: rules.minSilkClearance,
        min_text_height: rules.minTextHeight,
        min_text_thickness: rules.minTextThickness,
        max_error: rules.maxError,
        min_resolved_spokes: rules.minResolvedSpokes,
        use_height_for_length_calcs: rules.useHeightForLengthCalcs
      }
    }
  }

  if (settings.extraSizes) {
    const ds = (root.board as Record<string, unknown>).design_settings as Record<string, unknown>
    const { tracks, vias } = settings.extraSizes
    // KiCad leads each list with a zero entry, its "use the net class" slot.
    if (tracks.length > 0 || 'track_widths' in ds)
      ds.track_widths = tracks.length > 0 ? [0, ...tracks] : []
    if (vias.length > 0 || 'via_dimensions' in ds)
      ds.via_dimensions = vias.length > 0 ? [{ diameter: 0, drill: 0 }, ...vias] : []
  }

  const netSettings = isRecord(root.net_settings) ? root.net_settings : {}
  const existing = Array.isArray(netSettings.classes) ? netSettings.classes.filter(isRecord) : []
  const byName = new Map(existing.map((entry) => [str(entry.name), entry]))

  // Highest priority number = lowest precedence, and KiCad parks Default at
  // INT_MAX so every other class outranks it. A class we did not read in keeps
  // whatever priority the file gave it; a new one slots in below the existing
  // custom classes rather than silently outranking them.
  const takenPriorities = existing
    .map((entry) => (typeof entry.priority === 'number' ? entry.priority : -1))
    .filter((p) => p >= 0 && p !== DEFAULT_CLASS_PRIORITY)
  let nextPriority = takenPriorities.length ? Math.max(...takenPriorities) + 1 : 0

  const patchedClasses = classes.map((netClass) => {
    const previous = byName.get(netClass.name)
    const priority =
      netClass.name === DEFAULT_CLASS_NAME
        ? DEFAULT_CLASS_PRIORITY
        : typeof previous?.priority === 'number'
          ? previous.priority
          : nextPriority++
    return {
      // Everything this editor does not touch — schematic wire/bus width, line
      // style, both colors, tuning profile — survives on a class we already
      // knew about. A class the user just added has no history to preserve.
      ...(previous ?? {}),
      name: netClass.name,
      clearance: netClass.clearance,
      track_width: netClass.trackWidth,
      via_diameter: netClass.viaDiameter,
      via_drill: netClass.viaDrill,
      microvia_diameter: netClass.microviaDiameter,
      microvia_drill: netClass.microviaDrill,
      diff_pair_width: netClass.diffPairWidth,
      diff_pair_gap: netClass.diffPairGap,
      // Written where the file had one or the class has one now, in KiCad's spelling.
      ...(netClass.pcbColor || previous?.pcb_color !== undefined
        ? { pcb_color: cssColor(netClass.pcbColor ?? null) }
        : {}),
      ...(netClass.schematicColor || previous?.schematic_color !== undefined
        ? { schematic_color: cssColor(netClass.schematicColor ?? null) }
        : {}),
      ...(netClass.wireWidth !== undefined
        ? { wire_width: mmToSpacing(netClass.wireWidth, 'mil') }
        : {}),
      ...(netClass.busWidth !== undefined
        ? { bus_width: mmToSpacing(netClass.busWidth, 'mil') }
        : {}),
      ...(netClass.lineStyle !== undefined
        ? { line_style: CLASS_LINE_STYLES.indexOf(netClass.lineStyle) }
        : {}),
      // KiCad writes an empty name for none.
      ...(netClass.tuningProfile || previous?.tuning_profile !== undefined
        ? { tuning_profile: netClass.tuningProfile ?? '' }
        : {}),
      priority
    }
  })
  // A field the class leaves to another stays unset, or a save would pin it.
  classes.forEach((netClass, i) => {
    const entry = patchedClasses[i] as Record<string, unknown>
    for (const field of netClass.unset ?? []) delete entry[NET_CLASS_KEYS[field]]
    // Cleared on a class other than Default: it inherits again.
    if (netClass.name !== DEFAULT_CLASS_NAME) {
      if (netClass.wireWidth === undefined) delete entry.wire_width
      if (netClass.busWidth === undefined) delete entry.bus_width
      if (netClass.lineStyle === undefined) delete entry.line_style
    }
  })

  root.net_settings = {
    // net_colors and meta are KiCad's, and netclass_assignments the schematic's
    // (patchNetclassAssignments), so they ride through on the spread.
    ...netSettings,
    classes: patchedClasses,
    netclass_patterns: patterns.map((p) => ({ netclass: p.netClass, pattern: p.pattern }))
  }

  return `${JSON.stringify(root, null, 2)}\n`
}

interface DirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
}

const isDirectoryEntry = (value: unknown): value is DirectoryEntry =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  typeof value.path === 'string' &&
  typeof value.isDirectory === 'boolean'

/**
 * Locate the project file for a document (schematic or board): prefer the
 * matching basename, else a single .kicad_pro in the same directory. Null for
 * standalone documents — a loose board has no project, and so no design rules.
 */
export async function findProjectFile(documentPath: string): Promise<string | null> {
  const separatorIndex = Math.max(documentPath.lastIndexOf('/'), documentPath.lastIndexOf('\\'))
  if (separatorIndex <= 0) return null
  const dir = documentPath.slice(0, separatorIndex)
  const separator = documentPath[separatorIndex]
  const stem = documentPath.slice(separatorIndex + 1).replace(/\.kicad_[a-z]+$/i, '')

  const preferred = `${dir}${separator}${stem}.kicad_pro`
  const preferredRead = await window.api.readFile(preferred)
  if (preferredRead.success) return preferred

  const entries = await window.api.readDirectory(dir)
  const candidates = entries
    .filter(isDirectoryEntry)
    .filter((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith('.kicad_pro'))
  return candidates.length === 1 ? candidates[0].path : null
}

export async function readProjectBomSettings(projectPath: string): Promise<BomSettings | null> {
  const result = await window.api.readFile(projectPath)
  if (!result.success || result.content === undefined) return null
  return extractBomSettings(result.content)
}

export async function readProjectConnectionGrid(projectPath: string): Promise<Nm | null> {
  const result = await window.api.readFile(projectPath)
  if (!result.success || result.content === undefined) return null
  return extractConnectionGrid(result.content)
}

/**
 * Patch bom_settings into an existing project file. Re-reads the file fresh
 * so concurrent external edits aren't clobbered; never creates a missing file.
 */
export async function writeProjectBomSettings(
  projectPath: string,
  settings: BomSettings
): Promise<boolean> {
  const current = await window.api.readFile(projectPath)
  if (!current.success || current.content === undefined) return false
  const patched = patchBomSettings(current.content, settings)
  if (patched === null) return false
  const written = await window.api.createFile(projectPath, patched)
  return written.success
}

export async function readProjectRuleSeverities(
  projectPath: string,
  scope: SeverityScope
): Promise<SeverityMap | null> {
  const result = await window.api.readFile(projectPath)
  if (!result.success || result.content === undefined) return null
  return extractRuleSeverities(result.content, scope)
}

/** Patch rule severities into an existing project file, re-read fresh; never creates one. */
export async function writeProjectRuleSeverities(
  projectPath: string,
  scope: SeverityScope,
  changes: SeverityMap
): Promise<boolean> {
  const current = await window.api.readFile(projectPath)
  if (!current.success || current.content === undefined) return false
  const patched = patchRuleSeverities(current.content, scope, changes)
  if (patched === null) return false
  const written = await window.api.createFile(projectPath, patched)
  return written.success
}

/**
 * The Board Setup presets a user picked: a manufacturing profile and a stackup
 * build, by id, or null for Custom. A label for the user's intent, never a
 * source of values: the board keeps its own numbers, so a preset whose shipped
 * values change in an update leaves the board as it was (shown as edited).
 */
export interface BoardSetupChoice {
  profile: string | null
  stackup: string | null
}

/**
 * GoatCAD's own top-level key in the `.kicad_pro`. KiCad keeps keys it does not
 * know when it saves (`JSON_SETTINGS::SaveToFile` merges the file it loaded).
 */
const GOATCAD_KEY = 'goatcad'

/** The stored choice; Custom (null) for whatever is missing or malformed. */
export function extractBoardSetupChoice(root: Record<string, unknown>): BoardSetupChoice {
  const own = isRecord(root[GOATCAD_KEY]) ? root[GOATCAD_KEY] : {}
  const setup = isRecord(own.board_setup) ? own.board_setup : {}
  const id = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
  return { profile: id(setup.manufacturing_profile), stackup: id(setup.stackup_preset) }
}

/** Write the choice's given halves, a null removing its key; every other key untouched. */
export function patchBoardSetupChoice(
  projectJsonText: string,
  choice: Partial<BoardSetupChoice>
): string | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  const own = isRecord(root[GOATCAD_KEY]) ? { ...root[GOATCAD_KEY] } : {}
  const setup: Record<string, unknown> = isRecord(own.board_setup) ? { ...own.board_setup } : {}
  const put = (key: string, value: string | null | undefined): void => {
    if (value === undefined) return
    if (value === null) delete setup[key]
    else setup[key] = value
  }
  put('manufacturing_profile', choice.profile)
  put('stackup_preset', choice.stackup)
  if (Object.keys(setup).length) own.board_setup = setup
  else delete own.board_setup
  if (Object.keys(own).length) root[GOATCAD_KEY] = own
  else delete root[GOATCAD_KEY]
  return `${JSON.stringify(root, null, 2)}\n`
}

/** Store the choice in an existing project file, re-read fresh; never creates one. */
export async function writeProjectBoardSetupChoice(
  projectPath: string,
  choice: Partial<BoardSetupChoice>
): Promise<boolean> {
  const current = await window.api.readFile(projectPath)
  if (!current.success || current.content === undefined) return false
  const patched = patchBoardSetupChoice(current.content, choice)
  if (patched === null) return false
  if (patched === current.content) return true
  const written = await window.api.createFile(projectPath, patched)
  return written.success
}

export async function readProjectDesignSettings(
  projectPath: string
): Promise<BoardDesignSettings | null> {
  const result = await window.api.readFile(projectPath)
  if (!result.success || result.content === undefined) return null
  const settings = extractDesignSettings(result.content)
  if (!settings) return null
  const rules = await window.api.readFile(customRulesPath(projectPath))
  if (rules.success && rules.content !== undefined) settings.customRules = rules.content
  return settings
}

/** Where a project keeps its custom rules: `<project>.kicad_dru`, beside the `.kicad_pro`. */
export const customRulesPath = (projectPath: string): string =>
  projectPath.replace(/\.kicad_pro$/, '.kicad_dru')

/**
 * Patch design rules into an existing project file. Re-reads fresh so
 * concurrent external edits aren't clobbered; never creates a missing file
 * (a project-less board has nowhere to persist rules — the caller decides
 * whether to offer creating a project).
 */
export async function writeProjectDesignSettings(
  projectPath: string,
  settings: WritableDesignSettings,
  /** The presets picked with these settings, written in the same pass. */
  choice?: Partial<BoardSetupChoice>
): Promise<boolean> {
  const current = await window.api.readFile(projectPath)
  if (!current.success || current.content === undefined) return false
  const design = patchDesignSettings(current.content, settings)
  const patched = design !== null && choice ? patchBoardSetupChoice(design, choice) : design
  if (patched === null) return false
  const written = await window.api.createFile(projectPath, patched)
  return written.success
}

/** A copper layer's KiCad 10 id (`PCB_LAYER_ID`), as `board.layer_pairs` names it: F.Cu 0, B.Cu 2, In<n> 2 + 2n. */
const copperLayerId = (name: string): number | null => {
  if (name === 'F.Cu') return 0
  if (name === 'B.Cu') return 2
  const inner = /^In(\d+)\.Cu$/.exec(name)
  return inner ? 2 + 2 * Number(inner[1]) : null
}

const copperLayerName = (id: number): string | null => {
  if (id === 0) return 'F.Cu'
  if (id === 2) return 'B.Cu'
  return Number.isInteger(id) && id >= 4 && id % 2 === 0 ? `In${(id - 2) / 2}.Cu` : null
}

/** A layer pair the project keeps (`board.layer_pairs`, KiCad's Set Layer Pair presets). */
export interface ProjectLayerPair {
  top: string
  bottom: string
  enabled: boolean
  name?: string
}

/** The project's layer pair presets; null for malformed JSON, [] when it has none. */
export function extractLayerPairs(projectJsonText: string): ProjectLayerPair[] | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  const pairs = isRecord(root.board) ? root.board.layer_pairs : undefined
  if (!Array.isArray(pairs)) return []
  const out: ProjectLayerPair[] = []
  for (const entry of pairs) {
    if (!isRecord(entry)) continue
    const top = typeof entry.topLayer === 'number' ? copperLayerName(entry.topLayer) : null
    const bottom = typeof entry.bottomLayer === 'number' ? copperLayerName(entry.bottomLayer) : null
    if (!top || !bottom) continue
    out.push({
      top,
      bottom,
      enabled: entry.enabled !== false,
      ...(typeof entry.name === 'string' ? { name: entry.name } : {})
    })
  }
  return out
}

/** Replace `board.layer_pairs`, as KiCad writes it, leaving every other key untouched. */
export function patchLayerPairs(
  projectJsonText: string,
  pairs: readonly ProjectLayerPair[]
): string | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  const board = isRecord(root.board) ? root.board : {}
  const written = pairs.flatMap((p) => {
    const top = copperLayerId(p.top)
    const bottom = copperLayerId(p.bottom)
    if (top === null || bottom === null) return []
    // KiCad's JSON keeps its keys sorted.
    return [
      {
        bottomLayer: bottom,
        enabled: p.enabled,
        ...(p.name ? { name: p.name } : {}),
        topLayer: top
      }
    ]
  })
  root.board = { ...board, layer_pairs: written }
  return `${JSON.stringify(root, null, 2)}\n`
}

/** Read the project's layer pair presets; [] when there is no project or none are kept. */
export async function readProjectLayerPairs(projectPath: string): Promise<ProjectLayerPair[]> {
  const current = await window.api.readFile(projectPath)
  if (!current.success || current.content === undefined) return []
  return extractLayerPairs(current.content) ?? []
}

/** Write the project's layer pair presets, re-reading it fresh first as `writeProjectDesignSettings` does. */
export async function writeProjectLayerPairs(
  projectPath: string,
  pairs: readonly ProjectLayerPair[]
): Promise<boolean> {
  const current = await window.api.readFile(projectPath)
  if (!current.success || current.content === undefined) return false
  const patched = patchLayerPairs(current.content, pairs)
  if (patched === null) return false
  const written = await window.api.createFile(projectPath, patched)
  return written.success
}

/**
 * One length tuner's meander defaults, mm (`board.design_settings.tuning_pattern_settings`,
 * KiCad's `MEANDER_SETTINGS` as `BOARD_DESIGN_SETTINGS` saves it).
 */
export interface TuningPatternDefaults {
  minAmplitude: number
  maxAmplitude: number
  spacing: number
  cornerRadiusPercent: number
  singleSided: boolean
}

/** The three tuners' defaults, each saved under its own key as KiCad keeps them (T6). */
export interface TuningPatternSettings {
  single: TuningPatternDefaults
  pair: TuningPatternDefaults
  skew: TuningPatternDefaults
}

/** A missing key reads as KiCad's `MEANDER_SETTINGS` constructor leaves it. */
const MEANDER_CONSTRUCTED: TuningPatternDefaults = {
  minAmplitude: 0.2,
  maxAmplitude: 1,
  spacing: 0.6,
  cornerRadiusPercent: 80,
  singleSided: false
}

/**
 * KiCad's defaults for a project that saves none (`BOARD_DESIGN_SETTINGS`):
 * a pair's spacing is `DEFAULT_DP_MEANDER_SPACING`, the others `DEFAULT_MEANDER_SPACING`.
 */
export const DEFAULT_TUNING_PATTERN_SETTINGS: TuningPatternSettings = {
  single: { ...MEANDER_CONSTRUCTED },
  pair: { ...MEANDER_CONSTRUCTED, spacing: 1 },
  skew: { ...MEANDER_CONSTRUCTED }
}

const TUNING_KEYS: Readonly<Record<keyof TuningPatternSettings, string>> = {
  single: 'single_track_defaults',
  pair: 'diff_pair_defaults',
  skew: 'diff_pair_skew_defaults'
}

/** The project's tuner defaults; null for malformed JSON, KiCad's defaults where it saves none. */
export function extractTuningPatternSettings(
  projectJsonText: string
): TuningPatternSettings | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  const board = isRecord(root.board) ? root.board : {}
  const ds = isRecord(board.design_settings) ? board.design_settings : {}
  const saved = isRecord(ds.tuning_pattern_settings) ? ds.tuning_pattern_settings : {}
  const read = (mode: keyof TuningPatternSettings): TuningPatternDefaults => {
    const entry = saved[TUNING_KEYS[mode]]
    if (!isRecord(entry)) return { ...DEFAULT_TUNING_PATTERN_SETTINGS[mode] }
    const d = MEANDER_CONSTRUCTED
    return {
      minAmplitude: num(entry.min_amplitude, d.minAmplitude),
      maxAmplitude: num(entry.max_amplitude, d.maxAmplitude),
      spacing: num(entry.spacing, d.spacing),
      cornerRadiusPercent: num(entry.corner_radius_percentage, d.cornerRadiusPercent),
      singleSided: bool(entry.single_sided, d.singleSided)
    }
  }
  return { single: read('single'), pair: read('pair'), skew: read('skew') }
}

/**
 * Write the tuners' defaults as KiCad does, all three, leaving every other key
 * alone. A saved entry keeps the keys this does not model (`corner_style`);
 * a new one is written whole, round-cornered, its keys sorted as KiCad's JSON is.
 */
export function patchTuningPatternSettings(
  projectJsonText: string,
  settings: TuningPatternSettings
): string | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  const board = isRecord(root.board) ? root.board : {}
  const ds = isRecord(board.design_settings) ? board.design_settings : {}
  const saved = isRecord(ds.tuning_pattern_settings) ? ds.tuning_pattern_settings : {}
  const written: Record<string, unknown> = { ...saved }
  for (const mode of ['single', 'pair', 'skew'] as const) {
    const key = TUNING_KEYS[mode]
    const s = settings[mode]
    const previous = isRecord(saved[key]) ? saved[key] : null
    written[key] = {
      ...(previous ?? {}),
      corner_radius_percentage: Math.round(s.cornerRadiusPercent),
      ...(previous && 'corner_style' in previous ? {} : { corner_style: 1 }),
      max_amplitude: s.maxAmplitude,
      min_amplitude: s.minAmplitude,
      single_sided: s.singleSided,
      spacing: s.spacing
    }
  }
  root.board = { ...board, design_settings: { ...ds, tuning_pattern_settings: written } }
  return `${JSON.stringify(root, null, 2)}\n`
}

export async function readProjectTuningPatternSettings(
  projectPath: string
): Promise<TuningPatternSettings | null> {
  const current = await window.api.readFile(projectPath)
  if (!current.success || current.content === undefined) return null
  return extractTuningPatternSettings(current.content)
}

/** Write the tuners' defaults, re-reading the project fresh first as `writeProjectDesignSettings` does. */
export async function writeProjectTuningPatternSettings(
  projectPath: string,
  settings: TuningPatternSettings
): Promise<boolean> {
  const current = await window.api.readFile(projectPath)
  if (!current.success || current.content === undefined) return false
  const patched = patchTuningPatternSettings(current.content, settings)
  if (patched === null) return false
  const written = await window.api.createFile(projectPath, patched)
  return written.success
}

/**
 * Write the tuning profiles whole, as KiCad 10's `TUNING_PROFILES` saves them
 * (common/project/tuning_profiles.cpp): widths and gaps in nanometers, a missing
 * reference as `UNDEFINED`, keys sorted as its JSON is. A profile already saved
 * keeps the keys this does not model, matched by name; every other key of the
 * project stays as it was. With no profiles and none saved, the file is left as is.
 */
export function patchTuningProfiles(
  projectJsonText: string,
  profiles: readonly TuningProfile[]
): string | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  const tuning = isRecord(root.tuning_profiles) ? root.tuning_profiles : null
  if (!tuning && !profiles.length) return projectJsonText
  const saved = Array.isArray(tuning?.tuning_profiles_impedance_geometric)
    ? tuning.tuning_profiles_impedance_geometric.filter(isRecord)
    : []
  const byName = new Map(saved.map((entry) => [str(entry.profile_name), entry]))
  const layer = (name: string): string => name || 'UNDEFINED'
  const written = profiles.map((profile) => ({
    ...(byName.get(profile.name) ?? {}),
    enable_time_domain_tuning: profile.timeDomain,
    layer_entries: profile.layers.map((entry) => ({
      bottom_reference_layer: layer(entry.bottomReference),
      delay: Math.round(entry.delay),
      diff_pair_gap: mmToNm(entry.gap),
      signal_layer: entry.layer,
      top_reference_layer: layer(entry.topReference),
      width: mmToNm(entry.width)
    })),
    profile_name: profile.name,
    target_impedance: profile.targetImpedance,
    type: profile.differential ? 1 : 0,
    via_overrides: profile.overrides.map((o) => ({
      delay: Math.round(o.delay),
      signal_layer_from: o.signalFrom,
      signal_layer_to: o.signalTo,
      via_layer_from: o.viaFrom,
      via_layer_to: o.viaTo
    })),
    via_prop_delay: Math.round(profile.viaDelay)
  }))
  root.tuning_profiles = {
    meta: { version: 0 },
    ...(tuning ?? {}),
    tuning_profiles_impedance_geometric: written
  }
  return `${JSON.stringify(root, null, 2)}\n`
}

/** Write the tuning profiles, re-reading the project fresh first as `writeProjectDesignSettings` does. */
export async function writeProjectTuningProfiles(
  projectPath: string,
  profiles: readonly TuningProfile[]
): Promise<boolean> {
  const current = await window.api.readFile(projectPath)
  if (!current.success || current.content === undefined) return false
  const patched = patchTuningProfiles(current.content, profiles)
  if (patched === null) return false
  if (patched === current.content) return true
  const written = await window.api.createFile(projectPath, patched)
  return written.success
}

/** The schematic hierarchy as a project file records it. */
export interface ProjectHierarchy {
  /** The root schematic's file name, relative to the project. */
  rootFile: string
  rootUuid: string
  /** The root's display name: the project's name. */
  rootName: string
  /** Every sheet below the root, in hierarchy order: its uuid and its name. */
  sheets: Array<[uuid: string, name: string]>
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Add the keys `defaults` has and `target` lacks, recursing into objects both
 * have; a key the project sets is never touched. An object that gained a key
 * is re-sorted, as KiCad writes its keys.
 */
function fillDefaults(target: Record<string, unknown>, defaults: Record<string, unknown>): void {
  let added = false
  for (const [key, value] of Object.entries(defaults)) {
    const existing = target[key]
    if (existing === undefined) {
      target[key] = structuredClone(value)
      added = true
    } else if (isRecord(existing) && isRecord(value)) {
      fillDefaults(existing, value)
    }
  }
  if (!added) return
  const sorted = Object.keys(target).sort()
  const entries = sorted.map((key) => [key, target[key]] as const)
  for (const key of sorted) delete target[key]
  for (const [key, value] of entries) target[key] = value
}

/**
 * A project file as KiCad 10's first save leaves it: the `erc` and
 * `schematic` sections filled where they lack a key, and — given the
 * schematic's hierarchy — the sheet list and the root's entry in
 * `top_level_sheets`, which KiCad writes as a placeholder until its schematic
 * editor has saved. Null for malformed input, which is never overwritten.
 */
export function migrateProjectFile(
  projectJsonText: string,
  hierarchy: ProjectHierarchy | null
): string | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  const section = (key: string): Record<string, unknown> => {
    if (!isRecord(root[key])) (root as Record<string, unknown>)[key] = {}
    return (root as Record<string, Record<string, unknown>>)[key]
  }
  fillDefaults(root, { erc: {}, schematic: {} })
  fillDefaults(section('erc'), KICAD10_ERC_DEFAULTS)
  fillDefaults(section('schematic'), KICAD10_SCHEMATIC_DEFAULTS)
  if (hierarchy) {
    root.sheets = [[hierarchy.rootUuid, hierarchy.rootName], ...hierarchy.sheets]
    const schematic = section('schematic')
    const topLevel = Array.isArray(schematic.top_level_sheets) ? schematic.top_level_sheets : []
    const entry = topLevel.find(
      (sheet): sheet is Record<string, unknown> =>
        isRecord(sheet) && sheet.filename === hierarchy.rootFile
    )
    if (!entry) {
      topLevel.push({
        filename: hierarchy.rootFile,
        name: hierarchy.rootName,
        uuid: hierarchy.rootUuid
      })
    } else if (entry.uuid === NIL_UUID || entry.uuid === undefined) {
      entry.uuid = hierarchy.rootUuid
    }
    schematic.top_level_sheets = topLevel
  }
  return `${JSON.stringify(root, null, 2)}\n`
}

/** The project's bus aliases (`schematic.bus_aliases`, KiCad 9+), by name; null when it has none. */
export function extractBusAliases(projectJsonText: string): Record<string, string[]> | null {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return null
  }
  if (!isRecord(root) || !isRecord(root.schematic) || !isRecord(root.schematic.bus_aliases)) {
    return null
  }
  const out: Record<string, string[]> = {}
  for (const [name, members] of Object.entries(root.schematic.bus_aliases)) {
    if (Array.isArray(members)) {
      out[name] = members.filter((member): member is string => typeof member === 'string')
    }
  }
  return out
}
