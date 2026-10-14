import { describe, expect, it } from 'vitest'
import { Object3D, Vector3 } from 'three'
import { parseKicadBoard, type KicadBoardFootprint } from '../../../kicad/board'
import {
  componentClass,
  isDoNotPopulate,
  isNotInPosFiles,
  passesComponentFilter,
  placeComponentModel,
  type ComponentFilter
} from '../componentModels'

const ALL: ComponentFilter = {
  tht: true,
  smd: true,
  unspecified: true,
  dnp: true,
  notInPosFiles: true
}

const boardWith = (footprints: string): KicadBoardFootprint[] =>
  parseKicadBoard(`
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "")
  ${footprints})
`).footprints

const footprint = (options: {
  layer?: string
  at?: string
  attr?: string
  model?: string
}): KicadBoardFootprint =>
  boardWith(`(footprint "Part" (layer "${options.layer ?? 'F.Cu'}") (at ${options.at ?? '0 0'})
      ${options.attr ? `(attr ${options.attr})` : ''}
      ${options.model ?? '(model "part.step")'}
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))`)[0]

/** Where a unit point in the model's own frame lands in world space. */
const worldPoint = (bfp: KicadBoardFootprint, local: [number, number, number]): Vector3 => {
  const content = new Object3D()
  const placed = placeComponentModel(content, bfp, 1.6)!
  placed.updateMatrixWorld(true)
  return content.localToWorld(new Vector3(...local))
}

describe('componentClass', () => {
  it('reads the footprint attribute', () => {
    expect(componentClass(footprint({ attr: 'smd' }))).toBe('smd')
    expect(componentClass(footprint({ attr: 'through_hole' }))).toBe('tht')
  })

  it('is unspecified when the footprint declares neither', () => {
    expect(componentClass(footprint({}))).toBe('unspecified')
    expect(componentClass(footprint({ attr: 'exclude_from_pos_files' }))).toBe('unspecified')
  })
})

describe('passesComponentFilter', () => {
  it('filters by class', () => {
    const smd = footprint({ attr: 'smd' })
    expect(passesComponentFilter(smd, ALL)).toBe(true)
    expect(passesComponentFilter(smd, { ...ALL, smd: false })).toBe(false)
    expect(passesComponentFilter(footprint({ attr: 'through_hole' }), { ...ALL, smd: false })).toBe(
      true
    )
  })

  it('hides DNP parts unless asked for, whatever their class', () => {
    const dnp = footprint({ attr: 'smd dnp' })
    expect(isDoNotPopulate(dnp)).toBe(true)
    expect(passesComponentFilter(dnp, { ...ALL, dnp: false })).toBe(false)
    expect(passesComponentFilter(dnp, ALL)).toBe(true)
  })

  // A mounting hole, fiducial or logo: the assembler places nothing there, so
  // by default neither do we. KiCad gates on this before the class too
  // (board_adapter.cpp), which is why an excluded SMD part still goes.
  it('hides footprints the position file skips unless asked for', () => {
    const hole = footprint({ attr: 'exclude_from_pos_files exclude_from_bom' })
    expect(isNotInPosFiles(hole)).toBe(true)
    expect(passesComponentFilter(hole, { ...ALL, notInPosFiles: false })).toBe(false)
    expect(passesComponentFilter(hole, ALL)).toBe(true)

    const excludedSmd = footprint({ attr: 'smd exclude_from_pos_files' })
    expect(passesComponentFilter(excludedSmd, { ...ALL, notInPosFiles: false })).toBe(false)
  })

  it('leaves ordinary parts alone', () => {
    const part = footprint({ attr: 'smd' })
    expect(isNotInPosFiles(part)).toBe(false)
    expect(passesComponentFilter(part, { ...ALL, notInPosFiles: false })).toBe(true)
  })
})

describe('placeComponentModel', () => {
  it('returns nothing for a footprint with no model link', () => {
    const bare = boardWith('(footprint "Part" (layer "F.Cu") (at 0 0))')[0]
    expect(placeComponentModel(new Object3D(), bare, 1.6)).toBeNull()
  })

  it('puts a front-side part on the top face, at the board position with y negated', () => {
    const origin = worldPoint(footprint({ at: '10 20' }), [0, 0, 0])
    expect(origin.x).toBeCloseTo(10, 6)
    expect(origin.y).toBeCloseTo(-20, 6)
    expect(origin.z).toBeCloseTo(0.8, 6)
  })

  it('puts a back-side part on the bottom face', () => {
    const origin = worldPoint(footprint({ layer: 'B.Cu', at: '10 20' }), [0, 0, 0])
    expect(origin.z).toBeCloseTo(-0.8, 6)
  })

  it('turns a back-side part over rather than mirroring it', () => {
    // A half-turn about X: +Y and +Z both invert, +X is unchanged. That keeps
    // the part right-handed — a real part on the underside is not a reflection.
    const bfp = footprint({ layer: 'B.Cu' })
    const axis = (local: [number, number, number]): number[] => {
      const p = worldPoint(bfp, local)
      return [p.x, p.y, p.z + 0.8]
    }
    const expectAxis = (local: [number, number, number], want: number[]): void =>
      axis(local).forEach((value, i) => expect(value).toBeCloseTo(want[i], 6))
    expectAxis([1, 0, 0], [1, 0, 0])
    expectAxis([0, 1, 0], [0, -1, 0])
    expectAxis([0, 0, 1], [0, 0, -1])
  })

  it('rotates the part CCW by the footprint angle', () => {
    const tip = worldPoint(footprint({ at: '0 0 90' }), [1, 0, 0])
    expect(tip.x).toBeCloseTo(0, 6)
    expect(tip.y).toBeCloseTo(1, 6)
  })

  it('applies the model offset in the board frame, so its y inverts', () => {
    const origin = worldPoint(
      footprint({ model: '(model "part.step" (offset (xyz 1 2 3)))' }),
      [0, 0, 0]
    )
    expect(origin.x).toBeCloseTo(1, 6)
    expect(origin.y).toBeCloseTo(-2, 6)
    expect(origin.z).toBeCloseTo(0.8 + 3, 6)
  })

  it('applies the model rotation with KiCad sign and Z-Y-X order', () => {
    // (rotate (xyz 0 0 90)) turns the model clockwise seen from +Z.
    const tip = worldPoint(
      footprint({ model: '(model "part.step" (rotate (xyz 0 0 90)))' }),
      [1, 0, 0]
    )
    expect(tip.x).toBeCloseTo(0, 6)
    expect(tip.y).toBeCloseTo(-1, 6)
  })

  it('scales in the model’s own frame, which is not y-flipped', () => {
    // Only `(offset …)` is expressed in the board's y-down frame; the model
    // geometry itself already arrives in the 3D world frame.
    const tip = worldPoint(
      footprint({ model: '(model "part.step" (scale (xyz 2 3 4)))' }),
      [1, 1, 1]
    )
    expect(tip.x).toBeCloseTo(2, 6)
    expect(tip.y).toBeCloseTo(3, 6)
    expect(tip.z).toBeCloseTo(0.8 + 4, 6)
  })
})
