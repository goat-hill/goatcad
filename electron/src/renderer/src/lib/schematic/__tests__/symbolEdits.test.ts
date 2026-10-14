import { describe, expect, test } from 'vitest'
import {
  getSymbolProperty,
  parseKicadSchematic,
  serializeKicadSchematic,
  setSchematicSymbolProperty,
  type KicadSchematicSymbol
} from '../../kicad/schematic'
import { applyDocumentEdits, applySymbolEdits, type SymbolEdit } from '../symbolEdits'

const sheet = (reference: string): string => `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "${reference}-sheet")
  (symbol
    (lib_id "Device:R")
    (at 50.8 55.88 0)
    (unit 1)
    (uuid "${reference}-uuid")
    (property "Reference" "${reference}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 0 0 0) (effects (font (size 1.27 1.27)))))
)`

describe('applySymbolEdits', () => {
  test('edits this sheet in place and hands back every sibling it rewrote, as text', () => {
    const here = parseKicadSchematic(sheet('R1'))
    const siblings = new Map([
      ['/p/open.kicad_sch', parseKicadSchematic(sheet('R2'))],
      ['/p/disk.kicad_sch', parseKicadSchematic(sheet('R3'))]
    ])
    const toValue = (filePath: string): SymbolEdit => ({
      filePath,
      symbolIndex: 0,
      apply: (symbol: KicadSchematicSymbol) => setSchematicSymbolProperty(symbol, 'Value', '22k')
    })

    const rewrites = applySymbolEdits(
      ['here', 'open', 'disk', 'gone'].map((name) => toValue(`/p/${name}.kicad_sch`)),
      {
        filePath: '/p/here.kicad_sch',
        document: here,
        sibling: (path) => siblings.get(path),
        isOpen: (path) => path === '/p/open.kicad_sch'
      }
    )

    expect(getSymbolProperty(here.symbols[0], 'Value')).toBe('22k')
    // A sheet with no document to read is skipped, not invented.
    expect(rewrites.map((edit) => edit.path)).toEqual(['/p/open.kicad_sch', '/p/disk.kicad_sch'])
    for (const edit of rewrites) {
      const live = siblings.get(edit.path)!
      expect(edit.before).toBe(serializeKicadSchematic(live))
      expect(getSymbolProperty(parseKicadSchematic(edit.after).symbols[0], 'Value')).toBe('22k')
      // The shared parse is left alone: a sibling changes through its text.
      expect(getSymbolProperty(live.symbols[0], 'Value')).toBe('10k')
    }
    expect(rewrites[0].loaded).toBeUndefined()
    expect(rewrites[1].loaded).toBe(rewrites[1].before)
  })
})

describe('applyDocumentEdits', () => {
  test('runs every edit of a file on one parse of it, in order', () => {
    const here = parseKicadSchematic(sheet('R1'))
    const sibling = parseKicadSchematic(sheet('R2'))
    const seen: string[] = []
    const rewrites = applyDocumentEdits(
      [
        {
          filePath: '/p/other.kicad_sch',
          apply: (document) => {
            seen.push(getSymbolProperty(document.symbols[0], 'Value') ?? '')
            setSchematicSymbolProperty(document.symbols[0], 'Value', '1k')
          }
        },
        {
          filePath: '/p/other.kicad_sch',
          apply: (document) => seen.push(getSymbolProperty(document.symbols[0], 'Value') ?? '')
        },
        {
          filePath: '/p/here.kicad_sch',
          apply: (document) => setSchematicSymbolProperty(document.symbols[0], 'Value', '2k')
        }
      ],
      {
        filePath: '/p/here.kicad_sch',
        document: here,
        sibling: () => sibling,
        isOpen: () => true
      }
    )
    expect(seen).toEqual(['10k', '1k'])
    expect(rewrites).toHaveLength(1)
    expect(getSymbolProperty(parseKicadSchematic(rewrites[0].after).symbols[0], 'Value')).toBe('1k')
    expect(getSymbolProperty(here.symbols[0], 'Value')).toBe('2k')
  })
})
