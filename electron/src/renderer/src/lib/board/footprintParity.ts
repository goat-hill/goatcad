/**
 * Whether a board footprint still matches its library copy, as KiCad's DRC
 * asks (`FOOTPRINT::FootprintNeedsUpdate` in DRC mode, 10.0.6): the answer is
 * the first difference found, in words, or null.
 *
 * KiCad places the library copy where the board's sits and compares the two
 * board-absolute. A board file holds a footprint's graphics and pads in the
 * footprint's own frame, so this compares there instead, turning nothing:
 * the library copy is flipped top to bottom when the board's is on the back
 * (`footprintFlip.ts`), and a pad's angle, which the board file holds
 * absolute, is read less the footprint's. Rule areas, which a board file
 * holds board-absolute, are brought into the footprint's frame.
 *
 * What is compared, as KiCad compares it: the footprint's type (SMD or
 * through hole), whether it allows bridged mask apertures, a custom stackup,
 * its net-tie groups; its graphic shapes — texts, text boxes, tables and
 * dimensions never — each against the one it sorts beside, their geometry
 * within 10 nm (an arc's middle within 0.5 µm), fill and layer, and the
 * stroke only on copper; its pads, each against the one it sorts beside:
 * number, position, die length, unused-layer removal, layers (a library pad
 * on `*.Cu` meets the board's copper), type, fabrication property, angle,
 * and on each of its copper layers the shape, size, trapezoid delta, corner
 * rounding and chamfer, and offset, then the drill and custom primitives;
 * and its rule areas' settings and corners. Clearance and mask overrides are
 * a design's to set, so DRC reads none of them; nor the reference, value or
 * any text.
 */
import type { KicadBoard, KicadBoardFootprint } from '../kicad/board'
import {
  padOnLayer,
  parseFlag,
  parseFootprintNode,
  type KicadFootprint,
  type KicadPad,
  type KicadPadPrimitives,
  isSolidFill
} from '../kicad/footprint'
import {
  findChild,
  findChildren,
  getAtomValues,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'
import { boardLayerFlipper, expandLayerToken, isCopperLayer } from '../kicad/layers'
import { padProperty } from '../footprint/klc'
import type { Nm } from '../kicad/coordinates'
import { flippedFootprintNode } from './footprintFlip'

type P = { x: number; y: number }

/** KiCad's point tolerance in this comparison, nm. */
const EPSILON = 10
/** How far an arc's middle may stray, nm: 0.5 µm, as its center is computed. */
const ARC_MID_EPSILON = 500
/** KiCad's tolerance on angles and ratios. */
const EPSILON_D = 0.00001

const near = (a: P | undefined, b: P | undefined, eps = EPSILON): boolean =>
  !!a && !!b && Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps

/** The library copy as it would sit on the board's side: flipped for a footprint on the back. */
const libraryOnSide = (
  board: KicadBoard,
  bfp: KicadBoardFootprint,
  lib: KicadFootprint
): KicadFootprint => {
  const onBack = bfp.layer === 'B.Cu'
  const libBack = (lib.layer ?? 'F.Cu') === 'B.Cu'
  if (onBack === libBack || lib._raw.type !== 'list') return lib
  return parseFootprintNode(
    flippedFootprintNode(
      lib._raw,
      { x: 0 as Nm, y: 0 as Nm },
      'topBottom',
      boardLayerFlipper(board.layers)
    )
  )
}

/** The first way a board footprint differs from its library copy; null when it matches. */
export function libraryDifference(
  board: KicadBoard,
  bfp: KicadBoardFootprint,
  library: KicadFootprint
): string | null {
  const own = bfp.footprint
  const lib = libraryOnSide(board, bfp, library)
  const attr = (fp: KicadFootprint, name: string): boolean => fp.attributes.includes(name)
  if (
    attr(own, 'smd') !== attr(lib, 'smd') ||
    attr(own, 'through_hole') !== attr(lib, 'through_hole')
  )
    return 'its type (SMD or through hole) differs'
  if (attr(own, 'allow_soldermask_bridges') !== attr(lib, 'allow_soldermask_bridges'))
    return 'whether it allows bridged solder mask apertures differs'
  if (hasStackup(own) !== hasStackup(lib)) return 'its stackup differs'
  const groups = (fp: KicadFootprint): string[] => {
    const node = fp._raw.type === 'list' ? findChild(fp._raw, 'net_tie_pad_groups') : null
    return node ? getAtomValues(node) : []
  }
  if (groups(own).join('\u0000') !== groups(lib).join('\u0000'))
    return 'its net-tie pad groups differ'

  const quarterTurn = (bfp.position.angle ?? 0) % 90 === 0
  const ownShapes = graphics(own, quarterTurn)
  const libShapes = graphics(lib, quarterTurn)
  if (ownShapes.length !== libShapes.length) return 'its graphic item count differs'
  for (let i = 0; i < ownShapes.length; i++)
    if (!sameGraphic(ownShapes[i], libShapes[i], true))
      return `a ${ownShapes[i].kind} on ${ownShapes[i].layer} differs`

  const enabled = new Set(board.layers.map((l) => l.name))
  const copper = board.layers.filter((l) => isCopperLayer(l.name)).map((l) => l.name)
  const fpAngle = bfp.position.angle ?? 0
  const ownPads = sortPads(own.pads)
  const libPads = sortPads(lib.pads)
  if (ownPads.length !== libPads.length) return 'its pad count differs'
  for (let i = 0; i < ownPads.length; i++) {
    const why = padDifference(ownPads[i], libPads[i], fpAngle, enabled, copper, !hasStackup(own))
    if (why) return `pad ${ownPads[i].number}: ${why}`
  }

  const ownZones = sortZones(own.zones.map((z) => zoneOf(z._raw, bfp)))
  const libZones = sortZones(lib.zones.map((z) => zoneOf(z._raw, null)))
  if (ownZones.length !== libZones.length) return 'its rule area count differs'
  for (let i = 0; i < ownZones.length; i++) {
    const why = zoneDifference(ownZones[i], libZones[i], enabled, copper)
    if (why) return `a rule area: ${why}`
  }
  return null
}

const hasStackup = (fp: KicadFootprint): boolean =>
  fp._raw.type === 'list' && findChild(fp._raw, 'stackup') !== null

// ---- Graphics ---------------------------------------------------------------

interface Graphic {
  kind: 'segment' | 'arc' | 'circle' | 'rect' | 'poly' | 'bezier'
  layer: string
  /** segment/rect/circle/bezier start (a circle's center); arc start. */
  a?: P
  b?: P
  /** An arc's middle; a Bézier's first control. */
  m?: P
  c2?: P
  points?: P[]
  width: number
  strokeType: string
  fill: string
}

/** KiCad's fill as it loads it: legacy files with no `fill` fill a thin rect or circle, and every poly. */
const fillOf = (fill: string | undefined, filledByDefault: boolean): string =>
  fill === undefined
    ? filledByDefault
      ? 'solid'
      : 'none'
    : isSolidFill(fill)
      ? 'solid'
      : fill === 'no'
        ? 'none'
        : fill

type Shapes = Pick<KicadPadPrimitives, 'lines' | 'arcs' | 'circles' | 'rects' | 'polys'> & {
  curves?: KicadFootprint['fpCurves']
}

/**
 * Shapes as KiCad compares them: a segment's ends in order; at a quarter turn
 * an axis-aligned four-sided poly is a rect, and at any other angle a rect is
 * the poly KiCad turns it into.
 */
function graphicsOf(shapes: Shapes, normalize: boolean, quarterTurn = true): Graphic[] {
  const out: Graphic[] = []
  const stroke = (s: {
    strokeWidth?: number
    layer?: string
    strokeType?: string
  }): Pick<Graphic, 'width' | 'strokeType' | 'layer'> => ({
    width: s.strokeWidth ?? 0,
    // A board shape's `default` style is solid, and so is a legacy `(width …)` with no type.
    strokeType: !s.strokeType || s.strokeType === 'default' ? 'solid' : s.strokeType,
    layer: s.layer ?? ''
  })
  for (const l of shapes.lines) {
    let [a, b]: P[] = [l.start, l.end]
    if (normalize && (a.x > b.x || (a.x === b.x && a.y < b.y))) [a, b] = [b, a]
    out.push({ kind: 'segment', a, b, fill: 'none', ...stroke(l) })
  }
  for (const arc of shapes.arcs)
    out.push({ kind: 'arc', a: arc.start, b: arc.end, m: arc.mid, fill: 'none', ...stroke(arc) })
  for (const c of shapes.circles) {
    const w = c.strokeWidth ?? 0
    out.push({ kind: 'circle', a: c.center, b: c.end, fill: fillOf(c.fill, w <= 0), ...stroke(c) })
  }
  for (const r of shapes.rects) {
    const w = r.strokeWidth ?? 0
    const a = { x: Math.min(r.start.x, r.end.x), y: Math.min(r.start.y, r.end.y) }
    const b = { x: Math.max(r.start.x, r.end.x), y: Math.max(r.start.y, r.end.y) }
    const fill = fillOf(r.fill, w <= 0)
    if (quarterTurn) out.push({ kind: 'rect', a, b, fill, ...stroke(r) })
    else {
      const points = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
      out.push({ kind: 'poly', points, fill, ...stroke(r) })
    }
  }
  for (const poly of shapes.polys) {
    const points = closed(poly.points)
    const rect = normalize && quarterTurn ? axisRect(points) : null
    const fill = fillOf(poly.fill, true)
    if (rect) out.push({ kind: 'rect', ...rect, fill, ...stroke(poly) })
    else out.push({ kind: 'poly', points, fill, ...stroke(poly) })
  }
  for (const c of shapes.curves ?? []) {
    const [a, m, c2, b] = c.points
    out.push({ kind: 'bezier', a, m, c2, b, fill: 'none', ...stroke(c) })
  }
  return out
}

/** A closed outline's corners, a last one repeating the first dropped, as KiCad closes a chain. */
const closed = (points: readonly P[]): P[] => {
  const last = points[points.length - 1]
  return points.length > 1 && last.x === points[0].x && last.y === points[0].y
    ? points.slice(0, -1)
    : [...points]
}

/** A poly of four sides alternately horizontal and vertical, as the rect KiCad reads it as. */
function axisRect(points: readonly P[]): { a: P; b: P } | null {
  if (points.length !== 4) return null
  const side = (i: number): [P, P] => [points[i], points[(i + 1) % 4]]
  const horizontal = (i: number): boolean => side(i)[0].y === side(i)[1].y
  const vertical = (i: number): boolean => side(i)[0].x === side(i)[1].x
  const alternating =
    (horizontal(0) && vertical(1) && horizontal(2) && vertical(3)) ||
    (vertical(0) && horizontal(1) && vertical(2) && horizontal(3))
  if (!alternating) return null
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return {
    a: { x: Math.min(...xs), y: Math.min(...ys) },
    b: { x: Math.max(...xs), y: Math.max(...ys) }
  }
}

const KIND_ORDER = ['segment', 'rect', 'arc', 'circle', 'poly', 'bezier']

/** The order both copies' graphics are paired in: kind, layer, then where each lies. */
const compareGraphics = (g: Graphic, h: Graphic): number => {
  if (g.layer !== h.layer) return g.layer < h.layer ? -1 : 1
  if (g.kind !== h.kind) return KIND_ORDER.indexOf(g.kind) - KIND_ORDER.indexOf(h.kind)
  const points = (x: Graphic): P[] =>
    x.kind === 'poly' ? (x.points ?? []) : [x.a, x.b, x.m, x.c2].filter((p): p is P => !!p)
  const gp = points(g)
  const hp = points(h)
  if (gp.length !== hp.length) return gp.length - hp.length
  for (let i = 0; i < gp.length; i++) {
    if (gp[i].x !== hp[i].x) return gp[i].x - hp[i].x
    if (gp[i].y !== hp[i].y) return gp[i].y - hp[i].y
  }
  return g.width - h.width
}

function graphics(fp: KicadFootprint, quarterTurn: boolean): Graphic[] {
  return graphicsOf(
    {
      lines: fp.fpLines,
      arcs: fp.fpArcs,
      circles: fp.fpCircles,
      rects: fp.fpRects,
      polys: fp.fpPolys,
      curves: fp.fpCurves
    },
    true,
    quarterTurn
  ).sort(compareGraphics)
}

/** KiCad's `shapeNeedsUpdate` (`primitiveNeedsUpdate` for a pad's, which always reads the stroke). */
function sameGraphic(g: Graphic, h: Graphic, strokeOnCopperOnly: boolean): boolean {
  if (g.kind !== h.kind) return false
  switch (g.kind) {
    case 'segment':
    case 'rect':
    case 'circle':
      if (!near(g.a, h.a) || !near(g.b, h.b)) return false
      break
    case 'arc':
      if (!near(g.a, h.a) || !near(g.b, h.b) || !near(g.m, h.m, ARC_MID_EPSILON)) return false
      break
    case 'bezier':
      if (!near(g.a, h.a) || !near(g.b, h.b) || !near(g.m, h.m) || !near(g.c2, h.c2)) return false
      break
    case 'poly':
      if ((g.points ?? []).length !== (h.points ?? []).length) return false
      if (!sameRing(g.points ?? [], h.points ?? [])) return false
  }
  const strokeRead = !strokeOnCopperOnly || isCopperLayer(g.layer)
  if (strokeRead && (g.width !== h.width || g.strokeType !== h.strokeType)) return false
  if (g.fill !== h.fill) return false
  return !strokeOnCopperOnly || g.layer === h.layer
}

/**
 * Two closed rings the same within the tolerance, as KiCad's cyclic
 * `CompareGeometry` has it: repeated and collinear corners dropped, then the
 * corners compared in their order round each ring's centroid — so where a
 * ring starts, and which way it winds, do not matter.
 */
function sameRing(a: readonly P[], b: readonly P[]): boolean {
  const ra = simplified(a)
  const rb = simplified(b)
  if (ra.length !== rb.length) return false
  const byAngle = (ring: P[]): P[] => {
    const cx = ring.reduce((sum, p) => sum + p.x, 0) / ring.length
    const cy = ring.reduce((sum, p) => sum + p.y, 0) / ring.length
    return [...ring].sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx))
  }
  const sa = byAngle(ra)
  const sb = byAngle(rb)
  return sa.every((p, i) => near(p, sb[i]))
}

/** A closed ring less repeated corners and corners on a straight run. */
function simplified(ring: readonly P[]): P[] {
  let points = ring.filter((p, i) => {
    const prev = ring[(i + ring.length - 1) % ring.length]
    return ring.length < 2 || p.x !== prev.x || p.y !== prev.y
  })
  let changed = true
  while (changed && points.length > 2) {
    changed = false
    const kept = points.filter((p, i) => {
      const prev = points[(i + points.length - 1) % points.length]
      const next = points[(i + 1) % points.length]
      return (p.x - prev.x) * (next.y - prev.y) - (p.y - prev.y) * (next.x - prev.x) !== 0
    })
    if (kept.length !== points.length) {
      points = kept
      changed = true
    }
  }
  return points
}

// ---- Pads -------------------------------------------------------------------

/** KiCad's natural order of pad numbers (`StrNumCmp`): digit runs compare as numbers. */
function numberOrder(a: string, b: string): number {
  const parts = (s: string): Array<string | number> =>
    (s.match(/\d+|\D+/g) ?? []).map((p) => (/^\d/.test(p) ? Number(p) : p.toLowerCase()))
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x) < String(y) ? -1 : 1
  }
  return pa.length - pb.length
}

/**
 * A pad's number as KiCad loads it: an unplated hole, or a pad on no copper,
 * has none, whatever an older file gave it (`PAD::CanHaveNumber`).
 */
const numberOf = (pad: KicadPad): string =>
  pad.type === 'np_thru_hole' || !pad.layers.some(isCopperLayer) ? '' : pad.number

const sortPads = (pads: readonly KicadPad[]): KicadPad[] =>
  [...pads].sort(
    (a, b) =>
      numberOrder(numberOf(a), numberOf(b)) ||
      a.position.x - b.position.x ||
      a.position.y - b.position.y ||
      a.size.w - b.size.w ||
      a.size.h - b.size.h ||
      (a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0) ||
      (a.layers.join() < b.layers.join() ? -1 : a.layers.join() > b.layers.join() ? 1 : 0)
  )

const angle360 = (degrees: number): number => ((degrees % 360) + 360) % 360

const rawNumber = (raw: SExprNode, token: string): number | undefined => {
  const node = raw.type === 'list' ? findChild(raw, token) : null
  const value = node ? getAtomValues(node)[0] : undefined
  return value === undefined ? undefined : Number(value)
}

/** A pad's shape as KiCad names it: a rounded rect with chamfered corners is its own shape. */
const shapeOf = (pad: KicadPad): string =>
  (pad.chamfer?.length ?? 0) > 0 && (pad.shape === 'roundrect' || pad.shape === 'rect')
    ? 'chamfered'
    : pad.shape

/** The copper layers a pad's padstack holds apart (`UniqueLayers`). */
function uniqueLayers(pad: KicadPad, copper: readonly string[]): string[] {
  const stack = pad.padstack
  if (!stack) return ['F.Cu']
  if (stack.mode === 'front_inner_back')
    return copper.length > 2
      ? ['F.Cu', copper.find((l) => l !== 'F.Cu' && l !== 'B.Cu')!, 'B.Cu']
      : ['F.Cu', 'B.Cu']
  return copper.filter((l) => pad.layers.some((t) => expandLayerToken(t, copper).includes(l)))
}

/** A pad's layers on this board: its tokens expanded, less any layer the board lacks. */
const boardLayers = (
  pad: { layers: readonly string[] },
  enabled: ReadonlySet<string>,
  copper: readonly string[]
): Set<string> =>
  new Set(pad.layers.flatMap((t) => expandLayerToken(t, copper)).filter((l) => enabled.has(l)))

/**
 * KiCad's layer match: exact, or where the footprint takes the board's inner
 * copper (no stackup of its own) — outer copper and every other layer exact,
 * the library's inner copper held by the board's.
 */
function layersMatch(own: Set<string>, lib: Set<string>, expand: boolean): boolean {
  const inner = (l: string): boolean => isCopperLayer(l) && l !== 'F.Cu' && l !== 'B.Cu'
  const same = (f: (l: string) => boolean): boolean => {
    const a = [...own].filter(f).sort()
    const b = [...lib].filter(f).sort()
    return a.length === b.length && a.every((l, i) => l === b[i])
  }
  if (!expand) return same(() => true)
  if (!same((l) => !inner(l))) return false
  return [...lib].filter(inner).every((l) => own.has(l))
}

function padDifference(
  a: KicadPad,
  b: KicadPad,
  fpAngle: number,
  enabled: ReadonlySet<string>,
  copper: readonly string[],
  expand: boolean
): string | null {
  if ((rawNumber(a._raw, 'die_length') ?? 0) !== (rawNumber(b._raw, 'die_length') ?? 0))
    return 'pad to die length differs'
  if (!near(a.position, b.position)) return 'position differs'
  if (numberOf(a) !== numberOf(b)) return 'number differs'
  const flag = (p: KicadPad, token: string): boolean =>
    p._raw.type === 'list' && parseFlag(p._raw, token)
  const remove = (p: KicadPad): boolean => flag(p, 'remove_unused_layers')
  const keep = (p: KicadPad): boolean => flag(p, 'keep_end_layers')
  if (remove(a) !== remove(b) || (remove(a) && keep(a) !== keep(b))) return 'layers differ'
  if (!layersMatch(boardLayers(a, enabled, copper), boardLayers(b, enabled, copper), expand))
    return 'layers differ'
  if (a.type !== b.type) return 'pad type differs'
  if (padProperty(a._raw) !== padProperty(b._raw)) return 'fabrication property differs'
  const turn = Math.abs(
    angle360((a.position.angle ?? 0) - fpAngle) - angle360(b.position.angle ?? 0)
  )
  if (turn > EPSILON_D && Math.abs(turn - 360) > EPSILON_D) return 'orientation differs'
  for (const layer of uniqueLayers(a, copper)) {
    const pa = padOnLayer(a, layer)
    const pb = padOnLayer(b, layer)
    if (shapeOf(pa) !== shapeOf(pb)) return `pad shape differs on ${layer}`
    if (pa.size.w !== pb.size.w || pa.size.h !== pb.size.h) return `size differs on ${layer}`
    const delta = (p: KicadPad): P => p.rectDelta ?? { x: 0, y: 0 }
    if (delta(pa).x !== delta(pb).x || delta(pa).y !== delta(pb).y)
      return `trapezoid delta differs on ${layer}`
    const shape = shapeOf(pa)
    if (
      (shape === 'roundrect' || shape === 'chamfered') &&
      Math.abs((pa.roundrectRatio ?? 0.25) - (pb.roundrectRatio ?? 0.25)) > EPSILON_D
    )
      return `rounded corners differ on ${layer}`
    if (shape === 'chamfered') {
      if (Math.abs((pa.chamferRatio ?? 0.2) - (pb.chamferRatio ?? 0.2)) > EPSILON_D)
        return `chamfered corner sizes differ on ${layer}`
      if ([...(pa.chamfer ?? [])].sort().join() !== [...(pb.chamfer ?? [])].sort().join())
        return `chamfered corners differ on ${layer}`
    }
    const offset = (p: KicadPad): P => p.drill?.offset ?? { x: 0, y: 0 }
    if (!near(offset(pa), offset(pb))) return `shape offset from hole differs on ${layer}`
  }
  const drill = (p: KicadPad): { oval: boolean; w: number; h: number } => ({
    oval: !!p.drill?.oval,
    w: p.drill ? (p.drill.oval?.width ?? p.drill.diameter) : 0,
    h: p.drill ? (p.drill.oval?.height ?? p.drill.diameter) : 0
  })
  if (drill(a).oval !== drill(b).oval) return 'drill shape differs'
  if (drill(a).w !== drill(b).w || drill(a).h !== drill(b).h) return 'drill size differs'
  for (const layer of uniqueLayers(a, copper)) {
    const pa = padOnLayer(a, layer).primitives
    const pb = padOnLayer(b, layer).primitives
    const ga = pa ? graphicsOf(pa, false) : []
    const gb = pb ? graphicsOf(pb, false) : []
    if (ga.length !== gb.length || ga.some((g, i) => !sameGraphic(g, gb[i], false)))
      return `shape primitives differ on ${layer}`
  }
  return null
}

// ---- Rule areas --------------------------------------------------------------

interface Zone {
  /** Settings KiCad compares, each as written, defaults filled in. */
  settings: Record<string, string>
  layers: string[]
  /** The outline's corners in the footprint's frame, nm. */
  outline: P[]
}

/** A zone's own settings and outline; a board's held board-absolute is brought into its footprint's frame. */
function zoneOf(raw: SExprNode, bfp: KicadBoardFootprint | null): Zone {
  const node = raw as SExprList
  const value = (path: string[], fallback = ''): string => {
    let at: SExprList | null = node
    for (const token of path) at = at ? findChild(at, token) : null
    return at ? getAtomValues(at).join(' ') : fallback
  }
  const settings: Record<string, string> = {
    name: value(['name']),
    priority: value(['priority'], '0'),
    keepout: value(['keepout'], 'none'),
    ruleArea: findChild(node, 'keepout') || findChild(node, 'placement') ? 'yes' : 'no',
    connect: value(['connect_pads']) || 'thermal',
    clearance: value(['connect_pads', 'clearance']),
    minThickness: value(['min_thickness']),
    fill: value(['fill']),
    thermalGap: value(['fill', 'thermal_gap']),
    thermalWidth: value(['fill', 'thermal_bridge_width']),
    smoothing: value(['fill', 'smoothing'], 'none'),
    radius: value(['fill', 'radius'], '0'),
    islandMode: value(['fill', 'island_removal_mode'], '0'),
    islandArea: value(['fill', 'island_area_min']),
    hatch: [
      value(['fill', 'hatch_thickness']),
      value(['fill', 'hatch_gap']),
      value(['fill', 'hatch_orientation']),
      value(['fill', 'hatch_smoothing_level']),
      value(['fill', 'hatch_smoothing_value']),
      value(['fill', 'hatch_min_hole_area'])
    ].join('|')
  }
  for (const rule of ['tracks', 'vias', 'pads', 'copperpour', 'footprints'])
    settings[`keepout ${rule}`] = value(['keepout', rule])
  const layersNode = findChild(node, 'layers') ?? findChild(node, 'layer')
  const layers = layersNode ? getAtomValues(layersNode) : []
  const polygon = findChild(node, 'polygon')
  const pts = polygon ? findChild(polygon, 'pts') : null
  const points: P[] = (pts ? findChildren(pts, 'xy') : []).map((xy) => {
    const [x, y] = getAtomValues(xy).map((v) => Math.round(Number(v) * 1e6))
    return { x, y }
  })
  const outline = closed(points)
  return { settings, layers, outline: bfp ? outline.map((p) => toFootprintFrame(p, bfp)) : outline }
}

/** A board-absolute point in a footprint's own frame, nm. */
function toFootprintFrame(p: P, bfp: KicadBoardFootprint): P {
  const dx = p.x - bfp.position.x
  const dy = p.y - bfp.position.y
  // Board y runs down, so a footprint turned θ counterclockwise on screen maps
  // its frame's (x, y) to (x cos θ + y sin θ, −x sin θ + y cos θ): undo that.
  const t = ((bfp.position.angle ?? 0) * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return { x: Math.round(dx * c - dy * s), y: Math.round(dx * s + dy * c) }
}

const sortZones = (zones: Zone[]): Zone[] =>
  zones.sort(
    (a, b) =>
      Number(a.settings.priority) - Number(b.settings.priority) ||
      (a.layers.join() < b.layers.join() ? -1 : a.layers.join() > b.layers.join() ? 1 : 0) ||
      a.outline.length - b.outline.length
  )

function zoneDifference(
  a: Zone,
  b: Zone,
  enabled: ReadonlySet<string>,
  copper: readonly string[]
): string | null {
  for (const key of Object.keys(a.settings))
    if (a.settings[key] !== b.settings[key]) return `${key} differs`
  // A library area on an inner layer takes whatever inner layers the board has.
  const expand = b.layers.some((l) => l === 'In1.Cu' || l === '*.Cu' || l === '*In.Cu')
  if (!layersMatch(boardLayers(a, enabled, copper), boardLayers(b, enabled, copper), expand))
    return 'layers differ'
  if (!sameRing(a.outline, b.outline)) return 'corners differ'
  return null
}
