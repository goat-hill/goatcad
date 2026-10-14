/**
 * A move of schematic items with its wires following: the plan the drag
 * preview draws, the commit writes, and `items.update` applies. One function
 * computes it from the final position, so the three agree
 * (`docs/schematic-editor-workstream.md` §6).
 */
import { nm, type Nm } from '../kicad/coordinates'
import {
  addSchematicBusToAST,
  addSchematicJunctionToAST,
  addSchematicWireToAST,
  moveSchematicFieldInAST,
  moveSchematicLabelInAST,
  moveSchematicPointItemInAST,
  moveSchematicSheetInAST,
  moveSchematicSymbolInAST,
  moveSchematicWireInAST,
  removeSchematicNodesFromAST,
  resolveSymbolGeometry,
  setSchematicFieldsAutoplaced,
  setSchematicSymbolPoseInAST,
  fieldPointThroughPose,
  SHEET_PIN_ANGLE,
  setSchematicLabelPlacement,
  setSchematicPropertyJustify,
  setSchematicPropertyPlacement,
  setSchematicWirePointsInAST,
  setSheetPinPlacement,
  sheetPinLanding,
  type KicadSchematic,
  type KicadSchematicPoint,
  type KicadSchematicSymbol,
  type KicadWire,
  type Point,
  type SchematicItemType,
  type SheetSide
} from '../kicad/schematic'
import {
  isSheetItemType,
  placedSheetItem,
  sheetItemAt,
  sheetItemPoints,
  translation,
  withSheetItems,
  writeSheetItem,
  type Placement,
  type SheetItem,
  type SheetItemType
} from './sheetItemPlacement'
import { autoplaceFields, autoplaceFieldsInAST } from './schematicItems'
import { parseBusName } from './busNames'
import {
  transformAngle,
  transformPivot,
  transformPoint,
  transformedSymbol,
  type TransformOp
} from './schematicTransform'
import type { SExprNode } from '../kicad/sexpr'
import { makeList } from '../kicad/footprint'
import { placedPinPosition, type SchematicConnectivity } from './connectivity'
import { labelAngleForPin } from './schematicAgent'
import {
  directionOf,
  labelPortDirection,
  reshapeWires,
  type MovedPoint,
  type ReshapeGeometry,
  type ReshapeResult
} from './wireReshape'

/** A selection item as the editor holds it: a kind, an index, and for a part
 *  (a field, a sheet pin) which one of its owner's. */
export interface MoveItem {
  type: SchematicItemType
  index: number
  field?: string
  pin?: number
}

/** Which document items a move carries, by index per kind. */
export interface MoveSelection {
  symbols: Set<number>
  sheets: Set<number>
  wires: Set<number>
  junctions: Set<number>
  noConnects: Set<number>
  labels: Set<number>
  /** Sheet pins moving on their own, keyed `sheet/pin`; a moving sheet's are not listed. */
  sheetPins: Set<string>
  /** The annotation and bus items, which connect nothing a wire follows. */
  others: Array<{ type: SheetItemType; index: number }>
}

export const emptySelection = (): MoveSelection => ({
  symbols: new Set(),
  sheets: new Set(),
  wires: new Set(),
  junctions: new Set(),
  noConnects: new Set(),
  labels: new Set(),
  sheetPins: new Set(),
  others: []
})

const sheetPinKey = (sheet: number, pin: number): string => `${sheet}/${pin}`

/** A selection as the editor holds it, grouped. Fields move with nothing. */
export function selectionOf(items: MoveItem[]): MoveSelection {
  const selection = emptySelection()
  for (const item of items) {
    if (item.type === 'symbol') selection.symbols.add(item.index)
    else if (item.type === 'sheet') selection.sheets.add(item.index)
    else if (item.type === 'wire') selection.wires.add(item.index)
    else if (item.type === 'junction') selection.junctions.add(item.index)
    else if (item.type === 'no_connect') selection.noConnects.add(item.index)
    else if (item.type === 'label') selection.labels.add(item.index)
    else if (isSheetItemType(item.type))
      selection.others.push({ type: item.type, index: item.index })
  }
  for (const item of items) {
    if (item.type === 'sheet_pin' && item.pin !== undefined && !selection.sheets.has(item.index))
      selection.sheetPins.add(sheetPinKey(item.index, item.pin))
  }
  return selection
}

/** Each sheet pin moving on its own, and where a drag by `delta` lands it. */
const sheetPinMoves = (
  doc: KicadSchematic,
  selection: MoveSelection,
  delta: Point
): Array<{
  sheet: number
  pin: number
  from: Point & { angle: number }
  to: Point
  side: SheetSide
}> =>
  // A turn in place carries no shift, and pins do not turn: nothing to land.
  delta.x === 0 && delta.y === 0
    ? []
    : [...selection.sheetPins].flatMap((key) => {
        const [sheetIndex, pinIndex] = key.split('/').map(Number)
        const sheet = doc.sheets[sheetIndex]
        const pin = sheet?.pins[pinIndex]
        if (!sheet || !pin) return []
        const landing = sheetPinLanding(sheet, pin, delta)
        return [
          {
            sheet: sheetIndex,
            pin: pinIndex,
            from: pin.position,
            to: landing.position,
            side: landing.side
          }
        ]
      })

export interface MovePlan {
  moved: MovedPoint[]
  selection: MoveSelection
  reshape: ReshapeResult
  /** The same for buses, on their own layer: the buses joined to a moved bus or entry follow it. */
  busReshape?: ReshapeResult
  /** Unselected labels that ride along: on a moved pin (re-aimed when the
   *  pin turned), on a dangling end that travelled, or mid-segment on a wire
   *  that slid. */
  labelMoves: { index: number; to: Point; angle?: number }[]
  noConnectMoves: { index: number; to: Point }[]
}

const pointKey = (point: Point): string => `${point.x},${point.y}`

const emptyReshape = (): ReshapeResult => ({
  edits: [],
  added: [],
  junctionsAdded: [],
  junctionsRemoved: [],
  anchorsMoved: []
})

/** Where every connection point of the selection lands after a translation. */
export function movedPointsForTranslation(
  doc: KicadSchematic,
  selection: MoveSelection,
  delta: Point
): MovedPoint[] {
  const moved: MovedPoint[] = []
  const shift = (point: Point): Point => ({ x: nm(point.x + delta.x), y: nm(point.y + delta.y) })
  for (const index of selection.symbols) {
    const symbol = doc.symbols[index]
    if (!symbol) continue
    for (const { pin } of resolveSymbolGeometry(doc, symbol).pins) {
      const from = placedPinPosition(symbol, pin)
      moved.push({
        from,
        to: shift(from),
        direction: directionOf(labelAngleForPin(symbol, pin.position.angle))
      })
    }
  }
  for (const index of selection.sheets) {
    for (const pin of doc.sheets[index]?.pins ?? []) {
      moved.push({
        from: pin.position,
        to: shift(pin.position),
        direction: directionOf(pin.position.angle)
      })
    }
  }
  moved.push(...sheetPinMovedPoints(doc, selection, delta))
  for (const index of selection.wires) {
    const wire = doc.wires[index]
    if (!wire || wire.points.length < 2) continue
    for (const end of [wire.points[0], wire.points[wire.points.length - 1]]) {
      moved.push({ from: end, to: shift(end) })
    }
  }
  for (const index of selection.junctions) {
    const junction = doc.junctions[index]
    if (junction) moved.push({ from: junction, to: shift(junction) })
  }
  moved.push(...busMovedPoints(doc, selection, shift))
  for (const index of selection.noConnects) {
    const flag = doc.noConnects[index]
    if (flag) moved.push({ from: flag, to: shift(flag) })
  }
  for (const index of selection.labels) {
    const label = doc.labels[index]
    if (!label) continue
    // A global or hierarchical label is a port like a pin: its wire keeps
    // leaving the anchor away from the body. A local label bends freely.
    const direction = label.type === 'label' ? undefined : labelPortDirection(label.position.angle)
    moved.push({ from: label.position, to: shift(label.position), draws: true, direction })
  }
  return moved
}

const busEnds = (points: Point[]): Point[] =>
  points.length >= 2 ? [points[0], points[points.length - 1]] : []

/**
 * A selected bus's ends are what the buses joined to it follow, as a wire's
 * are; a selected bus entry's ends, what the wire and bus it joins follow.
 * `place` is where a point lands — a shift, or a turn and a shift.
 */
const busMovedPoints = (
  doc: KicadSchematic,
  selection: MoveSelection,
  place: (point: Point) => Point
): MovedPoint[] =>
  selection.others.flatMap(({ type, index }) =>
    (type === 'bus'
      ? busEnds(doc.buses[index]?.points ?? [])
      : type === 'bus_entry'
        ? busEntryEnds(doc.busEntries[index])
        : []
    ).map((end) => ({ from: end, to: place(end) }))
  )

/** Where each selected bus lands, for the bus reshape of a turn (`PlanOptions.movedBuses`). */
const placedBuses = (
  doc: KicadSchematic,
  selection: MoveSelection,
  place: (point: Point) => Point
): Map<number, Point[]> =>
  new Map(
    selection.others
      .filter((item) => item.type === 'bus' && doc.buses[item.index])
      .map((item) => [item.index, doc.buses[item.index].points.map(place)])
  )

const busEntryEnds = (entry: KicadSchematic['busEntries'][number] | undefined): Point[] =>
  entry
    ? [
        entry.position,
        { x: nm(entry.position.x + entry.size.width), y: nm(entry.position.y + entry.size.height) }
      ]
    : []

/** A sheet pin sliding along its sheet is a connection point its wire follows. */
const sheetPinMovedPoints = (
  doc: KicadSchematic,
  selection: MoveSelection,
  delta: Point
): MovedPoint[] =>
  sheetPinMoves(doc, selection, delta).map((move) => ({
    from: move.from,
    to: move.to,
    direction: directionOf(SHEET_PIN_ANGLE[move.side]),
    directionBefore: directionOf(move.from.angle)
  }))

export interface PlanOptions {
  grid: Nm
  /** Reshape the wires off the moved points (false: a bare move, wires stay). */
  wires: boolean
  /** Carry unselected labels and no-connects sitting on moved points. Off when
   *  the caller places them itself, as `items.update` does with their angle. */
  carryAttached: boolean
  /** Where each selected wire ends up when the move is a turn, not a shift. */
  movedWires?: ReadonlyMap<number, Point[]>
  /** The same for each selected bus. */
  movedBuses?: ReadonlyMap<number, Point[]>
  /** See `ReshapeOptions.teesRide`. */
  teesRide?: boolean
}

/**
 * The plan for a set of moved connection points. `moved` says where each
 * lands; `selection` says which items are moving so they are neither reshaped
 * nor carried twice.
 */
export function planMovedPoints(
  doc: KicadSchematic,
  moved: MovedPoint[],
  selection: MoveSelection,
  options: PlanOptions
): MovePlan {
  const geometry: ReshapeGeometry = {
    wires: doc.wires.map((wire) => wire.points),
    junctions: doc.junctions.filter((_, index) => !selection.junctions.has(index)),
    pins: [],
    anchors: []
  }
  doc.symbols.forEach((symbol, index) => {
    if (selection.symbols.has(index)) return
    for (const { pin } of resolveSymbolGeometry(doc, symbol).pins) {
      geometry.pins.push({
        position: placedPinPosition(symbol, pin),
        direction: directionOf(labelAngleForPin(symbol, pin.position.angle))
      })
    }
  })
  doc.sheets.forEach((sheet, index) => {
    if (selection.sheets.has(index)) return
    sheet.pins.forEach((pin, pinIndex) => {
      if (selection.sheetPins.has(sheetPinKey(index, pinIndex))) return
      geometry.pins.push({ position: pin.position, direction: directionOf(pin.position.angle) })
    })
  })
  const movedFrom = new Set(moved.map((point) => pointKey(point.from)))
  doc.labels.forEach((label, index) => {
    if (selection.labels.has(index)) return
    // A label riding a moved pin is carried, not routed to.
    if (label.type !== 'label' && !movedFrom.has(pointKey(label.position))) {
      geometry.pins.push({
        position: label.position,
        direction: labelPortDirection(label.position.angle),
        label: true
      })
    } else {
      geometry.anchors.push(label.position)
    }
  })
  doc.noConnects.forEach((flag, index) => {
    if (!selection.noConnects.has(index)) geometry.anchors.push(flag)
  })

  const reshape = options.wires
    ? reshapeWires(geometry, moved, {
        grid: options.grid,
        movedWires: selection.wires,
        movedWirePoints: options.movedWires,
        teesRide: options.teesRide
      })
    : emptyReshape()

  // Buses on their own layer: what fixes a bus's exit is a sheet pin, and
  // what rides one is a label naming a bus.
  const movingBuses = new Set(
    selection.others.filter((item) => item.type === 'bus').map((item) => item.index)
  )
  const busGeometry: ReshapeGeometry = {
    wires: doc.buses.map((bus) => bus.points),
    junctions: geometry.junctions,
    pins: geometry.pins.filter((pin) => !pin.label && sheetPinAt(doc, pin.position)),
    anchors: doc.labels
      .filter(
        (label, index) =>
          !selection.labels.has(index) &&
          label.type === 'label' &&
          parseBusName(label.text) !== null
      )
      .map((label) => label.position)
  }
  const busReshape =
    options.wires && doc.buses.length > 0
      ? reshapeWires(busGeometry, moved, {
          grid: options.grid,
          movedWires: movingBuses,
          movedWirePoints: options.movedBuses,
          teesRide: options.teesRide
        })
      : emptyReshape()

  // Anchors that travel: on a moved point when carrying, and wherever the
  // reshape says a wire took one along.
  const landing = new Map<string, { to: Point; angle?: number }>()
  if (options.carryAttached) {
    for (const point of moved) {
      landing.set(pointKey(point.from), { to: point.to, angle: point.labelAngle })
    }
  }
  for (const anchor of [...reshape.anchorsMoved, ...busReshape.anchorsMoved])
    landing.set(pointKey(anchor.from), { to: anchor.to })
  const labelMoves: MovePlan['labelMoves'] = []
  doc.labels.forEach((label, index) => {
    if (selection.labels.has(index)) return
    const land = landing.get(pointKey(label.position))
    if (land)
      labelMoves.push({
        index,
        to: land.to,
        ...(land.angle !== undefined ? { angle: land.angle } : {})
      })
  })
  const noConnectMoves: MovePlan['noConnectMoves'] = []
  doc.noConnects.forEach((flag, index) => {
    if (selection.noConnects.has(index)) return
    const land = landing.get(pointKey(flag))
    if (land) noConnectMoves.push({ index, to: land.to })
  })
  return { moved, selection, reshape, busReshape, labelMoves, noConnectMoves }
}

const sheetPinAt = (doc: KicadSchematic, point: Point): boolean =>
  doc.sheets.some((sheet) =>
    sheet.pins.some((pin) => pin.position.x === point.x && pin.position.y === point.y)
  )

/** The plan for dragging a selection by `delta`. */
export function planMove(
  doc: KicadSchematic,
  items: MoveItem[],
  delta: Point,
  options: { grid: Nm; wires: boolean }
): MovePlan {
  const selection = selectionOf(items)
  const moved = movedPointsForTranslation(doc, selection, delta)
  return planMovedPoints(doc, moved, selection, { ...options, carryAttached: true })
}

/**
 * Write a plan's wire, junction and anchor changes into the document. The
 * caller has already moved the selected items themselves, so a junction that
 * travelled with the selection is found where it now sits and not added twice.
 */
export function applyMovePlan(doc: KicadSchematic, plan: MovePlan): void {
  const { reshape } = plan
  const buses = plan.busReshape ?? emptyReshape()
  const doomed: SExprNode[] = []
  for (const [edits, lines] of [
    [reshape.edits, doc.wires],
    [buses.edits, doc.buses]
  ] as const) {
    for (const edit of edits) {
      const wire = lines[edit.index]
      if (!wire) continue
      if (edit.points.length >= 2) setSchematicWirePointsInAST(wire, edit.points)
      else doomed.push(wire._node)
    }
  }
  for (const point of [...reshape.junctionsRemoved, ...buses.junctionsRemoved]) {
    doc.junctions.forEach((junction, index) => {
      if (plan.selection.junctions.has(index)) return
      if (junction.x === point.x && junction.y === point.y) doomed.push(junction._node)
    })
  }
  removeSchematicNodesFromAST(doc, doomed)
  for (const points of reshape.added) addSchematicWireToAST(doc, points)
  for (const points of buses.added) addSchematicBusToAST(doc, points)
  const present = new Set(
    doc.junctions
      .filter((junction) => !doomed.includes(junction._node))
      .map((junction) => pointKey(junction))
  )
  for (const point of [...reshape.junctionsAdded, ...buses.junctionsAdded]) {
    if (present.has(pointKey(point))) continue
    present.add(pointKey(point))
    addSchematicJunctionToAST(doc, point)
  }
  for (const move of plan.labelMoves) {
    const label = doc.labels[move.index]
    if (!label) continue
    if (move.angle !== undefined) {
      setSchematicLabelPlacement(label, { ...move.to, angle: move.angle })
    } else {
      moveSchematicLabelInAST(label, {
        x: nm(move.to.x - label.position.x),
        y: nm(move.to.y - label.position.y)
      })
    }
  }
  for (const move of plan.noConnectMoves) {
    const flag = doc.noConnects[move.index]
    if (!flag) continue
    moveSchematicPointItemInAST(flag, { x: nm(move.to.x - flag.x), y: nm(move.to.y - flag.y) })
  }
}

/**
 * The sheet as it would read after a translation and its plan: enough of a
 * document for connectivity to run on, so a drag can say what it is about to
 * join or break before it lands. Nodes are placeholders; nothing here is
 * written.
 */
export function previewMovedSchematic(
  doc: KicadSchematic,
  plan: MovePlan,
  delta: Point
): KicadSchematic {
  const { selection } = plan
  const shift = (point: Point): Point => ({ x: nm(point.x + delta.x), y: nm(point.y + delta.y) })
  const placeholder = makeList([], 0)
  const editedAt = new Map(plan.reshape.edits.map((edit) => [edit.index, edit.points]))
  const wires: KicadWire[] = []
  doc.wires.forEach((wire, index) => {
    const edited = editedAt.get(index)
    if (selection.wires.has(index)) {
      // A wire dragged by one vertex is carried as an edit, not a shift.
      wires.push({ ...wire, points: edited ?? wire.points.map(shift) })
      return
    }
    if (edited === undefined) wires.push(wire)
    else if (edited.length >= 2) wires.push({ ...wire, points: edited })
  })
  for (const points of plan.reshape.added) {
    wires.push({ points, width: nm(0), _node: placeholder })
  }
  const busPlan = plan.busReshape ?? emptyReshape()
  const busEditedAt = new Map(busPlan.edits.map((edit) => [edit.index, edit.points]))
  const movingBuses = new Set(
    selection.others.filter((item) => item.type === 'bus').map((item) => item.index)
  )
  const buses: KicadWire[] = []
  doc.buses.forEach((bus, index) => {
    const edited = busEditedAt.get(index)
    if (movingBuses.has(index)) buses.push({ ...bus, points: bus.points.map(shift) })
    else if (edited === undefined) buses.push(bus)
    else if (edited.length >= 2) buses.push({ ...bus, points: edited })
  })
  for (const points of busPlan.added) buses.push({ points, width: nm(0), _node: placeholder })
  const removed = new Set(
    [...plan.reshape.junctionsRemoved, ...busPlan.junctionsRemoved].map(pointKey)
  )
  const junctions: KicadSchematicPoint[] = []
  doc.junctions.forEach((junction, index) => {
    if (selection.junctions.has(index)) junctions.push({ ...junction, ...shift(junction) })
    else if (!removed.has(pointKey(junction))) junctions.push(junction)
  })
  for (const point of [...plan.reshape.junctionsAdded, ...busPlan.junctionsAdded])
    junctions.push({ ...point, _node: placeholder })
  const labelTo = new Map(plan.labelMoves.map((move) => [move.index, move.to]))
  const labels = doc.labels.map((label, index) => {
    const to = selection.labels.has(index) ? shift(label.position) : labelTo.get(index)
    return to ? { ...label, position: { ...label.position, ...to } } : label
  })
  const flagTo = new Map(plan.noConnectMoves.map((move) => [move.index, move.to]))
  const noConnects = doc.noConnects.map((flag, index) => {
    const to = selection.noConnects.has(index) ? shift(flag) : flagTo.get(index)
    return to ? { ...flag, ...to } : flag
  })
  const symbols = doc.symbols.map((symbol, index) =>
    selection.symbols.has(index)
      ? { ...symbol, position: { ...symbol.position, ...shift(symbol.position) } }
      : symbol
  )
  const pinTo = new Map(
    sheetPinMoves(doc, selection, delta).map((move) => [sheetPinKey(move.sheet, move.pin), move])
  )
  const sheets = doc.sheets.map((sheet, index) =>
    selection.sheets.has(index)
      ? {
          ...sheet,
          position: shift(sheet.position),
          pins: sheet.pins.map((pin) => ({
            ...pin,
            position: { ...pin.position, ...shift(pin.position) }
          }))
        }
      : pinTo.size
        ? {
            ...sheet,
            pins: sheet.pins.map((pin, pinIndex) => {
              const move = pinTo.get(sheetPinKey(index, pinIndex))
              return move
                ? { ...pin, position: { ...move.to, angle: SHEET_PIN_ANGLE[move.side] } }
                : pin
            })
          }
        : sheet
  )
  return { ...doc, wires, buses, junctions, labels, noConnects, symbols, sheets }
}

// ---------------------------------------------------------------------------
// Dragging one vertex of a wire or bus
// ---------------------------------------------------------------------------

/** A wire's or bus's point, as its grab handle names it. */
export interface VertexTarget {
  type: 'wire' | 'bus'
  index: number
  vertex: number
}

const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y

const insideOf = (point: Point, run: Point[]): boolean =>
  run.some((b, i) => {
    if (i === 0) return false
    const a = run[i - 1]
    if (samePoint(point, a) || samePoint(point, b)) return false
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
    return (
      cross === 0 &&
      point.x >= Math.min(a.x, b.x) &&
      point.x <= Math.max(a.x, b.x) &&
      point.y >= Math.min(a.y, b.y) &&
      point.y <= Math.max(a.y, b.y)
    )
  })

/**
 * Whether a wire end at `point` is held there by something that does not move
 * with it: a pin (a symbol's or a sheet's), or another wire it tees onto.
 * Dragging such an end pulls it off; what else meets there stays.
 */
const heldAt = (doc: KicadSchematic, point: Point, except: number): boolean => {
  for (const symbol of doc.symbols) {
    for (const { pin } of resolveSymbolGeometry(doc, symbol).pins) {
      if (samePoint(placedPinPosition(symbol, pin), point)) return true
    }
  }
  if (doc.sheets.some((sheet) => sheet.pins.some((pin) => samePoint(pin.position, point))))
    return true
  return doc.wires.some((wire, index) => index !== except && insideOf(point, wire.points))
}

/**
 * The plan for dragging one point of a wire by `delta` — KiCad's point editor
 * on a wire, with its drag's connections kept. Only that point moves: the rest
 * of the wire stays, so the segment may go diagonal where the user pulls it.
 * An END drags what meets it there — the other wire ends, reshaped orthogonally
 * as a moved junction's are, a dot, a label or flag — unless the end sits on a
 * pin or tees onto another wire, which hold everything else in place; with
 * `wires` off (Shift) the end leaves alone. A wire teed onto the dragged wire
 * stays where it is. Returns null for a point the wire does not have.
 */
export function planVertexDrag(
  doc: KicadSchematic,
  target: VertexTarget,
  delta: Point,
  options: { grid: Nm; wires: boolean }
): MovePlan | null {
  if (target.type !== 'wire') return null
  const wire = doc.wires[target.index]
  const from = wire?.points[target.vertex]
  if (!wire || !from) return null
  const to: Point = { x: nm(from.x + delta.x), y: nm(from.y + delta.y) }
  const points = wire.points.map((point, index) => (index === target.vertex ? to : point))
  const selection = emptySelection()
  selection.wires.add(target.index)
  const end = target.vertex === 0 || target.vertex === wire.points.length - 1
  const follows = end && options.wires && !heldAt(doc, from, target.index)
  if (!follows) {
    return {
      moved: [],
      selection,
      reshape: { ...emptyReshape(), edits: [{ index: target.index, points }] },
      labelMoves: [],
      noConnectMoves: []
    }
  }
  doc.junctions.forEach((junction, index) => {
    if (samePoint(junction, from)) selection.junctions.add(index)
  })
  const plan = planMovedPoints(doc, [{ from, to }], selection, {
    grid: options.grid,
    wires: true,
    carryAttached: true,
    movedWires: new Map([[target.index, points]]),
    teesRide: false
  })
  plan.reshape.edits.push({ index: target.index, points })
  return plan
}

/** Write a vertex drag: the plan's wires and riders, and the dot that went along. */
export function applyVertexDrag(doc: KicadSchematic, plan: MovePlan, delta: Point): void {
  for (const index of plan.selection.junctions) {
    const junction = doc.junctions[index]
    if (junction) moveSchematicPointItemInAST(junction, delta)
  }
  applyMovePlan(doc, plan)
}

/**
 * The same for a bus, which connects nothing a wire follows: the point moves,
 * and with `follow` every other bus ending there moves its end along — a bus
 * held by nothing else, since a bus entry or a bus label rides on its line.
 */
export function planBusVertexDrag(
  doc: KicadSchematic,
  target: VertexTarget,
  delta: Point,
  follow: boolean
): Array<{ index: number; points: Point[] }> {
  if (target.type !== 'bus') return []
  const bus = doc.buses[target.index]
  const from = bus?.points[target.vertex]
  if (!bus || !from) return []
  const to: Point = { x: nm(from.x + delta.x), y: nm(from.y + delta.y) }
  const moveEnd = (points: Point[]): Point[] =>
    points.map((point, index) =>
      (index === 0 || index === points.length - 1) && samePoint(point, from) ? to : point
    )
  const edits = [
    {
      index: target.index,
      points: bus.points.map((point, index) => (index === target.vertex ? to : point))
    }
  ]
  const end = target.vertex === 0 || target.vertex === bus.points.length - 1
  if (!end || !follow) return edits
  doc.buses.forEach((other, index) => {
    if (index === target.index || other.points.length < 2) return
    const moved = moveEnd(other.points)
    if (moved.some((point, i) => point !== other.points[i])) edits.push({ index, points: moved })
  })
  return edits
}

// ---------------------------------------------------------------------------
// Turning and mirroring a selection
// ---------------------------------------------------------------------------

export interface TransformPlan {
  pivot: Point
  /** Whether anything turned or flipped (fields are autoplaced then). */
  turned: boolean
  symbols: { index: number; to: KicadSchematicSymbol }[]
  wires: { index: number; points: Point[] }[]
  labels: { index: number; position: Point; angle: number }[]
  junctions: { index: number; to: Point }[]
  noConnects: { index: number; to: Point }[]
  /** Annotation and bus items where they land, as new copies (`placedSheetItem`). */
  others: Array<{ index: number; from: SheetItem; to: SheetItem }>
  /** Sheet pins sliding along their sheets. Pins do not turn; they follow the shift. */
  sheetPins: Array<{ sheet: number; pin: number; to: Point; side: SheetSide }>
  /** The wires off the selection following, and riders carried. */
  move: MovePlan
}

/** One turn or flip about a pivot in the selection's original coordinates. */
export interface PlacementStep {
  op: TransformOp
  pivot: Point
}

/**
 * The plan for placing a selection after a sequence of turns and flips and
 * a shift: every selected item's new place, and the same move plan a drag
 * makes from where each connection point lands. A turn pressed mid-drag
 * about the cursor is a step whose pivot is the cursor mapped back by the
 * shift at that moment, so the steps compose on the original geometry and
 * the shift is applied last. Sheets and fields are left out — a sheet does
 * not turn, and a field goes where its symbol's autoplace puts it.
 */
export function planPlacement(
  doc: KicadSchematic,
  items: MoveItem[],
  steps: PlacementStep[],
  delta: Point,
  options: { grid: Nm; wires: boolean; carryAttached?: boolean }
): TransformPlan | null {
  const selection = selectionOf(items)
  selection.sheets.clear()
  const shift = (point: Point): Point => ({ x: nm(point.x + delta.x), y: nm(point.y + delta.y) })
  const place = (point: Point): Point =>
    shift(steps.reduce((at, step) => transformPoint(at, step.pivot, step.op), point))
  const turn = (angle: number): number =>
    steps.reduce((at, step) => transformAngle(at, step.op), angle)
  const placeSymbol = (symbol: KicadSchematicSymbol): KicadSchematicSymbol => {
    const turned = steps.reduce((at, step) => transformedSymbol(at, step.pivot, step.op), symbol)
    const origin = shift(turned.position)
    return { ...turned, position: { ...turned.position, ...origin } }
  }

  const moved: MovedPoint[] = []
  const symbols: TransformPlan['symbols'] = []
  for (const index of selection.symbols) {
    const symbol = doc.symbols[index]
    if (!symbol) continue
    const to = placeSymbol(symbol)
    symbols.push({ index, to })
    for (const { pin } of resolveSymbolGeometry(doc, symbol).pins) {
      const labelAngle = labelAngleForPin(to, pin.position.angle)
      moved.push({
        from: placedPinPosition(symbol, pin),
        to: placedPinPosition(to, pin),
        direction: directionOf(labelAngle),
        directionBefore: directionOf(labelAngleForPin(symbol, pin.position.angle)),
        labelAngle
      })
    }
  }
  const wires: TransformPlan['wires'] = []
  for (const index of selection.wires) {
    const wire = doc.wires[index]
    if (!wire || wire.points.length < 2) continue
    const points = wire.points.map(place)
    wires.push({ index, points })
    moved.push({ from: wire.points[0], to: points[0] })
    moved.push({
      from: wire.points[wire.points.length - 1],
      to: points[points.length - 1]
    })
  }
  const labels: TransformPlan['labels'] = []
  for (const index of selection.labels) {
    const label = doc.labels[index]
    if (!label) continue
    const position = place(label.position)
    const angle = turn(label.position.angle)
    labels.push({ index, position, angle })
    const port = label.type !== 'label'
    moved.push({
      from: label.position,
      to: position,
      draws: true,
      ...(port
        ? {
            direction: labelPortDirection(angle),
            directionBefore: labelPortDirection(label.position.angle)
          }
        : {})
    })
  }
  const junctions: TransformPlan['junctions'] = []
  for (const index of selection.junctions) {
    const junction = doc.junctions[index]
    if (!junction) continue
    const to = place(junction)
    junctions.push({ index, to })
    moved.push({ from: junction, to })
  }
  const noConnects: TransformPlan['noConnects'] = []
  for (const index of selection.noConnects) {
    const flag = doc.noConnects[index]
    if (!flag) continue
    const to = place(flag)
    noConnects.push({ index, to })
    moved.push({ from: flag, to })
  }
  const placement: Placement = { place, shift, ops: steps.map((step) => step.op) }
  const others = placedOthers(doc, selection, placement)
  const sheetPins = sheetPinMoves(doc, selection, delta).map(({ sheet, pin, to, side }) => ({
    sheet,
    pin,
    to,
    side
  }))
  moved.push(...sheetPinMovedPoints(doc, selection, delta))
  moved.push(...busMovedPoints(doc, selection, place))
  if (!moved.length && !symbols.length && !others.length) return null
  const move = planMovedPoints(doc, moved, selection, {
    grid: options.grid,
    wires: options.wires,
    carryAttached: options.carryAttached ?? true,
    movedWires: new Map(wires.map((wire) => [wire.index, wire.points])),
    movedBuses: placedBuses(doc, selection, place)
  })
  return {
    pivot: steps[0]?.pivot ?? { x: nm(0), y: nm(0) },
    turned: steps.length > 0,
    symbols,
    wires,
    labels,
    junctions,
    noConnects,
    others,
    sheetPins,
    move
  }
}

const placedOthers = (
  doc: KicadSchematic,
  selection: MoveSelection,
  placement: Placement
): TransformPlan['others'] =>
  selection.others.flatMap(({ type, index }) => {
    const from = sheetItemAt(doc, type, index)
    return from ? [{ index, from, to: placedSheetItem(from, placement) }] : []
  })

/**
 * The plan for turning or mirroring a selection in place. A lone symbol
 * turns about its own origin; a group about its middle. Only the selection
 * moves: the wires, labels and flags on its pins stay where they are, as
 * KiCad's rotate leaves them — a part turned because it was backwards is
 * meant to land in the wiring that is already there, and a label carried
 * onto a pin now sitting on another wire would join two nets unasked. The
 * turn pressed mid-drag is the one that follows, being a drag.
 */
export function planTransform(
  doc: KicadSchematic,
  items: MoveItem[],
  op: TransformOp,
  grid: Nm
): TransformPlan | null {
  const selection = selectionOf(items)
  const positions: Point[] = []
  for (const index of selection.symbols) {
    const symbol = doc.symbols[index]
    if (symbol) positions.push(symbol.position)
  }
  for (const index of selection.wires) positions.push(...(doc.wires[index]?.points ?? []))
  for (const index of selection.labels) {
    const label = doc.labels[index]
    if (label) positions.push(label.position)
  }
  for (const index of selection.junctions) {
    const junction = doc.junctions[index]
    if (junction) positions.push(junction)
  }
  for (const index of selection.noConnects) {
    const flag = doc.noConnects[index]
    if (flag) positions.push(flag)
  }
  for (const { type, index } of selection.others) {
    const entry = sheetItemAt(doc, type, index)
    if (entry) positions.push(...sheetItemPoints(entry))
  }
  if (!positions.length) return null
  const loneSymbol =
    selection.symbols.size === 1 && positions.length === 1 ? positions[0] : undefined
  const pivot = transformPivot(positions, grid, loneSymbol)
  return planPlacement(
    doc,
    items,
    [{ op, pivot }],
    { x: nm(0), y: nm(0) },
    { grid, wires: false, carryAttached: false }
  )
}

/**
 * The sheet with the selection turned as `steps` say and nothing else
 * changed: what the canvas rebuilds from mid-drag, so the shift that
 * continues afterward is a plain translation of what it draws. A turned
 * symbol's fields are where the drop will put them: carried round with the
 * body, then autoplaced if it is marked so, as `applyTransform` does. Nodes
 * are shared with the document; nothing here is written.
 */
export function turnedSchematic(
  doc: KicadSchematic,
  items: MoveItem[],
  steps: PlacementStep[],
  sheetPath = '/'
): KicadSchematic {
  const plan = planPlacement(
    doc,
    items,
    steps,
    { x: nm(0), y: nm(0) },
    {
      grid: nm(1),
      wires: false
    }
  )
  if (!plan) return doc
  const symbolTo = new Map(
    plan.symbols.map((entry) => [entry.index, fieldsCarried(doc.symbols[entry.index], entry.to)])
  )
  const wireTo = new Map(plan.wires.map((entry) => [entry.index, entry.points]))
  const labelTo = new Map(plan.labels.map((entry) => [entry.index, entry]))
  const junctionTo = new Map(plan.junctions.map((entry) => [entry.index, entry.to]))
  const flagTo = new Map(plan.noConnects.map((entry) => [entry.index, entry.to]))
  const turned = withSheetItems(
    doc,
    plan.others.map((entry) => ({ ...entry.to, index: entry.index }))
  )
  const result: KicadSchematic = {
    ...turned,
    symbols: doc.symbols.map((symbol, index) => symbolTo.get(index) ?? symbol),
    wires: doc.wires.map((wire, index) => {
      const points = wireTo.get(index)
      return points ? { ...wire, points } : wire
    }),
    labels: doc.labels.map((label, index) => {
      const to = labelTo.get(index)
      return to ? { ...label, position: { ...to.position, angle: to.angle } } : label
    }),
    junctions: doc.junctions.map((junction, index) => {
      const to = junctionTo.get(index)
      return to ? { ...junction, ...to } : junction
    }),
    noConnects: doc.noConnects.map((flag, index) => {
      const to = flagTo.get(index)
      return to ? { ...flag, ...to } : flag
    })
  }
  if (!plan.turned) return result
  for (const { index } of plan.symbols) {
    const symbol = result.symbols[index]
    if (!symbol?.fieldsAutoplaced) continue
    const placed = new Map(
      autoplaceFields(result, sheetPath, symbol).map((entry) => [entry.property.key, entry])
    )
    if (!placed.size) continue
    result.symbols[index] = {
      ...symbol,
      properties: symbol.properties.map((property) => {
        const entry = placed.get(property.key)
        return entry
          ? {
              ...property,
              position: { ...entry.at, angle: entry.angle },
              effects: {
                ...property.effects,
                horizontalAlign: entry.horizontal,
                verticalAlign: entry.vertical
              }
            }
          : property
      })
    }
  }
  return result
}

/** A placed copy whose fields moved, turned and flipped with it, as
 *  `setSchematicSymbolPoseInAST` carries them. */
const fieldsCarried = (
  from: KicadSchematicSymbol | undefined,
  to: KicadSchematicSymbol
): KicadSchematicSymbol => {
  if (!from) return to
  return {
    ...to,
    properties: from.properties.map((property) => ({
      ...property,
      position: { ...property.position, ...fieldPointThroughPose(property.position, from, to) }
    }))
  }
}

/** Write a transform plan into the document: the items themselves, then
 *  their wires and riders through `applyMovePlan`. */
export function applyTransform(doc: KicadSchematic, sheetPath: string, plan: TransformPlan): void {
  for (const { index, to } of plan.symbols) {
    const symbol = doc.symbols[index]
    if (!symbol) continue
    setSchematicSymbolPoseInAST(symbol, to)
    // Fields turn with the body; ones the autoplacer put are placed again, as
    // KiCad does only for a symbol still marked `fields_autoplaced`, so a
    // field the user placed stays where they put it.
    if (plan.turned && symbol.fieldsAutoplaced) autoplaceFieldsInAST(doc, sheetPath, symbol)
  }
  for (const { index, points } of plan.wires) {
    const wire = doc.wires[index]
    if (wire) setSchematicWirePointsInAST(wire, points)
  }
  for (const { index, position, angle } of plan.labels) {
    const label = doc.labels[index]
    if (label) setSchematicLabelPlacement(label, { ...position, angle })
  }
  for (const { index, to } of plan.junctions) {
    const junction = doc.junctions[index]
    if (junction)
      moveSchematicPointItemInAST(junction, { x: nm(to.x - junction.x), y: nm(to.y - junction.y) })
  }
  for (const { index, to } of plan.noConnects) {
    const flag = doc.noConnects[index]
    if (flag) moveSchematicPointItemInAST(flag, { x: nm(to.x - flag.x), y: nm(to.y - flag.y) })
  }
  for (const { from, to } of plan.others) writeSheetItem(from, to)
  for (const { sheet, pin, to, side } of plan.sheetPins) {
    const live = doc.sheets[sheet]?.pins[pin]
    if (live) setSheetPinPlacement(live, { position: to, side })
  }
  applyMovePlan(doc, plan.move)
}

/**
 * Write a plain drag of `items` by `delta` into the document — every kind the
 * editor selects, each by its own writer. A part whose owner is moving too is
 * left to the owner (a symbol carries its fields, a sheet its pins and name),
 * or it would move twice. The wires that follow are `planMove`'s business,
 * applied after this with `applyMovePlan`.
 */
export function translateSchematicItems(
  doc: KicadSchematic,
  items: MoveItem[],
  delta: Point
): void {
  const selection = selectionOf(items)
  for (const item of items) {
    switch (item.type) {
      case 'field': {
        const symbol = doc.symbols[item.index]
        if (symbol && item.field && !selection.symbols.has(item.index)) {
          moveSchematicFieldInAST(symbol, item.field, delta)
          // Placed by hand now: a later turn must not autoplace it back (KiCad's rule).
          setSchematicFieldsAutoplaced(symbol, false)
        }
        break
      }
      case 'sheet_field': {
        const sheet = doc.sheets[item.index]
        if (sheet && item.field && !selection.sheets.has(item.index))
          moveSchematicFieldInAST(sheet, item.field, delta)
        break
      }
      case 'sheet_pin':
        break
      case 'symbol': {
        const symbol = doc.symbols[item.index]
        if (symbol) moveSchematicSymbolInAST(symbol, delta)
        break
      }
      case 'wire': {
        const wire = doc.wires[item.index]
        if (wire) moveSchematicWireInAST(wire, delta)
        break
      }
      case 'label': {
        const label = doc.labels[item.index]
        if (label) moveSchematicLabelInAST(label, delta)
        break
      }
      case 'sheet': {
        const sheet = doc.sheets[item.index]
        if (sheet) moveSchematicSheetInAST(sheet, delta)
        break
      }
      case 'junction':
      case 'no_connect': {
        const point = (item.type === 'junction' ? doc.junctions : doc.noConnects)[item.index]
        if (point) moveSchematicPointItemInAST(point, delta)
        break
      }
      default: {
        const entry = sheetItemAt(doc, item.type, item.index)
        if (entry) writeSheetItem(entry, placedSheetItem(entry, translation(delta)))
      }
    }
  }
  for (const move of sheetPinMoves(doc, selection, delta)) {
    const pin = doc.sheets[move.sheet]?.pins[move.pin]
    if (pin) setSheetPinPlacement(pin, { position: move.to, side: move.side })
  }
}

// ---------------------------------------------------------------------------
// What a move does to the nets
// ---------------------------------------------------------------------------

export interface NetChanges {
  /** Pairs of nets that would become one. */
  merges: [string, string][]
  /** Nets that would come apart. */
  splits: string[]
  /** Something unconnected that would join a net: `member` is a pin ref or a
   *  label's text. */
  connects: { member: string; net: string }[]
}

interface NetMembers {
  name: string
  members: string[]
  /** More than a lone pin: something a merge or a split can be measured on. */
  real: boolean
}

const netMembers = (connectivity: SchematicConnectivity): NetMembers[] =>
  connectivity.nets.map((net) => {
    const members = new Set<string>()
    for (const pin of net.pins) members.add(`${pin.reference}.${pin.pin.number}`)
    for (const label of net.labels) members.add(label.label.text)
    for (const sheetPin of net.sheetPins)
      members.add(`${sheetPin.sheet.uuid ?? ''}#${sheetPin.pin.name}`)
    return {
      name: net.name,
      members: [...members],
      real: members.size >= 2 || net.wires.length >= 1
    }
  })

/** Merges, splits and new connections between two connectivity readings. */
export function netChanges(
  before: SchematicConnectivity,
  after: SchematicConnectivity
): NetChanges {
  const beforeNets = netMembers(before)
  const afterNets = netMembers(after)
  const beforeOf = new Map<string, number>()
  beforeNets.forEach((net, index) => {
    for (const member of net.members) beforeOf.set(member, index)
  })
  const afterOf = new Map<string, number>()
  afterNets.forEach((net, index) => {
    for (const member of net.members) afterOf.set(member, index)
  })

  const merges: NetChanges['merges'] = []
  const connects: NetChanges['connects'] = []
  for (const net of afterNets) {
    const sources = new Set<number>()
    for (const member of net.members) {
      const source = beforeOf.get(member)
      if (source !== undefined && beforeNets[source].real) sources.add(source)
    }
    const names = [...sources].map((source) => beforeNets[source].name)
    for (let index = 1; index < names.length; index++) merges.push([names[0], names[index]])
    if (!net.real) continue
    for (const member of net.members) {
      const source = beforeOf.get(member)
      if (source !== undefined && !beforeNets[source].real && net.members.length >= 2) {
        connects.push({ member, net: net.name })
      }
    }
  }
  const splits: string[] = []
  beforeNets.forEach((net) => {
    if (!net.real) return
    const targets = new Set<number>()
    for (const member of net.members) {
      const target = afterOf.get(member)
      if (target !== undefined) targets.add(target)
    }
    if (targets.size >= 2) splits.push(net.name)
  })
  return { merges, splits, connects }
}

/**
 * How many items a turn or flip of `items` names, for its undo label: every
 * selected item, sheets included, less a part whose owner is selected too —
 * the owner carries it, so it is not a second item.
 */
export function transformedItemCount(items: MoveItem[]): number {
  const owners = new Set(
    items
      .filter((item) => item.type === 'symbol' || item.type === 'sheet')
      .map((item) => `${item.type}:${item.index}`)
  )
  return items.filter((item) => {
    if (item.type === 'field') return !owners.has(`symbol:${item.index}`)
    if (item.type === 'sheet_pin' || item.type === 'sheet_field')
      return !owners.has(`sheet:${item.index}`)
    return true
  }).length
}

const flippedJustify = <T extends string>(justify: T, a: T, b: T): T =>
  justify === a ? b : justify === b ? a : justify

/**
 * Turn or flip a symbol's field on its own — `R`, `X` or `Y` on a selected
 * field whose symbol is not selected — as KiCad's edit tool does: a turn swaps
 * the field between horizontal and vertical where it stands, a flip mirrors
 * its justification. Either way the field is now placed by hand, so the
 * symbol stops being `fields_autoplaced`.
 */
export function transformSchematicFieldInAST(
  symbol: KicadSchematicSymbol,
  key: string,
  op: TransformOp
): void {
  const property = symbol.properties.find((candidate) => candidate.key === key)
  if (!property) return
  const { horizontalAlign, verticalAlign } = property.effects
  if (op === 'rotateCCW' || op === 'rotateCW') {
    const horizontal = Math.round(property.position.angle / 90) % 2 === 0
    setSchematicPropertyPlacement(property, { ...property.position, angle: horizontal ? 90 : 0 })
  } else if (op === 'mirrorHorizontal') {
    setSchematicPropertyJustify(
      property,
      flippedJustify(horizontalAlign, 'left', 'right'),
      verticalAlign
    )
  } else {
    setSchematicPropertyJustify(
      property,
      horizontalAlign,
      flippedJustify(verticalAlign, 'top', 'bottom')
    )
  }
  setSchematicFieldsAutoplaced(symbol, false)
}

/** The selected fields a turn or flip reaches on their own: those whose symbol is not selected. */
export function loneFields(items: MoveItem[]): Array<{ index: number; field: string }> {
  const symbols = new Set(items.filter((item) => item.type === 'symbol').map((item) => item.index))
  return items.flatMap((item) =>
    item.type === 'field' && item.field !== undefined && !symbols.has(item.index)
      ? [{ index: item.index, field: item.field }]
      : []
  )
}
