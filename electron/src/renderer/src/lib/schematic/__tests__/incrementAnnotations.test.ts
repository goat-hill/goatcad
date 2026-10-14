import { describe, expect, test } from 'vitest'
import { parseKicadSchematic } from '../../kicad/schematic'
import { planIncrementAnnotations, type AnnotateSource } from '../annotate'

const ROOT = '/root-uuid'
const CHILD = '/root-uuid/child-uuid'
const FILE = '/p/root.kicad_sch'

const sym = (reference: string, x: number, unit = 1, path = ROOT): string =>
  `(symbol (lib_id "Device:R") (at ${x} 0 0) (unit ${unit}) (uuid "${reference}-${unit}-${x}")
    (property "Reference" "${reference}" (at ${x} 0 0))
    (instances (project "p" (path "${path}" (reference "${reference}") (unit ${unit})))))`

const sheet = (...symbols: string[]): AnnotateSource[] => [
  {
    schematic: parseKicadSchematic(
      `(kicad_sch (version 20231120) (generator "test") (uuid "root-uuid") (lib_symbols) ${symbols.join(' ')})`
    ),
    sheetPath: ROOT,
    filePath: FILE
  }
]

const moves = (plan: ReturnType<typeof planIncrementAnnotations>): string[] =>
  plan.changes.map((change) => `${change.from}→${change.to}`)

describe("planIncrementAnnotations (KiCad's Increment Annotations From…)", () => {
  test('moves every designator of the prefix from the start up, and no other', () => {
    const scope = sheet(sym('R1', 0), sym('R3', 10), sym('R7', 20), sym('RV3', 30), sym('C3', 40))
    expect(moves(planIncrementAnnotations(scope, 'R3', 10))).toEqual(['R3→R13', 'R7→R17'])
  })

  test('moves each unit of a part, and leaves the unannotated alone', () => {
    const scope = sheet(sym('U2', 0, 1), sym('U2', 10, 2), sym('U?', 20))
    expect(moves(planIncrementAnnotations(scope, 'U1', 1))).toEqual(['U2→U3', 'U2→U3'])
  })

  test('a start with no number plans nothing', () => {
    const scope = sheet(sym('R1', 0))
    expect(planIncrementAnnotations(scope, 'R', 1).changes).toEqual([])
    expect(planIncrementAnnotations(scope, '', 1).changes).toEqual([])
  })

  test("reads each instance's own designator", () => {
    const [source] = sheet(sym('R5', 0, 1, CHILD))
    const plan = planIncrementAnnotations([{ ...source, sheetPath: CHILD }], 'R5', 2)
    expect(plan.changes).toEqual([
      { filePath: FILE, sheetPath: CHILD, symbolIndex: 0, from: 'R5', to: 'R7' }
    ])
  })
})
