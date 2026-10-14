import { describe, expect, it } from 'vitest'
import { pickDesignWindow, type DesignWindowState } from '../designWindow'

const win = (
  id: number,
  focused: boolean,
  tabPaths: string[],
  projectPath: string | null = '/p'
): DesignWindowState => ({ id, focused, projectPath, tabPaths })

describe('pickDesignWindow', () => {
  it('keeps the default with one window', () => {
    expect(pickDesignWindow({ sheet: 'main.kicad_sch' }, [win(1, true, [])])).toBeNull()
  })

  it('keeps the focused window when it holds the named file', () => {
    const windows = [win(1, true, ['/p/main.kicad_sch']), win(2, false, ['/p/main.kicad_sch'])]
    expect(pickDesignWindow({ sheet: 'main.kicad_sch' }, windows)).toBeNull()
  })

  it('goes to the window holding the file when the focused one does not', () => {
    const windows = [win(1, true, []), win(2, false, ['/p/sub/power.kicad_sch'])]
    expect(pickDesignWindow({ sheet: 'sub/power.kicad_sch' }, windows)).toBe(2)
    expect(pickDesignWindow({ sheet: 'power.kicad_sch' }, windows)).toBe(2)
    expect(pickDesignWindow({ sheet: 'C:\\p\\sub\\power.kicad_sch' }, windows)).toBeNull()
  })

  it('does not match a name that is only a suffix of another', () => {
    const windows = [win(1, true, []), win(2, false, ['/p/mypower.kicad_sch'])]
    expect(pickDesignWindow({ sheet: 'power.kicad_sch' }, windows)).toBeNull()
  })

  it('does not guess between two holders', () => {
    const windows = [
      win(1, true, []),
      win(2, false, ['/p/main.kicad_sch']),
      win(3, false, ['/p/main.kicad_sch'])
    ]
    expect(pickDesignWindow({ sheet: 'main.kicad_sch' }, windows)).toBeNull()
  })

  it('sends an unnamed request from a design-less window to the design beside it', () => {
    const windows = [win(1, true, []), win(2, false, ['/p/main.kicad_pcb'])]
    expect(pickDesignWindow({ kind: 'describe-board' }, windows)).toBe(2)
  })

  it('leaves an unnamed request alone across workspaces', () => {
    const windows = [win(1, true, []), win(2, false, ['/q/main.kicad_pcb'], '/q')]
    expect(pickDesignWindow({ kind: 'describe-board' }, windows)).toBeNull()
  })
})
