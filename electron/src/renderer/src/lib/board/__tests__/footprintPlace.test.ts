import { describe, expect, it } from 'vitest'
import { parseKicadFootprint } from '../../kicad/footprint'
import { mmToNm } from '../../kicad/coordinates'
import { findChild, findChildren, getAtomValues, serializeSExpr } from '../../kicad/sexpr'
import { boardLayerFlipper } from '../../kicad/layers'
import { flippedFootprintNode } from '../footprintFlip'
import {
  flippedPlacementAngle,
  placeFootprintNode,
  placedReference,
  placementFootprint,
  referencePrefix
} from '../footprintPlace'

const HOLE = parseKicadFootprint(`(footprint "MountingHole_3.2mm_M3"
  (version 20240108)
  (generator "kicad-footprint-generator")
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -4.2 0) (layer "F.SilkS") (uuid "a0000000-0000-0000-0000-000000000001") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "MountingHole_3.2mm_M3" (at 0 4.2 0) (layer "F.Fab") (uuid "a0000000-0000-0000-0000-000000000002") (effects (font (size 1 1) (thickness 0.15))))
  (attr exclude_from_pos_files exclude_from_bom)
  (fp_circle (center 0 0) (end 3.45 0) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd") (uuid "a0000000-0000-0000-0000-000000000003"))
  (pad "" np_thru_hole circle (at 0 0) (size 3.2 3.2) (drill 3.2) (layers "*.Cu" "*.Mask") (uuid "a0000000-0000-0000-0000-000000000004"))
)`)

const SOT23 = parseKicadFootprint(`(footprint "SOT-23"
  (version 20240108)
  (generator "test")
  (layer "F.Cu")
  (property "Reference" "Q**" (at 0 -2.5 0) (layer "F.SilkS") (uuid "b0000000-0000-0000-0000-000000000001") (effects (font (size 1 1) (thickness 0.15))))
  (attr smd)
  (fp_rect (start -1.7 -1.6) (end 1.7 1.6) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd") (uuid "b0000000-0000-0000-0000-000000000002"))
  (pad "1" smd rect (at -1 -0.95) (size 0.9 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "b0000000-0000-0000-0000-000000000003"))
  (pad "2" smd rect (at -1 0.95 90) (size 0.9 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "b0000000-0000-0000-0000-000000000004"))
  (zone (net 0) (net_name "") (layers "F.Cu") (uuid "b0000000-0000-0000-0000-000000000005") (hatch edge 0.5)
    (connect_pads (clearance 0)) (min_thickness 0.25) (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 1 0) (xy 2 0) (xy 2 1))))
)`)

const atomsOf = (node: Parameters<typeof getAtomValues>[0] | null): string[] =>
  node ? getAtomValues(node) : []

describe('referencePrefix', () => {
  it('takes the footprint’s own prefix where it names one', () => {
    expect(referencePrefix('Package_TO_SOT_SMD:SOT-23', SOT23)).toBe('Q')
  })

  it('falls back to the library for a bare REF**', () => {
    expect(referencePrefix('MountingHole:MountingHole_3.2mm_M3', HOLE)).toBe('H')
    expect(referencePrefix('TestPoint:TestPoint_Pad_1.0x1.0mm', HOLE)).toBe('TP')
    expect(referencePrefix('Unknown:Thing', HOLE)).toBe('U')
  })

  it('numbers past what the board already holds', () => {
    expect(placedReference('MountingHole:M3', HOLE, ['H1', 'H3', 'R1'])).toBe('H4')
  })
})

describe('placeFootprintNode', () => {
  it('names the footprint by its lib id, annotates it and marks it board-only', () => {
    const node = placeFootprintNode(HOLE, {
      libId: 'MountingHole:MountingHole_3.2mm_M3',
      at: { x: mmToNm(10), y: mmToNm(-5.5) },
      reference: 'H1'
    })
    expect(atomsOf(node)[0]).toBe('MountingHole:MountingHole_3.2mm_M3')
    expect(atomsOf(findChild(node, 'at'))).toEqual(['10', '-5.5'])
    const reference = findChildren(node, 'property').find((p) => atomsOf(p)[0] === 'Reference')
    expect(atomsOf(reference ?? null)[1]).toBe('H1')
    expect(atomsOf(findChild(node, 'attr'))).toEqual([
      'board_only',
      'exclude_from_pos_files',
      'exclude_from_bom'
    ])
    expect(findChild(node, 'version')).toBeNull()
    // Fresh uuids: two placements never share one.
    const again = placeFootprintNode(HOLE, {
      libId: 'MountingHole:MountingHole_3.2mm_M3',
      at: { x: mmToNm(0), y: mmToNm(0) },
      reference: 'H2'
    })
    expect(atomsOf(findChild(again, 'uuid'))[0]).not.toBe(atomsOf(findChild(node, 'uuid'))[0])
  })

  it('turns the footprint, its pads and texts, and its zones about its origin', () => {
    const node = placeFootprintNode(SOT23, {
      libId: 'Package_TO_SOT_SMD:SOT-23',
      at: { x: mmToNm(20), y: mmToNm(10) },
      angle: 90,
      reference: 'Q1'
    })
    expect(atomsOf(findChild(node, 'at'))).toEqual(['20', '10', '90'])
    const pads = findChildren(node, 'pad').map((pad) => atomsOf(findChild(pad, 'at')))
    expect(pads).toEqual([
      ['-1', '-0.95', '90'],
      ['-1', '0.95', '180']
    ])
    const text = findChildren(node, 'property')[0]
    expect(atomsOf(findChild(text, 'at'))).toEqual(['0', '-2.5', '90'])
    // (1, 0) turned 90° counterclockwise on a y-down board is (0, -1), then moved to (20, 10).
    const zone = serializeSExpr(findChild(node, 'zone')!)
    expect(zone).toContain('(xy 20 9)')
    expect(zone).toContain('(xy 20 8)')
    expect(zone).toContain('(xy 21 8)')
  })

  it('lands on the back as a placed footprint flipped where it stands, the turn kept as seen', () => {
    // R then F in hand is R, a click, then F on the placed footprint (FOOTPRINT::Flip).
    const at = { x: mmToNm(20), y: mmToNm(10) }
    const flipLayer = boardLayerFlipper([])
    const withoutUuids = (node: Parameters<typeof serializeSExpr>[0]): string =>
      serializeSExpr(node).replace(/\(uuid "[^"]*"\)/g, '')
    const placedThenFlipped = flippedFootprintNode(
      placeFootprintNode(SOT23, {
        libId: 'Package_TO_SOT_SMD:SOT-23',
        at,
        angle: 90,
        reference: 'Q1'
      }),
      at,
      'leftRight',
      flipLayer
    )
    const flippedInHand = placeFootprintNode(SOT23, {
      libId: 'Package_TO_SOT_SMD:SOT-23',
      at,
      angle: flippedPlacementAngle(90),
      reference: 'Q1',
      flipLayer
    })
    expect(withoutUuids(flippedInHand)).toBe(withoutUuids(placedThenFlipped))
    expect(atomsOf(findChild(flippedInHand, 'layer'))).toEqual(['B.Cu'])
  })

  it('writes no angle for a full turn', () => {
    const node = placeFootprintNode(SOT23, {
      libId: 'Package_TO_SOT_SMD:SOT-23',
      at: { x: mmToNm(0), y: mmToNm(0) },
      angle: 360,
      reference: 'Q1'
    })
    expect(atomsOf(findChild(node, 'at'))).toEqual(['0', '0'])
    expect(atomsOf(findChild(findChildren(node, 'pad')[1], 'at'))).toEqual(['-1', '0.95', '90'])
  })
})

describe('placementFootprint', () => {
  it('is the footprint the click lands, at the origin, as the board reads it', () => {
    const ghost = placementFootprint(SOT23, {
      libId: 'Package_TO_SOT_SMD:SOT-23',
      angle: 90,
      reference: 'Q3'
    })!
    expect(ghost.libId).toBe('Package_TO_SOT_SMD:SOT-23')
    expect(ghost.reference).toBe('Q3')
    expect(ghost.position).toMatchObject({ x: 0, y: 0, angle: 90 })
    expect(ghost.footprint.pads).toHaveLength(2)
    expect(ghost.footprint.attributes).toContain('board_only')
  })
})
