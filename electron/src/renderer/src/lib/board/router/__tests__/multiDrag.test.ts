import { describe, expect, test } from 'vitest'
import { MultiDragSession } from '../multiDrag'
import { allAngled, seedAt, track, world } from './routerFixture'

// docs/router-behavior.md D14.

/** Two U-shaped lines, one inside the other: net 1's floor at world y 4, net 3's at 2.5. */
const bus = [
  track(0, 0, 0, -4, 1),
  track(0, -4, 10, -4, 1),
  track(10, -4, 10, 0, 1),
  track(2, 0, 2, -2.5, 3),
  track(2, -2.5, 8, -2.5, 3),
  track(8, -2.5, 8, 0, 3)
].join('\n')

const floorY = (path: ReadonlyArray<{ x: number; y: number }>): number =>
  Math.max(...path.map((p) => p.y))

describe('D14: several tracks dragged at once', () => {
  test('the line under the cursor leads; a parallel one follows, keeping its spacing', () => {
    const w = world(bus)
    const s = new MultiDragSession(w, [seedAt(w, 5, 4), seedAt(w, 5, 2.5)], { x: 5, y: 4 }, 0.2)
    expect(s.valid).toBe(true)
    const u = s.update({ x: 5, y: 6 }, 'highlight')
    expect(floorY(u.lines[0].path)).toBeCloseTo(6, 9)
    expect(floorY(u.lines[1].path)).toBeCloseTo(4.5, 9)
    for (const l of u.lines) expect(allAngled(l.path)).toBe(true)
    expect(u.blocked).toBe(false)
  })

  test('the delta replaces every dragged line', () => {
    const w = world(bus)
    const s = new MultiDragSession(w, [seedAt(w, 5, 4), seedAt(w, 5, 2.5)], { x: 5, y: 4 }, 0.2)
    s.update({ x: 5, y: 6 }, 'walkaround')
    const d = s.delta()!
    expect(d.removed).toHaveLength(6)
    expect(new Set(d.added.map((a) => a.net))).toEqual(new Set([1, 3]))
    expect(s.unchanged()).toBe(false)
  })

  test('in Push, what the bus meets is pushed for all of it', () => {
    // A net-2 track above the bus, crossing where the floors move to.
    const w = world(`${bus}\n${track(-3, -7, 13, -7)}`)
    const s = new MultiDragSession(w, [seedAt(w, 5, 4), seedAt(w, 5, 2.5)], { x: 5, y: 4 }, 0.2)
    const u = s.update({ x: 5, y: 6.5 }, 'shove')
    expect(u.blocked).toBe(false)
    expect(u.preview.hiddenRefs).toContainEqual({ type: 'segment', index: 6 })
  })

  test('in Push, a push that cannot be done blocks the drag: no line is walked instead (KiCad)', () => {
    // A stub of net 2 in the way of net 3's new floor. Avoid walks round it;
    // a push given no work to do it in fails, and the drag is blocked where
    // it was drawn rather than falling back to walking.
    const body = `${bus}\n${track(4.5, -5, 5.5, -5)}`
    const drag = (mode: 'shove' | 'walkaround'): ReturnType<MultiDragSession['update']> => {
      const w = world(body)
      const s = new MultiDragSession(w, [seedAt(w, 5, 4), seedAt(w, 5, 2.5)], { x: 5, y: 4 }, 0.2, {
        workBudget: 0
      })
      return s.update({ x: 5, y: 6.5 }, mode)
    }
    const avoid = drag('walkaround')
    expect(avoid.blocked).toBe(false)
    expect(avoid.lines[1].path.length).toBeGreaterThan(4)

    const push = drag('shove')
    expect(push.blocked).toBe(true)
    expect(push.preview.segments).toHaveLength(0)
    // As drawn: net 3's floor straight through the stub at world y 5.
    expect(push.lines[1].path).toHaveLength(4)
    expect(push.lines[1].violations.some(Boolean)).toBe(true)
  })

  test('in Push, copper of one dragged net pushed by another stays on the board', () => {
    // A net-3 track above the bus, which net 1's floor pushes up; a net-2
    // track just above where net 3's floor goes, so net 3 pushes after net 1 has.
    const w = world(`${bus}\n${track(-3, -7, 13, -7, 3)}\n${track(3, -5.8, 7, -5.8)}`)
    const s = new MultiDragSession(w, [seedAt(w, 5, 4), seedAt(w, 5, 2.5)], { x: 5, y: 4 }, 0.2)
    const u = s.update({ x: 5, y: 6.5 }, 'shove')
    expect(u.blocked).toBe(false)
    const d = s.delta()!
    expect(d.removed).toContainEqual({ type: 'segment', index: 6 })
    const pushed = d.added.filter((a) => a.net === 3 && Math.min(a.start.y, a.end.y) > 6.5)
    expect(pushed.length).toBeGreaterThan(0)
    expect(u.preview.segments.some((p) => Math.min(p.y0, p.y1) > 6.5)).toBe(true)
  })
})
