import { describe, expect, test } from 'vitest'
import { ArcDragSession } from '../arcDrag'
import type { RouterWorld } from '../world'
import type { CopperItem, Pt } from '../../spatialIndex'
import { track, via, world } from './routerFixture'

// docs/router-behavior.md D15.

/**
 * A run along world y = 0 into a quarter arc of radius 1 turning up into a
 * run along x = 1: the corner the arc rounds is (1, 0). Source y is down.
 */
const s = Math.SQRT1_2
const arc = (net = 1): string =>
  `(arc (start 0 0) (mid ${s} ${-(1 - s)}) (end 1 -1) (width 0.25) (layer "F.Cu") (net ${net}) (uuid "a-1"))`
const thin = (x0: number, y0: number, x1: number, y1: number): string =>
  `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.25) (layer "F.Cu") (net 1) (uuid "t-${x0}-${y0}"))`
const board = `${thin(-5, 0, 0, 0)}\n${arc()}\n${thin(1, -1, 1, -6)}`

const arcOf = (w: RouterWorld): CopperItem => w.base.items.find((i) => i?.ref.type === 'tarc')!
const near = (p: Pt | undefined, x: number, y: number): void => {
  expect(p?.x).toBeCloseTo(x, 3)
  expect(p?.y).toBeCloseTo(y, 3)
}

describe('D15: dragging an arc', () => {
  test('pulled toward the corner it tightens, still tangent to both runs, and they meet it', () => {
    const w = world(board)
    const session = new ArcDragSession(w, arcOf(w), 0.2)
    expect(session.valid).toBe(true)
    // Its middle half way to the corner along the bisector.
    const corner = { x: 1, y: 0 }
    const out = session.update({
      x: corner.x - 0.5 * s * (Math.SQRT2 - 1),
      y: corner.y + 0.5 * s * (Math.SQRT2 - 1)
    })
    const r = out.result
    const t = 0.5
    near(r.arc?.start, 1 - t, 0)
    near(r.arc?.end, 1, t)
    expect(r.neighbours).toHaveLength(2)
    near(r.neighbours.find((n) => n.index === 0)?.end, 1 - t, 0)
    near(r.neighbours.find((n) => n.index === 1)?.end, 1, t)
    expect(out.blocked).toBe(false)
  })

  test('pulled out it widens, as far as the runs either side reach', () => {
    const w = world(board)
    const session = new ArcDragSession(w, arcOf(w), 0.2)
    const r = session.update({ x: -20, y: 20 }).result
    // The run along y = 0 starts 6 from the corner, the one up x = 1 runs 6: the tighter wins.
    near(r.arc?.start, -5, 0)
    near(r.arc?.end, 1, 6)
  })

  test('into the corner the arc closes up and the runs meet there', () => {
    const w = world(board)
    const session = new ArcDragSession(w, arcOf(w), 0.2)
    const r = session.update({ x: 1.2, y: -0.2 }).result
    expect(r.arc).toBeNull()
    for (const n of r.neighbours) near(n.end, 1, 0)
  })

  test('an end with no run along its tangent stays put, joined by a straight; the arc only tightens', () => {
    const w = world(`${arc()}\n${thin(1, -1, 1, -6)}`)
    const session = new ArcDragSession(w, arcOf(w), 0.2)
    const r = session.update({ x: -20, y: 20 }).result
    near(r.arc?.start, 0, 0)
    expect(r.added).toHaveLength(0)
    const tighter = session.update({ x: 1 - 0.2, y: 0.2 }).result
    expect(tighter.added).toHaveLength(1)
    near(tighter.added[0].start, 0, 0)
  })

  describe('the collision mode applies, as to a segment drag (KiCad)', () => {
    // A via of net 2 inside the arc's bend, clear of it as it is: widened to
    // tangent length 3, the arc's middle comes within 0.03 of its copper.
    const withVia = `${board}\n${via(-0.2, -1.2)}`
    const corner = { x: 1, y: 0 }
    const reach = 3 * (Math.SQRT2 - 1)
    const pulled = { x: corner.x - reach * s, y: corner.y + reach * s }

    test('Highlight marks it', () => {
      const w = world(withVia)
      const u = new ArcDragSession(w, arcOf(w), 0.2).update(pulled, 'highlight')
      expect(u.blocked).toBe(true)
      expect(u.violators).toContainEqual({ type: 'via', index: 0 })
    })

    test('Push pushes it aside and keeps the arc', () => {
      const w = world(withVia)
      const session = new ArcDragSession(w, arcOf(w), 0.2)
      const u = session.update(pulled, 'shove')
      expect(u.blocked).toBe(false)
      near(u.line.arc?.start, -2, 0)
      near(u.line.arc?.end, 1, 3)
      expect(u.preview.vias?.map((v) => v.index)).toEqual([0])
      const d = session.routerDelta()!
      expect(d.movedVias?.map((v) => v.index)).toEqual([0])
      expect(d.removed).toEqual(
        expect.arrayContaining([
          { type: 'tarc', index: 0 },
          { type: 'segment', index: 0 },
          { type: 'segment', index: 1 }
        ])
      )
      expect(d.addedArcs).toHaveLength(1)
      expect(d.added).toHaveLength(2)
      expect(session.unchanged()).toBe(false)
    })

    test('Avoid walks the line round it: bent there, the arc lands as straight track', () => {
      const w = world(withVia)
      const session = new ArcDragSession(w, arcOf(w), 0.2)
      const u = session.update(pulled, 'walkaround')
      expect(u.blocked).toBe(false)
      expect(u.line.arc).toBeNull()
      // Its far ends held.
      near(u.line.before[0], -5, 0)
      near(u.line.before[u.line.before.length - 1], 1, 6)
      expect(u.preview.vias ?? []).toHaveLength(0)
      const d = session.routerDelta()!
      expect(d.addedArcs).toBeUndefined()
      expect(d.added.length).toBe(u.line.before.length - 1)
    })
  })

  test('what it is dragged into is marked', () => {
    const w = world(`${board}\n${track(0, -3, 0, -6, 3)}`)
    const session = new ArcDragSession(w, arcOf(w), 0.2)
    const u = session.update({ x: -20, y: 20 })
    expect(u.blocked).toBe(true)
    expect(u.violators).toContainEqual({ type: 'segment', index: 2 })
    expect(u.marks.length).toBeGreaterThan(0)
  })
})
