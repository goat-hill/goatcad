import { describe, expect, test } from 'vitest'
import { parseKicadBoard, serializeKicadBoard, setBoardStackupInAST } from '../../kicad/board'
import { applyStackupEdits, planStackupEdits } from '../stackupEdits'
import { stackupSpecOf } from '../boardSetup'

/** A 4-layer board's stackup, read back from its file. */
const fourLayer = (): ReturnType<typeof parseKicadBoard> => {
  const board = parseKicadBoard(`(kicad_pcb (version 20241229) (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 ""))`)
  setBoardStackupInAST(board, { ...stackupSpecOf(board), copperLayers: 4 })
  return parseKicadBoard(serializeKicadBoard(board))
}

const names = (board: ReturnType<typeof parseKicadBoard>): string[] =>
  board.stackup!.layers.map((l) => l.name)

describe('planStackupEdits', () => {
  test("takes only the cells a row has in Board Setup's table", () => {
    const layers = fourLayer().stackup!.layers
    expect(planStackupEdits(layers, { layers: [{ name: 'F.Cu', epsilonR: 4 }] })).toMatchObject({
      ok: false,
      error: 'not-applicable'
    })
    expect(
      planStackupEdits(layers, { layers: [{ name: 'F.Mask', color: 'Purple' }] })
    ).toMatchObject({ ok: true, changed: { edited: ['F.Mask'] } })
    expect(planStackupEdits(layers, { layers: [{ name: 'F.Mask', color: 'Pink' }] })).toMatchObject(
      { ok: false, error: 'invalid-record' }
    )
    expect(planStackupEdits(layers, { layers: [{ name: 'Nope' }] })).toMatchObject({
      ok: false,
      candidates: expect.arrayContaining(['F.Cu'])
    })
  })

  test('a record read can be sent back whole: an unchanged field it has no cell for is no edit', () => {
    const layers = fourLayer().stackup!.layers
    const copper = layers.find((l) => l.name === 'F.Cu')!
    expect(
      planStackupEdits(layers, {
        layers: [{ name: 'F.Cu', type: copper.type, thickness: 0.07 }]
      })
    ).toMatchObject({ ok: true, plan: { edits: [{ name: 'F.Cu', patch: { thickness: 70000 } }] } })
  })

  test('adds a dielectric only below a copper layer, as Board Setup offers it', () => {
    const layers = fourLayer().stackup!.layers
    expect(planStackupEdits(layers, { addDielectric: [{ after: 'F.Mask' }] })).toMatchObject({
      ok: false,
      error: 'invalid-record'
    })
  })

  test('removes only dielectrics', () => {
    const layers = fourLayer().stackup!.layers
    expect(planStackupEdits(layers, { removeLayers: ['In1.Cu'] })).toMatchObject({
      ok: false,
      error: 'not-applicable'
    })
  })
})

describe('applyStackupEdits', () => {
  test('removes and adds by name, renumbering the dielectrics as Board Setup does', () => {
    const board = fourLayer()
    const before = names(board).filter((n) => n.startsWith('dielectric'))
    expect(before).toEqual(['dielectric 1', 'dielectric 2', 'dielectric 3'])
    const planned = planStackupEdits(board.stackup!.layers, {
      removeLayers: ['dielectric 2'],
      addDielectric: [{ after: 'F.Cu', thickness: 0.05, material: 'Rogers' }]
    })
    if (!planned.ok) throw new Error(planned.detail)
    applyStackupEdits(board.stackup!, planned.plan)
    const after = parseKicadBoard(serializeKicadBoard(board))
    const added =
      after.stackup!.layers[after.stackup!.layers.findIndex((l) => l.name === 'F.Cu') + 1]
    expect(added).toMatchObject({ name: 'dielectric 1', material: 'Rogers', thickness: 50000 })
    expect(names(after).filter((n) => n.startsWith('dielectric'))).toHaveLength(3)
  })
})
