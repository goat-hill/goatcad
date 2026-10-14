import { describe, it, expect } from 'vitest'
import {
  isComponentTab,
  componentTabPath,
  parseComponentTab,
  isReadonlyLibTab,
  readonlyLibTabPath,
  readonlyLibPath,
  isSchematicSetupTab,
  schematicSetupRootPath,
  schematicSetupTab,
  boardSetupTab,
  boardSetupBoardPath,
  isBoardSetupTab,
  tabDocumentPath,
  diffTabPath,
  parseDiffTab,
  tabParent,
  nestChildTabs,
  componentsTabPath,
  manufactureTabPath,
  schematicSetupTabPath,
  boardSetupTabPath
} from '../tabs'
import { designCopyPath } from '../designCopy'
import { hasContextPanels, tabFileType } from '../tabFileType'
import { setDiffView } from '../git/diffPreferences'

describe('component tabs', () => {
  it('detects component tab paths', () => {
    expect(isComponentTab('component://symbol/Device/R')).toBe(true)
    expect(isComponentTab('goatcad://welcome')).toBe(false)
    expect(isComponentTab('/a/b.kicad_sym')).toBe(false)
    expect(isComponentTab(null)).toBe(false)
  })

  it('builds and round-trips a symbol ref', () => {
    const p = componentTabPath('symbol', 'Device', 'R')
    expect(p).toBe('component://symbol/Device/R')
    expect(parseComponentTab(p)).toEqual({ kind: 'symbol', segments: ['Device', 'R'] })
  })

  it('encodes segments with separators/spaces', () => {
    const p = componentTabPath('footprint', 'Package_SO', 'SOIC-8_3.9x4.9mm', 'SOIC-8.kicad_mod')
    const ref = parseComponentTab(p)
    expect(ref).toEqual({
      kind: 'footprint',
      segments: ['Package_SO', 'SOIC-8_3.9x4.9mm', 'SOIC-8.kicad_mod']
    })
  })

  it('round-trips a model path segment', () => {
    const path = '/usr/share/kicad/3dmodels/Device.3dshapes/R_0402.step'
    const ref = parseComponentTab(componentTabPath('model', path))
    expect(ref).toEqual({ kind: 'model', segments: [path] })
  })

  it('rejects non-component and unknown kinds', () => {
    expect(parseComponentTab('goatcad://welcome')).toBeNull()
    expect(parseComponentTab('component://bogus/x')).toBeNull()
  })
})

describe('read-only library tabs', () => {
  it('detects read-only library tab paths', () => {
    expect(isReadonlyLibTab('readonly-lib://%2Fx.kicad_mod')).toBe(true)
    expect(isReadonlyLibTab('/x/y.kicad_mod')).toBe(false)
    expect(isReadonlyLibTab('component://footprint/x')).toBe(false)
    expect(isReadonlyLibTab(null)).toBe(false)
  })

  it('round-trips an absolute path, keeping slashes intact', () => {
    const abs = '/usr/share/kicad/footprints/Capacitor_SMD.pretty/C_0402_1005Metric.kicad_mod'
    const tab = readonlyLibTabPath(abs)
    expect(tab.startsWith('readonly-lib://')).toBe(true)
    expect(tab).not.toContain('.pretty/') // path slashes are encoded, not literal
    expect(readonlyLibPath(tab)).toBe(abs)
  })

  it('round-trips paths with spaces and Windows separators', () => {
    const abs = 'C:\\Program Files\\KiCad\\lib\\Package SO.pretty\\SOIC-8.kicad_mod'
    expect(readonlyLibPath(readonlyLibTabPath(abs))).toBe(abs)
  })
})

describe('Schematic Setup tabs', () => {
  it('Schematic Setup is keyed and titled by the root sheet', () => {
    const tab = schematicSetupTab('/w/top.kicad_sch')
    expect(tab.name).toBe('top.kicad_sch')
    expect(isSchematicSetupTab(tab.path)).toBe(true)
    expect(schematicSetupRootPath(tab.path)).toBe('/w/top.kicad_sch')
    expect(tabFileType(tab)).toBe('schematic-setup')
  })
})

describe('Board Setup tabs', () => {
  it('Board Setup is keyed and titled by its board, and shows that board', () => {
    const tab = boardSetupTab('/w/my board.kicad_pcb')
    expect(tab.name).toBe('my board.kicad_pcb')
    expect(isBoardSetupTab(tab.path)).toBe(true)
    expect(boardSetupBoardPath(tab.path)).toBe('/w/my board.kicad_pcb')
    expect(tabFileType(tab)).toBe('board-setup')
    expect(tabDocumentPath(tab.path)).toBe('/w/my board.kicad_pcb')
    expect(tabDocumentPath('/w/my board.kicad_pcb')).toBe('/w/my board.kicad_pcb')
  })
})

describe('child tabs', () => {
  const board = '/w/b.kicad_pcb'
  const root = '/w/top.kicad_sch'

  it('name their parent, and whether they edit its document', () => {
    expect(tabParent(boardSetupTabPath(board))).toEqual({ path: board, view: true })
    expect(tabParent(componentsTabPath(root))).toEqual({ path: root, view: true })
    expect(tabParent(designCopyPath('footprint', board, 'u1'))).toEqual({ path: board, view: true })
    expect(tabParent(manufactureTabPath(board))).toEqual({ path: board, view: false })
    expect(tabParent(schematicSetupTabPath(root))).toEqual({ path: root, view: false })
    expect(tabParent(board)).toBeNull()
    expect(tabParent('goatcad://welcome')).toBeNull()
  })

  it('sit after their parent and its earlier children, the rest in place', () => {
    const tabs = [
      { path: manufactureTabPath(board) },
      { path: root },
      { path: board },
      { path: 'goatcad://welcome' },
      { path: boardSetupTabPath(board) },
      { path: componentsTabPath('/w/closed.kicad_sch') }
    ]
    expect(nestChildTabs(tabs).map((tab) => tab.path)).toEqual([
      root,
      board,
      manufactureTabPath(board),
      boardSetupTabPath(board),
      'goatcad://welcome',
      componentsTabPath('/w/closed.kicad_sch')
    ])
    const nested = nestChildTabs(tabs)
    expect(nestChildTabs(nested)).toEqual(nested)
  })
})

describe('diff tabs', () => {
  it('round-trip a file diff and a symbol diff, slashes and all', () => {
    const file = diffTabPath('working', '/p/lib/my parts.kicad_sym')
    expect(parseDiffTab(file)).toEqual({ side: 'working', filePath: '/p/lib/my parts.kicad_sym' })
    const symbol = diffTabPath('staged', 'C:\\p\\lib.kicad_sym', 'LM/358')
    expect(parseDiffTab(symbol)).toEqual({
      side: 'staged',
      filePath: 'C:\\p\\lib.kicad_sym',
      symbol: 'LM/358'
    })
    expect(parseDiffTab('goatcad://diff/other/x')).toBeNull()
  })
})

describe('hasContextPanels', () => {
  const diff = (file: string): { name: string; path: string } => ({
    name: file,
    path: diffTabPath('working', file)
  })

  it("gives a board's visual diff the rail, and no other diff", () => {
    setDiffView('visual')
    expect(hasContextPanels(diff('/p/board.kicad_pcb'))).toBe(true)
    expect(hasContextPanels(diff('/p/sheet.kicad_sch'))).toBe(false)
    setDiffView('text')
    expect(hasContextPanels(diff('/p/board.kicad_pcb'))).toBe(false)
    setDiffView('visual')
  })
})
