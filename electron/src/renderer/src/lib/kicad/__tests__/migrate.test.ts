import { describe, expect, test } from 'vitest'
import { parseSExpr, serializeSExpr, type SExprList } from '../sexpr'
import { formatStatus, migrateToCurrent, moveLegacyInstances } from '../migrate'

const parse = (text: string): SExprList => parseSExpr(text) as SExprList
const migrated = (text: string): string => {
  const root = parse(text)
  migrateToCurrent(root)
  return serializeSExpr(root)
}

describe('formatStatus', () => {
  test.each([
    ['(kicad_sch (version 20231120))', 'older'],
    ['(kicad_sch (version 20260306))', 'current'],
    ['(kicad_sch (version 20260629))', 'newer'],
    ['(kicad_sch (version 20211014))', 'unsupported'],
    ['(kicad_pcb (version 20211014))', 'older'],
    ['(footprint "R" (version 20240108))', 'older'],
    ['(kicad_symbol_lib (version 20251024))', 'current']
  ])('%s is %s', (text, status) => {
    expect(formatStatus(parse(text))).toBe(status)
  })

  test('a document without a version, or not KiCad’s, has none', () => {
    expect(formatStatus(parse('(footprint "R" (layer "F.Cu"))'))).toBeNull()
    expect(formatStatus(parse('(fp_lib_table (version 7))'))).toBeNull()
  })
})

describe('migrateToCurrent', () => {
  test('stamps the current version on an older file', () => {
    expect(migrated('(kicad_sch (version 20231120) (generator "eeschema"))')).toContain(
      '(version 20260306)'
    )
  })

  test.each([
    '(kicad_sch (version 20260306))',
    '(kicad_sch (version 20260629))',
    '(kicad_pcb (version 20210126))'
  ])('leaves %s alone', (text) => {
    const root = parse(text)
    expect(migrateToCurrent(root)).toBe(false)
    expect(serializeSExpr(root)).toBe(serializeSExpr(parse(text)))
  })

  describe('footprint properties before PCB fields', () => {
    const legacy = `(footprint "R" (version 20221018) (layer "F.Cu")
      (property "MPN" "RC0603")
      (property "ki_description" "Resistor")
      (property "ki_keywords" "R res")
      (property "Sheetfile" "power.kicad_sch")
      (property "Sheetname" "Power"))`

    test('become hidden fields, and the reserved names what they stand for', () => {
      const text = migrated(legacy)
      expect(text).toMatch(/\(property "MPN" "RC0603"\s*\(hide yes\)\s*\)/)
      expect(text).toMatch(/\(property "Description" "Resistor"\s*\(at 0 0 0\)\s*\(hide yes\)\s*\)/)
      expect(text).not.toContain('ki_keywords')
      expect(text).toContain('(sheetfile "power.kicad_sch")')
      expect(text).toContain('(sheetname "Power")')
    })

    test('inside a board, every footprint, its own fields turned with it', () => {
      const text = migrated(`(kicad_pcb (version 20221018)
        (footprint "R" (layer "F.Cu") (at 10 20 180) (property "ki_description" "A"))
        (footprint "C" (layer "F.Cu") (at 5 5) (property "MPN" "B")))`)
      expect(text.match(/\(hide yes\)/g)).toHaveLength(2)
      expect(text).toMatch(/\(property "Description" "A"\s*\(at 0 0 180\)/)
      expect(text).toMatch(/\(property "MPN" "B"\s*\(hide yes\)/)
    })

    test('a file from PCB fields on keeps its properties as they are', () => {
      const text = migrated(`(footprint "R" (version 20240108) (layer "F.Cu")
        (property "MPN" "RC0603" (at 0 0 0) (layer "F.Fab")))`)
      expect(text).not.toContain('hide')
    })
  })

  describe('symbol libraries', () => {
    test('a lone ~ becomes empty text before 20250318, and stays literal after', () => {
      const lib = (version: number): string =>
        migrated(`(kicad_symbol_lib (version ${version})
          (symbol "R" (property "Datasheet" "~")
            (symbol "R_1_1" (pin passive line (at 0 0 0) (length 1)
              (name "~" (effects)) (number "~" (effects))))))`)
      expect(lib(20241209)).not.toContain('"~"')
      expect(lib(20250324).match(/"~"/g)).toHaveLength(3)
    })

    test('a symbol drawing a second body style, or extending one that does, is De Morgan', () => {
      const text = migrated(`(kicad_symbol_lib (version 20241209)
        (symbol "NAND" (symbol "NAND_1_1") (symbol "NAND_1_2"))
        (symbol "NAND_ALT" (extends "NAND"))
        (symbol "R" (power) (symbol "R_1_1")))`)
      expect(text.match(/\(body_styles demorgan\)/g)).toHaveLength(2)
      expect(text).toMatch(/\(symbol "NAND"\s*\(body_styles demorgan\)/)
      expect(text).toMatch(/\(extends "NAND"\)\s*\(body_styles demorgan\)/)
    })
  })
})

describe('moveLegacyInstances', () => {
  const R = '00000000-0000-0000-0000-0000000000a0'
  const S = '00000000-0000-0000-0000-0000000000b0'
  const S2 = '00000000-0000-0000-0000-0000000000b1'
  const U1 = '00000000-0000-0000-0000-0000000000c0'
  const U2 = '00000000-0000-0000-0000-0000000000c1'
  const symbol = (uuid: string): string => `(symbol (lib_id "Device:R") (at 0 0 0) (unit 1)
    (uuid "${uuid}")
    (property "Reference" "R?" (id 0) (at 0 0 0))
    (property "Value" "~" (id 1) (at 0 0 0))
    (property "Footprint" "" (id 2) (at 0 0 0)))`
  const sheet = (uuid: string): string => `(sheet (at 0 0) (size 10 10) (uuid "${uuid}")
    (property "Sheet name" "Power" (id 0) (at 0 0 0))
    (property "Sheet file" "power.kicad_sch" (id 1) (at 0 0 0)))`

  test('a KiCad 6 root gives each placed symbol its instance, reference and value', () => {
    const root = parse(`(kicad_sch (version 20211123) (uuid "${R}") ${symbol(U1)}
      (sheet_instances (path "/" (page "1")))
      (symbol_instances (path "/${U1}" (reference "R1") (unit 1) (value "10k") (footprint "R_0603"))))`)
    expect(moveLegacyInstances(root, 'demo', () => undefined)).toEqual([root])
    migrateToCurrent(root)
    const text = serializeSExpr(root)
    expect(text).toMatch(
      new RegExp(
        `\\(instances\\s*\\(project "demo"\\s*\\(path "/${R}"\\s*\\(reference "R1"\\)\\s*\\(unit 1\\)`
      )
    )
    expect(text).toMatch(/\(property "Reference" "R1"/)
    expect(text).toMatch(/\(property "Value" "10k"/)
    expect(text).toMatch(/\(property "Footprint" "R_0603"/)
    expect(text).not.toContain('symbol_instances')
    expect(text).toMatch(/\(sheet_instances\s*\(path "\/"\s*\(page "1"\)/)
  })

  test('a sheet used twice gives its symbols one instance per path, and each sheet its page', () => {
    const child = parse(`(kicad_sch (version 20211123) (uuid "${U2}") ${symbol(U1)})`)
    const root = parse(`(kicad_sch (version 20211123) (uuid "${R}") ${sheet(S)} ${sheet(S2)}
      (sheet_instances (path "/" (page "1")) (path "/${S}" (page "2")) (path "/${S2}" (page "3")))
      (symbol_instances
        (path "/${S}/${U1}" (reference "R1") (unit 1) (value "10k") (footprint ""))
        (path "/${S2}/${U1}" (reference "R2") (unit 1) (value "10k") (footprint ""))))`)
    const changed = moveLegacyInstances(root, 'demo', (name) =>
      name === 'power.kicad_sch' ? child : undefined
    )
    expect(changed).toContain(child)
    const childText = serializeSExpr(child)
    expect(childText).toContain(`(path "/${R}/${S}"`)
    expect(childText).toContain(`(path "/${R}/${S2}"`)
    expect(childText.match(/\(project "demo"/g)).toHaveLength(1)
    const rootText = serializeSExpr(root)
    expect(rootText).toMatch(new RegExp(`\\(path "/${R}"\\s*\\(page "2"\\)`))
    expect(rootText).toMatch(new RegExp(`\\(path "/${R}"\\s*\\(page "3"\\)`))
    expect(rootText).not.toContain(`(path "/${S}"`)
  })

  test('between the two moves only page numbers move, from records that name the root', () => {
    const root = parse(`(kicad_sch (version 20221004) (uuid "${R}") ${sheet(S)}
      (sheet_instances (path "/${R}" (page "1")) (path "/${R}/${S}" (page "4"))))`)
    moveLegacyInstances(root, 'demo', () => undefined)
    const text = serializeSExpr(root)
    expect(text).toMatch(new RegExp(`\\(sheet\\s[\\s\\S]*\\(path "/${R}"\\s*\\(page "4"\\)`))
    expect(text).toMatch(/\(sheet_instances\s*\(path "\/"\s*\(page "1"\)\s*\)\s*\)/)
  })

  test('a root from 20221110 on is left alone', () => {
    const root = parse(
      `(kicad_sch (version 20230121) (uuid "${R}") (sheet_instances (path "/" (page "1"))))`
    )
    expect(moveLegacyInstances(root, 'demo', () => undefined)).toEqual([])
  })
})

describe('schematic steps before KiCad 7', () => {
  test('a legacy power symbol takes its hidden pin’s name as its Value', () => {
    const text = migrated(`(kicad_sch (version 20221206)
      (lib_symbols (symbol "power:+3.3V" (power)
        (symbol "+3.3V_0_1" (pin power_in line (at 0 0 90) (length 0) hide (name "VCC") (number "1")))))
      (symbol (lib_id "power:+3.3V") (at 0 0 0) (property "Value" "+3.3V" (at 0 0 0))))`)
    expect(text).toMatch(/\(property "Value" "VCC"/)
  })

  test('a symbol arc of exactly 180° is pulled to 179.5°, as KiCad 7 did on load', () => {
    const lib = (version: number): string =>
      migrated(`(kicad_symbol_lib (version ${version})
        (symbol "S" (symbol "S_0_1" (arc (start -1.27 0) (mid -0.635 0.635) (end 0 0)))))`)
    // KiCad 10's upgrade of the same arc from a 20220914 library (spice_netlists/sources).
    expect(lib(20220914)).toMatch(/\(mid -0\.635 0\.6323\)/)
    expect(lib(20230620)).toMatch(/\(mid -0\.635 0\.635\)/)
  })
})

describe('board steps', () => {
  test('plot layer masks move to KiCad 9’s ids before 20240819', () => {
    const text = migrated(`(kicad_pcb (version 20221018) (general (thickness 1.6))
      (setup (pcbplotparams (layerselection 0x00010fc_ffffffff)
        (plot_on_all_layers_selection 0x0000000_00000000))))`)
    // KiCad 10's upgrade of the same mask (pcbnew/unconnected-netnames).
    expect(text).toContain('(layerselection 0x00000000_00000000_55555555_5755f5ff)')
    expect(text).toContain('(plot_on_all_layers_selection 0x00000000_00000000_00000000_00000000)')
  })

  test('an older via says its protection is off; a later one inherits', () => {
    const via = '(via (at 0 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 0))'
    const older = migrated(`(kicad_pcb (version 20241229) ${via})`)
    expect(older).toMatch(/\(capping no\)/)
    expect(older).toMatch(/\(covering\s*\(front no\)\s*\(back no\)\s*\)/)
    expect(older).toMatch(/\(plugging\s*\(front no\)\s*\(back no\)\s*\)/)
    expect(older).toMatch(/\(filling no\)/)
    expect(migrated(`(kicad_pcb (version 20250302) ${via})`)).not.toContain('capping')
  })

  test('a KiCad 7 board with teardrop zones is marked as having legacy teardrops', () => {
    const board = (zoneAttr: string): string =>
      migrated(`(kicad_pcb (version 20221018) (general (thickness 1.6))
        (zone (net 0) (layer "F.Cu") ${zoneAttr} (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))))`)
    expect(board('(attr (teardrop (type padvia)))')).toMatch(/\(legacy_teardrops yes\)/)
    expect(board('')).not.toContain('legacy_teardrops')
  })
})
