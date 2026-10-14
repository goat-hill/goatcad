// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Flip a placed footprint to the other side of the board — KiCad's
 * `FOOTPRINT::Flip`, which the file has to match: a flipped footprint must
 * read back in KiCad as the part KiCad's own flip makes. The steps follow
 * KiCad 10.0.6 (`pcbnew/footprint.cpp`, `pad.cpp`, `padstack.cpp`,
 * `pcb_text.cpp`, `pcb_textbox.cpp`, `pcb_dimension.cpp`, `zone.cpp`,
 * `common/eda_shape.cpp`, `board.cpp`'s `recalcOpposites`, and the writer's
 * rules for what it omits) and are checked against its Python module. A
 * footprint holding a table is not flipped (`footprintFlippable`).
 *
 * KiCad mirrors top-bottom about the footprint's own anchor, then for a
 * left-right flip (its default) turns the part 180° about the flip center. In
 * the file's terms, where a footprint's children sit in its own frame:
 * - the anchor mirrors about the center, and its angle negates (plus 180°
 *   left-right), folded into (-180°, 180°];
 * - every child's own-frame y negates; a pad's angle negates (plus 180°)
 *   into [0°, 360°), and its drill offset, trapezoid delta, chamfered corners
 *   and custom primitives mirror in its frame;
 * - a text's angle becomes 180° less itself (left-right: its negation folded
 *   into [0°, 360°)), a side-specific text toggles its mirror, and a text kept
 *   upright past 180° turns half a turn and swaps its justification
 *   (`PCB_TEXT::KeepUpright`, which the 180° turn runs);
 * - zones, points and dimensions, which a board file holds board-absolute,
 *   mirror about the center; a dimension's text is placed again from its new
 *   geometry, as KiCad's `updateText` places it;
 * - every layer takes its opposite on this board: F ↔ B, inner copper
 *   end for end, paired front / back user layers; a padstack's front and back
 *   copper trade places.
 *
 * The own-frame arithmetic here is exact. KiCad holds a footprint's children
 * board-absolute and rounds each time it turns them by the footprint's angle,
 * so at an angle off the quarter turns its coordinates can land a nanometer
 * from these.
 *
 * The flip writes a new footprint node in place of the old one, so the board
 * remap parses it fresh and the old domain objects keep the pre-flip geometry
 * the edit delta and the refill base read.
 */

import { formatNmAtom, mmAtomToNm, nm, type Nm } from '../kicad/coordinates'
import type { KicadBoard, KicadBoardFootprint } from '../kicad/board'
import { INNER_COPPER_LAYER, boardLayerFlipper, kicadLayerId } from '../kicad/layers'
import {
  angleOf,
  arcCenterFromPoints,
  arcMid,
  kiRound,
  rotateAbout,
  roundPoint
} from '../kicad/kicadArc'
import {
  cloneNodeDeep,
  findChild,
  findChildren,
  getToken,
  makeAtom,
  makeList,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'

type Pt = { x: Nm; y: Nm }

/** `leftRight` mirrors across a vertical line (KiCad's default), `topBottom` across a horizontal one. */
export type BoardFlipDirection = 'leftRight' | 'topBottom'

// ---------------------------------------------------------------------------
// Raw-node helpers
// ---------------------------------------------------------------------------

export const xyOf = (node: SExprList): Pt | null => {
  const [, x, y] = node.children
  if (x?.type !== 'atom' || y?.type !== 'atom') return null
  return { x: mmAtomToNm(x.value), y: mmAtomToNm(y.value) }
}

export const writeXY = (node: SExprList, p: Pt): void => {
  const [, x, y] = node.children
  if (x?.type === 'atom') x.value = formatNmAtom(p.x)
  if (y?.type === 'atom') y.value = formatNmAtom(p.y)
}

export const mapChildXY = (node: SExprList, token: string, map: (p: Pt) => Pt): void => {
  const child = findChild(node, token)
  const p = child && xyOf(child)
  if (child && p) writeXY(child, map(p))
}

/** A `(token n)` child's number. */
const numberChild = (node: SExprList | null, token: string): number | undefined => {
  const child = node && findChild(node, token)
  const atom = child?.children[1]
  return atom?.type === 'atom' ? Number(atom.value) : undefined
}

/** Every `(xy …)` of a `pts`, and each `(arc (start) (mid) (end))` in it. */
export const mapPts = (pts: SExprList, map: (p: Pt) => Pt): void => {
  for (const item of pts.children) {
    if (item.type !== 'list') continue
    const token = getToken(item)
    if (token === 'xy') {
      const p = xyOf(item)
      if (p) writeXY(item, map(p))
    } else if (token === 'arc') {
      for (const t of ['start', 'mid', 'end']) mapChildXY(item, t, map)
    }
  }
}

/**
 * A tuning pattern's points (`(generated (type tuning_pattern) …)`): its
 * origin and end, and its base lines; they move, turn and flip with its tracks.
 */
export const mapTuningPatternPoints = (node: SExprList, map: (p: Pt) => Pt): void => {
  for (const token of ['origin', 'end']) {
    const holder = findChild(node, token)
    const xy = holder && findChild(holder, 'xy')
    const p = xy && xyOf(xy)
    if (xy && p) writeXY(xy, map(p))
  }
  for (const token of ['base_line', 'base_line_coupled']) {
    const holder = findChild(node, token)
    const pts = holder && findChild(holder, 'pts')
    if (pts) mapPts(pts, map)
  }
}

/** A graphic's points (`EDA_SHAPE::flip`): ends, center, `pts`; an arc is its own case. */
const mirrorShape = (node: SExprList, map: (p: Pt) => Pt): void => {
  const token = getToken(node)
  if ((token === 'fp_arc' || token === 'gr_arc') && mirrorArc(node, map)) return
  for (const t of ['start', 'mid', 'end', 'center']) mapChildXY(node, t, map)
  const pts = findChild(node, 'pts')
  if (pts) mapPts(pts, map)
}

/**
 * KiCad holds an arc by its center, found on load from the file's three
 * points (`SetArcGeometry`), mirrors that with the ends and swaps them, and
 * writes the mid it computes back (`GetArcMid`) — so the mid is recomputed
 * here the same way, not mirrored, to land on KiCad's integer.
 */
const mirrorArc = (node: SExprList, map: (p: Pt) => Pt): boolean => {
  const s = findChild(node, 'start')
  const m = findChild(node, 'mid')
  const e = findChild(node, 'end')
  const ps = s && xyOf(s)
  const pm = m && xyOf(m)
  const pe = e && xyOf(e)
  if (!s || !m || !e || !ps || !pm || !pe) return false
  const center = roundPoint(arcCenterFromPoints(ps, pm, pe))
  const start = map(pe)
  const end = map(ps)
  const c = map({ x: nm(center.x), y: nm(center.y) })
  const mid = arcMid(start, end, c)
  writeXY(s, start)
  writeXY(m, { x: nm(mid.x), y: nm(mid.y) })
  writeXY(e, end)
  return true
}

/**
 * Rename every layer atom of a `(token …)` child. A `(layers …)` list is then
 * put back in KiCad's order (`formatLayers`): its wildcards first, the named
 * layers by id.
 */
const flipLayerAtoms = (node: SExprList, token: string, flip: (l: string) => string): void => {
  for (const child of findChildren(node, token)) {
    for (const atom of child.children.slice(1)) {
      if (atom.type === 'atom' && !KNOCKOUT.has(atom.value)) atom.value = flip(atom.value)
    }
    if (token === 'layers') sortLayerAtoms(child)
  }
}

const isWildcard = (name: string): boolean => name.startsWith('*.') || name.startsWith('F&B.')

const sortLayerAtoms = (list: SExprList): void => {
  const [head, ...rest] = list.children
  const name = (a: SExprNode): string => (a.type === 'atom' ? a.value : '')
  const wild = rest.filter((a) => isWildcard(name(a)))
  const named = rest
    .filter((a) => !isWildcard(name(a)))
    .sort((a, b) => kicadLayerId(name(a)) - kicadLayerId(name(b)))
  list.children = [head!, ...wild, ...named]
}

/** Keywords that ride in a `(layer …)` list beside the name. */
const KNOCKOUT = new Set(['knockout'])

/** `(at x y angle)`'s angle, undefined when the file wrote none. */
export const atAngle = (at: SExprList): number | undefined => {
  const a = at.children[3]
  return a?.type === 'atom' ? Number(a.value) : undefined
}

/** `EDA_UNIT_UTILS::FormatAngle`: degrees to ten significant digits. */
const formatAngle = (degrees: number): string => {
  const value = Number(degrees.toPrecision(10))
  return Object.is(value, -0) ? '0' : String(value)
}

/** Write `(at …)`'s angle; undefined drops it. */
export const setAtAngle = (at: SExprList, angle: number | undefined): void => {
  if (angle === undefined) {
    if (at.children.length > 3) at.children = at.children.slice(0, 3)
    return
  }
  const value = formatAngle(angle)
  const a = at.children[3]
  if (a?.type === 'atom') a.value = value
  else at.children.push(makeAtom(value, false, at.start))
}

/** Degrees folded into [0, 360) — `EDA_ANGLE::Normalize`. */
export const normalize = (a: number): number => {
  const r = ((a % 360) + 360) % 360
  return r === 360 ? 0 : r
}

/** Degrees folded into (-180, 180] — `EDA_ANGLE::Normalize180`. */
const normalize180 = (a: number): number => {
  const r = normalize(a)
  return r > 180 ? r - 360 : r
}

/** Degrees folded into (-360, 360) — `EDA_ANGLE::Normalize720`. */
const normalize720 = (a: number): number => {
  let r = a
  while (r >= 360) r -= 360
  while (r <= -360) r += 360
  return r
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const H_SWAP: Record<string, string> = { left: 'right', right: 'left' }
const V_SWAP: Record<string, string> = { top: 'bottom', bottom: 'top' }

/** Rewrite `(effects (justify …))` through `edit`, which takes and returns its atoms; empty drops it. */
const editJustify = (node: SExprList, edit: (atoms: string[]) => string[]): void => {
  const effects = findChild(node, 'effects')
  if (!effects) return
  const justify = findChild(effects, 'justify')
  const before = justify
    ? justify.children.slice(1).flatMap((a) => (a.type === 'atom' ? [a.value] : []))
    : []
  const after = edit(before)
  // KiCad writes horizontal, then vertical, then mirror.
  const ordered = [
    ...after.filter((a) => a === 'left' || a === 'right'),
    ...after.filter((a) => a === 'top' || a === 'bottom'),
    ...after.filter((a) => a === 'mirror')
  ]
  if (ordered.length === 0) {
    if (justify) effects.children = effects.children.filter((c) => c !== justify)
    return
  }
  const at = effects.start
  const atoms = [makeAtom('justify', false, at), ...ordered.map((a) => makeAtom(a, false, at))]
  if (justify) justify.children = atoms
  else {
    const font = effects.children.findIndex((c) => c.type === 'list' && getToken(c) === 'font')
    effects.children.splice(font === -1 ? 1 : font + 1, 0, makeList(atoms, at))
  }
}

const toggleMirror = (node: SExprList): void =>
  editJustify(node, (atoms) =>
    atoms.includes('mirror') ? atoms.filter((a) => a !== 'mirror') : [...atoms, 'mirror']
  )

const layerOf = (node: SExprList): string | undefined => {
  const layer = findChild(node, 'layer')
  const atom = layer?.children[1]
  return atom?.type === 'atom' ? atom.value : undefined
}

const isSided = (layer: string | undefined): boolean =>
  !!layer && (layer.startsWith('F.') || layer.startsWith('B.'))

/** A footprint field or text: `(property …)` / `(fp_text …)`. */
const flipText = (node: SExprList, ctx: FlipContext): void => {
  const at = findChild(node, 'at')
  if (at) {
    const p = xyOf(at)
    if (p) writeXY(at, ctx.local(p))
    // Top-bottom, `PCB_TEXT::Flip`: 180° less itself. KiCad writes a text's angle every time.
    let angle = 180 - (atAngle(at) ?? 0)
    let folded = false
    if (ctx.direction === 'leftRight') {
      angle = normalize(angle + 180)
      if (!findChild(node, 'unlocked') || !isYes(findChild(node, 'unlocked')!)) {
        // `PCB_TEXT::KeepUpright`, run by the 180° turn.
        if (angle >= 180) {
          editJustify(node, (atoms) => atoms.map((a) => H_SWAP[a] ?? V_SWAP[a] ?? a))
          angle = normalize(angle + 180)
          folded = true
        }
      }
    }
    setAtAngle(at, angle)
    flipRenderCache(node, ctx, () => angle, folded)
  }
  const sided = isSided(layerOf(node))
  flipLayerAtoms(node, 'layer', ctx.flipLayer)
  if (sided) toggleMirror(node)
}

/**
 * A TrueType text's cached outlines (`render_cache`), board-absolute: the
 * flipped text is their mirror image about the flip center, so they mirror
 * with it and take the new angle. A text kept upright past a half turn draws
 * otherwise, so its cache is dropped; KiCad rebuilds it from the font.
 */
const flipRenderCache = (
  node: SExprList,
  ctx: FlipContext,
  angle: (cached: number) => number,
  stale: boolean
): void => {
  const cache = findChild(node, 'render_cache')
  if (!cache) return
  if (stale) {
    node.children = node.children.filter((c) => c !== cache)
    return
  }
  const angleAtom = cache.children[2]
  if (angleAtom?.type === 'atom') angleAtom.value = formatAngle(angle(Number(angleAtom.value)))
  for (const polygon of findChildren(cache, 'polygon')) {
    const pts = findChild(polygon, 'pts')
    if (pts) mapPts(pts, ctx.absolute)
  }
}

const isYes = (node: SExprList): boolean => {
  const atom = node.children[1]
  return atom === undefined || (atom.type === 'atom' && atom.value !== 'no')
}

/** `(fp_text_box …)`: its shape mirrors, its angle (footprint-relative in the file) turns. */
const flipTextBox = (node: SExprList, ctx: FlipContext): void => {
  mirrorShape(node, ctx.local)
  const angleNode = findChild(node, 'angle')
  const rel = angleNode ? Number((angleNode.children[1] as { value: string }).value) : 0
  const next = normalize720(180 - rel)
  if (next === 0) {
    if (angleNode) node.children = node.children.filter((c) => c !== angleNode)
  } else if (angleNode) {
    ;(angleNode.children[1] as { value: string }).value = formatAngle(next)
  } else {
    const layerIdx = node.children.findIndex((c) => c.type === 'list' && getToken(c) === 'layer')
    const list = makeList(
      [makeAtom('angle', false, node.start), makeAtom(formatAngle(next), false, node.start)],
      node.start
    )
    node.children.splice(layerIdx === -1 ? node.children.length : layerIdx, 0, list)
  }
  // The cache holds the board angle: 180° less itself, and negated left-right.
  flipRenderCache(
    node,
    ctx,
    (a) => (ctx.direction === 'leftRight' ? normalize(-a) : 180 - a),
    false
  )
  const sided = isSided(layerOf(node))
  flipLayerAtoms(node, 'layer', ctx.flipLayer)
  if (sided) toggleMirror(node)
}

// ---------------------------------------------------------------------------
// Pads
// ---------------------------------------------------------------------------

const CHAMFER_TB: Record<string, string> = {
  top_left: 'bottom_left',
  bottom_left: 'top_left',
  top_right: 'bottom_right',
  bottom_right: 'top_right'
}
const CHAMFER_ORDER = ['top_left', 'top_right', 'bottom_left', 'bottom_right']

/** A copper layer's own-frame geometry mirrored top-bottom: offset, delta, corners, primitives. */
const mirrorPadLayer = (node: SExprList, offsetHolder: SExprList | null): void => {
  const flipY = (p: Pt): Pt => ({ x: p.x, y: nm(-p.y) })
  if (offsetHolder) mapChildXY(offsetHolder, 'offset', flipY)
  mapChildXY(node, 'rect_delta', flipY)
  const chamfer = findChild(node, 'chamfer')
  if (chamfer) {
    const corners = new Set(
      chamfer.children
        .slice(1)
        .flatMap((a) => (a.type === 'atom' ? [CHAMFER_TB[a.value] ?? a.value] : []))
    )
    const at = chamfer.start
    chamfer.children = [
      makeAtom('chamfer', false, at),
      ...CHAMFER_ORDER.filter((c) => corners.has(c)).map((c) => makeAtom(c, false, at))
    ]
  }
  const primitives = findChild(node, 'primitives')
  if (primitives) {
    for (const shape of primitives.children) {
      if (shape.type === 'list' && getToken(shape) !== 'primitives') mirrorShape(shape, flipY)
    }
  }
}

/** The copper properties a padstack holds per layer, as the pad's own children name them. */
const PER_LAYER = [
  'size',
  'rect_delta',
  'roundrect_rratio',
  'chamfer_ratio',
  'chamfer',
  'options',
  'primitives',
  'thermal_bridge_angle',
  'thermal_gap',
  'thermal_bridge_width',
  'clearance',
  'zone_connect'
]

/**
 * Trade the pad's own copper (its front) with its padstack's back entry
 * (`PADSTACK::FlipLayers`); a custom padstack's inner entries take their
 * opposite layers.
 */
const flipPadstack = (pad: SExprList, stack: SExprList, ctx: FlipContext): void => {
  const mode = findChild(stack, 'mode')?.children[1]
  const custom = mode?.type === 'atom' && mode.value === 'custom'
  const entries = findChildren(stack, 'layer')
  const back = entries.find((e) => (e.children[1] as { value?: string })?.value === 'B.Cu')
  if (custom) {
    for (const e of entries) {
      const name = e.children[1]
      if (name?.type === 'atom' && name.value !== 'B.Cu') name.value = ctx.flipLayer(name.value)
    }
    sortPadstack(stack)
  }
  if (!back) return

  // The shape: the pad header's third atom ↔ the entry's `(shape …)`.
  const header = pad.children[3]
  const shapeNode = findChild(back, 'shape')
  const shapeAtom = shapeNode?.children[1]
  if (header?.type === 'atom' && shapeAtom?.type === 'atom') {
    const front = header.value
    header.value = shapeAtom.value
    shapeAtom.value = front
  }
  // The offset: the drill's `(offset …)` ↔ the entry's, each absent at zero.
  const zero = { x: nm(0), y: nm(0) }
  const offsetOf = (holder: SExprList | null): Pt => {
    const node = holder && findChild(holder, 'offset')
    return (node && xyOf(node)) ?? zero
  }
  let drill = findChild(pad, 'drill')
  const frontOffset = offsetOf(drill)
  const backOffset = offsetOf(back)
  setOffset(back, frontOffset, false)
  if (!drill && (backOffset.x !== 0 || backOffset.y !== 0)) {
    // An SMD pad keeps its offset in a size-less `(drill (offset …))`.
    drill = makeList([makeAtom('drill', false, pad.start)], pad.start)
    const after = pad.children.findIndex(
      (c) => c.type === 'list' && (getToken(c) === 'rect_delta' || getToken(c) === 'size')
    )
    pad.children.splice(after === -1 ? pad.children.length : after + 1, 0, drill)
  }
  if (drill) setOffset(drill, backOffset, false)
  // The rest by token: swap in place where both have it, else move it across.
  for (const token of PER_LAYER) {
    const f = findChild(pad, token)
    const b = findChild(back, token)
    if (f && b) {
      const children = f.children
      f.children = b.children
      b.children = children
    } else if (f) {
      pad.children = pad.children.filter((c) => c !== f)
      back.children.push(f)
    } else if (b) {
      back.children = back.children.filter((c) => c !== b)
      const before = pad.children.findIndex(
        (c) => c.type === 'list' && (getToken(c) === 'uuid' || getToken(c) === 'padstack')
      )
      pad.children.splice(before === -1 ? pad.children.length : before, 0, b)
    }
  }
  // The front's zone connection is always set, to "inherited" when the file
  // gives none, so the back that takes it writes it (-1); the pad itself never
  // writes "inherited".
  const padZone = findChild(pad, 'zone_connect')
  if (padZone && numberChild(pad, 'zone_connect') === -1) {
    pad.children = pad.children.filter((c) => c !== padZone)
  }
  // The drill writes its offset when it is not zero or a layer's differs (`forceShapeOffsetOutput`).
  if (drill) {
    const front = offsetOf(drill)
    const differs = findChildren(stack, 'layer').some((e) => {
      const o = offsetOf(e)
      return o.x !== front.x || o.y !== front.y
    })
    setOffset(drill, front, differs)
  }
  if (!findChild(back, 'zone_connect')) {
    back.children.push(
      makeList(
        [makeAtom('zone_connect', false, back.start), makeAtom('-1', false, back.start)],
        back.start
      )
    )
  }
}

/** Write `holder`'s `(offset …)`, dropped at zero unless `force`d. */
const setOffset = (holder: SExprList, p: Pt, force: boolean): void => {
  const node = findChild(holder, 'offset')
  if (p.x === 0 && p.y === 0 && !force) {
    if (node) holder.children = holder.children.filter((c) => c !== node)
    return
  }
  if (node) {
    writeXY(node, p)
    return
  }
  const at = holder.start
  const list = makeList(
    [
      makeAtom('offset', false, at),
      makeAtom(formatNmAtom(p.x), false, at),
      makeAtom(formatNmAtom(p.y), false, at)
    ],
    at
  )
  // A layer entry writes its offset after its size; the drill ends with it.
  const size = holder.children.findIndex((c) => c.type === 'list' && getToken(c) === 'size')
  holder.children.splice(
    getToken(holder) === 'drill' || size === -1 ? holder.children.length : size + 1,
    0,
    list
  )
}

/** A custom padstack's entries in stack order, as KiCad writes them: inner layers up, then the back. */
const sortPadstack = (stack: SExprList): void => {
  const rank = (node: SExprNode): number => {
    const name = node.type === 'list' ? node.children[1] : undefined
    const value = name?.type === 'atom' ? name.value : ''
    const inner = INNER_COPPER_LAYER.exec(value)
    return inner ? Number(inner[1]) : value === 'B.Cu' ? Infinity : -1
  }
  const isEntry = (c: SExprNode): boolean => c.type === 'list' && getToken(c) === 'layer'
  const entries = stack.children.filter(isEntry).sort((a, b) => rank(a) - rank(b))
  let next = 0
  stack.children = stack.children.map((c) => (isEntry(c) ? entries[next++]! : c))
}

const flipPad = (node: SExprList, ctx: FlipContext): void => {
  const at = findChild(node, 'at')
  if (at) {
    const p = xyOf(at)
    if (p) writeXY(at, ctx.local(p))
    // `PAD::Flip` negates the angle; the 180° turn adds a half turn. Zero is not written.
    let angle = -(atAngle(at) ?? 0)
    if (ctx.direction === 'leftRight') angle += 180
    const folded = normalize(angle)
    setAtAngle(at, folded === 0 ? undefined : folded)
  }
  const stack = findChild(node, 'padstack')
  mirrorPadLayer(node, findChild(node, 'drill'))
  if (stack) {
    for (const entry of findChildren(stack, 'layer')) mirrorPadLayer(entry, entry)
    flipPadstack(node, stack, ctx)
  }
  flipLayerAtoms(node, 'layers', ctx.flipLayer)
  // `zone_layer_connections` stays: `PAD::Flip` leaves the zone-layer overrides alone.
  for (const token of ['backdrill', 'tertiary_drill']) {
    for (const drill of findChildren(node, token)) flipLayerAtoms(drill, 'layers', ctx.flipLayer)
  }
  // Front and back post-machining trade places, keeping KiCad's front-then-back order.
  const front = findChild(node, 'front_post_machining')
  const back = findChild(node, 'back_post_machining')
  if (front && back) {
    const children = front.children.slice(1)
    front.children = [front.children[0]!, ...back.children.slice(1)]
    back.children = [back.children[0]!, ...children]
  } else if (front || back) {
    const only = (front ?? back)!
    const name = only.children[0]
    if (name?.type === 'atom') {
      name.value = front ? 'back_post_machining' : 'front_post_machining'
    }
  }
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** A footprint zone: board-absolute, so it mirrors about the flip center itself. */
const flipZone = (node: SExprList, ctx: FlipContext): void => {
  for (const polygon of findChildren(node, 'polygon')) {
    const pts = findChild(polygon, 'pts')
    if (pts) mapPts(pts, ctx.absolute)
  }
  const fills = findChildren(node, 'filled_polygon')
  for (const filled of fills) {
    const pts = findChild(filled, 'pts')
    if (pts) mapPts(pts, ctx.absolute)
    flipLayerAtoms(filled, 'layer', ctx.flipLayer)
  }
  // KiCad writes the fills layer by layer, in id order.
  const sorted = fills
    .slice()
    .sort((a, b) => kicadLayerId(layerOf(a) ?? '') - kicadLayerId(layerOf(b) ?? ''))
  let next = 0
  node.children = node.children.map((c) =>
    c.type === 'list' && getToken(c) === 'filled_polygon' ? sorted[next++]! : c
  )
  flipLayerAtoms(node, 'layer', ctx.flipLayer)
  flipLayerAtoms(node, 'layers', ctx.flipLayer)
  for (const props of findChildren(node, 'property')) flipLayerAtoms(props, 'layer', ctx.flipLayer)
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** `sign()`: -1, 0 or 1. */
const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0)

/** `rescale<int64_t>`: a·b / c rounded to nearest, over 128 bits. */
const rescale = (a: bigint, b: bigint, c: bigint): bigint => {
  const n = a * b
  return n < 0n !== c < 0n ? (n - c / 2n) / c : (n + c / 2n) / c
}

/** `VECTOR2I::Resize`: the integer vector along (x, y) of length `len`. */
const resize = (x: number, y: number, len: number): { x: number; y: number } => {
  if (x === 0 && y === 0) return { x: 0, y: 0 }
  let nx: number
  let ny: number
  if (Math.abs(x) === Math.abs(y)) {
    nx = ny = Math.abs(len) * Math.SQRT1_2
  } else {
    const xs = BigInt(x) * BigInt(x)
    const ys = BigInt(y) * BigInt(y)
    const ls = BigInt(len) * BigInt(len)
    nx = Math.sqrt(Number(rescale(ls, xs, xs + ys)))
    ny = Math.sqrt(Number(rescale(ls, ys, xs + ys)))
  }
  const s = sign(len)
  return {
    x: (x < 0 ? -kiRound(nx) : kiRound(nx)) * s || 0,
    y: (y < 0 ? -kiRound(ny) : kiRound(ny)) * s || 0
  }
}

/** `VECTOR2I / 2`: rounded, halves away from zero (`KiROUND`). */
const half = (v: number): number => kiRound(v / 2)

const setNumberChild = (node: SExprList, token: string, value: string): void => {
  const atom = findChild(node, token)?.children[1]
  if (atom?.type === 'atom') atom.value = value
}

/** `EDA_TEXT::GetEffectiveTextPenWidth` for the dimension's text. */
const textPenWidth = (text: SExprList): { pen: number; height: number } => {
  const font = findChild(findChild(text, 'effects') ?? text, 'font')
  const size = font && findChild(font, 'size')
  const [h, w] = size
    ? size.children.slice(1).map((a) => (a.type === 'atom' ? mmAtomToNm(a.value) : 0))
    : [0, 0]
  const height = h ?? 0
  const width = w ?? 0
  let pen =
    font && findChild(font, 'thickness') ? mmAtomToNm(String(numberChild(font, 'thickness'))) : 0
  if (pen <= 1) {
    const boldNode = font && findChild(font, 'bold')
    pen = boldNode && isYes(boldNode) ? kiRound(width / 5) : kiRound(width / 8)
  }
  pen = Math.min(pen, kiRound(Math.min(Math.abs(width), Math.abs(height)) * 0.25))
  return { pen, height }
}

/**
 * A footprint's dimension (`PCB_DIMENSION_BASE::Flip`, then the 180° turn):
 * board-absolute like a zone, so its points mirror about the flip center. Its
 * height follows the type's rule, and its text is placed again from the new
 * geometry as KiCad's `updateText` places it, unless placed by hand.
 */
const flipDimension = (node: SExprList, ctx: FlipContext): void => {
  const type = findChild(node, 'type')?.children[1]
  const kind = type?.type === 'atom' ? type.value : 'aligned'
  const pts = findChild(node, 'pts')
  if (pts) mapPts(pts, ctx.absolute)
  const points = pts
    ? findChildren(pts, 'xy').flatMap((xy) => {
        const p = xyOf(xy)
        return p ? [p] : []
      })
    : []
  const start = points[0]
  const end = points[1] ?? start

  const heightNode = findChild(node, 'height')
  let height = heightNode ? mmAtomToNm(String(numberChild(node, 'height'))) : 0
  const orientation = numberChild(node, 'orientation') ?? 0
  if (kind === 'aligned') height = -height
  else if (kind === 'orthogonal') {
    // Top-bottom negates a horizontal one's height; the 180° turn negates any.
    const tb = orientation === 0
    if (ctx.direction === 'topBottom' ? tb : !tb) height = -height
  }
  if (heightNode) setNumberChild(node, 'height', formatNmAtom(nm(height)))

  const text = findChild(node, 'gr_text')
  if (text) {
    const style = findChild(node, 'style')
    const mode = numberChild(style, 'text_position_mode') ?? 0
    const keepNode = style && findChild(style, 'keep_text_aligned')
    const keepAligned = !!keepNode && isYes(keepNode)
    const at = findChild(text, 'at')
    const pos = at && xyOf(at)
    if (at && pos) {
      let angle = -(atAngle(at) ?? 0)
      if (ctx.direction === 'leftRight') angle = normalize(angle + 180)
      let next = ctx.absolute(pos)
      if ((kind === 'aligned' || kind === 'orthogonal') && start && end) {
        // The crossbar (`updateGeometry`), then the text on it (`PCB_DIM_ALIGNED::updateText`,
        // which the orthogonal's own ends by calling).
        const extension =
          kind === 'orthogonal'
            ? orientation === 0
              ? { x: 0, y: height }
              : { x: height, y: 0 }
            : height > 0
              ? { x: -(end.y - start.y), y: end.x - start.x }
              : { x: end.y - start.y, y: -(end.x - start.x) }
        const r = resize(extension.x, extension.y, height)
        const barStart = { x: start.x + sign(height) * r.x, y: start.y + sign(height) * r.y }
        const barEnd =
          kind === 'orthogonal'
            ? orientation === 0
              ? { x: end.x, y: barStart.y }
              : { x: barStart.x, y: end.y }
            : { x: end.x + sign(height) * r.x, y: end.y + sign(height) * r.y }
        const cc = { x: half(barEnd.x - barStart.x), y: half(barEnd.y - barStart.y) }
        if (mode === 0) {
          const { pen, height: textHeight } = textPenWidth(text)
          const rotation = cc.x === 0 ? 90 * sign(-cc.y) : cc.x < 0 ? -90 : 90
          const turned = rotateAbout(cc, { x: 0, y: 0 }, rotation)
          const offset = resize(turned.x, turned.y, pen + textHeight)
          next = { x: nm(barStart.x + cc.x + offset.x), y: nm(barStart.y + cc.y + offset.y) }
        } else if (mode === 1) {
          next = { x: nm(barStart.x + cc.x), y: nm(barStart.y + cc.y) }
        }
        if (keepAligned) {
          angle = normalize(360 - angleOf(cc.x, cc.y))
          if (angle > 90 && angle <= 270) angle -= 180
        }
      } else if (kind === 'center' && start) {
        next = start
      } else if (kind === 'radial' && keepAligned && start && end) {
        const leader = mmAtomToNm(String(numberChild(node, 'leader_length') ?? 0))
        const radial = resize(end.x - start.x, end.y - start.y, leader)
        const line = { x: next.x - (end.x + radial.x), y: next.y - (end.y + radial.y) }
        angle = normalize(360 - angleOf(line.x, line.y))
        if (angle > 90 && angle <= 270) angle -= 180
        angle = kiRound(angle)
      }
      writeXY(at, next)
      setAtAngle(at, angle)
    }
    const sided = isSided(layerOf(text))
    flipLayerAtoms(text, 'layer', ctx.flipLayer)
    if (sided) toggleMirror(text)
  }
  flipLayerAtoms(node, 'layer', ctx.flipLayer)
}

// ---------------------------------------------------------------------------
// Flip
// ---------------------------------------------------------------------------

interface FlipContext {
  direction: BoardFlipDirection
  flipLayer: (layer: string) => string
  /** An own-frame point: y negates. */
  local: (p: Pt) => Pt
  /** A board-absolute point: mirrored about the flip center. */
  absolute: (p: Pt) => Pt
}

/** The footprint node flipped (`FOOTPRINT::Flip`), as a new node; `node` is untouched. */
export function flippedFootprintNode(
  node: SExprList,
  center: Pt,
  direction: BoardFlipDirection,
  flipLayer: (layer: string) => string
): SExprList {
  const fp = cloneNodeDeep(node) as SExprList
  const ctx: FlipContext = {
    direction,
    flipLayer,
    local: (p) => ({ x: p.x, y: nm(-p.y) }),
    absolute: (p) =>
      direction === 'leftRight'
        ? { x: nm(2 * center.x - p.x), y: p.y }
        : { x: p.x, y: nm(2 * center.y - p.y) }
  }

  const at = findChild(fp, 'at')
  if (at) {
    const p = xyOf(at)
    if (p) writeXY(at, ctx.absolute(p))
    let angle = normalize180(-(atAngle(at) ?? 0))
    if (direction === 'leftRight') angle = normalize180(angle + 180)
    setAtAngle(at, angle === 0 ? undefined : angle)
  }
  flipLayerAtoms(fp, 'layer', flipLayer)

  for (const child of fp.children) {
    if (child.type !== 'list') continue
    switch (getToken(child)) {
      case 'property':
      case 'fp_text':
        flipText(child, ctx)
        break
      case 'pad':
        flipPad(child, ctx)
        break
      case 'fp_line':
      case 'fp_rect':
      case 'fp_circle':
      case 'fp_arc':
      case 'fp_poly':
      case 'fp_curve':
        mirrorShape(child, ctx.local)
        flipLayerAtoms(child, 'layer', flipLayer)
        break
      case 'fp_text_box':
        flipTextBox(child, ctx)
        break
      case 'zone':
        flipZone(child, ctx)
        break
      case 'dimension':
        flipDimension(child, ctx)
        break
      case 'point':
        // Board-absolute in the file, as zones are.
        mapChildXY(child, 'at', ctx.absolute)
        flipLayerAtoms(child, 'layer', flipLayer)
        break
    }
  }
  return fp
}

/**
 * Whether this flip can take the footprint. A table in a footprint is left
 * out: KiCad re-lays one's cells on a flip (`PCB_TABLE::Flip`), which is not
 * modeled here.
 */
export const footprintFlippable = (bfp: KicadBoardFootprint): boolean =>
  bfp.footprint.tables.length === 0

/**
 * Flip `bfp` about `center` onto the other side, replacing its node in the
 * board. Run inside one editor command; the command's remap parses the new
 * node.
 */
export function flipBoardFootprintInAST(
  board: KicadBoard,
  bfp: KicadBoardFootprint,
  center: Pt,
  direction: BoardFlipDirection = 'leftRight',
  flipLayer: (layer: string) => string = boardLayerFlipper(board.layers)
): boolean {
  const root = board._raw as SExprList
  const idx = root.children.indexOf(bfp._raw as SExprNode)
  if (idx === -1) return false
  root.children[idx] = flippedFootprintNode(bfp._raw, center, direction, flipLayer)
  return true
}

/**
 * Where a selection of footprints flips about (`EDIT_TOOL::Flip`): a lone
 * footprint's anchor, else the middle of the selection's box — taken here over
 * the anchors and pads, where KiCad takes each footprint's full outline.
 */
export function footprintFlipCenter(fps: readonly KicadBoardFootprint[]): Pt | null {
  if (fps.length === 0) return null
  if (fps.length === 1) return { x: fps[0]!.position.x, y: fps[0]!.position.y }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of fps.flatMap(footprintExtentPoints)) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { x: nm((minX + maxX) / 2), y: nm((minY + maxY) / 2) }
}

/** The points a footprint's extent is taken over: its anchor and its pads, board space. */
export function footprintExtentPoints(f: KicadBoardFootprint): Pt[] {
  const { x, y } = f.position
  const rad = ((f.position.angle ?? 0) * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // Own frame to board, y down: a positive angle turns counterclockwise on screen.
  return [
    { x, y },
    ...f.footprint.pads.map(({ position: { x: px, y: py } }) => ({
      x: nm(x + px * cos + py * sin),
      y: nm(y - px * sin + py * cos)
    }))
  ]
}

/** The board-level items `flippedBoardItemNode` takes, by file token. */
export const FLIPPABLE_BOARD_ITEMS: ReadonlySet<string> = new Set([
  'segment',
  'arc',
  'via',
  'zone',
  'gr_line',
  'gr_rect',
  'gr_circle',
  'gr_arc',
  'gr_poly',
  'gr_curve',
  'gr_text',
  'point',
  'generated'
])

/**
 * A board item — not a footprint — flipped about `center` onto the other side,
 * as a new node (`node` is untouched), or null for an item this does not take
 * (`FLIPPABLE_BOARD_ITEMS`). KiCad's `Flip` for each: tracks and shapes
 * mirror and take the opposite layer, a graphic arc swapping its ends; a via
 * mirrors, and a blind or micro one takes the opposite layer pair; a zone
 * mirrors its outline and fill and takes the opposite layers; a text mirrors
 * its position, its angle negating (left-right) or becoming 180° less itself
 * (top-bottom), and a side-specific one toggles its mirror (`PCB_TEXT::Flip`).
 */
export function flippedBoardItemNode(
  node: SExprList,
  center: Pt,
  direction: BoardFlipDirection,
  flipLayer: (layer: string) => string
): SExprList | null {
  const token = getToken(node) ?? ''
  if (!FLIPPABLE_BOARD_ITEMS.has(token)) return null
  const item = cloneNodeDeep(node) as SExprList
  const absolute = (p: Pt): Pt =>
    direction === 'leftRight'
      ? { x: nm(2 * center.x - p.x), y: p.y }
      : { x: p.x, y: nm(2 * center.y - p.y) }
  const ctx: FlipContext = { direction, flipLayer, local: absolute, absolute }
  switch (token) {
    case 'segment':
    case 'arc':
      // A track arc mirrors its three points as they are (`PCB_ARC::Flip`).
      for (const t of ['start', 'mid', 'end']) mapChildXY(item, t, absolute)
      flipLayerAtoms(item, 'layer', flipLayer)
      break
    case 'via': {
      mapChildXY(item, 'at', absolute)
      const kind = item.children.find(
        (c) =>
          c.type === 'atom' && (c.value === 'blind' || c.value === 'buried' || c.value === 'micro')
      )
      // Its pair stays written top first, in stack order (`PCB_VIA::SanitizeLayers`).
      const layers = findChild(item, 'layers')
      if (kind && layers) {
        const depth = (name: string): number =>
          name === 'F.Cu' ? 0 : name === 'B.Cu' ? Infinity : Number(/\d+/.exec(name)?.[0] ?? 0)
        const atoms = layers.children.slice(1).filter((c) => c.type === 'atom')
        const names = atoms.map((a) => flipLayer(a.value)).sort((a, b) => depth(a) - depth(b))
        atoms.forEach((a, i) => (a.value = names[i]!))
      }
      break
    }
    case 'zone':
      flipZone(item, ctx)
      break
    case 'gr_text': {
      const at = findChild(item, 'at')
      if (at) {
        const p = xyOf(at)
        if (p) writeXY(at, absolute(p))
        const was = atAngle(at) ?? 0
        const angle = normalize(direction === 'leftRight' ? -was : 180 - was)
        // KiCad writes a board text's angle every time, 0 included.
        setAtAngle(at, angle)
        flipRenderCache(item, ctx, () => angle, false)
      }
      const sided = isSided(layerOf(item))
      flipLayerAtoms(item, 'layer', flipLayer)
      if (sided) toggleMirror(item)
      break
    }
    case 'point':
      mapChildXY(item, 'at', absolute)
      flipLayerAtoms(item, 'layer', flipLayer)
      break
    case 'generated': {
      // A tuning pattern goes with its tracks; mirrored, its first bump's side is the other.
      mapTuningPatternPoints(item, absolute)
      flipLayerAtoms(item, 'layer', flipLayer)
      const side = findChild(item, 'initial_side')?.children[1]
      if (side?.type === 'atom' && (side.value === 'left' || side.value === 'right'))
        side.value = side.value === 'left' ? 'right' : 'left'
      break
    }
    default:
      mirrorShape(item, absolute)
      flipLayerAtoms(item, 'layer', flipLayer)
  }
  return item
}
