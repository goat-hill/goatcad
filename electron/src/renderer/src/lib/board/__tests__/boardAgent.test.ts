import { describe, expect, test, vi } from 'vitest'
import { createBoardAgent, isBoardRequest, type BoardAgentContext } from '../boardAgent'
import { createBoardSession, type BoardSession } from '../boardSession'
import {
  addSegmentToBoardAST,
  isTeardropZone,
  parseKicadBoard,
  type KicadBoard
} from '../../kicad/board'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  extractDesignSettings
} from '../../kicad/project'
import { mmToNm, nmToMm } from '../../kicad/coordinates'
import { serializeSExpr, type SExprList } from '../../kicad/sexpr'
import { DocumentStore } from '../../document/documentStore'
import { buildConnectivity, type SheetConnectivityInput } from '../../schematic/connectivity'
import { parseKicadFootprint, type KicadFootprint } from '../../kicad/footprint'
import { parseKicadSchematic } from '../../kicad/schematic'
import type { SyncDesign } from '../boardSync'
import type { SchematicNetlist } from '../schematicNetlist'
import type { SheetSource } from '../../componentsTable'
import type { BoardCaptureRequest } from '../../engine/boardCapture'
import type { Board3DCaptureRequest } from '../../engine/board3d/boardCapture3D'
import type { McpBeginRouteRequest, McpDesignRequest } from '../../../../../preload/mcpTypes'
import { createAgentViewports } from '../../agentViewports'
import { footprintPointOnBoard } from '../footprintChildren'
import { boardItems } from '../boardItems'
import type { AgentViewportShown } from '../../agentViewportView'
import type { RouteOverlay } from '../routeAgent'

const LIB = `
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))))))
`

const ROOT = 'aaaaaaaa-0000-0000-0000-000000000000'

const resistor = (reference: string, y: number, footprint: string): string =>
  `(symbol (lib_id "Device:R") (at 50 ${y} 0) (unit 1) (uuid "${reference.toLowerCase()}-uuid")
     (property "Reference" "${reference}" (at 50 ${y} 0))
     (property "Value" "10k" (at 50 ${y} 0))
     (property "Footprint" "${footprint}" (at 50 ${y} 0)))`

const SCHEMATIC = `(kicad_sch (version 20231120) (generator "test") (uuid "${ROOT}") ${LIB}
  ${resistor('R1', 50, 'Resistor_SMD:R_0402_1005Metric')}
  ${resistor('R2', 70, '')}
  (wire (pts (xy 50 53.81) (xy 50 66.19)) (stroke (width 0)))
)`

const R_0402 = `(footprint "R_0402_1005Metric"
  (version 20240108)
  (generator "test")
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -1.17 0) (layer "F.SilkS") (uuid "11111111-0000-0000-0000-000000000001") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "R" (at 0 1.17 0) (layer "F.Fab") (uuid "11111111-0000-0000-0000-000000000002") (effects (font (size 1 1) (thickness 0.15))))
  (attr smd)
  (pad "1" smd roundrect (at -0.485 0) (size 0.59 0.64) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (uuid "11111111-0000-0000-0000-000000000005"))
  (pad "2" smd roundrect (at 0.485 0) (size 0.59 0.64) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (uuid "11111111-0000-0000-0000-000000000006"))
)`

const BOARD = `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (generator_version "9.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (gr_line (start 100 100) (end 150 100) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "33333333-0000-0000-0000-000000000001"))
)`

/** The same board with R1 already placed, for the render frames. */
const PLACED = BOARD.replace(
  '  (gr_line',
  `  (footprint "Resistor_SMD:R_0402_1005Metric"
    (layer "F.Cu")
    (uuid "44444444-0000-0000-0000-000000000001")
    (at 120 110)
    (property "Reference" "R1" (at 0 -1.17 0) (layer "F.SilkS") (uuid "44444444-0000-0000-0000-000000000002"))
    (pad "1" smd roundrect (at -0.485 0) (size 0.59 0.64) (layers "F.Cu") (roundrect_rratio 0.25) (uuid "44444444-0000-0000-0000-000000000003"))
  )
  (gr_line`
)

const design = (text = SCHEMATIC): SyncDesign => {
  const schematic = parseKicadSchematic(text)
  const sheetPath = `/${ROOT}`
  const sheets: SheetSource[] = [
    { schematic, sheetPath, sheetName: '', filePath: '/p/psu.kicad_sch' }
  ]
  const inputs: SheetConnectivityInput[] = [{ sheetPath, namePath: '/', schematic }]
  return { sheets, inputs, connectivity: buildConnectivity(inputs) }
}

interface Fake {
  ctx: BoardAgentContext
  texts: Map<string, string>
  commits: Array<{ path: string; content: string; loaded: string }>
  captures: BoardCaptureRequest[]
  captures3D: Board3DCaptureRequest[]
  /** The sessions the door opened, as the window opens a tab behind the active one. */
  sessions: Map<string, BoardSession>
}

/** What the headless capture would answer: a 2 x 1 mm window, 200 x 100 px. */
const SHOT = {
  dataUrl: 'data:image/png;base64,SEEN',
  width: 200,
  height: 100,
  visible: { minX: 10, minY: -21, maxX: 12, maxY: -20 }
}

const SHOT_3D = {
  dataUrl: 'data:image/png;base64,SEEN3D',
  width: 320,
  height: 180,
  mmPerPixel: null,
  frame: null,
  models: { total: 3, placed: 2, missing: 1, missingLinks: ['${KICAD9_3DMODEL_DIR}/x.step'] },
  palette: { mask: '#151515', silk: '#141414', backSilk: '#e6e8e4' }
}

const fake = (
  options: {
    boards?: string[]
    design?: SyncDesign | null
    text?: string
    /** false: the window has no session to give, as a board door with no editor. */
    sessions?: boolean
    /** The project file's text, beside the board; none when absent. */
    project?: string
    /** The schematic's netlist as the window reads it live. */
    netlist?: SchematicNetlist
  } = {}
): Fake => {
  const PROJECT = '/p/psu.kicad_pro'
  const boards = options.boards ?? ['/p/psu.kicad_pcb']
  const texts = new Map(boards.map((path) => [path, options.text ?? BOARD]))
  if (options.project !== undefined) texts.set(PROJECT, options.project)
  const commits: Fake['commits'] = []
  const captures: BoardCaptureRequest[] = []
  const captures3D: Board3DCaptureRequest[] = []
  const sessions = new Map<string, BoardSession>()
  const store = new DocumentStore(async () => null)
  const library: Record<string, KicadFootprint> = {
    'Resistor_SMD:R_0402_1005Metric': parseKicadFootprint(R_0402)
  }
  return {
    texts,
    commits,
    captures,
    captures3D,
    sessions,
    ctx: {
      boardFiles: () => boards,
      resolveBoard: (name) =>
        boards.find((path) => path === name || path.endsWith(`/${name}`)) ?? null,
      boardText: async (path) => sessions.get(path)?.flushSync() ?? texts.get(path) ?? null,
      commitBoard: (path, content, loaded) => {
        commits.push({ path, content, loaded })
        texts.set(path, content)
      },
      design: async () => (options.design === undefined ? design() : options.design),
      ...(options.netlist ? { schematicNetlist: async () => options.netlist! } : {}),
      loadFootprint: async (libId) => library[libId] ?? null,
      hold: () => () => {},
      openSession: (path) => sessions.get(path) ?? null,
      session: async (path) => {
        if (options.sessions === false) return null
        const open = sessions.get(path)
        if (open) return open
        const text = texts.get(path)
        if (text === undefined) return null
        const session = createBoardSession({
          filePath: path,
          document: store.open(path, text),
          commit: (content) => texts.set(path, content),
          readOnly: () => false
        })
        await session.load(text)
        sessions.set(path, session)
        return session
      },
      label: (key, values) =>
        values === undefined
          ? key
          : `${key} ${typeof values === 'number' ? values : JSON.stringify(values)}`,
      capture: async (_board, request) => {
        captures.push(request)
        return SHOT
      },
      capture3D: async (_board, _path, request) => {
        captures3D.push(request)
        return { ok: true, capture: SHOT_3D }
      },
      designSettings: async () => {
        const text = texts.get(PROJECT)
        return text === undefined ? null : extractDesignSettings(text)
      },
      projectFile: async () => (texts.has(PROJECT) ? PROJECT : null),
      readText: async (path) => texts.get(path) ?? null,
      writeProject: async (path, content) => {
        texts.set(path, content)
        return true
      },
      readOnly: () => false
    }
  }
}

describe('isBoardRequest', () => {
  test('claims the board kinds and nothing else', () => {
    expect(isBoardRequest({ kind: 'describe-board' })).toBe(true)
    expect(isBoardRequest({ kind: 'sync-board', dryRun: false })).toBe(true)
    expect(isBoardRequest({ kind: 'render-board', maxPixels: 800 })).toBe(true)
    expect(isBoardRequest({ kind: 'check-board' })).toBe(true)
    expect(isBoardRequest({ kind: 'update-board-item', board: 'b', id: 'R1', record: {} })).toBe(
      true
    )
    expect(isBoardRequest({ kind: 'batch-board', ops: [] })).toBe(true)
    expect(isBoardRequest({ kind: 'refill-board' })).toBe(true)
    expect(isBoardRequest({ kind: 'describe-schematic' })).toBe(false)
    expect(
      isBoardRequest({ kind: 'update-footprint-item', footprint: 'x', id: 'y', record: {} })
    ).toBe(false)
  })
})

describe('render-board-3d', () => {
  const render = async (
    request: Record<string, unknown>
  ): Promise<{ answer: Record<string, unknown>; captures: Board3DCaptureRequest[] }> => {
    const { ctx, captures3D } = fake({ text: PLACED })
    const answer = (await createBoardAgent(ctx).dispatch({
      kind: 'render-board-3d',
      ...request
    } as never)) as Record<string, unknown>
    return { answer, captures: captures3D }
  }

  test('defaults to the 3D pane: iso, perspective, fit, studio light, theme background', async () => {
    const { answer, captures } = await render({})
    expect(captures).toEqual([
      expect.objectContaining({
        azimuth: 41.28,
        elevation: 29.6,
        projection: 'perspective',
        zoom: 1,
        lighting: 'studio',
        background: 'theme'
      })
    ])
    expect(answer.image).toEqual({ mimeType: 'image/png', base64: 'SEEN3D' })
    expect(answer.models).toEqual({
      linked: 3,
      placed: 2,
      missing: 1,
      missingLinks: ['${KICAD9_3DMODEL_DIR}/x.step']
    })
    expect(answer.finish).toEqual({ mask: '#151515', silk: '#141414', backSilk: '#e6e8e4' })
    expect(answer).not.toHaveProperty('mmPerPixel')
  })

  test('a bearing overrides only the part of the preset it names', async () => {
    const { captures } = await render({ view: 'front', elevation: 25 })
    expect(captures[0]).toMatchObject({ azimuth: 0, elevation: 25 })
  })

  test('passes the camera, framing and look through as given', async () => {
    const { captures } = await render({
      view: 'bottom',
      projection: 'orthographic',
      zoom: 2,
      width: 800,
      footprints: ['R1'],
      show: { models: false },
      background: 'transparent',
      silk: 'Black'
    })
    expect(captures[0]).toMatchObject({
      azimuth: 0,
      elevation: -90,
      projection: 'orthographic',
      zoom: 2,
      width: 800,
      footprints: ['R1'],
      show: { models: false },
      background: 'transparent',
      silk: 'Black'
    })
  })
})

describe('render-board', () => {
  const render = async (
    request: Record<string, unknown>,
    options: Parameters<typeof fake>[0] = {}
  ): Promise<{ answer: Record<string, unknown>; captures: BoardCaptureRequest[] }> => {
    const { ctx, captures } = fake({ text: PLACED, ...options })
    const answer = (await createBoardAgent(ctx).dispatch({
      kind: 'render-board',
      maxPixels: 800,
      ...request
    } as never)) as Record<string, unknown>
    return { answer, captures }
  }

  test('draws the whole board and answers with the frame in board millimetres', async () => {
    const { answer, captures } = await render({})
    expect(captures).toEqual([{ flipped: false, maxPixels: 800 }])
    // The shot's y-up window read back y-down: y = -maxY, height unchanged.
    expect(answer.frame).toEqual({ x: 10, y: 20, width: 2, height: 1 })
    expect(answer.side).toBe('front')
    expect(answer.board).toEqual({ path: '/p/psu.kicad_pcb', name: 'psu.kicad_pcb' })
    expect(answer.width).toBe(200)
    expect(answer.image).toEqual({ mimeType: 'image/png', base64: 'SEEN' })
  })

  test('a render in a viewport moves its box to the frame drawn', async () => {
    const { ctx } = fake({ text: PLACED })
    const viewports = createAgentViewports({ isOpen: () => true })
    ctx.viewports = viewports
    const agent = createBoardAgent(ctx)
    const mine = viewports.open('/p/psu.kicad_pcb', 'Placing U1')
    const answer = (await agent.dispatch({
      kind: 'render-board',
      maxPixels: 800,
      viewport: mine.id
    })) as Record<string, unknown>
    expect(answer).toMatchObject({
      viewport: mine.id,
      frame: { x: 10, y: 20, width: 2, height: 1 }
    })
    expect(viewports.live()[0].frame).toEqual({ x: 10, y: 20, width: 2, height: 1 })
    expect(viewports.live()[0].label).toBe('Placing U1')
    await agent.dispatch({
      kind: 'render-board',
      maxPixels: 800,
      viewport: mine.id,
      action: 'Review U1'
    })
    expect(viewports.live()[0].label).toBe('Review U1')
    const other = viewports.open('/p/other.kicad_pcb', 'Elsewhere')
    expect(
      await agent.dispatch({ kind: 'render-board', maxPixels: 800, viewport: other.id })
    ).toEqual({
      error: 'invalid-args',
      detail: 'Viewport viewport-2 is on other.kicad_pcb, not psu.kicad_pcb.'
    })
  })

  test('a picture missing zone fills says so', async () => {
    const { ctx } = fake({ text: PLACED })
    ctx.capture = async () => ({ ...SHOT, unfinishedFills: 2 })
    const answer = (await createBoardAgent(ctx).dispatch({
      kind: 'render-board',
      maxPixels: 800
    })) as Record<string, unknown>
    expect(answer.incomplete).toEqual({ fills: 2 })
    expect(answer.note).toMatch(/^2 zone fills .* missing from it\. Render again/)
  })

  test('a complete picture carries no incomplete or note', async () => {
    const { answer } = await render({})
    expect(answer).not.toHaveProperty('incomplete')
    expect(answer).not.toHaveProperty('note')
  })

  test('a box in board millimetres becomes the scene box, y flipped', async () => {
    const { captures } = await render({ box: { x: 100, y: 105, width: 20, height: 10 } })
    expect(captures[0].box).toEqual({ minX: 100, maxX: 120, minY: -115, maxY: -105 })
  })

  test('the back view mirrors x on the way in and unmirrors it on the way out', async () => {
    const { answer, captures } = await render({
      side: 'back',
      box: { x: 100, y: 105, width: 20, height: 10 }
    })
    expect(captures[0]).toMatchObject({
      flipped: true,
      box: { minX: -120, maxX: -100, minY: -115, maxY: -105 }
    })
    // visible x 10..12 in a mirrored scene is board x -12..-10.
    expect(answer.frame).toEqual({ x: -12, y: 20, width: 2, height: 1 })
    expect(answer.side).toBe('back')
  })

  test('named footprints are passed as indices', async () => {
    const { captures } = await render({ footprints: ['R1'] })
    expect(captures[0].footprints).toEqual([0])
  })

  test('a reference no footprint carries is refused with the candidates', async () => {
    const { answer, captures } = await render({ footprints: ['R1', 'U9'] })
    expect(answer).toMatchObject({ error: 'reference-not-found', candidates: ['R1'] })
    expect(answer.detail).toContain('U9')
    expect(captures).toEqual([])
  })

  test('a board the project does not hold is refused before anything is drawn', async () => {
    const { answer, captures } = await render({ board: 'nope.kicad_pcb' })
    expect(answer).toMatchObject({ error: 'board-not-found' })
    expect(captures).toEqual([])
  })
})

describe('check-board', () => {
  test('runs the board checks with the default rules and groups them by rule', async () => {
    // Two tracks of different nets 0.1 mm apart on F.Cu: closer than Default's 0.2 mm.
    const text = BOARD.replace(
      '(net 0 "")',
      `(net 0 "") (net 1 "A") (net 2 "B")
      (segment (start 110 110) (end 120 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "44444444-0000-0000-0000-000000000001"))
      (segment (start 110 110.3) (end 120 110.3) (width 0.2) (layer "F.Cu") (net 2) (uuid "44444444-0000-0000-0000-000000000002"))`
    )
    const { ctx } = fake({ text })
    const answer = (await createBoardAgent(ctx).dispatch({ kind: 'check-board' })) as {
      ok: boolean
      checks: Array<{ code: string; items: string[] }>
    }
    expect(answer.ok).toBe(false)
    const clearance = answer.checks.find((row) => row.code === 'copper-clearance')
    expect(clearance?.items).toEqual([
      '44444444-0000-0000-0000-000000000001',
      '44444444-0000-0000-0000-000000000002'
    ])
  })

  test("compares the board with the schematic's live netlist, as the pill does", async () => {
    const netlist: SchematicNetlist = {
      parts: [
        {
          reference: 'R1',
          value: '10k',
          libId: 'Resistor_SMD:R_0402_1005Metric',
          filters: [],
          fields: [],
          dnp: false,
          excludeFromBom: false,
          pins: new Map()
        }
      ]
    }
    const answer = (await createBoardAgent(fake({ netlist }).ctx).dispatch({
      kind: 'check-board'
    })) as { checks: Array<{ code: string; count: number }> }
    expect(answer.checks.find((row) => row.code === 'missing-footprint')?.count).toBe(1)
    const without = (await createBoardAgent(fake().ctx).dispatch({ kind: 'check-board' })) as {
      checks: Array<{ code: string }>
    }
    expect(without.checks.some((row) => row.code === 'missing-footprint')).toBe(false)
  })

  test('a row lists 20 findings, and every one when codes names its rule', async () => {
    // 22 pairs of tracks of different nets 0.1 mm apart, each pair a clearance finding.
    const pairs = Array.from({ length: 22 }, (_, i) => {
      const id = (n: number): string => `44444444-0000-0000-0000-${String(n).padStart(12, '0')}`
      const y = 105 + i
      return `(segment (start 110 ${y}) (end 112 ${y}) (width 0.2) (layer "F.Cu") (net 1) (uuid "${id(2 * i)}"))
      (segment (start 110 ${y + 0.3}) (end 112 ${y + 0.3}) (width 0.2) (layer "F.Cu") (net 2) (uuid "${id(2 * i + 1)}"))`
    }).join('\n')
    const text = BOARD.replace('(net 0 "")', `(net 0 "") (net 1 "A") (net 2 "B")\n${pairs}`)
    type Row = { code: string; count: number; findings?: unknown[]; truncated?: true }
    const agent = createBoardAgent(fake({ text }).ctx)
    const full = (await agent.dispatch({ kind: 'check-board' })) as {
      checks: Row[]
      guidance: string
    }
    const capped = full.checks.find((row) => row.code === 'copper-clearance')!
    expect(capped).toMatchObject({ count: 22, truncated: true })
    expect(capped.findings).toHaveLength(20)
    expect(full.guidance).toContain('pass its code in codes')
    const named = (await agent.dispatch({ kind: 'check-board', codes: ['copper-clearance'] })) as {
      checks: Row[]
    }
    expect(named.checks).toHaveLength(1)
    expect(named.checks[0].count).toBe(22)
    expect(named.checks[0].findings).toHaveLength(22)
    expect(named.checks[0].truncated).toBeUndefined()
  })

  test('refuses an unknown board with the candidates', async () => {
    const { ctx } = fake()
    const answer = (await createBoardAgent(ctx).dispatch({
      kind: 'check-board',
      board: 'other.kicad_pcb'
    })) as Record<string, unknown>
    expect(answer.error).toBe('board-not-found')
  })
})

describe('describe-board', () => {
  test('reads the board back with its outline, layers and counts', async () => {
    const { ctx } = fake()
    const answer = (await createBoardAgent(ctx).dispatch({ kind: 'describe-board' })) as Record<
      string,
      unknown
    >
    expect(answer.board).toEqual({ path: '/p/psu.kicad_pcb', name: 'psu.kicad_pcb' })
    expect(answer.layers).toEqual({ copper: 2, total: 3 })
    expect(answer.outline).toEqual({ x: 100, y: 100, width: 50, height: 0 })
    expect(answer.footprints).toEqual([])
    expect(answer.counts).toEqual({ footprints: 0, nets: 0, tracks: 0, vias: 0, zones: 0 })
    expect(answer.unrouted).toBe(0)
  })

  test('refuses an unknown board with the candidates, and an ambiguous project', async () => {
    const one = fake()
    expect(
      await createBoardAgent(one.ctx).dispatch({ kind: 'describe-board', board: 'x.kicad_pcb' })
    ).toMatchObject({
      error: 'board-not-found',
      candidates: ['/p/psu.kicad_pcb']
    })
    const two = fake({ boards: ['/p/a.kicad_pcb', '/p/b.kicad_pcb'] })
    expect(await createBoardAgent(two.ctx).dispatch({ kind: 'describe-board' })).toMatchObject({
      error: 'board-ambiguous'
    })
    expect(
      await createBoardAgent(two.ctx).dispatch({ kind: 'describe-board', board: 'b.kicad_pcb' })
    ).toMatchObject({ board: { path: '/p/b.kicad_pcb', name: 'b.kicad_pcb' } })
  })
})

describe('sync-board', () => {
  test('lands what it can, names what it cannot, as one undoable step on the session', async () => {
    const { ctx, commits, sessions } = fake()
    const agent = createBoardAgent(ctx)
    const answer = (await agent.dispatch({
      kind: 'sync-board',
      dryRun: false,
      checks: true
    })) as Record<string, unknown>
    expect(answer.added).toEqual([
      { reference: 'R1', libId: 'Resistor_SMD:R_0402_1005Metric', at: expect.any(Object) }
    ])
    expect(answer.skipped).toEqual([{ reference: 'R2', reason: 'no-footprint' }])
    expect(String(answer.fix)).toContain('bom_get')
    expect(answer.nets).toEqual({
      added: ['Net-(R1-Pad2)', 'unconnected-(R1-Pad1)'],
      removed: []
    })
    expect(answer.checks).toEqual({ new: expect.any(Array), resolved: [] })
    expect(typeof answer.revision).toBe('number')
    expect(commits).toHaveLength(0)
    const session = sessions.get('/p/psu.kicad_pcb')!
    expect(session.board()!.footprints.map((fp) => fp.reference)).toEqual(['R1'])
    expect(session.canUndo()).toBe(true)
    // Read back through the same door: the footprint is there, unrouted is
    // zero because R2 never landed and R1's pad 2 has no partner on the board.
    const described = (await agent.dispatch({ kind: 'describe-board' })) as Record<string, unknown>
    expect((described.footprints as unknown[]).length).toBe(1)
    expect(described.unrouted).toBe(0)
    session.undo()
    expect(session.board()!.footprints).toEqual([])
  })

  test('an open board takes an update to a placed footprint, not just additions', async () => {
    const { ctx, sessions } = fake()
    const agent = createBoardAgent(ctx)
    await agent.dispatch({ kind: 'sync-board', dryRun: false })
    // The value changes in the schematic; the plan is made over a parse of the
    // board's text, the apply lands on the session's own board.
    ctx.design = async () => design(SCHEMATIC.replace('"Value" "10k"', '"Value" "4k7"'))
    const answer = (await agent.dispatch({ kind: 'sync-board', dryRun: false })) as Record<
      string,
      unknown
    >
    expect(answer.updated).toEqual([{ reference: 'R1', changes: ['value'] }])
    const session = sessions.get('/p/psu.kicad_pcb')!
    expect(session.board()!.footprints.map((fp) => fp.value)).toEqual(['4k7'])
    session.undo()
    expect(session.board()!.footprints.map((fp) => fp.value)).toEqual(['10k'])
  })

  test('with no session to give, lands text in the tab buffer instead', async () => {
    const { ctx, commits, texts } = fake({ sessions: false })
    await createBoardAgent(ctx).dispatch({ kind: 'sync-board', dryRun: false })
    expect(commits).toHaveLength(1)
    expect(commits[0].loaded).toBe(BOARD)
    const board = parseKicadBoard(texts.get('/p/psu.kicad_pcb')!)
    expect(board.footprints.map((fp) => fp.reference)).toEqual(['R1'])
  })

  test('a dry run answers the same and writes nothing', async () => {
    const { ctx, commits } = fake()
    const answer = (await createBoardAgent(ctx).dispatch({
      kind: 'sync-board',
      dryRun: true
    })) as Record<string, unknown>
    expect(answer.dryRun).toBe(true)
    expect((answer.added as unknown[]).length).toBe(1)
    expect(commits).toHaveLength(0)
  })

  test('a second sync changes nothing and says so', async () => {
    const { ctx, sessions } = fake()
    const agent = createBoardAgent(ctx)
    await agent.dispatch({ kind: 'sync-board', dryRun: false })
    const revision = sessions.get('/p/psu.kicad_pcb')!.revision()
    const again = (await agent.dispatch({ kind: 'sync-board', dryRun: false })) as Record<
      string,
      unknown
    >
    expect(again.unchanged).toBe(1)
    expect(again.added).toEqual([])
    expect(String(again.guidance)).toContain('nothing was written')
    expect(sessions.get('/p/psu.kicad_pcb')!.revision()).toBe(revision)
  })

  test('refuses with no schematic to sync from', async () => {
    const { ctx } = fake({ design: null })
    expect(
      await createBoardAgent(ctx).dispatch({ kind: 'sync-board', dryRun: false })
    ).toMatchObject({
      error: 'no-schematic'
    })
  })
})

describe('previewSync', () => {
  test('answers the typed plan a dry run summarizes, and writes nothing', async () => {
    const { ctx, commits } = fake()
    const preview = await createBoardAgent(ctx).previewSync()
    if ('error' in preview) throw new Error(preview.error)
    expect(preview.board).toBe('/p/psu.kicad_pcb')
    expect(preview.plan.add.map((addition) => addition.part.reference)).toEqual(['R1'])
    expect(preview.plan.skipped).toEqual([{ reference: 'R2', reason: 'no-footprint' }])
    expect(commits).toHaveLength(0)
  })

  test('refuses as the sync does: no schematic, or a board to choose', async () => {
    expect(await createBoardAgent(fake({ design: null }).ctx).previewSync()).toMatchObject({
      error: 'no-schematic'
    })
    const two = fake({ boards: ['/p/a.kicad_pcb', '/p/b.kicad_pcb'] })
    expect(await createBoardAgent(two.ctx).previewSync()).toMatchObject({
      error: 'board-ambiguous'
    })
    const chosen = await createBoardAgent(two.ctx).previewSync('/p/b.kicad_pcb')
    expect('plan' in chosen && chosen.board).toBe('/p/b.kicad_pcb')
  })
})

// ---------------------------------------------------------------------------
// The item layer: a board with two placed parts, an outline and a ground pour
// ---------------------------------------------------------------------------

const part = (reference: string, x: number, nets: [string, string], uuid: string): string =>
  `(footprint "Resistor_SMD:R_0402_1005Metric"
    (layer "F.Cu")
    (uuid "${uuid}-0000-0000-0000-000000000000")
    (at ${x} 110)
    (property "Reference" "${reference}" (at 0 -1.17 0) (layer "F.SilkS") (uuid "${uuid}-0000-0000-0000-000000000001") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 1.17 0) (layer "F.Fab") (uuid "${uuid}-0000-0000-0000-000000000002") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd roundrect (at -0.485 0) (size 0.59 0.64) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net ${nets[0]}) (uuid "${uuid}-0000-0000-0000-000000000003"))
    (pad "2" smd roundrect (at 0.485 0) (size 0.59 0.64) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net ${nets[1]}) (uuid "${uuid}-0000-0000-0000-000000000004"))
  )`

const ZONE_ID = '55555555-0000-0000-0000-000000000001'

const ITEMS_BOARD = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (generator_version "8.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (34 "B.Paste" user) (35 "F.Paste" user) (36 "B.SilkS" user) (37 "F.SilkS" user) (38 "B.Mask" user) (39 "F.Mask" user) (44 "Edge.Cuts" user) (48 "B.Fab" user) (49 "F.Fab" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (net 1 "VCC")
  (net 2 "GND")
  (net 3 "SIG")
  ${part('R1', 120, ['1 "VCC"', '2 "GND"'], 'aaaaaaa1')}
  ${part('R2', 130, ['1 "VCC"', '3 "SIG"'], 'aaaaaaa2')}
  (gr_rect (start 100 100) (end 150 130) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") (uuid "66666666-0000-0000-0000-000000000001"))
  (zone (net 2) (net_name "GND") (layer "B.Cu") (uuid "${ZONE_ID}") (hatch edge 0.5)
    (connect_pads (clearance 0.5)) (min_thickness 0.25) (filled_areas_thickness no)
    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 100 100) (xy 150 100) (xy 150 130) (xy 100 130))))
)`

type Answer = Record<string, unknown>

const itemsFake = (): Fake & { run: (request: McpDesignRequest) => Promise<Answer> } => {
  const made = fake({ text: ITEMS_BOARD })
  const agent = createBoardAgent(made.ctx)
  return {
    ...made,
    run: async (request) => (await agent.dispatch(request as never)) as Answer
  }
}

const BOARD_NAME = 'psu.kicad_pcb'
const liveBoard = (made: Fake): KicadBoard => made.sessions.get('/p/psu.kicad_pcb')!.board()!

describe('items on a board: reads', () => {
  test('a query answers compact rows, filtered by kind and net', async () => {
    const { run } = itemsFake()
    const parts = await run({ kind: 'query-board-items', board: BOARD_NAME, itemKind: 'footprint' })
    expect((parts.items as Answer[]).map((row) => row.id)).toEqual(['R1', 'R2'])
    expect((parts.items as Answer[])[0]).toMatchObject({
      kind: 'footprint',
      libId: 'Resistor_SMD:R_0402_1005Metric',
      at: { x: 120, y: 110 },
      side: 'front'
    })
    const vcc = await run({ kind: 'query-board-items', board: BOARD_NAME, net: 'VCC' })
    expect((vcc.items as Answer[]).map((row) => row.id)).toEqual(['R1.1', 'R2.1'])
    const near = await run({
      kind: 'query-board-items',
      board: BOARD_NAME,
      itemKind: 'pad',
      near: { id: 'R2' },
      radius: 0.5
    })
    expect((near.items as Answer[]).map((row) => row.id)).toEqual(['R2.1', 'R2.2'])
  })

  test('a read opens nothing: a board no tab holds is read from its text', async () => {
    const made = itemsFake()
    await made.run({ kind: 'get-board-items', board: BOARD_NAME, ids: ['R1'] })
    expect(made.sessions.size).toBe(0)
  })

  test('a footprint record lists its pads with their nets and board positions', async () => {
    const { run } = itemsFake()
    const got = await run({ kind: 'get-board-items', board: BOARD_NAME, ids: ['R1', ZONE_ID] })
    const [footprint, zone] = got.items as Answer[]
    expect(footprint).toMatchObject({
      reference: 'R1',
      uuid: 'aaaaaaa1-0000-0000-0000-000000000000'
    })
    expect(footprint.pads).toEqual([
      {
        id: 'R1.1',
        number: '1',
        net: 'VCC',
        at: { x: 119.515, y: 110 },
        layers: expect.any(Array)
      },
      { id: 'R1.2', number: '2', net: 'GND', at: { x: 120.485, y: 110 }, layers: expect.any(Array) }
    ])
    expect(zone).toMatchObject({
      kind: 'zone',
      net: 'GND',
      layers: ['B.Cu'],
      padConnection: 'thermal'
    })
  })

  test('an id that names nothing is refused with candidates', async () => {
    const { run } = itemsFake()
    const answer = await run({ kind: 'get-board-items', board: BOARD_NAME, ids: ['R3'] })
    expect(answer).toMatchObject({ error: 'item-not-found' })
  })
})

describe('items on a board: writes', () => {
  test('a move is one undoable step that answers with the change, the checks and the stale pour', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { at: { x: 125, y: 115 }, angle: 90 },
      checks: true
    })
    expect(answer.changed).toEqual({ created: [], updated: ['R1'], deleted: [] })
    expect(answer.checks).toEqual({ new: expect.any(Array), resolved: expect.any(Array) })
    expect(typeof answer.unrouted).toBe('number')
    expect(answer.stale).toMatchObject({ fills: true })
    expect(String(answer.guidance)).toContain('board_refill')
    const session = made.sessions.get('/p/psu.kicad_pcb')!
    const r1 = session.board()!.footprints[0]
    expect([nmToMm(r1.position.x), nmToMm(r1.position.y), r1.position.angle]).toEqual([
      125, 115, 90
    ])
    expect(session.staleZones().has(ZONE_ID)).toBe(true)
    session.undo()
    expect(nmToMm(session.board()!.footprints[0].position.x)).toBe(120)
    expect(session.staleZones().size).toBe(0)
  })

  test('a write in a viewport moves its box round what changed, a deletion where it was', async () => {
    const made = fake({ text: ITEMS_BOARD })
    const viewports = createAgentViewports({ isOpen: () => true })
    made.ctx.viewports = viewports
    const agent = createBoardAgent(made.ctx)
    const run = async (request: McpDesignRequest): Promise<Answer> =>
      (await agent.dispatch(request as never)) as Answer
    const mine = viewports.open('/p/psu.kicad_pcb', 'Placing R1')
    const moved = await run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { at: { x: 125, y: 115 } },
      viewport: mine.id,
      action: 'Move R1 right'
    })
    expect(moved).toMatchObject({ viewport: mine.id, changed: { updated: ['R1'] } })
    expect(viewports.live()[0].label).toBe('Move R1 right')
    const frame = viewports.live()[0].frame!
    // R1's body, centered where it went, and a 2 mm margin round it.
    expect(frame.x + frame.width / 2).toBeCloseTo(125, 1)
    expect(frame.y + frame.height / 2).toBeCloseTo(115, 1)
    expect(frame.width).toBeGreaterThan(4)
    expect(frame.width).toBeLessThan(8)

    expect(
      await run({ kind: 'delete-board-items', board: BOARD_NAME, ids: ['R2'], viewport: mine.id })
    ).toMatchObject({ viewport: mine.id, changed: { deleted: ['R2'] } })
    const gone = viewports.live()[0].frame!
    expect(gone.x + gone.width / 2).toBeCloseTo(130, 1)

    const other = viewports.open('/p/other.kicad_pcb', 'Elsewhere')
    expect(
      await run({
        kind: 'update-board-item',
        board: BOARD_NAME,
        id: 'R1',
        record: { angle: 90 },
        viewport: other.id
      })
    ).toMatchObject({ error: 'invalid-args' })
    expect(liveBoard(made).footprints[0].position.angle).not.toBe(90)
  })

  test('a write runs no checks unless asked, and still says the fills are stale', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { at: { x: 125, y: 115 } }
    })
    expect(answer.changed).toEqual({ created: [], updated: ['R1'], deleted: [] })
    expect(answer).not.toHaveProperty('checks')
    expect(answer).not.toHaveProperty('unrouted')
    expect(answer.stale).toEqual({ fills: true })
    expect(String(answer.guidance)).toContain('board_check')
    // A later board_check with since answers with the burst's delta.
    const baseline = await made.run({ kind: 'check-board', board: BOARD_NAME })
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { at: { x: 130, y: 115 } }
    })
    const since = await made.run({
      kind: 'check-board',
      board: BOARD_NAME,
      since: baseline.revision as number
    })
    expect(since.since).toBe(baseline.revision)
    expect(since.checks).toEqual({ new: expect.any(Array), resolved: expect.any(Array) })
    expect(await made.run({ kind: 'check-board', board: BOARD_NAME, since: 9999 })).toMatchObject({
      error: 'check-baseline-not-found'
    })
  })

  test('tracks "follow" carries the ends on the pads as the D drag does, in one step; vias stay', async () => {
    const routed = ITEMS_BOARD.replace(
      '  (gr_rect',
      `  (segment (start 119.515 110) (end 119.515 105) (width 0.25) (layer "F.Cu") (net 1) (uuid "t-a"))
  (segment (start 119.515 105) (end 112 105) (width 0.25) (layer "F.Cu") (net 1) (uuid "t-b"))
  (via (at 112 105) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v-a"))
  (gr_rect`
    )
    const made = fake({ text: routed })
    const agent = createBoardAgent(made.ctx)
    const run = async (request: McpDesignRequest): Promise<Answer> =>
      (await agent.dispatch(request as never)) as Answer
    const ends = (): string[] =>
      liveBoard(made)
        .segments.flatMap((seg) => [seg.start, seg.end])
        .map((p) => `${nmToMm(p.x)},${nmToMm(p.y)}`)
    const before = ['119.515,110', '119.515,105', '119.515,105', '112,105']

    // Left alone by default.
    await run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { at: { x: 121, y: 110 } }
    })
    expect(ends()).toEqual(before)
    made.sessions.get('/p/psu.kicad_pcb')!.undo()

    const answer = await run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { at: { x: 122, y: 110 } },
      tracks: 'follow'
    })
    // Both tracks keep their nodes, reshaped: the last bend redrawn at 45 degrees.
    expect(answer.changed).toEqual({ created: [], updated: ['R1', 't-a', 't-b'], deleted: [] })
    expect(ends()).toEqual(['112,105', '116.515,105', '116.515,105', '121.515,110'])
    const via = liveBoard(made).vias[0]
    expect([nmToMm(via.position.x), nmToMm(via.position.y)]).toEqual([112, 105])
    // One undo step puts the part and its tracks back.
    made.sessions.get('/p/psu.kicad_pcb')!.undo()
    expect(ends()).toEqual(before)
    expect(nmToMm(liveBoard(made).footprints[0].position.x)).toBe(120)
  })

  test('tracks "follow" takes a footprint move, not a turn, and only on a footprint', async () => {
    const made = itemsFake()
    expect(
      await made.run({
        kind: 'update-board-item',
        board: BOARD_NAME,
        id: 'R1',
        record: { at: { x: 122, y: 110 }, angle: 90 },
        tracks: 'follow'
      })
    ).toMatchObject({ error: 'not-applicable' })
    expect(
      await made.run({
        kind: 'update-board-item',
        board: BOARD_NAME,
        id: '66666666-0000-0000-0000-000000000001',
        record: { locked: true },
        tracks: 'follow'
      })
    ).toMatchObject({ error: 'invalid-args' })
    expect(nmToMm(liveBoard(made).footprints[0].position.x)).toBe(120)
  })

  test('side flips a footprint to the back about its origin', async () => {
    const made = itemsFake()
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R2',
      record: { side: 'back' }
    })
    const r2 = liveBoard(made).footprints[1]
    expect(r2.layer).toBe('B.Cu')
    expect(nmToMm(r2.position.x)).toBe(130)
  })

  test('a locked part refuses a move unless the record unlocks it', async () => {
    const made = itemsFake()
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R2',
      record: { locked: true }
    })
    expect(liveBoard(made).footprints[1].footprint.locked).toBe(true)
    const refused = await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R2',
      record: { at: { x: 140, y: 110 } }
    })
    expect(refused).toMatchObject({ error: 'locked' })
    const moved = await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R2',
      record: { at: { x: 140, y: 110 }, locked: false }
    })
    expect(moved.changed).toMatchObject({ updated: ['R2'] })
  })

  test('a key the kind does not carry is refused and nothing is written', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { mirror: true }
    })
    expect(answer).toMatchObject({ error: 'not-applicable' })
    expect(made.sessions.get('/p/psu.kicad_pcb')!.canUndo()).toBe(false)
  })

  test('a track between pads takes their net and the net class width', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'create-board-item',
      board: BOARD_NAME,
      itemKind: 'track',
      record: { layer: 'F.Cu', points: ['R1.1', { x: 119.515, y: 105 }, 'R2.1'] }
    })
    expect((answer.changed as Answer).created).toHaveLength(2)
    const segments = liveBoard(made).segments
    expect(segments.map((segment) => segment.net)).toEqual([1, 1])
    expect(nmToMm(segments[0].width)).toBe(DEFAULT_NET_CLASSES[0].trackWidth)
    expect([nmToMm(segments[1].end.x), nmToMm(segments[1].end.y)]).toEqual([129.515, 110])
  })

  test('a track joining two nets is refused as a short', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'create-board-item',
      board: BOARD_NAME,
      itemKind: 'track',
      record: { layer: 'F.Cu', points: ['R1.2', 'R2.1'] }
    })
    expect(answer).toMatchObject({ error: 'net-conflict' })
    expect(liveBoard(made).segments).toEqual([])
  })

  test('a track to a pad with no copper on its layer is refused', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'create-board-item',
      board: BOARD_NAME,
      itemKind: 'track',
      record: { layer: 'B.Cu', points: ['R1.1', { x: 110, y: 110 }] }
    })
    expect(answer).toMatchObject({ error: 'refused' })
  })

  test('a via on a pad takes its net and the net class sizes', async () => {
    const made = itemsFake()
    await made.run({
      kind: 'create-board-item',
      board: BOARD_NAME,
      itemKind: 'via',
      record: { at: 'R2.2' }
    })
    const [via] = liveBoard(made).vias
    expect(via.net).toBe(3)
    expect(nmToMm(via.size)).toBe(DEFAULT_NET_CLASSES[0].viaDiameter)
    expect(via.layers).toEqual(['F.Cu', 'B.Cu'])
  })

  test('outline graphics take the editor defaults for their layer; an unknown net is named', async () => {
    const made = itemsFake()
    await made.run({
      kind: 'create-board-item',
      board: BOARD_NAME,
      itemKind: 'line',
      record: { layer: 'Edge.Cuts', start: { x: 100, y: 140 }, end: { x: 150, y: 140 } }
    })
    const line = liveBoard(made).grLines[0]
    expect(line.layer).toBe('Edge.Cuts')
    expect(nmToMm(line.strokeWidth!)).toBe(0.05)
    const zone = await made.run({
      kind: 'create-board-item',
      board: BOARD_NAME,
      itemKind: 'zone',
      record: {
        net: 'GNDD',
        layers: ['F.Cu'],
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 }
        ]
      }
    })
    expect(zone).toMatchObject({ error: 'net-not-found' })
    expect((zone.candidates as string[]) ?? []).toContain('GND')
  })

  test('a pad is not deleted on its own; a footprint is', async () => {
    const made = itemsFake()
    expect(
      await made.run({ kind: 'delete-board-items', board: BOARD_NAME, ids: ['R1.1'] })
    ).toMatchObject({ error: 'refused' })
    const gone = await made.run({ kind: 'delete-board-items', board: BOARD_NAME, ids: ['R1'] })
    expect(gone.changed).toEqual({ created: [], updated: [], deleted: ['R1'] })
    expect(liveBoard(made).footprints.map((fp) => fp.reference)).toEqual(['R2'])
  })
})

describe('undo and redo on a board', () => {
  const MOVE_R1 = 'pcbEditor.commands.moveFootprint {"reference":"R1"}'
  test('an undo takes back the last step, names it, and a redo puts it back', async () => {
    const made = itemsFake()
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { at: { x: 125, y: 115 } }
    })
    await made.run({ kind: 'delete-board-items', board: BOARD_NAME, ids: ['R2'] })
    const undone = await made.run({ kind: 'undo-board', board: BOARD_NAME, steps: 2 })
    expect(undone).toMatchObject({
      board: { name: 'psu.kicad_pcb' },
      undone: ['commandLabels.delete 1', MOVE_R1],
      changed: { created: ['R2'], updated: ['R1'], deleted: [] },
      next: { undo: null, redo: MOVE_R1 },
      revision: expect.any(Number)
    })
    expect(nmToMm(liveBoard(made).footprints[0].position.x)).toBe(120)
    const redone = await made.run({ kind: 'undo-board', board: BOARD_NAME, steps: 1, redo: true })
    expect(redone).toMatchObject({
      redone: [MOVE_R1],
      changed: { created: [], updated: ['R1'], deleted: [] }
    })
    expect(nmToMm(liveBoard(made).footprints[0].position.x)).toBe(125)
  })

  test('more steps than the list holds steps nothing', async () => {
    const made = itemsFake()
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { at: { x: 125, y: 115 } }
    })
    const answer = await made.run({ kind: 'undo-board', board: BOARD_NAME, steps: 2 })
    expect(answer).toMatchObject({ error: 'nothing-to-undo' })
    expect(String(answer.detail)).toContain('holds 1 step')
    expect(nmToMm(liveBoard(made).footprints[0].position.x)).toBe(125)
    expect(made.sessions.get('/p/psu.kicad_pcb')!.canRedo()).toBe(false)
  })

  test('a board no tab holds has nothing to undo, and opens nothing', async () => {
    const made = itemsFake()
    const answer = await made.run({ kind: 'undo-board', board: BOARD_NAME, steps: 1 })
    expect(answer).toMatchObject({ error: 'nothing-to-undo' })
    expect(made.sessions.size).toBe(0)
  })

  test('an undo in a viewport frames what it changed', async () => {
    const made = fake({ text: ITEMS_BOARD })
    const viewports = createAgentViewports({ isOpen: () => true })
    made.ctx.viewports = viewports
    const agent = createBoardAgent(made.ctx)
    const run = async (request: McpDesignRequest): Promise<Answer> =>
      (await agent.dispatch(request as never)) as Answer
    const mine = viewports.open('/p/psu.kicad_pcb', 'Undoing')
    await run({ kind: 'delete-board-items', board: BOARD_NAME, ids: ['R2'], viewport: mine.id })
    const undone = await run({ kind: 'undo-board', board: BOARD_NAME, steps: 1, viewport: mine.id })
    expect(undone).toMatchObject({ viewport: mine.id, changed: { created: ['R2'] } })
    const frame = viewports.live()[0].frame!
    expect(frame.x + frame.width / 2).toBeCloseTo(130, 1)
  })
})

describe('items on a board: pages, and deletes by filter', () => {
  const ids = (answer: Answer): string[] => (answer.items as Answer[]).map((row) => String(row.id))

  test('a capped query names its counts, and offset pinned to the revision reads on', async () => {
    const made = itemsFake()
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { angle: 90 }
    })
    const all = await made.run({ kind: 'query-board-items', board: BOARD_NAME, limit: 400 })
    expect(all.truncated).toBeUndefined()
    const first = await made.run({ kind: 'query-board-items', board: BOARD_NAME, limit: 3 })
    expect(first).toMatchObject({ count: 8, truncated: true, revision: expect.any(Number) })
    expect(String(first.guidance)).toContain('By kind: pad 4, footprint 2, rect 1, zone 1.')
    expect(String(first.guidance)).toContain(`offset 3 and revision ${first.revision}`)
    const pages = [first]
    while (pages[pages.length - 1].truncated)
      pages.push(
        await made.run({
          kind: 'query-board-items',
          board: BOARD_NAME,
          limit: 3,
          offset: pages.length * 3,
          revision: first.revision as number
        })
      )
    expect(pages.map((page) => page.offset)).toEqual([undefined, 3, 6])
    expect(pages.flatMap(ids)).toEqual(ids(all))
  })

  test('within the largest kind, the answer counts by layer and by net', async () => {
    const { run } = itemsFake()
    const pads = await run({
      kind: 'query-board-items',
      board: BOARD_NAME,
      itemKind: 'pad',
      limit: 1
    })
    expect(String(pads.guidance)).toContain('kind "pad" (4) by net: VCC 2, GND 1, SIG 1.')
    expect(String(pads.guidance)).not.toContain('By kind')
    expect(String(pads.guidance)).toContain('offset 1.')
  })

  test('a page pinned to a revision the board has left is refused', async () => {
    const made = itemsFake()
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { angle: 90 }
    })
    const first = await made.run({ kind: 'query-board-items', board: BOARD_NAME, limit: 3 })
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R2',
      record: { angle: 90 }
    })
    const next = await made.run({
      kind: 'query-board-items',
      board: BOARD_NAME,
      limit: 3,
      offset: 3,
      revision: first.revision as number
    })
    expect(next).toMatchObject({ error: 'revision-moved' })
  })

  test('a delete by filter is refused unless the match count is expect', async () => {
    const made = itemsFake()
    const wrong = await made.run({
      kind: 'delete-board-items',
      board: BOARD_NAME,
      itemKind: 'footprint',
      expect: 3
    })
    expect(wrong).toMatchObject({ error: 'count-mismatch' })
    expect(String(wrong.detail)).toContain('matches 2 items, not 3')
    expect(made.sessions.get('/p/psu.kicad_pcb')?.canUndo() ?? false).toBe(false)
  })

  test('a delete by filter takes every match as one undo step', async () => {
    const made = itemsFake()
    const gone = await made.run({
      kind: 'delete-board-items',
      board: BOARD_NAME,
      itemKind: 'footprint',
      box: { x: 100, y: 100, width: 50, height: 30 },
      expect: 2
    })
    expect(gone.changed).toEqual({ created: [], updated: [], deleted: ['R1', 'R2'] })
    expect(liveBoard(made).footprints).toEqual([])
    const session = made.sessions.get('/p/psu.kicad_pcb')!
    session.undo()
    expect(session.canUndo()).toBe(false)
    expect(liveBoard(made).footprints.map((fp) => fp.reference)).toEqual(['R1', 'R2'])
  })
})

describe('items on a board: record shapes that refuse', () => {
  const OUTLINE = [
    { x: 101, y: 101 },
    { x: 110, y: 101 },
    { x: 110, y: 110 }
  ]

  test('a keepout that is not a boolean is refused, with or without a net', async () => {
    const made = itemsFake()
    for (const net of [undefined, 'GND']) {
      const answer = await made.run({
        kind: 'create-board-item',
        board: BOARD_NAME,
        itemKind: 'zone',
        record: {
          layers: ['F.Cu'],
          points: OUTLINE,
          keepout: { tracks: true },
          ...(net ? { net } : {})
        }
      })
      expect(answer).toMatchObject({ error: 'keepout-shape' })
    }
    const update = await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: ZONE_ID,
      record: { keepout: 'yes' }
    })
    expect(update).toMatchObject({ error: 'keepout-shape' })
    expect(made.sessions.get('/p/psu.kicad_pcb')?.board()?.zones.length ?? 1).toBe(1)
  })

  test('a rule area takes rules and refuses pour settings; rules with keepout false are refused', async () => {
    const made = itemsFake()
    const area = await made.run({
      kind: 'create-board-item',
      board: BOARD_NAME,
      itemKind: 'zone',
      record: { layers: ['F.Cu'], points: OUTLINE, keepout: true, rules: { vias: 'not_allowed' } }
    })
    expect((area.changed as Answer).created).toHaveLength(1)
    const pour = await made.run({
      kind: 'create-board-item',
      board: BOARD_NAME,
      itemKind: 'zone',
      record: { layers: ['F.Cu'], points: OUTLINE, keepout: true, padConnection: 'solid' }
    })
    expect(pour).toMatchObject({ error: 'not-applicable' })
    const id = (area.changed as Answer as { created: string[] }).created[0]
    const back = await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id,
      record: { keepout: false, rules: { vias: 'allowed' } }
    })
    expect(back).toMatchObject({ error: 'not-applicable' })
    const islands = await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id,
      record: { islands: 'keep' }
    })
    expect(islands).toMatchObject({ error: 'not-applicable' })
  })

  test('<ref>#<field> reads the field where it sits on the board', async () => {
    const { run } = itemsFake()
    const got = await run({ kind: 'get-board-items', board: BOARD_NAME, ids: ['R1#Reference'] })
    expect((got.items as Answer[])[0]).toMatchObject({
      id: 'R1#Reference',
      kind: 'property',
      reference: 'R1',
      key: 'Reference',
      value: 'R1',
      at: { x: 120, y: 108.83 },
      angle: 0,
      layer: 'F.SilkS'
    })
  })

  test('a turned footprint: a field reads and writes in board coordinates, as the file keeps it', async () => {
    const turned = ITEMS_BOARD.replace('(at 120 110)', '(at 120 110 90)').replace(
      '(property "Reference" "R1" (at 0 -1.17 0)',
      '(property "Reference" "R1" (at 0 -1.17 90)'
    )
    const made = fake({ text: turned })
    const agent = createBoardAgent(made.ctx)
    const run = async (request: unknown): Promise<Answer> =>
      (await agent.dispatch(request as never)) as Answer
    const read = async (): Promise<Answer> =>
      (
        (await run({ kind: 'get-board-items', board: BOARD_NAME, ids: ['R1#Reference'] }))
          .items as Answer[]
      )[0]
    // Above the part in its own frame is left of it on the board, turned 90°.
    const before = await read()
    expect(before).toMatchObject({ at: { x: 118.83, y: 110 }, angle: 90 })
    const box = before.box as { x: number; y: number; width: number; height: number }
    expect(box.x + box.width / 2).toBeCloseTo(118.83, 4)
    expect(box.height).toBeGreaterThan(box.width)
    // The record read is the record written: nothing moves.
    await run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1#Reference',
      record: { at: before.at, angle: before.angle }
    })
    expect(await read()).toMatchObject({ at: { x: 118.83, y: 110 }, angle: 90 })
    await run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1#Reference',
      record: { at: { x: 121, y: 110 }, angle: 0 }
    })
    expect(await read()).toMatchObject({ at: { x: 121, y: 110 }, angle: 0 })
    // KiCad's file keeps the position in the footprint's frame and the angle on the board.
    const property = liveBoard(made).footprints[0].footprint.properties.find(
      (entry) => entry.key === 'Reference'
    )!
    expect(nmToMm(property.position!.x)).toBeCloseTo(0, 6)
    expect(nmToMm(property.position!.y)).toBeCloseTo(1, 6)
    expect(property.position!.angle).toBe(0)
  })

  test('a back-side footprint: a field reads its board layer and lands where it was sent', async () => {
    const made = itemsFake()
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R2',
      record: { side: 'back', angle: 30 }
    })
    const read = async (): Promise<Answer> =>
      (
        (await made.run({ kind: 'get-board-items', board: BOARD_NAME, ids: ['R2#Reference'] }))
          .items as Answer[]
      )[0]
    const before = await read()
    expect(before.layer).toBe('B.SilkS')
    // The board position is the GUI's: the stored offset through the placement.
    const placed = liveBoard(made).footprints[1]
    const stored = placed.footprint.properties.find((entry) => entry.key === 'Reference')!
    const onBoard = footprintPointOnBoard(placed, stored.position!)
    expect(before.at).toEqual({ x: nmToMm(onBoard.x), y: nmToMm(onBoard.y) })
    expect(before.angle).toBe(stored.position!.angle ?? 0)
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R2#Reference',
      record: { at: { x: 131.5, y: 112.25 }, angle: 210 }
    })
    expect(await read()).toMatchObject({
      at: { x: 131.5, y: 112.25 },
      angle: 210,
      layer: 'B.SilkS'
    })
    // The part itself stays put, and the write survives the text round trip.
    expect(nmToMm(liveBoard(made).footprints[1].position.x)).toBe(130)
    const reparsed = parseKicadBoard(serializeSExpr(liveBoard(made)._raw))
    const again = reparsed.footprints[1]
    const field = again.footprint.properties.find((entry) => entry.key === 'Reference')!
    const there = footprintPointOnBoard(again, field.position!)
    expect(nmToMm(there.x)).toBeCloseTo(131.5, 6)
    expect(nmToMm(there.y)).toBeCloseTo(112.25, 6)
  })

  test('<ref>#<field> writes the field as one step on the board', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1#Value',
      record: { value: '4k7' }
    })
    expect(answer.changed).toEqual({ created: [], updated: ['R1#Value'], deleted: [] })
    const session = made.sessions.get('/p/psu.kicad_pcb')!
    expect(liveBoard(made).footprints.map((fp) => fp.value)).toEqual(['4k7', '10k'])
    expect(nmToMm(liveBoard(made).footprints[0].position.x)).toBe(120)
    session.undo()
    expect(session.canUndo()).toBe(false)
    expect(liveBoard(made).footprints[0].value).toBe('10k')
  })

  test("a field write's change names only the board's own nodes, front and back", async () => {
    // The editor patches its scene from these; a node of the detached copy
    // among them sends it to a whole rebuild after every field write.
    const made = itemsFake()
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R2',
      record: { side: 'back' }
    })
    const live = made.sessions.get('/p/psu.kicad_pcb')!
    for (const id of ['R1#Reference', 'R2#Reference']) {
      const before = new Set((live.board()!._raw as SExprList).children)
      const answer = await made.run({
        kind: 'update-board-item',
        board: BOARD_NAME,
        id,
        record: { hidden: true, at: { x: 0.5, y: -1.5 } }
      })
      expect(answer.changed).toEqual({ created: [], updated: [id], deleted: [] })
      const after = new Set((live.board()!._raw as SExprList).children)
      const raws = [...live.lastChange()!.raws]
      expect(raws.length).toBeGreaterThan(0)
      expect(raws.filter((raw) => !before.has(raw) && !after.has(raw))).toEqual([])
    }
  })

  test('a field the footprint lacks is refused with its field ids', async () => {
    const { run } = itemsFake()
    const answer = await run({ kind: 'get-board-items', board: BOARD_NAME, ids: ['R1#Valu'] })
    expect(answer).toMatchObject({ error: 'item-not-found' })
    expect(answer.candidates).toEqual(['R1#Reference', 'R1#Value'])
  })

  test('a repeated id keeps its # suffix when the left side is no reference', async () => {
    const twice = ITEMS_BOARD.replace(
      '  (gr_rect',
      `  (gr_line (start 100 140) (end 150 140) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "77777777-0000-0000-0000-000000000001"))
  (gr_line (start 100 150) (end 150 150) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "77777777-0000-0000-0000-000000000001"))
  (gr_rect`
    )
    const agent = createBoardAgent(fake({ text: twice }).ctx)
    const got = (await agent.dispatch({
      kind: 'get-board-items',
      board: BOARD_NAME,
      ids: ['77777777-0000-0000-0000-000000000001#2']
    })) as Answer
    expect((got.items as Answer[])[0]).toMatchObject({ kind: 'line', start: { x: 100, y: 150 } })
  })
})

describe('check findings on a board', () => {
  // A VCC track 0.03 mm from R2's SIG pad: a clearance violation.
  const tooClose = {
    kind: 'create-board-item',
    board: BOARD_NAME,
    itemKind: 'track',
    record: {
      layer: 'F.Cu',
      net: 'VCC',
      width: 0.2,
      points: [
        { x: 130.2, y: 110.45 },
        { x: 133, y: 110.45 }
      ]
    }
  } as const

  const clearanceFinding = (rows: Answer[]): Answer => {
    const row = rows.find((entry) => entry.code === 'copper-clearance')!
    expect(row.findings).toHaveLength(1)
    return (row.findings as Answer[])[0]
  }

  test('a clearance violation answers its pair, location, layer and measure', async () => {
    const made = itemsFake()
    // A write opens the board's session, which a revision belongs to.
    await made.run({ kind: 'update-board-item', board: BOARD_NAME, id: 'R1', record: { angle: 0 } })
    const baseline = await made.run({ kind: 'check-board', board: BOARD_NAME })
    const wrote = await made.run({ ...tooClose, checks: true })
    const [track] = (wrote.changed as Answer).created as string[]
    const expected = {
      items: [track, 'R2.2'].sort(),
      at: { x: expect.any(Number), y: expect.any(Number) },
      layer: 'F.Cu',
      measure: { actual: 0.03, limit: 0.2, bound: 'min', unit: 'mm', rule: expect.any(String) }
    }
    // In the write's delta, the full check and the delta since a revision.
    expect(clearanceFinding((wrote.checks as { new: Answer[] }).new)).toMatchObject(expected)
    const full = await made.run({ kind: 'check-board', board: BOARD_NAME })
    const finding = clearanceFinding(full.checks as Answer[])
    expect(finding).toMatchObject(expected)
    const at = finding.at as { x: number; y: number }
    // Where the two meet, by R2.2 at (130.485, 110), beside the track.
    expect(Math.abs(at.x - 130.485)).toBeLessThan(0.4)
    expect(Math.abs(at.y - 110.2)).toBeLessThan(0.3)
    const since = await made.run({
      kind: 'check-board',
      board: BOARD_NAME,
      since: baseline.revision as number
    })
    expect(clearanceFinding((since.checks as { new: Answer[] }).new)).toMatchObject(expected)
  })

  test('a code asked for that found nothing answers its row at count 0', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'check-board',
      board: BOARD_NAME,
      codes: ['track-width']
    })
    expect(answer.checks).toEqual([
      { code: 'track-width', count: 0, items: [], rule: expect.any(String) }
    ])
  })

  test('every id a board check names reads back with items_get and explain_limits', async () => {
    const made = itemsFake()
    await made.run(tooClose)
    const full = await made.run({ kind: 'check-board', board: BOARD_NAME })
    const rows = full.checks as Answer[]
    const ids = [
      ...new Set(rows.flatMap((row) => (row.findings as Answer[]).flatMap((f) => f.items)))
    ] as string[]
    expect(ids.length).toBeGreaterThan(1)
    const got = await made.run({ kind: 'get-board-items', board: BOARD_NAME, ids })
    expect(got).not.toHaveProperty('error')
    const pair = clearanceFinding(rows).items as string[]
    const limits = await made.run({ kind: 'explain-board-limits', board: BOARD_NAME, items: pair })
    expect(limits).not.toHaveProperty('error')
    // A field, as a silk finding names it, resolves there too and has no limits.
    const field = await made.run({
      kind: 'explain-board-limits',
      board: BOARD_NAME,
      items: ['R1#Reference']
    })
    expect(field).toMatchObject({ error: 'invalid-args', detail: expect.stringContaining('field') })
  })
})

describe('board.batch', () => {
  const moves = (x: number): McpDesignRequest[] => [
    { kind: 'update-board-item', board: '(batch)', id: 'R1', record: { at: { x, y: 115 } } },
    { kind: 'update-board-item', board: '(batch)', id: 'R2', record: { at: { x: x + 10, y: 115 } } }
  ]

  test('lands every entry as one step, reads seeing the writes before them', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'batch-board',
      ops: [...moves(105), { kind: 'get-board-items', board: '(batch)', ids: ['R2'] }]
    })
    expect((answer.changed as Answer).updated).toEqual(['R1', 'R2'])
    const read = (answer.results as Answer[])[2] as { items: Answer[] }
    expect(read.items[0].at).toEqual({ x: 115, y: 115 })
    const session = made.sessions.get('/p/psu.kicad_pcb')!
    session.undo()
    expect(session.canUndo()).toBe(false)
    expect(liveBoard(made).footprints.map((fp) => nmToMm(fp.position.x))).toEqual([120, 130])
  })

  test('a refused entry writes nothing and names its index', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'batch-board',
      ops: [
        ...moves(105),
        { kind: 'update-board-item', board: '(batch)', id: 'R9', record: { angle: 90 } }
      ]
    })
    expect(answer).toMatchObject({ error: 'item-not-found' })
    expect(String(answer.detail)).toContain('Operation 2')
    expect(liveBoard(made).footprints.map((fp) => nmToMm(fp.position.x))).toEqual([120, 130])
    expect(made.sessions.get('/p/psu.kicad_pcb')!.canUndo()).toBe(false)
  })

  test('a dry run answers the delta and leaves the board as it was', async () => {
    const made = itemsFake()
    const answer = await made.run({ kind: 'batch-board', ops: moves(105), dryRun: true })
    expect(answer.dryRun).toBe(true)
    expect(answer.stale).toMatchObject({ fills: true })
    expect(liveBoard(made).footprints.map((fp) => nmToMm(fp.position.x))).toEqual([120, 130])
    expect(made.sessions.get('/p/psu.kicad_pcb')!.staleZones().size).toBe(0)
  })

  test('refill: true pours every zone in the same undo step', async () => {
    const made = itemsFake()
    const answer = await made.run({ kind: 'batch-board', ops: moves(105), refill: true })
    expect(answer.refill).toMatchObject({ counts: { refilled: 1 } })
    expect(answer.stale).toBeUndefined()
    expect(liveBoard(made).zones[0].filledPolys.length).toBeGreaterThan(0)
    const session = made.sessions.get('/p/psu.kicad_pcb')!
    session.undo()
    expect(session.canUndo()).toBe(false)
    expect(liveBoard(made).zones[0].filledPolys).toEqual([])
  })
})

describe('items.transform on a board', () => {
  test('a turn of two parts is one step, labeled as the editor labels it, leaving the fills stale', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'transform-board-items',
      board: BOARD_NAME,
      transform: 'rotate',
      ids: ['R1', 'R2'],
      angle: 90
    })
    expect(answer.changed).toEqual({ created: [], updated: ['R1', 'R2'], deleted: [] })
    expect(answer.stale).toMatchObject({ fills: true })
    const session = made.sessions.get('/p/psu.kicad_pcb')!
    expect(session.undoLabel()).toBe('pcbEditor.commands.rotateFootprints 2')
    expect(liveBoard(made).footprints.map((fp) => fp.position.angle)).toEqual([90, 90])
    session.undo()
    expect(liveBoard(made).footprints.map((fp) => fp.position.angle ?? 0)).toEqual([0, 0])
  })

  test('a batch holds a duplicate, and a later entry reads the copy', async () => {
    const made = itemsFake()
    const answer = await made.run({
      kind: 'batch-board',
      ops: [
        {
          kind: 'transform-board-items',
          board: '(batch)',
          transform: 'duplicate',
          ids: ['R2'],
          by: { x: 0, y: 5 }
        },
        { kind: 'get-board-items', board: '(batch)', ids: ['R3'] }
      ]
    })
    expect((answer.changed as Answer).created).toEqual(['R3'])
    const read = (answer.results as Answer[])[1] as { items: Answer[] }
    expect(read.items[0].at).toEqual({ x: 130, y: 115 })
  })
})

describe('board.refill and the stale fills', () => {
  test('stale fills are named by reads and checks until refilled', async () => {
    const made = itemsFake()
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { at: { x: 110, y: 120 } }
    })
    const described = await made.run({ kind: 'describe-board' })
    expect(described.stale).toEqual({ fills: true })
    const checked = await made.run({ kind: 'check-board' })
    expect(checked.stale).toMatchObject({ fills: true })
    const zones = await made.run({ kind: 'query-board-items', board: BOARD_NAME, itemKind: 'zone' })
    expect((zones.items as Answer[])[0].stale).toBe(true)

    const refilled = await made.run({ kind: 'refill-board' })
    expect(refilled.counts).toEqual({ refilled: 1 })
    expect(refilled.stale).toBeUndefined()
    expect(typeof refilled.ms).toBe('number')
    const after = await made.run({ kind: 'describe-board' })
    expect(after.stale).toBeUndefined()
  })

  test('with nothing stale it still refills every zone', async () => {
    const made = itemsFake()
    const answer = await made.run({ kind: 'refill-board' })
    expect(answer.counts).toEqual({ refilled: 1 })
    expect(made.sessions.get('/p/psu.kicad_pcb')!.canUndo()).toBe(true)
  })
})

describe('describe-board since', () => {
  test('answers only the footprints that moved since a revision', async () => {
    const made = itemsFake()
    await made.run({ kind: 'update-board-item', board: BOARD_NAME, id: 'R2', record: { angle: 0 } })
    const first = await made.run({ kind: 'describe-board' })
    await made.run({
      kind: 'update-board-item',
      board: BOARD_NAME,
      id: 'R1',
      record: { at: { x: 111, y: 111 } }
    })
    const diff = await made.run({ kind: 'describe-board', since: first.revision as number })
    expect(diff.footprints).toEqual({
      created: [],
      updated: [expect.objectContaining({ reference: 'R1', at: { x: 111, y: 111 }, angle: 0 })],
      deleted: []
    })
    expect(diff.counts).toBeUndefined()
    const lost = await made.run({ kind: 'describe-board', since: 9999 })
    expect(lost.sinceUnavailable).toContain('9999')
  })
})

describe('board setup', () => {
  const PROJECT = JSON.stringify(
    { board: { design_settings: {} }, net_settings: { classes: [] } },
    null,
    2
  )

  const setupFake = (
    project: string | null = PROJECT
  ): Fake & { run: (request: Record<string, unknown>) => Promise<Answer> } => {
    const made = fake({ text: ITEMS_BOARD, ...(project === null ? {} : { project }) })
    const agent = createBoardAgent(made.ctx)
    return {
      ...made,
      run: async (request: Record<string, unknown>) =>
        (await agent.dispatch(request as never)) as Answer
    }
  }

  test('reads the sections asked for, in the shape the update takes', async () => {
    const { run } = setupFake()
    const answer = await run({ kind: 'get-board-setup', sections: ['stackup', 'constraints'] })
    expect(Object.keys(answer)).toEqual(
      expect.arrayContaining(['stackup', 'constraints', 'project'])
    )
    expect(answer.netClasses).toBeUndefined()
    expect((answer.stackup as Answer).copperLayers).toBe(2)
    expect((answer.constraints as Answer).minClearance).toBeGreaterThan(0)
  })

  test('four copper layers: the inner layers exist, as one undo step, and every pour goes stale', async () => {
    const made = setupFake()
    const answer = await made.run({
      kind: 'update-board-setup',
      changes: { stackup: { copperLayers: 4 } }
    })
    expect(answer.sections).toMatchObject({ stackup: expect.arrayContaining(['copperLayers']) })
    expect(answer.stale).toMatchObject({ fills: true })
    const board = liveBoard(made)
    expect(board.layers.map((layer) => layer.name)).toEqual(
      expect.arrayContaining(['In1.Cu', 'In2.Cu'])
    )
    made.sessions.get('/p/psu.kicad_pcb')!.undo()
    expect(liveBoard(made).layers.map((layer) => layer.name)).not.toContain('In1.Cu')
  })

  test('constraints go to the project file, with every value they replaced', async () => {
    const made = setupFake()
    const answer = await made.run({
      kind: 'update-board-setup',
      changes: { constraints: { minClearance: 0.3 }, severities: { track_dangling: 'ignore' } }
    })
    expect(answer.written).toBe('/p/psu.kicad_pro')
    expect(answer.before).toMatchObject({
      constraints: { minClearance: DEFAULT_DESIGN_RULES.minClearance },
      severities: { track_dangling: 'warning' }
    })
    const project = JSON.parse(made.texts.get('/p/psu.kicad_pro')!)
    expect(project.board.design_settings.rules.min_clearance).toBe(0.3)
    expect(project.board.design_settings.rule_severities.track_dangling).toBe('ignore')
    expect(answer.stale).toMatchObject({ fills: true })
    const read = await made.run({ kind: 'get-board-setup', sections: ['constraints'] })
    expect((read.constraints as Answer).minClearance).toBe(0.3)
  })

  test("tuning profiles and the tuners' defaults alone still reach the project file", async () => {
    const made = setupFake()
    const answer = await made.run({
      kind: 'update-board-setup',
      changes: {
        tuningPatterns: { single: { spacing: 0.8 } },
        tuningProfiles: {
          upsert: [{ name: 'RF_50', targetImpedance: 50, layers: [{ layer: 'F.Cu', width: 0.3 }] }]
        }
      }
    })
    expect(answer.written).toBe('/p/psu.kicad_pro')
    const project = JSON.parse(made.texts.get('/p/psu.kicad_pro')!)
    expect(
      project.board.design_settings.tuning_pattern_settings.single_track_defaults.spacing
    ).toBe(0.8)
    expect(project.tuning_profiles.tuning_profiles_impedance_geometric[0]).toMatchObject({
      profile_name: 'RF_50',
      target_impedance: 50,
      layer_entries: [{ signal_layer: 'F.Cu', width: 300000 }]
    })
    const read = await made.run({ kind: 'get-board-setup', sections: ['tuningProfiles'] })
    expect(read.tuningProfiles).toMatchObject([{ name: 'RF_50', type: 'single' }])
  })

  test('an interface preset plans for the nets named, and writes the project', async () => {
    const made = setupFake()
    const request = {
      kind: 'apply-interface-preset',
      preset: 'rf-50',
      netClass: 'RF',
      patterns: ['SIG']
    }
    const dry = await made.run({ ...request, dryRun: true })
    expect(dry).toMatchObject({ dryRun: true, nets: ['SIG'], netClass: 'RF' })
    expect(made.texts.get('/p/psu.kicad_pro')).toBe(PROJECT)
    const answer = await made.run(request)
    // An RF feed has no rules, so the rules file is left alone.
    expect(answer.written).toEqual(['/p/psu.kicad_pro'])
    const project = JSON.parse(made.texts.get('/p/psu.kicad_pro')!)
    expect(project.tuning_profiles.tuning_profiles_impedance_geometric[0].profile_name).toBe('RF')
    expect(project.net_settings.netclass_patterns).toContainEqual({
      netclass: 'RF',
      pattern: 'SIG'
    })
    // A pair preset on a net with no partner is refused, naming it.
    expect(
      await made.run({ ...request, preset: 'usb2', netClass: 'USB', patterns: ['SIG'] })
    ).toMatchObject({ error: 'invalid-record', candidates: ['SIG'] })
  })

  test('a dry run answers the same and writes nothing', async () => {
    const made = setupFake()
    const answer = await made.run({
      kind: 'update-board-setup',
      changes: { stackup: { copperLayers: 4 }, constraints: { minClearance: 0.3 } },
      dryRun: true
    })
    expect(answer.dryRun).toBe(true)
    expect(made.texts.get('/p/psu.kicad_pro')).toBe(PROJECT)
    expect(liveBoard(made).layers.map((layer) => layer.name)).not.toContain('In1.Cu')
  })

  test('a board with no project keeps its stackup editable and refuses the rest', async () => {
    const made = setupFake(null)
    expect(
      await made.run({
        kind: 'update-board-setup',
        changes: { constraints: { minClearance: 0.3 } }
      })
    ).toMatchObject({ error: 'no-project-file' })
    const answer = await made.run({
      kind: 'update-board-setup',
      changes: { general: { paper: 'A3' } }
    })
    expect(answer.sections).toEqual({ general: ['paper'] })
    expect(liveBoard(made).paper).toBe('A3')
  })
})

describe('render-board layers', () => {
  test('draws only the layers named, and refuses one the board lacks', async () => {
    const { ctx, captures } = fake({ text: ITEMS_BOARD })
    const agent = createBoardAgent(ctx)
    const answer = (await agent.dispatch({
      kind: 'render-board',
      maxPixels: 800,
      layers: ['B.Cu', 'Edge.Cuts']
    })) as Answer
    expect(captures[0].layers).toEqual(['B.Cu', 'Edge.Cuts'])
    expect(answer.layers).toEqual(['B.Cu', 'Edge.Cuts'])
    expect(
      await agent.dispatch({ kind: 'render-board', maxPixels: 800, layers: ['In7.Cu'] })
    ).toMatchObject({ error: 'layer-not-found' })
  })

  test('expands a preset against the board and answers the layers it drew', async () => {
    const { ctx, captures } = fake({ text: ITEMS_BOARD })
    const answer = (await createBoardAgent(ctx).dispatch({
      kind: 'render-board',
      maxPixels: 800,
      preset: 'copper'
    })) as Answer
    expect(captures[0].layers).toEqual(['F.Cu', 'B.Cu', 'Edge.Cuts'])
    expect(captures[0]).not.toHaveProperty('fills')
    expect(answer).toMatchObject({ preset: 'copper', layers: ['F.Cu', 'B.Cu', 'Edge.Cuts'] })
  })

  test('the all preset draws every layer', async () => {
    const { ctx, captures } = fake({ text: ITEMS_BOARD })
    await createBoardAgent(ctx).dispatch({ kind: 'render-board', maxPixels: 800, preset: 'all' })
    expect(captures[0].layers).toBeUndefined()
  })

  test('puts the active layer on top at the dim asked for, and fills pours on request', async () => {
    const { ctx, captures } = fake({ text: ITEMS_BOARD })
    const agent = createBoardAgent(ctx)
    await agent.dispatch({
      kind: 'render-board',
      maxPixels: 800,
      preset: 'copper',
      activeLayer: 'B.Cu',
      dim: 0.2,
      fills: true
    })
    expect(captures[0]).toMatchObject({ activeLayer: 'B.Cu', dim: 0.2, fills: true })
    expect(
      await agent.dispatch({
        kind: 'render-board',
        maxPixels: 800,
        preset: 'front',
        activeLayer: 'B.Cu'
      })
    ).toMatchObject({ error: 'invalid-args' })
    expect(
      await agent.dispatch({
        kind: 'render-board',
        maxPixels: 800,
        preset: 'all',
        activeLayer: 'In7.Cu'
      })
    ).toMatchObject({ error: 'layer-not-found' })
  })
})

/**
 * A 3×3 BGA at 1.27 mm with 0.6 mm balls, one net a ball, inside an outline;
 * J1 has a pad on each net, so every ball has somewhere to go.
 */
const BGA_BOARD = (() => {
  const nets: string[] = ['(net 0 "")']
  const pads: string[] = []
  const partner: string[] = []
  for (let r = 0; r < 3; r += 1)
    for (let c = 0; c < 3; c += 1) {
      const n = r * 3 + c + 1
      nets.push(`(net ${n} "N${n}")`)
      pads.push(
        `(pad "${'ABC'[r]}${c + 1}" smd circle (at ${(c - 1) * 1.27} ${(r - 1) * 1.27}) (size 0.6 0.6) (layers "F.Cu" "F.Paste" "F.Mask") (net ${n} "N${n}"))`
      )
      partner.push(
        `(pad "${n}" smd rect (at ${(n - 5) * 1.27} 0) (size 0.6 0.6) (layers "F.Cu" "F.Paste" "F.Mask") (net ${n} "N${n}"))`
      )
    }
  return BOARD.replace('(net 0 "")', nets.join(' ')).replace(
    '  (gr_line',
    `  (footprint "Package_BGA:Test" (layer "F.Cu") (uuid "u1") (at 120 120)
    (property "Reference" "U1" (at 0 -3 0) (layer "F.SilkS") (uuid "u1-r"))
    ${pads.join('\n    ')})
  (footprint "Connector:Test" (layer "F.Cu") (uuid "j1") (at 120 130)
    (property "Reference" "J1" (at 0 -2 0) (layer "F.SilkS") (uuid "j1-r"))
    ${partner.join('\n    ')})
  (gr_line`
  )
})()

describe('fanout on a board', () => {
  const fanoutFake = (): Fake & { run: (request: McpDesignRequest) => Promise<Answer> } => {
    const made = fake({ text: BGA_BOARD })
    const agent = createBoardAgent(made.ctx)
    return { ...made, run: async (request) => (await agent.dispatch(request as never)) as Answer }
  }

  test('a dry run answers the fanout and writes nothing', async () => {
    const made = fanoutFake()
    const answer = await made.run({ kind: 'fanout-board', footprint: 'U1', dryRun: true })
    expect(answer).toMatchObject({
      dryRun: true,
      footprint: 'U1',
      layout: 'grid',
      style: 'dogbone',
      counts: { vias: 9, tracks: 9 },
      changed: { created: [], updated: [], deleted: [] }
    })
    const [first] = answer.escapes as Answer[]
    expect(first).not.toHaveProperty('via')
    expect(liveBoard(made).vias).toEqual([])
  })

  test('each via answers by the id items_get takes, in one undoable step', async () => {
    const made = fanoutFake()
    const answer = await made.run({ kind: 'fanout-board', footprint: 'U1', checks: true })
    const escapes = answer.escapes as Answer[]
    expect(escapes).toHaveLength(9)
    expect((answer.changed as Answer).created).toHaveLength(18)
    expect(answer.counts).toEqual({ vias: 9, tracks: 9 })
    const board = liveBoard(made)
    expect(board.vias).toHaveLength(9)
    expect(board.segments).toHaveLength(9)
    const a1 = escapes.find((row) => row.pad === 'U1.A1')!
    expect(a1).toMatchObject({ net: 'N1', at: { x: 118.095, y: 118.095 }, layer: 'F.Cu' })
    const read = await made.run({
      kind: 'get-board-items',
      board: BOARD_NAME,
      ids: [a1.via as string]
    })
    expect((read.items as Answer[])[0]).toMatchObject({ kind: 'via', net: 'N1' })
    // A new via is dangling until it is routed, and the delta says so.
    expect(JSON.stringify(answer.checks)).toContain('via-dangling')
    const session = made.sessions.get('/p/psu.kicad_pcb')!
    session.undo()
    expect(session.board()!.vias).toEqual([])
  })

  test('what is not a footprint, or a pad it does not have, is named', async () => {
    const made = fanoutFake()
    expect(await made.run({ kind: 'fanout-board', footprint: 'U9' })).toMatchObject({
      error: 'item-not-found'
    })
    expect(await made.run({ kind: 'fanout-board', footprint: 'U1.A1' })).toMatchObject({
      error: 'not-applicable'
    })
    expect(
      await made.run({ kind: 'fanout-board', footprint: 'U1', pads: ['U1.Z9'] })
    ).toMatchObject({ error: 'pad-not-found', candidates: expect.arrayContaining(['U1.A1']) })
  })
})

describe('place-footprint-board', () => {
  const placeFake = (): Fake & { run: (request: McpDesignRequest) => Promise<Answer> } => {
    const made = fake()
    const agent = createBoardAgent(made.ctx)
    return { ...made, run: async (request) => (await agent.dispatch(request as never)) as Answer }
  }

  test('lands the footprint annotated and board-only, in one undoable step', async () => {
    const made = placeFake()
    const before = parseKicadBoard(BOARD).footprints.length
    const answer = await made.run({
      kind: 'place-footprint-board',
      footprint: 'Resistor_SMD:R_0402_1005Metric',
      at: { x: 30, y: 40 },
      angle: 90
    })
    expect(answer).toMatchObject({
      changed: { created: ['R1'], updated: [], deleted: [] },
      placed: {
        id: 'R1',
        reference: 'R1',
        libId: 'Resistor_SMD:R_0402_1005Metric',
        at: { x: 30, y: 40 },
        angle: 90,
        side: 'front',
        pads: [
          expect.objectContaining({ id: 'R1.1', number: '1' }),
          expect.objectContaining({ id: 'R1.2', number: '2' })
        ]
      }
    })
    expect(typeof answer.revision).toBe('number')
    const board = liveBoard(made)
    expect(board.footprints).toHaveLength(before + 1)
    const placed = board.footprints.find((footprint) => footprint.reference === 'R1')!
    expect(placed.libId).toBe('Resistor_SMD:R_0402_1005Metric')
    expect(placed.position).toMatchObject({ x: 30_000_000, y: 40_000_000, angle: 90 })
    expect(placed.footprint.attributes).toContain('board_only')
    made.sessions.get('/p/psu.kicad_pcb')!.undo()
    expect(liveBoard(made).footprints).toHaveLength(before)
  })

  test('side "back" flips it as the editor does, and the record reads what was asked', async () => {
    const made = placeFake()
    const answer = await made.run({
      kind: 'place-footprint-board',
      footprint: 'Resistor_SMD:R_0402_1005Metric',
      at: { x: 30, y: 40 },
      angle: 90,
      side: 'back'
    })
    expect(answer.placed).toMatchObject({
      reference: 'R1',
      side: 'back',
      at: { x: 30, y: 40 },
      angle: 90
    })
    const placed = liveBoard(made).footprints.find((footprint) => footprint.reference === 'R1')!
    expect(placed.layer).toBe('B.Cu')
    const read = await made.run({ kind: 'get-board-items', board: BOARD_NAME, ids: ['R1'] })
    const record = (read.items as Answer[])[0]
    expect(record).toMatchObject({ side: 'back', angle: (answer.placed as Answer).angle })
  })

  test('a board batch places footprints with item edits, as one step', async () => {
    const made = placeFake()
    const before = parseKicadBoard(BOARD).footprints.length
    const answer = await made.run({
      kind: 'batch-board',
      ops: [
        {
          kind: 'place-footprint-board',
          board: '(batch)',
          footprint: 'Resistor_SMD:R_0402_1005Metric',
          at: { x: 10, y: 10 }
        },
        {
          kind: 'place-footprint-board',
          board: '(batch)',
          footprint: 'Resistor_SMD:R_0402_1005Metric',
          at: { x: 20, y: 10 }
        },
        { kind: 'update-board-item', board: '(batch)', id: 'R2', record: { angle: 90 } }
      ]
    })
    expect(answer.changed).toEqual({ created: ['R1', 'R2'], updated: ['R2'], deleted: [] })
    expect(answer.results).toMatchObject([
      { changed: { created: ['R1'] }, placed: { reference: 'R1' } },
      { changed: { created: ['R2'] }, placed: { reference: 'R2' } },
      { changed: { updated: ['R2'] } }
    ])
    expect(typeof answer.revision).toBe('number')
    expect(liveBoard(made).footprints).toHaveLength(before + 2)
    made.sessions.get('/p/psu.kicad_pcb')!.undo()
    expect(liveBoard(made).footprints).toHaveLength(before)
    const refused = await made.run({
      kind: 'batch-board',
      ops: [
        {
          kind: 'place-footprint-board',
          board: '(batch)',
          footprint: 'Resistor_SMD:R_0402_1005Metric',
          at: { x: 10, y: 10 }
        },
        {
          kind: 'place-footprint-board',
          board: '(batch)',
          footprint: 'Nope:Nothing',
          at: { x: 20, y: 10 }
        }
      ]
    })
    expect(refused).toMatchObject({ error: 'unknown-footprint' })
    expect(String(refused.detail)).toMatch(/^Operation 1 \(`board.place_footprint`\):/)
  })

  test('a dry run names the reference and writes nothing; an unknown footprint or a taken reference is refused', async () => {
    const made = placeFake()
    const before = parseKicadBoard(BOARD).footprints.length
    expect(
      await made.run({
        kind: 'place-footprint-board',
        footprint: 'Resistor_SMD:R_0402_1005Metric',
        at: { x: 0, y: 0 },
        dryRun: true
      })
    ).toMatchObject({
      dryRun: true,
      changed: { created: ['R1'] },
      placed: { reference: 'R1' },
      revision: expect.any(Number)
    })
    expect(liveBoard(made).footprints).toHaveLength(before)
    expect(
      await made.run({
        kind: 'place-footprint-board',
        footprint: 'Nope:Nothing',
        at: { x: 0, y: 0 }
      })
    ).toMatchObject({ error: 'unknown-footprint' })
    await made.run({
      kind: 'place-footprint-board',
      footprint: 'Resistor_SMD:R_0402_1005Metric',
      at: { x: 0, y: 0 },
      reference: 'R7'
    })
    expect(
      await made.run({
        kind: 'place-footprint-board',
        footprint: 'Resistor_SMD:R_0402_1005Metric',
        at: { x: 5, y: 0 },
        reference: 'R7'
      })
    ).toMatchObject({ error: 'reference-taken' })
  })
})

describe('update-footprints-board', () => {
  const agentFake = (
    options: Parameters<typeof fake>[0] = {}
  ): Fake & { run: (request: McpDesignRequest) => Promise<Answer> } => {
    const made = fake(options)
    const agent = createBoardAgent(made.ctx)
    return { ...made, run: async (request) => (await agent.dispatch(request as never)) as Answer }
  }

  test('rebuilds a footprint from its library where it sits, in one undoable step', async () => {
    const made = agentFake({ text: PLACED })
    const answer = await made.run({ kind: 'update-footprints-board', references: ['R1'] })
    expect(answer.changed).toEqual({ created: [], updated: ['R1'], deleted: [] })
    expect(answer.footprints).toMatchObject([
      { reference: 'R1', from: 'Resistor_SMD:R_0402_1005Metric', droppedPads: [] }
    ])
    const r1 = liveBoard(made).footprints.find((fp) => fp.reference === 'R1')!
    // The library's second pad arrives; the place stays.
    expect(r1.footprint.pads.map((pad) => pad.number)).toEqual(['1', '2'])
    expect(r1.position).toMatchObject({ x: 120_000_000, y: 110_000_000 })
    made.sessions.get('/p/psu.kicad_pcb')!.undo()
    const undone = liveBoard(made).footprints.find((fp) => fp.reference === 'R1')!
    expect(undone.footprint.pads).toHaveLength(1)
  })

  test('changes a board-only footprint; a symbol’s is refused and pointed at its Footprint field', async () => {
    const made = agentFake()
    await made.run({
      kind: 'place-footprint-board',
      footprint: 'Resistor_SMD:R_0402_1005Metric',
      at: { x: 0, y: 0 },
      reference: 'R9'
    })
    expect(
      await made.run({
        kind: 'update-footprints-board',
        references: ['R9'],
        footprint: 'Resistor_SMD:R_0402_1005Metric',
        dryRun: true
      })
    ).toMatchObject({
      dryRun: true,
      changed: { updated: ['R9'] },
      footprints: [{ reference: 'R9' }]
    })
    const owned = agentFake({
      text: PLACED.replace('(at 120 110)', '(at 120 110)\n    (path "/aaaa")')
    })
    expect(
      await owned.run({
        kind: 'update-footprints-board',
        references: ['R1'],
        footprint: 'Resistor_SMD:R_0402_1005Metric'
      })
    ).toMatchObject({ error: 'refused' })
    expect(await owned.run({ kind: 'update-footprints-board', references: ['R5'] })).toMatchObject({
      error: 'reference-not-found',
      candidates: ['R1']
    })
    expect(
      await owned.run({ kind: 'update-footprints-board', match: 'Nope:Nothing' })
    ).toMatchObject({ error: 'nothing-to-update', candidates: ['Resistor_SMD:R_0402_1005Metric'] })
  })
})

/** Two SIG pads, A1.1 at (110, 110) and B1.1 at (130, 110), and `extra`. */
const ROUTE_BOARD = (extra = ''): string =>
  BOARD.replace('(net 0 "")', '(net 0 "") (net 1 "SIG") (net 2 "OBS")').replace(
    '  (gr_line',
    `  (footprint "T:A" (layer "F.Cu") (uuid "fa") (at 110 110)
    (property "Reference" "A1" (at 0 -2 0) (layer "F.SilkS") (uuid "fa-r"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG") (uuid "fa-p")))
  (footprint "T:B" (layer "F.Cu") (uuid "fb") (at 130 110)
    (property "Reference" "B1" (at 0 -2 0) (layer "F.SilkS") (uuid "fb-r"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG") (uuid "fb-p")))
  ${extra}
  (gr_line`
  )

/** A net-2 track across the way between the pads. */
const WALL =
  '(segment (start 120 100) (end 120 120) (width 0.25) (layer "F.Cu") (net 2) (uuid "wall"))'

describe('routing sessions', () => {
  interface Shown {
    shows: number
    overlays: number
    /** What each overlay drew over the board. */
    drawn: RouteOverlay[]
    captures: Array<{ box: unknown; maxPixels: number }>
  }
  /** A routing request; a begin without a viewport routes in the fake's first live one. */
  type RouteRequest = McpDesignRequest | Omit<McpBeginRouteRequest, 'viewport'>
  const routeFake = (
    text = ROUTE_BOARD(),
    project?: string
  ): Fake & {
    run: (request: RouteRequest) => Promise<Answer>
    shown: Shown
    viewports: ReturnType<typeof createAgentViewports>
    /** What the canvases were shown, each time it changed. */
    views: AgentViewportShown[][]
  } => {
    const made = fake({ text, ...(project !== undefined ? { project } : {}) })
    const shown: Shown = { shows: 0, overlays: 0, drawn: [], captures: [] }
    const views: AgentViewportShown[][] = []
    const viewports = createAgentViewports({
      isOpen: () => true,
      show: (list) => void views.push([...list])
    })
    made.ctx.viewports = viewports
    made.ctx.routerPrefs = () => ({ mode: 'walkaround' })
    made.ctx.gridSpacing = () => 0.25
    made.ctx.routeScene = () => ({
      show: () => void shown.shows++,
      overlay: (overlay) => {
        shown.overlays++
        shown.drawn.push(overlay)
      },
      capture: async (box, maxPixels) => {
        shown.captures.push({ box, maxPixels })
        return SHOT
      },
      tile: async (shots) => ({
        dataUrl: shots[0].dataUrl,
        width: 2 * shots[0].width,
        height: 100
      }),
      dispose: () => {}
    })
    const agent = createBoardAgent(made.ctx)
    return {
      ...made,
      shown,
      viewports,
      views,
      run: async (request) => {
        const routed =
          request.kind === 'begin-route' && !('viewport' in request)
            ? {
                ...request,
                viewport: (viewports.live()[0] ?? viewports.open('/p/psu.kicad_pcb', 'Routing')).id
              }
            : request
        return (await agent.dispatch(routed as never)) as Answer
      }
    }
  }
  const sigTracks = (made: Fake): number =>
    liveBoard(made).segments.filter((s) => s.net === 1).length

  test('begin at a pad, step to the other, and the arrival lands as one undo step', async () => {
    const made = routeFake()
    const begun = await made.run({ kind: 'begin-route', start: 'A1.1' })
    expect(begun).toMatchObject({ session: 'route-1', net: 'SIG', layer: 'F.Cu', state: 'clear' })
    expect((begun.targets as Answer[]).map((t) => t.id)).toEqual(['B1.1'])
    expect(sigTracks(made)).toBe(0)

    const moved = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ to: 'B1.1' }]
    })
    expect(moved).toMatchObject({
      results: ['moved'],
      state: 'clear',
      head: { at: { x: 130, y: 110 } }
    })
    expect(sigTracks(made)).toBe(0)

    const landed = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ click: true }]
    })
    expect(landed).toMatchObject({ results: ['arrived'], arrived: ['B1.1'], state: 'idle' })
    expect((landed.changed as Answer).created).not.toHaveLength(0)
    expect(sigTracks(made)).toBeGreaterThan(0)
    const session = made.sessions.get('/p/psu.kicad_pcb')!
    expect(session.undoLabel()).toBe('pcbEditor.commands.routeTrack')
    session.undo()
    expect(sigTracks(made)).toBe(0)
    expect(session.canUndo()).toBe(false)
  })

  test("each routing call's action labels the session's box; a refused one leaves it", async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1', action: 'Route SIG' } as RouteRequest)
    expect(made.views.at(-1)![0].label).toBe('Route SIG')
    await made.run({
      kind: 'preview-route',
      session: 'route-1',
      candidates: [[{ to: 'B1.1' }]],
      action: 'Compare ways to B1'
    })
    expect(made.viewports.live()[0].label).toBe('Compare ways to B1')
    await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 120, y: 110 }, click: true }],
      action: 'Click a corner'
    })
    expect(made.views.at(-1)![0]).toMatchObject({ label: 'Click a corner', frame: { x: 104 } })
    await made.run({
      kind: 'preview-route',
      session: 'route-1',
      candidates: [[{ commit: true }]],
      action: 'Refused preview'
    })
    expect(made.viewports.live()[0].label).toBe('Click a corner')
  })

  test('the person sees the session in its viewport, and closing that ends it, landing what was clicked', async () => {
    const made = routeFake()
    const begun = await made.run({ kind: 'begin-route', start: 'A1.1' })
    expect(begun.viewport).toBe('viewport-1')
    await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 120, y: 110 }, click: true }]
    })
    const last = made.views.at(-1)!
    expect(last).toHaveLength(1)
    expect(last[0]).toMatchObject({
      id: 'viewport-1',
      path: '/p/psu.kicad_pcb',
      label: 'Routing',
      // The route from (110, 110) and the head at (120, 110), 6 mm round them.
      frame: { x: 104, y: 104, width: 22, height: 12 }
    })
    // What the session has not landed is in its pictures only, never on the canvas.
    expect(last[0]).not.toHaveProperty('ghost')
    made.viewports.closeByPerson('viewport-1')
    expect(made.views.at(-1)).toEqual([])
    // The person's × ends the route as their Esc would: the click lands (R21).
    expect(sigTracks(made)).toBe(1)
    const track = boardItems(liveBoard(made)).find(
      (item) => item.kind === 'track' && item.track.net === 1
    )!
    expect(
      await made.run({ kind: 'step-route', session: 'route-1', gestures: [{ undo: true }] })
    ).toMatchObject({
      error: 'route-session-ended',
      detail: `Routing session route-1 ended. Its viewport viewport-1 closed. The user closed it from the canvas. What it had clicked landed as one undo step: tracks ${track.id}.`
    })
    expect(
      await made.run({ kind: 'render-board', maxPixels: 512, viewport: 'viewport-1' })
    ).toEqual({
      error: 'viewport-closed',
      detail: 'Viewport viewport-1 closed. The user closed it from the canvas.'
    })
    made.sessions.get('/p/psu.kicad_pcb')!.undo()
    expect(sigTracks(made)).toBe(0)
  })

  test('a new begin lands what the session it replaces had clicked, and says so', async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 120, y: 110 }, click: true }]
    })
    const next = await made.run({ kind: 'begin-route', start: 'B1.1' })
    expect(sigTracks(made)).toBe(1)
    const ended = next.ended as Answer[]
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({
      session: 'route-1',
      reason: 'route_begin started another on its board.',
      landed: { vias: [] }
    })
    const landed = (ended[0].landed as { tracks: string[] }).tracks
    expect(landed).toHaveLength(1)
    expect((ended[0].changed as Answer).created).toEqual(landed)
    expect(next.guidance).toContain('ended lists the sessions')
    // Told once: the next begin reports only the session it replaced, which clicked nothing.
    expect((await made.run({ kind: 'begin-route', start: 'B1.1' })).ended).toEqual([
      { session: 'route-2', reason: 'route_begin started another on its board.' }
    ])
    const session = made.sessions.get('/p/psu.kicad_pcb')!
    expect(session.undoLabel()).toBe('pcbEditor.commands.routeTrack')
    session.undo()
    expect(sigTracks(made)).toBe(0)
  })

  test('cancel ends the route as Esc does: what was clicked lands, the head is dropped', async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    const cancelled = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [
        { at: { x: 120, y: 110 }, click: true },
        { at: { x: 125, y: 115 } },
        { cancel: true }
      ]
    })
    expect(cancelled).toMatchObject({ results: ['laid', 'moved', 'committed'], state: 'idle' })
    expect(cancelled.landed).toMatchObject({ vias: [] })
    expect((cancelled.landed as { tracks: string[] }).tracks).toHaveLength(1)
    expect(cancelled).not.toHaveProperty('laid')
    const tracks = liveBoard(made).segments.filter((s) => s.net === 1)
    expect(tracks.map((t) => [nmToMm(t.end.x), nmToMm(t.end.y)])).toEqual([[120, 110]])
    // With nothing clicked, cancel lands nothing.
    await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ to: 'A1.1', click: true }]
    })
    expect(
      await made.run({ kind: 'step-route', session: 'route-1', gestures: [{ cancel: true }] })
    ).toMatchObject({ results: ['cancelled'] })
    expect(sigTracks(made)).toBe(1)
  })

  test('a session that idles out lands what it clicked, and the next call is told', async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 120, y: 110 }, click: true }]
    })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000)
    try {
      const late = await made.run({
        kind: 'step-route',
        session: 'route-1',
        gestures: [{ undo: true }]
      })
      expect(late).toMatchObject({ error: 'route-session-ended' })
      expect(late.detail).toContain('It sat idle for 10 minutes. What it had clicked landed')
      expect(sigTracks(made)).toBe(1)
    } finally {
      clock.mockRestore()
    }
  })

  test('a step answers the copper it laid, and on landing the tracks by id', async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    const clicked = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 120, y: 110 }, click: true }]
    })
    expect(clicked.laid).toEqual({
      segments: [{ start: { x: 110, y: 110 }, end: { x: 120, y: 110 }, width: 0.2, layer: 'F.Cu' }],
      vias: []
    })
    expect(clicked).not.toHaveProperty('landed')
    // A move lays nothing.
    expect(
      await made.run({ kind: 'step-route', session: 'route-1', gestures: [{ to: 'B1.1' }] })
    ).not.toHaveProperty('laid')
    const arrived = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ click: true }]
    })
    expect(arrived).not.toHaveProperty('laid')
    const tracks = (arrived.landed as { tracks: string[] }).tracks
    const net = boardItems(liveBoard(made))
      .filter((item) => item.kind === 'track' && item.track.net === 1)
      .map((item) => item.id)
    expect([...tracks].sort()).toEqual([...net].sort())
  })

  test('a session attached to a viewport leaves it open when it ends', async () => {
    const made = routeFake()
    const mine = made.viewports.open('/p/psu.kicad_pcb', 'Routing SIG')
    const begun = await made.run({ kind: 'begin-route', start: 'A1.1', viewport: mine.id })
    expect(begun.viewport).toBe(mine.id)
    await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 120, y: 110 } }]
    })
    expect(made.views.at(-1)![0]).not.toHaveProperty('ghost')
    // A new begin in the same viewport ends the old session and keeps the box.
    await made.run({ kind: 'begin-route', start: 'A1.1', viewport: mine.id })
    expect(
      await made.run({ kind: 'step-route', session: 'route-1', gestures: [{ undo: true }] })
    ).toMatchObject({ error: 'route-session-ended' })
    // One in another viewport ends it too, and leaves the box open.
    const other = made.viewports.open('/p/psu.kicad_pcb', 'Routing GND')
    await made.run({ kind: 'begin-route', start: 'A1.1', viewport: other.id })
    const live = made.viewports.live()
    expect(live.map((v) => v.id)).toEqual([mine.id, other.id])
    expect(live[0]).toMatchObject({ label: 'Routing SIG' })
    expect(live[0].frame).not.toBeNull()
  })

  test('route_begin refuses a viewport it cannot find', async () => {
    const made = routeFake()
    expect(
      await made.run({ kind: 'begin-route', start: 'A1.1', viewport: 'viewport-9' })
    ).toMatchObject({ error: 'viewport-not-found', candidates: [] })
    expect(made.viewports.live()).toEqual([])
  })

  test('viewport_close ends the routing in it', async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    expect(
      await made.viewports.dispatch({ kind: 'close-viewport', viewport: 'viewport-1' })
    ).toEqual({ closed: 'viewport-1', endedSessions: ['route-1'] })
    // With something clicked, the close lands it and answers what landed.
    made.viewports.open('/p/psu.kicad_pcb', 'Routing')
    await made.run({ kind: 'begin-route', start: 'A1.1', viewport: 'viewport-2' })
    await made.run({
      kind: 'step-route',
      session: 'route-2',
      gestures: [{ at: { x: 120, y: 110 }, click: true }]
    })
    const closed = await made.viewports.dispatch({ kind: 'close-viewport', viewport: 'viewport-2' })
    expect(closed).toMatchObject({ closed: 'viewport-2', endedSessions: ['route-2'] })
    expect((closed as Answer).landed).toMatchObject({ vias: [] })
    expect(((closed as Answer).changed as Answer).created).toHaveLength(1)
    expect(sigTracks(made)).toBe(1)
    expect(
      await made.run({ kind: 'step-route', session: 'route-1', gestures: [{ undo: true }] })
    ).toMatchObject({ error: 'route-session-ended' })
  })

  test('a landing ends the step and counts the gestures it did not apply', async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    const landed = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ to: 'B1.1', click: true }, { at: { x: 120, y: 115 } }, { click: true }]
    })
    expect(landed).toMatchObject({
      results: ['arrived'],
      arrived: ['B1.1'],
      skipped: 2,
      state: 'idle'
    })
    expect((landed.changed as Answer).created).not.toHaveLength(0)
    expect(landed.guidance).toContain('the 2 after it were not applied')
    // The canvas shows the session's box where the route ended.
    expect(made.views.at(-1)).toMatchObject([{ id: 'viewport-1' }])
    const next = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ to: 'B1.1' }]
    })
    expect(next).not.toHaveProperty('skipped')
    expect(next).toMatchObject({ results: ['moved'], state: 'idle' })
  })

  test('a finish that arrives names the copper it reached', async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    const finished = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ finish: 'attempt' }]
    })
    expect(finished).toMatchObject({ results: ['arrived'], arrived: ['B1.1'], state: 'idle' })
    expect(sigTracks(made)).toBeGreaterThan(0)
  })

  test('a blocked click lays nothing and names what blocks it', async () => {
    const made = routeFake(ROUTE_BOARD(WALL))
    await made.run({ kind: 'begin-route', start: 'A1.1', settings: { mode: 'highlight' } })
    const stepped = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ to: 'B1.1', click: true }]
    })
    expect(stepped.results).toEqual(['nothing'])
    expect(stepped.state).toBe('violating')
    expect(stepped.blockedBy).toEqual(['wall'])
    expect(stepped.placed).toEqual({ segments: 0, vias: 0, length: 0 })
    expect(sigTracks(made)).toBe(0)
    expect(stepped).not.toHaveProperty('changed')
  })

  test('preview runs each candidate and leaves the session as it was', async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 120, y: 110 }, click: true }]
    })
    const before = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 125, y: 112 } }]
    })
    const preview = await made.run({
      kind: 'preview-route',
      session: 'route-1',
      candidates: [[{ to: 'B1.1', click: true }], [{ posture: 'flip' }, { to: 'B1.1' }]],
      render: true,
      maxPixels: 256
    })
    const [arrives, flipped] = preview.candidates as Answer[]
    // The session's own 10 mm to (120, 110) is not the candidate's.
    expect(arrives).toMatchObject({
      results: ['arrived'],
      arrives: true,
      state: 'arrived',
      length: 10
    })
    expect(flipped).toMatchObject({ results: ['posture', 'moved'], state: 'clear', length: 0 })
    expect(made.shown.captures).toHaveLength(2)
    expect(preview).toMatchObject({ width: 400, image: { mimeType: 'image/png' } })
    expect(sigTracks(made)).toBe(0)
    const after = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 125, y: 112 } }]
    })
    expect(after.placed).toEqual(before.placed)
    expect(after.head).toEqual(before.head)
  })

  test('a candidate that arrives draws the route it laid, framed whole', async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    const preview = await made.run({
      kind: 'preview-route',
      session: 'route-1',
      candidates: [[{ to: 'B1.1', click: true }]],
      render: true,
      maxPixels: 256
    })
    expect(preview.candidates).toMatchObject([{ arrives: true, length: 20 }])
    const drawn = made.shown.drawn.at(-1)!
    expect(drawn.placed.length).toBeGreaterThan(0)
    const xs = drawn.placed.flatMap((seg) => [seg.x0, seg.x1])
    expect(Math.min(...xs)).toBeCloseTo(110, 6)
    expect(Math.max(...xs)).toBeCloseTo(130, 6)
    // Start to end, not 12 mm round the end alone.
    expect(made.shown.captures.at(-1)!.box).toEqual({
      minX: 104,
      maxX: 136,
      minY: -116,
      maxY: -104
    })
  })

  test("a candidate's length is the track its own gestures laid", async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 115, y: 110 }, click: true }]
    })
    const preview = await made.run({
      kind: 'preview-route',
      session: 'route-1',
      candidates: [
        [{ at: { x: 118, y: 110 }, click: true }, { at: { x: 125, y: 110 } }],
        [{ at: { x: 118, y: 110 }, click: true }, { undo: true }, { undo: true }],
        [{ finish: 'attempt' }]
      ]
    })
    const [clicked, undone, finished] = preview.candidates as Answer[]
    expect(clicked).toMatchObject({ results: ['laid', 'moved'], length: 3 })
    // Undoing past its own click takes back the session's too, which it never laid.
    expect(undone).toMatchObject({ results: ['laid', 'undone', 'undone'], length: 0 })
    expect(finished).toMatchObject({ results: ['arrived'], arrives: true, length: 15 })
  })

  /** ROUTE_BOARD with a second pair on SIG2: C1.1 at (110, 130) and D1.1 at (130, 130). */
  const TWO_PAIRS = (extra = ''): string =>
    ROUTE_BOARD(`(footprint "T:C" (layer "F.Cu") (uuid "fc") (at 110 130)
    (property "Reference" "C1" (at 0 -2 0) (layer "F.SilkS") (uuid "fc-r"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 3 "SIG2") (uuid "fc-p")))
  (footprint "T:D" (layer "F.Cu") (uuid "fd") (at 130 130)
    (property "Reference" "D1" (at 0 -2 0) (layer "F.SilkS") (uuid "fd-r"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 3 "SIG2") (uuid "fd-p")))
  ${extra}`).replace('(net 2 "OBS")', '(net 2 "OBS") (net 3 "SIG2")')

  test('finish routes from each start in turn, one undo step per landing', async () => {
    const made = routeFake(TWO_PAIRS())
    const finished = await made.run({
      kind: 'finish-routes',
      starts: ['A1', 'C1.1', 'B1.1']
    })
    expect(finished).toMatchObject({
      arrived: [
        { from: 'A1.1', to: 'B1.1', length: 20 },
        { from: 'C1.1', to: 'D1.1', length: 20 }
      ],
      dropped: [{ from: 'B1.1', reason: 'joined' }]
    })
    // Each arrival names what its own landing created; together, the whole write.
    const rows = finished.arrived as Array<{ created: string[] }>
    const byNet = (net: number): string[] =>
      boardItems(liveBoard(made))
        .filter((item) => item.kind === 'track' && item.track.net === net)
        .map((item) => item.id)
        .sort()
    expect([...rows[0].created].sort()).toEqual(byNet(1))
    expect([...rows[1].created].sort()).toEqual(byNet(3))
    expect((finished.changed as Answer).created).toEqual([...rows[0].created, ...rows[1].created])
    expect((finished.changed as Answer).created).not.toHaveLength(0)
    expect(finished.guidance).toContain('Each landing is its own undo step')
    const session = made.sessions.get('/p/psu.kicad_pcb')!
    expect(liveBoard(made).segments.filter((s) => s.net === 3).length).toBeGreaterThan(0)
    session.undo()
    expect(liveBoard(made).segments.filter((s) => s.net === 3)).toHaveLength(0)
    expect(sigTracks(made)).toBeGreaterThan(0)
    session.undo()
    expect(sigTracks(made)).toBe(0)
    expect(session.canUndo()).toBe(false)
  })

  test('a finish never narrows to pass a gap: it lays the class width or nothing', async () => {
    // Two OBS walls across the way with 0.55 mm between their edges: the class's
    // 0.5 mm track and 0.2 mm clearances do not pass, the 0.1 mm board minimum would.
    const walls = [
      '(segment (start 120 100) (end 120 109.6) (width 0.25) (layer "F.Cu") (net 2) (uuid "w1"))',
      '(segment (start 120 110.4) (end 120 125) (width 0.25) (layer "F.Cu") (net 2) (uuid "w2"))'
    ].join('\n  ')
    const project = JSON.stringify({
      board: { design_settings: { rules: { min_track_width: 0.1, min_clearance: 0.2 } } },
      net_settings: { classes: [{ name: 'Default', track_width: 0.5, clearance: 0.2 }] }
    })
    const made = routeFake(ROUTE_BOARD(walls), project)
    const finished = await made.run({ kind: 'finish-routes', starts: ['A1.1'] })
    for (const arrival of (finished.arrived ?? []) as Answer[])
      expect(arrival).not.toHaveProperty('necked')
    const widths = liveBoard(made)
      .segments.filter((seg) => seg.net === 1)
      .map((seg) => seg.width)
    expect(widths.every((w) => w === mmToNm(0.5))).toBe(true)
  })

  test('a finish that does not get there is dropped, nothing of it kept', async () => {
    // A box of OBS track round B1.
    const box = [
      [127, 107, 133, 107],
      [133, 107, 133, 113],
      [133, 113, 127, 113],
      [127, 113, 127, 107]
    ]
      .map(
        ([x0, y0, x1, y1], i) =>
          `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.25) (layer "F.Cu") (net 2) (uuid "box${i}"))`
      )
      .join('\n  ')
    const made = routeFake(ROUTE_BOARD(box))
    const finished = await made.run({ kind: 'finish-routes', starts: ['A1.1'] })
    expect(finished).toMatchObject({
      arrived: [],
      dropped: [{ from: 'A1.1', reason: 'stopped' }],
      changed: { created: [], updated: [], deleted: [] }
    })
    expect(sigTracks(made)).toBe(0)
    expect(made.sessions.get('/p/psu.kicad_pcb')!.canUndo()).toBe(false)
    expect(await made.run({ kind: 'finish-routes', starts: ['box0'] })).toMatchObject({
      error: 'not-applicable'
    })
  })

  test("a finish follows the start's own ratsnest lines: a pad its cluster joins is dropped as joined", async () => {
    // A1 and B1 joined by a track, the island E1 past B1: the one line runs B1 to E1.
    const made = routeFake(
      ROUTE_BOARD(`(segment (start 110 110) (end 130 110) (width 0.25) (layer "F.Cu") (net 1) (uuid "ab"))
  (footprint "T:E" (layer "F.Cu") (uuid "fe") (at 140 110)
    (property "Reference" "E1" (at 0 -2 0) (layer "F.SilkS") (uuid "fe-r"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG") (uuid "fe-p")))`)
    )
    expect(await made.run({ kind: 'finish-routes', starts: ['A1.1', 'B1.1'] })).toMatchObject({
      arrived: [{ from: 'B1.1', to: 'E1.1', length: 10 }],
      dropped: [{ from: 'A1.1', reason: 'joined' }]
    })
  })

  test("a step's grid point takes the off-grid start's axis where it is nearer (R47)", async () => {
    // P1 sits off the 0.25 mm grid at (115.13, 105.07).
    const made = routeFake(
      ROUTE_BOARD(`(footprint "T:P" (layer "F.Cu") (uuid "fp") (at 115.13 105.07)
    (property "Reference" "P1" (at 0 -2 0) (layer "F.SilkS") (uuid "fp-r"))
    (pad "1" smd rect (at 0 0) (size 0.5 0.5) (layers "F.Cu") (net 1 "SIG") (uuid "fp-p")))`)
    )
    await made.run({ kind: 'begin-route', start: 'P1.1' })
    const along = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 119.02, y: 105.11 } }]
    })
    expect(along).toMatchObject({ head: { at: { x: 119, y: 105.07 } } })
    const off = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 119.02, y: 105.2 } }]
    })
    expect(off).toMatchObject({ head: { at: { x: 119, y: 105.25 } } })
  })

  test('a picture is framed round the head, with its scale', async () => {
    const made = routeFake()
    const begun = await made.run({
      kind: 'begin-route',
      start: 'A1.1',
      render: true,
      maxPixels: 512
    })
    expect(begun).toMatchObject({
      frame: { x: 10, y: 20, width: 2, height: 1 },
      width: 200,
      mmPerPixel: 0.01,
      image: { mimeType: 'image/png', base64: 'SEEN' }
    })
    // 12 mm across round the start at (110, 110): scene y is up.
    expect(made.shown.captures[0]).toEqual({
      box: { minX: 104, maxX: 116, minY: -116, maxY: -104 },
      maxPixels: 512
    })
    expect(made.shown.overlays).toBe(1)
  })

  test('the board edited under the session replays the route over it', async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 120, y: 110 }, click: true }]
    })
    const session = made.sessions.get('/p/psu.kicad_pcb')!
    // The person draws an unrelated track while the agent routes.
    session.runCommand('Draw', () =>
      addSegmentToBoardAST(session.board()!, {
        start: { x: mmToNm(140), y: mmToNm(140) },
        end: { x: mmToNm(145), y: mmToNm(140) },
        width: mmToNm(0.25),
        layer: 'B.Cu',
        net: 0
      })
    )
    expect(session.canUndo()).toBe(true)
    const stepped = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ to: 'B1.1' }]
    })
    expect(stepped).toMatchObject({ rebased: true, placed: { segments: 1 } })
  })

  test('a gesture that fails puts the session back; an unknown session is named', async () => {
    const made = routeFake()
    await made.run({ kind: 'begin-route', start: 'A1.1' })
    const failed = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 120, y: 110 }, click: true }, { to: 'Z9.9' }]
    })
    expect(failed).toMatchObject({ error: 'item-not-found' })
    const after = await made.run({
      kind: 'step-route',
      session: 'route-1',
      gestures: [{ at: { x: 121, y: 110 } }]
    })
    expect(after.placed).toEqual({ segments: 0, vias: 0, length: 0 })
    expect(
      await made.run({ kind: 'step-route', session: 'route-9', gestures: [{ undo: true }] })
    ).toMatchObject({ error: 'route-session-not-found', candidates: ['route-1'] })
    expect(
      await made.run({
        kind: 'step-route',
        session: 'route-1',
        gestures: [{ undo: true, commit: true }]
      })
    ).toMatchObject({ error: 'invalid-args' })
  })
})

describe('cleanup on a board', () => {
  // Two straight pieces from a pad, and a stub off its far end to nowhere.
  const CLEANUP_BOARD = BOARD.replace('(net 0 "")', '(net 0 "") (net 1 "A")').replace(
    '  (gr_line',
    `  (footprint "T:R" (layer "F.Cu") (uuid "r1") (at 110 120)
    (property "Reference" "R1" (at 0 -1 0) (layer "F.SilkS") (uuid "r1-r"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "r1-p1")))
  (footprint "T:R" (layer "F.Cu") (uuid "r2") (at 116 120)
    (property "Reference" "R2" (at 0 -1 0) (layer "F.SilkS") (uuid "r2-r"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "r2-p1")))
  (segment (start 110 120) (end 113 120) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 113 120) (end 116 120) (width 0.25) (layer "F.Cu") (net 1) (uuid "t2"))
  (segment (start 116 120) (end 118 122) (width 0.25) (layer "F.Cu") (net 1) (uuid "t3"))
  (gr_line`
  )
  const cleanupFake = (): Fake & { run: (request: McpDesignRequest) => Promise<Answer> } => {
    const made = fake({ text: CLEANUP_BOARD })
    const agent = createBoardAgent(made.ctx)
    return { ...made, run: async (request) => (await agent.dispatch(request as never)) as Answer }
  }

  test('a dry run lists each change by the ids items_get takes, and writes nothing', async () => {
    const made = cleanupFake()
    const answer = await made.run({ kind: 'cleanup-board', dryRun: true })
    expect(answer).toMatchObject({
      dryRun: true,
      changes: [
        { kind: 'dangling-track', items: ['t3'], at: { x: 116, y: 120 }, layer: 'F.Cu' },
        { kind: 'merge-tracks', items: ['t1', 't2'], at: { x: 113, y: 120 } }
      ],
      counts: { 'dangling-track': 1, 'merge-tracks': 1 },
      changed: { created: [], updated: ['t1'], deleted: ['t2', 't3'] }
    })
    expect(liveBoard(made).segments).toHaveLength(3)
  })

  test('the write lands as one undoable step; a pass turned off is left alone', async () => {
    const made = cleanupFake()
    await made.run({ kind: 'cleanup-board', passes: { danglingTracks: false } })
    expect(liveBoard(made).segments.map((seg) => seg.uuid)).toEqual(['t1', 't3'])
    made.sessions.get('/p/psu.kicad_pcb')!.undo()
    expect(liveBoard(made).segments).toHaveLength(3)
  })

  test('a net it does not have is named', async () => {
    const made = cleanupFake()
    expect(await made.run({ kind: 'cleanup-board', nets: ['B'] })).toMatchObject({
      error: 'net-not-found'
    })
  })

  // The same board's pads, for teardrops.
  describe('teardrops', () => {
    test('board_set_teardrops turns them on for the pads it picks, in one undoable step', async () => {
      const made = cleanupFake()
      const answer = await made.run({
        kind: 'set-teardrops-board',
        mode: 'add',
        targets: ['smdPads']
      })
      expect(answer).toMatchObject({ counts: { pads: 2, vias: 0 } })
      expect(answer).toMatchObject({ changed: { updated: ['R1.1', 'R2.1'] } })
      const teardrops = (): number => liveBoard(made).zones.filter(isTeardropZone).length
      expect(teardrops()).toBe(3)
      made.sessions.get('/p/psu.kicad_pcb')!.undo()
      expect(teardrops()).toBe(0)
    })

    test('a track named as an item is refused', async () => {
      const made = cleanupFake()
      expect(
        await made.run({ kind: 'set-teardrops-board', mode: 'add', items: ['t1'] })
      ).toMatchObject({ error: 'not-applicable' })
    })
  })
})
