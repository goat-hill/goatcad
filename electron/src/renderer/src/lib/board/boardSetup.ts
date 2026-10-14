/**
 * Board and Schematic Setup as records an agent reads and writes: the pages'
 * sections — stackup, general, constraints, net classes, severities, profile,
 * exclusions — in their own shape, in millimeters.
 *
 * Pure. A read builds the records from the board and the project's settings;
 * an update is planned here, against the same model functions the Board Setup
 * page edits through (`boardSetupSchema.ts`), and the caller lands the board
 * half as one command and the project half as one write of the `.kicad_pro`
 * (`patchDesignSettings`, `patchRuleSeverities`), as the page does.
 */
import type { KicadBoard, StackupSpec } from '../kicad/board'
import {
  DEFAULT_TEARDROP_SETTINGS,
  type TeardropParams,
  type TeardropSettings
} from './teardrop/params'
import { nmToMm, mmToNm, type Nm } from '../kicad/coordinates'
import {
  DEFAULT_CLASS_NAME,
  DEFAULT_TUNING_PATTERN_SETTINGS,
  type BoardDesignSettings,
  type BoardSetupChoice,
  type DesignRules,
  type NetClass,
  type NetClassField,
  type NetClassPattern,
  type TuningProfile,
  type TuningProfileLayer
} from '../kicad/project'
import {
  AS_PER_PS,
  addTuningProfile,
  applyLayerSolve,
  editTuningProfile,
  removeTuningProfile,
  solveProfileRow
} from './tuningProfiles'
import { solverStackupOf, type SolverStackup } from './impedance'
import {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_ID,
  allStackupPresets,
  defaultStackupOf,
  findProfile,
  findStackupPreset,
  matchesProfile,
  type ManufacturingProfile
} from '../manufacturingProfiles'
import { findAnyProfile, findAnyStackupPreset } from './userSetupPresets'
import {
  COPPER_FINISHES,
  MASK_COLORS,
  SILK_COLORS,
  addNetClass,
  editNetClass,
  nearestCopperLayerCount,
  removeNetClass,
  TUNING_FIELDS,
  TUNING_MODES,
  applyBoardSetupEdit,
  copperNamesFor,
  type BoardSetupModel,
  type NetClassColumn
} from './boardSetupSchema'
import {
  RULE_SEVERITIES,
  effectiveSeverity,
  isChecked,
  isRuleSeverity,
  type CatalogRule,
  type RuleSeverity,
  type SeverityMap
} from '../ruleSeverity'
import { exclusionMatches, type KicadExclusion } from '../kicadExclusions'
import type { CheckResult } from '../schematic/checks'
import { assignableNets, netCoverage } from './netClassCoverage'
import { netsInUse } from './boardSync'
import { planStackupEdits, stackupLayerRecord, type StackupEditPlan } from './stackupEdits'

/** KiCad's page sizes (`PAGE_INFO`); a custom page is not offered. */
export const PAPER_SIZES = [
  'A5',
  'A4',
  'A3',
  'A2',
  'A1',
  'A0',
  'A',
  'B',
  'C',
  'D',
  'E',
  'GERBER',
  'USLetter',
  'USLegal',
  'USLedger'
] as const

export const BOARD_SETUP_SECTIONS = [
  'stackup',
  'general',
  'constraints',
  'tuningPatterns',
  'teardrops',
  'tuningProfiles',
  'netClasses',
  'severities',
  'profile',
  'exclusions'
] as const

export type BoardSetupSection = (typeof BOARD_SETUP_SECTIONS)[number]

export const SCHEMATIC_SETUP_SECTIONS = ['severities', 'exclusions'] as const

export type SchematicSetupSection = (typeof SCHEMATIC_SETUP_SECTIONS)[number]

const mm = (value: Nm | number): number => Math.round(nmToMm(value as Nm) * 1e6) / 1e6

/**
 * The stackup as the Board Setup form holds it, read back from the board's
 * rows: what a regenerated stackup starts from, so a change to one field keeps
 * the rest. Rows are nanometers; the spec is millimeters.
 */
export function stackupSpecOf(board: KicadBoard | null): StackupSpec {
  const layers = board?.stackup?.layers ?? []
  const copper = layers.filter((layer) => layer.type === 'copper')
  const dielectrics = layers.filter((layer) => layer.name.startsWith('dielectric'))
  const core = dielectrics.find((layer) => layer.type === 'core') ?? dielectrics[0]
  const prepreg = dielectrics.find((layer) => layer.type === 'prepreg')
  const outer = copper[0]
  const inner = copper.length > 2 ? copper[1] : undefined
  const fallback = defaultStackupOf(findProfile(DEFAULT_PROFILE_ID)!)
  const boardCopper = board?.layers.filter((layer) => layer.name.endsWith('.Cu')).length ?? 0
  return {
    copperLayers: nearestCopperLayerCount(copper.length || boardCopper || fallback.copperLayers),
    boardThickness: board?.thickness !== undefined ? mm(board.thickness) : fallback.boardThickness,
    copperThickness:
      outer?.thickness !== undefined ? mm(outer.thickness) : fallback.copperThickness,
    ...(inner?.thickness !== undefined ? { innerCopperThickness: mm(inner.thickness) } : {}),
    ...(prepreg?.thickness !== undefined ? { prepregThickness: mm(prepreg.thickness) } : {}),
    ...(prepreg?.epsilonR !== undefined && prepreg.epsilonR !== core?.epsilonR
      ? { prepregEpsilonR: prepreg.epsilonR }
      : {}),
    dielectricMaterial: core?.material ?? fallback.dielectricMaterial,
    epsilonR: core?.epsilonR ?? fallback.epsilonR,
    lossTangent: core?.lossTangent ?? fallback.lossTangent,
    ...(layers.find((l) => l.name === 'F.Mask')?.color
      ? { maskColor: layers.find((l) => l.name === 'F.Mask')!.color }
      : {}),
    ...(layers.find((l) => l.name === 'F.SilkS')?.color
      ? { silkColor: layers.find((l) => l.name === 'F.SilkS')!.color }
      : {}),
    ...(board?.stackup?.copperFinish ? { copperFinish: board.stackup.copperFinish } : {})
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const point = (p: { x: Nm; y: Nm } | undefined): { x: number; y: number } =>
  p ? { x: mm(p.x), y: mm(p.y) } : { x: 0, y: 0 }

const NET_CLASS_FIELDS: readonly NetClassField[] = [
  'clearance',
  'trackWidth',
  'viaDiameter',
  'viaDrill',
  'microviaDiameter',
  'microviaDrill',
  'diffPairWidth',
  'diffPairGap'
]

const classRecord = (netClass: NetClass): Record<string, unknown> => ({
  name: netClass.name,
  ...Object.fromEntries(NET_CLASS_FIELDS.map((field) => [field, netClass[field]])),
  ...(netClass.priority !== undefined && netClass.name !== DEFAULT_CLASS_NAME
    ? { priority: netClass.priority }
    : {}),
  ...(netClass.unset?.length ? { inherits: netClass.unset } : {}),
  ...(netClass.tuningProfile ? { tuningProfile: netClass.tuningProfile } : {})
})

/** A tuning profile as `board_get_setup` answers and `board_update_setup` takes it: mm, ps/mm. */
export const tuningProfileRecord = (profile: TuningProfile): Record<string, unknown> => ({
  name: profile.name,
  type: profile.differential ? 'differential' : 'single',
  targetImpedance: profile.targetImpedance,
  timeDomain: profile.timeDomain,
  viaDelay: profile.viaDelay / AS_PER_PS,
  layers: profile.layers.map((l) => ({
    layer: l.layer,
    topReference: l.topReference,
    bottomReference: l.bottomReference,
    width: l.width,
    ...(profile.differential ? { gap: l.gap } : {}),
    delay: l.delay / AS_PER_PS
  })),
  ...(profile.overrides.length ? { viaOverrides: profile.overrides.length } : {})
})

/** Each rule's severity in the project, the ones it changed, and the ones not checked yet. */
export function severitiesRecord(
  catalog: readonly CatalogRule[],
  severities: SeverityMap
): Record<string, unknown> {
  return {
    rules: Object.fromEntries(
      catalog.map((rule) => [rule.key, effectiveSeverity(rule, severities)])
    ),
    changed: catalog
      .filter((rule) => severities[rule.key] && severities[rule.key] !== rule.severity)
      .map((rule) => rule.key),
    notChecked: catalog.filter((rule) => !isChecked(rule)).map((rule) => rule.key)
  }
}

/**
 * Findings counted by severity: what a severity change moves, which the check
 * delta (new and resolved findings, by rule and items) cannot show.
 */
export const severityCounts = (
  results: readonly CheckResult[]
): { errors: number; warnings: number } => ({
  errors: results.filter((result) => result.severity === 'error').length,
  warnings: results.filter((result) => result.severity === 'warning').length
})

/** The project's exclusions, each with how many of the current findings it hides. */
export function exclusionsRecord(
  exclusions: readonly KicadExclusion[],
  results: readonly CheckResult[] | null
): Array<Record<string, unknown>> {
  const hides = results ? exclusionMatches(results) : null
  return exclusions.map((exclusion) => ({
    rule: exclusion.key,
    items: exclusion.ids,
    ...(exclusion.comment ? { comment: exclusion.comment } : {}),
    ...(hides ? { hides: hides.get(exclusion.raw) ?? 0 } : {})
  }))
}

export interface BoardSetupInput {
  board: KicadBoard
  settings: BoardDesignSettings
  catalog: readonly CatalogRule[]
  /** The ranked findings, excluded ones marked, for how many each exclusion hides. */
  results: readonly CheckResult[] | null
  /** Whether a project file holds the project-half settings. */
  hasProject: boolean
}

/** Nets listed per `matched` row; a longer row says truncated beside its whole count. */
export const MATCHED_NETS_CAP = 100

/**
 * The nets each pattern takes and Default's (those no pattern or assignment
 * reaches), over the nets something on the board uses, as Board Setup's
 * assignment table counts them (`netCoverage`).
 * Read-only: an update takes the patterns, never their matches.
 */
const matchedNets = (
  board: KicadBoard,
  settings: BoardDesignSettings
): Array<Record<string, unknown>> => {
  const coverage = netCoverage(
    assignableNets(netsInUse(board)),
    settings.patterns,
    settings.assignments
  )
  const row = (nets: readonly string[]): Record<string, unknown> => ({
    count: nets.length,
    nets: nets.slice(0, MATCHED_NETS_CAP),
    ...(nets.length > MATCHED_NETS_CAP ? { truncated: true } : {})
  })
  return [
    ...settings.patterns.map((p, i) => ({
      pattern: p.pattern,
      netClass: p.netClass,
      ...row(coverage.matches[i])
    })),
    { netClass: DEFAULT_CLASS_NAME, ...row(coverage.unassigned) }
  ]
}

/** The sections asked for (all when none), as `update_setup` takes them back. */
export function boardSetupRecord(
  input: BoardSetupInput,
  sections: readonly BoardSetupSection[] = BOARD_SETUP_SECTIONS
): Record<string, unknown> {
  const { board, settings } = input
  const out: Record<string, unknown> = {}
  const want = new Set(sections)
  if (want.has('stackup')) {
    const spec = stackupSpecOf(board)
    out.stackup = {
      ...spec,
      layers: (board.stackup?.layers ?? []).map(stackupLayerRecord),
      presets: allStackupPresets().map((preset) => preset.id)
    }
  }
  if (want.has('general')) {
    out.general = {
      paper: board.paper ?? 'A4',
      gridOrigin: point(board.gridOrigin),
      drillOrigin: point(board.auxOrigin)
    }
  }
  if (want.has('constraints')) out.constraints = { ...settings.rules }
  if (want.has('tuningPatterns'))
    out.tuningPatterns = structuredClone(settings.tuningPatterns ?? DEFAULT_TUNING_PATTERN_SETTINGS)
  if (want.has('teardrops'))
    out.teardrops = teardropSetupRecord(settings.teardrops ?? DEFAULT_TEARDROP_SETTINGS)
  if (want.has('tuningProfiles'))
    out.tuningProfiles = (settings.tuning?.definitions ?? []).map(tuningProfileRecord)
  if (want.has('netClasses')) {
    out.netClasses = {
      classes: settings.classes.map(classRecord),
      patterns: settings.patterns.map((p) => ({ pattern: p.pattern, netClass: p.netClass })),
      ...(settings.assignments.length
        ? { assignments: settings.assignments.map((a) => ({ net: a.net, netClass: a.netClass })) }
        : {}),
      ...(settings.extraSizes ? { extraSizes: extraSizesRecord(settings.extraSizes) } : {}),
      matched: matchedNets(board, settings)
    }
  }
  if (want.has('severities'))
    out.severities = severitiesRecord(input.catalog, settings.severities ?? {})
  if (want.has('profile')) {
    // What the user picked, never inferred: a board can share a fab's numbers
    // without being built there.
    const active = settings.setupChoice?.profile
      ? findAnyProfile(settings.setupChoice.profile)
      : null
    const stackup = settings.setupChoice?.stackup ?? null
    out.profile = {
      active: active?.id ?? null,
      edited: active ? !matchesProfile(active, settings) : false,
      stackup: stackup && findAnyStackupPreset(stackup) ? stackup : null,
      available: BUILT_IN_PROFILES.map((profile) => ({
        id: profile.id,
        vendor: profile.vendor,
        tier: profile.tier
      }))
    }
  }
  if (want.has('exclusions'))
    out.exclusions = exclusionsRecord(settings.exclusions ?? [], input.results)
  if (!input.hasProject) out.noProject = true
  return out
}

// ---------------------------------------------------------------------------
// Planning an update
// ---------------------------------------------------------------------------

export type SetupFailure = {
  ok: false
  error: 'invalid-record' | 'not-applicable' | 'no-project-file'
  detail: string
  candidates?: string[]
}

const fail = (
  error: SetupFailure['error'],
  detail: string,
  candidates?: string[]
): SetupFailure => ({ ok: false, error, detail, ...(candidates?.length ? { candidates } : {}) })

type Rec = Record<string, unknown>

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What an update does, split the way it lands. */
export interface SetupPlan {
  /** The board half, one command: a regenerated stackup, the page, the origins. */
  board: {
    stackup?: StackupSpec
    /** Rows edited, removed and added in place, the rest kept (`stackupEdits.ts`). */
    stackupEdits?: StackupEditPlan
    paper?: string
    gridOrigin?: { x: Nm; y: Nm } | null
    drillOrigin?: { x: Nm; y: Nm } | null
  }
  /** The project half, one write: the rules and classes whole, the severities changed. */
  project: {
    design?: Pick<BoardDesignSettings, 'rules' | 'classes' | 'patterns' | 'extraSizes'>
    /** The length tuners' defaults, all three, as Board Setup writes them. */
    tuning?: BoardSetupModel['tuning']
    /** The teardrop defaults, every shape, as Board Setup writes them. */
    teardrops?: BoardSetupModel['teardrops']
    /** The tuning profiles whole, as Board Setup writes them. */
    tuningProfiles?: TuningProfile[]
    severities?: Record<string, RuleSeverity>
    /** The presets the update picks, stored as Board Setup stores them. */
    choice?: Partial<BoardSetupChoice>
  }
  /** Per section, what changed; and each changed value as it was, to put back. */
  changed: Record<string, unknown>
  before: Record<string, unknown>
}

const STACKUP_KEYS = [
  'preset',
  'copperLayers',
  'boardThickness',
  'copperThickness',
  'innerCopperThickness',
  'prepregThickness',
  'prepregEpsilonR',
  'dielectricMaterial',
  'epsilonR',
  'lossTangent',
  'maskColor',
  'silkColor',
  'copperFinish'
] as const

/** The stackup keys that edit rows in place rather than regenerate the build. */
const STACKUP_ROW_KEYS: readonly string[] = ['layers', 'addDielectric', 'removeLayers']

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

const extraKeys = (record: Rec, allowed: readonly string[]): string[] =>
  Object.keys(record).filter((key) => !allowed.includes(key))

/** The severities a record sets: every key a catalog rule, every value a severity. */
export function planSeverities(
  catalog: readonly CatalogRule[],
  current: SeverityMap,
  value: unknown
):
  | { ok: true; set: Record<string, RuleSeverity>; before: Record<string, RuleSeverity> }
  | SetupFailure {
  if (!isRecord(value))
    return fail(
      'invalid-record',
      'severities maps KiCad rule keys to "error", "warning" or "ignore".'
    )
  const set: Record<string, RuleSeverity> = {}
  const before: Record<string, RuleSeverity> = {}
  for (const [key, severity] of Object.entries(value)) {
    const rule = catalog.find((entry) => entry.key === key)
    if (!rule) {
      const lower = key.toLowerCase()
      return fail(
        'invalid-record',
        `No rule is keyed ${key}.`,
        catalog
          .map((entry) => entry.key)
          .filter((candidate) => candidate.includes(lower.split('_')[0] ?? lower))
          .slice(0, 8)
      )
    }
    if (!isRuleSeverity(severity))
      return fail('invalid-record', `severities.${key} is one of ${RULE_SEVERITIES.join(', ')}.`)
    if (rule.graded && severity !== 'ignore' && severity !== effectiveSeverity(rule, current))
      return fail(
        'not-applicable',
        `${key} grades each finding itself, so a project can only turn it off ("ignore") or back on.`
      )
    before[key] = effectiveSeverity(rule, current)
    set[key] = severity
  }
  return { ok: true, set, before }
}

const planStackup = (
  current: StackupSpec,
  value: unknown
): { ok: true; spec: StackupSpec } | SetupFailure => {
  if (!isRecord(value))
    return fail(
      'invalid-record',
      'stackup is a record: preset, or copperLayers, boardThickness and the rest; or layers, addDielectric and removeLayers.'
    )
  const extra = extraKeys(value, STACKUP_KEYS)
  if (extra.length)
    return fail(
      'not-applicable',
      `stackup does not carry ${extra.join(', ')}; it takes ${[...STACKUP_KEYS, ...STACKUP_ROW_KEYS].join(', ')}.`
    )
  let spec: StackupSpec = { ...current }
  if (value.preset !== undefined) {
    const preset = typeof value.preset === 'string' ? findStackupPreset(value.preset) : null
    if (!preset)
      return fail(
        'invalid-record',
        `No stackup preset is ${String(value.preset)}.`,
        allStackupPresets().map((p) => p.id)
      )
    spec = { ...preset.spec }
  }
  if (value.copperLayers !== undefined) {
    const count = value.copperLayers
    if (
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 2 ||
      count > 32 ||
      count % 2
    )
      return fail('invalid-record', 'copperLayers is an even count from 2 to 32.')
    spec.copperLayers = count
  }
  for (const key of [
    'boardThickness',
    'copperThickness',
    'innerCopperThickness',
    'prepregThickness',
    'prepregEpsilonR',
    'epsilonR'
  ] as const) {
    if (value[key] === undefined) continue
    if (!positive(value[key])) return fail('invalid-record', `${key} is a positive number.`)
    spec[key] = value[key] as number
  }
  if (value.lossTangent !== undefined) {
    if (typeof value.lossTangent !== 'number' || value.lossTangent < 0)
      return fail('invalid-record', 'lossTangent is a number, 0 or more.')
    spec.lossTangent = value.lossTangent
  }
  if (value.dielectricMaterial !== undefined) {
    if (typeof value.dielectricMaterial !== 'string' || !value.dielectricMaterial.trim())
      return fail('invalid-record', 'dielectricMaterial is a name, e.g. "FR4".')
    spec.dielectricMaterial = value.dielectricMaterial.trim()
  }
  const choice = (
    key: 'maskColor' | 'silkColor' | 'copperFinish',
    options: readonly string[]
  ): SetupFailure | null => {
    if (value[key] === undefined) return null
    if (typeof value[key] !== 'string' || !options.includes(value[key] as string))
      return fail('invalid-record', `${key} is one of ${options.join(', ')}.`, [...options])
    spec[key] = value[key] as string
    return null
  }
  const bad =
    choice('maskColor', MASK_COLORS) ??
    choice('silkColor', SILK_COLORS) ??
    choice('copperFinish', COPPER_FINISHES)
  if (bad) return bad
  return { ok: true, spec }
}

const planOrigin = (value: unknown, key: string): { x: Nm; y: Nm } | null | SetupFailure => {
  if (value === null) return null
  if (
    isRecord(value) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y)
  )
    return { x: mmToNm(value.x), y: mmToNm(value.y) }
  return fail('invalid-record', `${key} is a point {x, y} in mm, or null to reset it to 0,0.`)
}

const isFailure = (value: unknown): value is SetupFailure =>
  isRecord(value) && (value as SetupFailure).ok === false

const CONSTRAINT_KEYS = Object.keys({
  minClearance: 0,
  minTrackWidth: 0,
  minConnectionWidth: 0,
  minViaAnnularWidth: 0,
  minViaDiameter: 0,
  minCopperHoleClearance: 0,
  minCopperEdgeClearance: 0,
  minThroughHoleDiameter: 0,
  minHoleToHole: 0,
  minMicroviaDiameter: 0,
  minMicroviaDrill: 0,
  minSilkClearance: 0,
  minTextHeight: 0,
  minTextThickness: 0,
  maxError: 0,
  zonesAllowExternalFillets: false,
  minResolvedSpokes: 0,
  useHeightForLengthCalcs: false
} satisfies Record<keyof DesignRules, number | boolean>) as Array<keyof DesignRules>

const CLASS_KEYS = ['name', ...NET_CLASS_FIELDS, 'tuningProfile'] as const

const PROFILE_KEYS = [
  'name',
  'type',
  'targetImpedance',
  'timeDomain',
  'viaDelay',
  'layers',
  'solve'
] as const
const PROFILE_LAYER_KEYS = [
  'layer',
  'topReference',
  'bottomReference',
  'width',
  'gap',
  'delay'
] as const

/**
 * Tuning profile changes over the page's own edits: rename (carrying the
 * classes that name it), upsert by name (a given `layers` replaces the rows
 * whole), remove (clearing the classes that named it).
 */
const planTuningProfiles = (
  model: BoardSetupModel,
  value: unknown,
  copperLayers: readonly string[],
  stackup: SolverStackup
): { ok: true; model: BoardSetupModel; changed: Rec } | SetupFailure => {
  if (!isRecord(value))
    return fail('invalid-record', 'tuningProfiles takes upsert, rename and remove.')
  const extra = extraKeys(value, ['upsert', 'rename', 'remove'])
  if (extra.length)
    return fail(
      'not-applicable',
      `tuningProfiles does not carry ${extra.join(', ')}; it takes upsert, rename and remove.`
    )
  let next = model
  const changed: Rec = {}
  const indexOf = (name: string): number => next.tuningProfiles.findIndex((p) => p.name === name)
  const names = (): string[] => next.tuningProfiles.map((p) => p.name)

  if (value.rename !== undefined) {
    if (!Array.isArray(value.rename))
      return fail('invalid-record', 'rename is a list of {from, to}.')
    for (const entry of value.rename) {
      if (!isRecord(entry) || typeof entry.from !== 'string' || typeof entry.to !== 'string')
        return fail('invalid-record', 'Each rename is {from, to}, both profile names.')
      const index = indexOf(entry.from)
      if (index < 0)
        return fail('invalid-record', `No tuning profile is called ${entry.from}.`, names())
      if (!entry.to.trim() || indexOf(entry.to.trim()) >= 0)
        return fail('invalid-record', `${entry.to} is empty or already a profile's name.`)
      next = editTuningProfile(next, index, 'name', entry.to.trim())
    }
    changed.renamed = value.rename
  }
  if (value.upsert !== undefined) {
    if (!Array.isArray(value.upsert))
      return fail('invalid-record', 'upsert is a list of profiles by name.')
    const added: string[] = []
    const edited: string[] = []
    for (const entry of value.upsert) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim())
        return fail('invalid-record', 'Each upserted profile has a name.')
      const bad = extraKeys(entry, PROFILE_KEYS)
      if (bad.length)
        return fail(
          'not-applicable',
          `A tuning profile does not carry ${bad.join(', ')}; it takes ${PROFILE_KEYS.join(', ')}.`
        )
      const name = entry.name.trim()
      if (indexOf(name) < 0) {
        next = addTuningProfile(next, name)
        added.push(name)
      } else edited.push(name)
      const at = (): number => indexOf(name)
      if (entry.type !== undefined) {
        if (entry.type !== 'single' && entry.type !== 'differential')
          return fail('invalid-record', `${name}.type is single or differential.`)
        next = editTuningProfile(next, at(), 'differential', entry.type)
      }
      for (const key of ['targetImpedance', 'viaDelay'] as const) {
        const v = entry[key]
        if (v === undefined) continue
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
          return fail(
            'invalid-record',
            `${name}.${key} is ${key === 'viaDelay' ? 'ps/mm' : 'ohms'}, 0 or more.`
          )
        next = editTuningProfile(next, at(), key, v)
      }
      if (entry.timeDomain !== undefined) {
        if (typeof entry.timeDomain !== 'boolean')
          return fail('invalid-record', `${name}.timeDomain is true or false.`)
        next = editTuningProfile(next, at(), 'timeDomain', entry.timeDomain)
      }
      if (entry.layers !== undefined) {
        const layers = planProfileLayers(name, entry.layers, copperLayers)
        if (!layers.ok) return layers
        const profile = next.tuningProfiles[at()]
        next = {
          ...next,
          tuningProfiles: next.tuningProfiles.map((p) =>
            p === profile ? { ...p, layers: layers.layers } : p
          )
        }
      }
      // Solve every row for the target over the board's stackup, as Board Setup's Solve all does.
      if (entry.solve !== undefined && entry.solve !== false) {
        if (entry.solve !== true) return fail('invalid-record', `${name}.solve is true or false.`)
        const profile = next.tuningProfiles[at()]
        for (const [row, layer] of profile.layers.entries()) {
          const solved = solveProfileRow(stackup, next.tuningProfiles[at()], layer)
          if (!solved.ok)
            return fail('invalid-record', `${name} ${layer.layer} does not solve: ${solved.error}.`)
          next = applyLayerSolve(next, at(), row, solved.solve)
        }
      }
    }
    if (added.length) changed.added = added
    if (edited.length) changed.edited = edited
  }
  if (value.remove !== undefined) {
    if (!Array.isArray(value.remove) || !value.remove.every((n) => typeof n === 'string'))
      return fail('invalid-record', 'remove is a list of profile names.')
    for (const name of value.remove as string[]) {
      const index = indexOf(name)
      if (index < 0) return fail('invalid-record', `No tuning profile is called ${name}.`, names())
      next = removeTuningProfile(next, index)
    }
    changed.removed = value.remove
  }
  return { ok: true, model: next, changed }
}

/** A profile's layer rows, checked against the board's copper, one row per signal layer. */
const planProfileLayers = (
  name: string,
  value: unknown,
  copperLayers: readonly string[]
): { ok: true; layers: TuningProfileLayer[] } | SetupFailure => {
  if (!Array.isArray(value))
    return fail('invalid-record', `${name}.layers is a list of {layer, width, …}.`)
  const layers: TuningProfileLayer[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.layer !== 'string')
      return fail('invalid-record', `Each of ${name}.layers names its layer.`)
    const bad = extraKeys(entry, PROFILE_LAYER_KEYS)
    if (bad.length)
      return fail(
        'not-applicable',
        `A profile layer does not carry ${bad.join(', ')}; it takes ${PROFILE_LAYER_KEYS.join(', ')}.`
      )
    for (const key of ['layer', 'topReference', 'bottomReference'] as const) {
      const v = entry[key]
      if (v === undefined || (v === '' && key !== 'layer')) continue
      if (typeof v !== 'string' || !copperLayers.includes(v))
        return fail(
          'invalid-record',
          `${name}: ${String(v)} is not a copper layer of this board.`,
          [...copperLayers]
        )
    }
    if (layers.some((l) => l.layer === entry.layer))
      return fail('invalid-record', `${name} gives ${entry.layer} twice; one row per layer.`)
    const size = (key: 'width' | 'gap' | 'delay'): number | null => {
      const v = entry[key]
      if (v === undefined) return 0
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
    }
    const width = size('width')
    const gap = size('gap')
    const delay = size('delay')
    if (width === null || gap === null || delay === null)
      return fail('invalid-record', `${name} ${entry.layer}: width and gap are mm, delay ps/mm.`)
    layers.push({
      layer: entry.layer,
      topReference: typeof entry.topReference === 'string' ? entry.topReference : '',
      bottomReference: typeof entry.bottomReference === 'string' ? entry.bottomReference : '',
      width,
      gap,
      delay: delay * AS_PER_PS
    })
  }
  return { ok: true, layers }
}

/**
 * The tuners' defaults, partial records per tuner, through the page's own
 * edit (`applyBoardSetupEdit`): the amplitudes held in order, the radius a
 * percentage up to 100.
 */
const planTuningPatterns = (
  model: BoardSetupModel,
  value: unknown
): { ok: true; model: BoardSetupModel; changed: Rec } | SetupFailure => {
  if (!isRecord(value))
    return fail('invalid-record', `tuningPatterns takes ${TUNING_MODES.join(', ')}.`)
  const bad = extraKeys(value, TUNING_MODES)
  if (bad.length)
    return fail(
      'not-applicable',
      `tuningPatterns has no ${bad.join(', ')}; it takes ${TUNING_MODES.join(', ')}.`,
      [...TUNING_MODES]
    )
  let next = model
  const changed: Rec = {}
  for (const mode of TUNING_MODES) {
    const fields = value[mode]
    if (fields === undefined) continue
    if (!isRecord(fields))
      return fail('invalid-record', `tuningPatterns.${mode} takes ${TUNING_FIELDS.join(', ')}.`)
    const unknown = extraKeys(fields, TUNING_FIELDS)
    if (unknown.length)
      return fail('not-applicable', `tuningPatterns.${mode} has no ${unknown.join(', ')}.`, [
        ...TUNING_FIELDS
      ])
    for (const [field, v] of Object.entries(fields)) {
      const ok =
        field === 'singleSided'
          ? typeof v === 'boolean'
          : typeof v === 'number' && Number.isFinite(v) && v >= 0
      if (!ok)
        return fail(
          'invalid-record',
          `tuningPatterns.${mode}.${field} is ${field === 'singleSided' ? 'true or false' : field === 'cornerRadiusPercent' ? 'a percentage, 0 to 100' : 'a number in mm, 0 or more'}.`
        )
      next = applyBoardSetupEdit(next, 'tuningPatterns', `${mode}.${field}`, v as number | boolean)
    }
    changed[mode] = Object.keys(fields)
  }
  return { ok: true, model: next, changed }
}

const TEARDROP_RECORD_KEYS = [
  'bestLengthRatio',
  'maxLength',
  'bestWidthRatio',
  'maxWidth',
  'filterRatio',
  'curvedEdges',
  'allowTwoSegments',
  'preferZoneConnections'
] as const

/** The teardrop defaults as board_get_setup answers them: mm, ratios as fractions. */
const teardropSetupRecord = (t: TeardropSettings): Rec => {
  const shape = (p: TeardropParams, track: boolean): Rec => ({
    ...(track ? { enabled: p.enabled } : {}),
    bestLengthRatio: p.bestLengthRatio,
    maxLength: nmToMm(p.maxLength as Nm),
    bestWidthRatio: p.bestWidthRatio,
    maxWidth: nmToMm(p.maxWidth as Nm),
    filterRatio: p.filterRatio,
    curvedEdges: p.curvedEdges,
    allowTwoSegments: p.allowTwoSegments,
    ...(track ? {} : { preferZoneConnections: p.preferZoneConnections })
  })
  return { round: shape(t.round, false), rect: shape(t.rect, false), track: shape(t.track, true) }
}

/** The teardrop defaults, a partial record per shape, in board_get_setup's shape. */
const planTeardropSettings = (
  model: BoardSetupModel,
  value: unknown
): { ok: true; model: BoardSetupModel; changed: Rec } | SetupFailure => {
  const shapes = ['round', 'rect', 'track'] as const
  if (!isRecord(value)) return fail('invalid-record', `teardrops takes ${shapes.join(', ')}.`)
  const bad = extraKeys(value, shapes)
  if (bad.length)
    return fail(
      'not-applicable',
      `teardrops has no ${bad.join(', ')}; it takes ${shapes.join(', ')}.`,
      [...shapes]
    )
  const teardrops: TeardropSettings = structuredClone(model.teardrops)
  const changed: Rec = {}
  for (const shape of shapes) {
    const fields = value[shape]
    if (fields === undefined) continue
    const keys: readonly string[] =
      shape === 'track'
        ? ['enabled', ...TEARDROP_RECORD_KEYS.filter((k) => k !== 'preferZoneConnections')]
        : TEARDROP_RECORD_KEYS
    if (!isRecord(fields))
      return fail('invalid-record', `teardrops.${shape} takes ${keys.join(', ')}.`)
    const unknown = extraKeys(fields, keys)
    if (unknown.length)
      return fail('not-applicable', `teardrops.${shape} has no ${unknown.join(', ')}.`, [...keys])
    const p = teardrops[shape]
    for (const [field, v] of Object.entries(fields)) {
      const flag = ['enabled', 'curvedEdges', 'allowTwoSegments', 'preferZoneConnections'].includes(
        field
      )
      const ratio = field.endsWith('Ratio')
      const ok = flag
        ? typeof v === 'boolean'
        : typeof v === 'number' &&
          Number.isFinite(v) &&
          v >= 0 &&
          (!ratio || field === 'bestLengthRatio' || v <= 1)
      if (!ok)
        return fail(
          'invalid-record',
          `teardrops.${shape}.${field} is ${flag ? 'true or false' : ratio ? 'a fraction, 0 to 1' : 'a number in mm, 0 or more'}.`
        )
      const write = p as unknown as Record<string, unknown>
      write[field] = field === 'maxLength' || field === 'maxWidth' ? mmToNm(v as number) : v
    }
    if (shape === 'track')
      teardrops.targets = { ...teardrops.targets, trackToTrack: teardrops.track.enabled }
    changed[shape] = Object.keys(fields)
  }
  return { ok: true, model: { ...model, teardrops }, changed }
}

/**
 * Net class changes over the page's own model functions: a rename carries the
 * class's patterns, a removal drops them, a new class starts from Default.
 */
const planNetClasses = (
  model: BoardSetupModel,
  value: unknown
): { ok: true; model: BoardSetupModel; changed: Rec } | SetupFailure => {
  if (!isRecord(value))
    return fail(
      'invalid-record',
      'netClasses takes upsert, rename, remove, patterns and extraSizes.'
    )
  const extra = extraKeys(value, ['upsert', 'rename', 'remove', 'patterns', 'extraSizes'])
  if (extra.length)
    return fail(
      'not-applicable',
      `netClasses does not carry ${extra.join(', ')}; it takes upsert, rename, remove, patterns and extraSizes.`
    )
  let next = model
  const changed: Rec = {}
  const indexOf = (name: string): number => next.classes.findIndex((c) => c.name === name)
  const names = (): string[] => next.classes.map((c) => c.name)

  if (value.rename !== undefined) {
    if (!Array.isArray(value.rename))
      return fail('invalid-record', 'rename is a list of {from, to}.')
    for (const entry of value.rename) {
      if (
        !isRecord(entry) ||
        typeof entry.from !== 'string' ||
        typeof entry.to !== 'string' ||
        !entry.to.trim()
      )
        return fail('invalid-record', 'Each rename is {from, to}, both class names.')
      const index = indexOf(entry.from)
      if (index < 0) return fail('invalid-record', `No net class is called ${entry.from}.`, names())
      if (entry.from === DEFAULT_CLASS_NAME)
        return fail(
          'not-applicable',
          'Default is what every unassigned net falls back to, by that name; it keeps it.'
        )
      if (indexOf(entry.to.trim()) >= 0)
        return fail('invalid-record', `A net class is already called ${entry.to}.`)
      next = editNetClass(next, index, 'name', entry.to.trim())
    }
    changed.renamed = value.rename
  }
  if (value.upsert !== undefined) {
    if (!Array.isArray(value.upsert))
      return fail('invalid-record', 'upsert is a list of classes by name.')
    const added: string[] = []
    const edited: string[] = []
    for (const entry of value.upsert) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim())
        return fail('invalid-record', 'Each upserted class has a name.')
      const bad = extraKeys(entry, CLASS_KEYS)
      if (bad.length)
        return fail(
          'not-applicable',
          `A net class does not carry ${bad.join(', ')}; it takes ${CLASS_KEYS.join(', ')}.`
        )
      const name = entry.name.trim()
      if (indexOf(name) < 0) {
        next = addNetClass(next, name)
        added.push(name)
      } else {
        edited.push(name)
      }
      if (entry.tuningProfile !== undefined) {
        const profile = entry.tuningProfile
        if (
          typeof profile !== 'string' ||
          (profile !== '' && !next.tuningProfiles.some((p) => p.name === profile))
        )
          return fail(
            'invalid-record',
            `${name}.tuningProfile names no tuning profile; '' clears it.`,
            next.tuningProfiles.map((p) => p.name)
          )
        next = editNetClass(next, indexOf(name), 'tuningProfile', profile)
      }
      for (const field of NET_CLASS_FIELDS) {
        const v = entry[field]
        if (v === undefined) continue
        if (
          typeof v !== 'number' ||
          !Number.isFinite(v) ||
          v < 0 ||
          (field !== 'clearance' && v === 0)
        )
          return fail('invalid-record', `${name}.${field} is a length in mm.`)
        next = editNetClass(next, indexOf(name), field as NetClassColumn, v)
      }
    }
    if (added.length) changed.added = added
    if (edited.length) changed.edited = edited
  }
  if (value.remove !== undefined) {
    if (!Array.isArray(value.remove) || !value.remove.every((n) => typeof n === 'string'))
      return fail('invalid-record', 'remove is a list of class names.')
    for (const name of value.remove as string[]) {
      if (name === DEFAULT_CLASS_NAME) return fail('not-applicable', 'Default cannot be removed.')
      const index = indexOf(name)
      if (index < 0) return fail('invalid-record', `No net class is called ${name}.`, names())
      next = removeNetClass(next, index)
    }
    changed.removed = value.remove
  }
  if (value.patterns !== undefined) {
    if (!Array.isArray(value.patterns))
      return fail('invalid-record', 'patterns is the whole list of {pattern, netClass}, in order.')
    const patterns: NetClassPattern[] = []
    for (const entry of value.patterns) {
      if (
        !isRecord(entry) ||
        typeof entry.pattern !== 'string' ||
        !entry.pattern.trim() ||
        typeof entry.netClass !== 'string'
      )
        return fail(
          'invalid-record',
          'Each pattern is {pattern, netClass}, e.g. {"pattern": "/USB_*", "netClass": "USB"}.'
        )
      if (indexOf(entry.netClass) < 0)
        return fail(
          'invalid-record',
          `patterns name ${entry.netClass}, which is not a net class.`,
          names()
        )
      patterns.push({ pattern: entry.pattern.trim(), netClass: entry.netClass })
    }
    next = { ...next, patterns }
    changed.patterns = patterns.length
  }
  if (value.extraSizes !== undefined) {
    const sizes = planExtraSizes(value.extraSizes, next.extraSizes)
    if (!sizes.ok) return sizes
    next = { ...next, extraSizes: sizes.sizes }
    changed.extraSizes = extraSizesRecord(sizes.sizes)
  }
  return { ok: true, model: next, changed }
}

/**
 * The route tool's extra sizes (router-behavior.md S4): each list given is the
 * whole list, mm; one left out stays as it was.
 */
const planExtraSizes = (
  value: unknown,
  current: BoardSetupModel['extraSizes']
): { ok: true; sizes: BoardSetupModel['extraSizes'] } | SetupFailure => {
  const shape = 'extraSizes is {tracks: [mm], vias: [{size, drill}]}, each list whole.'
  if (!isRecord(value) || extraKeys(value, ['tracks', 'vias']).length)
    return fail('invalid-record', shape)
  const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
  let tracks = [...current.tracks]
  let vias = [...current.vias]
  if (value.tracks !== undefined) {
    if (!Array.isArray(value.tracks) || !value.tracks.every(positive))
      return fail('invalid-record', `tracks is a list of widths in mm. ${shape}`)
    tracks = value.tracks
  }
  if (value.vias !== undefined) {
    const ok =
      Array.isArray(value.vias) &&
      value.vias.every(
        (v) =>
          isRecord(v) &&
          extraKeys(v, ['size', 'drill']).length === 0 &&
          positive(v.size) &&
          positive(v.drill) &&
          v.drill < v.size
      )
    if (!ok)
      return fail(
        'invalid-record',
        `vias is a list of {size, drill} in mm, each drill smaller than its via. ${shape}`
      )
    vias = (value.vias as Array<{ size: number; drill: number }>).map((v) => ({
      diameter: v.size,
      drill: v.drill
    }))
  }
  return { ok: true, sizes: { tracks, vias } }
}

/** The extra sizes as an agent reads and writes them: a via's diameter is `size`, as on a via record. */
const extraSizesRecord = (
  sizes: BoardSetupModel['extraSizes']
): { tracks: number[]; vias: { size: number; drill: number }[] } => ({
  tracks: [...sizes.tracks],
  vias: sizes.vias.map((via) => ({ size: via.diameter, drill: via.drill }))
})

export interface BoardSetupContext {
  board: KicadBoard
  settings: BoardDesignSettings
  catalog: readonly CatalogRule[]
  hasProject: boolean
}

/** Plan `board.update_setup`: validated whole before anything is written. */
export function planBoardSetup(
  ctx: BoardSetupContext,
  changes: Rec
): { ok: true; plan: SetupPlan } | SetupFailure {
  const allowed = [
    'profile',
    'stackup',
    'general',
    'constraints',
    'tuningPatterns',
    'teardrops',
    'tuningProfiles',
    'netClasses',
    'severities'
  ]
  const extra = extraKeys(changes, allowed)
  if (extra.includes('exclusions'))
    return fail(
      'not-applicable',
      'Exclusions are read-only here, as in Board Setup: they are made in KiCad.'
    )
  if (extra.length)
    return fail(
      'not-applicable',
      `update_setup takes ${allowed.join(', ')}; not ${extra.join(', ')}.`
    )
  const projectHalf = [
    'profile',
    'constraints',
    'tuningPatterns',
    'teardrops',
    'tuningProfiles',
    'netClasses',
    'severities'
  ].filter((key) => changes[key] !== undefined)
  if (projectHalf.length && !ctx.hasProject)
    return fail(
      'no-project-file',
      `${projectHalf.join(', ')} live in the project file, and this board has none. The stackup and general settings are the board's own.`
    )

  const plan: SetupPlan = { board: {}, project: {}, changed: {}, before: {} }
  const startSpec = stackupSpecOf(ctx.board)
  let spec = startSpec
  let model: BoardSetupModel = {
    profiles: BUILT_IN_PROFILES,
    activeProfileId: null,
    edited: false,
    stackup: startSpec,
    layers: ctx.board.stackup?.layers ?? [],
    activeStackupId: null,
    stackupPresets: [],
    rules: { ...ctx.settings.rules },
    classes: ctx.settings.classes,
    patterns: ctx.settings.patterns,
    extraSizes: ctx.settings.extraSizes ?? { tracks: [], vias: [] },
    tuning: ctx.settings.tuningPatterns ?? DEFAULT_TUNING_PATTERN_SETTINGS,
    tuningProfiles: ctx.settings.tuning?.definitions ?? [],
    teardrops: ctx.settings.teardrops ?? DEFAULT_TEARDROP_SETTINGS
  }
  let designChanged = false
  let picked: ManufacturingProfile | null = null

  // A profile seeds the rest first, as the page applies it: the rules, the
  // Default class and the stackup. What else the update names lands on top.
  if (changes.profile !== undefined) {
    const profile = typeof changes.profile === 'string' ? findProfile(changes.profile) : null
    if (!profile)
      return fail(
        'invalid-record',
        `No manufacturing profile is ${String(changes.profile)}.`,
        BUILT_IN_PROFILES.map((p) => p.id)
      )
    model = {
      ...model,
      rules: { ...profile.rules },
      classes: model.classes.map((netClass) =>
        netClass.name === DEFAULT_CLASS_NAME ? { ...netClass, ...profile.defaults } : netClass
      )
    }
    spec = defaultStackupOf(profile)
    designChanged = true
    picked = profile
    plan.changed.profile = profile.id
  }
  const rowEdits =
    isRecord(changes.stackup) && STACKUP_ROW_KEYS.some((key) => key in (changes.stackup as Rec))
  if (rowEdits) {
    const value = changes.stackup as Rec
    const build = Object.keys(value).filter((key) => !STACKUP_ROW_KEYS.includes(key))
    if (build.length || changes.profile !== undefined)
      return fail(
        'not-applicable',
        `stackup.layers, addDielectric and removeLayers edit rows in place; ${[...build, ...(changes.profile !== undefined ? ['profile'] : [])].join(', ')} regenerate the build. Send them in separate calls.`
      )
    if (!ctx.board.stackup)
      return fail(
        'not-applicable',
        'The board has no stackup rows to edit; give it one with stackup.preset or copperLayers first.'
      )
    const planned = planStackupEdits(ctx.board.stackup.layers, value)
    if (!planned.ok) return planned
    plan.board.stackupEdits = planned.plan
    plan.changed.stackup = planned.changed
    plan.before.stackup = planned.before
  } else if (changes.stackup !== undefined) {
    const planned = planStackup(spec, changes.stackup)
    if (!planned.ok) return planned
    spec = planned.spec
  }
  if (changes.profile !== undefined || (changes.stackup !== undefined && !rowEdits)) {
    plan.board.stackup = spec
    plan.changed.stackup = Object.keys(spec).filter(
      (key) =>
        JSON.stringify(spec[key as keyof StackupSpec]) !==
        JSON.stringify(startSpec[key as keyof StackupSpec])
    )
    plan.before.stackup = startSpec
  }
  // The picks, as the page stores them: a catalog build named alone is that
  // build; one regenerated with other values, or edited by row, is Custom.
  if (picked || changes.stackup !== undefined) {
    const value = isRecord(changes.stackup) ? (changes.stackup as Rec) : null
    const presetOnly =
      value !== null && Object.keys(value).length === 1 && typeof value.preset === 'string'
    const stackup =
      changes.stackup === undefined
        ? (picked?.stackups[0]?.id ?? null)
        : presetOnly
          ? (value.preset as string)
          : null
    plan.project.choice = { ...(picked ? { profile: picked.id } : {}), stackup }
  }

  if (changes.general !== undefined) {
    const general = changes.general
    if (!isRecord(general))
      return fail('invalid-record', 'general takes paper, gridOrigin and drillOrigin.')
    const bad = extraKeys(general, ['paper', 'gridOrigin', 'drillOrigin'])
    if (bad.length)
      return fail(
        'not-applicable',
        `general does not carry ${bad.join(', ')}; it takes paper, gridOrigin and drillOrigin. The board's thickness is stackup.boardThickness.`
      )
    const before: Rec = {}
    if (general.paper !== undefined) {
      if (
        typeof general.paper !== 'string' ||
        !(PAPER_SIZES as readonly string[]).includes(general.paper)
      )
        return fail('invalid-record', `paper is one of ${PAPER_SIZES.join(', ')}.`, [
          ...PAPER_SIZES
        ])
      plan.board.paper = general.paper
      before.paper = ctx.board.paper ?? 'A4'
    }
    for (const [key, field, current] of [
      ['gridOrigin', 'gridOrigin', ctx.board.gridOrigin],
      ['drillOrigin', 'drillOrigin', ctx.board.auxOrigin]
    ] as const) {
      if (general[key] === undefined) continue
      const origin = planOrigin(general[key], key)
      if (isFailure(origin)) return origin
      plan.board[field] = origin
      before[key] = point(current)
    }
    plan.changed.general = Object.keys(general)
    plan.before.general = before
  }

  if (changes.constraints !== undefined) {
    const constraints = changes.constraints
    if (!isRecord(constraints))
      return fail('invalid-record', 'constraints is a partial record of the design rules.')
    const bad = extraKeys(constraints, CONSTRAINT_KEYS)
    if (bad.length)
      return fail(
        'not-applicable',
        `constraints has no ${bad.join(', ')}.`,
        CONSTRAINT_KEYS as string[]
      )
    const before: Rec = {}
    const rules = { ...model.rules }
    for (const [key, value] of Object.entries(constraints)) {
      const field = key as keyof DesignRules
      const kind = typeof ctx.settings.rules[field]
      if (
        kind === 'boolean'
          ? typeof value !== 'boolean'
          : typeof value !== 'number' || !Number.isFinite(value) || value < 0
      )
        return fail(
          'invalid-record',
          `constraints.${key} is ${kind === 'boolean' ? 'true or false' : 'a number in mm, 0 or more'}.`
        )
      before[key] = ctx.settings.rules[field]
      ;(rules as Record<string, unknown>)[key] = value
    }
    model = { ...model, rules }
    designChanged = true
    plan.changed.constraints = Object.keys(constraints)
    plan.before.constraints = before
  }

  if (changes.tuningPatterns !== undefined) {
    const planned = planTuningPatterns(model, changes.tuningPatterns)
    if (!planned.ok) return planned
    model = planned.model
    plan.project.tuning = model.tuning
    plan.changed.tuningPatterns = planned.changed
    plan.before.tuningPatterns = structuredClone(
      ctx.settings.tuningPatterns ?? DEFAULT_TUNING_PATTERN_SETTINGS
    )
  }

  if (changes.teardrops !== undefined) {
    const planned = planTeardropSettings(model, changes.teardrops)
    if (!planned.ok) return planned
    model = planned.model
    plan.project.teardrops = model.teardrops
    plan.changed.teardrops = planned.changed
    plan.before.teardrops = teardropSetupRecord(ctx.settings.teardrops ?? DEFAULT_TEARDROP_SETTINGS)
  }

  // Before the classes, so a class may name a profile the same update adds.
  if (changes.tuningProfiles !== undefined) {
    const before = model.classes
    const planned = planTuningProfiles(
      model,
      changes.tuningProfiles,
      copperNamesFor(startSpec.copperLayers),
      solverStackupOf(ctx.board)
    )
    if (!planned.ok) return planned
    model = planned.model
    plan.project.tuningProfiles = [...model.tuningProfiles]
    plan.changed.tuningProfiles = planned.changed
    plan.before.tuningProfiles = (ctx.settings.tuning?.definitions ?? []).map(tuningProfileRecord)
    // A rename or removal reaches the classes that named the profile.
    if (model.classes !== before) designChanged = true
  }

  if (changes.netClasses !== undefined) {
    const planned = planNetClasses(model, changes.netClasses)
    if (!planned.ok) return planned
    model = planned.model
    designChanged = true
    plan.changed.netClasses = planned.changed
    plan.before.netClasses = {
      classes: ctx.settings.classes.map(classRecord),
      patterns: ctx.settings.patterns,
      ...(planned.changed.extraSizes
        ? { extraSizes: extraSizesRecord(ctx.settings.extraSizes ?? { tracks: [], vias: [] }) }
        : {})
    }
  }

  if (designChanged) {
    plan.project.design = {
      rules: model.rules,
      classes: [...model.classes],
      patterns: [...model.patterns],
      extraSizes: { tracks: [...model.extraSizes.tracks], vias: [...model.extraSizes.vias] }
    }
  }

  if (changes.severities !== undefined) {
    const planned = planSeverities(ctx.catalog, ctx.settings.severities ?? {}, changes.severities)
    if (!planned.ok) return planned
    plan.project.severities = planned.set
    plan.changed.severities = Object.keys(planned.set)
    plan.before.severities = planned.before
  }
  return { ok: true, plan }
}
