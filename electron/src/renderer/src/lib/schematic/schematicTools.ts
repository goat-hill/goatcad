import { mmToNm, nm, pointsEqualNm, SNAP_EPSILON_NM, type Nm } from '../kicad/coordinates'
import type {
  KicadLibSymbol,
  KicadSchematic,
  Point,
  SymbolGraphic,
  SymbolPin
} from '../kicad/schematic'
import { textBoxCornerPoints } from './textBox'

/**
 * Pure geometry helpers behind the schematic placement tools: wire-draft
 * elbow routing, collinear cleanup on commit, attach-target detection, and
 * KiCad-style auto-junction placement. All coordinates are sheet space
 * (integer nanometers, y-down), matching the parsed document.
 */

/** Interactive tool armed in the schematic editor. */
export type SchematicTool =
  | 'select'
  | 'symbol'
  | 'power'
  | 'wire'
  | 'label'
  | 'global_label'
  | 'hierarchical_label'
  | 'no_connect'
  | 'junction'
  | 'text'
  | 'sheet'
  | 'sheet_pin'
  | 'directive_label'
  | 'bus'
  | 'bus_entry'
  | 'line'
  | 'rectangle'
  | 'circle'
  | 'arc'
  | 'bezier'
  | 'text_box'
  | 'table'
  | 'rule_area'
  | 'image'

/** Which axis the first segment of a wire elbow follows. */
export type WirePosture = 'hv' | 'vh'

/**
 * Default width of a newly drawn child sheet — the draw sets only height.
 * 10 cells of the default 1.27 mm grid; the resize handles widen it after.
 */
export const SHEET_DEFAULT_WIDTH: Nm = mmToNm(12.7)
/** Fallback height (12 grid cells) when the two draw clicks are (nearly) coincident. */
export const SHEET_DEFAULT_HEIGHT: Nm = mmToNm(15.24)

/**
 * Rectangle for a child sheet drawn by two clicks. Only the vertical extent
 * tracks the clicks; the width is fixed to `SHEET_DEFAULT_WIDTH` from the first
 * click's x (the resize handles adjust width and height freely once it is
 * placed). Sheet space (y-down): `y0` is the top edge, `y1` the bottom.
 */
export const sheetDraftRect = (start: Point, end: Point): { x0: Nm; y0: Nm; x1: Nm; y1: Nm } => ({
  x0: start.x,
  x1: nm(start.x + SHEET_DEFAULT_WIDTH),
  y0: nm(Math.min(start.y, end.y)),
  y1: nm(Math.max(start.y, end.y))
})

/**
 * Distance tolerance for the on-segment and collinearity tests below, which
 * measure TO a line and can carry sub-nm projection residue even on integer
 * inputs. Point identity itself is exact (`pointsEqualNm`).
 */
const EPSILON = SNAP_EPSILON_NM

const distanceToSegment = (point: Point, a: Point, b: Point): number => {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const apx = point.x - a.x
  const apy = point.y - a.y
  const lengthSq = abx * abx + aby * aby
  // Degenerate segment: under 1 nm² of extent means a and b are the same spot.
  if (lengthSq < 1) return Math.hypot(apx, apy)
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / lengthSq))
  return Math.hypot(apx - t * abx, apy - t * aby)
}

/**
 * Corner point(s) that turn `from` → `to` into axis-aligned segments.
 * Already-aligned targets need no corner; `posture` picks whether the
 * horizontal or the vertical leg comes first.
 */
export function elbowPoints(from: Point, to: Point, posture: WirePosture): Point[] {
  if (Math.abs(from.x - to.x) <= EPSILON || Math.abs(from.y - to.y) <= EPSILON) return [{ ...to }]
  const corner = posture === 'hv' ? { x: to.x, y: from.y } : { x: from.x, y: to.y }
  return [corner, { ...to }]
}

/**
 * Drop consecutive duplicate points, then interior points that sit on the
 * straight line between their neighbors (without reversing direction, so a
 * deliberate double-back survives).
 */
export function mergeCollinearPoints(points: Point[]): Point[] {
  const result: Point[] = []
  for (const point of points) {
    const last = result[result.length - 1]
    if (last && pointsEqualNm(last, point)) continue
    result.push({ ...point })
  }
  for (let index = result.length - 2; index >= 1; index--) {
    const a = result[index - 1]
    const b = result[index]
    const c = result[index + 1]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)
    if (Math.abs(cross) <= EPSILON && dot > 0) result.splice(index, 1)
  }
  return result
}

/** Whether `point` lies anywhere on the polyline (endpoints included). */
export function onWireRun(point: Point, run: Point[]): boolean {
  for (let index = 1; index < run.length; index++) {
    if (distanceToSegment(point, run[index - 1], run[index]) <= EPSILON) return true
  }
  return false
}

/** On the polyline but not at either terminal end (a T-landing, not a join). */
const onWireInterior = (point: Point, run: Point[]): boolean =>
  run.length >= 2 &&
  !pointsEqualNm(point, run[0]) &&
  !pointsEqualNm(point, run[run.length - 1]) &&
  onWireRun(point, run)

/**
 * Where a sheet's items other than symbols take a wire, as KiCad ends one
 * there: each sheet pin, each label (local, global, hierarchical) and net-class
 * flag at its anchor, and both ends of each bus entry. With the symbols' pins
 * and the wires, the points `isWireAttachPoint` reads.
 */
export function wireTerminals(
  doc: Pick<KicadSchematic, 'sheets' | 'labels' | 'directiveLabels' | 'busEntries'>
): Point[] {
  return [
    ...doc.sheets.flatMap((sheet) => sheet.pins.map((pin) => pin.position)),
    ...doc.labels.map((label) => label.position),
    ...doc.directiveLabels.map((label) => label.position),
    ...doc.busEntries.flatMap((entry) => [
      entry.position,
      { x: nm(entry.position.x + entry.size.width), y: nm(entry.position.y + entry.size.height) }
    ])
  ]
}

/**
 * Where a bus ends on its own, as KiCad's `IsTerminalPoint` has it for the
 * bus layer: a sheet pin or a label (another bus is the caller's run check).
 */
export function busTerminals(doc: Pick<KicadSchematic, 'sheets' | 'labels'>): Point[] {
  return [
    ...doc.sheets.flatMap((sheet) => sheet.pins.map((pin) => pin.position)),
    ...doc.labels.map((label) => label.position)
  ]
}

/**
 * Whether a wire ending at `point` should auto-complete: it landed on a pin,
 * a sheet pin, a label or a bus entry (`pins`), or anywhere on an existing wire.
 */
export function isWireAttachPoint(point: Point, wireRuns: Point[][], pins: Point[]): boolean {
  if (pins.some((pin) => pointsEqualNm(pin, point))) return true
  return wireRuns.some((run) => onWireRun(point, run))
}

/**
 * Next free reference for a designator prefix (`R` → `R4` when R1–R3 exist).
 * Only exact `<prefix><number>` matches count, so `RV2` never collides with
 * `R`. Unnumbered references (`R?`) are ignored.
 */
export function nextReference(existing: string[], prefix: string): string {
  let highest = 0
  for (const reference of existing) {
    if (!reference.startsWith(prefix)) continue
    const suffix = reference.slice(prefix.length)
    if (!/^\d+$/.test(suffix)) continue
    highest = Math.max(highest, Number(suffix))
  }
  return `${prefix}${highest + 1}`
}

/** Ghost geometry for the placement preview: a bounding outline and pin
 *  connection points in lib space (y-up, symbol origin). */
export interface PlacementGeometry {
  /** Closed bounding-box polyline (5 points). */
  outline: Point[]
  pins: Point[]
}

/** Every point that bounds a graphic, in lib space — what an outline or a
 *  placed bounding box is built from. */
export const graphicPoints = (graphic: SymbolGraphic): Point[] => {
  switch (graphic.type) {
    // Control points bound a Bezier, which is all a placement outline needs.
    case 'line':
    case 'bezier':
      return graphic.points
    case 'rectangle':
      return [graphic.start, graphic.end]
    case 'circle':
      return [
        { x: nm(graphic.center.x - graphic.radius), y: nm(graphic.center.y - graphic.radius) },
        { x: nm(graphic.center.x + graphic.radius), y: nm(graphic.center.y + graphic.radius) }
      ]
    case 'arc':
      return [graphic.start, graphic.mid, graphic.end]
    case 'text':
      return [graphic.position]
    // The border's corners, which is the box's real footprint on the sheet —
    // its anchor alone would under-report a body-sized annotation box. Rotation
    // is fractional trig, so the corners re-enter the integer grid rounded.
    case 'textBox':
      return textBoxCornerPoints(graphic).map((p) => ({ x: nm(p.x), y: nm(p.y) }))
  }
}

/** Bounding outline + pins of a lib-symbol extends chain, for one unit and body style. */
export function placementGeometry(
  chain: KicadLibSymbol[],
  unit = 1,
  bodyStyle = 1
): PlacementGeometry {
  const points: Point[] = []
  const pins: SymbolPin[] = []
  for (const definition of chain) {
    for (const graphic of definition.graphics) points.push(...graphicPoints(graphic))
    pins.push(...definition.pins)
    for (const variant of definition.variants) {
      if (
        (variant.unit === 0 || variant.unit === unit) &&
        (variant.style === 0 || variant.style === bodyStyle)
      ) {
        for (const graphic of variant.graphics) points.push(...graphicPoints(graphic))
        pins.push(...variant.pins)
      }
    }
  }
  for (const pin of pins) points.push(pin.position)
  if (!points.length) points.push({ x: nm(0), y: nm(0) })
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  const pad = mmToNm(0.635)
  minX -= pad
  minY -= pad
  maxX += pad
  maxY += pad
  return {
    outline: [
      { x: nm(minX), y: nm(minY) },
      { x: nm(maxX), y: nm(minY) },
      { x: nm(maxX), y: nm(maxY) },
      { x: nm(minX), y: nm(maxY) },
      { x: nm(minX), y: nm(minY) }
    ],
    pins: pins.map((pin) => ({ ...pin.position }))
  }
}

/**
 * Junction dots a freshly drawn wire requires, per KiCad's rules (three or
 * more exits at a point, `JUNCTION_HELPERS::AnalyzePoint`): a dot at each of
 * the new wire's terminals that lands on an existing wire's interior
 * (T-junction) or brings three or more items together, a dot wherever an
 * existing wire's dangling terminal is swallowed by the new wire's interior,
 * and a dot on every pin the new wire runs through — a pin with a wire through
 * it is three exits, and without the dot KiCad does not connect it. The wire
 * is broken at each of those points by the cleanup (`wireCleanup.ts` rule 0).
 * Points that already carry a junction are skipped.
 */
export function junctionsForNewWire(
  wireRuns: Point[][],
  junctions: Point[],
  pins: Point[],
  newWire: Point[]
): Point[] {
  if (newWire.length < 2) return []
  const result: Point[] = []
  const add = (point: Point): void => {
    if (junctions.some((junction) => pointsEqualNm(junction, point))) return
    if (result.some((existing) => pointsEqualNm(existing, point))) return
    result.push({ ...point })
  }

  const terminals = [newWire[0], newWire[newWire.length - 1]]
  for (const terminal of terminals) {
    let tJunction = false
    let degree = 1 // the new wire itself
    for (const run of wireRuns) {
      if (run.length < 2) continue
      if (pointsEqualNm(run[0], terminal) || pointsEqualNm(run[run.length - 1], terminal)) degree++
      else if (onWireRun(terminal, run)) tJunction = true
    }
    degree += pins.filter((pin) => pointsEqualNm(pin, terminal)).length
    if (tJunction || degree >= 3) add(terminal)
  }

  for (const run of wireRuns) {
    if (run.length < 2) continue
    for (const end of [run[0], run[run.length - 1]]) {
      if (terminals.some((terminal) => pointsEqualNm(terminal, end))) continue
      if (onWireInterior(end, newWire)) add(end)
    }
  }
  for (const pin of pins) {
    if (onWireInterior(pin, newWire)) add(pin)
  }
  return result
}
