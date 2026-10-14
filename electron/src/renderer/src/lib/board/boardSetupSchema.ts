// The Board Setup model: three sections of explained settings, and the fold-back
// that applies one edit. Pure — the host owns persistence (stackup through the
// board AST, rules and routing defaults through the .kicad_pro).
//
// Deliberately NOT PropertyGroup[]: Board Setup is not a property table. These
// settings are infrequent, consequential and jargon-heavy ("annular ring",
// "loss tangent"), so each carries a glyph and a one-line explanation and gets a
// card rather than a 24px row. Only the *value editor* is shared with the table
// (PropertyValueEditor), which is where the unit parsing and MIXED handling live.
//
// The three sections are a real distinction, not cosmetic — and it matches where
// the data persists:
//   stackup     — what the board IS (physical build)      → .kicad_pcb
//   constraints — what the board MUST SATISFY             → .kicad_pro
//   routing     — what I DRAW WITH (my defaults)          → .kicad_pro
// The constraint configuration picker lives in `constraints` because that is the
// one section whose every value it dictates; in `stackup` it only constrains the
// available options, and for `routing` it merely seeds sensible starting values.
//
// A profile is a named preset of the WHOLE constraint set — the built-ins are
// named after manufacturers only because that is what makes one quick to pick,
// not because the section is limited to fab-dictated limits. So `constraints`
// carries KiCad's Constraints page in full, grouped as KiCad groups it: at
// eighteen rows a flat list stops being scannable, and `BoardSetting.group`
// starts a labelled run at the first card of each.

import type { KicadStackupLayer, StackupSpec } from '../kicad/board'
import {
  teardropRowEdit,
  teardropRowValue,
  type TeardropParams,
  type TeardropSettings
} from './teardrop/params'
import { mmToNm, nm, nmToMm, type Nm } from '../kicad/coordinates'
import type {
  DesignRules,
  NetClass,
  NetClassPattern,
  TuningPatternDefaults,
  TuningPatternSettings,
  TuningProfile,
  TuningProfileLayer,
  ViaSize
} from '../kicad/project'
import { customRuleRows, type CustomRuleRow } from './customRuleRows'
import type { PendingState, PresetPending } from './presetDraft'

import {
  buildTuningProfileBlocks,
  type LayerReadout,
  type TuningProfileBlock
} from './tuningProfiles'
import {
  CLASS_LINE_STYLES,
  DEFAULT_CLASS_NAME,
  SCHEMATIC_CLASS_DEFAULTS,
  defaultNetClass
} from '../kicad/project'
import { STROKE_TYPE_OPTIONS } from '../propertyTable'
import { cssColor } from '../kicad/color'
import type {
  EditorDescriptor,
  PropertyEditValue,
  PropertyField,
  PropertyValue,
  Rgba,
  SelectOption
} from '../propertyTable'
import type { ManufacturingProfile } from '../manufacturingProfiles'
import { INNER_COPPER_LAYERS } from '../kicad/layers'
import { profileLabel } from '../manufacturingProfiles'

export type Translate = (key: string) => string

const isRgba = (value: PropertyEditValue): value is Rgba =>
  typeof value === 'object' && value !== null && 'r' in value

export type SectionId =
  | 'stackup'
  | 'constraints'
  | 'tuningPatterns'
  | 'teardrops'
  | 'tuningProfiles'
  | 'netClasses'
  | 'customRules'
  | 'rules'
  | 'exclusions'

/**
 * The net-class table's editable columns, in display order. `name` is handled
 * separately — it is the row header and the key patterns refer to.
 */
export const NET_CLASS_COLUMNS = [
  'clearance',
  'trackWidth',
  'viaDiameter',
  'viaDrill',
  'microviaDiameter',
  'microviaDrill',
  'diffPairWidth',
  'diffPairGap'
] as const
export type NetClassColumn = (typeof NET_CLASS_COLUMNS)[number]

/** Schematic Setup's columns instead (KiCad shows each editor its own): how a class's wires draw. */
export const SCHEMATIC_CLASS_COLUMNS = [
  'wireWidth',
  'busWidth',
  'schematicColor',
  'lineStyle'
] as const
export type SchematicClassColumn = (typeof SCHEMATIC_CLASS_COLUMNS)[number]

/** Every column a class edit addresses. */
export type NetClassEditColumn =
  NetClassColumn | SchematicClassColumn | 'name' | 'pcbColor' | 'tuningProfile'

export interface NetClassRow {
  /** Index into the model's class list — what an edit addresses. */
  index: number
  name: string
  /** Default is the fallback every unassigned net uses: it cannot go, or be renamed. */
  isDefault: boolean
  cells: Record<NetClassColumn, PropertyField>
  nameCell: PropertyField
  /** KiCad's PCB color: unset is the layer's own; Default's is fixed so (KiCad's). */
  colorCell: PropertyField
  /** KiCad 10's Tuning profile column: the profile the class's nets take. */
  profileCell: PropertyField
  /** Under an interface preset draft: what Apply would do to the row. */
  pending?: PendingState
  /** The schematic's styling; on a class other than Default, empty takes Default's. */
  schematicCells: Record<SchematicClassColumn, PropertyField>
}

/** One of the route tool's extra sizes (router-behavior.md S4): a track width, or a via. */
export interface ExtraSizeRow {
  kind: 'track' | 'via'
  /** Index into the model's list of that kind — what an edit addresses. */
  index: number
  /** A track's width; a via's diameter, then drill. */
  cells: PropertyField[]
}

export type ExtraSizeField = 'width' | 'diameter' | 'drill'

export interface NetClassPatternRow {
  index: number
  pattern: string
  netClass: string
  patternCell: PropertyField
  classCell: PropertyField
  /** True when the pattern names a class that no longer exists. */
  dangling: boolean
  /** Under an interface preset draft: a pattern Apply would add. */
  pending?: PendingState
}

/** Which demonstration the right-hand pane shows for the selected setting. */
export type PreviewKind =
  | 'stackup'
  | 'clearance'
  | 'trackWidth'
  | 'via'
  | 'annular'
  | 'hole'
  | 'holeSpacing'
  | 'edgeClearance'
  | 'silk'
  | 'arc'
  | 'zone'
  | 'none'

/** A labelled run of cards within a section — KiCad's Constraints groupings. */
export type SettingGroup =
  | 'copper'
  | 'holes'
  | 'microvias'
  | 'silk'
  | 'arcs'
  | 'zones'
  | 'lengthTuning'
  | 'tuneSingle'
  | 'tunePair'
  | 'tuneSkew'
  | 'teardropRound'
  | 'teardropRect'
  | 'teardropTrack'

export interface BoardSetting {
  key: string
  section: SectionId
  label: string
  /** One line of plain language; omitted where the name explains itself. */
  blurb?: string
  /** Glyph name from lib/boardSetupGlyphs. */
  glyph?: string
  editor: EditorDescriptor
  value: PropertyValue
  preview: PreviewKind
  /** Set on the FIRST card of a run to start a labelled group above it. */
  group?: SettingGroup
  /**
   * The section's header picker, rendered as a card above the rest: the
   * constraint configuration for Constraints, the catalog build for Stackup.
   * Both seed everything below them, so neither is a peer row.
   */
  isHeader?: boolean
}

export interface BoardSetupSection {
  id: SectionId
  title: string
  settings: BoardSetting[]
  /** The editable layer table — stackup only; the other sections use cards. */
  layers?: StackupLayerRow[]
  /** The net-class table — netClasses only. */
  netClasses?: NetClassRow[]
  /** The pattern → class assignment table — netClasses only. */
  netClassPatterns?: NetClassPatternRow[]
  /** The tuning profiles, one block each — tuningProfiles only. */
  tuningProfiles?: TuningProfileBlock[]
  /** The project's `.kicad_dru`, a row per rule and constraint — customRules only. */
  customRules?: Array<CustomRuleRow & { pending?: PendingState }>
  /** Why KiCad would discard the file's rules, where it would. */
  customRuleErrors?: string[]
  /** The route tool's extra track widths and vias — netClasses only. */
  extraTracks?: ExtraSizeRow[]
  extraVias?: ExtraSizeRow[]
  /** Every DRC rule and its severity (shared/RuleSeverityTable) — rules only. */
  rules?: boolean
  /** The project's KiCad exclusions (shared/ExclusionList) — exclusions only. */
  exclusions?: boolean
}

/** The columns of the stackup table, in display order. */
export const STACKUP_COLUMNS = [
  'type',
  'material',
  'thickness',
  'weight',
  'epsilonR',
  'lossTangent',
  'color'
] as const
export type StackupColumn = (typeof STACKUP_COLUMNS)[number]

/** What a stackup row physically is — decides which cells apply to it. */
export type LayerKind = 'copper' | 'dielectric' | 'mask' | 'silk' | 'paste' | 'other'

/**
 * The color a layer is drawn in when it carries none of its own — the physical
 * material. One source for the table's row tint, its swatch chip, and the
 * cross-section band, so the three can never disagree.
 */
export const KIND_SWATCHES: Record<LayerKind, string> = {
  copper: '#c98a3f',
  dielectric: '#4a5a3f',
  mask: '#1f6b3a',
  silk: '#d8d8d8',
  paste: '#8f9aa2',
  other: '#3d4a3f'
}

/**
 * Resolve what a row is drawn in: its own finish color where it has one (mask,
 * silkscreen), else the color of the material. Choosing a purple solder mask
 * therefore repaints the row and the cross-section, not just the dropdown.
 */
export const layerSwatch = (kind: LayerKind, color?: string): string =>
  (color ? FINISH_SWATCHES[color] : undefined) ?? KIND_SWATCHES[kind]

export interface StackupLayerRow {
  /** Index into KicadStackup.layers — what an edit addresses. */
  index: number
  /** Raw KiCad name, e.g. "dielectric 1". */
  name: string
  /** How the name is shown: KiCad writes dielectrics lower-case. */
  label: string
  kind: LayerKind
  /** Real thickness in mm; 0 for rows that carry none (silk, paste). */
  mm: number
  /** Color to draw this row in — its own finish, else its material. */
  swatch: string
  /** Cells that do not apply to this row are null, not blank editors. */
  cells: Record<StackupColumn, PropertyField | null>
}

/** Copper is specified by weight in practice; thickness is the file's unit. */
export const COPPER_WEIGHTS: Array<{ oz: string; mm: number }> = [
  { oz: '0.5 oz', mm: 0.0175 },
  { oz: '1 oz', mm: 0.035 },
  { oz: '2 oz', mm: 0.07 },
  { oz: '3 oz', mm: 0.105 }
]

/** The weight whose thickness matches, or null for a hand-entered value. */
export const weightForThickness = (thickness: number): string | null =>
  COPPER_WEIGHTS.find((w) => Math.abs(w.mm - thickness) < 1e-6)?.oz ?? null

export const thicknessForWeight = (oz: string): number | null =>
  COPPER_WEIGHTS.find((w) => w.oz === oz)?.mm ?? null

export const DIELECTRIC_TYPES = ['core', 'prepreg']

/**
 * Copper layer counts on offer. KiCad goes to 32; boards are built in even
 * counts (each core carries copper on both faces), so odd counts are omitted —
 * a 1-layer build also has a different topology (no B.Cu) than the generator
 * produces, so it is deliberately out.
 */
export const COPPER_LAYER_COUNTS: number[] = Array.from({ length: 16 }, (_, i) => (i + 1) * 2)

/** Snap an arbitrary value to the nearest offered count. */
export const nearestCopperLayerCount = (value: number): number =>
  COPPER_LAYER_COUNTS.reduce((best, n) => (Math.abs(n - value) < Math.abs(best - value) ? n : best))

/** KiCad stores dielectrics lower-case; every other row is already a proper name. */
export const displayLayerName = (name: string): string =>
  name.startsWith('dielectric') ? name.charAt(0).toUpperCase() + name.slice(1) : name

export function layerKindOf(name: string, type?: string): LayerKind {
  if (name.startsWith('dielectric')) return 'dielectric'
  const t = (type ?? '').toLowerCase()
  if (t === 'copper') return 'copper'
  if (t.includes('mask')) return 'mask'
  if (t.includes('silk')) return 'silk'
  if (t.includes('paste')) return 'paste'
  return 'other'
}

/**
 * Build the editable stackup table from the board's own layer list.
 *
 * The layers ARE the model: a preset seeds them, but every edit after that
 * addresses one row, so hand edits survive (unlike regenerating from a spec).
 * Cells that do not apply to a row are null — copper has no color, silkscreen
 * no thickness — rather than empty inputs that invite meaningless values.
 */
export function buildStackupRows(
  layers: readonly KicadStackupLayer[],
  t: Translate
): StackupLayerRow[] {
  const tr = (key: string): string => t(`boardSetup.${key}`)
  const cell = (key: string, editor: EditorDescriptor, value: PropertyValue): PropertyField => ({
    key,
    label: tr(`columns.${key}`),
    editor,
    value
  })

  const rows = layers.map((layer, index) => {
    const kind = layerKindOf(layer.name, layer.type)
    const isDielectric = kind === 'dielectric'
    const isCopper = kind === 'copper'
    const hasThickness = layer.thickness !== undefined || isCopper || isDielectric

    const cells: Record<StackupColumn, PropertyField | null> = {
      type: isDielectric
        ? cell(
            'type',
            { kind: 'select', options: DIELECTRIC_TYPES.map((v) => opt(v, v)) },
            layer.type ?? 'core'
          )
        : null,
      material:
        isDielectric || kind === 'mask'
          ? cell('material', { kind: 'text' }, layer.material ?? '')
          : null,
      thickness: hasThickness
        ? cell('thickness', { kind: 'distance', step: 0.01, model: 'nm' }, layer.thickness ?? 0)
        : null,
      weight: isCopper
        ? cell(
            'weight',
            {
              kind: 'select',
              options: COPPER_WEIGHTS.map((w) => opt(w.oz, w.oz))
            },
            weightForThickness(layer.thickness !== undefined ? nmToMm(layer.thickness) : 0) ?? ''
          )
        : null,
      epsilonR: isDielectric
        ? cell('epsilonR', { kind: 'number', step: 0.1, min: 1 }, layer.epsilonR ?? 4.5)
        : null,
      lossTangent: isDielectric
        ? cell('lossTangent', { kind: 'number', step: 0.001, min: 0 }, layer.lossTangent ?? 0.02)
        : null,
      color:
        kind === 'mask' || kind === 'silk'
          ? cell(
              'color',
              {
                kind: 'select',
                options: [
                  // A layer with no (color) is KiCad's "not specified": drawn,
                  // and made, in the default finish. Offered only while it is
                  // the value, so the cell shows it rather than going blank.
                  ...(layer.color
                    ? []
                    : [
                        kind === 'mask'
                          ? {
                              ...opt('', t('boardSetup.columns.colorUnsetMask')),
                              color: FINISH_SWATCHES.Green
                            }
                          : {
                              ...opt('', t('boardSetup.columns.colorUnsetSilk')),
                              color: FINISH_SWATCHES.White
                            }
                      ]),
                  ...(kind === 'mask' ? MASK_COLORS : SILK_COLORS).map((c) => ({
                    ...opt(c, c),
                    color: FINISH_SWATCHES[c]
                  }))
                ]
              },
              layer.color ?? ''
            )
          : null
    }

    return {
      index,
      name: layer.name,
      label: displayLayerName(layer.name),
      kind,
      mm: layer.thickness !== undefined ? nmToMm(layer.thickness) : 0,
      swatch: layerSwatch(kind, layer.color),
      cells
    }
  })
  // Paste is the assembly stencil's, not the bare board's: nothing in it is
  // editable, and the board the fab builds carries none. It stays in the file.
  return rows.filter((row) => row.kind !== 'paste')
}

const opt = (value: string, label: string): SelectOption => ({ value, label })

/** Surface finishes worth offering; the fab decides what it actually supports. */
/**
 * The header pickers' Custom entry. Not empty: the shared select treats an
 * empty value as a placeholder and never commits it.
 */
export const CUSTOM_PRESET_ID = 'custom'

export const COPPER_FINISHES = ['HASL', 'HASL lead-free', 'ENIG', 'OSP', 'None']
/** Solder-mask colors the common prototype fabs stock. */
export const MASK_COLORS = ['Green', 'Red', 'Yellow', 'Blue', 'White', 'Black', 'Purple']
export const SILK_COLORS = ['White', 'Black']

/**
 * What each named finish actually looks like, so the picker can show it. These
 * are the cured colors a fab produces — solder mask green is a dark olive
 * green, not CSS `green` — which is also what the cross-section paints.
 */
export const FINISH_SWATCHES: Record<string, string> = {
  Green: '#1f6b3a',
  Red: '#8c2323',
  Yellow: '#b8a52a',
  Blue: '#1f4d8c',
  White: '#d8d8d8',
  Black: '#1a1a1a',
  Purple: '#4b2a6b'
}

const dist = (step = 0.01): EditorDescriptor => ({ kind: 'distance', step })
const select = (values: string[]): EditorDescriptor => ({
  kind: 'select',
  options: values.map((v) => opt(v, v))
})

export interface BoardSetupModel {
  profiles: readonly ManufacturingProfile[]
  /** Currently applied profile, or null when the board matches no built-in. */
  activeProfileId: string | null
  /** True once the user edited a value away from the applied profile. */
  edited: boolean
  /** Seed spec — what a preset applies. NOT the live model; `layers` is. */
  stackup: StackupSpec
  /** The board's actual stackup rows: the source of truth for editing. */
  layers: readonly KicadStackupLayer[]
  /** Catalog build currently applied, or null once hand-edited. */
  activeStackupId: string | null
  /** Every catalog build on offer, across profiles. */
  stackupPresets: ReadonlyArray<{ id: string; name: string }>
  rules: DesignRules
  /** Every net class in the project; Default first and always present. */
  classes: readonly NetClass[]
  /** Pattern → class assignments, in KiCad's order. */
  patterns: readonly NetClassPattern[]
  /** The route tool's sizes beyond the classes' (`track_widths`, `via_dimensions`). */
  extraSizes: { tracks: readonly number[]; vias: readonly ViaSize[] }
  /** The length tuners' meander defaults (`tuning_pattern_settings`, router-behavior.md T6). */
  tuning: TuningPatternSettings
  /** The project's tuning profiles (`tuning_profiles`), Board Setup's Tuning profiles. */
  tuningProfiles: readonly TuningProfile[]
  /** The teardrop defaults per shape and track to track (`teardrop_parameters`). */
  teardrops: TeardropSettings
}

/** A board's copper layers top to bottom, by name, for its copper count: what a profile's rows pick from. */
export const copperNamesFor = (count: number): string[] =>
  count < 2 ? ['F.Cu'] : ['F.Cu', ...INNER_COPPER_LAYERS.slice(0, count - 2), 'B.Cu']

/** A tuner's defaults, in KiCad's Length-tuning Patterns order. */
export const TUNING_FIELDS = [
  'minAmplitude',
  'maxAmplitude',
  'spacing',
  'cornerRadiusPercent',
  'singleSided'
] as const satisfies ReadonlyArray<keyof TuningPatternDefaults>
export type TuningField = (typeof TUNING_FIELDS)[number]
export const TUNING_MODES = ['single', 'pair', 'skew'] as const
export type TuningMode = (typeof TUNING_MODES)[number]

/** Each tuner's group of cards; the page draws its legend under the heading. */
export const TEARDROP_SHAPES = ['round', 'rect', 'track'] as const
export type TeardropShape = (typeof TEARDROP_SHAPES)[number]
export const TEARDROP_GROUPS: Readonly<Record<TeardropShape, SettingGroup>> = {
  round: 'teardropRound',
  rect: 'teardropRect',
  track: 'teardropTrack'
}
/** Board Setup's teardrop fields, by the Properties row each edits. */
const TEARDROP_SETUP_ROWS: Record<string, string> = {
  bestLength: 'teardropBestLength',
  maxLength: 'teardropMaxLength',
  bestWidth: 'teardropBestWidth',
  maxWidth: 'teardropMaxWidth',
  trackWidthLimit: 'teardropMaxTrackWidth',
  curved: 'teardropCurved',
  twoSegments: 'teardropTwoSegments',
  preferZone: 'teardropPreferZone'
}
const TEARDROP_FIELD_OF: Record<string, keyof TeardropParams> = {
  bestLength: 'bestLengthRatio',
  maxLength: 'maxLength',
  bestWidth: 'bestWidthRatio',
  maxWidth: 'maxWidth',
  trackWidthLimit: 'filterRatio',
  curved: 'curvedEdges',
  twoSegments: 'allowTwoSegments',
  preferZone: 'preferZoneConnections'
}

/** Each Teardrops card's diagram (`boardSetupGlyphs.ts`). */
const TEARDROP_GLYPHS: Record<string, string> = {
  enabled: 'tdTrackToTrack',
  bestLength: 'tdLength',
  maxLength: 'tdLength',
  bestWidth: 'tdWidth',
  maxWidth: 'tdWidth',
  trackWidthLimit: 'tdTrackLimit',
  curved: 'tdCurved',
  twoSegments: 'tdTwoSegments',
  preferZone: 'tdZone'
}

export const TUNING_GROUPS: Readonly<Record<TuningMode, SettingGroup>> = {
  single: 'tuneSingle',
  pair: 'tunePair',
  skew: 'tuneSkew'
}

/** What Board Setup lays over its model: the custom rules, and a preset draft's marks. */
export interface SetupOverlay {
  rulesText?: string
  pending?: PresetPending
  /** Each layer's display color, for swatches. */
  layerColors?: Readonly<Record<string, string>>
}

export function buildBoardSetupSections(
  model: BoardSetupModel,
  t: Translate,
  /** What each profile row's geometry comes to (the solver); none leaves the readout blank. */
  readout?: (profile: TuningProfile, layer: TuningProfileLayer) => LayerReadout,
  /** The custom rules, and an interface preset draft's marks over every table. */
  overlay: SetupOverlay = {}
): BoardSetupSection[] {
  const { stackup: s, rules: r } = model
  const tr = (key: string): string => t(`boardSetup.${key}`)

  /**
   * A row. `blurb` is deliberately opt-in: the audience knows what a clearance
   * or a dielectric constant is, so a subtitle restating the term is noise. Pass
   * `blurb: true` only where the line says something the *product* decides —
   * a cost/lead-time consequence, a unit convention, what a default feeds.
   */
  const setting = (
    section: SectionId,
    key: string,
    glyph: string,
    editor: EditorDescriptor,
    value: PropertyValue,
    preview: PreviewKind,
    opts: { blurb?: boolean } = {}
  ): BoardSetting => ({
    key,
    section,
    label: tr(`${section}.${key}.label`),
    blurb: opts.blurb ? tr(`${section}.${key}.blurb`) : undefined,
    glyph,
    editor,
    value,
    preview
  })

  // Custom is always offered: picking it keeps the values as they are and
  // only stops naming a preset.
  const profileOptions = [
    ...model.profiles.map((p) => opt(p.id, profileLabel(p))),
    opt(CUSTOM_PRESET_ID, tr('profile.custom'))
  ]
  const stackupPresetOptions = [
    ...model.stackupPresets.map((p) => opt(p.id, p.name)),
    opt(CUSTOM_PRESET_ID, tr('profile.custom'))
  ]

  const stackup: BoardSetupSection = {
    id: 'stackup',
    title: tr('sections.stackup'),
    settings: [
      {
        key: 'stackupId',
        section: 'stackup',
        label: tr('stackup.preset.label'),
        editor: { kind: 'select', options: stackupPresetOptions },
        value: model.activeStackupId ?? CUSTOM_PRESET_ID,
        preview: 'stackup',
        isHeader: true
      },
      setting(
        'stackup',
        'copperLayers',
        'layers',
        { kind: 'select', options: COPPER_LAYER_COUNTS.map((n) => opt(String(n), String(n))) },
        String(s.copperLayers),
        'stackup'
      ),
      setting(
        'stackup',
        'copperFinish',
        'finish',
        select(COPPER_FINISHES),
        s.copperFinish ?? 'HASL',
        'stackup'
      )
    ],
    layers: buildStackupRows(model.layers, t)
  }

  /**
   * A constraint row off `model.rules`. Most are a distance; the editor is
   * overridable for the handful that are not (a spoke count, two toggles).
   */
  const rule = (
    key: keyof DesignRules,
    glyph: string,
    preview: PreviewKind,
    opts: { group?: SettingGroup; editor?: EditorDescriptor } = {}
  ): BoardSetting => ({
    ...setting('constraints', key, glyph, opts.editor ?? dist(), r[key], preview),
    ...(opts.group ? { group: opts.group } : {})
  })

  const constraints: BoardSetupSection = {
    id: 'constraints',
    title: tr('sections.constraints'),
    settings: [
      {
        key: 'profileId',
        section: 'constraints',
        label: tr('profile.name'),
        editor: { kind: 'select', options: profileOptions },
        value: model.activeProfileId ?? CUSTOM_PRESET_ID,
        preview: 'none',
        isHeader: true
      },
      // KiCad's Constraints page, in its order and its groupings.
      rule('minClearance', 'clearance', 'clearance', { group: 'copper' }),
      rule('minTrackWidth', 'trackWidth', 'trackWidth'),
      rule('minConnectionWidth', 'connection', 'trackWidth'),
      rule('minViaAnnularWidth', 'annular', 'annular'),
      rule('minViaDiameter', 'via', 'via'),
      rule('minCopperHoleClearance', 'holeClearance', 'clearance'),
      rule('minCopperEdgeClearance', 'edgeClearance', 'edgeClearance'),
      rule('minThroughHoleDiameter', 'hole', 'hole', { group: 'holes' }),
      rule('minHoleToHole', 'holeSpacing', 'holeSpacing'),
      rule('minMicroviaDiameter', 'microvia', 'via', { group: 'microvias' }),
      rule('minMicroviaDrill', 'microviaDrill', 'hole'),
      rule('minSilkClearance', 'silkClearance', 'silk', { group: 'silk' }),
      rule('minTextHeight', 'textHeight', 'silk'),
      rule('minTextThickness', 'textThickness', 'silk'),
      // Not fab limits but part of the same configuration — a preset carries
      // the whole constraint set, and KiCad keeps them on this page too.
      rule('maxError', 'arcError', 'arc', { group: 'arcs', editor: dist(0.001) }),
      rule('zonesAllowExternalFillets', 'zoneFillet', 'zone', {
        group: 'zones',
        editor: { kind: 'checkbox' }
      }),
      rule('minResolvedSpokes', 'spokes', 'zone', {
        // A count of spokes, not a length — a distance editor would offer mm.
        editor: { kind: 'number', step: 1, min: 0 }
      }),
      rule('useHeightForLengthCalcs', 'lengthTuning', 'stackup', {
        group: 'lengthTuning',
        editor: { kind: 'checkbox' }
      })
    ]
  }

  // KiCad's Length-tuning Patterns: each tuner's meander defaults, a group
  // apiece, keyed `mode.field`.
  const tuningGlyphs: Record<TuningField, string> = {
    minAmplitude: 'tuneAmplitude',
    maxAmplitude: 'tuneAmplitude',
    spacing: 'tuneSpacing',
    cornerRadiusPercent: 'tuneRadius',
    singleSided: 'tuneSides'
  }
  const tuningEditors: Record<TuningField, EditorDescriptor> = {
    minAmplitude: dist(),
    maxAmplitude: dist(),
    spacing: dist(),
    cornerRadiusPercent: { kind: 'number', step: 1, min: 0, max: 100 },
    singleSided: { kind: 'checkbox' }
  }
  const tuningPatterns: BoardSetupSection = {
    id: 'tuningPatterns',
    title: tr('sections.tuningPatterns'),
    settings: TUNING_MODES.flatMap((mode) =>
      TUNING_FIELDS.map((field, i): BoardSetting => ({
        key: `${mode}.${field}`,
        section: 'tuningPatterns',
        label: tr(`tuningPatterns.${field}.label`),
        glyph: tuningGlyphs[field],
        editor: tuningEditors[field],
        value: model.tuning[mode][field],
        preview: 'none',
        ...(i === 0 ? { group: TUNING_GROUPS[mode] } : {})
      }))
    )
  }

  // KiCad's Teardrops page: a block per shape, the track-to-track one with its switch.
  const percent: EditorDescriptor = { kind: 'number', unit: '%', step: 10, min: 0, max: 100 }
  const teardropRows = (shape: TeardropShape): BoardSetting[] => {
    const p = model.teardrops[shape]
    const row = (field: string, editor: EditorDescriptor, value: PropertyValue): BoardSetting => ({
      key: `${shape}.${field}`,
      section: 'teardrops',
      label: tr(`teardrops.${field}`),
      glyph: TEARDROP_GLYPHS[field],
      editor,
      value,
      preview: 'none'
    })
    const rows = [
      ...(shape === 'track' ? [row('enabled', { kind: 'checkbox' }, p.enabled)] : []),
      row('bestLength', { ...percent, max: undefined }, teardropRowValue(p, 'teardropBestLength')),
      row('maxLength', dist(), nmToMm(p.maxLength as Nm)),
      row('bestWidth', percent, teardropRowValue(p, 'teardropBestWidth')),
      row('maxWidth', dist(), nmToMm(p.maxWidth as Nm)),
      row('trackWidthLimit', percent, teardropRowValue(p, 'teardropMaxTrackWidth')),
      row('curved', { kind: 'checkbox' }, p.curvedEdges),
      row('twoSegments', { kind: 'checkbox' }, p.allowTwoSegments),
      ...(shape === 'track'
        ? []
        : [row('preferZone', { kind: 'checkbox' }, p.preferZoneConnections)])
    ]
    rows[0] = { ...rows[0], group: TEARDROP_GROUPS[shape] }
    return rows
  }
  const teardrops: BoardSetupSection = {
    id: 'teardrops',
    title: tr('sections.teardrops'),
    settings: TEARDROP_SHAPES.flatMap(teardropRows)
  }

  // A table, not cards: net classes are row-per-thing the way the stackup
  // layers are, and KiCad renders them as a table for the same reason — you
  // compare classes against each other, which columns do and cards do not.
  const netClasses: BoardSetupSection = {
    id: 'netClasses',
    title: tr('sections.netClasses'),
    settings: [],
    netClasses: buildNetClassRows(
      model.classes,
      t,
      model.tuningProfiles.map((p) => p.name)
    ).map((row) => ({
      ...row,
      ...(overlay.pending?.classes.get(row.name)
        ? { pending: overlay.pending.classes.get(row.name) }
        : {})
    })),
    netClassPatterns: buildPatternRows(model.classes, model.patterns, t).map((row) =>
      overlay.pending?.patterns.has(row.index) ? { ...row, pending: 'added' as const } : row
    ),
    ...buildExtraSizeRows(model.extraSizes, t)
  }

  const rules: BoardSetupSection = {
    id: 'rules',
    title: tr('sections.rules'),
    settings: [],
    rules: true
  }

  const exclusions: BoardSetupSection = {
    id: 'exclusions',
    title: tr('sections.exclusions'),
    settings: [],
    exclusions: true
  }

  // KiCad's Tuning Profiles: a block per profile, its layers a table.
  const tuningProfiles: BoardSetupSection = {
    id: 'tuningProfiles',
    title: tr('sections.tuningProfiles'),
    settings: [],
    tuningProfiles: buildTuningProfileBlocks(
      model,
      copperNamesFor(model.stackup.copperLayers),
      t,
      readout,
      overlay.layerColors
    ).map((block) =>
      overlay.pending?.profiles.get(block.name)
        ? { ...block, pending: overlay.pending.profiles.get(block.name) }
        : block
    )
  }

  // The project's custom rules, read only: what KiCad's Custom Rules holds.
  const read = customRuleRows(overlay.rulesText)
  const customRules: BoardSetupSection = {
    id: 'customRules',
    title: tr('sections.customRules'),
    settings: [],
    customRules: read.rows.map((row) =>
      overlay.pending?.rules.get(row.rule)
        ? { ...row, pending: overlay.pending.rules.get(row.rule) }
        : row
    ),
    customRuleErrors: read.errors
  }

  return [
    stackup,
    constraints,
    tuningPatterns,
    teardrops,
    tuningProfiles,
    netClasses,
    customRules,
    rules,
    exclusions
  ]
}

/** Options for a "which class" picker — every class currently defined. */
export const netClassOptions = (classes: readonly NetClass[]): SelectOption[] =>
  classes.map((netClass) => ({
    ...opt(netClass.name, netClass.name),
    ...(netClass.pcbColor ? { color: cssColor(netClass.pcbColor) } : {})
  }))

function schematicCells(
  netClass: NetClass,
  fallback: NetClass | undefined,
  t: Translate
): Record<SchematicClassColumn, PropertyField> {
  // An empty cell shows what it inherits: Default's, else KiCad's own; on
  // Default (no fallback), KiCad's own.
  const label = (column: SchematicClassColumn): string => t(`boardSetup.netClassColumns.${column}`)
  const width = (column: 'wireWidth' | 'busWidth'): PropertyField => ({
    key: column,
    label: label(column),
    editor: {
      ...dist(),
      optional: true,
      placeholderValue: fallback?.[column] ?? SCHEMATIC_CLASS_DEFAULTS[column]
    },
    value: netClass[column] ?? null
  })
  const styles = STROKE_TYPE_OPTIONS.filter((o) => o.value !== 'default')
  const inheritedStyle = fallback?.lineStyle ?? SCHEMATIC_CLASS_DEFAULTS.lineStyle
  return {
    wireWidth: width('wireWidth'),
    busWidth: width('busWidth'),
    schematicColor: {
      key: 'schematicColor',
      label: label('schematicColor'),
      editor: {
        kind: 'color',
        // Default's color where it has one, else the theme's wire color.
        placeholder: fallback?.schematicColor
          ? DEFAULT_CLASS_NAME
          : t('boardSetup.netClasses.themeColor')
      },
      value: netClass.schematicColor ?? null
    },
    lineStyle: {
      key: 'lineStyle',
      label: label('lineStyle'),
      editor: {
        kind: 'select',
        optional: true,
        options: [
          opt('', styles.find((o) => o.value === inheritedStyle)?.label ?? inheritedStyle),
          ...styles
        ]
      },
      value: netClass.lineStyle ?? ''
    }
  }
}

export function buildNetClassRows(
  classes: readonly NetClass[],
  t: Translate,
  /** The project's tuning profiles, which the Tuning profile column offers. */
  profileNames: readonly string[] = []
): NetClassRow[] {
  const profileOptions = [
    { value: '', label: t('boardSetup.tuningProfiles.none') },
    ...profileNames.map((name) => ({ value: name, label: name }))
  ]
  const defaultClass = classes.find((c) => c.name === DEFAULT_CLASS_NAME)
  return classes.map((netClass, index) => {
    const isDefault = netClass.name === DEFAULT_CLASS_NAME
    const cell = (column: NetClassColumn): PropertyField => ({
      key: column,
      label: t(`boardSetup.netClassColumns.${column}`),
      editor: dist(),
      value: netClass[column]
    })
    return {
      index,
      name: netClass.name,
      isDefault,
      nameCell: {
        key: 'name',
        label: t('boardSetup.netClassColumns.name'),
        editor: { kind: 'text' },
        value: netClass.name,
        // Every unassigned net falls back to Default by that exact name, and
        // KiCad looks it up by string — renaming it would orphan them all.
        readonly: isDefault
      },
      schematicCells: schematicCells(netClass, isDefault ? undefined : defaultClass, t),
      colorCell: {
        key: 'pcbColor',
        label: t('boardSetup.netClassColumns.pcbColor'),
        editor: { kind: 'color', placeholder: t('boardSetup.netClasses.layerColor') },
        value: netClass.pcbColor ?? null,
        readonly: isDefault
      },
      profileCell: {
        key: 'tuningProfile',
        label: t('boardSetup.netClassColumns.tuningProfile'),
        // A class may name a profile the project lacks (DRC's missing_tuning_profile): kept, shown.
        editor: {
          kind: 'select',
          options:
            netClass.tuningProfile && !profileNames.includes(netClass.tuningProfile)
              ? [
                  ...profileOptions,
                  { value: netClass.tuningProfile, label: netClass.tuningProfile }
                ]
              : profileOptions
        },
        value: netClass.tuningProfile ?? ''
      },
      cells: {
        clearance: cell('clearance'),
        trackWidth: cell('trackWidth'),
        viaDiameter: cell('viaDiameter'),
        viaDrill: cell('viaDrill'),
        microviaDiameter: cell('microviaDiameter'),
        microviaDrill: cell('microviaDrill'),
        diffPairWidth: cell('diffPairWidth'),
        diffPairGap: cell('diffPairGap')
      }
    }
  })
}

export function buildExtraSizeRows(
  sizes: BoardSetupModel['extraSizes'],
  t: Translate
): Pick<BoardSetupSection, 'extraTracks' | 'extraVias'> {
  const cell = (key: ExtraSizeField, value: number): PropertyField => ({
    key,
    label: t(`boardSetup.extraSizes.${key}`),
    editor: dist(),
    value
  })
  return {
    extraTracks: sizes.tracks.map((width, index) => ({
      kind: 'track',
      index,
      cells: [cell('width', width)]
    })),
    extraVias: sizes.vias.map((via, index) => ({
      kind: 'via',
      index,
      cells: [cell('diameter', via.diameter), cell('drill', via.drill)]
    }))
  }
}

export function buildPatternRows(
  classes: readonly NetClass[],
  patterns: readonly NetClassPattern[],
  t: Translate
): NetClassPatternRow[] {
  const options = netClassOptions(classes)
  const names = new Set(classes.map((c) => c.name))
  return patterns.map((pattern, index) => ({
    index,
    pattern: pattern.pattern,
    netClass: pattern.netClass,
    patternCell: {
      key: 'pattern',
      label: t('boardSetup.patternColumns.pattern'),
      // Syntax, not prose: the one example that says wildcards work.
      editor: { kind: 'text', placeholder: '/USB_*' },
      value: pattern.pattern
    },
    classCell: {
      key: 'netClass',
      label: t('boardSetup.patternColumns.netClass'),
      // A dangling pattern keeps its own name in the list, so the row shows
      // what it points at instead of silently snapping to another class.
      editor: {
        kind: 'select',
        tags: true,
        options: names.has(pattern.netClass)
          ? options
          : [...options, opt(pattern.netClass, pattern.netClass)]
      },
      value: pattern.netClass
    },
    dangling: !names.has(pattern.netClass)
  }))
}

// ---------------------------------------------------------------------------
// Laying the cards out in columns
// ---------------------------------------------------------------------------

/** A labelled run of consecutive settings — one category's worth. */
export interface SettingRun {
  /** The group that opens the run; absent for a section with no groupings. */
  group?: SettingGroup
  /** Indices into the settings array this was built from. */
  indices: number[]
}

/** Cut settings into their labelled runs. A run starts at a card with `group`. */
export function settingRuns(settings: readonly BoardSetting[]): SettingRun[] {
  const runs: SettingRun[] = []
  settings.forEach((setting, index) => {
    if (setting.group || runs.length === 0) {
      runs.push({ group: setting.group, indices: [] })
    }
    runs[runs.length - 1].indices.push(index)
  })
  return runs
}

/**
 * A heading takes real vertical space, but less than a card's. Weighting it
 * rather than counting it keeps a column of five small categories from towering
 * over a column holding one big one.
 */
const HEADING_WEIGHT = 0.6

const runWeight = (run: SettingRun): number => run.indices.length + (run.group ? HEADING_WEIGHT : 0)

/**
 * Split runs across two columns, **whole runs only**.
 *
 * A category is a unit: its settings read straight down, and a run broken
 * across the column boundary would have you reading up and over mid-category.
 * So the balance is struck between categories, never within one. Runs are taken
 * in order and each goes left while more of it would sit in the first half than
 * the second, which keeps the reading order "down column one, then column two".
 *
 * Returns a single column when there is nothing to split — the caller renders
 * whatever it gets, and CSS decides whether two columns sit side by side.
 */
export function balanceRuns(runs: SettingRun[]): SettingRun[][] {
  if (runs.length < 2) return [runs]

  const half = runs.reduce((sum, run) => sum + runWeight(run), 0) / 2
  const left: SettingRun[] = []
  const right: SettingRun[] = []
  let filled = 0
  for (const run of runs) {
    const weight = runWeight(run)
    // Once anything has gone right, everything after it must too, or the
    // reading order breaks.
    if (right.length === 0 && filled + weight / 2 <= half) {
      left.push(run)
      filled += weight
    } else {
      right.push(run)
    }
  }
  return right.length ? [left, right] : [left]
}

const asNumber = (value: PropertyEditValue): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

const asString = (value: PropertyEditValue): string => (typeof value === 'string' ? value : '')

const asBoolean = (value: PropertyEditValue): boolean => value === true

/**
 * Fold one edit into the model. Returns a new model — the host decides what to
 * persist from the diff (a `stackup` change writes the board, a `constraints` or
 * `routing` change writes the project file).
 */
export function applyBoardSetupEdit(
  model: BoardSetupModel,
  section: string,
  key: string,
  value: PropertyEditValue
): BoardSetupModel {
  if (section === 'stackup') {
    const stackup = { ...model.stackup }
    if (key === 'copperLayers') {
      stackup.copperLayers = nearestCopperLayerCount(asNumber(value))
    } else if (key === 'copperFinish') {
      stackup.copperFinish = asString(value)
    } else {
      // Everything else in the stackup is per layer now — see stackupLayerPatch.
      return model
    }
    return { ...model, stackup, edited: true }
  }

  if (section === 'tuningPatterns') {
    const [mode, field] = key.split('.') as [TuningMode, TuningField]
    const current = model.tuning[mode]
    if (!current || !TUNING_FIELDS.includes(field)) return model
    const next: TuningPatternDefaults =
      field === 'singleSided'
        ? { ...current, singleSided: asBoolean(value) }
        : { ...current, [field]: Math.max(0, asNumber(value)) }
    // The largest amplitude never under the least, as the in-tool form holds it.
    if (field === 'minAmplitude') next.maxAmplitude = Math.max(next.maxAmplitude, next.minAmplitude)
    if (field === 'maxAmplitude') next.minAmplitude = Math.min(next.minAmplitude, next.maxAmplitude)
    if (field === 'cornerRadiusPercent')
      next.cornerRadiusPercent = Math.min(100, next.cornerRadiusPercent)
    return { ...model, tuning: { ...model.tuning, [mode]: next } }
  }

  if (section === 'teardrops') {
    const [shape, field] = key.split('.') as [TeardropShape, string]
    const current = model.teardrops[shape]
    if (!current) return model
    const rowKey = TEARDROP_SETUP_ROWS[field]
    const next =
      field === 'enabled'
        ? { ...current, enabled: asBoolean(value) }
        : rowKey
          ? teardropRowEdit(
              current,
              rowKey,
              typeof current[TEARDROP_FIELD_OF[field]] === 'boolean'
                ? asBoolean(value)
                : field === 'maxLength' || field === 'maxWidth'
                  ? mmToNm(Math.max(0, asNumber(value)))
                  : Math.max(0, asNumber(value))
            )
          : null
    if (!next) return model
    const teardrops = { ...model.teardrops, [shape]: next }
    if (shape === 'track') teardrops.targets = { ...teardrops.targets, trackToTrack: next.enabled }
    return { ...model, teardrops }
  }

  if (section === 'constraints' && key in model.rules) {
    // Most constraints are numbers, two are toggles. Coerce to whatever the
    // field already holds, so a checkbox never lands in the file as 0/1.
    const current = model.rules[key as keyof DesignRules]
    const next = typeof current === 'boolean' ? asBoolean(value) : asNumber(value)
    const rules = { ...model.rules, [key]: next }
    return { ...model, rules, edited: true }
  }

  return model
}

// ---------------------------------------------------------------------------
// Net class edits
//
// Each returns a new model, or the SAME model when the edit is a no-op or is
// not allowed — the host treats identity as "nothing to persist".
// ---------------------------------------------------------------------------

/** A name no existing class uses, so two classes can never collide. */
function uniqueClassName(classes: readonly NetClass[], wanted: string): string {
  const taken = new Set(classes.map((c) => c.name))
  if (!taken.has(wanted)) return wanted
  for (let n = 2; ; n++) {
    const candidate = `${wanted} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** What the net class edits read and write: Board Setup's model, or Schematic Setup's classes and patterns. */
export type NetClassModel = Pick<BoardSetupModel, 'classes' | 'patterns' | 'edited'>

/** Edit one cell of one class. Renaming carries its patterns with it. */
export function editNetClass<M extends NetClassModel>(
  model: M,
  index: number,
  column: NetClassEditColumn,
  value: PropertyEditValue
): M {
  const target = model.classes[index]
  if (!target) return model

  if (
    column === 'schematicColor' ||
    column === 'wireWidth' ||
    column === 'busWidth' ||
    column === 'lineStyle'
  ) {
    const edited: NetClass = { ...target }
    if (column === 'schematicColor') {
      if (isRgba(value) && value.a > 0) edited.schematicColor = value
      else delete edited.schematicColor
    } else if (column === 'lineStyle') {
      const style = CLASS_LINE_STYLES.find((s) => s === value)
      if (style) edited.lineStyle = style
      else delete edited.lineStyle
    } else {
      const mm = value === null || value === '' ? null : asNumber(value)
      if (mm !== null && mm > 0) edited[column] = mm
      else delete edited[column]
    }
    return {
      ...model,
      classes: model.classes.map((c, i) => (i === index ? edited : c)),
      edited: true
    }
  }

  if (column === 'tuningProfile') {
    const name = asString(value)
    if (name === (target.tuningProfile ?? '')) return model
    const edited: NetClass = { ...target }
    if (name) edited.tuningProfile = name
    else delete edited.tuningProfile
    return {
      ...model,
      classes: model.classes.map((c, i) => (i === index ? edited : c)),
      edited: true
    }
  }

  if (column === 'pcbColor') {
    if (target.name === DEFAULT_CLASS_NAME) return model
    const color = isRgba(value) && value.a > 0 ? value : null
    const classes = model.classes.map((c, i) => {
      if (i !== index) return c
      const edited: NetClass = { ...c }
      if (color) edited.pcbColor = color
      else delete edited.pcbColor
      return edited
    })
    return { ...model, classes, edited: true }
  }

  if (column === 'name') {
    // Default is what unassigned nets fall back to, by that exact string.
    if (target.name === DEFAULT_CLASS_NAME) return model
    const wanted = asString(value).trim()
    if (!wanted || wanted === target.name) return model
    const name = uniqueClassName(
      model.classes.filter((_, i) => i !== index),
      wanted
    )
    const classes = model.classes.map((c, i) => (i === index ? { ...c, name } : c))
    // Patterns address a class by name, so a rename that did not carry them
    // would silently unassign every net the class routed.
    const patterns = model.patterns.map((p) =>
      p.netClass === target.name ? { ...p, netClass: name } : p
    )
    return { ...model, classes, patterns, edited: true }
  }

  // A value typed in is the class's own from now on, not Default's.
  const classes = model.classes.map((c, i) => {
    if (i !== index) return c
    const edited: NetClass = { ...c, [column]: asNumber(value) }
    const unset = c.unset?.filter((field) => field !== column)
    if (unset?.length) edited.unset = unset
    else delete edited.unset
    return edited
  })
  return { ...model, classes, edited: true }
}

/**
 * KiCad's "Import colors from schematic" (Board Setup's net classes): each
 * class's schematic color becomes its PCB color, Default's aside, which stays
 * the layer's. A class with no schematic color keeps its PCB color.
 */
export function importSchematicColors<M extends NetClassModel>(model: M): M {
  let changed = false
  const classes = model.classes.map((c) => {
    if (c.name === DEFAULT_CLASS_NAME || !c.schematicColor) return c
    changed = true
    return { ...c, pcbColor: c.schematicColor }
  })
  return changed ? { ...model, classes, edited: true } : model
}

/** Add a class, seeded from Default so it starts manufacturable. */
export function addNetClass<M extends NetClassModel>(model: M, name: string): M {
  const seed = model.classes.find((c) => c.name === DEFAULT_CLASS_NAME) ?? model.classes[0]
  if (!seed) return model
  // It outranks Default and ranks below the classes already there, as the writer numbers it.
  const priorities = model.classes
    .filter((c) => c.name !== DEFAULT_CLASS_NAME)
    .map((c, i) => c.priority ?? i + 1)
  const netClass: NetClass = {
    ...seed,
    name: uniqueClassName(model.classes, name),
    priority: priorities.length ? Math.max(...priorities) + 1 : 0
  }
  delete netClass.unset
  delete netClass.sources
  // Colors and schematic styling are the class's own choice, not Default's copied.
  for (const key of ['pcbColor', 'schematicColor', 'wireWidth', 'busWidth', 'lineStyle'] as const)
    delete netClass[key]
  return { ...model, classes: [...model.classes, netClass], edited: true }
}

/**
 * Remove a class, and every pattern that routed nets into it — a pattern
 * naming a class that no longer exists is config KiCad cannot honor, so it goes
 * with the class rather than being left dangling in the file.
 */
export function removeNetClass<M extends NetClassModel>(model: M, index: number): M {
  const target = model.classes[index]
  if (!target || target.name === DEFAULT_CLASS_NAME) return model
  return {
    ...model,
    classes: model.classes.filter((_, i) => i !== index),
    patterns: model.patterns.filter((p) => p.netClass !== target.name),
    edited: true
  }
}

export function editNetClassPattern<M extends NetClassModel>(
  model: M,
  index: number,
  field: 'pattern' | 'netClass',
  value: PropertyEditValue
): M {
  if (!model.patterns[index]) return model
  const next = asString(value)
  const patterns = model.patterns.map((p, i) => (i === index ? { ...p, [field]: next } : p))
  return { ...model, patterns, edited: true }
}

/** A blank pattern row, aimed at Default until the user points it somewhere. */
export function addNetClassPattern<M extends NetClassModel>(model: M): M {
  const netClass = model.classes.find((c) => c.name !== DEFAULT_CLASS_NAME) ?? model.classes[0]
  if (!netClass) return model
  return {
    ...model,
    patterns: [...model.patterns, { pattern: '', netClass: netClass.name }],
    edited: true
  }
}

export function removeNetClassPattern<M extends NetClassModel>(model: M, index: number): M {
  if (!model.patterns[index]) return model
  return { ...model, patterns: model.patterns.filter((_, i) => i !== index), edited: true }
}

/** One extra size's cell. A size must be positive and a via's drill smaller than it. */
export function editExtraSize(
  model: BoardSetupModel,
  kind: 'track' | 'via',
  index: number,
  field: ExtraSizeField,
  value: PropertyEditValue
): BoardSetupModel {
  const next = asNumber(value)
  if (!(next > 0)) return model
  const { tracks, vias } = model.extraSizes
  if (kind === 'track') {
    if (index >= tracks.length || field !== 'width') return model
    return {
      ...model,
      extraSizes: { tracks: tracks.map((w, i) => (i === index ? next : w)), vias }
    }
  }
  const via = vias[index]
  if (!via || field === 'width') return model
  const edited = { ...via, [field]: next }
  if (edited.drill >= edited.diameter) return model
  return { ...model, extraSizes: { tracks, vias: vias.map((v, i) => (i === index ? edited : v)) } }
}

/** A new extra size, seeded from Default's. */
export function addExtraSize(model: BoardSetupModel, kind: 'track' | 'via'): BoardSetupModel {
  const base = defaultNetClass(model.classes)
  const { tracks, vias } = model.extraSizes
  return kind === 'track'
    ? { ...model, extraSizes: { tracks: [...tracks, base.trackWidth], vias } }
    : {
        ...model,
        extraSizes: {
          tracks,
          vias: [...vias, { diameter: base.viaDiameter, drill: base.viaDrill }]
        }
      }
}

export function removeExtraSize(
  model: BoardSetupModel,
  kind: 'track' | 'via',
  index: number
): BoardSetupModel {
  const { tracks, vias } = model.extraSizes
  if (kind === 'track' ? index >= tracks.length : index >= vias.length) return model
  return kind === 'track'
    ? { ...model, extraSizes: { tracks: tracks.filter((_, i) => i !== index), vias } }
    : { ...model, extraSizes: { tracks, vias: vias.filter((_, i) => i !== index) } }
}

/**
 * Map one layer-table cell edit onto a KicadStackupLayer patch. Null for a cell
 * that carries no value (an unmatched copper weight, a cleared select), so the
 * caller can skip the command rather than write a meaningless field.
 */
export function stackupLayerPatch(
  column: StackupColumn,
  value: PropertyEditValue
): Partial<Omit<KicadStackupLayer, 'name' | '_raw'>> | null {
  switch (column) {
    case 'thickness':
      // The cell's model unit is nm, so the committed number already is.
      return { thickness: nm(asNumber(value)) }
    case 'weight': {
      // Weight is the industry unit; the file stores the thickness it implies.
      const mm = thicknessForWeight(asString(value))
      return mm === null ? null : { thickness: mmToNm(mm) }
    }
    case 'type':
      return { type: asString(value) }
    case 'material':
      return { material: asString(value) }
    case 'epsilonR':
      return { epsilonR: asNumber(value) }
    case 'lossTangent':
      return { lossTangent: asNumber(value) }
    case 'color':
      return { color: asString(value) }
    default:
      return null
  }
}
