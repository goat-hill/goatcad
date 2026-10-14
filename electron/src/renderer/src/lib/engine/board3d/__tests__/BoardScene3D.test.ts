/**
 * The scene's units contract: the board file counts in nanometers, the 3D
 * world counts in millimeters, and the stackup thickness has to cross that
 * boundary like every other dimension does. It once did not, and a 1.6 mm
 * board became a 1,646,200 mm slab — the camera framed the slab and the
 * viewport rendered blank.
 */
import { readFileSync } from 'node:fs'
import { Box3, Vector3 } from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseKicadBoard } from '../../../kicad/board'
import { loadClipper } from '../../../geometry/clip'
import { defaultBoard3DViewState } from '../../../board3dView'
import { BoardScene3D, DEFAULT_BOARD_THICKNESS_MM } from '../BoardScene3D'
import { CANARY_BOARD } from '../../../__tests__/canaryFixture'

const board = (general: string): string => `
(kicad_pcb (version 20221018) (generator pcbnew)
  ${general}
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (gr_rect (start 0 0) (end 20 10) (layer "Edge.Cuts")
    (stroke (width 0.1) (type solid)) (fill none)))
`

const built = (source: string): BoardScene3D => {
  const scene = new BoardScene3D()
  scene.setBoard(parseKicadBoard(source), defaultBoard3DViewState())
  return scene
}

describe('BoardScene3D thickness', () => {
  beforeAll(async () => {
    await loadClipper()
  })

  it('reads (general (thickness …)) as nanometers and reports millimeters', () => {
    const scene = built(board('(general (thickness 1.6462))'))
    expect(scene.thickness).toBeCloseTo(1.6462, 6)
    expect(scene.getStats().thickness).toBeCloseTo(1.6462, 6)
  })

  it('extrudes the substrate to that thickness, centered on Z = 0', () => {
    const scene = built(board('(general (thickness 1.6462))'))
    const bounds = scene.getBoardBounds()
    expect(bounds.min.z).toBeCloseTo(-1.6462 / 2, 4)
    expect(bounds.max.z).toBeCloseTo(1.6462 / 2, 4)
    // The outline is the 20 × 10 mm rect it was drawn as, not its nm count.
    const size = bounds.getSize(new Vector3())
    expect(size.x).toBeCloseTo(20, 3)
    expect(size.y).toBeCloseTo(10, 3)
  })

  it('falls back to KiCad’s default when the board declares no thickness', () => {
    const scene = built(board('(general)'))
    expect(scene.thickness).toBe(DEFAULT_BOARD_THICKNESS_MM)
  })
})

const FIXTURE = CANARY_BOARD

describe('smoke test — a real KiCad board', () => {
  beforeAll(async () => {
    await loadClipper()
  })

  it('builds a scene the size of a board, not of its unit count', () => {
    const scene = new BoardScene3D()
    scene.setBoard(parseKicadBoard(readFileSync(FIXTURE, 'utf8')), defaultBoard3DViewState())
    const size = new Box3().setFromObject(scene.root).getSize(new Vector3())
    // A hand-sized board: tens of mm across, a couple of mm thick. The nm bug
    // put z in the millions, and every framed camera lost the board with it.
    expect(size.x).toBeGreaterThan(10)
    expect(size.x).toBeLessThan(500)
    expect(size.y).toBeGreaterThan(10)
    expect(size.y).toBeLessThan(500)
    expect(size.z).toBeLessThan(10)
  })
})
