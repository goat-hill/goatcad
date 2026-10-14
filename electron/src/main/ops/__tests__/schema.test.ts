import { describe, it, expect } from 'vitest'
import { s } from '../schema'

/**
 * The DSL's claim is that one definition yields three things
 * (`docs/agent-api.md`). The TypeScript type is checked by
 * the compiler, so what is left to test here is the other two: the JSON Schema
 * that gets published, and the validator that enforces it.
 */
describe('the published JSON Schema', () => {
  it('omits `required` entirely when nothing is required', () => {
    expect(s.object({}).json).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false
    })
  })

  it('lists required keys in declaration order and closes the object', () => {
    const schema = s.object({
      a: s.string(),
      b: s.integer().optional(),
      c: s.boolean()
    })
    expect(schema.json).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'integer' }, c: { type: 'boolean' } },
      required: ['a', 'c'],
      additionalProperties: false
    })
  })

  it('spells bounds the way each type spells them', () => {
    expect(s.integer().min(1).max(50).json).toEqual({ type: 'integer', minimum: 1, maximum: 50 })
    expect(s.string().min(2).json).toEqual({ type: 'string', minLength: 2 })
    expect(s.array(s.string()).min(1).json).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1
    })
  })

  it('writes an enum as a string with its values', () => {
    expect(s.enum(['asc', 'desc'] as const).json).toEqual({
      type: 'string',
      enum: ['asc', 'desc']
    })
  })

  it('writes an open map as additionalProperties, not as properties', () => {
    expect(s.record(s.array(s.string())).json).toEqual({
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } }
    })
  })

  it('carries a description without disturbing the shape', () => {
    expect(s.string().describe('why').json).toEqual({ type: 'string', description: 'why' })
  })

  it('rebuilds rather than mutates, so a shared schema cannot be edited by a user', () => {
    const base = s.string()
    const described = base.describe('mine')
    expect(base.json).toEqual({ type: 'string' })
    expect(described.json).toEqual({ type: 'string', description: 'mine' })
  })
})

describe('the validator', () => {
  it('accepts an absent optional and leaves the key off', () => {
    const schema = s.object({ a: s.string(), b: s.string().optional() })
    expect(schema.parse({ a: 'x' }, '')).toEqual({ ok: true, value: { a: 'x' } })
  })

  it('trims only where trimming was asked for', () => {
    expect(s.string().trim().parse('  x  ', '')).toEqual({ ok: true, value: 'x' })
    expect(s.string().parse('  x  ', '')).toEqual({ ok: true, value: '  x  ' })
  })

  it('rejects an array where an object is declared', () => {
    const result = s.object({}).parse([], '')
    expect(result.ok).toBe(false)
  })

  it('points at the first bad entry inside a nested structure', () => {
    const schema = s.object({ rows: s.array(s.object({ id: s.string() })) })
    const result = schema.parse({ rows: [{ id: 'a' }, { id: 7 }] }, '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issue.path).toBe('/rows/1/id')
  })

  it('validates the values of an open map', () => {
    const result = s.record(s.string()).parse({ MPN: 'x', Manufacturer: 4 }, '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issue.path).toBe('/Manufacturer')
  })

  it('says what an object does accept when a field is unknown', () => {
    const result = s.object({ query: s.string() }).parse({ qeury: 'x' }, '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issue.message).toContain('accepts: query')
  })

  it('refuses NaN and Infinity, which JSON cannot carry back anyway', () => {
    expect(s.number().parse(Number.NaN, '').ok).toBe(false)
    expect(s.number().parse(Number.POSITIVE_INFINITY, '').ok).toBe(false)
  })
})
