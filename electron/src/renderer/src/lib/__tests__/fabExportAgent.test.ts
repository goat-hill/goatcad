import { describe, expect, it } from 'vitest'
import { createFabExportAgent, type FabExportAgentContext } from '../fabExportAgent'
import type { FabExportPayload } from '../../../../preload/fabTypes'
import type { GerberCaptureRequest } from '../engine/gerberCapture'

const PATH = '/work/demo/demo.kicad_pcb'

// A closed outline, one through-hole part with an LCSC number and one SMD part.
const BOARD = `
(kicad_pcb (version 20240108) (generator pcbnew)
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
  (footprint "Connector:Pin" (layer "F.Cu") (at 5 5)
    (property "Reference" "J1" (at 0 0))
    (property "Value" "Header" (at 0 0))
    (property "LCSC" "C123" (at 0 0))
    (attr through_hole)
    (pad "1" thru_hole circle (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask")))
  (footprint "Resistor_SMD:R_0603" (layer "F.Cu") (at 15 10 90)
    (property "Reference" "R1" (at 0 0))
    (property "Value" "10k" (at 0 0))
    (attr smd)
    (pad "1" smd rect (at -0.8 0) (size 0.9 0.8) (layers "F.Cu" "F.Mask"))))
`

const fake = (
  over: Partial<FabExportAgentContext> = {}
): {
  ctx: FabExportAgentContext
  writes: FabExportPayload[]
  captures: GerberCaptureRequest[]
} => {
  const writes: FabExportPayload[] = []
  const captures: GerberCaptureRequest[] = []
  // What the writes put on disk, by path, for a render to read back.
  const disk = new Map<string, string>([[PATH, BOARD]])
  const ctx: FabExportAgentContext = {
    boardFiles: () => [PATH],
    resolveBoard: (name) => (PATH.endsWith(name) ? PATH : null),
    unsaved: () => false,
    staleZones: () => new Set(),
    readText: async (path) => disk.get(path) ?? null,
    designSettings: async () => null,
    write: async (payload) => {
      writes.push(payload)
      for (const file of payload.files) disk.set(`${payload.directory}/${file.name}`, file.content)
      return {
        success: true,
        directory: payload.directory,
        written: payload.files.map((f) => ({
          path: `${payload.directory}/${f.name}`,
          bytes: f.content.length
        })),
        ...(payload.archive
          ? { archive: { path: `${payload.directory}/${payload.archive.name}`, bytes: 1 } }
          : {})
      }
    },
    listDir: async (dir) =>
      [...disk.keys()]
        .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
        .map((path) => ({ name: path.slice(dir.length + 1), path, isDir: false })),
    captureGerbers: async (request) => {
      captures.push(request)
      return {
        dataUrl: 'data:image/png;base64,AAAA',
        width: 100,
        height: 50,
        visible: { minX: 0, minY: -20, maxX: 30, maxY: 0 }
      }
    },
    ...over
  }
  return { ctx, writes, captures }
}

type Answer = Record<string, unknown> & {
  error?: string
  files?: Array<{ path?: string; name?: string; bytes?: number; summary: string }>
}

describe('the fab export door', () => {
  it('refuses a board with unsaved edits, and one with stale zones', async () => {
    const unsaved = createFabExportAgent(fake({ unsaved: () => true }).ctx)
    expect(
      ((await unsaved.dispatch({ kind: 'export-board', output: 'gerber' })) as Answer).error
    ).toBe('board-unsaved')
    const stale = createFabExportAgent(fake({ staleZones: () => new Set(['zone-1']) }).ctx)
    expect(
      ((await stale.dispatch({ kind: 'export-board', output: 'drill' })) as Answer).error
    ).toBe('zones-stale')
  })

  it('writes one writer’s files beside the board and answers paths, not content', async () => {
    const { ctx, writes } = fake()
    const answer = (await createFabExportAgent(ctx).dispatch({
      kind: 'export-board',
      output: 'bom',
      bom: {
        columns: [
          { label: 'Designator', field: 'Reference' },
          { label: 'Comment', field: 'Value' }
        ]
      }
    })) as Answer
    expect(writes[0].directory).toBe('/work/demo/fab')
    expect(writes[0].files.map((f) => f.name)).toEqual(['demo-bom.csv'])
    expect(writes[0].files[0].content).toBe('Designator,Comment\r\nJ1,Header\r\nR1,10k')
    expect(writes[0].archive).toBeNull()
    expect(answer.files).toEqual([
      { path: '/work/demo/fab/demo-bom.csv', bytes: 37, summary: 'BOM, 2 rows' }
    ])
    expect(JSON.stringify(answer)).not.toContain('J1')
  })

  it('takes a directory relative to the board', async () => {
    const { ctx, writes } = fake()
    await createFabExportAgent(ctx).dispatch({
      kind: 'export-board',
      output: 'drill',
      directory: '../out'
    })
    expect(writes[0].directory).toBe('/work/out')
    expect(writes[0].files.map((f) => f.name)).toEqual(['demo-PTH.drl'])
  })

  it("dry-runs a profile's package: its checklist and files, nothing written", async () => {
    const { ctx, writes } = fake()
    const answer = (await createFabExportAgent(ctx).dispatch({
      kind: 'export-board',
      output: 'package',
      profile: 'jlcpcb',
      dryRun: true
    })) as Answer
    expect(writes).toHaveLength(0)
    expect(answer.verdict).not.toBe('blocked')
    const names = answer.files!.map((f) => f.name)
    expect(names).toContain('demo.GTL')
    expect(names).toContain('demo-bom.csv')
    expect(answer.archive).toMatchObject({ name: 'demo-gerbers.zip' })
    expect((answer.archive as { files: string[] }).files).not.toContain('demo-bom.csv')
  })

  it('holds the board to the live schematic, as the drawer does', async () => {
    const rules = async (over: Partial<FabExportAgentContext>): Promise<unknown> => {
      const answer = (await createFabExportAgent(fake(over).ctx).dispatch({
        kind: 'export-board',
        output: 'package',
        profile: 'jlcpcb',
        dryRun: true
      })) as Answer & { findings: Array<{ check: string; rules?: Array<{ subject: string }> }> }
      return (
        answer.findings.find((f) => f.check === 'drcWarnings')?.rules?.map((r) => r.subject) ?? []
      )
    }
    const j1 = {
      reference: 'J1',
      value: 'Header',
      libId: 'Connector:Pin',
      filters: [],
      fields: [],
      dnp: false,
      excludeFromBom: false,
      pins: new Map([['1', 'unconnected-(J1-Pad1)']])
    }
    expect(await rules({})).not.toContain('extra-footprint')
    expect(await rules({ schematicNetlist: async () => ({ parts: [j1] }) })).toContain(
      'extra-footprint'
    )
  })

  it("replaces one of a profile's formats, keeping the rest", async () => {
    const { ctx, writes } = fake()
    await createFabExportAgent(ctx).dispatch({
      kind: 'export-board',
      output: 'package',
      profile: 'jlcpcb',
      drill: { separatePlated: false },
      archive: []
    })
    const names = writes[0].files.map((f) => f.name)
    expect(names).toContain('demo.drl')
    expect(names).toContain('demo.GTL')
    expect(writes[0].archive).toBeNull()
  })

  it('names the profiles there are when one is unknown, and a package with none to write', async () => {
    const agent = createFabExportAgent(fake().ctx)
    const missing = (await agent.dispatch({
      kind: 'export-board',
      output: 'package',
      profile: 'nope'
    })) as Answer
    expect(missing.error).toBe('profile-not-found')
    expect(missing.candidates).toContain('jlcpcb')
    const empty = (await agent.dispatch({ kind: 'export-board', output: 'package' })) as Answer
    expect(empty.error).toBe('nothing-to-export')
  })

  it('lists the profiles with their sources and open questions, and reads one in full', async () => {
    const agent = createFabExportAgent(fake().ctx)
    const list = (await agent.dispatch({ kind: 'export-profiles' })) as {
      profiles: Array<{ id: string; sources: string[]; todo?: string[] }>
    }
    const jlc = list.profiles.find((p) => p.id === 'jlcpcb')!
    expect(jlc.sources.length).toBeGreaterThan(0)
    expect(list.profiles.find((p) => p.id === 'jlcpcb')!.todo?.length).toBeGreaterThan(0)
    const one = (await agent.dispatch({ kind: 'export-profiles', profile: 'jlcpcb' })) as {
      formats: { gerber: { naming: string } }
    }
    expect(one.formats.gerber.naming).toBe('protel')
  })

  it('draws an exported set back, every layer identified and the holes on top', async () => {
    const { ctx, captures } = fake()
    const agent = createFabExportAgent(ctx)
    await agent.dispatch({ kind: 'export-board', output: 'package', profile: 'jlcpcb' })
    const answer = (await agent.dispatch({
      kind: 'render-gerbers',
      maxPixels: 512
    })) as Answer & { layers: Array<{ file: string; layer: string | null }> }
    expect(answer.error).toBeUndefined()
    expect(answer.layers.map((l) => l.layer)).toEqual(
      expect.arrayContaining(['F.Cu', 'B.Cu', 'F.Mask', 'Edge.Cuts', 'drill'])
    )
    expect(answer.layers.at(-1)?.layer).toBe('drill')
    expect(answer.layers.every((l) => l.layer !== null)).toBe(true)
    expect(answer.frame).toEqual({ x: 0, y: -20, width: 30, height: 20 })
    expect(captures[0].maxPixels).toBe(512)
  })

  it('draws only the layers named, and names the ones there are when none match', async () => {
    const { ctx, captures } = fake()
    const agent = createFabExportAgent(ctx)
    await agent.dispatch({ kind: 'export-board', output: 'gerber' })
    await agent.dispatch({ kind: 'render-gerbers', layers: ['Edge.Cuts'], maxPixels: 256 })
    expect(captures[0].layers.map((l) => l.kicadLayer)).toEqual(['Edge.Cuts'])
    const none = (await agent.dispatch({
      kind: 'render-gerbers',
      layers: ['In7.Cu'],
      maxPixels: 256
    })) as Answer
    expect(none.error).toBe('layer-not-found')
    expect(none.candidates).toContain('F.Cu')
  })
})
