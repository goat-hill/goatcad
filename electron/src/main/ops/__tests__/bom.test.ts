import { describe, expect, it } from 'vitest'
import { registry } from '../index'

const build = (
  name: string,
  args: Record<string, unknown>
): ReturnType<NonNullable<ReturnType<typeof registry.get>>['designRequest'] & object> => {
  const op = registry.get(name)
  if (!op?.designRequest) throw new Error(`${name} is not a design operation`)
  return op.designRequest(args)
}

const kindOf = (result: ReturnType<typeof build>): string | undefined =>
  result.ok ? undefined : result.error.kind

const where = [{ field: 'Value', match: 'equals', value: '10k' }]

describe('bom.update refuses before anything crosses to the window', () => {
  it('names its parts one way, and a write by condition says how many it expects', () => {
    expect(kindOf(build('bom.update', { fields: { MPN: 'X' } }))).toBe('target-required')
    expect(kindOf(build('bom.update', { references: ['R1'], where, fields: { MPN: 'X' } }))).toBe(
      'target-required'
    )
    expect(kindOf(build('bom.update', { references: [], fields: { MPN: 'X' } }))).toBe(
      'target-required'
    )
    expect(kindOf(build('bom.update', { where, fields: { MPN: 'X' } }))).toBe('expect-required')
    expect(
      kindOf(
        build('bom.update', {
          where: [{ field: 'Value', match: 'equals' }],
          expect: 2,
          fields: { MPN: 'X' }
        })
      )
    ).toBe('filter-without-value')
  })

  it('writes fields and flags only', () => {
    for (const fields of [{ Reference: 'R9' }, { DNP: 'yes' }, { '${EXCLUDE_FROM_BOM}': 'yes' }]) {
      expect(kindOf(build('bom.update', { references: ['R1'], fields }))).toBe('not-applicable')
    }
    expect(kindOf(build('bom.update', { references: ['R1'] }))).toBe('nothing-to-write')
  })

  it('builds the request the window runs, field names trimmed', () => {
    expect(
      build('bom.update', { references: ['R1'], fields: { ' MPN ': 'RC0402' }, dnp: true })
    ).toEqual({
      ok: true,
      request: {
        kind: 'update-bom',
        references: ['R1'],
        fields: { MPN: 'RC0402' },
        dnp: true,
        dryRun: false
      }
    })
  })
})

describe('bom.get', () => {
  it('passes the query through, and refuses a condition with no value', () => {
    expect(build('bom.get', { fields: ['Value'], groupBy: ['Value'], limit: 50 })).toEqual({
      ok: true,
      request: { kind: 'get-bom', fields: ['Value'], groupBy: ['Value'], limit: 50 }
    })
    expect(kindOf(build('bom.get', { where: [{ field: 'MPN', match: 'contains' }] }))).toBe(
      'filter-without-value'
    )
  })
})
