// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * A single stripline's impedance as KiCad 10.0.6 computes it
 * (`common/transline_calculations/stripline.cpp`): the strip between two planes
 * taken as two half-lines in parallel, one per plane, each by Wheeler's
 * finite-thickness formula. The medium is homogeneous, so the effective
 * permittivity is the dielectric's own. Meters.
 */
import { minimiseZ0Error1D, unitPropagationDelay, ZF0, type Transline } from './translineMath'

/** `a` is the dielectric from the strip up to the top plane; `h` is plane to plane. */
export type StriplineParam = 'epsilonR' | 'h' | 'a' | 't' | 'width' | 'z0'

export class Stripline implements Transline<StriplineParam> {
  p: Record<StriplineParam, number> = { epsilonR: 0, h: 0, a: 0, t: 0, width: 0, z0: 0 }
  epsilonEff = 0
  /** Picoseconds per centimeter. */
  unitPropDelay = 0

  analyse(): void {
    const { t, a, h } = this.p
    this.epsilonEff = this.p.epsilonR
    this.p.z0 =
      2.0 / (1.0 / this.lineImpedance(2.0 * a + t) + 1.0 / this.lineImpedance(2.0 * (h - a) - t))
    this.unitPropDelay = unitPropagationDelay(this.epsilonEff)
  }

  synthesize(): boolean {
    return minimiseZ0Error1D(this, 'width', 'z0')
  }

  /** KiCad marks the geometry invalid when the strip reaches the bottom plane. */
  get geometryValid(): boolean {
    return !(this.p.a + this.p.t >= this.p.h)
  }

  private lineImpedance(height: number): number {
    const { t, width: w, epsilonR: er } = this.p
    const hmt = height - t
    if (w / hmt >= 0.35) {
      const zl =
        w +
        (2.0 * height * Math.log((2.0 * height - t) / hmt) -
          t * Math.log((height * height) / hmt / hmt - 1.0)) /
          Math.PI
      return (ZF0 * hmt) / Math.sqrt(er) / 4.0 / zl
    }
    let tdw = t / w
    if (t / w > 1.0) tdw = w / t
    let de =
      1.0 + (tdw / Math.PI) * (1.0 + Math.log((4.0 * Math.PI) / tdw)) + 0.236 * Math.pow(tdw, 1.65)
    de *= t / w > 1.0 ? t / 2.0 : w / 2.0
    return (ZF0 / 2.0 / Math.PI / Math.sqrt(er)) * Math.log((4.0 * height) / Math.PI / de)
  }
}
