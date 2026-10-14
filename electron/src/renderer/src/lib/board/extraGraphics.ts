/**
 * What a Bézier, text box, table or point draws, as plain geometry both board
 * scenes and every hit test read — so what you click is what you see, on the
 * board and in the footprint editor alike.
 *
 * Everything here is FILE space: integer-nanometer inputs, x right and y down,
 * the frame the item is written in (a footprint's items are footprint-local).
 * Outputs may carry fractional nanometers (a sampled curve, a centered anchor);
 * they are display and hit-test geometry, never written back. A scene maps each
 * point into its own frame (and through a footprint's placement) at the edge.
 *
 * Text boxes lay out through the schematic's `textBox.ts`, whose rules KiCad's
 * PCB text box shares (`PCB_TEXTBOX::GetDrawPos`): centered text ignores the
 * margins, left / right / top / bottom inset by theirs, and the wrap width is
 * always the box less its left and right margins.
 */

import type {
  KicadExtraGraphic,
  KicadFontEffects,
  KicadFpCurve,
  KicadFpTextBox,
  KicadPoint,
  KicadTable,
  KicadTableCell
} from '../kicad/footprint'
import { legacyTextBoxMargin } from '../kicad/footprint'
import { bezierCurvePoints } from '../kicad/schematic'
import { strokeOptionsFromEffects } from '../kicad/newstroke'
import { textBoxLayout, type TextBoxFrame } from '../schematic/textBox'
import { mmToNm } from '../kicad/coordinates'

export interface Pt {
  x: number
  y: number
}

/** One stroked run: an open polyline, or a closed outline. `width` in nm. */
export interface GraphicStroke {
  points: Pt[]
  closed: boolean
  width: number
}

/** One block of stroke text, laid out already: `anchor` and `angle` as the renderer takes them. */
export interface GraphicText {
  text: string
  anchor: Pt
  /** Degrees, counterclockwise on screen as KiCad's angles run. */
  angle: number
  effects?: KicadFontEffects
}

/** Everything one item draws. */
export interface GraphicDrawing {
  strokes: GraphicStroke[]
  texts: GraphicText[]
  rings: Array<{ center: Pt; radius: number; width: number }>
}

/** The width a stroke without one draws at: KiCad's 0.1 mm default line. */
export const DEFAULT_GRAPHIC_WIDTH = mmToNm(0.1)

/** A point marker's pen: a hairline, as KiCad's screen-width outline reads. */
const POINT_PEN = mmToNm(0.02)

/** A stroke's width, or the default where the file gave none (or KiCad's -1 "unset"). */
const widthOr = (width: number | undefined): number =>
  width !== undefined && width > 0 ? width : DEFAULT_GRAPHIC_WIDTH

// ---------------------------------------------------------------------------
// Bézier
// ---------------------------------------------------------------------------

/** A curve flattened for drawing and hit-testing (the schematic's own sampler). */
export const curvePolyline = (curve: KicadFpCurve): Pt[] => bezierCurvePoints(curve.points)

// ---------------------------------------------------------------------------
// Text box
// ---------------------------------------------------------------------------

/** A box's corners in order: the rectangle's four, or the polygon KiCad wrote. */
export function textBoxCorners(box: KicadFpTextBox): Pt[] {
  if (box.points && box.points.length >= 3) return box.points.map((p) => ({ x: p.x, y: p.y }))
  const s = box.start ?? { x: 0, y: 0 }
  const e = box.end ?? s
  return [
    { x: s.x, y: s.y },
    { x: e.x, y: s.y },
    { x: e.x, y: e.y },
    { x: s.x, y: e.y }
  ]
}

/** The margins a box lays out with: its own, or KiCad's legacy rule when it names none. */
export function textBoxMargins(box: KicadFpTextBox): {
  left: number
  top: number
  right: number
  bottom: number
} {
  if (box.margins) return box.margins
  const m = legacyTextBoxMargin(box.strokeWidth ?? 0, box.fontEffects?.height ?? mmToNm(1.27))
  return { left: m, top: m, right: m, bottom: m }
}

const rotate = (p: Pt, about: Pt, degrees: number): Pt => {
  const a = (degrees * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = p.x - about.x
  const dy = p.y - about.y
  return { x: about.x + dx * cos - dy * sin, y: about.y + dx * sin + dy * cos }
}

/**
 * The laid-out text of a box: wrapped to the box, anchored where its
 * justification puts it. The box's corners are un-turned by the text angle to
 * find the text's own frame (KiCad's `GetCornersInSequence`), so a box whose
 * text runs at 90° wraps to its height, not its width.
 */
export function textBoxText(box: KicadFpTextBox): GraphicText | null {
  if (!box.text) return null
  const corners = textBoxCorners(box)
  // The layout speaks y-up; the file is y-down. Cross once each way.
  const up = corners.map((p) => ({ x: p.x, y: -p.y }))
  const center = {
    x: up.reduce((sum, p) => sum + p.x, 0) / up.length,
    y: up.reduce((sum, p) => sum + p.y, 0) / up.length
  }
  const local = up.map((p) => rotate(p, center, -box.angle))
  const left = Math.min(...local.map((p) => p.x))
  const right = Math.max(...local.map((p) => p.x))
  const bottom = Math.min(...local.map((p) => p.y))
  const top = Math.max(...local.map((p) => p.y))
  const topLeft = rotate({ x: left, y: top }, center, box.angle)
  const frame: TextBoxFrame = {
    position: { x: topLeft.x, y: topLeft.y, angle: box.angle },
    size: { width: right - left, height: -(top - bottom) },
    margins: textBoxMargins(box)
  }
  const options = strokeOptionsFromEffects(box.fontEffects)
  // Mirrored text reads right to left, so its anchor sits on the other side
  // (`GetDrawPos`, IsMirrored); the glyphs mirror in the stroke layout itself.
  const hAlign = options.mirror
    ? options.horizontalAlign === 'left'
      ? 'right'
      : options.horizontalAlign === 'right'
        ? 'left'
        : 'center'
    : options.horizontalAlign
  const laid = textBoxLayout(frame, box.text, { ...options, horizontalAlign: hAlign })
  return {
    text: laid.text,
    anchor: { x: laid.anchor.x, y: -laid.anchor.y },
    angle: box.angle,
    effects: box.fontEffects
  }
}

/** A text box's drawing: its border (when it has one) and its text. */
export function textBoxDrawing(box: KicadFpTextBox): GraphicDrawing {
  const text = textBoxText(box)
  return {
    strokes: box.border
      ? [{ points: textBoxCorners(box), closed: true, width: widthOr(box.strokeWidth) }]
      : [],
    texts: text ? [text] : [],
    rings: []
  }
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/** Running offsets of a list of sizes: [0, a, a+b, …]. */
const offsets = (sizes: readonly number[]): number[] => {
  const out = [0]
  for (const size of sizes) out.push(out[out.length - 1] + size)
  return out
}

/**
 * A table's grid: where it starts (its first cell's corner) and the x of every
 * column edge and y of every row edge. Null for a table with no cells to start
 * from.
 */
export function tableGrid(table: KicadTable): { xs: number[]; ys: number[] } | null {
  const first = table.cells[0]
  if (!first) return null
  const origin = first.start ?? first.points?.[0]
  if (!origin) return null
  const columns = Math.max(1, table.columnCount)
  const rows = Math.max(1, Math.ceil(table.cells.length / columns))
  const widths = Array.from({ length: columns }, (_, i) => table.columnWidths[i] ?? 0)
  const heights = Array.from({ length: rows }, (_, i) => table.rowHeights[i] ?? 0)
  return {
    xs: offsets(widths).map((x) => origin.x + x),
    ys: offsets(heights).map((y) => origin.y + y)
  }
}

/** The table's outline: its grid's four corners. */
export function tableCorners(table: KicadTable): Pt[] {
  const grid = tableGrid(table)
  if (!grid) return []
  const x0 = grid.xs[0]
  const x1 = grid.xs[grid.xs.length - 1]
  const y0 = grid.ys[0]
  const y1 = grid.ys[grid.ys.length - 1]
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 }
  ]
}

/** The cells a table draws: the ones not covered by a neighbor's span. */
const drawnCells = (
  table: KicadTable
): Array<{ cell: KicadTableCell; row: number; col: number }> => {
  const columns = Math.max(1, table.columnCount)
  return table.cells
    .map((cell, i) => ({ cell, row: Math.floor(i / columns), col: i % columns }))
    .filter(({ cell }) => cell.colSpan > 0 && cell.rowSpan > 0)
}

/**
 * A table's drawing, as KiCad's painter rules it: the outside border and the
 * header's underline in the border stroke, then each drawn cell's right and
 * bottom edge (short of the table's own edge) in the separator stroke, so a
 * spanning cell draws no line through itself. Every cell's text lays out as a
 * text box over the cells it spans.
 */
export function tableDrawing(table: KicadTable): GraphicDrawing {
  const grid = tableGrid(table)
  const drawing: GraphicDrawing = { strokes: [], texts: [], rings: [] }
  if (!grid) return drawing
  const { xs, ys } = grid
  const lastX = xs.length - 1
  const lastY = ys.length - 1
  const border = widthOr(table.borderStrokeWidth)
  const separator = widthOr(table.separatorStrokeWidth)
  const line = (a: Pt, b: Pt, width: number): void => {
    drawing.strokes.push({ points: [a, b], closed: false, width })
  }
  if (table.borderExternal) {
    drawing.strokes.push({ points: tableCorners(table), closed: true, width: border })
  }
  if (table.borderHeader && lastY > 1) {
    line({ x: xs[0], y: ys[1] }, { x: xs[lastX], y: ys[1] }, border)
  }
  for (const { cell, row, col } of drawnCells(table)) {
    const right = Math.min(col + cell.colSpan, lastX)
    const bottom = Math.min(row + cell.rowSpan, lastY)
    if (table.separatorCols && right < lastX) {
      line({ x: xs[right], y: ys[row] }, { x: xs[right], y: ys[bottom] }, separator)
    }
    // The header's underline is the border's to draw when it is on.
    const header = row === 0 && bottom === 1 && table.borderHeader
    if (table.separatorRows && bottom < lastY && !header) {
      line({ x: xs[col], y: ys[bottom] }, { x: xs[right], y: ys[bottom] }, separator)
    }
    const text = textBoxText({
      ...cell,
      start: { x: xs[col], y: ys[row] } as KicadFpTextBox['start'],
      end: { x: xs[right], y: ys[bottom] } as KicadFpTextBox['end'],
      points: undefined
    })
    if (text) drawing.texts.push(text)
  }
  return drawing
}

// ---------------------------------------------------------------------------
// Point
// ---------------------------------------------------------------------------

/**
 * A point's marker, KiCad's `draw( PCB_POINT )`: an X across its size, and a
 * ring half as wide around its center.
 */
export function pointDrawing(point: KicadPoint): GraphicDrawing {
  const { x, y } = point.position
  const h = point.size / 2
  return {
    strokes: [
      {
        points: [
          { x: x - h, y: y - h },
          { x: x + h, y: y + h }
        ],
        closed: false,
        width: POINT_PEN
      },
      {
        points: [
          { x: x + h, y: y - h },
          { x: x - h, y: y + h }
        ],
        closed: false,
        width: POINT_PEN
      }
    ],
    texts: [],
    rings: [{ center: { x, y }, radius: h / 2, width: POINT_PEN }]
  }
}

// ---------------------------------------------------------------------------
// Any of the four
// ---------------------------------------------------------------------------

/** Which of the four an item is, read from its node's token. */
export type ExtraGraphicKind = 'curve' | 'textbox' | 'table' | 'point'

export function extraGraphicKind(item: KicadExtraGraphic): ExtraGraphicKind {
  if ('columnCount' in item) return 'table'
  if ('size' in item && 'position' in item) return 'point'
  if ('text' in item) return 'textbox'
  return 'curve'
}

/** What any of the four draws. */
export function extraGraphicDrawing(item: KicadExtraGraphic): GraphicDrawing {
  switch (extraGraphicKind(item)) {
    case 'curve': {
      const curve = item as KicadFpCurve
      return {
        strokes: [
          { points: curvePolyline(curve), closed: false, width: widthOr(curve.strokeWidth) }
        ],
        texts: [],
        rings: []
      }
    }
    case 'textbox':
      return textBoxDrawing(item as KicadFpTextBox)
    case 'table':
      return tableDrawing(item as KicadTable)
    case 'point':
      return pointDrawing(item as KicadPoint)
  }
}

/**
 * The area a click inside selects: a text box's or table's outline and a
 * point's square. A curve is only its stroke, so it has none.
 */
export function extraGraphicArea(item: KicadExtraGraphic): Pt[] | null {
  switch (extraGraphicKind(item)) {
    case 'curve':
      return null
    case 'textbox':
      return textBoxCorners(item as KicadFpTextBox)
    case 'table': {
      const corners = tableCorners(item as KicadTable)
      return corners.length ? corners : null
    }
    case 'point': {
      const { position, size } = item as KicadPoint
      const h = size / 2
      return [
        { x: position.x - h, y: position.y - h },
        { x: position.x + h, y: position.y - h },
        { x: position.x + h, y: position.y + h },
        { x: position.x - h, y: position.y + h }
      ]
    }
  }
}

/** Every point an item reaches, for a band's box and a view's extent. */
export function extraGraphicExtent(item: KicadExtraGraphic): Pt[] {
  const area = extraGraphicArea(item)
  if (area) return area
  return curvePolyline(item as KicadFpCurve)
}

/** Where a click on the item pivots a drag from: its first point or corner. */
export function extraGraphicPivot(item: KicadExtraGraphic): Pt {
  const extent = extraGraphicExtent(item)
  if (extraGraphicKind(item) === 'point') return { ...(item as KicadPoint).position }
  return extent[0] ?? { x: 0, y: 0 }
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

const distToSegment = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

const insidePolygon = (p: Pt, polygon: Pt[]): boolean => {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/**
 * How far `p` is from what the item draws, in the same units and frame as
 * `p`: 0 inside a box, table or point, otherwise the nearest stroke's edge.
 * `map` carries the item's file-space points into `p`'s frame (a scene's mm,
 * through a footprint's placement), so every caller measures one geometry.
 */
export function extraGraphicDistance(
  item: KicadExtraGraphic,
  p: Pt,
  map: (q: Pt) => Pt,
  scale: number
): number {
  const area = extraGraphicArea(item)
  if (area && insidePolygon(p, area.map(map))) return 0
  let best = Infinity
  for (const stroke of extraGraphicDrawing(item).strokes) {
    const pts = stroke.points.map(map)
    const n = stroke.closed ? pts.length : pts.length - 1
    for (let i = 0; i < n; i++) {
      const d = distToSegment(p, pts[i], pts[(i + 1) % pts.length]) - (stroke.width * scale) / 2
      if (d < best) best = d
    }
  }
  return Math.max(0, best)
}
