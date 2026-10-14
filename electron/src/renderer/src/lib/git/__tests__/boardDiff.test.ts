import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { diffBoards, withRemovedBoardItems } from '../boardDiff'

const fp = (uuid: string, reference: string, x: number, value = '10k', padNet = 'GND'): string =>
  `(footprint "Resistor_SMD:R_0603" (layer "F.Cu") (uuid "${uuid}") (at ${x} 10 0)
    (property "Reference" "${reference}" (at 0 -1.5 0) (layer "F.SilkS") (uuid "${uuid}-r"))
    (property "Value" "${value}" (at 0 1.5 0) (layer "F.Fab") (uuid "${uuid}-v"))
    (pad "1" smd roundrect (at -0.8 0) (size 0.8 0.9) (layers "F.Cu" "F.Mask" "F.Paste") (net 1 "${padNet}") (uuid "${uuid}-p1")))`

const seg = (uuid: string, x1: number, x2: number, width = 0.25): string =>
  `(segment (start ${x1} 5) (end ${x2} 5) (width ${width}) (layer "F.Cu") (net 1) (uuid "${uuid}"))`

const zone = (fill: string): string =>
  `(zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z") (hatch edge 0.5)
    (polygon (pts (xy 0 0) (xy 8 0) (xy 8 10) (xy 0 10))) ${fill})`

const board = (body: string): ReturnType<typeof parseKicadBoard> =>
  parseKicadBoard(`(kicad_pcb (version 20240108) (generator "test")
    (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
    (net 0 "") (net 1 "GND") (net 2 "VCC")
    ${body})`)

const summary = (diff: ReturnType<typeof diffBoards>): string[] =>
  diff.changes.map((c) => `${c.kind} ${c.item} ${c.label}`)

describe('diffBoards', () => {
  test('an unchanged board has no changes', () => {
    const text = `${fp('a', 'R1', 10)} ${seg('s', 0, 5)}`
    expect(diffBoards(board(text), board(text)).changes).toEqual([])
  })

  test('matches by uuid: a dragged part is a move', () => {
    const diff = diffBoards(board(fp('a', 'R1', 10)), board(fp('a', 'R1', 20)))
    expect(summary(diff)).toEqual(['moved footprint R1'])
  })

  test('a value edit is a modification that names the field', () => {
    const diff = diffBoards(board(fp('a', 'R1', 10)), board(fp('a', 'R1', 10, '4k7')))
    expect(summary(diff)).toEqual(['modified footprint R1'])
    expect(diff.changes[0].fields).toEqual([{ name: 'Value', before: '10k', after: '4k7' }])
  })

  test('a pad changing net modifies its footprint', () => {
    const diff = diffBoards(board(fp('a', 'R1', 10)), board(fp('a', 'R1', 10, '10k', 'VCC')))
    expect(summary(diff)).toEqual(['modified footprint R1'])
  })

  test('tracks: a width change modifies, a reroute moves, and are named by net', () => {
    const diff = diffBoards(
      board(`${seg('s1', 0, 5)} ${seg('s2', 5, 9)}`),
      board(`${seg('s1', 0, 5, 0.5)} ${seg('s2', 5, 8)}`)
    )
    expect(summary(diff)).toEqual(['modified segment GND', 'moved segment GND'])
  })

  test('additions and removals, footprints listed before tracks', () => {
    const diff = diffBoards(
      board(`${fp('a', 'R1', 10)} ${seg('s1', 0, 5)}`),
      board(`${fp('b', 'R2', 30)} ${seg('s1', 0, 5)} ${seg('s2', 5, 9)}`)
    )
    expect(summary(diff)).toEqual([
      'removed footprint R1',
      'added footprint R2',
      'added segment GND'
    ])
    expect(diff.counts).toEqual({ added: 2, removed: 1, modified: 0, moved: 0 })
  })

  test('a refill is not a change', () => {
    const diff = diffBoards(
      board(zone('')),
      board(zone('(filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 8 0) (xy 8 10)))'))
    )
    expect(diff.changes).toEqual([])
  })

  test('each change names its render key on the sides that have it', () => {
    const diff = diffBoards(
      board(`${seg('s0', 0, 1)} ${fp('a', 'R1', 10)}`),
      board(`${fp('b', 'R2', 30)} ${fp('a', 'R1', 20)}`)
    )
    const byLabel = Object.fromEntries(diff.changes.map((c) => [`${c.kind} ${c.label}`, c]))
    expect(byLabel['moved R1']).toMatchObject({ beforeKey: 'footprint:0', afterKey: 'footprint:1' })
    expect(byLabel['added R2']).toMatchObject({ afterKey: 'footprint:0' })
    expect(byLabel['removed GND']).toMatchObject({ beforeKey: 'segment:0' })
  })

  test('a missing side makes everything added or removed', () => {
    const one = board(fp('a', 'R1', 10))
    expect(summary(diffBoards(null, one))).toEqual(['added footprint R1'])
    expect(summary(diffBoards(one, null))).toEqual(['removed footprint R1'])
  })
})

describe('withRemovedBoardItems', () => {
  test('appends removed items to the after board and names where they landed', () => {
    const before = board(`${fp('a', 'R1', 10)} ${seg('s0', 0, 1)}`)
    const after = board(fp('b', 'R2', 30))
    const { changes } = diffBoards(before, after)
    const { board: combined, removedKeys } = withRemovedBoardItems(after, before, changes)
    expect(combined?.footprints.map((f) => f.reference)).toEqual(['R2', 'R1'])
    expect(combined?.segments).toHaveLength(1)
    expect(removedKeys.get('a')).toBe('footprint:1')
    expect(removedKeys.get('s0')).toBe('segment:0')
    // The after board itself is untouched.
    expect(after.footprints).toHaveLength(1)
  })

  test('a deleted file draws the before board, all of it removed', () => {
    const before = board(fp('a', 'R1', 10))
    const { changes } = diffBoards(before, null)
    const { board: combined, removedKeys } = withRemovedBoardItems(null, before, changes)
    expect(combined?.footprints).toHaveLength(1)
    expect(removedKeys.get('a')).toBe('footprint:0')
  })
})
