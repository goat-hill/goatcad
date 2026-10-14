import { describe, expect, test } from 'vitest'
import {
  parseKicadBoard,
  remapKicadBoard,
  removeBoardNodeFromAST,
  serializeKicadBoard
} from '../../kicad/board'
import { BoardSpatialIndex } from '../spatialIndex'
import { applyNetChanges, netChanges, propagationFor } from '../netPropagation'

const board = (body: string): ReturnType<typeof parseKicadBoard> =>
  parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "A") (net 2 "B") (net 3 "GND")
  (net 4 "unconnected-(J1-Pad1)")${body}
)`)

const pad = (ref: string, x: number, net: string, extra = ''): string => `
  (footprint "T:P" (layer "F.Cu") (uuid "fp-${ref}") (at ${x} 120)
    (property "Reference" "${ref}" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") ${net} ${extra} (uuid "p-${ref}")))`

const track = (x0: number, x1: number, net: number, uuid: string): string =>
  `\n  (segment (start ${x0} 120) (end ${x1} 120) (width 0.25) (layer "F.Cu") (net ${net}) (uuid "${uuid}"))`

/** The nets every track and via would take, seeded from all of the board's copper. */
const propagate = (body: string): Array<[string, number]> => {
  const b = board(body)
  const index = BoardSpatialIndex.build(b)
  const changes = netChanges(
    b,
    index,
    index.items.map((item) => item.id)
  )
  return changes.map(({ ref, net }) => {
    const item =
      ref.type === 'segment'
        ? b.segments[ref.index]
        : ref.type === 'tarc'
          ? b.trackArcs[ref.index]
          : b.vias[ref.index]
    return [item.uuid ?? '', net]
  })
}

describe('net propagation', () => {
  test('copper takes the net of the pads it reaches, whatever net it had', () => {
    expect(propagate(pad('R1', 110, '(net 1 "A")') + track(110, 115, 0, 't1'))).toEqual([['t1', 1]])
    expect(
      propagate(pad('R1', 110, '(net 1 "A")') + track(110, 115, 2, 't1') + track(115, 118, 0, 't2'))
    ).toEqual([
      ['t1', 1],
      ['t2', 1]
    ])
  })

  test('pads of two nets leave the cluster as it is', () => {
    expect(
      propagate(
        pad('R1', 110, '(net 1 "A")') + pad('R2', 115, '(net 2 "B")') + track(110, 115, 0, 't1')
      )
    ).toEqual([])
  })

  test('with no pads, the one net its copper agrees on; with two, nothing', () => {
    expect(propagate(track(110, 115, 3, 't1') + track(115, 118, 0, 't2'))).toEqual([['t2', 3]])
    expect(propagate(track(110, 115, 1, 't1') + track(115, 118, 2, 't2'))).toEqual([])
  })

  test('a free pad does not set the net when a real pad does', () => {
    const free = pad('J1', 115, '(net 4 "unconnected-(J1-Pad1)")', '(pintype "free")')
    expect(propagate(pad('R1', 110, '(net 1 "A")') + free + track(110, 115, 0, 't1'))).toEqual([
      ['t1', 1]
    ])
  })

  test('a free via keeps its net', () => {
    expect(
      propagate(
        pad('R1', 110, '(net 1 "A")') +
          track(110, 115, 1, 't1') +
          `\n  (via (at 115 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (free yes) (net 2) (uuid "v1"))`
      )
    ).toEqual([])
  })

  test('a via joined only to fills takes their net, keeping its own if a fill has it', () => {
    const pour = (net: number, name: string): string => `
  (zone (net ${net}) (net_name "${name}") (layer "F.Cu") (uuid "z${net}") (hatch edge 0.5)
    (polygon (pts (xy 101 101) (xy 139 101) (xy 139 139) (xy 101 139)))
    (filled_polygon (layer "F.Cu") (pts (xy 101 101) (xy 139 101) (xy 139 139) (xy 101 139))))`
    const via = (net: number): string =>
      `\n  (via (at 120 130) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net ${net}) (uuid "v1"))`
    expect(propagate(pour(3, 'GND') + via(0))).toEqual([['v1', 3]])
    expect(propagate(pour(3, 'GND') + via(3))).toEqual([])
    expect(propagate(via(0))).toEqual([])
    // A pour of no net gives none: the via keeps its own.
    expect(propagate(pour(0, '') + via(2))).toEqual([])
  })

  test('the changes write the net into the file', () => {
    const b = board(pad('R1', 110, '(net 1 "A")') + track(110, 115, 0, 't1'))
    const index = BoardSpatialIndex.build(b)
    applyNetChanges(b, netChanges(b, index, [0]))
    expect(b.segments[0].net).toBe(1)
    expect(serializeKicadBoard(b)).toMatch(/\(end 115 120\)[\s\S]*?\(net 1\)/)
  })

  test('an edit reaches the clusters where its copper was as well as where it is', () => {
    const b = board(
      pad('R1', 110, '(net 1 "A")') +
        pad('R2', 120, '(net 2 "B")') +
        track(110, 115, 1, 't1') +
        track(115, 120, 2, 't2')
    )
    const index = BoardSpatialIndex.build(b)
    const arrays = {
      segments: b.segments.slice(),
      trackArcs: b.trackArcs.slice(),
      vias: b.vias.slice(),
      footprints: b.footprints.slice()
    }
    const r2 = b.footprints[1]._raw
    removeBoardNodeFromAST(b, r2)
    const after = remapKicadBoard(b)
    const raws = new Set([r2])
    const changes = propagationFor(after, raws, () => BoardSpatialIndex.build(after), {
      index,
      arrays
    })
    expect(changes).toEqual([{ ref: { type: 'segment', index: 1 }, net: 1 }])
    // Without where it was, nothing it added or changed is left to reach.
    expect(propagationFor(after, raws, () => BoardSpatialIndex.build(after))).toEqual([])
  })
})
