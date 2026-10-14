import { describe, expect, test } from 'vitest'
import { gestureFree, redoAllowed, undoTarget, type LiveGestures } from '../liveGesture'

const none: LiveGestures = { drag: false, pair: false, tune: false, route: false }

describe('R22: undo and redo while a gesture is live', () => {
  test('with nothing live, undo and redo are history', () => {
    expect(undoTarget(none)).toBe('history')
    expect(redoAllowed(none)).toBe(true)
    expect(gestureFree(none)).toBe(true)
  })

  test.each(['drag', 'pair', 'tune', 'route'] as const)(
    'a live %s takes undo, and holds redo and new gestures off',
    (live) => {
      const state = { ...none, [live]: true }
      expect(undoTarget(state)).toBe(live)
      expect(redoAllowed(state)).toBe(false)
      expect(gestureFree(state)).toBe(false)
    }
  )

  test('a drag is undone before what it runs inside', () => {
    expect(undoTarget({ drag: true, pair: true, tune: true, route: true })).toBe('drag')
    expect(undoTarget({ ...none, pair: true, route: true })).toBe('pair')
  })
})
