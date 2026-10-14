import { describe, expect, test } from 'vitest'
import {
  connectedShapes,
  connectedTracks,
  expandConnection,
  unrouteNeighbors,
  type ConnectionWorld,
  type ConnTrack
} from '../selectConnection'

const T = (
  id: string,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  layer = 'F.Cu'
): ConnTrack => ({
  id,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  layer
})

/*
 * pad:0/0 ─ s0 ─ (10,0) ─ s1 ─ (20,0) ─ s2 ─ pad:1/0
 *                              │
 *                              s3 (a branch: three tracks meet at 20,0)
 *                              │
 *                           via:0 at (20,10) ── s4 on B.Cu ── (30,10)
 */
const world: ConnectionWorld = {
  tracks: [
    T('segment:0', 0, 0, 10, 0),
    T('segment:1', 10, 0, 20, 0),
    T('segment:2', 20, 0, 30, 0),
    T('segment:3', 20, 0, 20, 10),
    T('segment:4', 20, 10, 30, 10, 'B.Cu')
  ],
  vias: [{ id: 'via:0', at: { x: 20, y: 10 }, radius: 2, layers: ['F.Cu', 'B.Cu'] }],
  pads: [
    { id: 'pad:0/0', footprint: 'footprint:0', at: { x: 0, y: 0 }, layers: ['F.Cu'] },
    { id: 'pad:1/0', footprint: 'footprint:1', at: { x: 30, y: 0 }, layers: ['F.Cu'] }
  ]
}

const sorted = (s: Set<string>): string[] => [...s].sort()

describe('connectedTracks', () => {
  test('stop at junction: the run between the pad and the branch', () => {
    expect(sorted(connectedTracks(world, ['segment:0'], 'junction'))).toEqual([
      'segment:0',
      'segment:1'
    ])
  })

  test('stop at pad: through the branch and the via, not past the far pad', () => {
    expect(sorted(connectedTracks(world, ['segment:0'], 'pad'))).toEqual([
      'segment:0',
      'segment:1',
      'segment:2',
      'segment:3',
      'segment:4',
      'via:0'
    ])
  })

  test('a start pad does not stop the walk that begins on it', () => {
    expect(sorted(connectedTracks(world, ['pad:0/0'], 'junction'))).toEqual([
      'segment:0',
      'segment:1'
    ])
  })

  test('tracks on another layer do not join at a shared point without a via', () => {
    const w: ConnectionWorld = {
      tracks: [T('segment:0', 0, 0, 10, 0), T('segment:1', 10, 0, 20, 0, 'B.Cu')],
      vias: [],
      pads: []
    }
    expect(sorted(connectedTracks(w, ['segment:0'], 'never'))).toEqual(['segment:0'])
  })

  test('the filter ends the walk at a refused via', () => {
    const passes = (id: string): boolean => id !== 'via:0'
    expect(sorted(connectedTracks(world, ['segment:4'], 'never', passes))).toEqual(['segment:4'])
  })
})

describe('expandConnection', () => {
  test('widens to the first reach that adds anything', () => {
    // A lone via stops at itself under "junction", so the press reaches pads.
    const found = expandConnection(world, {
      copperCount: 1,
      selectionSize: 1,
      starts: ['via:0']
    })
    expect(found.has('segment:4')).toBe(true)
    expect(found.has('segment:3')).toBe(true)
  })

  test('takes the junction reach when it already adds', () => {
    const found = expandConnection(world, {
      copperCount: 1,
      selectionSize: 1,
      starts: ['segment:0']
    })
    expect(sorted(found)).toEqual(['segment:0', 'segment:1'])
  })
})

describe('connectedShapes', () => {
  test('an outline chains end to end on its layer', () => {
    const shapes = [
      { ...T('gr_line:0', 0, 0, 10, 0, 'Edge.Cuts'), width: 1 },
      { ...T('gr_line:1', 10, 0, 10, 10, 'Edge.Cuts'), width: 1 },
      { ...T('gr_line:2', 10, 10, 0, 0, 'Edge.Cuts'), width: 1 },
      { ...T('gr_line:3', 10, 10, 20, 20, 'F.SilkS'), width: 1 }
    ]
    expect(sorted(connectedShapes(shapes, ['gr_line:0']))).toEqual([
      'gr_line:0',
      'gr_line:1',
      'gr_line:2'
    ])
  })
})

describe('unrouteNeighbors', () => {
  test('a track mid-run steps out to both neighbors', () => {
    expect(sorted(unrouteNeighbors(world, ['segment:1']))).toEqual([
      'segment:0',
      'segment:2',
      'segment:3'
    ])
  })

  test('a pad ends the step', () => {
    expect(sorted(unrouteNeighbors(world, ['segment:0']))).toEqual(['segment:1'])
  })

  test("a track ending on a pad's center steps through it to the other tracks ending there (KiCad's)", () => {
    const through: ConnectionWorld = {
      ...world,
      tracks: [...world.tracks, T('segment:5', 0, 0, 0, -10)]
    }
    expect(sorted(unrouteNeighbors(through, ['segment:0']))).toEqual(['segment:1', 'segment:5'])
    expect(sorted(unrouteNeighbors(through, ['segment:5']))).toEqual(['segment:0'])
  })

  test('a via deleted with the track into it steps onto its other layers too, whatever the order', () => {
    for (const ids of [
      ['segment:3', 'via:0'],
      ['via:0', 'segment:3']
    ])
      // The via walks first and reaches the track, which then walks no more (KiCad's marks).
      expect(sorted(unrouteNeighbors(world, ids))).toEqual(['segment:4'])
  })

  test("from a via, only the tracks ending at its center: one ending off-center inside it is not a step (KiCad's)", () => {
    const offCenter: ConnectionWorld = {
      ...world,
      tracks: [...world.tracks, T('segment:5', 21, 10, 30, 20, 'B.Cu')]
    }
    expect(sorted(unrouteNeighbors(offCenter, ['via:0']))).toEqual(['segment:3', 'segment:4'])
    // A track ending inside the via's copper reaches the via all the same.
    expect(sorted(unrouteNeighbors(offCenter, ['segment:5']))).toEqual(['via:0'])
  })

  test('a via is a step of its own, and from it the walk changes layer', () => {
    expect(sorted(unrouteNeighbors(world, ['segment:3']))).toEqual([
      'segment:1',
      'segment:2',
      'via:0'
    ])
    expect(sorted(unrouteNeighbors(world, ['via:0']))).toEqual(['segment:3', 'segment:4'])
  })

  test('several at once step out from each, never back onto one another', () => {
    expect(sorted(unrouteNeighbors(world, ['segment:3', 'segment:4']))).toEqual([
      'segment:1',
      'segment:2',
      'via:0'
    ])
  })

  test('the selection filter keeps what it refuses out of the next step', () => {
    expect(sorted(unrouteNeighbors(world, ['segment:3'], (id) => id !== 'via:0'))).toEqual([
      'segment:1',
      'segment:2'
    ])
  })
})
