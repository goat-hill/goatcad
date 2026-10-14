import { describe, expect, test } from 'vitest'
import { sheetUpdateRequest } from '../items/update'

describe('a sheet item update', () => {
  test('the Reference is refused through fields and through its field item', () => {
    for (const [id, record] of [
      ['U5', { fields: { Reference: 'U9' } }],
      ['U5#Reference', { value: 'U9' }]
    ] as const) {
      const outcome = sheetUpdateRequest(id, record, {})
      expect(outcome).toMatchObject({ ok: false, error: { code: 'refused' } })
      expect(JSON.stringify(outcome)).toContain('schematic_annotate')
    }
  })

  test('the Reference field still moves', () => {
    expect(sheetUpdateRequest('U5#Reference', { hidden: true }, {})).toMatchObject({
      kind: 'update-item',
      id: 'U5#Reference',
      hidden: true
    })
  })

  test("size is a sheet's {width, height} or a text's glyph height", () => {
    expect(
      sheetUpdateRequest('box-uuid', { size: { width: 38.1, height: 25.4 } }, {})
    ).toMatchObject({ kind: 'update-item', size: { width: 38.1, height: 25.4 } })
    expect(sheetUpdateRequest('text-uuid', { size: 2 }, {})).toMatchObject({
      kind: 'update-item',
      size: 2
    })
    expect(sheetUpdateRequest('text-uuid', { size: 20 }, {})).toMatchObject({
      ok: false,
      error: { code: 'invalid-args' }
    })
  })

  test('colors are hex or null, and a create-only key is refused', () => {
    expect(
      sheetUpdateRequest('rect-uuid', { strokeColor: '#ff000080', fillColor: null }, {})
    ).toMatchObject({ kind: 'update-item', strokeColor: '#ff000080', fillColor: null })
    expect(sheetUpdateRequest('rect-uuid', { strokeColor: 'red' }, {})).toMatchObject({
      ok: false,
      error: { code: 'invalid-args', kind: 'invalid-record', path: '/record/strokeColor' }
    })
    expect(sheetUpdateRequest('image-uuid', { path: 'logo.png' }, {})).toMatchObject({
      ok: false,
      error: { code: 'refused', kind: 'not-applicable', path: '/record/path' }
    })
  })
})
