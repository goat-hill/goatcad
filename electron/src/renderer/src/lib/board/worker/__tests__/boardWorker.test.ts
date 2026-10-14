import { describe, expect, test } from 'vitest'
import { loadClipper } from '../../../geometry/clip'
import { createBoardSession, type BoardSession } from '../../boardSession'
import { DocumentStore } from '../../../document/documentStore'
import {
  addSegmentToBoardAST,
  moveBoardFootprintInAST,
  parseKicadBoard,
  removeBoardNodeFromAST,
  serializeKicadBoard,
  type KicadBoard
} from '../../../kicad/board'
import { mmToNm } from '../../../kicad/coordinates'
import { DEFAULT_DESIGN_RULES, DEFAULT_NET_CLASSES } from '../../../kicad/project'
import type { SExprList } from '../../../kicad/sexpr'
import { computeConnectivity } from '../../boardConnectivity'
import { boardCheckRun, boardChecksSteps } from '../../boardChecks'
import { boardRules } from '../../rules/boardRules'
import { boardIndex } from '../../spatialIndex'
import { computeRefill } from '../../zoneRefill'
import { zoneKey } from '../../boardItems'
import { BoardWorkerEngine } from '../boardWorkerEngine'
import { BoardWorkerHost } from '../boardWorkerHost'
import { unpackFillPoly } from '../protocol'

const BOARD = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "A")
  (net 2 "GND")
  (footprint "Lib:Part" (layer "F.Cu") (uuid "11111111-0000-0000-0000-000000000000") (at 10 10)
    (property "Reference" "U1" (at 0 0 0) (layer "F.SilkS") (uuid "11111111-0000-0000-0000-000000000001"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "11111111-0000-0000-0000-000000000002"))
    (pad "2" smd rect (at 3 0) (size 1 1) (layers "F.Cu") (net 2 "GND") (uuid "11111111-0000-0000-0000-000000000003")))
  (segment (start 10 10) (end 20 10) (width 0.25) (layer "F.Cu") (net 1) (uuid "22222222-0000-0000-0000-000000000000"))
  (gr_rect (start 0 0) (end 30 30) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts") (uuid "33333333-0000-0000-0000-000000000000"))
  (zone (net 2) (net_name "GND") (layer "F.Cu") (uuid "44444444-0000-0000-0000-000000000000") (hatch edge 0.5)
    (connect_pads (clearance 0.2)) (min_thickness 0.2)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 1 1) (xy 29 1) (xy 29 29) (xy 1 29))))
)`

const settings = {
  rules: { ...DEFAULT_DESIGN_RULES },
  classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
  patterns: [],
  assignments: []
}

const open = async (): Promise<{
  session: BoardSession
  engine: BoardWorkerEngine
  host: BoardWorkerHost
}> => {
  // The worker loads Clipper before its first message: have it loaded, so a settle is enough.
  await loadClipper()
  const engine = new BoardWorkerEngine(() => {})
  let session: BoardSession | null = null
  const host = new BoardWorkerHost(() => {
    const board = session?.board()
    return board ? { text: session!.flushSync(), root: board._raw as SExprList } : null
  }, engine)
  session = createBoardSession({
    filePath: '/p/b.kicad_pcb',
    document: new DocumentStore(async () => null).open('/p/b.kicad_pcb', BOARD),
    commit: () => {},
    readOnly: () => false,
    worker: host
  })
  await session.load(BOARD)
  await settle()
  return { session, engine, host }
}

/** Let the in-thread worker take its queued messages. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const same = async (session: BoardSession, engine: BoardWorkerEngine): Promise<void> => {
  await settle()
  expect(serializeKicadBoard(engine.board!)).toBe(serializeKicadBoard(session.board()!))
}

describe('board worker', () => {
  test('its copy follows edits, undo and redo', async () => {
    const { session, engine } = await open()
    await same(session, engine)
    session.runCommand('move', () => {
      const fp = session.board()!.footprints[0]
      moveBoardFootprintInAST(fp, mmToNm(12), mmToNm(14))
    })
    await same(session, engine)
    session.runCommand('track', () => {
      addSegmentToBoardAST(session.board()!, {
        start: { x: mmToNm(5), y: mmToNm(5) },
        end: { x: mmToNm(8), y: mmToNm(5) },
        width: mmToNm(0.2),
        layer: 'F.Cu',
        net: 1
      })
    })
    await same(session, engine)
    session.runCommand('delete', () => {
      removeBoardNodeFromAST(session.board()!, session.board()!.segments[0]._raw)
    })
    await same(session, engine)
    session.undo()
    await same(session, engine)
    session.undo()
    await same(session, engine)
    session.redo()
    await same(session, engine)
  })

  test('checks and refills as the board itself would', async () => {
    const { session, host } = await open()
    session.runCommand('move', () => {
      const fp = session.board()!.footprints[0]
      moveBoardFootprintInAST(fp, mmToNm(12), mmToNm(14))
    })
    await settle()
    const board: KicadBoard = session.board()!
    const index = boardIndex(board)

    const refilled = await host.refill({ settings })
    const direct = await computeRefill(board, index, boardRules(board, settings), 'all')
    expect(refilled?.fills.map((fill) => [fill.zone, fill.polys.map(unpackFillPoly)])).toEqual(
      direct?.fills.map((fill) => [zoneKey(fill.zone), fill.polys])
    )

    const checked = await host.check({
      settings: { version: 1, value: settings },
      libraries: { version: 0, value: null },
      schematic: { version: 0, value: null },
      whole: true
    })
    const steps = boardChecksSteps({
      board,
      index,
      connectivity: computeConnectivity(board, index),
      settings,
      schematic: null
    })
    let step = steps.next()
    while (!step.done) step = steps.next()
    expect(checked).toEqual(step.value)
  })

  test('each job and its steps are measured on the page', async () => {
    const { host } = await open()
    performance.clearMeasures()
    await host.refill({ settings })
    await host.check({
      settings: { version: 1, value: settings },
      libraries: { version: 0, value: null },
      schematic: { version: 0, value: null },
      whole: true
    })
    const names = performance.getEntriesByType('measure').map((entry) => entry.name)
    expect(names).toContain('board:refill all')
    expect(names).toContain('board:refill all · GND on F.Cu')
    expect(names).toContain('board:check whole')
    expect(names).toContain('board:check whole · copper clearance')
  })

  test('an answer for a board an edit has since changed is dropped', async () => {
    const { session, host } = await open()
    const pending = host.refill({ settings })
    session.runCommand('move', () => {
      const fp = session.board()!.footprints[0]
      moveBoardFootprintInAST(fp, mmToNm(12), mmToNm(14))
    })
    expect(await pending).toBeNull()
  })

  test('a check names each phase of its plan as it starts it', () => {
    const parsed = parseKicadBoard(BOARD)
    const index = boardIndex(parsed)
    const seen: string[] = []
    let plan: readonly string[] = []
    const steps = boardCheckRun(
      { board: parsed, index, connectivity: computeConnectivity(parsed, index), settings },
      undefined,
      true,
      (phase, whole) => {
        seen.push(phase)
        plan = whole
      }
    )
    while (!steps.next().done);
    expect(seen).toEqual(plan)
    expect(seen[0]).toBe('context')
  })

  test('without shared memory, a job answers to the revisions its messages bring', async () => {
    const answers: unknown[] = []
    const engine = new BoardWorkerEngine((message) => answers.push(message))
    const ids = Int32Array.from(
      (parseKicadBoard(BOARD)._raw as SExprList).children,
      (_, i) => i + 1
    )
    // What a worker gets from a page that is not isolated: a copy, frozen at revision 0.
    await engine.handle({ type: 'init', control: new ArrayBuffer(4) })
    await engine.handle({ type: 'load', revision: 3, text: BOARD, ids })
    await engine.handle({
      type: 'check',
      revision: 3,
      job: 1,
      settingsVersion: 1,
      settings,
      librariesVersion: 0,
      libraries: null,
      schematicVersion: 0,
      schematic: null,
      whole: true
    })
    const checked = answers.find((message) => (message as { type: string }).type === 'checked') as {
      results: unknown[] | null
    }
    expect(checked.results).not.toBeNull()
  })

  test('a check that fails answers with nothing rather than never', async () => {
    const { host } = await open()
    const broken = { ...settings, classes: null } as unknown as typeof settings
    const errors: unknown[] = []
    const error = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      const answer = await host.check({
        settings: { version: 1, value: broken },
        libraries: { version: 0, value: null },
        schematic: { version: 0, value: null },
        whole: true
      })
      expect(answer).toBeNull()
      expect(errors).toHaveLength(1)
    } finally {
      console.error = error
    }
  })
})
