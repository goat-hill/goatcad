import { describe, expect, test } from 'vitest'
import { createBoardSession, type BoardSession } from '../boardSession'
import { DocumentStore } from '../../document/documentStore'
import {
  addSegmentToBoardAST,
  moveBoardFootprintInAST,
  removeBoardNodeFromAST,
  serializeKicadBoard,
  setZoneFilledPolysInAST
} from '../../kicad/board'
import { zoneKey } from '../boardItems'
import { fillable } from '../zoneRefill'
import { mmToNm, nmToMm } from '../../kicad/coordinates'

const BOARD = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "A")
  (footprint "Lib:Part" (layer "F.Cu") (uuid "11111111-0000-0000-0000-000000000000") (at 10 10)
    (property "Reference" "U1" (at 0 0 0) (layer "F.SilkS") (uuid "11111111-0000-0000-0000-000000000001"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "11111111-0000-0000-0000-000000000002")))
)`

const zone = (uuid: string, x: number, extra = ''): string =>
  `(zone (net 1) (net_name "A") (layer "F.Cu") (uuid "${uuid}") (hatch edge 0.5) ${extra}
    (connect_pads (clearance 0.5)) (min_thickness 0.25)
    (polygon (pts (xy ${x} 0) (xy ${x + 5} 0) (xy ${x + 5} 5) (xy ${x} 5))))`
const KEEPOUT =
  '(keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))'
const ZONED = BOARD.replace(
  /\)$/,
  `${zone('z1', 0)}\n${zone('z2', 10)}\n${zone('k1', 20, KEEPOUT)}\n)`
)

const open = async (text = BOARD): Promise<BoardSession> => {
  const session = createBoardSession({
    filePath: '/p/b.kicad_pcb',
    document: new DocumentStore(async () => null).open('/p/b.kicad_pcb', text),
    commit: () => {},
    readOnly: () => false
  })
  await session.load(text)
  return session
}

const move = (session: BoardSession, x: number): boolean =>
  session.runCommand('move', () => {
    const fp = session.board()!.footprints[0]
    moveBoardFootprintInAST(fp, mmToNm(x), fp.position.y)
  })

describe('board session: a command that throws', () => {
  test('puts the board back and records nothing', async () => {
    const session = await open()
    move(session, 20)
    const before = serializeKicadBoard(session.board()!)
    expect(() =>
      session.runCommand('half', () => {
        const board = session.board()!
        moveBoardFootprintInAST(board.footprints[0], mmToNm(30), mmToNm(30))
        addSegmentToBoardAST(board, {
          start: { x: mmToNm(0), y: mmToNm(0) },
          end: { x: mmToNm(5), y: mmToNm(0) },
          width: mmToNm(0.2),
          layer: 'F.Cu',
          net: 1
        })
        throw new Error('refused')
      })
    ).toThrow('refused')
    expect(serializeKicadBoard(session.board()!)).toBe(before)
    expect(nmToMm(session.board()!.footprints[0].position.x)).toBe(20)
    expect(session.board()!.segments).toEqual([])
    expect(session.undoLabel()).toBe('move')
    // The step before it still undoes to the board it started from.
    session.undo()
    expect(nmToMm(session.board()!.footprints[0].position.x)).toBe(10)
    session.redo()
    expect(nmToMm(session.board()!.footprints[0].position.x)).toBe(20)
  })
})

describe('board session: stale zones', () => {
  test('a command marks and clears them, and undo and redo restore them', async () => {
    const session = await open(ZONED)
    session.runCommand(
      'edit',
      () => moveBoardFootprintInAST(session.board()!.footprints[0], mmToNm(12), mmToNm(10)),
      { zones: () => ({ stale: ['z1', 'z2'] }) }
    )
    expect([...session.staleZones()]).toEqual(['z1', 'z2'])
    session.runCommand(
      'refill',
      () => moveBoardFootprintInAST(session.board()!.footprints[0], mmToNm(13), mmToNm(10)),
      { zones: () => ({ filled: ['z1'] }) }
    )
    expect([...session.staleZones()]).toEqual(['z2'])
    session.undo()
    expect([...session.staleZones()]).toEqual(['z1', 'z2'])
    session.undo()
    expect(session.staleZones().size).toBe(0)
    session.redo()
    expect([...session.staleZones()]).toEqual(['z1', 'z2'])
  })

  test('the command hands the zone callback the nodes it touched', async () => {
    const session = await open()
    let touched = 0
    session.runCommand(
      'edit',
      () => moveBoardFootprintInAST(session.board()!.footprints[0], mmToNm(12), mmToNm(10)),
      {
        zones: (after, raws) => {
          touched = raws.size
          expect(raws.has(after.footprints[0]._raw)).toBe(true)
          return {}
        }
      }
    )
    expect(touched).toBe(1)
  })

  test('only fillable zones of the board as it is stay stale', async () => {
    const session = await open(ZONED)
    session.markZonesStale(['z1', 'k1', 'gone'])
    expect([...session.staleZones()]).toEqual(['z1'])
    session.runCommand(
      'edit',
      () => moveBoardFootprintInAST(session.board()!.footprints[0], mmToNm(12), mmToNm(10)),
      { zones: () => ({ stale: ['z2', 'k1'] }) }
    )
    expect([...session.staleZones()].sort()).toEqual(['z1', 'z2'])
    // Deleting a stale zone takes its key with it, whoever deletes it.
    session.runCommand('delete', () => {
      const board = session.board()!
      removeBoardNodeFromAST(board, board.zones.find((z) => z.uuid === 'z2')!._raw)
    })
    expect([...session.staleZones()]).toEqual(['z1'])
    // Undo brings the zone back, and its stale mark with it.
    session.undo()
    expect([...session.staleZones()].sort()).toEqual(['z1', 'z2'])
  })

  test('an auto-refill run on every stale notice settles once the zones are filled', async () => {
    const session = await open(ZONED)
    // The editor's loop: any stale zone left after a change schedules a refill,
    // which fills every fillable zone and commits.
    let pending = false
    let committing = false
    session.subscribe(() => {
      if (!committing && session.staleZones().size > 0) pending = true
    })
    const refill = (): void => {
      const zones = session.board()!.zones.filter(fillable)
      committing = true
      try {
        session.runCommand(
          'refill',
          () => {
            for (const z of zones) setZoneFilledPolysInAST(z, [{ layer: 'F.Cu', points: z.points }])
          },
          { zones: () => ({ filled: zones.map(zoneKey) }), refill: true }
        )
      } finally {
        committing = false
      }
    }
    // An agent's write leaves every zone stale; then the agent deletes one.
    session.runCommand(
      'agent write',
      () => moveBoardFootprintInAST(session.board()!.footprints[0], mmToNm(12), mmToNm(10)),
      { zones: (after) => ({ stale: after.zones.filter(fillable).map(zoneKey) }) }
    )
    session.runCommand('agent delete', () => {
      const board = session.board()!
      removeBoardNodeFromAST(board, board.zones.find((z) => z.uuid === 'z2')!._raw)
    })
    let refills = 0
    while (pending && refills < 5) {
      pending = false
      refills++
      refill()
    }
    expect(refills).toBe(1)
    expect(session.staleZones().size).toBe(0)
  })
})

describe('board session: net propagation', () => {
  const addTrack = (session: BoardSession, x0: number, x1: number, net: number): boolean =>
    session.runCommand('track', () => {
      addSegmentToBoardAST(session.board()!, {
        start: { x: mmToNm(x0), y: mmToNm(10) },
        end: { x: mmToNm(x1), y: mmToNm(10) },
        width: mmToNm(0.2),
        layer: 'F.Cu',
        net
      })
    })

  test('a track joined to a pad takes its net in the same step, and undo takes both back', async () => {
    const session = await open()
    addTrack(session, 10, 15, 0)
    expect(session.board()!.segments.map((s) => s.net)).toEqual([1])
    expect(serializeKicadBoard(session.board()!)).toMatch(/\(segment[\s\S]*\(net 1\)/)
    expect(session.lastChange()!.raws.size).toBe(1)
    session.undo()
    expect(session.board()!.segments).toEqual([])
    session.redo()
    expect(session.board()!.segments.map((s) => s.net)).toEqual([1])
  })

  test('copper the edit does not reach keeps its net', async () => {
    const session = await open()
    addTrack(session, 20, 25, 0)
    expect(session.board()!.segments.map((s) => s.net)).toEqual([0])
    // Moving the pad onto it reaches it.
    move(session, 20)
    expect(session.board()!.segments.map((s) => s.net)).toEqual([1])
    session.undo()
    expect(session.board()!.segments.map((s) => s.net)).toEqual([0])
  })
})
