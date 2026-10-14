import { describe, expect, it } from 'vitest'
import { pickDesignWindow, type DesignWindowState } from '../designWindow'

const win = (
  id: number,
  workspace: string,
  tabPaths: string[],
  root: string | null = '/p'
): DesignWindowState => ({ id, key: `win_${id}`, workspace, root, tabPaths })

describe('pickDesignWindow', () => {
  it("answers the workspace's window, whatever else is open", () => {
    const windows = [win(1, 'other', ['/q/main.kicad_sch'], '/q'), win(2, 'ws', [])]
    expect(pickDesignWindow({ kind: 'describe-schematic' }, 'ws', windows)).toEqual({ window: 2 })
  })

  it('is null for a workspace with no window', () => {
    expect(pickDesignWindow({}, 'ws', [win(1, 'other', [])])).toBeNull()
  })

  it('goes to the window of the workspace holding the named file', () => {
    const windows = [win(1, 'ws', []), win(2, 'ws', ['/p/sub/power.kicad_sch'])]
    expect(pickDesignWindow({ sheet: 'sub/power.kicad_sch' }, 'ws', windows)).toEqual({ window: 2 })
    expect(pickDesignWindow({ sheet: 'power.kicad_sch' }, 'ws', windows)).toEqual({ window: 2 })
  })

  it('does not match a name that is only a suffix of another', () => {
    const windows = [win(1, 'ws', []), win(2, 'ws', ['/p/mypower.kicad_sch'])]
    expect(pickDesignWindow({ sheet: 'power.kicad_sch' }, 'ws', windows)).toEqual({ window: 1 })
  })

  it('reads a bare name as its own workspace file, even when another holds one of that name', () => {
    const windows = [win(1, 'other', ['/q/main.kicad_sch'], '/q'), win(2, 'ws', [])]
    expect(pickDesignWindow({ sheet: 'main.kicad_sch' }, 'ws', windows)).toEqual({ window: 2 })
  })

  it('refuses a full path another workspace holds or contains, naming it', () => {
    const windows = [win(1, 'other', ['/q/main.kicad_sch'], '/q'), win(2, 'ws', [])]
    for (const sheet of ['/q/main.kicad_sch', '/q/sub/power.kicad_sch'])
      expect(pickDesignWindow({ sheet }, 'ws', windows)).toMatchObject({
        refused: 'file-in-workspace',
        candidates: ['other']
      })
    // A folder nested in another's is its own workspace's.
    const nested = [win(1, 'other', [], '/q'), win(2, 'ws', [], '/q/inner')]
    expect(pickDesignWindow({ sheet: '/q/inner/a.kicad_sch' }, 'ws', nested)).toEqual({ window: 2 })
  })

  it('sends an unnamed request from a design-less first window to the design beside it', () => {
    const windows = [win(1, 'ws', []), win(2, 'ws', ['/p/main.kicad_pcb'])]
    expect(pickDesignWindow({ kind: 'describe-board' }, 'ws', windows)).toEqual({ window: 2 })
  })

  it('routes by a named window, refusing one it does not have or a file open in another', () => {
    const windows = [win(1, 'ws', ['/p/a.kicad_sch']), win(2, 'ws', []), win(3, 'other', [])]
    expect(
      pickDesignWindow({ kind: 'open-file', file: 'b.kicad_pcb', window: 'win_2' }, 'ws', windows)
    ).toEqual({ window: 2 })
    expect(
      pickDesignWindow({ kind: 'open-file', file: 'b.kicad_pcb', window: 'win_3' }, 'ws', windows)
    ).toMatchObject({
      refused: 'window-not-found',
      candidates: ['win_1', 'win_2']
    })
    expect(
      pickDesignWindow({ kind: 'open-file', file: 'a.kicad_sch', window: 'win_2' }, 'ws', windows)
    ).toMatchObject({
      refused: 'file-in-window',
      candidates: ['win_1']
    })
  })

  it('needs a window to open a tab in when there are several and none holds the file', () => {
    const windows = [win(1, 'ws', ['/p/a.kicad_sch']), win(2, 'ws', [])]
    expect(
      pickDesignWindow({ kind: 'open-file', file: 'b.kicad_pcb' }, 'ws', windows)
    ).toMatchObject({
      refused: 'window-required'
    })
    expect(pickDesignWindow({ kind: 'open-file', file: 'a.kicad_sch' }, 'ws', windows)).toEqual({
      window: 1
    })
    expect(
      pickDesignWindow({ kind: 'open-file', file: 'b.kicad_pcb' }, 'ws', [windows[0]])
    ).toEqual({ window: 1 })
  })
})
