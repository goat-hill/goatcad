/**
 * Wires follow a moved item: the geometry behind a drag that keeps its
 * connections. Design and rationale: `docs/schematic-editor-workstream.md`
 * §6. In short — wires stay orthogonal; a wire end on a pin keeps leaving the
 * pin along its axis for a grid step, an end on a junction or another wire
 * bends where it is, and a dangling end travels with its segment; the fewest
 * vertices change; and the answer is a function of the final position alone,
 * so a preview, a commit and an API call agree.
 *
 * Sheet space throughout: integer nanometers, y-down.
 */
import { nm, pointsEqualNm, type Nm } from '../kicad/coordinates'
import type { Point } from '../kicad/schematic'
import { mergeCollinearPoints } from './schematicTools'

export type Direction = 'right' | 'up' | 'left' | 'down'

/** Cardinal direction of a KiCad angle: 0 is right, 90 is up (y decreasing). */
export const directionOf = (angle: number): Direction => {
  const folded = (((Math.round(angle / 90) * 90) % 360) + 360) % 360
  return folded === 0 ? 'right' : folded === 90 ? 'up' : folded === 180 ? 'left' : 'down'
}

const OPPOSITE: Record<Direction, Direction> = {
  right: 'left',
  up: 'down',
  left: 'right',
  down: 'up'
}

/**
 * The way a wire leaves a global or hierarchical label's anchor: back along
 * the label's reading direction, since the body extends the other way and a
 * wire dropping onto the anchor from any other side lands on the body's
 * corner. A local label is text above the wire and has no such side.
 */
export const labelPortDirection = (angle: number): Direction => OPPOSITE[directionOf(angle)]

interface Vector {
  x: number
  y: number
}

const VECTOR: Record<Direction, Vector> = {
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  down: { x: 0, y: 1 }
}

/** A connection point that moves: where it was, where it lands, and — for a
 *  pin — the way a wire must leave it there. Wire ends, junctions and labels
 *  carry no direction: a wire may bend right at them. */
export interface MovedPoint {
  from: Point
  to: Point
  direction?: Direction
  /** The pin's direction before the move, when it was turned: its wire is
   *  then redrawn to leave along the new axis rather than slid. */
  directionBefore?: Direction
  /** The angle a label riding this point should read at afterward, when a
   *  turn changed it. */
  labelAngle?: number
  /** A net item without a direction of its own — a label — that keeps its
   *  connection: pulled off a pin it sat on directly, it takes a new wire
   *  along. A junction, flag or wire end pulled off a pin just leaves it. */
  draws?: boolean
}

/** The sheet as the reshape sees it. Everything that is itself moving is left
 *  out of `pins`, `junctions` and `anchors` (the caller carries those), and
 *  named in `movedWires` instead of being reshaped. */
export interface ReshapeGeometry {
  /** Every wire on the sheet, by index. */
  wires: Point[][]
  /** Junction dots that are not moving. */
  junctions: Point[]
  /** Connection points that stay put and fix a wire's exit axis: the pins of
   *  unmoved symbols and hierarchical sheets, and the anchors of unmoved
   *  global and hierarchical labels (`label`, which fix the axis the same way
   *  but do not count toward a junction). */
  pins: { position: Point; direction: Direction; label?: boolean }[]
  /** Points that ride a wire — label anchors and no-connect flags — that are
   *  not themselves moving. */
  anchors: Point[]
}

export interface ReshapeOptions {
  /** The grid step: how far a wire leaves a pin before it may bend. */
  grid: Nm
  /** Wires moving with the selection. Their ends are moved points. */
  movedWires?: ReadonlySet<number>
  /** Where each moved wire ends up, when the move is not a translation (a
   *  turn); otherwise a moved wire is taken to shift with its first point. */
  movedWirePoints?: ReadonlyMap<number, Point[]>
  /** Whether a wire end T'd onto a moved wire's interior rides along it
   *  (default). Off for a wire whose end alone is dragged: the T stays where it
   *  is on the part of the wire that did not move. */
  teesRide?: boolean
}

/** A wire's new polyline; empty means the wire is gone. */
export interface WireGeometryEdit {
  index: number
  points: Point[]
}

export interface ReshapeResult {
  edits: WireGeometryEdit[]
  added: Point[][]
  junctionsAdded: Point[]
  junctionsRemoved: Point[]
  /** Anchors that travelled with a dangling end or slid along a segment. */
  anchorsMoved: { from: Point; to: Point }[]
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const key = (point: Point): string => `${point.x},${point.y}`

const offset = (point: Point, vector: Vector, by: number): Point => ({
  x: nm(point.x + vector.x * by),
  y: nm(point.y + vector.y * by)
})

const shift = (point: Point, delta: Vector): Point => ({
  x: nm(point.x + delta.x),
  y: nm(point.y + delta.y)
})

/** Unit axis from `a` to `b`, or null when the segment is diagonal or empty. */
const axisOf = (a: Point, b: Point): Vector | null => {
  if (a.x === b.x && a.y !== b.y) return { x: 0, y: b.y > a.y ? 1 : -1 }
  if (a.y === b.y && a.x !== b.x) return { x: b.x > a.x ? 1 : -1, y: 0 }
  return null
}

const sameVector = (a: Vector, b: Vector): boolean => a.x === b.x && a.y === b.y
const horizontal = (vector: Vector): boolean => vector.y === 0

const between = (value: number, a: number, b: number): boolean =>
  value >= Math.min(a, b) && value <= Math.max(a, b)

/** Whether `point` lies on the axis-aligned segment `a`–`b`, ends included. */
const onSegment = (point: Point, a: Point, b: Point): boolean =>
  a.x === b.x
    ? point.x === a.x && between(point.y, a.y, b.y)
    : a.y === b.y
      ? point.y === a.y && between(point.x, a.x, b.x)
      : false

/** On the segment but at neither end. */
const insideSegment = (point: Point, a: Point, b: Point): boolean =>
  onSegment(point, a, b) && !pointsEqualNm(point, a) && !pointsEqualNm(point, b)

const insideRun = (point: Point, run: Point[]): boolean => {
  for (let index = 1; index < run.length; index++) {
    if (insideSegment(point, run[index - 1], run[index])) return true
  }
  return false
}

/** Closest point of an axis-aligned polyline to `point`. */
const nearestOnRun = (point: Point, run: Point[]): Point => {
  let best = run[0]
  let bestDistance = Infinity
  for (let index = 1; index < run.length; index++) {
    const a = run[index - 1]
    const b = run[index]
    const candidate: Point =
      a.x === b.x
        ? { x: a.x, y: nm(Math.min(Math.max(point.y, Math.min(a.y, b.y)), Math.max(a.y, b.y))) }
        : { x: nm(Math.min(Math.max(point.x, Math.min(a.x, b.x)), Math.max(a.x, b.x))), y: a.y }
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Runs: the chain of segments from a moved point to the first place it may not
// bend freely past
// ---------------------------------------------------------------------------

type FarEnd =
  | { kind: 'pin'; point: Point; direction: Direction }
  | { kind: 'hinged'; point: Point }
  | { kind: 'free'; point: Point }
  | { kind: 'moved'; point: Point; moved: MovedPoint }

interface Run {
  from: MovedPoint
  /** Original polyline, moved end first, corners merged. */
  points: Point[]
  /** Wires the run consumed, moved end first. */
  wireIndices: number[]
  far: FarEnd
  /** A wire the run left mid-segment keeps the part past the split. */
  truncated?: WireGeometryEdit
}

interface Port {
  point: Point
  direction?: Direction
}

class SheetIndex {
  readonly endsAt = new Map<string, { index: number; end: 'start' | 'end' }[]>()
  readonly pinsAt = new Map<string, Direction>()
  readonly junctionsAt = new Set<string>()
  readonly anchorsAt = new Set<string>()
  readonly movedAt = new Map<string, MovedPoint>()
  readonly staticWires: number[] = []

  constructor(
    readonly geometry: ReshapeGeometry,
    moved: MovedPoint[],
    readonly movedWires: ReadonlySet<number>
  ) {
    for (const point of moved) {
      const existing = this.movedAt.get(key(point.from))
      // Two items on one point: the pin's direction is the one that matters.
      if (!existing || (!existing.direction && point.direction)) {
        this.movedAt.set(key(point.from), point)
      }
    }
    geometry.wires.forEach((wire, index) => {
      if (movedWires.has(index) || wire.length < 2) return
      if (pointsEqualNm(wire[0], wire[wire.length - 1])) return
      this.staticWires.push(index)
      this.addEnd(wire[0], index, 'start')
      this.addEnd(wire[wire.length - 1], index, 'end')
    })
    for (const pin of geometry.pins) this.pinsAt.set(key(pin.position), pin.direction)
    for (const junction of geometry.junctions) this.junctionsAt.add(key(junction))
    for (const anchor of geometry.anchors) this.anchorsAt.add(key(anchor))
  }

  private addEnd(point: Point, index: number, end: 'start' | 'end'): void {
    const list = this.endsAt.get(key(point))
    if (list) list.push({ index, end })
    else this.endsAt.set(key(point), [{ index, end }])
  }

  /** The wire `index`, ordered so `end` comes first. */
  oriented(index: number, end: 'start' | 'end'): Point[] {
    const wire = this.geometry.wires[index]
    return end === 'start' ? [...wire] : [...wire].reverse()
  }

  /** Static wires whose interior a point sits on, other than `exclude`. */
  hostOf(point: Point, exclude: ReadonlySet<number>): number | null {
    for (const index of this.staticWires) {
      if (exclude.has(index)) continue
      if (insideRun(point, this.geometry.wires[index])) return index
    }
    return null
  }
}

/** Nearest point strictly inside `a`–`b` where the run may not pass freely:
 *  a pin, a junction, or another wire's end. */
const firstHingeInside = (
  index: SheetIndex,
  a: Point,
  b: Point,
  exclude: ReadonlySet<number>
): Point | null => {
  let best: Point | null = null
  let bestDistance = Infinity
  const consider = (point: Point): void => {
    if (!insideSegment(point, a, b)) return
    const distance = Math.hypot(point.x - a.x, point.y - a.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = point
    }
  }
  for (const pin of index.geometry.pins) consider(pin.position)
  for (const junction of index.geometry.junctions) consider(junction)
  for (const wireIndex of index.staticWires) {
    if (exclude.has(wireIndex)) continue
    const wire = index.geometry.wires[wireIndex]
    consider(wire[0])
    consider(wire[wire.length - 1])
  }
  return best
}

const walkRun = (
  index: SheetIndex,
  from: MovedPoint,
  startWire: number,
  startEnd: 'start' | 'end',
  visited: Set<number>
): Run => {
  const points: Point[] = []
  const wireIndices: number[] = []
  const consumed = new Set<number>()
  let wire = startWire
  let end = startEnd
  for (;;) {
    const oriented = index.oriented(wire, end)
    consumed.add(wire)
    visited.add(wire)
    // A pin, junction or wire end inside a segment is where the run stops,
    // and the wire keeps whatever lies beyond it.
    for (let segment = 1; segment < oriented.length; segment++) {
      const hinge = firstHingeInside(index, oriented[segment - 1], oriented[segment], consumed)
      if (!hinge) continue
      points.push(...oriented.slice(0, segment), hinge)
      return {
        from,
        points: mergeCollinearPoints(points),
        wireIndices,
        far: { kind: 'hinged', point: hinge },
        truncated: { index: wire, points: [hinge, ...oriented.slice(segment)] }
      }
    }
    points.push(...(points.length ? oriented.slice(1) : oriented))
    wireIndices.push(wire)
    const tip = oriented[oriented.length - 1]
    const at = key(tip)
    const moved = index.movedAt.get(at)
    const finish = (far: FarEnd): Run => ({
      from,
      points: mergeCollinearPoints(points),
      wireIndices,
      far
    })
    if (moved) return finish({ kind: 'moved', point: tip, moved })
    const pin = index.pinsAt.get(at)
    if (pin) return finish({ kind: 'pin', point: tip, direction: pin })
    const others = (index.endsAt.get(at) ?? []).filter((entry) => !consumed.has(entry.index))
    const hinged =
      index.junctionsAt.has(at) ||
      others.length >= 2 ||
      (others.length === 1 && (index.anchorsAt.has(at) || visited.has(others[0].index))) ||
      index.hostOf(tip, consumed) !== null
    if (hinged) return finish({ kind: 'hinged', point: tip })
    if (others.length === 0) return finish({ kind: 'free', point: tip })
    wire = others[0].index
    end = others[0].end
  }
}

// ---------------------------------------------------------------------------
// Reshaping one run
// ---------------------------------------------------------------------------

/** The grid point nearest the middle of `u`–`v`, or the exact middle when the
 *  two are too close for a grid point to sit strictly between them. */
const midpoint = (u: number, v: number, grid: Nm): number => {
  const middle = (u + v) / 2
  const snapped = Math.round(middle / grid) * grid
  return snapped > Math.min(u, v) && snapped < Math.max(u, v) ? snapped : middle
}

/**
 * An orthogonal route between two ports: a stub off each port that has a
 * direction, then a straight line, an L, or a Z. The Z's riser sits `k` grid
 * steps off the moved port, so sibling wires nest instead of overlapping. No
 * leg ever travels back through a port: when the one-corner routes all would,
 * the wire hooks around instead.
 */
const routePorts = (
  from: Port,
  to: Port,
  preferredAxis: Vector | null,
  k: number,
  grid: Nm
): Point[] => {
  const fromVector = from.direction ? VECTOR[from.direction] : null
  const toVector = to.direction ? VECTOR[to.direction] : null
  let a = fromVector ? offset(from.point, fromVector, grid * k) : from.point
  let b = toVector ? offset(to.point, toVector, grid) : to.point
  // Ports facing each other closer than two stubs: the stubs would pass each
  // other and the wire would hook around itself. A person draws the short
  // way — straight between the tips, or one bend — leaving the pins sideways.
  if (fromVector && toVector && sameVector(fromVector, { x: -toVector.x, y: -toVector.y })) {
    if ((b.x - a.x) * fromVector.x + (b.y - a.y) * fromVector.y < 0) {
      a = from.point
      b = to.point
    }
  }
  // A leg leaving `a` along the from-axis must head away from its port, and a
  // leg reaching `b` along the to-axis must head toward its port — a wire
  // never runs back through the body it comes out of or goes into.
  const leavesWrong = (next: Point): boolean => {
    if (!fromVector) return false
    const dx = next.x - a.x
    const dy = next.y - a.y
    return horizontal(fromVector)
      ? dy === 0 && Math.sign(dx) !== fromVector.x
      : dx === 0 && Math.sign(dy) !== fromVector.y
  }
  const arrivesWrong = (previous: Point): boolean => {
    if (!toVector) return false
    const dx = b.x - previous.x
    const dy = b.y - previous.y
    return horizontal(toVector)
      ? dy === 0 && Math.sign(dx) !== -toVector.x
      : dx === 0 && Math.sign(dy) !== -toVector.y
  }
  const conflicts = (middle: Point[]): boolean =>
    leavesWrong(middle[0] ?? b) || arrivesWrong(middle[middle.length - 1] ?? a)

  let middle: Point[] | undefined
  if (a.x === b.x && a.y === b.y) {
    middle = []
  } else if (a.x === b.x || a.y === b.y) {
    if (!conflicts([])) middle = []
  } else {
    const viaX: Point = { x: b.x, y: a.y }
    const viaY: Point = { x: a.x, y: b.y }
    const parallel = fromVector && toVector && horizontal(fromVector) === horizontal(toVector)
    const order = parallel
      ? // The riser off the moved port, so siblings nest.
        horizontal(fromVector)
        ? [viaY, viaX]
        : [viaX, viaY]
      : fromVector
        ? // Carry on past the stub before turning.
          horizontal(fromVector)
          ? [viaX, viaY]
          : [viaY, viaX]
        : toVector
          ? // Arrive along the pin's axis over the long leg.
            horizontal(toVector)
            ? [viaY, viaX]
            : [viaX, viaY]
          : preferredAxis && !horizontal(preferredAxis)
            ? [viaY, viaX]
            : [viaX, viaY]
    const corner = order.find((candidate) => !conflicts([candidate]))
    if (corner) middle = [corner]
  }
  if (!middle && fromVector && toVector && horizontal(fromVector) === horizontal(toVector)) {
    // Facing ports that have passed each other: hook around between them.
    middle = horizontal(fromVector)
      ? [
          { x: a.x, y: nm(midpoint(a.y, b.y, grid)) },
          { x: b.x, y: nm(midpoint(a.y, b.y, grid)) }
        ]
      : [
          { x: nm(midpoint(a.x, b.x, grid)), y: a.y },
          { x: nm(midpoint(a.x, b.x, grid)), y: b.y }
        ]
  }
  if (!middle && fromVector) {
    // The target lies behind the port: step one grid to the side of the
    // stub, run back along the body's flank, and come in from there — one
    // more step off the far port first if that is the only way in.
    const perpendicular: Vector = horizontal(fromVector)
      ? { x: 0, y: Math.sign(b.y - a.y) || 1 }
      : { x: Math.sign(b.x - a.x) || 1, y: 0 }
    const side = offset(a, perpendicular, grid)
    const alongside = (target: Point): Point =>
      horizontal(fromVector) ? { x: target.x, y: side.y } : { x: side.x, y: target.y }
    middle = [side, alongside(b)]
    if (arrivesWrong(alongside(b)) && toVector) {
      const beyond = offset(b, toVector, grid)
      middle = [side, alongside(beyond), beyond]
    }
  }
  return mergeCollinearPoints([from.point, a, ...(middle ?? []), b, to.point])
}

const farPort = (far: FarEnd): Port =>
  far.kind === 'pin'
    ? { point: far.point, direction: far.direction }
    : far.kind === 'moved'
      ? { point: far.moved.to, direction: far.moved.direction }
      : { point: far.point }

/** The first segment leaves along `direction` for at least a grid step. */
const keepsStub = (points: Point[], direction: Direction, grid: Nm): boolean => {
  if (points.length < 2) return false
  const vector = VECTOR[direction]
  const dx = points[1].x - points[0].x
  const dy = points[1].y - points[0].y
  return dx * vector.x + dy * vector.y >= grid && dx * vector.y === 0 && dy * vector.x === 0
}

type Plan =
  | { mode: 'rigid'; delta: Vector }
  | { mode: 'slide'; points: Point[] }
  /** Redrawn from the moved point; `stub` says whether it leaves along the
   *  pin's axis first (a wire that left sideways before stays sideways). */
  | { mode: 'reroute'; stub: boolean }

/** What a run can do without being redrawn. */
const planRun = (run: Run, grid: Nm): Plan => {
  const { from, far, points } = run
  const delta: Vector = { x: from.to.x - from.from.x, y: from.to.y - from.from.y }
  if (far.kind === 'moved') {
    const farDelta = { x: far.moved.to.x - far.moved.from.x, y: far.moved.to.y - far.moved.from.y }
    return sameVector(delta, farDelta) ? { mode: 'rigid', delta } : { mode: 'reroute', stub: true }
  }
  const axis = axisOf(points[0], points[1])
  // Pin on pin with no wire between: a wire is drawn. A diagonal wire has no
  // axis to keep; it rubber-bands.
  if (!axis) {
    if (pointsEqualNm(points[0], points[1])) return { mode: 'reroute', stub: true }
    return { mode: 'slide', points: [from.to, ...points.slice(1)] }
  }
  if (from.directionBefore && from.directionBefore !== from.direction) {
    return { mode: 'reroute', stub: true }
  }
  // A wire that already left its pin sideways is slid as it is; only one
  // that kept the stub is held to keeping it.
  const vector = from.direction ? VECTOR[from.direction] : null
  const kept = vector !== null && sameVector(vector, axis)
  const perpendicular: Vector = { x: -axis.y, y: axis.x }
  const across = delta.x * perpendicular.x + delta.y * perpendicular.y
  let slid: Point[] | null = null
  if (across === 0) slid = [from.to, ...points.slice(1)]
  else if (points.length >= 3) {
    slid = [from.to, offset(points[1], perpendicular, across), ...points.slice(2)]
  } else if (far.kind === 'free') {
    slid = [from.to, ...points.slice(1).map((point) => offset(point, perpendicular, across))]
  }
  if (slid && (!kept || !from.direction || keepsStub(slid, from.direction, grid))) {
    return { mode: 'slide', points: slid }
  }
  return { mode: 'reroute', stub: kept }
}

/** A rerouted run gets a nested riser only when both ends are pins facing the
 *  same axis: that is the Z, and the Z is what siblings stack. */
const needsRiser = (run: Run, plan: Plan): boolean => {
  if (plan.mode !== 'reroute' || !plan.stub || !run.from.direction) return false
  const far = farPort(run.far)
  return (
    far.direction !== undefined &&
    horizontal(VECTOR[run.from.direction]) === horizontal(VECTOR[far.direction])
  )
}

// ---------------------------------------------------------------------------
// The reshape
// ---------------------------------------------------------------------------

export function reshapeWires(
  geometry: ReshapeGeometry,
  moved: MovedPoint[],
  options: ReshapeOptions
): ReshapeResult {
  const grid = options.grid
  const movedWires = options.movedWires ?? new Set<number>()
  // Moved points, one per place; a pin's direction wins over a bare point's.
  const movedAt = new Map<string, MovedPoint>()
  const note = (point: MovedPoint): void => {
    const existing = movedAt.get(key(point.from))
    if (!existing || (!existing.direction && point.direction)) movedAt.set(key(point.from), point)
  }
  for (const point of moved) note(point)
  const isStatic = (wireIndex: number): boolean =>
    !movedWires.has(wireIndex) && (geometry.wires[wireIndex]?.length ?? 0) >= 2
  /** Where a moved wire ends up: as given for a turn, else shifted with its first point. */
  const finalMovedWire = (wireIndex: number): Point[] => {
    const placed = options.movedWirePoints?.get(wireIndex)
    if (placed) return placed
    const wire = geometry.wires[wireIndex]
    const at = movedAt.get(key(wire[0]))
    const delta = at ? { x: at.to.x - at.from.x, y: at.to.y - at.from.y } : { x: 0, y: 0 }
    return wire.map((point) => shift(point, delta))
  }

  // A wire end T'd onto a moved wire's interior rides the wire: it becomes a
  // moved point, landing the same way along the segment as it sat.
  for (const wireIndex of options.teesRide === false ? [] : movedWires) {
    const before = geometry.wires[wireIndex]
    if (!before || before.length < 2) continue
    const after = finalMovedWire(wireIndex)
    geometry.wires.forEach((other, otherIndex) => {
      if (!isStatic(otherIndex)) return
      for (const end of [other[0], other[other.length - 1]]) {
        if (movedAt.has(key(end))) continue
        for (let i = 1; i < before.length && i < after.length; i++) {
          const a = before[i - 1]
          const b = before[i]
          if (!insideSegment(end, a, b)) continue
          const t = a.x === b.x ? (end.y - a.y) / (b.y - a.y) : (end.x - a.x) / (b.x - a.x)
          const a2 = after[i - 1]
          const b2 = after[i]
          note({
            from: end,
            to: { x: nm(a2.x + (b2.x - a2.x) * t), y: nm(a2.y + (b2.y - a2.y) * t) }
          })
          break
        }
      }
    })
  }

  // A pin or label sitting mid-wire has the wire split under it, so both
  // halves follow it. The far half is a wire of its own past the sheet's
  // count; whatever it becomes is added rather than edited.
  const wires = geometry.wires.map((wire) => [...wire])
  const extra: Point[][] = []
  const endsAt = new Set<string>()
  wires.forEach((wire, wireIndex) => {
    if (!isStatic(wireIndex)) return
    endsAt.add(key(wire[0]))
    endsAt.add(key(wire[wire.length - 1]))
  })
  for (const point of movedAt.values()) {
    if (!(point.direction || point.draws) || endsAt.has(key(point.from))) continue
    for (let hostIndex = 0; hostIndex < wires.length; hostIndex++) {
      if (!isStatic(hostIndex)) continue
      const host = wires[hostIndex]
      const split = host.findIndex(
        (vertex, i) => i > 0 && insideSegment(point.from, host[i - 1], vertex)
      )
      if (split < 0) continue
      extra.push([point.from, ...host.slice(split)])
      wires[hostIndex] = [...host.slice(0, split), point.from]
      endsAt.add(key(point.from))
      break
    }
  }
  const sheet: ReshapeGeometry = { ...geometry, wires: [...wires, ...extra] }
  const extraFrom = geometry.wires.length
  const index = new SheetIndex(sheet, [...movedAt.values()], movedWires)

  // 1. Every run out of a moved point.
  const runs: Run[] = []
  const visited = new Set<number>()
  for (const point of index.movedAt.values()) {
    const ends = index.endsAt.get(key(point.from)) ?? []
    for (const end of ends) {
      if (visited.has(end.index)) continue
      const run = walkRun(index, point, end.index, end.end, visited)
      runs.push(run)
      // The part of a split wire past the hinge is its own run when it ends
      // on another moved point, or that end would be left behind.
      const remainder = run.truncated?.points
      const tail = remainder ? index.movedAt.get(key(remainder[remainder.length - 1])) : null
      if (remainder && tail && run.truncated) {
        runs.push({
          from: tail,
          points: mergeCollinearPoints([...remainder].reverse()),
          wireIndices: [run.truncated.index],
          far: { kind: 'hinged', point: remainder[0] }
        })
        delete run.truncated
      }
    }
    // A pin or a label sitting directly on a pin gets a wire drawn between
    // them as it leaves; any wire that also met there follows on its own.
    const pinUnder = index.pinsAt.get(key(point.from))
    if ((point.direction || point.draws) && pinUnder !== undefined) {
      runs.push({
        from: point,
        points: [point.from, point.from],
        wireIndices: [],
        far: { kind: 'pin', point: point.from, direction: pinUnder }
      })
    }
  }

  // 2. Riser nesting: on each side, the pin leading the motion bends farthest out.
  const plans = runs.map((run) => planRun(run, grid))
  const riser = new Map<Run, number>()
  const groups = new Map<Direction, Run[]>()
  runs.forEach((run, at) => {
    if (!needsRiser(run, plans[at]) || !run.from.direction) return
    const list = groups.get(run.from.direction)
    if (list) list.push(run)
    else groups.set(run.from.direction, [run])
  })
  for (const [direction, group] of groups) {
    const vector = VECTOR[direction]
    const perpendicular: Vector = { x: -vector.y, y: vector.x }
    const lead = (run: Run): number => {
      const delta = { x: run.from.to.x - run.from.from.x, y: run.from.to.y - run.from.from.y }
      const across = delta.x * perpendicular.x + delta.y * perpendicular.y
      return (run.from.to.x * perpendicular.x + run.from.to.y * perpendicular.y) * Math.sign(across)
    }
    group.sort((a, b) => lead(a) - lead(b))
    group.forEach((run, at) => riser.set(run, at + 1))
  }

  // 3. New geometry per run.
  const reshaped = runs.map((run, at): Point[] | null => {
    const plan = plans[at]
    const points =
      plan.mode === 'rigid'
        ? run.points.map((point) => shift(point, plan.delta))
        : plan.mode === 'slide'
          ? plan.points
          : routePorts(
              { point: run.from.to, direction: plan.stub ? run.from.direction : undefined },
              farPort(run.far),
              axisOf(run.points[0], run.points[1]),
              riser.get(run) ?? 1,
              grid
            )
    const merged = mergeCollinearPoints(points)
    return merged.length >= 2 ? merged : null
  })

  // 4. A bend that lands along the wire it joins slides along it instead of
  //    drawing over it: the T moves, the wire does not double.
  const touchedWires = new Set<number>()
  for (const run of runs) {
    for (const wire of run.wireIndices) touchedWires.add(wire)
    if (run.truncated) touchedWires.add(run.truncated.index)
  }
  runs.forEach((run, at) => {
    const points = reshaped[at]
    if (!points || run.far.kind !== 'hinged' || points.length < 2) return
    // Every wire collinear with the last leg through its end is a candidate;
    // the one that takes the most off wins, and the leg is re-tried from its
    // new end in case another wire continues past the first.
    for (let pass = 0; pass < index.staticWires.length && points.length >= 2; pass++) {
      const c = points[points.length - 2]
      const f = points[points.length - 1]
      const axis = axisOf(c, f)
      if (!axis) break
      let stop: Point | null = null
      let stopDistance = Infinity
      const consider = (candidate: Point): void => {
        const distance = Math.hypot(candidate.x - c.x, candidate.y - c.y)
        if (distance < stopDistance) {
          stopDistance = distance
          stop = candidate
        }
      }
      for (const wireIndex of index.staticWires) {
        if (touchedWires.has(wireIndex)) continue
        const wire = sheet.wires[wireIndex]
        for (let segment = 1; segment < wire.length; segment++) {
          const a = wire[segment - 1]
          const b = wire[segment]
          const hostAxis = axisOf(a, b)
          if (!hostAxis || horizontal(hostAxis) !== horizontal(axis)) continue
          if (!onSegment(f, a, b)) continue
          if (horizontal(axis) ? a.y !== c.y : a.x !== c.x) continue
          if (onSegment(c, a, b)) consider(c)
          else if (insideSegment(a, c, f)) consider(a)
          else if (insideSegment(b, c, f)) consider(b)
        }
      }
      if (!stop) break
      if (pointsEqualNm(stop, c)) points.pop()
      else points[points.length - 1] = stop
    }
    reshaped[at] = points.length >= 2 ? mergeCollinearPoints(points) : null
  })

  // 4b. A pin the label left is not wired again while a wire still passes
  //     through it — the wire that followed the label along its own axis, or
  //     one that never moved. The new run is for the pin that would otherwise
  //     be left bare.
  const passesThrough = (points: readonly Point[], point: Point): boolean =>
    points.some((b, i) => i > 0 && onSegment(point, points[i - 1], b))
  runs.forEach((run, at) => {
    if (run.far.kind !== 'pin' || run.wireIndices.length) return
    const pinPoint = run.far.point
    const stillWired =
      runs.some((other, i) => {
        // Another bare pin run is not a wire; a run that carries wires is.
        const points = reshaped[i]
        return (
          i !== at && other.wireIndices.length > 0 && !!points && passesThrough(points, pinPoint)
        )
      }) ||
      index.staticWires.some(
        (wireIndex) =>
          !touchedWires.has(wireIndex) && passesThrough(sheet.wires[wireIndex], pinPoint)
      )
    if (stillWired) reshaped[at] = null
  })

  // 5. Edits: reuse the run's wires for its first segments, add the rest,
  //    drop the surplus. A segment some other run or an untouched wire already
  //    draws is not drawn twice — two halves of a split wire rising to one pin
  //    share the riser, and meet it at a junction.
  const edits: WireGeometryEdit[] = []
  const added: Point[][] = []
  const overflow: Point[][] = []
  const finalOf = new Map<number, Point[]>()
  const segmentKey = (a: Point, b: Point): string => {
    const ka = key(a)
    const kb = key(b)
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
  }
  const drawn = new Set<string>()
  sheet.wires.forEach((wire, wireIndex) => {
    if (touchedWires.has(wireIndex) || movedWires.has(wireIndex)) return
    for (let i = 1; i < wire.length; i++) drawn.add(segmentKey(wire[i - 1], wire[i]))
  })
  const place = (wireIndex: number, points: Point[]): void => {
    finalOf.set(wireIndex, points)
    if (wireIndex >= extraFrom) {
      if (points.length >= 2) added.push(points)
    } else {
      edits.push({ index: wireIndex, points })
    }
  }
  runs.forEach((run, at) => {
    const points = reshaped[at]
    const segments: Point[][] = []
    if (points) {
      for (let i = 1; i < points.length; i++) {
        const mark = segmentKey(points[i - 1], points[i])
        if (drawn.has(mark)) continue
        drawn.add(mark)
        segments.push([points[i - 1], points[i]])
      }
    }
    run.wireIndices.forEach((wireIndex, i) => place(wireIndex, segments[i] ?? []))
    for (let i = run.wireIndices.length; i < segments.length; i++) {
      added.push(segments[i])
      overflow.push(segments[i])
    }
    if (run.truncated) place(run.truncated.index, run.truncated.points)
  })

  // 6. Junctions, only where the move touched: a dot where three things now
  //    meet or a wire end lands mid-wire, and none where that stopped being so.
  const finalWires: Point[][] = []
  sheet.wires.forEach((wire, wireIndex) => {
    if (movedWires.has(wireIndex)) {
      finalWires.push(finalMovedWire(wireIndex))
      return
    }
    const edited = finalOf.get(wireIndex)
    if (edited === undefined) finalWires.push(wire)
    else if (edited.length >= 2) finalWires.push(edited)
  })
  finalWires.push(...overflow)
  const finalPins = new Set(
    geometry.pins.filter((pin) => !pin.label).map((pin) => key(pin.position))
  )
  for (const point of index.movedAt.values()) if (point.direction) finalPins.add(key(point.to))
  const endCount = new Map<string, number>()
  for (const wire of finalWires) {
    for (const end of [wire[0], wire[wire.length - 1]]) {
      endCount.set(key(end), (endCount.get(key(end)) ?? 0) + 1)
    }
  }
  const junctionNeeded = (point: Point): boolean => {
    const meeting = (endCount.get(key(point)) ?? 0) + (finalPins.has(key(point)) ? 1 : 0)
    if (meeting >= 3) return true
    return meeting >= 1 && finalWires.some((wire) => insideRun(point, wire))
  }
  const touched = new Map<string, Point>()
  runs.forEach((run, at) => {
    for (const point of [...run.points, ...(reshaped[at] ?? [])]) touched.set(key(point), point)
    if (run.truncated) touched.set(key(run.truncated.points[0]), run.truncated.points[0])
  })
  for (const point of index.movedAt.values()) touched.set(key(point.to), point.to)
  const junctionsAdded: Point[] = []
  const junctionsRemoved: Point[] = []
  for (const [at, point] of touched) {
    const has = index.junctionsAt.has(at)
    const needed = junctionNeeded(point)
    if (needed && !has) junctionsAdded.push(point)
    if (!needed && has) junctionsRemoved.push(point)
  }

  // 7. Anchors: a dangling end takes its label along; a label mid-segment
  //    stays on the wire it was on.
  const anchorsMoved: ReshapeResult['anchorsMoved'] = []
  runs.forEach((run, at) => {
    const points = reshaped[at]
    if (!points) return
    const last = points[points.length - 1]
    if (run.far.kind === 'free' && !pointsEqualNm(last, run.far.point)) {
      if (index.anchorsAt.has(key(run.far.point))) {
        anchorsMoved.push({ from: run.far.point, to: last })
      }
    }
    for (const anchor of geometry.anchors) {
      if (!insideRun(anchor, run.points)) continue
      const landing = nearestOnRun(anchor, points)
      if (!pointsEqualNm(landing, anchor)) anchorsMoved.push({ from: anchor, to: landing })
    }
  })

  return { edits, added, junctionsAdded, junctionsRemoved, anchorsMoved }
}
