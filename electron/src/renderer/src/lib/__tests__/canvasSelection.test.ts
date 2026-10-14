import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import type { ViewportEngine } from '../engine/ViewportEngine'
import { useCanvasSelection, type BoxBounds, type CanvasSelection } from '../canvasSelection'
import type { AllowsHit, HitCandidate } from '../selectionResolve'

interface Ref {
  type: string
  index: number
}

type SelectCallback = (type: string | null, index: number | null, event: MouseEvent) => void
type SelectOtherCallback = (p: THREE.Vector2, r: number, c: { x: number; y: number }) => void
type BoxCallback = (bounds: BoxBounds, crossing: boolean, event: MouseEvent) => void

/** The slice of the engine the model talks to, with its handlers kept to call. */
const fakeEngine = (): {
  engine: ViewportEngine
  press: (e: Partial<MouseEvent>) => void
  click: (type: string | null, index: number | null, e?: Partial<MouseEvent>) => void
  hold: () => void
  band: (crossing: boolean, e?: Partial<MouseEvent>) => void
  pointer: { at: THREE.Vector2 | null }
} => {
  let onSelect: SelectCallback = () => {}
  let onSelectOther: SelectOtherCallback = () => {}
  let onBox: BoxCallback = () => {}
  let onPress: (e: MouseEvent) => void = () => {}
  const pointer = { at: new THREE.Vector2(0, 0) as THREE.Vector2 | null }
  const engine = {
    hitRadius: () => 1,
    pointerWorld: () => pointer.at,
    onPressCapture: (l: (e: MouseEvent) => void) => (onPress = l),
    onSelectOther: (c: SelectOtherCallback) => (onSelectOther = c),
    onSelect: (c: SelectCallback) => (onSelect = c),
    onBoxSelect: (c: BoxCallback) => (onBox = c),
    selectOtherAt: (at: { x: number; y: number }) => onSelectOther(new THREE.Vector2(0, 0), 1, at)
  } as unknown as ViewportEngine
  const mouse = (e: Partial<MouseEvent> = {}): MouseEvent =>
    ({ button: 0, shiftKey: false, ctrlKey: false, metaKey: false, ...e }) as MouseEvent
  return {
    engine,
    press: (e) => onPress(mouse(e)),
    click: (type, index, e) => onSelect(type, index, mouse(e)),
    hold: () => onSelectOther(new THREE.Vector2(0, 0), 1, { x: 5, y: 6 }),
    band: (crossing, e) => onBox({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 }, crossing, mouse(e)),
    pointer
  }
}

const candidate = (
  type: string,
  index: number,
  kind = type,
  locked = false
): HitCandidate<Ref> => ({
  levels: [{ kind, locked, ref: { type, index } }]
})

const setup = (
  options: {
    under?: Array<HitCandidate<Ref>>
    swept?: Array<HitCandidate<Ref>>
    allows?: AllowsHit
    active?: boolean
  } = {}
): {
  fake: ReturnType<typeof fakeEngine>
  state: { selected: Ref[] }
  selection: CanvasSelection<Ref>
} => {
  const fake = fakeEngine()
  const state = { selected: [] as Ref[] }
  const selection = useCanvasSelection<Ref>({
    engine: () => fake.engine,
    pointCandidates: () => options.under ?? [],
    boxCandidates: () => options.swept ?? [],
    allows: () => options.allows ?? (() => true),
    key: (r) => `${r.type}:${r.index}`,
    selected: () => state.selected,
    select: (items) => (state.selected = items),
    active: () => options.active ?? true
  })
  selection.install(fake.engine)
  return { fake, state, selection }
}

describe('useCanvasSelection', () => {
  test('a plain click replaces, a modified click toggles', () => {
    const { fake, state } = setup()
    fake.click('via', 1)
    fake.click('via', 2, { shiftKey: true })
    expect(state.selected).toEqual([
      { type: 'via', index: 1 },
      { type: 'via', index: 2 }
    ])
    fake.click('via', 1, { ctrlKey: true })
    expect(state.selected).toEqual([{ type: 'via', index: 2 }])
    fake.click('via', 3)
    expect(state.selected).toEqual([{ type: 'via', index: 3 }])
  })

  test('an empty click clears only without a modifier', () => {
    const { fake, state } = setup()
    fake.click('via', 1)
    fake.click(null, null, { shiftKey: true })
    expect(state.selected).toHaveLength(1)
    fake.click(null, null)
    expect(state.selected).toEqual([])
  })

  test('nothing selects while the editor is not selecting', () => {
    const { fake, state } = setup({ active: false, swept: [candidate('via', 1)] })
    fake.click('via', 1)
    fake.band(true)
    expect(state.selected).toEqual([])
  })

  test('a band resolves through the filter, kind and lock alike', () => {
    const allows: AllowsHit = (level) => level.kind !== 'zone' && !level.locked
    const swept = [
      candidate('via', 1),
      candidate('zone', 0),
      candidate('segment', 2, 'track', true)
    ]
    const { fake, state, selection } = setup({ swept, allows })
    fake.band(false)
    expect(state.selected).toEqual([{ type: 'via', index: 1 }])
    expect(selection.selectAll()).toEqual([{ type: 'via', index: 1 }])
  })

  test('a plain band replaces, a modified band adds without repeating', () => {
    const { fake, state } = setup({ swept: [candidate('via', 2), candidate('via', 3)] })
    fake.click('via', 1)
    fake.click('via', 2, { shiftKey: true })
    fake.band(false, { shiftKey: true })
    expect(state.selected).toEqual([
      { type: 'via', index: 1 },
      { type: 'via', index: 2 },
      { type: 'via', index: 3 }
    ])
    fake.band(false)
    expect(state.selected).toEqual([
      { type: 'via', index: 2 },
      { type: 'via', index: 3 }
    ])
  })

  test('Ctrl+Shift / Cmd+Shift takes out, by click and by band, and never adds', () => {
    const { fake, state } = setup({ swept: [candidate('via', 2), candidate('via', 4)] })
    fake.click('via', 1)
    fake.click('via', 2, { shiftKey: true })
    fake.click('via', 3, { shiftKey: true })
    fake.click('via', 3, { ctrlKey: true, shiftKey: true })
    fake.click('via', 5, { metaKey: true, shiftKey: true })
    expect(state.selected).toEqual([
      { type: 'via', index: 1 },
      { type: 'via', index: 2 }
    ])
    fake.band(true, { metaKey: true, shiftKey: true })
    expect(state.selected).toEqual([{ type: 'via', index: 1 }])
    fake.click(null, null, { ctrlKey: true, shiftKey: true })
    expect(state.selected).toEqual([{ type: 'via', index: 1 }])
  })

  test('the item at the cursor honours the filter and a narrowing, and is nothing off the canvas', () => {
    const under = [candidate('via', 1), candidate('segment', 2, 'track')]
    const { fake, selection } = setup({ under, allows: (l) => l.kind !== 'via' })
    expect(selection.itemAtCursor()).toEqual({ type: 'segment', index: 2 })
    expect(selection.itemAtCursor((r) => r.type !== 'segment')).toBeNull()
    fake.pointer.at = null
    expect(selection.itemAtCursor()).toBeNull()
  })

  describe('Select Other', () => {
    const under = [candidate('via', 1), candidate('segment', 2, 'track'), candidate('via', 1)]

    test('lists each item under the pointer once, where the list was asked for', () => {
      const { fake, selection } = setup({ under })
      fake.hold()
      expect(selection.selectOther.value).toMatchObject({
        x: 5,
        y: 6,
        items: [
          { type: 'via', index: 1 },
          { type: 'segment', index: 2 }
        ]
      })
    })

    test('one item is no choice: it is selected and no list opens', () => {
      const { fake, state, selection } = setup({ under: [candidate('via', 1)] })
      fake.hold()
      expect(selection.selectOther.value).toBeNull()
      expect(state.selected).toEqual([{ type: 'via', index: 1 }])
    })

    test('a row previews, a pick keeps it, closing without one restores the selection before the press', () => {
      const { fake, state, selection } = setup({ under })
      state.selected = [{ type: 'zone', index: 9 }]
      fake.press({ button: 0 })
      // The held press selected what it landed on before the list opened.
      state.selected = [{ type: 'via', index: 1 }]
      fake.hold()
      selection.previewSelectOther([{ type: 'segment', index: 2 }])
      expect(state.selected).toEqual([{ type: 'segment', index: 2 }])
      selection.previewSelectOther(null)
      expect(state.selected).toEqual([{ type: 'zone', index: 9 }])
      selection.closeSelectOther()
      expect(state.selected).toEqual([{ type: 'zone', index: 9 }])
      expect(selection.selectOther.value).toBeNull()

      fake.hold()
      selection.closeSelectOther([{ type: 'segment', index: 2 }])
      expect(state.selected).toEqual([{ type: 'segment', index: 2 }])
    })

    test('the menu restores the selection as it is, not as the last press found it', () => {
      const { fake, state, selection } = setup({ under })
      fake.press({ button: 0 })
      state.selected = [{ type: 'zone', index: 4 }]
      selection.selectOtherAt({ x: 5, y: 6 })
      selection.closeSelectOther()
      expect(state.selected).toEqual([{ type: 'zone', index: 4 }])
    })
  })
})
