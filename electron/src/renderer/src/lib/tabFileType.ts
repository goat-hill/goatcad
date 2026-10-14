// Which editor or viewer a tab opens in. Read by the editor group that routes
// the tab and by the shell, which needs to know whether a tab has context panels
// without mounting anything.

import {
  isBoardSetupTab,
  isComponentTab,
  isComponentsTableTab,
  isDiffTab,
  isManufactureTab,
  isPartsTab,
  isSchematicSetupTab,
  isSettingsTab,
  isTerminalTab,
  isWelcomeTab,
  parseDiffTab,
  type Tab
} from './tabs'
import { diffView, visualDiffKind } from './git/diffPreferences'
import { isImageFile } from './imageFiles'
import { isGerberFile } from './gerber/files'
import { isPdfFile, isHtmlFile } from './documentFiles'
import { isTextFile } from './fileTypes'

export type TabFileType =
  | 'none'
  | 'welcome'
  | 'settings'
  | 'parts'
  | 'manufacture'
  | 'components'
  | 'schematic-setup'
  | 'board-setup'
  | 'terminal'
  | 'diff'
  | 'component'
  | 'schematic'
  | 'pcb'
  | 'library-symbol'
  | 'library-footprint'
  | 'model3d'
  | 'image'
  | 'gerber'
  | 'pdf'
  | 'html'
  | 'text'
  | 'unsupported'

export const tabFileType = (tab: Pick<Tab, 'name' | 'path'> | null): TabFileType => {
  if (!tab) return 'none'
  // Virtual tabs have no file behind them and must never reach a file read.
  if (isWelcomeTab(tab.path)) return 'welcome'
  if (isSettingsTab(tab.path)) return 'settings'
  if (isPartsTab(tab.path)) return 'parts'
  if (isManufactureTab(tab.path)) return 'manufacture'
  if (isComponentsTableTab(tab.path)) return 'components'
  if (isSchematicSetupTab(tab.path)) return 'schematic-setup'
  if (isBoardSetupTab(tab.path)) return 'board-setup'
  if (isTerminalTab(tab.path)) return 'terminal'
  if (isDiffTab(tab.path)) return 'diff'
  if (isComponentTab(tab.path)) return 'component'
  const name = tab.name.toLowerCase()
  const path = tab.path.toLowerCase()
  if (name.endsWith('.kicad_sch')) return 'schematic'
  if (name.endsWith('.kicad_pcb')) return 'pcb'
  if (name.endsWith('.kicad_sym')) return 'library-symbol'
  if (name.endsWith('.kicad_mod') || path.startsWith('readonly-lib://')) {
    return 'library-footprint'
  }
  if (name.endsWith('.step') || name.endsWith('.stp') || name.endsWith('.wrl')) return 'model3d'
  if (isImageFile(name)) return 'image'
  if (isGerberFile(name)) return 'gerber'
  if (isPdfFile(name)) return 'pdf'
  if (isHtmlFile(name)) return 'html'
  // Only clearly-text files reach the text editor; unknown and binary types get
  // the read-only file-info tab instead.
  if (isTextFile(name)) return 'text'
  return 'unsupported'
}

/** The editors that draw a properties rail of their own. */
const CONTEXT_PANEL_TYPES: ReadonlySet<TabFileType> = new Set([
  'schematic',
  'pcb',
  'library-symbol',
  'library-footprint',
  'gerber'
])

export const hasContextPanels = (tab: Pick<Tab, 'name' | 'path'> | null): boolean => {
  const type = tabFileType(tab)
  if (type === 'diff' && tab) return boardDiffHasPanels(tab.path)
  return CONTEXT_PANEL_TYPES.has(type)
}

/** A board's visual diff draws the board's Layers panel (`BoardDiffViewport.vue`); its text diff, nothing. */
const boardDiffHasPanels = (path: string): boolean => {
  const target = parseDiffTab(path)
  return (
    !!target &&
    diffView.value === 'visual' &&
    visualDiffKind(target.filePath, target.symbol) === 'board'
  )
}
