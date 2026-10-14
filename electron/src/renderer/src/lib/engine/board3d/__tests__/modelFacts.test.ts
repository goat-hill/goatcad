import { describe, expect, test } from 'vitest'
import { BoxGeometry, Mesh, Object3D } from 'three'
import { parseKicadFootprint } from '../../../kicad/footprint'
import { meshStats, modelFit, placedBounds, rawBounds } from '../modelFacts'
import { commonScale, scaleBarFor } from '../modelCapture'

/** A 2 × 1 × 0.5 mm body centered on its own origin, as a STEP file holds one. */
const body = (): Object3D => new Mesh(new BoxGeometry(2, 1, 0.5))

const footprintWith = (model: string, extra = ''): ReturnType<typeof parseKicadFootprint> =>
  parseKicadFootprint(`
(footprint "P" (layer "F.Cu")
  (pad "1" smd rect (at -0.9 0) (size 0.6 0.9) (layers "F.Cu"))
  (pad "2" smd rect (at 0.9 0) (size 0.6 0.9) (layers "F.Cu"))
  ${extra}
  ${model})
`)

describe('the box a model fills', () => {
  test("is the model's own, before any footprint transform", () => {
    expect(rawBounds(body())).toEqual({
      w: 2,
      h: 1,
      d: 0.5,
      min: { x: -1, y: -0.5, z: -0.25 },
      max: { x: 1, y: 0.5, z: 0.25 }
    })
  })

  test('is reported in the footprint frame, y down, z off the board', () => {
    const bounds = placedBounds(body(), footprintWith('(model "p.step")'))
    expect(bounds).toEqual({ x: -1, y: -0.5, w: 2, h: 1, zMin: -0.25, zMax: 0.25 })
  })

  test("follows the record's offset, KiCad's y inversion included", () => {
    const bounds = placedBounds(body(), footprintWith('(model "p.step" (offset (xyz 1 2 0.25)))'))
    // x and z move with the offset; a y offset is down the board's frame, so
    // the model moves to +y here as it does in the 3D view.
    expect(bounds).toEqual({ x: 0, y: 1.5, w: 2, h: 1, zMin: 0, zMax: 0.5 })
  })

  test('a quarter turn about Z swaps the sides, and is measured over vertices', () => {
    const bounds = placedBounds(body(), footprintWith('(model "p.step" (rotate (xyz 0 0 90)))'))
    expect(bounds?.w).toBeCloseTo(1, 5)
    expect(bounds?.h).toBeCloseTo(2, 5)
  })

  test('nothing to measure is null rather than an empty box', () => {
    expect(placedBounds(new Object3D(), footprintWith('(model "p.step")'))).toBeNull()
    expect(placedBounds(body(), footprintWith(''))).toBeNull()
  })
})

describe('how the model sits over the land pattern', () => {
  const bounds = { x: -1, y: -0.5, w: 2, h: 1, zMin: 0, zMax: 0.5 }

  test('measures against the fab outline, and says which box it used', () => {
    const fit = modelFit(bounds, {
      fab: { x: -1, y: -0.5, width: 2, height: 1 },
      courtyard: { x: -1.5, y: -1, width: 3, height: 2 },
      pads: null
    })
    expect(fit).toEqual({
      dx: 0,
      dy: 0,
      overFab: { left: 0, right: 0, top: 0, bottom: 0 },
      insideCourtyard: true,
      against: 'fab'
    })
  })

  test('a body wider than its outline reads as a positive overhang', () => {
    const fit = modelFit(bounds, {
      fab: { x: -0.8, y: -0.5, width: 1.6, height: 1 },
      courtyard: { x: -0.9, y: -0.6, width: 1.8, height: 1.2 },
      pads: null
    })
    expect(fit?.overFab).toEqual({ left: 0.2, right: 0.2, top: 0, bottom: 0 })
    expect(fit?.insideCourtyard).toBe(false)
  })

  test('an off-center body reads as a center offset', () => {
    const fit = modelFit(bounds, {
      fab: { x: -1.5, y: -0.5, width: 2, height: 1 },
      courtyard: null,
      pads: null
    })
    expect(fit?.dx).toBe(0.5)
    expect(fit?.dy).toBe(0)
    // No courtyard is unknown, not false.
    expect(fit?.insideCourtyard).toBeNull()
  })

  test('falls back to the courtyard, then the copper, then answers nothing', () => {
    const courtyard = { x: -1, y: -0.5, width: 2, height: 1 }
    expect(modelFit(bounds, { fab: null, courtyard, pads: null })?.against).toBe('courtyard')
    expect(modelFit(bounds, { fab: null, courtyard: null, pads: courtyard })?.against).toBe('pads')
    expect(modelFit(bounds, { fab: null, courtyard: null, pads: null })).toBeNull()
  })
})

describe('the mesh itself', () => {
  test('counts triangles and meshes, which is how an assembly gives itself away', () => {
    const group = new Object3D()
    group.add(body(), body())
    expect(meshStats(group)).toEqual({ triangles: 24, meshes: 2 })
  })
})

describe('the four-view picture', () => {
  test('one scale holds every view, the diagonal one included', () => {
    const mmPerPixel = commonScale({ x: 10, y: 4, z: 2 }, 512)
    // The angled view sees the diagonal, which is longer than any single side.
    expect(10 / mmPerPixel).toBeLessThan(512)
    expect(mmPerPixel).toBeGreaterThan(Math.hypot(10, 4, 2) / 512)
  })

  test('a part of no size still gets a scale rather than a division by zero', () => {
    expect(Number.isFinite(commonScale({ x: 0, y: 0, z: 0 }, 512))).toBe(true)
  })

  test('the bar is a round number a reader can count', () => {
    expect(scaleBarFor(10)).toBe(1)
    expect(scaleBarFor(100)).toBe(10)
    expect(scaleBarFor(2)).toBe(0.2)
  })
})
