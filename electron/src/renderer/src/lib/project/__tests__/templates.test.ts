import { describe, expect, test } from 'vitest'
import {
  boardTemplate,
  footprintTemplate,
  projectTemplate,
  schematicTemplate,
  symbolLibraryTemplate
} from '../templates'
import {
  parseSExpr,
  findChild,
  getFirstAtomValue,
  serializeSExpr,
  type SExprList
} from '../../kicad/sexpr'
import { parseKicadSchematic } from '../../kicad/schematic'
import { parseKicadFootprint } from '../../kicad/footprint'

const ROOT_UUID = '00000000-0000-4000-8000-000000000001'

/** Parse to a list node — every template's root is one by construction. */
const parseRoot = (text: string): SExprList => {
  const root = parseSExpr(text)
  if (root.type !== 'list') throw new Error('template root is not a list')
  return root
}

describe('schematicTemplate', () => {
  test('renders a blank sheet', () => {
    expect(schematicTemplate(ROOT_UUID)).toBe(`(kicad_sch
\t(version 20260306)
\t(generator "goatcad")
\t(generator_version "1.0")
\t(uuid "${ROOT_UUID}")
\t(paper "A4")
\t(lib_symbols)
\t(sheet_instances
\t\t(path "/"
\t\t\t(page "1")
\t\t)
\t)
)
`)
  })

  test('parses as a schematic and survives a serialize round-trip', () => {
    const text = schematicTemplate(ROOT_UUID)
    const sheet = parseKicadSchematic(text)
    expect(sheet.symbols).toEqual([])
    expect(serializeSExpr(parseSExpr(text)) + '\n').toBe(text)
  })
})

describe('boardTemplate', () => {
  /** Layer names from the board's `(layers (<ordinal> "<name>" …) …)` table. */
  const layerNames = (text: string): (string | undefined)[] => {
    const layers = findChild(parseRoot(text), 'layers')
    expect(layers).not.toBeNull()
    return layers!.children
      .filter((child): child is SExprList => child.type === 'list')
      .map((row) => getFirstAtomValue(row))
  }

  test('parses, and defaults to a two-layer stackup', () => {
    const names = layerNames(boardTemplate())
    expect(names).toContain('F.Cu')
    expect(names).toContain('B.Cu')
    expect(names).not.toContain('In1.Cu')
  })

  test('a four-layer stackup adds the inner copper layers between the outers', () => {
    expect(layerNames(boardTemplate(4)).slice(0, 4)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])
  })

  test('numbers its layers as KiCad 10 does', () => {
    const board = boardTemplate(4)
    expect(board).toContain('(version 20260206)')
    expect(board).toContain('(4 "In1.Cu" signal)')
    expect(board).toContain('(2 "B.Cu" signal)')
    expect(board).toContain('(25 "Edge.Cuts" user)')
    expect(board).not.toContain('(net 0')
  })

  test('round-trips through the serializer', () => {
    const text = boardTemplate()
    expect(serializeSExpr(parseSExpr(text)) + '\n').toBe(text)
  })
})

describe('symbolLibraryTemplate', () => {
  test('renders an empty library', () => {
    expect(symbolLibraryTemplate()).toBe(`(kicad_symbol_lib
\t(version 20251024)
\t(generator "goatcad")
\t(generator_version "1.0")
)
`)
  })
})

describe('every template is already in the writer’s own shape', () => {
  // The templates are serialized by the same writer the editors save through,
  // so opening a fresh file and saving it must produce a zero-byte diff. A
  // hand-written text template is exactly what would break this invariant.
  test.each([
    ['schematic', schematicTemplate(ROOT_UUID)],
    ['board', boardTemplate()],
    ['four-layer board', boardTemplate(4)],
    ['symbol library', symbolLibraryTemplate()],
    ['footprint', footprintTemplate('LED_0805')]
  ])('%s', (_name, text) => {
    expect(`${serializeSExpr(parseSExpr(text))}\n`).toBe(text)
  })
})

describe('footprintTemplate', () => {
  test('parses as a footprint carrying its own name', () => {
    const footprint = parseKicadFootprint(footprintTemplate('LED_0805'))
    expect(footprint.name).toBe('LED_0805')
    expect(footprint.pads).toEqual([])
  })

  test('quotes a name containing spaces', () => {
    expect(footprintTemplate('My Part')).toContain('(footprint "My Part"')
  })
})

describe('projectTemplate', () => {
  test('is valid JSON at KiCad schema version 3', () => {
    const project = JSON.parse(projectTemplate('demo', ROOT_UUID))
    expect(project.meta).toEqual({ filename: 'demo.kicad_pro', version: 3 })
  })

  test('keys the root sheet by the schematic uuid, not its filename', () => {
    // KiCad's `sheets` is [[uuid, name]]; a filename here is the invented shape
    // this template replaced, and would not resolve in KiCad.
    const project = JSON.parse(projectTemplate('demo', ROOT_UUID))
    expect(project.sheets).toEqual([[ROOT_UUID, 'Root']])
  })

  test('declares a Default net class so a fresh board has rules to read', () => {
    const project = JSON.parse(projectTemplate('demo', ROOT_UUID))
    expect(project.net_settings.classes[0].name).toBe('Default')
    expect(project.net_settings.classes[0].track_width).toBe(0.2)
  })
})
