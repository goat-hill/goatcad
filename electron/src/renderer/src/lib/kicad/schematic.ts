// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
import {
  cloneNodeDeep,
  findChild,
  findChildren,
  getAtomValues,
  getFirstAtomValue,
  getToken,
  getXY,
  parseSExpr,
  serializeSExpr,
  type SExprAtom,
  type SExprList,
  type SExprNode
} from './sexpr'
import {
  findOrCreateChild,
  makeAtom,
  makeList,
  setNodeValue,
  setPositionalAtom,
  setScalarChild
} from './footprint'
import { formatKicadNumber, formatNmAtom, mmToNm, nm, NM_PER_MIL, type Nm } from './coordinates'
import { parseColorChild, removeColorChild, setColorChild, type Rgba } from './color'
import { DEFAULT_TEXT_BOX_MARGIN_NM } from '../schematic/textBox'

/**
 * A point in the schematic/symbol domain model: integer nanometers, y-down
 * KiCad sheet space. Every distance field in this model is `Nm`; angles stay
 * fractional degrees.
 */
export interface Point {
  x: Nm
  y: Nm
}

const ZERO: Nm = 0 as Nm
/** KiCad's default text size, 50 mil (1.27 mm). */
export const DEFAULT_FONT_SIZE_NM: Nm = nm(50 * NM_PER_MIL)
/** KiCad's default symbol stroke width, 10 mil (0.254 mm). */
const DEFAULT_STROKE_WIDTH_NM: Nm = nm(10 * NM_PER_MIL)
/** KiCad's default pin length, 100 mil (2.54 mm). */
const DEFAULT_PIN_LENGTH_NM: Nm = nm(100 * NM_PER_MIL)
/** KiCad's default pin-name offset, 20 mil (0.508 mm). */
const DEFAULT_PIN_NAME_OFFSET_NM: Nm = nm(20 * NM_PER_MIL)
/** Sheetname/Sheetfile field offset from the sheet box, KiCad's 0.7128 mm. */
const SHEET_LABEL_OFFSET_NM: Nm = mmToNm(0.7128)

export interface KicadTextEffects {
  face?: string
  fontSize: { height: Nm; width: Nm }
  thickness?: Nm
  bold: boolean
  italic: boolean
  lineSpacing: number
  horizontalAlign: 'left' | 'center' | 'right'
  verticalAlign: 'top' | 'center' | 'bottom'
  hidden: boolean
  /**
   * `(font (color R G B A))` — KiCad 7+ per-text color, absent when the text
   * inherits the theme's. Every text-bearing node shares the effects model, so
   * this covers symbol text, properties, pin names and labels alike.
   */
  color?: Rgba
}

export interface SchematicProperty {
  key: string
  value: string
  /** `(property private …)`, KiCad 9+: a field private to its symbol, not shown on placements. */
  isPrivate?: boolean
  position: Point & { angle: number }
  hidden: boolean
  /** `(show_name …)` — draw the field's KEY next to its value ("MPN: 1234"). */
  showName: boolean
  /** `(do_not_autoplace …)` — KiCad's field autoplacer leaves this one where it is. */
  doNotAutoplace: boolean
  effects: KicadTextEffects
  _node: SExprList
}

export interface SymbolStroke {
  width: Nm
  /** (stroke (type default|dash|dot|dash_dot|dash_dot_dot|solid)); undefined when unspecified. */
  type?: string
  /** (stroke (color r g b a)); undefined when the stroke inherits the theme color. */
  color?: Rgba
}

// `fill` stays the type token (none/outline/background) that render code compares
// as a string; `fillColor` carries the optional explicit (fill (color …)).
export type SymbolGraphic =
  | { type: 'line'; points: Point[]; stroke: SymbolStroke; fill: string; fillColor?: Rgba }
  | {
      /**
       * `(bezier (pts …))` — a cubic curve given as start, two control points and
       * end. Shaped like `line` because it *is* a point list; the type is what
       * tells the renderer to curve through it instead of connecting the dots.
       */
      type: 'bezier'
      points: Point[]
      stroke: SymbolStroke
      fill: string
      fillColor?: Rgba
    }
  | {
      type: 'rectangle'
      start: Point
      end: Point
      stroke: SymbolStroke
      fill: string
      fillColor?: Rgba
    }
  | {
      type: 'circle'
      center: Point
      radius: Nm
      stroke: SymbolStroke
      fill: string
      fillColor?: Rgba
    }
  | {
      type: 'arc'
      start: Point
      mid: Point
      end: Point
      stroke: SymbolStroke
      fill: string
      fillColor?: Rgba
    }
  | {
      type: 'text'
      text: string
      position: Point & { angle: number }
      effects: KicadTextEffects
    }
  | {
      /**
       * `(text_box "…" (at x y angle) (size w h) (margins l t r b) …)` — a
       * bordered, optionally filled box with text laid out inside it. Layout
       * rules (and how they were verified against KiCad) live in `textBox.ts`.
       *
       * `position` is the box's TOP-LEFT corner, not a center, and `size.height`
       * is negative for the downward boxes KiCad writes. Note the angle is in
       * plain DEGREES here while a sibling `text` stores decidegrees.
       */
      type: 'textBox'
      text: string
      position: Point & { angle: number }
      size: { width: Nm; height: Nm }
      margins: { left: Nm; top: Nm; right: Nm; bottom: Nm }
      stroke: SymbolStroke
      fill: string
      fillColor?: Rgba
      effects: KicadTextEffects
    }

/**
 * `(alternate "NAME" <electricalType> <graphicStyle>)` — a second function a pin
 * can take on. Defined on the pin in the symbol; *chosen* per placed instance in
 * the schematic (KiCad's Pin Functions tab), which is why the symbol editor only
 * has to author the list.
 */
export interface SymbolPinAlternate {
  name: string
  electricalType: string
  graphicStyle: string
}

export interface SymbolPin {
  electricalType: string
  graphicStyle: string
  name: string
  number: string
  alternates: SymbolPinAlternate[]
  nameEffects: KicadTextEffects
  numberEffects: KicadTextEffects
  position: Point & { angle: number }
  length: Nm
  /** Invisible pin ((hide yes) / bare hide). Hidden power-input pins connect globally. */
  hidden: boolean
}

/**
 * A pin name or number as KiCad reads it: `~` is the older files' spelling of
 * empty (KiCad 10 writes `""`). KiCad clears it only in files before 20250318;
 * a library symbol is parsed without its file's version, so this clears it
 * always — a pin literally named `~` is not worth the ambiguity.
 */
export const pinText = (value: string): string => (value === '~' ? '' : value)

export interface SymbolVariant {
  unit: number
  style: number
  graphics: SymbolGraphic[]
  pins: SymbolPin[]
}

export interface KicadLibSymbol {
  name: string
  extends?: string
  /** (power) flag: the symbol is a power port whose Value names a net. */
  isPower: boolean
  /**
   * `(power local)`, KiCad 9+: the port's net is local to its sheet rather than
   * global. False for a bare `(power)` or `(power global)`, and for a non-power
   * symbol.
   */
  isLocalPower: boolean
  graphics: SymbolGraphic[]
  pins: SymbolPin[]
  variants: SymbolVariant[]
  /**
   * Every `(property …)` the definition carries, in document order. Fields are
   * open-ended (`MPN`, `ki_fp_filters`, `Sim.Device`), and the order is
   * meaningful — it is what the fields editor reorders.
   */
  properties: SchematicProperty[]
  pinNameOffset: Nm
  pinNamesHidden: boolean
  pinNumbersHidden: boolean
  /** Symbol-level flags (default when the token is absent, as KiCad omits them). */
  inBom: boolean
  onBoard: boolean
  excludeFromSim: boolean
  /** `(in_pos_files …)`, KiCad 9+: placed in the position (pick-and-place) files. */
  inPosFiles: boolean
  /** `(duplicate_pin_numbers_are_jumpers …)`, KiCad 9+: pins sharing a number are tied. */
  duplicatePinNumbersAreJumpers: boolean
  /**
   * KiCad's "units are not interchangeable", stored as the `ki_locked` property
   * (KiCad's own stand-in until it derives the flag). The panel asks it the
   * other way round: "all units interchangeable" is the absence of this.
   */
  unitsLocked: boolean
  _node: SExprList
}

/**
 * One placement of a symbol in a specific sheet instance. KiCad stores the
 * reference (and unit) per hierarchical path, so a symbol on a sheet reused
 * multiple times carries one entry per instantiation. The path is a chain of
 * sheet-node UUIDs from the root: `/<root-uuid>/<sheet-node-uuid>/...`.
 */
export interface KicadSymbolInstance {
  project: string
  path: string
  reference: string
  unit: number
  _node: SExprList
}

export interface KicadSchematicSymbol {
  libId: string
  /**
   * `(lib_name …)`: the entry in the sheet's `lib_symbols` this placement is
   * drawn from, when it is not the one `lib_id` names — KiCad writes it for
   * a symbol whose embedded copy was renamed or derived. Read the definition
   * through `definitionIdOf`, never `libId` alone.
   */
  libName?: string
  position: Point & { angle: number }
  unit: number
  /**
   * Which body style this placement draws — 1 is standard, 2 the De Morgan
   * alternate, and KiCad 10 allows further named styles. Absence means 1.
   */
  bodyStyle: number
  mirror?: 'x' | 'y'
  uuid?: string
  dnp: boolean
  inBom: boolean
  onBoard: boolean
  excludeFromSim: boolean
  /**
   * `(fields_autoplaced yes)`: the fields are where the autoplacer put them,
   * so a turn or flip places them again. Moving, turning or re-justifying a
   * field by hand clears it, as KiCad does.
   */
  fieldsAutoplaced?: boolean
  properties: SchematicProperty[]
  /** Per-hierarchical-path placements from the (instances ...) block. */
  instances: KicadSymbolInstance[]
  _node: SExprList
}

export interface KicadWire {
  points: Point[]
  width: Nm
  /** (stroke (type …)); undefined when unspecified. */
  strokeType?: string
  /** (stroke (color …)); undefined when the wire inherits the net color. */
  strokeColor?: Rgba
  uuid?: string
  _node: SExprList
}

export interface KicadLabel {
  type: 'label' | 'global_label' | 'hierarchical_label'
  text: string
  position: Point & { angle: number }
  effects: KicadTextEffects
  shape?: 'input' | 'output' | 'bidirectional' | 'tri_state' | 'passive'
  /** KiCad's own id for this label. Persisted, stable across a save, and what
   *  an agent addresses the item by — see `docs/agent-api.md`.
   *  Optional because a hand-written or pre-6 file may carry none. */
  uuid?: string
  _node: SExprList
}

export interface KicadSchematicText {
  text: string
  position: Point & { angle: number }
  effects: KicadTextEffects
  uuid?: string
  _node: SExprList
}

export interface KicadSheetPin {
  name: string
  electricalType: string
  position: Point & { angle: number }
  effects: KicadTextEffects
  _node: SExprList
}

export interface KicadSheet {
  position: Point
  size: { width: Nm; height: Nm }
  strokeWidth: Nm
  properties: SchematicProperty[]
  pins: KicadSheetPin[]
  uuid?: string
  _node: SExprList
}

/** A point-anchored document node (junction, no-connect) with its AST backing. */
export interface KicadSchematicPoint extends Point {
  /** (diameter …) — junctions only; 0 / undefined means the default size. */
  diameter?: Nm
  /** (color …) — junctions only; undefined inherits the theme color. */
  color?: Rgba
  _node: SExprList
}

/** A sheet-level graphic rectangle — a block outline around a group of parts.
 *  KiCad 7+ writes `(rectangle (start …) (end …) (stroke …) (fill …))` at the
 *  document root; it draws and connects nothing. */
export interface KicadSchematicShape {
  type: 'rectangle'
  start: Point
  end: Point
  strokeWidth: Nm
  strokeType?: string
  /** (stroke (color …)); undefined when the outline inherits the theme color. */
  strokeColor?: Rgba
  /** The `(fill (type …))` token — none/outline/background/color/hatch/…. */
  fill: string
  fillColor?: Rgba
  uuid?: string
  _node: SExprList
}

type GraphicOf<T extends SymbolGraphic['type']> = Extract<SymbolGraphic, { type: T }>

/**
 * A free graphic drawn on the sheet — `polyline`, `circle`, `arc`, `bezier`,
 * `text_box` at the document root. The geometry is the symbol-graphic model,
 * read by the same parser, but in SHEET space: nanometers, y-down.
 */
export interface KicadSchematicGraphic<G extends SymbolGraphic = SymbolGraphic> {
  graphic: G
  uuid?: string
  _node: SExprList
}

/** `(bus_entry (at …) (size dx dy))` — a stub from `at` to `at + size`. */
export interface KicadBusEntry {
  position: Point
  size: { width: Nm; height: Nm }
  /** (stroke (width …)); 0 means the net class's wire width. */
  width: Nm
  strokeType?: string
  strokeColor?: Rgba
  uuid?: string
  _node: SExprList
}

/** `(image (at …) (scale …) (data "…"…))` — a bitmap centered on `at`. */
export interface KicadSchematicImage {
  position: Point
  /** `(scale …)`, 1 when absent. */
  scale: number
  /** The base64 PNG, its `(data …)` string atoms joined. */
  data: string
  uuid?: string
  _node: SExprList
}

/** One `(table_cell …)`: a text box without a border of its own. */
export interface KicadTableCell {
  text: string
  position: Point & { angle: number }
  size: { width: Nm; height: Nm }
  margins: { left: Nm; top: Nm; right: Nm; bottom: Nm }
  /** `(span cols rows)`; 0 marks a cell covered by a neighbor's span. */
  span: { cols: number; rows: number }
  fill: string
  fillColor?: Rgba
  effects: KicadTextEffects
  _node: SExprList
}

/** `(table …)` — cells in row-major order, `columnCount` to a row. */
export interface KicadSchematicTable {
  columnCount: number
  border: { external: boolean; header: boolean; stroke: SymbolStroke }
  separators: { rows: boolean; cols: boolean; stroke: SymbolStroke }
  cells: KicadTableCell[]
  uuid?: string
  _node: SExprList
}

export type DirectiveLabelShape = 'round' | 'dot' | 'diamond' | 'rectangle'

/**
 * `(netclass_flag …)` — KiCad's directive label: a pin line ending in a small
 * glyph, carrying fields (Net Class, Component Class, …) rather than a name.
 */
export interface KicadDirectiveLabel {
  text: string
  position: Point & { angle: number }
  effects: KicadTextEffects
  shape: DirectiveLabelShape
  /** `(length …)` — the pin line, 100 mil when absent. */
  length: Nm
  properties: SchematicProperty[]
  uuid?: string
  _node: SExprList
}

/** `(rule_area … (polyline …))` — the area's outline, a closed polygon. */
export interface KicadRuleArea {
  graphic: GraphicOf<'line'>
  uuid?: string
  _node: SExprList
}

/**
 * The page a sheet is drawn on: KiCad's `(paper ...)` node.
 *
 * Mostly a KiCad-compatibility concern — a GoatCAD-native design is read at
 * whatever size its content is, and `render.schematic` frames the drawing rather
 * than the page. It is parsed and reported so an agent that cannot see the
 * sheet can tell content from page (`docs/agent-api.md`),
 * and so the KiCad file round-trips with the size the user chose.
 */
export interface KicadPaper {
  /** KiCad's page name: "A4", "USLetter", or "User" for a custom size. */
  size: string
  portrait: boolean
  /** The page rectangle, from the sheet origin. */
  width: Nm
  height: Nm
}

/**
 * KiCad's standard pages, **landscape** (`eeschema`'s `PAGE_INFO` table, whose
 * entries are all wider than tall; `(paper "A4" portrait)` swaps them).
 *
 * Nominal millimetres, not KiCad's mils converted: it holds A3 as
 * 16535 × 11693 mil and plots a 419.989 × 297.0022 mm page, and reporting
 * "420 × 297" is both what the size means and what a reader comparing a
 * drawing against it wants. Nothing here is written to a file — a named page
 * is written by name — so the 11 µm never reaches KiCad.
 */
const PAGE_SIZES_MM: Record<string, { width: number; height: number }> = {
  A0: { width: 1189, height: 841 },
  A1: { width: 841, height: 594 },
  A2: { width: 594, height: 420 },
  A3: { width: 420, height: 297 },
  A4: { width: 297, height: 210 },
  A5: { width: 210, height: 148 },
  A: { width: 279.4, height: 215.9 },
  B: { width: 431.8, height: 279.4 },
  C: { width: 558.8, height: 431.8 },
  D: { width: 863.6, height: 558.8 },
  E: { width: 1117.6, height: 863.6 },
  USLetter: { width: 279.4, height: 215.9 },
  USLegal: { width: 355.6, height: 215.9 },
  USLedger: { width: 431.8, height: 279.4 }
}

/** The page names KiCad accepts, for a verb that takes one. */
export const KICAD_PAGE_NAMES = Object.keys(PAGE_SIZES_MM)

/**
 * `(paper "A3")`, `(paper "A4" portrait)` or `(paper "User" 200 150)`.
 *
 * A name the table does not hold is not guessed at: the file may be newer than
 * this parser, and a page invented here would be worse than none.
 */
const parsePaper = (node: SExprList | null): KicadPaper | undefined => {
  if (!node) return undefined
  const atoms = getAtomValues(node)
  const size = atoms[0]
  if (!size) return undefined
  if (size === 'User') {
    const width = Number(atoms[1])
    const height = Number(atoms[2])
    if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined
    return { size, portrait: height > width, width: mmToNm(width), height: mmToNm(height) }
  }
  const page = PAGE_SIZES_MM[size]
  if (!page) return undefined
  const portrait = atoms.includes('portrait')
  return {
    size,
    portrait,
    width: mmToNm(portrait ? page.height : page.width),
    height: mmToNm(portrait ? page.width : page.height)
  }
}

export interface KicadSchematic {
  version?: number
  generator?: string
  uuid?: string
  /** Title-block title, the human name of the sheet (root shows this). */
  title?: string
  /** The page the sheet is drawn on, when the file names one. */
  paper?: KicadPaper
  libSymbols: Map<string, KicadLibSymbol>
  symbols: KicadSchematicSymbol[]
  wires: KicadWire[]
  junctions: KicadSchematicPoint[]
  noConnects: KicadSchematicPoint[]
  labels: KicadLabel[]
  texts: KicadSchematicText[]
  shapes: KicadSchematicShape[]
  sheets: KicadSheet[]
  buses: KicadWire[]
  busEntries: KicadBusEntry[]
  polylines: KicadSchematicGraphic<GraphicOf<'line'>>[]
  circles: KicadSchematicGraphic<GraphicOf<'circle'>>[]
  arcs: KicadSchematicGraphic<GraphicOf<'arc'>>[]
  beziers: KicadSchematicGraphic<GraphicOf<'bezier'>>[]
  textBoxes: KicadSchematicGraphic<GraphicOf<'textBox'>>[]
  images: KicadSchematicImage[]
  tables: KicadSchematicTable[]
  directiveLabels: KicadDirectiveLabel[]
  ruleAreas: KicadRuleArea[]
  _root: SExprList
  _unknownNodes: SExprNode[]
}

/**
 * Read a plain numeric atom — an angle, a ratio, a count, a version. This is
 * deliberately NOT how distances are read: those go through `atomNm`, and the
 * split is what keeps a decidegree or a unit number from ever being scaled
 * into nanometers (or a millimeter from sneaking into an `Nm` field).
 */
const atomNumber = (node: SExprList | null, index: number, fallback = 0): number => {
  if (!node) return fallback
  const value = Number(getAtomValues(node)[index])
  return Number.isFinite(value) ? value : fallback
}

/** Read a millimeter distance atom into integer nanometers. */
const atomNm = (node: SExprList | null, index: number, fallback: Nm = ZERO): Nm => {
  if (!node) return fallback
  const value = Number(getAtomValues(node)[index])
  return Number.isFinite(value) ? mmToNm(value) : fallback
}

const pointFrom = (node: SExprList, token: string): Point => {
  const point = getXY(node, token)
  return point ? { x: mmToNm(point.x), y: mmToNm(point.y) } : { x: ZERO, y: ZERO }
}

const positionFrom = (node: SExprList): Point & { angle: number } => {
  const point = getXY(node, 'at')
  return {
    x: point ? mmToNm(point.x) : ZERO,
    y: point ? mmToNm(point.y) : ZERO,
    angle: point?.angle ?? 0
  }
}

const tokenEnabled = (node: SExprList | null, token: string): boolean => {
  if (!node) return false
  const child = findChild(node, token)
  if (child) {
    const value = getFirstAtomValue(child)
    return value === undefined || value === 'yes' || value === 'true'
  }
  return getAtomValues(node).includes(token)
}

export const parseTextEffects = (node: SExprList): KicadTextEffects => {
  const effects = findChild(node, 'effects')
  const font = effects ? findChild(effects, 'font') : null
  const size = font ? findChild(font, 'size') : null
  const sizeAtoms = size ? getAtomValues(size) : []
  const height = Number(sizeAtoms[0])
  const width = Number(sizeAtoms[1])
  const justify = effects ? findChild(effects, 'justify') : null
  const justification = justify ? getAtomValues(justify) : []
  const faceNode = font ? findChild(font, 'face') : null
  const thicknessNode = font ? findChild(font, 'thickness') : null
  return {
    face: faceNode ? getFirstAtomValue(faceNode) : undefined,
    fontSize: {
      height: Number.isFinite(height) ? mmToNm(height) : DEFAULT_FONT_SIZE_NM,
      width: Number.isFinite(width)
        ? mmToNm(width)
        : Number.isFinite(height)
          ? mmToNm(height)
          : DEFAULT_FONT_SIZE_NM
    },
    thickness: thicknessNode ? atomNm(thicknessNode, 0) : undefined,
    bold: tokenEnabled(font, 'bold'),
    italic: tokenEnabled(font, 'italic'),
    lineSpacing: atomNumber(font ? findChild(font, 'line_spacing') : null, 0, 1),
    horizontalAlign: justification.includes('left')
      ? 'left'
      : justification.includes('right')
        ? 'right'
        : 'center',
    verticalAlign: justification.includes('top')
      ? 'top'
      : justification.includes('bottom')
        ? 'bottom'
        : 'center',
    hidden: tokenEnabled(effects, 'hide') || tokenEnabled(node, 'hide'),
    // On the FONT, not on the effects — that is where KiCad puts it, alongside
    // size and thickness, unlike a graphic's stroke/fill colors.
    color: font ? parseColorChild(font) : undefined
  }
}

const parseStroke = (node: SExprList): SymbolStroke => {
  const stroke = findChild(node, 'stroke') ?? node
  const typeNode = findChild(stroke, 'type')
  return {
    width: atomNm(findChild(stroke, 'width'), 0, DEFAULT_STROKE_WIDTH_NM),
    type: typeNode ? getFirstAtomValue(typeNode) : undefined,
    color: parseColorChild(stroke)
  }
}

const parseFill = (node: SExprList): string => {
  const fill = findChild(node, 'fill')
  if (!fill) return 'none'
  const type = findChild(fill, 'type')
  return (type ? getFirstAtomValue(type) : getFirstAtomValue(fill)) ?? 'none'
}

/** The explicit (fill (color …)), or undefined when the fill has no color. */
const parseFillColor = (node: SExprList): Rgba | undefined => {
  const fill = findChild(node, 'fill')
  return fill ? parseColorChild(fill) : undefined
}

const parsePoints = (node: SExprList): Point[] => {
  const pts = findChild(node, 'pts')
  if (!pts) return []
  return findChildren(pts, 'xy').map((xy) => ({
    x: atomNm(xy, 0),
    y: atomNm(xy, 1)
  }))
}

const parseGraphic = (node: SExprList): SymbolGraphic | null => {
  switch (getToken(node)) {
    case 'polyline':
      return {
        type: 'line',
        points: parsePoints(node),
        stroke: parseStroke(node),
        fill: parseFill(node),
        fillColor: parseFillColor(node)
      }
    case 'bezier':
      return {
        type: 'bezier',
        points: parsePoints(node),
        stroke: parseStroke(node),
        fill: parseFill(node),
        fillColor: parseFillColor(node)
      }
    case 'rectangle':
      return {
        type: 'rectangle',
        start: pointFrom(node, 'start'),
        end: pointFrom(node, 'end'),
        stroke: parseStroke(node),
        fill: parseFill(node),
        fillColor: parseFillColor(node)
      }
    case 'circle':
      return {
        type: 'circle',
        center: pointFrom(node, 'center'),
        radius: atomNm(findChild(node, 'radius'), 0),
        stroke: parseStroke(node),
        fill: parseFill(node),
        fillColor: parseFillColor(node)
      }
    case 'arc':
      return {
        type: 'arc',
        start: pointFrom(node, 'start'),
        mid: pointFrom(node, 'mid'),
        end: pointFrom(node, 'end'),
        stroke: parseStroke(node),
        fill: parseFill(node),
        fillColor: parseFillColor(node)
      }
    case 'text': {
      const position = positionFrom(node)
      position.angle /= 10
      return {
        type: 'text',
        text: getFirstAtomValue(node) ?? '',
        position,
        effects: parseTextEffects(node)
      }
    }
    case 'text_box': {
      const size = findChild(node, 'size')
      const margins = findChild(node, 'margins')
      // NO /10 here, unlike `text` directly above. Verified against KiCad 10:
      // `(at 0 0 90)` on a text_box renders turned a quarter turn, where the
      // same value on a `text` would mean 9°. Two same-shaped nodes, two units.
      return {
        type: 'textBox',
        text: getFirstAtomValue(node) ?? '',
        position: positionFrom(node),
        // Indices are 0-based AFTER the token — `getAtomValues` slices it off.
        size: {
          width: atomNm(size, 0),
          height: atomNm(size, 1)
        },
        margins: {
          left: atomNm(margins, 0, DEFAULT_TEXT_BOX_MARGIN_NM),
          top: atomNm(margins, 1, DEFAULT_TEXT_BOX_MARGIN_NM),
          right: atomNm(margins, 2, DEFAULT_TEXT_BOX_MARGIN_NM),
          bottom: atomNm(margins, 3, DEFAULT_TEXT_BOX_MARGIN_NM)
        },
        stroke: parseStroke(node),
        fill: parseFill(node),
        fillColor: parseFillColor(node),
        effects: parseTextEffects(node)
      }
    }
    default:
      return null
  }
}

const parsePin = (node: SExprList): SymbolPin => {
  const nameNode = findChild(node, 'name')
  const numberNode = findChild(node, 'number')
  const atoms = getAtomValues(node)
  return {
    electricalType: atoms[0] ?? 'unspecified',
    graphicStyle: atoms[1] ?? 'line',
    name: nameNode ? (getFirstAtomValue(nameNode) ?? '') : '',
    number: numberNode ? (getFirstAtomValue(numberNode) ?? '') : '',
    // `(alternate "NAME" type style)` — three positional atoms, like the pin's
    // own `(pin type style …)` head, in the same order.
    alternates: findChildren(node, 'alternate').map((alt) => {
      const atoms = getAtomValues(alt)
      return {
        name: atoms[0] ?? '',
        electricalType: atoms[1] ?? 'unspecified',
        graphicStyle: atoms[2] ?? 'line'
      }
    }),
    nameEffects: nameNode ? parseTextEffects(nameNode) : parseTextEffects(node),
    numberEffects: numberNode ? parseTextEffects(numberNode) : parseTextEffects(node),
    position: positionFrom(node),
    length: atomNm(findChild(node, 'length'), 0, DEFAULT_PIN_LENGTH_NM),
    hidden: tokenEnabled(node, 'hide')
  }
}

/**
 * `<symbol>_<unit>_<style>` — the sub-symbol naming KiCad writes.
 *
 * Exported because the renderer and `symbolEdit` must derive the SAME
 * `(unit, style)` from a sub-symbol independently; two copies of this pattern
 * is exactly the "two orderings that have to agree" failure the naming model
 * exists to remove (ARCHITECTURE.md §3.7).
 *
 * Callers differ in what they do with a name this cannot read: `parseLibSymbol`
 * falls back to `{0, 0}` so a malformed library still draws, while
 * `symbolPartAddresses` skips it, because a part it cannot name is a part it
 * cannot address. KiCad never writes such a name.
 */
export const parseVariantSuffix = (name: string): { unit: number; style: number } | null => {
  const match = name.match(/_(\d+)_(\d+)$/)
  return match ? { unit: Number(match[1]), style: Number(match[2]) } : null
}

/**
 * Tokens `parseGraphic` below turns into a `SymbolGraphic`. Exported so
 * `symbolEdit` selects the same nodes from the AST that the typed views are
 * built from — if the two sets drifted, graphic indices would skew between the
 * node path and the typed path, silently retargeting an edit.
 *
 * Keep in step with `parseGraphic`'s switch.
 */
export const SYMBOL_GRAPHIC_TOKENS: ReadonlySet<string> = new Set([
  'polyline',
  'rectangle',
  'circle',
  'arc',
  'text',
  'text_box',
  'bezier'
])

/**
 * A cubic Bézier's control points flattened into a polyline, for drawing and for
 * hit-testing — one definition, so what you click is what you see.
 *
 * KiCad writes exactly four points (start, two controls, end). Any other count is
 * not a cubic, so those come back unchanged: a straight run through the points the
 * file gave is honest and visible, where returning nothing would hide the item.
 *
 * The control points **bound** the curve (a Bézier stays inside its control
 * hull), which is why callers can keep using them for extents.
 */
export function bezierCurvePoints(
  points: Array<{ x: number; y: number }>,
  segments = 24
): Array<{ x: number; y: number }> {
  if (points.length !== 4) return points
  const [p0, p1, p2, p3] = points
  // Interpolation produces fractional nanometers; this is display/hit-test
  // geometry, never written back, so the result stays deliberately unbranded.
  const out: Array<{ x: number; y: number }> = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const u = 1 - t
    const a = u * u * u
    const b = 3 * u * u * t
    const c = 3 * u * t * t
    const d = t * t * t
    out.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    })
  }
  return out
}

const parseGraphicsAndPins = (
  node: SExprList
): { graphics: SymbolGraphic[]; pins: SymbolPin[] } => {
  const graphics: SymbolGraphic[] = []
  const pins: SymbolPin[] = []
  for (const child of node.children) {
    if (child.type !== 'list') continue
    if (getToken(child) === 'pin') pins.push(parsePin(child))
    const graphic = parseGraphic(child)
    if (graphic) graphics.push(graphic)
  }
  return { graphics, pins }
}

export const parseLibSymbol = (node: SExprList): KicadLibSymbol => {
  const own = parseGraphicsAndPins(node)
  const extendsNode = findChild(node, 'extends')
  const pinNames = findChild(node, 'pin_names')
  const pinNumbers = findChild(node, 'pin_numbers')
  const variants = findChildren(node, 'symbol').map((variantNode) => {
    const variantName = getFirstAtomValue(variantNode) ?? ''
    const suffix = parseVariantSuffix(variantName) ?? { unit: 0, style: 0 }
    return { ...suffix, ...parseGraphicsAndPins(variantNode) }
  })
  // Absent flag token means the KiCad default, not false.
  const flag = (token: string, absentDefault: boolean): boolean =>
    findChild(node, token) ? tokenEnabled(node, token) : absentDefault
  const power = findChild(node, 'power')
  const properties = findChildren(node, 'property').map(parseProperty)
  return {
    name: getFirstAtomValue(node) ?? '',
    extends: extendsNode ? getFirstAtomValue(extendsNode) : undefined,
    isPower: Boolean(power),
    isLocalPower: power ? getFirstAtomValue(power) === 'local' : false,
    graphics: own.graphics,
    pins: own.pins,
    variants,
    properties,
    pinNameOffset: atomNm(
      pinNames ? findChild(pinNames, 'offset') : null,
      0,
      DEFAULT_PIN_NAME_OFFSET_NM
    ),
    pinNamesHidden: tokenEnabled(pinNames, 'hide'),
    pinNumbersHidden: tokenEnabled(pinNumbers, 'hide'),
    inBom: flag('in_bom', true),
    onBoard: flag('on_board', true),
    excludeFromSim: flag('exclude_from_sim', false),
    inPosFiles: flag('in_pos_files', true),
    duplicatePinNumbersAreJumpers: flag('duplicate_pin_numbers_are_jumpers', false),
    unitsLocked: properties.some((property) => property.key === 'ki_locked'),
    _node: node
  }
}

/**
 * Where a `(property …)`'s name sits: after the bare `private` keyword KiCad 9
 * writes for a field private to its symbol (`(property private "Name" "Value" …)`,
 * `sch_io_kicad_sexpr_parser.cpp`), else first. Its value follows it.
 */
export const propertyNameIndex = (node: SExprList): number => {
  const first = node.children[1]
  return first?.type === 'atom' && !first.quoted && first.value === 'private' ? 2 : 1
}

const atomAt = (node: SExprList, index: number): string => {
  const child = node.children[index]
  return child?.type === 'atom' ? child.value : ''
}

/** A `(property …)` node's field name, past a `private` keyword. */
export const propertyKeyOf = (node: SExprList): string => atomAt(node, propertyNameIndex(node))

/** Whether a `(property …)` node is a private field (KiCad 9+), which stays with its library symbol. */
export const isPrivateProperty = (node: SExprList): boolean => propertyNameIndex(node) === 2

const parseProperty = (node: SExprList): SchematicProperty => {
  const name = propertyNameIndex(node)
  const effects = parseTextEffects(node)
  return {
    key: atomAt(node, name),
    value: atomAt(node, name + 1),
    ...(name === 2 ? { isPrivate: true } : {}),
    position: positionFrom(node),
    hidden: effects.hidden,
    // On the PROPERTY, beside `at` and `hide` — not inside `effects`.
    showName: tokenEnabled(node, 'show_name'),
    doNotAutoplace: tokenEnabled(node, 'do_not_autoplace'),
    effects,
    _node: node
  }
}

const parseSymbolInstances = (node: SExprList): KicadSymbolInstance[] => {
  const instancesNode = findChild(node, 'instances')
  if (!instancesNode) return []
  const result: KicadSymbolInstance[] = []
  for (const projectNode of findChildren(instancesNode, 'project')) {
    const project = getFirstAtomValue(projectNode) ?? ''
    for (const pathNode of findChildren(projectNode, 'path')) {
      const referenceNode = findChild(pathNode, 'reference')
      result.push({
        project,
        path: getFirstAtomValue(pathNode) ?? '',
        reference: referenceNode ? (getFirstAtomValue(referenceNode) ?? '') : '',
        unit: atomNumber(findChild(pathNode, 'unit'), 0, 1),
        _node: pathNode
      })
    }
  }
  return result
}

const parsePlacedSymbol = (node: SExprList): KicadSchematicSymbol => {
  const mirrorNode = findChild(node, 'mirror')
  const uuidNode = findChild(node, 'uuid')
  const libIdNode = findChild(node, 'lib_id')
  const libNameNode = findChild(node, 'lib_name')
  const libName = libNameNode ? getFirstAtomValue(libNameNode) : undefined
  const mirror = mirrorNode ? getFirstAtomValue(mirrorNode) : undefined
  // KiCad omits these flag tokens in older files; absence means the default,
  // while tokenEnabled alone would read absence as false.
  const flag = (token: string, absentDefault: boolean): boolean =>
    findChild(node, token) ? tokenEnabled(node, token) : absentDefault
  return {
    libId: libIdNode ? (getFirstAtomValue(libIdNode) ?? '') : '',
    ...(libName ? { libName } : {}),
    position: positionFrom(node),
    unit: atomNumber(findChild(node, 'unit'), 0, 1),
    // KiCad 10 renamed `(convert N)` to `(body_style N)`; files older than that
    // still carry the original, so both are read and the newer one wins.
    bodyStyle: atomNumber(findChild(node, 'body_style') ?? findChild(node, 'convert'), 0, 1),
    mirror: mirror === 'x' || mirror === 'y' ? mirror : undefined,
    uuid: uuidNode ? getFirstAtomValue(uuidNode) : undefined,
    dnp: flag('dnp', false),
    inBom: flag('in_bom', true),
    onBoard: flag('on_board', true),
    excludeFromSim: flag('exclude_from_sim', false),
    fieldsAutoplaced: flag('fields_autoplaced', false),
    properties: findChildren(node, 'property').map(parseProperty),
    instances: parseSymbolInstances(node),
    _node: node
  }
}

const parseWire = (node: SExprList): KicadWire => {
  const uuidNode = findChild(node, 'uuid')
  const stroke = findChild(node, 'stroke')
  const typeNode = stroke ? findChild(stroke, 'type') : null
  return {
    points: parsePoints(node),
    width: atomNm(findChild(stroke ?? node, 'width'), 0),
    strokeType: typeNode ? getFirstAtomValue(typeNode) : undefined,
    strokeColor: stroke ? parseColorChild(stroke) : undefined,
    uuid: uuidNode ? getFirstAtomValue(uuidNode) : undefined,
    _node: node
  }
}

const parseLabel = (node: SExprList): KicadLabel => {
  const shapeNode = findChild(node, 'shape')
  const shape = shapeNode ? getFirstAtomValue(shapeNode) : undefined
  const uuidNode = findChild(node, 'uuid')
  return {
    type: getToken(node) as KicadLabel['type'],
    text: getFirstAtomValue(node) ?? '',
    position: positionFrom(node),
    effects: parseTextEffects(node),
    ...(uuidNode ? { uuid: getFirstAtomValue(uuidNode) } : {}),
    shape:
      shape === 'input' ||
      shape === 'output' ||
      shape === 'bidirectional' ||
      shape === 'tri_state' ||
      shape === 'passive'
        ? shape
        : undefined,
    _node: node
  }
}

const parseSchematicText = (node: SExprList): KicadSchematicText => {
  const uuid = findChild(node, 'uuid')
  return {
    text: getFirstAtomValue(node) ?? '',
    position: positionFrom(node),
    effects: parseTextEffects(node),
    uuid: uuid ? getFirstAtomValue(uuid) : undefined,
    _node: node
  }
}

const uuidOf = (node: SExprList): string | undefined => {
  const uuid = findChild(node, 'uuid')
  return uuid ? getFirstAtomValue(uuid) : undefined
}

const parseSchematicRectangle = (node: SExprList): KicadSchematicShape => {
  const stroke = findChild(node, 'stroke')
  const width = stroke ? findChild(stroke, 'width') : null
  const strokeType = stroke ? findChild(stroke, 'type') : null
  return {
    type: 'rectangle',
    start: pointFrom(node, 'start'),
    end: pointFrom(node, 'end'),
    strokeWidth: width ? atomNm(width, 0) : ZERO,
    strokeType: strokeType ? getFirstAtomValue(strokeType) : undefined,
    strokeColor: stroke ? parseColorChild(stroke) : undefined,
    fill: parseFill(node),
    fillColor: parseFillColor(node),
    uuid: uuidOf(node),
    _node: node
  }
}

/** A sheet graphic of one kind, through the symbol-graphic parser. */
const parseSheetGraphic = <T extends SymbolGraphic['type']>(
  node: SExprList,
  type: T
): KicadSchematicGraphic<GraphicOf<T>> | null => {
  const graphic = parseGraphic(node)
  if (!graphic || graphic.type !== type) return null
  return { graphic: graphic as GraphicOf<T>, uuid: uuidOf(node), _node: node }
}

const sheetGraphics = <T extends SymbolGraphic['type']>(
  root: SExprList,
  token: string,
  type: T
): KicadSchematicGraphic<GraphicOf<T>>[] =>
  findChildren(root, token).flatMap((node) => parseSheetGraphic(node, type) ?? [])

const parseBusEntry = (node: SExprList): KicadBusEntry => {
  const size = findChild(node, 'size')
  const stroke = findChild(node, 'stroke')
  const typeNode = stroke ? findChild(stroke, 'type') : null
  return {
    position: pointFrom(node, 'at'),
    size: { width: atomNm(size, 0), height: atomNm(size, 1) },
    width: atomNm(stroke ? findChild(stroke, 'width') : null, 0),
    strokeType: typeNode ? getFirstAtomValue(typeNode) : undefined,
    strokeColor: stroke ? parseColorChild(stroke) : undefined,
    uuid: uuidOf(node),
    _node: node
  }
}

const parseSchematicImage = (node: SExprList): KicadSchematicImage => {
  const data = findChild(node, 'data')
  return {
    position: pointFrom(node, 'at'),
    scale: atomNumber(findChild(node, 'scale'), 0, 1) || 1,
    data: data ? getAtomValues(data).join('') : '',
    uuid: uuidOf(node),
    _node: node
  }
}

const parseTableCell = (node: SExprList): KicadTableCell => {
  const size = findChild(node, 'size')
  const margins = findChild(node, 'margins')
  const span = findChild(node, 'span')
  return {
    text: getFirstAtomValue(node) ?? '',
    position: positionFrom(node),
    size: { width: atomNm(size, 0), height: atomNm(size, 1) },
    margins: {
      left: atomNm(margins, 0, DEFAULT_TEXT_BOX_MARGIN_NM),
      top: atomNm(margins, 1, DEFAULT_TEXT_BOX_MARGIN_NM),
      right: atomNm(margins, 2, DEFAULT_TEXT_BOX_MARGIN_NM),
      bottom: atomNm(margins, 3, DEFAULT_TEXT_BOX_MARGIN_NM)
    },
    span: { cols: atomNumber(span, 0, 1), rows: atomNumber(span, 1, 1) },
    fill: parseFill(node),
    fillColor: parseFillColor(node),
    effects: parseTextEffects(node),
    _node: node
  }
}

const parseSchematicTable = (node: SExprList): KicadSchematicTable => {
  const border = findChild(node, 'border')
  const separators = findChild(node, 'separators')
  const cells = findChild(node, 'cells')
  // KiCad's defaults when a flag is absent: every line is stroked.
  const flag = (parent: SExprList | null, token: string): boolean =>
    parent && findChild(parent, token) ? tokenEnabled(parent, token) : true
  const strokeOf = (parent: SExprList | null): SymbolStroke =>
    parent && findChild(parent, 'stroke') ? parseStroke(parent) : { width: ZERO }
  return {
    columnCount: Math.max(1, atomNumber(findChild(node, 'column_count'), 0, 1)),
    border: {
      external: flag(border, 'external'),
      header: flag(border, 'header'),
      stroke: strokeOf(border)
    },
    separators: {
      rows: flag(separators, 'rows'),
      cols: flag(separators, 'cols'),
      stroke: strokeOf(separators)
    },
    cells: cells ? findChildren(cells, 'table_cell').map(parseTableCell) : [],
    uuid: uuidOf(node),
    _node: node
  }
}

/** KiCad's default directive-label pin, `m_pinLength = MilsToIU( 100 )`. */
const DEFAULT_DIRECTIVE_LENGTH_NM: Nm = nm(100 * NM_PER_MIL)

const parseDirectiveLabel = (node: SExprList): KicadDirectiveLabel => {
  const shapeNode = findChild(node, 'shape')
  const shape = shapeNode ? getFirstAtomValue(shapeNode) : undefined
  return {
    text: getFirstAtomValue(node) ?? '',
    position: positionFrom(node),
    effects: parseTextEffects(node),
    shape: shape === 'dot' || shape === 'diamond' || shape === 'rectangle' ? shape : 'round',
    length: atomNm(findChild(node, 'length'), 0, DEFAULT_DIRECTIVE_LENGTH_NM),
    properties: findChildren(node, 'property').map(parseProperty),
    uuid: uuidOf(node),
    _node: node
  }
}

const parseRuleArea = (node: SExprList): KicadRuleArea | null => {
  const polyline = findChild(node, 'polyline')
  const outline = polyline ? parseSheetGraphic(polyline, 'line') : null
  return outline ? { graphic: outline.graphic, uuid: outline.uuid, _node: node } : null
}

/** The sheet items a writer inserts and may read straight back, by their node's token. */
export interface SheetItemNodes {
  rectangle: KicadSchematicShape
  polyline: KicadSchematicGraphic<GraphicOf<'line'>>
  circle: KicadSchematicGraphic<GraphicOf<'circle'>>
  arc: KicadSchematicGraphic<GraphicOf<'arc'>>
  bezier: KicadSchematicGraphic<GraphicOf<'bezier'>>
  text_box: KicadSchematicGraphic<GraphicOf<'textBox'>>
  image: KicadSchematicImage
  table: KicadSchematicTable
  bus: KicadWire
  bus_entry: KicadBusEntry
  netclass_flag: KicadDirectiveLabel
  rule_area: KicadRuleArea
}

/**
 * One top-level node read as `parseKicadSchematic` reads it, so a command that
 * has just inserted a node can write the rest of it through the same setters
 * an edit uses. Null when the node is not that item.
 */
export function parseSheetItemNode<K extends keyof SheetItemNodes>(
  token: K,
  node: SExprList
): SheetItemNodes[K] | null {
  if (getToken(node) !== token) return null
  const parsers: { [T in keyof SheetItemNodes]: (node: SExprList) => SheetItemNodes[T] | null } = {
    rectangle: parseSchematicRectangle,
    polyline: (n) => parseSheetGraphic(n, 'line'),
    circle: (n) => parseSheetGraphic(n, 'circle'),
    arc: (n) => parseSheetGraphic(n, 'arc'),
    bezier: (n) => parseSheetGraphic(n, 'bezier'),
    text_box: (n) => parseSheetGraphic(n, 'textBox'),
    image: parseSchematicImage,
    table: parseSchematicTable,
    bus: parseWire,
    bus_entry: parseBusEntry,
    netclass_flag: parseDirectiveLabel,
    rule_area: parseRuleArea
  }
  return parsers[token](node)
}

const parseSheetPin = (node: SExprList): KicadSheetPin => {
  const atoms = getAtomValues(node)
  return {
    name: atoms[0] ?? '',
    electricalType: atoms[1] ?? 'passive',
    position: positionFrom(node),
    effects: parseTextEffects(node),
    _node: node
  }
}

const parseSheet = (node: SExprList): KicadSheet => {
  const size = findChild(node, 'size')
  const uuid = findChild(node, 'uuid')
  return {
    position: pointFrom(node, 'at'),
    size: {
      width: atomNm(size, 0),
      height: atomNm(size, 1)
    },
    strokeWidth: parseStroke(node).width,
    properties: findChildren(node, 'property').map(parseProperty),
    pins: findChildren(node, 'pin').map(parseSheetPin),
    uuid: uuid ? getFirstAtomValue(uuid) : undefined,
    _node: node
  }
}

export function parseKicadSchematic(source: string): KicadSchematic {
  const parsed = parseSExpr(source)
  if (parsed.type !== 'list' || getToken(parsed) !== 'kicad_sch') {
    throw new Error('Expected a KiCad (kicad_sch ...) document')
  }
  const root = parsed
  const libSymbols = new Map<string, KicadLibSymbol>()
  const libNode = findChild(root, 'lib_symbols')
  if (libNode) {
    for (const symbolNode of findChildren(libNode, 'symbol')) {
      const symbol = parseLibSymbol(symbolNode)
      libSymbols.set(symbol.name, symbol)
    }
  }

  const known = new Set([
    'version',
    'generator',
    'generator_version',
    'uuid',
    'paper',
    'lib_symbols',
    'symbol',
    'wire',
    'bus',
    'bus_entry',
    'junction',
    'no_connect',
    'label',
    'global_label',
    'hierarchical_label',
    'text',
    'text_box',
    'sheet',
    'sheet_instances',
    'embedded_fonts',
    'rectangle',
    'polyline',
    'circle',
    'arc',
    'bezier',
    'image',
    'table',
    'netclass_flag',
    'rule_area'
  ])

  const pointNodes = (token: string): KicadSchematicPoint[] =>
    findChildren(root, token).map((node) => {
      const diameterNode = findChild(node, 'diameter')
      return {
        ...pointFrom(node, 'at'),
        diameter: diameterNode ? atomNm(diameterNode, 0) : undefined,
        color: parseColorChild(node),
        _node: node
      }
    })

  const generatorNode = findChild(root, 'generator')
  const uuidNode = findChild(root, 'uuid')
  const titleBlock = findChild(root, 'title_block')
  const titleNode = titleBlock ? findChild(titleBlock, 'title') : null
  const title = titleNode ? getFirstAtomValue(titleNode) : undefined
  return {
    version: atomNumber(findChild(root, 'version'), 0) || undefined,
    generator: generatorNode ? getFirstAtomValue(generatorNode) : undefined,
    uuid: uuidNode ? getFirstAtomValue(uuidNode) : undefined,
    title: title || undefined,
    paper: parsePaper(findChild(root, 'paper')),
    libSymbols,
    symbols: findChildren(root, 'symbol').map(parsePlacedSymbol),
    wires: findChildren(root, 'wire').map(parseWire),
    junctions: pointNodes('junction'),
    noConnects: pointNodes('no_connect'),
    labels: (['label', 'global_label', 'hierarchical_label'] as const).flatMap((token) =>
      findChildren(root, token).map(parseLabel)
    ),
    texts: findChildren(root, 'text').map(parseSchematicText),
    shapes: findChildren(root, 'rectangle').map(parseSchematicRectangle),
    sheets: findChildren(root, 'sheet').map(parseSheet),
    buses: findChildren(root, 'bus').map(parseWire),
    busEntries: findChildren(root, 'bus_entry').map(parseBusEntry),
    polylines: sheetGraphics(root, 'polyline', 'line'),
    circles: sheetGraphics(root, 'circle', 'circle'),
    arcs: sheetGraphics(root, 'arc', 'arc'),
    beziers: sheetGraphics(root, 'bezier', 'bezier'),
    textBoxes: sheetGraphics(root, 'text_box', 'textBox'),
    images: findChildren(root, 'image').map(parseSchematicImage),
    tables: findChildren(root, 'table').map(parseSchematicTable),
    directiveLabels: findChildren(root, 'netclass_flag').map(parseDirectiveLabel),
    ruleAreas: findChildren(root, 'rule_area').flatMap((node) => parseRuleArea(node) ?? []),
    _root: root,
    _unknownNodes: root.children.filter(
      (child) => child.type === 'list' && !known.has(getToken(child) ?? '')
    )
  }
}

export function serializeKicadSchematic(schematic: KicadSchematic): string {
  return `${serializeSExpr(schematic._root)}\n`
}

const updateAt = (node: SExprList, x: Nm, y: Nm, angle?: number): void => {
  const at = findChild(node, 'at')
  if (!at) return
  const oldAtoms = at.children.filter((child): child is SExprAtom => child.type === 'atom')
  // Keep angle-less (at x y) nodes (junctions, no-connects) angle-less.
  const hadAngle = oldAtoms.length > 3
  const finalAngle = angle ?? Number(oldAtoms[3]?.value ?? 0)
  at.children = [
    makeAtom('at', false, at.start),
    makeAtom(formatNmAtom(x), false, at.start),
    makeAtom(formatNmAtom(y), false, at.start),
    // The angle is degrees, not a distance — it keeps the fractional writer.
    ...(hadAngle || angle !== undefined
      ? [makeAtom(formatKicadNumber(finalAngle), false, at.start)]
      : []),
    ...at.children.filter((child) => child.type === 'list')
  ]
}

/** Move a placed symbol and its absolute-positioned properties by a sheet-space delta. */
export function moveSchematicSymbolInAST(symbol: KicadSchematicSymbol, delta: Point): void {
  symbol.position.x = nm(symbol.position.x + delta.x)
  symbol.position.y = nm(symbol.position.y + delta.y)
  updateAt(symbol._node, symbol.position.x, symbol.position.y, symbol.position.angle)
  for (const property of symbol.properties) {
    property.position.x = nm(property.position.x + delta.x)
    property.position.y = nm(property.position.y + delta.y)
    updateAt(property._node, property.position.x, property.position.y, property.position.angle)
  }
}

/**
 * Move ONE of a symbol's (or a sheet's) fields, leaving the owner and its other
 * fields where they are — dragging a Reference off a crowded body without
 * moving the part.
 *
 * KiCad stores a field's `(at)` in absolute sheet space, not relative to its
 * symbol, so this is the same write `moveSchematicSymbolInAST` performs on
 * every property; it just does it to one. A missing key is a no-op rather than
 * an error: the caller's selection may name a field the document no longer has.
 */
export function moveSchematicFieldInAST(
  owner: { properties: SchematicProperty[] },
  key: string,
  delta: Point
): void {
  const property = owner.properties.find((candidate) => candidate.key === key)
  if (!property) return
  property.position.x = nm(property.position.x + delta.x)
  property.position.y = nm(property.position.y + delta.y)
  updateAt(property._node, property.position.x, property.position.y, property.position.angle)
}

/** A placed symbol's origin, turn and mirror. */
export interface SymbolPose {
  position: Point & { angle: number }
  mirror?: 'x' | 'y'
}

/** A quarter-turn angle's cosine and sine, exactly. */
const quarterTurn = (angle: number): { cos: number; sin: number } =>
  [
    { cos: 1, sin: 0 },
    { cos: 0, sin: 1 },
    { cos: -1, sin: 0 },
    { cos: 0, sin: -1 }
  ][((Math.round(angle / 90) % 4) + 4) % 4]

/**
 * Where a field's anchor lands when its symbol moves, turns or flips from
 * `from` to `to`: fixed to the symbol, as KiCad keeps it — a field's stored
 * place is its offset in the symbol's unturned frame (`SCH_FIELD::GetPosition`),
 * so `SCH_SYMBOL::Rotate` and the mirrors carry it round with the body. The
 * symbol's transform is `placedPoint`'s (connectivity.ts): turn in y-up
 * library space, flip to the sheet, then mirror.
 */
export function fieldPointThroughPose(point: Point, from: SymbolPose, to: SymbolPose): Point {
  const was = quarterTurn(from.position.angle)
  const dx = point.x - from.position.x
  const dy = point.y - from.position.y
  // Undo `from`: unmirror, back to y-up, turn back.
  const rx = from.mirror === 'y' ? -dx : dx
  const ry = from.mirror === 'x' ? dy : -dy
  const lx = rx * was.cos + ry * was.sin
  const ly = -rx * was.sin + ry * was.cos
  // Apply `to`.
  const now = quarterTurn(to.position.angle)
  const tx = lx * now.cos - ly * now.sin
  const ty = lx * now.sin + ly * now.cos
  return {
    x: nm(to.position.x + (to.mirror === 'y' ? -tx : tx)),
    y: nm(to.position.y + (to.mirror === 'x' ? ty : -ty))
  }
}

/**
 * Put a placed symbol at a new origin, turn and mirror, its fields carried
 * with it (`fieldPointThroughPose`). A field keeps its own angle and
 * justification: both read in the symbol's frame, so they turn with it.
 */
export function setSchematicSymbolPoseInAST(symbol: KicadSchematicSymbol, to: SymbolPose): void {
  const from: SymbolPose = { position: { ...symbol.position }, mirror: symbol.mirror }
  const angle = ((to.position.angle % 360) + 360) % 360
  const landed: SymbolPose = { position: { ...to.position, angle }, mirror: to.mirror }
  for (const property of symbol.properties) {
    const point = fieldPointThroughPose(property.position, from, landed)
    if (point.x === property.position.x && point.y === property.position.y) continue
    property.position.x = point.x
    property.position.y = point.y
    updateAt(property._node, point.x, point.y, property.position.angle)
  }
  const moved =
    symbol.position.x !== landed.position.x ||
    symbol.position.y !== landed.position.y ||
    symbol.position.angle !== angle
  if (moved) {
    symbol.position = { ...landed.position }
    updateAt(symbol._node, landed.position.x, landed.position.y, angle)
  }
  if (symbol.mirror !== to.mirror) mirrorSchematicSymbolInAST(symbol, to.mirror)
}

/**
 * Set or clear a symbol's `(fields_autoplaced yes)`, where KiCad writes it:
 * just before the uuid. KiCad writes nothing when it is clear.
 */
export function setSchematicFieldsAutoplaced(symbol: KicadSchematicSymbol, on: boolean): void {
  const node = symbol._node
  const existing = findChild(node, 'fields_autoplaced')
  const enabled = !!existing && tokenEnabled(node, 'fields_autoplaced')
  if (on && !enabled) {
    if (existing) node.children = node.children.filter((child) => child !== existing)
    const flag = makeList(
      [makeAtom('fields_autoplaced', false, node.start), makeAtom('yes', false, node.start)],
      node.start
    )
    let index = symbolChildIndex(symbol, 'uuid')
    if (index < 0) index = symbolChildIndex(symbol, 'property')
    node.children.splice(index >= 0 ? index : node.children.length, 0, flag)
  } else if (!on && existing) {
    node.children = node.children.filter((child) => child !== existing)
  }
  symbol.fieldsAutoplaced = on
}

/** Move a wire by a sheet-space delta, rewriting its (pts (xy ...)) list. */
export function moveSchematicWireInAST(wire: KicadWire, delta: Point): void {
  wire.points = wire.points.map((point) => ({
    x: nm(point.x + delta.x),
    y: nm(point.y + delta.y)
  }))
  const pts = findChild(wire._node, 'pts')
  if (!pts) return
  findChildren(pts, 'xy').forEach((xy, index) => {
    const point = wire.points[index]
    if (!point) return
    xy.children = [
      makeAtom('xy', false, xy.start),
      makeAtom(formatNmAtom(point.x), false, xy.start),
      makeAtom(formatNmAtom(point.y), false, xy.start)
    ]
  })
}

/** Replace a wire's polyline outright, rewriting its (pts …) list — the
 *  write behind a wire following a moved pin, where the segment count may
 *  change. */
export function setSchematicWirePointsInAST(wire: KicadWire, points: Point[]): void {
  wire.points = points.map((point) => ({ x: nm(point.x), y: nm(point.y) }))
  const pts = findChild(wire._node, 'pts')
  if (!pts) return
  const at = pts.start
  pts.children = [
    makeAtom('pts', false, at),
    ...wire.points.map((point) =>
      makeList(
        [
          makeAtom('xy', false, at),
          makeAtom(formatNmAtom(point.x), false, at),
          makeAtom(formatNmAtom(point.y), false, at)
        ],
        at
      )
    )
  ]
}

/** Move a label (any kind) by a sheet-space delta. */
export function moveSchematicLabelInAST(label: KicadLabel, delta: Point): void {
  label.position.x = nm(label.position.x + delta.x)
  label.position.y = nm(label.position.y + delta.y)
  updateAt(label._node, label.position.x, label.position.y, label.position.angle)
}

/** Move a point-anchored node (junction, no-connect) by a sheet-space delta. */
export function moveSchematicPointItemInAST(item: KicadSchematicPoint, delta: Point): void {
  item.x = nm(item.x + delta.x)
  item.y = nm(item.y + delta.y)
  updateAt(item._node, item.x, item.y)
}

/** Rotate a placed symbol to `angle` degrees (KiCad symbol angles are cardinal). */
export function rotateSchematicSymbolInAST(symbol: KicadSchematicSymbol, angle: number): void {
  const normalized = ((angle % 360) + 360) % 360
  symbol.position.angle = normalized
  updateAt(symbol._node, symbol.position.x, symbol.position.y, normalized)
}

/** Set/clear a placed symbol's `(mirror x|y)` (undefined removes it). */
export function mirrorSchematicSymbolInAST(
  symbol: KicadSchematicSymbol,
  mirror: 'x' | 'y' | undefined
): void {
  symbol.mirror = mirror
  const node = symbol._node
  const isMirror = (c: SExprNode): boolean => c.type === 'list' && getToken(c) === 'mirror'
  // Where the old one stood, else right after `(at …)`, where KiCad writes it.
  const existing = node.children.findIndex(isMirror)
  const at = node.children.findIndex((c) => c.type === 'list' && getToken(c) === 'at')
  node.children = node.children.filter((c) => !isMirror(c))
  if (mirror) {
    const index = existing >= 0 ? existing : at >= 0 ? at + 1 : node.children.length
    node.children.splice(
      index,
      0,
      makeList(
        [makeAtom('mirror', false, node.start), makeAtom(mirror, false, node.start)],
        node.start
      )
    )
  }
}

/** Edit a wire's stroke width / type / color (color null clears the override). */
export function updateSchematicWireInAST(
  // A bus entry strokes the same way, so it takes this writer too.
  wire: Pick<KicadWire, 'width' | 'strokeType' | 'strokeColor' | '_node'>,
  data: { width?: Nm; strokeType?: string; strokeColor?: Rgba | null }
): void {
  const stroke = findOrCreateChild(wire._node, 'stroke')
  if (data.width !== undefined) {
    wire.width = data.width
    setScalarChild(stroke, 'width', formatNmAtom(data.width))
  }
  if (data.strokeType !== undefined) {
    wire.strokeType = data.strokeType
    setScalarChild(stroke, 'type', data.strokeType)
  }
  if (data.strokeColor !== undefined) {
    wire.strokeColor = data.strokeColor ?? undefined
    if (data.strokeColor) setColorChild(stroke, data.strokeColor)
    else removeColorChild(stroke)
  }
}

/** Edit a junction's diameter / color (color null clears the override). */
export function updateSchematicJunctionInAST(
  junction: KicadSchematicPoint,
  data: { diameter?: Nm; color?: Rgba | null }
): void {
  const node = junction._node
  if (data.diameter !== undefined) {
    junction.diameter = data.diameter
    setScalarChild(node, 'diameter', formatNmAtom(data.diameter))
  }
  if (data.color !== undefined) {
    junction.color = data.color ?? undefined
    if (data.color) setColorChild(node, data.color)
    else removeColorChild(node)
  }
}

/** Set a label's net-name text (its first positional atom). */
export function setSchematicLabelText(label: KicadLabel, text: string): void {
  label.text = text
  setPositionalAtom(label._node, 1, text, true)
}

/** Set a global/hierarchical label's I/O shape. */
export function setSchematicLabelShape(label: KicadLabel, shape: KicadLabel['shape']): void {
  label.shape = shape
  if (shape) setScalarChild(label._node, 'shape', shape)
}

/** Move a hierarchical-sheet rectangle (box, name/file fields, pins) by a delta. */
export function moveSchematicSheetInAST(sheet: KicadSheet, delta: Point): void {
  sheet.position.x = nm(sheet.position.x + delta.x)
  sheet.position.y = nm(sheet.position.y + delta.y)
  updateAt(sheet._node, sheet.position.x, sheet.position.y)
  for (const property of sheet.properties) {
    property.position.x = nm(property.position.x + delta.x)
    property.position.y = nm(property.position.y + delta.y)
    updateAt(property._node, property.position.x, property.position.y, property.position.angle)
  }
  for (const pin of sheet.pins) {
    pin.position.x = nm(pin.position.x + delta.x)
    pin.position.y = nm(pin.position.y + delta.y)
    updateAt(pin._node, pin.position.x, pin.position.y, pin.position.angle)
  }
}

/** Replace a sheet node's `(size w h)` atoms in place. */
const updateSize = (node: SExprList, width: Nm, height: Nm): void => {
  const size = findChild(node, 'size')
  if (!size) return
  size.children = [
    makeAtom('size', false, size.start),
    makeAtom(formatNmAtom(width), false, size.start),
    makeAtom(formatNmAtom(height), false, size.start)
  ]
}

/**
 * Resize a sheet to a new top-left position + size (sheet space). The box and
 * its size atom move; the Sheetname/Sheetfile fields are re-anchored to the new
 * corners the way `addSchematicSheetToAST` places them (name above the top-left,
 * file below the bottom-left). Each pin keeps the edge it was on and its
 * distance along that edge, clamped into the new span — a pin left behind in
 * space is a connection point no wire can meet and nothing in the file records
 * that it was ever attached.
 */
export function resizeSchematicSheetInAST(
  sheet: KicadSheet,
  position: Point,
  size: { width: Nm; height: Nm }
): void {
  // Read against the OLD box, before it moves: a pin's side and its distance
  // along that side are what survive the resize.
  const pins = sheet.pins.map((pin) => {
    const side = sheetSideOf(sheet, pin.position)
    return { pin, side, offset: sheetPinOffset(sheet, side, pin.position) }
  })
  sheet.position.x = position.x
  sheet.position.y = position.y
  sheet.size.width = size.width
  sheet.size.height = size.height
  updateAt(sheet._node, position.x, position.y)
  updateSize(sheet._node, size.width, size.height)
  for (const property of sheet.properties) {
    const field = canonicalSheetFieldName(property.key)
    const y =
      field === 'sheetfile'
        ? nm(position.y + size.height + SHEET_LABEL_OFFSET_NM)
        : field === 'sheetname'
          ? nm(position.y - SHEET_LABEL_OFFSET_NM)
          : property.position.y
    property.position.x = position.x
    property.position.y = y
    updateAt(property._node, position.x, y, property.position.angle)
  }
  for (const pin of pins) {
    setSheetPinPlacement(pin.pin, {
      position: sheetPinPoint(sheet, pin.side, pin.offset),
      side: pin.side
    })
  }
}

/**
 * What a schematic selection can hold. Most are document items, `index` into
 * the parsed array of their kind (`schematicItemsOf`); three are parts of one:
 * `field` of a symbol, and `sheet_field` and `sheet_pin` of a sheet, whose
 * `index` is then the owner's.
 */
export type SchematicItemType =
  | 'symbol'
  | 'wire'
  | 'label'
  | 'junction'
  | 'no_connect'
  | 'sheet'
  /** A symbol's Reference/Value text, selectable and movable on its own. */
  | 'field'
  /** A sheet's Sheetname/Sheetfile text, a field of the sheet as in KiCad. */
  | 'sheet_field'
  | 'sheet_pin'
  | 'text'
  | 'text_box'
  /** A sheet-level `(rectangle …)`, drawn under the `shape:` key. */
  | 'shape'
  | 'polyline'
  | 'circle'
  | 'arc'
  | 'bezier'
  | 'image'
  | 'table'
  | 'bus'
  | 'bus_entry'
  /** KiCad's directive label. */
  | 'netclass_flag'
  | 'rule_area'

/** A document item and the array it lives in. Parts (fields, sheet pins) have none. */
export type SchematicDocumentItemType = Exclude<
  SchematicItemType,
  'field' | 'sheet_field' | 'sheet_pin'
>

/** The parsed array a document item type indexes into. */
export const schematicItemsOf = (
  schematic: KicadSchematic,
  type: SchematicDocumentItemType
): ReadonlyArray<{ _node: SExprList; uuid?: string }> => {
  switch (type) {
    case 'symbol':
      return schematic.symbols
    case 'wire':
      return schematic.wires
    case 'label':
      return schematic.labels
    case 'junction':
      return schematic.junctions
    case 'no_connect':
      return schematic.noConnects
    case 'sheet':
      return schematic.sheets
    case 'text':
      return schematic.texts
    case 'text_box':
      return schematic.textBoxes
    case 'shape':
      return schematic.shapes
    case 'polyline':
      return schematic.polylines
    case 'circle':
      return schematic.circles
    case 'arc':
      return schematic.arcs
    case 'bezier':
      return schematic.beziers
    case 'image':
      return schematic.images
    case 'table':
      return schematic.tables
    case 'bus':
      return schematic.buses
    case 'bus_entry':
      return schematic.busEntries
    case 'netclass_flag':
      return schematic.directiveLabels
    case 'rule_area':
      return schematic.ruleAreas
  }
}

const SCHEMATIC_ITEM_TYPES: ReadonlySet<string> = new Set<SchematicItemType>([
  'symbol',
  'wire',
  'label',
  'junction',
  'no_connect',
  'sheet',
  'field',
  'sheet_field',
  'sheet_pin',
  'text',
  'text_box',
  'shape',
  'polyline',
  'circle',
  'arc',
  'bezier',
  'image',
  'table',
  'bus',
  'bus_entry',
  'netclass_flag',
  'rule_area'
])

/**
 * Whether a selection ref — perhaps one an undo step kept from before an edit —
 * still names something on this sheet: an item in range of its array, or a
 * part (a field by key, a sheet pin by index) its owner still has.
 */
export function schematicItemExists(
  schematic: KicadSchematic,
  item: { type: string; index: number; field?: string; pin?: number }
): item is { type: SchematicItemType; index: number; field?: string; pin?: number } {
  if (!SCHEMATIC_ITEM_TYPES.has(item.type) || item.index < 0) return false
  const type = item.type as SchematicItemType
  switch (type) {
    case 'field':
      return !!schematic.symbols[item.index]?.properties.some((p) => p.key === item.field)
    case 'sheet_field':
      return !!schematic.sheets[item.index]?.properties.some((p) => p.key === item.field)
    case 'sheet_pin':
      return (
        item.pin !== undefined &&
        item.pin >= 0 &&
        item.pin < (schematic.sheets[item.index]?.pins.length ?? 0)
      )
    default:
      return item.index < schematicItemsOf(schematic, type).length
  }
}

export const isSchematicPartType = (
  type: SchematicItemType
): type is 'field' | 'sheet_field' | 'sheet_pin' =>
  type === 'field' || type === 'sheet_field' || type === 'sheet_pin'

/** The items on this sheet with these uuids, as selection refs: every document item that carries one. */
export const itemRefsWithUuids = (
  sheet: KicadSchematic,
  uuids: string[]
): Array<{ type: SchematicItemType; index: number }> => {
  const wanted = new Set(uuids)
  const refs: Array<{ type: SchematicItemType; index: number }> = []
  // Junctions and no-connects are parsed as points; their uuid is on the node.
  const uuidOf = (item: { _node: SExprList; uuid?: string }): string | undefined => {
    if (item.uuid) return item.uuid
    const node = findChild(item._node, 'uuid')
    return node ? getFirstAtomValue(node) : undefined
  }
  const collect = (type: SchematicDocumentItemType): void =>
    schematicItemsOf(sheet, type).forEach((item, index) => {
      const uuid = uuidOf(item)
      if (uuid && wanted.has(uuid)) refs.push({ type, index })
    })
  const types: SchematicDocumentItemType[] = [
    'symbol',
    'wire',
    'label',
    'junction',
    'no_connect',
    'sheet',
    'text',
    'text_box',
    'shape',
    'polyline',
    'circle',
    'arc',
    'bezier',
    'image',
    'table',
    'bus',
    'bus_entry',
    'netclass_flag',
    'rule_area'
  ]
  for (const type of types) collect(type)
  return refs
}

/**
 * Remove items' backing AST nodes. Indices refer to the parsed arrays; the
 * caller re-parses afterwards, so the stale domain arrays are never read
 * again. A sheet pin leaves its sheet; a field is part of its owner and is not
 * removed, as KiCad keeps a symbol's and a sheet's fields. Removing a sheet
 * drops only the `(sheet)` node — the child file on disk is never touched.
 */
export function removeSchematicItemsFromAST(
  schematic: KicadSchematic,
  items: Array<{ type: SchematicItemType; index: number; pin?: number }>
): void {
  const doomed: SExprNode[] = []
  const removedSheets = new Set(
    items.filter((item) => item.type === 'sheet').map((item) => item.index)
  )
  for (const item of items) {
    if (item.type === 'sheet_pin') {
      const sheet = schematic.sheets[item.index]
      const pin = item.pin !== undefined ? sheet?.pins[item.pin] : undefined
      if (sheet && pin && !removedSheets.has(item.index)) removeSheetPinFromAST(sheet, pin)
      continue
    }
    if (isSchematicPartType(item.type)) continue
    const node = schematicItemsOf(schematic, item.type)[item.index]?._node
    if (node) doomed.push(node)
  }
  removeSchematicNodesFromAST(schematic, doomed)
}

/** Remove top-level nodes by identity — any item kind, texts included, which
 *  the typed selection above never names. The caller re-parses afterwards. */
export function removeSchematicNodesFromAST(schematic: KicadSchematic, nodes: SExprNode[]): void {
  const doomed = new Set(nodes)
  schematic._root.children = schematic._root.children.filter((child) => !doomed.has(child))
  if (nodes.some((node) => node.type === 'list' && getToken(node) === 'symbol')) {
    pruneUnusedLibSymbols(schematic)
  }
}

/**
 * Drop every `lib_symbols` definition no placed symbol uses, as KiCad does on
 * save. Done at removal rather than at save because the agent's loop never
 * saves: `ensureLibSymbolsInAST` keeps a cached copy for the life of the file,
 * so without this a symbol regenerated in its library could not be brought
 * onto the sheet even by removing and re-placing every instance. A definition another
 * definition `extends` stays as long as that one does. Works from the raw
 * root, not the parsed arrays, because it runs before the caller re-parses.
 */
export function pruneUnusedLibSymbols(schematic: KicadSchematic): void {
  const container = findChild(schematic._root, 'lib_symbols')
  if (!container) return
  const used = new Set<string>()
  for (const child of schematic._root.children) {
    if (child.type !== 'list' || getToken(child) !== 'symbol') continue
    // A placement draws from its `lib_name` entry when it carries one.
    const libId = findChild(child, 'lib_name') ?? findChild(child, 'lib_id')
    const [name] = libId ? getAtomValues(libId) : []
    if (name) used.add(name)
  }
  // Keep the parents of what is kept, transitively.
  const definitions = container.children.filter(
    (child): child is SExprList => child.type === 'list' && getToken(child) === 'symbol'
  )
  const parentOf = new Map<string, string>()
  for (const definition of definitions) {
    const [name] = getAtomValues(definition)
    const extendsNode = findChild(definition, 'extends')
    const [parent] = extendsNode ? getAtomValues(extendsNode) : []
    if (name && parent) parentOf.set(name, parent)
  }
  for (const name of [...used]) {
    let current = parentOf.get(name)
    while (current && !used.has(current)) {
      used.add(current)
      current = parentOf.get(current)
    }
  }
  container.children = container.children.filter((child) => {
    if (child.type !== 'list' || getToken(child) !== 'symbol') return true
    const [name] = getAtomValues(child)
    return !name || used.has(name)
  })
  for (const name of [...schematic.libSymbols.keys()]) {
    if (!used.has(name)) schematic.libSymbols.delete(name)
  }
}

// ---------------------------------------------------------------------------
// Adding new items. These splice nodes into the raw AST only — callers go
// through the editor's runCommand serialize→reparse cycle, which re-derives
// the domain arrays, so none of them touch the typed collections.
// ---------------------------------------------------------------------------

const bare = (value: string, at: number): SExprAtom => makeAtom(value, false, at)
const quoted = (value: string, at: number): SExprAtom => makeAtom(value, true, at)
/** Plain numeric atom: angles, unit numbers, color components. NOT distances. */
const num = (value: number, at: number): SExprAtom => makeAtom(formatKicadNumber(value), false, at)
/** Distance atom, written from integer nanometers. */
const numNm = (value: Nm, at: number): SExprAtom => makeAtom(formatNmAtom(value), false, at)

const uuidNode = (at: number): SExprList =>
  makeList([bare('uuid', at), quoted(crypto.randomUUID(), at)], at)

const atNode = (position: Point & { angle?: number }, at: number): SExprList =>
  makeList(
    [bare('at', at), numNm(position.x, at), numNm(position.y, at), num(position.angle ?? 0, at)],
    at
  )

/** A field's `(hide yes)`, which KiCad 10 writes on the field itself, just
 *  before its effects — for a field that carries data rather than something
 *  meant to be read off the sheet. */
const hideYesNode = (at: number): SExprList => makeList([bare('hide', at), bare('yes', at)], at)

const fontEffectsNode = (
  at: number,
  justify?: string[],
  font: { size?: Nm; bold?: boolean } = {}
): SExprList => {
  const size = font.size ?? DEFAULT_FONT_SIZE_NM
  return makeList(
    [
      bare('effects', at),
      makeList(
        [
          bare('font', at),
          makeList([bare('size', at), numNm(size, at), numNm(size, at)], at),
          ...(font.bold ? [makeList([bare('bold', at), bare('yes', at)], at)] : [])
        ],
        at
      ),
      ...(justify?.length
        ? [makeList([bare('justify', at), ...justify.map((word) => bare(word, at))], at)]
        : [])
    ],
    at
  )
}

/**
 * Splice a new top-level node after the last sibling with the same token so
 * diffs stay grouped; the first of a kind goes before `sheet_instances`,
 * which KiCad keeps at the document tail.
 */
export const insertTopLevelNode = (schematic: KicadSchematic, node: SExprList): void => {
  const children = schematic._root.children
  const token = getToken(node)
  let index = -1
  for (let i = 0; i < children.length; i++) {
    if (getToken(children[i]) === token) index = i + 1
  }
  if (index < 0) {
    const tail = children.findIndex((child) => getToken(child) === 'sheet_instances')
    index = tail >= 0 ? tail : children.length
  }
  children.splice(index, 0, node)
}

/**
 * Append a new wire along `points` (two or more, sheet space).
 *
 * Written as one `(wire …)` node per segment, each with its own uuid, because
 * that is what a wire IS to KiCad: `parseLine` reads exactly two points, and a
 * three-point node makes the whole file unloadable ("Failed to load
 * schematic", nothing more). The reader here accepts a polyline, which is why
 * the defect survived until a bent wire met kicad-cli.
 */
export function addSchematicWireToAST(schematic: KicadSchematic, points: Point[]): void {
  if (points.length < 2) return
  const at = schematic._root.start
  for (let index = 1; index < points.length; index += 1) {
    const pts = makeList(
      [
        bare('pts', at),
        ...[points[index - 1], points[index]].map((point) =>
          makeList([bare('xy', at), numNm(point.x, at), numNm(point.y, at)], at)
        )
      ],
      at
    )
    const stroke = makeList(
      [
        bare('stroke', at),
        makeList([bare('width', at), numNm(ZERO, at)], at),
        makeList([bare('type', at), bare('default', at)], at)
      ],
      at
    )
    insertTopLevelNode(schematic, makeList([bare('wire', at), pts, stroke, uuidNode(at)], at))
  }
}

/**
 * Break a wire at a point on its interior, as KiCad does where a junction
 * lands mid-wire (`BreakSegments`): the node keeps the part up to the point,
 * and a copy — same stroke, new uuid, written right after it — takes the rest.
 * The new wire is appended to `schematic.wires`. False when the point is not
 * strictly inside the wire.
 */
export function splitSchematicWireInAST(
  schematic: KicadSchematic,
  wire: KicadWire,
  point: Point
): boolean {
  const points = wire.points
  const inside = (a: Point, b: Point): boolean => {
    if ((point.x === a.x && point.y === a.y) || (point.x === b.x && point.y === b.y)) return false
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
    if (cross !== 0) return false
    return (
      point.x >= Math.min(a.x, b.x) &&
      point.x <= Math.max(a.x, b.x) &&
      point.y >= Math.min(a.y, b.y) &&
      point.y <= Math.max(a.y, b.y)
    )
  }
  const segment = points.findIndex((b, index) => index > 0 && inside(points[index - 1], b))
  if (segment < 0) return false
  const head = [...points.slice(0, segment), point]
  const tail = [point, ...points.slice(segment)]
  const node = cloneNodeDeep(wire._node) as SExprList
  const uuid = findChild(node, 'uuid')
  if (uuid) uuid.children = uuidNode(node.start).children
  const copy: KicadWire = { ...wire, points: [], _node: node, uuid: undefined }
  setSchematicWirePointsInAST(copy, tail)
  setSchematicWirePointsInAST(wire, head)
  const children = schematic._root.children
  const at = children.indexOf(wire._node)
  if (at >= 0) children.splice(at + 1, 0, node)
  else insertTopLevelNode(schematic, node)
  // A bus splits into a bus, a wire into a wire: the copy is the same node kind.
  ;(schematic.buses.includes(wire) ? schematic.buses : schematic.wires).push(copy)
  return true
}

/** Append a junction dot at a sheet-space point. */
export function addSchematicJunctionToAST(schematic: KicadSchematic, point: Point): void {
  const at = schematic._root.start
  insertTopLevelNode(
    schematic,
    makeList(
      [
        bare('junction', at),
        makeList([bare('at', at), numNm(point.x, at), numNm(point.y, at)], at),
        makeList([bare('diameter', at), numNm(ZERO, at)], at),
        makeList([bare('color', at), num(0, at), num(0, at), num(0, at), num(0, at)], at),
        uuidNode(at)
      ],
      at
    )
  )
}

/** Append a no-connect flag at a sheet-space point. */
export function addSchematicNoConnectToAST(schematic: KicadSchematic, point: Point): void {
  const at = schematic._root.start
  insertTopLevelNode(
    schematic,
    makeList(
      [
        bare('no_connect', at),
        makeList([bare('at', at), numNm(point.x, at), numNm(point.y, at)], at),
        uuidNode(at)
      ],
      at
    )
  )
}

/** Append a label of any kind. Global/hierarchical labels get a passive-ish
 *  `(shape input)`, matching what KiCad writes for a fresh label. */
export function addSchematicLabelToAST(
  schematic: KicadSchematic,
  kind: KicadLabel['type'],
  text: string,
  position: Point & { angle?: number },
  shape: SheetPinShape = 'input'
): void {
  const at = schematic._root.start
  const children: SExprNode[] = [bare(kind, at), quoted(text, at)]
  // A global or hierarchical label's shape is what it is DRAWN as and what a
  // hierarchical boundary is checked against; only a local label has none.
  if (kind !== 'label') children.push(makeList([bare('shape', at), bare(shape, at)], at))
  // A label's text grows away from its anchor, and which way "away" is comes
  // from the justification, not the angle: KiCad's loader folds 180° to 0° and
  // 270° to 90° (`EDA_ANGLE::KeepUpright`) before it chooses a spin style, so
  // the angle alone cannot say "leftward". `SCH_LABEL_BASE::SetSpinStyle` pairs
  // LEFT and BOTTOM with right-justified text, and that is what KiCad writes.
  // Emitting `left` for every angle put every left-facing and downward label's
  // text through the pin and into the symbol body — in both editors.
  const horizontal = labelHorizontalJustify(position.angle ?? 0)
  children.push(
    atNode(position, at),
    fontEffectsNode(at, kind === 'label' ? [horizontal, 'bottom'] : [horizontal]),
    uuidNode(at)
  )
  insertTopLevelNode(schematic, makeList(children, at))
}

/**
 * Set the page. A named size is written by name, so KiCad's own table decides
 * the millimetres and this never persists its nominal figures; `User` carries
 * its own width and height.
 *
 * A file with no `(paper ...)` gets one directly after `(uuid ...)`, which is
 * where KiCad writes it — `insertTopLevelNode` groups by token and would put a
 * first-of-its-kind at the document tail instead.
 */
export function setSchematicPaper(
  schematic: KicadSchematic,
  page: { size: string; portrait?: boolean; width?: number; height?: number }
): void {
  const root = schematic._root
  const at = root.start
  const atoms: SExprNode[] = [bare('paper', at), quoted(page.size, at)]
  if (page.size === 'User') {
    atoms.push(
      makeAtom(formatKicadNumber(page.width ?? 0), false, at),
      makeAtom(formatKicadNumber(page.height ?? 0), false, at)
    )
  } else if (page.portrait) {
    atoms.push(bare('portrait', at))
  }
  const node = makeList(atoms, at)
  const existing = findChild(root, 'paper')
  if (existing) {
    root.children[root.children.indexOf(existing)] = node
    return
  }
  const uuid = findChild(root, 'uuid')
  const after = uuid ? root.children.indexOf(uuid) + 1 : 1
  root.children.splice(after, 0, node)
}

/** The shapes KiCad gives a sheet pin or a hierarchical label. */
export const SHEET_PIN_SHAPES = [
  'input',
  'output',
  'bidirectional',
  'tri_state',
  'passive'
] as const
export type SheetPinShape = (typeof SHEET_PIN_SHAPES)[number]

export type SheetSide = 'left' | 'right' | 'top' | 'bottom'

/**
 * Which way a sheet pin faces, per edge, as KiCad writes it: the angle names
 * the edge's outward side. The glyph and name are drawn the OTHER way, inside
 * the box — see `sheetPinJustify`.
 */
export const SHEET_PIN_ANGLE: Record<SheetSide, number> = {
  left: 180,
  right: 0,
  top: 90,
  bottom: 270
}

/** Enough of a sheet to place a pin on it: the box, before or after parsing. */
export interface SheetBox {
  position: Point
  size: { width: Nm; height: Nm }
}

/** Sheet pins sit on the pin grid, like every other connection point. */
export const SHEET_PIN_PITCH: Nm = mmToNm(2.54)

/**
 * Distance along an edge, from its top or left corner, of a point on that side.
 * The pair with `sheetPinPoint` is what lets a resize keep its pins where they
 * were along an edge instead of leaving them behind in space.
 */
export const sheetPinOffset = (sheet: SheetBox, side: SheetSide, position: Point): Nm =>
  side === 'left' || side === 'right'
    ? nm(position.y - sheet.position.y)
    : nm(position.x - sheet.position.x)

/** A point `offset` along one edge of a sheet, clamped inside it and snapped to
 *  the pin grid so a wire can meet it. */
export const sheetPinPoint = (sheet: SheetBox, side: SheetSide, offset: Nm): Point => {
  const span = side === 'left' || side === 'right' ? sheet.size.height : sheet.size.width
  // One pitch of margin at each end keeps a pin off the corner, where its name
  // would run into the neighbouring edge's.
  // Snap first, then clamp to grid-aligned bounds: rounding after a clamp can
  // step back outside it, and a pin off the edge is a connection point that
  // does not exist.
  const high = Math.max(
    SHEET_PIN_PITCH,
    Math.floor((span - SHEET_PIN_PITCH) / SHEET_PIN_PITCH) * SHEET_PIN_PITCH
  )
  const snapped = Math.round(offset / SHEET_PIN_PITCH) * SHEET_PIN_PITCH
  const along = nm(Math.min(Math.max(snapped, SHEET_PIN_PITCH), high))
  switch (side) {
    case 'left':
      return { x: sheet.position.x, y: nm(sheet.position.y + along) }
    case 'right':
      return { x: nm(sheet.position.x + sheet.size.width), y: nm(sheet.position.y + along) }
    case 'top':
      return { x: nm(sheet.position.x + along), y: sheet.position.y }
    case 'bottom':
      return { x: nm(sheet.position.x + along), y: nm(sheet.position.y + sheet.size.height) }
  }
}

/**
 * Where the `index`-th pin on a side goes (1-based), stacked at pin pitch.
 *
 * Left and right fill downward from the top corner. Top and bottom fill
 * **inward from the right**, because a sheet's Sheetname and Sheetfile labels
 * are both anchored at the left corners — filling from the left ran a bottom
 * pin's name straight through the file name.
 */
export const sheetPinSlot = (sheet: SheetBox, side: SheetSide, index: number): Point =>
  side === 'left' || side === 'right'
    ? sheetPinPoint(sheet, side, nm(SHEET_PIN_PITCH * index))
    : sheetPinPoint(sheet, side, nm(sheet.size.width - SHEET_PIN_PITCH * index))

/** Which edge a point lies on, by nearest edge — the side a pin is *on*, which
 *  the file does not state and the angle only implies. */
export const sheetSideOf = (sheet: SheetBox, position: Point): SheetSide => {
  const distances: Array<[SheetSide, number]> = [
    ['left', Math.abs(position.x - sheet.position.x)],
    ['right', Math.abs(position.x - (sheet.position.x + sheet.size.width))],
    ['top', Math.abs(position.y - sheet.position.y)],
    ['bottom', Math.abs(position.y - (sheet.position.y + sheet.size.height))]
  ]
  return distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best))[0]
}

/**
 * Add a pin to a hierarchical sheet. The node is nested in the `(sheet ...)`,
 * not the document root, which is why this cannot go through
 * `insertTopLevelNode` like every other add.
 */
export function addSheetPinToAST(
  sheet: KicadSheet,
  pin: { name: string; shape: SheetPinShape; position: Point; side: SheetSide }
): void {
  const at = sheet._node.start
  const angle = SHEET_PIN_ANGLE[pin.side]
  sheet._node.children.push(
    makeList(
      [
        bare('pin', at),
        quoted(pin.name, at),
        bare(pin.shape, at),
        atNode({ ...pin.position, angle }, at),
        fontEffectsNode(at, [sheetPinJustify(angle)]),
        uuidNode(at)
      ],
      at
    )
  )
}

/** Drop a pin's node from its sheet. The caller re-parses, as with every
 *  other removal, so the stale `pins` array is never read again. */
export function removeSheetPinFromAST(sheet: KicadSheet, pin: KicadSheetPin): void {
  sheet._node.children = sheet._node.children.filter((child) => child !== pin._node)
}

/** Move a sheet pin, re-justifying for the edge it now sits on. */
export function setSheetPinPlacement(
  pin: KicadSheetPin,
  placement: { position: Point; side: SheetSide }
): void {
  const angle = SHEET_PIN_ANGLE[placement.side]
  pin.position = { ...placement.position, angle }
  updateAt(pin._node, placement.position.x, placement.position.y, angle)
  const horizontal = sheetPinJustify(angle)
  const effects = findOrCreateChild(pin._node, 'effects')
  const justify = findChild(effects, 'justify')
  const node = makeList(
    [bare('justify', effects.start), bare(horizontal, effects.start)],
    effects.start
  )
  if (justify) effects.children[effects.children.indexOf(justify)] = node
  else effects.children.push(node)
  pin.effects.horizontalAlign = horizontal
}

/** Rename a sheet pin, or change the shape it advertises. */
export function setSheetPinFields(
  pin: KicadSheetPin,
  fields: { name?: string; shape?: SheetPinShape }
): void {
  if (fields.name !== undefined) {
    pin.name = fields.name
    const atoms = pin._node.children.filter((child) => child.type === 'atom')
    const nameAtom = atoms[1]
    if (nameAtom && nameAtom.type === 'atom') {
      nameAtom.value = fields.name
      nameAtom.quoted = true
    }
  }
  if (fields.shape !== undefined) {
    pin.electricalType = fields.shape
    const atoms = pin._node.children.filter((child) => child.type === 'atom')
    const shapeAtom = atoms[2]
    if (shapeAtom && shapeAtom.type === 'atom') {
      shapeAtom.value = fields.shape
      shapeAtom.quoted = false
    }
  }
}

/**
 * A sheet pin's justification for its angle: the opposite of a label's, so the
 * glyph and name run from the edge into the box. KiCad writes exactly this
 * (`180` with `justify left` on a left edge) and honors whatever the file says —
 * checked with `kicad-cli sch export svg`: a left-edge pin written `justify
 * right` draws outside the box, glyph pointing away from it.
 */
export const sheetPinJustify = (angle: number): 'left' | 'right' =>
  labelHorizontalJustify(angle) === 'left' ? 'right' : 'left'

/** KiCad's spin-style rule for a label at a cardinal angle: facing left (180°)
 *  or down (270°) is right-justified, so the text extends away from the anchor. */
export const labelHorizontalJustify = (angle: number): 'left' | 'right' => {
  const cardinal = ((Math.round(angle) % 360) + 360) % 360
  return cardinal === 180 || cardinal === 270 ? 'right' : 'left'
}

/**
 * Put a label at a point and angle. The justification is rewritten with the
 * angle, because the two are one fact (see `addSchematicLabelToAST`): a label
 * turned to 180° and left justified would read back through its pin.
 */
export function setSchematicLabelPlacement(
  label: KicadLabel,
  position: Point & { angle?: number }
): void {
  const angle = position.angle ?? label.position.angle
  label.position.x = position.x
  label.position.y = position.y
  label.position.angle = angle
  updateAt(label._node, position.x, position.y, angle)
  const effects = findOrCreateChild(label._node, 'effects')
  const justify = findChild(effects, 'justify')
  const vertical = justify
    ? getAtomValues(justify).filter((word) => word === 'top' || word === 'bottom')
    : label.type === 'label'
      ? ['bottom']
      : []
  const horizontal = labelHorizontalJustify(angle)
  const node = makeList(
    [
      bare('justify', effects.start),
      ...[horizontal, ...vertical].map((w) => bare(w, effects.start))
    ],
    effects.start
  )
  if (justify) effects.children[effects.children.indexOf(justify)] = node
  else effects.children.push(node)
  label.effects.horizontalAlign = horizontal
}

/** Move a symbol field to an absolute point, turning it if an angle is given. */
export function setSchematicPropertyPlacement(
  property: SchematicProperty,
  position: Point & { angle?: number }
): void {
  const angle = position.angle ?? property.position.angle
  property.position.x = position.x
  property.position.y = position.y
  property.position.angle = angle
  updateAt(property._node, position.x, position.y, angle)
}

/** Show or hide a field, as KiCad 10 writes it: `(hide yes)` on the field,
 *  before its effects, and no `hide` inside them (KiCad 8's spelling). */
export function setSchematicPropertyHidden(property: SchematicProperty, hidden: boolean): void {
  const isHide = (child: SExprNode): boolean =>
    (child.type === 'atom' && child.value === 'hide') ||
    (child.type === 'list' && getToken(child) === 'hide')
  const node = property._node
  const effects = findOrCreateChild(node, 'effects')
  effects.children = effects.children.filter((child) => !isHide(child))
  node.children = node.children.filter((child) => !isHide(child))
  if (hidden) node.children.splice(node.children.indexOf(effects), 0, hideYesNode(node.start))
  property.hidden = hidden
}

/** Set a field's text justification, rewriting the `(justify …)` words. */
export function setSchematicPropertyJustify(
  property: SchematicProperty,
  horizontal: 'left' | 'center' | 'right',
  vertical: 'top' | 'center' | 'bottom'
): void {
  const effects = findOrCreateChild(property._node, 'effects')
  const justify = findChild(effects, 'justify')
  const words = [
    ...(horizontal === 'center' ? [] : [horizontal]),
    ...(vertical === 'center' ? [] : [vertical])
  ]
  const node = words.length
    ? makeList(
        [bare('justify', effects.start), ...words.map((w) => bare(w, effects.start))],
        effects.start
      )
    : null
  if (justify) {
    if (node) effects.children[effects.children.indexOf(justify)] = node
    else effects.children = effects.children.filter((child) => child !== justify)
  } else if (node) {
    effects.children.push(node)
  }
  property.effects.horizontalAlign = horizontal
  property.effects.verticalAlign = vertical
}

/** Set a free text's content (its first positional atom). */
export function setSchematicTextContent(text: KicadSchematicText, value: string): void {
  text.text = value
  setPositionalAtom(text._node, 1, value, true)
}

/** Put a free text at a point, turning it if an angle is given. */
export function setSchematicTextPlacement(
  text: KicadSchematicText,
  position: Point & { angle?: number }
): void {
  const angle = position.angle ?? text.position.angle
  text.position.x = position.x
  text.position.y = position.y
  text.position.angle = angle
  updateAt(text._node, position.x, position.y, angle)
}

const cloneSExprNode = <T extends SExprNode>(node: T): T => {
  if (node.type === 'atom') return { ...node }
  return {
    ...node,
    children: (node as SExprList).children.map((child) => cloneSExprNode(child))
  }
}

/** A lib symbol plus its `extends` ancestors, base last (parents resolved
 *  against the sheet the definition came from). */
export function libSymbolChain(
  libSymbol: KicadLibSymbol,
  lookup: (name: string) => KicadLibSymbol | undefined
): KicadLibSymbol[] {
  const chain: KicadLibSymbol[] = [libSymbol]
  const visited = new Set<string>([libSymbol.name])
  let current = libSymbol
  while (current.extends && !visited.has(current.extends)) {
    const parent = lookup(current.extends)
    if (!parent) break
    visited.add(parent.name)
    chain.push(parent)
    current = parent
  }
  return chain
}

/** The name KiCad prefixes unit sub-symbols with: the part after the nickname. */
const bareSymbolName = (name: string): string => name.slice(name.indexOf(':') + 1)

/** Fields KiCad's `Flatten` lets a derived symbol override only when it sets
 *  them to something; an empty one keeps the parent's. */
const MANDATORY_FIELDS = new Set(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'])

/**
 * A derived symbol as the single flat root symbol KiCad expects in a
 * schematic's `(lib_symbols …)` block.
 *
 * `extends` is a *library* construct. When KiCad caches a symbol into a sheet
 * it calls `LIB_SYMBOL::Flatten()` first ("we want a full symbol, not just the
 * top level child"), and its schematic parser never resolves a parent inside
 * `lib_symbols` — the map it passes is a dummy, by its own comment. So a
 * derived symbol embedded with its parent beside it draws in GoatCAD, which
 * walks the chain itself, and draws as *nothing* in KiCad. Found by rendering
 * the same sheet in both.
 *
 * Mirrors `Flatten` (`eeschema/lib_symbol.cpp`): start from the root, apply each
 * derived symbol's fields from the root down — a mandatory field only when it
 * is non-empty, any other field always — and name the result after the leaf.
 * Unit sub-symbols are renamed to the leaf's bare name, which KiCad's parser
 * checks as a prefix and refuses when it does not match.
 */
export function flattenLibSymbolChain(chain: KicadLibSymbol[]): SExprList {
  const leaf = chain[0]
  const root = chain[chain.length - 1]
  const flat = cloneSExprNode(root._node)
  if (chain.length === 1) return flat

  const nameAtom = flat.children[1]
  if (nameAtom?.type === 'atom') nameAtom.value = leaf.name
  const rootPrefix = `${bareSymbolName(root.name)}_`
  const leafPrefix = `${bareSymbolName(leaf.name)}_`
  for (const child of flat.children) {
    if (child.type !== 'list' || getToken(child) !== 'symbol') continue
    const unitName = child.children[1]
    if (unitName?.type === 'atom' && unitName.value.startsWith(rootPrefix)) {
      unitName.value = leafPrefix + unitName.value.slice(rootPrefix.length)
    }
  }

  for (let index = chain.length - 2; index >= 0; index--) {
    for (const field of findChildren(chain[index]._node, 'property')) {
      const [key, value] = getAtomValues(field)
      if (!key) continue
      if (MANDATORY_FIELDS.has(key) && !value) continue
      const clone = cloneSExprNode(field)
      const existing = findChildren(flat, 'property').find(
        (candidate) => getFirstAtomValue(candidate) === key
      )
      if (existing) {
        flat.children[flat.children.indexOf(existing)] = clone
        continue
      }
      // A new field goes with the others, ahead of the unit sub-symbols.
      const properties = findChildren(flat, 'property')
      const anchor = properties.length
        ? flat.children.indexOf(properties[properties.length - 1]) + 1
        : flat.children.findIndex(
            (candidate) => candidate.type === 'list' && getToken(candidate) === 'symbol'
          )
      flat.children.splice(anchor < 0 ? flat.children.length : anchor, 0, clone)
    }
  }
  return flat
}

/**
 * Make sure this schematic's `(lib_symbols …)` block can draw every symbol in
 * `definitions`, the way KiCad would write it: one flat root symbol per leaf,
 * never an `extends` (see `flattenLibSymbolChain`). Callers pass what
 * `libSymbolChain` returns, leaf first; a definition already cached is left
 * alone unless the cached copy is a derived one, which KiCad cannot draw and
 * which this replaces so a re-place repairs the file.
 */
export function ensureLibSymbolsInAST(
  schematic: KicadSchematic,
  definitions: KicadLibSymbol[]
): void {
  const container = findOrCreateChild(schematic._root, 'lib_symbols')
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  const parents = new Set(definitions.map((definition) => definition.extends).filter(Boolean))
  for (const definition of definitions) {
    if (parents.has(definition.name)) continue
    const cached = schematic.libSymbols.get(definition.name)
    if (cached && !cached.extends) continue
    const node = flattenLibSymbolChain(libSymbolChain(definition, (name) => byName.get(name)))
    const stale = cached ? container.children.indexOf(cached._node) : -1
    if (stale >= 0) container.children[stale] = node
    else container.children.push(node)
    // Keep the in-memory map consistent for repeat placements inside the
    // same command; the post-command reparse rebuilds it anyway.
    schematic.libSymbols.set(definition.name, parseLibSymbol(node))
  }
}

/** Pins of the given unit (plus common-unit pins) across an extends chain. */
/**
 * Gate count of a multi-unit package — the highest unit number anywhere in the
 * chain, 1 at minimum. There is no unit-count field in the format; the count is
 * implied by which unit sub-symbols exist.
 */
export function libSymbolUnitCount(chain: KicadLibSymbol[]): number {
  let max = 1
  for (const definition of chain) {
    for (const variant of definition.variants) max = Math.max(max, variant.unit)
  }
  return max
}

export function libSymbolUnitPins(chain: KicadLibSymbol[], unit = 1, bodyStyle = 1): SymbolPin[] {
  const pins: SymbolPin[] = []
  for (const definition of [...chain].reverse()) {
    pins.push(...definition.pins)
    for (const variant of definition.variants) {
      if (
        (variant.unit === 0 || variant.unit === unit) &&
        (variant.style === 0 || variant.style === bodyStyle)
      ) {
        pins.push(...variant.pins)
      }
    }
  }
  return pins
}

/**
 * Rotate a point about the origin. Trig on integer nanometers produces
 * fractions, so the result is deliberately unbranded — callers round with
 * `nm()` before anything re-enters the domain or a writer.
 */
const rotateBy = (
  point: { x: number; y: number },
  angleDegrees: number
): { x: number; y: number } => {
  const angle = (angleDegrees * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos }
}

export interface SymbolPlacementInstance {
  project: string
  /** Hierarchical sheet path (`/<root-uuid>/...`) this placement keys into. */
  path: string
}

/**
 * Append a placed symbol instance. Properties are copied from the lib
 * definition (skipping lib-only `ki_*` keys, keeping hide flags) and
 * repositioned from symbol-relative lib space to absolute sheet space; the
 * Reference property gets the annotated reference. The caller is responsible
 * for `ensureLibSymbolsInAST` so the definition exists in this file.
 */
export function addSchematicSymbolToAST(
  schematic: KicadSchematic,
  libSymbol: KicadLibSymbol,
  /** Origin, turn and flip, as `SymbolPose` reads them: the body turned, then mirrored. */
  position: Point & { angle?: number; mirror?: 'x' | 'y' },
  reference: string,
  pins: SymbolPin[],
  instances: SymbolPlacementInstance[],
  /** Which gate of a multi-unit package this placement is (U1A = 1, U1B = 2). */
  unit = 1,
  /** Which body style to draw — 1 standard, 2 the De Morgan alternate. */
  bodyStyle = 1,
  /**
   * Property values to write onto this placement, by KiCad field key —
   * `Value`, `MPN`, `Manufacturer`, and so on.
   *
   * Applied **here**, while the node is being built, rather than by the caller
   * afterwards. The reason is a trap worth naming: this function inserts into
   * the S-expression tree and does **not** touch `schematic.symbols`, which is
   * re-derived on the next serialize→reparse. So a caller reaching for
   * `symbols[symbols.length - 1]` to set fields on "the one just placed" gets
   * the *previous* symbol, and writes the new part's identity onto it.
   */
  fields: Record<string, string> = {}
): void {
  const at = schematic._root.start
  const angle = position.angle ?? 0
  const children: SExprNode[] = [
    bare('symbol', at),
    makeList([bare('lib_id', at), quoted(libSymbol.name, at)], at),
    atNode({ x: position.x, y: position.y, angle }, at),
    ...(position.mirror ? [makeList([bare('mirror', at), bare(position.mirror, at)], at)] : []),
    makeList([bare('unit', at), num(unit, at)], at),
    // Only when it is not the default. `body_style` is KiCad 10's spelling, so
    // emitting it on every placement would put a token KiCad 9 cannot read into
    // files that do not otherwise need one.
    ...(bodyStyle === 1 ? [] : [makeList([bare('body_style', at), num(bodyStyle, at)], at)]),
    makeList([bare('exclude_from_sim', at), bare('no', at)], at),
    makeList([bare('in_bom', at), bare('yes', at)], at),
    makeList([bare('on_board', at), bare('yes', at)], at),
    makeList([bare('dnp', at), bare('no', at)], at),
    uuidNode(at)
  ]

  const pendingFields = new Map(Object.entries(fields))
  for (const propertyNode of findChildren(libSymbol._node, 'property')) {
    // A private field belongs to the library symbol: KiCad never puts it on a placement.
    if (isPrivateProperty(propertyNode)) continue
    const key = propertyKeyOf(propertyNode)
    const libValue = atomAt(propertyNode, propertyNameIndex(propertyNode) + 1)
    if (key.startsWith('ki_')) continue
    // An override wins over the library's own value, the same way the annotated
    // reference already does.
    const override = pendingFields.get(key)
    if (override !== undefined) pendingFields.delete(key)
    const value = key === 'Reference' ? reference : (override ?? libValue)
    // Lib property offsets are y-up around the symbol origin; sheet
    // positions are absolute y-down (mirrors transformLocal in the scene).
    const offset = rotateBy(pointFrom(propertyNode, 'at'), angle)
    const libAt = getXY(propertyNode, 'at')
    const turned = { x: nm(position.x + offset.x), y: nm(position.y - offset.y) }
    // A flip carries the field with the body, as a mirror of a placed one does.
    const placed = position.mirror
      ? fieldPointThroughPose(
          turned,
          { position: { x: position.x, y: position.y, angle } },
          { position: { x: position.x, y: position.y, angle }, mirror: position.mirror }
        )
      : turned
    const propertyChildren: SExprNode[] = [
      bare('property', at),
      quoted(key, at),
      quoted(value, at),
      atNode({ ...placed, angle: libAt?.angle ?? 0 }, at)
    ]
    // The rest of the property, in KiCad's order and before the effects block.
    for (const token of ['show_name', 'do_not_autoplace', 'hide'] as const) {
      const child = findChild(propertyNode, token)
      if (child) propertyChildren.push(cloneSExprNode(child))
    }
    const effects = findChild(propertyNode, 'effects')
    propertyChildren.push(effects ? cloneSExprNode(effects) : fontEffectsNode(at))
    children.push(makeList(propertyChildren, at))
  }

  // Fields the library definition does not carry — MPN and Manufacturer on a
  // symbol that has no such property — are appended as hidden fields, still
  // inside the property block KiCad expects before the pins.
  for (const [key, value] of pendingFields) {
    children.push(
      makeList(
        [
          bare('property', at),
          quoted(key, at),
          quoted(value, at),
          atNode({ x: position.x, y: position.y, angle: 0 }, at),
          hideYesNode(at),
          fontEffectsNode(at)
        ],
        at
      )
    )
  }

  for (const pin of pins) {
    children.push(makeList([bare('pin', at), quoted(pin.number, at), uuidNode(at)], at))
  }

  if (instances.length) {
    // Group paths under their project node, KiCad-style.
    const byProject = new Map<string, string[]>()
    for (const instance of instances) {
      const paths = byProject.get(instance.project)
      if (paths) paths.push(instance.path)
      else byProject.set(instance.project, [instance.path])
    }
    const projectNodes: SExprNode[] = [bare('instances', at)]
    for (const [project, paths] of byProject) {
      projectNodes.push(
        makeList(
          [
            bare('project', at),
            quoted(project, at),
            ...paths.map((path) =>
              makeList(
                [
                  bare('path', at),
                  quoted(path, at),
                  makeList([bare('reference', at), quoted(reference, at)], at),
                  makeList([bare('unit', at), num(unit, at)], at)
                ],
                at
              )
            )
          ],
          at
        )
      )
    }
    children.push(makeList(projectNodes, at))
  }

  insertTopLevelNode(schematic, makeList(children, at))
}

/** One instantiation of a child sheet: the parent path it hangs under + its page. */
export interface SheetPlacementInstance {
  project: string
  /** Parent sheet's hierarchical path this child is instantiated under. */
  path: string
  /** Page label KiCad shows for this instance (it re-annotates on open). */
  page: string
}

/**
 * Append a `(sheet)` node referencing a child `.kicad_sch`. The
 * child *file* is written separately and is not part of this AST edit — undo
 * removes the sheet node and leaves the orphaned file on disk, the honest
 * boundary of docs/projects.md §8.5. `sheetFile` is stored
 * as written (a basename when the child sits beside the parent), matching how
 * hierarchy.ts resolves it.
 */
export function addSchematicSheetToAST(
  schematic: KicadSchematic,
  options: {
    position: Point
    size: { width: Nm; height: Nm }
    sheetName: string
    sheetFile: string
    instances?: SheetPlacementInstance[]
    /** Boundary signals, placed down each edge in order. Written here rather
     *  than by the caller because `schematic.sheets` does not hold the new
     *  sheet until the document is re-parsed, so there is nothing to add them
     *  to afterwards. */
    pins?: Array<{ name: string; shape: SheetPinShape; side: SheetSide }>
  }
): void {
  const at = schematic._root.start
  const { position, size, sheetName, sheetFile, instances } = options

  const sheetProperty = (key: string, value: string, y: Nm, justify: string[]): SExprList =>
    makeList(
      [
        bare('property', at),
        quoted(key, at),
        quoted(value, at),
        atNode({ x: position.x, y, angle: 0 }, at),
        fontEffectsNode(at, justify)
      ],
      at
    )

  const children: SExprNode[] = [
    bare('sheet', at),
    makeList([bare('at', at), numNm(position.x, at), numNm(position.y, at)], at),
    makeList([bare('size', at), numNm(size.width, at), numNm(size.height, at)], at),
    makeList(
      [
        bare('stroke', at),
        makeList([bare('width', at), numNm(nm(6 * NM_PER_MIL), at)], at),
        makeList([bare('type', at), bare('solid', at)], at)
      ],
      at
    ),
    makeList(
      [
        bare('fill', at),
        makeList([bare('color', at), num(0, at), num(0, at), num(0, at), num(0, at)], at)
      ],
      at
    ),
    uuidNode(at),
    // Sheetname sits above the box, Sheetfile below — KiCad's default field layout.
    sheetProperty('Sheetname', sheetName, nm(position.y - SHEET_LABEL_OFFSET_NM), [
      'left',
      'bottom'
    ]),
    sheetProperty('Sheetfile', sheetFile, nm(position.y + size.height + SHEET_LABEL_OFFSET_NM), [
      'left',
      'top'
    ])
  ]

  if (instances?.length) {
    const byProject = new Map<string, SheetPlacementInstance[]>()
    for (const instance of instances) {
      const group = byProject.get(instance.project)
      if (group) group.push(instance)
      else byProject.set(instance.project, [instance])
    }
    const projectNodes: SExprNode[] = [bare('instances', at)]
    for (const [project, group] of byProject) {
      projectNodes.push(
        makeList(
          [
            bare('project', at),
            quoted(project, at),
            ...group.map((instance) =>
              makeList(
                [
                  bare('path', at),
                  quoted(instance.path, at),
                  makeList([bare('page', at), quoted(instance.page, at)], at)
                ],
                at
              )
            )
          ],
          at
        )
      )
    }
    children.push(makeList(projectNodes, at))
  }

  const node = makeList(children, at)
  const box: SheetBox = { position, size }
  const used: Record<SheetSide, number> = { left: 0, right: 0, top: 0, bottom: 0 }
  for (const pin of options.pins ?? []) {
    used[pin.side] += 1
    const angle = SHEET_PIN_ANGLE[pin.side]
    node.children.push(
      makeList(
        [
          bare('pin', at),
          quoted(pin.name, at),
          bare(pin.shape, at),
          atNode({ ...sheetPinSlot(box, pin.side, used[pin.side]), angle }, at),
          fontEffectsNode(at, [sheetPinJustify(angle)]),
          uuidNode(at)
        ],
        at
      )
    )
  }
  insertTopLevelNode(schematic, node)
}

/** Value of a lib symbol's own property node (Reference, Value, Description…). */
export function getLibSymbolProperty(libSymbol: KicadLibSymbol, key: string): string | undefined {
  for (const propertyNode of findChildren(libSymbol._node, 'property')) {
    const atoms = getAtomValues(propertyNode)
    if (atoms[0] === key) return atoms[1]
  }
  return undefined
}

/** Append a free text annotation. Newlines in `text` are lines, as KiCad
 *  reads them; `size` is the glyph height (1.27 mm when omitted). */
export function addSchematicTextToAST(
  schematic: KicadSchematic,
  text: string,
  position: Point & { angle?: number },
  font: { size?: Nm; bold?: boolean } = {}
): void {
  const at = schematic._root.start
  insertTopLevelNode(
    schematic,
    makeList(
      [
        bare('text', at),
        quoted(text, at),
        atNode(position, at),
        fontEffectsNode(at, ['left', 'bottom'], font),
        uuidNode(at)
      ],
      at
    )
  )
}

/** Append a block outline: a sheet-level rectangle that draws and connects
 *  nothing. Written the way KiCad 7+ writes one, so it loads there. */
export function addSchematicRectangleToAST(
  schematic: KicadSchematic,
  start: Point,
  end: Point,
  strokeWidth: Nm = ZERO
): void {
  const at = schematic._root.start
  insertTopLevelNode(
    schematic,
    makeList(
      [
        bare('rectangle', at),
        makeList([bare('start', at), numNm(start.x, at), numNm(start.y, at)], at),
        makeList([bare('end', at), numNm(end.x, at), numNm(end.y, at)], at),
        makeList(
          [
            bare('stroke', at),
            makeList([bare('width', at), numNm(strokeWidth, at)], at),
            makeList([bare('type', at), bare('default', at)], at)
          ],
          at
        ),
        makeList([bare('fill', at), makeList([bare('type', at), bare('none', at)], at)], at),
        uuidNode(at)
      ],
      at
    )
  )
}

/** `(stroke (width 0) (type default))`: KiCad's default pen, as its drawing tools write it. */
const defaultStrokeNode = (at: number): SExprList =>
  makeList(
    [
      bare('stroke', at),
      makeList([bare('width', at), numNm(ZERO, at)], at),
      makeList([bare('type', at), bare('default', at)], at)
    ],
    at
  )

const noFillNode = (at: number): SExprList =>
  makeList([bare('fill', at), makeList([bare('type', at), bare('none', at)], at)], at)

const xyNode = (token: string, point: Point, at: number): SExprList =>
  makeList([bare(token, at), numNm(point.x, at), numNm(point.y, at)], at)

/**
 * Append a graphic line along `points`, one `(polyline …)` of two points per
 * segment — what KiCad's Draw Lines tool writes (`saveLine`, a notes-layer
 * `SCH_LINE`), so each segment selects and drags on its own there too.
 */
export function addSchematicPolylineToAST(schematic: KicadSchematic, points: Point[]): void {
  const at = schematic._root.start
  for (let index = 1; index < points.length; index += 1) {
    const pts = makeList(
      [bare('pts', at), xyNode('xy', points[index - 1], at), xyNode('xy', points[index], at)],
      at
    )
    insertTopLevelNode(
      schematic,
      makeList([bare('polyline', at), pts, defaultStrokeNode(at), uuidNode(at)], at)
    )
  }
}

/** Append a bus along `points`, one `(bus …)` per segment, as wires are written. */
export function addSchematicBusToAST(schematic: KicadSchematic, points: Point[]): void {
  const at = schematic._root.start
  for (let index = 1; index < points.length; index += 1) {
    const pts = makeList(
      [bare('pts', at), xyNode('xy', points[index - 1], at), xyNode('xy', points[index], at)],
      at
    )
    insertTopLevelNode(
      schematic,
      makeList([bare('bus', at), pts, defaultStrokeNode(at), uuidNode(at)], at)
    )
  }
}

/** Append a wire-to-bus entry: `(at)` is one end, `(size)` the offset to the other. */
export function addSchematicBusEntryToAST(
  schematic: KicadSchematic,
  position: Point,
  size: { width: Nm; height: Nm }
): void {
  const at = schematic._root.start
  insertTopLevelNode(
    schematic,
    makeList(
      [
        bare('bus_entry', at),
        makeList([bare('at', at), numNm(position.x, at), numNm(position.y, at)], at),
        makeList([bare('size', at), numNm(size.width, at), numNm(size.height, at)], at),
        defaultStrokeNode(at),
        uuidNode(at)
      ],
      at
    )
  )
}

/** Append an unfilled circle, as KiCad's Draw Circles tool writes one. */
export function addSchematicCircleToAST(
  schematic: KicadSchematic,
  center: Point,
  radius: Nm
): void {
  const at = schematic._root.start
  insertTopLevelNode(
    schematic,
    makeList(
      [
        bare('circle', at),
        xyNode('center', center, at),
        makeList([bare('radius', at), numNm(radius, at)], at),
        defaultStrokeNode(at),
        noFillNode(at),
        uuidNode(at)
      ],
      at
    )
  )
}

/** Append an unfilled arc through `mid`, as KiCad's Draw Arcs tool writes one. */
export function addSchematicArcToAST(
  schematic: KicadSchematic,
  arc: { start: Point; mid: Point; end: Point }
): void {
  const at = schematic._root.start
  insertTopLevelNode(
    schematic,
    makeList(
      [
        bare('arc', at),
        xyNode('start', arc.start, at),
        xyNode('mid', arc.mid, at),
        xyNode('end', arc.end, at),
        defaultStrokeNode(at),
        noFillNode(at),
        uuidNode(at)
      ],
      at
    )
  )
}

/** Append an unfilled cubic bezier — start, two control points, end — as
 *  KiCad's Draw Bezier tool writes one (`formatBezier`). */
export function addSchematicBezierToAST(
  schematic: KicadSchematic,
  points: [Point, Point, Point, Point]
): void {
  const at = schematic._root.start
  const pts = makeList([bare('pts', at), ...points.map((point) => xyNode('xy', point, at))], at)
  insertTopLevelNode(
    schematic,
    makeList([bare('bezier', at), pts, defaultStrokeNode(at), noFillNode(at), uuidNode(at)], at)
  )
}

/**
 * Append a rule area over the closed outline `points`, as KiCad's Draw Rule
 * Area tool writes one (`RULE_AREA_CREATE_HELPER`, `saveRuleArea`): the four
 * flags at their defaults and a dashed, unfilled polyline carrying the uuid.
 */
export function addSchematicRuleAreaToAST(schematic: KicadSchematic, points: Point[]): void {
  const at = schematic._root.start
  const flag = (token: string, on: boolean): SExprList =>
    makeList([bare(token, at), bare(on ? 'yes' : 'no', at)], at)
  const pts = makeList([bare('pts', at), ...points.map((point) => xyNode('xy', point, at))], at)
  const stroke = makeList(
    [
      bare('stroke', at),
      makeList([bare('width', at), numNm(ZERO, at)], at),
      makeList([bare('type', at), bare('dash', at)], at)
    ],
    at
  )
  insertTopLevelNode(
    schematic,
    makeList(
      [
        bare('rule_area', at),
        flag('exclude_from_sim', false),
        flag('in_bom', true),
        flag('on_board', true),
        flag('dnp', false),
        makeList([bare('polyline', at), pts, stroke, noFillNode(at), uuidNode(at)], at)
      ],
      at
    )
  )
}

/**
 * Append an empty table whose top-left corner is `origin`, as KiCad's Draw
 * Table tool writes one (`saveTable`): every border and separator on in the
 * default pen, then one empty cell per row and column, each a borderless text
 * box at its own corner with the legacy margins.
 */
export function addSchematicTableToAST(
  schematic: KicadSchematic,
  origin: Point,
  columnWidths: Nm[],
  rowHeights: Nm[]
): void {
  const at = schematic._root.start
  const flag = (token: string): SExprList => makeList([bare(token, at), bare('yes', at)], at)
  const margin = nm(DEFAULT_FONT_SIZE_NM * 0.75)
  const cells: SExprList[] = []
  let y = origin.y
  for (const height of rowHeights) {
    let x = origin.x
    for (const width of columnWidths) {
      cells.push(
        makeList(
          [
            bare('table_cell', at),
            quoted('', at),
            makeList([bare('exclude_from_sim', at), bare('no', at)], at),
            atNode({ x, y, angle: 0 }, at),
            makeList([bare('size', at), numNm(width, at), numNm(height, at)], at),
            makeList([bare('margins', at), ...[0, 1, 2, 3].map(() => numNm(margin, at))], at),
            makeList([bare('span', at), num(1, at), num(1, at)], at),
            noFillNode(at),
            fontEffectsNode(at, ['left', 'top']),
            uuidNode(at)
          ],
          at
        )
      )
      x = nm(x + width)
    }
    y = nm(y + height)
  }
  insertTopLevelNode(
    schematic,
    makeList(
      [
        bare('table', at),
        makeList([bare('column_count', at), num(columnWidths.length, at)], at),
        makeList([bare('border', at), flag('external'), flag('header'), defaultStrokeNode(at)], at),
        makeList([bare('separators', at), flag('rows'), flag('cols'), defaultStrokeNode(at)], at),
        makeList([bare('column_widths', at), ...columnWidths.map((w) => numNm(w, at))], at),
        makeList([bare('row_heights', at), ...rowHeights.map((h) => numNm(h, at))], at),
        uuidNode(at),
        makeList([bare('cells', at), ...cells], at)
      ],
      at
    )
  )
}

/** Base64 per `(data …)` atom: KiCad's `FormatStreamData` wraps at 76 characters. */
const IMAGE_DATA_CHUNK = 76

/**
 * Append a bitmap centered on `position`, as KiCad's Place Image writes one
 * (`saveBitmap`): scale 1 left unwritten, the PNG as base64 in 76-character
 * atoms.
 */
export function addSchematicImageToAST(
  schematic: KicadSchematic,
  position: Point,
  pngBase64: string
): void {
  const at = schematic._root.start
  const chunks: SExprAtom[] = []
  for (let index = 0; index < pngBase64.length; index += IMAGE_DATA_CHUNK) {
    chunks.push(quoted(pngBase64.slice(index, index + IMAGE_DATA_CHUNK), at))
  }
  insertTopLevelNode(
    schematic,
    makeList(
      [
        bare('image', at),
        makeList([bare('at', at), numNm(position.x, at), numNm(position.y, at)], at),
        uuidNode(at),
        makeList([bare('data', at), ...chunks], at)
      ],
      at
    )
  )
}

/**
 * Append a text box with KiCad's defaults for a new one: left/top text, no
 * fill, the default pen, and margins of `GetLegacyTextMargin` — three quarters
 * of the 1.27 mm text height, which KiCad writes explicitly.
 */
export function addSchematicTextBoxToAST(
  schematic: KicadSchematic,
  text: string,
  position: Point,
  size: { width: Nm; height: Nm }
): void {
  const at = schematic._root.start
  const margin = nm(DEFAULT_FONT_SIZE_NM * 0.75)
  const margins = makeList([bare('margins', at), ...[0, 1, 2, 3].map(() => numNm(margin, at))], at)
  insertTopLevelNode(
    schematic,
    makeList(
      [
        bare('text_box', at),
        quoted(text, at),
        makeList([bare('exclude_from_sim', at), bare('no', at)], at),
        atNode(position, at),
        makeList([bare('size', at), numNm(size.width, at), numNm(size.height, at)], at),
        margins,
        defaultStrokeNode(at),
        noFillNode(at),
        fontEffectsNode(at, ['left', 'top']),
        uuidNode(at)
      ],
      at
    )
  )
}

/**
 * Append a directive label (`netclass_flag`) carrying a Netclass field, as
 * KiCad's Place Directive Labels tool writes one: the flag on its 100 mil
 * pole, and the field autoplaced beside the flag (`AutoplaceFields`, spin
 * right: the symbol's 20 mil width plus the 0.15 text offset across, the pole
 * up), italic and left-justified. An empty class writes no field.
 */
export function addSchematicDirectiveLabelToAST(
  schematic: KicadSchematic,
  position: Point,
  shape: DirectiveLabelShape,
  netclass: string
): void {
  const at = schematic._root.start
  const length = DEFAULT_DIRECTIVE_LENGTH_NM
  const children: SExprNode[] = [
    bare('netclass_flag', at),
    quoted('', at),
    makeList([bare('length', at), numNm(length, at)], at),
    makeList([bare('shape', at), bare(shape, at)], at),
    atNode({ ...position, angle: 0 }, at),
    fontEffectsNode(at, ['left', 'bottom']),
    uuidNode(at)
  ]
  if (netclass) children.push(directiveNetclassNode(position, length, netclass, at))
  insertTopLevelNode(schematic, makeList(children, at))
}

/** A directive label's Netclass field, autoplaced beside an upright flag on its pole. */
const directiveNetclassNode = (
  position: Point,
  length: Nm,
  netclass: string,
  at: number
): SExprList => {
  const across = nm(20 * NM_PER_MIL + Math.round(DEFAULT_FONT_SIZE_NM * 0.15))
  const field = { x: nm(position.x + across), y: nm(position.y - length), angle: 0 }
  const effects = fontEffectsNode(at, ['left'])
  const font = findChild(effects, 'font')
  font?.children.push(makeList([bare('italic', at), bare('yes', at)], at))
  return makeList(
    [
      bare('property', at),
      quoted('Netclass', at),
      quoted(netclass, at),
      atNode(field, at),
      makeList([bare('show_name', at), bare('no', at)], at),
      makeList([bare('do_not_autoplace', at), bare('no', at)], at),
      effects
    ],
    at
  )
}

/**
 * Set a directive label's net class: its Netclass field's value, or a new
 * field placed as the Place Directive Labels tool places one when it has none.
 */
export function setSchematicDirectiveLabelNetclass(
  label: KicadDirectiveLabel,
  netclass: string
): void {
  const property = label.properties.find((candidate) => candidate.key === 'Netclass')
  if (property) {
    setSchematicPropertyValue(property, netclass)
    return
  }
  const node = directiveNetclassNode(label.position, label.length, netclass, label._node.start)
  const uuid = findChild(label._node, 'uuid')
  const index = uuid ? label._node.children.indexOf(uuid) + 1 : label._node.children.length
  label._node.children.splice(index, 0, node)
  label.properties.push(parseProperty(node))
}

/** Set one table cell's text, its first positional atom. */
export function setSchematicTableCellText(cell: KicadTableCell, text: string): void {
  setPositionalAtom(cell._node, 1, text, true)
  cell.text = text
}

/** Move a sheet-level rectangle by a delta, rewriting both corners. */
export function moveSchematicShapeInAST(shape: KicadSchematicShape, delta: Point): void {
  shape.start = { x: nm(shape.start.x + delta.x), y: nm(shape.start.y + delta.y) }
  shape.end = { x: nm(shape.end.x + delta.x), y: nm(shape.end.y + delta.y) }
  for (const [token, point] of [
    ['start', shape.start],
    ['end', shape.end]
  ] as const) {
    const node = findChild(shape._node, token)
    if (!node) continue
    node.children = [
      makeAtom(token, false, node.start),
      makeAtom(formatNmAtom(point.x), false, node.start),
      makeAtom(formatNmAtom(point.y), false, node.start)
    ]
  }
}

// ---------------------------------------------------------------------------
// Placing sheet graphics, text boxes, buses and the rest. Each writer takes
// the item's NEW geometry and rewrites only the atoms that changed, so a move
// diffs to exactly the coordinates that moved (RULES.md §7).
// ---------------------------------------------------------------------------

const samePoint = (a: Point | undefined, b: Point): boolean => !!a && a.x === b.x && a.y === b.y

/** Rewrite a `(token x y)` node's atoms, unless it already holds `point`. */
const setXYNode = (node: SExprList | null, point: Point, before?: Point): void => {
  if (!node || samePoint(before, point)) return
  node.children = [
    makeAtom(getToken(node) ?? '', false, node.start),
    makeAtom(formatNmAtom(point.x), false, node.start),
    makeAtom(formatNmAtom(point.y), false, node.start)
  ]
}

/**
 * Rewrite the `(pts …)` of `owner`. The same number of points rewrites each
 * `xy` in place, leaving the unmoved ones byte-identical; a different number
 * rebuilds the run.
 */
const setPtsInAST = (owner: SExprList, points: Point[], before: Point[]): void => {
  const pts = findChild(owner, 'pts')
  if (!pts) return
  const xys = findChildren(pts, 'xy')
  if (xys.length === points.length) {
    xys.forEach((xy, index) => setXYNode(xy, points[index], before[index]))
    return
  }
  const at = pts.start
  pts.children = [
    makeAtom('pts', false, at),
    ...points.map((point) => makeList([bare('xy', at), numNm(point.x, at), numNm(point.y, at)], at))
  ]
}

/** An `(at x y [angle])` rewritten only when the point or angle moved. */
const setAtInAST = (
  node: SExprList,
  position: Point & { angle?: number },
  before: Point & { angle?: number }
): void => {
  if (samePoint(before, position) && (position.angle ?? 0) === (before.angle ?? 0)) return
  updateAt(node, position.x, position.y, position.angle)
}

/**
 * Give a free sheet graphic — polyline, bezier, circle, arc or text box — new
 * geometry of the same type. A circle's radius and a text box's size are
 * written only when they change, which a move and a turn never do to a radius.
 */
export function setSchematicGraphicInAST<G extends SymbolGraphic>(
  item: KicadSchematicGraphic<G>,
  graphic: G
): void {
  const node = item._node
  const before: SymbolGraphic = item.graphic
  if ((graphic.type === 'line' || graphic.type === 'bezier') && 'points' in before) {
    setPtsInAST(node, graphic.points, before.points)
  } else if (graphic.type === 'circle' && before.type === 'circle') {
    setXYNode(findChild(node, 'center'), graphic.center, before.center)
    if (graphic.radius !== before.radius)
      setScalarChild(node, 'radius', formatNmAtom(graphic.radius))
  } else if (graphic.type === 'arc' && before.type === 'arc') {
    setXYNode(findChild(node, 'start'), graphic.start, before.start)
    setXYNode(findChild(node, 'mid'), graphic.mid, before.mid)
    setXYNode(findChild(node, 'end'), graphic.end, before.end)
  } else if (graphic.type === 'rectangle' && before.type === 'rectangle') {
    setXYNode(findChild(node, 'start'), graphic.start, before.start)
    setXYNode(findChild(node, 'end'), graphic.end, before.end)
  } else if (graphic.type === 'textBox' && before.type === 'textBox') {
    setAtInAST(node, graphic.position, before.position)
    if (graphic.size.width !== before.size.width || graphic.size.height !== before.size.height) {
      updateSize(node, graphic.size.width, graphic.size.height)
    }
  }
  item.graphic = graphic
}

/** Put a sheet-level rectangle's corners where they now belong. */
export function setSchematicShapeCornersInAST(
  shape: KicadSchematicShape,
  start: Point,
  end: Point
): void {
  setXYNode(findChild(shape._node, 'start'), start, shape.start)
  setXYNode(findChild(shape._node, 'end'), end, shape.end)
  shape.start = start
  shape.end = end
}

/** A rule area's outline, the `(polyline (pts …))` nested in it. */
export function setSchematicRuleAreaInAST(area: KicadRuleArea, points: Point[]): void {
  const polyline = findChild(area._node, 'polyline')
  if (polyline) setPtsInAST(polyline, points, area.graphic.points)
  area.graphic = { ...area.graphic, points }
}

/** A bus's points; the same run a wire has, written the same way. */
export function setSchematicBusPointsInAST(bus: KicadWire, points: Point[]): void {
  setPtsInAST(bus._node, points, bus.points)
  bus.points = points
}

/** A bus entry's stub: `(at …)` stays angle-less, `(size …)` only when it turned. */
export function setSchematicBusEntryInAST(
  entry: KicadBusEntry,
  position: Point,
  size: { width: Nm; height: Nm }
): void {
  setAtInAST(entry._node, position, entry.position)
  if (size.width !== entry.size.width || size.height !== entry.size.height)
    updateSize(entry._node, size.width, size.height)
  entry.position = position
  entry.size = size
}

export function setSchematicImagePositionInAST(image: KicadSchematicImage, position: Point): void {
  setAtInAST(image._node, position, image.position)
  image.position = position
}

/** Each cell's `(at …)`, in cell order — a table has no position of its own. */
export function setSchematicTableCellsInAST(table: KicadSchematicTable, positions: Point[]): void {
  table.cells.forEach((cell, index) => {
    const position = positions[index]
    if (!position) return
    const next = { ...position, angle: cell.position.angle }
    setAtInAST(cell._node, next, cell.position)
    cell.position = next
  })
}

/**
 * Place a directive label and its fields, which KiCad stores in absolute sheet
 * space as it does a symbol's. `fields` runs in property order; a missing
 * entry leaves that field where it is.
 */
export function setSchematicDirectiveLabelInAST(
  label: KicadDirectiveLabel,
  position: Point & { angle: number },
  fields: Array<Point & { angle: number }>
): void {
  setAtInAST(label._node, position, label.position)
  label.position = position
  label.properties.forEach((property, index) => {
    const next = fields[index]
    if (!next) return
    setAtInAST(property._node, next, property.position)
    property.position = next
  })
}

/** Set a directive label's flag shape. */
export function setSchematicDirectiveLabelShape(
  label: KicadDirectiveLabel,
  shape: DirectiveLabelShape
): void {
  label.shape = shape
  setScalarChild(label._node, 'shape', shape)
}

/** Set a directive label's pin length, `(length …)`. */
export function setSchematicDirectiveLabelLength(label: KicadDirectiveLabel, length: Nm): void {
  label.length = length
  setScalarChild(label._node, 'length', formatNmAtom(length))
}

/** Set a sheet box's border width, `(stroke (width …))`. */
export function setSchematicSheetStrokeWidth(sheet: KicadSheet, width: Nm): void {
  sheet.strokeWidth = width
  setScalarChild(findOrCreateChild(sheet._node, 'stroke'), 'width', formatNmAtom(width))
}

/** Move an image (its center, `(at …)`) or rescale it, `(scale …)`. */
export function updateSchematicImageInAST(
  image: KicadSchematicImage,
  data: { x?: Nm; y?: Nm; scale?: number }
): void {
  if (data.x !== undefined || data.y !== undefined) {
    image.position = { x: data.x ?? image.position.x, y: data.y ?? image.position.y }
    updateAt(image._node, image.position.x, image.position.y)
  }
  if (data.scale !== undefined && data.scale > 0) {
    image.scale = data.scale
    setScalarChild(image._node, 'scale', formatKicadNumber(data.scale))
  }
}

/** A table's border and separator switches and widths — KiCad's Table Properties. */
export interface SchematicTablePatch {
  borderExternal?: boolean
  borderHeader?: boolean
  borderWidth?: Nm
  separatorRows?: boolean
  separatorCols?: boolean
  separatorWidth?: Nm
}

/**
 * Write a table's border and separator settings. A missing `(border …)` or
 * `(separators …)` is created after `(column_count …)`, where KiCad writes
 * them (`SCH_IO_KICAD_SEXPR::saveTable`).
 */
export function updateSchematicTableInAST(
  table: KicadSchematicTable,
  data: SchematicTablePatch
): void {
  const section = (token: 'border' | 'separators'): SExprList => {
    const existing = findChild(table._node, token)
    if (existing) return existing
    const node = makeList([makeAtom(token, false, table._node.start)], table._node.start)
    const anchor = findChild(table._node, token === 'border' ? 'column_count' : 'border')
    const index = anchor ? table._node.children.indexOf(anchor) + 1 : table._node.children.length
    table._node.children.splice(index, 0, node)
    return node
  }
  const yesNo = (value: boolean): string => (value ? 'yes' : 'no')
  const strokeWidth = (node: SExprList, width: Nm): void =>
    setScalarChild(findOrCreateChild(node, 'stroke'), 'width', formatNmAtom(width))
  if (data.borderExternal !== undefined) {
    table.border.external = data.borderExternal
    setScalarChild(section('border'), 'external', yesNo(data.borderExternal))
  }
  if (data.borderHeader !== undefined) {
    table.border.header = data.borderHeader
    setScalarChild(section('border'), 'header', yesNo(data.borderHeader))
  }
  if (data.borderWidth !== undefined) {
    table.border.stroke = { ...table.border.stroke, width: data.borderWidth }
    strokeWidth(section('border'), data.borderWidth)
  }
  if (data.separatorRows !== undefined) {
    table.separators.rows = data.separatorRows
    setScalarChild(section('separators'), 'rows', yesNo(data.separatorRows))
  }
  if (data.separatorCols !== undefined) {
    table.separators.cols = data.separatorCols
    setScalarChild(section('separators'), 'cols', yesNo(data.separatorCols))
  }
  if (data.separatorWidth !== undefined) {
    table.separators.stroke = { ...table.separators.stroke, width: data.separatorWidth }
    strokeWidth(section('separators'), data.separatorWidth)
  }
}

/** Set a text box's text (its first positional atom). */
export function setSchematicTextBoxContent(
  box: KicadSchematic['textBoxes'][number],
  value: string
): void {
  setPositionalAtom(box._node, 1, value, true)
  box.graphic = { ...box.graphic, text: value }
}

/** Set one of a sheet's or a directive label's field values — its second atom. */
export function setSchematicPropertyValue(property: SchematicProperty, value: string): void {
  setPositionalAtom(property._node, propertyNameIndex(property._node) + 1, value, true)
  property.value = value
}

/**
 * Where a sheet pin dragged by `delta` lands: on the edge nearest the point it
 * was dragged to, at the nearest pin-pitch slot along it — KiCad keeps a pin
 * on its sheet's border, sliding round a corner onto the next edge.
 */
export function sheetPinLanding(
  sheet: SheetBox,
  pin: Pick<KicadSheetPin, 'position'>,
  delta: Point
): { position: Point; side: SheetSide } {
  const target = { x: nm(pin.position.x + delta.x), y: nm(pin.position.y + delta.y) }
  const side = sheetSideOf(sheet, target)
  return { position: sheetPinPoint(sheet, side, sheetPinOffset(sheet, side, target)), side }
}

const symbolChildIndex = (symbol: KicadSchematicSymbol, token: string): number =>
  symbol._node.children.findIndex((child) => child.type === 'list' && getToken(child) === token)

/**
 * Set a symbol property value, creating a hidden property node at the symbol
 * position when the key does not exist yet (e.g. a missing Datasheet).
 */
export function setSchematicSymbolProperty(
  symbol: KicadSchematicSymbol,
  key: string,
  value: string
): void {
  const existing = symbol.properties.find((property) => property.key === key)
  if (existing) {
    setPositionalAtom(existing._node, propertyNameIndex(existing._node) + 1, value, true)
    existing.value = value
    return
  }
  const at = symbol._node.start
  const node = makeList(
    [
      makeAtom('property', false, at),
      makeAtom(key, true, at),
      makeAtom(value, true, at),
      makeList(
        [
          makeAtom('at', false, at),
          makeAtom(formatNmAtom(symbol.position.x), false, at),
          makeAtom(formatNmAtom(symbol.position.y), false, at),
          makeAtom('0', false, at)
        ],
        at
      ),
      hideYesNode(at),
      fontEffectsNode(at)
    ],
    at
  )
  // KiCad writes properties as one block before the pins.
  const children = symbol._node.children
  let insertIndex = -1
  for (let index = 0; index < children.length; index++) {
    const child = children[index]
    if (child.type === 'list' && getToken(child) === 'property') insertIndex = index + 1
  }
  if (insertIndex < 0) {
    const pinIndex = symbolChildIndex(symbol, 'pin')
    insertIndex = pinIndex >= 0 ? pinIndex : children.length
  }
  children.splice(insertIndex, 0, node)
  symbol.properties.push(parseProperty(node))
}

export type SchematicSymbolFlag = 'dnp' | 'in_bom' | 'on_board' | 'exclude_from_sim'

/** Set a yes/no placement flag such as (dnp yes), creating the node in KiCad order. */
export function setSchematicSymbolFlag(
  symbol: KicadSchematicSymbol,
  flag: SchematicSymbolFlag,
  value: boolean
): void {
  const existing = findChild(symbol._node, flag)
  if (existing) {
    setNodeValue(existing, value ? 'yes' : 'no')
  } else {
    const at = symbol._node.start
    const node = makeList(
      [makeAtom(flag, false, at), makeAtom(value ? 'yes' : 'no', false, at)],
      at
    )
    // KiCad writes these flags between (unit ...) and (uuid ...).
    let index = symbolChildIndex(symbol, 'uuid')
    if (index < 0) index = symbolChildIndex(symbol, 'property')
    const children = symbol._node.children
    children.splice(index >= 0 ? index : children.length, 0, node)
  }
  if (flag === 'dnp') symbol.dnp = value
  else if (flag === 'in_bom') symbol.inBom = value
  else if (flag === 'on_board') symbol.onBoard = value
  else symbol.excludeFromSim = value
}

/**
 * Where one drawn part came from — its identity, and eventually its name.
 *
 * A placed symbol's drawing is assembled from up to three sources: an inherited
 * parent (`extends`), the symbol's own graphics, and the unit sub-symbols for
 * the unit on screen plus the common unit 0. Flattening those into one list is
 * what made it impossible to point at a single pin or body line — the only
 * thing addressable was the whole symbol, which is why the symbol editor draws
 * a moving copy instead of moving the real geometry, and why netlist sync has
 * no way to refer to a pin. See ARCHITECTURE.md §3.7.
 *
 * Built from WHAT A PART IS, never from the order it happened to be drawn in.
 * The renderer draws inherited body first, then the visible unit; the symbol
 * editor lists every unit in document order. Numbering by draw order would
 * force those two to coincide, and they do not for a multi-unit part. Derived
 * independently from `(source, unit, style, index)`, there is nothing to keep
 * in sync.
 */
export interface SymbolPartRef {
  /**
   * The `lib_id` the part is DEFINED on. Not necessarily the placed symbol's:
   * an inherited body belongs to the parent in the `extends` chain.
   */
  source: string
  /**
   * Position in the `extends` chain: 0 is the placed symbol's own definition,
   * 1 its parent, and so on.
   *
   * Carried alongside `source` because it is what makes a NAME collision-free.
   * `resolveSymbolGeometry` concatenates inherited parts with own parts, so
   * `(unit, style, index)` alone repeats across the chain — a derived symbol
   * defining its own `_0_1` collides with the parent's. `source` disambiguates
   * semantically but is a poor key component: a `lib_id` already contains the
   * `:` a key would separate on (`Device:Dual`). A small integer cannot.
   */
  depth: number
  /** 0 is the common body drawn with every unit. */
  unit: number
  /** 0 is the body common to every style; 1 is standard, 2 the De Morgan alternate. */
  style: number
  /** Position within that one `(source, unit, style)` group, in document order. */
  index: number
}

/**
 * The stable name of one part, relative to its symbol. Built from what the part
 * IS, so the renderer and an editor derive the same string independently with
 * nothing to keep in sync — the rule ARCHITECTURE.md §3.7 states as "a name must
 * never depend on drawing order".
 *
 * Opaque: nothing parses it back. `kind` distinguishes the two part lists,
 * which index separately.
 */
export function symbolPartKey(
  kind: 'pin' | 'graphic',
  part: Omit<SymbolPartRef, 'source'>
): string {
  return `${kind}:${part.depth}.${part.unit}.${part.style}.${part.index}`
}

/**
 * The stable name of one FIELD, relative to its symbol — `symbolPartKey` for
 * the part kind that is named rather than indexed. Beside its sibling because
 * two independent callers must spell it identically: the scene files a field's
 * paint under it, and `symbolPreviewPartKey` derives what the editor selects by.
 */
export const schematicFieldKey = (field: string): string => `field:${field}`

/**
 * What a field DRAWS: with `show_name` set KiCad prefixes the key
 * (`SCH_FIELD::GetShownText`). Shared with the hit-test, which measures the
 * glyph box of this exact string.
 */
export const shownFieldText = (property: SchematicProperty): string =>
  property.showName ? `${property.key}: ${property.value}` : property.value

/** A part paired with where it came from. */
export interface ResolvedGraphic {
  graphic: SymbolGraphic
  part: SymbolPartRef
}

export interface ResolvedPin {
  pin: SymbolPin
  part: SymbolPartRef
}

/** Resolve embedded symbol geometry, including common and selected unit variants. */
export interface ResolvedSymbolGeometry {
  graphics: ResolvedGraphic[]
  pins: ResolvedPin[]
  pinNameOffset: Nm
  pinNamesHidden: boolean
  pinNumbersHidden: boolean
}

/**
 * Marks a part defined directly on the symbol node rather than inside a unit
 * sub-symbol. `parseVariantSuffix` reads `\d+`, so a real variant's unit and
 * style are never negative and this cannot collide with one — including with
 * the `{unit: 0, style: 0}` fallback an unparseable sub-symbol name gets.
 */
const OWN_PART = { unit: -1, style: -1 } as const

/** The `lib_symbols` entry a placement is drawn from: its `lib_name` when it carries one, else its `lib_id`. */
export const definitionIdOf = (placed: Pick<KicadSchematicSymbol, 'libId' | 'libName'>): string =>
  placed.libName ?? placed.libId

export function resolveSymbolGeometry(
  schematic: KicadSchematic,
  placed: KicadSchematicSymbol
): ResolvedSymbolGeometry {
  const visited = new Set<string>()
  const empty = (): ResolvedSymbolGeometry => ({
    graphics: [],
    pins: [],
    pinNameOffset: DEFAULT_PIN_NAME_OFFSET_NM,
    pinNamesHidden: false,
    pinNumbersHidden: false
  })
  const resolve = (id: string, depth: number): ResolvedSymbolGeometry => {
    if (visited.has(id)) return empty()
    visited.add(id)
    const definition = schematic.libSymbols.get(id)
    if (!definition) return empty()
    const parent = definition.extends ? resolve(definition.extends, depth + 1) : empty()
    const variants = definition.variants.filter(
      (variant) =>
        (variant.unit === 0 || variant.unit === placed.unit) &&
        (variant.style === 0 || variant.style === placed.bodyStyle)
    )
    // Each group indexes from 0 within itself, so a part's ref describes where
    // it lives rather than when it was appended. Parent parts keep the refs
    // they were given — they belong to the parent's id, not this one.
    const own = { ...OWN_PART, source: id, depth }
    const from = <T>(items: T[], part: Omit<SymbolPartRef, 'index'>): Array<[T, SymbolPartRef]> =>
      items.map((item, index) => [item, { ...part, index }])
    return {
      graphics: [
        ...parent.graphics,
        ...from(definition.graphics, own).map(([graphic, part]) => ({ graphic, part })),
        ...variants.flatMap((variant) =>
          from(variant.graphics, {
            source: id,
            depth,
            unit: variant.unit,
            style: variant.style
          }).map(([graphic, part]) => ({ graphic, part }))
        )
      ],
      pins: [
        ...parent.pins,
        ...from(definition.pins, own).map(([pin, part]) => ({ pin, part })),
        ...variants.flatMap((variant) =>
          from(variant.pins, { source: id, depth, unit: variant.unit, style: variant.style }).map(
            ([pin, part]) => ({ pin, part })
          )
        )
      ],
      pinNameOffset: definition.pinNameOffset,
      pinNamesHidden: definition.pinNamesHidden,
      pinNumbersHidden: definition.pinNumbersHidden
    }
  }
  return resolve(definitionIdOf(placed), 0)
}

export const getSymbolProperty = (symbol: KicadSchematicSymbol, key: string): string | undefined =>
  symbol.properties.find((property) => property.key === key)?.value

/** Value of a sheet property (Sheetname / Sheetfile). */
/** KiCad 6's names for a sheet's two own fields, which KiCad still reads. */
const LEGACY_SHEET_FIELDS: Record<string, string> = {
  'sheet name': 'sheetname',
  'sheet file': 'sheetfile'
}

/** A field's name as KiCad matches it (`parseSchField`): case-insensitive, legacy names aliased. */
export const canonicalSheetFieldName = (name: string): string =>
  LEGACY_SHEET_FIELDS[name.toLowerCase()] ?? name.toLowerCase()

export const getSheetProperty = (sheet: KicadSheet, key: string): string | undefined => {
  const wanted = canonicalSheetFieldName(key)
  return sheet.properties.find((property) => canonicalSheetFieldName(property.key) === wanted)
    ?.value
}

/**
 * Each symbol's pin ids by number, read once per node: the checks ask for
 * every pin of every symbol, and a scan per ask is quadratic in a symbol's
 * pins (a 900-pin module). Read again when the node's children change, as an
 * update from the library adds and drops pin entries in place.
 */
const pinUuidsByNode = new WeakMap<
  SExprList,
  { children: SExprNode[]; length: number; ids: Map<string, string | undefined> }
>()

/** A placed pin's own KiCad id: the symbol's `(pin "<number>" (uuid …))` entry. */
export const placedPinUuid = (symbol: KicadSchematicSymbol, number: string): string | undefined => {
  const node = symbol._node
  let cached = pinUuidsByNode.get(node)
  if (!cached || cached.children !== node.children || cached.length !== node.children.length) {
    const ids = new Map<string, string | undefined>()
    for (const pin of findChildren(node, 'pin')) {
      const key = getFirstAtomValue(pin)
      if (key === undefined || ids.has(key)) continue
      const uuid = findChild(pin, 'uuid')
      ids.set(key, uuid ? getFirstAtomValue(uuid) : undefined)
    }
    cached = { children: node.children, length: node.children.length, ids }
    pinUuidsByNode.set(node, cached)
  }
  return cached.ids.get(number)
}

/** A sheet pin's own KiCad id. */
export const sheetPinUuid = (pin: KicadSheetPin): string | undefined => {
  const uuid = findChild(pin._node, 'uuid')
  return uuid ? getFirstAtomValue(uuid) : undefined
}

/**
 * The reference a symbol shows on a given sheet instance. References live in
 * the per-path (instances ...) block; when no path matches (a standalone
 * single-sheet file, or a path from another project) we fall back to the
 * Reference property, which mirrors what a plain single-file view showed.
 */
export const referenceForSheetPath = (
  symbol: KicadSchematicSymbol,
  sheetPath: string
): string | undefined => {
  const match = symbol.instances.find((instance) => instance.path === sheetPath)
  return match ? match.reference : getSymbolProperty(symbol, 'Reference')
}

/**
 * Set the reference for one hierarchical path. References are per-instance, so
 * editing a repeated sheet only touches its own path. The Reference property
 * (KiCad's cached default) is kept in sync when it currently equals the old
 * per-path value so single-file views stay consistent.
 */
export function setSymbolInstanceReference(
  symbol: KicadSchematicSymbol,
  sheetPath: string,
  reference: string
): void {
  const instance = symbol.instances.find((item) => item.path === sheetPath)
  if (instance) {
    const referenceNode = findChild(instance._node, 'reference')
    if (referenceNode) setPositionalAtom(referenceNode, 1, reference, true)
    if (getSymbolProperty(symbol, 'Reference') === instance.reference) {
      setSchematicSymbolProperty(symbol, 'Reference', reference)
    }
    instance.reference = reference
    return
  }
  // No per-path entry (standalone sheet): the Reference property is the value.
  setSchematicSymbolProperty(symbol, 'Reference', reference)
}

/**
 * Give any pin of `pins` the placement does not list yet its `(pin "N" (uuid))`
 * entry, after the last pin or before `(instances)` — what KiCad's
 * `UpdatePins` does when a unit or body style brings new pins into view.
 * Pins already listed keep their uuids, so nothing wired to them changes.
 */
const addMissingPlacedPins = (symbol: KicadSchematicSymbol, pins: SymbolPin[]): void => {
  const node = symbol._node
  const at = node.start
  const listed = new Set(findChildren(node, 'pin').map((pin) => getFirstAtomValue(pin) ?? ''))
  const added: SExprList[] = []
  for (const pin of pins) {
    if (listed.has(pin.number)) continue
    listed.add(pin.number)
    added.push(makeList([bare('pin', at), quoted(pin.number, at), uuidNode(at)], at))
  }
  if (!added.length) return
  let index = -1
  node.children.forEach((child, i) => {
    if (getToken(child) === 'pin') index = i + 1
  })
  if (index < 0) {
    const instances = node.children.findIndex((child) => getToken(child) === 'instances')
    index = instances >= 0 ? instances : node.children.length
  }
  node.children.splice(index, 0, ...added)
}

/** Set a placement's `(token N)`, or insert it after the first `after` child found. */
const setPlacedNumber = (
  node: SExprList,
  tokens: string[],
  value: number,
  after: string[]
): void => {
  const existing = tokens.map((token) => findChild(node, token)).find((child) => !!child)
  if (existing) {
    setPositionalAtom(existing, 1, String(value), false)
    return
  }
  const at = node.start
  const anchor = after
    .map((token) => node.children.findIndex((child) => getToken(child) === token))
    .find((index) => index >= 0)
  node.children.splice(
    anchor === undefined ? node.children.length : anchor + 1,
    0,
    makeList([bare(tokens[0], at), num(value, at)], at)
  )
}

/**
 * Show another unit of a multi-unit part, as KiCad's `SelectUnit` does: the
 * placement's `(unit)` and the unit of the instance on screen (`sheetPath`) —
 * the other instances of a reused sheet keep theirs. `pins` are the new unit's.
 */
export function setSchematicSymbolUnit(
  symbol: KicadSchematicSymbol,
  unit: number,
  sheetPath: string,
  pins: SymbolPin[]
): void {
  setPlacedNumber(symbol._node, ['unit'], unit, ['at', 'lib_id'])
  symbol.unit = unit
  const instance = symbol.instances.find((item) => item.path === sheetPath)
  if (instance) {
    setPlacedNumber(instance._node, ['unit'], unit, ['reference'])
    instance.unit = unit
  }
  addMissingPlacedPins(symbol, pins)
}

/**
 * Draw the placement in another body style (KiCad's `SelectBodyStyle`). An
 * older file's `(convert N)` is set where it stands; otherwise KiCad 10's
 * `(body_style N)` goes after `(unit)`. `pins` are the new style's.
 */
export function setSchematicSymbolBodyStyle(
  symbol: KicadSchematicSymbol,
  style: number,
  pins: SymbolPin[]
): void {
  setPlacedNumber(symbol._node, ['body_style', 'convert'], style, ['unit', 'at', 'lib_id'])
  symbol.bodyStyle = style
  addMissingPlacedPins(symbol, pins)
}
