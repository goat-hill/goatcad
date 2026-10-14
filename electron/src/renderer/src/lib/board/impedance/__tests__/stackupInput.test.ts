import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../../kicad/board'
import { solverStackupOf } from '../stackupInput'

describe('solverStackupOf', () => {
  test("reads a board's stackup, each dielectric sublayer its own row", () => {
    const board = parseKicadBoard(`(kicad_pcb (version 20241229) (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user))
  (setup
    (stackup
      (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01) (epsilon_r 3.3))
      (layer "F.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 1" (type "core") (thickness 0.8) (material "FR4") (epsilon_r 4.4) (loss_tangent 0.015)
        addsublayer (thickness 0.6) (material "FR4") (epsilon_r 3.9)
        addsublayer (thickness 0.1))
      (layer "B.Cu" (type "copper"))))
  (net 0 ""))`)
    expect(solverStackupOf(board)).toEqual([
      { kind: 'copper', name: 'F.Cu', thicknessMm: 0.035, epsilonR: 1, lossTangent: 0 },
      {
        kind: 'dielectric',
        name: 'dielectric 1',
        thicknessMm: 0.8,
        epsilonR: 4.4,
        lossTangent: 0.015
      },
      // An added sublayer starts from KiCad's DIELECTRIC_PRMS, not FR-4.
      { kind: 'dielectric', name: 'dielectric 1', thicknessMm: 0.6, epsilonR: 3.9, lossTangent: 0 },
      { kind: 'dielectric', name: 'dielectric 1', thicknessMm: 0.1, epsilonR: 1, lossTangent: 0 },
      // Copper with no thickness of its own is KiCad's 35 µm.
      { kind: 'copper', name: 'B.Cu', thicknessMm: 0.035, epsilonR: 1, lossTangent: 0 }
    ])
  })

  test("builds KiCad's default stackup for a board without one", () => {
    const board = parseKicadBoard(`(kicad_pcb (version 20241229) (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)
    (1 "F.Mask" user) (3 "B.Mask" user))
  (net 0 ""))`)
    // (1.6 mm − 4 × 35 µm − 2 × 10 µm) / 3, in whole nanometers.
    const dielectric = { kind: 'dielectric', thicknessMm: 0.48, epsilonR: 4.5, lossTangent: 0.02 }
    const copper = { kind: 'copper', thicknessMm: 0.035, epsilonR: 1, lossTangent: 0 }
    expect(solverStackupOf(board)).toEqual([
      { ...copper, name: 'F.Cu' },
      { ...dielectric, name: 'dielectric 1' },
      { ...copper, name: 'In1.Cu' },
      { ...dielectric, name: 'dielectric 2' },
      { ...copper, name: 'In2.Cu' },
      { ...dielectric, name: 'dielectric 3' },
      { ...copper, name: 'B.Cu' }
    ])
  })
})
