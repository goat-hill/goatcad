import { describe, expect, test } from 'vitest'
import { analyseCoplanar, solveCoplanar } from '../coplanar'

/*
 * Expected values are KiCad 10.0.6's PCB Calculator: pcb_calculator's
 * `coplanar.cpp` compiled unchanged over its `transline.cpp` helpers.
 */

const close = (actual: number, expected: number, tolerance = 1e-9): void =>
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tolerance)

describe('solveCoplanar, held to KiCad 10.0.6', () => {
  test.each([
    // [grounded, solveFor, width, gap, height, thickness, er, f, target] → [width, gap, epsilonEff], mm
    [
      true,
      'width',
      0,
      0.2,
      1.53,
      0.035,
      4.5,
      2.4e9,
      50,
      1.0678454852190611,
      0.2,
      2.4718073281524768
    ],
    [
      true,
      'width',
      0,
      0.15,
      0.2104,
      0.035,
      4.5,
      2.4e9,
      50,
      0.3260046780563527,
      0.15,
      2.5878796793248968
    ],
    [
      false,
      'width',
      0,
      0.2,
      1.53,
      0.035,
      4.5,
      2.4e9,
      50,
      0.8480695494752057,
      0.2,
      2.5033804754367468
    ],
    [true, 'width', 0, 0.2, 1.53, 0, 4.2, 1e9, 75, 0.4094937399738472, 0.2, 2.6216082882201537],
    [true, 'gap', 1, 0.3, 1.53, 0.035, 4.5, 2.4e9, 55, 1, 0.2500306174858932, 2.526090570198945],
    [false, 'gap', 0.8, 0.3, 1.53, 0, 4.5, 2.4e9, 50, 0.8, 0.10452192956311585, 2.7133303371970436]
  ] as const)(
    'grounded %s, %s',
    (
      grounded,
      solveFor,
      widthMm,
      gapMm,
      heightMm,
      thicknessMm,
      epsilonR,
      frequencyHz,
      targetOhms,
      w,
      g,
      eff
    ) => {
      const result = solveCoplanar({
        grounded,
        widthMm,
        gapMm,
        heightMm,
        thicknessMm,
        epsilonR,
        frequencyHz,
        targetOhms,
        solveFor
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // Newton stops within a micro-ohm, so the fitted dimension agrees well past a nanometer.
      close(result.widthMm, w, 1e-7)
      close(result.gapMm, g, 1e-7)
      close(result.epsilonEff, eff, 1e-7)
      expect(result.ohms).toBe(targetOhms)
    }
  )

  test('refuses a target that is not positive', () => {
    expect(
      solveCoplanar({
        grounded: true,
        widthMm: 0,
        gapMm: 0.2,
        heightMm: 1.53,
        thicknessMm: 0.035,
        epsilonR: 4.5,
        frequencyHz: 2.4e9,
        targetOhms: 0,
        solveFor: 'width'
      })
    ).toEqual({ ok: false, error: 'target-not-positive' })
  })
})

describe('analyseCoplanar', () => {
  test.each([
    [true, 1.2, 0.2, 1.53, 0.035, 4.5, 5.8e9, 47.728289797944782, 2.5035903824704584],
    [false, 0.3, 0.25, 0.2104, 0.035, 4.5, 2.4e9, 84.139865406822011, 2.0336049614613714]
  ] as const)(
    'grounded %s, %s mm',
    (grounded, widthMm, gapMm, heightMm, thicknessMm, epsilonR, frequencyHz, ohms, eff) => {
      const result = analyseCoplanar({
        grounded,
        widthMm,
        gapMm,
        heightMm,
        thicknessMm,
        epsilonR,
        frequencyHz
      })
      close(result.ohms, ohms)
      close(result.epsilonEff, eff)
      expect(result.delay).toBe(Math.trunc(((Math.sqrt(eff) * (1e10 / 2.99e8)) / 10) * 1e6))
    }
  )
})
