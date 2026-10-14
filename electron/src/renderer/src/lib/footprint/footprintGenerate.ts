/**
 * A footprint from what the datasheet prints: the agent's pads and body in,
 * a complete `.kicad_mod` out, drawn to the house style.
 *
 * The boundary: the input is
 * semantics and dimensions only — pads, body, pin 1, metadata. Everything
 * else is derived here from `footprintStyle.ts`: fab outline and bevel, silk
 * outline cut clear of the pads, the pin 1 marker, courtyard, texts, pad
 * corner radii and pad layers. The generator writes the pads it was given and
 * nothing else.
 *
 * Pure: the file is built as an AST from `footprintTemplate` and serialized by
 * the same writer every editor saves with.
 */
import {
  addFpCircleToFootprintAST,
  addFpLineToFootprintAST,
  addFpPolyToFootprintAST,
  addFpPropertyToFootprintAST,
  addFpRectToFootprintAST,
  addFpTextToFootprintAST,
  addPadToFootprintAST,
  makeAtom,
  makeList,
  parseKicadFootprint,
  serializeKicadFootprint,
  setAttrChild,
  type FootprintPadData,
  type KicadFootprint,
  type SExprList
} from '../kicad/footprint'
import { mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import { footprintTemplate } from '../project/templates'
import {
  COURTYARD_GRID,
  COURTYARD_OFFSET,
  COURTYARD_WIDTH,
  DEFAULT_PAD_LAYERS,
  FAB_BEVEL_FRACTION,
  FAB_BEVEL_MAX,
  FAB_REFERENCE_CHARACTERS,
  FAB_REFERENCE_MAX,
  FAB_REFERENCE_MIN,
  FAB_WIDTH,
  FOOTPRINT_STYLE_VERSION,
  GENERATOR_PROPERTY,
  PIN1_CHEVRON_LENGTH,
  PIN1_DOT_DIAMETER,
  PIN1_DOT_GAP,
  PIN1_LINE_OVERRUN,
  SILK_MIN_SEGMENT,
  SILK_OFFSET,
  SILK_PAD_CLEARANCE,
  SILK_WIDTH,
  TEXT_GAP,
  TEXT_SIZE,
  TEXT_THICKNESS,
  TEXT_THICKNESS_RATIO,
  roundrectRatio,
  type CourtyardClass,
  type FootprintStyleChoices,
  type Pin1MarkerKind
} from './footprintStyle'
import {
  cutSegment,
  distance,
  offsetPolygon,
  padShape,
  pointGap,
  pointsBox,
  shapeBox,
  shapeGap,
  unionBox,
  type Box,
  type Point,
  type Shape
} from './footprintGeometry'

// --- Input, in millimeters, as the op takes it ------------------------------

export type PadType = 'smd' | 'thru_hole' | 'np_thru_hole'
export type PadShapeName = 'rect' | 'roundrect' | 'circle' | 'oval'

export interface PadSpec {
  number: string
  type: PadType
  shape: PadShapeName
  at: { x: number; y: number; angle?: number }
  size: { width: number; height: number }
  drill?: {
    diameter: number
    oval?: { width: number; height: number }
    offset?: { x: number; y: number }
  }
  layers?: string[]
  /** A row of identical pads: `count` from `at`, stepping by (dx, dy). */
  array?: { count: number; dx: number; dy: number; numberStep?: number }
}

export type BodySpec =
  | { rect: { x: number; y: number; width: number; height: number }; polygon?: undefined }
  | { polygon: Array<{ x: number; y: number }>; rect?: undefined }

export interface FootprintSpec {
  name: string
  attributes: 'smd' | 'tht'
  description?: string
  tags?: string
  datasheet?: string
  courtyard?: CourtyardClass
  pads: PadSpec[]
  body: BodySpec
  pin1?: string
}

export type FootprintRefusal =
  | 'blank-name'
  | 'bad-name'
  | 'no-pads'
  | 'bad-pad'
  | 'bad-array'
  | 'pads-overlap'
  | 'bad-pin1'
  | 'bad-body'

export const FOOTPRINT_REFUSAL_REMEDY: Record<FootprintRefusal, string> = {
  'blank-name': 'Name the footprint the way the library names its neighbors.',
  'bad-name':
    'A footprint name is a file name: no slash, backslash, colon or other character a file system refuses.',
  'no-pads': 'Pass every pad the land pattern shows; a footprint with none is not a footprint.',
  'bad-pad':
    'Every pad needs a positive size, and a through-hole pad a positive drill. Read the size off the land pattern drawing.',
  'bad-array':
    'An array needs count of 2 or more and a first number that ends in digits, which the array counts up (7, or A1 for a row of balls); for named pads (MP, SH) pass each pad on its own.',
  'pads-overlap':
    'Two pads with different numbers would share copper, which is a short by construction. Check the positions against the drawing: a pitch or an origin is usually off.',
  'bad-pin1':
    'pin1 must name a pad in the table, and is required when there is more than one pad: it is the pad the drawing marks.',
  'bad-body':
    'body is the package outline from the top view: a rect with positive width and height, or a polygon of three or more points.'
}

export type GenerateResult =
  | { ok: true; text: string; report: GenerateReport }
  | { ok: false; error: FootprintRefusal; detail: string }

/** One pad as expanded, in the answer's shape. */
export interface PadRow {
  number: string
  type: PadType
  shape: PadShapeName
  at: { x: number; y: number; angle?: number }
  size: { width: number; height: number }
  layers: string[]
  drill?: { diameter: number; oval?: { width: number; height: number } }
}

export interface MmBox {
  x: number
  y: number
  width: number
  height: number
}

export interface GenerateReport {
  pads: PadRow[]
  sharedNumbers: string[]
  box: { courtyard: MmBox; fab: MmBox; pads: MmBox }
  derived: {
    silk: { segments: number; cutNearPads: number }
    pin1Marker: { kind: Pin1MarkerKind; at: { x: number; y: number } | null; note?: string } | null
    courtyard: { offset: number; box: MmBox }
    bevel: { corner: { x: number; y: number }; size: number } | null
    texts: Array<{ text: string; layer: string; at: { x: number; y: number }; size: number }>
  }
}

// --- Expansion and validation ------------------------------------------------

/** Characters a file name on any of the three platforms refuses, plus the
 *  lib id separator. Control characters are tested apart. */
const BAD_NAME = /[/\\:*?"<>|]/
const hasControl = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) < 0x20)

interface ExpandedPad extends FootprintPadData {
  type: PadType
  shape: PadShapeName
}

const toNm = (value: number): Nm => mmToNm(value)

/** Pads as the file will hold them, arrays unrolled. */
export const expandPads = (
  pads: PadSpec[]
): { ok: true; pads: ExpandedPad[] } | { ok: false; error: FootprintRefusal; detail: string } => {
  const out: ExpandedPad[] = []
  for (const [index, pad] of pads.entries()) {
    const where = `pads[${index}] (number ${JSON.stringify(pad.number)})`
    if (!(pad.size.width > 0 && pad.size.height > 0)) {
      return { ok: false, error: 'bad-pad', detail: `${where} has a zero or negative size.` }
    }
    if (pad.type !== 'smd' && !(pad.drill && pad.drill.diameter > 0)) {
      return { ok: false, error: 'bad-pad', detail: `${where} is ${pad.type} and has no drill.` }
    }
    const count = pad.array ? pad.array.count : 1
    const step = pad.array?.numberStep ?? 1
    // A grid array's row is a letter prefix and a column: `A1`, `AB12`.
    const [, prefix = '', digits = ''] = /^([A-Za-z]*)(\d+)$/.exec(pad.number.trim()) ?? []
    const first = Number(digits)
    if (pad.array) {
      if (!Number.isInteger(count) || count < 2) {
        return { ok: false, error: 'bad-array', detail: `${where}: count must be 2 or more.` }
      }
      if (!digits || !Number.isInteger(step)) {
        return {
          ok: false,
          error: 'bad-array',
          detail: `${where}: an array needs a first number that ends in digits (7, A1) and an integer numberStep.`
        }
      }
    }
    for (let i = 0; i < count; i++) {
      const number = pad.array ? `${prefix}${first + i * step}` : pad.number.trim()
      const x = pad.at.x + (pad.array ? pad.array.dx * i : 0)
      const y = pad.at.y + (pad.array ? pad.array.dy * i : 0)
      const size = { w: toNm(pad.size.width), h: toNm(pad.size.height) }
      out.push({
        number,
        type: pad.type,
        shape: pad.shape,
        at: {
          x: toNm(x),
          y: toNm(y),
          ...(pad.at.angle ? { angle: pad.at.angle } : {})
        },
        size,
        ...(pad.drill
          ? {
              drill: {
                diameter: toNm(pad.drill.diameter),
                ...(pad.drill.oval
                  ? { oval: { w: toNm(pad.drill.oval.width), h: toNm(pad.drill.oval.height) } }
                  : {}),
                ...(pad.drill.offset
                  ? { offset: { x: toNm(pad.drill.offset.x), y: toNm(pad.drill.offset.y) } }
                  : {})
              }
            }
          : {}),
        layers: pad.layers?.length ? pad.layers : DEFAULT_PAD_LAYERS[pad.type],
        ...(pad.shape === 'roundrect' ? { roundrectRatio: roundrectRatio(size.w, size.h) } : {})
      })
    }
  }
  return { ok: true, pads: out }
}

export const shapeOfPad = (pad: FootprintPadData): Shape =>
  padShape({
    shape: pad.shape,
    position: pad.at,
    size: pad.size,
    roundrectRatio: pad.roundrectRatio
  })

/** Pairs of differently-numbered pads whose copper touches, as the entries passed in. */
export const overlappingPads = <T extends { number: string; shape: Shape }>(
  pads: T[]
): Array<[T, T]> => {
  const out: Array<[T, T]> = []
  const boxes = pads.map((pad) => shapeBox(pad.shape))
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      if (pads[i].number === pads[j].number) continue
      const a = boxes[i]
      const b = boxes[j]
      if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) continue
      if (shapeGap(pads[i].shape, pads[j].shape) <= 0) out.push([pads[i], pads[j]])
    }
  }
  return out
}

/** Numbers two or more pads carry, sorted as a pin table reads. */
export const sharedPadNumbers = (numbers: string[]): string[] => {
  const seen = new Map<string, number>()
  for (const number of numbers) seen.set(number, (seen.get(number) ?? 0) + 1)
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([number]) => number)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

// --- Derivation ---------------------------------------------------------------

const bodyPoints = (body: BodySpec): Point[] | null => {
  if (body.rect) {
    const { x, y, width: w, height: h } = body.rect
    if (!(w > 0 && h > 0)) return null
    const [x0, y0, x1, y1] = [toNm(x), toNm(y), toNm(x + w), toNm(y + h)]
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 }
    ]
  }
  if (!body.polygon || body.polygon.length < 3) return null
  const points = body.polygon.map((p) => ({ x: toNm(p.x), y: toNm(p.y) }))
  const box = pointsBox(points)
  return box.maxX > box.minX && box.maxY > box.minY ? points : null
}

const nearestIndex = (points: Point[], target: Point): number => {
  let best = 0
  for (let i = 1; i < points.length; i++) {
    if (distance(points[i], target) < distance(points[best], target)) best = i
  }
  return best
}

/** The polygon with vertex `index` cut off by `size` along both edges. */
const bevelVertex = (points: Point[], index: number, size: number): Point[] => {
  const n = points.length
  const v = points[index]
  const toward = (other: Point): Point => {
    const length = distance(v, other)
    const along = Math.min(size, length / 2)
    return {
      x: Math.round(v.x + ((other.x - v.x) / length) * along),
      y: Math.round(v.y + ((other.y - v.y) / length) * along)
    }
  }
  const before = toward(points[(index - 1 + n) % n])
  const after = toward(points[(index + 1) % n])
  return [...points.slice(0, index), before, after, ...points.slice(index + 1)]
}

/** Round a box outward to the courtyard grid. */
const snapOutward = (box: Box, grid: number): Box => ({
  minX: Math.floor(box.minX / grid) * grid,
  minY: Math.floor(box.minY / grid) * grid,
  maxX: Math.ceil(box.maxX / grid) * grid,
  maxY: Math.ceil(box.maxY / grid) * grid
})

const mm = (value: number): number => nmToMm(Math.round(value) as Nm)
const mmPoint = (p: Point): { x: number; y: number } => ({ x: mm(p.x), y: mm(p.y) })
export const mmBox = (box: Box): MmBox => ({
  x: mm(box.minX),
  y: mm(box.minY),
  width: mm(box.maxX - box.minX),
  height: mm(box.maxY - box.minY)
})

const unit = (from: Point, to: Point): Point => {
  const length = distance(from, to) || 1
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
}

const nmPoint = (p: Point): { x: Nm; y: Nm } => ({
  x: Math.round(p.x) as Nm,
  y: Math.round(p.y) as Nm
})

interface Marker {
  kind: Pin1MarkerKind
  lines: Array<[Point, Point]>
  dot: Point | null
  at: Point | null
  note?: string
}

/**
 * The pin 1 marker on silk, per the project's choice. Every stroke is cut
 * clear of the pads like the outline is.
 */
const pin1Marker = (
  kind: Pin1MarkerKind,
  silk: Point[],
  pad1: ExpandedPad,
  pad1Shape: Shape,
  bodyCenter: Point,
  keepouts: Shape[],
  clearance: number
): Marker => {
  const cut = (a: Point, b: Point): Array<[Point, Point]> =>
    cutSegment(a, b, keepouts, clearance, SILK_MIN_SEGMENT)
  const chevron = (): Marker => {
    const index = nearestIndex(silk, pad1.at)
    const n = silk.length
    const corner = silk[index]
    const toPrev = unit(corner, silk[(index - 1 + n) % n])
    const toNext = unit(corner, silk[(index + 1) % n])
    // Just outside the outline: one stroke plus its clearance beyond the corner.
    const out = { x: -(toPrev.x + toNext.x), y: -(toPrev.y + toNext.y) }
    const outLength = Math.hypot(out.x, out.y) || 1
    const gap = SILK_WIDTH * 2
    const vertex = {
      x: corner.x + (out.x / outLength) * gap * Math.SQRT2,
      y: corner.y + (out.y / outLength) * gap * Math.SQRT2
    }
    const arm = (direction: Point): Point => ({
      x: vertex.x + direction.x * PIN1_CHEVRON_LENGTH,
      y: vertex.y + direction.y * PIN1_CHEVRON_LENGTH
    })
    const lines = [...cut(vertex, arm(toPrev)), ...cut(vertex, arm(toNext))]
    return {
      kind: 'chevron',
      lines,
      dot: null,
      at: lines.length ? vertex : null,
      ...(lines.length
        ? {}
        : { note: 'Every stroke of the chevron fell within the pad clearance; none was drawn.' })
    }
  }

  if (kind === 'dot') {
    const box = shapeBox(pad1Shape)
    const dx = pad1.at.x - bodyCenter.x
    const dy = pad1.at.y - bodyCenter.y
    const reach = PIN1_DOT_GAP + PIN1_DOT_DIAMETER / 2
    const at =
      Math.abs(dx) >= Math.abs(dy)
        ? { x: dx < 0 ? box.minX - reach : box.maxX + reach, y: pad1.at.y }
        : { x: pad1.at.x, y: dy < 0 ? box.minY - reach : box.maxY + reach }
    const clear = keepouts.every(
      (shape) => pointGap(at, shape) >= clearance - SILK_WIDTH / 2 + PIN1_DOT_DIAMETER / 2
    )
    return clear
      ? { kind: 'dot', lines: [], dot: at, at }
      : {
          ...chevron(),
          note: 'The dot would have touched another pad; a chevron was drawn instead.'
        }
  }

  if (kind === 'line') {
    // The silk edge pad 1 sits beside: one whose line, run on, passes pad 1
    // rather than one pad 1 lies alongside. The nearest such edge is run past
    // pad 1's far side.
    const box = shapeBox(pad1Shape)
    const corners = [
      { x: box.minX, y: box.minY },
      { x: box.maxX, y: box.minY },
      { x: box.minX, y: box.maxY },
      { x: box.maxX, y: box.maxY }
    ]
    let best: { from: Point; to: Point; offset: number } | null = null
    for (let i = 0; i < silk.length; i++) {
      const a = silk[i]
      const b = silk[(i + 1) % silk.length]
      const along = unit(a, b)
      const length = distance(a, b)
      const projection = (p: Point): number => (p.x - a.x) * along.x + (p.y - a.y) * along.y
      const t = projection(pad1.at)
      if (t >= 0 && t <= length) continue
      const offset = Math.abs((pad1.at.x - a.x) * along.y - (pad1.at.y - a.y) * along.x)
      if (best && best.offset <= offset) continue
      const reach =
        t < 0
          ? Math.min(...corners.map(projection)) - PIN1_LINE_OVERRUN
          : Math.max(...corners.map(projection)) + PIN1_LINE_OVERRUN
      best = {
        from: t < 0 ? a : b,
        to: { x: a.x + along.x * reach, y: a.y + along.y * reach },
        offset
      }
    }
    if (best) {
      const { from, to } = best
      const pieces = cut(from, to)
      const whole =
        pieces.length === 1 && distance(pieces[0][0], from) < 1 && distance(pieces[0][1], to) < 1
      if (whole) return { kind: 'line', lines: pieces, dot: null, at: to }
    }
    return {
      ...chevron(),
      note: best
        ? 'The extended outline would have run within the pad clearance; a chevron was drawn instead.'
        : 'Pad 1 lies within the outline, so no edge runs past it; a chevron was drawn instead.'
    }
  }

  return chevron()
}

/** The fab `${REFERENCE}` size that fits three characters in the body, or null. */
const fabReferenceSize = (box: Box): number | null => {
  const fit = Math.min((box.maxX - box.minX) / FAB_REFERENCE_CHARACTERS, box.maxY - box.minY)
  const size = Math.min(FAB_REFERENCE_MAX, Math.floor(fit / 10000) * 10000)
  return size >= FAB_REFERENCE_MIN ? size : null
}

/** Generate the footprint text and a report of what was derived. */
export const generateFootprint = (
  spec: FootprintSpec,
  style: FootprintStyleChoices,
  opName = 'footprint.create'
): GenerateResult => {
  const name = spec.name.trim()
  if (!name) return { ok: false, error: 'blank-name', detail: 'name is empty.' }
  if (BAD_NAME.test(name) || hasControl(name) || name === '.' || name === '..') {
    return { ok: false, error: 'bad-name', detail: name }
  }
  if (!spec.pads.length) return { ok: false, error: 'no-pads', detail: 'pads is empty.' }

  const expanded = expandPads(spec.pads)
  if (!expanded.ok) return expanded
  const pads = expanded.pads
  const shapes = pads.map(shapeOfPad)

  const overlaps = overlappingPads(pads.map((pad, i) => ({ number: pad.number, shape: shapes[i] })))
  if (overlaps.length) {
    return {
      ok: false,
      error: 'pads-overlap',
      detail: `Copper of pads ${overlaps
        .slice(0, 6)
        .map(([a, b]) => `${a.number} and ${b.number}`)
        .join(
          ', '
        )}${overlaps.length > 6 ? ` and ${overlaps.length - 6} more pairs` : ''} would touch.`
    }
  }

  const numbers = pads.map((pad) => pad.number)
  const pin1 = spec.pin1?.trim()
  if (pin1 !== undefined && !numbers.includes(pin1)) {
    return { ok: false, error: 'bad-pin1', detail: `pin1 "${pin1}" is not a pad number.` }
  }
  if (pin1 === undefined && pads.length > 1) {
    return {
      ok: false,
      error: 'bad-pin1',
      detail: 'pin1 is required when there is more than one pad.'
    }
  }

  const body = bodyPoints(spec.body)
  if (!body) return { ok: false, error: 'bad-body', detail: JSON.stringify(spec.body) }
  const bodyBox = pointsBox(body)
  const bodyCenter = { x: (bodyBox.minX + bodyBox.maxX) / 2, y: (bodyBox.minY + bodyBox.maxY) / 2 }

  const padsBox = shapes.reduce<Box | null>((box, shape) => unionBox(box, shapeBox(shape)), null)!
  const pad1Index = pin1 === undefined ? -1 : numbers.indexOf(pin1)
  const pad1 = pad1Index >= 0 ? pads[pad1Index] : null

  // Fab: the body as given, pin 1's corner beveled.
  let fab = body
  let bevel: GenerateReport['derived']['bevel'] = null
  if (pad1) {
    const size = Math.min(
      FAB_BEVEL_MAX,
      FAB_BEVEL_FRACTION * Math.min(bodyBox.maxX - bodyBox.minX, bodyBox.maxY - bodyBox.minY)
    )
    const index = nearestIndex(body, pad1.at)
    fab = bevelVertex(body, index, size)
    bevel = { corner: mmPoint(body[index]), size: mm(size) }
  }

  // Silk: the body grown by the offset, cut clear of every pad. The clearance is
  // to the stroke's edge, so the centerline keeps half a stroke more.
  const clearance = SILK_PAD_CLEARANCE + SILK_WIDTH / 2
  const silk = offsetPolygon(body, SILK_OFFSET)
  const silkLines: Array<[Point, Point]> = []
  let cutNearPads = 0
  for (let i = 0; i < silk.length; i++) {
    const a = silk[i]
    const b = silk[(i + 1) % silk.length]
    const pieces = cutSegment(a, b, shapes, clearance, SILK_MIN_SEGMENT)
    const whole =
      pieces.length === 1 && distance(pieces[0][0], a) < 1 && distance(pieces[0][1], b) < 1
    if (!whole) cutNearPads += 1
    silkLines.push(...pieces)
  }

  const marker = pad1
    ? pin1Marker(style.pin1Marker, silk, pad1, shapes[pad1Index], bodyCenter, shapes, clearance)
    : null

  // Courtyard: pads ∪ body, grown by the class offset, on the courtyard grid.
  const courtyardClass = spec.courtyard ?? 'default'
  const offset = COURTYARD_OFFSET[courtyardClass]
  const union = unionBox(padsBox, bodyBox)
  const courtyard = snapOutward(
    {
      minX: union.minX - offset,
      minY: union.minY - offset,
      maxX: union.maxX + offset,
      maxY: union.maxY + offset
    },
    COURTYARD_GRID
  )

  // --- Write ------------------------------------------------------------------
  const footprint: KicadFootprint = parseKicadFootprint(footprintTemplate(name))
  const root = footprint._raw as SExprList
  setAttrChild(root, [])
  const at = root.start
  const scalar = (token: string, value: string): void => {
    root.children.push(makeList([makeAtom(token, false, at), makeAtom(value, true, at)], at))
  }
  if (spec.description) scalar('descr', spec.description)
  if (spec.tags) scalar('tags', spec.tags)

  const centerX = Math.round((courtyard.minX + courtyard.maxX) / 2) as Nm
  const referenceAt = { x: centerX, y: (courtyard.minY - TEXT_GAP) as Nm }
  const valueAt = { x: centerX, y: (courtyard.maxY + TEXT_GAP) as Nm }
  const text = { size: TEXT_SIZE, thickness: TEXT_THICKNESS }
  addFpPropertyToFootprintAST(footprint, 'Reference', 'REF**', {
    ...text,
    at: referenceAt,
    layer: 'F.SilkS'
  })
  addFpPropertyToFootprintAST(footprint, 'Value', name, { ...text, at: valueAt, layer: 'F.Fab' })
  if (spec.datasheet) {
    addFpPropertyToFootprintAST(footprint, 'Datasheet', spec.datasheet, {
      ...text,
      at: { x: 0 as Nm, y: 0 as Nm },
      layer: 'F.Fab',
      hide: true
    })
  }
  addFpPropertyToFootprintAST(
    footprint,
    GENERATOR_PROPERTY,
    `${opName} style ${FOOTPRINT_STYLE_VERSION}`,
    { ...text, at: { x: 0 as Nm, y: 0 as Nm }, layer: 'F.SilkS', hide: true }
  )
  setAttrChild(root, [spec.attributes === 'smd' ? 'smd' : 'through_hole'])

  for (const [a, b] of silkLines) {
    addFpLineToFootprintAST(footprint, {
      start: nmPoint(a),
      end: nmPoint(b),
      width: SILK_WIDTH,
      layer: 'F.SilkS'
    })
  }
  for (const [a, b] of marker?.lines ?? []) {
    addFpLineToFootprintAST(footprint, {
      start: nmPoint(a),
      end: nmPoint(b),
      width: SILK_WIDTH,
      layer: 'F.SilkS'
    })
  }
  if (marker?.dot) {
    // A filled circle whose stroke's outer edge is the marker's diameter.
    const radius = (PIN1_DOT_DIAMETER - SILK_WIDTH) / 2
    addFpCircleToFootprintAST(footprint, {
      center: nmPoint(marker.dot),
      end: nmPoint({ x: marker.dot.x + radius, y: marker.dot.y }),
      width: SILK_WIDTH,
      layer: 'F.SilkS',
      fill: 'solid'
    })
  }
  addFpRectToFootprintAST(footprint, {
    start: { x: courtyard.minX as Nm, y: courtyard.minY as Nm },
    end: { x: courtyard.maxX as Nm, y: courtyard.maxY as Nm },
    width: COURTYARD_WIDTH,
    layer: 'F.CrtYd'
  })
  addFpPolyToFootprintAST(footprint, {
    points: fab.map(nmPoint),
    width: FAB_WIDTH,
    layer: 'F.Fab'
  })

  const texts: GenerateReport['derived']['texts'] = [
    { text: 'REF**', layer: 'F.SilkS', at: mmPoint(referenceAt), size: mm(TEXT_SIZE) },
    { text: name, layer: 'F.Fab', at: mmPoint(valueAt), size: mm(TEXT_SIZE) }
  ]
  const fabSize = fabReferenceSize(bodyBox)
  if (fabSize !== null) {
    const fabAt = nmPoint(bodyCenter)
    addFpTextToFootprintAST(footprint, '${REFERENCE}', {
      at: fabAt,
      layer: 'F.Fab',
      size: fabSize as Nm,
      thickness: Math.round(fabSize * TEXT_THICKNESS_RATIO) as Nm
    })
    texts.push({ text: '${REFERENCE}', layer: 'F.Fab', at: mmPoint(fabAt), size: mm(fabSize) })
  }

  for (const pad of pads) addPadToFootprintAST(footprint, pad)

  return {
    ok: true,
    text: serializeKicadFootprint(footprint),
    report: {
      pads: pads.map((pad) => ({
        number: pad.number,
        type: pad.type,
        shape: pad.shape,
        at: {
          x: mm(pad.at.x),
          y: mm(pad.at.y),
          ...(pad.at.angle ? { angle: pad.at.angle } : {})
        },
        size: { width: mm(pad.size.w), height: mm(pad.size.h) },
        layers: pad.layers,
        ...(pad.drill
          ? {
              drill: {
                diameter: mm(pad.drill.diameter),
                ...(pad.drill.oval
                  ? { oval: { width: mm(pad.drill.oval.w), height: mm(pad.drill.oval.h) } }
                  : {})
              }
            }
          : {})
      })),
      // Unnumbered pads are mechanical holes, never one connection.
      sharedNumbers: sharedPadNumbers(numbers.filter(Boolean)),
      box: { courtyard: mmBox(courtyard), fab: mmBox(bodyBox), pads: mmBox(padsBox) },
      derived: {
        silk: { segments: silkLines.length, cutNearPads },
        pin1Marker: marker
          ? {
              kind: marker.kind,
              at: marker.at ? mmPoint(marker.at) : null,
              ...(marker.note ? { note: marker.note } : {})
            }
          : null,
        courtyard: { offset: mm(offset), box: mmBox(courtyard) },
        bevel,
        texts
      }
    }
  }
}
