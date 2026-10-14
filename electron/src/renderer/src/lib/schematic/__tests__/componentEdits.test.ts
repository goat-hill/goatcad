import { describe, expect, test } from 'vitest'
import {
  getSymbolProperty,
  parseKicadSchematic,
  serializeKicadSchematic
} from '../../kicad/schematic'
import { buildProjectComponentRecords } from '../../componentsTable'
import { fieldEdits, fieldListEdits, flagEdits } from '../componentEdits'

const sheet = (reference: string): string => `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "${reference}-sheet")
  (symbol
    (lib_id "Device:R")
    (at 50.8 55.88 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid "${reference}-uuid")
    (property "Reference" "${reference}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 0 0 0) (effects (font (size 1.27 1.27)))))
)`

const design = (): {
  records: ReturnType<typeof buildProjectComponentRecords>
  docs: Map<string, ReturnType<typeof parseKicadSchematic>>
} => {
  const docs = new Map([
    ['/p/main.kicad_sch', parseKicadSchematic(sheet('R1'))],
    ['/p/power.kicad_sch', parseKicadSchematic(sheet('R2'))]
  ])
  const records = buildProjectComponentRecords(
    [...docs].map(([filePath, schematic], index) => ({
      filePath,
      sheetPath: index === 0 ? '/' : '/power-sheet',
      sheetName: index === 0 ? '/' : '/Power/',
      schematic
    }))
  )
  return { records, docs }
}

describe('componentEdits', () => {
  test('a field edit reaches each record on the sheet it lives on', () => {
    const { records, docs } = design()
    const edits = fieldEdits(records, 'Value', '22k')
    expect(edits.map((edit) => edit.filePath).sort()).toEqual([
      '/p/main.kicad_sch',
      '/p/power.kicad_sch'
    ])
    for (const edit of edits) edit.apply(docs.get(edit.filePath)!.symbols[edit.symbolIndex])
    for (const doc of docs.values()) expect(getSymbolProperty(doc.symbols[0], 'Value')).toBe('22k')
  })

  test('a field list change reaches every unit, and refuses the mandatory five', () => {
    const { records, docs } = design()
    const run = (change: Parameters<typeof fieldListEdits>[1]): void => {
      for (const edit of fieldListEdits(records, change))
        edit.apply(docs.get(edit.filePath)!.symbols[edit.symbolIndex])
    }
    const keys = (): string[][] =>
      [...docs.values()].map((doc) => doc.symbols[0].properties.map((p) => p.key))
    run({ op: 'add', key: 'MPN' })
    run({ op: 'add', key: 'Tol' })
    expect(keys()).toEqual([
      ['Reference', 'Value', 'MPN', 'Tol'],
      ['Reference', 'Value', 'MPN', 'Tol']
    ])
    run({ op: 'move', key: 'Tol', delta: -1 })
    run({ op: 'rename', key: 'MPN', newKey: 'Part' })
    run({ op: 'visible', key: 'Part', visible: true })
    run({ op: 'remove', key: 'Value' })
    expect(keys()[1]).toEqual(['Reference', 'Value', 'Tol', 'Part'])
    run({ op: 'remove', key: 'Tol' })
    for (const doc of docs.values()) {
      const reparsed = parseKicadSchematic(serializeKicadSchematic(doc)).symbols[0]
      expect(reparsed.properties.map((p) => [p.key, p.hidden])).toEqual([
        ['Reference', false],
        ['Value', false],
        ['Part', false]
      ])
    }
  })

  test('"exclude from BOM" stores the inverse, and DNP stores itself', () => {
    const { records, docs } = design()
    const main = docs.get('/p/main.kicad_sch')!.symbols[0]
    const mine = records.filter((record) => record.filePath === '/p/main.kicad_sch')
    for (const edit of flagEdits(mine, 'excludeFromBom', true)) edit.apply(main)
    for (const edit of flagEdits(mine, 'dnp', true)) edit.apply(main)
    expect(main.inBom).toBe(false)
    expect(main.dnp).toBe(true)
  })
})
