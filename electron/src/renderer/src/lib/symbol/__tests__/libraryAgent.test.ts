import { describe, expect, test, vi } from 'vitest'
import { mmToNm, spacingToMm } from '../../kicad/coordinates'
import { shallowRef } from 'vue'
import { createLibraryAgent, isLibraryRequest, type LibraryAgentContext } from '../libraryAgent'
import type { LibrarySymbol, SymbolSources } from '../symbolSources'
import { generateSymbol, parseOrCreateLibrary } from '../symbolGenerate'
import { serializeKicadSymbolLibrary } from '../../kicad/symbolLibrary'
import { planSymbol } from '../symbolLayout'
import type { AgentCapture } from '../../schematic/schematicAgent'
import { generateFootprint } from '../../footprint/footprintGenerate'
import { DEFAULT_STYLE_CHOICES } from '../../footprint/footprintStyle'
import type { McpCreateFootprintRequest } from '../../../../../preload/mcpTypes'

/** A library file holding one generated symbol. */
const libraryText = (name: string, value: string): string => {
  const plan = planSymbol(
    [
      { id: 'pwr', role: 'power' },
      { id: 'gnd', role: 'ground' },
      { id: 'io', role: 'signal' }
    ],
    [
      { number: '1', name: 'VDD', type: 'power_in', group: 'pwr' },
      { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
      { number: '3', name: 'IN', type: 'input', group: 'io' }
    ]
  )
  if (!plan.ok) throw new Error(plan.error)
  const library = parseOrCreateLibrary(null)
  generateSymbol(library, name, plan.layout, { reference: 'U', value })
  return serializeKicadSymbolLibrary(library)
}

/** A parsed library holding one generated symbol, as a source tier carries it. */
const tierWith = (libId: string, tier: LibrarySymbol['tier']): LibrarySymbol => {
  const parsed = parseOrCreateLibrary(libraryText(libId, libId))
  return { libId, description: '', isPower: false, tier, sheet: parsed.doc }
}

const sourcesWith = (table: LibrarySymbol[], standard: LibrarySymbol[] = []): SymbolSources => {
  const tableSymbols = shallowRef(table)
  const standardSymbols = shallowRef<LibrarySymbol[]>([])
  return {
    tableSymbols,
    standardSymbols,
    registeredLibraries: shallowRef(new Map()),
    ready: async () => {},
    reload: async () => {},
    ensureStandardLibrary: async (libId) => {
      const found = standard.find((entry) => entry.libId === libId)
      if (found) standardSymbols.value = [...standardSymbols.value, found]
    },
    lookup: () => undefined
  }
}

const shot: AgentCapture = {
  dataUrl: 'data:image/png;base64,UElORw==',
  width: 400,
  height: 300,
  visible: { minX: -10, minY: -7.5, maxX: 10, maxY: 7.5 }
}

/** A chip resistor as KiCad ships it, trimmed: two pads, a courtyard, a fab
 *  outline and one model. */
const R_0402 = `(footprint "R_0402_1005Metric" (version 20240108) (generator "pcbnew") (layer "F.Cu")
  (descr "Resistor SMD 0402 (1005 Metric)")
  (tags "resistor")
  (attr smd)
  (fp_line (start -0.93 -0.47) (end 0.93 -0.47) (stroke (width 0.05) (type solid)) (layer "F.CrtYd"))
  (fp_line (start -0.93 0.47) (end 0.93 0.47) (stroke (width 0.05) (type solid)) (layer "F.CrtYd"))
  (fp_line (start -0.5 -0.25) (end 0.5 0.25) (stroke (width 0.1) (type solid)) (layer "F.Fab"))
  (pad "1" smd roundrect (at -0.485 0) (size 0.59 0.64) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
  (pad "2" smd roundrect (at 0.485 0) (size 0.59 0.64) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
  (model "\${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl"
    (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)`

const R_0402_RECORD = {
  type: 'footprint' as const,
  id: 'Resistor_SMD:R_0402_1005Metric',
  name: 'R_0402_1005Metric',
  library: 'Resistor_SMD',
  scope: 'system' as const,
  file: '/libs/Resistor_SMD.pretty/R_0402_1005Metric.kicad_mod',
  description: 'Resistor SMD 0402 (1005 Metric)',
  tags: 'resistor',
  pads: 2,
  padNumbers: 2,
  models: ['${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl']
}

const context = (over: Partial<LibraryAgentContext> = {}): LibraryAgentContext => ({
  projectPath: () => '/proj',
  projectFile: () => '/proj/proj.kicad_pro',
  hasUnsavedEdits: () => false,
  reloadOpenFile: () => {},
  refreshIndex: async () => {},
  editOpenLibrary: () => false,
  sources: () =>
    sourcesWith([tierWith('proj:PART', 'project')], [tierWith('Device:R', 'standard')]),
  capture: () => shot,
  captureFootprint: () => shot,
  findFootprint: async (libId) => (libId === R_0402_RECORD.id ? R_0402_RECORD : undefined),
  footprintCandidates: async () => [R_0402_RECORD.id],
  symbolCandidates: async () => ['Device:R'],
  libraryRevision: async () => null,
  // R1 is the 0402 placed on a board; U1 a placement of proj:PART on a sheet.
  placedFootprint: async (reference) =>
    reference === 'R1'
      ? { ok: true, file: '/proj/proj.kicad_pcb', text: R_0402, libId: R_0402_RECORD.id }
      : { ok: false, error: 'reference-not-found', detail: reference, candidates: ['R1'] },
  placedSymbol: async (reference) =>
    reference === 'U1'
      ? {
          ok: true,
          file: '/proj/proj.kicad_sch',
          document: tierWith('proj:PART', 'project').sheet,
          id: 'proj:PART'
        }
      : { ok: false, error: 'reference-not-found', detail: reference, candidates: ['U1'] },
  readFile: async (path) => (path === R_0402_RECORD.file ? R_0402 : null),
  symbolGrid: () => mmToNm(spacingToMm(50, 'mil')),
  // The installed set is STEP-only, as it is on a stock Linux install.
  modelFacts: async ({ path }) =>
    path.endsWith('.wrl')
      ? {
          status: 'resolved',
          resolved: path.replace('.wrl', '.step'),
          bounds: { x: -0.5, y: -0.25, w: 1, h: 0.5, zMin: 0, zMax: 0.35 },
          fit: null,
          triangles: 240,
          meshes: 1
        }
      : {
          status: 'missing',
          resolved: null,
          bounds: null,
          fit: null,
          triangles: 0,
          meshes: 0
        },
  captureModel: async () => null,
  captureFootprintWithModel: async () => ({ capture: null, placed: false }),
  copyFootprint: async () => {
    throw new Error('not under test')
  },
  copySymbol: async () => {
    throw new Error('not under test')
  },
  createSymbol: async () => {
    throw new Error('not under test')
  },
  deleteSymbol: async () => {
    throw new Error('not under test')
  },
  createFootprint: async () => {
    throw new Error('not under test')
  },
  deleteFootprint: async () => {
    throw new Error('not under test')
  },
  libraryChanged: async () => {},
  openBehind: () => {},
  ...over
})

describe('which requests are the library door’s', () => {
  test('the library kinds, and nothing sheet-shaped', () => {
    expect(isLibraryRequest({ kind: 'render-symbol', symbol: 'a:b', maxPixels: 100 })).toBe(true)
    expect(isLibraryRequest({ kind: 'get-symbol', symbol: 'a:b' })).toBe(true)
    expect(isLibraryRequest({ kind: 'get-footprint', footprint: 'a:b', maxPads: 1 })).toBe(true)
    expect(isLibraryRequest({ kind: 'render-footprint', footprint: 'a:b', maxPixels: 100 })).toBe(
      true
    )
    expect(isLibraryRequest({ kind: 'create-symbol', name: 'X', groups: [], pins: [] })).toBe(true)
    expect(isLibraryRequest({ kind: 'delete-symbol', symbol: 'a:X' })).toBe(true)
    expect(isLibraryRequest({ kind: 'delete-footprint', footprint: 'a:X' })).toBe(true)
    expect(isLibraryRequest({ kind: 'copy-symbol', libId: 'a:X' })).toBe(true)
    expect(isLibraryRequest({ kind: 'describe-schematic' })).toBe(false)
    expect(isLibraryRequest({ kind: 'render-sheet', maxPixels: 100 })).toBe(false)
  })
})

describe('render-symbol', () => {
  test('draws a project-tier symbol and answers the picture with its frame and tier', async () => {
    const capture = vi.fn<LibraryAgentContext['capture']>(() => shot)
    const agent = createLibraryAgent(context({ capture }))
    const answer = (await agent.dispatch({
      kind: 'render-symbol',
      symbol: 'proj:PART',
      maxPixels: 400
    })) as Record<string, unknown>
    expect(answer.error).toBeUndefined()
    expect(answer.tier).toBe('project')
    expect(answer.frame).toEqual({ x: -10, y: -7.5, width: 20, height: 15 })
    expect(answer.image).toEqual({ mimeType: 'image/png', base64: 'UElORw==' })
    // The document drawn holds exactly the symbol, placed at the origin.
    const [document, box, maxPixels] = capture.mock.calls[0]!
    expect(document.symbols).toHaveLength(1)
    expect(document.symbols[0].position).toMatchObject({ x: 0, y: 0 })
    expect(box).toBeNull()
    expect(maxPixels).toBe(400)
  })

  test('parses a standard library on demand when the table tiers lack the id', async () => {
    const agent = createLibraryAgent(context())
    const answer = (await agent.dispatch({
      kind: 'render-symbol',
      symbol: 'Device:R',
      maxPixels: 400
    })) as Record<string, unknown>
    expect(answer.error).toBeUndefined()
    expect(answer.tier).toBe('standard')
  })

  test('needs no project: the global and standard tiers are read alone', async () => {
    const sources = vi.fn((projectPath: string | null) => {
      expect(projectPath).toBeNull()
      return sourcesWith([], [tierWith('Device:R', 'standard')])
    })
    const agent = createLibraryAgent(context({ projectPath: () => null, sources }))
    const answer = (await agent.dispatch({
      kind: 'render-symbol',
      symbol: 'Device:R',
      maxPixels: 400
    })) as Record<string, unknown>
    expect(answer.error).toBeUndefined()
    expect(sources).toHaveBeenCalledWith(null)
  })

  test('refuses an id no tier has, naming it', async () => {
    const agent = createLibraryAgent(context())
    const answer = await agent.dispatch({
      kind: 'render-symbol',
      symbol: 'no:such',
      maxPixels: 400
    })
    expect(answer).toEqual({ error: 'unknown-symbol', detail: 'no:such', candidates: ['Device:R'] })
  })

  test('says so when the window cannot draw', async () => {
    const agent = createLibraryAgent(context({ capture: () => null }))
    const answer = (await agent.dispatch({
      kind: 'render-symbol',
      symbol: 'proj:PART',
      maxPixels: 400
    })) as Record<string, unknown>
    expect(answer.error).toBe('renderer-failed')
  })
})

describe('check-symbol', () => {
  test('runs the symbol checks the editor pill runs, grouped by rule', async () => {
    const agent = createLibraryAgent(context())
    const answer = (await agent.dispatch({ kind: 'check-symbol', symbol: 'Device:R' })) as Record<
      string,
      unknown
    >
    expect(answer.error).toBeUndefined()
    expect(answer).toMatchObject({
      libId: 'Device:R',
      ok: true,
      checks: [],
      counts: { error: 0, warning: 0 }
    })
  })

  test('codes names rules, and a code no symbol rule has is refused', async () => {
    const agent = createLibraryAgent(context())
    const answer = (await agent.dispatch({
      kind: 'check-symbol',
      symbol: 'Device:R',
      codes: ['no-such-rule']
    })) as Record<string, unknown>
    expect(answer.error).toBe('unknown-check-code')
    expect((answer.candidates as string[]).length).toBeGreaterThan(0)
  })

  test('refuses a symbol no library has', async () => {
    const agent = createLibraryAgent(context())
    expect(await agent.dispatch({ kind: 'check-symbol', symbol: 'Nope:X' })).toMatchObject({
      error: 'unknown-symbol',
      candidates: ['Device:R']
    })
  })
})

describe('a placed part reads its design copy', () => {
  test('a symbol reference reads the definition its sheet embeds, and says where', async () => {
    const agent = createLibraryAgent(context())
    const answer = (await agent.dispatch({ kind: 'get-symbol', symbol: 'U1' })) as Record<
      string,
      unknown
    >
    expect(answer).toMatchObject({
      libId: 'proj:PART',
      reference: 'U1',
      sheet: '/proj/proj.kicad_sch'
    })
    expect(answer.tier).toBe('sheet')
    expect((answer.pins as unknown[]).length).toBe(3)
  })

  test('a reference the sheet lacks is refused with the ones it has', async () => {
    const agent = createLibraryAgent(context())
    expect(await agent.dispatch({ kind: 'check-symbol', symbol: 'U9' })).toEqual({
      error: 'reference-not-found',
      detail: 'U9',
      candidates: ['U1']
    })
  })

  test("a footprint reference with board reads the board's copy", async () => {
    const agent = createLibraryAgent(context())
    const answer = (await agent.dispatch({
      kind: 'get-footprint',
      footprint: 'R1',
      board: 'proj.kicad_pcb',
      maxPads: 200
    })) as Record<string, unknown>
    expect(answer).toMatchObject({
      libId: R_0402_RECORD.id,
      reference: 'R1',
      board: '/proj/proj.kicad_pcb',
      tier: 'board',
      padCount: 2
    })
    expect(answer).not.toHaveProperty('file')
  })
})

describe('get-symbol', () => {
  test('reports every pin as an offset from the origin with its free side, and the box', async () => {
    const agent = createLibraryAgent(context())
    const answer = (await agent.dispatch({ kind: 'get-symbol', symbol: 'Device:R' })) as Record<
      string,
      unknown
    >
    expect(answer.error).toBeUndefined()
    expect(answer.tier).toBe('standard')
    expect(answer.units).toBe(1)
    const pins = answer.pins as Array<Record<string, unknown>>
    expect(pins.map((pin) => pin.number)).toEqual(['1', '2', '3'])
    // The generated three-pin part: VDD on top, GND below, IN on the left.
    const byName = Object.fromEntries(pins.map((pin) => [pin.name, pin]))
    expect(byName.VDD.free).toBe('up')
    expect(byName.GND.free).toBe('down')
    expect(byName.IN.free).toBe('left')
    // Sheet space, y down: the top pin's offset is negative.
    expect((byName.VDD.at as { y: number }).y).toBeLessThan(0)
    expect((byName.GND.at as { y: number }).y).toBeGreaterThan(0)
    const box = answer.box as { width: number; height: number }
    expect(box.width).toBeGreaterThan(0)
    expect(box.height).toBeGreaterThan(0)
    expect(answer.fields).toMatchObject({ Reference: 'U', Value: 'Device:R' })
    expect(answer.footprintFilters).toEqual([])
  })

  test('answers only the columns asked for, beside the identity', async () => {
    const agent = createLibraryAgent(context())
    const answer = (await agent.dispatch({
      kind: 'get-symbol',
      symbol: 'Device:R',
      columns: ['pins', 'description']
    })) as Record<string, unknown>
    // A column the symbol has no value for (no description) stays absent.
    expect(Object.keys(answer)).toEqual(['libId', 'tier', 'pins', 'guidance'])
    expect((answer.pins as unknown[]).length).toBe(3)
  })

  test('a library tab with unsaved edits is read from the tab, not the disk', async () => {
    const file = '/proj/proj.kicad_sym'
    // On disk proj:PART has the value it was generated with; the tab has an edit.
    const sources = sourcesWith([tierWith('proj:PART', 'project')])
    sources.registeredLibraries.value = new Map([
      ['proj', { nickname: 'proj', path: file, scope: 'project' }]
    ])
    const read = (dirty: boolean): Promise<unknown> =>
      createLibraryAgent(
        context({
          sources: () => sources,
          hasUnsavedEdits: (path) => dirty && path === file,
          readFile: async (path) => (path === file ? libraryText('PART', 'edited') : null)
        })
      ).dispatch({ kind: 'get-symbol', symbol: 'proj:PART' })
    expect(await read(true)).toMatchObject({ fields: { Value: 'edited' } })
    expect(await read(false)).toMatchObject({ fields: { Value: 'proj:PART' } })
  })

  test('refuses an id no tier has', async () => {
    const agent = createLibraryAgent(context())
    expect(await agent.dispatch({ kind: 'get-symbol', symbol: 'no:such' })).toEqual({
      error: 'unknown-symbol',
      detail: 'no:such',
      candidates: ['Device:R']
    })
  })
})

describe('get-footprint', () => {
  test('parses the file the index names and reports pads, boxes and models', async () => {
    const agent = createLibraryAgent(context())
    const answer = (await agent.dispatch({
      kind: 'get-footprint',
      footprint: R_0402_RECORD.id,
      maxPads: 200,
      modelFit: true
    })) as Record<string, unknown>
    expect(answer.error).toBeUndefined()
    expect(answer.tier).toBe('system')
    expect(answer.padCount).toBe(2)
    // The footprint's own record, as items_get reads id "footprint".
    expect(answer).toMatchObject({
      name: 'R_0402_1005Metric',
      locked: false,
      attributes: { type: 'smd', excludeFromBom: false, dnp: false },
      overrides: { clearance: null, zoneConnect: null, allowSolderMaskBridges: false }
    })
    const pads = answer.pads as Array<Record<string, unknown>>
    expect(pads[0]).toMatchObject({
      number: '1',
      type: 'smd',
      shape: 'roundrect',
      at: { x: -0.485, y: 0 },
      size: { width: 0.59, height: 0.64 },
      layers: ['F.Cu', 'F.Paste', 'F.Mask']
    })
    const box = answer.boxes as Record<string, { x: number; width: number } | null>
    expect(box.courtyard).toEqual({ x: -0.93, y: -0.47, width: 1.86, height: 0.94 })
    expect(box.fab).toEqual({ x: -0.5, y: -0.25, width: 1, height: 0.5 })
    expect(box.pads?.width).toBeCloseTo(1.61, 2)
    const models = answer.models as Array<Record<string, unknown>>
    expect(models).toHaveLength(1)
    expect(models[0].resolved).toContain('.step')
    expect(models[0].status).toBe('resolved')
    expect(models[0].bounds).toEqual({ x: -0.5, y: -0.25, w: 1, h: 0.5, zMin: 0, zMax: 0.35 })
    expect(models[0].offset).toEqual({ x: 0, y: 0, z: 0 })
  })

  test('a model is resolved, not decoded, unless modelFit asks where it lands', async () => {
    const decoded: boolean[] = []
    const base = context()
    const agent = createLibraryAgent({
      ...base,
      modelFacts: (input) => {
        decoded.push(input.decode !== false)
        return base.modelFacts(input)
      }
    })
    const answer = (await agent.dispatch({
      kind: 'get-footprint',
      footprint: R_0402_RECORD.id,
      maxPads: 200
    })) as Record<string, unknown>
    const models = answer.models as Array<Record<string, unknown>>
    expect(models[0].status).toBe('resolved')
    expect(models[0]).not.toHaveProperty('bounds')
    expect(decoded).toEqual([false])
  })

  test('counts pads past the cap rather than listing them', async () => {
    const agent = createLibraryAgent(context())
    const answer = (await agent.dispatch({
      kind: 'get-footprint',
      footprint: R_0402_RECORD.id,
      maxPads: 1
    })) as Record<string, unknown>
    expect((answer.pads as unknown[]).length).toBe(1)
    expect(answer.padCount).toBe(2)
    expect(answer.truncated).toBe(true)
    expect(answer.guidance).toContain('items_query')
  })

  test('refuses an id the index lacks, with the nearest real ids', async () => {
    const agent = createLibraryAgent(context())
    const answer = await agent.dispatch({
      kind: 'get-footprint',
      footprint: 'Resistor_SMD:R_0402',
      maxPads: 200
    })
    expect(answer).toEqual({
      error: 'unknown-footprint',
      detail: 'Resistor_SMD:R_0402',
      candidates: [R_0402_RECORD.id]
    })
  })

  test('says the file is unreadable rather than answering an empty footprint', async () => {
    const agent = createLibraryAgent(context({ readFile: async () => null }))
    const answer = (await agent.dispatch({
      kind: 'get-footprint',
      footprint: R_0402_RECORD.id,
      maxPads: 200
    })) as Record<string, unknown>
    expect(answer.error).toBe('footprint-unreadable')
  })
})

describe('render-footprint', () => {
  test('draws the parsed footprint and answers the picture with its frame', async () => {
    const captureFootprint = vi.fn<LibraryAgentContext['captureFootprint']>(() => shot)
    const agent = createLibraryAgent(context({ captureFootprint }))
    const answer = (await agent.dispatch({
      kind: 'render-footprint',
      footprint: R_0402_RECORD.id,
      maxPixels: 400
    })) as Record<string, unknown>
    expect(answer.error).toBeUndefined()
    expect(answer.frame).toEqual({ x: -10, y: -7.5, width: 20, height: 15 })
    expect(answer.image).toEqual({ mimeType: 'image/png', base64: 'UElORw==' })
    const [footprint, maxPixels] = captureFootprint.mock.calls[0]!
    expect(footprint.pads).toHaveLength(2)
    expect(maxPixels).toBe(400)
  })
})

describe('create-symbol and delete-symbol pass through the project writer', () => {
  test('a created symbol announces its file and opens it behind the active tab', async () => {
    const libraryChanged = vi.fn(async () => {})
    const openBehind = vi.fn()
    const agent = createLibraryAgent(
      context({
        libraryChanged,
        openBehind,
        createSymbol: async (input) => {
          const plan = planSymbol(input.groups ?? [], input.pins ?? [])
          if (!plan.ok) throw new Error(plan.error)
          return {
            ok: true as const,
            libId: `proj:${input.name}`,
            libraryPath: '/proj/proj.kicad_sym',
            nickname: 'proj',
            created: true,
            replaced: false,
            layout: plan.layout,
            inTab: false
          }
        }
      })
    )
    const answer = (await agent.dispatch({
      kind: 'create-symbol',
      name: 'NEW',
      groups: [
        { id: 'pwr', role: 'power' },
        { id: 'gnd', role: 'ground' }
      ],
      pins: [
        { number: '1', name: 'VDD', type: 'power_in', group: 'pwr' },
        { number: '2', name: 'GND', type: 'power_in', group: 'gnd' }
      ]
    })) as Record<string, unknown>
    expect(answer.libId).toBe('proj:NEW')
    expect(answer.createdLibrary).toBe(true)
    expect(answer.changed).toEqual({ created: ['proj:NEW'], updated: [], deleted: [] })
    expect(answer).not.toHaveProperty('revision')
    expect(libraryChanged).toHaveBeenCalledWith('/proj/proj.kicad_sym', true)
    expect(openBehind).toHaveBeenCalledWith('/proj/proj.kicad_sym')
  })

  test('a blank power symbol passes its kind and a #PWR reference, and answers no layout', async () => {
    const createSymbol = vi.fn<LibraryAgentContext['createSymbol']>(async (input) => ({
      ok: true as const,
      libId: `proj:${input.name}`,
      libraryPath: '/proj/proj.kicad_sym',
      nickname: 'proj',
      created: false,
      replaced: false,
      inTab: false
    }))
    const agent = createLibraryAgent(context({ createSymbol }))
    const answer = (await agent.dispatch({
      kind: 'create-symbol',
      name: '+5V',
      power: 'global'
    })) as Record<string, unknown>
    const [input] = createSymbol.mock.calls[0]!
    expect(input).toMatchObject({ power: 'global', fields: { reference: '#PWR', value: '+5V' } })
    expect(input.pins).toBeUndefined()
    expect(answer).not.toHaveProperty('pinsDrawn')
    expect(String(answer.guidance)).toContain('Blank')
  })

  test("a writer's refusal comes back as the door's failure, remedy included", async () => {
    const agent = createLibraryAgent(
      context({
        deleteSymbol: async () => ({ ok: false, error: 'no-project', remedy: 'Open one.' })
      })
    )
    const answer = await agent.dispatch({ kind: 'delete-symbol', symbol: 'proj:X' })
    expect(answer).toEqual({ error: 'no-project', detail: 'Open one.' })
  })
})

describe('copy-symbol and the delete refusals', () => {
  test('copies a library symbol into the project library and answers the new id', async () => {
    const copySymbol = vi.fn<LibraryAgentContext['copySymbol']>(async (input) => ({
      ok: true,
      libId: `proj:${input.name}`,
      libraryPath: '/proj/proj.kicad_sym',
      createdLibrary: false,
      inTab: true
    }))
    const openBehind = vi.fn()
    const agent = createLibraryAgent(
      context({ copySymbol, openBehind, libraryRevision: async () => 7 })
    )
    const answer = (await agent.dispatch({
      kind: 'copy-symbol',
      libId: 'Device:R',
      name: 'R_Sense'
    })) as Record<string, unknown>
    expect(answer).toEqual({
      libId: 'proj:R_Sense',
      source: 'Device:R',
      file: '/proj/proj.kicad_sym',
      changed: { created: ['proj:R_Sense'], updated: [], deleted: [] },
      revision: 7,
      guidance: expect.any(String)
    })
    const [input] = copySymbol.mock.calls[0]!
    expect(input.name).toBe('R_Sense')
    expect(openBehind).toHaveBeenCalledWith('/proj/proj.kicad_sym')
  })

  test('a source no tier has is refused with candidates', async () => {
    const agent = createLibraryAgent(context())
    expect(await agent.dispatch({ kind: 'copy-symbol', libId: 'Device:Q' })).toEqual({
      error: 'unknown-symbol',
      detail: 'Device:Q',
      candidates: ['Device:R']
    })
  })

  test('deleting from a read-only tier is refused before the writer runs', async () => {
    const agent = createLibraryAgent(context())
    expect(await agent.dispatch({ kind: 'delete-symbol', symbol: 'Device:R' })).toMatchObject({
      error: 'library-read-only'
    })
    expect(
      await agent.dispatch({ kind: 'delete-footprint', footprint: R_0402_RECORD.id })
    ).toMatchObject({ error: 'library-read-only' })
  })

  test('a pin carries its angle', async () => {
    const agent = createLibraryAgent(context())
    const answer = (await agent.dispatch({ kind: 'get-symbol', symbol: 'Device:R' })) as {
      pins: Array<{ angle?: number }>
    }
    expect(answer.pins.every((pin) => typeof pin.angle === 'number')).toBe(true)
  })
})

describe('create-footprint and delete-footprint', () => {
  const request: McpCreateFootprintRequest = {
    kind: 'create-footprint',
    name: 'PAD2',
    attributes: 'smd',
    pads: [
      {
        number: '1',
        type: 'smd',
        shape: 'rect',
        at: { x: -1, y: 0 },
        size: { width: 0.6, height: 0.6 },
        array: { count: 2, dx: 2, dy: 0 }
      },
      {
        number: '4',
        type: 'smd',
        shape: 'rect',
        at: { x: 0, y: 1 },
        size: { width: 0.4, height: 0.4 }
      }
    ],
    body: { rect: { x: -1.5, y: -0.5, width: 3, height: 1 } },
    pin1: '1',
    symbol: 'proj:PART',
    style: DEFAULT_STYLE_CHOICES,
    maxPads: 2
  }

  test('answers with the pads, what was derived, the checks and the pin check', async () => {
    const libraryChanged = vi.fn(async () => {})
    const refreshIndex = vi.fn(async () => {})
    const openBehind = vi.fn()
    const agent = createLibraryAgent(
      context({
        libraryChanged,
        refreshIndex,
        openBehind,
        createFootprint: async (input) => {
          const generated = generateFootprint(input.spec, input.style)
          if (!generated.ok) throw new Error(generated.error)
          return {
            ok: true as const,
            libId: 'proj:PAD2',
            libraryPath: '/proj/proj.pretty',
            file: '/proj/proj.pretty/PAD2.kicad_mod',
            createdLibrary: true,
            replaced: false,
            report: generated.report,
            checks: []
          }
        }
      })
    )
    const answer = (await agent.dispatch(request)) as Record<string, unknown>
    expect(answer.libId).toBe('proj:PAD2')
    expect(answer.padCount).toBe(3)
    expect(answer.pads).toHaveLength(2)
    expect(answer.truncated).toBe(true)
    // The symbol has pins 1, 2 and 3; the footprint pads 1, 2 and 4.
    expect(answer.pinCheck).toEqual({
      symbol: 'proj:PART',
      matched: 2,
      padsWithoutPin: ['4'],
      pinsWithoutPad: ['3']
    })
    expect(answer.style).toEqual(DEFAULT_STYLE_CHOICES)
    expect(answer.checks).toEqual({ new: [], resolved: [] })
    expect(answer.changed).toEqual({ created: ['proj:PAD2'], updated: [], deleted: [] })
    expect(libraryChanged).toHaveBeenCalledWith('/proj/proj.pretty/PAD2.kicad_mod', true)
    expect(refreshIndex).toHaveBeenCalled()
    expect(openBehind).toHaveBeenCalledWith('/proj/proj.pretty/PAD2.kicad_mod')
  })

  test('says so when the symbol to compare against is not in any library', async () => {
    const agent = createLibraryAgent(
      context({
        createFootprint: async (input) => {
          const generated = generateFootprint(input.spec, input.style)
          if (!generated.ok) throw new Error(generated.error)
          return {
            ok: true as const,
            libId: 'proj:PAD2',
            libraryPath: '/proj/proj.pretty',
            file: '/proj/proj.pretty/PAD2.kicad_mod',
            createdLibrary: false,
            replaced: true,
            report: generated.report,
            checks: []
          }
        }
      })
    )
    const answer = (await agent.dispatch({ ...request, symbol: 'nope:X' })) as {
      pinCheck: { note?: string }
    }
    expect(answer.pinCheck.note).toMatch(/No library has that symbol/)
  })

  test('a refusal carries its detail and its remedy', async () => {
    const agent = createLibraryAgent(
      context({
        createFootprint: async () => ({
          ok: false,
          error: 'pads-overlap',
          detail: 'Copper of pads 1 and 2 would touch.',
          remedy: 'Check the positions.'
        }),
        deleteFootprint: async () => ({
          ok: false,
          error: 'footprint-not-found',
          detail: 'proj:X',
          candidates: ['proj:Y']
        })
      })
    )
    expect(await agent.dispatch(request)).toEqual({
      error: 'pads-overlap',
      detail: 'Copper of pads 1 and 2 would touch. Check the positions.'
    })
    expect(await agent.dispatch({ kind: 'delete-footprint', footprint: 'proj:X' })).toEqual({
      error: 'footprint-not-found',
      detail: 'proj:X',
      candidates: ['proj:Y']
    })
  })

  test('a deletion announces the file and re-reads the index', async () => {
    const libraryChanged = vi.fn(async () => {})
    const refreshIndex = vi.fn(async () => {})
    const agent = createLibraryAgent(
      context({
        libraryChanged,
        refreshIndex,
        deleteFootprint: async () => ({
          ok: true,
          libId: 'proj:X',
          libraryPath: '/proj/proj.pretty',
          file: '/proj/proj.pretty/X.kicad_mod',
          remaining: ['Y']
        })
      })
    )
    const answer = (await agent.dispatch({
      kind: 'delete-footprint',
      footprint: 'proj:X'
    })) as Record<string, unknown>
    expect(answer).toMatchObject({
      changed: { created: [], updated: [], deleted: ['proj:X'] },
      file: '/proj/proj.pretty/X.kicad_mod'
    })
    expect(libraryChanged).toHaveBeenCalledWith('/proj/proj.pretty/X.kicad_mod', false)
    expect(refreshIndex).toHaveBeenCalled()
  })
})

describe('land-pattern', () => {
  test('answers the pad table with the density it used', async () => {
    const agent = createLibraryAgent(context())
    const answer = (await agent.dispatch({
      kind: 'land-pattern',
      leadType: 'chip',
      density: 'nominal',
      densitySource: 'board-intent',
      body: { x: { min: 1.5, max: 1.7 }, y: { min: 0.7, max: 0.95 } },
      lead: { length: { min: 0.15, max: 0.4 } }
    })) as { pads: unknown[]; notes: Record<string, unknown> }
    expect(answer.pads).toHaveLength(2)
    expect(answer.notes).toMatchObject({ density: 'nominal', densitySource: 'board-intent' })
  })

  test('a package it cannot compute is a refusal', async () => {
    const agent = createLibraryAgent(context())
    expect(
      await agent.dispatch({
        kind: 'land-pattern',
        leadType: 'gullwing',
        density: 'nominal',
        densitySource: 'default',
        body: { x: { nominal: 3.9 }, y: { nominal: 4.9 } },
        lead: { width: { nominal: 0.4 }, length: { nominal: 0.8 } },
        pitch: 1.27,
        pins: { y: 4 }
      })
    ).toMatchObject({ error: 'bad-package' })
  })
})
