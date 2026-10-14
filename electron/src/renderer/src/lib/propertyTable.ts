import {
  NM_PER_MM,
  formatNanometersToUnit,
  parseValueToNanometers,
  type LengthUnit
} from './kicad/coordinates'
import type { IconName } from './icons'

// Data contract for the generic right-bar property editor (PropertyTable.vue).
//
// A host editor builds an array of PropertyGroups from its current selection —
// one group per KiCad AST primitive type (a "Pin" group, a "Rectangle" group,
// …) — and hands them to PropertyTable, which renders a label + editor row per
// field and emits a single `edit(groupType, key, value)` back. The component
// knows nothing about the AST, units, or the selection; the host resolves those.
//
// Multi-selection: a group covers every selected item of its type. When those
// items disagree on a field, its value is the MIXED sentinel (rendered `‹…›`),
// and editing the field sets all of them. This mirrors the string|null "mixed"
// model already used by the components table (lib/componentsTable.ts).

/** Sentinel: the selected items of a group disagree on this field's value. */
export const MIXED = Symbol('mixed')
export type Mixed = typeof MIXED

export const isMixed = (value: unknown): value is Mixed => value === MIXED

// Every cell is one Key + one Value (strictly tabular). text/number are plain;
// distance/angle/color carry special behavior the widget owns (unit conversion,
// cardinal snap, RGBA picking) so no host reinvents it. A multi-scalar S-expr
// property like `(at x y)` maps to SEPARATE rows (X, Y) — never a combined cell.
// `segmented` is a `select` shown as a horizontal all-options-visible toggle —
// reserved for short 2–3 option sets (unit, fill, alignment); Enter cycles.
// `multiselect` picks any number of its options, at least one: its value is
// the chosen option values comma-joined, in option order.
export type EditorKind =
  | 'text'
  | 'number'
  | 'select'
  | 'segmented'
  | 'multiselect'
  | 'checkbox'
  | 'distance'
  | 'angle'
  | 'color'

export interface SelectOption {
  value: string
  /** Pre-localized display label (the host resolves i18n before building). */
  label: string
  /** In a `tags` list, an entry that is not a class ("New class…"): plain text, not a tag. */
  plain?: boolean
  /** Optional swatch color (CSS string) drawn beside the option — e.g. a layer. */
  color?: string
  /** segmented: a glyph name (lib/propertyGlyphs) shown instead of the label. */
  icon?: string
}

/** How a field's value cell renders and validates. */
export interface EditorDescriptor {
  kind: EditorKind
  /** number: a unit suffix (mm/deg/…) shown inside the input. */
  unit?: string
  step?: number
  min?: number
  max?: number
  /** select: the localized options. */
  options?: SelectOption[]
  /** select: render as a searchable/filterable list (long net lists). */
  searchable?: boolean
  /**
   * text: commit exactly what was typed. A text cell trims its ENDS by default,
   * since nearly every string here is an identifier something else must match
   * exactly; drawn text (`(text …)`, `(text_box …)`, `(fp_text …)`) opts out,
   * because padding a label to clear a pin is deliberate. See DESIGN.md.
   */
  skipTrim?: boolean
  /**
   * text: commit on Enter (or the host's own confirm) only; leaving the field
   * abandons it, as Escape does. The exception to RULES.md §6 for a name
   * prompt, where clicking away is not consent to create something.
   */
  commitOnEnter?: boolean
  /** distance: negate the value on display + commit (KiCad Y-down → up). */
  negate?: boolean
  /**
   * distance: the unit the MODEL stores. The schematic/symbol domain holds
   * integer nanometers; the board/footprint domain still holds millimeters
   * until stage 2 of the coordinate-units migration retires this flag and
   * `'nm'` becomes the only case. Display is unaffected — both format to the
   * grid unit.
   */
  model?: 'mm' | 'nm'
  /**
   * number / distance / select: the value may be unset (`null`, a select's `''`
   * option), shown as an empty cell and committed by clearing it — KiCad's
   * "blank inherits" local overrides.
   */
  optional?: boolean
  /** What an empty optional, text or color cell shows in place of a value. */
  placeholder?: string
  /**
   * distance: what an empty optional cell inherits, in the model's unit, shown
   * muted in the display unit where a value would be. Wins over `placeholder`.
   */
  placeholderValue?: number
  /** select: the options are net classes, each shown as a tag (DESIGN.md, Net class tags). */
  tags?: boolean
  /** angle: restrict/snap to the four cardinal orientations (0/90/180/270). */
  cardinal?: boolean
  /**
   * angle: the model-stored multiple, e.g. `10` when the raw field value is
   * tenths of a degree. Display divides, commit multiplies. Omit when the field
   * value is already in real degrees (the usual case — most parsers convert).
   */
  scale?: number
}

/**
 * KiCad's stroke styles, shared by every schema that edits a graphic outline.
 * One list because the values are the file format's, not any editor's — the
 * symbol editor and the footprint editor must offer exactly the same six.
 */
export const STROKE_TYPE_OPTIONS: SelectOption[] = [
  { value: 'default', label: 'Default' },
  { value: 'solid', label: 'Solid' },
  { value: 'dash', label: 'Dash' },
  { value: 'dot', label: 'Dot' },
  { value: 'dash_dot', label: 'Dash-dot' },
  { value: 'dash_dot_dot', label: 'Dash-dot-dot' }
]

/**
 * Text justification segments, shared by every schema that edits text effects —
 * the footprint editor's text rows and the symbol editor's. Alignment is one
 * concept with one set of choices; two copies would be two chances to disagree
 * about which glyph or which value means "center".
 *
 * Icon segments, so the label is the accessible name rather than the visible one.
 * The labels are English literals here, as the footprint schema's option sets
 * have always been — the localization gap is real but predates this and is not
 * worth half-closing for one field.
 */
export const H_ALIGN_OPTIONS: SelectOption[] = [
  { value: 'left', label: 'Left', icon: 'align-left' },
  { value: 'center', label: 'Center', icon: 'align-center' },
  { value: 'right', label: 'Right', icon: 'align-right' }
]
export const V_ALIGN_OPTIONS: SelectOption[] = [
  { value: 'top', label: 'Top', icon: 'align-top' },
  { value: 'center', label: 'Center', icon: 'align-middle' },
  { value: 'bottom', label: 'Bottom', icon: 'align-bottom' }
]

/** RGBA color, mirrored from lib/kicad/color to keep this contract editor-agnostic. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** Contextual option sources a host passes to schema builders (layers/nets). */
export interface SchemaContext {
  layers?: SelectOption[]
  nets?: SelectOption[]
}

/** Every value a field can hold (color null = unset/inherit). */
export type PropertyValue = string | number | boolean | Rgba | null | Mixed

/** Every value the edit event can carry back to the host. */
export type PropertyEditValue = string | number | boolean | Rgba | null

export interface PropertyField {
  /** Stable key echoed back in the edit event (e.g. 'x', 'strokeWidth'). */
  key: string
  /** Central-registry key resolved via t(`shared.properties.<labelKey>`). */
  labelKey?: string
  /** Explicit label; wins over labelKey when present. */
  label?: string
  editor: EditorDescriptor
  /** Current value; MIXED when the selection disagrees. */
  value: PropertyValue
  readonly?: boolean
  /** Localized note under the row — a value that is allowed but worth a second look. */
  warning?: string
  /** What set the bound the warning names, after it: a net class as its tag, else a rule's name. */
  warningSource?: WarningSource
  /** Buttons on this row, echoed back as action events with the field's key. */
  actions?: PropertyAction[]
  /**
   * The subheading this row sits under inside its group, KiCad's property
   * groups ("Text Properties", "Overrides"): rows with none come first, as
   * KiCad's basic rows do. `inSection` tags a run of rows.
   */
  section?: PropertySection
  /** What the visual diff saw happen to this row (`diffPropertyGroups`). */
  change?: PropertyChange
  /** A `changed` row as the old version had it. */
  was?: PropertyField
}

/**
 * Who set a warned bound, as the rules name it: a net class (shown as its tag,
 * DESIGN.md Net class tags), a custom rule (its name in mono), or anything else
 * (`board minimum`), as text.
 */
export type WarningSource =
  | { kind: 'netClass'; name: string; color?: string }
  | { kind: 'rule'; name: string }
  | { kind: 'text'; text: string }

/** A row or group the old version lacked, the new one lacks, or the two disagree on. */
export type PropertyChange = 'added' | 'removed' | 'changed'

/**
 * The subheadings a group's rows fall under, resolved through
 * `shared.propertySections.<key>` — KiCad's own property groups, named once.
 */
export type PropertySection =
  | 'text'
  | 'shape'
  | 'fill'
  | 'border'
  | 'margins'
  | 'pad'
  | 'hole'
  | 'via'
  | 'fields'
  | 'attributes'
  | 'overrides'
  | 'keepout'
  | 'islands'
  | 'thermal'
  | 'pinDisplay'
  | 'units'
  | 'length'
  | 'teardrops'

/** Put a run of rows under one subheading. */
export const inSection = (section: PropertySection, fields: PropertyField[]): PropertyField[] =>
  fields.map((field) => ({ ...field, section }))

/** A button on a group's section header (`PropertyGroup.actions`) or on one row
 *  (`PropertyField.actions`). */
export interface PropertyAction {
  /** Echoed back in the action event ('addAlternate', 'remove'). */
  id: string
  /** Localized tooltip. */
  label: string
  /** The button's glyph. One of `icon` or `text` is required. */
  icon?: IconName
  /** Localized text rendered INSTEAD of an icon, when no glyph carries the meaning. */
  text?: string
  /**
   * Shown but not pressable. A row action that comes and goes is a row that
   * changes width as you work it, so an action that does not apply right now
   * dims in place rather than leaving.
   */
  disabled?: boolean
  /** Changes nothing (opens a link, reveals a file), so a read-only file keeps it. */
  readOnlySafe?: boolean
}

export interface PropertyGroup {
  /** AST primitive category echoed back as edit(groupType, …): 'pin', 'rectangle', … */
  type: string
  /**
   * Unique render key, for schemas that emit SEVERAL groups of one type (one per
   * alternate pin function). Falls back to `type`, which is unique everywhere
   * else. Also echoed back with an action, so the host knows which one was hit.
   */
  id?: string
  /** Localized section header ("Pin", "Rectangle"). */
  title: string
  /** How many selected items this group covers (for a "Rectangle (3)" header). */
  count: number
  fields: PropertyField[]
  actions?: PropertyAction[]
  /**
   * The groups a selection group stands for (`intersectGroups`): an edit to
   * one of its fields is the same edit to each of them.
   */
  members?: Array<{ type: string; id?: string }>
  /** What the visual diff saw happen to the item the group describes. */
  change?: PropertyChange
}

/**
 * Collapse N members' value for one field into a concrete value, or MIXED when
 * they disagree. Strict equality matches the primitives properties carry
 * (numbers, strings, booleans) — the same rule componentsTable.ts uses.
 */
export function collapseValue<T, V>(
  members: T[],
  read: (member: T) => V,
  eq: (a: V, b: V) => boolean = (a, b) => a === b
): V | Mixed {
  if (members.length === 0) return MIXED
  const first = read(members[0])
  return members.every((m) => eq(read(m), first)) ? first : MIXED
}

/** Value-equality for RGBA (or null) so multi-select color rows collapse correctly. */
export function rgbaEq(a: Rgba | null, b: Rgba | null): boolean {
  if (a === null || b === null) return a === b
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a
}

/**
 * The row the keyboard cursor moves to. Clamps to the ends (no wrap, matching
 * KiCad's inspector); extracted so the navigation math is testable without a DOM.
 */
export function nextRowIndex(current: number, delta: 1 | -1, rowCount: number): number {
  if (rowCount <= 0) return 0
  return Math.max(0, Math.min(rowCount - 1, current + delta))
}

// ---------------------------------------------------------------------------
// Pure value conversions for the special editor kinds — DOM-free so the format/
// parse/negate/snap logic is unit-tested directly (PropertyTable.vue wires them).
// ---------------------------------------------------------------------------

export type DistanceUnit = LengthUnit

/**
 * Format a model distance (mm) for display in the chosen unit, negating first
 * when the field is Y-down. nm-safe: routes through integer nanometers.
 */
export function formatDistance(mm: number, unit: DistanceUnit, negate = false): string {
  return formatNanometersToUnit(Math.round((negate ? -mm : mm) * NM_PER_MM), unit)
}

/**
 * Parse a distance input back to the model number (mm), honoring an explicit
 * `mm`/`mil` suffix and the field's default unit, then un-negating. Returns null
 * on unparseable input so the caller can leave the value unchanged.
 */
export function parseDistance(raw: string, unit: DistanceUnit, negate = false): number | null {
  if (raw.trim() === '') return null // empty leaves the value unchanged, not 0
  try {
    const mm = parseValueToNanometers(raw, unit) / NM_PER_MM
    return negate ? -mm : mm
  } catch {
    return null
  }
}

/** `formatDistance` for a model that stores integer nanometers. */
export function formatDistanceNm(value: number, unit: DistanceUnit, negate = false): string {
  return formatNanometersToUnit(negate ? -value : value, unit)
}

/** `parseDistance` for a model that stores integer nanometers. */
export function parseDistanceNm(raw: string, unit: DistanceUnit, negate = false): number | null {
  if (raw.trim() === '') return null // empty leaves the value unchanged, not 0
  try {
    const nm = parseValueToNanometers(raw, unit)
    return negate ? -nm : nm
  } catch {
    return null
  }
}

/** Normalize any degree value into [0, 360). */
export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** Snap a degree value to the nearest cardinal orientation (0/90/180/270). */
export function snapCardinal(deg: number): number {
  return (Math.round(normalizeAngle(deg) / 90) * 90) % 360
}

/** Format a model angle (real degrees) for display, dividing out an optional scale. */
export function formatAngle(deg: number, scale = 1): string {
  return parseFloat((deg / scale).toFixed(4)).toString()
}

/**
 * Parse an angle input to the model value: normalize, optionally snap to a
 * cardinal, then multiply by the storage scale. Returns null on bad input.
 */
export function parseAngle(raw: string, scale = 1, cardinal = false): number | null {
  const n = Number(raw.trim())
  if (raw.trim() === '' || Number.isNaN(n)) return null
  const norm = cardinal ? snapCardinal(n) : normalizeAngle(n)
  return norm * scale
}

const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

/** `#rrggbb` for an RGBA (alpha is carried separately for the picker). */
export function rgbaToHex(c: Rgba): string {
  const h = (n: number): string => clampByte(n).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

/** Parse `#rrggbb` into an RGBA, keeping the supplied alpha. */
export function hexToRgba(hex: string, alpha = 1): Rgba {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { r: 0, g: 0, b: 0, a: alpha }
  const int = parseInt(m[1], 16)
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: alpha }
}

/** The group a mixed selection shows (`intersectGroups`); its edits go to each member group. */
export const SELECTION_GROUP = 'selection'

/**
 * An empty group for each selected item type a schema has no rows for, so the
 * panel says it has nothing to edit there instead of falling back to the root
 * group (the board, the footprint) or going blank — either of which reads as
 * the panel ignoring the selection. PropertyTable shows a fieldless group as
 * "No properties to edit".
 */
export function placeholderGroups(
  selected: ReadonlyArray<{ type: string }>,
  handled: ReadonlySet<string>,
  t: (key: string) => string
): PropertyGroup[] {
  const counts = new Map<string, number>()
  for (const { type } of selected) {
    if (!handled.has(type)) counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts].map(([type, count]) => ({
    type,
    title: t('shared.properties.selection'),
    count,
    fields: []
  }))
}

const sameEditor = (a: EditorDescriptor, b: EditorDescriptor): boolean =>
  a.kind === b.kind &&
  JSON.stringify((a.options ?? []).map((option) => option.value)) ===
    JSON.stringify((b.options ?? []).map((option) => option.value))

const sameValue = (a: PropertyField['value'], b: PropertyField['value']): boolean =>
  !isMixed(a) && !isMixed(b) && JSON.stringify(a) === JSON.stringify(b)

/**
 * A selection of several kinds of item shows only what they share: one group
 * holding the fields every group has — the same key, edited the same way —
 * each value the shared one or MIXED. A field only some kinds have is not
 * shown, so nothing in the panel applies to part of the selection only. One
 * group, or none, is returned as it is.
 */
export function intersectGroups(all: PropertyGroup[], title: string): PropertyGroup[] {
  // A group with an id is one of several for one item (a pin's alternates), not an item kind.
  const groups = all.filter((group) => !group.id)
  if (groups.length <= 1) return all
  const [first, ...rest] = groups
  const fields = first.fields.flatMap((field): PropertyField[] => {
    const others = rest.map((group) => group.fields.find((f) => f.key === field.key))
    if (others.some((other) => !other || !sameEditor(other.editor, field.editor))) return []
    const all = [field, ...(others as PropertyField[])]
    return [
      {
        key: field.key,
        ...(field.labelKey ? { labelKey: field.labelKey } : {}),
        ...(field.label ? { label: field.label } : {}),
        editor: field.editor,
        value: all.every((f) => sameValue(f.value, field.value)) ? field.value : MIXED,
        ...(all.some((f) => f.readonly) ? { readonly: true } : {}),
        ...(field.section ? { section: field.section } : {})
      }
    ]
  })
  return [
    {
      type: SELECTION_GROUP,
      title,
      count: groups.reduce((sum, group) => sum + group.count, 0),
      fields,
      members: groups.map((group) => ({ type: group.type, ...(group.id ? { id: group.id } : {}) }))
    }
  ]
}
