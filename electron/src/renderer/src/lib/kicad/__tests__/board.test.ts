import { describe, expect, test } from 'vitest'
import {
  addSegmentToBoardAST,
  addTrackArcToBoardAST,
  addViaToBoardAST,
  addTuningPatternToBoardAST,
  addZoneToBoardAST,
  updateBoardZoneInAST,
  setBoardZoneOutlineInAST,
  addGrLineToBoardAST,
  addGrArcToBoardAST,
  addGrCircleToBoardAST,
  addGrRectToBoardAST,
  addGrPolyToBoardAST,
  addGrTextToBoardAST,
  getNetName,
  netDisplayNames,
  moveBoardFootprintInAST,
  parseKicadBoard,
  remapKicadBoard,
  removeBoardNodeFromAST,
  rotateBoardFootprintInAST,
  serializeKicadBoard,
  setBoardStackupInAST,
  translateBoardZoneInAST,
  updateSegmentInAST,
  updateStackupLayerInAST,
  updateStackupSettingsInAST,
  updateViaInAST,
  updateGrTextInAST,
  setBoardItemLockedInAST,
  setBoardOriginInAST,
  viaMaskIsOpen
} from '../board'
import { updateFootprintMetaInAST } from '../footprint'
import { flipBoardFootprintInAST } from '../../board/footprintFlip'
import { mmToNm as mm } from '../coordinates'
import {
  beginNodeCapture,
  endNodeCapture,
  getToken,
  serializeSExpr,
  type SExprList,
  type SExprNode
} from '../sexpr'

const boardSource = `(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (general
    (thickness 1.6)
    (legacy_teardrops no)
  )
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (2 "B.Cu" signal)
    (7 "B.SilkS" user "B.Silkscreen")
    (5 "F.SilkS" user "F.Silkscreen")
    (25 "Edge.Cuts" user)
  )
  (setup
    (stackup
      (layer "F.SilkS" (type "Top Silk Screen"))
      (layer "F.Mask" (type "Top Solder Mask") (color "Green") (thickness 0.01))
      (layer "F.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 1"
        (type "core")
        (thickness 1.51)
        (material "FR4")
        (epsilon_r 4.5)
        (loss_tangent 0.02)
      )
      (layer "B.Cu" (type "copper") (thickness 0.035))
      (layer "B.Mask" (type "Bottom Solder Mask") (color "Green") (thickness 0.01))
      (layer "B.SilkS" (type "Bottom Silk Screen"))
      (copper_finish "HASL")
      (dielectric_constraints no)
    )
    (pad_to_mask_clearance 0)
    (pcbplotparams
      (usegerberextensions yes)
    )
  )
  (embedded_fonts no)
  (net 0 "")
  (net 1 "GND")
  (net 2 "+3V3")
  (footprint "Resistor_SMD:R_0603_1608Metric"
    (layer "F.Cu")
    (uuid "fp-uuid-1")
    (at 100 60 90)
    (property "Reference" "R1"
      (at 0 -1.43 90)
      (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Value" "10k"
      (at 0 1.43 90)
      (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (pad "1" smd roundrect
      (at -0.825 0 90)
      (size 0.8 0.95)
      (layers "F.Cu" "F.Paste" "F.Mask")
      (roundrect_rratio 0.25)
      (net 1 "GND")
    )
    (pad "2" smd roundrect
      (at 0.825 0 90)
      (size 0.8 0.95)
      (layers "F.Cu" "F.Paste" "F.Mask")
      (roundrect_rratio 0.25)
      (net 2 "+3V3")
    )
    (fp_line
      (start -1.24 -0.6)
      (end 1.24 -0.6)
      (stroke (width 0.12) (type solid))
      (layer "F.SilkS")
    )
  )
  (gr_rect
    (start 90 50)
    (end 120 75)
    (stroke (width 0.1) (type solid))
    (layer "Edge.Cuts")
    (uuid "outline-uuid")
  )
  (gr_text "goatcad"
    (at 105 72 0)
    (layer "F.SilkS")
    (effects (font (size 1.5 1.5) (thickness 0.3)))
  )
  (segment
    (start 100 60)
    (end 105 60)
    (width 0.25)
    (layer "F.Cu")
    (net 1)
    (uuid "seg-uuid-1")
  )
  (arc
    (start 105 60)
    (mid 106.464466 60.606602)
    (end 107.071068 62.071068)
    (width 0.25)
    (layer "F.Cu")
    (net 1)
  )
  (via
    (at 107.071068 62.071068)
    (size 0.6)
    (drill 0.3)
    (layers "F.Cu" "B.Cu")
    (net 1)
    (uuid "via-uuid-1")
  )
  (zone
    (net 1)
    (net_name "GND")
    (layer "B.Cu")
    (uuid "zone-uuid-1")
    (hatch edge 0.5)
    (min_thickness 0.25)
    (polygon
      (pts
        (xy 92 52) (xy 118 52) (xy 118 73) (xy 92 73)
      )
    )
    (filled_polygon
      (layer "B.Cu")
      (pts
        (xy 92.2 52.2) (xy 117.8 52.2) (xy 117.8 72.8) (xy 92.2 72.8)
      )
    )
  )
)
`

describe('parseKicadBoard', () => {
  test('parses board metadata, layers and nets', () => {
    const board = parseKicadBoard(boardSource)
    expect(board.version).toBe(20260206)
    expect(board.generator).toBe('pcbnew')
    expect(board.thickness).toBe(mm(1.6))
    expect(board.paper).toBe('A4')

    expect(board.layers.length).toBe(5)
    expect(board.layers[0]).toEqual({
      ordinal: 0,
      name: 'F.Cu',
      type: 'signal',
      userName: undefined
    })
    expect(board.layers[2].userName).toBe('B.Silkscreen')

    expect(board.nets.map((n) => n.name)).toEqual(['', 'GND', '+3V3'])
    expect(getNetName(board, 1)).toBe('GND')
    expect(getNetName(board, 99)).toBe('')
  })

  test('parses placed footprints with placement and embedded definition', () => {
    const board = parseKicadBoard(boardSource)
    expect(board.footprints.length).toBe(1)

    const fp = board.footprints[0]
    expect(fp.libId).toBe('Resistor_SMD:R_0603_1608Metric')
    expect(fp.position).toEqual({ x: mm(100), y: mm(60), angle: 90 })
    expect(fp.layer).toBe('F.Cu')
    expect(fp.reference).toBe('R1')
    expect(fp.value).toBe('10k')
    expect(fp.footprint.pads.length).toBe(2)
    expect(fp.footprint.pads[0].net).toEqual({ number: 1, name: 'GND' })
    expect(fp.footprint.fpLines.length).toBe(1)
  })

  test('parses tracks, arcs and vias', () => {
    const board = parseKicadBoard(boardSource)

    expect(board.segments.length).toBe(1)
    expect(board.segments[0]).toMatchObject({
      start: { x: mm(100), y: mm(60) },
      end: { x: mm(105), y: mm(60) },
      width: mm(0.25),
      layer: 'F.Cu',
      net: 1
    })

    expect(board.trackArcs.length).toBe(1)
    expect(board.trackArcs[0].mid.x).toBe(mm(106.464466))

    expect(board.vias.length).toBe(1)
    expect(board.vias[0]).toMatchObject({
      position: { x: mm(107.071068), y: mm(62.071068) },
      size: mm(0.6),
      drill: mm(0.3),
      layers: ['F.Cu', 'B.Cu'],
      net: 1
    })
  })

  test('parses zones and board graphics', () => {
    const board = parseKicadBoard(boardSource)

    expect(board.zones.length).toBe(1)
    const zone = board.zones[0]
    expect(zone.layers).toEqual(['B.Cu'])
    expect(zone.netName).toBe('GND')
    expect(zone.isKeepout).toBe(false)
    expect(zone.points.length).toBe(4)
    expect(zone.filledPolys.length).toBe(1)
    expect(zone.filledPolys[0].layer).toBe('B.Cu')

    expect(board.grRects.length).toBe(1)
    expect(board.grRects[0].layer).toBe('Edge.Cuts')
    expect(board.grTexts.length).toBe(1)
    expect(board.grTexts[0].text).toBe('goatcad')
    expect(board.grTexts[0].fontEffects?.height).toBe(mm(1.5))
  })

  test('preserves unknown nodes and round-trips stably', () => {
    const board = parseKicadBoard(boardSource)
    expect(board._unknownNodes.length).toBe(1)
    expect(board._unknownNodes.map((n) => getToken(n as SExprList))).toEqual(['embedded_fonts'])

    // The serializer canonicalizes whitespace; the contract is that a
    // serialize -> parse -> serialize cycle is a fixpoint and that unknown
    // nodes — and the unmodeled halves of `setup` — survive untouched.
    const once = serializeKicadBoard(board)
    expect(once).toContain('pad_to_mask_clearance')
    expect(once).toContain('pcbplotparams')
    expect(once).toContain('embedded_fonts')
    const twice = serializeKicadBoard(parseKicadBoard(once))
    expect(twice).toBe(once)
  })
})

describe('stackup', () => {
  test('parses the physical stackup from (setup (stackup ..))', () => {
    const stackup = parseKicadBoard(boardSource).stackup
    expect(stackup).toBeDefined()
    if (!stackup) return

    expect(stackup.layers.map((l) => l.name)).toEqual([
      'F.SilkS',
      'F.Mask',
      'F.Cu',
      'dielectric 1',
      'B.Cu',
      'B.Mask',
      'B.SilkS'
    ])
    expect(stackup.copperFinish).toBe('HASL')
    expect(stackup.dielectricConstraints).toBe(false)
    // Absent flags stay undefined rather than defaulting to false.
    expect(stackup.castellatedPads).toBeUndefined()

    const core = stackup.layers[3]
    expect(core).toMatchObject({
      type: 'core',
      thickness: mm(1.51),
      material: 'FR4',
      epsilonR: 4.5,
      lossTangent: 0.02
    })
    expect(stackup.layers[2]).toMatchObject({ type: 'copper', thickness: mm(0.035) })
    expect(stackup.layers[1].color).toBe('Green')
  })

  test('a board with no stackup parses without one', () => {
    const bare = parseKicadBoard(`(kicad_pcb
  (version 20240108)
  (setup
    (pad_to_mask_clearance 0)
  )
)
`)
    expect(bare.stackup).toBeUndefined()
  })

  test('updateStackupLayerInAST writes through and preserves setup siblings', () => {
    const board = parseKicadBoard(boardSource)
    const stackup = board.stackup
    expect(stackup).toBeDefined()
    if (!stackup) return

    updateStackupLayerInAST(stackup, stackup.layers[2], { thickness: mm(0.07) })
    expect(stackup.layers[2].thickness).toBe(mm(0.07))

    const text = serializeKicadBoard(board)
    expect(text).toContain('pad_to_mask_clearance')
    expect(text).toContain('pcbplotparams')

    const reparsed = parseKicadBoard(text)
    expect(reparsed.stackup?.layers[2].thickness).toBe(mm(0.07))
    // Untouched rows are unchanged.
    expect(reparsed.stackup?.layers[3].material).toBe('FR4')
  })

  test('updateStackupSettingsInAST edits finish and flags', () => {
    const board = parseKicadBoard(boardSource)
    const stackup = board.stackup
    if (!stackup) throw new Error('expected a stackup')

    updateStackupSettingsInAST(stackup, {
      copperFinish: 'ENIG',
      dielectricConstraints: true,
      castellatedPads: true
    })

    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    expect(reparsed.stackup?.copperFinish).toBe('ENIG')
    expect(reparsed.stackup?.dielectricConstraints).toBe(true)
    expect(reparsed.stackup?.castellatedPads).toBe(true)
  })

  test('setBoardStackupInAST builds a 2-layer stackup and syncs board thickness', () => {
    // A board whose setup has no stackup — the shape our own template writes.
    const board = parseKicadBoard(`(kicad_pcb
  (version 20240108)
  (general
    (thickness 1.6)
  )
  (setup
    (pad_to_mask_clearance 0)
  )
)
`)
    setBoardStackupInAST(board, {
      copperLayers: 2,
      boardThickness: 1.6,
      copperThickness: 0.035,
      dielectricMaterial: 'FR4',
      epsilonR: 4.5,
      lossTangent: 0.02,
      maskColor: 'Green',
      copperFinish: 'HASL'
    })

    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    const stackup = reparsed.stackup
    expect(stackup?.layers.map((l) => l.name)).toEqual([
      'F.SilkS',
      'F.Paste',
      'F.Mask',
      'F.Cu',
      'dielectric 1',
      'B.Cu',
      'B.Mask',
      'B.Paste',
      'B.SilkS'
    ])
    // 1.6 - 2 * 0.035, rounded rather than 1.5299999999999998.
    expect(stackup?.layers[4].thickness).toBe(mm(1.53))
    expect(serializeKicadBoard(board)).not.toContain('1.5299999')
    expect(stackup?.copperFinish).toBe('HASL')
    // The pre-existing setup sibling survives.
    expect(serializeKicadBoard(board)).toContain('pad_to_mask_clearance')
    expect(reparsed.thickness).toBe(mm(1.6))
  })

  test('setBoardStackupInAST builds 4 copper layers with prepreg/core/prepreg', () => {
    const board = parseKicadBoard(boardSource)
    setBoardStackupInAST(board, {
      copperLayers: 4,
      boardThickness: 1.6,
      copperThickness: 0.035,
      dielectricMaterial: 'FR4',
      epsilonR: 4.5,
      lossTangent: 0.02
    })

    const stackup = parseKicadBoard(serializeKicadBoard(board)).stackup
    expect(stackup?.layers.map((l) => l.name)).toEqual([
      'F.SilkS',
      'F.Paste',
      'F.Mask',
      'F.Cu',
      'dielectric 1',
      'In1.Cu',
      'dielectric 2',
      'In2.Cu',
      'dielectric 3',
      'B.Cu',
      'B.Mask',
      'B.Paste',
      'B.SilkS'
    ])
    expect(stackup?.layers.map((l) => l.type).filter((t) => t === 'copper').length).toBe(4)
    const dielectrics = stackup?.layers.filter((l) => l.name.startsWith('dielectric')) ?? []
    expect(dielectrics.map((l) => l.type)).toEqual(['prepreg', 'core', 'prepreg'])
    // Copper + dielectrics add back up to the finished board thickness.
    const total = (stackup?.layers ?? [])
      .filter((l) => l.type === 'copper' || l.name.startsWith('dielectric'))
      .reduce((sum, l) => sum + (l.thickness ?? 0) / 1e6, 0)
    expect(total).toBeCloseTo(1.6, 6)
  })

  test('builds any even copper count and keeps the layer table in step', () => {
    // A stackup naming In5.Cu against a layer table without it is an invalid
    // file, so the two must be written together.
    for (const count of [2, 4, 6, 12, 32]) {
      const board = parseKicadBoard(boardSource)
      setBoardStackupInAST(board, {
        copperLayers: count,
        boardThickness: 1.6,
        copperThickness: 0.035,
        innerCopperThickness: 0.0152,
        dielectricMaterial: 'FR4',
        epsilonR: 4.5,
        lossTangent: 0.02
      })
      const reparsed = parseKicadBoard(serializeKicadBoard(board))

      const copper = (reparsed.stackup?.layers ?? []).filter((l) => l.type === 'copper')
      expect(copper.length).toBe(count)
      expect(copper[0].name).toBe('F.Cu')
      expect(copper[copper.length - 1].name).toBe('B.Cu')

      // N copper layers are separated by N-1 dielectrics.
      const dielectrics = (reparsed.stackup?.layers ?? []).filter((l) =>
        l.name.startsWith('dielectric')
      )
      expect(dielectrics.length).toBe(count - 1)

      // The board's own layer table carries the same copper, on KiCad 10's
      // ordinals: F.Cu 0, In*n*.Cu 2*n*+2, B.Cu 2.
      const tableCopper = reparsed.layers.filter((l) => l.name.endsWith('.Cu'))
      expect(tableCopper.map((l) => l.name)).toEqual(copper.map((l) => l.name))
      expect(tableCopper[0].ordinal).toBe(0)
      expect(tableCopper[tableCopper.length - 1].ordinal).toBe(2)
      // Non-copper rows survive untouched.
      expect(reparsed.layers.some((l) => l.name === 'Edge.Cuts')).toBe(true)

      // And it still adds up to the finished thickness — within the stack's
      // own quantization, since every row is independently snapped to 1 nm.
      const rows = (reparsed.stackup?.layers ?? []).filter(
        (l) => l.type === 'copper' || l.name.startsWith('dielectric')
      )
      const total = rows.reduce((sum, l) => sum + (l.thickness ?? 0) / 1e6, 0)
      expect(Math.abs(total - 1.6)).toBeLessThanOrEqual(rows.length * 1e-6)
    }
  })

  test('copper rows take KiCad 10’s ids, whatever the table held', () => {
    // v9 moved B.Cu to 2 and inner layers to 4, 6, …; 31 is F.CrtYd there, so
    // the KiCad 8 ids would put B.Cu on the courtyard.
    for (const source of [boardSource, boardSource.replace('(2 "B.Cu" signal)', '')]) {
      const board = parseKicadBoard(source)
      setBoardStackupInAST(board, {
        copperLayers: 6,
        boardThickness: 1.6,
        copperThickness: 0.035,
        dielectricMaterial: 'FR4',
        epsilonR: 4.5,
        lossTangent: 0.02
      })
      const copper = parseKicadBoard(serializeKicadBoard(board)).layers.filter((l) =>
        l.name.endsWith('.Cu')
      )
      expect(copper.map((l) => [l.ordinal, l.name])).toEqual([
        [0, 'F.Cu'],
        [4, 'In1.Cu'],
        [6, 'In2.Cu'],
        [8, 'In3.Cu'],
        [10, 'In4.Cu'],
        [2, 'B.Cu']
      ])
    }
  })

  test('multilayer builds alternate prepreg and core', () => {
    const board = parseKicadBoard(boardSource)
    setBoardStackupInAST(board, {
      copperLayers: 6,
      boardThickness: 1.6,
      copperThickness: 0.035,
      innerCopperThickness: 0.0152,
      dielectricMaterial: 'FR4',
      epsilonR: 4.5,
      lossTangent: 0.02
    })
    const dielectrics = (parseKicadBoard(serializeKicadBoard(board)).stackup?.layers ?? []).filter(
      (l) => l.name.startsWith('dielectric')
    )
    // Cores carry the copper; prepreg bonds them together.
    expect(dielectrics.map((l) => l.type)).toEqual([
      'prepreg',
      'core',
      'prepreg',
      'core',
      'prepreg'
    ])
  })

  test('shrinking the copper count drops the inner layers again', () => {
    const board = parseKicadBoard(boardSource)
    const spec = {
      boardThickness: 1.6,
      copperThickness: 0.035,
      dielectricMaterial: 'FR4',
      epsilonR: 4.5,
      lossTangent: 0.02
    }
    setBoardStackupInAST(board, { ...spec, copperLayers: 8 })
    setBoardStackupInAST(board, { ...spec, copperLayers: 2 })
    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    expect(reparsed.layers.filter((l) => l.name.endsWith('.Cu')).map((l) => l.name)).toEqual([
      'F.Cu',
      'B.Cu'
    ])
    expect(serializeKicadBoard(board)).not.toContain('In1.Cu')
  })

  test('replacing a stackup keeps it in place and does not duplicate it', () => {
    const board = parseKicadBoard(boardSource)
    setBoardStackupInAST(board, {
      copperLayers: 2,
      boardThickness: 1.0,
      copperThickness: 0.035,
      dielectricMaterial: 'FR4',
      epsilonR: 4.6,
      lossTangent: 0.02
    })
    const text = serializeKicadBoard(board)
    expect(text.match(/\(stackup/g)?.length).toBe(1)
    expect(text).toContain('pad_to_mask_clearance')
    expect(parseKicadBoard(text).stackup?.layers[4].thickness).toBe(mm(0.93))
  })
})

describe('board AST mutations', () => {
  test('updateSegmentInAST writes through', () => {
    const board = parseKicadBoard(boardSource)
    const seg = board.segments[0]
    updateSegmentInAST(seg, { end: { x: mm(110), y: mm(61) }, width: mm(0.5) })

    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    expect(reparsed.segments[0].end).toEqual({ x: mm(110), y: mm(61) })
    expect(reparsed.segments[0].width).toBe(mm(0.5))
    expect(reparsed.segments[0].start).toEqual({ x: mm(100), y: mm(60) })
  })

  test('updateViaInAST writes through', () => {
    const board = parseKicadBoard(boardSource)
    updateViaInAST(board.vias[0], {
      position: { x: mm(108), y: mm(63) },
      size: mm(0.8),
      drill: mm(0.4)
    })

    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    expect(reparsed.vias[0].position).toEqual({ x: mm(108), y: mm(63) })
    expect(reparsed.vias[0].size).toBe(mm(0.8))
    expect(reparsed.vias[0].drill).toBe(mm(0.4))
  })

  test('moveBoardFootprintInAST keeps rotation', () => {
    const board = parseKicadBoard(boardSource)
    moveBoardFootprintInAST(board.footprints[0], mm(95.5), mm(58))

    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    expect(reparsed.footprints[0].position).toEqual({ x: mm(95.5), y: mm(58), angle: 90 })
  })

  test('rotateBoardFootprintInAST rotates children absolute angles', () => {
    const board = parseKicadBoard(boardSource)
    rotateBoardFootprintInAST(board.footprints[0], 180)

    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    const fp = reparsed.footprints[0]
    expect(fp.position.angle).toBe(180)
    // Pads were at absolute 90 (= fp 90 + rel 0); rotating fp by +90 makes them 180
    expect(fp.footprint.pads[0].position.angle).toBe(180)
    expect(fp.footprint.properties[0].position?.angle).toBe(180)
    // Relative pad offsets unchanged
    expect(fp.footprint.pads[0].position.x).toBe(mm(-0.825))
  })

  test('rotate to 0 drops the angle atoms', () => {
    const board = parseKicadBoard(boardSource)
    rotateBoardFootprintInAST(board.footprints[0], 360)

    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    expect(reparsed.footprints[0].position.angle).toBeUndefined()
    // Pads were stored at absolute 90 (= fp 90 + rel 0); the fp is now at 0,
    // so the pads' absolute angle is 0 and the atom is dropped too
    expect(reparsed.footprints[0].footprint.pads[0].position.angle).toBeUndefined()
    expect(reparsed.footprints[0].footprint.pads[0].position.x).toBe(mm(-0.825))
  })

  test("a footprint's board-absolute zones follow it when it moves and turns", () => {
    const board = parseKicadBoard(`(kicad_pcb (version 20240108) (generator "test")
  (footprint "T:MOD" (layer "F.Cu") (uuid "fp") (at 10 20)
    (zone (layers "F.Cu") (uuid "ko")
      (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
      (polygon (pts (xy 12 20) (xy 14 20) (xy 14 18))))))`)
    const bfp = board.footprints[0]
    expect(bfp.footprint.zones[0]).toMatchObject({ isKeepout: true, layers: ['F.Cu'], uuid: 'ko' })

    moveBoardFootprintInAST(bfp, mm(11), mm(25))
    let zone = parseKicadBoard(serializeKicadBoard(board)).footprints[0].footprint.zones[0]
    expect(zone.points[0]).toEqual({ x: mm(13), y: mm(25) })

    // +90 is counterclockwise on screen: a point 2 mm east of the origin goes 2 mm up (y down).
    rotateBoardFootprintInAST(bfp, 90)
    zone = parseKicadBoard(serializeKicadBoard(board)).footprints[0].footprint.zones[0]
    expect(zone.points[0]).toEqual({ x: mm(11), y: mm(23) })
    expect(zone.points[2]).toEqual({ x: mm(9), y: mm(21) })
  })

  test('a placement area is a rule area keeping out tracks, vias and pads, as KiCad reads it', () => {
    const board = parseKicadBoard(`(kicad_pcb (version 20240108) (generator "test")
  (zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (uuid "area") (name "auto-placement-area")
    (placement (enabled yes) (sheetname "/io/"))
    (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10)))))`)
    const zone = board.zones[0]
    expect(zone.isKeepout).toBe(true)
    expect(zone.keepoutRules).toEqual({
      tracks: false,
      vias: false,
      pads: false,
      copperpour: true,
      footprints: true
    })
    // Editing one rule writes the (keepout …) the file lacked, with the rest as they stood.
    updateBoardZoneInAST(zone, { keepoutRules: { tracks: true } })
    const reparsed = parseKicadBoard(serializeKicadBoard(board)).zones[0]
    expect(reparsed.keepoutRules).toEqual({
      tracks: true,
      vias: false,
      pads: false,
      copperpour: true,
      footprints: true
    })
  })

  test('updateBoardZoneInAST pours hatched as KiCad writes it, and solid again', () => {
    const board = parseKicadBoard(boardSource)
    const zone = board.zones[0]
    updateBoardZoneInAST(zone, { hatchFill: {} })
    updateBoardZoneInAST(zone, { hatchFill: { gap: 2, orientation: 30 } })
    const text = serializeKicadBoard(board)
    // (mode hatch) leads the keyed children; the hatch keys close the fill in KiCad's order.
    expect(text.replace(/\s+/g, ' ')).toMatch(
      /\(fill[^()]*\(mode hatch\).*\(hatch_thickness 1\) \(hatch_gap 2\) \(hatch_orientation 30\) \(hatch_border_algorithm hatch_thickness\) \(hatch_min_hole_area 0\.3\) \)/
    )
    expect(parseKicadBoard(text).zones[0].hatchFill).toMatchObject({ gap: 2, orientation: 30 })

    updateBoardZoneInAST(zone, { hatchFill: null })
    const solid = serializeKicadBoard(board)
    expect(solid).not.toMatch(/mode hatch|hatch_/)
    expect(parseKicadBoard(solid).zones[0].hatchFill).toBeUndefined()
  })

  test('translateBoardZoneInAST moves outline and fills', () => {
    const board = parseKicadBoard(boardSource)
    translateBoardZoneInAST(board.zones[0], mm(2), mm(-3))

    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    expect(reparsed.zones[0].points[0]).toEqual({ x: mm(94), y: mm(49) })
    expect(reparsed.zones[0].filledPolys[0].points[0]).toEqual({ x: mm(94.2), y: mm(49.2) })
  })

  test('addSegmentToBoardAST and addViaToBoardAST append parseable nodes', () => {
    const board = parseKicadBoard(boardSource)
    addSegmentToBoardAST(board, {
      start: { x: mm(90), y: mm(50) },
      end: { x: mm(95), y: mm(50) },
      width: mm(0.3),
      layer: 'B.Cu',
      net: 2
    })
    addViaToBoardAST(board, {
      position: { x: mm(95), y: mm(50) },
      size: mm(0.7),
      drill: mm(0.35),
      layers: ['F.Cu', 'B.Cu'],
      net: 2
    })

    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    expect(reparsed.segments.length).toBe(2)
    expect(reparsed.segments[1]).toMatchObject({
      start: { x: mm(90), y: mm(50) },
      end: { x: mm(95), y: mm(50) },
      width: mm(0.3),
      layer: 'B.Cu',
      net: 2
    })
    expect(reparsed.vias.length).toBe(2)
    expect(reparsed.vias[1].drill).toBe(mm(0.35))
    expect(reparsed.vias[1].uuid).toBeTruthy()
  })

  test('addTrackArcToBoardAST appends a parseable track arc', () => {
    const board = parseKicadBoard(boardSource)
    const before = board.trackArcs.length
    addTrackArcToBoardAST(board, {
      start: { x: mm(90), y: mm(50) },
      mid: { x: mm(91), y: mm(51) },
      end: { x: mm(92), y: mm(50) },
      width: mm(0.25),
      layer: 'F.Cu',
      net: 2
    })
    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    expect(reparsed.trackArcs.length).toBe(before + 1)
    expect(reparsed.trackArcs[before]).toMatchObject({
      start: { x: mm(90), y: mm(50) },
      mid: { x: mm(91), y: mm(51) },
      end: { x: mm(92), y: mm(50) },
      width: mm(0.25),
      layer: 'F.Cu',
      net: 2
    })
    expect(reparsed.trackArcs[before].uuid).toBeTruthy()
  })

  test('removeBoardNodeFromAST deletes elements', () => {
    const board = parseKicadBoard(boardSource)
    expect(removeBoardNodeFromAST(board, board.segments[0]._raw)).toBe(true)
    expect(removeBoardNodeFromAST(board, board.vias[0]._raw)).toBe(true)

    const reparsed = parseKicadBoard(serializeKicadBoard(board))
    expect(reparsed.segments.length).toBe(0)
    expect(reparsed.vias.length).toBe(0)
    expect(reparsed.footprints.length).toBe(1)
  })

  test('setBoardItemLockedInAST writes (locked yes) before the layer and removes it', () => {
    const board = parseKicadBoard(boardSource)
    setBoardItemLockedInAST(board.segments[0], true)
    setBoardItemLockedInAST(board.vias[0], true)
    setBoardItemLockedInAST(board.footprints[0].footprint, true)
    const text = serializeKicadBoard(board)
    expect(text).toMatch(/\(segment[\s\S]*?\(locked yes\)\s*\(layer/)
    const locked = parseKicadBoard(text)
    expect(locked.segments[0].locked).toBe(true)
    expect(locked.vias[0].locked).toBe(true)
    expect(locked.footprints[0].footprint.locked).toBe(true)

    setBoardItemLockedInAST(locked.segments[0], false)
    setBoardItemLockedInAST(locked.footprints[0].footprint, false)
    const unlocked = serializeKicadBoard(locked)
    expect(parseKicadBoard(unlocked).segments[0].locked).toBe(false)
    expect(parseKicadBoard(unlocked).footprints[0].footprint.locked).toBe(false)
    expect(unlocked).toBe(serializeKicadBoard(parseKicadBoard(unlocked)))
  })

  test('setBoardItemLockedInAST keeps an old file’s bare locked atom', () => {
    const board = parseKicadBoard(`(kicad_pcb (version 20211014) (generator pcbnew)
  (gr_text "HI" locked (at 1 2) (layer "F.SilkS"))
  (gr_line locked (start 0 0) (end 1 0) (layer "Edge.Cuts") (width 0.1)))`)
    expect(board.grTexts[0].locked).toBe(true)
    setBoardItemLockedInAST(board.grTexts[0], true)
    expect(serializeKicadBoard(board)).not.toContain('(locked yes)')
    setBoardItemLockedInAST(board.grLines[0], false)
    expect(parseKicadBoard(serializeKicadBoard(board)).grLines[0].locked).toBe(false)
  })

  test('setBoardOriginInAST places, moves and resets the grid and drill origins', () => {
    const board = parseKicadBoard(`(kicad_pcb (version 20240108) (generator "test")
  (setup (pad_to_mask_clearance 0) (pcbplotparams (layerselection 0x1)))
  (gr_line (start 0 0) (end 1 0) (layer "Edge.Cuts") (width 0.1)))`)
    expect(board.gridOrigin).toBeUndefined()
    setBoardOriginInAST(board, 'grid', { x: mm(100), y: mm(50) })
    setBoardOriginInAST(board, 'drill', { x: mm(10), y: mm(20) })
    let text = serializeKicadBoard(board)
    // KiCad's order: aux_axis_origin, grid_origin, then the plot parameters.
    expect(text).toMatch(/\(aux_axis_origin 10 20\)\s*\(grid_origin 100 50\)\s*\(pcbplotparams/)
    const placed = parseKicadBoard(text)
    expect(placed.gridOrigin).toEqual({ x: mm(100), y: mm(50) })
    expect(placed.auxOrigin).toEqual({ x: mm(10), y: mm(20) })

    setBoardOriginInAST(placed, 'grid', { x: mm(1.5), y: mm(2) })
    setBoardOriginInAST(placed, 'drill', null)
    text = serializeKicadBoard(placed)
    expect(parseKicadBoard(text).gridOrigin).toEqual({ x: mm(1.5), y: mm(2) })
    expect(text).not.toContain('aux_axis_origin')
    setBoardOriginInAST(placed, 'grid', { x: mm(0), y: mm(0) })
    expect(serializeKicadBoard(placed)).not.toContain('grid_origin')
  })

  test('a board text takes the marker after its string', () => {
    const board = parseKicadBoard(`(kicad_pcb (version 20240108) (generator "test")
  (gr_text "HI" (at 1 2) (layer "F.SilkS") (uuid "t")))`)
    setBoardItemLockedInAST(board.grTexts[0], true)
    expect(serializeKicadBoard(board)).toMatch(/\(gr_text "HI"\s*\(locked yes\)/)
  })
})

// Grammar details originally verified against real KiCad 8 output ("canary"
// checks): text justification order, custom pad primitives, footprint-embedded
// dimensions, and property hide flags. Captured here as an inline fixture so
// the regression suite is self-contained and deterministic.
const grammarSource = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (36 "B.SilkS" user "B.Silkscreen")
    (44 "Edge.Cuts" user)
  )
  (net 0 "")
  (footprint "Test:CustomPad"
    (layer "F.Cu")
    (uuid "fp-grammar-1")
    (at 100 60)
    (property "Reference" "U1"
      (at 0 -2 0)
      (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Value" "logo"
      (at 0 2 0)
      (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Footprint" "Test:CustomPad"
      (at 0 0 0)
      (layer "F.Fab")
      hide
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (pad "1" smd custom
      (at 0 0 90)
      (size 1 1)
      (layers "F.Cu" "F.Mask")
      (options (clearance outline) (anchor circle))
      (primitives
        (gr_poly
          (pts (xy -1 -1) (xy 1 -1) (xy 1.4 0) (xy 1 1) (xy -1 1))
          (width 0.1)
          (fill yes)
        )
      )
    )
    (dimension
      (type orthogonal)
      (layer "F.Fab")
      (pts (xy 0 0) (xy 12.7 0))
      (height 3)
      (gr_text "12.7 mm"
        (at 6.35 -3.5 0)
        (layer "F.Fab")
        (effects (font (size 1 1) (thickness 0.15)))
      )
      (style (thickness 0.15) (arrow_length 1.27) (extension_height 0.58) (extension_offset 0.5))
    )
  )
  (gr_text "corner anchored"
    (at 91 74 0)
    (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15)) (justify left bottom))
  )
  (gr_text "shouted"
    (at 105 60 0)
    (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15) bold))
  )
)
`

describe('KiCad 8 grammar details', () => {
  test('parses text justification and font size (HEIGHT WIDTH order)', () => {
    const board = parseKicadBoard(grammarSource)
    const anchored = board.grTexts.find((t) => t.text === 'corner anchored')
    expect(anchored?.fontEffects?.hAlign).toBe('left')
    expect(anchored?.fontEffects?.vAlign).toBe('bottom')

    const bold = board.grTexts.find((t) => t.text === 'shouted')
    expect(bold?.fontEffects?.bold).toBe(true)
    // Center-justified text carries no alignment overrides
    expect(bold?.fontEffects?.hAlign).toBeUndefined()
    expect(bold?.fontEffects?.vAlign).toBeUndefined()
  })

  test('parses custom pad primitives', () => {
    const board = parseKicadBoard(grammarSource)
    const customPads = board.footprints.flatMap((f) =>
      f.footprint.pads.filter((p) => p.shape === 'custom')
    )
    expect(customPads.length).toBe(1)
    expect(customPads[0].primitives?.polys.length).toBe(1)
    expect(customPads[0].primitives?.polys[0].points.length).toBe(5)
    expect(customPads[0].primitives?.polys[0].fill).toBe('yes')
  })

  test('parses dimensions embedded in footprints', () => {
    const board = parseKicadBoard(grammarSource)
    const dims = board.footprints.flatMap((f) => f.footprint.dimensions)
    expect(dims.length).toBe(1)
    expect(dims[0].dimensionType).toBe('orthogonal')
    expect(dims[0].points.length).toBe(2)
    expect(dims[0].text?.text).toContain('mm')
    expect(dims[0].style?.arrowLength).toBeGreaterThan(0)
  })

  test('hidden properties stay hidden, visible values stay visible', () => {
    const board = parseKicadBoard(grammarSource)
    const footprint = board.footprints[0]?.footprint
    expect(footprint?.properties.find((p) => p.key === 'Footprint')?.hide).toBe(true)
    // A property without a hide token must not be hidden
    expect(footprint?.properties.find((p) => p.key === 'Value')?.hide).toBe(false)
  })

  test('round-trips stably with no data loss', () => {
    const board = parseKicadBoard(grammarSource)
    const once = serializeKicadBoard(board)
    const reparsed = parseKicadBoard(once)

    // Fixpoint: a second serialize/parse cycle is byte-identical
    expect(serializeKicadBoard(reparsed)).toBe(once)
    expect(reparsed.footprints.length).toBe(board.footprints.length)
    expect(reparsed.grTexts.length).toBe(board.grTexts.length)
  })
})

describe('incremental serialization', () => {
  // serializeKicadBoard caches serialized text per top-level AST node, and
  // every exported mutator must mark the node it touches dirty. This suite
  // exercises each mutator between two serializes and asserts the cached
  // output is byte-identical to a from-scratch serialize of the same AST —
  // a stale-cache bug fails loudly here.
  // Matches `serializeKicadBoard`, trailing newline included — the comparison
  // is about cache coherence, not about who appends the final byte.
  const freshText = (board: ReturnType<typeof parseKicadBoard>): string =>
    `${serializeSExpr(board._raw)}\n`

  test('every mutator invalidates its node', () => {
    const board = parseKicadBoard(boardSource)
    serializeKicadBoard(board) // populate the cache

    updateSegmentInAST(board.segments[0], { start: { x: mm(101), y: mm(61) }, width: mm(0.3) })
    expect(serializeKicadBoard(board)).toBe(freshText(board))

    updateViaInAST(board.vias[0], { position: { x: mm(105), y: mm(60) }, size: mm(0.7) })
    expect(serializeKicadBoard(board)).toBe(freshText(board))

    moveBoardFootprintInAST(board.footprints[0], mm(90), mm(55))
    expect(serializeKicadBoard(board)).toBe(freshText(board))

    rotateBoardFootprintInAST(board.footprints[0], 180)
    expect(serializeKicadBoard(board)).toBe(freshText(board))

    translateBoardZoneInAST(board.zones[0], mm(1.5), mm(-2))
    expect(serializeKicadBoard(board)).toBe(freshText(board))

    addSegmentToBoardAST(board, {
      start: { x: mm(1), y: mm(2) },
      end: { x: mm(3), y: mm(4) },
      width: mm(0.2),
      layer: 'F.Cu',
      net: 1
    })
    expect(serializeKicadBoard(board)).toBe(freshText(board))

    addViaToBoardAST(board, {
      position: { x: mm(5), y: mm(6) },
      size: mm(0.6),
      drill: mm(0.3),
      layers: ['F.Cu', 'B.Cu'],
      net: 1
    })
    expect(serializeKicadBoard(board)).toBe(freshText(board))

    removeBoardNodeFromAST(board, board.vias[0]._raw)
    expect(serializeKicadBoard(board)).toBe(freshText(board))

    // Stackup edits live two levels down (setup > stackup > layer). The cache
    // is keyed on the root's direct children, so these must dirty `setup`.
    const stackup = board.stackup
    if (!stackup) throw new Error('expected a stackup')
    updateStackupLayerInAST(stackup, stackup.layers[2], { thickness: mm(0.07) })
    expect(serializeKicadBoard(board)).toBe(freshText(board))

    updateStackupSettingsInAST(stackup, { copperFinish: 'ENIG' })
    expect(serializeKicadBoard(board)).toBe(freshText(board))

    setBoardStackupInAST(board, {
      copperLayers: 2,
      boardThickness: 1.6,
      copperThickness: 0.035,
      dielectricMaterial: 'FR4',
      epsilonR: 4.5,
      lossTangent: 0.02
    })
    expect(serializeKicadBoard(board)).toBe(freshText(board))
  })

  test('remap keeps the cache coherent across the command cycle', () => {
    let board = parseKicadBoard(boardSource)
    serializeKicadBoard(board)
    updateSegmentInAST(board.segments[0], { width: mm(0.42) })
    const after = serializeKicadBoard(board)
    board = remapKicadBoard(board)
    expect(serializeKicadBoard(board)).toBe(after)
    expect(after).toBe(freshText(board))
    expect(board.segments[0].width).toBe(mm(0.42))
  })
})

describe('structural undo primitives', () => {
  // Mirrors PcbEditor's runCommand/applySnapshot flow without the component:
  // capture pre-mutation clones via the dirty-mark journal, snapshot the
  // top-level children, mutate, then restore and expect byte-identical text.
  interface Snap {
    children: SExprNode[]
  }

  const command = (
    board: ReturnType<typeof parseKicadBoard>,
    mutate: () => void
  ): { before: Snap; after: Snap; clones: Map<SExprNode, SExprNode> } => {
    const root = board._raw as SExprList
    const childrenBefore = root.children.slice()
    beginNodeCapture()
    mutate()
    const clones = endNodeCapture()
    return {
      before: { children: childrenBefore.map((n) => clones.get(n) ?? n) },
      after: { children: root.children.slice() },
      clones
    }
  }

  const apply = (board: ReturnType<typeof parseKicadBoard>, snap: Snap): string => {
    const root = board._raw as SExprList
    root.children = snap.children.slice()
    return serializeKicadBoard(remapKicadBoard(board))
  }

  test('each mutator round-trips through undo to identical text', () => {
    const mutations: Array<(b: ReturnType<typeof parseKicadBoard>) => void> = [
      (b) => updateSegmentInAST(b.segments[0], { start: { x: mm(7), y: mm(8) }, width: mm(0.4) }),
      (b) => updateViaInAST(b.vias[0], { position: { x: mm(1), y: mm(2) }, drill: mm(0.2) }),
      (b) => moveBoardFootprintInAST(b.footprints[0], mm(42), mm(24)),
      (b) => rotateBoardFootprintInAST(b.footprints[0], 270),
      (b) => void flipBoardFootprintInAST(b, b.footprints[0], b.footprints[0].position),
      (b) => translateBoardZoneInAST(b.zones[0], mm(3), mm(-4)),
      (b) =>
        void addSegmentToBoardAST(b, {
          start: { x: mm(0), y: mm(0) },
          end: { x: mm(1), y: mm(1) },
          width: mm(0.2),
          layer: 'F.Cu',
          net: 1
        }),
      (b) =>
        void addTrackArcToBoardAST(b, {
          start: { x: mm(0), y: mm(0) },
          mid: { x: mm(1), y: mm(1) },
          end: { x: mm(2), y: mm(0) },
          width: mm(0.2),
          layer: 'F.Cu',
          net: 1
        }),
      (b) => void removeBoardNodeFromAST(b, b.vias[0]._raw),
      (b) =>
        void addGrLineToBoardAST(b, {
          start: { x: mm(0), y: mm(0) },
          end: { x: mm(10), y: mm(0) },
          width: mm(0.05),
          layer: 'Edge.Cuts'
        }),
      (b) =>
        void addGrArcToBoardAST(b, {
          start: { x: mm(0), y: mm(0) },
          mid: { x: mm(5), y: mm(5) },
          end: { x: mm(10), y: mm(0) },
          width: mm(0.1),
          layer: 'F.SilkS'
        }),
      (b) =>
        void addGrCircleToBoardAST(b, {
          center: { x: mm(5), y: mm(5) },
          end: { x: mm(8), y: mm(5) },
          width: mm(0.1),
          layer: 'F.SilkS'
        }),
      (b) =>
        void addGrRectToBoardAST(b, {
          start: { x: mm(1), y: mm(1) },
          end: { x: mm(9), y: mm(6) },
          width: mm(0.1),
          layer: 'Cmts.User'
        }),
      (b) =>
        void addGrPolyToBoardAST(b, {
          points: [
            { x: mm(0), y: mm(0) },
            { x: mm(4), y: mm(0) },
            { x: mm(2), y: mm(3) }
          ],
          width: mm(0.1),
          layer: 'F.SilkS'
        }),
      (b) =>
        void addGrTextToBoardAST(b, {
          text: 'Text',
          position: { x: mm(3), y: mm(4) },
          layer: 'F.SilkS',
          size: mm(1),
          thickness: mm(0.1)
        }),
      (b) =>
        void addZoneToBoardAST(b, {
          points: [
            { x: mm(0), y: mm(0) },
            { x: mm(10), y: mm(0) },
            { x: mm(10), y: mm(10) }
          ],
          layers: ['F.Cu'],
          net: 1,
          netName: 'GND'
        }),
      (b) =>
        updateBoardZoneInAST(b.zones[0], {
          net: { number: 1, name: 'GND' },
          priority: 2,
          padConnection: 'solid',
          thermalGap: mm(0.4),
          keepout: true
        }),
      (b) =>
        setBoardZoneOutlineInAST(b.zones[0], [
          { x: mm(1), y: mm(1) },
          { x: mm(9), y: mm(1) },
          { x: mm(5), y: mm(8) }
        ]),
      (b) => {
        if (b.stackup)
          updateStackupLayerInAST(b.stackup, b.stackup.layers[3], { thickness: mm(1.2) })
      },
      (b) => {
        if (b.stackup) updateStackupSettingsInAST(b.stackup, { copperFinish: 'ENIG' })
      },
      (b) =>
        setBoardStackupInAST(b, {
          copperLayers: 4,
          boardThickness: 1.6,
          copperThickness: 0.035,
          dielectricMaterial: 'FR4',
          epsilonR: 4.5,
          lossTangent: 0.02
        })
    ]

    for (const mutation of mutations) {
      const board = parseKicadBoard(boardSource)
      const pristine = serializeKicadBoard(board)
      const delta = command(board, () => mutation(board))
      const mutatedText = serializeKicadBoard(board)
      expect(apply(board, delta.before)).toBe(pristine)
      expect(apply(board, delta.after)).toBe(mutatedText)
    }
  })

  test('undo chain over repeated mutation of the same node', () => {
    const board = parseKicadBoard(boardSource)
    const t0 = serializeKicadBoard(board)
    const d1 = command(board, () => updateSegmentInAST(board.segments[0], { width: mm(0.5) }))
    const t1 = serializeKicadBoard(board)
    // second command mutates the same node: per the invariant, older entries
    // must swap the live node for its fresh pre-mutation clone
    const d2 = command(board, () => updateSegmentInAST(board.segments[0], { width: mm(0.9) }))
    const substitute = (snap: Snap): Snap => ({
      children: snap.children.map((n) => d2.clones.get(n) ?? n)
    })
    d1.before = substitute(d1.before)
    d1.after = substitute(d1.after)
    const t2 = serializeKicadBoard(board)

    expect(apply(board, d2.before)).toBe(t1)
    expect(apply(board, d1.before)).toBe(t0)
    // redo forward again
    expect(apply(board, d1.after)).toBe(t1)
    expect(apply(board, d2.after)).toBe(t2)
  })

  test('capture clones packed nodes without materializing them', () => {
    const board = parseKicadBoard(boardSource)
    const segNode = board.segments[0]._raw
    beginNodeCapture()
    updateSegmentInAST(board.segments[0], { width: mm(0.7) })
    const clones = endNodeCapture()
    const clone = clones.get(segNode)
    expect(clone).toBeDefined()
    expect(clone).not.toBe(segNode)
    // the clone carries the pre-mutation width, the live node the new one
    expect(serializeSExpr(clone!)).toContain('(width 0.25)')
    expect(serializeSExpr(segNode)).toContain('(width 0.7)')
  })
})

describe('Phase 0 board gaps', () => {
  test('via type + layers are editable', () => {
    const board = parseKicadBoard(boardSource)
    expect(board.vias[0].type).toBeUndefined() // through
    updateViaInAST(board.vias[0], { type: 'micro', layers: ['F.Cu', 'In1.Cu'] })
    const round = parseKicadBoard(serializeKicadBoard(board))
    expect(round.vias[0].type).toBe('micro')
    expect(round.vias[0].layers).toEqual(['F.Cu', 'In1.Cu'])
  })

  test('a buried via, KiCad 10’s third marker, reads and writes as buried', () => {
    const board = parseKicadBoard(boardSource)
    updateViaInAST(board.vias[0], { type: 'buried', layers: ['In1.Cu', 'In2.Cu'] })
    const text = serializeKicadBoard(board)
    expect(text).toMatch(/\(via buried/)
    expect(parseKicadBoard(text).vias[0].type).toBe('buried')
  })

  test('a new via carries its type marker, a through via none', () => {
    const board = parseKicadBoard(boardSource)
    const base = { position: { x: mm(1), y: mm(1) }, size: mm(0.3), drill: mm(0.1), net: 0 }
    addViaToBoardAST(board, { ...base, layers: ['F.Cu', 'In1.Cu'], type: 'micro' })
    addViaToBoardAST(board, { ...base, layers: ['F.Cu', 'B.Cu'] })
    const round = parseKicadBoard(serializeKicadBoard(board))
    const added = round.vias.slice(-2)
    expect(added[0].type).toBe('micro')
    expect(added[1].type).toBeUndefined()
  })

  test('a tuning pattern is written as KiCad writes one, its tracks its members', () => {
    const board = parseKicadBoard(boardSource)
    const p = (x: number, y: number): { x: ReturnType<typeof mm>; y: ReturnType<typeof mm> } => ({
      x: mm(x),
      y: mm(y)
    })
    addTuningPatternToBoardAST(board, {
      layer: 'F.Cu',
      mode: 'single',
      origin: p(1, 2),
      end: p(5, 2),
      baseLine: [p(1, 2), p(5, 2)],
      initialSide: 'left',
      minAmplitude: 0.2,
      maxAmplitude: 1,
      minSpacing: 0.6,
      cornerRadiusPercent: 80,
      rounded: true,
      singleSided: false,
      targetLength: { min: 9.9, opt: 10, max: 10.1 },
      targetSkew: { min: -0.1, opt: 0, max: 0.1 },
      overrideCustomRules: false,
      lastNetName: 'SIG',
      lastStatus: 'tuned',
      lastTrackWidth: 0.25,
      lastDiffPairGap: 0,
      lastTuningLength: 10,
      members: ['b-uuid', 'a-uuid']
    })
    const text = serializeKicadBoard(board)
    expect(text).toMatch(/\(generated\s+\(uuid "[^"]+"\)\s+\(type tuning_pattern\)/)
    expect(text).toMatch(/\(base_line\s+\(pts\s+\(xy 1 2\)\s*\(xy 5 2\)/)
    expect(text).toMatch(/\(tuning_mode "single"\)/)
    // Sorted, as KiCad sorts them.
    expect(text).toMatch(/\(members "a-uuid" "b-uuid"\)/)
    expect(text).toMatch(/\(target_skew_min -0\.1\)/)
    // Still a board KiCad's shape reads.
    expect(parseKicadBoard(text).segments.length).toBe(board.segments.length)
  })

  test('a time-domain tuning pattern keeps its target in ps, as KiCad reads it back', () => {
    const board = parseKicadBoard(boardSource)
    const p = { x: mm(1), y: mm(2) }
    addTuningPatternToBoardAST(board, {
      layer: 'F.Cu',
      mode: 'single',
      origin: p,
      end: p,
      baseLine: [p, p],
      initialSide: 'left',
      minAmplitude: 0.2,
      maxAmplitude: 1,
      minSpacing: 0.6,
      cornerRadiusPercent: 80,
      rounded: true,
      singleSided: false,
      targetLength: { min: 24.9, opt: 25, max: 25.1 },
      targetSkew: { min: -0.1, opt: 0, max: 0.1 },
      targetDelay: { min: 174.9, opt: 175, max: 175.1 },
      overrideCustomRules: false,
      lastNetName: 'SIG',
      lastStatus: 'tuned',
      lastTrackWidth: 0.25,
      lastDiffPairGap: 0,
      lastTuningLength: 25,
      members: []
    })
    const text = serializeKicadBoard(board)
    expect(text).toMatch(/\(is_time_domain yes\)/)
    expect(text).toMatch(/\(target_delay 175\)/)
    const round = parseKicadBoard(text).tuningPatterns.at(-1)!
    expect(round.targetDelay).toEqual({ min: 174.9, opt: 175, max: 175.1 })
  })

  test('a tuning pattern’s base line keeps its arcs, as KiCad writes them', () => {
    const board = parseKicadBoard(boardSource)
    const p = (x: number, y: number): { x: ReturnType<typeof mm>; y: ReturnType<typeof mm> } => ({
      x: mm(x),
      y: mm(y)
    })
    const base = [p(0, 0), p(5, 0), { ...p(10, 0), mid: p(7.5, -2.5) }, p(20, 0)]
    addTuningPatternToBoardAST(board, {
      layer: 'F.Cu',
      mode: 'single',
      origin: p(0, 0),
      end: p(20, 0),
      baseLine: base,
      initialSide: 'left',
      minAmplitude: 0.2,
      maxAmplitude: 1,
      minSpacing: 0.6,
      cornerRadiusPercent: 80,
      rounded: true,
      singleSided: false,
      targetLength: { min: 0, opt: Infinity, max: Infinity },
      targetSkew: { min: -0.1, opt: 0, max: 0.1 },
      overrideCustomRules: false,
      lastNetName: 'SIG',
      lastStatus: 'tuned',
      lastTrackWidth: 0.25,
      lastDiffPairGap: 0,
      lastTuningLength: 25,
      members: []
    })
    const text = serializeKicadBoard(board)
    expect(text).toMatch(
      /\(pts\s+\(xy 0 0\)\s*\(arc\s+\(start 5 0\)\s*\(mid 7\.5 -2\.5\)\s*\(end 10 0\)\s*\)\s*\(xy 20 0\)\s*\)/
    )
    expect(parseKicadBoard(text).tuningPatterns.at(-1)!.baseLine).toEqual(base)
  })

  test('via type reverts to through by clearing the marker', () => {
    const board = parseKicadBoard(boardSource)
    updateViaInAST(board.vias[0], { type: 'blind' })
    updateViaInAST(board.vias[0], { type: 'through' })
    const round = parseKicadBoard(serializeKicadBoard(board))
    expect(round.vias[0].type).toBeUndefined()
  })

  test('gr_text edits text/layer/effects', () => {
    const board = parseKicadBoard(boardSource)
    updateGrTextInAST(board.grTexts[0], {
      text: 'hello',
      layer: 'B.SilkS',
      fontEffects: { width: mm(1), height: mm(1), thickness: mm(0.15), bold: true }
    })
    const round = parseKicadBoard(serializeKicadBoard(board))
    expect(round.grTexts[0].text).toBe('hello')
    expect(round.grTexts[0].layer).toBe('B.SilkS')
    expect(round.grTexts[0].fontEffects?.bold).toBe(true)
  })

  test('board footprint locked + side are editable', () => {
    const board = parseKicadBoard(boardSource)
    const bfp = board.footprints[0]
    expect(bfp.footprint.locked).toBe(false)
    updateFootprintMetaInAST(bfp.footprint, { locked: true })
    flipBoardFootprintInAST(board, bfp, bfp.position)
    const round = parseKicadBoard(serializeKicadBoard(board))
    expect(round.footprints[0].footprint.locked).toBe(true)
    expect(round.footprints[0].layer).toBe('B.Cu')
  })

  test('board gr_line picks up stroke color from the footprint parser', () => {
    const src = `(kicad_pcb (version 20240108) (generator "x")
  (gr_line (start 0 0) (end 1 0) (stroke (width 0.1) (type solid) (color 9 8 7 1)) (layer "Edge.Cuts")))`
    const board = parseKicadBoard(src)
    expect(board.grLines[0].strokeColor).toEqual({ r: 9, g: 8, b: 7, a: 1 })
  })

  test('locked is read on every kind the selection filter can exclude', () => {
    const src = `(kicad_pcb (version 20240108) (generator "x")
  (segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net 1) (uuid "a") (locked yes))
  (segment (start 0 1) (end 1 1) (width 0.2) (layer "F.Cu") (net 1) (uuid "b"))
  (arc (start 0 0) (mid 1 1) (end 2 0) (width 0.2) (layer "F.Cu") (net 1) (locked yes))
  (via (at 3 3) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (locked yes))
  (zone (net 1) (layer "F.Cu") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))) (locked yes))
  (gr_text "hi" (at 0 0) (layer "F.SilkS") (locked yes))
  (gr_line (start 0 0) (end 1 0) (layer "Edge.Cuts") (locked yes)))`
    const board = parseKicadBoard(src)
    expect(board.segments[0].locked).toBe(true)
    expect(board.trackArcs[0].locked).toBe(true)
    expect(board.vias[0].locked).toBe(true)
    expect(board.zones[0].locked).toBe(true)
    expect(board.grTexts[0].locked).toBe(true)
    expect(board.grLines[0].locked).toBe(true)
    // The second segment is the canonical shape the packed scanner accepts;
    // `locked` must survive that fast path as a definite false.
    expect(board.segments[1].locked).toBe(false)
  })
})

describe('via tenting', () => {
  // `yes` means tented — the mask closes over the via — and a per-via node
  // overrides the board's `(setup (tenting …))` one side at a time. Probed
  // against KiCad 10 by plotting F.Mask/B.Mask; see `viaMaskIsOpen`.
  const src = `(kicad_pcb (version 20240108) (generator "x")
  (setup (pad_to_mask_clearance 0.1) (tenting (front yes) (back no)))
  (via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu"))
  (via (at 2 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (tenting (front no) (back yes))))`

  test('reads the board default and the per-via override', () => {
    const board = parseKicadBoard(src)
    expect(board.tenting).toEqual({ front: true, back: false })
    expect(board.vias[0].tenting).toBeUndefined()
    expect(board.vias[1].tenting).toEqual({ front: false, back: true })
    expect(board.padToMaskClearance).toBe(mm(0.1))
  })

  test('resolves per side, via over board over KiCad default', () => {
    const board = parseKicadBoard(src)
    const [inherited, overridden] = board.vias
    expect(viaMaskIsOpen(inherited, 'front', board.tenting)).toBe(false)
    expect(viaMaskIsOpen(inherited, 'back', board.tenting)).toBe(true)
    expect(viaMaskIsOpen(overridden, 'front', board.tenting)).toBe(true)
    expect(viaMaskIsOpen(overridden, 'back', board.tenting)).toBe(false)
  })

  test('tents both sides when nothing says otherwise', () => {
    const bare = parseKicadBoard(
      `(kicad_pcb (version 20240108) (generator "x")
  (via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu")))`
    )
    expect(bare.tenting).toBeUndefined()
    expect(bare.padToMaskClearance).toBe(0)
    expect(viaMaskIsOpen(bare.vias[0], 'front', bare.tenting)).toBe(false)
    expect(viaMaskIsOpen(bare.vias[0], 'back', bare.tenting)).toBe(false)
  })

  test('a one-sided node leaves the other side inheriting', () => {
    const board = parseKicadBoard(
      src.replace('(tenting (front no) (back yes))', '(tenting (back yes))')
    )
    const via = board.vias[1]
    expect(via.tenting).toEqual({ front: undefined, back: true })
    // Front falls through to the board's `front yes`.
    expect(viaMaskIsOpen(via, 'front', board.tenting)).toBe(false)
    expect(viaMaskIsOpen(via, 'back', board.tenting)).toBe(false)
  })
})

describe('board graphics authoring (gr_* add mutators)', () => {
  test('added graphics reparse with the fields they were built from', () => {
    const board = parseKicadBoard(boardSource)
    addGrLineToBoardAST(board, {
      start: { x: mm(100), y: mm(100) },
      end: { x: mm(150), y: mm(100) },
      width: mm(0.05),
      layer: 'Edge.Cuts'
    })
    addGrArcToBoardAST(board, {
      start: { x: mm(0), y: mm(0) },
      mid: { x: mm(5), y: mm(5) },
      end: { x: mm(10), y: mm(0) },
      width: mm(0.1),
      layer: 'F.SilkS'
    })
    addGrCircleToBoardAST(board, {
      center: { x: mm(5), y: mm(5) },
      end: { x: mm(8), y: mm(5) },
      width: mm(0.12),
      layer: 'B.SilkS'
    })
    addGrRectToBoardAST(board, {
      start: { x: mm(1), y: mm(1) },
      end: { x: mm(9), y: mm(6) },
      width: mm(0.1),
      layer: 'Cmts.User',
      fill: 'solid'
    })
    addGrPolyToBoardAST(board, {
      points: [
        { x: mm(0), y: mm(0) },
        { x: mm(4), y: mm(0) },
        { x: mm(2), y: mm(3) }
      ],
      width: mm(0.1),
      layer: 'F.SilkS'
    })
    addGrTextToBoardAST(board, {
      text: 'Text',
      position: { x: mm(3), y: mm(4), angle: 90 },
      layer: 'F.SilkS',
      size: mm(1),
      thickness: mm(0.1)
    })

    const round = parseKicadBoard(serializeKicadBoard(board))
    const line = round.grLines[round.grLines.length - 1]
    expect(line.start).toEqual({ x: mm(100), y: mm(100) })
    expect(line.end).toEqual({ x: mm(150), y: mm(100) })
    expect(line.strokeWidth).toBe(mm(0.05))
    expect(line.layer).toBe('Edge.Cuts')
    expect(line.uuid).toBeTruthy()

    const arc = round.grArcs[round.grArcs.length - 1]
    expect(arc.mid).toEqual({ x: mm(5), y: mm(5) })
    expect(arc.layer).toBe('F.SilkS')

    const circle = round.grCircles[round.grCircles.length - 1]
    expect(circle.center).toEqual({ x: mm(5), y: mm(5) })
    expect(circle.end).toEqual({ x: mm(8), y: mm(5) })
    expect(circle.fill).toBe('none')

    const rect = round.grRects[round.grRects.length - 1]
    expect(rect.start).toEqual({ x: mm(1), y: mm(1) })
    expect(rect.fill).toBe('solid')

    const poly = round.grPolys[round.grPolys.length - 1]
    expect(poly.points).toHaveLength(3)
    expect(poly.layer).toBe('F.SilkS')

    const text = round.grTexts[round.grTexts.length - 1]
    expect(text.text).toBe('Text')
    expect(text.position).toEqual({ x: mm(3), y: mm(4), angle: 90 })
    expect(text.fontEffects?.thickness).toBe(mm(0.1))
  })

  test('returned index addresses the item after remap', () => {
    const board = parseKicadBoard(boardSource)
    const index = addGrLineToBoardAST(board, {
      start: { x: mm(0), y: mm(0) },
      end: { x: mm(1), y: mm(0) },
      width: mm(0.05),
      layer: 'Edge.Cuts'
    })
    const remapped = remapKicadBoard(board)
    expect(remapped.grLines[index]?.start).toEqual({ x: mm(0), y: mm(0) })
  })

  test('zones author, edit and round-trip through KiCad grammar', () => {
    const board = parseKicadBoard(boardSource)
    const index = addZoneToBoardAST(board, {
      points: [
        { x: mm(0), y: mm(0) },
        { x: mm(20), y: mm(0) },
        { x: mm(20), y: mm(15) },
        { x: mm(0), y: mm(15) }
      ],
      layers: ['F.Cu'],
      net: 1,
      netName: 'GND'
    })

    let round = parseKicadBoard(serializeKicadBoard(board))
    const fresh = round.zones[index]
    expect(fresh.net).toBe(1)
    expect(fresh.netName).toBe('GND')
    expect(fresh.layers).toEqual(['F.Cu'])
    expect(fresh.points).toHaveLength(4)
    expect(fresh.hatchStyle).toBe('edge')
    expect(fresh.minThickness).toBe(mm(0.25))
    expect(fresh.padConnection).toBe('thermal') // unmarked connect_pads
    expect(fresh.padClearance).toBe(mm(0.5))
    expect(fresh.thermalGap).toBe(mm(0.5))
    expect(fresh.thermalBridgeWidth).toBe(mm(0.5))
    expect(fresh.isKeepout).toBe(false)

    // The domain array picks the new zone up on remap; the AST is shared.
    const zone = remapKicadBoard(board).zones[index]
    updateBoardZoneInAST(zone, {
      net: { number: 0, name: '' },
      layers: ['F.Cu', 'B.Cu'],
      priority: 3,
      minThickness: mm(0.3),
      padConnection: 'thru_hole_only',
      padClearance: mm(0.6),
      thermalGap: mm(0.7),
      thermalBridgeWidth: mm(0.8),
      islandRemovalMode: 1
    })
    round = parseKicadBoard(serializeKicadBoard(board))
    const edited = round.zones[index]
    expect(edited.net).toBe(0)
    expect(edited.layers).toEqual(['F.Cu', 'B.Cu'])
    expect(edited.priority).toBe(3)
    expect(edited.minThickness).toBe(mm(0.3))
    expect(edited.padConnection).toBe('thru_hole_only')
    expect(edited.padClearance).toBe(mm(0.6))
    expect(edited.thermalGap).toBe(mm(0.7))
    expect(edited.thermalBridgeWidth).toBe(mm(0.8))
    expect(edited.islandRemovalMode).toBe(1)

    // Marker swap back to solid, priority removal back to implicit 0.
    updateBoardZoneInAST(zone, { padConnection: 'solid', priority: null, islandRemovalMode: null })
    round = parseKicadBoard(serializeKicadBoard(board))
    expect(round.zones[index].padConnection).toBe('solid')
    expect(round.zones[index].priority).toBeUndefined()
    expect(round.zones[index].islandRemovalMode).toBeUndefined()
  })

  test('keepout zones carry rule flags and toggle back to copper', () => {
    const board = parseKicadBoard(boardSource)
    const index = addZoneToBoardAST(board, {
      points: [
        { x: mm(0), y: mm(0) },
        { x: mm(5), y: mm(0) },
        { x: mm(5), y: mm(5) }
      ],
      layers: ['F.Cu', 'B.Cu'],
      net: 0,
      netName: '',
      keepout: true
    })
    let round = parseKicadBoard(serializeKicadBoard(board))
    expect(round.zones[index].isKeepout).toBe(true)
    expect(round.zones[index].keepoutRules).toEqual({
      tracks: false,
      vias: false,
      pads: true,
      copperpour: false,
      footprints: true
    })

    const zone = remapKicadBoard(board).zones[index]
    updateBoardZoneInAST(zone, { keepoutRules: { vias: true, pads: false } })
    round = parseKicadBoard(serializeKicadBoard(board))
    expect(round.zones[index].keepoutRules?.vias).toBe(true)
    expect(round.zones[index].keepoutRules?.pads).toBe(false)

    updateBoardZoneInAST(zone, { keepout: false })
    round = parseKicadBoard(serializeKicadBoard(board))
    expect(round.zones[index].isKeepout).toBe(false)
    expect(round.zones[index].keepoutRules).toBeUndefined()
  })

  test('outline rewrite leaves stored fills in place (stale, like KiCad)', () => {
    const board = parseKicadBoard(boardSource)
    const zone = board.zones[0]
    const fillsBefore = zone.filledPolys.length
    setBoardZoneOutlineInAST(zone, [
      { x: mm(2), y: mm(2) },
      { x: mm(12), y: mm(2) },
      { x: mm(7), y: mm(9) }
    ])
    const round = parseKicadBoard(serializeKicadBoard(board))
    expect(round.zones[0].points).toEqual([
      { x: mm(2), y: mm(2) },
      { x: mm(12), y: mm(2) },
      { x: mm(7), y: mm(9) }
    ])
    expect(round.zones[0].filledPolys).toHaveLength(fillsBefore)
  })

  test('fresh graphics carry the v7+ stroke grammar, not the legacy width', () => {
    const board = parseKicadBoard(boardSource)
    addGrLineToBoardAST(board, {
      start: { x: mm(0), y: mm(0) },
      end: { x: mm(1), y: mm(0) },
      width: mm(0.05),
      layer: 'Edge.Cuts'
    })
    const text = serializeKicadBoard(board)
    // A list holding sub-lists breaks, one child per line — KiCad's own shape.
    expect(text).toContain('(stroke\n\t\t\t(width 0.05)\n\t\t\t(type default)\n\t\t)')
  })
})

describe('KiCad 10 name-referenced nets', () => {
  // v10 dropped the top-level net table; items carry (net "NAME") and the
  // domain synthesizes numbers (board.ts net resolver).
  const v10Board = `(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (layers
    (0 "F.Cu" signal)
    (2 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (footprint "Test:FP" (layer "F.Cu") (uuid "fp-1") (at 10 10)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "GND") (pintype "passive"))
    (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (net "/USB/USB_D+") (pintype "passive"))
  )
  (segment (start 10 10) (end 20 10) (width 0.25) (layer "F.Cu") (net "GND") (uuid "s1"))
  (via (at 20 10) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid "v1"))
  (zone (net "GND") (layer "F.Cu") (uuid "z1") (hatch edge 0.5)
    (polygon (pts (xy 0 0) (xy 30 0) (xy 30 30) (xy 0 30)))
  )
)`

  test('names synthesize one table entry each, shared across item kinds', () => {
    const board = parseKicadBoard(v10Board)
    expect(board.netRefStyle).toBe('name')
    const gnd = board.nets.find((n) => n.name === 'GND')!
    const usb = board.nets.find((n) => n.name === '/USB/USB_D+')!
    expect(gnd.number).toBeGreaterThan(0)
    expect(usb.number).toBeGreaterThan(0)
    expect(gnd.number).not.toBe(usb.number)

    expect(board.footprints[0].footprint.pads[0].net?.number).toBe(gnd.number)
    expect(board.footprints[0].footprint.pads[1].net?.number).toBe(usb.number)
    expect(board.segments[0].net).toBe(gnd.number)
    expect(board.vias[0].net).toBe(gnd.number)
    expect(board.zones[0].net).toBe(gnd.number)
    expect(board.zones[0].netName).toBe('GND')
    expect(getNetName(board, gnd.number)).toBe('GND')
  })

  test('numbers survive a remap unchanged (held net refs must not re-point)', () => {
    const board = parseKicadBoard(v10Board)
    const gndBefore = board.nets.find((n) => n.name === 'GND')!.number
    const usbBefore = board.nets.find((n) => n.name === '/USB/USB_D+')!.number
    const remapped = remapKicadBoard(board)
    expect(remapped.netRefStyle).toBe('name')
    expect(remapped.nets.find((n) => n.name === 'GND')!.number).toBe(gndBefore)
    expect(remapped.nets.find((n) => n.name === '/USB/USB_D+')!.number).toBe(usbBefore)
  })

  test('add mutators write the name dialect, and it round-trips', () => {
    const board = parseKicadBoard(v10Board)
    const gnd = board.nets.find((n) => n.name === 'GND')!.number
    addSegmentToBoardAST(board, {
      start: { x: mm(20), y: mm(10) },
      end: { x: mm(25), y: mm(10) },
      width: mm(0.25),
      layer: 'B.Cu',
      net: gnd
    })
    addViaToBoardAST(board, {
      position: { x: mm(25), y: mm(10) },
      size: mm(0.8),
      drill: mm(0.4),
      layers: ['F.Cu', 'B.Cu'],
      net: gnd
    })
    const text = serializeKicadBoard(board)
    expect(text).toContain('(net "GND")')
    expect(text).not.toMatch(/\(net \d+\)/)

    const reparsed = parseKicadBoard(text)
    expect(reparsed.segments).toHaveLength(2)
    expect(reparsed.segments[1].net).toBe(reparsed.nets.find((n) => n.name === 'GND')!.number)
  })

  test('zone add writes (net "name") with no net_name row on v10 boards', () => {
    const board = parseKicadBoard(v10Board)
    const gnd = board.nets.find((n) => n.name === 'GND')!.number
    addZoneToBoardAST(board, {
      points: [
        { x: mm(0), y: mm(0) },
        { x: mm(5), y: mm(0) },
        { x: mm(5), y: mm(5) }
      ],
      layers: ['F.Cu'],
      net: gnd,
      netName: 'GND'
    })
    const text = serializeKicadBoard(board)
    const zoneText = text.slice(text.lastIndexOf('(zone'))
    expect(zoneText).toContain('(net "GND")')
    expect(zoneText).not.toContain('net_name')
  })

  test('update mutators write the name dialect when given the board', () => {
    const board = parseKicadBoard(v10Board)
    const usb = board.nets.find((n) => n.name === '/USB/USB_D+')!.number
    updateSegmentInAST(board.segments[0], { net: usb }, board)
    updateViaInAST(board.vias[0], { net: usb }, board)
    const text = serializeKicadBoard(board)
    expect(text.match(/\(net "\/USB\/USB_D\+"\)/g)!.length).toBeGreaterThanOrEqual(3)
    const reparsed = parseKicadBoard(text)
    expect(reparsed.segments[0].net).toBe(reparsed.vias[0].net)
  })

  test('numeric-table boards keep the numeric dialect', () => {
    const v8 = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "")
  (net 1 "GND")
)`
    const board = parseKicadBoard(v8)
    expect(board.netRefStyle).toBe('number')
    addSegmentToBoardAST(board, {
      start: { x: mm(0), y: mm(0) },
      end: { x: mm(5), y: mm(0) },
      width: mm(0.25),
      layer: 'F.Cu',
      net: 1
    })
    expect(serializeKicadBoard(board)).toContain('(net 1)')
  })
})

describe('netDisplayNames (KiCad RebuildDisplayNetnames)', () => {
  const names = (list: string[]): Map<number, string> =>
    netDisplayNames(list.map((name, i) => ({ number: i + 1, name })))

  test('hierarchical nets show their short name', () => {
    const m = names(['/USB/CC2', '/BMV_IRQ1', 'GND'])
    expect(m.get(1)).toBe('CC2')
    expect(m.get(2)).toBe('BMV_IRQ1')
    expect(m.get(3)).toBe('GND')
  })

  test('a short-name collision shows the minimal distinguishing suffix', () => {
    const m = names(['/usb/SIG', '/dp/SIG'])
    expect(m.get(1)).toBe('usb/SIG')
    expect(m.get(2)).toBe('dp/SIG')
  })

  test('a root-level collision falls back to the full names', () => {
    // 'GND' vs '/sub/GND': the very first path part differs, so neither can
    // shorten (KiCad: firstNonCommon = 0 keeps the full name).
    const m = names(['GND', '/sub/GND'])
    expect(m.get(1)).toBe('GND')
    expect(m.get(2)).toBe('/sub/GND')
  })

  test('deep collisions cut at the first differing part, not the last', () => {
    const m = names(['/a/x/SIG', '/b/x/SIG'])
    expect(m.get(1)).toBe('a/x/SIG')
    expect(m.get(2)).toBe('b/x/SIG')
  })

  test('a name shows as its letters: markup dropped, escapes unescaped', () => {
    // Jetson's M.2 lane, and an escaped slash that is not a hierarchy step.
    const m = names(['/M.2/PCIe_{C1x1}.TX0+', '/~{RST}', '/pwr/V{slash}2'])
    expect(m.get(1)).toBe('PCIeC1x1.TX0+')
    expect(m.get(2)).toBe('RST')
    expect(m.get(3)).toBe('V/2')
  })

  test('collisions are found on the raw names, then shown plain', () => {
    const m = names(['/a/D_{P}', '/b/D_{P}'])
    expect(m.get(1)).toBe('a/DP')
    expect(m.get(2)).toBe('b/DP')
  })
})

// A full multi-layer board routed and poured in KiCad — the round-trip canary
// for the whole parse/serialize stack, packed records included. Every other
// round-trip test in this suite runs over small inline sources already in the
// serializer's own canonical form; this one proves the invariants over a real
// KiCad-authored file at real density. The serializer canonicalizes
// WHITESPACE by contract (sexpr.ts: "whitespace may differ"), so the
// invariant against the raw file is token identity — every atom and paren,
// in order, byte-for-byte — and byte identity holds over the canonical form.
// Sibling fixture may be absent in isolated checkouts.
import { readFileSync } from 'node:fs'
import { sexprTokens } from './sexprTokens'
import { CANARY_BOARD } from '../../__tests__/canaryFixture'

const CANARY = CANARY_BOARD

describe('canary board round-trip', () => {
  const materializeAll = (node: SExprNode): void => {
    if (node.type !== 'list') return
    for (const child of node.children) materializeAll(child)
  }

  test('parse → serialize preserves every token of the KiCad-authored file', () => {
    const source = readFileSync(CANARY, 'utf8')
    const out = serializeKicadBoard(parseKicadBoard(source))
    expect(sexprTokens(out)).toStrictEqual(sexprTokens(source))
  })

  test('canonical form is a byte-identical fixpoint, remap and materialization included', () => {
    const source = readFileSync(CANARY, 'utf8')
    const canonical = serializeKicadBoard(parseKicadBoard(source))

    const reparsed = parseKicadBoard(canonical)
    expect(serializeKicadBoard(reparsed)).toBe(canonical)

    expect(serializeKicadBoard(remapKicadBoard(reparsed))).toBe(canonical)

    const materialized = parseKicadBoard(canonical)
    materializeAll(materialized._raw)
    expect(serializeKicadBoard(materialized)).toBe(canonical)
  })
})
