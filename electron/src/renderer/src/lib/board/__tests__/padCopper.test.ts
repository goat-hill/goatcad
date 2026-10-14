import { beforeAll, describe, expect, test } from 'vitest'
import { loadClipper } from '../../geometry/clip'
import { parseKicadFootprint } from '../../kicad/footprint'
import {
  padAnchorShape,
  padCopperPieces,
  padHasPrimitives,
  padOutline,
  padPointDistance
} from '../padCopper'

// SOT-89-3 pad 2 as KiCad ships it: an anchor rect whose right edge and the
// tab polygon's left edge are both at x = -1.125 in pad space — abutting
// exactly, which is the case that leaves a seam when the two are drawn apart.
const SOT89 = `(footprint "SOT-89-3"
  (version 20240108)
  (generator "test")
  (layer "F.Cu")
  (pad "1" smd roundrect (at -1.95 -1.5) (size 1.3 0.9) (layers "F.Cu") (roundrect_rratio 0.25))
  (pad "2" smd custom (at -1.8625 0) (size 1.475 0.9) (layers "F.Cu")
    (options (clearance outline) (anchor rect))
    (primitives
      (gr_poly (pts (xy 3.8625 0.8665) (xy 0.7375 0.8665) (xy 0.7375 -0.8665) (xy 3.8625 -0.8665)) (width 0) (fill yes))
    )
  )
)`

const pads = parseKicadFootprint(SOT89).pads
const origin = { x: 0, y: 0 }

describe('padHasPrimitives', () => {
  test('separates a plain pad from one carrying primitives', () => {
    expect(padHasPrimitives(pads[0])).toBe(false)
    expect(padHasPrimitives(pads[1])).toBe(true)
  })
})

describe('padAnchorShape', () => {
  test('a custom pad anchors on its size, with the corner radius its options ask for', () => {
    expect(padAnchorShape(pads[1], origin, 0)).toEqual({
      kind: 'rrect',
      cx: 0,
      cy: 0,
      halfW: 0.7375,
      halfH: 0.45,
      cornerR: 0,
      rotation: 0
    })
  })

  test("a roundrect's radius is the ratio of its shorter side", () => {
    expect(padAnchorShape(pads[0], origin, 0)).toMatchObject({ cornerR: 0.9 * 0.25 })
  })
})

describe('padCopperPieces', () => {
  test('the anchor and the tab, in data space with y flipped up', () => {
    const pieces = padCopperPieces(pads[1], origin, 0)
    expect(pieces).toHaveLength(2)
    expect(pieces[0]).toMatchObject({ kind: 'shape', shape: { kind: 'rrect', halfW: 0.7375 } })
    expect(pieces[1].kind).toBe('fill')
    const points = pieces[1].kind === 'fill' ? pieces[1].points : []
    // Pad-local x 0.7375..3.8625, y ±0.8665 (y down) → the same x, y up.
    expect(Math.min(...points.map((p) => p.x))).toBeCloseTo(0.7375, 9)
    expect(Math.max(...points.map((p) => p.x))).toBeCloseTo(3.8625, 9)
    expect(Math.max(...points.map((p) => p.y))).toBeCloseTo(0.8665, 9)
  })

  test('the placement rotates and translates every piece', () => {
    const pieces = padCopperPieces(pads[1], { x: 10, y: 5 }, Math.PI / 2)
    const points = pieces[1].kind === 'fill' ? pieces[1].points : []
    // A quarter turn CCW sends pad-local +x to +y about the pad's center.
    expect(Math.max(...points.map((p) => p.y))).toBeCloseTo(5 + 3.8625, 9)
    expect(Math.min(...points.map((p) => p.x))).toBeCloseTo(10 - 0.8665, 9)
  })

  test('a plain pad is its anchor and nothing else', () => {
    expect(padCopperPieces(pads[0], origin, 0)).toHaveLength(1)
  })
})

describe('padOutline', () => {
  beforeAll(async () => {
    await loadClipper()
  })

  test('the anchor and the tab merge into one ring, with the shared edge gone', () => {
    const merged = padOutline(padCopperPieces(pads[1], origin, 0))
    expect(merged).not.toBeNull()
    expect(merged).toHaveLength(1)
    expect(merged?.[0].holes).toHaveLength(0)
    const ring = merged?.[0].outer ?? []
    // The union spans both pieces: the anchor's left edge to the tab's right.
    expect(Math.min(...ring.map((p) => p.x))).toBeCloseTo(-0.7375, 3)
    expect(Math.max(...ring.map((p) => p.x))).toBeCloseTo(3.8625, 3)
    expect(Math.max(...ring.map((p) => p.y))).toBeCloseTo(0.8665, 3)
    // No vertex sits on the old shared edge's interior: the union dissolved it.
    const onSeam = ring.filter((p) => Math.abs(p.x - 0.7375) < 1e-6 && Math.abs(p.y) < 0.45 - 1e-6)
    expect(onSeam).toEqual([])
  })

  test('a pad the engine cannot help with answers null rather than throwing', () => {
    expect(padOutline([])).toBeNull()
  })
})

describe('padPointDistance', () => {
  const pieces = padCopperPieces(pads[1], origin, 0)

  test('inside the anchor, and inside the tab, are both on the pad', () => {
    expect(padPointDistance(pieces, 0, 0)).toBe(0)
    expect(padPointDistance(pieces, 3, 0)).toBe(0)
  })

  test('the seam between them is copper, not a gap', () => {
    expect(padPointDistance(pieces, 0.7375, 0)).toBe(0)
  })

  test('outside is the edge separation, from whichever piece is nearest', () => {
    // 1 mm right of the tab's far edge.
    expect(padPointDistance(pieces, 4.8625, 0)).toBeCloseTo(1, 6)
    // Above the tab, which reaches further in y than the anchor does.
    expect(padPointDistance(pieces, 3, 1.8665)).toBeCloseTo(1, 6)
  })

  test('a plain pad measures to its anchor alone', () => {
    const plain = padCopperPieces(pads[0], origin, 0)
    expect(padPointDistance(plain, 0, 0)).toBe(0)
    expect(padPointDistance(plain, 1.65, 0)).toBeCloseTo(1, 6)
  })
})
