import { describe, expect, test } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import { heldMove, withHoverSelection, type HeldMove, type HoverSelection } from '../hoverSelection'

interface Item {
  id: number
}

const setup = (
  selected: Item[],
  under: Item | null
): { state: Ref<Item[]>; seen: Item[][]; hover: HoverSelection<Item>; record: () => void } => {
  const state = ref<Item[]>(selected)
  const seen: Item[][] = []
  const hover = { selected: state, hover: () => under, same: (a: Item, b: Item) => a.id === b.id }
  return { state, seen, hover, record: () => void seen.push([...state.value]) }
}

describe('withHoverSelection', () => {
  test('acts on the selection when there is one, and leaves it', () => {
    const { state, seen, hover, record } = setup([{ id: 1 }], { id: 2 })
    withHoverSelection(hover, record)
    expect(seen).toEqual([[{ id: 1 }]])
    expect(state.value).toEqual([{ id: 1 }])
  })

  test('with none, acts on the item under the pointer and lets it go', () => {
    const { state, seen, hover, record } = setup([], { id: 2 })
    withHoverSelection(hover, record)
    expect(seen).toEqual([[{ id: 2 }]])
    expect(state.value).toEqual([])
  })

  test('keeps the hovered item when asked, or when the command selected something else', () => {
    const kept = setup([], { id: 2 })
    withHoverSelection(kept.hover, kept.record, true)
    expect(kept.state.value).toEqual([{ id: 2 }])

    const moved = setup([], { id: 2 })
    withHoverSelection(moved.hover, () => (moved.state.value = [{ id: 3 }]))
    expect(moved.state.value).toEqual([{ id: 3 }])
  })

  test('runs on an empty selection when nothing is under the pointer', () => {
    const { seen, hover, record } = setup([], null)
    withHoverSelection(hover, record)
    expect(seen).toEqual([[]])
  })
})

describe('heldMove', () => {
  const moves = (
    selected: Item[],
    under: Item | null,
    begins = true
  ): { state: Ref<Item[]>; log: string[]; move: HeldMove } => {
    const { state, hover } = setup(selected, under)
    const log: string[] = []
    const move = heldMove(hover, {
      begin: () => (log.push(`begin ${state.value.map((i) => i.id)}`), begins),
      abandon: () => void log.push('abandon'),
      history: { mark: () => 7, rollback: (mark) => void log.push(`rollback ${mark}`) }
    })
    return { state, log, move }
  }

  test('picks up the selection and keeps it after the drop', async () => {
    const { state, log, move } = moves([{ id: 1 }], { id: 2 })
    move.start()
    await nextTick()
    move.end()
    expect(log).toEqual(['begin 1'])
    expect(state.value).toEqual([{ id: 1 }])
  })

  test('with none, picks up the item under the pointer and lets it go after a drop or Escape — which takes back the edits made meanwhile', async () => {
    const dropped = moves([], { id: 2 })
    dropped.move.start()
    await nextTick()
    expect(dropped.log).toEqual(['begin 2'])
    dropped.move.end()
    expect(dropped.state.value).toEqual([])

    const cancelled = moves([], { id: 2 })
    cancelled.move.start()
    await nextTick()
    cancelled.move.cancel()
    expect(cancelled.log).toEqual(['begin 2', 'abandon', 'rollback 7'])
    expect(cancelled.state.value).toEqual([])
  })

  test('a viewport that cannot begin lets the hovered item go', async () => {
    const refused = moves([], { id: 2 }, false)
    refused.move.start()
    await nextTick()
    expect(refused.state.value).toEqual([])
    expect(refused.move.active()).toBe(false)
  })
})
