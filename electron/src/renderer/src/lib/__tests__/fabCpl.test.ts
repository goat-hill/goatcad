import { describe, it, expect } from 'vitest'
import { parseKicadBoard } from '../kicad/board'
import {
  boardCplComponents,
  componentsForCpl,
  buildCplRows,
  positionsMatrix,
  type CplOptions
} from '../fabCpl'

// A board with: a front SMD part, a back part (rotated), a DNP part, a
// graphic-only mounting hole (board_only), and a ref-less footprint.
const BOARD = `
(kicad_pcb (version 20221018) (generator pcbnew)
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "")
  (footprint "Resistor_SMD:R_0603" (layer "F.Cu") (at 10 10 90)
    (property "Reference" "R1" (at 0 0))
    (property "Value" "10k" (at 0 0))
    (pad "1" smd rect (at -0.8 0 90) (size 0.9 0.8) (layers "F.Cu")))
  (footprint "Package_QFN:QFN-32" (layer "B.Cu") (at 20 15 180)
    (property "Reference" "U1" (at 0 0))
    (property "Value" "MCU" (at 0 0))
    (pad "1" smd rect (at -2 0) (size 0.3 0.9) (layers "B.Cu")))
  (footprint "Resistor_SMD:R_0603" (layer "F.Cu") (at 5 5)
    (attr dnp)
    (property "Reference" "R2" (at 0 0))
    (property "Value" "DNP" (at 0 0))
    (pad "1" smd rect (at -0.8 0) (size 0.9 0.8) (layers "F.Cu")))
  (footprint "MountingHole:MountingHole_3.2mm" (layer "F.Cu") (at 1 1)
    (attr board_only)
    (property "Reference" "H1" (at 0 0)))
  (footprint "Fiducial" (layer "F.Cu") (at 2 2)
    (property "Reference" "" (at 0 0))))
`

const board = parseKicadBoard(BOARD)
const all = boardCplComponents(board.footprints)

const opts = (over: Partial<CplOptions> = {}): CplOptions => ({
  units: 'mm',
  side: 'both',
  includeDnp: false,
  ...over
})

describe('boardCplComponents', () => {
  it('reads placement, side, and rotation; skips ref-less footprints', () => {
    // R1, U1, R2, H1 have refs; the fiducial does not.
    const refs = all.map((c) => c.reference).sort()
    expect(refs).toEqual(['H1', 'R1', 'R2', 'U1'])

    const r1 = all.find((c) => c.reference === 'R1')!
    expect(r1).toMatchObject({ x: 10, y: 10, rotation: 90, side: 'top', value: '10k' })

    const u1 = all.find((c) => c.reference === 'U1')!
    expect(u1).toMatchObject({ side: 'bottom', rotation: 180 })
  })

  it('flags DNP and board_only exclusions', () => {
    expect(all.find((c) => c.reference === 'R2')!.flags.dnp).toBe(true)
    expect(all.find((c) => c.reference === 'H1')!.flags.excludeFromPos).toBe(true)
  })
})

describe('componentsForCpl', () => {
  it('drops board_only and DNP by default', () => {
    const refs = componentsForCpl(all, opts()).map((c) => c.reference)
    expect(refs).toEqual(['R1', 'U1']) // H1 excluded, R2 dnp
  })

  it('includes DNP when asked', () => {
    const refs = componentsForCpl(all, opts({ includeDnp: true })).map((c) => c.reference)
    expect(refs).toEqual(['R1', 'R2', 'U1'])
  })

  it('filters to one side', () => {
    const refs = componentsForCpl(all, opts({ side: 'front' })).map((c) => c.reference)
    expect(refs).toEqual(['R1']) // U1 is on the bottom
  })
})

describe('buildCplRows / positionsMatrix', () => {
  it('emits y-up coordinates, layer, and normalized rotation', () => {
    const rows = buildCplRows(all, opts())
    const r1 = rows.find((r) => r.designator === 'R1')!
    expect(r1.midX).toBe('10')
    expect(r1.midY).toBe('-10') // y-up: KiCad +y (down) → -y
    expect(r1.layer).toBe('Top')
    expect(r1.rotation).toBe('90')

    const u1 = rows.find((r) => r.designator === 'U1')!
    expect(u1.layer).toBe('Bottom')
  })

  it('converts to mil when the profile asks', () => {
    const rows = buildCplRows(all, opts({ units: 'mil' }))
    const r1 = rows.find((r) => r.designator === 'R1')!
    // 10 mm = 393.7 mil
    expect(parseFloat(r1.midX)).toBeCloseTo(393.7, 1)
  })

  it('writes the columns it is given, a row per placement', () => {
    const matrix = positionsMatrix(all, {
      columns: [
        { label: 'Designator', field: 'reference' },
        { label: 'Mid X', field: 'x' },
        { label: 'Layer', field: 'side' }
      ]
    })
    expect(matrix).toEqual([
      ['Designator', 'Mid X', 'Layer'],
      ['R1', '10', 'Top'],
      ['U1', expect.any(String), 'Bottom']
    ])
  })

  it("defaults to KiCad's position-file columns, the footprint without its library", () => {
    const matrix = positionsMatrix(all, {})
    expect(matrix[0]).toEqual(['Ref', 'Val', 'Package', 'PosX', 'PosY', 'Rot', 'Side'])
    expect(matrix[1].slice(0, 2)).toEqual(['R1', '10k'])
    expect(matrix[1][2]).not.toContain(':')
  })
})
