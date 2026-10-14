/**
 * Boards for the router tests. Net 1 is routed; nets 2 and 3 are obstacles.
 * Source coordinates are KiCad's (y down); the router works y up, so a
 * source y of −0.5 is a world y of +0.5.
 */

import { parseKicadBoard } from '../../../kicad/board'
import { BoardSpatialIndex, type CopperItem, type Pt } from '../../spatialIndex'
import { DEFAULT_DESIGN_RULES, DEFAULT_NET_CLASSES } from '../../../kicad/project'
import { boardRules } from '../../rules/boardRules'
import { RouterWorld } from '../world'
import { routerBounds } from '../boundaries'
import { routerRules } from '../rules'
import type { RouteRequest } from '../engine'

const parse = (body: string): ReturnType<typeof parseKicadBoard> =>
  parseKicadBoard(`(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "SIG")
  (net 2 "OBS")
  (net 3 "OBS2")
${body}
)`)

/** A board's router world; its edge, if `body` draws one, held at `edgeClearance`. */
export const world = (body: string, edgeClearance = 0.5): RouterWorld => {
  const board = parse(body)
  return new RouterWorld(BoardSpatialIndex.build(board), undefined, () =>
    routerBounds(board, edgeClearance)
  )
}

/**
 * A board's router world holding each item to the clearance the rules give
 * it: the default net class's (0.2), pad overrides, and `ruleText` as the
 * project's `.kicad_dru`.
 */
export const rulesWorld = (body: string, ruleText?: string): RouterWorld => {
  const board = parse(body)
  const rules = boardRules(
    board,
    {
      rules: { ...DEFAULT_DESIGN_RULES },
      classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
      patterns: [],
      assignments: []
    },
    ruleText
  )
  return new RouterWorld(
    BoardSpatialIndex.build(board),
    undefined,
    () => routerBounds(board, rules.resolver.worst('edge_clearance')),
    () => routerRules(rules)
  )
}

/** A closed Edge.Cuts outline through source points. */
export const outline = (...points: Array<[number, number]>): string =>
  `(gr_poly (pts ${points.map(([x, y]) => `(xy ${x} ${y})`).join(' ')}) (stroke (width 0.05)) (layer "Edge.Cuts") (fill none) (uuid "edge-${points.length}-${points[0].join('-')}"))`

/** A keepout forbidding tracks over a source rectangle, on F.Cu. */
export const keepout = (x0: number, y0: number, x1: number, y1: number): string =>
  `(zone (layers "F.Cu") (uuid "ko-${x0}-${y0}") (hatch full 0.5)
    (keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))
    (polygon (pts (xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1}))))`

export const request = (
  tail: Pt,
  cursor: Pt,
  overrides: Partial<RouteRequest> = {}
): RouteRequest => ({
  mode: 'walkaround',
  tail,
  cursor,
  cornerMode: 'free',
  diagFirst: true,
  layer: 'F.Cu',
  width: 0.5,
  clearance: 0.5,
  net: 1,
  ...overrides
})

/** A square SMD pad of net 2, centered at a source position; `extra` goes inside the pad. */
export const pad = (x: number, y: number, size = 2, name = 'P', extra = ''): string =>
  `(footprint "T:${name}" (layer "F.Cu") (uuid "f-${name}-${x}-${y}") (at ${x} ${y})
    (pad "1" smd rect (at 0 0) (size ${size} ${size}) (layers "F.Cu") (net 2 "OBS")${extra}))`

export const track = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  net = 2,
  extra = ''
): string =>
  `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.5) (layer "F.Cu") (net ${net})${extra} (uuid "s-${x0}-${y0}-${x1}-${y1}-${net}"))`

export const via = (x: number, y: number, net = 2, extra = ''): string =>
  `(via (at ${x} ${y}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net ${net})${extra} (uuid "v-${x}-${y}"))`

export const seedAt = (w: RouterWorld, x: number, y: number): CopperItem => {
  const item = w.base.near(x, y, 0.3, {}).find((h) => h.item.ref.type === 'segment')?.item
  if (!item) throw new Error('no segment at seed point')
  return item
}

export type Seg = { x0: number; y0: number; x1: number; y1: number }

export const pointsOf = (segments: readonly Seg[]): Pt[] =>
  segments.length === 0
    ? []
    : [{ x: segments[0].x0, y: segments[0].y0 }, ...segments.map((s) => ({ x: s.x1, y: s.y1 }))]

/** Every segment at a multiple of 45° (or of 90°). */
export const allAngled = (path: readonly Pt[], step: 45 | 90 = 45): boolean =>
  path.every((p, i) => {
    if (i === 0) return true
    const a = (Math.atan2(p.y - path[i - 1].y, p.x - path[i - 1].x) * 180) / Math.PI
    const r = ((a % step) + step) % step
    return r < 1e-6 || step - r < 1e-6
  })

export const maxY = (path: readonly Pt[]): number => Math.max(...path.map((p) => p.y))
export const minY = (path: readonly Pt[]): number => Math.min(...path.map((p) => p.y))
