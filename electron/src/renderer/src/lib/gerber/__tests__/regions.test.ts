import { beforeAll, describe, expect, it } from 'vitest'
import { loadClipper, type ClipRegion } from '../../geometry/clip'
import { parseGerber } from '../parse'
import { gerberRegions } from '../regions'

const HEADER = '%FSLAX26Y26*%\n%MOMM*%\n'

const area = (regions: ClipRegion[]): number => {
  const ring = (pts: { x: number; y: number }[]): number => {
    let a = 0
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
      a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y)
    return Math.abs(a) / 2
  }
  return regions.reduce((s, r) => s + ring(r.outer) - r.holes.reduce((h, x) => h + ring(x), 0), 0)
}

describe('gerberRegions', () => {
  beforeAll(async () => {
    await loadClipper()
  })

  it('covers a flash, a draw and a region as the area they paint, overlaps counted once', () => {
    const image = parseGerber(
      HEADER +
        '%ADD10C,2*%\n%ADD11R,2X2*%\nD10*\nX0Y0D03*\nD11*\nX0Y0D03*\n' +
        'G36*\nX10000000Y0D02*\nX12000000Y0D01*\nX12000000Y2000000D01*\nX10000000Y2000000D01*\nG37*\nM02*\n'
    )
    // The disc sits inside the square: 4 + 4.
    expect(area(gerberRegions(image))).toBeCloseTo(8, 6)
  })

  it('lets a clear item erase only what came before it', () => {
    const image = parseGerber(
      HEADER +
        '%ADD10R,4X4*%\n%ADD11R,2X2*%\nD10*\nX0Y0D03*\n%LPC*%\nD11*\nX0Y0D03*\n%LPD*%\nX10000000Y0D03*\nM02*\n'
    )
    expect(area(gerberRegions(image))).toBeCloseTo(16 - 4 + 4, 6)
  })

  it('keeps a curve within the sag of its true edge', () => {
    const image = parseGerber(HEADER + '%ADD10C,2*%\nD10*\nX0Y0D03*\nM02*\n')
    expect(area(gerberRegions(image, 0.0001))).toBeCloseTo(Math.PI, 3)
  })
})
