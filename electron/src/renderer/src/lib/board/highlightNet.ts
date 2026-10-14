// Highlight Net (`): which net a press of the key picks, as KiCad's
// `BOARD_INSPECTION_TOOL::highlightNet` collects it.

import type { KicadBoardZone } from '../kicad/board'
import { pointInPolygon } from '../geometry/regionClips'

/** Copper within the pointer's reach: its net, its copper layers, its distance. */
export interface NetPickCopper {
  net: number
  layers: readonly string[]
  dist: number
}

export interface NetPickInput {
  /** Pads, vias and tracks within reach of the pointer. */
  copper: readonly NetPickCopper[]
  zones: readonly Pick<KicadBoardZone, 'net' | 'isKeepout' | 'layers' | 'filledPolys'>[]
  /** The pointer in file space (nm, y down), for the zone fills. */
  at: { x: number; y: number }
  activeLayer: string
  /** Whether copper on these layers can be picked under the current display. */
  interactable: (layers: readonly string[]) => boolean
}

/**
 * The net under the pointer: copper with a net on a pickable layer — the
 * active layer's first, then the nearest — and only when there is none, a
 * zone's fill under the point, the active layer's first. 0 for none.
 */
export function pickHighlightNet(input: NetPickInput): number {
  const { activeLayer, interactable } = input
  const offActive = (layers: readonly string[]): number => (layers.includes(activeLayer) ? 0 : 1)
  const copper = input.copper
    .filter((hit) => hit.net > 0 && interactable(hit.layers))
    .sort((a, b) => offActive(a.layers) - offActive(b.layers) || a.dist - b.dist)
  if (copper.length) return copper[0].net
  const fills = input.zones.flatMap(({ net, isKeepout, layers, filledPolys }) =>
    isKeepout || !net || net <= 0
      ? []
      : filledPolys.flatMap((poly) => {
          const layer = poly.layer ?? layers[0]
          return interactable([layer]) && pointInPolygon(input.at, poly.points)
            ? [{ net, layer }]
            : []
        })
  )
  fills.sort((a, b) => offActive([a.layer]) - offActive([b.layer]))
  return fills[0]?.net ?? 0
}
