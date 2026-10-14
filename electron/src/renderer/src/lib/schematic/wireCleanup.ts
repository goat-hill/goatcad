/**
 * Wire and junction cleanup: the tidy-up KiCad runs after every edit that
 * touches a wire (`SCHEMATIC::CleanUp`), so that what a sheet holds is exactly
 * what it draws. Design: `docs/schematic-editor-workstream.md` §6 and
 * `docs/agent-api.md`.
 *
 * Five rules, in this order:
 * 0. Where the edit put a connection point that needs a junction on a wire's
 *    interior — a pin a new wire runs through, a moved part's pin landing
 *    mid-wire, a wire end T'd onto another — the wire is broken there, as
 *    KiCad's `AddJunction` breaks it (`BreakSegments`); rule 3 then dots it.
 *    Only there: a pin that sat mid-wire before the edit is not connected in
 *    KiCad, and joining it unasked would change the netlist.
 * 1. A zero-length wire goes.
 * 2. Two collinear wires that overlap are one wire; one that lies inside
 *    another goes. Two that meet end to end and continue in the same
 *    direction are joined only when nothing else connects at the joint.
 * 3. A junction dot sits exactly where three things meet, counted the way
 *    KiCad counts them (`JUNCTION_HELPERS::AnalyzePoint`): by the distinct
 *    directions wires leave the point in, plus one per pin. Two wires drawn on
 *    top of each other leave in one direction and are not a junction; a wire
 *    passing through the point counts both ways once something ends there.
 * 4. Two dots at one point are one dot.
 *
 * Buses are tidied the same way on their own layer, as KiCad's cleanup takes
 * both (`LAYER_WIRE`, `LAYER_BUS`): a bus merges only with a bus, and its
 * dots count bus exits (`JUNCTION_HELPERS::AnalyzePoint` keeps the two
 * apart). A bus entry's end and a label naming a bus break a bus as a label
 * breaks a wire; on the wire layer an entry's end is an exit, as a pin is.
 *
 * Everything works on one sheet's document and writes through its AST. The
 * parsed arrays are stale afterwards, as after any AST edit; the command layer
 * re-parses.
 */
import { nm, pointsEqualNm } from '../kicad/coordinates'
import { placedPinPosition } from './connectivity'
import {
  addSchematicJunctionToAST,
  removeSchematicNodesFromAST,
  resolveSymbolGeometry,
  setSchematicWirePointsInAST,
  splitSchematicWireInAST,
  type KicadBusEntry,
  type KicadSchematic,
  type KicadWire,
  type Point
} from '../kicad/schematic'
import { parseBusName } from './busNames'
import { mergeCollinearPoints, onWireRun } from './schematicTools'
import type { SExprNode } from '../kicad/sexpr'

export interface CleanupReport {
  /** Zero-length wires, exact duplicates, and wires inside another. */
  wiresRemoved: number
  /** Overlapping or end-to-end collinear runs joined into one. */
  wiresMerged: number
  junctionsRemoved: number
  junctionsAdded: number
  /** Wires broken where the edit put a junction on their interior. */
  wiresSplit: number
}

export const cleanupChanged = (report: CleanupReport): boolean =>
  report.wiresRemoved +
    report.wiresMerged +
    report.junctionsRemoved +
    report.junctionsAdded +
    report.wiresSplit >
  0

const pointKey = (point: Point): string => `${point.x},${point.y}`

/** The direction a wire leaves `from` towards `to`, as a key: 0, 90, 180, -90 for orthogonal runs. */
const directionKey = (from: Point, to: Point): string =>
  String(Math.round((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI))

/** What connects on a sheet besides wires: pins (each its own direction, as
 *  KiCad has it) and the items that split a wire without adding a direction. */
export interface SheetContacts {
  pins: Point[]
  /** Label anchors and no-connect flags. */
  breakers: Point[]
}

export const sheetContacts = (doc: KicadSchematic): SheetContacts => {
  const pins: Point[] = []
  // One exit per symbol per point, as KiCad counts it: a part that stacks
  // its VDD pins at one place is one thing meeting the wire there, not three.
  const stack = (points: Point[]): void => {
    const seen = new Set<string>()
    for (const point of points) {
      const key = pointKey(point)
      if (seen.has(key)) continue
      seen.add(key)
      pins.push(point)
    }
  }
  for (const symbol of doc.symbols) {
    stack(resolveSymbolGeometry(doc, symbol).pins.map(({ pin }) => placedPinPosition(symbol, pin)))
  }
  for (const sheet of doc.sheets) {
    stack(sheet.pins.map((pin) => ({ x: pin.position.x, y: pin.position.y })))
  }
  // A bus entry's ends are exits on the wire layer too, as KiCad counts them.
  stack(doc.busEntries.flatMap(busEntryEnds))
  const breakers: Point[] = doc.labels.map((label) => ({
    x: label.position.x,
    y: label.position.y
  }))
  return { pins, breakers }
}

const busEntryEnds = (entry: KicadBusEntry): Point[] => [
  { x: entry.position.x, y: entry.position.y },
  { x: nm(entry.position.x + entry.size.width), y: nm(entry.position.y + entry.size.height) }
]

/**
 * What connects to buses: nothing that is an exit of its own. A bus entry's
 * end and a local label naming a bus break a bus there but add no direction,
 * so an entry tapping a bus is no junction while three buses meeting at it
 * are (KiCad's `hasBusEntryToMultipleBuses`).
 */
export const busContacts = (doc: KicadSchematic): SheetContacts => ({
  pins: [],
  breakers: [
    ...doc.busEntries.flatMap(busEntryEnds),
    ...doc.labels
      .filter((label) => label.type === 'label' && parseBusName(label.text) !== null)
      .map((label) => ({ x: label.position.x, y: label.position.y }))
  ]
})

/** One layer the cleanup tidies: its lines and what connects to them. */
interface Layer {
  lines: KicadWire[]
  contacts: SheetContacts
}

const layersOf = (doc: KicadSchematic): Layer[] => [
  { lines: doc.wires, contacts: sheetContacts(doc) },
  { lines: doc.buses, contacts: busContacts(doc) }
]

/**
 * Whether a junction dot belongs at `point`: KiCad's rule, three distinct
 * exits. A wire ending here is one exit in its direction; a pin here is an
 * exit of its own; a wire running through here adds both of its directions,
 * but only once something ends here — two wires crossing are not a junction.
 *
 * `breakCrossings` is the reading for a dot that is already there: a dot
 * placed on a crossing is the one way to join two wires that cross, so the
 * wires through it count whether or not anything ends there (KiCad's
 * `IsExplicitJunction`). A dot is never *added* on that reading.
 */
export const junctionNeededAt = (
  point: Point,
  runs: readonly Point[][],
  contacts: SheetContacts,
  breakCrossings = false
): boolean => {
  const exits = new Set<string>()
  let breaking = breakCrossings
  const through: Point[][] = []
  for (const run of runs) {
    if (run.length < 2) continue
    const first = run[0]
    const last = run[run.length - 1]
    if (pointsEqualNm(first, point)) {
      exits.add(directionKey(first, run[1]))
      breaking = true
    } else if (pointsEqualNm(last, point)) {
      exits.add(directionKey(last, run[run.length - 2]))
      breaking = true
    } else if (onWireRun(point, run)) {
      through.push(run)
    }
  }
  let pinCount = 0
  for (const pin of contacts.pins) {
    if (pointsEqualNm(pin, point)) {
      exits.add(`pin${pinCount++}`)
      breaking = true
    }
  }
  if (!breaking && contacts.breakers.some((breaker) => pointsEqualNm(breaker, point))) {
    breaking = true
  }
  if (breaking) {
    for (const run of through) {
      for (let index = 1; index < run.length; index++) {
        const a = run[index - 1]
        const b = run[index]
        if (onWireRun(point, [a, b])) {
          exits.add(directionKey(a, b))
          exits.add(directionKey(b, a))
        }
      }
    }
  }
  return exits.size >= 3
}

/**
 * A sheet's connection points and wire segments before an edit, by key — what
 * lets the cleanup tell where the edit touched, which is where KiCad looks for
 * the junctions an edit needs (`GetNeededJunctions` over the changed items).
 */
export interface ConnectionShape {
  points: Set<string>
  segments: Set<string>
  /** The same for the bus layer. */
  bus?: { points: Set<string>; segments: Set<string> }
}

const segmentKey = (a: Point, b: Point): string => {
  const ka = pointKey(a)
  const kb = pointKey(b)
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
}

/** Every point something connects at on a layer: its contacts, its line ends, dots. */
const connectionPoints = (doc: KicadSchematic, layer: Layer): Point[] => [
  ...layer.contacts.pins,
  ...layer.contacts.breakers,
  ...layer.lines.flatMap((wire) =>
    wire.points.length ? [wire.points[0], wire.points[wire.points.length - 1]] : []
  ),
  ...doc.junctions.map((junction) => ({ x: junction.x, y: junction.y }))
]

const layerShape = (doc: KicadSchematic, layer: Layer): Omit<ConnectionShape, 'bus'> => {
  const segments = new Set<string>()
  for (const wire of layer.lines) {
    for (let index = 1; index < wire.points.length; index++) {
      segments.add(segmentKey(wire.points[index - 1], wire.points[index]))
    }
  }
  return { points: new Set(connectionPoints(doc, layer).map(pointKey)), segments }
}

export const connectionShape = (doc: KicadSchematic): ConnectionShape => {
  const [wires, buses] = layersOf(doc)
  return { ...layerShape(doc, wires), bus: layerShape(doc, buses) }
}

/**
 * Where an edit touched the sheet's connections: every connection point that
 * is new, and every connection point on a wire segment that is new — which
 * takes in a pin a new wire runs through, and a wire end the new wire's
 * interior swallows.
 */
const touchedPoints = (
  doc: KicadSchematic,
  layer: Layer,
  before: Omit<ConnectionShape, 'bus'>
): Point[] => {
  const points = connectionPoints(doc, layer)
  const touched = new Map<string, Point>()
  for (const point of points) {
    if (!before.points.has(pointKey(point))) touched.set(pointKey(point), point)
  }
  for (const wire of layer.lines) {
    for (let index = 1; index < wire.points.length; index++) {
      const a = wire.points[index - 1]
      const b = wire.points[index]
      if (before.segments.has(segmentKey(a, b))) continue
      for (const point of points) {
        if (onWireRun(point, [a, b])) touched.set(pointKey(point), point)
      }
    }
  }
  return [...touched.values()]
}

/** Rule 0: break every wire that runs through a touched point needing a dot. */
const breakAtTouched = (
  doc: KicadSchematic,
  layer: Layer,
  before: Omit<ConnectionShape, 'bus'>
): number => {
  let splits = 0
  for (const point of touchedPoints(doc, layer, before)) {
    const runs = layer.lines.map((wire) => mergeCollinearPoints(wire.points))
    // A dot the edit put down is read as KiCad's junction tool places it: it
    // joins the wires crossing there, so they break there too.
    const dotted = doc.junctions.some((junction) => pointsEqualNm(junction, point))
    if (!junctionNeededAt(point, runs, layer.contacts, dotted)) continue
    for (const wire of [...layer.lines]) {
      if (splitSchematicWireInAST(doc, wire, point)) splits++
    }
  }
  return splits
}

interface Segment {
  wire: KicadWire
  points: Point[]
  stroke: string
  alive: boolean
}

const strokeKey = (wire: KicadWire): string =>
  `${wire.width}|${wire.strokeType ?? ''}|${wire.strokeColor ? JSON.stringify(wire.strokeColor) : ''}`

type Axis = 'x' | 'y'

/** The axis a two-point orthogonal segment runs along, or null for a diagonal. */
const axisOf = (points: Point[]): Axis | null => {
  if (points.length !== 2) return null
  if (points[0].y === points[1].y) return 'x'
  if (points[0].x === points[1].x) return 'y'
  return null
}

const extent = (points: Point[], axis: Axis): [number, number] => {
  const a = points[0][axis]
  const b = points[1][axis]
  return a <= b ? [a, b] : [b, a]
}

/** `base` with its coordinate along `axis` replaced. */
const along = (base: Point, axis: Axis, value: number): Point =>
  axis === 'x' ? { x: nm(value), y: base.y } : { x: base.x, y: nm(value) }

/**
 * Tidy the sheet in place, per the rules in the header. `before` is the sheet's
 * connection shape before the edit, which is what rule 0 needs; without it the
 * tidy breaks no wire. Returns what changed; the caller re-parses the document
 * afterwards.
 */
export function cleanupSchematic(doc: KicadSchematic, before?: ConnectionShape): CleanupReport {
  const report: CleanupReport = {
    wiresRemoved: 0,
    wiresMerged: 0,
    junctionsRemoved: 0,
    junctionsAdded: 0,
    wiresSplit: 0
  }
  const doomed: SExprNode[] = []
  const layers = layersOf(doc)

  // 0. Breaks where the edit needs a dot, each layer against its own before.
  const [wireLayer, busLayer] = layers
  if (before) {
    report.wiresSplit += breakAtTouched(doc, wireLayer, before)
    if (before.bus) report.wiresSplit += breakAtTouched(doc, busLayer, before.bus)
  }

  // 1 and 2, a layer at a time; then 3 and 4 over the dots both need.
  const needed = new Map<string, Point>()
  const tidied = layers.map((layer) => {
    const runs = tidyLayer(layer, doomed, report)
    const candidates = new Map<string, Point>()
    for (const run of runs) {
      candidates.set(pointKey(run[0]), run[0])
      candidates.set(pointKey(run[run.length - 1]), run[run.length - 1])
    }
    for (const [key, point] of candidates) {
      if (junctionNeededAt(point, runs, layer.contacts)) needed.set(key, point)
    }
    return { runs, contacts: layer.contacts }
  })

  const kept = new Set<string>()
  for (const junction of doc.junctions) {
    const key = pointKey(junction)
    const wanted =
      needed.has(key) ||
      tidied.some(({ runs, contacts }) => junctionNeededAt(junction, runs, contacts, true))
    if (!wanted || kept.has(key)) {
      doomed.push(junction._node)
      report.junctionsRemoved++
      continue
    }
    kept.add(key)
  }

  if (doomed.length) removeSchematicNodesFromAST(doc, doomed)
  for (const [key, point] of needed) {
    if (kept.has(key)) continue
    addSchematicJunctionToAST(doc, point)
    report.junctionsAdded++
  }
  return report
}

/**
 * Rules 1 and 2 on one layer's lines: zero-length lines go, overlapping and
 * continuing collinear ones join. Returns the runs left.
 */
function tidyLayer(layer: Layer, doomed: SExprNode[], report: CleanupReport): Point[][] {
  const { contacts } = layer
  const segments: Segment[] = layer.lines.map((wire) => ({
    wire,
    points: mergeCollinearPoints(wire.points),
    stroke: strokeKey(wire),
    alive: true
  }))

  // 1. Zero length.
  for (const segment of segments) {
    if (segment.points.length < 2) {
      segment.alive = false
      doomed.push(segment.wire._node)
      report.wiresRemoved++
    }
  }

  const alive = (): Segment[] => segments.filter((segment) => segment.alive)

  /** Whether anything but `first` and `second` connects at `point`. */
  const otherContactAt = (point: Point, first: Segment, second: Segment): boolean => {
    if (contacts.pins.some((pin) => pointsEqualNm(pin, point))) return true
    if (contacts.breakers.some((breaker) => pointsEqualNm(breaker, point))) return true
    for (const other of alive()) {
      if (other === first || other === second) continue
      if (onWireRun(point, other.points)) return true
    }
    return false
  }

  // 2. Overlap and continuation, until nothing more joins.
  let changed = true
  while (changed) {
    changed = false
    const live = alive()
    for (let i = 0; i < live.length && !changed; i++) {
      const first = live[i]
      const axis = axisOf(first.points)
      if (!axis) continue
      const across: Axis = axis === 'x' ? 'y' : 'x'
      for (let j = i + 1; j < live.length; j++) {
        const second = live[j]
        if (second.stroke !== first.stroke) continue
        if (axisOf(second.points) !== axis) continue
        if (second.points[0][across] !== first.points[0][across]) continue
        const [lo1, hi1] = extent(first.points, axis)
        const [lo2, hi2] = extent(second.points, axis)
        const overlapLow = Math.max(lo1, lo2)
        const overlapHigh = Math.min(hi1, hi2)
        if (overlapLow > overlapHigh) continue
        const touching = overlapLow === overlapHigh
        if (touching) {
          const joint = along(first.points[0], axis, overlapLow)
          if (otherContactAt(joint, first, second)) continue
        }
        const lo = Math.min(lo1, lo2)
        const hi = Math.max(hi1, hi2)
        const inside = (low: number, high: number): boolean => low === lo && high === hi
        if (inside(lo1, hi1)) {
          // second lies within first: it goes, first is unchanged.
          second.alive = false
          doomed.push(second.wire._node)
          report.wiresRemoved++
        } else if (inside(lo2, hi2)) {
          first.alive = false
          doomed.push(first.wire._node)
          report.wiresRemoved++
        } else {
          const span = [along(first.points[0], axis, lo), along(first.points[0], axis, hi)]
          setSchematicWirePointsInAST(first.wire, span)
          first.points = span
          second.alive = false
          doomed.push(second.wire._node)
          report.wiresMerged++
        }
        changed = true
        break
      }
    }
  }

  return alive().map((segment) => segment.points)
}

/** How a route about to be drawn meets the wires already on the sheet. */
export interface RouteContacts {
  /** Wires a segment of the route would lie along, sharing more than a point. */
  overlapping: number[]
  /** Wires an end of the route lands on — the joins the route makes. */
  landing: number[]
  /** Wires whose own end lands on the route's interior — joins the route makes the other way. */
  teed: number[]
}

export const routeContacts = (wires: readonly KicadWire[], route: Point[]): RouteContacts => {
  const contacts: RouteContacts = { overlapping: [], landing: [], teed: [] }
  if (route.length < 2) return contacts
  const ends = [route[0], route[route.length - 1]]
  wires.forEach((wire, index) => {
    const points = mergeCollinearPoints(wire.points)
    if (points.length < 2) return
    let overlaps = false
    const axis = axisOf(points)
    if (axis) {
      const across: Axis = axis === 'x' ? 'y' : 'x'
      for (let i = 1; i < route.length && !overlaps; i++) {
        const segment = [route[i - 1], route[i]]
        if (axisOf(segment) !== axis) continue
        if (segment[0][across] !== points[0][across]) continue
        const [lo1, hi1] = extent(segment, axis)
        const [lo2, hi2] = extent(points, axis)
        if (Math.max(lo1, lo2) < Math.min(hi1, hi2)) overlaps = true
      }
    }
    if (overlaps) {
      contacts.overlapping.push(index)
      return
    }
    if (ends.some((end) => onWireRun(end, points))) contacts.landing.push(index)
    const first = points[0]
    const last = points[points.length - 1]
    const interior = (point: Point): boolean =>
      !ends.some((end) => pointsEqualNm(end, point)) && onWireRun(point, route)
    if (interior(first) || interior(last)) contacts.teed.push(index)
  })
  return contacts
}
