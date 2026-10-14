import { describe, expect, it } from 'vitest'
import { boardPickKey, keyIndex, pickedSides, schematicPickKey } from '../diffPick'

const changes = [
  { id: 'a', kind: 'moved', beforeKey: 'symbol:0', afterKey: 'symbol:2' },
  { id: 'b', kind: 'added', afterKey: 'symbol:1' },
  { id: 'c', kind: 'removed', beforeKey: 'symbol:1' }
]
// Diff draws the after sheet's three symbols, then the removed one as symbol:3.
const removedKeys = new Map([['c', 'symbol:3']])

describe('pickedSides', () => {
  it('finds a changed item in both versions from any view', () => {
    expect(pickedSides(changes, removedKeys, 'diff', 'symbol:2')).toEqual({
      before: 'symbol:0',
      after: 'symbol:2'
    })
    expect(pickedSides(changes, removedKeys, 'after', 'symbol:2')).toEqual({
      before: 'symbol:0',
      after: 'symbol:2'
    })
    expect(pickedSides(changes, removedKeys, 'before', 'symbol:0')).toEqual({
      before: 'symbol:0',
      after: 'symbol:2'
    })
  })

  it('finds an added item in the new version only', () => {
    expect(pickedSides(changes, removedKeys, 'diff', 'symbol:1')).toEqual({
      before: null,
      after: 'symbol:1'
    })
  })

  it('finds a removed item drawn back in by where Diff put it', () => {
    expect(pickedSides(changes, removedKeys, 'diff', 'symbol:3')).toEqual({
      before: 'symbol:1',
      after: null
    })
    expect(pickedSides(changes, removedKeys, 'before', 'symbol:1')).toEqual({
      before: 'symbol:1',
      after: null
    })
  })

  it('names nothing for an unchanged item', () => {
    expect(pickedSides(changes, removedKeys, 'diff', 'symbol:0')).toBeNull()
    // Before's symbol:1 is the removed one; After's is the added one.
    expect(pickedSides(changes, removedKeys, 'after', 'symbol:0')).toBeNull()
  })
})

describe('pick keys', () => {
  it('names the item a part belongs to', () => {
    expect(schematicPickKey({ type: 'field', index: 4 })).toBe('symbol:4')
    expect(schematicPickKey({ type: 'sheet_pin', index: 1 })).toBe('sheet:1')
    expect(schematicPickKey({ type: 'text', index: 0 })).toBe('schematic-text:0')
    expect(schematicPickKey({ type: 'wire', index: 7 })).toBe('wire:7')
    expect(boardPickKey({ type: 'pad', index: 2 })).toBe('footprint:2')
    expect(boardPickKey({ type: 'segment', index: 9 })).toBe('segment:9')
    expect(keyIndex('schematic-text:12')).toBe(12)
  })
})
