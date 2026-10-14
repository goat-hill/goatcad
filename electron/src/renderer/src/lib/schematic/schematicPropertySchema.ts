// Builds the property-table schema (PropertyGroup[]) for the schematic editor
// from the current selection. Pure: reads typed schematic views. The host
// (SchematicEditor) maps `edit(groupType, key, value)` back — routing symbol
// identity edits through the EXISTING hierarchical onEditField/onEditFlag so a
// per-sheet Reference stays correct, and position/rotation/mirror through the
// AST helpers. Mirrors footprint/pcb schemas.
//
// One group per selected primitive type (symbol / label / wire / junction /
// no_connect), plus the sheet's annotation and bus items — text, text box, the
// free graphics as one group, sheet, sheet pin, directive label, bus — whose
// edits `applySheetItemEdit` writes. Schematic coordinates show raw KiCad Y
// (unflipped), so distance fields do NOT negate.

import {
  getSheetProperty,
  getSymbolProperty,
  KICAD_PAGE_NAMES,
  resizeSchematicSheetInAST,
  setSchematicDirectiveLabelLength,
  setSchematicDirectiveLabelShape,
  setSchematicPaper,
  setSchematicPropertyValue,
  setSchematicTextBoxContent,
  setSchematicTextContent,
  setSchematicTextPlacement,
  setSchematicSheetStrokeWidth,
  setSheetPinFields,
  SHEET_PIN_SHAPES,
  updateSchematicImageInAST,
  updateSchematicTableInAST,
  updateSchematicWireInAST,
  type DirectiveLabelShape,
  type KicadBusEntry,
  type KicadDirectiveLabel,
  type KicadLabel,
  type KicadSchematic,
  type KicadSchematicImage,
  type KicadSchematicPoint,
  type KicadSchematicSymbol,
  type KicadSchematicTable,
  type KicadSheet,
  type KicadSheetPin,
  type KicadTextEffects,
  type KicadWire,
  type SheetPinShape
} from '../kicad/schematic'
import { findChild, getAtomValues } from '../kicad/sexpr'
import { nm, NM_PER_MM, nmToMm, type Nm } from '../kicad/coordinates'
import { basenameOf } from '../kicad/paths'
import {
  collapseValue,
  H_ALIGN_OPTIONS,
  inSection,
  MIXED,
  placeholderGroups,
  rgbaEq,
  STROKE_TYPE_OPTIONS,
  V_ALIGN_OPTIONS,
  type EditorDescriptor,
  type PropertyEditValue,
  type PropertyField,
  type PropertyGroup,
  type Rgba,
  type SelectOption
} from '../propertyTable'
import { isMandatoryField, isPanelField, setTextEffects } from '../symbol/symbolEdit'
import { applyGraphicEdit, graphicPatchFor } from '../symbol/graphicEdit'
import { graphicGroups } from '../symbol/symbolPropertySchema'
import {
  SHEET_GRAPHIC_GROUPS,
  SHEET_GRAPHIC_TYPES,
  sheetGraphicOf,
  type SheetGraphic
} from './sheetGraphicEdit'
import { rootPageOf, setRootPage, setSheetPage, sheetPageOf } from './sheetPages'
import type { DocumentEdit } from './symbolEdits'
import { letterSubReference, placedSymbolChoices } from './symbolUnits'
import {
  isTitleBlockKey,
  readTitleBlock,
  setTitleBlockEntry,
  TITLE_BLOCK_KEYS,
  type TitleBlockKey
} from './titleBlock'

export type Translate = (key: string) => string

export interface SelectionItem {
  type: string
  index: number
  field?: string
  pin?: number
}

/** Resolved views + derived net the host passes in (net is connectivity-derived). */
export interface SchematicContext {
  symbols: KicadSchematicSymbol[]
  labels: KicadLabel[]
  wires: KicadWire[]
  junctions: KicadSchematicPoint[]
  noConnects: KicadSchematicPoint[]
  /** Net name for the current selection (wire/junction/label), read-only display. */
  netName: string | null
  /** The whole sheet, for the annotation, bus and sheet groups. */
  document?: KicadSchematic | null
  /** The sheet row's page number: which instance is on screen, and every page the design uses. */
  sheetPages?: SheetPageContext
  /** The sheet on screen, whose group shows while nothing is selected. */
  screen?: ScreenSheet
  /** What the symbol's link rows can open; absent, their buttons are off. */
  links?: SymbolLinks
}

/** Whether a symbol's Footprint and Datasheet values lead anywhere. */
export interface SymbolLinks {
  /** A library holds this footprint. */
  footprint: (libId: string) => boolean
  /** A web address or a file this value opens. */
  datasheet: (value: string) => boolean
}

/** Row actions on a symbol's link fields, echoed back with the field key. */
export const SYMBOL_ROW_ACTIONS = {
  browseFootprint: 'browseFootprint',
  openFootprint: 'openFootprint',
  openDatasheet: 'openDatasheet'
} as const

/**
 * The sheet instance on screen, as KiCad's Sheet Properties and Page Settings
 * see it: its name and page live on its box in the parent file, under the
 * parent instance's path; the root's page in its own `sheet_instances`.
 */
export interface ScreenSheet {
  /** The file on screen. */
  filePath: string
  document: KicadSchematic
  /** The design's top sheet: its page is its own, and it has no name. */
  root: boolean
  /** The box that places this instance, for a subsheet; absent on the root and
   *  while the parent is unread, when name and page are not shown. */
  parent?: {
    filePath: string
    /** The parent instance's path, under which the page is filed. */
    sheetPath: string
    sheet: KicadSheet
  }
  /** Every page the design numbers, this instance's included (`pagesOf`). */
  designPages: readonly string[]
  /** The project a new instance entry is filed under. */
  project: string
}

/**
 * A sheet's page belongs to one instance of it — here, the one under the
 * parent instance on screen — so the row reads and writes that one.
 */
export interface SheetPageContext {
  /** The instance path of the sheet on screen: the selected sheets' parent. */
  parentPath: string
  /** Every page the design numbers, the selected sheet's own included (`pagesOf`). */
  designPages: readonly string[]
}

/** Where a page edit lands: the parent instance, and the project a new entry is filed under. */
export interface SheetPageTarget {
  parentPath: string
  project: string
}

const opt = (value: string, label: string): SelectOption => ({ value, label })
const MIRROR = [opt('', 'None'), opt('x', 'Mirror X'), opt('y', 'Mirror Y')]
const LABEL_SHAPES = [
  opt('input', 'Input'),
  opt('output', 'Output'),
  opt('bidirectional', 'Bidirectional'),
  opt('tri_state', 'Tri-state'),
  opt('passive', 'Passive')
]

const dist = (): EditorDescriptor => ({ kind: 'distance', step: 1.27, model: 'nm' })
const ang = (): EditorDescriptor => ({ kind: 'angle', cardinal: true })
const select = (opts: SelectOption[]): EditorDescriptor => ({ kind: 'select', options: opts })
/** A select shown as an all-options-visible toggle — for short 2–3 option sets. */
const segmented = (opts: SelectOption[]): EditorDescriptor => ({ kind: 'segmented', options: opts })

const field = (
  key: string,
  labelKey: string,
  editor: EditorDescriptor,
  value: PropertyField['value']
): PropertyField => ({ key, labelKey, editor, value })
const explicit = (
  key: string,
  label: string,
  editor: EditorDescriptor,
  value: PropertyField['value']
): PropertyField => ({ key, label, editor, value })
const ro = (f: PropertyField): PropertyField => ({ ...f, readonly: true })

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * The Unit and Body style rows, shown only when every selected placement
 * offers the same choice — a unit list means nothing across different parts.
 */
const symbolChoiceFields = (
  t: Translate,
  ss: KicadSchematicSymbol[],
  document: KicadSchematic | null | undefined
): PropertyField[] => {
  if (!document) return []
  const choices = ss.map((s) => placedSymbolChoices(document, s))
  const same = (key: 'units' | 'bodyStyles'): number =>
    choices.every((c) => c[key] === choices[0][key]) ? choices[0][key] : 1
  const fields: PropertyField[] = []
  const units = same('units')
  if (units > 1) {
    const options = Array.from({ length: units }, (_, i) =>
      opt(String(i + 1), letterSubReference(i + 1))
    )
    fields.push(
      field(
        'unit',
        'symbolUnit',
        select(options),
        collapseValue(ss, (s) => String(s.unit))
      )
    )
  }
  const styles = same('bodyStyles')
  if (styles > 1) {
    const options = Array.from({ length: styles }, (_, i) =>
      opt(
        String(i + 1),
        i === 0
          ? t('shared.properties.bodyStyleStandard')
          : styles === 2
            ? t('shared.properties.bodyStyleAlternate')
            : String(i + 1)
      )
    )
    fields.push(
      field(
        'bodyStyle',
        'bodyStyle',
        styles === 2 ? segmented(options) : select(options),
        collapseValue(ss, (s) => String(s.bodyStyle))
      )
    )
  }
  return fields
}

/** A placed part's own field row, keyed by its name past this prefix. */
export const USER_FIELD_PREFIX = 'userField:'

/** The group button that opens the Edit fields sheet on a lone part. */
export const EDIT_FIELDS_ACTION = 'editFields'

/** The fields beyond the mandatory five that every one of these parts has, in the first's order. */
const sharedUserFields = (ss: KicadSchematicSymbol[]): string[] =>
  (ss[0]?.properties ?? [])
    .map((property) => property.key)
    .filter(
      (key) =>
        isPanelField(key) &&
        !isMandatoryField(key) &&
        ss.every((s) => s.properties.some((property) => property.key === key))
    )

const symbolGroup = (
  t: Translate,
  ss: KicadSchematicSymbol[],
  document?: KicadSchematic | null,
  links?: SymbolLinks
): PropertyGroup => {
  const prop = (key: string): PropertyField['value'] =>
    collapseValue(ss, (s) => getSymbolProperty(s, key) ?? '')
  const footprint = prop('Footprint')
  const datasheet = prop('Datasheet')
  return {
    type: 'symbol',
    title: t('shared.primitives.symbol'),
    count: ss.length,
    // Adding, removing, renaming and ordering fields is one part's, behind this
    // button; the rows keep the values, as in the symbol editor.
    ...(ss.length === 1
      ? {
          actions: [
            {
              id: EDIT_FIELDS_ACTION,
              label: t('symbolEditor.actions.editFieldsTitle'),
              text: t('symbolEditor.actions.editFields')
            }
          ]
        }
      : {}),
    // KiCad's order for a placed symbol (SCH_SYMBOL): where it sits first,
    // then its Fields, its Units and Body Styles, and its Attributes.
    fields: [
      ro(
        field(
          'libId',
          'libId',
          { kind: 'text' },
          collapseValue(ss, (s) => s.libId)
        )
      ),
      field(
        'posX',
        'posX',
        dist(),
        collapseValue(ss, (s) => s.position.x)
      ),
      field(
        'posY',
        'posY',
        dist(),
        collapseValue(ss, (s) => s.position.y)
      ),
      field(
        'rotation',
        'rotation',
        ang(),
        collapseValue(ss, (s) => s.position.angle)
      ),
      field(
        'mirror',
        'mirror',
        segmented(MIRROR),
        collapseValue(ss, (s) => s.mirror ?? '')
      ),
      ...inSection('fields', [
        field('Reference', 'reference', { kind: 'text' }, prop('Reference')),
        field('Value', 'value', { kind: 'text' }, prop('Value')),
        {
          ...field('Footprint', 'footprint', { kind: 'text' }, footprint),
          actions: [
            {
              id: SYMBOL_ROW_ACTIONS.browseFootprint,
              label: t('shared.properties.browseFootprint'),
              icon: 'libraries'
            },
            {
              id: SYMBOL_ROW_ACTIONS.openFootprint,
              label: t('shared.properties.openFootprint'),
              icon: 'open-external',
              disabled: !(
                typeof footprint === 'string' &&
                footprint &&
                links?.footprint(footprint)
              ),
              readOnlySafe: true
            }
          ]
        },
        {
          ...field('Datasheet', 'datasheet', { kind: 'text' }, datasheet),
          actions: [
            {
              id: SYMBOL_ROW_ACTIONS.openDatasheet,
              label: t('shared.properties.openDatasheet'),
              icon: 'open-external',
              disabled: !(typeof datasheet === 'string' && links?.datasheet(datasheet)),
              readOnlySafe: true
            }
          ]
        },
        ...sharedUserFields(ss).map((key) =>
          explicit(`${USER_FIELD_PREFIX}${key}`, key, { kind: 'text' }, prop(key))
        )
      ]),
      ...inSection('units', symbolChoiceFields(t, ss, document)),
      ...inSection('attributes', [
        explicit(
          'dnp',
          'DNP',
          { kind: 'checkbox' },
          collapseValue(ss, (s) => s.dnp)
        ),
        explicit(
          'excludeFromBom',
          'Excl. BOM',
          { kind: 'checkbox' },
          collapseValue(ss, (s) => !s.inBom)
        ),
        explicit(
          'excludeFromBoard',
          'Excl. Board',
          { kind: 'checkbox' },
          collapseValue(ss, (s) => !s.onBoard)
        ),
        explicit(
          'excludeFromSim',
          'Excl. Sim',
          { kind: 'checkbox' },
          collapseValue(ss, (s) => s.excludeFromSim)
        )
      ])
    ]
  }
}

const labelGroup = (t: Translate, ctx: SchematicContext, ls: KicadLabel[]): PropertyGroup => {
  const isGlobalOrHier = ls.every((l) => l.type !== 'label')
  const fields: PropertyField[] = [
    field(
      'text',
      'text',
      { kind: 'text' },
      collapseValue(ls, (l) => l.text)
    ),
    ro(
      field(
        'kind',
        'kind',
        { kind: 'text' },
        collapseValue(ls, (l) => l.type)
      )
    )
  ]
  if (isGlobalOrHier) {
    fields.push(
      field(
        'shape',
        'shape',
        select(LABEL_SHAPES),
        collapseValue(ls, (l) => l.shape ?? 'input')
      )
    )
  }
  fields.push(
    field(
      'posX',
      'posX',
      dist(),
      collapseValue(ls, (l) => l.position.x)
    ),
    field(
      'posY',
      'posY',
      dist(),
      collapseValue(ls, (l) => l.position.y)
    ),
    ro(
      field(
        'angle',
        'rotation',
        { kind: 'number' },
        collapseValue(ls, (l) => l.position.angle)
      )
    ),
    ro(field('net', 'net', { kind: 'text' }, ctx.netName ?? ''))
  )
  return { type: 'label', title: t('shared.primitives.label'), count: ls.length, fields }
}

/**
 * A wire's, bus's or bus entry's stroke: KiCad's Line Width, Wire Style and
 * Color (SCH_LINE, SCH_BUS_ENTRY_BASE). Width 0 and an unset style or color
 * mean the net class's.
 */
const strokeRows = (
  items: Array<{ width: Nm; strokeType?: string; strokeColor?: Rgba }>
): PropertyField[] => [
  field(
    'width',
    'width',
    dist(),
    collapseValue(items, (w) => w.width)
  ),
  field(
    'strokeType',
    'strokeType',
    select(STROKE_TYPE_OPTIONS),
    collapseValue(items, (w) => w.strokeType ?? 'default')
  ),
  field(
    'strokeColor',
    'strokeColor',
    { kind: 'color' },
    collapseValue<{ strokeColor?: Rgba }, Rgba | null>(items, (w) => w.strokeColor ?? null, rgbaEq)
  )
]

/** A wire-stroke row's edit as `updateSchematicWireInAST` takes it, or null. */
export const strokePatch = (
  key: string,
  value: PropertyEditValue
): Parameters<typeof updateSchematicWireInAST>[1] | null => {
  if (key === 'width') return { width: asNm(value) }
  if (key === 'strokeType') return { strokeType: String(value) }
  if (key === 'strokeColor') return { strokeColor: value as Rgba | null }
  return null
}

/** Run length of the wire's points, in millimeters — a display-only figure. */
const wireLengthMm = (w: KicadWire): number => {
  let len = 0
  for (let i = 1; i < w.points.length; i++) {
    len += Math.hypot(w.points[i].x - w.points[i - 1].x, w.points[i].y - w.points[i - 1].y)
  }
  return len / NM_PER_MM
}

const wireGroup = (t: Translate, ctx: SchematicContext, ws: KicadWire[]): PropertyGroup => ({
  type: 'wire',
  title: t('shared.primitives.wire'),
  count: ws.length,
  fields: [
    ...strokeRows(ws),
    ro(field('net', 'net', { kind: 'text' }, ctx.netName ?? '')),
    ro(
      field(
        'length',
        'length',
        { kind: 'text' },
        ws.length === 1 ? wireLengthMm(ws[0]).toFixed(3) : ''
      )
    )
  ]
})

const junctionGroup = (
  t: Translate,
  ctx: SchematicContext,
  js: KicadSchematicPoint[]
): PropertyGroup => ({
  type: 'junction',
  title: t('shared.primitives.junction'),
  count: js.length,
  fields: [
    field(
      'diameter',
      'diameter',
      dist(),
      collapseValue(js, (j) => j.diameter ?? 0)
    ),
    field(
      'color',
      'strokeColor',
      { kind: 'color' },
      collapseValue<KicadSchematicPoint, Rgba | null>(js, (j) => j.color ?? null, rgbaEq)
    ),
    ro(field('net', 'net', { kind: 'text' }, ctx.netName ?? ''))
  ]
})

const noConnectGroup = (t: Translate, ns: KicadSchematicPoint[]): PropertyGroup => ({
  type: 'no_connect',
  title: t('shared.primitives.noConnect'),
  count: ns.length,
  fields: [
    ro(
      field(
        'posX',
        'posX',
        { kind: 'number' },
        collapseValue(ns, (n) => n.x)
      )
    ),
    ro(
      field(
        'posY',
        'posY',
        { kind: 'number' },
        collapseValue(ns, (n) => n.y)
      )
    )
  ]
})

// ---------------------------------------------------------------------------
// Text, graphics, sheets, directive labels and buses
// ---------------------------------------------------------------------------

/** What a text row reads: a free text's or a text box's content and effects. */
interface TextLike {
  text: string
  angle: number
  effects: KicadTextEffects
}

/** The rows every text-bearing group shares — KiCad's text properties. */
const textFields = (ts: TextLike[]): PropertyField[] => [
  field(
    'text',
    'text',
    // Drawn text keeps its padding: see `skipTrim`.
    { kind: 'text', skipTrim: true },
    collapseValue(ts, (x) => x.text)
  ),
  field(
    'size',
    'size',
    dist(),
    collapseValue(ts, (x) => x.effects.fontSize.height)
  ),
  field(
    'bold',
    'bold',
    { kind: 'checkbox' },
    collapseValue(ts, (x) => x.effects.bold)
  ),
  field(
    'italic',
    'italic',
    { kind: 'checkbox' },
    collapseValue(ts, (x) => x.effects.italic)
  ),
  field(
    'hAlign',
    'hAlign',
    segmented(H_ALIGN_OPTIONS),
    collapseValue(ts, (x) => x.effects.horizontalAlign)
  ),
  field(
    'vAlign',
    'vAlign',
    segmented(V_ALIGN_OPTIONS),
    collapseValue(ts, (x) => x.effects.verticalAlign)
  ),
  field(
    'angle',
    'angle',
    ang(),
    collapseValue(ts, (x) => x.angle)
  )
]

/** The sheet item groups, plus one per free-graphic primitive (`SHEET_GRAPHIC_GROUPS`). */
export type SheetItemGroup =
  | 'text'
  | 'text_box'
  | 'sheet'
  | 'sheet_pin'
  | 'netclass_flag'
  | 'bus'
  | 'bus_entry'
  | 'image'
  | 'table'

/** The selected items behind each of these groups, resolved against the sheet. */
export interface SheetItemSelection {
  texts: KicadSchematic['texts']
  textBoxes: KicadSchematic['textBoxes']
  /** Every free outline: rectangles, polylines, circles, arcs, beziers, rule areas. */
  graphics: SheetGraphic[]
  sheets: KicadSheet[]
  sheetPins: KicadSheetPin[]
  directiveLabels: KicadDirectiveLabel[]
  buses: KicadWire[]
  busEntries: KicadBusEntry[]
  images: KicadSchematicImage[]
  tables: KicadSchematicTable[]
}

export function sheetItemSelection(
  doc: KicadSchematic,
  items: SelectionItem[]
): SheetItemSelection {
  const unique = <T>(values: Array<T | undefined>): T[] => [
    ...new Set(values.filter((v): v is T => v !== undefined))
  ]
  const of = (type: string): SelectionItem[] => items.filter((item) => item.type === type)
  const graphics = items.flatMap((item) => sheetGraphicOf(doc, item) ?? [])
  return {
    texts: unique(of('text').map((item) => doc.texts[item.index])),
    textBoxes: unique(of('text_box').map((item) => doc.textBoxes[item.index])),
    graphics,
    // A selected name or file field shows its sheet's group, as a symbol's
    // field shows the symbol's.
    sheets: unique(
      items
        .filter((item) => item.type === 'sheet' || item.type === 'sheet_field')
        .map((item) => doc.sheets[item.index])
    ),
    sheetPins: unique(
      of('sheet_pin').map((item) =>
        item.pin !== undefined ? doc.sheets[item.index]?.pins[item.pin] : undefined
      )
    ),
    directiveLabels: unique(of('netclass_flag').map((item) => doc.directiveLabels[item.index])),
    buses: unique(of('bus').map((item) => doc.buses[item.index])),
    busEntries: unique(of('bus_entry').map((item) => doc.busEntries[item.index])),
    images: unique(of('image').map((item) => doc.images[item.index])),
    tables: unique(of('table').map((item) => doc.tables[item.index]))
  }
}

/**
 * The page number row. One sheet shows its page; several show mixed and do
 * not edit, since each instance's page is its own. Like KiCad's Sheet
 * Properties, any text is taken, empty and repeats included; those two get a
 * note, since a page is how the design orders and names its sheets.
 */
const sheetPageField = (
  t: Translate,
  sheets: KicadSheet[],
  pages: SheetPageContext
): PropertyField => {
  if (sheets.length !== 1)
    return ro(explicit('page', t('schematicEditor.properties.pageNumber'), { kind: 'text' }, MIXED))
  return pageField(t, sheetPageOf(sheets[0], pages.parentPath) ?? '', pages.designPages)
}

/** One instance's page row, with its note for an empty page or one used twice. */
const pageField = (t: Translate, page: string, designPages: readonly string[]): PropertyField => {
  const uses = designPages.filter((other) => other === page).length
  const warning =
    page === ''
      ? t('schematicEditor.properties.pageEmpty')
      : uses > 1
        ? t('schematicEditor.properties.pageDuplicate')
        : undefined
  return {
    ...explicit('page', t('schematicEditor.properties.pageNumber'), { kind: 'text' }, page),
    ...(warning ? { warning } : {})
  }
}

const sheetItemGroups = (
  t: Translate,
  selection: SheetItemSelection,
  pages?: SheetPageContext
): PropertyGroup[] => {
  const groups: PropertyGroup[] = []
  const {
    texts,
    textBoxes,
    graphics,
    sheets,
    sheetPins,
    directiveLabels,
    buses,
    busEntries,
    images,
    tables
  } = selection
  if (texts.length) {
    groups.push({
      type: 'text',
      title: t('shared.primitives.text'),
      count: texts.length,
      fields: textFields(
        texts.map((x) => ({ text: x.text, angle: x.position.angle, effects: x.effects }))
      )
    })
  }
  // A sheet's text box is the symbol editor's text box in sheet space — its
  // text, margins, border and fill rows are the same, under KiCad's sections.
  if (textBoxes.length) {
    groups.push(
      ...graphicGroups(
        t,
        textBoxes.map(({ graphic }) => graphic)
      ).map((group) => ({ ...group, type: 'text_box' }))
    )
  }
  // The symbol editor's own rows: a sheet graphic is the same model, in sheet space.
  groups.push(
    ...graphicGroups(
      t,
      graphics.map(({ graphic }) => graphic)
    )
  )
  if (sheets.length) {
    groups.push({
      type: 'sheet',
      title: t('shared.primitives.sheet'),
      count: sheets.length,
      fields: [
        field(
          'Sheetname',
          'name',
          { kind: 'text' },
          collapseValue(sheets, (x) => getSheetProperty(x, 'Sheetname') ?? '')
        ),
        explicit(
          'Sheetfile',
          t('schematicEditor.properties.file'),
          { kind: 'text' },
          collapseValue(sheets, (x) => getSheetProperty(x, 'Sheetfile') ?? '')
        ),
        ...(pages ? [sheetPageField(t, sheets, pages)] : []),
        field(
          'width',
          'width',
          dist(),
          collapseValue(sheets, (x) => x.size.width)
        ),
        field(
          'height',
          'height',
          dist(),
          collapseValue(sheets, (x) => x.size.height)
        ),
        field(
          'strokeWidth',
          'borderWidth',
          dist(),
          collapseValue(sheets, (x) => x.strokeWidth)
        )
      ]
    })
  }
  if (sheetPins.length) {
    groups.push({
      type: 'sheet_pin',
      title: t('shared.primitives.sheetPin'),
      count: sheetPins.length,
      fields: [
        field(
          'name',
          'name',
          { kind: 'text' },
          collapseValue(sheetPins, (x) => x.name)
        ),
        field(
          'shape',
          'shape',
          select(LABEL_SHAPES),
          collapseValue(sheetPins, (x) => x.electricalType)
        )
      ]
    })
  }
  if (directiveLabels.length) {
    // Fields by key, in the first label's order; a key another selected label
    // lacks is left out rather than written into it.
    const keys = directiveLabels[0].properties
      .map((p) => p.key)
      .filter((key) => directiveLabels.every((l) => l.properties.some((p) => p.key === key)))
    groups.push({
      type: 'netclass_flag',
      title: t('shared.primitives.directiveLabel'),
      count: directiveLabels.length,
      fields: [
        field(
          'shape',
          'shape',
          select([
            opt('round', t('schematicEditor.directiveShapes.round')),
            opt('dot', t('schematicEditor.directiveShapes.dot')),
            opt('diamond', t('schematicEditor.directiveShapes.diamond')),
            opt('rectangle', t('schematicEditor.directiveShapes.rectangle'))
          ]),
          collapseValue(directiveLabels, (x) => x.shape)
        ),
        field(
          'length',
          'pinLength',
          dist(),
          collapseValue(directiveLabels, (x) => x.length)
        ),
        ...inSection(
          'fields',
          keys.map((key) =>
            explicit(
              `field:${key}`,
              key,
              { kind: 'text' },
              collapseValue(
                directiveLabels,
                (x) => x.properties.find((p) => p.key === key)?.value ?? ''
              )
            )
          )
        )
      ]
    })
  }
  if (buses.length) {
    groups.push({
      type: 'bus',
      title: t('shared.primitives.bus'),
      count: buses.length,
      fields: strokeRows(buses)
    })
  }
  if (busEntries.length) {
    groups.push({
      type: 'bus_entry',
      title: t('shared.primitives.busEntry'),
      count: busEntries.length,
      fields: strokeRows(busEntries)
    })
  }
  if (images.length) {
    groups.push({
      type: 'image',
      title: t('shared.primitives.image'),
      count: images.length,
      fields: [
        field(
          'posX',
          'posX',
          dist(),
          collapseValue(images, (x) => x.position.x)
        ),
        field(
          'posY',
          'posY',
          dist(),
          collapseValue(images, (x) => x.position.y)
        ),
        field(
          'scale',
          'scale',
          { kind: 'number', step: 0.1, min: 0.01 },
          collapseValue(images, (x) => x.scale)
        )
      ]
    })
  }
  if (tables.length) {
    groups.push({
      type: 'table',
      title: t('shared.primitives.table'),
      count: tables.length,
      // KiCad's Table Properties; cells are edited on the canvas.
      fields: [
        field(
          'borderExternal',
          'externalBorder',
          { kind: 'checkbox' },
          collapseValue(tables, (x) => x.border.external)
        ),
        field(
          'borderHeader',
          'headerBorder',
          { kind: 'checkbox' },
          collapseValue(tables, (x) => x.border.header)
        ),
        field(
          'borderWidth',
          'borderWidth',
          dist(),
          collapseValue(tables, (x) => x.border.stroke.width)
        ),
        field(
          'separatorRows',
          'rowSeparators',
          { kind: 'checkbox' },
          collapseValue(tables, (x) => x.separators.rows)
        ),
        field(
          'separatorCols',
          'colSeparators',
          { kind: 'checkbox' },
          collapseValue(tables, (x) => x.separators.cols)
        ),
        field(
          'separatorWidth',
          'separatorWidth',
          dist(),
          collapseValue(tables, (x) => x.separators.stroke.width)
        )
      ]
    })
  }
  return groups
}

const asNm = (value: PropertyEditValue): Nm =>
  nm(typeof value === 'number' ? value : Number(value) || 0)
const asNumber = (value: PropertyEditValue): number =>
  typeof value === 'number' ? value : Number(value) || 0

/** The effects half of a text edit, or null when the key is not one. */
const effectsPatch = (
  key: string,
  value: PropertyEditValue
): Parameters<typeof setTextEffects>[1] | null => {
  switch (key) {
    case 'size':
      return { fontHeight: asNm(value), fontWidth: asNm(value) }
    case 'bold':
      return { bold: !!value }
    case 'italic':
      return { italic: !!value }
    case 'hAlign':
      return { hAlign: value as KicadTextEffects['horizontalAlign'] }
    case 'vAlign':
      return { vAlign: value as KicadTextEffects['verticalAlign'] }
    default:
      return null
  }
}

/**
 * Write one properties-panel edit of the text, graphic, sheet, sheet pin,
 * directive label or bus groups into every selected item it applies to.
 * Returns false when `group` is none of those, so the caller can route it on.
 */
export function applySheetItemEdit(
  selection: SheetItemSelection,
  group: string,
  key: string,
  value: PropertyEditValue,
  page?: SheetPageTarget
): boolean {
  if (SHEET_GRAPHIC_GROUPS.has(group)) {
    for (const { graphic, node } of selection.graphics) {
      if (graphic.type === group)
        applyGraphicEdit(group, node, graphicPatchFor(key, value, graphic))
    }
    return true
  }
  switch (group as SheetItemGroup) {
    case 'text':
      for (const text of selection.texts) {
        if (key === 'text') setSchematicTextContent(text, String(value))
        else if (key === 'angle')
          setSchematicTextPlacement(text, { ...text.position, angle: asNumber(value) })
        else {
          const patch = effectsPatch(key, value)
          if (patch) setTextEffects(text._node, patch)
        }
      }
      return true
    case 'text_box':
      // The rows are the symbol editor's text box rows, so their writes are too.
      for (const box of selection.textBoxes) {
        if (key === 'text') setSchematicTextBoxContent(box, String(value))
        else applyGraphicEdit('textBox', box._node, graphicPatchFor(key, value, box.graphic))
      }
      return true
    case 'sheet':
      for (const sheet of selection.sheets) {
        if (key === 'Sheetname' || key === 'Sheetfile') {
          const property = sheet.properties.find((p) => p.key === key)
          if (property) setSchematicPropertyValue(property, String(value))
        } else if (key === 'page') {
          if (page && selection.sheets.length === 1)
            setSheetPage(sheet, page.parentPath, String(value), page.project)
        } else if (key === 'width' || key === 'height') {
          const size = { ...sheet.size, [key]: asNm(value) }
          if (size.width > 0 && size.height > 0)
            resizeSchematicSheetInAST(sheet, { ...sheet.position }, size)
        } else if (key === 'strokeWidth') setSchematicSheetStrokeWidth(sheet, asNm(value))
      }
      return true
    case 'sheet_pin':
      for (const pin of selection.sheetPins) {
        if (key === 'name') setSheetPinFields(pin, { name: String(value) })
        else if (key === 'shape' && (SHEET_PIN_SHAPES as readonly string[]).includes(String(value)))
          setSheetPinFields(pin, { shape: value as SheetPinShape })
      }
      return true
    case 'netclass_flag':
      for (const label of selection.directiveLabels) {
        if (key === 'shape') setSchematicDirectiveLabelShape(label, value as DirectiveLabelShape)
        else if (key === 'length') setSchematicDirectiveLabelLength(label, asNm(value))
        else if (key.startsWith('field:')) {
          const property = label.properties.find((p) => p.key === key.slice('field:'.length))
          if (property) setSchematicPropertyValue(property, String(value))
        }
      }
      return true
    case 'bus':
    case 'bus_entry': {
      const patch = strokePatch(key, value)
      if (patch)
        for (const item of group === 'bus' ? selection.buses : selection.busEntries)
          updateSchematicWireInAST(item, patch)
      return true
    }
    case 'image':
      for (const image of selection.images) {
        if (key === 'posX') updateSchematicImageInAST(image, { x: asNm(value) })
        else if (key === 'posY') updateSchematicImageInAST(image, { y: asNm(value) })
        else if (key === 'scale') updateSchematicImageInAST(image, { scale: asNumber(value) })
      }
      return true
    case 'table':
      for (const table of selection.tables) {
        if (key === 'borderWidth' || key === 'separatorWidth')
          updateSchematicTableInAST(table, { [key]: asNm(value) })
        else if (
          key === 'borderExternal' ||
          key === 'borderHeader' ||
          key === 'separatorRows' ||
          key === 'separatorCols'
        )
          updateSchematicTableInAST(table, { [key]: !!value })
      }
      return true
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// The sheet on screen (nothing selected)
// ---------------------------------------------------------------------------

/** What the file's `(paper …)` names, read raw so a page this app does not know still shows. */
const paperOf = (document: KicadSchematic): { size: string; portrait: boolean } => {
  const node = findChild(document._root, 'paper')
  const atoms = node ? getAtomValues(node) : []
  return {
    size: atoms[0] ?? '',
    portrait: document.paper?.portrait ?? atoms.includes('portrait')
  }
}

/** Page Settings' title block rows, named as KiCad names them. */
const titleBlockLabels = (t: Translate): Record<TitleBlockKey, string> => ({
  title: t('schematicEditor.titleBlock.title'),
  date: t('schematicEditor.titleBlock.date'),
  rev: t('schematicEditor.titleBlock.rev'),
  company: t('schematicEditor.titleBlock.company'),
  comment1: t('schematicEditor.titleBlock.comment1'),
  comment2: t('schematicEditor.titleBlock.comment2'),
  comment3: t('schematicEditor.titleBlock.comment3'),
  comment4: t('schematicEditor.titleBlock.comment4'),
  comment5: t('schematicEditor.titleBlock.comment5'),
  comment6: t('schematicEditor.titleBlock.comment6'),
  comment7: t('schematicEditor.titleBlock.comment7'),
  comment8: t('schematicEditor.titleBlock.comment8'),
  comment9: t('schematicEditor.titleBlock.comment9')
})

/** KiCad writes an unnamed sheet as this (`DIALOG_SHEET_PROPERTIES`). */
const UNTITLED_SHEET = 'Untitled Sheet'

/**
 * The sheet on screen, as KiCad's Sheet Properties and Page Settings give it:
 * a subsheet's name, then its file and page, then the page's paper and the
 * file's title block. The root has no name of its own (its title is the
 * title block's), so the row is left out there.
 */
export const screenSheetGroup = (t: Translate, screen: ScreenSheet): PropertyGroup => {
  const { document, parent, root } = screen
  const fields: PropertyField[] = []
  if (parent)
    fields.push(
      explicit(
        'sheetName',
        t('schematicEditor.properties.sheetName'),
        { kind: 'text' },
        getSheetProperty(parent.sheet, 'Sheetname') ?? ''
      )
    )
  fields.push(
    ro(
      explicit(
        'sheetFile',
        t('schematicEditor.properties.file'),
        { kind: 'text' },
        parent ? (getSheetProperty(parent.sheet, 'Sheetfile') ?? '') : basenameOf(screen.filePath)
      )
    )
  )
  if (parent || root)
    fields.push(
      pageField(
        t,
        (parent ? sheetPageOf(parent.sheet, parent.sheetPath) : rootPageOf(document)) ?? '',
        screen.designPages
      )
    )
  const paper = paperOf(document)
  const sizes = [...new Set([...KICAD_PAGE_NAMES, 'User', ...(paper.size ? [paper.size] : [])])]
  fields.push(
    explicit(
      'paperSize',
      t('schematicEditor.properties.paperSize'),
      select(
        sizes.map((size) =>
          opt(size, size === 'User' ? t('schematicEditor.properties.paperUser') : size)
        )
      ),
      paper.size
    )
  )
  if (paper.size === 'User') {
    fields.push(
      explicit(
        'paperWidth',
        t('schematicEditor.properties.paperWidth'),
        dist(),
        document.paper?.width ?? 0
      ),
      explicit(
        'paperHeight',
        t('schematicEditor.properties.paperHeight'),
        dist(),
        document.paper?.height ?? 0
      )
    )
  } else {
    fields.push(
      explicit(
        'orientation',
        t('schematicEditor.properties.orientation'),
        segmented([
          opt('landscape', t('schematicEditor.properties.landscape')),
          opt('portrait', t('schematicEditor.properties.portrait'))
        ]),
        paper.portrait ? 'portrait' : 'landscape'
      )
    )
  }
  const block = readTitleBlock(document)
  const names = titleBlockLabels(t)
  for (const key of TITLE_BLOCK_KEYS)
    fields.push(explicit(key, names[key], { kind: 'text' }, block[key]))
  return { type: 'screen_sheet', title: t('shared.primitives.sheet'), count: 1, fields }
}

/**
 * The file edits one row of the screen sheet's group makes: a subsheet's
 * name and page on its box in the parent, the root's page, the paper and the
 * title block in the file on screen. Empty when the edit changes nothing the
 * row can write.
 */
export function screenSheetEdits(
  screen: ScreenSheet,
  key: string,
  value: PropertyEditValue
): DocumentEdit[] {
  const { parent } = screen
  const here = (apply: (document: KicadSchematic) => void): DocumentEdit[] => [
    { filePath: screen.filePath, apply }
  ]
  const onBox = (apply: (sheet: KicadSheet) => void): DocumentEdit[] => {
    if (!parent) return []
    const uuid = parent.sheet.uuid
    return [
      {
        filePath: parent.filePath,
        apply: (document) => {
          const sheet = document.sheets.find((candidate) => candidate.uuid === uuid)
          if (sheet) apply(sheet)
        }
      }
    ]
  }
  const text = String(value)
  if (key === 'sheetName')
    return onBox((sheet) => {
      const property = sheet.properties.find((p) => p.key === 'Sheetname')
      if (property) setSchematicPropertyValue(property, text === '' ? UNTITLED_SHEET : text)
    })
  if (key === 'page') {
    if (parent) return onBox((sheet) => setSheetPage(sheet, parent.sheetPath, text, screen.project))
    return screen.root ? here((document) => setRootPage(document, text)) : []
  }
  if (isTitleBlockKey(key)) return here((document) => setTitleBlockEntry(document, key, text))
  if (key === 'paperSize' || key === 'orientation' || key === 'paperWidth' || key === 'paperHeight')
    return here((document) => {
      const paper = paperOf(document)
      const width = nmToMm(document.paper?.width ?? nm(0))
      const height = nmToMm(document.paper?.height ?? nm(0))
      const size = key === 'paperSize' ? text : paper.size
      if (!size) return
      if (size !== 'User') {
        setSchematicPaper(document, {
          size,
          portrait: key === 'orientation' ? text === 'portrait' : paper.portrait
        })
        return
      }
      // A page made custom keeps the size it had, as KiCad's Page Settings does.
      const next = {
        width: key === 'paperWidth' ? nmToMm(asNm(value)) : width,
        height: key === 'paperHeight' ? nmToMm(asNm(value)) : height
      }
      if (next.width > 0 && next.height > 0) setSchematicPaper(document, { size, ...next })
    })
  return []
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildSchematicGroups(
  selectedItems: SelectionItem[],
  t: Translate,
  ctx: SchematicContext
): PropertyGroup[] {
  const pick = <T>(type: string, coll: T[]): T[] =>
    selectedItems
      .filter((i) => i.type === type)
      .map((i) => coll[i.index])
      .filter((n): n is T => !!n)

  const groups: PropertyGroup[] = []
  // A selected field shows its SYMBOL's group: the field's value is edited
  // there, so the panel stays useful instead of going blank on a selection the
  // canvas plainly made. `index` on a field ref is already the symbol's, and
  // the merge dedupes so selecting a symbol and its Reference is still one
  // group rather than the symbol listed twice.
  const symbols = [...new Set([...pick('symbol', ctx.symbols), ...pick('field', ctx.symbols)])]
  const labels = pick('label', ctx.labels)
  const wires = pick('wire', ctx.wires)
  const junctions = pick('junction', ctx.junctions)
  const noConnects = pick('no_connect', ctx.noConnects)

  if (symbols.length) groups.push(symbolGroup(t, symbols, ctx.document, ctx.links))
  if (labels.length) groups.push(labelGroup(t, ctx, labels))
  if (wires.length) groups.push(wireGroup(t, ctx, wires))
  if (junctions.length) groups.push(junctionGroup(t, ctx, junctions))
  if (noConnects.length) groups.push(noConnectGroup(t, noConnects))
  if (ctx.document)
    groups.push(
      ...sheetItemGroups(t, sheetItemSelection(ctx.document, selectedItems), ctx.sheetPages)
    )
  // Nothing selected is the sheet itself, as the board editor shows the board.
  if (!selectedItems.length && ctx.screen) groups.push(screenSheetGroup(t, ctx.screen))
  return [...groups, ...placeholderGroups(selectedItems, SCHEMATIC_GROUPED_TYPES, t)]
}

/**
 * The selected item types some group above answers for — a field and a
 * sheet's name or file answer through their owner's group. A selectable type
 * missing here gets an empty group (`placeholderGroups`), not a blank panel.
 */
export const SCHEMATIC_GROUPED_TYPES: ReadonlySet<string> = new Set([
  'symbol',
  'field',
  'label',
  'wire',
  'junction',
  'no_connect',
  'text',
  'text_box',
  ...SHEET_GRAPHIC_TYPES,
  'sheet',
  'sheet_field',
  'sheet_pin',
  'netclass_flag',
  'bus',
  'bus_entry',
  'image',
  'table'
])
