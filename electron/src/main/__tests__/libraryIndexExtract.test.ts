import { describe, it, expect } from 'vitest'
import {
  extractSymbols,
  extractFootprint,
  extractPlacedAssignments,
  topLevelSymbolBlocks
} from '../libraryIndexExtract'

const SYM_LIB = `(kicad_symbol_lib (version 20211014) (generator kicad_symbol_editor)
  (symbol "R" (pin_numbers hide) (pin_names (offset 0))
    (property "Reference" "R" (id 0))
    (property "Value" "R" (id 1))
    (property "Footprint" "" (id 2))
    (property "Datasheet" "~" (id 3))
    (property "ki_keywords" "R res resistor")
    (property "ki_description" "Resistor")
    (property "ki_fp_filters" "R_* R_0*")
    (symbol "R_0_1" (rectangle (start -1 2) (end 1 -2)))
    (symbol "R_1_1" (pin passive line (at 0 3 270) (length 1)))
  )
  (symbol "R_US" (extends "R")
    (property "Footprint" "Resistor_SMD:R_0402_1005Metric" (id 2))
  )
)`

const FOOTPRINT = `(footprint "R_0402_1005Metric" (version 20211014) (generator pcbnew)
  (layer "F.Cu")
  (descr "Resistor SMD 0402")
  (tags "resistor 0402")
  (attr smd)
  (pad "1" smd roundrect (at -0.5 0) (size 0.6 0.7))
  (pad "2" smd roundrect (at 0.5 0) (size 0.6 0.7))
  (model "\${KICAD8_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step" (offset (xyz 0 0 0)))
)`

const ctx = { library: 'Device', file: '/x/Device.kicad_sym', scope: 'system' as const }

describe('extractSymbols', () => {
  it('finds only top-level symbols, skipping nested unit sub-symbols', () => {
    expect(topLevelSymbolBlocks(SYM_LIB)).toHaveLength(2)
    const syms = extractSymbols(SYM_LIB, ctx)
    expect(syms.map((s) => s.name)).toEqual(['R', 'R_US'])
  })

  it('extracts reserved properties, footprint field, and filters', () => {
    const [r, rus] = extractSymbols(SYM_LIB, ctx)
    expect(r).toMatchObject({
      id: 'Device:R',
      isPower: false,
      value: 'R',
      keywords: 'R res resistor',
      description: 'Resistor',
      footprint: '',
      fpFilters: ['R_*', 'R_0*'],
      library: 'Device',
      scope: 'system',
      file: '/x/Device.kicad_sym'
    })
    // Derived symbol carries its overridden footprint.
    expect(rus.footprint).toBe('Resistor_SMD:R_0402_1005Metric')
  })

  it('flags (power) symbols, inherited through extends, ignoring quoted mentions', () => {
    const POWER_LIB = `(kicad_symbol_lib (version 20211014)
      (symbol "GND" (power) (pin_names (offset 0))
        (property "Reference" "#PWR" (id 0))
        (property "ki_description" "Global label for the (power) net GND")
      )
      (symbol "GNDA" (extends "GND"))
      (symbol "NotPower"
        (property "ki_description" "mentions (power) only inside a string")
      )
    )`
    const syms = extractSymbols(POWER_LIB, { ...ctx, library: 'power' })
    expect(syms.map((s) => [s.name, s.isPower])).toEqual([
      ['GND', true],
      ['GNDA', true],
      ['NotPower', false]
    ])
  })

  // KiCad 10 writes `(power global)`, and a pattern anchored on the bare
  // KiCad 9 form matched NONE of the 102 power symbols in the standard library
  // — the flag read false for all 22,784 indexed symbols. The chooser survived
  // only because it falls back to the `power:` nickname, which left a user's own
  // power symbols in any other library invisible to power mode.
  it('flags the KiCad 10 (power global) form, and its local variant', () => {
    const KICAD10 = `(kicad_symbol_lib (version 20251024)
      (symbol "+12V" (power global) (pin_numbers (hide yes)))
      (symbol "LOCAL_RAIL" (power local))
      (symbol "power_flag_lookalike" (power_flag))
    )`
    expect(
      extractSymbols(KICAD10, { ...ctx, library: 'power' }).map((s) => [s.name, s.isPower])
    ).toEqual([
      ['+12V', true],
      ['LOCAL_RAIL', true],
      ['power_flag_lookalike', false]
    ])
  })

  it('counts pins, inheriting the parent count for a derived symbol', () => {
    const [r, rus] = extractSymbols(SYM_LIB, ctx)
    expect(r.pins).toBe(1)
    // `R_US` extends `R` and draws nothing of its own; an uninherited 0 would
    // read as an answer rather than as an absence.
    expect(rus.pins).toBe(1)
  })

  it('does not count (pin_numbers) or (pin_names) as pins', () => {
    const LIB = `(kicad_symbol_lib (version 20251024)
      (symbol "U" (pin_numbers (hide yes)) (pin_names (offset 0))
        (property "ki_description" "mentions (pin 9) in prose")
        (symbol "U_1_1"
          (pin input line (at 0 0 0) (length 1))
          (pin output line (at 0 2 0) (length 1))
        )
      )
    )`
    expect(extractSymbols(LIB, ctx)[0].pins).toBe(2)
  })
})

describe('extractFootprint', () => {
  it('extracts header fields, pad count, and 3D model refs', () => {
    const fp = extractFootprint(FOOTPRINT, {
      ...ctx,
      library: 'Resistor_SMD',
      name: 'R_0402_1005Metric'
    })
    expect(fp).toMatchObject({
      type: 'footprint',
      id: 'Resistor_SMD:R_0402_1005Metric',
      name: 'R_0402_1005Metric',
      description: 'Resistor SMD 0402',
      tags: 'resistor 0402',
      pads: 2,
      padNumbers: 2
    })
    expect(fp.models).toEqual([
      '${KICAD8_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.step'
    ])
  })

  it('counts each numbered pad once, so an exposed pad’s via array does not', () => {
    const qfn = `(footprint "QFN-4"
  (pad "1" smd rect (at 0 0) (size 1 1))
  (pad "2" smd rect (at 1 0) (size 1 1))
  (pad "3" smd rect (at 2 0) (size 1 1))
  (pad "4" smd rect (at 3 0) (size 1 1))
  (pad "5" smd rect (at 1 1) (size 2 2))
  (pad "5" thru_hole circle (at 1 1) (size 0.5 0.5) (drill 0.3))
  (pad "5" thru_hole circle (at 2 1) (size 0.5 0.5) (drill 0.3))
  (pad "" np_thru_hole circle (at 5 5) (size 1 1) (drill 1))
)`
    const fp = extractFootprint(qfn, { ...ctx, library: 'Package_DFN_QFN', name: 'QFN-4' })
    expect(fp.pads).toBe(8)
    expect(fp.padNumbers).toBe(5)
  })

  it('takes its name from the file, not the header, as KiCad does', () => {
    const fp = extractFootprint(FOOTPRINT, { ...ctx, library: 'L', name: 'R_Renamed' })
    expect(fp).toMatchObject({ id: 'L:R_Renamed', name: 'R_Renamed' })
    expect(extractFootprint('(module malformed', { ...ctx, library: 'L', name: 'F' }).pads).toBe(0)
  })
})

const SCH = `(kicad_sch (version 20231120) (generator "goatcad")
  (lib_symbols
    (symbol "power:GND" (power) (pin_names (offset 0))
      (property "Value" "GND")
      (symbol "GND_0_1" (rectangle (start -1 2) (end 1 -2)))
    )
    (symbol "Device:R" (pin_numbers hide)
      (property "Value" "R")
      (property "ki_keywords" "resistor")
      (property "Footprint" "")
    )
  )
  (symbol (lib_id "Device:R") (at 100 100 0) (uuid "u1")
    (property "Reference" "R1") (property "Value" "10k")
    (property "Footprint" "Resistor_SMD:R_0402_1005Metric")
  )
  (symbol (lib_id "Device:R") (at 120 100 0) (uuid "u2")
    (property "Reference" "R2")
    (property "Footprint" "Resistor_SMD:R_0402_1005Metric")
  )
  (symbol (lib_id "power:GND") (at 100 120 0) (uuid "u3")
    (property "Reference" "#PWR01") (property "Footprint" "")
  )
)`

describe('embedded symbols (container = lib_symbols)', () => {
  it('scans only lib_symbols definitions, keying id/library/name off the lib_id', () => {
    const syms = extractSymbols(
      SCH,
      { library: '', file: '/p/main.kicad_sch', scope: 'project' },
      { container: 'lib_symbols', embedded: true }
    )
    expect(syms.map((s) => s.id)).toEqual(['power:GND', 'Device:R'])
    expect(syms[1]).toMatchObject({
      id: 'Device:R',
      name: 'R',
      library: 'Device',
      scope: 'project',
      keywords: 'resistor',
      file: '/p/main.kicad_sch'
    })
    expect(syms[0].isPower).toBe(true)
  })
})

describe('extractPlacedAssignments', () => {
  it('dedupes placed symbol → footprint pairs, skipping blank footprints', () => {
    expect(extractPlacedAssignments(SCH)).toEqual([
      { symbol: 'Device:R', footprint: 'Resistor_SMD:R_0402_1005Metric' }
    ])
  })
})
