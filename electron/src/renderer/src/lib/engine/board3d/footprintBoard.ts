/**
 * A footprint, wrapped as a one-part board.
 *
 * The footprint editor's 3D pane needs to show how the part sits on copper,
 * not just the linked `(model …)` floating in space. Rather than grow a
 * second renderer for that, the pane synthesizes a small board: the footprint
 * placed at the origin, with an `Edge.Cuts` rectangle a little larger than its
 * own extent. Everything downstream — `BoardScene3D`, `buildBoardLayers`,
 * `ComponentModelLoader` — then works unchanged, so the pads, silkscreen, mask
 * and drilled holes come out looking exactly as they do on a real board,
 * because they are drawn by the same code.
 *
 * Nothing here touches the AST. The synthetic board is a plain value that
 * exists for the render pass and is thrown away; it is never serialized, so its
 * `_raw` nodes are inert placeholders.
 */

import type { KicadBoard, KicadBoardFootprint } from '../../kicad/board'
import type { KicadFontEffects, KicadFootprint, SExprList } from '../../kicad/footprint'
import { getTextStrokes, strokeOptionsFromEffects } from '../../kicad/newstroke'
import { EDGE_CUTS } from './boardOutline'
import { mmToNm, nm, nmToMm, NM_PER_MM } from '../../kicad/coordinates'

/** KiCad's default board thickness — the pane has no stackup to read. */
const THICKNESS_MM = 1.6

/**
 * How much board to show around the part. Enough to read as "sitting on a
 * board" without shrinking the part to a speck: a fixed minimum for tiny
 * passives, a fraction for anything larger, capped so a big connector does not
 * come with a placemat.
 */
export function boardMarginFor(width: number, height: number): number {
  return Math.max(1.5, Math.min(5, 0.25 * Math.max(width, height)))
}

export interface Extent {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const inert = (): SExprList => ({ type: 'list', children: [], start: 0, end: 0 })

/**
 * The footprint's own extent in its local (KiCad, y-down) frame.
 *
 * Everything printed counts — pads, graphics, and silkscreen **text**. The
 * reference and value are silkscreen like any other line on that layer, so a
 * board sized without them leaves the designator hanging off the substrate,
 * floating in space next to the part. Only hidden text is skipped, because it
 * is not printed.
 */
export function footprintExtent(fp: KicadFootprint): Extent | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const expand = (x: number, y: number, pad = 0): void => {
    minX = Math.min(minX, x - pad)
    minY = Math.min(minY, y - pad)
    maxX = Math.max(maxX, x + pad)
    maxY = Math.max(maxY, y + pad)
  }

  for (const pad of fp.pads) {
    // Half the longer side, so a rotated pad still fits its own box.
    expand(pad.position.x, pad.position.y, Math.max(pad.size.w, pad.size.h) / 2)
  }
  for (const line of fp.fpLines) {
    expand(line.start.x, line.start.y)
    expand(line.end.x, line.end.y)
  }
  for (const arc of fp.fpArcs) {
    expand(arc.start.x, arc.start.y)
    expand(arc.mid.x, arc.mid.y)
    expand(arc.end.x, arc.end.y)
  }
  for (const circle of fp.fpCircles) {
    const r = Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y)
    expand(circle.center.x, circle.center.y, r)
  }
  for (const rect of fp.fpRects) {
    expand(rect.start.x, rect.start.y)
    expand(rect.end.x, rect.end.y)
  }
  for (const poly of fp.fpPolys) {
    for (const point of poly.points) expand(point.x, point.y)
  }

  const text = (
    value: string,
    position: { x: number; y: number; angle?: number } | undefined,
    hide: boolean | undefined,
    effects: KicadFontEffects | undefined
  ): void => {
    if (hide || !position || !value) return
    const { bounds } = getTextStrokes(value, strokeOptionsFromEffects(effects))
    const angle = ((position.angle ?? 0) * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    // The layout is y-up mm (scene space, as the renderer strokes it); rotate
    // each corner the way `addStrokeText` does, scale into nanometers, then
    // flip back into KiCad's y-down local frame to join the rest of the extent.
    for (const [bx, by] of [
      [bounds.minX, bounds.minY],
      [bounds.maxX, bounds.minY],
      [bounds.maxX, bounds.maxY],
      [bounds.minX, bounds.maxY]
    ]) {
      expand(
        position.x + (bx * cos - by * sin) * NM_PER_MM,
        position.y - (bx * sin + by * cos) * NM_PER_MM
      )
    }
  }

  for (const property of fp.properties) {
    text(property.value, property.position, property.hide, property.fontEffects)
  }
  for (const fpText of fp.fpTexts) {
    text(fpText.text, fpText.position, fpText.hide, fpText.fontEffects)
  }

  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

/** Whether the footprint already draws its own board edge (a board-outline or
 *  mounting-hole part). If it does, the synthetic rectangle would nest inside
 *  it and come out as a cutout, so it is left off. */
export function hasOwnBoardEdge(fp: KicadFootprint): boolean {
  const onEdge = (layer: string | undefined): boolean => layer === EDGE_CUTS
  return (
    fp.fpLines.some((i) => onEdge(i.layer)) ||
    fp.fpArcs.some((i) => onEdge(i.layer)) ||
    fp.fpCircles.some((i) => onEdge(i.layer)) ||
    fp.fpRects.some((i) => onEdge(i.layer)) ||
    fp.fpPolys.some((i) => onEdge(i.layer))
  )
}

/** The board this footprint would sit on, for preview only. */
export function boardFromFootprint(fp: KicadFootprint): KicadBoard {
  const placed: KicadBoardFootprint = {
    libId: fp.name,
    position: { x: nm(0), y: nm(0) },
    // Front side always: the pane previews the part as authored, and a
    // footprint's own file has no board side to be on.
    layer: 'F.Cu',
    reference: fp.properties.find((p) => p.key === 'Reference')?.value,
    value: fp.properties.find((p) => p.key === 'Value')?.value,
    footprint: fp,
    _raw: inert()
  }

  const board: KicadBoard = {
    thickness: mmToNm(THICKNESS_MM),
    netRefStyle: 'number',
    padToMaskClearance: nm(0),
    padToPasteClearance: nm(0),
    padToPasteClearanceRatio: 0,
    layers: [
      { ordinal: 0, name: 'F.Cu', type: 'signal' },
      { ordinal: 2, name: 'B.Cu', type: 'signal' }
    ],
    nets: [],
    footprints: [placed],
    segments: [],
    trackArcs: [],
    vias: [],
    zones: [],
    grLines: [],
    grArcs: [],
    grCircles: [],
    grRects: [],
    grPolys: [],
    grTexts: [],
    grCurves: [],
    grTextBoxes: [],
    tables: [],
    points: [],
    dimensions: [],
    tuningPatterns: [],
    _raw: inert(),
    _unknownNodes: []
  }

  const extent = footprintExtent(fp)
  if (extent && !hasOwnBoardEdge(fp)) {
    // The margin rule speaks mm; the extent is nm — convert in, then out.
    const margin = mmToNm(
      boardMarginFor(nmToMm(nm(extent.maxX - extent.minX)), nmToMm(nm(extent.maxY - extent.minY)))
    )
    board.grRects.push({
      start: { x: nm(extent.minX - margin), y: nm(extent.minY - margin) },
      end: { x: nm(extent.maxX + margin), y: nm(extent.maxY + margin) },
      layer: EDGE_CUTS,
      strokeWidth: mmToNm(0.1),
      locked: false,
      _raw: inert()
    })
  }

  return board
}
