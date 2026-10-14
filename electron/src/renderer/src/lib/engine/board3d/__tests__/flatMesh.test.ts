import { describe, expect, it } from 'vitest'
import { FlatMeshBuilder, pointInPolygon, roundRectOutline, signedArea, type Pt } from '../flatMesh'

const SQUARE: Pt[] = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 2 },
  { x: 0, y: 2 }
]

/** Read the built geometry back as flat triples, for winding assertions. */
const triangles = (geometry: NonNullable<ReturnType<FlatMeshBuilder['build']>>): Pt[][] => {
  const position = geometry.getAttribute('position')
  const out: Pt[][] = []
  for (let t = 0; t < position.count / 3; t++) {
    out.push([0, 1, 2].map((v) => ({ x: position.getX(t * 3 + v), y: position.getY(t * 3 + v) })))
  }
  return out
}

describe('FlatMeshBuilder', () => {
  it('builds nothing from nothing', () => {
    expect(new FlatMeshBuilder().build(0)).toBeNull()
    expect(new FlatMeshBuilder().isEmpty).toBe(true)
  })

  it('normalizes every triangle to CCW regardless of input order', () => {
    const builder = new FlatMeshBuilder()
    builder.addTriangle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 })
    // Same triangle, wound the other way.
    builder.addTriangle({ x: 5, y: 0 }, { x: 5, y: 1 }, { x: 6, y: 0 })
    const geometry = builder.build(0)!
    for (const face of triangles(geometry)) expect(signedArea(face)).toBeGreaterThan(0)
  })

  it('drops degenerate (zero-area) triangles', () => {
    const builder = new FlatMeshBuilder()
    builder.addTriangle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })
    expect(builder.isEmpty).toBe(true)
  })

  it('places every vertex at the given z with a matching normal', () => {
    const builder = new FlatMeshBuilder()
    builder.addPolygon(SQUARE)
    const geometry = builder.build(-0.8, -1)!
    const position = geometry.getAttribute('position')
    const normal = geometry.getAttribute('normal')
    for (let i = 0; i < position.count; i++) {
      // Float32 storage, so exact equality is the wrong assertion.
      expect(position.getZ(i)).toBeCloseTo(-0.8, 6)
      expect(normal.getZ(i)).toBe(-1)
    }
  })

  it('reverses winding for a back-facing layer, so the visible side faces out', () => {
    const front = new FlatMeshBuilder()
    front.addPolygon(SQUARE)
    const back = new FlatMeshBuilder()
    back.addPolygon(SQUARE)
    for (const face of triangles(front.build(1, 1)!)) expect(signedArea(face)).toBeGreaterThan(0)
    for (const face of triangles(back.build(-1, -1)!)) expect(signedArea(face)).toBeLessThan(0)
  })

  it('triangulates a polygon with a hole, leaving the hole empty', () => {
    const solid = new FlatMeshBuilder()
    solid.addPolygon(SQUARE)
    const holed = new FlatMeshBuilder()
    holed.addPolygon(SQUARE, [
      [
        { x: 0.5, y: 0.5 },
        { x: 0.5, y: 1.5 },
        { x: 1.5, y: 1.5 },
        { x: 1.5, y: 0.5 }
      ]
    ])
    const area = (b: FlatMeshBuilder): number =>
      triangles(b.build(0)!).reduce((sum, face) => sum + Math.abs(signedArea(face)), 0)
    expect(area(solid)).toBeCloseTo(4, 5)
    expect(area(holed)).toBeCloseTo(3, 5)
  })

  it('strokes a segment as a body plus two round caps', () => {
    const builder = new FlatMeshBuilder()
    builder.addSegment(0, 0, 10, 0, 0.5)
    const area = triangles(builder.build(0)!).reduce(
      (sum, face) => sum + Math.abs(signedArea(face)),
      0
    )
    // 10 x 1 body, plus two discs of r = 0.5 (tessellated, so slightly under π).
    expect(area).toBeGreaterThan(10)
    expect(area).toBeLessThanOrEqual(10 + Math.PI * 0.25 * 2 + 1e-6)
  })

  it('collapses a zero-length segment to a single cap rather than nothing', () => {
    const builder = new FlatMeshBuilder()
    builder.addSegment(3, 3, 3, 3, 0.4)
    expect(builder.isEmpty).toBe(false)
  })
})

describe('roundRectOutline', () => {
  it('is a plain rectangle at zero radius', () => {
    expect(roundRectOutline(2, 1, 0)).toEqual([
      { x: -2, y: -1 },
      { x: 2, y: -1 },
      { x: 2, y: 1 },
      { x: -2, y: 1 }
    ])
  })

  it('clamps the radius to the shorter half — a circle pad, not a bowtie', () => {
    const outline = roundRectOutline(1, 1, 5)
    for (const point of outline) expect(Math.hypot(point.x, point.y)).toBeCloseTo(1, 6)
  })

  it('winds CCW so the builder never has to flip it', () => {
    expect(signedArea(roundRectOutline(2, 1, 0.3))).toBeGreaterThan(0)
  })

  it('rejects a degenerate size', () => {
    expect(roundRectOutline(0, 1, 0)).toEqual([])
  })
})

describe('pointInPolygon', () => {
  it('separates inside from outside', () => {
    expect(pointInPolygon({ x: 1, y: 1 }, SQUARE)).toBe(true)
    expect(pointInPolygon({ x: 3, y: 1 }, SQUARE)).toBe(false)
    expect(pointInPolygon({ x: -1, y: 1 }, SQUARE)).toBe(false)
  })
})
