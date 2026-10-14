/**
 * The board's layers beyond copper, indexed: what the silkscreen, mask,
 * paste, fab, courtyard and edge rules measure (design-health-workstream.md).
 * The copper index (`spatialIndex.ts`) holds tracks, vias and
 * pads for everything that routes and edits; this holds the rest, each item
 * by its shape on its layer.
 *
 * What a layer holds:
 * - **Drawings** (`boardDrawings.ts`): graphics as their strokes and fills;
 *   text, text boxes, tables and dimensions as their glyph strokes — the text
 *   outlines the Gerber writer draws — with their outlines and lines; a
 *   knockout text as the box it knocks its glyphs out of.
 * - **Mask** (`F.Mask`, `B.Mask`): each pad's opening, its copper on that side
 *   grown by its margin; untented vias; tracks the file opens
 *   (`maskExpansion.ts`). Zones drawn on the layer.
 * - **Paste**: each pad's aperture, its copper grown (or shrunk) by its paste
 *   margin on each axis.
 * - **Courtyards** (`F.CrtYd`, `B.CrtYd`): each footprint's side as the
 *   nested regions KiCad builds (`courtyards.ts`), beside the strokes drawn there.
 * - **Edge.Cuts**: every edge as a bare centerline, arcs and curves in chords
 *   within the copper index's arc tolerance.
 *
 * A layer is built the first time it is asked for, so what no check reads
 * costs nothing. World space: millimeters, y up. A margin other than zero
 * grows a polygon through Clipper2, which must be loaded; before it is, a
 * trapezoid, chamfered or custom pad's opening is its copper as it is.
 */
import type { KicadBoard, KicadTrackArc, KicadTrackSegment } from '../kicad/board'
import { viaMaskIsOpen } from '../kicad/board'
import { padOnLayer, rectOutline, type KicadFootprint } from '../kicad/footprint'
import { isCopperLayer } from '../kicad/layers'
import { nmToMm, type Nm } from '../kicad/coordinates'
import { EDGE_CUTS, bezierPoints } from '../engine/board3d/boardOutline'
import { footprintTransform, tfPoint } from '../schematic/placement'
import { PackedRTree } from '../geometry/packedRTree'
import { offset } from '../geometry/clip'
import { boardDrawings, type BoardDrawing, type DrawingKind } from './boardDrawings'
import { boardCourtyards, type FootprintCourtyard } from './courtyards'
import {
  padMaskMargin,
  padPasteMargin,
  padTouchesLayer,
  trackMaskMargin,
  viaMaskMargin
} from './maskExpansion'
import { shapeOutlines } from './shapeOutline'
import { padShape, polyShape, sampleArc, type CopperShape, type Pt } from './spatialIndex'
import type { BoardRules } from './rules/boardRules'

export type LayerItemKind = DrawingKind | 'pad' | 'via' | 'track' | 'zone' | 'courtyard' | 'edge'

export interface LayerItem {
  /** Position in its layer's items. */
  id: number
  layer: string
  kind: LayerItemKind
  shape: CopperShape
  /** The footprint it belongs to, if any. */
  fp?: number
  /** A pad's index in its footprint; a via's, track's or zone's in the board's list. */
  index?: number
  uuid?: string
  /** A courtyard's regions, as the courtyard checks read them. */
  courtyard?: FootprintCourtyard
  /** An edge's two ends. */
  ends?: readonly [Pt, Pt]
  /** Which piece of its drawing an edge is (`EdgeSegment.piece`). */
  piece?: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface LayerItems {
  readonly items: readonly LayerItem[]
  /** The items whose boxes meet a box. */
  query(minX: number, minY: number, maxX: number, maxY: number): LayerItem[]
}

export interface BoardLayerIndex {
  /** One layer's items, built on first use. */
  layer(name: string): LayerItems
  /** Every footprint's courtyards, front and back (`courtyards.ts`). */
  readonly courtyards: readonly FootprintCourtyard[]
}

/**
 * The board's layer index, cached per board, text variables and rules: the
 * checks and the rules' area functions share one.
 */
export function boardLayerIndex(
  board: KicadBoard,
  variables: Readonly<Record<string, string>> = {},
  rules?: BoardRules
): BoardLayerIndex {
  const entries = cache.get(board) ?? []
  const hit = entries.find((entry) => entry.variables === variables && entry.rules === rules)
  if (hit) return hit.index
  const layers = new Map<string, LayerItems>()
  const index: BoardLayerIndex = {
    layer(name) {
      let built = layers.get(name)
      if (!built) layers.set(name, (built = buildLayer(board, name, variables, rules, index)))
      return built
    },
    get courtyards() {
      return boardCourtyards(board)
    }
  }
  cache.set(board, [...entries, { variables, rules, index }])
  return index
}

const cache = new WeakMap<
  KicadBoard,
  Array<{
    variables: Readonly<Record<string, string>>
    rules: BoardRules | undefined
    index: BoardLayerIndex
  }>
>()

function buildLayer(
  board: KicadBoard,
  layer: string,
  variables: Readonly<Record<string, string>>,
  rules: BoardRules | undefined,
  index: BoardLayerIndex
): LayerItems {
  const items: LayerItem[] = []
  const push = (
    item: Omit<LayerItem, 'id' | 'layer' | 'minX' | 'minY' | 'maxX' | 'maxY'>
  ): void => {
    const box = boundsOf(item.shape)
    if (!Number.isFinite(box.minX)) return
    items.push({ ...item, id: items.length, layer, ...box })
  }

  if (layer === EDGE_CUTS) {
    for (const { ends, uuid, fp, piece } of edgeCutsSegmentsOf(board)) {
      const [a, b] = ends
      push({
        kind: 'edge',
        shape: { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth: 0 },
        ends,
        piece,
        ...(uuid ? { uuid } : {}),
        ...(fp !== undefined ? { fp } : {})
      })
    }
    return pack(items)
  }

  if (!isCopperLayer(layer)) {
    // Drawings: each item's pieces as one, a text by its glyph strokes.
    const bySource = new Map<number, BoardDrawing[]>()
    for (const piece of boardDrawings(board, variables, true, { layer }).get(layer) ?? []) {
      const list = bySource.get(piece.source) ?? []
      list.push(piece)
      bySource.set(piece.source, list)
    }
    for (const pieces of bySource.values()) {
      // A knockout text is solid round its glyphs: its box grown by its margin.
      const parts = pieces.flatMap((p) =>
        p.knockout && p.shape.kind === 'rrect'
          ? [
              {
                ...p.shape,
                halfW: p.shape.halfW + (p.knockoutMargin ?? 0),
                halfH: p.shape.halfH + (p.knockoutMargin ?? 0)
              }
            ]
          : (p.glyphs ?? [p.shape])
      )
      if (parts.length === 0) continue
      const first = pieces[0]
      push({
        kind: first.drawing,
        shape: parts.length === 1 ? parts[0] : { kind: 'compound', parts },
        ...(first.fp !== undefined ? { fp: first.fp } : {}),
        ...(first.uuid ? { uuid: first.uuid } : {})
      })
    }
  }

  const mask = layer === 'F.Mask' || layer === 'B.Mask'
  const paste = layer === 'F.Paste' || layer === 'B.Paste'
  if (mask || paste) {
    const side = layer.startsWith('B.') ? 'B.Cu' : 'F.Cu'
    board.footprints.forEach((bfp, fp) => {
      const tf = footprintTransform(bfp)
      bfp.footprint.pads.forEach((pad, padIndex) => {
        if (!padTouchesLayer(pad, layer)) return
        const copper = padShape(padOnLayer(pad, side), tfPoint(tf, pad.position.x, pad.position.y))
        const grown = mask
          ? grow(copper, mm(padMaskMargin(board, fp, padIndex, layer, rules)))
          : growAxes(copper, padPasteMargin(board, fp, padIndex, layer, rules))
        push({
          kind: 'pad',
          shape: grown,
          fp,
          index: padIndex,
          ...(pad.uuid ? { uuid: pad.uuid } : {})
        })
      })
    })
  }
  if (mask) {
    const side = layer === 'B.Mask' ? 'back' : 'front'
    const outer = layer === 'B.Mask' ? 'B.Cu' : 'F.Cu'
    board.vias.forEach((via, i) => {
      if (!via.layers.includes(outer) || !viaMaskIsOpen(via, side, board.tenting)) return
      push({
        kind: 'via',
        index: i,
        shape: {
          kind: 'circle',
          cx: nmToMm(via.position.x),
          cy: -nmToMm(via.position.y),
          r: nmToMm(via.size) / 2 + mm(viaMaskMargin(board))
        },
        ...(via.uuid ? { uuid: via.uuid } : {})
      })
    })
    const opened = (track: KicadTrackSegment | KicadTrackArc): number | null =>
      track.layer === outer ? trackMaskMargin(board, track) : null
    board.segments.forEach((seg, i) => {
      const margin = opened(seg)
      if (margin === null) return
      push({
        kind: 'track',
        index: i,
        shape: {
          kind: 'capsule',
          x0: nmToMm(seg.start.x),
          y0: -nmToMm(seg.start.y),
          x1: nmToMm(seg.end.x),
          y1: -nmToMm(seg.end.y),
          halfWidth: nmToMm(seg.width) / 2 + nmToMm(margin as Nm)
        },
        ...(seg.uuid ? { uuid: seg.uuid } : {})
      })
    })
    board.trackArcs.forEach((arc, i) => {
      const margin = opened(arc)
      if (margin === null) return
      push({
        kind: 'track',
        index: i,
        shape: {
          kind: 'arc',
          x0: nmToMm(arc.start.x),
          y0: -nmToMm(arc.start.y),
          mx: nmToMm(arc.mid.x),
          my: -nmToMm(arc.mid.y),
          x1: nmToMm(arc.end.x),
          y1: -nmToMm(arc.end.y),
          halfWidth: nmToMm(arc.width) / 2 + nmToMm(margin as Nm)
        },
        ...(arc.uuid ? { uuid: arc.uuid } : {})
      })
    })
  }

  if (!isCopperLayer(layer)) {
    // Zones drawn on the layer: a board zone by its fill there where it has one,
    // else by its outline. A footprint's zone is in board space too.
    type Ring = ReadonlyArray<{ x: Nm; y: Nm }>
    const zones: Array<{
      layers: string[]
      keepout: boolean
      rings: Ring[]
      i: number
      fp?: number
      uuid?: string
    }> = [
      ...board.zones.map((zone, i) => {
        const fills = zone.filledPolys.filter((f) => (f.layer ?? zone.layers[0]) === layer)
        return {
          layers: zone.layers,
          keepout: zone.isKeepout,
          rings: fills.length ? fills.map((f) => f.points) : [zone.points],
          i,
          uuid: zone.uuid
        }
      }),
      ...board.footprints.flatMap((bfp, fp) =>
        bfp.footprint.zones.map((zone, i) => ({
          layers: zone.layers,
          keepout: zone.isKeepout,
          rings: [zone.points],
          i,
          fp,
          uuid: zone.uuid
        }))
      )
    ]
    for (const zone of zones) {
      if (zone.keepout || !zone.layers.includes(layer)) continue
      const rings = zone.rings
        .map((points) => points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) })))
        .filter((ring) => ring.length >= 3)
      if (rings.length === 0) continue
      push({
        kind: 'zone',
        index: zone.i,
        shape: polyShape(rings),
        ...(zone.fp !== undefined ? { fp: zone.fp } : {}),
        ...(zone.uuid ? { uuid: zone.uuid } : {})
      })
    }
  }

  if (layer === 'F.CrtYd' || layer === 'B.CrtYd') {
    for (const courtyard of index.courtyards) {
      const regions = layer === 'F.CrtYd' ? courtyard.front : courtyard.back
      if (regions.length === 0) continue
      const parts = regions.map((region) => polyShape([region.outer, ...region.holes]))
      push({
        kind: 'courtyard',
        fp: courtyard.fp,
        courtyard,
        shape: parts.length === 1 ? parts[0] : { kind: 'compound', parts }
      })
    }
  }
  return pack(items)
}

/** A layer's items with their boxes packed for queries. */
function pack(items: LayerItem[]): LayerItems {
  const boxes = new Float64Array(items.length * 4)
  items.forEach((item, i) => {
    boxes[i * 4] = item.minX
    boxes[i * 4 + 1] = item.minY
    boxes[i * 4 + 2] = item.maxX
    boxes[i * 4 + 3] = item.maxY
  })
  const tree = new PackedRTree(boxes, items.length)
  return {
    items,
    query(minX, minY, maxX, maxY) {
      const out: LayerItem[] = []
      tree.search(minX, minY, maxX, maxY, (i) => out.push(items[i]))
      return out
    }
  }
}

const mm = (value: Nm): number => nmToMm(value)

/** A shape grown by a margin, mm (shrunk by a negative one). */
function grow(shape: CopperShape, by: number): CopperShape {
  if (by === 0) return shape
  switch (shape.kind) {
    case 'capsule':
    case 'arc':
      return { ...shape, halfWidth: Math.max(0, shape.halfWidth + by) }
    case 'circle':
      return { ...shape, r: Math.max(0, shape.r + by) }
    case 'rrect':
      return {
        ...shape,
        halfW: Math.max(0, shape.halfW + by),
        halfH: Math.max(0, shape.halfH + by),
        cornerR: Math.max(0, shape.cornerR + by)
      }
    case 'poly': {
      const regions = offset(
        [
          {
            outer: [...(shape.rings[0] ?? [])],
            holes: shape.rings.slice(1).map((ring) => [...ring])
          }
        ],
        by,
        { join: by > 0 ? 'round' : 'miter' }
      )
      const rings = regions.flatMap((region) => [region.outer, ...region.holes])
      return rings.length
        ? { ...polyShape(rings), ...(shape.frame ? { frame: shape.frame } : {}) }
        : shape
    }
    case 'compound':
      return { ...shape, parts: shape.parts.map((part) => grow(part, by)) }
  }
}

/** A shape grown by a margin on each axis, nm: a rounded rect by both, anything else by the first. */
function growAxes(shape: CopperShape, margin: { x: Nm; y: Nm }): CopperShape {
  if (shape.kind !== 'rrect' || margin.x === margin.y) return grow(shape, mm(margin.x))
  // The margins are the pad's own axes; the rect's halves are too, whatever its turn.
  const x = mm(margin.x)
  const y = mm(margin.y)
  return {
    ...shape,
    halfW: Math.max(0, shape.halfW + x),
    halfH: Math.max(0, shape.halfH + y),
    cornerR: Math.max(0, shape.cornerR + Math.min(x, y))
  }
}

/** A shape's box, from its outline where it is not simple. */
function boundsOf(shape: CopperShape): { minX: number; minY: number; maxX: number; maxY: number } {
  if (shape.kind === 'poly')
    return { minX: shape.minX, minY: shape.minY, maxX: shape.maxX, maxY: shape.maxY }
  if (shape.kind === 'compound') {
    const boxes = shape.parts.map(boundsOf)
    return {
      minX: Math.min(...boxes.map((b) => b.minX)),
      minY: Math.min(...boxes.map((b) => b.minY)),
      maxX: Math.max(...boxes.map((b) => b.maxX)),
      maxY: Math.max(...boxes.map((b) => b.maxY))
    }
  }
  if (shape.kind === 'circle')
    return {
      minX: shape.cx - shape.r,
      minY: shape.cy - shape.r,
      maxX: shape.cx + shape.r,
      maxY: shape.cy + shape.r
    }
  const points = shapeOutlines(shape, 0).flat()
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  }
}

/**
 * Every Edge.Cuts drawing on the board, board-level and inside footprints, as
 * world segments: lines as they are, arcs and circles as chords within the
 * copper index's arc tolerance, rectangles and polygons as their sides.
 */
export function edgeCutsSegments(board: KicadBoard): Array<[Pt, Pt]> {
  return edgeCutsSegmentsOf(board).map((segment) => segment.ends)
}

/** An Edge.Cuts segment with the drawing it is part of: its uuid, and its footprint if any. */
export interface EdgeSegment {
  ends: [Pt, Pt]
  uuid?: string
  fp?: number
  /**
   * Which piece of its drawing it is, as KiCad's edge checks split drawings: a
   * rectangle's sides and a polygon's segments are pieces apart; an arc's,
   * circle's or curve's chords, or a rounded rectangle's outline, are one.
   */
  piece: number
}

/** `edgeCutsSegments`, each segment knowing the drawing it came from. */
export function edgeCutsSegmentsOf(board: KicadBoard): EdgeSegment[] {
  const out: EdgeSegment[] = []
  let owner: { uuid?: string; fp?: number } = {}
  const push = (a: Pt, b: Pt, piece = 0): void => {
    out.push({ ends: [a, b], ...owner, piece })
  }
  /** A closed outline; `sides` makes each segment a piece of its own. */
  const ring = (points: Pt[], sides = false): void => {
    for (let i = 0, j = points.length - 1; i < points.length; j = i++)
      push(points[j], points[i], sides ? i : 0)
  }
  const collect = (
    fp:
      | Pick<KicadBoard, 'grLines' | 'grArcs' | 'grCircles' | 'grRects' | 'grPolys' | 'grCurves'>
      | KicadFootprint,
    at: (p: { x: Nm; y: Nm }) => Pt,
    fpIndex?: number
  ): void => {
    const own = (item: { uuid?: string }): void => {
      owner = {
        ...(item.uuid ? { uuid: item.uuid } : {}),
        ...(fpIndex !== undefined ? { fp: fpIndex } : {})
      }
    }
    const lines = 'fpLines' in fp ? fp.fpLines : fp.grLines
    const arcs = 'fpArcs' in fp ? fp.fpArcs : fp.grArcs
    const circles = 'fpCircles' in fp ? fp.fpCircles : fp.grCircles
    const rects = 'fpRects' in fp ? fp.fpRects : fp.grRects
    const polys = 'fpPolys' in fp ? fp.fpPolys : fp.grPolys
    const curves = 'fpCurves' in fp ? fp.fpCurves : fp.grCurves
    for (const line of lines)
      if (line.layer === EDGE_CUTS) {
        own(line)
        push(at(line.start), at(line.end))
      }
    for (const arc of arcs) {
      if (arc.layer !== EDGE_CUTS) continue
      own(arc)
      const a = at(arc.start)
      const m = at(arc.mid)
      const b = at(arc.end)
      const points = sampleArc(a.x, a.y, m.x, m.y, b.x, b.y)
      for (let i = 1; i < points.length; i++) push(points[i - 1], points[i])
    }
    for (const circle of circles) {
      if (circle.layer !== EDGE_CUTS) continue
      own(circle)
      const c = at(circle.center)
      const e = at(circle.end)
      const r = Math.hypot(e.x - c.x, e.y - c.y)
      if (r <= 0) continue
      // Two half arcs through the far side, each sampled to the arc tolerance.
      const far = { x: 2 * c.x - e.x, y: 2 * c.y - e.y }
      const top = { x: c.x - (e.y - c.y), y: c.y + (e.x - c.x) }
      const bottom = { x: c.x + (e.y - c.y), y: c.y - (e.x - c.x) }
      const half = sampleArc(e.x, e.y, top.x, top.y, far.x, far.y)
      const other = sampleArc(far.x, far.y, bottom.x, bottom.y, e.x, e.y)
      ring([...half.slice(0, -1), ...other.slice(0, -1)])
    }
    for (const rect of rects) {
      if (rect.layer !== EDGE_CUTS) continue
      own(rect)
      const outline = rectOutline(rect)
      const on = (p: { x: number; y: number }): Pt => at(p as { x: Nm; y: Nm })
      if (outline.kind === 'corners') {
        ring(outline.corners.map(on), true)
        continue
      }
      // Rounded corners: each quarter arc to the arc tolerance, sides between
      // them; each arc and each side a piece of its own.
      const arcs = outline.arcs.map((arc) => {
        const [s, m, e] = [on(arc.start), on(arc.mid), on(arc.end)]
        return sampleArc(s.x, s.y, m.x, m.y, e.x, e.y)
      })
      arcs.forEach((points, k) => {
        for (let i = 1; i < points.length; i++) push(points[i - 1], points[i], 2 * k)
        const next = arcs[(k + 1) % arcs.length][0]
        push(points[points.length - 1], next, 2 * k + 1)
      })
    }
    for (const poly of polys)
      if (poly.layer === EDGE_CUTS && poly.points.length >= 2) {
        own(poly)
        ring(poly.points.map(at), true)
      }
    for (const curve of curves) {
      if (curve.layer !== EDGE_CUTS || curve.points.length !== 4) continue
      own(curve)
      const points = bezierPoints(curve.points.map(at) as [Pt, Pt, Pt, Pt])
      for (let i = 1; i < points.length; i++) push(points[i - 1], points[i])
    }
  }
  collect(board, (p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) }))
  board.footprints.forEach((bfp, fp) => {
    const tf = footprintTransform(bfp)
    collect(bfp.footprint, (p) => tfPoint(tf, p.x, p.y), fp)
  })
  return out
}
