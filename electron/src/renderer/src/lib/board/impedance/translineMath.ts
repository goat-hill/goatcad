// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * The arithmetic KiCad's transmission-line models share, held to KiCad 10.0.6
 * (`common/transline_calculations/transline_calculation_base.cpp`, `units.h`):
 * its constants, the AGM elliptic integral, the unit propagation delay and the
 * Newton search that fits one dimension to a target impedance. Exact output:
 * the steps and constants are KiCad's, so a profile solved here lands on the
 * width KiCad's tuning-profile page writes. Lengths are meters, as KiCad's are.
 */

export const MU0 = 12.566370614e-7
export const E0 = 8.854e-12
export const C0 = 299792458.0
export const ZF0 = 376.730313668

/** KiCad's convergence bound on |Z0 − target|, ohms. */
const MAX_ERROR = 0.000001

const NR_EPSI = 2.2204460492503131e-16

/**
 * The complete elliptic integrals K and E of `arg` by the arithmetic-geometric
 * mean (Abramowitz and Stegun), as KiCad computes them: `arg` is passed where
 * the modulus is, and a series that has not settled in 16 steps answers zero.
 */
export function ellipticIntegral(arg: number): { k: number; e: number } {
  if (arg === 1.0) return { k: Infinity, e: 0 }
  if (arg === -Infinity) return { k: 0, e: Infinity }
  let fk = 1
  let fe = 1
  let da = arg
  if (arg < 0) {
    fk = 1 / Math.sqrt(1 - arg)
    fe = Math.sqrt(1 - arg)
    da = -arg / (1 - arg)
  }
  let a = 1
  let b = Math.sqrt(1 - da)
  let c = Math.sqrt(da)
  let fr = 0.5
  let s = fr * c * c
  let i = 0
  for (; i < 16; i++) {
    const t = (a + b) / 2
    c = (a - b) / 2
    b = Math.sqrt(a * b)
    a = t
    fr *= 2
    s += fr * c * c
    if (c / a < NR_EPSI) break
  }
  if (i >= 16) return { k: 0, e: 0 }
  let k = Math.PI / 2 / a
  let e = ((Math.PI / 2) * (1 - s)) / a
  if (arg < 0) {
    k *= fk
    e *= fe
  }
  return { k, e }
}

/** Picoseconds per centimeter for an effective permittivity (KiCad's 2.99e8, not c). */
export const unitPropagationDelay = (epsilonEff: number): number =>
  Math.sqrt(epsilonEff) * (1.0e10 / 2.99e8)

export const coth = (x: number): number => (Math.exp(2.0 * x) + 1.0) / (Math.exp(2.0 * x) - 1.0)

export const sech = (x: number): number => 2.0 / (Math.exp(x) + Math.exp(-x))

/**
 * A model's parameters: what Newton's search varies and what it measures are
 * named slots, as KiCad's `m_parameters` map is.
 */
export interface Transline<K extends string> {
  p: Record<K, number>
  analyse(): void
}

/**
 * KiCad's `MinimiseZ0Error1D`: vary one parameter until the measured impedance
 * is within a micro-ohm of the target it held on entry, by a secant Newton step
 * from a 1% probe, giving up after `maxIterations` (250 in KiCad 10's models,
 * 100 in the older calculator's). The parameter keeps wherever it stopped;
 * whether it converged is returned and, as in KiCad's profile page, a caller
 * may read the result either way.
 */
export function minimiseZ0Error1D<K extends string>(
  line: Transline<K>,
  optimise: K,
  measure: K,
  maxIterations = 250
): boolean {
  const p = line.p
  if (!Number.isFinite(p[measure])) {
    p[optimise] = NaN
    return false
  }
  if (!Number.isFinite(p[optimise]) || p[optimise] === 0) p[optimise] = 0.001
  const dest = p[measure]
  let iteration = 0
  line.analyse()
  let current = p[measure]
  let error = Math.abs(dest - current)
  while (error > MAX_ERROR) {
    iteration++
    const increment = p[optimise] / 100.0
    p[optimise] += increment
    line.analyse()
    const result = p[measure]
    let slope = (result - current) / increment
    slope = (dest - current) / slope - increment
    p[optimise] += slope
    if (p[optimise] <= 0.0) p[optimise] = increment
    line.analyse()
    current = p[measure]
    error = Math.abs(dest - current)
    if (iteration > maxIterations) break
  }
  return error <= MAX_ERROR
}
