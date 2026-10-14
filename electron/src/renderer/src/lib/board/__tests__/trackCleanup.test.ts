import { beforeAll, describe, expect, test } from 'vitest'
import { parseKicadBoard, serializeKicadBoard, type KicadBoard } from '../../kicad/board'
import { DEFAULT_DESIGN_RULES, DEFAULT_NET_CLASSES } from '../../kicad/project'
import { BoardSpatialIndex } from '../spatialIndex'
import { loadClipper } from '../../geometry/clip'
import {
  DEFAULT_CLEANUP_OPTIONS,
  applyTrackCleanup,
  planTrackCleanup,
  type CleanupOptions,
  type CleanupPlan,
  type CleanupScope,
  type TrackRef
} from '../trackCleanup'
import { drainSteps } from '../../geometry/regionClips'

beforeAll(loadClipper)

const HEAD = `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "A") (net 2 "B")`

const pad = (reference: string, x: number, net = 1): string => `
  (footprint "T:R" (layer "F.Cu") (uuid "fp-${reference}") (at ${x} 120)
    (property "Reference" "${reference}" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net ${net} "${net === 1 ? 'A' : 'B'}") (uuid "p-${reference}")))`

const thru = (reference: string, x: number): string => `
  (footprint "T:J" (layer "F.Cu") (uuid "fp-${reference}") (at ${x} 120)
    (property "Reference" "${reference}" (at 0 0) (layer "F.SilkS"))
    (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu") (net 1 "A") (uuid "p-${reference}")))`

const seg = (x0: number, x1: number, uuid: string, net = 1, layer = 'F.Cu', width = 0.25): string =>
  `(segment (start ${x0} 120) (end ${x1} 120) (width ${width}) (layer "${layer}") (net ${net}) (uuid "${uuid}"))`

const via = (x: number, uuid: string, net = 1): string =>
  `(via (at ${x} 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net ${net}) (uuid "${uuid}"))`

const boardOf = (body: string): KicadBoard => parseKicadBoard(`${HEAD}${body}\n)`)

const plan = (
  board: KicadBoard,
  over: Partial<CleanupOptions> = {},
  scope?: CleanupScope,
  seeds?: readonly TrackRef[]
): CleanupPlan =>
  drainSteps(
    planTrackCleanup(
      {
        board,
        index: BoardSpatialIndex.build(board),
        connectivity: null,
        settings: {
          rules: DEFAULT_DESIGN_RULES,
          classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
          patterns: [],
          assignments: []
        }
      },
      { ...DEFAULT_CLEANUP_OPTIONS, ...over },
      scope,
      seeds
    )
  )

/** Each change as its kind and the uuids of what it names. */
const changes = (board: KicadBoard, result: CleanupPlan): Array<[string, string[]]> =>
  result.changes.map((change) => [
    change.kind,
    change.items.map(
      (ref) =>
        (ref.type === 'segment'
          ? board.segments[ref.index]
          : ref.type === 'tarc'
            ? board.trackArcs[ref.index]
            : board.vias[ref.index]
        ).uuid ?? ''
    )
  ])

describe('cleanup tracks and vias', () => {
  test("seeded, it takes a stub and what hangs off it, not the board's other debris", () => {
    const board = boardOf(
      pad('R1', 110) +
        seg(110, 112, 't1') +
        seg(112, 114, 't2', 1, 'F.Cu', 0.5) +
        `(segment (start 110 120) (end 110 125) (width 0.25) (layer "F.Cu") (net 1) (uuid "t3"))`
    )
    const only = { shorts: false, redundantVias: false, mergeTracks: false }
    expect(changes(board, plan(board, only, undefined, [{ type: 'segment', index: 1 }]))).toEqual([
      ['dangling-track', ['t2']],
      ['dangling-track', ['t1']]
    ])
  })

  test('collinear tracks of one width merge into one, through a chain', () => {
    const board = boardOf(
      pad('R1', 110) +
        pad('R2', 116) +
        seg(110, 112, 't1') +
        seg(112, 114, 't2') +
        seg(114, 116, 't3')
    )
    const result = plan(board)
    expect(changes(board, result).map(([kind]) => kind)).toEqual(['merge-tracks', 'merge-tracks'])
    applyTrackCleanup(board, result)
    const after = parseKicadBoard(serializeKicadBoard(board))
    expect(after.segments).toHaveLength(1)
    expect(after.segments[0]).toMatchObject({ uuid: 't1' })
    expect([after.segments[0].start.x, after.segments[0].end.x].sort()).toEqual([110e6, 116e6])
  })

  test('a via, a width change or a tee at the joint keeps tracks apart', () => {
    const viaAt = boardOf(
      pad('R1', 110) + pad('R2', 116) + seg(110, 113, 't1') + seg(113, 116, 't2') + via(113, 'v1')
    )
    expect(plan(viaAt, { danglingVias: false }).changes).toEqual([])
    const widths = boardOf(
      pad('R1', 110) + pad('R2', 116) + seg(110, 113, 't1') + seg(113, 116, 't2', 1, 'F.Cu', 0.5)
    )
    expect(plan(widths).changes).toEqual([])
    const tee = boardOf(
      pad('R1', 110) +
        pad('R2', 116) +
        seg(110, 113, 't1') +
        seg(113, 116, 't2') +
        `(segment (start 113 120) (end 113 125) (width 0.25) (layer "F.Cu") (net 1) (uuid "t3"))` +
        `(footprint "T:R" (layer "F.Cu") (uuid "fp-R3") (at 113 125)
    (property "Reference" "R3" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "p-R3")))`
    )
    expect(plan(tee).changes).toEqual([])
  })

  test('a dangling chain goes piece by piece, and so does the via it ended on', () => {
    const board = boardOf(
      pad('R1', 110) + seg(110, 112, 't1') + seg(112, 114, 't2', 1, 'F.Cu', 0.5) + via(114, 'v1')
    )
    expect(changes(board, plan(board))).toEqual([
      ['dangling-via', ['v1']],
      ['dangling-track', ['t2']],
      ['dangling-track', ['t1']]
    ])
    expect(changes(board, plan(board, { danglingVias: false }))).toEqual([])
  })

  test('a locked track stays, and holds what leads to it', () => {
    const board = boardOf(
      pad('R1', 110) +
        seg(110, 112, 't1', 1, 'F.Cu', 0.5) +
        `(segment (start 112 120) (end 114 120) (width 0.25) (locked yes) (layer "F.Cu") (net 1) (uuid "t2"))`
    )
    expect(plan(board).changes).toEqual([])
  })

  test('a via over another or over a through-hole pad is redundant', () => {
    const board = boardOf(
      thru('J1', 110) +
        pad('R1', 116) +
        via(110, 'v1') +
        via(116, 'v2') +
        via(116, 'v3') +
        seg(110, 116, 't1')
    )
    expect(changes(board, plan(board, { danglingVias: false }))).toEqual([
      ['redundant-via', ['v3']],
      ['redundant-via', ['v1']]
    ])
  })

  test('a track meeting another net goes, both sides of it', () => {
    const board = boardOf(pad('R1', 110) + pad('R2', 116, 2) + seg(110, 116, 't1'))
    expect(changes(board, plan(board, { danglingTracks: false }))).toEqual([
      ['shorting-track', ['t1']]
    ])
    expect(plan(board, { shorts: false, danglingTracks: false }).changes).toEqual([])
  })

  test('duplicates and zero-length tracks go', () => {
    const board = boardOf(
      pad('R1', 110) +
        pad('R2', 116) +
        seg(110, 116, 't1') +
        `(segment (start 116 120) (end 110 120) (width 0.25) (layer "F.Cu") (net 1) (uuid "t2"))` +
        seg(113, 113, 't3')
    )
    expect(changes(board, plan(board))).toEqual([
      ['zero-length-track', ['t3']],
      ['duplicate-track', ['t2']]
    ])
  })

  test('a track inside a pad goes only when asked', () => {
    const board = boardOf(
      `(footprint "T:R" (layer "F.Cu") (uuid "fp-R1") (at 110 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net 1 "A") (uuid "p-R1")))` +
        `(segment (start 109.7 120) (end 110.3 120) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))`
    )
    expect(plan(board).changes).toEqual([])
    expect(changes(board, plan(board, { tracksInPads: true }))).toEqual([['track-in-pad', ['t1']]])
  })

  test('copper out of scope is neither removed nor merged', () => {
    const board = boardOf(pad('R1', 110) + seg(110, 112, 't1') + seg(112, 114, 't2'))
    const onlyFirst: CleanupScope = (ref) => ref.type === 'segment' && ref.index === 0
    expect(changes(board, plan(board, {}, onlyFirst))).toEqual([])
    expect(changes(board, plan(board, { mergeTracks: false }))).toEqual([
      ['dangling-track', ['t2']],
      ['dangling-track', ['t1']]
    ])
  })
})
