/**
 * A sheet's free graphics — rectangles, polylines, circles, arcs, beziers and
 * rule-area outlines — as the shared graphic model (`SymbolGraphic`, in sheet
 * space: nm, y-down) plus the node that writes them. What lets the schematic
 * editor reuse the symbol editor's handles, property rows and writers
 * (`symbol/graphicEdit.ts`, `symbol/symbolEdit.ts`) rather than keep its own.
 */
import type { KicadSchematic, KicadSchematicShape, SymbolGraphic } from '../kicad/schematic'
import { findChild, type SExprList } from '../kicad/sexpr'

export const SHEET_GRAPHIC_TYPES = [
  'shape',
  'polyline',
  'circle',
  'arc',
  'bezier',
  'rule_area'
] as const

export type SheetGraphicType = (typeof SHEET_GRAPHIC_TYPES)[number]

export const isSheetGraphicType = (type: unknown): type is SheetGraphicType =>
  (SHEET_GRAPHIC_TYPES as readonly unknown[]).includes(type)

/**
 * The panel groups sheet graphics fall into (`graphicGroups` names one per
 * primitive type). Never `text`/`textBox`: those are the sheet's own items.
 */
export const SHEET_GRAPHIC_GROUPS: ReadonlySet<string> = new Set([
  'rectangle',
  'line',
  'bezier',
  'circle',
  'arc'
])

/** A sheet rectangle as the graphic model. */
export const shapeGraphic = (shape: KicadSchematicShape): SymbolGraphic => ({
  type: 'rectangle',
  start: shape.start,
  end: shape.end,
  stroke: { width: shape.strokeWidth, type: shape.strokeType, color: shape.strokeColor },
  fill: shape.fill,
  fillColor: shape.fillColor
})

export interface SheetGraphic {
  graphic: SymbolGraphic
  /** The node a graphic write edits: a rule area's is the polyline inside it. */
  node: SExprList
}

/** One free sheet graphic by its item ref, or null when the ref names none. */
export function sheetGraphicOf(
  doc: KicadSchematic,
  ref: { type: string; index: number }
): SheetGraphic | null {
  if (!isSheetGraphicType(ref.type)) return null
  if (ref.type === 'shape') {
    const shape = doc.shapes[ref.index]
    return shape ? { graphic: shapeGraphic(shape), node: shape._node } : null
  }
  if (ref.type === 'rule_area') {
    const area = doc.ruleAreas[ref.index]
    const node = area ? findChild(area._node, 'polyline') : undefined
    return area && node ? { graphic: area.graphic, node } : null
  }
  const entry = {
    polyline: doc.polylines,
    circle: doc.circles,
    arc: doc.arcs,
    bezier: doc.beziers
  }[ref.type][ref.index]
  return entry ? { graphic: entry.graphic, node: entry._node } : null
}
