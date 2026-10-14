import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpDesignRequest } from '../../preload/mcpTypes'
import { createWorkspaces, type WorkspaceRow, type Workspaces } from '../workspaces'
import { createWorkspaceService, type WorkspaceWindows } from '../workspaceService'
import type { WorkspaceService } from '../ops/context'

const dir = mkdtempSync(join(tmpdir(), 'goatcad-workspaces-'))
const canary = join(dir, 'canary')
const pedal = join(dir, 'pedal')
for (const folder of [canary, pedal]) mkdirSync(folder)
writeFileSync(join(canary, 'canary.kicad_pro'), '{}')
writeFileSync(join(pedal, 'pedal.kicad_pro'), '{}')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Windows as a fake app holds them: tabs, unsaved files, what each was asked. */
interface Fake {
  tabs: string[]
  unsaved: string[]
  shown: boolean
  asked: McpDesignRequest[]
}

let registry: Workspaces
let fakes: Map<number, Fake>
let left: string[]
let service: WorkspaceService

beforeEach(() => {
  let count = 0
  registry = createWorkspaces({ newId: (prefix) => `${prefix}_${++count}` })
  fakes = new Map()
  left = []
  let windowId = 0
  const windows: WorkspaceWindows = {
    open(init, { hidden, join }) {
      const id = ++windowId
      fakes.set(id, { tabs: [...init.tabs], unsaved: [], shown: !hidden, asked: [] })
      if (join) registry.join(join, id)
      else registry.create({ root: init.root, project: init.project, window: id, hidden })
      return id
    },
    show: (id) => void (fakes.get(id)!.shown = true),
    tabs: (id) => fakes.get(id)?.tabs ?? [],
    close: (id) => {
      fakes.delete(id)
      registry.leave(id)
    },
    removeTab: (id, path) => {
      const fake = fakes.get(id)!
      fake.tabs = fake.tabs.filter((tab) => tab !== path)
    },
    ask: async (id, request) => {
      const fake = fakes.get(id)!
      fake.asked.push(request)
      if (request.kind === 'unsaved-files') return { ok: true, payload: { unsaved: fake.unsaved } }
      return { ok: true, payload: { project: null } }
    },
    leave: (connection) => void left.push(connection)
  }
  service = createWorkspaceService(registry, windows)
})

const started = async (
  args: Parameters<WorkspaceService['start']>[1],
  connection = 'c'
): Promise<WorkspaceRow> => {
  const answer = await service.start({ connection }, args)
  if (!answer.ok) throw new Error(answer.error)
  return answer.value
}

describe('the workspace service', () => {
  it("starts on a project in the background, defaulting the folder to the project's", async () => {
    const row = await started({ project: join(canary, 'canary.kicad_pro'), openWindow: false })
    expect(row).toMatchObject({
      root: canary,
      project: { name: 'canary' },
      windows: [],
      connections: 1
    })
    expect(service.attached({ connection: 'c' })?.id).toBe(row.id)
    expect([...fakes.values()][0].shown).toBe(false)
  })

  it('refuses a project or folder another workspace holds, naming it', async () => {
    const first = await started({ root: canary, openWindow: true })
    for (const args of [
      { project: join(canary, 'canary.kicad_pro'), openWindow: false },
      { root: canary, openWindow: false }
    ])
      await expect(service.start({ connection: 'd' }, args)).resolves.toMatchObject({
        ok: false,
        error: 'project-in-workspace',
        candidates: [first.id]
      })
    await expect(
      service.start({}, { project: join(canary, 'missing.kicad_pro'), openWindow: false })
    ).resolves.toMatchObject({ ok: false, error: 'file-not-found' })
  })

  it('attaches by id, closing the viewport left behind', async () => {
    const a = await started({ root: canary, openWindow: true })
    const b = await started({ root: pedal, openWindow: true }, 'other')
    expect(service.attach({ connection: 'c' }, b.id)).toMatchObject({ ok: true })
    expect(left).toEqual(['c'])
    expect(service.attach({ connection: 'c' }, 'ws_nope')).toMatchObject({
      ok: false,
      error: 'workspace-not-found',
      candidates: [a.id, b.id]
    })
    expect(service.attach({}, a.id)).toMatchObject({ ok: false, error: 'no-connection' })
  })

  it('shows a background workspace as its first window, with what it holds', async () => {
    const row = await started({ root: canary, openWindow: false })
    const [id] = registry.get(row.id)!.windows
    fakes.get(id)!.tabs = [join(canary, 'canary.kicad_sch')]
    const opened = await service.openWindow(row.id, [])
    expect(opened).toMatchObject({ ok: true, value: { files: [join(canary, 'canary.kicad_sch')] } })
    expect(fakes.get(id)!.shown).toBe(true)
    expect(registry.get(row.id)!.hidden).toBe(false)
  })

  it('opens another window, moving open files into it unless they hold unsaved edits', async () => {
    const row = await started({ root: canary, openWindow: true })
    const [first] = registry.get(row.id)!.windows
    const sheet = join(canary, 'canary.kicad_sch')
    const board = join(canary, 'canary.kicad_pcb')
    fakes.get(first)!.tabs = [sheet, board]
    fakes.get(first)!.unsaved = [board]
    await expect(service.openWindow(row.id, [board])).resolves.toMatchObject({
      ok: false,
      error: 'unsaved-edits'
    })
    const opened = await service.openWindow(row.id, [sheet])
    expect(opened).toMatchObject({ ok: true, value: { files: [sheet] } })
    expect(fakes.get(first)!.tabs).toEqual([board])
    expect(registry.get(row.id)!.windows).toHaveLength(2)
  })

  it('closes only with nothing unsaved, unless told to discard', async () => {
    const row = await started({ root: canary, openWindow: true })
    const [id] = registry.get(row.id)!.windows
    fakes.get(id)!.unsaved = ['/x.kicad_sch']
    await expect(service.close(row.id, false)).resolves.toMatchObject({
      ok: false,
      error: 'unsaved-edits',
      candidates: ['/x.kicad_sch']
    })
    await expect(service.close(row.id, true)).resolves.toEqual({
      ok: true,
      value: { closed: row.id }
    })
    expect(registry.get(row.id)).toBeNull()
  })

  it('closes one window, and the workspace with its last', async () => {
    const row = await started({ root: canary, openWindow: true })
    await service.openWindow(row.id, [])
    const [a, b] = registry.get(row.id)!.windows
    await expect(service.closeWindow(registry.windowKey(a), false)).resolves.toMatchObject({
      ok: true,
      value: { workspaceClosed: false }
    })
    await expect(service.closeWindow(registry.windowKey(b), false)).resolves.toMatchObject({
      ok: true,
      value: { workspaceClosed: true }
    })
    await expect(service.closeWindow('win_nope', false)).resolves.toMatchObject({
      ok: false,
      error: 'window-not-found'
    })
  })

  it('retargets every window, refusing with unsaved edits', async () => {
    const row = await started({ root: canary, openWindow: true })
    const [id] = registry.get(row.id)!.windows
    fakes.get(id)!.unsaved = ['/x.kicad_sch']
    await expect(service.update({ workspace: row.id, root: pedal })).resolves.toMatchObject({
      ok: false,
      error: 'unsaved-edits'
    })
    fakes.get(id)!.unsaved = []
    const answer = await service.update({
      workspace: row.id,
      project: join(pedal, 'pedal.kicad_pro')
    })
    expect(answer).toMatchObject({ ok: true, value: { root: pedal, project: { name: 'pedal' } } })
    expect(fakes.get(id)!.asked.at(-1)).toEqual({
      kind: 'set-workspace',
      root: pedal,
      project: join(pedal, 'pedal.kicad_pro')
    })
  })
})
