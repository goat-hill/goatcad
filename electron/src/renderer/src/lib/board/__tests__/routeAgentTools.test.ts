import { describe, expect, test } from 'vitest'
import { createBoardAgent, type BoardAgentContext } from '../boardAgent'
import { createBoardSession, type BoardSession } from '../boardSession'
import { parseKicadBoard, setBoardStackupInAST, type KicadBoard } from '../../kicad/board'
import { DocumentStore } from '../../document/documentStore'
import { createAgentViewports } from '../../agentViewports'
import { routeToolSpec } from '../routeAgentTools'
import { stackupSpecOf } from '../boardSetup'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  type BoardDesignSettings
} from '../../kicad/project'

const PATH = '/p/b.kicad_pcb'

const SHOT = {
  dataUrl: 'data:image/png;base64,SEEN',
  width: 200,
  height: 100,
  visible: { minX: 10, minY: -21, maxX: 12, maxY: -20 }
}

const board = (nets: string, body: string): string => `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (generator_version "9.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  ${nets}
  ${body}
)`

/** A pair's two pads on a footprint, `p` above `n`, 1 mm apart. */
const pairPads = (
  ref: string,
  x: number
): string => `(footprint "T:${ref}" (layer "F.Cu") (uuid "f-${ref}") (at ${x} 110)
    (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (uuid "f-${ref}-r"))
    (pad "1" smd rect (at 0 -0.5) (size 0.4 0.4) (layers "F.Cu") (net 1 "USB_D+") (uuid "f-${ref}-1"))
    (pad "2" smd rect (at 0 0.5) (size 0.4 0.4) (layers "F.Cu") (net 2 "USB_D-") (uuid "f-${ref}-2")))`

const PAIR_BOARD = board(
  '(net 1 "USB_D+") (net 2 "USB_D-")',
  `${pairPads('A1', 110)}\n  ${pairPads('B1', 130)}`
)

/** A straight 30 mm CLK track. */
const TUNE_BOARD = board(
  '(net 1 "CLK")',
  '(segment (start 110 110) (end 140 110) (width 0.25) (layer "F.Cu") (net 1) (uuid "clk"))'
)

type Answer = Record<string, unknown>

const agentOn = (
  text: string,
  settings: BoardDesignSettings | null = null
): {
  run: (request: Record<string, unknown>) => Promise<Answer>
  session: () => BoardSession
  live: () => KicadBoard
} => {
  const sessions = new Map<string, BoardSession>()
  const store = new DocumentStore(async () => null)
  const viewports = createAgentViewports({ isOpen: () => true, show: () => {} })
  const ctx: BoardAgentContext = {
    boardFiles: () => [PATH],
    resolveBoard: (name) => (name === PATH ? PATH : null),
    boardText: async (path) => sessions.get(path)?.flushSync() ?? text,
    commitBoard: () => {},
    design: async () => null,
    loadFootprint: async () => null,
    hold: () => () => {},
    openSession: (path) => sessions.get(path) ?? null,
    session: async (path) => {
      const open = sessions.get(path)
      if (open) return open
      const session = createBoardSession({
        filePath: path,
        document: store.open(path, text),
        commit: () => {},
        readOnly: () => false
      })
      await session.load(text)
      sessions.set(path, session)
      return session
    },
    label: (key) => key,
    capture: async () => SHOT,
    capture3D: async () => ({ ok: false, reason: 'none' }) as never,
    designSettings: async () => settings,
    projectFile: async () => null,
    readText: async () => null,
    writeProject: async () => true,
    readOnly: () => false,
    routerPrefs: () => ({ mode: 'walkaround' }),
    gridSpacing: () => 0.25,
    routeScene: () => ({
      show: () => {},
      overlay: () => {},
      capture: async () => SHOT,
      tile: async (shots) => shots[0],
      dispose: () => {}
    }),
    viewports
  }
  const agent = createBoardAgent(ctx)
  const viewport = viewports.open(PATH, 'Routing').id
  return {
    run: async (request) =>
      (await agent.dispatch({
        ...(request.kind === 'begin-route' ? { viewport } : {}),
        ...request
      } as never)) as Answer,
    session: () => sessions.get(PATH)!,
    live: () => sessions.get(PATH)!.board()!
  }
}

describe('a pair session', () => {
  test('begins on a pad of a half, arrives over the far pads, and lands both halves as one step', async () => {
    const made = agentOn(PAIR_BOARD)
    const begun = await made.run({ kind: 'begin-route', start: 'A1.1', pair: {} })
    expect(begun).toMatchObject({ session: 'route-1', layer: 'F.Cu' })
    expect(begun.pair).toMatchObject({ nets: ['USB_D+', 'USB_D-'] })
    expect(begun).not.toHaveProperty('widths')

    const landed = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ to: 'B1.1', click: true }]
    })
    expect(landed).toMatchObject({ results: ['arrived'], state: 'idle' })
    expect(landed.arrived).toEqual(['B1.1'])
    const live = made.live()
    expect(live.segments.some((s) => s.net === 1)).toBe(true)
    expect(live.segments.some((s) => s.net === 2)).toBe(true)
    expect((landed.landed as { tracks: string[] }).tracks.length).toBeGreaterThanOrEqual(2)
    expect(made.session().undoLabel()).toBe('pcbEditor.commands.routePair')
    made.session().undo()
    expect(made.live().segments).toHaveLength(0)
  })

  test('commit lands only what was clicked, never the head toward the cursor', async () => {
    const made = agentOn(PAIR_BOARD)
    await made.run({ kind: 'begin-route', start: 'A1.1', pair: {} })
    const committed = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ to: 'B1.1' }, { commit: true }]
    })
    expect(committed.results).toEqual(['moved', 'nothing'])
    expect(made.live().segments).toHaveLength(0)
  })

  test("draws at the width and gap its class's tuning profile gives the layer (S13)", async () => {
    const settings: BoardDesignSettings = {
      rules: { ...DEFAULT_DESIGN_RULES, minTrackWidth: 0.1, minClearance: 0.1 },
      classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
      patterns: [],
      assignments: [],
      tuning: {
        classProfiles: { Default: 'USB_90' },
        profiles: ['USB_90'],
        geometries: {
          USB_90: { differential: true, layers: [{ layer: 'F.Cu', width: 0.15, gap: 0.18 }] }
        }
      }
    }
    const made = agentOn(PAIR_BOARD, settings)
    const begun = await made.run({ kind: 'begin-route', start: 'A1.1', pair: {} })
    expect(begun.pair).toMatchObject({
      width: 0.15,
      gap: 0.18,
      sizes: [{ width: 0.15, gap: 0.18 }]
    })
    await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ to: 'B1.1', click: true }]
    })
    // Nanometers, as the board holds them.
    const widths = new Set(made.live().segments.map((s) => s.width))
    expect([...widths]).toEqual([150000])
  })

  test("refuses copper that is no pair half, and a route's own gestures", async () => {
    const made = agentOn(TUNE_BOARD)
    expect(await made.run({ kind: 'begin-route', at: { x: 120, y: 110 }, pair: {} })).toMatchObject(
      { error: 'not-applicable' }
    )
    const pair = agentOn(PAIR_BOARD)
    await pair.run({ kind: 'begin-route', start: 'A1.1', pair: {} })
    expect(
      await pair.run({ kind: 'step-route', session: 'route-1', gestures: [{ width: 0.3 }] })
    ).toMatchObject({ error: 'not-applicable' })
  })
})

describe('a tune session', () => {
  test('meanders a track to its target and lands the pattern as one step', async () => {
    const made = agentOn(TUNE_BOARD)
    const begun = await made.run({
      kind: 'begin-route',
      at: { x: 113, y: 110 },
      tune: { mode: 'single', target: 40 }
    })
    expect(begun.tune).toMatchObject({ mode: 'single', nets: ['CLK'], before: 30 })
    const stepped = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 137, y: 111 }, click: true }]
    })
    expect(stepped.results).toEqual(['committed'])
    const tuned = stepped.tuned as { length: number; status: string; target: { opt: number } }
    expect(tuned.status).toBe('tuned')
    expect(tuned.target.opt).toBe(40)
    expect(Math.abs(tuned.length - 40)).toBeLessThanOrEqual(0.1)
    expect(made.live().tuningPatterns).toHaveLength(1)
    expect(made.session().undoLabel()).toBe('pcbEditor.commands.tune')

    const read = await made.run({ kind: 'describe-board', lengths: ['CLK'] })
    const [row] = read.lengths as Array<{ net: string; length: number }>
    expect(row.net).toBe('CLK')
    expect(Math.abs(row.length - 40)).toBeLessThanOrEqual(0.1)
  })

  test('a pattern on the board is re-tuned by its record, and every one by update_tuning_patterns', async () => {
    const made = agentOn(TUNE_BOARD)
    expect(await made.run({ kind: 'update-tuning-patterns-board' })).toMatchObject({
      error: 'no-tuning-patterns'
    })
    await made.run({
      kind: 'begin-route',
      at: { x: 113, y: 110 },
      tune: { mode: 'single', target: 40 }
    })
    await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 137, y: 111 }, click: true }]
    })
    const id = made.live().tuningPatterns[0].uuid
    const [read] = (await made.run({ kind: 'get-board-items', ids: [id] })).items as Answer[]
    expect(read).toMatchObject({ kind: 'tuning_pattern', target: 40, origin: { y: 110 } })

    const answer = await made.run({ kind: 'update-board-item', id, record: { target: 44 } })
    const tuned = answer.tuned as { id: string; length: number; status: string }
    expect(tuned).toMatchObject({ id, status: 'tuned' })
    expect(Math.abs(tuned.length - 44)).toBeLessThanOrEqual(0.1)
    const changed = answer.changed as { created: string[]; updated: string[]; deleted: string[] }
    expect(changed.updated).toEqual([id])
    expect(changed.created.length).toBeGreaterThan(0)
    expect(changed.deleted.length).toBeGreaterThan(0)
    expect(made.live().tuningPatterns[0].targetLength.opt).toBe(44)
    expect(made.session().undoLabel()).toBe('pcbEditor.commands.retune')

    // What the tune laid is read, not written.
    expect(await made.run({ kind: 'update-board-item', id, record: { length: 50 } })).toMatchObject(
      { error: 'not-applicable' }
    )
    expect(
      await made.run({
        kind: 'update-board-item',
        id,
        record: { minAmplitude: 2, maxAmplitude: 1 }
      })
    ).toMatchObject({ error: 'invalid-record' })

    const all = await made.run({ kind: 'update-tuning-patterns-board', dryRun: true })
    expect(all).toMatchObject({ dryRun: true, patterns: [{ id, status: 'tuned' }] })
  })

  test('a pad is no track to tune; an unknown net is no length to read', async () => {
    const made = agentOn(PAIR_BOARD)
    expect(
      await made.run({ kind: 'begin-route', start: 'A1.1', tune: { mode: 'single' } })
    ).toMatchObject({ error: 'not-applicable' })
    expect(await made.run({ kind: 'describe-board', lengths: ['USB_D'] })).toMatchObject({
      error: 'net-not-found',
      candidates: ['USB_D+', 'USB_D-']
    })
  })
})

describe('routeToolSpec', () => {
  test('a pair takes a row or typed sizes, never both', () => {
    const list = [{ width: 0.2, gap: 0.15, viaGap: 0.3 }]
    expect(routeToolSpec({ pair: { row: 1 } }, list, null)).toMatchObject({ kind: 'pair', row: 1 })
    expect(routeToolSpec({ pair: { width: 0.2, gap: 0.2 } }, list, null)).toMatchObject({
      override: { width: 0.2, gap: 0.2, viaGap: 0.2 }
    })
    expect(routeToolSpec({ pair: { row: 2 } }, list, null)).toMatchObject({ error: 'invalid-args' })
    expect(routeToolSpec({ pair: { width: 0.2 } }, list, null)).toMatchObject({
      error: 'invalid-args'
    })
    expect(routeToolSpec({ pair: {}, net: 'X' }, list, null)).toMatchObject({
      error: 'invalid-args'
    })
  })

  test("a tune takes the project's meanders for its mode, under what it is given", () => {
    const project = JSON.stringify({
      board: {
        design_settings: {
          tuning_pattern_settings: { diff_pair_defaults: { spacing: 1.5, max_amplitude: 2 } }
        }
      }
    })
    const spec = routeToolSpec({ tune: { mode: 'pair', minAmplitude: 3 } }, [], project)
    expect(spec).toMatchObject({
      kind: 'tune',
      mode: 'pair',
      target: null,
      settings: { spacing: 1.5, minAmplitude: 3, maxAmplitude: 3 }
    })
  })
})

describe('stackup rows through board_update_setup', () => {
  test('one dielectric edited in place, the rest kept, as one undo step', async () => {
    const parsed = parseKicadBoard(TUNE_BOARD)
    setBoardStackupInAST(parsed, { ...stackupSpecOf(parsed), copperLayers: 2 })
    const { serializeKicadBoard } = await import('../../kicad/board')
    const text = serializeKicadBoard(parsed)
    const made = agentOn(text)
    const before = parseKicadBoard(text).stackup!.layers
    const answer = await made.run({
      kind: 'update-board-setup',
      changes: { stackup: { layers: [{ name: 'dielectric 1', thickness: 1.2, epsilonR: 4.2 }] } }
    })
    expect(answer).toMatchObject({ sections: { stackup: { edited: ['dielectric 1'] } } })
    const after = made.live().stackup!.layers
    const core = after.find((l) => l.name === 'dielectric 1')!
    expect(core.thickness).toBe(1_200_000)
    expect(core.epsilonR).toBe(4.2)
    expect(after.filter((l) => l.name !== 'dielectric 1').map((l) => l.thickness)).toEqual(
      before.filter((l) => l.name !== 'dielectric 1').map((l) => l.thickness)
    )
    expect(made.session().undoLabel()).toBe('pcbEditor.commands.editStackup')
  })

  test('row edits and a regenerating key are refused together', async () => {
    const parsed = parseKicadBoard(TUNE_BOARD)
    setBoardStackupInAST(parsed, { ...stackupSpecOf(parsed), copperLayers: 2 })
    const { serializeKicadBoard } = await import('../../kicad/board')
    const made = agentOn(serializeKicadBoard(parsed))
    expect(
      await made.run({
        kind: 'update-board-setup',
        changes: { stackup: { copperLayers: 4, layers: [{ name: 'F.Cu', thickness: 0.07 }] } }
      })
    ).toMatchObject({ error: 'not-applicable' })
  })
})
