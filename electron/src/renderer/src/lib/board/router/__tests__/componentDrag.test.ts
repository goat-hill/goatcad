import { describe, expect, test } from 'vitest'
import { ComponentDragSession } from '../componentDrag'
import type { RouterWorld } from '../world'
import { allAngled, track, world } from './routerFixture'

// docs/router-behavior.md D13.

/** A footprint at (5, 0) with pads of net 1 at its left and right, and one of net 2 below. */
const part = `(footprint "T:U" (layer "F.Cu") (uuid "f-u") (at 5 0)
  (pad "1" smd rect (at -1 0) (size 0.6 0.6) (layers "F.Cu") (net 1 "SIG"))
  (pad "2" smd rect (at 1 0) (size 0.6 0.6) (layers "F.Cu") (net 1 "SIG"))
  (pad "3" smd rect (at 0 1) (size 0.6 0.6) (layers "F.Cu") (net 2 "OBS")))`

const padsOf = (w: RouterWorld): ReturnType<RouterWorld['itemsNear']> =>
  w.base.items.filter((i) => i?.ref.type === 'pad' && i.ref.index === 0)

describe('D13: dragging a footprint', () => {
  test('a track ending on a pad has that end carried along, its far end pinned', () => {
    const w = world(`${part}\n${track(0, 0, 4, 0, 1)}`)
    const s = new ComponentDragSession(w, padsOf(w), { x: 5, y: 0 }, 0.2)
    const u = s.update({ x: 5, y: 2 })
    expect(u.lines).toHaveLength(1)
    const path = u.lines[0].path
    expect(path[0].x).toBeCloseTo(0, 9)
    expect(path[0].y).toBeCloseTo(0, 9)
    expect(path[path.length - 1].x).toBeCloseTo(4, 9)
    expect(path[path.length - 1].y).toBeCloseTo(2, 9)
    expect(allAngled(path)).toBe(true)
    expect(u.blocked).toBe(false)
    expect(u.hiddenRefs).toEqual([{ type: 'segment', index: 0 }])
  })

  test('a track from one of its pads to another moves with it whole', () => {
    const w = world(`${part}\n${track(4, 0, 6, 0, 1)}`)
    const s = new ComponentDragSession(w, padsOf(w), { x: 5, y: 0 }, 0.2)
    const path = s.update({ x: 7, y: 1 }).lines[0].path
    expect(path.map((p) => [+p.x.toFixed(6), +p.y.toFixed(6)])).toEqual([
      [6, 1],
      [8, 1]
    ])
  })

  test('moved into other copper, the drag is marked and blocked', () => {
    // A net-3 track crossing above the footprint.
    const w = world(`${part}\n${track(0, -2, 10, -2, 3)}`)
    const s = new ComponentDragSession(w, padsOf(w), { x: 5, y: 0 }, 0.2)
    expect(s.update({ x: 5, y: 0.5 }).blocked).toBe(false)
    const u = s.update({ x: 5, y: 1.8 })
    expect(u.blocked).toBe(true)
    expect(u.violators).toContainEqual({ type: 'segment', index: 0 })
  })

  test('D7: back where it started, nothing changes', () => {
    const w = world(`${part}\n${track(0, 0, 4, 0, 1)}`)
    const s = new ComponentDragSession(w, padsOf(w), { x: 5, y: 0 }, 0.2)
    s.update({ x: 6, y: 1 })
    expect(s.unchanged()).toBe(false)
    s.update({ x: 5, y: 0 })
    expect(s.unchanged()).toBe(true)
    expect(s.delta()!.move).toEqual({ x: 0, y: 0 })
  })
})
