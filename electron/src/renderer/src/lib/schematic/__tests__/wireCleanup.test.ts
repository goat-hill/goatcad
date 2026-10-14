import { describe, expect, test } from 'vitest'
import { mmToNm } from '../../kicad/coordinates'
import { parseKicadSchematic, serializeKicadSchematic, type Point } from '../../kicad/schematic'
import {
  cleanupChanged,
  cleanupSchematic,
  connectionShape,
  junctionNeededAt,
  routeContacts,
  sheetContacts
} from '../wireCleanup'

const p = (x: number, y: number): Point => ({ x: mmToNm(x), y: mmToNm(y) })

/** A sheet with one resistor whose pins sit at (50.8, 52.07) and (50.8, 59.69). */
const sheet = (items: string): string => `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "root-uuid")
  (paper "A4")
  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R" (at 0 0 0))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
  )
${items}
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

const wire = (a: [number, number], b: [number, number]): string =>
  `  (wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "w-${a}-${b}"))`
const junction = (x: number, y: number): string =>
  `  (junction (at ${x} ${y}) (diameter 0) (color 0 0 0 0) (uuid "j-${x}-${y}"))`

/** Clean, then read the result back the way the command layer does. */
const cleaned = (
  items: string
): ReturnType<typeof parseKicadSchematic> & {
  report: ReturnType<typeof cleanupSchematic>
} => {
  const doc = parseKicadSchematic(sheet(items))
  const report = cleanupSchematic(doc)
  return { ...parseKicadSchematic(serializeKicadSchematic(doc)), report }
}

const runs = (doc: { wires: { points: Point[] }[] }): Point[][] => doc.wires.map((w) => w.points)

describe('cleanupSchematic', () => {
  test('a wire drawn twice is one wire, and the dots it earned go with it', () => {
    // The sixth run's pattern: pin-to-connector drawn once each way, and the
    // draw-time junction rule dotted both ends because it counted wire ends.
    const doc = cleaned(
      [
        wire([50.8, 52.07], [40.64, 52.07]),
        wire([40.64, 52.07], [50.8, 52.07]),
        junction(50.8, 52.07),
        junction(40.64, 52.07)
      ].join('\n')
    )
    expect(doc.wires).toHaveLength(1)
    expect(doc.junctions).toHaveLength(0)
    expect(doc.report).toEqual({
      wiresRemoved: 1,
      wiresMerged: 0,
      junctionsRemoved: 2,
      junctionsAdded: 0,
      wiresSplit: 0
    })
  })

  test('a stub lying inside a longer run goes; two overlapping runs become one', () => {
    const doc = cleaned(
      [
        wire([60.96, 40.64], [60.96, 60.96]),
        wire([60.96, 58.42], [60.96, 60.96]),
        wire([60.96, 55.88], [60.96, 66.04])
      ].join('\n')
    )
    expect(runs(doc)).toEqual([[p(60.96, 40.64), p(60.96, 66.04)]])
    expect(doc.report.wiresRemoved).toBe(1)
    expect(doc.report.wiresMerged).toBe(1)
  })

  test('end-to-end runs join only when nothing else sits at the joint', () => {
    const plain = cleaned([wire([20, 30], [30, 30]), wire([30, 30], [40, 30])].join('\n'))
    expect(runs(plain)).toEqual([[p(20, 30), p(40, 30)]])
    expect(plain.report.wiresMerged).toBe(1)

    const labelled = cleaned(
      [
        wire([20, 30], [30, 30]),
        wire([30, 30], [40, 30]),
        '  (label "NET" (at 30 30 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l"))'
      ].join('\n')
    )
    expect(labelled.wires).toHaveLength(2)

    const teed = cleaned(
      [wire([20, 30], [30, 30]), wire([30, 30], [40, 30]), wire([30, 30], [30, 20])].join('\n')
    )
    expect(teed.wires).toHaveLength(3)
    expect(teed.junctions.map((j) => [j.x, j.y])).toEqual([[mmToNm(30), mmToNm(30)]])
    expect(teed.report.junctionsAdded).toBe(1)
  })

  test('a zero-length wire goes, and a dot at a corner goes', () => {
    const doc = cleaned(
      [
        wire([20, 30], [20, 30]),
        wire([20, 30], [30, 30]),
        wire([30, 30], [30, 40]),
        junction(30, 30)
      ].join('\n')
    )
    expect(doc.wires).toHaveLength(2)
    expect(doc.junctions).toHaveLength(0)
    expect(doc.report.wiresRemoved).toBe(1)
    expect(doc.report.junctionsRemoved).toBe(1)
  })

  test('a T onto a wire interior gets its dot, and two dots at one point are one', () => {
    const doc = cleaned(
      [wire([20, 30], [40, 30]), wire([30, 30], [30, 20]), junction(30, 30), junction(30, 30)].join(
        '\n'
      )
    )
    expect(doc.junctions).toHaveLength(1)
    expect(doc.report.junctionsRemoved).toBe(1)
    expect(doc.report.junctionsAdded).toBe(0)
  })

  test('a dot on a crossing is a join and stays; none is added to a bare crossing', () => {
    const crossing = [wire([40, 30], [60, 30]), wire([50, 20], [50, 40])]
    const joined = cleaned([...crossing, junction(50, 30)].join('\n'))
    expect(joined.junctions).toHaveLength(1)
    expect(joined.report.junctionsRemoved).toBe(0)
    const bare = cleaned(crossing.join('\n'))
    expect(bare.junctions).toHaveLength(0)
    expect(bare.report.junctionsAdded).toBe(0)
  })

  test('a clean sheet is left alone', () => {
    const source = sheet([wire([50.8, 52.07], [40.64, 52.07])].join('\n'))
    const doc = parseKicadSchematic(source)
    const untouched = serializeKicadSchematic(doc)
    const report = cleanupSchematic(doc)
    expect(cleanupChanged(report)).toBe(false)
    expect(serializeKicadSchematic(doc)).toBe(untouched)
  })

  test('different strokes are not merged', () => {
    const doc = cleaned(
      [
        wire([20, 30], [30, 30]),
        '  (wire (pts (xy 30 30) (xy 40 30)) (stroke (width 0.5) (type default)) (uuid "thick"))'
      ].join('\n')
    )
    expect(doc.wires).toHaveLength(2)
  })
})

describe('breaking a wire where the edit needs a dot (rule 0)', () => {
  /** Clean `after` as an edit from `before`, the way the command layer does. */
  const edited = (
    before: string,
    after: string
  ): ReturnType<typeof parseKicadSchematic> & {
    report: ReturnType<typeof cleanupSchematic>
    text: string
  } => {
    const doc = parseKicadSchematic(after)
    const report = cleanupSchematic(doc, connectionShape(parseKicadSchematic(before)))
    const text = serializeKicadSchematic(doc)
    return { ...parseKicadSchematic(text), report, text }
  }
  const dots = (doc: { junctions: Point[] }): number[][] => doc.junctions.map((j) => [j.x, j.y])
  // R1's pin 1 sits at (50.8, 52.07).
  const through = wire([40.64, 52.07], [60.96, 52.07])

  test('a new wire through a pin breaks at the pin and dots it', () => {
    const doc = edited(sheet(''), sheet(through))
    expect(runs(doc)).toEqual([
      [p(40.64, 52.07), p(50.8, 52.07)],
      [p(50.8, 52.07), p(60.96, 52.07)]
    ])
    expect(dots(doc)).toEqual([[mmToNm(50.8), mmToNm(52.07)]])
    expect(doc.report.wiresSplit).toBe(1)
    expect(doc.report.junctionsAdded).toBe(1)
    // The broken wire keeps its uuid on the first half; the second is new.
    expect(doc.wires[0].uuid).toBe('w-40.64,52.07-60.96,52.07')
    expect(doc.wires[1].uuid).not.toBe(doc.wires[0].uuid)
  })

  test('the new half is written right after the wire it came from, same stroke', () => {
    const doc = edited(sheet(''), sheet([through, wire([20, 30], [30, 30])].join('\n')))
    const first = doc.text.indexOf('w-40.64,52.07-60.96,52.07')
    const second = doc.text.indexOf('(wire', first)
    const other = doc.text.indexOf('w-20,30-30,30')
    expect(second).toBeGreaterThan(first)
    expect(second).toBeLessThan(other)
    expect(doc.wires[1].width).toBe(doc.wires[0].width)
    expect(doc.wires[1].strokeType).toBe(doc.wires[0].strokeType)
  })

  test('a pin that already sat mid-wire before the edit is left alone', () => {
    // KiCad does not connect it, so a junction there would join a net unasked.
    const doc = edited(sheet(through), sheet([through, wire([20, 30], [30, 30])].join('\n')))
    expect(doc.wires).toHaveLength(2)
    expect(doc.junctions).toHaveLength(0)
    expect(doc.report.wiresSplit).toBe(0)
    // And a plain tidy never breaks a wire.
    expect(cleaned(through).wires).toHaveLength(1)
  })

  test('a part moved so its pin lands mid-wire breaks the wire there', () => {
    const away = sheet(through).replace('(at 50.8 55.88 0)', '(at 50.8 45.72 0)')
    const doc = edited(away, sheet(through))
    expect(doc.wires).toHaveLength(2)
    expect(dots(doc)).toEqual([[mmToNm(50.8), mmToNm(52.07)]])
  })

  test('a wire end teed onto a wire breaks the wire it lands on', () => {
    const host = wire([20, 30], [40, 30])
    const doc = edited(sheet(host), sheet([host, wire([30, 30], [30, 20])].join('\n')))
    expect(runs(doc)).toEqual([
      [p(20, 30), p(30, 30)],
      [p(30, 30), p(40, 30)],
      [p(30, 30), p(30, 20)]
    ])
    expect(dots(doc)).toEqual([[mmToNm(30), mmToNm(30)]])
  })

  test('a wire whose interior swallows a dangling end breaks there', () => {
    const stub = wire([30, 30], [30, 20])
    const doc = edited(sheet(stub), sheet([stub, wire([20, 30], [40, 30])].join('\n')))
    expect(doc.wires).toHaveLength(3)
    expect(dots(doc)).toEqual([[mmToNm(30), mmToNm(30)]])
  })

  test('a label on a new wire breaks nothing', () => {
    const label =
      '  (label "N" (at 30 30 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l"))'
    const doc = edited(sheet(label), sheet([label, wire([20, 30], [40, 30])].join('\n')))
    expect(doc.wires).toHaveLength(1)
    expect(doc.junctions).toHaveLength(0)
  })

  test('a dot put on a crossing breaks both wires there, as the junction tool does', () => {
    const crossing = [wire([20, 30], [40, 30]), wire([30, 20], [30, 40])].join('\n')
    const doc = edited(sheet(crossing), sheet([crossing, junction(30, 30)].join('\n')))
    expect(doc.wires).toHaveLength(4)
    expect(dots(doc)).toEqual([[mmToNm(30), mmToNm(30)]])
    expect(doc.report.wiresSplit).toBe(2)
  })
})

describe('junctionNeededAt', () => {
  test('a part with stacked pins is one exit, so a wire ending on them earns no dot', () => {
    const stacked = parseKicadSchematic(
      sheet('').replace(
        '(number "1" (effects (font (size 1.27 1.27)))))',
        `(number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27)))))`
      )
    )
    const contacts = sheetContacts(stacked)
    expect(contacts.pins.filter((pin) => pin.y === mmToNm(52.07))).toHaveLength(1)
    expect(junctionNeededAt(p(50.8, 52.07), [[p(50.8, 52.07), p(50.8, 40)]], contacts)).toBe(false)
  })

  const contacts = sheetContacts(parseKicadSchematic(sheet('')))

  test('counts directions, not wire ends: a duplicate is one exit', () => {
    const at = p(50.8, 52.07)
    const twice = [
      [at, p(40.64, 52.07)],
      [p(40.64, 52.07), at]
    ]
    // Two identical wires leave leftwards, plus the pin: two exits.
    expect(junctionNeededAt(at, twice, contacts)).toBe(false)
    // A second direction makes three.
    expect(junctionNeededAt(at, [...twice, [at, p(60.96, 52.07)]], contacts)).toBe(true)
  })

  test('a pin on a wire interior is a junction; a crossing is not', () => {
    const through = [[p(40, 52.07), p(60, 52.07)]]
    expect(junctionNeededAt(p(50.8, 52.07), through, contacts)).toBe(true)
    const crossing = [
      [p(40, 30), p(60, 30)],
      [p(50, 20), p(50, 40)]
    ]
    expect(junctionNeededAt(p(50, 30), crossing, contacts)).toBe(false)
    // Something ending there breaks the crossing into four exits.
    expect(junctionNeededAt(p(50, 30), [...crossing, [p(50, 30), p(70, 50)]], contacts)).toBe(true)
  })
})

describe('routeContacts', () => {
  const wires = parseKicadSchematic(
    sheet([wire([20, 30], [40, 30]), wire([30, 30], [30, 10]), wire([60, 30], [60, 50])].join('\n'))
  ).wires

  test('names the wires a route overlaps, lands on, and is teed by', () => {
    // Wire 1 ends at (30, 30), which lies inside this route: a tee as well.
    expect(routeContacts(wires, [p(25, 30), p(35, 30)])).toEqual({
      overlapping: [0],
      landing: [],
      teed: [1]
    })
    expect(routeContacts(wires, [p(30, 40), p(30, 30)])).toEqual({
      overlapping: [],
      landing: [0, 1],
      teed: []
    })
    expect(routeContacts(wires, [p(50, 30), p(70, 30)])).toEqual({
      overlapping: [],
      landing: [],
      teed: [2]
    })
  })
})

describe('cleanupSchematic: buses, on their own layer', () => {
  const bus = (a: [number, number], b: [number, number]): string =>
    `  (bus (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "b-${a}-${b}"))`
  const entry = (x: number, y: number): string =>
    `  (bus_entry (at ${x} ${y}) (size 2.54 2.54) (stroke (width 0) (type default)) (uuid "e-${x}-${y}"))`
  const busRuns = (doc: { buses: { points: Point[] }[] }): Point[][] =>
    doc.buses.map((b) => b.points)

  test('two collinear buses meeting end to end merge, and a bus inside another goes', () => {
    const doc = cleaned([bus([100, 20], [110, 20]), bus([110, 20], [120, 20])].join('\n'))
    expect(busRuns(doc)).toEqual([[p(100, 20), p(120, 20)]])
    const inside = cleaned([bus([100, 20], [120, 20]), bus([105, 20], [110, 20])].join('\n'))
    expect(busRuns(inside)).toEqual([[p(100, 20), p(120, 20)]])
  })

  test('a bus never merges with a wire', () => {
    const doc = cleaned([bus([100, 20], [110, 20]), wire([110, 20], [120, 20])].join('\n'))
    expect(doc.buses).toHaveLength(1)
    expect(doc.wires).toHaveLength(1)
  })

  test('three buses meeting take a dot; an entry tapping a bus does not', () => {
    const tee = cleaned(
      [bus([100, 20], [110, 20]), bus([110, 20], [120, 20]), bus([110, 20], [110, 30])].join('\n')
    )
    expect(tee.junctions.map((j) => ({ x: j.x, y: j.y }))).toEqual([p(110, 20)])
    const tapped = cleaned([bus([100, 20], [120, 20]), entry(110, 20)].join('\n'))
    expect(tapped.junctions).toEqual([])
    expect(busRuns(tapped)).toEqual([[p(100, 20), p(120, 20)]])
  })

  test('a bus teed into another breaks it there, as a wire does', () => {
    const before = parseKicadSchematic(sheet(bus([100, 20], [120, 20])))
    const doc = parseKicadSchematic(
      sheet([bus([100, 20], [120, 20]), bus([110, 20], [110, 30])].join('\n'))
    )
    const report = cleanupSchematic(doc, connectionShape(before))
    const after = parseKicadSchematic(serializeKicadSchematic(doc))
    expect(report.wiresSplit).toBe(1)
    expect(after.buses).toHaveLength(3)
    expect(after.junctions.map((j) => ({ x: j.x, y: j.y }))).toEqual([p(110, 20)])
  })
})
