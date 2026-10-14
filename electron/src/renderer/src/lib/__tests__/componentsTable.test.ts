import { describe, expect, test } from 'vitest'
import { parseKicadSchematic } from '../kicad/schematic'
import {
  BOM_FIELD_MODEL,
  bomFieldNames,
  buildComponentRecords,
  buildRows,
  canonicalBomField,
  collectCustomFieldNames,
  compareReferencesNatural,
  compressReferences,
  defaultBomSettings,
  planBomUpdate,
  projectBom,
  reconcileBomSettings,
  unknownBomFields,
  type ComponentRecord
} from '../componentsTable'

const symbolBlock = (
  reference: string,
  value: string,
  options: { libId?: string; unit?: number; extra?: string; fields?: Record<string, string> } = {}
): string => {
  const fields = Object.entries(options.fields ?? {})
    .map(([key, fieldValue]) => `(property "${key}" "${fieldValue}" (at 0 0 0))`)
    .join('\n    ')
  return `(symbol
    (lib_id "${options.libId ?? 'Device:R'}")
    (at 50.8 55.88 0)
    (unit ${options.unit ?? 1})
    ${options.extra ?? ''}
    (property "Reference" "${reference}" (at 0 0 0))
    (property "Value" "${value}" (at 0 0 0))
    ${fields})`
}

const records = (...symbols: string[]): ComponentRecord[] =>
  buildComponentRecords(
    parseKicadSchematic(`(kicad_sch (version 20231120)\n${symbols.join('\n')}\n)`)
  )

describe('component records', () => {
  test('excludes power symbols and # references, coalesces multi-unit parts', () => {
    const result = records(
      symbolBlock('R1', '10k'),
      symbolBlock('#PWR01', 'GND', { libId: 'power:GND' }),
      symbolBlock('U1', 'LM324', { unit: 1 }),
      symbolBlock('U1', 'LM324', { unit: 2, extra: '(dnp yes)' })
    )
    expect(result.map((record) => record.reference)).toEqual(['R1', 'U1'])
    const u1 = result.find((record) => record.reference === 'U1')!
    expect(u1.locations).toHaveLength(2)
    expect(u1.flags.dnp).toBe(true) // OR across units
    expect(u1.flags.excludeFromBom).toBe(false)
  })

  test('captures custom fields and flag defaults', () => {
    const result = records(symbolBlock('R1', '10k', { fields: { MPN: 'RC0603FR-0710KL' } }))
    expect(result[0].fields.MPN).toBe('RC0603FR-0710KL')
    expect(result[0].flags).toEqual({ dnp: false, excludeFromBom: false, excludeFromBoard: false })
    expect(collectCustomFieldNames(result)).toEqual(['MPN'])
  })
})

describe('reference utilities', () => {
  test('natural ordering', () => {
    expect(['R10', 'R2', 'R1'].sort(compareReferencesNatural)).toEqual(['R1', 'R2', 'R10'])
  })

  test('compresses consecutive references into ranges', () => {
    expect(compressReferences(['R1', 'R3', 'R4', 'R5'])).toBe('R1, R3-R5')
    expect(compressReferences(['C2', 'C1', 'R1'])).toBe('C1-C2, R1')
    expect(compressReferences(['XTAL', 'R1', 'R2'])).toBe('R1-R2, XTAL')
  })
})

describe('row building', () => {
  const fourResistors = (): ComponentRecord[] =>
    records(
      symbolBlock('R1', '10k', { fields: { Footprint: 'R_0603' } }),
      symbolBlock('R2', '10k', { fields: { Footprint: 'R_0603' } }),
      symbolBlock('R3', '4.7k', { fields: { Footprint: 'R_0603' } }),
      symbolBlock('R10', '10k', { fields: { Footprint: 'R_0805' } })
    )

  test('ungrouped rows sort naturally by reference', () => {
    const rows = buildRows(fourResistors(), defaultBomSettings([]), new Set())
    expect(rows.map((row) => row.referenceLabel)).toEqual(['R1', 'R2', 'R3', 'R10'])
    expect(rows[0].values.Value).toBe('10k')
  })

  test('groups by value+footprint with mixed markers and expansion', () => {
    const settings = defaultBomSettings([])
    settings.group_symbols = true
    settings.fields_ordered = settings.fields_ordered.map((field) => ({
      ...field,
      group_by: field.name === 'Value' || field.name === 'Footprint'
    }))
    const rows = buildRows(fourResistors(), settings, new Set())
    const group = rows.find((row) => row.isGroup)!
    expect(group.referenceLabel).toBe('R1-R2')
    expect(group.count).toBe(2)
    expect(group.values.Value).toBe('10k')
    expect(group.values.Reference).toBeNull()
    expect(group.children).toBeUndefined()

    const expanded = buildRows(fourResistors(), settings, new Set([group.key]))
    const expandedGroup = expanded.find((row) => row.isGroup)!
    expect(expandedGroup.children?.map((child) => child.referenceLabel)).toEqual(['R1', 'R2'])
  })

  test('grouping by value only marks differing footprints as mixed', () => {
    const settings = defaultBomSettings([])
    settings.group_symbols = true
    settings.fields_ordered = settings.fields_ordered.map((field) => ({
      ...field,
      group_by: field.name === 'Value'
    }))
    const rows = buildRows(fourResistors(), settings, new Set())
    const group = rows.find((row) => row.count === 3)!
    expect(group.referenceLabel).toBe('R1-R2, R10')
    expect(group.values.Footprint).toBeNull()
    expect(group.flags.dnp).toBe(false)
  })

  test('filters across shown fields case-insensitively', () => {
    const settings = { ...defaultBomSettings([]), filter_string: '0805' }
    const rows = buildRows(fourResistors(), settings, new Set())
    expect(rows.map((row) => row.referenceLabel)).toEqual(['R10'])
  })
})

describe('settings reconciliation', () => {
  test('appends new custom fields without disturbing saved config', () => {
    const saved = defaultBomSettings([])
    saved.fields_ordered = saved.fields_ordered.slice(0, 2) // first two columns only
    const reconciled = reconcileBomSettings(saved, ['MPN'])
    expect(reconciled.fields_ordered.map((field) => field.name).slice(0, 2)).toEqual([
      'Reference',
      'Sheet'
    ])
    expect(reconciled.fields_ordered.some((field) => field.name === 'MPN')).toBe(true)
    expect(reconciled.fields_ordered.some((field) => field.name === '${DNP}')).toBe(true)
    // Unchanged inputs return the same object (no spurious reactivity churn).
    const complete = defaultBomSettings(['MPN'])
    expect(reconcileBomSettings(complete, ['MPN'])).toBe(complete)
  })
})

describe('the BOM as data', () => {
  const parts = (): ComponentRecord[] =>
    records(
      symbolBlock('C1', '100nF', { fields: { Footprint: '~' } }),
      symbolBlock('C2', '100nF'),
      symbolBlock('C3', '10uF', { fields: { Footprint: 'C_0805', MPN: 'GRM21' } }),
      symbolBlock('R1', '10k', { extra: '(dnp yes)' })
    )

  test('filters on field values, reading "~" as empty', () => {
    const table = projectBom(parts(), {
      fields: ['Value'],
      where: [{ field: 'Footprint', match: 'empty' }]
    })
    expect(table.rows).toEqual([
      ['C1', '100nF'],
      ['C2', '100nF'],
      ['R1', '10k']
    ])
    expect(table).toMatchObject({ parts: 3, total: 3 })
  })

  test('groups, counts, and marks a column a group disagrees on as null', () => {
    const table = projectBom(parts(), { fields: ['Footprint', 'QUANTITY'], groupBy: ['Value'] })
    expect(table.columns).toEqual(['Reference', 'Footprint', '${QUANTITY}'])
    expect(table.rows).toEqual([
      ['C1-C2', null, 2],
      ['C3', 'C_0805', 1],
      ['R1', '', 1]
    ])
  })

  test('reads generated columns under either spelling, and matches wildcards over the whole value', () => {
    expect(canonicalBomField('DNP')).toBe('${DNP}')
    expect(canonicalBomField('${QUANTITY}')).toBe('${QUANTITY}')
    expect(canonicalBomField(' MPN ')).toBe('MPN')
    const capacitors = projectBom(parts(), {
      fields: ['DNP'],
      where: [{ field: 'Reference', match: 'matches', value: 'c?' }]
    })
    expect(capacitors.rows).toEqual([
      ['C1', 'no'],
      ['C2', 'no'],
      ['C3', 'no']
    ])
    const unpopulated = projectBom(parts(), {
      where: [{ field: 'DNP', match: 'equals', value: 'yes' }]
    })
    expect(unpopulated.rows.map((row) => row[0])).toEqual(['R1'])
  })

  test('a limit cuts rows and keeps the totals', () => {
    const table = projectBom(parts(), { limit: 2 })
    expect(table.rows).toHaveLength(2)
    expect(table).toMatchObject({ parts: 4, total: 4 })
    expect(table.columns).toEqual([
      'Reference',
      'Value',
      'Footprint',
      'Datasheet',
      'MPN',
      'Manufacturer'
    ])
  })

  test('knows its columns, the part-identity ones included before any part carries them', () => {
    expect(bomFieldNames(parts())).toEqual([
      'Reference',
      'Value',
      'Footprint',
      'Datasheet',
      'MPN',
      'Manufacturer',
      'Sheet',
      '${QUANTITY}',
      '${MODEL}',
      '${DNP}',
      '${EXCLUDE_FROM_BOM}',
      '${EXCLUDE_FROM_BOARD}'
    ])
    expect(unknownBomFields(parts(), ['Value', 'Manufacturer', 'QUANTITY', 'Mpn', 'LCSC'])).toEqual(
      ['Mpn', 'LCSC']
    )
  })

  test('an update plan names what it changes and every non-empty value it replaces', () => {
    const plan = planBomUpdate(
      parts(),
      { where: [{ field: 'Reference', match: 'matches', value: 'C*' }] },
      { fields: { Footprint: 'C_0402' } }
    )
    expect(plan.matched.map((record) => record.reference)).toEqual(['C1', 'C2', 'C3'])
    expect(plan.changed.map((record) => record.reference)).toEqual(['C1', 'C2', 'C3'])
    expect(plan.overwritten).toEqual([{ field: 'Footprint', was: 'C_0805', references: ['C3'] }])
  })

  test('an update plan leaves out parts that already match, and names references that do not exist', () => {
    const same = planBomUpdate(
      parts(),
      { references: ['C3', 'U9'] },
      { fields: { MPN: 'GRM21' }, dnp: false }
    )
    expect(same.changed).toEqual([])
    expect(same.missing).toEqual(['U9'])
    const flag = planBomUpdate(parts(), { references: ['R1'] }, { dnp: false })
    expect(flag.changed.map((record) => record.reference)).toEqual(['R1'])
  })
})

describe('a generated column a reader filled in', () => {
  // `bom.get` writes ${MODEL} onto the record so conditions and grouping reach
  // it; it must not then read back as a field the design itself carries.
  const withModel = (): ComponentRecord[] =>
    buildComponentRecords(
      parseKicadSchematic(
        `(kicad_sch (version 20231120) (generator eeschema) (uuid "s") (paper "A4")
           ${symbolBlock('C1', '100nF')}${symbolBlock('R1', '10k')})`
      )
    ).map((record) => ({
      ...record,
      fields: { ...record.fields, [BOM_FIELD_MODEL]: 'resolved' }
    }))

  test('is listed once, as generated, not twice', () => {
    const names = bomFieldNames(withModel())
    expect(names.filter((name) => name === BOM_FIELD_MODEL)).toHaveLength(1)
  })

  test('still filters and groups like any other column', () => {
    const table = projectBom(withModel(), {
      fields: ['MODEL'],
      where: [{ field: 'MODEL', match: 'equals', value: 'resolved' }]
    })
    expect(table.columns).toEqual(['Reference', BOM_FIELD_MODEL])
    expect(table.parts).toBe(withModel().length)
  })
})
