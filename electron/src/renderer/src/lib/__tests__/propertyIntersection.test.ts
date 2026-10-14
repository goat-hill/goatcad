/** A mixed selection's properties (`intersectGroups`): only what every kind shares. */
import { describe, expect, test } from 'vitest'
import {
  MIXED,
  SELECTION_GROUP,
  intersectGroups,
  type PropertyField,
  type PropertyGroup
} from '../propertyTable'

const field = (
  key: string,
  value: PropertyField['value'],
  kind: 'text' | 'distance' = 'distance'
): PropertyField => ({
  key,
  labelKey: key,
  editor: { kind },
  value
})

const track: PropertyGroup = {
  type: 'segment',
  title: 'Track',
  count: 2,
  fields: [field('width', 250_000), field('net', 'GND', 'text'), field('layer', 'F.Cu', 'text')]
}
const via: PropertyGroup = {
  type: 'via',
  title: 'Via',
  count: 1,
  fields: [field('net', 'VCC', 'text'), field('drill', 300_000), field('layer', 'F.Cu', 'text')]
}

describe('a mixed selection', () => {
  test('shows one group of the fields every kind has, a differing value mixed', () => {
    const [group, ...rest] = intersectGroups([track, via], 'Selection')
    expect(rest).toEqual([])
    expect(group.type).toBe(SELECTION_GROUP)
    expect(group.count).toBe(3)
    expect(group.fields.map((f) => [f.key, f.value])).toEqual([
      ['net', MIXED],
      ['layer', 'F.Cu']
    ])
    expect(group.members).toEqual([{ type: 'segment' }, { type: 'via' }])
  })

  test('a field edited another way in one kind is not shared', () => {
    const odd: PropertyGroup = { ...via, fields: [field('layer', 'F.Cu', 'distance')] }
    expect(intersectGroups([track, odd], 'Selection')[0].fields).toEqual([])
  })

  test('one kind, and a pin with its alternates, are left as they are', () => {
    expect(intersectGroups([track], 'Selection')).toEqual([track])
    const alternate: PropertyGroup = {
      type: 'alternate',
      id: 'a1',
      title: 'Alt',
      count: 1,
      fields: []
    }
    expect(intersectGroups([track, alternate], 'Selection')).toEqual([track, alternate])
  })
})
