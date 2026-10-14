/**
 * Board file → one flat mesh per physical layer.
 *
 * This is the 2D board's item vocabulary rendered a second time, for a
 * different purpose: `BoardScene` draws items so they can be picked and edited,
 * this draws surfaces so they can be lit. Every track on a layer collapses into
 * one mesh, nothing is selectable, and the split that matters is not by item
 * kind but by **what is on top of it** — copper under solder mask reads as a
 * green ridge, copper in a mask opening reads as bare pad finish. That is why
 * pads and tracks land in separate builders despite being the same metal.
 *
 * Coordinates are world space (millimeters, y-up) via `kicad/placement.ts`, so
 * the 3D board sits exactly where the 2D board and the Gerbers do.
 */

import { viaMaskIsOpen } from '../../kicad/board'
import type { KicadBoard, KicadBoardFootprint, KicadBoardZone } from '../../kicad/board'
import { footprintTextDrawAngle, isSolidFill } from '../../kicad/footprint'
import type {
  KicadFontEffects,
  KicadFpArc,
  KicadFpCircle,
  KicadFpLine,
  KicadFpPoly,
  KicadFpRect,
  KicadPad
} from '../../kicad/footprint'
import { getTextStrokes, strokeOptionsFromEffects } from '../../kicad/newstroke'
import { expandLayerToken } from '../../kicad/layers'
import {
  footprintTransform,
  padLocal,
  tfPoint,
  worldPoint,
  type FpTransform,
  type Pt
} from '../../schematic/placement'
import { EDGE_CUTS } from './boardOutline'
import { FlatMeshBuilder, placedRoundRect, type Pt as FlatPt } from './flatMesh'
import { nm, nmToMm, type Nm } from '../../kicad/coordinates'

/** A drilled hole, as both a substrate cutout and (when round) a plated barrel. */
export interface DrillHole {
  x: number
  y: number
  /** Half-extents of the hole's round-rect outline; equal for a round hole. */
  halfW: number
  halfH: number
  /** Corner radius — equal to the half-extents for a round hole. */
  cornerR: number
  angle: number
  /** Copper-walled. `np_thru_hole` pads are bare laminate. */
  plated: boolean
}

export interface Board3DLayers {
  /** Copper that stays under solder mask: tracks, arcs, zone fills, via annuli. */
  copper: Map<string, FlatMeshBuilder>
  /** Copper in a mask opening: pads and their custom-shape primitives. */
  pads: Map<string, FlatMeshBuilder>
  silk: Map<string, FlatMeshBuilder>
  paste: Map<string, FlatMeshBuilder>
  /** Comment / drawing / ECO layers, drawn as one plane above the front side. */
  drawings: FlatMeshBuilder
  holes: DrillHole[]
}

const SILK_LAYERS = new Set(['F.SilkS', 'B.SilkS'])
const PASTE_LAYERS = new Set(['F.Paste', 'B.Paste'])
const DRAWING_LAYERS = new Set(['Dwgs.User', 'Cmts.User', 'Eco1.User', 'Eco2.User'])

const DEFAULT_STROKE_MM = 0.12
const DEFAULT_POLY_STROKE_MM = 0.1

const isCopper = (layer: string): boolean => layer.endsWith('.Cu')

/** Lazily create the builder for a layer — most boards use few of them. */
function builderFor(map: Map<string, FlatMeshBuilder>, layer: string): FlatMeshBuilder {
  let builder = map.get(layer)
  if (!builder) {
    builder = new FlatMeshBuilder()
    map.set(layer, builder)
  }
  return builder
}

/**
 * Expand KiCad's layer wildcards. `*.Cu` on a through-hole pad means every
 * copper layer the board has, not just the outer two.
 */
function resolvePadLayers(pad: KicadPad, copperLayers: readonly string[]): string[] {
  const resolved: string[] = []
  for (const layer of pad.layers) {
    for (const concrete of expandLayerToken(layer, copperLayers)) {
      if (!resolved.includes(concrete)) resolved.push(concrete)
    }
  }
  return resolved
}

/** Pad outline as the round-rect the 2D scene resolves it to. */
function padOutline(pad: KicadPad): { halfW: number; halfH: number; cornerR: number } {
  // World mm out of nm pad sizes.
  const w = nmToMm(pad.size.w)
  const h = nmToMm(pad.size.h)
  if (pad.shape === 'circle') return { halfW: w / 2, halfH: w / 2, cornerR: w / 2 }
  if (pad.shape === 'oval') return { halfW: w / 2, halfH: h / 2, cornerR: Math.min(w, h) / 2 }
  if (pad.shape === 'roundrect' || pad.roundrectRatio) {
    return { halfW: w / 2, halfH: h / 2, cornerR: Math.min(w, h) * (pad.roundrectRatio ?? 0.25) }
  }
  return { halfW: w / 2, halfH: h / 2, cornerR: 0 }
}

function addGraphicsTo(
  target: FlatMeshBuilder,
  at: (p: { x: Nm; y: Nm }) => Pt,
  graphic:
    | { kind: 'line'; item: KicadFpLine }
    | { kind: 'arc'; item: KicadFpArc }
    | { kind: 'circle'; item: KicadFpCircle }
    | { kind: 'rect'; item: KicadFpRect }
    | { kind: 'poly'; item: KicadFpPoly }
): void {
  switch (graphic.kind) {
    case 'line': {
      const a = at(graphic.item.start)
      const b = at(graphic.item.end)
      target.addSegment(
        a.x,
        a.y,
        b.x,
        b.y,
        (graphic.item.strokeWidth !== undefined
          ? nmToMm(graphic.item.strokeWidth)
          : DEFAULT_STROKE_MM) / 2
      )
      return
    }
    case 'arc': {
      target.addArc(
        at(graphic.item.start),
        at(graphic.item.mid),
        at(graphic.item.end),
        (graphic.item.strokeWidth !== undefined
          ? nmToMm(graphic.item.strokeWidth)
          : DEFAULT_STROKE_MM) / 2
      )
      return
    }
    case 'circle': {
      const center = at(graphic.item.center)
      const edge = at(graphic.item.end)
      const r = Math.hypot(edge.x - center.x, edge.y - center.y)
      if (isSolidFill(graphic.item.fill)) target.addCircle(center.x, center.y, r)
      else
        target.addRing(
          center.x,
          center.y,
          r,
          (graphic.item.strokeWidth !== undefined
            ? nmToMm(graphic.item.strokeWidth)
            : DEFAULT_STROKE_MM) / 2
        )
      return
    }
    case 'rect': {
      const { start, end } = graphic.item
      const corners = [
        at({ x: start.x, y: start.y }),
        at({ x: end.x, y: start.y }),
        at({ x: end.x, y: end.y }),
        at({ x: start.x, y: end.y })
      ]
      if (isSolidFill(graphic.item.fill)) target.addPolygon(corners)
      else
        target.addPolyline(
          corners,
          (graphic.item.strokeWidth !== undefined
            ? nmToMm(graphic.item.strokeWidth)
            : DEFAULT_STROKE_MM) / 2,
          true
        )
      return
    }
    case 'poly': {
      const points = graphic.item.points.map(at)
      if (points.length < 2) return
      if (isSolidFill(graphic.item.fill)) target.addPolygon(points)
      else
        target.addPolyline(
          points,
          (graphic.item.strokeWidth !== undefined
            ? nmToMm(graphic.item.strokeWidth)
            : DEFAULT_POLY_STROKE_MM) / 2,
          true
        )
      return
    }
  }
}

/** KiCad stroke text, as capsules on whichever layer carries it. */
function addStrokeText(
  target: FlatMeshBuilder,
  text: string,
  position: Pt,
  angleDeg: number | undefined,
  effects: KicadFontEffects | undefined
): void {
  if (!text) return
  const options = strokeOptionsFromEffects(effects)
  const { strokes } = getTextStrokes(text, options)
  const angle = ((angleDeg ?? 0) * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  for (const stroke of strokes) {
    target.addSegment(
      position.x + stroke.x1 * cos - stroke.y1 * sin,
      position.y + stroke.x1 * sin + stroke.y1 * cos,
      position.x + stroke.x2 * cos - stroke.y2 * sin,
      position.y + stroke.x2 * sin + stroke.y2 * cos,
      options.thickness / 2
    )
  }
}

export function buildBoardLayers(board: KicadBoard): Board3DLayers {
  const steps = buildBoardLayersSteps(board)
  let result = steps.next()
  while (!result.done) result = steps.next()
  return result.value
}

/** Items per progress yield; footprints count more, they carry pads and text. */
const LAYER_CHUNK = 800
const FOOTPRINT_WEIGHT = 10

/**
 * Stepwise `buildBoardLayers`: yields its progress (0–1) every few hundred
 * items so a large board's layer accumulation never runs as one long task.
 */
export function* buildBoardLayersSteps(board: KicadBoard): Generator<number, Board3DLayers> {
  const layers: Board3DLayers = {
    copper: new Map(),
    pads: new Map(),
    silk: new Map(),
    paste: new Map(),
    drawings: new FlatMeshBuilder(),
    holes: []
  }

  const totalWeight =
    board.footprints.length * FOOTPRINT_WEIGHT +
    board.segments.length +
    board.trackArcs.length +
    board.vias.length +
    board.zones.length +
    board.grLines.length +
    board.grArcs.length +
    board.grCircles.length +
    board.grRects.length +
    board.grPolys.length +
    board.grTexts.length
  let weight = 0
  let sinceYield = 0
  function* tick(units: number): Generator<number, void> {
    weight += units
    sinceYield += units
    if (sinceYield >= LAYER_CHUNK) {
      sinceYield = 0
      yield totalWeight > 0 ? weight / totalWeight : 1
    }
  }

  const copperLayers = board.layers.filter((l) => isCopper(l.name)).map((l) => l.name)
  const knownCopper = copperLayers.length > 0 ? copperLayers : ['F.Cu', 'B.Cu']

  /** Route a graphic to the builder for its layer, or drop it. */
  const surfaceFor = (layer: string | undefined): FlatMeshBuilder | null => {
    if (!layer || layer === EDGE_CUTS) return null
    if (SILK_LAYERS.has(layer)) return builderFor(layers.silk, layer)
    if (DRAWING_LAYERS.has(layer)) return layers.drawings
    // Copper graphics are rare but legal; they belong under the mask.
    if (isCopper(layer)) return builderFor(layers.copper, layer)
    return null
  }

  for (const seg of board.segments) {
    const a = worldPoint(seg.start)
    const b = worldPoint(seg.end)
    builderFor(layers.copper, seg.layer).addSegment(a.x, a.y, b.x, b.y, nmToMm(seg.width) / 2)
    yield* tick(1)
  }
  for (const arc of board.trackArcs) {
    builderFor(layers.copper, arc.layer).addArc(
      worldPoint(arc.start),
      worldPoint(arc.mid),
      worldPoint(arc.end),
      nmToMm(arc.width) / 2
    )
    yield* tick(1)
  }
  for (const via of board.vias) {
    const p = worldPoint(via.position)
    const spans = via.layers.length > 0 ? via.layers : ['F.Cu', 'B.Cu']
    const outer = nmToMm(via.size) / 2
    const bore = nmToMm(via.drill) / 2
    for (const layer of spans) {
      // A tented via's annulus sits under mask (green); an untented one is in a
      // mask opening, like a pad, and reads as bare finish.
      const exposed =
        (layer === 'F.Cu' && viaMaskIsOpen(via, 'front', board.tenting)) ||
        (layer === 'B.Cu' && viaMaskIsOpen(via, 'back', board.tenting))
      const target = builderFor(exposed ? layers.pads : layers.copper, layer)
      // The annulus, not a disc: a via's copper is the ring around its barrel,
      // and filling the middle would cap the hole it is supposed to reveal.
      if (bore > 0 && bore < outer) {
        target.addRing(p.x, p.y, (outer + bore) / 2, (outer - bore) / 2)
      } else {
        target.addCircle(p.x, p.y, outer)
      }
    }
    if (bore > 0) {
      layers.holes.push({
        x: p.x,
        y: p.y,
        halfW: bore,
        halfH: bore,
        cornerR: bore,
        angle: 0,
        plated: true
      })
    }
    yield* tick(1)
  }

  const zoneLayer = (zone: KicadBoardZone, polyLayer: string | undefined): string | null =>
    polyLayer ?? zone.layers[0] ?? null

  for (const zone of board.zones) {
    if (zone.isKeepout) continue
    for (const poly of zone.filledPolys) {
      const layer = zoneLayer(zone, poly.layer)
      if (!layer || poly.points.length < 3) continue
      builderFor(layers.copper, layer).addPolygon(poly.points.map(worldPoint))
    }
    yield* tick(1)
  }

  for (const bfp of board.footprints) {
    addFootprint(layers, bfp, knownCopper, surfaceFor)
    yield* tick(FOOTPRINT_WEIGHT)
  }

  for (const line of board.grLines) {
    const target = surfaceFor(line.layer)
    if (target) addGraphicsTo(target, worldPoint, { kind: 'line', item: line })
    yield* tick(1)
  }
  for (const arc of board.grArcs) {
    const target = surfaceFor(arc.layer)
    if (target) addGraphicsTo(target, worldPoint, { kind: 'arc', item: arc })
    yield* tick(1)
  }
  for (const circle of board.grCircles) {
    const target = surfaceFor(circle.layer)
    if (target) addGraphicsTo(target, worldPoint, { kind: 'circle', item: circle })
    yield* tick(1)
  }
  for (const rect of board.grRects) {
    const target = surfaceFor(rect.layer)
    if (target) addGraphicsTo(target, worldPoint, { kind: 'rect', item: rect })
    yield* tick(1)
  }
  for (const poly of board.grPolys) {
    const target = surfaceFor(poly.layer)
    if (target) addGraphicsTo(target, worldPoint, { kind: 'poly', item: poly })
    yield* tick(1)
  }
  for (const text of board.grTexts) {
    if (text.hide || !text.position) {
      yield* tick(1)
      continue
    }
    const target = surfaceFor(text.layer)
    if (target) {
      addStrokeText(
        target,
        text.text,
        worldPoint(text.position),
        text.position.angle,
        text.fontEffects
      )
    }
    yield* tick(1)
  }

  return layers
}

function addFootprint(
  layers: Board3DLayers,
  bfp: KicadBoardFootprint,
  copperLayers: readonly string[],
  surfaceFor: (layer: string | undefined) => FlatMeshBuilder | null
): void {
  const tf = footprintTransform(bfp)
  const at = (p: { x: Nm; y: Nm }): Pt => tfPoint(tf, p.x, p.y)
  const fp = bfp.footprint

  for (const pad of fp.pads) addPad(layers, pad, tf, copperLayers)

  for (const line of fp.fpLines) {
    const target = surfaceFor(line.layer)
    if (target) addGraphicsTo(target, at, { kind: 'line', item: line })
  }
  for (const arc of fp.fpArcs) {
    const target = surfaceFor(arc.layer)
    if (target) addGraphicsTo(target, at, { kind: 'arc', item: arc })
  }
  for (const circle of fp.fpCircles) {
    const target = surfaceFor(circle.layer)
    if (target) addGraphicsTo(target, at, { kind: 'circle', item: circle })
  }
  for (const rect of fp.fpRects) {
    const target = surfaceFor(rect.layer)
    if (target) addGraphicsTo(target, at, { kind: 'rect', item: rect })
  }
  for (const poly of fp.fpPolys) {
    const target = surfaceFor(poly.layer)
    if (target) addGraphicsTo(target, at, { kind: 'poly', item: poly })
  }

  // Reference/value live as properties in modern files and as fp_texts in older
  // ones; both carry absolute angles, so only the position is placed, and the
  // angle goes through the keep-upright fold the 2D board uses.
  for (const property of fp.properties) {
    if (!property.position || property.hide) continue
    const target = surfaceFor(property.layer)
    if (!target) continue
    addStrokeText(
      target,
      property.value,
      at(property.position),
      footprintTextDrawAngle(property.position.angle, property.keepUpright),
      property.fontEffects
    )
  }
  for (const text of fp.fpTexts) {
    if (!text.position || text.hide) continue
    const target = surfaceFor(text.layer)
    if (!target) continue
    addStrokeText(
      target,
      text.text,
      at(text.position),
      footprintTextDrawAngle(text.position.angle, text.keepUpright),
      text.fontEffects
    )
  }
}

function addPad(
  layers: Board3DLayers,
  pad: KicadPad,
  tf: FpTransform,
  copperLayers: readonly string[]
): void {
  const center = tfPoint(tf, pad.position.x, pad.position.y)
  const { halfW, halfH, cornerR } = padOutline(pad)
  // Pad angles in a board file are absolute — the footprint rotation is baked
  // in already (see BoardScene.renderPad).
  const angle = ((pad.position.angle ?? 0) * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)

  // A drilled pad is an annulus, not a disc. Without this the copper covers its
  // own hole and the board reads as undrilled from directly above — the bore is
  // cut out of the substrate and the barrel is in it, but nothing is visible
  // through a solid lid.
  const bore = padBore(pad, center, cos, sin, angle)
  const annulus =
    bore && boreFitsInside(bore.halfW, bore.halfH, halfW, halfH) ? bore.outline : undefined
  // A hole at least as big as the pad leaves no copper at all (an unplated
  // mounting hole whose "pad" is only there to carry the drill).
  const noCopperLeft = !!bore && !annulus && bore.halfW >= halfW && bore.halfH >= halfH

  for (const layer of resolvePadLayers(pad, copperLayers)) {
    const target = layer.endsWith('.Cu')
      ? builderFor(layers.pads, layer)
      : PASTE_LAYERS.has(layer)
        ? builderFor(layers.paste, layer)
        : null
    if (!target) continue
    if (!noCopperLeft) {
      target.addRoundRect(center.x, center.y, halfW, halfH, cornerR, angle, annulus)
    }

    const prims = pad.primitives
    if (!prims) continue
    const local = (p: { x: Nm; y: Nm }): Pt => padLocal(center, cos, sin, p.x, p.y)
    for (const line of prims.lines) addGraphicsTo(target, local, { kind: 'line', item: line })
    for (const arc of prims.arcs) addGraphicsTo(target, local, { kind: 'arc', item: arc })
    for (const circle of prims.circles)
      addGraphicsTo(target, local, { kind: 'circle', item: circle })
    for (const rect of prims.rects) addGraphicsTo(target, local, { kind: 'rect', item: rect })
    for (const poly of prims.polys) addGraphicsTo(target, local, { kind: 'poly', item: poly })
  }

  if (!bore) return
  layers.holes.push({
    x: bore.x,
    y: bore.y,
    halfW: bore.halfW,
    halfH: bore.halfH,
    cornerR: Math.min(bore.halfW, bore.halfH),
    angle,
    plated: pad.type === 'thru_hole'
  })
}

/** Where a pad's drill is and what shape it cuts, in world space. */
function padBore(
  pad: KicadPad,
  center: Pt,
  cos: number,
  sin: number,
  angle: number
): { x: number; y: number; halfW: number; halfH: number; outline: FlatPt[] } | null {
  if (pad.type !== 'thru_hole' && pad.type !== 'np_thru_hole') return null
  const drill = pad.drill
  if (!drill) return null

  const offset = drill.offset ?? { x: nm(0), y: nm(0) }
  const at = padLocal(center, cos, sin, offset.x, offset.y)
  const oval = drill.oval
  const halfW = nmToMm(oval ? oval.width : drill.diameter) / 2
  const halfH = nmToMm(oval ? oval.height : drill.diameter) / 2
  if (!(halfW > 0) || !(halfH > 0)) return null
  return {
    x: at.x,
    y: at.y,
    halfW,
    halfH,
    outline: placedRoundRect(at.x, at.y, halfW, halfH, Math.min(halfW, halfH), angle)
  }
}

/**
 * Whether the bore leaves a ring of copper all the way round. Earcut needs the
 * hole strictly inside its contour, and a bore that pokes out of the pad is a
 * malformed footprint rather than an annulus — better to draw the pad solid
 * than to hand the triangulator something it will turn into garbage.
 */
function boreFitsInside(boreW: number, boreH: number, padHalfW: number, padHalfH: number): boolean {
  const clearance = 0.001
  return boreW + clearance < padHalfW && boreH + clearance < padHalfH
}
