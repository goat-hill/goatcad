import { describe, expect, test } from 'vitest'
import { applyTerminalRestore, isSessionTab } from '../terminalRestore'
import { terminalTab, terminalTabPath } from '../tabs'

const PCB = '/p/main.kicad_pcb'
const SCH = '/p/main.kicad_sch'
const OLD = terminalTabPath('claude', 'term-old-3')

describe('isSessionTab', () => {
  test('an agent tab is recorded with the window; a plain shell is not', () => {
    expect(isSessionTab(PCB)).toBe(true)
    expect(isSessionTab(OLD)).toBe(true)
    expect(isSessionTab(terminalTabPath('codex', 'term-old-4'))).toBe(true)
    expect(isSessionTab(terminalTabPath('shell', 'term-old-5'))).toBe(false)
  })
})

describe('applyTerminalRestore', () => {
  const init = {
    projectPath: '/p',
    tabs: [
      { name: 'main.kicad_pcb', path: PCB, cameras: { '': { x: 1, y: 2, zoom: 3 } } },
      { name: 'Claude', path: OLD },
      { name: 'main.kicad_sch', path: SCH }
    ],
    activeTabPath: OLD,
    editorLayout: {
      groups: [
        { tabs: [PCB], activeTabPath: PCB },
        { tabs: [OLD, SCH], activeTabPath: OLD }
      ],
      focusedGroup: 1,
      direction: 'row' as const,
      ratio: 0.5
    }
  }

  test('the new session takes the old tab’s place, pane and front', () => {
    const fresh = terminalTab('claude', 'term-new-1', 'Claude')
    const restored = applyTerminalRestore(init, new Map([[OLD, fresh]]))
    expect(restored.tabs.map((tab) => tab.path)).toEqual([PCB, fresh.path, SCH])
    expect(restored.tabs[0]).toBe(init.tabs[0])
    expect(restored.activeTabPath).toBe(fresh.path)
    expect(restored.editorLayout?.groups[1]).toEqual({
      tabs: [fresh.path, SCH],
      activeTabPath: fresh.path
    })
    expect(restored.projectPath).toBe('/p')
  })

  test('a tab that could not be started is left out everywhere', () => {
    const restored = applyTerminalRestore(init, new Map([[OLD, null]]))
    expect(restored.tabs.map((tab) => tab.path)).toEqual([PCB, SCH])
    expect(restored.activeTabPath).toBe(PCB)
    expect(restored.editorLayout?.groups[1]).toEqual({ tabs: [SCH], activeTabPath: null })
  })

  test('nothing to restore is the same init', () => {
    expect(applyTerminalRestore(init, new Map())).toBe(init)
  })
})
