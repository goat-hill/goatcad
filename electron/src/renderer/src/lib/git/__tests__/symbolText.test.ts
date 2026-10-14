import { describe, expect, test } from 'vitest'
import { hunksWithin, symbolLineRange } from '../symbolText'
import { parseUnifiedDiff } from '../unifiedDiff'

const LIB = `(kicad_symbol_lib
  (version 20231120)
  (symbol "A"
    (property "Value" "A")
  )
  (symbol "B"
    (property "Value" "B")
  )
)
`

describe('symbolLineRange', () => {
  test('spans the definition, first line to closing paren', () => {
    expect(symbolLineRange(LIB, 'A')).toEqual({ first: 3, last: 5 })
    expect(symbolLineRange(LIB, 'B')).toEqual({ first: 6, last: 8 })
  })

  test('null for a missing symbol, a missing side, or text that does not parse', () => {
    expect(symbolLineRange(LIB, 'C')).toBeNull()
    expect(symbolLineRange(null, 'A')).toBeNull()
    expect(symbolLineRange('(unclosed', 'A')).toBeNull()
  })
})

describe('hunksWithin', () => {
  const diff = parseUnifiedDiff(
    [
      '@@ -3,6 +3,6 @@',
      '   (symbol "A"',
      '-    (property "Value" "A")',
      '+    (property "Value" "A2")',
      '   )',
      '   (symbol "B"',
      '-    (property "Value" "B")',
      '+    (property "Value" "B2")',
      ''
    ].join('\n')
  )

  test("keeps only the symbol's own changes and the context around them", () => {
    const [hunk] = hunksWithin(diff.hunks, { first: 6, last: 8 }, { first: 6, last: 8 })
    expect(hunk.lines.map((l) => `${l.kind}:${l.text.trim()}`)).toEqual([
      'context:(symbol "B"',
      'del:(property "Value" "B")',
      'add:(property "Value" "B2")'
    ])
    expect(hunk.oldStart).toBe(6)
  })

  test('drops a hunk with no change left in it', () => {
    expect(hunksWithin(diff.hunks, { first: 20, last: 30 }, { first: 20, last: 30 })).toEqual([])
  })

  test('an added symbol has no old range: only its additions count', () => {
    const added = parseUnifiedDiff('@@ -2,0 +3,2 @@\n+  (symbol "N"\n+  )\n')
    expect(hunksWithin(added.hunks, null, { first: 3, last: 4 })[0].lines).toHaveLength(2)
  })
})
