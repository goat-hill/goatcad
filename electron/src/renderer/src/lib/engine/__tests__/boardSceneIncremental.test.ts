import { beforeAll, describe, expect, test, vi } from 'vitest'
import * as THREE from 'three'
import { BoardScene, type BoardEditDelta } from '../BoardScene'
import {
  addSegmentToBoardAST,
  addViaToBoardAST,
  moveBoardFootprintInAST,
  parseKicadBoard,
  remapKicadBoard,
  removeBoardNodeFromAST,
  setZoneFilledPolysInAST,
  updateGrTextInAST,
  type KicadBoard
} from '../../kicad/board'
import { beginNodeCapture, endNodeCapture, type SExprList, type SExprNode } from '../../kicad/sexpr'
import { nm, type Nm } from '../../kicad/coordinates'
import { flipBoardFootprintInAST } from '../../board/footprintFlip'

const boardSource = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (net 0 "")
  (net 1 "GND")
  (net 2 "VCC")
  (gr_rect (start 0 0) (end 20 10) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") (uuid "edge"))
  (gr_text "note" (at 3 9 0) (layer "F.Cu") (uuid "note") (effects (font (size 1 1) (thickness 0.15))))
  (footprint "Test:R"
    (layer "F.Cu")
    (uuid "fp-r")
    (at 5 5)
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "GND"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 2 "VCC"))
  )
  (segment (start 2 2) (end 6 2) (width 0.3) (layer "F.Cu") (net 1) (uuid "s0"))
  (segment (start 6 2) (end 9 2) (width 0.3) (layer "F.Cu") (net 1) (uuid "s1"))
  (segment (start 12 8) (end 15 8) (width 0.3) (layer "B.Cu") (net 2) (uuid "s2"))
  (via (at 9 2) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v0"))
  (zone
    (net 1)
    (net_name "GND")
    (layer "F.Cu")
    (uuid "z0")
    (hatch edge 0.5)
    (min_thickness 0.25)
    (fill yes)
    (polygon (pts (xy 10 0) (xy 20 0) (xy 20 6) (xy 10 6)))
    (filled_polygon (layer "F.Cu") (pts (xy 10.2 0.2) (xy 19.8 0.2) (xy 19.8 5.8) (xy 10.2 5.8)))
  )
)`

// BoardScene rasterizes label glyphs against a DOM canvas; this environment
// has none. A deterministic stub is enough for equivalence: both the patched
// and the freshly rebuilt scene see identical (blank) glyph metrics.
beforeAll(() => {
  const fakeCtx = {
    font: '',
    textAlign: '',
    textBaseline: '',
    fillStyle: '',
    measureText: (s: string) => ({ width: s.length * 20 + 8 }),
    fillText: (): void => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4)
    })
  }
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx })
  })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
})

const buildScene = (board: KicadBoard): BoardScene => {
  const scene = new BoardScene(new THREE.Scene())
  scene.rebuild(board)
  return scene
}

/** Run a mutation the way runCommand does and capture its delta. */
const runEdit = (
  board: KicadBoard,
  mutate: () => void
): { delta: BoardEditDelta; next: KicadBoard } => {
  const root = board._raw as SExprList
  const childrenBefore = root.children.slice()
  const prev = {
    segments: board.segments.slice(),
    trackArcs: board.trackArcs.slice(),
    vias: board.vias.slice(),
    footprints: board.footprints.slice(),
    zones: board.zones.slice()
  }
  beginNodeCapture()
  mutate()
  const mutatedClones = endNodeCapture()
  const next = remapKicadBoard(board)
  const beforeSet = new Set(childrenBefore)
  const afterSet = new Set(root.children)
  const raws = new Set<SExprNode>()
  for (const n of root.children) if (!beforeSet.has(n)) raws.add(n)
  for (const n of childrenBefore) if (!afterSet.has(n)) raws.add(n)
  for (const n of mutatedClones.keys()) raws.add(n)
  return { delta: { id: 1, fromBoard: board, raws, prev }, next }
}

const expectEquivalent = (patched: BoardScene, next: KicadBoard): void => {
  const fresh = buildScene(next)
  const a = patched.debugSnapshot()
  const b = fresh.debugSnapshot()
  expect(a.anchors).toEqual(b.anchors)
  expect(a.batch).toEqual(b.batch)
  expect(a.labels).toEqual(b.labels)
  expect(a.trackLabels).toEqual(b.trackLabels)
  // Board batches write no depth: paint order is the stacking, and must be a rebuild's.
  expect(patched.debugDrawOrder()).toEqual(fresh.debugDrawOrder())
}

describe('BoardScene.applyBoardEdit', () => {
  test('a track-drag-shaped splice (remove + append segments) matches a fresh rebuild', () => {
    const board = parseKicadBoard(boardSource)
    const scene = buildScene(board)
    const { delta, next } = runEdit(board, () => {
      removeBoardNodeFromAST(board, board.segments[0]._raw)
      addSegmentToBoardAST(board, {
        start: { x: nm(2_000_000), y: nm(2_000_000) },
        end: { x: nm(4_000_000), y: nm(3_000_000) },
        width: nm(300_000),
        layer: 'F.Cu',
        net: 1
      })
      addSegmentToBoardAST(board, {
        start: { x: nm(4_000_000), y: nm(3_000_000) },
        end: { x: nm(6_000_000), y: nm(2_000_000) },
        width: nm(300_000),
        layer: 'F.Cu',
        net: 1
      })
    })
    expect(scene.applyBoardEdit(delta, next)).toBe(true)
    expectEquivalent(scene, next)
  })

  test('a via patched in where one was removed stacks as a rebuild does', () => {
    const board = parseKicadBoard(boardSource)
    const scene = buildScene(board)
    const { delta, next } = runEdit(board, () => {
      removeBoardNodeFromAST(board, board.vias[0]._raw)
      addViaToBoardAST(board, {
        position: { x: nm(15_000_000), y: nm(8_000_000) },
        size: nm(800_000),
        drill: nm(400_000),
        layers: ['F.Cu', 'B.Cu'],
        net: 2
      })
    })
    expect(scene.applyBoardEdit(delta, next)).toBe(true)
    // The bore paints over its plated wall, as in a rebuild, not under it.
    expectEquivalent(scene, next)
  })

  test('an in-place footprint mutation matches a fresh rebuild', () => {
    const board = parseKicadBoard(boardSource)
    const scene = buildScene(board)
    const { delta, next } = runEdit(board, () => {
      const fp = board.footprints[0]
      moveBoardFootprintInAST(fp, nm(fp.position.x + 1_000_000), fp.position.y)
    })
    expect(scene.applyBoardEdit(delta, next)).toBe(true)
    expectEquivalent(scene, next)
  })

  test('moving a footprint that carries a zone matches a fresh rebuild', () => {
    const board = parseKicadBoard(
      boardSource.replace(
        '(pad "1" smd rect (at -1 0)',
        `(zone (net 0) (net_name "") (layers "F.Cu") (uuid "kz") (hatch edge 0.5)
      (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
      (polygon (pts (xy 3 7) (xy 7 7) (xy 7 9) (xy 3 9))))
    (pad "1" smd rect (at -1 0)`
      )
    )
    const scene = buildScene(board)
    const { delta, next } = runEdit(board, () => {
      const fp = board.footprints[0]
      moveBoardFootprintInAST(fp, nm(fp.position.x + 1_000_000), fp.position.y)
    })
    expect(scene.applyBoardEdit(delta, next)).toBe(true)
    expectEquivalent(scene, next)
  })

  test('a footprint flip (its node replaced) matches a fresh rebuild', () => {
    const board = parseKicadBoard(boardSource)
    const scene = buildScene(board)
    const { delta, next } = runEdit(board, () => {
      const fp = board.footprints[0]
      flipBoardFootprintInAST(board, fp, fp.position)
    })
    expect(scene.applyBoardEdit(delta, next)).toBe(true)
    expectEquivalent(scene, next)
  })

  test('a zone fill rewrite (the refill commit) matches a fresh rebuild', () => {
    const board = parseKicadBoard(boardSource)
    const scene = buildScene(board)
    const pts = (coords: Array<[number, number]>): Array<{ x: Nm; y: Nm }> =>
      coords.map(([x, y]) => ({ x: nm(x * 1e6), y: nm(y * 1e6) }))
    const { delta, next } = runEdit(board, () => {
      setZoneFilledPolysInAST(board.zones[0], [
        {
          layer: 'F.Cu',
          points: pts([
            [10.5, 0.5],
            [19.5, 0.5],
            [19.5, 5.5],
            [10.5, 5.5]
          ])
        }
      ])
    })
    expect(scene.applyBoardEdit(delta, next)).toBe(true)
    expectEquivalent(scene, next)
  })

  test('an unattributable change (gr_text edit) falls back', () => {
    const board = parseKicadBoard(boardSource)
    const scene = buildScene(board)
    const { delta, next } = runEdit(board, () => {
      updateGrTextInAST(board.grTexts[0], { text: 'changed' })
    })
    expect(scene.applyBoardEdit(delta, next)).toBe(false)
  })

  test('dimmed and hidden non-active layers are not selectable', () => {
    const board = parseKicadBoard(boardSource)
    const scene = new BoardScene(new THREE.Scene())
    const onB = new THREE.Vector2(13.5, -8) // over the B.Cu segment only

    scene.rebuild(board, undefined, 'F.Cu', { nonActiveDisplay: 'show' })
    expect(scene.hitTest(onB, 0.5)?.type).toBe('segment')

    scene.rebuild(board, undefined, 'F.Cu', { nonActiveDisplay: 'dim' })
    expect(scene.hitTest(onB, 0.5)).toBeNull()

    scene.rebuild(board, undefined, 'F.Cu', { nonActiveDisplay: 'hide' })
    expect(scene.hitTest(onB, 0.5)).toBeNull()

    // The active layer's own copper stays selectable in every mode.
    scene.rebuild(board, undefined, 'B.Cu', { nonActiveDisplay: 'dim' })
    expect(scene.hitTest(onB, 0.5)?.type).toBe('segment')
  })

  test('a delta against a different drawn board falls back', () => {
    const board = parseKicadBoard(boardSource)
    const other = parseKicadBoard(boardSource)
    const scene = buildScene(other)
    const { delta, next } = runEdit(board, () => {
      removeBoardNodeFromAST(board, board.segments[0]._raw)
    })
    expect(scene.applyBoardEdit(delta, next)).toBe(false)
  })
})
