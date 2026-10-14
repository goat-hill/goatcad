import { describe, expect, test } from 'vitest'
import { DragSession, dragGeometry, snapDragCursor } from '../drag'
import { selfCrosses } from '../geometry'
import type { Pt } from '../../spatialIndex'
import { allAngled, seedAt, track, world } from './routerFixture'

// docs/router-behavior.md D1–D10.

const L: Pt[] = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 5, y: 5 }
]

// A horizontal run, a 45° chamfer, a vertical run.
const CHAMFER: Pt[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 12, y: 2 },
  { x: 12, y: 10 }
]

const endsHeld = (out: readonly Pt[], path: readonly Pt[]): void => {
  expect(out[0]).toEqual(path[0])
  expect(out[out.length - 1]).toEqual(path[path.length - 1])
}

describe('dragGeometry', () => {
  test('D5: free corner drag puts the corner on the cursor', () => {
    const out = dragGeometry(L, { kind: 'corner', index: 1 }, { x: 6, y: 1 }, 'free')!
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 6, y: 1 },
      { x: 5, y: 5 }
    ])
  })

  test('D5: a 45° corner drag re-draws both sides as bends through the cursor', () => {
    const out = dragGeometry(L, { kind: 'corner', index: 1 }, { x: 6, y: 1 }, '45')!
    endsHeld(out, L)
    expect(out).toContainEqual({ x: 6, y: 1 })
    expect(allAngled(out)).toBe(true)
    // Each side leaves its pin the way it did.
    expect(out[1].y).toBeCloseTo(0, 9)
    expect(out[out.length - 2].x).toBeCloseTo(5, 9)
  })

  test('D2, D4: a line-end segment moves to the cursor with a stub from its pinned end', () => {
    const out = dragGeometry(L, { kind: 'segment', index: 0 }, { x: 2, y: -2 }, '45')!
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: -2 },
      { x: 5, y: -2 },
      { x: 5, y: 5 }
    ])
  })

  test('D2: the neighbors keep their directions while they can', () => {
    const out = dragGeometry(CHAMFER, { kind: 'segment', index: 1 }, { x: 10, y: 3 }, '45')!
    endsHeld(out, CHAMFER)
    expect(allAngled(out)).toBe(true)
    // The chamfer moved out along its normal: longer, neighbors shorter.
    expect(out[1].y).toBeCloseTo(0, 9)
    expect(out[2].x).toBeCloseTo(12, 9)
  })

  test('D3: a chamfer pulled past its corner collapses into the corner — no bow tie', () => {
    const out = dragGeometry(CHAMFER, { kind: 'segment', index: 1 }, { x: 14, y: -2 }, '45')!
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      { x: 12, y: 10 }
    ])
  })

  test('D3: across a sweep of cursors, a drag never crosses itself or leaves its angles', () => {
    for (const mode of ['45', '90'] as const) {
      for (let x = -4; x <= 20; x += 0.7) {
        for (let y = -6; y <= 12; y += 0.7) {
          const path = mode === '45' ? CHAMFER : L
          for (const grab of [
            { kind: 'segment' as const, index: 0 },
            { kind: 'segment' as const, index: 1 },
            { kind: 'corner' as const, index: 1 }
          ]) {
            const out = dragGeometry(path, grab, { x, y }, mode)
            if (!out) continue
            expect(selfCrosses(out)).toBe(false)
            expect(allAngled(out, mode === '90' ? 90 : 45)).toBe(true)
            endsHeld(out, path)
          }
        }
      }
    }
  })
})

describe('DragSession', () => {
  const line = track(0, 0, 10, 0, 1)

  test('D1, D2: a clean drag proposes the moved line and hides the original', () => {
    const w = world(line)
    const session = new DragSession(w, seedAt(w, 5, 0), { x: 5, y: 0 }, 0.5)
    expect(session.valid).toBe(true)
    expect(session.grab.kind).toBe('segment')
    const u = session.update({ x: 5, y: 2 }, 'shove')
    expect(u.blocked).toBe(false)
    expect(u.path.some((p) => Math.abs(p.y - 2) < 1e-9)).toBe(true)
    expect(u.path[0].x).toBeCloseTo(0, 12)
    expect(u.path[0].y).toBeCloseTo(0, 12)
    expect(u.path[u.path.length - 1].x).toBeCloseTo(10, 12)
    expect(u.path[u.path.length - 1].y).toBeCloseTo(0, 12)
    expect(u.preview.hiddenRefs).toContainEqual({ type: 'segment', index: 0 })
    const delta = session.delta()!
    expect(delta.blocked).toBe(false)
    expect(delta.removed).toContainEqual({ type: 'segment', index: 0 })
    expect(delta.added.every((s) => s.net === 1 && s.layer === 'F.Cu')).toBe(true)
  })

  test('D1: a chained line drags as one and keeps its far ends', () => {
    const w = world(`${track(0, 0, 5, 0, 1)}\n${track(5, 0, 5, -5, 1)}`)
    const session = new DragSession(w, seedAt(w, 2, 0), { x: 2, y: 0 }, 0.5)
    expect(session.line.ids).toHaveLength(2)
    const u = session.update({ x: 2, y: 1 }, 'highlight')
    expect(u.blocked).toBe(false)
    expect(u.path[0].x).toBeCloseTo(0, 9)
    expect(u.path[0].y).toBeCloseTo(0, 9)
    expect(u.path[u.path.length - 1].x).toBeCloseTo(5, 9)
    expect(u.path[u.path.length - 1].y).toBeCloseTo(5, 9)
  })

  test('D8: dragging into another track pushes it aside', () => {
    const w = world(`${line}\n${track(-6, -2, 16, -2)}`)
    const session = new DragSession(w, seedAt(w, 5, 0), { x: 5, y: 0 }, 0.5)
    const u = session.update({ x: 5, y: 2 }, 'shove')
    expect(u.blocked).toBe(false)
    expect(u.path.some((p) => Math.abs(p.y - 2) < 1e-9)).toBe(true)
    expect(session.delta()!.added.some((s) => s.net === 2)).toBe(true)
  })

  test('D8: avoid bends the dragged part round what it meets, ends held', () => {
    const w = world(`${line}\n${track(4, -2, 6, -2)}`)
    const session = new DragSession(w, seedAt(w, 5, 0), { x: 5, y: 0 }, 0.5)
    const u = session.update({ x: 2, y: 2 }, 'walkaround')
    expect(u.path[0].x).toBeCloseTo(0, 12)
    expect(u.path[0].y).toBeCloseTo(0, 12)
    expect(u.path[u.path.length - 1].x).toBeCloseTo(10, 12)
    expect(u.path[u.path.length - 1].y).toBeCloseTo(0, 12)
    expect(u.blocked).toBe(false)
    expect(u.violations.every((v) => !v)).toBe(true)
    // Over the net-2 track at y 2, by 0.25 + 0.5 + 0.25.
    expect(Math.max(...u.path.map((p) => p.y))).toBeGreaterThanOrEqual(3 - 1e-6)
  })

  test('D8: a push that cannot be settled refuses the drag where it stands, not walked round', () => {
    // No work allowed: the push into the net-2 track cannot settle (KiCad's dragger refuses).
    const w = world(`${line}\n${track(-6, -2, 16, -2)}`)
    const session = new DragSession(w, seedAt(w, 5, 0), { x: 5, y: 0 }, 0.5, { workBudget: 0 })
    const u = session.update({ x: 5, y: 2 }, 'shove')
    expect(u.blocked).toBe(true)
    // The drawn geometry, through the track: no detour over it.
    expect(Math.max(...u.path.map((p) => p.y))).toBeCloseTo(2, 9)
    expect(u.preview.segments).toHaveLength(0)
    expect(session.delta()!.blocked).toBe(true)
  })

  test('D7: a drag that ends where it started changes nothing', () => {
    const w = world(line)
    const session = new DragSession(w, seedAt(w, 5, 0), { x: 5, y: 0 }, 0.5)
    expect(session.unchanged()).toBe(true)
    session.update({ x: 5, y: 0 }, 'shove')
    expect(session.unchanged()).toBe(true)
    session.update({ x: 5, y: 2 }, 'shove')
    expect(session.unchanged()).toBe(false)
    session.update({ x: 5, y: 0 }, 'shove')
    expect(session.unchanged()).toBe(true)
  })

  test('D8, F2: highlight marks the violation and what is violated', () => {
    const w = world(`${line}\n${track(-6, -2, 16, -2)}`)
    const session = new DragSession(w, seedAt(w, 5, 0), { x: 5, y: 0 }, 0.5)
    const u = session.update({ x: 5, y: 2 }, 'highlight')
    expect(u.blocked).toBe(true)
    expect(u.violators).toContainEqual({ type: 'segment', index: 1 })
    expect(u.marks.length).toBeGreaterThan(0)
    expect(session.delta()!.blocked).toBe(true)
  })
})

const near = (p: Pt, x: number, y: number): void => {
  expect(p.x).toBeCloseTo(x, 9)
  expect(p.y).toBeCloseTo(y, 9)
}

describe('D11: smoothing a drag', () => {
  // A step: along y = 0, a 45° chamfer up, along y = 2.
  const STEP: Pt[] = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 7, y: 2 },
    { x: 12, y: 2 },
    { x: 14, y: 4 },
    { x: 20, y: 4 }
  ]

  test('a dragged segment near the line of the one beyond its neighbour snaps into it', () => {
    // Dragging the y = 2 run down to near y = 0: it snaps onto y = 0.
    const at = snapDragCursor(STEP, { kind: 'segment', index: 2 }, { x: 9, y: 0.1 }, 0.125)
    expect(at.y).toBeCloseTo(0, 9)
    const out = dragGeometry(STEP, { kind: 'segment', index: 2 }, at, '45')!
    // The chamfer between closes up: one straight run along y = 0 into the next chamfer.
    expect(out.filter((p) => Math.abs(p.y) < 1e-9).length).toBe(2)
    expect(allAngled(out)).toBe(true)
  })

  test('a drag snaps within half a width in Push, a quarter in Avoid and Highlight (KiCad)', () => {
    // STEP as board tracks (0.5 wide), its y = 2 run dragged to 0.2 above the
    // y = 0 run: past a quarter width, within a half.
    const w = world(
      STEP.slice(1)
        .map((p, i) => track(STEP[i].x, -STEP[i].y, p.x, -p.y, 1))
        .join('\n')
    )
    const drag = (mode: 'shove' | 'walkaround' | 'highlight'): Pt[] =>
      new DragSession(w, seedAt(w, 9.5, 2), { x: 9.5, y: 2 }, 0.2).update({ x: 9.5, y: 0.2 }, mode)
        .path
    expect(drag('shove').some((p) => Math.abs(p.y - 0.2) < 1e-9)).toBe(false)
    for (const mode of ['walkaround', 'highlight'] as const)
      expect(drag(mode).some((p) => Math.abs(p.y - 0.2) < 1e-9)).toBe(true)
  })

  test('further off, the cursor is left alone', () => {
    const c = { x: 9, y: 0.5 }
    expect(snapDragCursor(STEP, { kind: 'segment', index: 2 }, c, 0.125)).toEqual(c)
  })

  test('a dragged corner near where two lines meet at 135° snaps onto it', () => {
    // Dragging corner (7, 2): the line of the y = 0 run and that of the
    // chamfer from (12, 2) meet at (10, 0), turning 45° there.
    const at = snapDragCursor(STEP, { kind: 'corner', index: 2 }, { x: 10.05, y: 0.05 }, 0.125)
    expect(at.x).toBeCloseTo(10, 9)
    expect(at.y).toBeCloseTo(0, 9)
  })
})

describe('D12: a free end', () => {
  test('grabbed, the end follows the cursor and its last bend re-draws', () => {
    const w = world(track(0, 0, 5, 0, 1))
    const session = new DragSession(w, seedAt(w, 2.5, 0), { x: 5, y: 0 }, 0.2)
    expect(session.grab.kind).toBe('end')
    const u = session.update({ x: 7, y: 2 }, 'walkaround')
    near(u.path[0], 0, 0)
    near(u.path[u.path.length - 1], 7, 2)
    expect(allAngled(u.path)).toBe(true)
  })

  test('an end on a pad is not free: grabbed there, the segment drags', () => {
    const own = `(footprint "T:O" (layer "F.Cu") (uuid "f-own") (at 5 0)
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG")))`
    const w = world(`${track(0, 0, 5, 0, 1)}\n${own}`)
    const session = new DragSession(w, seedAt(w, 2.5, 0), { x: 5, y: 0 }, 0.2)
    expect(session.grab.kind).toBe('segment')
  })
})

describe('D10: optimizing the whole dragged line', () => {
  test('a jagged run elsewhere on the line is pulled straight, the held part kept', () => {
    // A zig-zag start, then a long run that is dragged.
    const w = world(
      [
        track(0, 0, 1, 0, 1),
        track(1, 0, 1, -1, 1),
        track(1, -1, 2, -1, 1),
        track(2, -1, 2, 0, 1),
        track(2, 0, 10, 0, 1),
        track(10, 0, 10, 5, 1)
      ].join('\n')
    )
    const seed = seedAt(w, 6, 0)
    const plain = new DragSession(w, seed, { x: 6, y: 0 }, 0.2).update(
      { x: 6, y: 0.5 },
      'walkaround'
    )
    const tidy = new DragSession(w, seed, { x: 6, y: 0 }, 0.2, { optimizeDragged: true }).update(
      { x: 6, y: 0.5 },
      'walkaround'
    )
    expect(tidy.path.length).toBeLessThan(plain.path.length)
    near(tidy.path[0], 0, 0)
    near(tidy.path[tidy.path.length - 1], 10, -5)
  })
})
