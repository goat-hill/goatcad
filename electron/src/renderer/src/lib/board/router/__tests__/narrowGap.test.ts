import { describe, expect, test } from 'vitest'
import { RouteSession } from '../engine'
import { outline, pad, pointsOf, request, world } from './routerFixture'

// docs/router-behavior.md R13 (narrow gaps) and K1 (Shift+W when a narrower size passes).

const O = { x: 0, y: 0 }
/** Two tall pads at x = 5 with 1.2 mm of board between them: 0.5 + 2 × 0.5 = 1.5 will not pass, 0.1 + 1 will. */
const gap = (): ReturnType<typeof world> => world(`${pad(5, 3.6, 6, 'A')}\n${pad(5, -3.6, 6, 'B')}`)

describe('narrow gaps', () => {
  test('a gap the width does not pass is a wall, though a narrower legal size would (R13)', () => {
    const p = new RouteSession(gap()).propose(request(O, { x: 10, y: 0 }, { narrowestWidth: 0.1 }))
    expect(pointsOf(p.segments).every((q) => Math.abs(q.y) < 0.01)).toBe(false)
    expect(p.narrowerFails).toBeUndefined()
  })

  test('K1: blocked where even the narrowest legal size does not pass, the proposal says so', () => {
    // 0.6 mm between the pads, which run off the board on both sides.
    const w = world(
      `${pad(5, 3.3, 6, 'A')}\n${pad(5, -3.3, 6, 'B')}\n${outline([-2, -6], [12, -6], [12, 6], [-2, 6])}`,
      0
    )
    const p = new RouteSession(w).propose(request(O, { x: 10, y: 0 }, { narrowestWidth: 0.1 }))
    expect(p.state).toBe('blocked')
    expect(p.narrowerFails).toBe(true)
    expect(pointsOf(p.segments).every((q) => q.x < 5)).toBe(true)
  })
})
