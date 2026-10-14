/**
 * The layer lists `render.board`'s `preset` names, expanded against one board.
 *
 * Fixed lists, so a picture made from a preset is the same picture on every
 * board but for the inner copper a board has. The membership is stated in the
 * op's argument description (`main/ops/render/board.ts`); change both together.
 */
import type { McpRenderBoardPreset } from '../../../../preload/mcpTypes'
import { COPPER_LAYERS } from '../kicad/layers'

/** Front placement: copper, silk, fab bodies and courtyards. Mask and paste only repaint the pads. */
const FRONT = ['F.Cu', 'F.SilkS', 'F.Fab', 'F.CrtYd', 'Edge.Cuts']
const BACK = ['B.Cu', 'B.SilkS', 'B.Fab', 'B.CrtYd', 'Edge.Cuts']
/** Silkscreen review: both sides, pads as their mask openings — what silk must stay off — and no tracks. */
const SILK = [
  'F.SilkS',
  'B.SilkS',
  'F.Fab',
  'B.Fab',
  'F.CrtYd',
  'B.CrtYd',
  'F.Mask',
  'B.Mask',
  'Edge.Cuts'
]

/**
 * The layers a preset draws on a board with these layer names, or null for
 * `all`, which draws every layer.
 */
export const boardRenderPresetLayers = (
  preset: McpRenderBoardPreset,
  boardLayerNames: readonly string[]
): string[] | null => {
  switch (preset) {
    case 'front':
      return [...FRONT]
    case 'back':
      return [...BACK]
    case 'silk':
      return [...SILK]
    case 'copper': {
      const enabled = new Set(boardLayerNames)
      const copper = COPPER_LAYERS.filter((layer) => enabled.has(layer))
      return [...(copper.length ? copper : ['F.Cu', 'B.Cu']), 'Edge.Cuts']
    }
    case 'all':
      return null
  }
}
