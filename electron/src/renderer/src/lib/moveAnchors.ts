// Where a move can grab an item, and what it can snap to: KiCad's
// `PCB_GRID_HELPER::computeAnchors`, over the shapes the board and the
// footprint share. File space (nm, y down); the scenes carry them into theirs.

import { extraGraphicPivot } from './board/extraGraphics'
import { arcCenterFromPoints } from './kicad/kicadArc'
import type {
  KicadExtraGraphic,
  KicadFootprint,
  KicadFpArc,
  KicadFpCircle,
  KicadFpLine,
  KicadFpPoly,
  KicadFpRect
} from './kicad/footprint'
import { footprintCollection } from './footprint/footprintPropertySchema'
import { spacingToMm } from './kicad/coordinates'

export interface AnchorPoint {
  x: number
  y: number
}

const mid = (a: AnchorPoint, b: AnchorPoint): AnchorPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2
})

/** A line's or a track's ends and middle. */
export const lineAnchors = (line: Pick<KicadFpLine, 'start' | 'end'>): AnchorPoint[] => [
  line.start,
  line.end,
  mid(line.start, line.end)
]

/** An arc's ends and middle, and — a drawn arc's, not a track's — its center. */
export const arcAnchors = (
  arc: Pick<KicadFpArc, 'start' | 'mid' | 'end'>,
  center = true
): AnchorPoint[] => [
  arc.start,
  arc.end,
  arc.mid,
  ...(center ? [arcCenterFromPoints(arc.start, arc.mid, arc.end)] : [])
]

export const circleAnchors = (circle: Pick<KicadFpCircle, 'center'>): AnchorPoint[] => [
  circle.center
]

/** A rectangle's corners, edge middles and center. */
export const rectAnchors = (rect: Pick<KicadFpRect, 'start' | 'end'>): AnchorPoint[] => {
  const { start: a, end: b } = rect
  const corners = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
  return [...corners, ...corners.map((c, i) => mid(c, corners[(i + 1) % 4])), mid(a, b)]
}

export const polyAnchors = (poly: Pick<KicadFpPoly, 'points'>): AnchorPoint[] => poly.points

/** The footprint editor's extra graphics: Béziers, text boxes, tables, points. */
const EXTRA_TYPES = new Set(['curve', 'textbox', 'table', 'point'])

/** Where a move can grab a footprint editor item (footprint-local nm). */
export function footprintItemAnchors(
  footprint: KicadFootprint,
  ref: { type: string; index: number }
): AnchorPoint[] {
  const item = footprintCollection(footprint, ref.type)?.[ref.index]
  if (!item) return []
  switch (ref.type) {
    case 'pad':
      return [footprint.pads[ref.index].position]
    case 'line':
      return lineAnchors(item as KicadFpLine)
    case 'arc':
      return arcAnchors(item as KicadFpArc)
    case 'circle':
      return circleAnchors(item as KicadFpCircle)
    case 'rect':
      return rectAnchors(item as KicadFpRect)
    case 'poly':
    case 'zone':
      return polyAnchors(item as KicadFpPoly)
    case 'text':
    case 'property': {
      const position = (item as { position?: AnchorPoint }).position
      return position ? [position] : []
    }
  }
  return EXTRA_TYPES.has(ref.type) ? [extraGraphicPivot(item as KicadExtraGraphic)] : []
}

/**
 * What a move in the footprint editor snaps to, as KiCad's defaults there
 * have it (magnetic pads always, graphics on): the pads and drawings on the
 * active layer, the moved ones aside.
 */
export function footprintSnapTargets(
  footprint: KicadFootprint,
  moved: readonly { type: string; index: number }[],
  onActiveLayer: (layers: readonly string[]) => boolean
): AnchorPoint[] {
  const skip = new Set(moved.map((ref) => `${ref.type}:${ref.index}`))
  const targets: AnchorPoint[] = []
  const add = (type: string, items: readonly { layer?: string }[]): void =>
    items.forEach((item, index) => {
      if (!skip.has(`${type}:${index}`) && item.layer && onActiveLayer([item.layer]))
        targets.push(...footprintItemAnchors(footprint, { type, index }))
    })
  footprint.pads.forEach((pad, index) => {
    if (!skip.has(`pad:${index}`) && onActiveLayer(pad.layers)) targets.push(pad.position)
  })
  add('line', footprint.fpLines)
  add('arc', footprint.fpArcs)
  add('circle', footprint.fpCircles)
  add('rect', footprint.fpRects)
  add('poly', footprint.fpPolys)
  return targets
}

/** What a moved part is to KiCad's schematic and symbol grid helper. */
export type MoveRole = 'connectable' | 'wire' | 'text' | 'graphic'

/**
 * The anchors a schematic or symbol move may grab by (`EE_GRID_HELPER`): a
 * text's or a drawing's only while nothing connectable or wire moves with it.
 */
export function roleAnchors<P>(parts: readonly { role: MoveRole; anchors: readonly P[] }[]): P[] {
  const wired = parts.some((part) => part.role === 'connectable' || part.role === 'wire')
  return parts.flatMap((part) =>
    wired && (part.role === 'text' || part.role === 'graphic') ? [] : part.anchors
  )
}

const ROLE_GRID_MIL = { connectable: 50, wire: 50, text: 10 } as const

/**
 * The grid a schematic or symbol selection moves on, mm: KiCad's grid
 * overrides, on by default — connectables and wires 50 mil, text 10 mil,
 * graphics the current grid — the coarsest of its parts'. Null for none.
 */
export function roleGrid(roles: Iterable<MoveRole>, currentMm: number): number | null {
  let grid: number | null = null
  for (const role of roles) {
    const mm = role === 'graphic' ? currentMm : spacingToMm(ROLE_GRID_MIL[role], 'mil')
    grid = Math.max(grid ?? 0, mm)
  }
  return grid
}
