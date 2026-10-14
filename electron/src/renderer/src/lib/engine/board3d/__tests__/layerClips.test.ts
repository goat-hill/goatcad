import { beforeAll, describe, expect, it } from 'vitest'
import { loadClipper } from '../../../geometry/clip'
import type { DrillHole } from '../boardLayers'
import type { OutlineRegion } from '../boardOutline'
import { buildLayerClips, DrillSubtract, OutlineKeep } from '../layerClips'
import { buildMaskRegions } from '../maskLayer'
import { FlatMeshBuilder, roundRectOutline, signedArea, type Pt, type ShapeClip } from '../flatMesh'

const squareRing = (cx: number, cy: number, half: number): Pt[] => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half }
]

const roundHole = (x: number, y: number, r: number): DrillHole => ({
  x,
  y,
  halfW: r,
  halfH: r,
  cornerR: r,
  angle: 0,
  plated: true
})

/** Total triangulated area of a built layer. */
const builtArea = (builder: FlatMeshBuilder, clips?: readonly ShapeClip[]): number => {
  const geometry = builder.build(0, 1, clips)
  if (!geometry) return 0
  const position = geometry.getAttribute('position')
  let area = 0
  for (let t = 0; t < position.count / 3; t++) {
    const ring: Pt[] = [0, 1, 2].map((v) => ({
      x: position.getX(t * 3 + v),
      y: position.getY(t * 3 + v)
    }))
    area += Math.abs(signedArea(ring))
  }
  return area
}

beforeAll(async () => {
  await loadClipper()
})

describe('DrillSubtract', () => {
  const subtract = new DrillSubtract([roundHole(5, 5, 1), roundHole(50, 5, 0.5)])

  it('keeps a region that comes nowhere near a bore, untouched', () => {
    expect(
      subtract.clip({
        outer: [
          { x: 20, y: 20 },
          { x: 22, y: 20 },
          { x: 22, y: 22 },
          { x: 20, y: 22 }
        ],
        holes: []
      })
    ).toBeNull()
  })

  it('drops a region a bore swallows whole', () => {
    expect(
      subtract.clip({
        outer: [
          { x: 4.8, y: 4.8 },
          { x: 5.2, y: 4.8 },
          { x: 5.2, y: 5.2 },
          { x: 4.8, y: 5.2 }
        ],
        holes: []
      })
    ).toEqual([])
  })

  // The reported bug: a track ending on a via got a full round end cap that
  // lidded the bore. The cap must come back with the bore's bite taken out.
  it('opens the bore in a track cap that covers it', () => {
    const builder = new FlatMeshBuilder()
    builder.addSegment(0, 5, 5, 5, 0.6)
    const lidded = builtArea(builder)
    const clipped = builtArea(builder, [subtract])
    // The cap loses the intersection of cap disc and bore disc — a bite about
    // half the cap, so well over a tenth of it and well under all of it.
    expect(clipped).toBeLessThan(lidded - 0.1)
    expect(clipped).toBeGreaterThan(0)
  })

  // The other reported bug at scale: a zone pour over stitching vias. Past
  // the per-piece cut budget the pour comes back partitioned — several small
  // regions instead of one giant holed one — but the area must be the same
  // pour-minus-bores either way, and no piece may carry an earcut-hostile
  // hole count.
  it('perforates a pour over many bores, in partitioned pieces', () => {
    const holes: DrillHole[] = []
    for (let i = 0; i < 100; i++) {
      holes.push(roundHole((i % 10) * 4 + 2, Math.floor(i / 10) * 4 + 2, 0.3))
    }
    const pour = new DrillSubtract(holes)
    const regions = pour.clip({
      outer: [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 40 },
        { x: 0, y: 40 }
      ],
      holes: []
    })
    expect(regions).not.toBeNull()
    expect(regions!.length).toBeGreaterThan(1)
    let area = 0
    for (const region of regions!) {
      expect(region.holes.length).toBeLessThanOrEqual(48)
      area += Math.abs(signedArea(region.outer))
      for (const hole of region.holes) area -= Math.abs(signedArea(hole))
    }
    // 40×40 pour minus 100 bores of r = 0.3 plus the clip's 0.002 clearance
    // (tessellated, so slightly under the analytic π r²).
    const bore = Math.abs(signedArea(roundRectOutline(0.302, 0.302, 0.302)))
    expect(area).toBeCloseTo(40 * 40 - 100 * bore, 1)
  })
})

describe('OutlineKeep', () => {
  const board: OutlineRegion = {
    outer: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 }
    ],
    holes: [
      [
        { x: 40, y: 20 },
        { x: 60, y: 20 },
        { x: 60, y: 40 },
        { x: 40, y: 40 }
      ]
    ]
  }
  const keep = new OutlineKeep([board])

  const squareAt = (x: number, y: number, half = 1): { outer: Pt[]; holes: Pt[][] } => ({
    outer: [
      { x: x - half, y: y - half },
      { x: x + half, y: y - half },
      { x: x + half, y: y + half },
      { x: x - half, y: y + half }
    ],
    holes: []
  })

  it('keeps silk well inside the board, untouched', () => {
    expect(keep.clip(squareAt(20, 30))).toBeNull()
  })

  it('drops silk entirely off the board', () => {
    expect(keep.clip(squareAt(120, 30))).toEqual([])
  })

  it('drops silk inside a board cutout', () => {
    expect(keep.clip(squareAt(50, 30))).toEqual([])
  })

  // The reported bug: footprint silk hanging past the board edge.
  it('trims silk straddling the board edge to the on-board part', () => {
    const regions = keep.clip(squareAt(100, 30, 2))
    expect(regions).toHaveLength(1)
    // Half of the 4x4 square hangs off; only the on-board half survives.
    expect(Math.abs(signedArea(regions![0].outer))).toBeCloseTo(8, 6)
  })

  it('trims silk poking into a cutout back to its rim', () => {
    const regions = keep.clip(squareAt(40, 30, 2))
    expect(regions).toHaveLength(1)
    expect(Math.abs(signedArea(regions![0].outer))).toBeCloseTo(8, 6)
  })
})

describe('buildLayerClips', () => {
  const outline = {
    regions: [{ outer: [{ x: 0, y: 0 }], holes: [] }],
    fallback: false,
    openCount: 0
  }

  it('gives drilled layers the bore clip and silk both clips', () => {
    const clips = buildLayerClips([roundHole(1, 1, 0.5)], outline)
    expect(clips.drilled).toHaveLength(1)
    expect(clips.silkFor('F.SilkS')).toHaveLength(2)
  })

  it('adds that side’s mask openings to the silk stack', () => {
    const opening = { outer: squareRing(5, 5, 1), holes: [] }
    const clips = buildLayerClips([roundHole(1, 1, 0.5)], outline, {
      front: [opening],
      back: []
    })
    // Front: drill + mask + outline. Back: no openings, so drill + outline.
    expect(clips.silkFor('F.SilkS')).toHaveLength(3)
    expect(clips.silkFor('B.SilkS')).toHaveLength(2)
  })

  it('never clips silk against a fallback or unclosed outline', () => {
    expect(buildLayerClips([], { ...outline, fallback: true }).silkFor('F.SilkS')).toBeUndefined()
    expect(buildLayerClips([], { ...outline, openCount: 2 }).silkFor('F.SilkS')).toBeUndefined()
  })

  it('builds no clips at all for an undrilled board with no outline', () => {
    const clips = buildLayerClips([], null)
    expect(clips.drilled).toBeUndefined()
    expect(clips.silkFor('F.SilkS')).toBeUndefined()
  })
})

describe('buildMaskRegions', () => {
  const outline: OutlineRegion[] = [
    {
      outer: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 }
      ],
      holes: []
    }
  ]

  const regionArea = (regions: readonly { outer: Pt[]; holes: Pt[][] }[]): number =>
    regions.reduce(
      (sum, r) =>
        sum +
        Math.abs(signedArea(r.outer)) -
        r.holes.reduce((h, ring) => h + Math.abs(signedArea(ring)), 0),
      0
    )

  it('cuts the openings and the bores out of the face', () => {
    const opening = { outer: squareRing(3, 3, 1), holes: [] }
    const regions = buildMaskRegions(outline, [opening], [roundHole(7, 7, 0.5)])!
    expect(regions.length).toBeGreaterThan(0)
    // 100 minus the 2×2 opening minus the tessellated ~π·0.5² bore.
    expect(regionArea(regions)).toBeCloseTo(100 - 4 - Math.PI * 0.25, 1)
  })

  it('covers the whole face when nothing opens it', () => {
    const regions = buildMaskRegions(outline, [], [])!
    expect(regionArea(regions)).toBeCloseTo(100, 6)
  })
})
