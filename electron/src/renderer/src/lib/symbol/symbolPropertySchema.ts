// Builds the property-table schema (PropertyGroup[]) for the symbol editor from
// the current selection. Pure: reads typed KicadLibSymbol views, returns groups
// PropertyTable renders. The host (SymbolLibraryEditor) maps `edit(groupType,
// key, value)` back to the symbolEdit.ts helpers, applying each to every
// selected node of that group's type.
//
// Grouping (confirmed design): one group per KiCad AST primitive type. Pins →
// a `pin` group; graphics are sub-categorized by their resolved type into
// `rectangle`/`line`/`circle`/`arc`/`text` groups. The root-level `symbol` group
// (fields + flags) shows only when nothing else is selected — the symbol itself
// is the selection then. A field's value collapses across the group's members to
// a concrete value, or MIXED when they disagree.

import {
  type KicadLibSymbol,
  type KicadTextEffects,
  type SchematicProperty,
  type SymbolGraphic,
  type SymbolPin
} from '../kicad/schematic'
import {
  collapseValue,
  H_ALIGN_OPTIONS,
  inSection,
  STROKE_TYPE_OPTIONS,
  rgbaEq,
  V_ALIGN_OPTIONS,
  type EditorDescriptor,
  type PropertyAction,
  type PropertyField,
  type PropertyGroup,
  type Rgba,
  type SelectOption
} from '../propertyTable'
import { isColorUnset } from '../kicad/color'
import { mmToNm } from '../kicad/coordinates'
import { tk, type MessageKey } from '../messageKey'
// For the thickness a text is DRAWN with when the file omits it: the renderer's
// own derivation, so the panel cannot report a weight nothing draws.
import { strokeOptionsFromTextEffects } from '../kicad/newstroke'
import {
  isFieldOnCanvas,
  isMandatoryField,
  isPanelField,
  symbolPartGraphic,
  symbolPartPin,
  symbolUnitCount,
  symbolUnitName,
  type SymbolPartAddress
} from './symbolEdit'
import { POWER_KINDS } from '../../../../shared/itemRecords'

export type Translate = (key: string) => string

/**
 * A selected part, named the way the renderer and the edit helpers name it.
 * Re-exported so callers need one import; the definition lives with the AST
 * helpers that resolve it. See ARCHITECTURE.md §3.7.
 */
export type SelectionItem = SymbolPartAddress

/** Pin electrical types + graphic styles KiCad allows (option `value`s). */
export const ELECTRICAL_TYPES = [
  'input',
  'output',
  'bidirectional',
  'tri_state',
  'passive',
  'free',
  'unspecified',
  'power_in',
  'power_out',
  'open_collector',
  'open_emitter',
  'no_connect'
]
export const GRAPHIC_STYLES = [
  'line',
  'inverted',
  'clock',
  'inverted_clock',
  'input_low',
  'clock_low',
  'output_low',
  'edge_clock_high',
  'non_logic'
]
/**
 * Schematic graphic fill kinds — KiCad's `FILL_T` as its shape dialog offers
 * them, for a symbol body and a sheet graphic alike (distinct from footprint's
 * none/solid/hatch). `color` and the hatches paint with the fill color row.
 */
export const FILL_KINDS = [
  'none',
  'outline',
  'background',
  'color',
  'hatch',
  'reverse_hatch',
  'cross_hatch'
]

const options = (t: Translate, ns: string, values: string[]): SelectOption[] =>
  values.map((value) => ({ value, label: t(`symbolEditor.${ns}.${value}`) }))

/** A distance (mm) coordinate/length input; the widget owns unit conversion. */
const dist = (step = 0.254): EditorDescriptor => ({ kind: 'distance', step, model: 'nm' })
/** A degree angle input; pins snap to cardinals, text is free. */
const ang = (cardinal = false): EditorDescriptor => ({ kind: 'angle', cardinal })

/** A field descriptor with its labelKey pointing at the central registry. */
const field = (
  key: string,
  labelKey: string,
  editor: EditorDescriptor,
  value: PropertyField['value']
): PropertyField => ({ key, labelKey, editor, value })

const stroke = <T>(members: T[], read: (m: T) => number): PropertyField =>
  field('strokeWidth', 'strokeWidth', dist(), collapseValue(members, read))
const fillField = (t: Translate, members: SymbolGraphic[]): PropertyField =>
  field(
    'fill',
    'fill',
    { kind: 'select', options: options(t, 'fillTypes', FILL_KINDS) },
    collapseValue(members, (g) => (g as { fill: string }).fill)
  )
/** Stroke + fill color rows (unset → null so the picker shows the inherit state). */
const strokeColorField = (members: SymbolGraphic[]): PropertyField =>
  field(
    'strokeColor',
    'strokeColor',
    { kind: 'color' },
    collapseValue<SymbolGraphic, Rgba | null>(
      members,
      (g) => (g as { stroke?: { color?: Rgba } }).stroke?.color ?? null,
      rgbaEq
    )
  )
const fillColorField = (members: SymbolGraphic[]): PropertyField =>
  field(
    'fillColor',
    'fillColor',
    { kind: 'color' },
    collapseValue<SymbolGraphic, Rgba | null>(
      members,
      (g) => (g as { fillColor?: Rgba }).fillColor ?? null,
      rgbaEq
    )
  )

/**
 * Glyph weight, as the file states it: `(font (thickness …))` is usually
 * ABSENT, and absent means "derive from the size and the bold flag" — the state
 * all but 13 texts in the 223 standard libraries are in. So the control is a
 * checkbox over the token's presence, with the number row showing the weight
 * that is actually drawn, read-only, while Auto is on.
 *
 * KiCad's own text dialog has no thickness field at all; this is ours, and it
 * is only honest if it can say "auto".
 */
const thicknessFields = (members: Array<{ effects: KicadTextEffects }>): PropertyField[] => [
  field(
    'thicknessAuto',
    'thicknessAuto',
    { kind: 'checkbox' },
    collapseValue(members, (m) => m.effects.thickness === undefined)
  ),
  {
    ...field(
      'thickness',
      'thickness',
      dist(0.01),
      // `strokeOptionsFromTextEffects` answers in layout mm; the field's model
      // unit is nm like every other distance here.
      collapseValue(members, (m) => mmToNm(strokeOptionsFromTextEffects(m.effects).thickness))
    ),
    // Editable the moment ANY member carries an explicit weight, so a mixed
    // selection can be given one value rather than being stuck read-only.
    readonly: members.every((m) => m.effects.thickness === undefined)
  }
]

/** Narrow a graphic union member to a subtype (all members share one type). */
const asRect = (g: SymbolGraphic): Extract<SymbolGraphic, { type: 'rectangle' }> =>
  g as Extract<SymbolGraphic, { type: 'rectangle' }>
const asCircle = (g: SymbolGraphic): Extract<SymbolGraphic, { type: 'circle' }> =>
  g as Extract<SymbolGraphic, { type: 'circle' }>
const asArc = (g: SymbolGraphic): Extract<SymbolGraphic, { type: 'arc' }> =>
  g as Extract<SymbolGraphic, { type: 'arc' }>
const asText = (g: SymbolGraphic): Extract<SymbolGraphic, { type: 'text' }> =>
  g as Extract<SymbolGraphic, { type: 'text' }>
const asTextBox = (g: SymbolGraphic): Extract<SymbolGraphic, { type: 'textBox' }> =>
  g as Extract<SymbolGraphic, { type: 'textBox' }>
const asBezier = (g: SymbolGraphic): Extract<SymbolGraphic, { type: 'bezier' }> =>
  g as Extract<SymbolGraphic, { type: 'bezier' }>

const pinGroup = (t: Translate, pins: SymbolPin[]): PropertyGroup => ({
  type: 'pin',
  title: t('shared.primitives.pin'),
  count: pins.length,
  // "Add function" lives on the PIN header, not on the alternates list, because
  // a pin with no alternates yet has no list to hang it on — and that is exactly
  // the case where you need it. Single selection only, for the reason in
  // `alternateGroups`.
  actions:
    pins.length === 1
      ? [{ id: ADD_ALTERNATE_ACTION, label: t('symbolEditor.alternates.add'), icon: 'plus' }]
      : undefined,
  fields: [
    field(
      'name',
      'name',
      { kind: 'text' },
      collapseValue(pins, (p) => p.name)
    ),
    field(
      'number',
      'number',
      { kind: 'text' },
      collapseValue(pins, (p) => p.number)
    ),
    field(
      'x',
      'x',
      dist(),
      collapseValue(pins, (p) => p.position.x)
    ),
    field(
      'y',
      'y',
      dist(),
      collapseValue(pins, (p) => p.position.y)
    ),
    field(
      'angle',
      'angle',
      ang(true),
      collapseValue(pins, (p) => p.position.angle)
    ),
    field(
      'length',
      'length',
      dist(),
      collapseValue(pins, (p) => p.length)
    ),
    // KiCad's own dialog order, and its own two rows: a pin carries text effects
    // on its `(name …)` / `(number …)` nodes, and nothing else in the panel
    // reaches them.
    field(
      'nameSize',
      'nameSize',
      dist(),
      collapseValue(pins, (p) => p.nameEffects.fontSize.height)
    ),
    field(
      'numberSize',
      'numberSize',
      dist(),
      collapseValue(pins, (p) => p.numberEffects.fontSize.height)
    ),
    field(
      'electricalType',
      'electricalType',
      { kind: 'select', options: options(t, 'pinTypes', ELECTRICAL_TYPES) },
      collapseValue(pins, (p) => p.electricalType)
    ),
    field(
      'graphicStyle',
      'graphicStyle',
      { kind: 'select', options: options(t, 'pinStyles', GRAPHIC_STYLES) },
      collapseValue(pins, (p) => p.graphicStyle)
    ),
    field(
      'hidden',
      'hidden',
      { kind: 'checkbox' },
      collapseValue(pins, (p) => p.hidden)
    )
  ]
})

/**
 * Action ids the symbol panel's header buttons emit. Exported so the host
 * dispatches on a shared constant rather than a string literal it could typo.
 */
export const ADD_ALTERNATE_ACTION = 'addAlternate'
export const REMOVE_ALTERNATE_ACTION = 'removeAlternate'

/** `alternate:<index>` group id → the index, or null when it isn't one. */
export const alternateIndexOf = (groupId: string | undefined): number | null => {
  const match = /^alternate:(\d+)$/.exec(groupId ?? '')
  return match ? Number(match[1]) : null
}

/**
 * One group per alternate pin function — a repeating list, which is what makes
 * this the only schema here that needs add and remove rather than just edit.
 *
 * Groups rather than rows-in-one-group so each entry gets its own header to hang
 * a remove button on, and so its three fields read as a unit. Numbered from 1,
 * since the index is a position rather than a name.
 *
 * **Single selection only.** An alternate list cannot be collapsed across pins
 * the way a scalar field can — two pins with different alternates have no
 * meaningful shared value, and "add" would have to mean adding to all of them.
 * With several pins selected the caller simply omits these.
 */
const alternateGroups = (t: Translate, pin: SymbolPin): PropertyGroup[] =>
  pin.alternates.map((alternate, index) => ({
    type: 'alternate',
    id: `alternate:${index}`,
    title: t('symbolEditor.groups.alternate').replace('{n}', String(index + 1)),
    count: 1,
    actions: [
      {
        id: REMOVE_ALTERNATE_ACTION,
        label: t('symbolEditor.alternates.remove'),
        icon: 'close-sm'
      }
    ],
    fields: [
      field('name', 'name', { kind: 'text' }, alternate.name),
      field(
        'electricalType',
        'electricalType',
        { kind: 'select', options: options(t, 'pinTypes', ELECTRICAL_TYPES) },
        alternate.electricalType
      ),
      field(
        'graphicStyle',
        'graphicStyle',
        { kind: 'select', options: options(t, 'pinStyles', GRAPHIC_STYLES) },
        alternate.graphicStyle
      )
    ]
  }))

/** Each symbol graphic's group title, the primitive's shared name. */
const GRAPHIC_TITLES: Record<string, MessageKey> = {
  rectangle: tk('shared.primitives.rectangle'),
  line: tk('shared.primitives.line'),
  bezier: tk('shared.primitives.curve'),
  circle: tk('shared.primitives.circle'),
  arc: tk('shared.primitives.arc'),
  text: tk('shared.primitives.text'),
  textBox: tk('shared.primitives.textBox')
}

const graphicGroup = (t: Translate, type: string, gs: SymbolGraphic[]): PropertyGroup => {
  const title = t(GRAPHIC_TITLES[type] ?? type)
  /**
   * The stroke-width row, built **lazily**: text is the one symbol graphic with
   * no stroke — its weight is its font — so evaluating this eagerly would read
   * `undefined.width` for it.
   */
  const strokeField = (): PropertyField =>
    stroke(gs, (g) => (g as { stroke: { width: number } }).stroke.width)
  /**
   * Stroke style — dashed and dotted body outlines are ordinary in KiCad symbols
   * (228k `(stroke (type …))` entries across the standard library).
   */
  const strokeTypeField = (): PropertyField =>
    field(
      'strokeType',
      'strokeType',
      { kind: 'select', options: STROKE_TYPE_OPTIONS },
      collapseValue(gs, (g) => (g as { stroke?: { type?: string } }).stroke?.type ?? 'default')
    )
  let fields: PropertyField[]
  if (type === 'rectangle') {
    const r = gs.map(asRect)
    fields = [
      field(
        'startX',
        'startX',
        dist(),
        collapseValue(r, (g) => g.start.x)
      ),
      field(
        'startY',
        'startY',
        dist(),
        collapseValue(r, (g) => g.start.y)
      ),
      field(
        'endX',
        'endX',
        dist(),
        collapseValue(r, (g) => g.end.x)
      ),
      field(
        'endY',
        'endY',
        dist(),
        collapseValue(r, (g) => g.end.y)
      ),
      // KiCad's Width / Height: the far corner, stated from the start corner
      // (signed, as the file's corners can sit either way round).
      field(
        'rectWidth',
        'width',
        dist(),
        collapseValue(r, (g) => g.end.x - g.start.x)
      ),
      field(
        'rectHeight',
        'height',
        dist(),
        collapseValue(r, (g) => g.end.y - g.start.y)
      ),
      strokeField(),
      strokeTypeField(),
      fillField(t, gs),
      strokeColorField(gs),
      fillColorField(gs)
    ]
  } else if (type === 'circle') {
    const c = gs.map(asCircle)
    fields = [
      field(
        'centerX',
        'centerX',
        dist(),
        collapseValue(c, (g) => g.center.x)
      ),
      field(
        'centerY',
        'centerY',
        dist(),
        collapseValue(c, (g) => g.center.y)
      ),
      field(
        'radius',
        'radius',
        dist(),
        collapseValue(c, (g) => g.radius)
      ),
      strokeField(),
      strokeTypeField(),
      fillField(t, gs),
      strokeColorField(gs),
      fillColorField(gs)
    ]
  } else if (type === 'arc') {
    const a = gs.map(asArc)
    fields = [
      field(
        'startX',
        'startX',
        dist(),
        collapseValue(a, (g) => g.start.x)
      ),
      field(
        'startY',
        'startY',
        dist(),
        collapseValue(a, (g) => g.start.y)
      ),
      field(
        'midX',
        'midX',
        dist(),
        collapseValue(a, (g) => g.mid.x)
      ),
      field(
        'midY',
        'midY',
        dist(),
        collapseValue(a, (g) => g.mid.y)
      ),
      field(
        'endX',
        'endX',
        dist(),
        collapseValue(a, (g) => g.end.x)
      ),
      field(
        'endY',
        'endY',
        dist(),
        collapseValue(a, (g) => g.end.y)
      ),
      // No fill rows: KiCad offers Fill on no arc (`fillAvailable`, EDA_SHAPE).
      strokeField(),
      strokeTypeField(),
      strokeColorField(gs)
    ]
  } else if (type === 'text') {
    const tx = gs.map(asText)
    fields = [
      field(
        'text',
        'text',
        // Drawn text: padding a label to clear a pin is deliberate, so this is
        // one of the few cells that commits exactly what was typed.
        { kind: 'text', skipTrim: true },
        collapseValue(tx, (g) => g.text)
      ),
      field(
        'x',
        'x',
        dist(),
        collapseValue(tx, (g) => g.position.x)
      ),
      field(
        'y',
        'y',
        dist(),
        collapseValue(tx, (g) => g.position.y)
      ),
      field(
        'angle',
        'angle',
        ang(),
        collapseValue(tx, (g) => g.position.angle)
      ),
      field(
        'size',
        'size',
        dist(),
        collapseValue(tx, (g) => g.effects.fontSize.height)
      ),
      ...thicknessFields(tx),
      field(
        'bold',
        'bold',
        { kind: 'checkbox' },
        collapseValue(tx, (g) => g.effects.bold)
      ),
      field(
        'italic',
        'italic',
        { kind: 'checkbox' },
        collapseValue(tx, (g) => g.effects.italic)
      ),
      // Justification is what the anchor MEANS: two texts with identical (at)
      // render in different places depending on it, which is why it belongs on
      // the panel and not only in the file.
      field(
        'hAlign',
        'hAlign',
        { kind: 'segmented', options: H_ALIGN_OPTIONS },
        collapseValue(tx, (g) => g.effects.horizontalAlign)
      ),
      field(
        'vAlign',
        'vAlign',
        { kind: 'segmented', options: V_ALIGN_OPTIONS },
        collapseValue(tx, (g) => g.effects.verticalAlign)
      ),
      // KiCad 7+ `(font (color …))`. Unset reads as null so the picker shows the
      // inherit state, exactly as the stroke/fill color rows do.
      field(
        'color',
        'textColor',
        { kind: 'color' },
        collapseValue<Extract<SymbolGraphic, { type: 'text' }>, Rgba | null>(
          tx,
          (g) => (g.effects.color && !isColorUnset(g.effects.color) ? g.effects.color : null),
          rgbaEq
        )
      )
    ]
  } else if (type === 'textBox') {
    const b = gs.map(asTextBox)
    // KiCad's three groups for a text box (SCH_TEXTBOX): its text, its margins,
    // and the box as a shape. Where it sits stays on top, unsectioned.
    fields = [
      field(
        'x',
        'x',
        dist(),
        collapseValue(b, (g) => g.position.x)
      ),
      field(
        'y',
        'y',
        dist(),
        collapseValue(b, (g) => g.position.y)
      ),
      field(
        'angle',
        'angle',
        ang(),
        collapseValue(b, (g) => g.position.angle)
      ),
      ...inSection('text', [
        field(
          'text',
          'text',
          // Drawn text — untrimmed, as the plain text row is.
          { kind: 'text', skipTrim: true },
          collapseValue(b, (g) => g.text)
        ),
        field(
          'size',
          'size',
          dist(),
          collapseValue(b, (g) => g.effects.fontSize.height)
        ),
        ...thicknessFields(b),
        field(
          'bold',
          'bold',
          { kind: 'checkbox' },
          collapseValue(b, (g) => g.effects.bold)
        ),
        field(
          'italic',
          'italic',
          { kind: 'checkbox' },
          collapseValue(b, (g) => g.effects.italic)
        ),
        // Justification does more here than on a plain text: it decides which
        // margins apply at all. Centered text ignores them and centers on the full
        // box; only left/right/top/bottom inset. (Verified against KiCad — see
        // textBox.ts.)
        field(
          'hAlign',
          'hAlign',
          { kind: 'segmented', options: H_ALIGN_OPTIONS },
          collapseValue(b, (g) => g.effects.horizontalAlign)
        ),
        field(
          'vAlign',
          'vAlign',
          { kind: 'segmented', options: V_ALIGN_OPTIONS },
          collapseValue(b, (g) => g.effects.verticalAlign)
        ),
        field(
          'color',
          'textColor',
          { kind: 'color' },
          collapseValue<Extract<SymbolGraphic, { type: 'textBox' }>, Rgba | null>(
            b,
            (g) => (g.effects.color && !isColorUnset(g.effects.color) ? g.effects.color : null),
            rgbaEq
          )
        )
      ]),
      ...inSection('margins', [
        field(
          'marginLeft',
          'marginLeft',
          dist(),
          collapseValue(b, (g) => g.margins.left)
        ),
        field(
          'marginTop',
          'marginTop',
          dist(),
          collapseValue(b, (g) => g.margins.top)
        ),
        field(
          'marginRight',
          'marginRight',
          dist(),
          collapseValue(b, (g) => g.margins.right)
        ),
        field(
          'marginBottom',
          'marginBottom',
          dist(),
          collapseValue(b, (g) => g.margins.bottom)
        )
      ]),
      // A box has a border AND a fill, unlike a plain text, so it carries the
      // full graphic style set as well as the font one. Width/height rather than
      // a second corner, because that is what the file stores and what the box
      // means: `(at)` is the corner, `(size)` the reach. Height is negative for a
      // box that runs downward — KiCad's own sign.
      ...inSection('shape', [
        field(
          'width',
          'width',
          dist(),
          collapseValue(b, (g) => g.size.width)
        ),
        field(
          'height',
          'height',
          dist(),
          collapseValue(b, (g) => g.size.height)
        ),
        strokeField(),
        strokeTypeField(),
        fillField(t, gs),
        strokeColorField(gs),
        fillColorField(gs)
      ])
    ]
  } else if (type === 'bezier') {
    // KiCad's Start / End for a curve: its first and last points. The two
    // control points stay on the canvas, as KiCad keeps them off its panel.
    const z = gs.map(asBezier)
    const first = (g: Extract<SymbolGraphic, { type: 'bezier' }>): { x: number; y: number } =>
      g.points[0] ?? { x: 0, y: 0 }
    const last = (g: Extract<SymbolGraphic, { type: 'bezier' }>): { x: number; y: number } =>
      g.points[g.points.length - 1] ?? { x: 0, y: 0 }
    fields = [
      field(
        'startX',
        'startX',
        dist(),
        collapseValue(z, (g) => first(g).x)
      ),
      field(
        'startY',
        'startY',
        dist(),
        collapseValue(z, (g) => first(g).y)
      ),
      field(
        'endX',
        'endX',
        dist(),
        collapseValue(z, (g) => last(g).x)
      ),
      field(
        'endY',
        'endY',
        dist(),
        collapseValue(z, (g) => last(g).y)
      ),
      strokeField(),
      strokeTypeField(),
      fillField(t, gs),
      strokeColorField(gs),
      fillColorField(gs)
    ]
  } else {
    // polyline / 'line': geometry stays on-canvas — a point list a vertex drag
    // edits — so the panel offers only stroke and fill.
    // A two-point line encloses nothing, so it has no fill rows: KiCad reads
    // one on a sheet as a plain `SCH_LINE`, whose dialog has none.
    const fillable = gs.every((g) => g.type !== 'line' || g.points.length > 2)
    fields = [
      strokeField(),
      strokeTypeField(),
      ...(fillable ? [fillField(t, gs)] : []),
      strokeColorField(gs),
      ...(fillable ? [fillColorField(gs)] : [])
    ]
  }
  return { type, title, count: gs.length, fields }
}

/**
 * Property key → label registry entry, for the fields KiCad names itself.
 * Anything absent is a custom field, labelled with its own key. A Map, since
 * the key is user text and an object would answer `constructor` from its
 * prototype.
 */
const FIELD_LABEL_KEYS: ReadonlyMap<string, string> = new Map([
  ['Reference', 'reference'],
  ['Value', 'value'],
  ['Footprint', 'footprint'],
  ['Datasheet', 'datasheet'],
  ['Description', 'description'],
  ['ki_description', 'description'],
  ['ki_keywords', 'keywords']
])

/** A field row's label: the registry name where KiCad has one, else the raw key. */
const fieldRow = (property: SchematicProperty, action?: PropertyAction): PropertyField => {
  const labelKey = FIELD_LABEL_KEYS.get(property.key)
  return {
    key: property.key,
    ...(labelKey ? { labelKey } : { label: property.key }),
    editor: { kind: 'text' },
    value: property.value,
    ...(action ? { action } : {})
  }
}

/**
 * The symbol's own settings, as SECTIONS rather than one long list — KiCad splits
 * its Symbol Properties the same way (Fields / Symbol Definition / Pin Display /
 * Attributes / Unit Bodies & Styles).
 *
 * Sections are ordinary `PropertyGroup`s, not a new nesting concept: the table
 * already renders one header per group, so the split costs nothing and each
 * section keeps its own `type` for the edit dispatch. All three route to
 * `applySymbolEdit`, since they all write the same symbol node.
 *
 * **Symbol Definition leads**, and it earns its place twice over. It names the
 * subject — the other three titles say what KIND of setting they hold, not whose
 * — which is how the panel says *nothing is selected* rather than leaving you to
 * infer it. And it explains a derived symbol, whose inherited body and disabled
 * geometry tools (`canAddGeometry`) are otherwise unaccounted for on screen.
 *
 * The name is editable here as well as in the File Explorer tree, which is a
 * second control for one state and deliberate: the tree is a file-manager
 * affordance (find the leaf, right-click) and this is the one you reach for
 * while editing the thing. Both call `renameSymbol`, so they cannot diverge.
 *
 * **Unit Bodies & Styles** stays absent — the unit and body-style selectors on
 * the canvas own it, and restating them here would be the second control that
 * is NOT worth it, since they are already visible whenever they apply.
 */
export { POWER_KINDS }

/** Which of `POWER_KINDS` a symbol is. */
export const powerKindOf = (def: KicadLibSymbol): (typeof POWER_KINDS)[number] =>
  !def.isPower ? 'none' : def.isLocalPower ? 'local' : 'global'

/** What the root panel needs beyond the symbol itself. */
export interface SymbolGroupContext {
  /** The gate on screen, whose name the Units group edits. */
  unit?: number
}

const symbolGroups = (
  t: Translate,
  def: KicadLibSymbol,
  context: SymbolGroupContext
): PropertyGroup[] => [
  {
    type: 'symbolDefinition',
    title: t('shared.primitives.symbol'),
    count: 1,
    fields: [
      field('symbolName', 'name', { kind: 'text' }, def.name),
      // KiCad's footprint filter list: `ki_fp_filters`, whitespace-separated
      // patterns. The fields list hides `ki_*` keys, so this row is its home,
      // as KiCad's Symbol Properties gives it a tab of its own.
      field(
        'fpFilters',
        'fpFilters',
        { kind: 'text' },
        def.properties.find((property) => property.key === 'ki_fp_filters')?.value ?? ''
      ),
      // Read-only, and only when it applies: re-parenting rewrites the whole
      // body, which is not a property-row-sized act. The row exists to explain
      // why the canvas is inherited and the tools are off.
      ...(def.extends
        ? [
            {
              ...field('derivedFrom', 'derivedFrom', { kind: 'text' }, def.extends),
              readonly: true
            }
          ]
        : [])
    ]
  },
  {
    type: 'symbolFields',
    title: t('symbolEditor.groups.fields'),
    count: 1,
    // Structure (add/remove/rename/reorder) lives behind this button; the rows
    // keep the value. Text rather than an icon — none reads as the action.
    actions: [
      {
        id: 'editFields',
        label: t('symbolEditor.actions.editFieldsTitle'),
        text: t('symbolEditor.actions.editFields')
      }
    ],
    fields: def.properties
      .filter((property) => isPanelField(property.key))
      .map((property) =>
        fieldRow(
          property,
          // Same test the hit-test uses, so the button cannot select nothing.
          isFieldOnCanvas(property)
            ? { id: 'focusField', label: t('symbolEditor.actions.focusField'), icon: 'locate' }
            : undefined
        )
      )
  },
  {
    type: 'symbolPinDisplay',
    title: t('symbolEditor.groups.pinDisplay'),
    count: 1,
    // Stated POSITIVELY — "show", where the file stores "hide" — because that is
    // how KiCad asks it, and a checkbox labelled with a negative is a checkbox
    // people tick backwards. `applySymbolEdit` inverts on the way to the AST.
    fields: [
      field('showPinNames', 'showPinNames', { kind: 'checkbox' }, !def.pinNamesHidden),
      field('showPinNumbers', 'showPinNumbers', { kind: 'checkbox' }, !def.pinNumbersHidden),
      field('pinNameOffset', 'pinNameOffset', dist(), def.pinNameOffset)
    ]
  },
  {
    type: 'symbolAttributes',
    title: t('symbolEditor.groups.attributes'),
    count: 1,
    fields: [
      field('inBom', 'inBom', { kind: 'checkbox' }, def.inBom),
      field('onBoard', 'onBoard', { kind: 'checkbox' }, def.onBoard),
      field('inPosFiles', 'inPosFiles', { kind: 'checkbox' }, def.inPosFiles),
      field('excludeFromSim', 'excludeFromSim', { kind: 'checkbox' }, def.excludeFromSim),
      field(
        'duplicatePinNumbersAreJumpers',
        'duplicatePinNumbersAreJumpers',
        { kind: 'checkbox' },
        def.duplicatePinNumbersAreJumpers
      ),
      field(
        'power',
        'power',
        { kind: 'select', options: options(t, 'powerKinds', [...POWER_KINDS]) },
        powerKindOf(def)
      )
    ]
  },
  // A package's gates: what the one on screen is called, and whether a
  // placement may swap one gate for another. Only on a symbol that has gates.
  ...(isMultiUnit(def)
    ? [
        {
          type: 'symbolUnits',
          title: t('symbolEditor.groups.units'),
          count: 1,
          fields: [
            field(
              'unitName',
              'unitName',
              { kind: 'text' },
              symbolUnitName(def._node, context.unit ?? 1) ?? ''
            ),
            field(
              'unitsInterchangeable',
              'unitsInterchangeable',
              { kind: 'checkbox' },
              !def.unitsLocked
            )
          ]
        }
      ]
    : [])
]

/** Every group type that writes the SYMBOL node — the edit dispatch's whitelist. */
export const SYMBOL_GROUP_TYPES = new Set([
  'symbolDefinition',
  'symbolFields',
  'symbolPinDisplay',
  'symbolAttributes',
  'symbolUnits'
])

/**
 * The group for SELECTED fields — how a field looks and where it sits. Hangs
 * off a canvas selection like every other item's styling, which is what keeps
 * the root panel at one row per field; structure is the fields editor's.
 */
const fieldGroup = (t: Translate, properties: SchematicProperty[]): PropertyGroup => {
  // Which field this group is describing. The panel is otherwise all styling,
  // and a Reference and an MPN produce identical-looking rows — without the key
  // the only way to tell them apart is to remember what you clicked.
  //
  // Editable exactly where a rename is legal: one field, and not one of KiCad's
  // mandatory five. `renameSymbolProperty` refuses those anyway, so an editable
  // row there would be a control that silently does nothing.
  const soleKey = properties.length === 1 ? properties[0].key : null
  const renameable = !!soleKey && !isMandatoryField(soleKey)
  return {
    type: 'field',
    title: t('shared.primitives.field'),
    count: properties.length,
    fields: [
      {
        ...field(
          'name',
          'name',
          { kind: 'text' },
          collapseValue(properties, (p) => p.key)
        ),
        readonly: !renameable
      },
      field(
        'value',
        'value',
        { kind: 'text' },
        collapseValue(properties, (p) => p.value)
      ),
      // Asked positively, as KiCad does; the file stores `(hide yes)`.
      field(
        'visible',
        'show',
        { kind: 'checkbox' },
        collapseValue(properties, (p) => !p.hidden)
      ),
      field(
        'showName',
        'showName',
        { kind: 'checkbox' },
        collapseValue(properties, (p) => p.showName)
      ),
      field(
        'doNotAutoplace',
        'doNotAutoplace',
        { kind: 'checkbox' },
        collapseValue(properties, (p) => p.doNotAutoplace)
      ),
      // KiCad 9's private field stays with the library symbol, never copied to a
      // placement. KiCad offers it on all but the mandatory fields.
      {
        ...field(
          'private',
          'private',
          { kind: 'checkbox' },
          collapseValue(properties, (p) => !!p.isPrivate)
        ),
        readonly: properties.some((p) => isMandatoryField(p.key))
      },
      field(
        'x',
        'x',
        dist(),
        collapseValue(properties, (p) => p.position.x)
      ),
      field(
        'y',
        'y',
        dist(),
        collapseValue(properties, (p) => p.position.y)
      ),
      // Plain degrees — unlike `(text …)`, which is decidegrees.
      field(
        'angle',
        'angle',
        ang(),
        collapseValue(properties, (p) => p.position.angle)
      ),
      ...inSection('text', [
        field(
          'size',
          'size',
          dist(),
          collapseValue(properties, (p) => p.effects.fontSize.height)
        ),
        field(
          'bold',
          'bold',
          { kind: 'checkbox' },
          collapseValue(properties, (p) => p.effects.bold)
        ),
        field(
          'italic',
          'italic',
          { kind: 'checkbox' },
          collapseValue(properties, (p) => p.effects.italic)
        ),
        field(
          'hAlign',
          'hAlign',
          { kind: 'segmented', options: H_ALIGN_OPTIONS },
          collapseValue(properties, (p) => p.effects.horizontalAlign)
        ),
        field(
          'vAlign',
          'vAlign',
          { kind: 'segmented', options: V_ALIGN_OPTIONS },
          collapseValue(properties, (p) => p.effects.verticalAlign)
        ),
        field(
          'color',
          'textColor',
          { kind: 'color' },
          collapseValue<SchematicProperty, Rgba | null>(
            properties,
            (p) => (p.effects.color && !isColorUnset(p.effects.color) ? p.effects.color : null),
            rgbaEq
          )
        )
      ])
    ]
  }
}

const GRAPHIC_ORDER = ['rectangle', 'line', 'bezier', 'circle', 'arc', 'text', 'textBox']

/**
 * One group per graphic primitive type present, in a stable order — a symbol's
 * body and a sheet's free graphics alike, which share the model and its rows.
 */
export const graphicGroups = (t: Translate, graphics: SymbolGraphic[]): PropertyGroup[] =>
  GRAPHIC_ORDER.flatMap((type) => {
    const gs = graphics.filter((g) => g.type === type)
    return gs.length ? [graphicGroup(t, type, gs)] : []
  })

/** One group per primitive type present, in a stable order. Shared by both builders. */
const itemGroups = (
  t: Translate,
  pins: SymbolPin[],
  graphics: SymbolGraphic[]
): PropertyGroup[] => {
  const groups: PropertyGroup[] = []
  if (pins.length) groups.push(pinGroup(t, pins))
  // Directly under the pin they belong to, before any graphic groups.
  if (pins.length === 1) groups.push(...alternateGroups(t, pins[0]))
  groups.push(...graphicGroups(t, graphics))
  return groups
}

/**
 * KiCad's "Common to all units in symbol": the part lives in the shared unit 0
 * sub-symbol instead of one gate. A checkbox over WHERE the part is stored, not
 * a token on it — see `movePartToUnit`.
 *
 * Shown only when the symbol has more than one unit. On a single-gate symbol
 * the two states are indistinguishable on screen, and our own insert rule
 * already puts body graphics in unit 0 there, so the row would be a control for
 * nothing.
 *
 * **Body styles get no companion row, deliberately.** KiCad pairs this with
 * "Common to all body styles", but an alternate body style cannot be authored
 * here yet (the canvas is geometry-read-only on one), so the row waits for that.
 */
const commonUnitField = (value: PropertyField['value']): PropertyField =>
  field('commonToAllUnits', 'commonToAllUnits', { kind: 'checkbox' }, value)

/** Whether a symbol has gates at all — the condition `commonUnitField` needs. */
const isMultiUnit = (definition: KicadLibSymbol): boolean => symbolUnitCount(definition._node) > 1

/**
 * Build the property groups for the current selection. With a pin/graphic
 * selected, only those groups show; the symbol itself is the "selection" only
 * when nothing else is, so the root-level symbol group appears exactly then.
 */
export function buildSymbolGroups(
  definition: KicadLibSymbol | null,
  selectedItems: SelectionItem[],
  t: Translate,
  context: SymbolGroupContext = {}
): PropertyGroup[] {
  if (!definition) return []
  // Resolved by name rather than by a flat position across units, which
  // shifted whenever an earlier unit gained a part. The ADDRESS travels with
  // each resolved part, because one row — which unit holds it — is a fact about
  // the address rather than about the pin or graphic.
  const pins = selectedItems
    .map((address) => ({ address, pin: symbolPartPin(definition, address) }))
    .filter((entry): entry is { address: SelectionItem; pin: SymbolPin } => !!entry.pin)
  const graphics = selectedItems
    .map((address) => ({ address, graphic: symbolPartGraphic(definition, address) }))
    .filter((entry): entry is { address: SelectionItem; graphic: SymbolGraphic } => !!entry.graphic)

  // Fields resolve by KEY, and in document order — so a multi-field selection
  // reads the way the fields editor lists them.
  const selectedFieldKeys = new Set(
    selectedItems
      .filter((address) => address.kind === 'field' && address.field)
      .map((address) => address.field as string)
  )
  const fields = definition.properties.filter((property) => selectedFieldKeys.has(property.key))

  const groups = itemGroups(
    t,
    pins.map((entry) => entry.pin),
    graphics.map((entry) => entry.graphic)
  )
  if (fields.length) groups.push(fieldGroup(t, fields))
  if (isMultiUnit(definition)) {
    for (const group of groups) {
      // Alternates are a repeating list INSIDE a pin group; the pin's own row
      // already answers for them.
      if (group.type === 'alternate') continue
      const addresses =
        group.type === 'pin'
          ? pins.map((entry) => entry.address)
          : graphics
              .filter((entry) => entry.graphic.type === group.type)
              .map((entry) => entry.address)
      if (!addresses.length) continue
      group.fields = [
        ...group.fields,
        commonUnitField(collapseValue(addresses, (address) => address.unit === 0))
      ]
    }
  }
  // Root-level symbol props show only when nothing else is selected.
  if (groups.length === 0) groups.push(...symbolGroups(t, definition, context))
  return groups
}

/**
 * Rows that describe WHERE an item is, rather than what it is. Kept in the
 * pending panel — the panel must not change shape when you arm a tool — but
 * shown READ-ONLY, because while a tool is armed the pointer owns the position.
 * A row you could type into would fight the ghost; the values themselves are
 * live, so they report where the item would actually land rather than a
 * placeholder zero.
 */
const POSITION_KEYS = new Set([
  'x',
  'y',
  'angle',
  'startX',
  'startY',
  'endX',
  'endY',
  'midX',
  'midY',
  'centerX',
  'centerY',
  'radius',
  'rectWidth',
  'rectHeight',
  // A text box's extent is drawn out by the span gesture, so it belongs with the
  // coordinates the pointer owns. Its MARGINS do not — those are settings the
  // box carries, editable before it lands like any other template value.
  'width',
  'height'
])

/**
 * Groups for the item an ARMED TOOL is about to place — `symbolTools.toolTemplate`
 * output rather than a selection. Same builders as a real selection, so a pending
 * pin's rows read identically to a placed one's, in the same order, with nothing
 * added or removed: arming a tool must not reshape the panel.
 *
 * Empty when the tool places nothing, which is what makes the caller fall back to
 * the ordinary selection panel.
 */
export function buildPendingGroups(
  items: { pins: SymbolPin[]; graphics: SymbolGraphic[] },
  t: Translate,
  /**
   * The symbol the item is about to land in, when it has gates: an armed tool
   * gets the same "common to all units" row a placed part has, and answers it
   * from the tool's own template rather than from an address it does not have
   * yet. Omitted on a single-unit symbol, where the row does not exist either.
   */
  unitScope?: { multiUnit: boolean; commonToAllUnits: boolean }
): PropertyGroup[] {
  return itemGroups(t, items.pins, items.graphics).map((group) => ({
    ...group,
    // A pending item is one item, never a multi-selection, so the count badge
    // would only ever read "1" — noise beside a group that is already singular.
    count: 1,
    // No header actions on a pending item. "Add pin function" would have nothing
    // to add to: the pin does not exist until the click, and an alternate list
    // is not part of the tool template (it is per-pin authoring, not a default
    // worth carrying to the next pin).
    actions: undefined,
    fields: [
      ...group.fields.map((f) => (POSITION_KEYS.has(f.key) ? { ...f, readonly: true } : f)),
      ...(unitScope?.multiUnit ? [commonUnitField(unitScope.commonToAllUnits)] : [])
    ]
  }))
}
