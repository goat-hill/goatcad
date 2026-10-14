import { describe, expect, test } from 'vitest'
import {
  addSegmentToBoardAST,
  parseKicadBoard,
  remapKicadBoard,
  moveBoardFootprintInAST,
  removeBoardNodeFromAST
} from '../../kicad/board'
import { BoardSpatialIndex } from '../spatialIndex'
import { beginNodeCapture, endNodeCapture, type SExprList, type SExprNode } from '../../kicad/sexpr'
import { nm } from '../../kicad/coordinates'

const src = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
  )
  (net 0 "")
  (net 1 "GND")
  (footprint "Test:R"
    (layer "F.Cu")
    (uuid "fp-r")
    (at 5 5 45)
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "GND"))
    (pad "2" thru_hole circle (at 1 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu") (net 1 "GND"))
  )
  (segment (start 2 2) (end 6 2) (width 0.3) (layer "F.Cu") (net 1) (uuid "s0"))
  (segment (start 6 2) (end 9 2) (width 0.3) (layer "F.Cu") (net 1) (uuid "s1"))
  (arc (start 9 2) (mid 10 3) (end 9 4) (width 0.3) (layer "F.Cu") (net 1) (uuid "a0"))
  (via (at 9 2) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v0"))
)`

/** Mutate like runCommand and return the change set + pre-command arrays. */
const edit = (
  board: ReturnType<typeof parseKicadBoard>,
  mutate: () => void
): {
  raws: Set<SExprNode>
  prev: Parameters<typeof BoardSpatialIndex.buildFrom>[1]
  next: ReturnType<typeof parseKicadBoard>
} => {
  const root = board._raw as SExprList
  const childrenBefore = root.children.slice()
  const prev = {
    segments: board.segments.slice(),
    trackArcs: board.trackArcs.slice(),
    vias: board.vias.slice(),
    footprints: board.footprints.slice()
  }
  beginNodeCapture()
  mutate()
  const clones = endNodeCapture()
  const next = remapKicadBoard(board)
  const beforeSet = new Set(childrenBefore)
  const afterSet = new Set(root.children)
  const raws = new Set<SExprNode>()
  for (const n of root.children) if (!beforeSet.has(n)) raws.add(n)
  for (const n of childrenBefore) if (!afterSet.has(n)) raws.add(n)
  for (const n of clones.keys()) raws.add(n)
  return { raws, prev, next }
}

describe('BoardSpatialIndex.buildFrom', () => {
  test('a splice matches a full build, sharing unchanged shapes', () => {
    const board = parseKicadBoard(src)
    const before = BoardSpatialIndex.build(board)
    const { raws, prev, next } = edit(board, () => {
      removeBoardNodeFromAST(board, board.segments[0]._raw)
      addSegmentToBoardAST(board, {
        start: { x: nm(2_000_000), y: nm(2_000_000) },
        end: { x: nm(3_000_000), y: nm(5_000_000) },
        width: nm(300_000),
        layer: 'F.Cu',
        net: 1
      })
    })
    const incremental = BoardSpatialIndex.buildFrom(before, prev, next, raws)
    const full = BoardSpatialIndex.build(next)
    expect(incremental.items).toEqual(full.items)
    // The unchanged segment's shape is the previous extraction, by reference.
    const oldS1 = before.items.find(
      (it) => it.ref.type === 'segment' && prev.segments[it.ref.index] === next.segments[0]
    )!
    const newS1 = incremental.items.find((it) => it.ref.type === 'segment' && it.ref.index === 0)!
    expect(newS1.shape).toBe(oldS1.shape)
  })

  test('a mutated-in-place footprint re-extracts (identity is not the reuse key)', () => {
    const board = parseKicadBoard(src)
    const before = BoardSpatialIndex.build(board)
    const { raws, prev, next } = edit(board, () => {
      const fp = board.footprints[0]
      moveBoardFootprintInAST(fp, nm(fp.position.x + 1_000_000), fp.position.y)
    })
    const incremental = BoardSpatialIndex.buildFrom(before, prev, next, raws)
    expect(incremental.items).toEqual(BoardSpatialIndex.build(next).items)
  })
})
