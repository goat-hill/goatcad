import { describe, expect, test } from 'vitest'
import { createAgentViewports, isViewportRequest, VIEWPORT_IDLE_MS } from '../agentViewports'
import type { AgentViewportShown } from '../agentViewportView'

const BOARD = '/p/phone.kicad_pcb'
const SHEET = '/p/power.kicad_sch'

const made = (
  options: { open?: string[] } = {}
): {
  viewports: ReturnType<typeof createAgentViewports>
  shown: AgentViewportShown[][]
  tabs: Set<string>
  opened: string[]
  clock: { now: number }
} => {
  const tabs = new Set(options.open ?? [BOARD, SHEET])
  const shown: AgentViewportShown[][] = []
  const opened: string[] = []
  const clock = { now: 0 }
  const files = [BOARD, SHEET, '/p/notes.txt']
  const viewports = createAgentViewports({
    isOpen: (path) => tabs.has(path),
    resolve: (name) => files.find((path) => path === name || path.endsWith(`/${name}`)) ?? null,
    candidates: () => files,
    open: async (path) => {
      opened.push(path)
      tabs.add(path)
    },
    show: (list) => void shown.push([...list]),
    now: () => clock.now
  })
  return { viewports, shown, tabs, opened, clock }
}

describe('agent viewports', () => {
  test('serves only its own two kinds', () => {
    expect(isViewportRequest({ kind: 'open-viewport', label: 'x' })).toBe(true)
    expect(isViewportRequest({ kind: 'close-viewport', viewport: 'viewport-1' })).toBe(true)
    expect(isViewportRequest({ kind: 'render-board', maxPixels: 512 })).toBe(false)
  })

  test('opens on a board and a sheet with distinct ids, relabels, and closes', async () => {
    const { viewports, shown } = made()
    const board = await viewports.dispatch({
      kind: 'open-viewport',
      board: 'phone.kicad_pcb',
      label: 'Placing'
    })
    expect(board).toMatchObject({
      viewport: 'viewport-1',
      board: { path: BOARD, name: 'phone.kicad_pcb' },
      label: 'Placing'
    })
    const sheet = await viewports.dispatch({
      kind: 'open-viewport',
      sheet: SHEET,
      label: 'Wiring'
    })
    expect(sheet).toMatchObject({ viewport: 'viewport-2', sheet: { path: SHEET } })
    expect(shown.at(-1)!.map((v) => [v.id, v.path, v.frame])).toEqual([
      ['viewport-1', BOARD, null],
      ['viewport-2', SHEET, null]
    ])

    expect(
      await viewports.dispatch({ kind: 'open-viewport', viewport: 'viewport-1', label: 'Routing' })
    ).toMatchObject({ viewport: 'viewport-1', label: 'Routing' })
    expect(shown.at(-1)![0].label).toBe('Routing')

    expect(await viewports.dispatch({ kind: 'close-viewport', viewport: 'viewport-1' })).toEqual({
      closed: 'viewport-1'
    })
    expect(shown.at(-1)!.map((v) => v.id)).toEqual(['viewport-2'])
    expect(await viewports.dispatch({ kind: 'close-viewport', viewport: 'viewport-1' })).toEqual({
      error: 'viewport-closed',
      detail: 'Viewport viewport-1 closed. viewport_close closed it.'
    })
    expect(await viewports.dispatch({ kind: 'close-viewport', viewport: 'viewport-7' })).toEqual({
      error: 'viewport-not-found',
      detail: 'No viewport viewport-7 is open.',
      candidates: ['viewport-2']
    })
  })

  test('opens a document no tab holds behind, and refuses what is not a board or sheet', async () => {
    const { viewports, opened } = made({ open: [] })
    await viewports.dispatch({ kind: 'open-viewport', board: 'phone.kicad_pcb', label: 'x' })
    expect(opened).toEqual([BOARD])
    expect(
      await viewports.dispatch({ kind: 'open-viewport', board: 'notes.txt', label: 'x' })
    ).toMatchObject({ error: 'invalid-args' })
    expect(
      await viewports.dispatch({ kind: 'open-viewport', board: 'gone.kicad_pcb', label: 'x' })
    ).toMatchObject({ error: 'file-not-found' })
    expect(await viewports.dispatch({ kind: 'open-viewport', label: 'x' })).toMatchObject({
      error: 'invalid-args'
    })
    expect(
      await viewports.dispatch({ kind: 'open-viewport', sheet: 'phone.kicad_pcb', label: 'x' })
    ).toMatchObject({ error: 'invalid-args' })
  })

  test('the person closing one tells the next call that names it', async () => {
    const { viewports } = made()
    const heard: string[] = []
    viewports.onClose((viewport, reason) => void heard.push(`${viewport.id}: ${reason}`))
    const mine = viewports.open(SHEET, 'Wiring')
    viewports.closeByPerson(mine.id)
    expect(heard).toEqual(['viewport-1: The user closed it from the canvas.'])
    expect(
      await viewports.dispatch({ kind: 'open-viewport', viewport: mine.id, label: 'again' })
    ).toEqual({
      error: 'viewport-closed',
      detail: 'Viewport viewport-1 closed. The user closed it from the canvas.'
    })
  })

  test('closes after ten idle minutes; a call naming it keeps it open', () => {
    const { viewports, clock } = made()
    const busy = viewports.open(BOARD, 'busy')
    const idle = viewports.open(BOARD, 'idle')
    clock.now = VIEWPORT_IDLE_MS - 1
    expect(viewports.find(busy.id)).toBe(busy)
    clock.now = VIEWPORT_IDLE_MS + 1
    viewports.sweep()
    expect(viewports.live().map((v) => v.id)).toEqual([busy.id])
    expect(viewports.find(idle.id)).toEqual({
      error: 'viewport-closed',
      detail: 'Viewport viewport-2 closed. It sat idle for 10 minutes.'
    })
  })

  test('closes when its document closes', () => {
    const { viewports, tabs } = made()
    const mine = viewports.open(SHEET, 'Wiring')
    tabs.delete(SHEET)
    expect(viewports.find(mine.id)).toEqual({
      error: 'viewport-closed',
      detail: 'Viewport viewport-1 closed. Its tab was closed.'
    })
  })

  test('a render in a viewport frames what it drew; a refused one moves nothing', async () => {
    const { viewports } = made()
    const mine = viewports.open(SHEET, 'Wiring')
    const frame = { x: 10, y: 20, width: 30, height: 15 }
    expect(
      await viewports.framed({ viewport: mine.id }, SHEET, async () => ({ frame, image: 'png' }))
    ).toEqual({
      frame,
      image: 'png',
      viewport: mine.id
    })
    expect(viewports.live()[0].frame).toEqual(frame)
    expect(
      await viewports.framed({ viewport: mine.id }, SHEET, async () => ({
        error: 'reference-not-found'
      }))
    ).toEqual({ error: 'reference-not-found' })
    expect(viewports.live()[0].frame).toEqual(frame)
    let ran = false
    expect(
      await viewports.framed({ viewport: mine.id }, BOARD, async () => {
        ran = true
        return { frame }
      })
    ).toMatchObject({ error: 'invalid-args' })
    expect(ran).toBe(false)
    expect(await viewports.framed({}, SHEET, async () => ({ frame }))).toEqual({ frame })
  })

  test("each call's action replaces the label; a refused call leaves it", async () => {
    const { viewports, shown } = made()
    const mine = viewports.open(SHEET, 'Board redesign')
    const frame = { x: 1, y: 2, width: 3, height: 4 }
    const at = { viewport: mine.id, action: 'Wire the LDO' }
    await viewports.framed(at, SHEET, async () => ({ frame }))
    expect(viewports.live()[0].label).toBe('Wire the LDO')
    expect(shown.at(-1)).toEqual([expect.objectContaining({ label: 'Wire the LDO', frame })])
    await viewports.framed({ viewport: mine.id, action: 'Check silk' }, SHEET, async () => ({
      error: 'reference-not-found'
    }))
    expect(viewports.live()[0].label).toBe('Wire the LDO')
    // Labeled even when the answer frames nothing.
    await viewports.framed({ viewport: mine.id, action: 'Check silk' }, SHEET, async () => ({}))
    expect(viewports.live()[0]).toMatchObject({ label: 'Check silk', frame })
    viewports.update(mine.id, { label: 'Route USB_DP' })
    expect(viewports.live()[0]).toMatchObject({ label: 'Route USB_DP', frame })
  })

  test("main's id relabels the connection's open viewport, moves it, or opens it again", async () => {
    const { viewports } = made()
    const heard: string[] = []
    viewports.onClose((viewport, reason) => void heard.push(`${viewport.id}: ${reason}`))
    const first = await viewports.dispatch({
      kind: 'open-viewport',
      board: 'phone.kicad_pcb',
      label: 'Placing',
      id: 'viewport-7'
    })
    expect(first).toMatchObject({ viewport: 'viewport-7', label: 'Placing' })
    viewports.update('viewport-7', { frame: { x: 0, y: 0, width: 5, height: 5 } })

    // Same document: relabeled in place, the box where it was.
    expect(
      await viewports.dispatch({
        kind: 'open-viewport',
        board: 'phone.kicad_pcb',
        label: 'Routing',
        id: 'viewport-7'
      })
    ).toMatchObject({ viewport: 'viewport-7', label: 'Routing', frame: { width: 5 } })
    expect(viewports.live()).toHaveLength(1)
    expect(heard).toEqual([])

    // Another document: moved there, and what ran in it ends.
    expect(
      await viewports.dispatch({
        kind: 'open-viewport',
        sheet: 'power.kicad_sch',
        label: 'Wiring',
        id: 'viewport-7'
      })
    ).toMatchObject({ viewport: 'viewport-7', sheet: { path: SHEET } })
    expect(viewports.live().map((v) => [v.id, v.path, v.frame])).toEqual([
      ['viewport-7', SHEET, null]
    ])
    expect(heard).toEqual(['viewport-7: viewport_open moved it to power.kicad_sch.'])

    // Closed by main as its client left, then opened again under the same id.
    expect(
      await viewports.dispatch({
        kind: 'close-viewport',
        viewport: 'viewport-7',
        reason: 'Its client disconnected.'
      })
    ).toEqual({ closed: 'viewport-7' })
    expect(viewports.find('viewport-7')).toMatchObject({
      detail: 'Viewport viewport-7 closed. Its client disconnected.'
    })
    await viewports.dispatch({
      kind: 'open-viewport',
      sheet: 'power.kicad_sch',
      label: 'Again',
      id: 'viewport-7'
    })
    expect(viewports.find('viewport-7')).toMatchObject({ id: 'viewport-7', label: 'Again' })
  })
})
