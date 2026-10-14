import { describe, expect, test } from 'vitest'
import { RECORDS, type RecordDocument, type RecordMode } from '../itemRecords'
import { checkRecord, ruleFor } from '../recordRules'

const DOCUMENTS: RecordDocument[] = ['sheet', 'symbol', 'footprint', 'board']
const MODES: RecordMode[] = ['create', 'update']

describe('the rules', () => {
  test('every key any kind takes has a rule', () => {
    for (const doc of DOCUMENTS)
      for (const mode of MODES)
        for (const [kind, keys] of Object.entries(RECORDS[doc][mode]))
          for (const key of keys)
            expect(ruleFor(doc, kind, key, mode), `${doc} ${kind}.${key} (${mode})`).toBeDefined()
  })

  test('a key that means the same everywhere is one rule, said one way', () => {
    const same = [
      ['sheet', 'text', 'bold'],
      ['symbol', 'text', 'bold'],
      ['footprint', 'text', 'bold'],
      ['board', 'text', 'bold']
    ] as const
    const rules = same.map(([doc, kind, key]) => ruleFor(doc, kind, key, 'update'))
    expect(new Set(rules).size).toBe(1)
    for (const key of ['strokeType', 'strokeColor', 'justify', 'verticalJustify', 'margins'])
      expect(ruleFor('symbol', 'text_box', key, 'update')).toBe(
        ruleFor('footprint', 'text_box', key, 'update')
      )
    expect(ruleFor('sheet', 'rect', 'fillColor', 'update')).toBe(
      ruleFor('symbol', 'rect', 'fillColor', 'update')
    )
  })

  test('every boolean reads "true or false"', () => {
    for (const doc of DOCUMENTS)
      for (const [kind, keys] of Object.entries(RECORDS[doc].update))
        for (const key of keys) {
          const rule = ruleFor(doc, kind, key, 'update')!
          // A PCB fill takes true and false too, but reads as its names.
          if (rule.check(true) && rule.check(false) && !rule.check('x') && !rule.check('none'))
            expect(rule.expects, `${doc} ${kind}.${key}`).toMatch(/^true/)
        }
  })

  test('a color is #rrggbb or #rrggbbaa in either case, or null', () => {
    const color = ruleFor('board', 'line', 'strokeColor', 'update')!
    for (const ok of ['#ff0000', '#FF000080', null]) expect(color.check(ok)).toBe(true)
    for (const bad of ['red', '#fff', '#ff00001', 'ff0000']) expect(color.check(bad)).toBe(false)
    expect(color.expects).toBe('"#rrggbb" or "#rrggbbaa", or null for the default')
  })

  test('where KiCad’s meaning differs by document, so does the rule', () => {
    const fill = (doc: RecordDocument, kind: string): ((v: unknown) => boolean) =>
      ruleFor(doc, kind, 'fill', 'update')!.check
    expect(fill('sheet', 'rect')('background')).toBe(true)
    expect(fill('symbol', 'rect')(true)).toBe(false)
    for (const doc of ['footprint', 'board'] as const) {
      expect(fill(doc, 'rect')(true)).toBe(true)
      expect(fill(doc, 'rect')('solid')).toBe(true)
      expect(fill(doc, 'rect')('background')).toBe(false)
    }
    expect(ruleFor('symbol', 'text', 'thickness', 'update')!.check(null)).toBe(true)
    expect(ruleFor('footprint', 'text', 'thickness', 'update')!.check(null)).toBe(false)
    expect(ruleFor('sheet', 'text', 'angle', 'update')!.check(45)).toBe(false)
    expect(ruleFor('board', 'text', 'angle', 'update')!.check(45)).toBe(true)
  })
})

describe('checkRecord', () => {
  test('refuses a key the kind does not take, naming what it does', () => {
    expect(checkRecord('symbol', 'circle', { at: { x: 0, y: 0 } }, 'update')).toMatchObject({
      error: 'not-applicable',
      keys: ['at'],
      detail: expect.stringMatching(/^A circle does not take at; it takes center, radius, /)
    })
  })

  test('says a bad value the same way on every document', () => {
    for (const doc of DOCUMENTS) {
      const kind = doc === 'board' || doc === 'footprint' ? 'line' : 'polyline'
      expect(checkRecord(doc, kind, { strokeType: 'wavy' }, 'update')).toEqual({
        error: 'invalid-record',
        key: 'strokeType',
        expects: 'one of default, solid, dash, dot, dash_dot, dash_dot_dot',
        detail: `${kind}.strokeType must be one of default, solid, dash, dot, dash_dot, dash_dot_dot.`
      })
    }
  })

  test('holds an update whose kind is not known to any kind of its document', () => {
    expect(checkRecord('board', undefined, { glow: '#000000' }, 'update')).toMatchObject({
      error: 'not-applicable',
      detail: 'No board item takes glow.'
    })
    // A read-only key passes here; the door names what to do instead once the kind is known.
    expect(checkRecord('footprint', undefined, { holes: [] }, 'update')).toBeNull()
    // A point or a size holds only its own keys: an angle inside at is refused, not dropped.
    expect(
      checkRecord('sheet', 'symbol', { at: { x: 1, y: 2, angle: 90 } }, 'update')
    ).toMatchObject({ error: 'invalid-record', key: 'at' })
    expect(
      checkRecord('footprint', 'pad', { drill: { diameter: 1, shape: 'oval' } }, 'update')
    ).toMatchObject({ error: 'invalid-record', key: 'drill' })
    const size = checkRecord('sheet', undefined, { size: 20 }, 'update')
    expect(size).toMatchObject({ error: 'invalid-record', key: 'size' })
    expect(size?.detail).toBe(
      'record.size must be a glyph height from 0.5 to 10 mm (label, text, text_box); or {width, height} in millimeters (sheet).'
    )
    expect(
      checkRecord('sheet', undefined, { size: { width: 30, height: 20 } }, 'update')
    ).toBeNull()
  })

  test('checks the keys of a nested object, each optional', () => {
    expect(
      checkRecord('footprint', 'footprint', { attributes: { type: 'smd', dnp: true } }, 'update')
    ).toBeNull()
    expect(
      checkRecord('footprint', 'footprint', { attributes: { type: 'glued' } }, 'update')
    ).toMatchObject({
      error: 'invalid-record',
      detail: 'footprint.attributes.type must be one of smd, through_hole, unspecified.'
    })
    expect(
      checkRecord('footprint', 'footprint', { overrides: { glue: 1 } }, 'update')
    ).toMatchObject({ error: 'not-applicable', keys: ['overrides.glue'] })
  })

  test('margins name any of the four sides, on every document', () => {
    for (const doc of ['symbol', 'footprint', 'board'] as const) {
      expect(checkRecord(doc, 'text_box', { margins: { left: 1 } }, 'update')).toBeNull()
      expect(checkRecord(doc, 'text_box', { margins: {} }, 'update')).toMatchObject({
        error: 'invalid-record'
      })
    }
  })

  test('a rule may carry a finer failure kind', () => {
    expect(checkRecord('board', 'zone', { keepout: 'yes' }, 'update')).toMatchObject({
      error: 'keepout-shape'
    })
  })

  test('a create may read a key its own way', () => {
    expect(checkRecord('board', 'via', { at: 'U1.3' }, 'create')).toBeNull()
    expect(checkRecord('board', 'via', { at: 'U1.3' }, 'update')).toMatchObject({
      error: 'invalid-record',
      key: 'at'
    })
    expect(checkRecord('board', 'track', { points: ['U1.3', { x: 1, y: 2 }] }, 'create')).toBeNull()
  })
})
