import { describe, test, expect } from 'vitest'
import { escapeCsvField, bomCsvMatrix, serializeBomCsv, type BomColumn } from '../bomCsv'

const columns: BomColumn[] = [
  { key: 'comment', label: 'Comment' },
  { key: 'designator', label: 'Designator' },
  { key: 'pn', label: 'LCSC' }
]

describe('escapeCsvField', () => {
  test('leaves a plain field untouched', () => {
    expect(escapeCsvField('100nF')).toBe('100nF')
  })
  test('quotes a field containing a comma (a grouped designator)', () => {
    expect(escapeCsvField('C1, C2, C3')).toBe('"C1, C2, C3"')
  })
  test('doubles embedded quotes and wraps', () => {
    expect(escapeCsvField('2.2" pitch')).toBe('"2.2"" pitch"')
  })
  test('quotes a field with a newline', () => {
    expect(escapeCsvField('a\nb')).toBe('"a\nb"')
  })
})

describe('bomCsvMatrix', () => {
  test('first row is the column labels', () => {
    const m = bomCsvMatrix(columns, [])
    expect(m[0]).toEqual(['Comment', 'Designator', 'LCSC'])
  })
  test('missing keys become empty fields', () => {
    const m = bomCsvMatrix(columns, [{ comment: '100nF', designator: 'C1' }])
    expect(m[1]).toEqual(['100nF', 'C1', ''])
  })
})

describe('serializeBomCsv', () => {
  test('joins fields with commas and rows with CRLF, quoting where needed', () => {
    const csv = serializeBomCsv(columns, [{ comment: '100nF', designator: 'C1, C2', pn: 'C1525' }])
    expect(csv).toBe('Comment,Designator,LCSC\r\n100nF,"C1, C2",C1525')
  })
})
