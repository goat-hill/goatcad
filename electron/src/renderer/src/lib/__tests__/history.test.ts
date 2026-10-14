import { describe, test, expect } from 'vitest'
import { CommandHistory } from '../history'

const entry = (
  label: string,
  before: string,
  after: string,
  extra: Partial<{ mergeKey: string; groupWithPrevious: boolean; timestamp: number }> = {}
): Parameters<CommandHistory['push']>[0] => ({
  label,
  before,
  after,
  selectionBefore: [],
  selectionAfter: [],
  ...extra
})

describe('CommandHistory', () => {
  test('push/undo/redo round-trip returns the right states', () => {
    const h = new CommandHistory()
    h.push(entry('Edit A', 'v1', 'v2'))
    h.push(entry('Edit B', 'v2', 'v3'))

    expect(h.canUndo).toBe(true)
    expect(h.undoLabel).toBe('Edit B')

    const u1 = h.undo()
    expect(u1?.before).toBe('v2')
    expect(h.redoLabel).toBe('Edit B')

    const u2 = h.undo()
    expect(u2?.before).toBe('v1')
    expect(h.canUndo).toBe(false)

    const r1 = h.redo()
    expect(r1?.after).toBe('v2')
    expect(h.undoLabel).toBe('Edit A')
  })

  test('a rollback takes back everything since its mark, merged or not, and leaves nothing to redo', () => {
    const h = new CommandHistory()
    h.push(entry('Rotate', 'v1', 'v2', { mergeKey: 'rotate', timestamp: 1 }))
    const mark = h.mark()
    h.push(entry('Rotate', 'v2', 'v3', { mergeKey: 'rotate', timestamp: 2 }))
    h.push(entry('Flip', 'v3', 'v4'))
    expect(h.rollback(mark)?.before).toBe('v2')
    expect(h.undoLabel).toBe('Rotate')
    expect(h.canRedo).toBe(false)
    expect(h.rollback(mark)).toBeNull()
  })

  test('no-op commands are not recorded', () => {
    const h = new CommandHistory()
    h.push(entry('Nothing', 'same', 'same'))
    expect(h.canUndo).toBe(false)
  })

  test('new command clears the redo stack', () => {
    const h = new CommandHistory()
    h.push(entry('Edit A', 'v1', 'v2'))
    h.undo()
    expect(h.canRedo).toBe(true)
    h.push(entry('Edit B', 'v1', 'v4'))
    expect(h.canRedo).toBe(false)
  })

  test('entries with the same mergeKey coalesce within the window', () => {
    const h = new CommandHistory(100, 1000)
    h.push(entry('Edit Pad 1', 'v1', 'v2', { mergeKey: 'pad:0:size', timestamp: 0 }))
    h.push(entry('Edit Pad 1', 'v2', 'v3', { mergeKey: 'pad:0:size', timestamp: 500 }))

    const u = h.undo()
    // One entry spanning the whole burst: undo returns to the original state
    expect(u?.before).toBe('v1')
    expect(u?.after).toBe('v3')
    expect(h.canUndo).toBe(false)
  })

  test('entries outside the merge window do not coalesce', () => {
    const h = new CommandHistory(100, 1000)
    h.push(entry('Edit Pad 1', 'v1', 'v2', { mergeKey: 'pad:0:size', timestamp: 0 }))
    h.push(entry('Edit Pad 1', 'v2', 'v3', { mergeKey: 'pad:0:size', timestamp: 2000 }))
    expect(h.undo()?.before).toBe('v2')
    expect(h.undo()?.before).toBe('v1')
  })

  test('entries with different mergeKeys do not coalesce', () => {
    const h = new CommandHistory(100, 1000)
    h.push(entry('Edit Pad 1', 'v1', 'v2', { mergeKey: 'pad:0:size', timestamp: 0 }))
    h.push(entry('Edit Pad 2', 'v2', 'v3', { mergeKey: 'pad:1:size', timestamp: 100 }))
    expect(h.undo()?.before).toBe('v2')
    expect(h.undo()?.before).toBe('v1')
  })

  test('selection is preserved on entries', () => {
    const h = new CommandHistory()
    h.push({
      label: 'Move Pad',
      before: 'v1',
      after: 'v2',
      selectionBefore: [{ type: 'pad', index: 3 }],
      selectionAfter: [{ type: 'pad', index: 3 }]
    })
    const u = h.undo()
    expect(u?.selectionBefore).toEqual([{ type: 'pad', index: 3 }])
  })

  test('an auxiliary entry groups with the user command for undo and redo', () => {
    const h = new CommandHistory()
    h.push(entry('Move Footprint', 'before-move', 'after-move'))
    h.push(
      entry('Refill Zones', 'after-move', 'after-refill', {
        groupWithPrevious: true
      })
    )

    expect(h.undoLabel).toBe('Move Footprint')
    const undo = h.undo()
    expect(undo?.label).toBe('Move Footprint')
    expect(undo?.before).toBe('before-move')
    expect(undo?.after).toBe('after-refill')
    expect(h.canUndo).toBe(false)

    expect(h.redo()?.after).toBe('after-refill')
    expect(h.canRedo).toBe(false)
  })

  test('stack depth is capped at the limit', () => {
    const h = new CommandHistory(3)
    for (let i = 0; i < 5; i++) {
      h.push(entry(`Edit ${i}`, `v${i}`, `v${i + 1}`))
    }
    // Only the 3 most recent survive
    expect(h.undo()?.before).toBe('v4')
    expect(h.undo()?.before).toBe('v3')
    expect(h.undo()?.before).toBe('v2')
    expect(h.canUndo).toBe(false)
  })

  test('clear empties both stacks', () => {
    const h = new CommandHistory()
    h.push(entry('Edit A', 'v1', 'v2'))
    h.undo()
    h.clear()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
  })
})

describe('CommandHistory with sibling files', () => {
  const files = [{ path: '/p/child.kicad_sch', before: 'child-0', after: 'child-1' }]

  test('an entry whose own file is unchanged is kept when it carries sibling files', () => {
    const h = new CommandHistory()
    h.push({
      label: 'Annotate',
      before: 'a',
      after: 'a',
      selectionBefore: [],
      selectionAfter: [],
      files
    })
    expect(h.canUndo).toBe(true)
    expect(h.undo()?.files).toEqual(files)
  })

  test('a plain no-op is still dropped', () => {
    const h = new CommandHistory()
    h.push({ label: 'x', before: 'a', after: 'a', selectionBefore: [], selectionAfter: [] })
    expect(h.canUndo).toBe(false)
  })

  test('merged entries keep the first before and take the last after, per file', () => {
    const h = new CommandHistory()
    h.push({
      label: 'x',
      before: 'a',
      after: 'b',
      selectionBefore: [],
      selectionAfter: [],
      files,
      mergeKey: 'k'
    })
    h.push({
      label: 'x',
      before: 'b',
      after: 'c',
      selectionBefore: [],
      selectionAfter: [],
      files: [
        { path: '/p/child.kicad_sch', before: 'child-1', after: 'child-2' },
        { path: '/p/other.kicad_sch', before: 'o-0', after: 'o-1' }
      ],
      mergeKey: 'k'
    })
    const entry = h.undo()
    expect(entry?.before).toBe('a')
    expect(entry?.after).toBe('c')
    expect(entry?.files).toEqual([
      { path: '/p/child.kicad_sch', before: 'child-0', after: 'child-2' },
      { path: '/p/other.kicad_sch', before: 'o-0', after: 'o-1' }
    ])
  })
})
