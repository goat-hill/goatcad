import { Box3, MeshStandardMaterial, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseKicadFootprint } from '../../../kicad/footprint'
import { nm } from '../../../kicad/coordinates'
import type { KicadBoardFootprint } from '../../../kicad/board'
import type { SExprList } from '../../../kicad/footprint'
import { buildStandInBody, standInExtent, standInHeightMm } from '../placementBodies'

const inert = (): SExprList => ({ type: 'list', children: [], start: 0, end: 0 })

/** Courtyard, fab and silk all differ, so each source is distinguishable. */
const FULL = parseKicadFootprint(`
(footprint "R_0603" (layer "F.Cu")
  (attr smd)
  (property "Reference" "R1" (at 0 -5 0) (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15))))
  (fp_rect (start -1.5 -0.8) (end 1.5 0.8) (layer "F.CrtYd") (stroke (width 0.05)))
  (fp_rect (start -1 -0.5) (end 1 0.5) (layer "F.Fab") (stroke (width 0.1)))
  (fp_line (start -4 -4) (end 4 4) (layer "F.SilkS") (stroke (width 0.12)))
  (pad "1" smd rect (at -0.8 0) (size 0.9 0.9) (layers "F.Cu")))
`)

const FAB_ONLY = parseKicadFootprint(`
(footprint "FabOnly" (layer "F.Cu")
  (fp_rect (start -1 -0.5) (end 1 0.5) (layer "F.Fab") (stroke (width 0.1)))
  (fp_line (start -4 -4) (end 4 4) (layer "F.SilkS") (stroke (width 0.12)))
  (pad "1" smd rect (at -0.8 0) (size 0.9 0.9) (layers "F.Cu")))
`)

const PADS_ONLY = parseKicadFootprint(`
(footprint "PadsOnly" (layer "F.Cu")
  (fp_line (start -4 -4) (end 4 4) (layer "F.SilkS") (stroke (width 0.12)))
  (pad "1" smd rect (at -1 0) (size 1 2) (layers "F.Cu"))
  (pad "2" smd rect (at 1 0) (size 1 2) (layers "F.Cu")))
`)

const placed = (
  footprint: typeof FULL,
  overrides: Partial<KicadBoardFootprint> = {}
): KicadBoardFootprint => ({
  libId: footprint.name,
  position: { x: nm(0), y: nm(0) },
  layer: 'F.Cu',
  reference: 'R1',
  footprint,
  _raw: inert(),
  ...overrides
})

describe('standInExtent', () => {
  it('prefers the courtyard — the room the part is actually entitled to', () => {
    const extent = standInExtent(FULL)!
    expect(extent.maxX - extent.minX).toBe(3_000_000)
    expect(extent.maxY - extent.minY).toBe(1_600_000)
  })

  it('falls back to the fab outline when there is no courtyard', () => {
    const extent = standInExtent(FAB_ONLY)!
    expect(extent.maxX - extent.minX).toBe(2_000_000)
    expect(extent.maxY - extent.minY).toBe(1_000_000)
  })

  it('falls back to the pads when there is neither', () => {
    const extent = standInExtent(PADS_ONLY)!
    // Each pad is padded by half its LONGER side, so a rotated pad still fits
    // its own box: 1 mm either side of centers at ±1 mm.
    expect(extent.maxX - extent.minX).toBe(4_000_000)
    expect(extent.maxY - extent.minY).toBe(2_000_000)
  })

  it('never counts silkscreen: a designator is printed beside a part, not on it', () => {
    // The silk line spans ±4 mm (8 mm across) in all three; no source picks it up.
    for (const fp of [FULL, FAB_ONLY, PADS_ONLY]) {
      const extent = standInExtent(fp)!
      expect(extent.maxX - extent.minX).toBeLessThan(8_000_000)
    }
  })

  it('has nothing to extrude for a footprint with no geometry at all', () => {
    expect(standInExtent(parseKicadFootprint('(footprint "Empty" (layer "F.Cu"))'))).toBeNull()
  })

  // A board carries footprints that mark a region rather than fit a part. Their
  // courtyards are the size of the region, so extruding one buries the board.
  it('declines a padless region marker, however large its courtyard', () => {
    const keepout = parseKicadFootprint(`
      (footprint "AntennaArea" (layer "F.Cu")
        (fp_rect (start -20 -15) (end 20 15) (layer "F.CrtYd") (stroke (width 0.05))))
    `)
    expect(standInExtent(keepout)).toBeNull()
  })

  it('declines a footprint that draws the board outline', () => {
    const outline = parseKicadFootprint(`
      (footprint "BoardOutline" (layer "F.Cu")
        (fp_line (start -30 -20) (end 30 -20) (layer "Edge.Cuts") (stroke (width 0.05)))
        (fp_rect (start -30 -20) (end 30 20) (layer "F.CrtYd") (stroke (width 0.05)))
        (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))
    `)
    expect(standInExtent(outline)).toBeNull()
  })

  it('still accepts a large part that has pads — a module is not a region', () => {
    const module = parseKicadFootprint(`
      (footprint "BigModule" (layer "F.Cu")
        (fp_rect (start -12 -9) (end 12 9) (layer "F.CrtYd") (stroke (width 0.05)))
        (pad "1" smd rect (at -11 -8) (size 1 1) (layers "F.Cu")))
    `)
    const extent = standInExtent(module)!
    expect(extent.maxX - extent.minX).toBe(24_000_000)
  })
})

describe('buildStandInBody', () => {
  const material = new MeshStandardMaterial()

  it('stands the courtyard box on the front face, not sunk into the board', () => {
    const body = buildStandInBody(placed(FULL), 1.6, 'smd', material)!
    const bounds = new Box3().setFromObject(body)
    expect(bounds.min.z).toBeCloseTo(0.8, 6)
    expect(bounds.max.z).toBeCloseTo(0.8 + standInHeightMm('smd'), 6)
    const size = bounds.getSize(new Vector3())
    expect(size.x).toBeCloseTo(3, 6)
    expect(size.y).toBeCloseTo(1.6, 6)
  })

  it('hangs a back-side part below the board', () => {
    const body = buildStandInBody(placed(FULL, { layer: 'B.Cu' }), 1.6, 'tht', material)!
    const bounds = new Box3().setFromObject(body)
    expect(bounds.max.z).toBeCloseTo(-0.8, 6)
    expect(bounds.min.z).toBeCloseTo(-0.8 - standInHeightMm('tht'), 6)
  })

  it('carries the placement into world space, y-flipped out of KiCad’s frame', () => {
    const at = placed(FULL, { position: { x: nm(10_000_000), y: nm(4_000_000) } })
    const bounds = new Box3().setFromObject(buildStandInBody(at, 1.6, 'smd', material)!)
    const center = bounds.getCenter(new Vector3())
    expect(center.x).toBeCloseTo(10, 6)
    expect(center.y).toBeCloseTo(-4, 6)
  })

  it('keeps an asymmetric part at the same XY on either side of the board', () => {
    // Courtyard center sits 1.5 mm below the origin in the local y-down frame.
    // Board files store back-side locals pre-flipped, so the 2D renderer maps
    // both sides identically — the stand-in must land at the same XY too.
    const asym = parseKicadFootprint(`
      (footprint "Asym" (layer "F.Cu")
        (fp_rect (start -1 0) (end 1 3) (layer "F.CrtYd") (stroke (width 0.05)))
        (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))
    `)
    const front = new Box3().setFromObject(buildStandInBody(placed(asym), 1.6, 'smd', material)!)
    const back = new Box3().setFromObject(
      buildStandInBody(placed(asym, { layer: 'B.Cu' }), 1.6, 'smd', material)!
    )
    const frontCenter = front.getCenter(new Vector3())
    const backCenter = back.getCenter(new Vector3())
    expect(frontCenter.y).toBeCloseTo(-1.5, 6)
    expect(backCenter.x).toBeCloseTo(frontCenter.x, 6)
    expect(backCenter.y).toBeCloseTo(frontCenter.y, 6)
  })

  it('declines a footprint with nothing to measure', () => {
    const empty = parseKicadFootprint('(footprint "Empty" (layer "F.Cu"))')
    expect(buildStandInBody(placed(empty), 1.6, 'smd', material)).toBeNull()
  })
})
