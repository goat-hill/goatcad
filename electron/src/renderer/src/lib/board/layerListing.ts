/**
 * What an editor's Layers panel lists — the same whether the panel is in the
 * right bar or behind the active-layer pill in the viewport's corner, so the
 * two cannot list different layers.
 */

import { KICAD_LAYER_COLORS } from '../kicad/layers'
import { buildLayerPresets, type LayerPreset, type LayerPresetKey } from './layerPresets'
import type { KicadBoard } from '../kicad/board'

export interface LayerListing {
  /** In panel order; `title` is the board's own name for the layer, where it has one. */
  layers: Array<{ name: string; title?: string }>
  /** Layers that can be made active; absent means all of them. */
  activatable?: string[]
  presets: LayerPreset[]
}

/** A board's layer table, less the layers the palette does not draw. */
export function boardLayerListing(
  board: KicadBoard | null,
  presetLabel: (key: LayerPresetKey) => string
): LayerListing {
  const shown = (board?.layers ?? []).filter((l) => KICAD_LAYER_COLORS[l.name] !== undefined)
  const names = shown.map((l) => l.name)
  return {
    layers: shown.map((l) => ({ name: l.name, title: l.userName })),
    activatable: names,
    presets: buildLayerPresets(names, presetLabel)
  }
}

/** The footprint editor's fixed set, front then back. */
const FOOTPRINT_LAYERS = [
  'F.SilkS',
  'F.Paste',
  'F.Cu',
  'F.Mask',
  'F.Fab',
  'F.CrtYd',
  'B.SilkS',
  'B.Paste',
  'B.Cu',
  'B.Mask',
  'B.Fab',
  'B.CrtYd'
]

export function footprintLayerListing(presetLabel: (key: LayerPresetKey) => string): LayerListing {
  return {
    layers: FOOTPRINT_LAYERS.map((name) => ({ name })),
    presets: buildLayerPresets(FOOTPRINT_LAYERS, presetLabel)
  }
}

/** The name a layer goes by in a listing: the board's own, else its canonical one. */
export const layerTitle = (listing: LayerListing, layer: string): string =>
  listing.layers.find((l) => l.name === layer)?.title ?? layer
