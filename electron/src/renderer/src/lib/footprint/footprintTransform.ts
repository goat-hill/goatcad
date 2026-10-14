/**
 * Rotate, mirror and flip for the footprint editor's selection, and Place
 * Footprint Anchor — KiCad's `EDIT_TOOL::Rotate` / `Mirror` / `Flip` and
 * `FOOTPRINT::MoveAnchorPosition`, ported to the footprint's own frame
 * (integer nanometers, y down).
 *
 * Every edit writes through the AST (the `update…InAST` writers, or the raw
 * node where no writer exists), so a KiCad round-trip stays lossless and the
 * editor's command layer turns one call into one undo step.
 *
 * KiCad's rules, kept:
 * - A positive angle turns counter-clockwise as drawn (R); y points down.
 * - The pivot is the lone item's own position (a rectangle or polygon turns
 *   about its center), or the grid-snapped center of the selection, text left
 *   out when anything else is selected (`updateModificationPoint`).
 * - Flip is a left-right mirror onto the other side: layers swap F ↔ B, text on
 *   a sided layer toggles its mirror, and the pivot is the footprint anchor
 *   unless one item (not a rectangle) is flipped alone.
 * - Mirror keeps every layer; a pad's angle negates, its drill offset,
 *   trapezoid delta and custom primitives mirror in its own frame; an arc
 *   swaps its ends, as `EDA_SHAPE::flip` does; a horizontal text swaps its
 *   left / right justification.
 */
import {
  updateArcInAST,
  updateCircleInAST,
  updateLineInAST,
  updateModelInAST,
  updatePadInAST,
  updatePolyInAST,
  updatePropertyInAST,
  updateRectInAST,
  updateTextInAST,
  updateZoneInAST,
  translateGraphicInAST,
  type KicadFontEffects,
  type KicadFootprint,
  type KicadPad,
  type KicadZone
} from '../kicad/footprint'
import {
  findChild,
  findChildren,
  getToken,
  markNodeDirty,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'
import { formatNmAtom, mmAtomToNm, nm, type Nm } from '../kicad/coordinates'
import { arcCenterFromPoints } from '../kicad/kicadArc'
import { footprintItems } from './footprintItems'
import { pointsBox, unionBox, type Box } from './footprintGeometry'

export interface Pt {
  x: number
  y: number
}

/** A selection entry, as the editor holds it. */
export interface ItemRef {
  type: string
  index: number
}

export type FlipDirection = 'leftRight' | 'topBottom'

export type FootprintTransform =
  | { kind: 'rotate'; angle: number }
  | { kind: 'mirror'; direction: FlipDirection }
  | { kind: 'flip' }

// ---------------------------------------------------------------------------
// Point and layer math
// ---------------------------------------------------------------------------

/** Degrees folded into [0, 360). */
export const normalizeAngle = (angle: number): number => {
  // Rounded to a micro-degree, so float dust (89.99999999) lands on the quarter turn.
  const folded = Math.round((((angle % 360) + 360) % 360) * 1e6) / 1e6
  return folded === 360 ? 0 : folded
}

/** cos / sin of a degree angle, exact on the quarter turns. */
const trig = (angle: number): { c: number; s: number } => {
  const a = normalizeAngle(angle)
  if (a === 0) return { c: 1, s: 0 }
  if (a === 90) return { c: 0, s: 1 }
  if (a === 180) return { c: -1, s: 0 }
  if (a === 270) return { c: 0, s: -1 }
  const rad = (a * Math.PI) / 180
  return { c: Math.cos(rad), s: Math.sin(rad) }
}

/** `p` turned about `c` by `angle` degrees, counter-clockwise as drawn (y down). */
export const rotatePoint = (p: Pt, c: Pt, angle: number): { x: Nm; y: Nm } => {
  const { c: cos, s: sin } = trig(angle)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: nm(c.x + dx * cos + dy * sin), y: nm(c.y - dx * sin + dy * cos) }
}

/** `p` mirrored across the vertical (left-right) or horizontal (top-bottom) line through `c`. */
export const mirrorPoint = (p: Pt, c: Pt, direction: FlipDirection): { x: Nm; y: Nm } =>
  direction === 'leftRight'
    ? { x: nm(2 * c.x - p.x), y: nm(p.y) }
    : { x: nm(p.x), y: nm(2 * c.y - p.y) }

/** The same layer on the other side: `F.SilkS` ↔ `B.SilkS`; `*.Cu`, `F&B.Cu`, inner and user layers stay. */
export const flipLayer = (layer: string): string =>
  layer.startsWith('F.')
    ? `B.${layer.slice(2)}`
    : layer.startsWith('B.')
      ? `F.${layer.slice(2)}`
      : layer

/** A layer that belongs to one side (KiCad's `IsSideSpecific`). */
const isSided = (layer: string | undefined): boolean =>
  !!layer && (layer.startsWith('F.') || layer.startsWith('B.'))

// ---------------------------------------------------------------------------
// Pivot
// ---------------------------------------------------------------------------

type Round = (value: number) => Nm
const R: Round = nm

/** An item's position as KiCad reads it (`GetPosition`). */
const itemPosition = (fp: KicadFootprint, ref: ItemRef): Pt | null => {
  const at = rawPosition(fp, ref)
  return at ? { x: at.x, y: at.y } : null
}

const rawPosition = (fp: KicadFootprint, ref: ItemRef): Pt | null => {
  switch (ref.type) {
    case 'pad':
      return fp.pads[ref.index]?.position ?? null
    case 'line':
      return fp.fpLines[ref.index]?.start ?? null
    case 'rect':
      return fp.fpRects[ref.index]?.start ?? null
    case 'circle':
      return fp.fpCircles[ref.index]?.center ?? null
    case 'arc': {
      const arc = fp.fpArcs[ref.index]
      if (!arc) return null
      const c = arcCenterFromPoints(arc.start, arc.mid, arc.end)
      return { x: R(c.x), y: R(c.y) }
    }
    case 'poly':
      return fp.fpPolys[ref.index]?.points[0] ?? null
    case 'zone':
      return fp.zones[ref.index]?.points[0] ?? null
    case 'text':
      return fp.fpTexts[ref.index]?.position ?? { x: 0, y: 0 }
    case 'property':
      return fp.properties[ref.index]?.position ?? { x: 0, y: 0 }
  }
  return null
}

/** The center a lone rectangle or polygon turns about (`PCB_SHAPE::GetCenter`). */
const shapeCenter = (fp: KicadFootprint, ref: ItemRef): Pt | null => {
  const points =
    ref.type === 'rect'
      ? ((r) => (r ? [r.start, r.end] : null))(fp.fpRects[ref.index])
      : ref.type === 'poly'
        ? (fp.fpPolys[ref.index]?.points ?? null)
        : null
  if (!points?.length) return null
  const box = pointsBox(points)
  return { x: R((box.minX + box.maxX) / 2), y: R((box.minY + box.maxY) / 2) }
}

const rawOf = (fp: KicadFootprint, ref: ItemRef): SExprNode | undefined => {
  switch (ref.type) {
    case 'pad':
      return fp.pads[ref.index]?._raw
    case 'line':
      return fp.fpLines[ref.index]?._raw
    case 'arc':
      return fp.fpArcs[ref.index]?._raw
    case 'circle':
      return fp.fpCircles[ref.index]?._raw
    case 'rect':
      return fp.fpRects[ref.index]?._raw
    case 'poly':
      return fp.fpPolys[ref.index]?._raw
    case 'zone':
      return fp.zones[ref.index]?._raw
    case 'text':
      return fp.fpTexts[ref.index]?._raw
    case 'property':
      return fp.properties[ref.index]?._raw
  }
  return undefined
}

const isText = (ref: ItemRef): boolean => ref.type === 'text' || ref.type === 'property'

/** The box around the selected items, text left out when anything else is selected. */
export const selectionBox = (fp: KicadFootprint, refs: ItemRef[]): Box | null => {
  const shapes = refs.some((ref) => !isText(ref)) ? refs.filter((ref) => !isText(ref)) : refs
  const boxes = new Map<SExprNode, Box | null>()
  for (const item of footprintItems(fp)) boxes.set(item.node, item.box)
  let box: Box | null = null
  for (const ref of shapes) {
    const raw = rawOf(fp, ref)
    const zone = ref.type === 'zone' ? fp.zones[ref.index] : undefined
    const itemBox = zone?.points.length
      ? pointsBox(zone.points)
      : raw
        ? (boxes.get(raw) ?? null)
        : null
    if (itemBox) box = unionBox(box, itemBox)
    else {
      const at = itemPosition(fp, ref)
      if (at) box = unionBox(box, { minX: at.x, minY: at.y, maxX: at.x, maxY: at.y })
    }
  }
  return box
}

/**
 * Where `transform` turns or mirrors the selection about. `snap` puts the
 * center of a multi-selection on the grid, as KiCad's `BestSnapAnchor` does.
 */
export function transformPivot(
  fp: KicadFootprint,
  refs: ItemRef[],
  transform: FootprintTransform,
  snap: (p: Pt) => Pt = (p) => p
): Pt {
  const lone = refs.length === 1 ? refs[0] : undefined
  if (transform.kind === 'flip') {
    // About the footprint anchor, unless one item (not a rectangle) flips alone.
    if (lone && lone.type !== 'rect') return itemPosition(fp, lone) ?? { x: 0, y: 0 }
    return { x: 0, y: 0 }
  }
  if (lone) {
    if (transform.kind === 'rotate') {
      const center = shapeCenter(fp, lone)
      if (center) return center
    }
    return itemPosition(fp, lone) ?? { x: 0, y: 0 }
  }
  const box = selectionBox(fp, refs)
  if (!box) return { x: 0, y: 0 }
  const snapped = snap({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 })
  return { x: R(snapped.x), y: R(snapped.y) }
}

// ---------------------------------------------------------------------------
// Raw-node helpers
// ---------------------------------------------------------------------------

const xyOf = (node: SExprList): { x: Nm; y: Nm } | null => {
  const [, x, y] = node.children
  if (x?.type !== 'atom' || y?.type !== 'atom') return null
  return { x: mmAtomToNm(x.value), y: mmAtomToNm(y.value) }
}

const writeXY = (node: SExprList, p: { x: Nm; y: Nm }): void => {
  const [, x, y] = node.children
  if (x?.type === 'atom') x.value = formatNmAtom(p.x)
  if (y?.type === 'atom') y.value = formatNmAtom(p.y)
}

/** Map every `(token x y)` child of `node` named in `tokens`, and every `(xy …)` of its `pts`. */
const mapCoords = (
  node: SExprList,
  tokens: string[],
  map: (p: { x: Nm; y: Nm }) => { x: Nm; y: Nm }
): void => {
  markNodeDirty(node)
  for (const token of tokens) {
    const child = findChild(node, token)
    const p = child && xyOf(child)
    if (child && p) writeXY(child, map(p))
  }
  const pts = findChild(node, 'pts')
  if (pts)
    for (const xy of findChildren(pts, 'xy')) {
      const p = xyOf(xy)
      if (p) writeXY(xy, map(p))
    }
}

/** Swap two `(token x y)` children's values — an arc's ends after a mirror. */
const swapCoords = (node: SExprList, a: string, b: string): void => {
  const na = findChild(node, a)
  const nb = findChild(node, b)
  const pa = na && xyOf(na)
  const pb = nb && xyOf(nb)
  if (na && nb && pa && pb) {
    writeXY(na, pb)
    writeXY(nb, pa)
  }
}

/** Rename the layer atoms of a `(layer …)` / `(layers …)` child. */
const flipLayerAtoms = (node: SExprList, token: 'layer' | 'layers'): void => {
  const child = findChild(node, token)
  if (!child) return
  markNodeDirty(child)
  for (const atom of child.children.slice(1)) {
    if (atom.type === 'atom') atom.value = flipLayer(atom.value)
  }
}

const CHAMFER_SWAP: Record<FlipDirection, Record<string, string>> = {
  leftRight: {
    top_left: 'top_right',
    top_right: 'top_left',
    bottom_left: 'bottom_right',
    bottom_right: 'bottom_left'
  },
  topBottom: {
    top_left: 'bottom_left',
    bottom_left: 'top_left',
    top_right: 'bottom_right',
    bottom_right: 'top_right'
  }
}

/**
 * A pad's own-frame geometry mirrored (`mirrorPad`, `PAD::FlipPrimitives`):
 * drill offset, trapezoid delta, chamfered corners and custom primitives.
 */
const mirrorPadFrame = (padNode: SExprList, direction: FlipDirection): void => {
  const origin = { x: 0, y: 0 }
  const mirror = (p: { x: Nm; y: Nm }): { x: Nm; y: Nm } => mirrorPoint(p, origin, direction)
  markNodeDirty(padNode)
  const drill = findChild(padNode, 'drill')
  if (drill) mapCoords(drill, ['offset'], mirror)
  mapCoords(padNode, ['rect_delta'], mirror)
  const chamfer = findChild(padNode, 'chamfer')
  if (chamfer) {
    for (const atom of chamfer.children.slice(1)) {
      if (atom.type === 'atom') atom.value = CHAMFER_SWAP[direction][atom.value] ?? atom.value
    }
  }
  const primitives = findChild(padNode, 'primitives')
  if (!primitives) return
  for (const shape of primitives.children) {
    if (shape.type !== 'list') continue
    mapCoords(shape, ['start', 'mid', 'end', 'center'], mirror)
    if (getToken(shape) === 'gr_arc') swapCoords(shape, 'start', 'end')
  }
}

/** A pad with a KiCad 9 padstack: its per-layer copper swaps sides on a flip, which this does not model. */
export const hasPadstack = (pad: KicadPad): boolean =>
  !!findChild(pad._raw as SExprList, 'padstack')

/** The pad's text-like angle after a mirror: KiCad negates it. */
const mirroredAngle = (angle: number | undefined): number | undefined => {
  const next = normalizeAngle(-(angle ?? 0))
  return next === 0 ? undefined : next
}

const rotatedPadAngle = (angle: number | undefined, by: number): number | undefined => {
  const next = normalizeAngle((angle ?? 0) + by)
  return next === 0 ? undefined : next
}

/** A text's stored angle after a turn; a 0 stays written when the file wrote one. */
const rotatedTextAngle = (angle: number | undefined, next: number): number | undefined =>
  next === 0 && angle === undefined ? undefined : next

const swapJustify = (effects: KicadFontEffects): KicadFontEffects => ({
  ...effects,
  hAlign: effects.hAlign === 'left' ? 'right' : effects.hAlign === 'right' ? 'left' : undefined
})

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/**
 * Turn, mirror or flip the selected items about `pivot`, writing each through
 * the AST. Run it inside one editor command so it is one undo step.
 */
export function transformFootprintItems(
  fp: KicadFootprint,
  refs: ItemRef[],
  transform: FootprintTransform,
  pivot: Pt
): void {
  const direction: FlipDirection = transform.kind === 'mirror' ? transform.direction : 'leftRight'
  const move = (p: Pt): { x: Nm; y: Nm } =>
    transform.kind === 'rotate'
      ? rotatePoint(p, pivot, transform.angle)
      : mirrorPoint(p, pivot, direction)
  const flip = transform.kind === 'flip'
  const sideLayer = (layer: string | undefined): string | undefined =>
    flip && layer !== undefined ? flipLayer(layer) : undefined

  for (const ref of refs) {
    switch (ref.type) {
      case 'pad': {
        const pad = fp.pads[ref.index]
        if (!pad) break
        const at = move(pad.position)
        const angle =
          transform.kind === 'rotate'
            ? rotatedPadAngle(pad.position.angle, transform.angle)
            : mirroredAngle(pad.position.angle)
        if (transform.kind !== 'rotate') {
          mirrorPadFrame(pad._raw as SExprList, direction)
        }
        if (flip) flipLayerAtoms(pad._raw as SExprList, 'layers')
        updatePadInAST(pad, { position: { x: at.x, y: at.y, angle } })
        break
      }
      case 'line': {
        const line = fp.fpLines[ref.index]
        if (!line) break
        updateLineInAST(line, {
          start: move(line.start),
          end: move(line.end),
          ...(flip ? { layer: sideLayer(line.layer) } : {})
        })
        break
      }
      case 'arc': {
        const arc = fp.fpArcs[ref.index]
        if (!arc) break
        const start = move(arc.start)
        const end = move(arc.end)
        const mirrored = transform.kind !== 'rotate'
        updateArcInAST(arc, {
          start: mirrored ? end : start,
          mid: move(arc.mid),
          end: mirrored ? start : end,
          ...(flip ? { layer: sideLayer(arc.layer) } : {})
        })
        break
      }
      case 'circle': {
        const circle = fp.fpCircles[ref.index]
        if (!circle) break
        updateCircleInAST(circle, {
          center: move(circle.center),
          end: move(circle.end),
          ...(flip ? { layer: sideLayer(circle.layer) } : {})
        })
        break
      }
      case 'rect': {
        const rect = fp.fpRects[ref.index]
        if (!rect) break
        const a = move(rect.start)
        const b = move(rect.end)
        updateRectInAST(rect, {
          start: { x: nm(Math.min(a.x, b.x)), y: nm(Math.min(a.y, b.y)) },
          end: { x: nm(Math.max(a.x, b.x)), y: nm(Math.max(a.y, b.y)) },
          ...(flip ? { layer: sideLayer(rect.layer) } : {})
        })
        break
      }
      case 'poly': {
        const poly = fp.fpPolys[ref.index]
        if (!poly) break
        updatePolyInAST(poly, {
          points: poly.points.map(move),
          ...(flip ? { layer: sideLayer(poly.layer) } : {})
        })
        break
      }
      case 'zone': {
        const zone = fp.zones[ref.index]
        if (zone) transformZone(zone, move, flip)
        break
      }
      case 'text': {
        const text = fp.fpTexts[ref.index]
        if (!text) break
        const patch = textPatch(text, transform, move)
        updateTextInAST(text, patch)
        break
      }
      case 'property': {
        const prop = fp.properties[ref.index]
        if (!prop) break
        updatePropertyInAST(prop, textPatch(prop, transform, move))
        break
      }
    }
  }
}

/** A zone's outline and fills moved, and on a flip its layers renamed. */
const transformZone = (zone: KicadZone, move: (p: Pt) => { x: Nm; y: Nm }, flip: boolean): void => {
  const raw = zone._raw as SExprList
  markNodeDirty(raw)
  updateZoneInAST(zone, { points: zone.points.map(move) })
  for (const filled of findChildren(raw, 'filled_polygon')) {
    const pts = findChild(filled, 'pts')
    if (!pts) continue
    for (const xy of findChildren(pts, 'xy')) {
      const p = xyOf(xy)
      if (p) writeXY(xy, move(p))
    }
    if (flip) flipLayerAtoms(filled, 'layer')
  }
  if (flip) {
    flipLayerAtoms(raw, 'layer')
    flipLayerAtoms(raw, 'layers')
  }
}

interface TextLike {
  position?: { x: Nm; y: Nm; angle?: number }
  layer?: string
  fontEffects?: KicadFontEffects
}

/** What a text or field becomes: KiCad's `PCB_TEXT::Rotate` / `Mirror` / `Flip`. */
const textPatch = (
  text: TextLike,
  transform: FootprintTransform,
  move: (p: Pt) => { x: Nm; y: Nm }
): {
  position: { x: Nm; y: Nm; angle?: number }
  layer?: string
  fontEffects?: KicadFontEffects
} => {
  const at = text.position ?? { x: nm(0), y: nm(0) }
  const p = move(at)
  const angle = at.angle
  if (transform.kind === 'rotate') {
    const next = normalizeAngle((angle ?? 0) + transform.angle)
    return { position: { ...p, angle: rotatedTextAngle(angle, next) } }
  }
  if (transform.kind === 'mirror') {
    // Position and justification mirror; the glyphs do not.
    const horizontal = normalizeAngle(angle ?? 0) === (transform.direction === 'leftRight' ? 0 : 90)
    return {
      position: { ...p, angle },
      ...(horizontal && text.fontEffects ? { fontEffects: swapJustify(text.fontEffects) } : {})
    }
  }
  const next = normalizeAngle(-(angle ?? 0))
  const layer = text.layer !== undefined ? flipLayer(text.layer) : undefined
  return {
    position: { ...p, angle: rotatedTextAngle(angle, next) },
    ...(layer !== undefined ? { layer } : {}),
    ...(isSided(text.layer) && text.fontEffects
      ? { fontEffects: { ...text.fontEffects, mirror: !text.fontEffects.mirror } }
      : {})
  }
}

// ---------------------------------------------------------------------------
// Place Footprint Anchor
// ---------------------------------------------------------------------------

/** Shift every item's `(token x y)` children and `pts` of a dimension by `d`. */
const shiftDimension = (node: SExprList, d: Pt): void => {
  const shift = (p: { x: Nm; y: Nm }): { x: Nm; y: Nm } => ({ x: nm(p.x + d.x), y: nm(p.y + d.y) })
  mapCoords(node, [], shift)
  const text = findChild(node, 'gr_text')
  if (text) mapCoords(text, ['at'], shift)
}

/**
 * Make `anchor` the footprint's origin: every item shifts by the opposite
 * offset, so nothing moves on screen but the anchor, and a linked 3D model's
 * offset follows (`FOOTPRINT::MoveAnchorPosition`). Custom-pad primitives sit
 * in the pad's own frame and stay.
 */
export function moveFootprintAnchor(fp: KicadFootprint, anchor: Pt): void {
  const d = { x: -anchor.x, y: -anchor.y }
  if (d.x === 0 && d.y === 0) return
  const shift = (p: Pt): { x: Nm; y: Nm } => ({ x: nm(p.x + d.x), y: nm(p.y + d.y) })
  for (const pad of fp.pads) {
    const at = shift(pad.position)
    updatePadInAST(pad, { position: { ...pad.position, ...at } })
  }
  for (const line of fp.fpLines)
    updateLineInAST(line, { start: shift(line.start), end: shift(line.end) })
  for (const arc of fp.fpArcs) {
    updateArcInAST(arc, { start: shift(arc.start), mid: shift(arc.mid), end: shift(arc.end) })
  }
  for (const circle of fp.fpCircles) {
    updateCircleInAST(circle, { center: shift(circle.center), end: shift(circle.end) })
  }
  for (const rect of fp.fpRects)
    updateRectInAST(rect, { start: shift(rect.start), end: shift(rect.end) })
  for (const poly of fp.fpPolys) updatePolyInAST(poly, { points: poly.points.map(shift) })
  for (const zone of fp.zones) transformZone(zone, shift, false)
  for (const text of fp.fpTexts) {
    if (text.position)
      updateTextInAST(text, { position: { ...text.position, ...shift(text.position) } })
  }
  for (const prop of fp.properties) {
    if (prop.position) {
      updatePropertyInAST(prop, { position: { ...prop.position, ...shift(prop.position) } })
    }
  }
  for (const dim of fp.dimensions) shiftDimension(dim._raw as SExprList, d)
  for (const item of [...fp.fpCurves, ...fp.fpTextBoxes, ...fp.tables, ...fp.points]) {
    translateGraphicInAST(item, nm(d.x), nm(d.y))
  }
  if (fp.model) {
    // The model's offset is mm with y up: KiCad adds the move to x and takes it from y.
    const offset = fp.model.offset ?? { x: nm(0), y: nm(0), z: nm(0) }
    updateModelInAST(fp.model, {
      offset: { x: nm(offset.x + d.x), y: nm(offset.y - d.y), z: offset.z }
    })
  }
}
