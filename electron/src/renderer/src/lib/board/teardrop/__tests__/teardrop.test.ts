import { beforeAll, describe, expect, test } from 'vitest'
import { loadClipper } from '../../../geometry/clip'
import {
  isTeardropZone,
  moveBoardFootprintInAST,
  parseKicadBoard,
  removeBoardNodeFromAST,
  updateSegmentInAST
} from '../../../kicad/board'
import { DocumentStore } from '../../../document/documentStore'
import { createBoardSession, type BoardSession } from '../../boardSession'
import { setZoneFilledPolysInAST } from '../../../kicad/board'
import { DEFAULT_DESIGN_RULES, DEFAULT_NET_CLASSES } from '../../../kicad/project'
import type { SExprList } from '../../../kicad/sexpr'
import { zoneKey } from '../../boardItems'
import { BoardWorkerEngine } from '../../worker/boardWorkerEngine'
import { BoardWorkerHost } from '../../worker/boardWorkerHost'
import { unpackFillPoly } from '../../worker/protocol'
import { serializeKicadBoard } from '../../../kicad/board'
import { editTeardrops } from '../edit'
import { mmToNm } from '../../../kicad/coordinates'
import { boardIndex } from '../../spatialIndex'
import { planTeardrops } from '../manager'
import { DEFAULT_TEARDROP_SETTINGS } from '../params'

const PARAMS = `(teardrops (best_length_ratio 0.5) (max_length 1) (best_width_ratio 1) (max_width 2)
  (curved_edges no) (filter_ratio 0.9) (enabled yes) (allow_two_segments yes) (prefer_zone_connections yes))`

const board = (body: string): string => `(kicad_pcb (version 20260206) (generator "pcbnew")
  (general (thickness 1.6) (legacy_teardrops no))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (net 0 "") (net 1 "A")
  ${body}
)`

const plan = (text: string): ReturnType<typeof planTeardrops> => {
  const b = parseKicadBoard(text)
  return planTeardrops(b, boardIndex(b), 'all', {
    maxError: mmToNm(0.005),
    settings: DEFAULT_TEARDROP_SETTINGS,
    maskExpansion: 0
  })
}

const mm = (points: { x: number; y: number }[]): number[][] =>
  points.map((p) => [p.x / 1e6, p.y / 1e6])

beforeAll(loadClipper)

describe('teardrops, as KiCad 10.0.6 builds them', () => {
  test('a track leaving a round pad', () => {
    const out = plan(
      board(`(footprint "T:P" (layer "F.Cu") (uuid "11111111-0000-0000-0000-000000000000") (at 10 10)
        (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (net 1 "A")
          ${PARAMS} (uuid "11111111-0000-0000-0000-000000000001")))
        (segment (start 10 10) (end 15 11) (width 0.25) (layer "F.Cu") (net 1)
          (uuid "22222222-0000-0000-0000-000000000000"))`)
    )
    expect(out.add).toHaveLength(1)
    expect(out.add[0]).toMatchObject({ type: 'padvia', layer: 'F.Cu', net: 1, priority: 30000 })
    // pcbnew 10.0.6's Fill All Zones on this board.
    expect(mm(out.add[0].outline)).toEqual([
      [11.540638, 10.435603],
      [11.589667, 10.190458],
      [10.507515, 9.381592],
      [9.995243, 9.999049],
      [10.232228, 10.765552]
    ])
  })
})

const PAD_AND_TRACK = `(footprint "T:P" (layer "F.Cu") (uuid "11111111-0000-0000-0000-000000000000") (at 10 10)
  (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (net 1 "A")
    ${PARAMS} (uuid "11111111-0000-0000-0000-000000000001")))
  (segment (start 10 10) (end 15 11) (width 0.25) (layer "F.Cu") (net 1)
    (uuid "22222222-0000-0000-0000-000000000000"))`

const open = async (text: string): Promise<BoardSession> => {
  const session = createBoardSession({
    filePath: '/p/b.kicad_pcb',
    document: new DocumentStore(async () => null).open('/p/b.kicad_pcb', text),
    commit: () => {},
    readOnly: () => false
  })
  await session.load(text)
  return session
}

const moveEnd = (session: BoardSession, x: number, y = 10): boolean =>
  session.runCommand('move', () => {
    const b = session.board()!
    updateSegmentInAST(b.segments[0], { end: { x: mmToNm(x), y: mmToNm(y) } }, b)
  })

const teardrops = (session: BoardSession): number[][][] =>
  session
    .board()!
    .zones.filter(isTeardropZone)
    .map((z) => mm(z.points))

describe('teardrops follow an edit', () => {
  test('an edit to a track rebuilds its teardrop in the same step, and undo restores it', async () => {
    const session = await open(board(PAD_AND_TRACK))
    expect(teardrops(session)).toEqual([])
    moveEnd(session, 15)
    const first = teardrops(session)
    expect(first).toHaveLength(1)
    moveEnd(session, 14, 13)
    const second = teardrops(session)
    expect(second).toHaveLength(1)
    expect(second).not.toEqual(first)
    session.undo()
    expect(teardrops(session)).toEqual(first)
  })

  test('a pad moved off its track loses its teardrop; moved back, it has it again', async () => {
    const session = await open(board(PAD_AND_TRACK))
    moveEnd(session, 15)
    expect(teardrops(session)).toHaveLength(1)
    const move = (x: number): boolean =>
      session.runCommand('move', () =>
        moveBoardFootprintInAST(session.board()!.footprints[0], mmToNm(x), mmToNm(10))
      )
    move(30)
    expect(teardrops(session)).toEqual([])
    move(10)
    expect(teardrops(session)).toHaveLength(1)
  })

  test('a teardrop the file brings goes when its pad leaves the track', async () => {
    // Built, saved and opened again: its owners are read off the board.
    const first = await open(board(PAD_AND_TRACK))
    moveEnd(first, 15)
    const saved = serializeKicadBoard(first.board()!)
    const session = await open(saved)
    expect(teardrops(session)).toHaveLength(1)
    session.runCommand('move', () =>
      moveBoardFootprintInAST(session.board()!.footprints[0], mmToNm(30), mmToNm(10))
    )
    expect(teardrops(session)).toEqual([])
    session.undo()
    expect(teardrops(session)).toHaveLength(1)
    session.runCommand('delete', () => {
      const b = session.board()!
      removeBoardNodeFromAST(b, b.segments[0]._raw)
    })
    expect(teardrops(session)).toEqual([])
  })

  test('KiCad 7 teardrops stay as they are', async () => {
    const legacy = board(PAD_AND_TRACK).replace('(legacy_teardrops no)', '(legacy_teardrops yes)')
    const session = await open(legacy)
    moveEnd(session, 14)
    expect(teardrops(session)).toEqual([])
  })

  test('a pad with teardrops off gets none', async () => {
    const session = await open(board(PAD_AND_TRACK.replace('(enabled yes)', '(enabled no)')))
    moveEnd(session, 14)
    expect(teardrops(session)).toEqual([])
  })
})

describe('a refill leaves the teardrops nothing came near', () => {
  const settings = {
    rules: { ...DEFAULT_DESIGN_RULES },
    classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
    patterns: [],
    assignments: []
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  test('a far edit keeps a teardrop out of the refill; a near one puts it back', async () => {
    const text = board(`${PAD_AND_TRACK}
      (segment (start 40 40) (end 45 40) (width 0.25) (layer "F.Cu") (net 1)
        (uuid "33333333-0000-0000-0000-000000000000"))`)
    const engine = new BoardWorkerEngine(() => {})
    let session: BoardSession | null = null
    const host = new BoardWorkerHost(() => {
      const b = session?.board()
      return b ? { text: session!.flushSync(), root: b._raw as SExprList } : null
    }, engine)
    session = createBoardSession({
      filePath: '/p/b.kicad_pcb',
      document: new DocumentStore(async () => null).open('/p/b.kicad_pcb', text),
      commit: () => {},
      readOnly: () => false,
      worker: host
    })
    await session.load(text)
    await settle()
    const s = session
    const refilled = async (): Promise<string[]> => {
      await settle()
      const result = await host.refill({ settings })
      const fills = result?.fills ?? []
      const zones = new Map(s.board()!.zones.map((z) => [zoneKey(z), z]))
      s.runCommand(
        'refill',
        () => {
          for (const { zone, polys } of fills) {
            const target = zones.get(zone)
            if (target) setZoneFilledPolysInAST(target, polys.map(unpackFillPoly))
          }
        },
        { refill: true }
      )
      await settle()
      return fills.map((f) => f.zone)
    }
    const teardropKey = (): string => zoneKey(s.board()!.zones.find(isTeardropZone)!)
    const moveFar = (x: number): boolean =>
      s.runCommand('far', () => {
        const b = s.board()!
        updateSegmentInAST(b.segments[1], { end: { x: mmToNm(x), y: mmToNm(40) } }, b)
      })

    moveEnd(s, 15)
    expect(await refilled()).toContain(teardropKey())
    moveFar(46)
    expect(await refilled()).not.toContain(teardropKey())
    moveEnd(s, 14, 13)
    expect(await refilled()).toContain(teardropKey())
  })
})

describe('Edit teardrops', () => {
  const plain = board(PAD_AND_TRACK.replace(PARAMS, ''))
  const all = { vias: true, pthPads: true, smdPads: true, trackToTrack: false }

  test("add writes the pad's block where KiCad does and makes its teardrop; remove takes both", async () => {
    const session = await open(plain)
    expect(editTeardrops(session, 'add', { action: 'add', targets: all })).toMatchObject({
      pads: 1,
      vias: 0
    })
    const text = serializeKicadBoard(session.board()!)
    expect(text).toMatch(
      /\(net 1 "A"\)\s*\(teardrops\s*\(best_length_ratio 0\.5\)[\s\S]*\(enabled yes\)[\s\S]*\)\s*\(uuid "11111111-0000-0000-0000-000000000001"\)/
    )
    expect(teardrops(session)).toHaveLength(1)
    editTeardrops(session, 'remove', { action: 'remove', targets: all })
    expect(serializeKicadBoard(session.board()!)).not.toContain('(teardrops')
    expect(teardrops(session)).toEqual([])
    session.undo()
    expect(teardrops(session)).toHaveLength(1)
  })

  test("set changes only the values given and keeps the rest of each item's", async () => {
    const session = await open(board(PAD_AND_TRACK))
    editTeardrops(session, 'set', { action: 'set', targets: all, values: { curvedEdges: true } })
    const text = serializeKicadBoard(session.board()!)
    expect(text).toContain('(curved_edges yes)')
    expect(text).toContain('(max_length 1)')
    expect(teardrops(session)[0].length).toBeGreaterThan(5)
  })

  test("a KiCad 7 board's teardrops are taken over", async () => {
    const legacy = board(PAD_AND_TRACK).replace('(legacy_teardrops no)', '(legacy_teardrops yes)')
    const session = await open(legacy)
    editTeardrops(session, 'add', { action: 'add', targets: all })
    expect(serializeKicadBoard(session.board()!)).toContain('(legacy_teardrops no)')
    expect(teardrops(session)).toHaveLength(1)
  })
})
