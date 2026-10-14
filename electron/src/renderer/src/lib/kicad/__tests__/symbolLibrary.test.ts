import { describe, expect, it } from 'vitest'
import {
  buildSymbolPreviewSchematic,
  namespaceSymbolLibrary,
  parseKicadSymbolLibrary,
  serializeKicadSymbolLibrary,
  symbolPreviewPartKey
} from '../symbolLibrary'
import { setSymbolProperty, symbolPartAddresses } from '../../symbol/symbolEdit'
import { resolveSymbolGeometry, symbolPartKey } from '../schematic'

// KiCad 8-shaped library: a base symbol with one body unit and two pins, and
// a derived symbol that extends it.
const LIBRARY = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "R"
    (pin_numbers hide)
    (pin_names (offset 0))
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "ki_keywords" "R res resistor" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "R_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54)
        (stroke (width 0.254) (type default)) (fill (type none)))
    )
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))
    )
  )
  (symbol "R_Small"
    (extends "R")
    (property "Reference" "R" (at 0.762 0.508 0) (effects (font (size 1.27 1.27))))
    (property "Value" "R_Small" (at 0.762 -1.016 0) (effects (font (size 1.27 1.27))))
  )
)
`

describe('parseKicadSymbolLibrary', () => {
  it('lists top-level symbols in file order (units stay nested)', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    expect(library.names).toEqual(['R', 'R_Small'])
    expect(library.doc.libSymbols.get('R')?.pins.length ?? 0).toBe(0)
    expect(library.doc.libSymbols.get('R')?.variants.length).toBe(2)
  })

  it('rejects non-library documents', () => {
    expect(() => parseKicadSymbolLibrary('(kicad_sch (version 20231120))')).toThrow(
      /kicad_symbol_lib/
    )
  })
})

describe('serializeKicadSymbolLibrary', () => {
  // The serializer regenerates text from the AST, so "lossless" means idempotent:
  // serialize(parse(canonical)) === canonical. Normalize the fixture once through
  // one round so the assertion is about stability, not hand-matched formatting.
  const canonical = serializeKicadSymbolLibrary(parseKicadSymbolLibrary(LIBRARY))

  it('round-trips a library byte-for-byte', () => {
    expect(serializeKicadSymbolLibrary(parseKicadSymbolLibrary(canonical))).toBe(canonical)
  })

  it('a one-symbol edit leaves every other node byte-identical', () => {
    const library = parseKicadSymbolLibrary(canonical)
    setSymbolProperty(library.symbols.get('R_Small')!._node, 'Value', 'CHANGED')
    const edited = serializeKicadSymbolLibrary(library)
    // Everything before the edited symbol (top-level version/generator + the
    // whole "R" definition) must be untouched.
    const marker = '(symbol "R_Small"'
    expect(edited.slice(0, edited.indexOf(marker))).toBe(
      canonical.slice(0, canonical.indexOf(marker))
    )
    expect(edited).toContain('"Value" "CHANGED"')
  })

  it('preserves unknown / future top-level nodes across an edit', () => {
    // Patched against the canonical (tab-indented) text, not the source
    // fixture — a two-space needle silently matches nothing now.
    const withUnknown = canonical.replace(
      '\t(symbol "R"',
      '\t(future_node "keep me" (nested 1))\n\t(symbol "R"'
    )
    const library = parseKicadSymbolLibrary(withUnknown)
    setSymbolProperty(library.symbols.get('R')!._node, 'Value', 'X')
    expect(serializeKicadSymbolLibrary(library)).toContain(
      '(future_node "keep me"\n\t\t(nested 1)\n\t)'
    )
  })
})

describe('buildSymbolPreviewSchematic', () => {
  it('places the symbol at the origin with its lib properties', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    const doc = buildSymbolPreviewSchematic(library, 'R')
    expect(doc).not.toBeNull()
    expect(doc!.symbols).toHaveLength(1)
    const placed = doc!.symbols[0]
    expect(placed.libId).toBe('R')
    expect(placed.position).toMatchObject({ x: 0, y: 0 })
    const reference = placed.properties.find((property) => property.key === 'Reference')
    expect(reference?.value).toBe('R')
  })

  it('resolves extends chains so derived symbols render', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    const doc = buildSymbolPreviewSchematic(library, 'R_Small')
    expect(doc).not.toBeNull()
    expect(doc!.symbols[0].libId).toBe('R_Small')
    // The parent definition must ride along or the instance renders empty.
    expect(doc!.libSymbols.has('R')).toBe(true)
    expect(doc!.libSymbols.get('R_Small')?.extends).toBe('R')
  })

  it('returns null for unknown symbol names', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    expect(buildSymbolPreviewSchematic(library, 'nope')).toBeNull()
  })

  // The editor's body-style selector is only as real as this: the preview has to
  // carry the style through to the placed symbol, or `resolveSymbolGeometry`
  // draws style 1 whatever the selector says.
  describe('body styles', () => {
    const DEMORGAN = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "G"
    (body_styles demorgan)
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "G_1_1"
      (rectangle (start -5 5) (end 5 -5)
        (stroke (width 0.254) (type default)) (fill (type none)))
      (pin input line (at -7.62 0 0) (length 2.54)
        (name "A" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27))))))
    (symbol "G_1_2"
      (circle (center 0 0) (radius 5)
        (stroke (width 0.254) (type default)) (fill (type none)))
      (pin input inverted (at -7.62 0 0) (length 2.54)
        (name "A" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27))))))
  )
)
`
    const drawnAt = (bodyStyle: number): { shapes: string[]; pins: string[] } => {
      const library = parseKicadSymbolLibrary(DEMORGAN)
      const preview = buildSymbolPreviewSchematic(library, 'G', 1, bodyStyle)!
      const geometry = resolveSymbolGeometry(preview, preview.symbols[0])
      return {
        shapes: geometry.graphics.map(({ graphic }) => graphic.type),
        pins: geometry.pins.map(({ pin }) => pin.graphicStyle)
      }
    }

    it('defaults to the standard style', () => {
      expect(
        buildSymbolPreviewSchematic(parseKicadSymbolLibrary(DEMORGAN), 'G')!.symbols[0].bodyStyle
      ).toBe(1)
      expect(drawnAt(1)).toEqual({ shapes: ['rectangle'], pins: ['line'] })
    })

    it('draws the alternate when one is asked for', () => {
      expect(drawnAt(2)).toEqual({ shapes: ['circle'], pins: ['inverted'] })
    })
  })
})

describe('namespaceSymbolLibrary', () => {
  it('prefixes every top-level symbol with the nickname', () => {
    const library = namespaceSymbolLibrary(LIBRARY, 'Device')
    expect(library.names).toEqual(['Device:R', 'Device:R_Small'])
    // Nested unit sub-symbols stay bare, matching KiCad's placed shape.
    expect(library.doc.libSymbols.get('Device:R')?.variants.length).toBe(2)
  })

  it('prefixes extends references so derived symbols still resolve', () => {
    const library = namespaceSymbolLibrary(LIBRARY, 'Device')
    expect(library.doc.libSymbols.get('Device:R_Small')?.extends).toBe('Device:R')
    // The chain resolves against the same namespaced map placement will copy.
    const doc = buildSymbolPreviewSchematic(library, 'Device:R_Small')
    expect(doc).not.toBeNull()
    expect(doc!.symbols[0].libId).toBe('Device:R_Small')
    expect(doc!.libSymbols.has('Device:R')).toBe(true)
  })

  it('reads an early library-prefixed name as the name after the prefix', () => {
    const library = namespaceSymbolLibrary(
      `(kicad_symbol_lib (version 20201005) (generator kicad_symbol_editor)
        (symbol "rescue:IAM" (property "Reference" "I" (id 0) (at 0 0 0)))
        (symbol "rescue:IAM2" (extends "rescue:IAM")))`,
      'sources'
    )
    expect(library.names).toEqual(['sources:IAM', 'sources:IAM2'])
    expect(library.doc.libSymbols.get('sources:IAM2')?.extends).toBe('sources:IAM')
  })

  // A project-scope embedded symbol is indexed with its schematic sheet as the
  // record's `file`, so the Component viewer can hand a `(kicad_sch …)` document
  // here. Its `(lib_symbols …)` are already namespaced — take them as-is.
  it('accepts a kicad_sch document and returns its embedded lib symbols', () => {
    const sheet = `(kicad_sch
      (version 20231120)
      (generator "goatcad")
      (lib_symbols
        (symbol "Device:C"
          (property "Reference" "C" (at 0 0 0) (effects (font (size 1.27 1.27))))
          (property "Value" "C" (at 0 0 0) (effects (font (size 1.27 1.27))))
          (symbol "C_0_1"
            (rectangle (start -1 1) (end 1 -1)
              (stroke (width 0.254) (type default)) (fill (type none))))
        )
      )
    )`
    // The nickname is ignored for a schematic (symbols are already lib_ids).
    const library = namespaceSymbolLibrary(sheet, 'IgnoredNickname')
    expect(library.doc.libSymbols.has('Device:C')).toBe(true)
    expect(library.names).toEqual(['Device:C'])
  })

  it('rejects a document that is neither a symbol lib nor a schematic', () => {
    expect(() => namespaceSymbolLibrary('(kicad_pcb (version 20231120))', 'X')).toThrow(
      /kicad_symbol_lib.*kicad_sch/
    )
  })
})

// The invariant the symbol editor's selection and drag both rest on: the name
// the EDITOR gives a part and the key the RENDERER files its paint under are
// derived independently, from different structures, and must come out equal.
// If they drifted, a selection would halo and move nothing at all — silently,
// because a key that matches no paint is not an error anywhere.
// See ARCHITECTURE.md §3.7.
describe('symbolPreviewPartKey', () => {
  // Two gates plus a common body, so the unit a part lives in actually varies.
  const MULTI = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "U"
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "U_0_1"
      (rectangle (start -2 -3) (end 2 3)
        (stroke (width 0.254) (type default)) (fill (type none)))
      (circle (center 0 0) (radius 0.5)
        (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "U_1_1"
      (pin input line (at -5 1 0) (length 2)
        (name "A" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27))))))
    (symbol "U_2_1"
      (pin input line (at -5 -1 0) (length 2)
        (name "B" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))
      (polyline (pts (xy 0 0) (xy 1 1))
        (stroke (width 0.254) (type default)) (fill (type none)))))
)`

  /** Every key the renderer would file this symbol's parts under, at `unit`. */
  const rendererKeys = (unit: number): string[] => {
    const library = parseKicadSymbolLibrary(MULTI)
    const preview = buildSymbolPreviewSchematic(library, 'U', unit)!
    const placed = preview.symbols[0]
    const geometry = resolveSymbolGeometry(preview, placed)
    return [
      ...geometry.graphics.map(({ part }) => `symbol:0/${symbolPartKey('graphic', part)}`),
      ...geometry.pins.map(({ part }) => `symbol:0/${symbolPartKey('pin', part)}`)
    ]
  }

  /** Every key the EDITOR would ask for, at the same unit. */
  const editorKeys = (unit: number): string[] => {
    const library = parseKicadSymbolLibrary(MULTI)
    const node = library.symbols.get('U')!._node
    return symbolPartAddresses(node)
      .filter((a) => a.unit === 0 || a.unit === unit)
      .map(symbolPreviewPartKey)
  }

  it.each([1, 2])('names the same parts as the renderer, on unit %i', (unit) => {
    const rendered = rendererKeys(unit)
    // Guard the guard: an empty comparison would pass for the wrong reason.
    expect(rendered.length).toBeGreaterThan(0)
    expect([...editorKeys(unit)].sort()).toEqual([...rendered].sort())
  })

  it('gives the common body the same name whichever gate is shown', () => {
    const body = (unit: number): string[] =>
      rendererKeys(unit).filter((key) => key.includes(':0.0.'))
    expect(body(1)).toEqual(body(2))
    expect(body(1).length).toBe(2)
  })
})
