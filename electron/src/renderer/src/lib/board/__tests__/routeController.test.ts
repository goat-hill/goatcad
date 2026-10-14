import { describe, expect, test } from 'vitest'
import { DocumentStore } from '../../document/documentStore'
import { createBoardSession, type BoardSession } from '../boardSession'
import { BoardSpatialIndex, boardIndex } from '../spatialIndex'
import { boardRules } from '../rules/boardRules'
import { DEFAULT_DESIGN_RULES, DEFAULT_NET_CLASSES } from '../../kicad/project'
import { addSegmentToBoardAST, type KicadBoard } from '../../kicad/board'
import { mmToNm } from '../../kicad/coordinates'
import type { PcbRouterState } from '../../../../../preload/pcbRouterTypes'
import {
  RouteController,
  createRouteState,
  routerWorldOf,
  selectedFinishEdges,
  type RouteHost,
  type RouteSetup
} from '../routeController'

// The route tool's state machine driven headless, as `router/replay.ts`
// drives the engine: clicks and keys in, the board's tracks out
// (docs/router-behavior.md R18–R25, R34).

/** Two SMD pads of SIG on F.Cu at file (10, 10) and (20, 10), and what `extra` adds. */
const board = (extra = ''): string => `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "SIG")
  (net 2 "OBS")
  (footprint "T:A" (layer "F.Cu") (uuid "f-a") (at 10 10)
    (property "Reference" "A1" (at 0 0 0) (layer "F.SilkS") (uuid "p-a"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG") (uuid "pad-a")))
  (footprint "T:B" (layer "F.Cu") (uuid "f-b") (at 20 10)
    (property "Reference" "B1" (at 0 0 0) (layer "F.SilkS") (uuid "p-b"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG") (uuid "pad-b")))
${extra}
)`

/** A net-2 track across the route's way, vertical at file x = 15. */
const WALL = `(segment (start 15 5) (end 15 15) (width 0.25) (layer "F.Cu") (net 2) (uuid "wall"))`

/** A net-2 box round B1, file (17, 7) to (23, 13). */
const BOX = [
  [17, 7, 23, 7],
  [23, 7, 23, 13],
  [23, 13, 17, 13],
  [17, 13, 17, 7]
]
  .map(
    ([x0, y0, x1, y1], i) =>
      `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.25) (layer "F.Cu") (net 2) (uuid "box${i}"))`
  )
  .join('\n')

const A = { x: 10, y: -10 }
const B = { x: 20, y: -10 }

interface Rig {
  route: RouteController
  session: BoardSession
  layer: () => string
  lands: string[]
}

/** What a rig routes with besides its prefs: *Use starting track width* and the project's sizes and rules. */
interface RigOptions {
  useConnectedWidth?: boolean
  extraTracks?: number[]
  customRules?: string
}

const rig = async (
  text: string,
  prefs: PcbRouterState = { mode: 'walkaround' },
  opts: RigOptions = {}
): Promise<Rig> => {
  const store = new DocumentStore(async () => null)
  const session = createBoardSession({
    filePath: '/p/r.kicad_pcb',
    document: store.open('/p/r.kicad_pcb', text),
    commit: () => {},
    readOnly: () => false
  })
  await session.load(text)
  const setup: RouteSetup = {
    rules: { ...DEFAULT_DESIGN_RULES },
    classes: DEFAULT_NET_CLASSES.map((c) => ({ ...c })),
    patterns: [],
    assignments: [],
    extraSizes: { tracks: opts.extraTracks ?? [], vias: [] },
    ...(opts.customRules ? { customRules: opts.customRules } : {})
  }
  let layer = 'F.Cu'
  const lands: string[] = []
  const index = (): BoardSpatialIndex | null => {
    const b = session.board()
    return b ? boardIndex(b) : null
  }
  const host: RouteHost = {
    board: () => session.board(),
    index,
    world: () => {
      const b = session.board()
      const idx = index()
      return b && idx ? routerWorldOf(b, idx, setup) : null
    },
    prefs: () => prefs,
    useConnectedWidth: () => opts.useConnectedWidth ?? true,
    setup: () => setup,
    sizeRules: () => {
      const b = session.board()
      return b && opts.customRules ? boardRules(b, setup, opts.customRules) : null
    },
    layer: () => layer,
    setLayer: (next) => (layer = next),
    land: (mutate) => {
      lands.push('route')
      session.runCommand('Route track', mutate)
    }
  }
  return {
    route: new RouteController(host, createRouteState()),
    session,
    layer: () => layer,
    lands
  }
}

const tracks = (b: KicadBoard | null, net = 1): KicadBoard['segments'] =>
  (b?.segments ?? []).filter((s) => s.net === net)

describe('RouteController: a route from click to commit', () => {
  test('begun on a pad, it takes the pad’s net; a click on the other pad arrives and lands once', async () => {
    const { route, session, lands } = await rig(board())
    expect(route.click({ snapped: A })).toBe('begun')
    expect(route.state.net).toBe(1)
    expect(route.click({ snapped: B, magnetNet: 1, onNetTarget: true })).toBe('arrived')
    expect(lands).toHaveLength(1)
    expect(route.active).toBe(false)
    const laid = tracks(session.board())
    expect(laid.length).toBeGreaterThan(0)
    expect(session.undoLabel()).toBe('Route track')
  })

  test('the click lays exactly the head the preview proposed (R18)', async () => {
    const { route } = await rig(board(WALL))
    route.begin(A)
    const proposal = route.propose(B)!
    expect(proposal.walked).toBe(true)
    route.click({ snapped: B })
    expect(route.state.segments.map((s) => [s.x0, s.y0, s.x1, s.y1])).toEqual(
      proposal.segments.map((s) => [s.x0, s.y0, s.x1, s.y1])
    )
    expect(route.state.tail).toEqual(proposal.endsAt)
  })

  test('a blocked click lays nothing (R19)', async () => {
    const { route } = await rig(board(WALL), { mode: 'highlight' })
    route.begin(A)
    expect(route.propose(B)?.blocked).toBe(true)
    expect(route.click({ snapped: B })).toBe('nothing')
    expect(route.state.segments).toEqual([])
    expect(route.state.tail).toEqual(A)
  })

  test('a click over its net’s copper ends the route where the head stopped short, that end unconnected (R20)', async () => {
    // B1 boxed in by OBS: the head walks up to the box and no further.
    const { route, session, lands } = await rig(board(BOX))
    route.begin(A)
    expect(route.propose(B)!.endsAt).not.toEqual(B)
    expect(route.click({ snapped: B, magnetNet: 1, onNetTarget: true })).toBe('ended')
    expect(lands).toHaveLength(1)
    expect(route.active).toBe(false)
    const laid = tracks(session.board())
    expect(laid.length).toBeGreaterThan(0)
    expect(laid.some((t) => t.end.x === mmToNm(20) && t.end.y === mmToNm(10))).toBe(false)
  })

  test('Backspace takes back the last click; with none, undo ends the route (R22)', async () => {
    const { route } = await rig(board())
    route.begin(A)
    route.click({ snapped: { x: 14, y: -10 } })
    route.click({ snapped: { x: 14, y: -14 } })
    expect(route.state.stops).toHaveLength(2)
    expect(route.unrouteLast()).toBe('click')
    expect(route.state.tail).toEqual({ x: 14, y: -10 })
    route.undoStep()
    expect(route.state.tail).toEqual(A)
    route.undoStep()
    expect(route.active).toBe(false)
  })

  test('an armed via lands with the click and the route goes on on its layer (R24); Esc hands the layer back', async () => {
    const { route, layer } = await rig(board())
    route.begin(A)
    route.armVia()
    expect(route.state.viaTarget).toBe('B.Cu')
    route.click({ snapped: { x: 14, y: -10 } })
    expect(route.state.vias).toHaveLength(1)
    expect(layer()).toBe('B.Cu')
    route.cancel()
    expect(layer()).toBe('F.Cu')
  })

  test('commit lands the route and its pushes as one undo step (R25)', async () => {
    const { route, session, lands } = await rig(board(WALL), { mode: 'shove' })
    route.begin(A)
    route.click({ snapped: { x: 17, y: -10 } })
    expect(route.pushedCount()).toBeGreaterThan(0)
    expect(route.commit()).toBe(true)
    expect(lands).toHaveLength(1)
    const wall = session.board()!.segments.filter((s) => s.net === 2)
    // The wall was pushed aside, in the same command as the route.
    expect(wall.some((s) => s.start.x !== mmToNm(15) || s.end.x !== mmToNm(15))).toBe(true)
    session.undo()
    expect(session.board()!.segments.filter((s) => s.net === 2)).toHaveLength(1)
    expect(tracks(session.board())).toHaveLength(0)
  })
})

describe('RouteController: the board holds still under a route (R34)', () => {
  test('an outside edit ends a live route rather than landing against a stale world', async () => {
    const { route, session, lands } = await rig(board(WALL), { mode: 'shove' })
    route.begin(A)
    route.click({ snapped: { x: 17, y: -10 } })
    expect(route.pushedCount()).toBeGreaterThan(0)
    // Someone else's write — an agent's — lands while the route is live.
    session.runCommand('Agent edit', () => {
      const b = session.board()!
      addSegmentToBoardAST(b, {
        start: { x: mmToNm(30), y: mmToNm(30) },
        end: { x: mmToNm(31), y: mmToNm(30) },
        width: mmToNm(0.25),
        layer: 'F.Cu',
        net: 2
      })
    })
    expect(route.outsideChange()).toBe(true)
    expect(route.active).toBe(false)
    expect(lands).toEqual([])
    // Nothing of the route or its pushes reached the board.
    expect(tracks(session.board())).toHaveLength(0)
    expect(session.board()!.segments.filter((s) => s.net === 2)).toHaveLength(2)
  })

  test('with the board unmoved, nothing happens', async () => {
    const { route } = await rig(board())
    route.begin(A)
    expect(route.outsideChange()).toBe(false)
    expect(route.active).toBe(true)
  })
})

/** A SIG pad `ref` at file (x, y) on F.Cu. */
const sigPad = (ref: string, x: number, y: number): string =>
  `(footprint "T:${ref}" (layer "F.Cu") (uuid "f-${ref}") (at ${x} ${y})
    (property "Reference" "${ref}" (at 0 0 0) (layer "F.SilkS") (uuid "p-${ref}"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG") (uuid "pad-${ref}")))`

const padRef = (b: KicadBoard, ref: string): { type: string; index: number; pad: number } => ({
  type: 'pad',
  index: b.footprints.findIndex((fp) => fp.reference === ref),
  pad: 0
})

describe('RouteController: Attempt Finish Selected follows the ratsnest (R46)', () => {
  // A1 and B1 joined by a track; the island D1 lies past B1, so the net's one
  // ratsnest line runs from B1 to D1 and none ends on A1.
  const JOINED = `${sigPad('D1', 40, 10)}
  (segment (start 10 10) (end 20 10) (width 0.25) (layer "F.Cu") (net 1) (uuid "ab"))`

  test('a pad joined to the rest of its net by its cluster has no line to follow', async () => {
    const { session } = await rig(board(JOINED))
    const b = session.board()!
    expect(selectedFinishEdges(b, boardIndex(b), padRef(b, 'A1'))).toEqual([])
  })

  test('a pad a line ends on finishes along it, to its other end', async () => {
    const { route, session, lands } = await rig(board(JOINED))
    const b = session.board()!
    const idx = boardIndex(b)
    const edges = selectedFinishEdges(b, idx, padRef(b, 'B1'))!
    expect(edges).toHaveLength(1)
    expect(edges[0].start.point).toEqual(B)
    expect(edges[0].target).toEqual({ x: 40, y: -10 })
    expect(route.finishFrom(edges[0].start).outcome).toBe('arrived')
    expect(lands).toHaveLength(1)
    expect(route.finishedAt?.ref).toMatchObject({ type: 'pad', index: padRef(b, 'D1').index })
    const laid = tracks(session.board()).filter((t) => t.uuid !== 'ab')
    const length = laid.reduce(
      (sum, t) => sum + Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y) / 1e6,
      0
    )
    expect(length).toBeCloseTo(20)
  })

  test('a pad between two islands follows both its lines, each toward what is left to join (KiCad skips none)', async () => {
    // A1 (10, 10) and B1 (20, 10) with M1 nearer A1: the first line routes to
    // A1, the nearest; the second, though its far end is A1's too, still
    // finishes toward the copper left, B1. Nothing is stranded.
    const { route, session, lands } = await rig(board(sigPad('M1', 12, 10)))
    const b = session.board()!
    const edges = selectedFinishEdges(b, boardIndex(b), padRef(b, 'M1'))!
    expect(edges).toHaveLength(2)
    for (const edge of edges) expect(route.finishFrom(edge.start).outcome).toBe('arrived')
    expect(lands).toHaveLength(2)
    expect(route.finishedAt?.anchor).toEqual(B)
  })
})

describe('RouteController: Attempt Finish Selected heads as F does (R46)', () => {
  test('for the copper nearest the start, whichever line it was begun along', async () => {
    // M1 sits 2 mm from A1 and 8 mm from B1.
    const { route, session } = await rig(board(sigPad('M1', 12, 10)))
    const b = session.board()!
    const edges = selectedFinishEdges(b, boardIndex(b), padRef(b, 'M1'))!
    const towardB = edges.find((e) => e.target.x === B.x)!
    expect(route.finishFrom(towardB.start).outcome).toBe('arrived')
    expect(route.finishedAt?.anchor).toEqual(A)
  })

  test('from a through pad it stays on the active layer, where the far pads are not', async () => {
    const tht = `(footprint "T:T1" (layer "F.Cu") (uuid "f-T1") (at 15 20)
    (property "Reference" "T1" (at 0 0 0) (layer "F.SilkS") (uuid "p-T1"))
    (pad "1" thru_hole circle (at 0 0) (size 1.5 1.5) (drill 0.8) (layers "*.Cu") (net 1 "SIG") (uuid "pad-T1")))`
    const { route, session, layer, lands } = await rig(board(tht))
    route.switchLayer('B.Cu')
    const b = session.board()!
    const edges = selectedFinishEdges(b, boardIndex(b), padRef(b, 'T1'))!
    expect(edges.length).toBeGreaterThan(0)
    expect(edges[0].start.layers).toContain('B.Cu')
    expect(route.finishFrom(edges[0].start).outcome).not.toBe('arrived')
    expect(lands).toEqual([])
    expect(layer()).toBe('B.Cu')
  })
})

describe('RouteController: a width not picked on this route gives way past a via (S12)', () => {
  // B.Cu holds tracks to 0.25–0.35 mm; the project lists 0.5 mm.
  const opts = {
    extraTracks: [0.5],
    customRules: `(version 1)
(rule bottom (layer "B.Cu") (constraint track_width (min 0.25mm) (opt 0.3mm) (max 0.35mm)))`
  }
  const viaDown = (route: RouteController): void => {
    route.armVia('B.Cu')
    route.click({ snapped: { x: 14, y: -10 } })
  }

  test('a row picked before the route: the rules’ width on the new layer, and back on Backspace', async () => {
    const { route, layer } = await rig(board(), undefined, opts)
    route.pickWidthRow(1)
    route.begin(A)
    expect(route.width()).toBe(0.5)
    viaDown(route)
    expect(layer()).toBe('B.Cu')
    expect(route.widthState()).toMatchObject({ width: 0.3, source: 'rules', outOfRule: false })
    expect(route.unrouteLast()).toBe('click')
    expect(route.width()).toBe(0.5)
    // The next route starts at the row picked again.
    route.cancel()
    route.begin(A)
    expect(route.width()).toBe(0.5)
  })

  test('a row picked or stepped to on this route is kept, flagged', async () => {
    for (const pick of [
      (r: RouteController) => r.pickWidthRow(1),
      (r: RouteController) => r.stepWidth(1)
    ]) {
      const { route } = await rig(board(), undefined, opts)
      route.begin(A)
      pick(route)
      viaDown(route)
      expect(route.widthState()).toMatchObject({ width: 0.5, outOfRule: true })
    }
  })

  test('with Use starting track width off, an earlier pick is explicit and kept (R1)', async () => {
    const { route } = await rig(board(), undefined, { ...opts, useConnectedWidth: false })
    route.pickWidthRow(1)
    route.begin(A)
    viaDown(route)
    expect(route.widthState()).toMatchObject({ width: 0.5, outOfRule: true })
  })
})

describe('RouteController: F mid-route (R23)', () => {
  // From A1, B1 is 10 mm along and D1 20 mm down.
  const TWO_WAYS = sigPad('D1', 10, 30)

  test("heads for the copper nearest the head's end, as KiCad measures from the line's end", async () => {
    const { route } = await rig(board(TWO_WAYS))
    route.begin(A)
    expect(route.attemptFinish({ cursor: { x: 10, y: -25 } })).toBe('arrived')
    expect(route.finishedAt?.anchor).toEqual({ x: 10, y: -30 })
  })

  test('with no cursor, from the tail', async () => {
    const { route } = await rig(board(TWO_WAYS))
    route.begin(A)
    expect(route.attemptFinish()).toBe('arrived')
    expect(route.finishedAt?.anchor).toEqual(B)
  })
})
