/**
 * Tool model for the board editor's canvas tools.
 *
 * The same shape as `symbolTools.ts`: one pure definition per tool, used
 * twice — once to build the placement preview, once to build the items
 * actually inserted — so a preview that doesn't match what lands cannot
 * happen. Click-folding rules come from the shared `toolGesture.ts`.
 *
 * Coordinates are deliberately space-agnostic: every function is plain point
 * math, valid in scene space (y up, for previews) and KiCad space (y down,
 * for commits) alike. The editor converts between the two at its boundaries.
 * `route` and `via` are declared here for completeness but keep their own
 * interactive logic in `PcbEditor` — a route commits a segment per click and
 * inherits nets, which is not a shape gesture.
 */

import {
  gestureClick,
  gestureFinish,
  type GestureResult,
  type Point2,
  type ToolGesture
} from '../toolGesture'
import { mmToNm, nm, nmToMm, pointsEqualNm, type Nm } from '../kicad/coordinates'
import { isCopperLayer } from '../kicad/layers'
import { LINE_MODES, nextLineMode, type LineMode } from '../lineMode'
import { bezierDraft } from '../schematic/drawTools'
import { bezierCurvePoints } from '../kicad/schematic'

export type { Point2 }

export type PcbTool =
  | 'select'
  | 'route'
  | 'via'
  | 'line'
  | 'arc'
  | 'rectangle'
  | 'circle'
  | 'polygon'
  | 'bezier'
  | 'text'
  | 'textBox'
  | 'point'
  | 'zone'
  // Lands the library footprint in hand at each click (lib/board/footprintPlace.ts).
  | 'footprint'
  // Pickers: one click places the board's grid or drill / place file origin.
  | 'gridOrigin'
  | 'drillOrigin'

/** The shape tools this module's gesture/commit pipeline drives. */
export const GRAPHIC_TOOLS: readonly PcbTool[] = [
  'line',
  'arc',
  'rectangle',
  'circle',
  'polygon',
  'bezier',
  'text',
  'textBox',
  'point'
]

export const isGraphicTool = (tool: PcbTool): boolean => GRAPHIC_TOOLS.includes(tool)

/**
 * Tools the click-gesture pipeline drives: the graphics set plus the zone
 * tool, whose outline is drawn exactly like a polygon but commits a copper
 * zone rather than a gr_poly.
 */
export const isGestureTool = (tool: PcbTool): boolean => isGraphicTool(tool) || tool === 'zone'

/**
 * The chain tools the line mode constrains (`lib/lineMode.ts`). Rectangles and
 * circles stay free, as KiCad's do; an arc's angle snap is not taken yet.
 */
export const takesLineMode = (tool: PcbTool | null): boolean =>
  tool === 'line' || tool === 'polygon' || tool === 'zone'

export const pcbToolGesture = (tool: PcbTool): ToolGesture => {
  switch (tool) {
    case 'rectangle':
    case 'circle':
    case 'arc':
    case 'bezier':
    case 'textBox':
      return 'span'
    case 'line':
    case 'polygon':
    case 'zone':
    case 'route':
      return 'chain'
    // `select` places nothing; naming it a drop keeps this total.
    case 'via':
    case 'text':
    case 'point':
    case 'select':
    case 'footprint':
    case 'gridOrigin':
    case 'drillOrigin':
      return 'drop'
  }
}

export const pcbToolPointCount = (tool: PcbTool): number => {
  switch (pcbToolGesture(tool)) {
    case 'drop':
      return 1
    case 'chain':
      return Infinity
    case 'span':
      return tool === 'arc' ? 3 : tool === 'bezier' ? 4 : 2
  }
}

export function pcbToolClick(tool: PcbTool, draft: Point2[], point: Point2): GestureResult {
  if (tool === 'select') return { draft: [], commit: null }
  return gestureClick(pcbToolGesture(tool), pcbToolPointCount(tool), draft, point)
}

export function pcbToolFinish(tool: PcbTool, draft: Point2[]): GestureResult {
  if (tool === 'select') return { draft, commit: null }
  return gestureFinish(pcbToolGesture(tool), draft)
}

// ---------------------------------------------------------------------------
// Route corner posture
// ---------------------------------------------------------------------------

/**
 * The angles a route's corners take: the line modes' (`lib/lineMode.ts`).
 * The route's setting is the router's own (`routeCorner`, lib/pcbRouter.ts),
 * apart from the graphics tools' line mode, as KiCad keeps them.
 */
export type RouteCornerMode = LineMode

export const ROUTE_CORNER_MODES: readonly RouteCornerMode[] = LINE_MODES

export const nextRouteCornerMode = nextLineMode

/**
 * The corner a route inserts between its tail and the cursor: `[corner, to]`,
 * or just `[to]` when the pair needs none (collinear, axis-aligned, or free
 * angle). `diagonalFirst` is the posture `/` toggles — the 45° diagonal (or
 * the 90° elbow's first leg) leaves from the tail rather than arriving at the
 * cursor. Space-agnostic like everything here; a 45° diagonal is a 45°
 * diagonal under y-flip.
 */
export function routeElbow(
  mode: RouteCornerMode,
  diagonalFirst: boolean,
  from: Point2,
  to: Point2
): Point2[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (mode === 'free' || dx === 0 || dy === 0) return [{ ...to }]
  if (mode === '90') {
    const corner = diagonalFirst ? { x: to.x, y: from.y } : { x: from.x, y: to.y }
    return [corner, { ...to }]
  }
  // 45°: the diagonal leg covers the smaller extent; the remainder runs
  // axis-aligned. Equal extents are a single pure diagonal.
  const run = Math.min(Math.abs(dx), Math.abs(dy))
  if (Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-9) return [{ ...to }]
  const sx = Math.sign(dx)
  const sy = Math.sign(dy)
  const corner = diagonalFirst
    ? { x: from.x + sx * run, y: from.y + sy * run }
    : { x: to.x - sx * run, y: to.y - sy * run }
  return [corner, { ...to }]
}

/**
 * The copper layer `steps` positions away in stack order, clamped at the
 * ends — KiCad's `+`/`-` layer walk. `copperLayers` is the board's copper in
 * file (= stack) order.
 */
export function stepCopperLayer(
  copperLayers: readonly string[],
  current: string,
  steps: number
): string {
  if (copperLayers.length === 0) return current
  const at = copperLayers.indexOf(current)
  const from = at >= 0 ? at : 0
  const to = Math.max(0, Math.min(copperLayers.length - 1, from + steps))
  return copperLayers[to]
}

// ---------------------------------------------------------------------------
// Layer-class drawing defaults
// ---------------------------------------------------------------------------

/** What a fresh graphic/text on a layer is drawn with (integer nm). */
export interface GraphicDefaults {
  lineWidth: Nm
  textSize: Nm
  textThickness: Nm
}

/**
 * KiCad's own per-layer-class defaults (board_design_settings: the
 * silk/copper/edge/courtyard/other classes), so a line drawn on Edge.Cuts is
 * the hairline a KiCad user expects and silk text arrives legible. Board
 * Setup's Text & Graphics defaults page would make these editable; until it
 * exists these constants are the whole story.
 */
export function graphicDefaults(layer: string): GraphicDefaults {
  if (isCopperLayer(layer))
    return { lineWidth: mmToNm(0.2), textSize: mmToNm(1.5), textThickness: mmToNm(0.3) }
  if (layer === 'Edge.Cuts' || layer.endsWith('.CrtYd')) {
    return { lineWidth: mmToNm(0.05), textSize: mmToNm(1.0), textThickness: mmToNm(0.15) }
  }
  if (layer.endsWith('.SilkS'))
    return { lineWidth: mmToNm(0.1), textSize: mmToNm(1.0), textThickness: mmToNm(0.1) }
  return { lineWidth: mmToNm(0.1), textSize: mmToNm(1.0), textThickness: mmToNm(0.15) }
}

// ---------------------------------------------------------------------------
// Committed points → the shape a tool places
// ---------------------------------------------------------------------------

/**
 * Extent two points must span before they describe a shape at all —
 * the same guard, for the same reason, as the symbol tools': below it the
 * cursor is still sitting on its anchor and there is nothing to draw.
 */
const MIN_SPAN = mmToNm(0.01)

export type PcbToolShape =
  | { kind: 'lines'; segments: Array<{ start: Point2; end: Point2 }> }
  | { kind: 'arc'; start: Point2; mid: Point2; end: Point2 }
  | { kind: 'rect'; start: Point2; end: Point2 }
  | { kind: 'circle'; center: Point2; end: Point2 }
  | { kind: 'poly'; points: Point2[] }
  | { kind: 'text'; position: Point2 }
  | { kind: 'bezier'; points: [Point2, Point2, Point2, Point2] }
  | { kind: 'textBox'; start: Point2; end: Point2 }
  | { kind: 'point'; position: Point2 }

/**
 * The shape `tool` describes with the points it has collected — the committed
 * clicks, optionally followed by the live cursor while previewing — or null
 * while they describe nothing yet. One function serves preview and commit, so
 * the two cannot disagree.
 *
 * Rules worth naming:
 * - `line` is a chain of independent segments: boards have no polyline node,
 *   so each pair becomes its own `gr_line`. Zero-length steps are dropped.
 * - `polygon` closed by clicking the start carries that point twice (the
 *   gesture keeps it); `gr_poly` outlines are implicitly closed, so the
 *   duplicate is dropped here rather than written.
 * - `arc` is clicked start → end → bulge (ends before shape, KiCad's order);
 *   the file stores start/mid/end, and with no bulge yet the mid sits on the
 *   chord so the preview is the straight line it currently is.
 * - `rect` corners are normalized to (min, min) → (max, max) so either drag
 *   direction writes the same file; a text box is drawn the same way.
 * - `bezier` is clicked start → end → first control → second control, KiCad's
 *   order (`bezierDraft`); the file stores start, controls, end.
 */
export function pcbToolShape(tool: PcbTool, points: Point2[]): PcbToolShape | null {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return null
  switch (tool) {
    case 'line': {
      const segments: Array<{ start: Point2; end: Point2 }> = []
      for (let i = 0; i < points.length - 1; i++) {
        if (!pointsEqualNm(points[i], points[i + 1])) {
          segments.push({ start: { ...points[i] }, end: { ...points[i + 1] } })
        }
      }
      return segments.length > 0 ? { kind: 'lines', segments } : null
    }
    case 'polygon':
    case 'zone': {
      const outline = points.slice()
      if (outline.length >= 2 && pointsEqualNm(outline[0], outline[outline.length - 1])) {
        outline.pop()
      }
      if (outline.length < 3) return null
      return { kind: 'poly', points: outline.map((p) => ({ ...p })) }
    }
    case 'rectangle':
    case 'textBox': {
      if (Math.abs(last.x - first.x) < MIN_SPAN || Math.abs(last.y - first.y) < MIN_SPAN) {
        return null
      }
      return {
        kind: tool === 'textBox' ? 'textBox' : 'rect',
        start: { x: Math.min(first.x, last.x), y: Math.min(first.y, last.y) },
        end: { x: Math.max(first.x, last.x), y: Math.max(first.y, last.y) }
      }
    }
    case 'circle': {
      // Center → rim, the pair KiCad stores. Quantized so the preview radius
      // is bit-for-bit the committed one, not a neighbor.
      if (Math.hypot(last.x - first.x, last.y - first.y) < MIN_SPAN) return null
      return {
        kind: 'circle',
        center: { ...first },
        end: { x: nm(last.x), y: nm(last.y) }
      }
    }
    case 'arc': {
      const end = points.length >= 3 ? points[1] : last
      const bulge = points.length >= 3 ? last : undefined
      if (Math.hypot(end.x - first.x, end.y - first.y) < MIN_SPAN) return null
      const mid = bulge ?? {
        x: nm((first.x + end.x) / 2),
        y: nm((first.y + end.y) / 2)
      }
      return { kind: 'arc', start: { ...first }, mid: { ...mid }, end: { ...end } }
    }
    case 'bezier': {
      const curve = points.length >= 2 ? bezierDraft(points.slice(0, -1), last) : null
      if (!curve) return null
      const [a, b, c, d] = curve
      return { kind: 'bezier', points: [{ ...a }, { ...b }, { ...c }, { ...d }] }
    }
    case 'text':
      return { kind: 'text', position: { ...last } }
    case 'point':
      return { kind: 'point', position: { ...last } }
    case 'select':
    case 'route':
    case 'via':
    case 'footprint':
    case 'gridOrigin':
    case 'drillOrigin':
      return null
  }
}

// ---------------------------------------------------------------------------
// Shape → preview primitives
// ---------------------------------------------------------------------------

/** Renderer-agnostic primitives a shape previews as. */
export interface ToolPreviewPrimitives {
  segments: Array<{ start: Point2; end: Point2 }>
  rings: Array<{ center: Point2; radius: number }>
  arcs: Array<{ start: Point2; mid: Point2; end: Point2 }>
}

/**
 * Decompose a shape into the stroke primitives the scene can draw haloed
 * under the cursor. Text has no ghost (its size is a property, the cursor
 * owns its anchor), so it decomposes to nothing.
 */
export function shapePreviewPrimitives(shape: PcbToolShape): ToolPreviewPrimitives {
  const none: ToolPreviewPrimitives = { segments: [], rings: [], arcs: [] }
  switch (shape.kind) {
    case 'lines':
      return { ...none, segments: shape.segments }
    case 'poly': {
      const segments: ToolPreviewPrimitives['segments'] = []
      for (let i = 0; i < shape.points.length; i++) {
        segments.push({ start: shape.points[i], end: shape.points[(i + 1) % shape.points.length] })
      }
      return { ...none, segments }
    }
    case 'rect':
    case 'textBox': {
      const { start: a, end: b } = shape
      return {
        ...none,
        segments: [
          { start: { x: a.x, y: a.y }, end: { x: b.x, y: a.y } },
          { start: { x: b.x, y: a.y }, end: { x: b.x, y: b.y } },
          { start: { x: b.x, y: b.y }, end: { x: a.x, y: b.y } },
          { start: { x: a.x, y: b.y }, end: { x: a.x, y: a.y } }
        ]
      }
    }
    case 'circle':
      return {
        ...none,
        rings: [
          {
            center: shape.center,
            radius: Math.hypot(shape.end.x - shape.center.x, shape.end.y - shape.center.y)
          }
        ]
      }
    case 'arc':
      return { ...none, arcs: [{ start: shape.start, mid: shape.mid, end: shape.end }] }
    case 'bezier': {
      const line = bezierCurvePoints(shape.points)
      const segments: ToolPreviewPrimitives['segments'] = []
      for (let i = 0; i < line.length - 1; i++) segments.push({ start: line[i], end: line[i + 1] })
      return { ...none, segments }
    }
    case 'text':
    case 'point':
      return none
  }
}

/**
 * Preview primitives carried from the domain (integer nm, y down) into the
 * scene a viewport draws in (mm, y up). The draft, the cursor joined to it and
 * the stroke width are all domain values; this is the one crossing, so a
 * viewport cannot hand the scene a nanometre and have it read as a millimetre.
 */
export function previewToScene(primitives: ToolPreviewPrimitives): ToolPreviewPrimitives {
  const at = (p: Point2): Point2 => ({ x: nmToMm(p.x as Nm), y: -nmToMm(p.y as Nm) })
  return {
    segments: primitives.segments.map((s) => ({ start: at(s.start), end: at(s.end) })),
    rings: primitives.rings.map((r) => ({ center: at(r.center), radius: nmToMm(r.radius as Nm) })),
    arcs: primitives.arcs.map((a) => ({ start: at(a.start), mid: at(a.mid), end: at(a.end) }))
  }
}
