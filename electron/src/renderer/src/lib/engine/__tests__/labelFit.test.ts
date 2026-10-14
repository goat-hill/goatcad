import { describe, expect, test } from 'vitest'
import { uprightFitFont, uprightHalfWidth } from '../LabelBatch'

describe('uprightFitFont', () => {
  test('unrotated: bound by width and height independently', () => {
    // a=2, b=1; needs kW=1, kH=0.5 per font unit → width allows 2, height 2.
    expect(uprightFitFont(2, 1, 0, 1, 0.5)).toBeCloseTo(2, 9)
    // Narrower pad: width binds first.
    expect(uprightFitFont(1, 1, 0, 1, 0.5)).toBeCloseTo(1, 9)
  })

  test('a quarter turn swaps the roles of the box extents', () => {
    const upright = uprightFitFont(2, 1, 0, 1, 0.5)
    const turned = uprightFitFont(1, 2, Math.PI / 2, 1, 0.5)
    expect(turned).toBeCloseTo(upright, 9)
  })

  test('45°: both extents share the load symmetrically', () => {
    const c = Math.SQRT1_2
    const expected = Math.min(2, 3) / ((1 + 0.5) * c)
    expect(uprightFitFont(2, 3, Math.PI / 4, 1, 0.5)).toBeCloseTo(expected, 9)
  })

  test('rotation never helps a matched wide label in a wide pad', () => {
    const flat = uprightFitFont(3, 1, 0, 2, 0.5)
    for (const theta of [0.2, 0.6, 1.0, Math.PI / 2]) {
      expect(uprightFitFont(3, 1, theta, 2, 0.5)).toBeLessThanOrEqual(flat + 1e-9)
    }
  })

  test('degenerate needs fall back to the remaining constraint', () => {
    // No width need: only height binds (at 0°, b/kH).
    expect(uprightFitFont(2, 1, 0, 0, 0.5)).toBeCloseTo(2, 9)
    // No needs at all: no meaningful fit.
    expect(uprightFitFont(2, 1, 0, 0, 0)).toBe(0)
  })

  test('symmetry: any angle mirrors into the first quadrant', () => {
    const base = uprightFitFont(2, 1, 0.4, 1, 0.5)
    for (const theta of [-0.4, Math.PI - 0.4, Math.PI + 0.4]) {
      expect(uprightFitFont(2, 1, theta, 1, 0.5)).toBeCloseTo(base, 9)
    }
  })
})

describe('uprightHalfWidth', () => {
  test('always holds the width the matching fit used', () => {
    // The two solves are the same constraint pair read two ways, so the line
    // that set the fit always fits the room — exactly when width bound the
    // fit, with slack to spare when height did.
    for (const [a, b] of [
      [2, 1],
      [1, 3],
      [0.6, 0.6]
    ]) {
      for (const theta of [0, 0.3, Math.PI / 4, 1.2, Math.PI / 2]) {
        for (const [kW, kH] of [
          [1, 0.5],
          [0.2, 0.9],
          [3, 0.4]
        ]) {
          const f = uprightFitFont(a, b, theta, kW, kH)
          expect(uprightHalfWidth(a, b, theta, kH * f)).toBeGreaterThanOrEqual(kW * f - 1e-9)
        }
      }
    }
  })

  test('width-bound fits get back exactly their own width', () => {
    // a=2, b=3 at 0°: the width binds, so the room is the line's own half-width.
    const f = uprightFitFont(2, 3, 0, 1, 0.5)
    expect(uprightHalfWidth(2, 3, 0, 0.5 * f)).toBeCloseTo(1 * f, 9)
  })

  test('a taller block leaves less width, never negative', () => {
    const wide = uprightHalfWidth(2, 1, 0.4, 0.2)
    expect(uprightHalfWidth(2, 1, 0.4, 0.5)).toBeLessThan(wide)
    expect(uprightHalfWidth(2, 1, 0.4, 10)).toBe(0)
  })

  test('unrotated: height does not eat into width', () => {
    expect(uprightHalfWidth(2, 1, 0, 0.9)).toBeCloseTo(2, 9)
  })
})
