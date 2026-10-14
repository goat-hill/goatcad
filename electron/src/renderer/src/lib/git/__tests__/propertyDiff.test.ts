import { describe, expect, it } from 'vitest'
import { diffPropertyGroups } from '../propertyDiff'
import type { PropertyField, PropertyGroup } from '../../propertyTable'

const text = (key: string, value: string): PropertyField => ({
  key,
  editor: { kind: 'text' },
  value
})

const group = (type: string, fields: PropertyField[]): PropertyGroup => ({
  type,
  title: type,
  count: 1,
  fields
})

describe('diffPropertyGroups', () => {
  it('leaves rows both versions agree on unmarked', () => {
    const fields = [text('ref', 'R1'), text('value', '10k')]
    const [merged] = diffPropertyGroups([group('symbol', fields)], [group('symbol', fields)])
    expect(merged.change).toBeUndefined()
    expect(merged.fields.map((f) => f.change)).toEqual([undefined, undefined])
  })

  it('marks a changed row and keeps the old one with it', () => {
    const [merged] = diffPropertyGroups(
      [group('symbol', [text('ref', 'R1'), text('value', '10k')])],
      [group('symbol', [text('ref', 'R1'), text('value', '4k7')])]
    )
    const value = merged.fields[1]
    expect(value.change).toBe('changed')
    expect(value.value).toBe('4k7')
    expect(value.was?.value).toBe('10k')
  })

  it('marks new rows added and puts removed rows back under the row they followed', () => {
    const [merged] = diffPropertyGroups(
      [group('symbol', [text('ref', 'R1'), text('mpn', 'X'), text('value', '10k')])],
      [group('symbol', [text('ref', 'R1'), text('value', '10k'), text('tol', '1%')])]
    )
    expect(merged.fields.map((f) => [f.key, f.change])).toEqual([
      ['ref', undefined],
      ['mpn', 'removed'],
      ['value', undefined],
      ['tol', 'added']
    ])
  })

  it('compares a select by the label it shows', () => {
    const net = (number: string, name: string): PropertyField => ({
      key: 'net',
      editor: { kind: 'select', options: [{ value: number, label: name }] },
      value: number
    })
    const renumbered = diffPropertyGroups(
      [group('segment', [net('3', 'GND')])],
      [group('segment', [net('4', 'GND')])]
    )
    expect(renumbered[0].fields[0].change).toBeUndefined()
    const renamed = diffPropertyGroups(
      [group('segment', [net('3', 'GND')])],
      [group('segment', [net('3', 'VCC')])]
    )
    expect(renamed[0].fields[0].change).toBe('changed')
  })

  it('marks a group only one version has on the group, not its rows', () => {
    const merged = diffPropertyGroups(
      [group('pad', [text('number', '1')])],
      [group('field', [text('name', 'Value')])]
    )
    expect(merged.map((g) => [g.type, g.change])).toEqual([
      ['field', 'added'],
      ['pad', 'removed']
    ])
    expect(merged[0].fields[0].change).toBeUndefined()
  })
})
