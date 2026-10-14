/**
 * The copper a board draws that is not a track, via, pad or zone: graphic
 * lines, arcs, circles, rectangles and polygons on a copper layer, the board's
 * and its footprints', and what they write there — texts, a footprint's visible
 * fields, text boxes, tables and their cells, and dimensions. World space:
 * millimeters, y up.
 *
 * Each is read as KiCad 10 reads it, which differs by kind and by reader:
 * - **What DRC measures** (`GetEffectiveShape`): a graphic's strokes and fill; a
 *   text's glyphs; a text box's glyphs and, when it has a stroke, its outline
 *   at the stroke's width, border or no; a table's whole area and its rules,
 *   and each cell's glyphs as an item of its own; a dimension's lines as bare
 *   centerlines and its text's glyphs.
 * - **What the zone filler cuts** (`ZONE_FILLER::addKnockout`): a text's box; a
 *   text box's area as it is and its border grown by the clearance; a table's
 *   cells the same way, each border as wide as the table's widest rule; a
 *   dimension's lines at their thickness and its text's box. Of a footprint's
 *   fields only the reference and value.
 * - **Which have a net** (`IsConnected`): a board graphic, and — being a kind
 *   of shape — a board text box or table cell, whose net is always 0. Only the
 *   graphic joins what it touches.
 * - A footprint's table is not in DRC's copper index (`forEachGeometryItem`
 *   gathers only a footprint's text, text boxes, shapes and dimensions), so
 *   only the zones see it.
 *
 * A text is its box, as KiCad takes it wherever copper keeps clear of text
 * (`PCB_TEXT::TransformShapeToPolygon`, `buildBoundingHull`): the glyphs'
 * extent in the text's own frame, strokes included, turned with the text —
 * and grown by a clearance as a box too, its corners square.
 * The zone filler cuts both. DRC and connectivity read them too, each item's
 * pieces gathered as one (`source`), and a text there as its glyphs, which is
 * how KiCad's DRC takes it (`GetEffectiveShape`).
 *
 * Shapes are read as KiCad loads them (`PCB_IO_KICAD_SEXPR_PARSER::parsePCB_SHAPE`):
 * with no `fill` token, a rectangle or circle of no width and any polygon are
 * filled, and an unfilled shape of no width is drawn at the default width. A
 * hidden board text is shown, as KiCad shows it.
 */
import { expandBoardText, type KicadBoard } from '../kicad/board'
import type {
  KicadDimension,
  KicadFontEffects,
  KicadFpTextBox,
  KicadTable,
  KicadFpArc,
  KicadFpCircle,
  KicadFpCurve,
  KicadFpLine,
  KicadFpPoly,
  KicadFpRect
} from '../kicad/footprint'
import {
  expandFootprintText,
  footprintTextDrawAngle,
  getReference,
  getValue,
  isSolidFill
} from '../kicad/footprint'
import { getTextStrokes, strokeOptionsFromEffects } from '../kicad/newstroke'
import { isCopperLayer } from '../kicad/layers'
import { nmToMm, type Nm } from '../kicad/coordinates'
import { footprintTransform, tfPoint, worldPoint, type Pt } from '../schematic/placement'
import { polyShape, sampleArc, type CopperShape } from './spatialIndex'
import { segmentsPerTurn } from './shapeOutline'
import { findChild, findChildren, getAtomValues, type SExprNode } from '../kicad/sexpr'
import { bezierPoints } from '../engine/board3d/boardOutline'
import { tableCorners, tableDrawing, tableGrid, textBoxCorners, textBoxText } from './extraGraphics'
import { dimensionGeometry } from './dimensionGeometry'
import { mmToNm } from '../kicad/coordinates'

/** KiCad's kind of drawing, as `A.Type` names it: 'Graphic', 'Text', 'Text Box', 'Table', 'Table Cell', 'Dimension', 'Leader'. */
export type DrawingKind = 'graphic' | 'text' | 'textbox' | 'table' | 'cell' | 'dimension' | 'leader'

/** A piece the zone filler cuts, and whether it is grown by the clearance (and by how much more). */
export interface FillCut {
  shape: CopperShape
  grows: boolean
  extra?: number
}

export interface BoardDrawing {
  drawing: DrawingKind
  /**
   * Net number: a board graphic's own (`(net …)`); a footprint's graphic and
   * any text carry none, so 0.
   */
  net: number
  /**
   * A board graphic: KiCad's `PCB_SHAPE::IsConnected`. It has a net, even if 0,
   * and joins the copper it touches; a footprint's graphic and text do neither.
   */
  connected: boolean
  /**
   * KiCad's `IsConnected`: DRC reads the item's net, 0 or not — a board
   * graphic, text box or table cell. Every other drawing has none.
   */
  netted: boolean
  /** The zone filler cuts it. */
  inFill: boolean
  /** DRC's copper index holds it; a footprint's table only the zones meet. */
  inCopperTree: boolean
  /** What the filler cuts, where it is not the shape (or a text's box). */
  fill?: FillCut[]
  /** The item this piece is part of: a stroked rectangle is four strokes and its fill. */
  source: number
  /** The item's uuid, as KiCad's report names it. */
  uuid?: string
  /**
   * Where a board graphic connects (`PCB_SHAPE::GetConnectionPoints`): a
   * filled shape's center; else its ends, an arc's middle too, a circle's
   * quadrants, a rectangle's corners, a polygon's vertices. Shared by its pieces.
   */
  anchors?: readonly Pt[]
  /** The footprint that draws it (index into the board's footprints); absent for the board's own. */
  fp?: number
  layer: string
  /** The copper DRC measures; for a text, its box (a rectangle, corner radius 0). */
  shape: CopperShape
  /** A text's strokes, each a capsule its pen wide: what DRC measures of it. */
  glyphs?: CopperShape[]
  /**
   * A knockout text (`(layer "F.Cu" knockout)`): drawn as copper round its
   * glyphs, so a pour keeps off the glyphs alone, not the box.
   */
  knockout?: boolean
  /**
   * A knockout text's margin round its glyphs, mm (`GetKnockoutTextMargin`:
   * half the pen, or a ninth of the height if more): its copper is its box
   * grown by this, less the glyphs.
   */
  knockoutMargin?: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** How far a circle's chords may stray from it, mm. */
const CURVE_ERROR = 0.005

/** Graphic lines drawn without a width: KiCad's default graphic width, mm. */
const DEFAULT_WIDTH = 0.1

/** A dimension that names no line thickness: KiCad's default, 0.2 mm. */
const DEFAULT_DIMENSION_THICKNESS = mmToNm(0.2)

/** A shape's fill as KiCad loads it: a file with no `fill` token fills by the legacy rules. */
const fillOf = (
  fill: string | undefined,
  kind: 'rect' | 'circle' | 'poly',
  width: Nm | undefined
): boolean => (fill !== undefined ? isSolidFill(fill) : kind === 'poly' || !width || width <= 0)

/**
 * A board's copper drawings on each copper layer. `withText` false leaves text
 * out, for what reads only the copper that conducts.
 */
export const copperDrawings = (
  board: KicadBoard,
  variables: Readonly<Record<string, string>> = {},
  withText = true
): Map<string, BoardDrawing[]> => boardDrawings(board, variables, withText, 'copper')

/**
 * A board's drawings: on each copper layer, or on one other layer
 * (silkscreen, mask, paste, fab, courtyards, the edge…), read alike. Off
 * copper nothing has a net. One layer at a time off copper, so asking for a
 * courtyard lays out no silkscreen text.
 */
export function boardDrawings(
  board: KicadBoard,
  variables: Readonly<Record<string, string>>,
  withText: boolean,
  side: 'copper' | { layer: string }
): Map<string, BoardDrawing[]> {
  const entries = drawingCache.get(board) ?? []
  const cached = entries.find(
    (entry) =>
      entry.variables === variables &&
      entry.withText === withText &&
      entry.side === (side === 'copper' ? side : side.layer)
  )
  if (cached) return cached.byLayer
  const onSide = (layer: string): boolean =>
    side === 'copper' ? isCopperLayer(layer) : layer === side.layer
  const byLayer = new Map<string, BoardDrawing[]>()
  /** The footprint whose drawings are being read; undefined while reading the board's. */
  let owner: number | undefined
  /** The item being read: its source number, uuid and, for a board graphic, its net. */
  let source = 0
  let item: { uuid?: string; net?: number } = {}
  let anchors: readonly Pt[] | undefined
  const begin = (next: { uuid?: string; net?: number }, points?: readonly Pt[]): void => {
    source++
    item = next
    anchors = points
  }
  /** The middle of points' box: a filled shape's one anchor. */
  const boxCenter = (points: readonly Pt[]): Pt[] => {
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    return [
      { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
    ]
  }
  const push = (
    layer: string | undefined,
    drawing: Omit<
      BoardDrawing,
      'layer' | 'source' | 'uuid' | 'connected' | 'netted' | 'inFill' | 'inCopperTree'
    > &
      Partial<Pick<BoardDrawing, 'inFill' | 'inCopperTree'>>
  ): void => {
    if (!layer || !onSide(layer)) return
    const list = byLayer.get(layer) ?? []
    const copper = side === 'copper'
    const connected = copper && owner === undefined && drawing.drawing === 'graphic'
    const netted =
      connected ||
      (copper &&
        owner === undefined &&
        (drawing.drawing === 'textbox' || drawing.drawing === 'cell'))
    list.push({
      inFill: true,
      inCopperTree: true,
      ...drawing,
      layer,
      source,
      connected,
      netted,
      ...(item.uuid ? { uuid: item.uuid } : {}),
      ...(anchors ? { anchors } : {}),
      ...(owner !== undefined ? { fp: owner } : {})
    })
    byLayer.set(layer, list)
  }
  const graphic = (layer: string | undefined, shape: CopperShape): void => {
    const box = boxOfShape(shape)
    const net = owner === undefined ? (item.net ?? 0) : 0
    push(layer, { drawing: 'graphic', net, shape, ...box })
  }
  /** A stroke: of no width only on a filled shape, which then has none. */
  const stroke = (
    layer: string | undefined,
    points: Pt[],
    width: Nm | undefined,
    isFilled = false
  ): void => {
    const w = width !== undefined && width > 0 ? nmToMm(width) : isFilled ? 0 : DEFAULT_WIDTH
    if (w <= 0) return
    const half = w / 2
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]
      const b = points[i + 1]
      graphic(layer, { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth: half })
    }
  }
  const shapes = (
    at: (p: { x: Nm; y: Nm }) => Pt,
    lines: readonly KicadFpLine[],
    arcs: readonly KicadFpArc[],
    circles: readonly KicadFpCircle[],
    rects: readonly KicadFpRect[],
    polys: readonly KicadFpPoly[],
    curves: readonly KicadFpCurve[]
  ): void => {
    // Only this side is read: off it a shape is passed over before it is measured.
    const onThisSide = (shape: { layer?: string }): boolean =>
      shape.layer !== undefined && onSide(shape.layer)
    for (const line of lines) {
      if (!onThisSide(line)) continue
      const ends = [at(line.start), at(line.end)]
      begin(line, ends)
      stroke(line.layer, ends, line.strokeWidth)
    }
    for (const arc of arcs) {
      if (!onThisSide(arc)) continue
      const [a, m, b] = [at(arc.start), at(arc.mid), at(arc.end)]
      begin(arc, [m, a, b])
      stroke(arc.layer, sampleArc(a.x, a.y, m.x, m.y, b.x, b.y), arc.strokeWidth)
    }
    for (const curve of curves) {
      if (!onThisSide(curve) || curve.points.length !== 4) continue
      const [p0, p1, p2, p3] = curve.points.map(at)
      begin(curve, [p0, p3])
      stroke(curve.layer, bezierPoints([p0, p1, p2, p3]), curve.strokeWidth)
    }
    for (const circle of circles) {
      if (!onThisSide(circle)) continue
      const c = at(circle.center)
      const e = at(circle.end)
      const r = Math.hypot(e.x - c.x, e.y - c.y)
      if (r <= 0) continue
      begin(
        circle,
        fillOf(circle.fill, 'circle', circle.strokeWidth)
          ? [c]
          : [
              { x: c.x + r, y: c.y },
              { x: c.x, y: c.y + r },
              { x: c.x - r, y: c.y },
              { x: c.x, y: c.y - r }
            ]
      )
      const count = segmentsPerTurn(r, CURVE_ERROR)
      const outline = Array.from({ length: count }, (_, k) => ({
        x: c.x + r * Math.cos((2 * Math.PI * k) / count),
        y: c.y + r * Math.sin((2 * Math.PI * k) / count)
      }))
      const solid = fillOf(circle.fill, 'circle', circle.strokeWidth)
      if (solid) graphic(circle.layer, polyShape([outline]))
      stroke(circle.layer, [...outline, outline[0]], circle.strokeWidth, solid)
    }
    for (const rect of rects) {
      if (!onThisSide(rect)) continue
      const corners = [
        at(rect.start),
        at({ x: rect.end.x, y: rect.start.y }),
        at(rect.end),
        at({ x: rect.start.x, y: rect.end.y })
      ]
      const solid = fillOf(rect.fill, 'rect', rect.strokeWidth)
      begin(rect, solid ? boxCenter(corners) : corners)
      if (solid) graphic(rect.layer, polyShape([corners]))
      stroke(rect.layer, [...corners, corners[0]], rect.strokeWidth, solid)
    }
    for (const poly of polys) {
      if (!onThisSide(poly)) continue
      const points = poly.points.map(at)
      if (points.length < 2) continue
      const solid = points.length >= 3 && fillOf(poly.fill, 'poly', poly.strokeWidth)
      begin(poly, solid ? boxCenter(points) : points)
      if (solid) graphic(poly.layer, polyShape([points]))
      stroke(poly.layer, [...points, points[0]], poly.strokeWidth, solid)
    }
  }
  const onTextLayer = (layer: string | undefined): layer is string =>
    withText && !!layer && onSide(layer)
  const text = (
    layer: string | undefined,
    content: string,
    position: Pt,
    angleDeg: number,
    effects: KicadFontEffects | undefined,
    raw: SExprNode,
    inFill = true
  ): void => {
    if (!onTextLayer(layer) || !content) return
    begin({ uuid: uuidOf(raw) })
    const laid = layText(content, position, angleDeg, effects)
    if (!laid) return
    const { shape, half, options } = laid
    // A TrueType text draws the outlines KiCad cached for it, not stroke glyphs.
    const glyphs = cachedOutlines(raw, content, angleDeg) ?? laid.glyphs
    const layerNode = raw.type === 'list' ? findChild(raw, 'layer') : null
    const knockout = !!layerNode && getAtomValues(layerNode).includes('knockout')
    const knockoutMargin = knockout ? Math.max(half, options.height / 9) : undefined
    push(layer, {
      drawing: 'text',
      net: 0,
      shape,
      glyphs,
      knockout,
      inFill,
      ...(knockoutMargin !== undefined ? { knockoutMargin } : {}),
      ...boxOfShape(shape)
    })
  }
  /**
   * A text box or table cell: its laid-out glyphs, and for a text box its
   * outline where it has a stroke. `at` maps its file points to the world,
   * `turn` is the footprint's rotation its angle adds to.
   */
  const textBox = (
    box: KicadFpTextBox,
    kind: 'textbox' | 'cell',
    at: (p: { x: Nm; y: Nm }) => Pt,
    turn: number,
    content: string,
    extra: Partial<Pick<BoardDrawing, 'inFill' | 'inCopperTree'>> = {}
  ): void => {
    if (!onTextLayer(box.layer)) return
    begin({ uuid: box.uuid })
    const laidOut = content ? textBoxText({ ...box, text: content }) : null
    const laid = laidOut
      ? layText(
          laidOut.text,
          at(laidOut.anchor as { x: Nm; y: Nm }),
          laidOut.angle + turn,
          laidOut.effects
        )
      : null
    const corners = textBoxCorners(box).map((p) => at(p as { x: Nm; y: Nm }))
    const edges = (halfWidth: number): CopperShape[] =>
      corners.map((a, i) => {
        const b = corners[(i + 1) % corners.length]
        return { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth }
      })
    const width = box.strokeWidth
    const outline =
      kind === 'textbox' && width !== undefined && width >= 0 ? edges(nmToMm(width) / 2) : []
    const parts = [...(laid?.glyphs ?? []), ...outline]
    if (corners.length < 3) return
    const fill: FillCut[] =
      kind === 'textbox'
        ? [
            { shape: polyShape([corners]), grows: false },
            ...(box.border
              ? edges(width !== undefined && width > 0 ? nmToMm(width) / 2 : 0).map((shape) => ({
                  shape,
                  grows: true
                }))
              : [])
          ]
        : []
    // An empty box is still an area to the filler; to DRC it is nothing.
    if (parts.length === 0 && fill.length === 0) return
    const shape: CopperShape = parts.length === 1 ? parts[0] : { kind: 'compound', parts }
    push(box.layer, {
      drawing: kind,
      net: 0,
      shape,
      fill,
      ...(kind === 'cell' ? { inFill: false } : {}),
      ...extra,
      ...boxOfShape({ kind: 'compound', parts: [...parts, polyShape([corners])] })
    })
  }
  /**
   * A table: to DRC its whole area and its rules, and each drawn cell's text an
   * item of its own; to the filler every cell's area and a border as wide as
   * the table's widest rule, grown by the clearance.
   */
  const table = (
    t: KicadTable,
    at: (p: { x: Nm; y: Nm }) => Pt,
    turn: number,
    expand: (text: string) => string
  ): void => {
    if (!onTextLayer(t.layer)) return
    const grid = tableGrid(t)
    if (!grid) return
    const inCopperTree = owner === undefined
    begin({ uuid: t.uuid })
    const area = tableCorners(t).map((p) => at(p as { x: Nm; y: Nm }))
    const rules: CopperShape[] = tableDrawing(t).strokes.flatMap((stroke) => {
      const points = stroke.points.map((p) => at(p as { x: Nm; y: Nm }))
      const ends = stroke.closed ? [...points, points[0]] : points
      return ends.slice(1).map((b, i): CopperShape => {
        const a = ends[i]
        return {
          kind: 'capsule',
          x0: a.x,
          y0: a.y,
          x1: b.x,
          y1: b.y,
          halfWidth: nmToMm(stroke.width as Nm) / 2
        }
      })
    })
    const widest = Math.max(
      0,
      t.separatorCols || t.separatorRows ? nmToMm(t.separatorStrokeWidth ?? (0 as Nm)) / 2 : 0,
      t.borderExternal || t.borderHeader ? nmToMm(t.borderStrokeWidth ?? (0 as Nm)) / 2 : 0
    )
    const fill: FillCut[] = t.cells.flatMap((cell) => {
      const corners = textBoxCorners(cell).map((p) => at(p as { x: Nm; y: Nm }))
      if (corners.length < 3) return []
      return [
        { shape: polyShape([corners]), grows: false },
        ...corners.map((a, i): FillCut => {
          const b = corners[(i + 1) % corners.length]
          return {
            shape: { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth: 0 },
            grows: true,
            extra: widest
          }
        })
      ]
    })
    const parts = area.length >= 3 ? [polyShape([area]), ...rules] : rules
    if (parts.length > 0) {
      const shape: CopperShape = { kind: 'compound', parts }
      push(t.layer, { drawing: 'table', net: 0, shape, fill, inCopperTree, ...boxOfShape(shape) })
    }
    const { xs, ys } = grid
    const columns = Math.max(1, t.columnCount)
    t.cells.forEach((cell, i) => {
      if (cell.colSpan <= 0 || cell.rowSpan <= 0) return
      const row = Math.floor(i / columns)
      const col = i % columns
      const right = Math.min(col + cell.colSpan, xs.length - 1)
      const bottom = Math.min(row + cell.rowSpan, ys.length - 1)
      const placed: KicadFpTextBox = {
        ...cell,
        layer: cell.layer ?? t.layer,
        start: { x: xs[col], y: ys[row] } as KicadFpTextBox['start'],
        end: { x: xs[right], y: ys[bottom] } as KicadFpTextBox['end'],
        points: undefined
      }
      textBox(placed, 'cell', at, turn, expand(cell.text), { inCopperTree })
    })
  }
  /**
   * A dimension, one item: each line a bare centerline (the filler cuts it at
   * the style's thickness), a leader's circular frame a disc, and its text.
   * Its points are the board's even inside a footprint.
   */
  const dimension = (dim: KicadDimension): void => {
    if (!onTextLayer(dim.layer)) return
    begin({ uuid: dim.uuid })
    const drawing: DrawingKind = dim.dimensionType === 'leader' ? 'leader' : 'dimension'
    const half = nmToMm(dim.style?.thickness ?? DEFAULT_DIMENSION_THICKNESS) / 2
    const geometry = dimensionGeometry(dim)
    for (const { a, b } of geometry.lines) {
      const [p, q] = [worldPoint(a as { x: Nm; y: Nm }), worldPoint(b as { x: Nm; y: Nm })]
      const shape: CopperShape = {
        kind: 'capsule',
        x0: p.x,
        y0: p.y,
        x1: q.x,
        y1: q.y,
        halfWidth: 0
      }
      const cut: CopperShape = { ...shape, halfWidth: half }
      push(dim.layer, {
        drawing,
        net: 0,
        shape,
        fill: [{ shape: cut, grows: true }],
        ...boxOfShape(cut)
      })
    }
    for (const { center, radius } of geometry.circles) {
      const c = worldPoint(center as { x: Nm; y: Nm })
      const shape: CopperShape = { kind: 'circle', cx: c.x, cy: c.y, r: nmToMm(radius as Nm) }
      const cut: CopperShape = { ...shape, r: shape.r + half }
      push(dim.layer, {
        drawing,
        net: 0,
        shape,
        fill: [{ shape: cut, grows: true }],
        ...boxOfShape(cut)
      })
    }
    const t = dim.text
    if (t?.text && t.position) {
      const laid = layText(t.text, worldPoint(t.position), t.position.angle ?? 0, t.fontEffects)
      if (laid)
        push(dim.layer, {
          drawing,
          net: 0,
          shape: laid.shape,
          glyphs: laid.glyphs,
          ...boxOfShape(laid.shape)
        })
    }
  }
  shapes(
    worldPoint,
    board.grLines,
    board.grArcs,
    board.grCircles,
    board.grRects,
    board.grPolys,
    board.grCurves
  )
  // KiCad shows a hidden board text: `hide` is a footprint text's alone.
  for (const t of board.grTexts) {
    if (!t.position) continue
    const content = expandBoardText(t.text, board, t.layer, variables)
    text(t.layer, content, worldPoint(t.position), t.position.angle ?? 0, t.fontEffects, t._raw)
  }
  const boardText = (layer: string | undefined) => (content: string) =>
    expandBoardText(content, board, layer, variables)
  for (const box of board.grTextBoxes)
    textBox(box, 'textbox', worldPoint, 0, boardText(box.layer)(box.text))
  for (const t of board.tables) table(t, worldPoint, 0, boardText(t.layer))
  for (const dim of board.dimensions) dimension(dim)
  board.footprints.forEach((bfp, fpIndex) => {
    owner = fpIndex
    const tf = footprintTransform(bfp)
    const at = (p: { x: Nm; y: Nm }): Pt => tfPoint(tf, p.x, p.y)
    const fp = bfp.footprint
    const scope = {
      name: fp.name,
      layer: fp.layer,
      reference: getReference(fp),
      value: getValue(fp)
    }
    shapes(at, fp.fpLines, fp.fpArcs, fp.fpCircles, fp.fpRects, fp.fpPolys, fp.fpCurves)
    // Every visible field is copper to DRC; the filler cuts only the reference and value.
    for (const property of fp.properties) {
      if (property.hide || !property.position) continue
      text(
        property.layer,
        expandFootprintText(property.value, scope),
        at(property.position),
        footprintTextDrawAngle(property.position.angle, property.keepUpright),
        property.fontEffects,
        property._raw,
        property.key === 'Reference' || property.key === 'Value'
      )
    }
    for (const t of fp.fpTexts) {
      if (t.hide || !t.position) continue
      text(
        t.layer,
        expandFootprintText(t.text, scope),
        at(t.position),
        footprintTextDrawAngle(t.position.angle, t.keepUpright),
        t.fontEffects,
        t._raw
      )
    }
    const turn = bfp.position.angle ?? 0
    const expand = (content: string): string => expandFootprintText(content, scope)
    for (const box of fp.fpTextBoxes) textBox(box, 'textbox', at, turn, expand(box.text))
    for (const t of fp.tables) table(t, at, turn, expand)
    for (const dim of fp.dimensions) dimension(dim)
  })
  drawingCache.set(board, [
    ...entries,
    { variables, withText, side: side === 'copper' ? side : side.layer, byLayer }
  ])
  return byLayer
}

/**
 * A text laid out at a world position: its glyphs, each a capsule its pen
 * wide, and its box — the glyphs' extent in the text's own frame, strokes'
 * round ends included, turned with it. Null when it draws nothing.
 */
function layText(
  content: string,
  position: Pt,
  angleDeg: number,
  effects: KicadFontEffects | undefined
): {
  shape: Extract<CopperShape, { kind: 'rrect' }>
  glyphs: CopperShape[]
  half: number
  options: ReturnType<typeof strokeOptionsFromEffects>
} | null {
  const options = strokeOptionsFromEffects(effects)
  const { strokes } = getTextStrokes(content, options)
  if (strokes.length === 0) return null
  const angle = (angleDeg * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const place = (x: number, y: number): Pt => ({
    x: position.x + x * cos - y * sin,
    y: position.y + x * sin + y * cos
  })
  const half = options.thickness / 2
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of strokes) {
    minX = Math.min(minX, s.x1, s.x2)
    minY = Math.min(minY, s.y1, s.y2)
    maxX = Math.max(maxX, s.x1, s.x2)
    maxY = Math.max(maxY, s.y1, s.y2)
  }
  const center = place((minX + maxX) / 2, (minY + maxY) / 2)
  const shape = {
    kind: 'rrect' as const,
    cx: center.x,
    cy: center.y,
    halfW: (maxX - minX) / 2 + half,
    halfH: (maxY - minY) / 2 + half,
    cornerR: 0,
    rotation: angle
  }
  const glyphs: CopperShape[] = strokes.map((st) => {
    const a = place(st.x1, st.y1)
    const b = place(st.x2, st.y2)
    return { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth: half }
  })
  return { shape, glyphs, half, options }
}

/**
 * A TrueType text's glyph outlines as KiCad cached them (`render_cache`),
 * board-absolute, each glyph a filled polygon: what KiCad measures, while the
 * cache still holds the text and angle shown. Null for a stroke-font text.
 */
function cachedOutlines(raw: SExprNode, content: string, angleDeg: number): CopperShape[] | null {
  const cache = raw.type === 'list' ? findChild(raw, 'render_cache') : null
  if (!cache) return null
  const [text, angle] = getAtomValues(cache)
  if (text !== content || Math.abs(Number(angle ?? 0) - angleDeg) > 1e-6) return null
  const glyphs: CopperShape[] = []
  for (const polygon of findChildren(cache, 'polygon')) {
    const rings = findChildren(polygon, 'pts')
      .map((pts) =>
        findChildren(pts, 'xy').map((xy) => {
          const [x, y] = getAtomValues(xy)
          return { x: Number(x), y: -Number(y) }
        })
      )
      .filter((ring) => ring.length >= 3)
    if (rings.length) glyphs.push(polyShape(rings))
  }
  return glyphs.length ? glyphs : null
}

/** A drawing's `(uuid …)` (or a pre-v6 file's `(tstamp …)`). */
function uuidOf(raw: SExprNode): string | undefined {
  if (raw.type !== 'list') return undefined
  const node = findChild(raw, 'uuid') ?? findChild(raw, 'tstamp')
  return node ? (getAtomValues(node)[0] ?? undefined) : undefined
}

const drawingCache = new WeakMap<
  KicadBoard,
  Array<{
    variables: Readonly<Record<string, string>>
    withText: boolean
    /** 'copper', or the one other layer read. */
    side: string
    byLayer: Map<string, BoardDrawing[]>
  }>
>()

function boxOfShape(shape: CopperShape): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  switch (shape.kind) {
    case 'capsule':
      return {
        minX: Math.min(shape.x0, shape.x1) - shape.halfWidth,
        minY: Math.min(shape.y0, shape.y1) - shape.halfWidth,
        maxX: Math.max(shape.x0, shape.x1) + shape.halfWidth,
        maxY: Math.max(shape.y0, shape.y1) + shape.halfWidth
      }
    case 'poly':
      return { minX: shape.minX, minY: shape.minY, maxX: shape.maxX, maxY: shape.maxY }
    case 'rrect': {
      const ex =
        Math.abs(shape.halfW * Math.cos(shape.rotation)) +
        Math.abs(shape.halfH * Math.sin(shape.rotation))
      const ey =
        Math.abs(shape.halfW * Math.sin(shape.rotation)) +
        Math.abs(shape.halfH * Math.cos(shape.rotation))
      return { minX: shape.cx - ex, minY: shape.cy - ey, maxX: shape.cx + ex, maxY: shape.cy + ey }
    }
    case 'circle':
      return {
        minX: shape.cx - shape.r,
        minY: shape.cy - shape.r,
        maxX: shape.cx + shape.r,
        maxY: shape.cy + shape.r
      }
    case 'compound': {
      const boxes = shape.parts.map(boxOfShape)
      return {
        minX: Math.min(...boxes.map((b) => b.minX)),
        minY: Math.min(...boxes.map((b) => b.minY)),
        maxX: Math.max(...boxes.map((b) => b.maxX)),
        maxY: Math.max(...boxes.map((b) => b.maxY))
      }
    }
    default:
      throw new Error(`copper drawing of kind ${shape.kind}`)
  }
}
