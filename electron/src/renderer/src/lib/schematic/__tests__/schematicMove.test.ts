import { describe, expect, test } from 'vitest'
import {
  parseKicadSchematic,
  resolveSymbolGeometry,
  serializeKicadSchematic,
  setSchematicPropertyPlacement,
  type KicadSchematic,
  type SchematicProperty
} from '../../kicad/schematic'
import { buildConnectivity, placedPinPosition, type SchematicConnectivity } from '../connectivity'
import { mmToNm } from '../../kicad/coordinates'
import type { Point } from '../../kicad/schematic'
import {
  applyMovePlan,
  applyTransform,
  loneFields,
  netChanges,
  planMove,
  planPlacement,
  planTransform,
  previewMovedSchematic,
  selectionOf,
  transformSchematicFieldInAST,
  translateSchematicItems,
  turnedSchematic
} from '../schematicMove'
import { schematicMoveParts } from '../moveParts'
import { roleAnchors, roleGrid } from '../../moveAnchors'

/** A resistor whose top pin (R1.1, pointing up) is wired sideways to a
 *  labelled junction, with a no-connect on its bottom pin. */
const SOURCE = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "root-uuid")
  (paper "A4")
  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R" (at 0 0 0))
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default))
          (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
  )
  (junction (at 63.5 52.07) (diameter 0) (color 0 0 0 0))
  (no_connect (at 50.8 59.69) (uuid "nc-uuid"))
  (wire (pts (xy 50.8 52.07) (xy 63.5 52.07))
    (stroke (width 0) (type default))
    (uuid "wire-uuid"))
  (label "VBUS" (at 63.5 52.07 0)
    (effects (font (size 1.27 1.27)) (justify left bottom))
    (uuid "label-uuid"))
  (symbol
    (lib_id "Device:R")
    (at 50.8 55.88 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid "symbol-uuid")
    (property "Reference" "R1" (at 52.07 54.61 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 52.07 57.15 0) (effects (font (size 1.27 1.27)) (justify left)))
    (pin "1" (uuid "pin-1"))
    (pin "2" (uuid "pin-2")))
  (sheet_instances (path "/" (page "1")))
)`

const parsed = (): KicadSchematic => parseKicadSchematic(SOURCE)
const GRID = mmToNm(1.27)
const p = (x: number, y: number): Point => ({ x: mmToNm(x), y: mmToNm(y) })
const symbol = [{ type: 'symbol' as const, index: 0 }]

const connectivityOf = (schematic: KicadSchematic): SchematicConnectivity =>
  buildConnectivity([{ sheetPath: '/root-uuid', namePath: '/', schematic }])

describe('planMove + applyMovePlan', () => {
  test('a sideways move lengthens the wire and carries the no-connect', () => {
    const doc = parsed()
    const plan = planMove(doc, symbol, p(2.54, 0), { grid: GRID, wires: true })
    expect(plan.reshape.edits).toEqual([{ index: 0, points: [p(53.34, 52.07), p(63.5, 52.07)] }])
    expect(plan.noConnectMoves).toEqual([{ index: 0, to: p(53.34, 59.69) }])
    expect(plan.labelMoves).toEqual([])
  })

  test('the plan writes through the AST and survives a round trip', () => {
    const doc = parsed()
    const plan = planMove(doc, symbol, p(0, -5.08), { grid: GRID, wires: true })
    applyMovePlan(doc, plan)
    const again = parseKicadSchematic(serializeKicadSchematic(doc))
    // The wire bent at its labelled end: the pin end rose, the label stayed.
    expect(again.wires.map((wire) => wire.points)).toEqual([
      [p(50.8, 46.99), p(63.5, 46.99)],
      [p(63.5, 46.99), p(63.5, 52.07)]
    ])
    expect(again.labels[0].position).toMatchObject(p(63.5, 52.07))
    expect(again.wires[0].uuid).toBe('wire-uuid')
  })

  test('a bare move leaves the wire and reports the break', () => {
    const doc = parsed()
    const delta = p(0, -5.08)
    const plan = planMove(doc, symbol, delta, { grid: GRID, wires: false })
    expect(plan.reshape.edits).toEqual([])
    const changes = netChanges(
      connectivityOf(doc),
      connectivityOf(previewMovedSchematic(doc, plan, delta))
    )
    expect(changes.splits).toEqual(['/VBUS'])
    expect(changes.merges).toEqual([])
  })

  test('a move with wires following changes no net', () => {
    const doc = parsed()
    const delta = p(0, -5.08)
    const plan = planMove(doc, symbol, delta, { grid: GRID, wires: true })
    const changes = netChanges(
      connectivityOf(doc),
      connectivityOf(previewMovedSchematic(doc, plan, delta))
    )
    expect(changes).toEqual({ merges: [], splits: [], connects: [] })
  })

  test('a turn in place moves the symbol alone; its wiring stays put', () => {
    const doc = parsed()
    const plan = planTransform(doc, symbol, 'rotateCCW', GRID)
    expect(plan).not.toBeNull()
    if (!plan) return
    expect(plan.pivot).toMatchObject(p(50.8, 55.88))
    applyTransform(doc, '/root-uuid', plan)
    const again = parseKicadSchematic(serializeKicadSchematic(doc))
    expect(again.symbols[0].position.angle).toBe(90)
    // The wire, the label and the no-connect are where they were: a part
    // turned because it was backwards lands in the wiring already there.
    expect(again.wires.map((wire) => wire.points)).toEqual([[p(50.8, 52.07), p(63.5, 52.07)]])
    expect(again.labels[0].position).toMatchObject(p(63.5, 52.07))
    expect(again.noConnects[0]).toMatchObject(p(50.8, 59.69))
  })

  test('a turn mid-drag composes about the cursor, then the shift lands', () => {
    const doc = parsed()
    // Turned about its own origin, then carried 2.54 right: the same as a
    // drag that pressed R with the cursor on the body, then kept going.
    const plan = planPlacement(
      doc,
      symbol,
      [{ op: 'rotateCCW', pivot: p(50.8, 55.88) }],
      p(2.54, 0),
      { grid: GRID, wires: true }
    )
    expect(plan?.turned).toBe(true)
    expect(plan?.symbols[0].to.position).toMatchObject({ ...p(53.34, 55.88), angle: 90 })
    // Pin 1 lands left of the turned body, shifted with it.
    expect(plan?.move.moved[0]).toMatchObject({ to: p(49.53, 55.88), direction: 'left' })
    // The canvas's mid-drag copy holds the turn alone; the shift is the drag's.
    const turned = turnedSchematic(doc, symbol, [{ op: 'rotateCCW', pivot: p(50.8, 55.88) }])
    expect(turned.symbols[0].position).toMatchObject({ ...p(50.8, 55.88), angle: 90 })
    expect(turned.wires.map((wire) => wire.points)).toEqual(doc.wires.map((wire) => wire.points))
  })

  test('a turn mid-drag shows the fields where the drop will put them', () => {
    // Half a turn about a point off the body: the origin moves, and the
    // fields ride with it and then autoplace — the same as the drop writes.
    const steps = [
      { op: 'rotateCCW' as const, pivot: p(60.96, 55.88) },
      { op: 'rotateCCW' as const, pivot: p(60.96, 55.88) }
    ]
    const turned = turnedSchematic(parsed(), symbol, steps, '/root-uuid')
    const doc = parsed()
    const plan = planPlacement(doc, symbol, steps, p(0, 0), { grid: GRID, wires: false })
    if (!plan) throw new Error('no plan')
    applyTransform(doc, '/root-uuid', plan)
    const dropped = parseKicadSchematic(serializeKicadSchematic(doc)).symbols[0]
    expect(turned.symbols[0].position).toEqual(dropped.position)
    const fieldsOf = (s: typeof dropped): unknown =>
      s.properties.map(({ key, position, effects }) => ({
        key,
        position,
        h: effects.horizontalAlign,
        v: effects.verticalAlign
      }))
    expect(fieldsOf(turned.symbols[0])).toEqual(fieldsOf(dropped))
    // Nothing of the document itself was touched.
    expect(parsed().symbols[0].properties[0].position).toEqual(
      turnedSchematic(parsed(), symbol, []).symbols[0].properties[0].position
    )
  })

  test('selectionOf groups a selection by kind and ignores fields', () => {
    const selection = selectionOf([
      { type: 'symbol', index: 2 },
      { type: 'wire', index: 1 },
      { type: 'field', index: 2 }
    ])
    expect([...selection.symbols]).toEqual([2])
    expect([...selection.wires]).toEqual([1])
  })
})

describe('fields through a turn or flip', () => {
  const OPS = ['rotateCCW', 'rotateCW', 'mirrorHorizontal', 'mirrorVertical'] as const
  const reference = (doc: KicadSchematic): SchematicProperty =>
    doc.symbols[0].properties.find((property) => property.key === 'Reference')!
  const reparsed = (doc: KicadSchematic): KicadSchematic =>
    parseKicadSchematic(serializeKicadSchematic(doc))
  const pinOne = (doc: KicadSchematic): Point => {
    const pin = resolveSymbolGeometry(doc, doc.symbols[0]).pins.find(
      ({ pin }) => pin.number === '1'
    )!.pin
    return placedPinPosition(doc.symbols[0], pin)
  }

  // KiCad keeps a field fixed to its symbol (`SCH_SYMBOL::Rotate` and the
  // mirrors carry its offset): one sitting on a pin stays on that pin, and
  // keeps its stored angle and justification, which read in the symbol's frame.
  test.each(OPS)('%s carries a hand-placed field round with the body', (op) => {
    let doc = parsed()
    setSchematicPropertyPlacement(reference(doc), pinOne(doc))
    doc = reparsed(doc)
    for (let step = 0; step < 3; step++) {
      const plan = planTransform(doc, symbol, op, GRID)
      if (!plan) throw new Error('no plan')
      applyTransform(doc, '/root-uuid', plan)
      doc = reparsed(doc)
      expect(reference(doc).position).toMatchObject(pinOne(doc))
      expect(reference(doc).position.angle).toBe(0)
      expect(reference(doc).effects.horizontalAlign).toBe('left')
    }
  })

  test('a symbol marked fields_autoplaced has them placed again', () => {
    const doc = parseKicadSchematic(
      SOURCE.replace('(uuid "symbol-uuid")', '(fields_autoplaced yes) (uuid "symbol-uuid")')
    )
    const plan = planTransform(doc, symbol, 'rotateCCW', GRID)
    if (!plan) throw new Error('no plan')
    applyTransform(doc, '/root-uuid', plan)
    const after = reparsed(doc)
    // Turned a quarter, its pins point left and right: the fields go on top,
    // stored at 90 so they read along the sheet, and it stays autoplaced.
    expect(after.symbols[0].fieldsAutoplaced).toBe(true)
    for (const property of after.symbols[0].properties) {
      expect(property.position.angle).toBe(90)
      expect(property.position.y).toBeLessThan(mmToNm(55.88 - 1.016))
    }
  })

  test('dragging a field takes it off the autoplacer', () => {
    const doc = parseKicadSchematic(
      SOURCE.replace('(uuid "symbol-uuid")', '(fields_autoplaced yes) (uuid "symbol-uuid")')
    )
    translateSchematicItems(doc, [{ type: 'field', index: 0, field: 'Value' }], p(2.54, 0))
    const text = serializeKicadSchematic(doc)
    expect(text).not.toContain('fields_autoplaced')
    // And so a later turn carries it rather than putting it back.
    const after = parseKicadSchematic(text)
    const plan = planTransform(after, symbol, 'mirrorHorizontal', GRID)
    if (!plan) throw new Error('no plan')
    applyTransform(after, '/root-uuid', plan)
    const value = after.symbols[0].properties.find((property) => property.key === 'Value')!
    expect(value.position).toMatchObject(p(50.8 - 1.27 - 2.54, 57.15))
  })

  test('R on a lone field swaps it between horizontal and vertical in place', () => {
    const doc = parseKicadSchematic(
      SOURCE.replace('(uuid "symbol-uuid")', '(fields_autoplaced yes) (uuid "symbol-uuid")')
    )
    const items = [{ type: 'field' as const, index: 0, field: 'Reference' }]
    expect(planTransform(doc, items, 'rotateCCW', GRID)).toBeNull()
    expect(loneFields(items)).toEqual([{ index: 0, field: 'Reference' }])
    transformSchematicFieldInAST(doc.symbols[0], 'Reference', 'rotateCCW')
    const after = reparsed(doc)
    expect(reference(after).position).toMatchObject({ ...p(52.07, 54.61), angle: 90 })
    expect(after.symbols[0].fieldsAutoplaced).toBe(false)
    transformSchematicFieldInAST(after.symbols[0], 'Reference', 'rotateCW')
    expect(reference(reparsed(after)).position.angle).toBe(0)
  })

  test('X and Y on a lone field flip its justification', () => {
    const doc = parsed()
    transformSchematicFieldInAST(doc.symbols[0], 'Reference', 'mirrorHorizontal')
    transformSchematicFieldInAST(doc.symbols[0], 'Reference', 'mirrorVertical')
    // Stored `justify left` with the default vertical center: only left flips.
    expect(reference(reparsed(doc)).effects).toMatchObject({
      horizontalAlign: 'right',
      verticalAlign: 'center'
    })
    expect(loneFields([...symbol, { type: 'field', index: 0, field: 'Reference' }])).toEqual([])
  })
})

describe('planMove: buses follow as wires do', () => {
  // A bus along y = 20 from x 100 to 110, and a second down from its end.
  const withBuses = (): KicadSchematic =>
    parseKicadSchematic(
      SOURCE.replace(
        '  (sheet_instances',
        `  (bus (pts (xy 100 20) (xy 110 20)) (stroke (width 0) (type default)) (uuid "bus-a"))
  (bus (pts (xy 110 20) (xy 110 30)) (stroke (width 0) (type default)) (uuid "bus-b"))
  (label "D[0..7]" (at 100 20 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "bus-label"))
  (sheet_instances`
      )
    )

  test('moving a bus stretches the bus joined to its end', () => {
    const doc = withBuses()
    const plan = planMove(doc, [{ type: 'bus', index: 1 }], p(2.54, 0), { grid: GRID, wires: true })
    expect(plan.busReshape?.edits).toEqual([{ index: 0, points: [p(112.54, 20), p(100, 20)] }])
    // The wires are not a bus's business.
    expect(plan.reshape.edits).toEqual([])
  })

  test('the stretch writes through the AST, and the moved bus lands with it', () => {
    const doc = withBuses()
    const items = [{ type: 'bus' as const, index: 1 }]
    const plan = planMove(doc, items, p(2.54, 0), { grid: GRID, wires: true })
    translateSchematicItems(doc, items, p(2.54, 0))
    applyMovePlan(doc, plan)
    const again = parseKicadSchematic(serializeKicadSchematic(doc))
    expect(again.buses.map((bus) => bus.points)).toEqual([
      [p(112.54, 20), p(100, 20)],
      [p(112.54, 20), p(112.54, 30)]
    ])
  })

  test('the drag preview plans the same stretch (planPlacement)', () => {
    const doc = withBuses()
    const plan = planPlacement(doc, [{ type: 'bus', index: 1 }], [], p(2.54, 0), {
      grid: GRID,
      wires: true
    })
    expect(plan?.move.busReshape?.edits).toEqual([
      { index: 0, points: [p(112.54, 20), p(100, 20)] }
    ])
  })

  test('a label on a moved bus end rides along', () => {
    const doc = withBuses()
    const plan = planMove(doc, [{ type: 'bus', index: 0 }], p(0, 2.54), { grid: GRID, wires: true })
    expect(plan.labelMoves).toEqual([{ index: 1, to: p(100, 22.54) }])
  })
})

describe('schematicMoveParts', () => {
  test('a symbol grabs by its origin or a pin, a field moves on the text grid', () => {
    const parts = schematicMoveParts(parsed(), [
      ...symbol,
      { type: 'field', index: 0, field: 'Reference' }
    ])
    expect(parts[0]).toMatchObject({
      role: 'connectable',
      anchors: [p(50.8, 55.88), p(50.8, 52.07), p(50.8, 59.69)]
    })
    expect(parts[1]).toMatchObject({ role: 'text', anchors: [p(52.07, 54.61)] })
    // The field's anchor counts only without the symbol (`roleAnchors`).
    expect(roleAnchors(parts)).toHaveLength(3)
    expect(roleGrid(['text'], 0.5)).toBeCloseTo(0.254)
    expect(roleGrid(['text', 'connectable'], 0.5)).toBeCloseTo(1.27)
  })

  test('a wire grabs by its ends', () => {
    expect(schematicMoveParts(parsed(), [{ type: 'wire', index: 0 }])).toEqual([
      { role: 'wire', anchors: [p(50.8, 52.07), p(63.5, 52.07)] }
    ])
  })
})
