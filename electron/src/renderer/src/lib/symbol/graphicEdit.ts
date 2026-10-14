/**
 * Editing one graphic primitive — rectangle, polyline, circle, arc, bezier,
 * text, text box — wherever it lives. A symbol's body and a sheet's free
 * graphics share the model (`SymbolGraphic`) and the S-expression shape, so the
 * symbol editor and the schematic editor share this too: the handles a selected
 * graphic carries and the write a property row makes.
 *
 * Coordinates stay in the graphic's own space (symbol y-up, sheet y-down);
 * callers map to the engine through `toEngine`.
 */
import { strokeOptionsFromTextEffects } from '../kicad/newstroke'
import { mmToNm, nm } from '../kicad/coordinates'
import type { SymbolGraphic } from '../kicad/schematic'
import type { SExprList } from '../kicad/sexpr'
import type { PropertyEditValue } from '../propertyTable'
import type { VertexHandleSpec } from '../engine/VertexHandles'
import {
  graphicExtentPoints,
  graphicVertexPoints,
  setGraphicVertex,
  updateArc,
  updateCircle,
  updatePolyline,
  updateRectangle,
  updateSymbolText,
  updateSymbolTextBox,
  type ArcPatch,
  type CirclePatch,
  type GraphicStylePatch,
  type Point2,
  type RectanglePatch,
  type TextBoxPatch,
  type TextPatch
} from './symbolEdit'

/**
 * Where a graphic's handles belong, and what each one writes back: every
 * vertex (`data` plus its `vertexIndex`, indexed like `setGraphicVertex`), and
 * for an outline-only shape a center grab. A live resize re-reads these off the
 * previewed shape, so the handle under the cursor and the geometry it reshapes
 * cannot describe different positions.
 */
export function graphicHandleSpecs(
  graphic: SymbolGraphic,
  toEngine: (point: Point2) => { x: number; y: number },
  data: Record<string, unknown>
): VertexHandleSpec[] {
  // A text is positioned by one stored point, so that point is the whole
  // control: an ANCHOR handle, dragged to move the text. A square would promise
  // a resize the write does not perform.
  if (graphic.type === 'text') return [{ ...toEngine(graphic.position), role: 'anchor', data }]
  const specs: VertexHandleSpec[] = graphicVertexPoints(graphic).map((point, vertexIndex) => ({
    ...toEngine(point),
    // A circle's vertex 0 is its `(center …)`: writing it MOVES the circle, so
    // it is a move handle and only the rim resizes.
    ...(graphic.type === 'circle' && vertexIndex === 0 ? { role: 'move' as const } : {}),
    data: { ...data, vertexIndex }
  }))
  // A shape hit-tested by its OUTLINE needs a way to grab its middle: the
  // center of its own extent, invented for the grab and stored nowhere. A
  // circle already has one (its center) and a text box's hit-test covers its
  // interior.
  if (graphic.type !== 'textBox' && graphic.type !== 'circle') {
    const points = graphicExtentPoints(graphic)
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    specs.push({
      ...toEngine({
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2
      }),
      role: 'move',
      data
    })
  }
  return specs
}

/** A curve's end rows → which of its points they write. */
const BEZIER_ENDS: Record<string, { end: 'start' | 'end'; axis: 'x' | 'y' }> = {
  startX: { end: 'start', axis: 'x' },
  startY: { end: 'start', axis: 'y' },
  endX: { end: 'end', axis: 'x' },
  endY: { end: 'end', axis: 'y' }
}

/**
 * Panel row → patch field. Most rows ARE their patch field. The exceptions
 * read the graphic they edit: a rectangle's Width / Height move its far corner
 * from its start; a curve's Start / End rows write a whole point (the other
 * axis kept) as `{ vertex, x, y }`, for `setGraphicVertex`; and `thicknessAuto` is a
 * checkbox over the PRESENCE of `(font (thickness …))`, so it maps to null
 * (remove) or to the weight currently being drawn — writing that on the way out
 * of Auto is what keeps the picture unchanged when the checkbox changes.
 */
export const graphicPatchFor = (
  key: string,
  value: PropertyEditValue,
  graphic?: SymbolGraphic
): Record<string, PropertyEditValue | null> => {
  const n = typeof value === 'number' ? value : Number(value) || 0
  if (graphic?.type === 'rectangle' && key === 'rectWidth') return { endX: graphic.start.x + n }
  if (graphic?.type === 'rectangle' && key === 'rectHeight') return { endY: graphic.start.y + n }
  const bezierEnd = BEZIER_ENDS[key]
  if (graphic?.type === 'bezier' && bezierEnd && graphic.points.length) {
    const index = bezierEnd.end === 'start' ? 0 : graphic.points.length - 1
    const point = { ...graphic.points[index], [bezierEnd.axis]: n }
    return { vertex: index, x: point.x, y: point.y }
  }
  if (key !== 'thicknessAuto') return { [key]: value }
  if (value) return { thickness: null }
  const effects = graphic && 'effects' in graphic ? graphic.effects : null
  // The layout answers in mm; the patch (like the file) carries nm.
  return effects ? { thickness: mmToNm(strokeOptionsFromTextEffects(effects).thickness) } : {}
}

/** Apply a graphic panel edit to one node, dispatched by its primitive type. */
export const applyGraphicEdit = (
  type: SymbolGraphic['type'] | string,
  node: SExprList,
  patch: Record<string, PropertyEditValue | null>
): void => {
  if (type === 'rectangle') updateRectangle(node, patch as RectanglePatch)
  else if (type === 'circle') updateCircle(node, patch as CirclePatch)
  else if (type === 'arc') updateArc(node, patch as ArcPatch)
  else if (type === 'text') updateSymbolText(node, patch as TextPatch)
  else if (type === 'textBox') updateSymbolTextBox(node, patch as TextBoxPatch)
  else if (type === 'bezier' && typeof patch.vertex === 'number')
    setGraphicVertex(node, patch.vertex, { x: nm(Number(patch.x)), y: nm(Number(patch.y)) })
  else updatePolyline(node, patch as GraphicStylePatch)
}
