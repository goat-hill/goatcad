import { describe, expect, it } from 'vitest'
import { createWorkspaces, resolveWorkspace, type Workspaces } from '../workspaces'

const registry = (): Workspaces => {
  let count = 0
  return createWorkspaces({ newId: (prefix) => `${prefix}_${++count}` })
}

describe('workspaces', () => {
  it('groups windows, and ends a workspace with its last window', () => {
    const workspaces = registry()
    const ws = workspaces.create({ root: '/p', project: '/p/p.kicad_pro', window: 1 })
    workspaces.join(ws.id, 2)
    expect(workspaces.ofWindow(2)).toBe(ws)
    expect(workspaces.leave(1)).toBeNull()
    expect(workspaces.leave(2)).toBe(ws)
    expect(workspaces.get(ws.id)).toBeNull()
  })

  it("follows a sole window's folder, and splits off one of several that opens another", () => {
    const workspaces = registry()
    const ws = workspaces.create({ root: '/p', project: null, window: 1 })
    workspaces.report(1, { root: '/q', project: '/q/q.kicad_pro' })
    expect(ws).toMatchObject({ root: '/q', project: '/q/q.kicad_pro', windows: [1] })

    workspaces.join(ws.id, 2)
    workspaces.report(2, { root: '/Q/', project: '/q/q.kicad_pro' })
    expect(workspaces.ofWindow(2)).toBe(ws)
    workspaces.report(2, { root: '/r', project: null })
    expect(ws.windows).toEqual([1])
    expect(workspaces.ofWindow(2)).toMatchObject({ root: '/r', windows: [2] })
  })

  it('finds the workspace holding a path, the innermost folder winning', () => {
    const workspaces = registry()
    const outer = workspaces.create({ root: '/boards', project: null, window: 1 })
    const inner = workspaces.create({
      root: '/boards/canary',
      project: '/boards/canary/canary.kicad_pro',
      window: 2
    })
    expect(workspaces.holding('/boards/other/x.kicad_sch')).toBe(outer)
    expect(workspaces.holding('/boards/canary/x.kicad_sch')).toBe(inner)
    expect(workspaces.holding('/boards/canary/canary.kicad_pro')).toBe(inner)
    expect(workspaces.holding('/elsewhere')).toBeNull()
  })

  it('resolves the workspace a call names, else the only one open, and never guesses', () => {
    const workspaces = registry()
    expect(resolveWorkspace(undefined, workspaces)).toMatchObject({ error: 'no-workspace' })
    const mine = workspaces.create({ root: '/p', project: null, window: 1 })
    expect(resolveWorkspace(undefined, workspaces)).toEqual({ workspace: mine })
    const theirs = workspaces.create({ root: '/q', project: null, window: 2 })
    expect(resolveWorkspace(undefined, workspaces)).toMatchObject({
      error: 'workspace-required',
      candidates: [mine.id, theirs.id]
    })
    expect(resolveWorkspace(theirs.id, workspaces)).toEqual({ workspace: theirs })
    expect(resolveWorkspace('ws_gone', workspaces)).toMatchObject({ error: 'workspace-not-found' })
  })

  it('lists a workspace with no window as having none', () => {
    const workspaces = registry()
    const ws = workspaces.create({
      root: '/p',
      project: '/p/canary.kicad_pro',
      window: 7,
      hidden: true
    })
    expect(workspaces.row(ws, () => ['/p/a.kicad_sch'])).toEqual({
      id: ws.id,
      root: '/p',
      project: { path: '/p/canary.kicad_pro', name: 'canary' },
      windows: []
    })
    workspaces.reveal(ws.id)
    expect(workspaces.row(ws, () => ['/p/a.kicad_sch']).windows).toEqual([
      { id: workspaces.windowKey(7), files: ['/p/a.kicad_sch'] }
    ])
    expect(workspaces.windowById(workspaces.windowKey(7))).toBe(7)
  })
})
