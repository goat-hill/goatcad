import { describe, expect, test } from 'vitest'
import { parseKicadSymbolLibrary } from '../../kicad/symbolLibrary'
import { FIND_TEXT_DEFAULTS, findHits } from '../../canvasFind'
import { symbolFindCandidates } from '../symbolFind'

const library = parseKicadSymbolLibrary(`(kicad_symbol_lib (version 20241209) (generator "test")
  (symbol "U"
    (property "Reference" "U" (at 0 5 0) (effects (font (size 1.27 1.27))))
    (property "Value" "OPAMP" (at 0 -5 0) (effects (font (size 1.27 1.27))))
    (property "ki_keywords" "amp" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Footprint" "SOIC" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "U_1_1"
      (text "AMP" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (pin input line (at -5 2 0) (length 2.54) (name "IN+" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))
      (pin input line (at -5 -2 0) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))
    (symbol "U_2_1"
      (pin power_in line (at 0 5 270) (length 2.54) hide (name "V+" (effects (font (size 1.27 1.27)))) (number "8" (effects (font (size 1.27 1.27))))))))`)

const symbol = library.symbols.get('U')!
const all = { pins: true, fields: true }

const find = (query: string, shown = all): string[] =>
  findHits(symbolFindCandidates(symbol, shown), query, FIND_TEXT_DEFAULTS, false).map(
    (hit) => `${hit.target.kind}:${hit.target.unit}:${hit.target.field ?? hit.target.index}`
  )

describe('symbolFindCandidates', () => {
  test('finds pin names and numbers in every unit', () => {
    expect(find('IN+')).toEqual(['pin:1:0'])
    expect(find('8')).toEqual(['pin:2:0'])
  })

  test('reads an old `~` pin name as empty', () => {
    expect(find('~')).toEqual([])
  })

  test('finds fields and graphic text, but never a ki_ field', () => {
    expect(find('OPAMP')).toEqual(['field:0:Value'])
    expect(find('AMP')).toEqual(['graphic:1:0', 'field:0:Value'])
    expect(find('amp', all).includes('field:0:ki_keywords')).toBe(false)
  })

  test('offers hidden pins and fields only while the view shows them', () => {
    expect(find('V+', { pins: false, fields: true })).toEqual([])
    expect(find('SOIC', { pins: true, fields: false })).toEqual([])
    expect(find('SOIC')).toEqual(['field:0:Footprint'])
  })
})
