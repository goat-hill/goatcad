import { describe, test, expect } from 'vitest'
import { matchComponent, highlightText, type SearchItem } from '../componentSearch'

describe('componentSearch', () => {
  const testItem: SearchItem = {
    name: 'R_0402_1005Metric.kicad_mod',
    category: 'Resistor_SMD',
    library: 'KiCad_Official',
    extraSearchTerms: ['330R Resistor']
  }

  test('returns true for empty query or whitespace only', () => {
    expect(matchComponent('', testItem)).toBe(true)
    expect(matchComponent('   ', testItem)).toBe(true)
  })

  test('matches name case-insensitively', () => {
    expect(matchComponent('r_0402', testItem)).toBe(true)
    expect(matchComponent('R_0402', testItem)).toBe(true)
    expect(matchComponent('1005metric', testItem)).toBe(true)
  })

  test('matches name with stripped extension or replaced underscores', () => {
    expect(matchComponent('kicad_mod', testItem)).toBe(true)
    expect(matchComponent('R 0402', testItem)).toBe(true)
  })

  test('matches category case-insensitively', () => {
    expect(matchComponent('resistor_smd', testItem)).toBe(true)
    expect(matchComponent('resistor smd', testItem)).toBe(true)
    expect(matchComponent('RESISTOR', testItem)).toBe(true)
  })

  test('matches library/grouping case-insensitively', () => {
    expect(matchComponent('kicad_official', testItem)).toBe(true)
    expect(matchComponent('kicad official', testItem)).toBe(true)
    expect(matchComponent('OFFICIAL', testItem)).toBe(true)
  })

  test('matches extra search terms', () => {
    expect(matchComponent('330r', testItem)).toBe(true)
    expect(matchComponent('330R Resistor', testItem)).toBe(true)
  })

  test('matches multiple keywords separated by space (AND matching)', () => {
    // Both keywords match category/library/name
    expect(matchComponent('resistor 0402', testItem)).toBe(true)
    expect(matchComponent('kicad resistor 330r', testItem)).toBe(true)
    expect(matchComponent('official smd 1005', testItem)).toBe(true)
  })

  test('returns false if any keyword is not matched', () => {
    expect(matchComponent('resistor 0603', testItem)).toBe(false)
    expect(matchComponent('kicad capacitor', testItem)).toBe(false)
  })
})

describe('highlightText', () => {
  test('returns single unmatched segment for empty/whitespace query', () => {
    expect(highlightText('Resistor_SMD', '')).toEqual([{ text: 'Resistor_SMD', isMatch: false }])
    expect(highlightText('Resistor_SMD', '   ')).toEqual([{ text: 'Resistor_SMD', isMatch: false }])
  })

  test('returns single unmatched segment for no matches', () => {
    expect(highlightText('Resistor_SMD', 'capacitor')).toEqual([
      { text: 'Resistor_SMD', isMatch: false }
    ])
  })

  test('highlights single matching keyword case-insensitively', () => {
    expect(highlightText('Resistor_SMD', 'resistor')).toEqual([
      { text: 'Resistor', isMatch: true },
      { text: '_SMD', isMatch: false }
    ])
    expect(highlightText('Resistor_SMD', 'SMD')).toEqual([
      { text: 'Resistor_', isMatch: false },
      { text: 'SMD', isMatch: true }
    ])
  })

  test('highlights multiple non-overlapping keywords', () => {
    expect(highlightText('Resistor_SMD_R_0402', 'resistor 0402')).toEqual([
      { text: 'Resistor', isMatch: true },
      { text: '_SMD_R_', isMatch: false },
      { text: '0402', isMatch: true }
    ])
  })

  test('merges overlapping and adjacent matching keyword ranges', () => {
    // Overlapping keywords: "res" and "sist"
    expect(highlightText('Resistor', 'res sist')).toEqual([
      { text: 'Resist', isMatch: true },
      { text: 'or', isMatch: false }
    ])

    // Adjacent keywords: "res" and "istor"
    expect(highlightText('Resistor', 'res istor')).toEqual([{ text: 'Resistor', isMatch: true }])
  })
})
