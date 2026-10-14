import { describe, expect, test } from 'vitest'
import { addedRowKey } from '../useFocusAddedRow'

describe('addedRowKey', () => {
  test('names the row that was not there before, wherever it landed', () => {
    expect(addedRowKey(new Set(['a', 'c']), ['a', 'b', 'c'])).toBe('b')
    expect(addedRowKey(new Set(['0', '1']), ['0', '1', '2'])).toBe('2')
  })

  test('is null when nothing new appeared', () => {
    expect(addedRowKey(new Set(['a', 'b']), ['b'])).toBeNull()
    expect(addedRowKey(new Set(['a', 'b']), ['a', 'b'])).toBeNull()
  })
})
