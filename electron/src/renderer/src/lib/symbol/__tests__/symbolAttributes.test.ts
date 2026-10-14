import { describe, expect, it } from 'vitest'
import {
  parseKicadSymbolLibrary,
  serializeKicadSymbolLibrary,
  type KicadSymbolLibrary
} from '../../kicad/symbolLibrary'
import { mmToNm as mm } from '../../kicad/coordinates'
import { findChild, getToken, type SExprList } from '../../kicad/sexpr'
import type { SymbolVariant } from '../../kicad/schematic'
import {
  moveSymbolAnchor,
  normalizeFootprintFilters,
  setSymbolFlag,
  setSymbolFootprintFilters,
  setSymbolPowerKind,
  setSymbolUnitName,
  setSymbolUnitsInterchangeable,
  symbolUnitName
} from '../symbolEdit'
import { buildSymbolGroups, powerKindOf } from '../symbolPropertySchema'

const DUAL = `(kicad_symbol_lib
  (version 20251024)
  (generator "kicad_symbol_editor")
  (symbol "DUAL"
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (property "Reference" "U" (at 1.27 2.54 0) (effects (font (size 1.27 1.27))))
    (property "ki_keywords" "dual" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
    (symbol "DUAL_0_1"
      (rectangle (start -5 5) (end 5 -5)
        (stroke (width 0.254) (type default)) (fill (type none)))
    )
    (symbol "DUAL_1_1"
      (unit_name "NMOS")
      (pin passive line (at 0 7.62 270) (length 2.54)
        (name "A" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
    )
    (symbol "DUAL_2_1"
      (pin passive line (at 0 -7.62 90) (length 2.54)
        (name "B" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))
    )
    (symbol "DUAL_2_2"
      (polyline (pts (xy 0 0) (xy 1.27 1.27))
        (stroke (width 0.254) (type default)) (fill (type none)))
    )
  )
)
`

const load = (): KicadSymbolLibrary => parseKicadSymbolLibrary(DUAL)
const nodeOf = (lib: KicadSymbolLibrary): SExprList => lib.symbols.get('DUAL')!._node
/** Edit, then serialize and read back — what the command layer does. */
const applied = (mutate: (node: SExprList) => void): KicadSymbolLibrary => {
  const lib = load()
  mutate(nodeOf(lib))
  return parseKicadSymbolLibrary(serializeKicadSymbolLibrary(lib))
}
const t = (key: string): string => key

describe('KiCad 9 symbol flags', () => {
  it('reads the defaults when the tokens are absent', () => {
    const def = load().symbols.get('DUAL')!
    expect(def.inPosFiles).toBe(true)
    expect(def.duplicatePinNumbersAreJumpers).toBe(false)
    expect(def.unitsLocked).toBe(false)
    expect(def.isLocalPower).toBe(false)
  })

  it('writes a new flag in the header, ahead of the properties', () => {
    const lib = applied((node) => {
      setSymbolFlag(node, 'in_pos_files', false)
      setSymbolFlag(node, 'duplicate_pin_numbers_are_jumpers', true)
    })
    const def = lib.symbols.get('DUAL')!
    expect(def.inPosFiles).toBe(false)
    expect(def.duplicatePinNumbersAreJumpers).toBe(true)
    const tokens = def._node.children.map((child) =>
      child.type === 'list' ? getToken(child) : null
    )
    expect(tokens.indexOf('in_pos_files')).toBeLessThan(tokens.indexOf('property'))
    expect(tokens.indexOf('duplicate_pin_numbers_are_jumpers')).toBeLessThan(
      tokens.indexOf('property')
    )
  })

  it('updates an existing flag in place', () => {
    const lib = applied((node) => setSymbolFlag(node, 'in_bom', false))
    expect(lib.symbols.get('DUAL')!.inBom).toBe(false)
    expect(serializeKicadSymbolLibrary(lib).match(/in_bom/g)).toHaveLength(1)
  })
})

describe('power symbol kind', () => {
  it('makes a global port with the bare token every version reads, after the name', () => {
    const lib = applied((node) => setSymbolPowerKind(node, 'global'))
    const def = lib.symbols.get('DUAL')!
    expect(powerKindOf(def)).toBe('global')
    expect(serializeKicadSymbolLibrary(lib)).toContain('(symbol "DUAL"\n\t\t(power)\n')
  })

  it('scopes a port to its sheet with (power local), and back', () => {
    const local = applied((node) => setSymbolPowerKind(node, 'local'))
    expect(powerKindOf(local.symbols.get('DUAL')!)).toBe('local')
    const node = nodeOf(local)
    setSymbolPowerKind(node, 'global')
    const back = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(local))
    expect(powerKindOf(back.symbols.get('DUAL')!)).toBe('global')
    expect(serializeKicadSymbolLibrary(back)).not.toContain('local')
  })

  it("keeps KiCad 10's (power global) as written when it stays global", () => {
    const source = DUAL.replace('(symbol "DUAL"\n', '(symbol "DUAL"\n    (power global)\n')
    const lib = parseKicadSymbolLibrary(source)
    expect(powerKindOf(lib.symbols.get('DUAL')!)).toBe('global')
    const before = serializeKicadSymbolLibrary(lib)
    setSymbolPowerKind(nodeOf(lib), 'global')
    expect(serializeKicadSymbolLibrary(lib)).toBe(before)
    expect(before).toContain('(power global)')
  })

  it('removes the marker for none', () => {
    const lib = applied((node) => {
      setSymbolPowerKind(node, 'local')
      setSymbolPowerKind(node, 'none')
    })
    expect(powerKindOf(lib.symbols.get('DUAL')!)).toBe('none')
  })
})

describe('units interchangeable', () => {
  it('stores "not interchangeable" as a hidden ki_locked property', () => {
    const lib = applied((node) => setSymbolUnitsInterchangeable(node, false))
    const def = lib.symbols.get('DUAL')!
    expect(def.unitsLocked).toBe(true)
    const locked = def.properties.find((property) => property.key === 'ki_locked')!
    expect(locked.value).toBe('')
    expect(locked.hidden).toBe(true)
  })

  it('removes it again, and adds it only once', () => {
    const lib = applied((node) => {
      setSymbolUnitsInterchangeable(node, false)
      setSymbolUnitsInterchangeable(node, false)
    })
    expect(serializeKicadSymbolLibrary(lib).match(/ki_locked/g)).toHaveLength(1)
    setSymbolUnitsInterchangeable(nodeOf(lib), true)
    expect(serializeKicadSymbolLibrary(lib)).not.toContain('ki_locked')
  })
})

describe('footprint filters', () => {
  it('normalizes whitespace the way KiCad splits it', () => {
    expect(normalizeFootprintFilters('  R_*\n  Resistor*   ')).toBe('R_* Resistor*')
  })

  it('writes a hidden ki_fp_filters, updates it, and drops it when emptied', () => {
    const lib = applied((node) => setSymbolFootprintFilters(node, 'SOIC* TSSOP*'))
    const property = lib.symbols.get('DUAL')!.properties.find((p) => p.key === 'ki_fp_filters')!
    expect(property.value).toBe('SOIC* TSSOP*')
    expect(property.hidden).toBe(true)
    setSymbolFootprintFilters(nodeOf(lib), 'DIP*')
    const updated = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(lib))
    expect(
      updated.symbols.get('DUAL')!.properties.find((p) => p.key === 'ki_fp_filters')!.value
    ).toBe('DIP*')
    setSymbolFootprintFilters(nodeOf(updated), '   ')
    expect(serializeKicadSymbolLibrary(updated)).not.toContain('ki_fp_filters')
  })
})

describe('unit names', () => {
  it('renames, names and clears a unit in every body style that has it', () => {
    const lib = applied((node) => {
      setSymbolUnitName(node, 1, 'N-channel')
      setSymbolUnitName(node, 2, 'PMOS')
    })
    const node = nodeOf(lib)
    expect(symbolUnitName(node, 1)).toBe('N-channel')
    expect(symbolUnitName(node, 2)).toBe('PMOS')
    // Unit 2 has two body styles; KiCad writes the name into each.
    expect(serializeKicadSymbolLibrary(lib).match(/unit_name "PMOS"/g)).toHaveLength(2)
    setSymbolUnitName(node, 2, '')
    expect(symbolUnitName(node, 2)).toBeNull()
  })

  it('writes the name right after the sub-symbol name, where KiCad puts it', () => {
    const lib = applied((node) => setSymbolUnitName(node, 2, 'PMOS'))
    const unit = nodeOf(lib).children.find(
      (child) =>
        child.type === 'list' &&
        child.children[1]?.type === 'atom' &&
        child.children[1].value === 'DUAL_2_1'
    ) as SExprList
    expect(getToken(unit.children[2] as SExprList)).toBe('unit_name')
  })
})

describe('moveSymbolAnchor', () => {
  it('shifts every part of every unit and style, and the fields, the other way', () => {
    const lib = applied((node) => {
      expect(moveSymbolAnchor(node, { x: mm(1.27), y: mm(2.54) })).toBe(true)
    })
    const def = lib.symbols.get('DUAL')!
    const variant = (unit: number, style: number): SymbolVariant =>
      def.variants.find((v) => v.unit === unit && v.style === style)!
    expect(variant(1, 1).pins[0].position).toMatchObject({ x: mm(-1.27), y: mm(5.08) })
    expect(variant(2, 1).pins[0].position).toMatchObject({ x: mm(-1.27), y: mm(-10.16) })
    expect(variant(0, 1).graphics[0]).toMatchObject({
      start: { x: mm(-6.27), y: mm(2.46) },
      end: { x: mm(3.73), y: mm(-7.54) }
    })
    expect(variant(2, 2).graphics[0]).toMatchObject({
      points: [
        { x: mm(-1.27), y: mm(-2.54) },
        { x: 0, y: mm(-1.27) }
      ]
    })
    const reference = def.properties.find((p) => p.key === 'Reference')!
    expect(reference.position).toMatchObject({ x: 0, y: 0 })
  })

  it("leaves KiCad's non-field ki_ properties at the origin", () => {
    const lib = applied((node) => void moveSymbolAnchor(node, { x: mm(1.27), y: mm(1.27) }))
    const keywords = lib.symbols.get('DUAL')!.properties.find((p) => p.key === 'ki_keywords')!
    expect(keywords.position).toMatchObject({ x: 0, y: 0 })
  })

  it('does nothing for the origin itself', () => {
    const lib = load()
    const before = serializeKicadSymbolLibrary(lib)
    expect(moveSymbolAnchor(nodeOf(lib), { x: mm(0), y: mm(0) })).toBe(false)
    expect(serializeKicadSymbolLibrary(lib)).toBe(before)
  })
})

describe('root panel rows', () => {
  it('lists the new attributes, and a Units group on a symbol with gates', () => {
    const def = load().symbols.get('DUAL')!
    const groups = buildSymbolGroups(def, [], t, { unit: 1 })
    const attributes = groups.find((g) => g.type === 'symbolAttributes')!
    expect(attributes.fields.map((f) => f.key)).toEqual([
      'inBom',
      'onBoard',
      'inPosFiles',
      'excludeFromSim',
      'duplicatePinNumbersAreJumpers',
      'power'
    ])
    expect(attributes.fields.find((f) => f.key === 'power')!.value).toBe('none')
    const units = groups.find((g) => g.type === 'symbolUnits')!
    expect(units.fields.find((f) => f.key === 'unitName')!.value).toBe('NMOS')
    expect(units.fields.find((f) => f.key === 'unitsInterchangeable')!.value).toBe(true)
    const definition = groups.find((g) => g.type === 'symbolDefinition')!
    expect(definition.fields.find((f) => f.key === 'fpFilters')!.value).toBe('')
  })

  it('names the unit on screen', () => {
    const def = load().symbols.get('DUAL')!
    const groups = buildSymbolGroups(def, [], t, { unit: 2 })
    const units = groups.find((g) => g.type === 'symbolUnits')!
    expect(units.fields.find((f) => f.key === 'unitName')!.value).toBe('')
  })

  it('has no Units group on a single-unit symbol', () => {
    const lib = parseKicadSymbolLibrary(
      DUAL.replace(
        /\(symbol "DUAL_2_1"[\s\S]*?\n {4}\)\n {4}\(symbol "DUAL_2_2"[\s\S]*?\n {4}\)\n/,
        ''
      )
    )
    const def = lib.symbols.get('DUAL')!
    expect(findChild(def._node, 'symbol')).not.toBeNull()
    expect(buildSymbolGroups(def, [], t).some((g) => g.type === 'symbolUnits')).toBe(false)
  })
})
