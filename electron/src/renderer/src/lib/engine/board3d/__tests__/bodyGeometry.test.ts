import { beforeAll, describe, expect, it } from 'vitest'
import { loadClipper } from '../../../geometry/clip'
import { buildBodyGeometry, drillContour } from '../bodyGeometry'
import type { OutlineRegion } from '../boardOutline'
import { signedArea, type Pt } from '../flatMesh'

const square = (cx: number, cy: number, half: number): Pt[] => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half }
]

const plate: OutlineRegion = { outer: square(0, 0, 10), holes: [] }

/** Sum of one group's triangle areas projected onto the XY plane. */
const groupFlatArea = (
  geometry: NonNullable<ReturnType<typeof buildBodyGeometry>>,
  group: number
): number => {
  const { start, count } = geometry.groups[group]
  const position = geometry.getAttribute('position')
  let area = 0
  for (let v = start; v < start + count; v += 3) {
    const ring: Pt[] = [0, 1, 2].map((i) => ({
      x: position.getX(v + i),
      y: position.getY(v + i)
    }))
    area += Math.abs(signedArea(ring))
  }
  return area
}

describe('buildBodyGeometry', () => {
  beforeAll(async () => {
    await loadClipper()
  })

  it('extrudes a plate: two caps, walls, centered on Z=0', () => {
    const geometry = buildBodyGeometry(plate, [], 1.6)
    expect(geometry).not.toBeNull()
    expect(geometry!.groups).toHaveLength(2)
    // Both caps' triangles project to the plate area, twice.
    expect(groupFlatArea(geometry!, 0)).toBeCloseTo(2 * 400, 4)
    geometry!.computeBoundingBox()
    expect(geometry!.boundingBox!.min.z).toBeCloseTo(-0.8, 6)
    expect(geometry!.boundingBox!.max.z).toBeCloseTo(0.8, 6)
  })

  it('bores drills through the caps and walls their bores', () => {
    const drill = drillContour({
      x: 0,
      y: 0,
      halfW: 1,
      halfH: 1,
      cornerR: 1,
      angle: 0,
      plated: true
    })!
    const bore = Math.abs(signedArea(drill))
    const solid = buildBodyGeometry(plate, [], 1.6)!
    const drilled = buildBodyGeometry(plate, [drill], 1.6)!
    expect(groupFlatArea(drilled, 0)).toBeCloseTo(2 * (400 - bore), 3)
    // The bore adds one wall ring beyond the outer's.
    expect(drilled.groups[1].count).toBe(solid.groups[1].count + drill.length * 6)
  })

  it('respects outline cutouts as walls, not cap fill', () => {
    const withHole: OutlineRegion = { outer: square(0, 0, 10), holes: [square(4, 4, 2)] }
    const geometry = buildBodyGeometry(withHole, [], 1.6)!
    expect(groupFlatArea(geometry, 0)).toBeCloseTo(2 * (400 - 16), 3)
  })

  it('keeps a repeated outline point out of the bounding box', () => {
    // A ring with a duplicated point has a zero-length edge, whose reserved
    // wall slots must collapse onto the point rather than onto (0, 0, 0):
    // stray origin vertices are invisible but drag the box — and with it the
    // extent gauge, the dimension readout and the 3D fit — back to the origin.
    const ring = square(100, 100, 10)
    const doubled: OutlineRegion = { outer: [...ring, { ...ring[3] }], holes: [] }
    const geometry = buildBodyGeometry(doubled, [], 1.6)!
    geometry.computeBoundingBox()
    expect(geometry.boundingBox!.min.x).toBeCloseTo(90, 6)
    expect(geometry.boundingBox!.min.y).toBeCloseTo(90, 6)
    expect(geometry.boundingBox!.max.x).toBeCloseTo(110, 6)
    expect(geometry.boundingBox!.max.y).toBeCloseTo(110, 6)
  })

  it('returns null for a degenerate region', () => {
    expect(buildBodyGeometry({ outer: [], holes: [] }, [], 1.6)).toBeNull()
  })
})
