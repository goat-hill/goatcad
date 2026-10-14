import { describe, test, expect } from 'vitest'
import {
  bomMatrix,
  resolvePartNumber,
  boardBomComponents,
  componentsForBom,
  dnpReferences,
  type FabBomComponent
} from '../fabBom'
import { parseKicadBoard } from '../kicad/board'

const comp = (
  reference: string,
  fields: Record<string, string>,
  flags: Partial<FabBomComponent['flags']> = {}
): FabBomComponent => ({
  reference,
  fields,
  flags: { dnp: false, excludeFromBom: false, ...flags }
})

describe('resolvePartNumber', () => {
  test('finds an LCSC field case-insensitively', () => {
    expect(resolvePartNumber({ 'LCSC Part #': 'C1525' }, 'LCSC')).toBe('C1525')
  })
  test('falls back to MPN when the preferred kind is absent', () => {
    expect(resolvePartNumber({ MPN: 'RC0402' }, 'LCSC')).toBe('RC0402')
  })
  test('prefers MPN for an MPN fab', () => {
    expect(resolvePartNumber({ LCSC: 'C1', MPN: 'RC0402' }, 'MPN')).toBe('RC0402')
  })
})

describe('bomMatrix', () => {
  const components = [
    comp('C1', { Value: '100nF', Footprint: 'Capacitor_SMD:C_0402', LCSC: 'C1525' }),
    comp('C2', { Value: '100nF', Footprint: 'Capacitor_SMD:C_0402', LCSC: 'C1525' }),
    comp('R1', { Value: '10k', Footprint: 'Resistor_SMD:R_0402', LCSC: 'C25744' }),
    comp('TP1', { Value: 'TestPoint' }, { excludeFromBom: true }),
    comp('D9', { Value: 'DNP-LED', Footprint: 'LED_0603' }, { dnp: true })
  ]

  const JLC_COLUMNS = [
    { label: 'Comment', field: 'Value' },
    { label: 'Designator', field: 'Reference' },
    { label: 'Footprint', field: 'Footprint' },
    { label: 'JLCPCB Part #', partNumber: 'LCSC' as const }
  ]
  const rowsOf = (matrix: string[][]): Array<Record<string, string>> =>
    matrix.slice(1).map((row) => Object.fromEntries(row.map((cell, i) => [matrix[0][i], cell])))

  test('writes the headers it is given, untranslated, first', () => {
    expect(bomMatrix(components, { columns: JLC_COLUMNS })[0]).toEqual([
      'Comment',
      'Designator',
      'Footprint',
      'JLCPCB Part #'
    ])
  })

  test('groups identical parts and joins designators without spaces', () => {
    const rows = rowsOf(bomMatrix(components, { columns: JLC_COLUMNS }))
    const caps = rows.find((r) => r.Comment === '100nF')!
    expect(caps.Designator).toBe('C1,C2')
    expect(caps.Footprint).toBe('C_0402')
    expect(caps['JLCPCB Part #']).toBe('C1525')
  })

  test('counts a group under Quantity and reads any field by name', () => {
    const rows = rowsOf(
      bomMatrix(components, {
        columns: [
          { label: 'Refs', field: 'Reference' },
          { label: 'Qty', field: 'Quantity' },
          { label: 'lcsc', field: 'lcsc' }
        ]
      })
    )
    expect(rows[0]).toEqual({ Refs: 'C1,C2', Qty: '2', lcsc: 'C1525' })
  })

  test("defaults to KiCad's fields and an MPN column", () => {
    expect(bomMatrix(components, {})[0]).toEqual(['Reference', 'Value', 'Footprint', 'Qty', 'MPN'])
  })

  test('componentsForBom and dnpReferences drive the stats and DNP list', () => {
    // 3 populated (C1, C2, R1); DNP D9 excluded from the BOM but listed as DNP.
    expect(componentsForBom(components, false)).toHaveLength(3)
    expect(componentsForBom(components, true)).toHaveLength(4)
    expect(dnpReferences(components)).toEqual(['D9'])
  })

  test('excludes exclude-from-BOM parts, and DNP unless included', () => {
    const off = rowsOf(bomMatrix(components, { columns: JLC_COLUMNS }))
    expect(off.some((r) => r.Comment === 'TestPoint')).toBe(false)
    expect(off.some((r) => r.Comment === 'DNP-LED')).toBe(false)

    const on = rowsOf(bomMatrix(components, { columns: JLC_COLUMNS, includeDnp: true }))
    expect(on.some((r) => r.Comment === 'DNP-LED')).toBe(true)
  })

  test('ungrouped keeps one row per reference, reference-sorted', () => {
    const rows = rowsOf(bomMatrix(components, { columns: JLC_COLUMNS, group: false }))
    expect(rows.map((r) => r.Designator)).toEqual(['C1', 'C2', 'R1'])
  })
})

describe('boardBomComponents', () => {
  // BOM comes from the board footprints, so an unsynced schematic never changes it.
  const board = parseKicadBoard(
    `(kicad_pcb (version 20240108)
      (footprint "Resistor_SMD:R_0402" (layer "F.Cu") (attr smd) (at 10 10)
        (property "Reference" "R1") (property "Value" "10k") (property "LCSC" "C25744"))
      (footprint "TestPoint:TP" (layer "F.Cu") (attr smd exclude_from_bom) (at 20 20)
        (property "Reference" "TP1") (property "Value" "TestPoint")))
`
  )

  test('reads reference/value/part# and the footprint identity from the board', () => {
    const comps = boardBomComponents(board.footprints)
    const r1 = comps.find((c) => c.reference === 'R1')!
    expect(r1.fields.Value).toBe('10k')
    expect(r1.fields.Footprint).toBe('Resistor_SMD:R_0402')
    expect(r1.fields.LCSC).toBe('C25744')
  })

  test('carries the exclude_from_bom attribute through', () => {
    const comps = boardBomComponents(board.footprints)
    expect(comps.find((c) => c.reference === 'TP1')!.flags.excludeFromBom).toBe(true)
    const matrix = bomMatrix(comps, { columns: [{ label: 'Comment', field: 'Value' }] })
    expect(matrix.flat()).not.toContain('TestPoint')
  })
})
