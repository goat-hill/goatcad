import { describe, expect, test } from 'vitest'
import { ViaDragSession } from '../viaDrag'
import type { RouterWorld } from '../world'
import type { CopperItem } from '../../spatialIndex'
import { allAngled, pad, via, world } from './routerFixture'

// docs/router-behavior.md D6–D9 for a via.

/** A raw segment on a layer; source y is KiCad's (down). */
const seg = (x0: number, y0: number, x1: number, y1: number, layer: string, net: number): string =>
  `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.25) (layer "${layer}") (net ${net}) (uuid "s-${x0}-${y0}-${x1}-${y1}-${layer}"))`

/** A net-1 via at (5, 0) carrying an F.Cu track from the left and a B.Cu one from the right. */
const carried = `${via(5, 0, 1)}\n${seg(0, 0, 5, 0, 'F.Cu', 1)}\n${seg(5, 0, 10, 0, 'B.Cu', 1)}`

const viaOf = (w: RouterWorld): CopperItem => w.base.items.find((i) => i.ref.type === 'via')!

const session = (body: string): { s: ViaDragSession; w: RouterWorld } => {
  const w = world(`${carried}\n${body}`)
  return { s: new ViaDragSession(w, viaOf(w), 0.2), w }
}

/** A net-2 B.Cu track along world y = `y`, its ends far off. */
const backObstacle = (y: number): string => seg(-6, -y, 16, -y, 'B.Cu', 2)

describe('D6: the via follows the cursor, carrying its tracks', () => {
  test('both tracks re-draw their last bend to meet it, far ends pinned', () => {
    const { s } = session('')
    expect(s.lines).toHaveLength(2)
    const u = s.update({ x: 5, y: 2 }, 'highlight')
    expect(u.at).toEqual({ x: 5, y: 2 })
    expect(u.blocked).toBe(false)
    const near = (p: { x: number; y: number }, x: number, y: number): void => {
      expect(p.x).toBeCloseTo(x, 9)
      expect(p.y).toBeCloseTo(y, 9)
    }
    for (const line of u.lines) near(line.path[line.path.length - 1], 5, 2)
    near(u.lines.find((l) => l.layer === 'F.Cu')!.path[0], 0, 0)
    near(u.lines.find((l) => l.layer === 'B.Cu')!.path[0], 10, 0)
    // The via and its tracks are hidden where they were.
    expect(u.preview.hiddenRefs).toEqual(
      expect.arrayContaining([
        { type: 'via', index: 0 },
        { type: 'segment', index: 0 },
        { type: 'segment', index: 1 }
      ])
    )
  })

  test('D6: in 90° mode the carried tracks re-draw in right angles', () => {
    const { s } = session('')
    const u = s.update({ x: 7, y: 3 }, 'highlight', '90')
    for (const line of u.lines) expect(allAngled(line.path, 90)).toBe(true)
  })

  test('D7: back where it started writes nothing; moved, it writes the via and its tracks', () => {
    const { s } = session('')
    expect(s.unchanged()).toBe(true)
    s.update({ x: 5, y: 0 }, 'highlight')
    expect(s.unchanged()).toBe(true)
    s.update({ x: 5, y: 2 }, 'highlight')
    expect(s.unchanged()).toBe(false)
    const d = s.delta()!
    expect(d.movedVias).toEqual([{ index: 0, x: 5, y: 2 }])
    expect(d.removed).toEqual(
      expect.arrayContaining([
        { type: 'segment', index: 0 },
        { type: 'segment', index: 1 }
      ])
    )
    expect(d.added.every((a) => a.net === 1)).toBe(true)
  })
})

describe('D8: collisions', () => {
  test('Highlight: the via goes where the cursor is and is marked', () => {
    const { s } = session(backObstacle(2))
    const u = s.update({ x: 5, y: 2 }, 'highlight')
    expect(u.at).toEqual({ x: 5, y: 2 })
    expect(u.viaViolation).toBe(true)
    expect(u.blocked).toBe(true)
    expect(u.marks.length).toBeGreaterThan(0)
  })

  test('Avoid: the via slides to the clear spot nearest the cursor, on the side it came from', () => {
    // The B.Cu track at y = 2 keeps the via 0.125 + 0.2 + 0.3 off its centerline.
    const { s } = session(backObstacle(2))
    s.update({ x: 5, y: 0.5 }, 'walkaround')
    const u = s.update({ x: 5, y: 2.1 }, 'walkaround')
    expect(u.at.x).toBeCloseTo(5, 6)
    expect(u.at.y).toBeCloseTo(1.375, 3)
    expect(u.blocked).toBe(false)
  })

  test('Avoid: the carried tracks take the shorter way round what they walk, whatever came before', () => {
    // An F.Cu pad below the left track's way: swept from above, the track
    // goes round it as a drag straight to the last spot does (KiCad's shortest walk).
    const swept = session(pad(2.5, 0, 0.6)).s
    swept.update({ x: 5, y: 2 }, 'walkaround')
    swept.update({ x: 5, y: 0.6 }, 'walkaround')
    const u = swept.update({ x: 5, y: -0.4 }, 'walkaround')
    const fresh = session(pad(2.5, 0, 0.6)).s.update({ x: 5, y: -0.4 }, 'walkaround')
    expect(u.blocked).toBe(false)
    expect(u.lines).toEqual(fresh.lines)
  })

  test('Push: what it meets on another layer moves aside', () => {
    const { s } = session(backObstacle(2))
    const u = s.update({ x: 5, y: 2 }, 'shove')
    expect(u.at).toEqual({ x: 5, y: 2 })
    expect(u.blocked).toBe(false)
    const d = s.delta()!
    expect(d.removed).toEqual(expect.arrayContaining([{ type: 'segment', index: 2 }]))
    expect(d.added.some((a) => a.net === 2 && a.layer === 'B.Cu')).toBe(true)
  })

  test('Push against what cannot move does as Avoid does (P5)', () => {
    const { s } = session(pad(5, -2, 0.6))
    s.update({ x: 5, y: 0.5 }, 'shove')
    const u = s.update({ x: 5, y: 2 }, 'shove')
    expect(u.at.x).toBeCloseTo(5, 6)
    expect(u.at.y).toBeCloseTo(1.2, 3)
    expect(u.blocked).toBe(false)
  })
})
