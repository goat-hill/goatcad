/**
 * A board's keepouts ("rule areas"): its own and those its footprints carry,
 * the ESP32 module's antenna area being the case that matters. The zone
 * filler reads them to carve pours; the board checks read them for KiCad's
 * `items_not_allowed`; the router routes round those that forbid tracks.
 *
 * World space, as the spatial index has it: millimeters, y up. A footprint's
 * zone is board-absolute in a board file, so it maps like a board zone.
 */
import type { KicadBoard, KicadBoardZone } from '../kicad/board'
import type { KicadZone, ZoneKeepoutRules } from '../kicad/footprint'
import { isCopperLayer } from '../kicad/layers'
import { nmToMm, type Nm } from '../kicad/coordinates'
import { pointInPoly, rrectCore, sampleArc, type CopperShape, type Pt } from './spatialIndex'
import {
  capsuleEntersRegion,
  pointInRegion,
  ringBox,
  segmentsCrossProperly,
  type Box,
  type Region
} from '../geometry/polygon'

export interface Keepout {
  zone: KicadBoardZone | KicadZone
  region: Region
  box: Box
  /** The layers it applies on: wildcards resolved against the board's copper. */
  layers: string[]
  rules: ZoneKeepoutRules
  /** The footprint that carries it; null for a board-level area. */
  footprint: number | null
  uuid: string | undefined
}

const toWorld = (p: { x: Nm; y: Nm }): Pt => ({ x: nmToMm(p.x), y: -nmToMm(p.y) })

/** A zone's layers as the board has them: `*.Cu` and `F&B.Cu` expanded, absent copper dropped. */
export const resolveLayers = (layers: readonly string[], board: KicadBoard): string[] => {
  const copper = board.layers.filter((l) => isCopperLayer(l.name)).map((l) => l.name)
  const out = new Set<string>()
  for (const layer of layers) {
    if (layer === '*.Cu') copper.forEach((l) => out.add(l))
    else if (layer === 'F&B.Cu') ['F.Cu', 'B.Cu'].forEach((l) => out.add(l))
    else if (!isCopperLayer(layer) || copper.includes(layer)) out.add(layer)
  }
  return [...out]
}

/** Whether an area blocks anything at all (KiCad's `HasKeepoutParametersSet`). */
const blocksSomething = (rules: ZoneKeepoutRules): boolean =>
  !rules.tracks || !rules.vias || !rules.pads || !rules.copperpour || !rules.footprints

export const boardKeepouts = (board: KicadBoard): Keepout[] => {
  const out: Keepout[] = []
  const add = (
    zone: KicadBoardZone | KicadZone,
    layers: readonly string[],
    footprint: number | null
  ): void => {
    const rules = zone.keepoutRules
    if (!zone.isKeepout || !rules || !blocksSomething(rules) || zone.points.length < 3) return
    const outer = zone.points.map(toWorld)
    out.push({
      zone,
      // A cutout in an area is outside it: what sits in the hole is allowed.
      region: { outer, holes: (zone.holes ?? []).map((hole) => hole.map(toWorld)) },
      box: ringBox(outer),
      layers: resolveLayers(layers, board),
      rules,
      footprint,
      uuid: zone.uuid
    })
  }
  for (const zone of board.zones) add(zone, zone.layers, null)
  board.footprints.forEach((bfp, index) => {
    for (const zone of bfp.footprint.zones) add(zone, zone.layers, index)
  })
  return out
}

/**
 * Whether a piece of copper reaches into a region by more than `tolerance`:
 * KiCad's collision against an area deflated by its DRC epsilon, where
 * touching the boundary does not count.
 */
export const shapeEntersRegion = (
  shape: CopperShape,
  region: Region,
  tolerance: number
): boolean => {
  switch (shape.kind) {
    case 'capsule':
      return capsuleEntersRegion(
        { x: shape.x0, y: shape.y0 },
        { x: shape.x1, y: shape.y1 },
        shape.halfWidth,
        region,
        tolerance
      )
    case 'circle':
      return capsuleEntersRegion(
        { x: shape.cx, y: shape.cy },
        { x: shape.cx, y: shape.cy },
        shape.r,
        region,
        tolerance
      )
    case 'arc': {
      const points = sampleArc(shape.x0, shape.y0, shape.mx, shape.my, shape.x1, shape.y1)
      for (let i = 1; i < points.length; i++)
        if (capsuleEntersRegion(points[i - 1], points[i], shape.halfWidth, region, tolerance))
          return true
      return false
    }
    case 'rrect': {
      const core = rrectCore(shape)
      for (let i = 0, j = core.length - 1; i < core.length; j = i++)
        if (capsuleEntersRegion(core[j], core[i], shape.cornerR, region, tolerance)) return true
      // A region wholly inside the pad touches none of its edges.
      return region.outer.some((p) => pointInRegion(p, { outer: core, holes: [] }))
    }
    case 'poly': {
      for (const ring of shape.rings)
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
          if (capsuleEntersRegion(ring[j], ring[i], 0, region, tolerance)) return true
      // A region wholly inside the polygon touches none of its edges.
      return region.outer.some((p) => pointInPoly(shape.rings, p.x, p.y))
    }
    case 'compound':
      return shape.parts.some((part) => shapeEntersRegion(part, region, tolerance))
  }
}

/** Whether a closed outline's edges reach into a region: KiCad's line-chain collision. */
export const ringEntersRegion = (ring: readonly Pt[], region: Region): boolean => {
  if (ring.some((p) => pointInRegion(p, region))) return true
  // A region wholly inside the ring meets none of its edges, but the areas meet.
  if (region.outer.some((p) => pointInRegion(p, { outer: ring as Pt[], holes: [] }))) return true
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    for (let k = 0, l = region.outer.length - 1; k < region.outer.length; l = k++)
      if (segmentsCrossProperly(ring[j], ring[i], region.outer[l], region.outer[k])) return true
  return false
}
