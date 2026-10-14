/**
 * The footprint editor's insert tools, on the board's gesture machinery: a
 * line, arc, rectangle, circle and polygon are the same gestures on a
 * footprint as on a board, so `pcbTools` owns what the points mean; a pad and
 * a text are one click, and so are the two pickers — Place Footprint Anchor
 * and the grid origin — which act where the click lands and put themselves
 * away (the editor's `handleToolClick`).
 */
import type { PcbTool } from '../board/pcbTools'

export type FootprintTool =
  | 'select'
  | 'pad'
  | 'line'
  | 'arc'
  | 'rectangle'
  | 'circle'
  | 'polygon'
  | 'bezier'
  | 'text'
  | 'textBox'
  | 'point'
  | 'anchor'
  | 'gridOrigin'

/**
 * The tools that borrow a board tool's gesture and shape: the shapes, the
 * text box (two corners, as a rectangle) and the point (a one-click drop).
 */
const GESTURE_TOOLS: ReadonlySet<FootprintTool> = new Set<FootprintTool>([
  'line',
  'arc',
  'rectangle',
  'circle',
  'polygon',
  'bezier',
  'textBox',
  'point'
])

/** The board tool whose gesture and shape a footprint tool borrows, or null for a one-click drop. */
export const footprintGestureTool = (tool: FootprintTool): PcbTool | null =>
  GESTURE_TOOLS.has(tool) ? (tool as PcbTool) : null
