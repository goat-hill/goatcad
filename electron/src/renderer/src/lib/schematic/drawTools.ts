import { NM_PER_MIL, nm, pointsEqualNm, type Nm } from '../kicad/coordinates'
import {
  addSchematicArcToAST,
  addSchematicBezierToAST,
  addSchematicImageToAST,
  addSchematicRuleAreaToAST,
  addSchematicTableToAST,
  DEFAULT_FONT_SIZE_NM,
  addSchematicBusEntryToAST,
  addSchematicBusToAST,
  addSchematicCircleToAST,
  addSchematicDirectiveLabelToAST,
  addSchematicPolylineToAST,
  addSchematicRectangleToAST,
  addSchematicTextBoxToAST,
  parseKicadSchematic,
  serializeKicadSchematic,
  sheetPinLanding,
  SHEET_PIN_SHAPES,
  type DirectiveLabelShape,
  type KicadSchematic,
  type KicadSheet,
  type Point,
  type SheetPinShape,
  type SheetSide
} from '../kicad/schematic'
import { elbowPoints, mergeCollinearPoints, type WirePosture } from './schematicTools'

/**
 * The schematic's drawing and bus tools as pure steps: what the clicks so far
 * and the cursor make (the preview draws exactly that, through the real
 * writer), and what a click commits. Sheet space, integer nanometers, y-down.
 */

/** A tool that builds its item from clicks rather than dropping it whole. */
export type DrawTool =
  | 'line'
  | 'rectangle'
  | 'circle'
  | 'arc'
  | 'bezier'
  | 'text_box'
  | 'table'
  | 'rule_area'
  | 'image'
  | 'bus'
  | 'bus_entry'
  | 'directive_label'

export const DRAW_TOOLS: readonly DrawTool[] = [
  'line',
  'rectangle',
  'circle',
  'arc',
  'bezier',
  'text_box',
  'table',
  'rule_area',
  'image',
  'bus',
  'bus_entry',
  'directive_label'
]

export const isDrawTool = (tool: string): tool is DrawTool =>
  (DRAW_TOOLS as readonly string[]).includes(tool)

/** Tools that take a run of vertices, finished by a double click or Enter —
 *  a rule area's outline also by clicking its first point again. */
export const isRunTool = (tool: string): tool is 'line' | 'bus' | 'rule_area' =>
  tool === 'line' || tool === 'bus' || tool === 'rule_area'

/** Tools that take exactly two clicks: a corner and its opposite, a center and
 *  the rim, an arc's two ends, a table's corner and its extent. */
export const isTwoClickTool = (
  tool: string
): tool is 'rectangle' | 'circle' | 'arc' | 'text_box' | 'table' =>
  tool === 'rectangle' ||
  tool === 'circle' ||
  tool === 'arc' ||
  tool === 'text_box' ||
  tool === 'table'

/** Clicks a bezier takes: start, end, then each control point (KiCad's order). */
export const BEZIER_CLICKS = 4

/** One item a drawing tool writes, in the writer's own terms. */
export type DrawItem =
  | { kind: 'polyline'; points: Point[] }
  | { kind: 'bus'; points: Point[] }
  | { kind: 'rectangle'; start: Point; end: Point }
  | { kind: 'circle'; center: Point; radius: Nm }
  | { kind: 'arc'; start: Point; mid: Point; end: Point }
  | { kind: 'bezier'; points: [Point, Point, Point, Point] }
  | { kind: 'text_box'; position: Point; size: { width: Nm; height: Nm }; text: string }
  | { kind: 'table'; position: Point; columnWidths: Nm[]; rowHeights: Nm[] }
  | { kind: 'rule_area'; points: Point[] }
  | { kind: 'image'; position: Point; data: string }
  | { kind: 'bus_entry'; position: Point; size: { width: Nm; height: Nm } }
  | { kind: 'directive_label'; position: Point; shape: DirectiveLabelShape; netclass: string }

/** KiCad's `DEFAULT_SCH_ENTRY_SIZE`: a bus entry spans 100 mil each way. */
export const BUS_ENTRY_SPAN: Nm = nm(100 * NM_PER_MIL)

/** The entry KiCad places by default, `/` leaving the bus down and right. */
export const BUS_ENTRY_SIZE = { width: BUS_ENTRY_SPAN, height: BUS_ENTRY_SPAN }

/** The other diagonal, `\`, for Shift+Z. */
export const BUS_ENTRY_SIZE_FLIPPED = { width: BUS_ENTRY_SPAN, height: nm(-BUS_ENTRY_SPAN) }

/** An entry turned a quarter clockwise on screen (y-down): (w, h) → (−h, w). */
export const rotateBusEntrySize = (size: { width: Nm; height: Nm }): { width: Nm; height: Nm } => ({
  width: nm(-size.height),
  height: size.width
})

/**
 * KiCad 10's two-click arc (`EDA_SHAPE::calcEdit`, edit state 1): the ends
 * are the clicks and the arc subtends 90°, running clockwise on screen from
 * start to end — of the two centers a radius of chord/√2 allows, the one that
 * keeps the angle under 180°. Returns the point halfway along it, which is
 * what the file stores.
 */
export function arcMidpoint(start: Point, end: Point): Point {
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  const mx = (start.x + end.x) / 2
  const my = (start.y + end.y) / 2
  if (length === 0) return { x: nm(mx), y: nm(my) }
  // The vector from the chord's middle to a center, √(r² − l²/4) = l/2 long.
  const dx = (start.y - end.y) / 2
  const dy = (end.x - start.x) / 2
  const sweep = (cx: number, cy: number): number => {
    const a = Math.atan2(start.y - cy, start.x - cx)
    const b = Math.atan2(end.y - cy, end.x - cx)
    return (((b - a) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  }
  let cx = mx + dx
  let cy = my + dy
  if (sweep(cx, cy) > Math.PI) {
    cx = mx - dx
    cy = my - dy
  }
  // The arc's middle lies on the bisector beyond the chord, a radius from the
  // center: (m − c) is l/2 long and the radius l/√2, hence the √2.
  return {
    x: toSchematicUnit(cx + (mx - cx) * Math.SQRT2),
    y: toSchematicUnit(cy + (my - cy) * Math.SQRT2)
  }
}

/** KiCad's schematic internal unit (`schIUScale`): 100 nm. A computed point
 *  lands on it, as KiCad's own would, so a save there changes nothing. */
const SCHEMATIC_IU_NM = 100

const toSchematicUnit = (value: number): Nm =>
  nm(Math.round(value / SCHEMATIC_IU_NM) * SCHEMATIC_IU_NM + 0)

/** The rectangle two corners span, as a top-left point and a positive size. */
export const spannedBox = (
  a: Point,
  b: Point
): { position: Point; size: { width: Nm; height: Nm } } => ({
  position: { x: nm(Math.min(a.x, b.x)), y: nm(Math.min(a.y, b.y)) },
  size: { width: nm(Math.abs(b.x - a.x)), height: nm(Math.abs(b.y - a.y)) }
})

/** How far from a bus the cursor may be for an entry to land on it. */
const BUS_ENTRY_REACH: Nm = nm(50 * NM_PER_MIL)

/**
 * Where a bus entry held at `cursor` lands: its `(at)` end on the nearest bus
 * within reach (the foot of the perpendicular, so an axis-aligned bus keeps
 * the cursor's grid step along it), else the cursor itself.
 */
export function busEntryLanding(buses: Point[][], cursor: Point): Point {
  let best: Point | null = null
  let bestDistance: number = BUS_ENTRY_REACH
  for (const run of buses) {
    for (let index = 1; index < run.length; index++) {
      const a = run[index - 1]
      const b = run[index]
      const abx = b.x - a.x
      const aby = b.y - a.y
      const lengthSq = abx * abx + aby * aby
      const t =
        lengthSq < 1
          ? 0
          : Math.max(0, Math.min(1, ((cursor.x - a.x) * abx + (cursor.y - a.y) * aby) / lengthSq))
      const foot = { x: a.x + t * abx, y: a.y + t * aby }
      const distance = Math.hypot(cursor.x - foot.x, cursor.y - foot.y)
      if (distance <= bestDistance) {
        bestDistance = distance
        best = { x: nm(foot.x), y: nm(foot.y) }
      }
    }
  }
  return best ?? { ...cursor }
}

/** How far outside a sheet's border a click still lands a pin on it. */
const SHEET_PIN_REACH: Nm = nm(50 * NM_PER_MIL)

/**
 * The sheet a pin click lands on and where: the last-drawn sheet whose box,
 * widened by the reach, holds the point, with the pin on its nearest edge at
 * the nearest pin-pitch slot (`sheetPinLanding`, as a dragged pin lands).
 */
export function sheetPinTarget(
  sheets: KicadSheet[],
  point: Point
): { sheetIndex: number; position: Point; side: SheetSide } | null {
  for (let index = sheets.length - 1; index >= 0; index--) {
    const sheet = sheets[index]
    const { x, y } = sheet.position
    const { width, height } = sheet.size
    if (
      point.x < x - SHEET_PIN_REACH ||
      point.x > x + width + SHEET_PIN_REACH ||
      point.y < y - SHEET_PIN_REACH ||
      point.y > y + height + SHEET_PIN_REACH
    ) {
      continue
    }
    const landing = sheetPinLanding(
      sheet,
      { position: { ...point, angle: 0 } },
      { x: nm(0), y: nm(0) }
    )
    return { sheetIndex: index, ...landing }
  }
  return null
}

/**
 * The hierarchical labels inside a sheet's child that no pin on the sheet
 * carries yet, in file order, each with the shape its pin should take —
 * KiCad's Place Pins from Sheet imports these one per click.
 */
export function unplacedSheetPins(
  sheet: KicadSheet,
  child: KicadSchematic | null
): { name: string; shape: SheetPinShape }[] {
  if (!child) return []
  const placed = new Set(sheet.pins.map((pin) => pin.name))
  const seen = new Set<string>()
  const result: { name: string; shape: SheetPinShape }[] = []
  for (const label of child.labels) {
    if (label.type !== 'hierarchical_label' || placed.has(label.text) || seen.has(label.text)) {
      continue
    }
    seen.add(label.text)
    const shape = (SHEET_PIN_SHAPES as readonly string[]).includes(label.shape ?? '')
      ? (label.shape as SheetPinShape)
      : 'input'
    result.push({ name: label.text, shape })
  }
  return result
}

/**
 * A bezier from its clicks so far and the cursor, KiCad's way
 * (`EDA_SHAPE::calcEdit`): the second click is the end, dragging the second
 * control point with it, then each control point in turn. Null until the
 * curve spans something.
 */
export function bezierDraft<P extends { x: number; y: number } = Point>(
  points: P[],
  cursor: P
): [P, P, P, P] | null {
  const [start, end, c1] = points
  if (!start) return null
  if (!end)
    return pointsEqualNm(start, cursor) ? null : [start, start, { ...cursor }, { ...cursor }]
  if (!c1) return [start, { ...cursor }, end, end]
  return [start, c1, { ...cursor }, end]
}

/**
 * The columns and rows a table dragged from `origin` to `cursor` gets, as
 * KiCad's Draw Table sizes it: a column per 15 text heights and a row per 2,
 * at least one of each; each cell the drag's share, no smaller than 5 × 2 grid
 * steps, rounded to the grid. Worked in KiCad's 100 nm unit, integer division
 * and all, so the sizes are KiCad's own.
 */
export function tableDraft(
  origin: Point,
  cursor: Point,
  grid: Nm,
  textSize: Nm = DEFAULT_FONT_SIZE_NM
): { columnWidths: Nm[]; rowHeights: Nm[] } {
  const iu = (value: number): number => Math.round(value / SCHEMATIC_IU_NM)
  const g = Math.max(1, iu(grid))
  const font = iu(textSize)
  const dx = iu(cursor.x - origin.x)
  const dy = iu(cursor.y - origin.y)
  const cols = Math.max(1, Math.trunc(dx / (font * 15)))
  const rows = Math.max(1, Math.trunc(dy / (font * 2)))
  const cellX = Math.round(Math.max(g * 5, Math.trunc(dx / cols)) / g) * g
  const cellY = Math.round(Math.max(g * 2, Math.trunc(dy / rows)) / g) * g
  return {
    columnWidths: Array.from({ length: cols }, () => nm(cellX * SCHEMATIC_IU_NM)),
    rowHeights: Array.from({ length: rows }, () => nm(cellY * SCHEMATIC_IU_NM))
  }
}

/** Options a draft reads beyond its clicks. */
export interface DraftOptions {
  posture: WirePosture
  busEntrySize: { width: Nm; height: Nm }
  directiveShape: DirectiveLabelShape
  /** The sheet's buses, for an entry to land on. */
  buses: Point[][]
  /** The grid step a table's cells round to. */
  grid?: Nm
  /** The PNG (base64) the image tool holds. */
  image?: string | null
}

/**
 * What the tool would commit with `cursor` as its next click, or null while
 * that makes nothing drawable (a run with no first point, a zero-size box).
 * The preview draws this; a click commits it when the tool is one click from
 * done.
 */
export function draftItem(
  tool: DrawTool,
  points: Point[],
  cursor: Point,
  options: DraftOptions
): DrawItem | null {
  switch (tool) {
    case 'rule_area': {
      if (!points.length) return null
      const outline = mergeCollinearPoints([...points, { ...cursor }])
      return outline.length >= 2 ? { kind: 'rule_area', points: outline } : null
    }
    case 'bezier': {
      const curve = bezierDraft(points, cursor)
      return curve ? { kind: 'bezier', points: curve } : null
    }
    case 'table': {
      const origin = points[0]
      if (!origin) return null
      return {
        kind: 'table',
        position: origin,
        ...tableDraft(origin, cursor, options.grid ?? nm(0))
      }
    }
    case 'image':
      return options.image ? { kind: 'image', position: { ...cursor }, data: options.image } : null
    case 'line':
    case 'bus': {
      if (!points.length) return null
      const last = points[points.length - 1]
      const tail = tool === 'bus' ? elbowPoints(last, cursor, options.posture) : [{ ...cursor }]
      const run = mergeCollinearPoints([...points, ...tail])
      if (run.length < 2) return null
      return tool === 'bus' ? { kind: 'bus', points: run } : { kind: 'polyline', points: run }
    }
    case 'rectangle': {
      const start = points[0]
      if (!start || start.x === cursor.x || start.y === cursor.y) return null
      return { kind: 'rectangle', start, end: { ...cursor } }
    }
    case 'text_box': {
      const start = points[0]
      if (!start || start.x === cursor.x || start.y === cursor.y) return null
      return { kind: 'text_box', ...spannedBox(start, cursor), text: '' }
    }
    case 'circle': {
      const center = points[0]
      if (!center) return null
      const radius = nm(Math.hypot(cursor.x - center.x, cursor.y - center.y))
      return radius > 0 ? { kind: 'circle', center, radius } : null
    }
    case 'arc': {
      const start = points[0]
      if (!start || pointsEqualNm(start, cursor)) return null
      return { kind: 'arc', start, mid: arcMidpoint(start, cursor), end: { ...cursor } }
    }
    case 'bus_entry':
      return {
        kind: 'bus_entry',
        position: busEntryLanding(options.buses, cursor),
        size: options.busEntrySize
      }
    case 'directive_label':
      return {
        kind: 'directive_label',
        position: { ...cursor },
        shape: options.directiveShape,
        netclass: ''
      }
  }
}

/** Write a drawn item into a sheet through its AST writer. */
export function writeDrawItem(schematic: KicadSchematic, item: DrawItem): void {
  switch (item.kind) {
    case 'polyline':
      addSchematicPolylineToAST(schematic, item.points)
      return
    case 'bus':
      addSchematicBusToAST(schematic, item.points)
      return
    case 'rectangle':
      addSchematicRectangleToAST(schematic, item.start, item.end)
      return
    case 'circle':
      addSchematicCircleToAST(schematic, item.center, item.radius)
      return
    case 'arc':
      addSchematicArcToAST(schematic, item)
      return
    case 'bezier':
      addSchematicBezierToAST(schematic, item.points)
      return
    case 'table':
      addSchematicTableToAST(schematic, item.position, item.columnWidths, item.rowHeights)
      return
    case 'rule_area':
      addSchematicRuleAreaToAST(schematic, item.points)
      return
    case 'image':
      addSchematicImageToAST(schematic, item.position, item.data)
      return
    case 'text_box':
      addSchematicTextBoxToAST(schematic, item.text, item.position, item.size)
      return
    case 'bus_entry':
      addSchematicBusEntryToAST(schematic, item.position, item.size)
      return
    case 'directive_label':
      addSchematicDirectiveLabelToAST(schematic, item.position, item.shape, item.netclass)
  }
}

const DRAFT_SHEET =
  '(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "00000000-0000-0000-0000-000000000000") (paper "A4") (lib_symbols))'

/**
 * A scratch sheet holding only `item`, written by the same writer a commit
 * uses and read back by the same parser: the preview is the thing itself.
 */
export function draftSheet(item: DrawItem): KicadSchematic {
  const scratch = parseKicadSchematic(DRAFT_SHEET)
  writeDrawItem(scratch, item)
  return parseKicadSchematic(serializeKicadSchematic(scratch))
}
