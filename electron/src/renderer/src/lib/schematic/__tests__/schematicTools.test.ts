import { describe, expect, test } from 'vitest'
import {
  elbowPoints,
  isWireAttachPoint,
  junctionsForNewWire,
  sheetDraftRect,
  SHEET_DEFAULT_WIDTH,
  mergeCollinearPoints,
  nextReference,
  wireTerminals
} from '../schematicTools'
import { mmToNm } from '../../kicad/coordinates'
import type { KicadSchematic, Point } from '../../kicad/schematic'

/** A sheet point from mm coordinates — the tests speak mm, the domain nm. */
const p = (x: number, y: number): Point => ({ x: mmToNm(x), y: mmToNm(y) })

describe('elbowPoints', () => {
  test('aligned targets get a single segment', () => {
    expect(elbowPoints(p(0, 0), p(10, 0), 'hv')).toEqual([p(10, 0)])
    expect(elbowPoints(p(0, 0), p(0, 10), 'vh')).toEqual([p(0, 10)])
  })

  test('posture picks which leg comes first', () => {
    expect(elbowPoints(p(0, 0), p(10, 5), 'hv')).toEqual([p(10, 0), p(10, 5)])
    expect(elbowPoints(p(0, 0), p(10, 5), 'vh')).toEqual([p(0, 5), p(10, 5)])
  })
})

describe('mergeCollinearPoints', () => {
  test('drops duplicates and pass-through interior points', () => {
    expect(mergeCollinearPoints([p(0, 0), p(0, 0), p(5, 0), p(10, 0), p(10, 5)])).toEqual([
      p(0, 0),
      p(10, 0),
      p(10, 5)
    ])
  })

  test('keeps a deliberate double-back', () => {
    const points = [p(0, 0), p(10, 0), p(5, 0)]
    expect(mergeCollinearPoints(points)).toEqual(points)
  })
})

describe('wireTerminals', () => {
  test("names each sheet pin, label anchor and bus entry's two ends", () => {
    const at = (x: number, y: number): Point & { angle: number } => ({ ...p(x, y), angle: 0 })
    const doc = {
      sheets: [{ pins: [{ position: at(30, 10) }, { position: at(30, 15) }] }],
      labels: [{ position: at(40, 0) }],
      directiveLabels: [{ position: at(45, 0) }],
      busEntries: [{ position: p(50, 0), size: { width: mmToNm(2.54), height: mmToNm(2.54) } }]
    } as unknown as Pick<KicadSchematic, 'sheets' | 'labels' | 'directiveLabels' | 'busEntries'>
    const points = wireTerminals(doc)
    expect(points.map((q) => [q.x, q.y])).toEqual(
      [p(30, 10), p(30, 15), p(40, 0), p(45, 0), p(50, 0), p(52.54, 2.54)].map((q) => [q.x, q.y])
    )
    expect(isWireAttachPoint(p(30, 15), [], points)).toBe(true)
  })
})

describe('isWireAttachPoint', () => {
  const wires = [[p(0, 0), p(10, 0)]]
  const pins = [p(20, 20)]

  test('detects pins, wire interiors, and wire ends', () => {
    expect(isWireAttachPoint(p(20, 20), wires, pins)).toBe(true)
    expect(isWireAttachPoint(p(5, 0), wires, pins)).toBe(true)
    expect(isWireAttachPoint(p(10, 0), wires, pins)).toBe(true)
    expect(isWireAttachPoint(p(5, 5), wires, pins)).toBe(false)
  })
})

describe('junctionsForNewWire', () => {
  const horizontal = [p(0, 0), p(20, 0)]

  test('T-landing on an existing wire interior gets a dot', () => {
    const junctions = junctionsForNewWire([horizontal], [], [], [p(10, 10), p(10, 0)])
    expect(junctions).toEqual([p(10, 0)])
  })

  test('end-to-end continuation needs no dot', () => {
    expect(junctionsForNewWire([horizontal], [], [], [p(20, 0), p(30, 0)])).toEqual([])
  })

  test('three items meeting at a point gets a dot (wire ends and pins count)', () => {
    const other = [p(20, 10), p(20, 0)]
    expect(junctionsForNewWire([horizontal, other], [], [], [p(20, 0), p(30, 0)])).toEqual([
      p(20, 0)
    ])
    expect(junctionsForNewWire([horizontal], [], [p(20, 0)], [p(20, 0), p(30, 0)])).toEqual([
      p(20, 0)
    ])
  })

  test('existing junctions suppress duplicates', () => {
    expect(junctionsForNewWire([horizontal], [p(10, 0)], [], [p(10, 10), p(10, 0)])).toEqual([])
  })

  test('a dangling end swallowed by the new wire interior gets a dot', () => {
    const dangling = [p(10, 10), p(10, 5)]
    expect(junctionsForNewWire([dangling], [], [], [p(0, 5), p(20, 5)])).toEqual([p(10, 5)])
  })

  test('a pin the new wire runs through gets a dot; one at its end is only an end', () => {
    // A pin with a wire through it is three exits; KiCad connects it only
    // with the dot (checked against kicad-cli's netlist).
    expect(junctionsForNewWire([], [], [p(10, 0)], [p(0, 0), p(20, 0)])).toEqual([p(10, 0)])
    expect(junctionsForNewWire([], [], [p(20, 0)], [p(0, 0), p(20, 0)])).toEqual([])
    expect(junctionsForNewWire([], [p(10, 0)], [p(10, 0)], [p(0, 0), p(20, 0)])).toEqual([])
  })
})

describe('nextReference', () => {
  test('picks the next number after the highest exact-prefix match', () => {
    expect(nextReference(['R1', 'R3', 'C2', 'RV9', 'R?'], 'R')).toBe('R4')
    expect(nextReference([], 'U')).toBe('U1')
    expect(nextReference(['#PWR1', '#PWR12'], '#PWR')).toBe('#PWR13')
  })
})

describe('sheetDraftRect', () => {
  test('fixes width to the default and takes height from the two clicks', () => {
    const rect = sheetDraftRect(p(10, 20), p(99, 45))
    expect(rect).toEqual({
      x0: mmToNm(10),
      x1: mmToNm(10) + SHEET_DEFAULT_WIDTH,
      y0: mmToNm(20),
      y1: mmToNm(45)
    })
  })

  test('normalizes an upward draw (second click above the first)', () => {
    const rect = sheetDraftRect(p(5, 50), p(5, 30))
    expect(rect.y0).toBe(mmToNm(30))
    expect(rect.y1).toBe(mmToNm(50))
    // The second click's x is ignored — width stays the default.
    expect(rect.x1 - rect.x0).toBe(SHEET_DEFAULT_WIDTH)
  })
})
