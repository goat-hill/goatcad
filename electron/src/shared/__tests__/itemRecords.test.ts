import { describe, expect, test } from 'vitest'
import { RECORDS, recordKeys, type RecordDocument } from '../itemRecords'

const DOCUMENTS: RecordDocument[] = ['sheet', 'symbol', 'footprint', 'board']

describe('each document’s kinds and keys', () => {
  test('the kinds', () => {
    expect(RECORDS.sheet.kinds).toEqual([
      'symbol',
      'field',
      'label',
      'wire',
      'junction',
      'no_connect',
      'text',
      'rect',
      'sheet',
      'sheet_pin',
      'polyline',
      'circle',
      'arc',
      'bezier',
      'text_box',
      'rule_area',
      'image',
      'table',
      'bus',
      'bus_entry',
      'directive_label'
    ])
    expect(RECORDS.symbol.kinds).toEqual([
      'pin',
      'polyline',
      'rect',
      'circle',
      'arc',
      'bezier',
      'text',
      'text_box',
      'field',
      'symbol'
    ])
    expect(RECORDS.footprint.kinds).toEqual([
      'pad',
      'line',
      'arc',
      'circle',
      'rect',
      'poly',
      'text',
      'property',
      'model',
      'zone',
      'footprint',
      'bezier',
      'text_box',
      'point',
      'table'
    ])
    expect(RECORDS.board.kinds).toEqual([
      'footprint',
      'pad',
      'track',
      'via',
      'zone',
      'line',
      'arc',
      'circle',
      'rect',
      'poly',
      'bezier',
      'text',
      'text_box',
      'point',
      'table',
      'tuning_pattern'
    ])
  })

  test.each(DOCUMENTS)(
    '%s: every kind has update keys, and every create kind create keys',
    (doc) => {
      const records = RECORDS[doc]
      expect(Object.keys(records.update).sort()).toEqual([...records.kinds].sort())
      expect(Object.keys(records.create).sort()).toEqual([...records.createKinds].sort())
      for (const kind of records.createKinds) expect(records.kinds).toContain(kind)
    }
  )

  test.each(DOCUMENTS)('%s: no kind lists a key twice, or reads only a key it writes', (doc) => {
    const records = RECORDS[doc]
    for (const table of [records.update, records.create])
      for (const [kind, keys] of Object.entries(table))
        expect(new Set(keys).size, `${doc} ${kind}`).toBe(keys.length)
    for (const [kind, keys] of Object.entries(records.readOnly))
      for (const key of keys ?? [])
        expect(records.update[kind], `${doc} ${kind}.${key}`).not.toContain(key)
  })

  test('the documents that do not create a kind say so', () => {
    expect(recordKeys('symbol', 'symbol', 'create')).toBeUndefined()
    expect(recordKeys('footprint', 'footprint', 'create')).toBeUndefined()
    expect(recordKeys('footprint', 'table', 'create')).toBeUndefined()
    expect(recordKeys('board', 'pad', 'update')).toEqual([])
    expect(recordKeys('sheet', 'bus', 'create')).toBeUndefined()
  })

  test('a create takes what an update writes, plus where a new item goes', () => {
    expect(recordKeys('footprint', 'property', 'create')).toEqual([
      'key',
      ...(recordKeys('footprint', 'property', 'update') ?? [])
    ])
    expect(recordKeys('sheet', 'label', 'create')).toEqual(
      expect.arrayContaining(['labelKind', 'pin'])
    )
    expect(recordKeys('board', 'track', 'create')).toEqual(['points', 'layer', 'width', 'net'])
  })
})
