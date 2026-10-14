// Builds the property-table schema (PropertyGroup[]) for the footprint editor
// from the current selection, and maps an `edit(groupType, key, value)` back to
// a Partial<KicadX> patch for the matching updateXInAST helper. Pure: reads the
// typed KicadFootprint views, returns groups PropertyTable renders. Mirrors
// symbolPropertySchema.ts.
//
// One group per selected primitive type (pad / fpLine / fpPoly / arc / circle /
// rect / text / zone). With nothing selected, the root `footprint` group (name,
// side, description, locked, attributes) shows — the footprint itself is the
// selection then. Coordinates are KiCad Y-down; the `distance` editor's
// `negate` flips the sign for display, so field values stay the raw model mm.

import { KICAD_LAYER_COLORS } from '../kicad/layers'
import { mmToNm, nm, type Nm } from '../kicad/coordinates'
import type {
  KicadFontEffects,
  KicadFootprint,
  KicadFpArc,
  KicadFpCircle,
  KicadFpLine,
  KicadFpPoly,
  KicadFpRect,
  KicadFpText,
  KicadFpTextBox,
  KicadFpCurve,
  KicadPad,
  KicadPoint,
  KicadProperty,
  KicadTable,
  KicadTextBoxMargins,
  KicadZone,
  TextBoxPatch,
  ZoneKeepoutRules
} from '../kicad/footprint'
import { legacyTextBoxMargin } from '../kicad/footprint'
import type { SExprList } from '../kicad/sexpr'
import {
  readTeardropParams,
  TEARDROP_ROWS,
  teardropRowEdit,
  teardropRowValue,
  type TeardropParams
} from '../board/teardrop/params'
import { tk, type MessageKey } from '../messageKey'
import {
  collapseValue,
  inSection,
  H_ALIGN_OPTIONS,
  rgbaEq,
  V_ALIGN_OPTIONS,
  type EditorDescriptor,
  type PropertyEditValue,
  type PropertyField,
  type PropertyGroup,
  placeholderGroups,
  type Rgba,
  type SelectOption
} from '../propertyTable'

export type Translate = (key: string) => string

export interface SelectionItem {
  type: string
  index: number
}

/** Contextual options a host passes in (the document's layer set). */
export interface FootprintContext {
  layers: SelectOption[]
}

/** Layer select options with a color swatch, drawn from the KiCad palette. */
export function footprintLayerOptions(): SelectOption[] {
  return Object.keys(KICAD_LAYER_COLORS).map((value) => ({
    value,
    label: value,
    color: KICAD_LAYER_COLORS[value]
  }))
}

// KiCad enum option sets, with human-readable labels (the stored value stays the
// raw KiCad token). English dev; a per-editor locale namespace can wrap these at
// release time like the rest.
const opt = (value: string, label: string, icon?: string): SelectOption => ({
  value,
  label,
  ...(icon ? { icon } : {})
})
const PAD_TYPES = [
  opt('smd', 'SMD'),
  opt('thru_hole', 'Through-hole'),
  opt('np_thru_hole', 'NPTH (unplated)'),
  opt('connect', 'Connector')
]
const PAD_SHAPES = [
  opt('rect', 'Rectangle'),
  opt('circle', 'Circle'),
  opt('oval', 'Oval'),
  opt('roundrect', 'Rounded rect'),
  opt('trapezoid', 'Trapezoid'),
  opt('custom', 'Custom')
]
const STROKE_TYPES = [
  opt('default', 'Default'),
  opt('solid', 'Solid'),
  opt('dash', 'Dash'),
  opt('dot', 'Dot'),
  opt('dash_dot', 'Dash-dot'),
  opt('dash_dot_dot', 'Dash-dot-dot')
]
const FILL_KINDS = [opt('none', 'None'), opt('solid', 'Solid')]
const HATCH_STYLES = [opt('none', 'None'), opt('edge', 'Edge'), opt('full', 'Full')]
// Short label — renders as a segmented toggle (all options visible).
const SIDES = [opt('F.Cu', 'Front'), opt('B.Cu', 'Back')]
// Alignment toggles use icon segments (labels are the accessible names). Shared
// with the symbol editor's text rows — see propertyTable.ts.
const H_ALIGN = H_ALIGN_OPTIONS
const V_ALIGN = V_ALIGN_OPTIONS
/** Footprint `(attr …)` flags exposed as individual checkboxes, with UI labels. */
export const FOOTPRINT_ATTRS: Array<{ token: string; label: string }> = [
  { token: 'smd', label: 'SMD' },
  { token: 'through_hole', label: 'Through-hole' },
  { token: 'board_only', label: 'Not in schematic' },
  { token: 'exclude_from_pos_files', label: 'Excl. pos files' },
  { token: 'exclude_from_bom', label: 'Excl. BOM' },
  { token: 'allow_missing_courtyard', label: 'Allow no courtyard' },
  { token: 'dnp', label: 'DNP' }
]

const dist = (negate = false): EditorDescriptor => ({
  kind: 'distance',
  negate,
  step: 0.1,
  model: 'nm'
})
const ang = (): EditorDescriptor => ({ kind: 'angle' })
const select = (opts: SelectOption[]): EditorDescriptor => ({ kind: 'select', options: opts })
/** A select shown as an all-options-visible toggle — for short 2–3 option sets. */
const segmented = (opts: SelectOption[]): EditorDescriptor => ({ kind: 'segmented', options: opts })

const field = (
  key: string,
  labelKey: string,
  editor: EditorDescriptor,
  value: PropertyField['value']
): PropertyField => ({ key, labelKey, editor, value })

const layerField = (ctx: FootprintContext, members: Array<{ layer?: string }>): PropertyField =>
  field(
    'layer',
    'layer',
    select(ctx.layers),
    collapseValue(members, (m) => m.layer ?? '')
  )

const strokeColorField = <T extends { strokeColor?: Rgba }>(members: T[]): PropertyField =>
  field(
    'strokeColor',
    'strokeColor',
    { kind: 'color' },
    collapseValue<T, Rgba | null>(members, (m) => m.strokeColor ?? null, rgbaEq)
  )

// ---------------------------------------------------------------------------
// Per-primitive groups
// ---------------------------------------------------------------------------

/** A local override that inherits the board's value while blank. */
const override = (t: Translate): EditorDescriptor => ({
  ...dist(),
  optional: true,
  placeholder: t('footprintEditor.properties.fromBoard')
})

/** A paste ratio override: a fraction in the file, a percentage on screen, as KiCad shows it. */
const ratioOverride = (t: Translate): EditorDescriptor => ({
  kind: 'number',
  unit: '%',
  step: 1,
  optional: true,
  placeholder: t('footprintEditor.properties.fromBoard')
})
const ratioPercent = (ratio: number | undefined): number | null =>
  ratio === undefined ? null : Math.round(ratio * 100 * 1e6) / 1e6

/** KiCad's four local clearance overrides, on a pad or a footprint: blank inherits. */
const overrideFields = <
  T extends {
    clearance?: Nm
    solderMaskMargin?: Nm
    solderPasteMargin?: Nm
    solderPasteMarginRatio?: number
  }
>(
  t: Translate,
  items: T[]
): PropertyField[] => [
  field(
    'clearance',
    'padClearance',
    override(t),
    collapseValue(items, (i) => i.clearance ?? null)
  ),
  field(
    'solderMaskMargin',
    'maskMargin',
    override(t),
    collapseValue(items, (i) => i.solderMaskMargin ?? null)
  ),
  field(
    'solderPasteMargin',
    'pasteMargin',
    override(t),
    collapseValue(items, (i) => i.solderPasteMargin ?? null)
  ),
  field(
    'solderPasteMarginRatio',
    'pasteRatio',
    ratioOverride(t),
    collapseValue(items, (i) => ratioPercent(i.solderPasteMarginRatio))
  )
]

/** Whether a pad's hole is KiCad's oblong slot or a round drill. */
const HOLE_SHAPES = [opt('circle', 'Circle'), opt('oblong', 'Oblong')]

/**
 * A pad's rows. `placed` is a pad on a board: its position is the footprint's
 * to change (moving a pad moves its footprint there), so no position rows.
 */
export const padFields = (t: Translate, pads: KicadPad[], placed = false): PropertyField[] =>
  padGroup(t, pads).fields.filter(
    (f) => !placed || (f.key !== 'posX' && f.key !== 'posY' && f.key !== 'angle')
  )

const padGroup = (t: Translate, pads: KicadPad[]): PropertyGroup => {
  const isThruHole = pads.every((p) => p.type === 'thru_hole' || p.type === 'np_thru_hole')
  const isRoundrect = pads.every((p) => p.shape === 'roundrect')
  const isOblong = pads.every((p) => !!p.drill?.oval)
  const fields: PropertyField[] = [
    field(
      'posX',
      'posX',
      dist(),
      collapseValue(pads, (p) => p.position.x)
    ),
    field(
      'posY',
      'posY',
      dist(true),
      collapseValue(pads, (p) => p.position.y)
    ),
    field(
      'angle',
      'angle',
      ang(),
      collapseValue(pads, (p) => p.position.angle ?? 0)
    ),
    ...inSection('pad', [
      field(
        'number',
        'number',
        { kind: 'text' },
        collapseValue(pads, (p) => p.number)
      ),
      field(
        'type',
        'type',
        select(PAD_TYPES),
        collapseValue(pads, (p) => p.type)
      ),
      field(
        'shape',
        'shape',
        select(PAD_SHAPES),
        collapseValue(pads, (p) => p.shape)
      ),
      field(
        'width',
        'width',
        dist(),
        collapseValue(pads, (p) => p.size.w)
      ),
      field(
        'height',
        'height',
        dist(),
        collapseValue(pads, (p) => p.size.h)
      ),
      ...(isRoundrect
        ? [
            field(
              'roundRatio',
              'roundRatio',
              { kind: 'number', step: 0.05, min: 0, max: 0.5 },
              collapseValue(pads, (p) => p.roundrectRatio ?? 0.25)
            )
          ]
        : [])
    ]),
    ...(isThruHole
      ? inSection('hole', [
          field(
            'holeShape',
            'holeShape',
            segmented(HOLE_SHAPES),
            collapseValue(pads, (p) => (p.drill?.oval ? 'oblong' : 'circle'))
          ),
          field(
            'drill',
            'drill',
            dist(),
            collapseValue(pads, (p) => p.drill?.oval?.width ?? p.drill?.diameter ?? 0)
          ),
          ...(isOblong
            ? [
                field(
                  'drillY',
                  'holeSizeY',
                  dist(),
                  collapseValue(pads, (p) => p.drill?.oval?.height ?? 0)
                )
              ]
            : [])
        ])
      : []),
    ...inSection('overrides', overrideFields(t, pads)),
    ...teardropFields(
      pads.map((p) => readTeardropParams(p._raw as SExprList)),
      true
    )
  ]
  return { type: 'pad', title: t('shared.primitives.pad'), count: pads.length, fields }
}

/**
 * A pad's or via's Teardrops rows, KiCad's property group of that name: the
 * switch, and its settings once every item has it on. Prefer zone connection
 * is a pad's only.
 */
export const teardropFields = (all: TeardropParams[], pads: boolean): PropertyField[] => {
  const row = (key: (typeof TEARDROP_ROWS)[number], editor: EditorDescriptor): PropertyField =>
    field(
      key,
      key,
      editor,
      collapseValue(all, (p) => teardropRowValue(p, key))
    )
  const percent: EditorDescriptor = { kind: 'number', unit: '%', step: 10, min: 0, max: 100 }
  const on = all.length > 0 && all.every((p) => p.enabled)
  return inSection('teardrops', [
    row('teardropsEnabled', { kind: 'checkbox' }),
    ...(on
      ? [
          row('teardropBestLength', { ...percent, max: undefined }),
          row('teardropMaxLength', dist()),
          row('teardropBestWidth', percent),
          row('teardropMaxWidth', dist()),
          row('teardropCurved', { kind: 'checkbox' }),
          row('teardropTwoSegments', { kind: 'checkbox' }),
          row('teardropMaxTrackWidth', percent),
          ...(pads ? [row('teardropPreferZone', { kind: 'checkbox' })] : [])
        ]
      : [])
  ])
}

// ---------------------------------------------------------------------------
// Shapes — KiCad's Shape Properties (EDA_SHAPE): the geometry it lists for
// each kind, then the stroke and fill. The layer stays above, a basic row.
// Shared with the board's graphics (`pcbPropertySchema.ts`); `negateY` shows Y
// up, as the footprint editor does.
// ---------------------------------------------------------------------------

type XY = { x: Nm; y: Nm }
interface ShapeLike {
  layer?: string
  strokeWidth?: Nm
  strokeType?: string
  strokeColor?: Rgba
}

const xyFields = <T>(
  prefix: 'start' | 'end' | 'mid' | 'center',
  items: T[],
  at: (item: T) => XY,
  negateY: boolean
): PropertyField[] => [
  field(
    `${prefix}X`,
    `${prefix}X`,
    dist(),
    collapseValue(items, (i) => at(i).x)
  ),
  field(
    `${prefix}Y`,
    `${prefix}Y`,
    dist(negateY),
    collapseValue(items, (i) => at(i).y)
  )
]

const strokeFields = <T extends ShapeLike>(items: T[]): PropertyField[] => [
  field(
    'strokeWidth',
    'strokeWidth',
    dist(),
    collapseValue(items, (i) => i.strokeWidth ?? 0)
  ),
  field(
    'strokeType',
    'strokeType',
    select(STROKE_TYPES),
    collapseValue(items, (i) => i.strokeType ?? 'default')
  ),
  strokeColorField(items)
]

const fillField = <T extends { fill?: string }>(items: T[]): PropertyField =>
  field(
    'fill',
    'fill',
    segmented(FILL_KINDS),
    collapseValue(items, (i) => i.fill ?? 'none')
  )

/** The rows of one kind of shape, by its kind; `GraphicKind` names them across editors. */
export type GraphicKind = 'line' | 'arc' | 'circle' | 'rect' | 'poly' | 'curve'

export function shapeFields(
  kind: GraphicKind,
  ctx: FootprintContext,
  items: Array<KicadFpLine | KicadFpArc | KicadFpCircle | KicadFpRect | KicadFpPoly | KicadFpCurve>,
  negateY: boolean
): PropertyField[] {
  const geometry = ((): PropertyField[] => {
    switch (kind) {
      case 'line':
      case 'arc': {
        const ls = items as Array<KicadFpLine | KicadFpArc>
        return [
          ...xyFields('start', ls, (l) => l.start, negateY),
          ...(kind === 'arc' ? xyFields('mid', ls as KicadFpArc[], (a) => a.mid, negateY) : []),
          ...xyFields('end', ls, (l) => l.end, negateY)
        ]
      }
      case 'circle': {
        const cs = items as KicadFpCircle[]
        return [
          ...xyFields('center', cs, (c) => c.center, negateY),
          field(
            'radius',
            'radius',
            dist(),
            collapseValue(cs, (c) =>
              nm(Math.round(Math.hypot(c.end.x - c.center.x, c.end.y - c.center.y)))
            )
          )
        ]
      }
      case 'rect': {
        const rs = items as KicadFpRect[]
        return [
          ...xyFields('start', rs, (r) => r.start, negateY),
          ...xyFields('end', rs, (r) => r.end, negateY),
          field(
            'rectWidth',
            'width',
            dist(),
            collapseValue(rs, (r) => r.end.x - r.start.x)
          ),
          field(
            'rectHeight',
            'height',
            dist(negateY),
            collapseValue(rs, (r) => r.end.y - r.start.y)
          ),
          field(
            'cornerRadius',
            'cornerRadius',
            dist(),
            collapseValue(rs, (r) => r.radius ?? 0)
          )
        ]
      }
      case 'curve': {
        const cs = items as KicadFpCurve[]
        const zero = { x: nm(0), y: nm(0) }
        return [
          ...xyFields('start', cs, (c) => c.points[0] ?? zero, negateY),
          ...xyFields('end', cs, (c) => c.points[3] ?? zero, negateY)
        ]
      }
      case 'poly': {
        const ps = items as KicadFpPoly[]
        // Vertices are edited on canvas, not here — a read-only count is the ceiling.
        return [
          {
            ...field(
              'points',
              'points',
              { kind: 'text' },
              collapseValue(ps, (p) => `${p.points.length}`)
            ),
            readonly: true
          }
        ]
      }
    }
  })()
  const filled = kind === 'circle' || kind === 'rect' || kind === 'poly'
  return [
    layerField(ctx, items),
    ...inSection('shape', [
      ...geometry,
      ...strokeFields(items as ShapeLike[]),
      ...(filled ? [fillField(items as Array<{ fill?: string }>)] : [])
    ])
  ]
}

const SHAPE_TITLES: Record<GraphicKind, MessageKey> = {
  line: tk('shared.primitives.line'),
  arc: tk('shared.primitives.arc'),
  circle: tk('shared.primitives.circle'),
  rect: tk('shared.primitives.rectangle'),
  poly: tk('shared.primitives.polygon'),
  curve: tk('shared.primitives.curve')
}

const shapeGroup =
  <T extends KicadFpLine | KicadFpArc | KicadFpCircle | KicadFpRect | KicadFpPoly | KicadFpCurve>(
    kind: GraphicKind
  ) =>
  (t: Translate, ctx: FootprintContext, items: T[]): PropertyGroup => ({
    type: kind,
    title: t(SHAPE_TITLES[kind]),
    count: items.length,
    fields: shapeFields(kind, ctx, items, true)
  })

/**
 * A shape edit KiCad lists as geometry we store another way — a circle's
 * radius, a rectangle's size, a Bézier's ends — as the patch its writer takes.
 * Undefined for a key that maps directly.
 */
function shapePatch(
  kind: GraphicKind,
  key: string,
  value: PropertyEditValue,
  node: unknown
): Record<string, unknown> | undefined {
  const v = numberVal(value)
  if (kind === 'circle' && key === 'radius') {
    const c = node as KicadFpCircle
    const dx = c.end.x - c.center.x
    const dy = c.end.y - c.center.y
    const len = Math.hypot(dx, dy)
    const [ux, uy] = len > 0 ? [dx / len, dy / len] : [1, 0]
    return {
      end: { x: nm(Math.round(c.center.x + ux * v)), y: nm(Math.round(c.center.y + uy * v)) }
    }
  }
  if (kind === 'rect') {
    const r = node as KicadFpRect
    if (key === 'rectWidth') return { end: { x: nm(r.start.x + v) } }
    if (key === 'rectHeight') return { end: { y: nm(r.start.y + v) } }
    if (key === 'cornerRadius') return { radius: nm(v) }
  }
  if (kind === 'curve' && /^(start|end)[XY]$/.test(key)) {
    const points = (node as KicadFpCurve).points.map((p) => ({ ...p }))
    const at = points[key.startsWith('start') ? 0 : 3]
    if (at) at[key.endsWith('X') ? 'x' : 'y'] = nm(v)
    return { points }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Text boxes and tables — shared with the board (`pcbPropertySchema.ts`).
// ---------------------------------------------------------------------------

/** A text box's rows, as KiCad lists PCB_TEXTBOX's: its text, then border and margins. */
export const textBoxFields = (ctx: FootprintContext, bs: KicadFpTextBox[]): PropertyField[] => [
  layerField(ctx, bs),
  ...inSection('text', [
    // Drawn text — untrimmed; see `skipTrim`.
    field(
      'text',
      'text',
      { kind: 'text', skipTrim: true },
      collapseValue(bs, (b) => b.text)
    ),
    field(
      'knockout',
      'knockout',
      { kind: 'checkbox' },
      collapseValue(bs, (b) => b.knockout)
    )
  ]),
  ...inSection('border', [
    field(
      'border',
      'border',
      { kind: 'checkbox' },
      collapseValue(bs, (b) => b.border)
    ),
    field(
      'strokeType',
      'strokeType',
      select(STROKE_TYPES),
      collapseValue(bs, (b) => b.strokeType ?? 'default')
    ),
    field(
      'strokeWidth',
      'strokeWidth',
      dist(),
      collapseValue(bs, (b) => b.strokeWidth ?? 0)
    )
  ]),
  ...inSection(
    'margins',
    (['Left', 'Top', 'Right', 'Bottom'] as const).map((side) =>
      field(
        `margin${side}`,
        `margin${side}`,
        dist(),
        collapseValue(bs, (b) => textBoxMargins(b)[side.toLowerCase() as keyof KicadTextBoxMargins])
      )
    )
  )
]

/** A box's margins, or what KiCad derives for a file from before they were written. */
const textBoxMargins = (b: KicadFpTextBox): KicadTextBoxMargins => {
  if (b.margins) return b.margins
  const m = legacyTextBoxMargin(
    b.strokeWidth ?? 0,
    b.fontEffects?.height ?? DEFAULT_TEXT_EFFECTS.height
  )
  return { left: m, top: m, right: m, bottom: m }
}

/** A text box edit as `updateTextBoxInAST`'s patch; undefined for a key that maps directly. */
function textBoxPatch(
  key: string,
  value: PropertyEditValue,
  node: unknown
): TextBoxPatch | undefined {
  const match = /^margin(Left|Top|Right|Bottom)$/.exec(key)
  if (!match) return undefined
  const side = match[1].toLowerCase() as keyof KicadTextBoxMargins
  return { margins: { ...textBoxMargins(node as KicadFpTextBox), [side]: nm(numberVal(value)) } }
}

/**
 * A table's rows: its size read-only (its cells are edited on the canvas, which
 * is open work), its layer, and its border and separator lines.
 */
export const tableFields = (ctx: FootprintContext, ts: KicadTable[]): PropertyField[] => [
  layerField(ctx, ts),
  {
    ...field(
      'columns',
      'columns',
      { kind: 'text' },
      collapseValue(ts, (x) => `${x.columnCount}`)
    ),
    readonly: true
  },
  {
    ...field(
      'rows',
      'rows',
      { kind: 'text' },
      collapseValue(ts, (x) => `${x.rowHeights.length}`)
    ),
    readonly: true
  },
  ...inSection('border', [
    field(
      'borderExternal',
      'externalBorder',
      { kind: 'checkbox' },
      collapseValue(ts, (x) => x.borderExternal)
    ),
    field(
      'borderHeader',
      'headerBorder',
      { kind: 'checkbox' },
      collapseValue(ts, (x) => x.borderHeader)
    ),
    field(
      'borderStrokeWidth',
      'strokeWidth',
      dist(),
      collapseValue(ts, (x) => x.borderStrokeWidth ?? 0)
    ),
    field(
      'separatorRows',
      'rowSeparators',
      { kind: 'checkbox' },
      collapseValue(ts, (x) => x.separatorRows)
    ),
    field(
      'separatorCols',
      'colSeparators',
      { kind: 'checkbox' },
      collapseValue(ts, (x) => x.separatorCols)
    ),
    field(
      'separatorStrokeWidth',
      'separatorWidth',
      dist(),
      collapseValue(ts, (x) => x.separatorStrokeWidth ?? 0)
    )
  ])
]

const textBoxGroup = (
  t: Translate,
  ctx: FootprintContext,
  bs: KicadFpTextBox[]
): PropertyGroup => ({
  type: 'textbox',
  title: t('shared.primitives.textBox'),
  count: bs.length,
  fields: textBoxFields(ctx, bs)
})

/** The rows a drawn string has — an fp_text's, a field's and a board text's. */
type TextLike = Pick<KicadFpText, 'position' | 'layer' | 'hide' | 'fontEffects' | 'knockout'> & {
  keepUpright?: boolean
}

/** KiCad's default text: 1 mm glyphs, 0.15 mm strokes. */
const DEFAULT_TEXT_EFFECTS = { width: mmToNm(1), height: mmToNm(1), thickness: mmToNm(0.15) }

/**
 * A drawn string's rows, as KiCad's properties panel lists them (`EDA_TEXT`
 * with `PCB_TEXT`'s and `PCB_FIELD`'s additions). `visible` is a field's row
 * only — KiCad writes `hide` on nothing else; `keepUpright` is a footprint
 * text's only; `negateY` shows Y up, as the footprint editor does.
 */
export const textFields = <T extends TextLike>(
  ctx: FootprintContext,
  ts: T[],
  textOf: (x: T) => string,
  opts: { negateY: boolean; visible: boolean; keepUpright: boolean }
): PropertyField[] => {
  const effect = (read: (e: KicadFontEffects) => Nm, fallback: Nm) => (x: T) =>
    x.fontEffects ? read(x.fontEffects) : fallback
  return [
    field(
      'posX',
      'posX',
      dist(),
      collapseValue(ts, (x) => x.position?.x ?? 0)
    ),
    field(
      'posY',
      'posY',
      dist(opts.negateY),
      collapseValue(ts, (x) => x.position?.y ?? 0)
    ),
    field(
      'angle',
      'angle',
      ang(),
      collapseValue(ts, (x) => x.position?.angle ?? 0)
    ),
    layerField(ctx, ts),
    ...inSection('text', [
      field(
        'text',
        'text',
        // Drawn text — untrimmed; see `skipTrim`.
        { kind: 'text', skipTrim: true },
        collapseValue(ts, textOf)
      ),
      ...(opts.visible
        ? [
            field(
              'hidden',
              'hidden',
              { kind: 'checkbox' },
              collapseValue(ts, (x) => !!x.hide)
            )
          ]
        : []),
      field(
        'knockout',
        'knockout',
        { kind: 'checkbox' },
        collapseValue(ts, (x) => x.knockout)
      ),
      ...(opts.keepUpright
        ? [
            field(
              'keepUpright',
              'keepUpright',
              { kind: 'checkbox' },
              collapseValue(ts, (x) => x.keepUpright ?? true)
            )
          ]
        : []),
      field(
        'textWidth',
        'width',
        dist(),
        collapseValue(
          ts,
          effect((e) => e.width, DEFAULT_TEXT_EFFECTS.width)
        )
      ),
      field(
        'textHeight',
        'height',
        dist(),
        collapseValue(
          ts,
          effect((e) => e.height, DEFAULT_TEXT_EFFECTS.height)
        )
      ),
      field(
        'thickness',
        'thickness',
        dist(),
        collapseValue(
          ts,
          effect((e) => e.thickness, DEFAULT_TEXT_EFFECTS.thickness)
        )
      ),
      field(
        'bold',
        'bold',
        { kind: 'checkbox' },
        collapseValue(ts, (x) => !!x.fontEffects?.bold)
      ),
      field(
        'italic',
        'italic',
        { kind: 'checkbox' },
        collapseValue(ts, (x) => !!x.fontEffects?.italic)
      ),
      field(
        'mirror',
        'mirror',
        { kind: 'checkbox' },
        collapseValue(ts, (x) => !!x.fontEffects?.mirror)
      ),
      field(
        'hAlign',
        'hAlign',
        segmented(H_ALIGN),
        collapseValue(ts, (x) => x.fontEffects?.hAlign ?? 'center')
      ),
      field(
        'vAlign',
        'vAlign',
        segmented(V_ALIGN),
        collapseValue(ts, (x) => x.fontEffects?.vAlign ?? 'center')
      )
    ])
  ]
}

const textGroup = (t: Translate, ctx: FootprintContext, ts: KicadFpText[]): PropertyGroup => ({
  type: 'text',
  title: t('shared.primitives.text'),
  count: ts.length,
  // A v6 file's reference and value are fp_text, and fields all the same.
  fields: textFields(ctx, ts, (x) => x.text, {
    negateY: true,
    visible: ts.some((x) => x.type !== 'user'),
    keepUpright: true
  })
})

/** A field (Reference, Value, …): the `(property …)` KiCad 8+ draws in place of fp_text. */
const propertyGroup = (
  t: Translate,
  ctx: FootprintContext,
  ps: KicadProperty[]
): PropertyGroup => ({
  type: 'property',
  title: t('shared.primitives.field'),
  count: ps.length,
  fields: [
    // Renaming a field is not offered yet; Reference and Value never rename.
    {
      ...field(
        'name',
        'name',
        { kind: 'text' },
        collapseValue(ps, (p) => p.key)
      ),
      readonly: true
    },
    ...textFields(ctx, ps, (p) => p.value, { negateY: true, visible: true, keepUpright: true })
  ]
})

/** A point's position, size and layer, on a board or in a footprint. */
export const pointFields = (
  ctx: FootprintContext,
  ps: KicadPoint[],
  negateY = true
): PropertyField[] => [
  field(
    'posX',
    'posX',
    dist(),
    collapseValue(ps, (p) => p.position.x)
  ),
  field(
    'posY',
    'posY',
    dist(negateY),
    collapseValue(ps, (p) => p.position.y)
  ),
  field(
    'size',
    'size',
    dist(),
    collapseValue(ps, (p) => p.size)
  ),
  layerField(ctx, ps)
]

const pointGroup = (t: Translate, ctx: FootprintContext, ps: KicadPoint[]): PropertyGroup => ({
  type: 'point',
  title: t('shared.primitives.point'),
  count: ps.length,
  fields: pointFields(ctx, ps)
})

const tableGroup = (t: Translate, ctx: FootprintContext, ts: KicadTable[]): PropertyGroup => ({
  type: 'table',
  title: t('shared.primitives.table'),
  count: ts.length,
  fields: tableFields(ctx, ts)
})

/** The five keepout switches, checked = blocked, as KiCad's dialog reads ("Keep out tracks"). */
export const KEEPOUT_BLOCKS = [
  ['blockTracks', 'tracks'],
  ['blockVias', 'vias'],
  ['blockPads', 'pads'],
  ['blockPour', 'copperpour'],
  ['blockFootprints', 'footprints']
] as const

export const keepoutFields = (zs: Array<{ keepoutRules?: ZoneKeepoutRules }>): PropertyField[] =>
  inSection(
    'keepout',
    KEEPOUT_BLOCKS.map(([key, rule]) =>
      field(
        key,
        key,
        { kind: 'checkbox' },
        collapseValue(zs, (z) => !(z.keepoutRules?.[rule] ?? false))
      )
    )
  )

const zoneGroup = (t: Translate, ctx: FootprintContext, zs: KicadZone[]): PropertyGroup => ({
  type: 'zone',
  title: t('shared.primitives.ruleArea'),
  count: zs.length,
  fields: [
    layerField(ctx, zs),
    field(
      'minThickness',
      'minThickness',
      dist(),
      collapseValue(zs, (z) => z.minThickness ?? 0)
    ),
    ...(zs.every((z) => z.isKeepout) ? keepoutFields(zs) : []),
    // How the outline draws on the canvas; not one of KiCad's panel rows.
    ...inSection('shape', [
      field(
        'hatchStyle',
        'hatchStyle',
        segmented(HATCH_STYLES),
        collapseValue(zs, (z) => z.hatchStyle ?? 'edge')
      ),
      field(
        'hatchPitch',
        'hatchPitch',
        dist(),
        collapseValue(zs, (z) => z.hatchPitch ?? 0)
      )
    ])
  ]
})

/** The zone-connection select's value for "use the zone's setting" (no `zone_connect`). */
export const ZONE_CONNECT_INHERIT = 'inherit'

/**
 * KiCad's Footprint Properties choices, in its order: the zone's own setting,
 * solid, thermal reliefs, none. "Thermal reliefs for PTH" (3) is written by
 * other tools; it is offered only on a footprint that already carries it, so
 * the select can show what the file says.
 */
const zoneConnectOptions = (t: Translate, current: number | undefined): SelectOption[] => [
  opt(ZONE_CONNECT_INHERIT, t('footprintEditor.zoneConnect.inherit')),
  opt('2', t('footprintEditor.zoneConnect.solid')),
  opt('1', t('footprintEditor.zoneConnect.thermal')),
  opt('0', t('footprintEditor.zoneConnect.none')),
  ...(current === 3 ? [opt('3', t('footprintEditor.zoneConnect.thermalTht'))] : [])
]

/**
 * A footprint's Attributes and Overrides sections, KiCad's, for the footprint
 * editor's root group and a placed footprint's group on the board alike.
 */
export const footprintAttributeFields = (fps: KicadFootprint[]): PropertyField[] =>
  inSection(
    'attributes',
    FOOTPRINT_ATTRS.map(({ token, label }): PropertyField => ({
      key: `attr:${token}`,
      label,
      editor: { kind: 'checkbox' },
      value: collapseValue(fps, (fp) => fp.attributes.includes(token))
    }))
  )

export const footprintOverrideFields = (t: Translate, fps: KicadFootprint[]): PropertyField[] => {
  const connect = collapseValue(fps, (fp) => fp.zoneConnect)
  return inSection('overrides', [
    ...overrideFields(t, fps),
    field(
      'zoneConnect',
      'padConnection',
      select(zoneConnectOptions(t, typeof connect === 'number' ? connect : undefined)),
      collapseValue(fps, (fp) =>
        fp.zoneConnect === undefined ? ZONE_CONNECT_INHERIT : String(fp.zoneConnect)
      )
    ),
    field(
      'attr:allow_soldermask_bridges',
      'bridgedMask',
      { kind: 'checkbox' },
      collapseValue(fps, (fp) => fp.attributes.includes('allow_soldermask_bridges'))
    )
  ])
}

const footprintGroup = (t: Translate, fp: KicadFootprint): PropertyGroup => ({
  type: 'footprint',
  title: t('shared.primitives.footprint'),
  count: 1,
  fields: [
    field('name', 'name', { kind: 'text' }, fp.name),
    field('side', 'side', segmented(SIDES), fp.layer ?? 'F.Cu'),
    field('description', 'description', { kind: 'text' }, fp.description ?? ''),
    field('keywords', 'keywords', { kind: 'text' }, fp.tags ?? ''),
    field('locked', 'locked', { kind: 'checkbox' }, fp.locked),
    ...footprintAttributeFields([fp]),
    ...footprintOverrideFields(t, [fp])
  ]
})

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Every item type the footprint editor selects, and the collection it indexes —
 * in the order the panel shows their groups. The editor resolves a selection
 * through this map, and `GROUP_BUILDERS` is typed against it, so a type made
 * selectable without a property group does not compile.
 */
export const FOOTPRINT_ITEM_COLLECTIONS = {
  pad: 'pads',
  line: 'fpLines',
  arc: 'fpArcs',
  circle: 'fpCircles',
  rect: 'fpRects',
  poly: 'fpPolys',
  curve: 'fpCurves',
  property: 'properties',
  text: 'fpTexts',
  textbox: 'fpTextBoxes',
  table: 'tables',
  point: 'points',
  zone: 'zones'
} as const satisfies Record<string, keyof KicadFootprint>

export type FootprintItemType = keyof typeof FOOTPRINT_ITEM_COLLECTIONS

type ItemOf<K extends FootprintItemType> =
  KicadFootprint[(typeof FOOTPRINT_ITEM_COLLECTIONS)[K]] extends Array<infer T> ? T : never

const GROUP_BUILDERS: {
  [K in FootprintItemType]: (
    t: Translate,
    ctx: FootprintContext,
    items: ItemOf<K>[]
  ) => PropertyGroup
} = {
  pad: (t, _ctx, items) => padGroup(t, items),
  line: shapeGroup('line'),
  arc: shapeGroup('arc'),
  circle: shapeGroup('circle'),
  rect: shapeGroup('rect'),
  poly: shapeGroup('poly'),
  curve: shapeGroup('curve'),
  property: propertyGroup,
  text: textGroup,
  textbox: textBoxGroup,
  table: tableGroup,
  point: pointGroup,
  zone: zoneGroup
}

const GROUPED_TYPES: ReadonlySet<string> = new Set(Object.keys(GROUP_BUILDERS))

export const isFootprintItemType = (type: string): type is FootprintItemType =>
  Object.hasOwn(FOOTPRINT_ITEM_COLLECTIONS, type)

/** The collection a selected item type indexes, or undefined for a type the editor does not select. */
export function footprintCollection(
  footprint: KicadFootprint,
  type: string
): unknown[] | undefined {
  return isFootprintItemType(type) ? footprint[FOOTPRINT_ITEM_COLLECTIONS[type]] : undefined
}

/**
 * Build the property groups for the current selection. Only the selected
 * primitive types get a group; the root `footprint` group shows only when
 * nothing is selected. A selected type with no group still gets an empty one
 * (`placeholderGroups`), so the panel never shows the footprint for it.
 */
export function buildFootprintGroups(
  footprint: KicadFootprint | null,
  selectedItems: SelectionItem[],
  t: Translate,
  ctx: FootprintContext
): PropertyGroup[] {
  if (!footprint) return []
  if (selectedItems.length === 0) return [footprintGroup(t, footprint)]
  const groups: PropertyGroup[] = []
  for (const type of Object.keys(GROUP_BUILDERS) as FootprintItemType[]) {
    const coll = footprint[FOOTPRINT_ITEM_COLLECTIONS[type]] as unknown[]
    const items = selectedItems
      .filter((i) => i.type === type)
      .map((i) => coll[i.index])
      .filter((n) => !!n)
    if (!items.length) continue
    const build = GROUP_BUILDERS[type] as (
      t: Translate,
      ctx: FootprintContext,
      items: unknown[]
    ) => PropertyGroup
    groups.push(build(t, ctx, items))
  }
  return [...groups, ...placeholderGroups(selectedItems, GROUPED_TYPES, t)]
}

// ---------------------------------------------------------------------------
// edit(key, value) → Partial<KicadX> patch for the matching updateXInAST helper.
// `node` is the target primitive, needed to merge font effects / attributes.
// ---------------------------------------------------------------------------

const numberVal = (v: PropertyEditValue): number => (typeof v === 'number' ? v : 0)

const isGraphicKind = (type: string): type is GraphicKind =>
  ['line', 'arc', 'circle', 'rect', 'poly', 'curve'].includes(type)

/** An override row's edit: blank (null) removes it; the ratio is a percentage on screen. */
function overridePatch(key: string, value: PropertyEditValue): Record<string, unknown> | undefined {
  if (key === 'solderPasteMarginRatio')
    return { solderPasteMarginRatio: typeof value === 'number' ? value / 100 : null }
  if (key === 'clearance' || key === 'solderMaskMargin' || key === 'solderPasteMargin')
    return { [key]: typeof value === 'number' ? value : null }
  return undefined
}

/**
 * A board graphic's, text box's or text's edit, for the PCB editor: the same
 * rows as the footprint's, under the board's own type names.
 */
export function boardGraphicPatch(
  type: string,
  key: string,
  value: PropertyEditValue,
  node: unknown
): Record<string, unknown> {
  const kind = BOARD_GRAPHIC_KINDS[type]
  return footprintPatch(kind ?? type, key, value, node)
}

const BOARD_GRAPHIC_KINDS: Record<string, string> = {
  gr_line: 'line',
  gr_arc: 'arc',
  gr_circle: 'circle',
  gr_rect: 'rect',
  gr_poly: 'poly',
  gr_curve: 'curve',
  gr_text: 'text',
  gr_text_box: 'textbox'
}

/**
 * A drawn string's edit as its patch — a footprint's fp_text and field, a
 * board's gr_text: font effects merge onto `node`'s current ones.
 */
function textPatch(key: string, value: PropertyEditValue, node: unknown): Record<string, unknown> {
  if (key === 'angle') return { position: { angle: numberVal(value) } }
  if (key === 'hidden') return { hide: !!value }
  if (key === 'knockout') return { knockout: !!value }
  if (key === 'keepUpright') return { keepUpright: !!value }
  const base = (node as TextLike | undefined)?.fontEffects ?? DEFAULT_TEXT_EFFECTS
  const effects = (patch: Partial<KicadFontEffects>): Record<string, unknown> => ({
    fontEffects: { ...base, ...patch }
  })
  if (key === 'textWidth') return effects({ width: numberVal(value) as Nm })
  if (key === 'textHeight') return effects({ height: numberVal(value) as Nm })
  if (key === 'thickness') return effects({ thickness: numberVal(value) as Nm })
  if (key === 'bold') return effects({ bold: !!value })
  if (key === 'italic') return effects({ italic: !!value })
  if (key === 'mirror') return effects({ mirror: !!value })
  if (key === 'hAlign')
    return effects({ hAlign: value === 'center' ? undefined : (value as 'left' | 'right') })
  if (key === 'vAlign')
    return effects({ vAlign: value === 'center' ? undefined : (value as 'top' | 'bottom') })
  return { [key]: value }
}

/** Map a pad/graphic/text/zone/footprint field edit to its update patch. */
export function footprintPatch(
  type: string,
  key: string,
  value: PropertyEditValue,
  node: unknown
): Record<string, unknown> {
  const shape = isGraphicKind(type) ? shapePatch(type, key, value, node) : undefined
  if (shape) return shape
  if (type === 'textbox') {
    const box = textBoxPatch(key, value, node)
    if (box) return box
  }
  if (type === 'pad' && key.startsWith('teardrop')) {
    const pad = node as KicadPad
    const next = teardropRowEdit(readTeardropParams(pad._raw as SExprList), key, value)
    if (next) return { teardrops: next }
  }
  const block = KEEPOUT_BLOCKS.find(([k]) => k === key)
  if (block) return { keepoutRules: { [block[1]]: !value } }
  // Coordinate keys shared by graphics.
  const coord: Record<string, [string, 'x' | 'y']> = {
    posX: ['position', 'x'],
    posY: ['position', 'y'],
    startX: ['start', 'x'],
    startY: ['start', 'y'],
    midX: ['mid', 'x'],
    midY: ['mid', 'y'],
    endX: ['end', 'x'],
    endY: ['end', 'y'],
    centerX: ['center', 'x'],
    centerY: ['center', 'y']
  }
  if (key in coord) {
    const [group, axis] = coord[key]
    return { [group]: { [axis]: numberVal(value) } }
  }
  if (type === 'pad') {
    const drill = (node as KicadPad | undefined)?.drill
    if (key === 'width') return { size: { w: numberVal(value) } }
    if (key === 'height') return { size: { h: numberVal(value) } }
    if (key === 'angle') return { position: { angle: numberVal(value) } }
    if (key === 'drill') {
      const v = numberVal(value) as Nm
      return {
        drill: drill?.oval ? { diameter: v, oval: { ...drill.oval, width: v } } : { diameter: v }
      }
    }
    if (key === 'drillY' && drill?.oval)
      return { drill: { oval: { ...drill.oval, height: numberVal(value) } } }
    if (key === 'holeShape') {
      const d = drill?.oval?.width ?? drill?.diameter ?? (0 as Nm)
      return {
        drill: { oval: value === 'oblong' ? { width: d, height: d } : undefined, diameter: d }
      }
    }
    if (key === 'roundRatio') return { roundrectRatio: numberVal(value) }
    return overridePatch(key, value) ?? { [key]: value }
  }
  if (type === 'text' || type === 'property') {
    if (type === 'property' && key === 'text') return { value }
    return textPatch(key, value, node)
  }
  if (type === 'point' && key === 'size') return { size: numberVal(value) }
  if (type === 'footprint') {
    if (key === 'side') return { layer: value }
    if (key === 'keywords') return { tags: typeof value === 'string' ? value : '' }
    const over = overridePatch(key, value)
    if (over) return over
    if (key === 'zoneConnect') {
      return { zoneConnect: value === ZONE_CONNECT_INHERIT ? null : Number(value) }
    }
    if (key.startsWith('attr:')) {
      const attr = key.slice(5)
      const current = (node as KicadFootprint).attributes
      const attributes = value
        ? [...new Set([...current, attr])]
        : current.filter((a) => a !== attr)
      return { attributes }
    }
    return { [key]: value }
  }
  // line / arc / circle / rect / poly / zone: flat keys map directly.
  return { [key]: value }
}
