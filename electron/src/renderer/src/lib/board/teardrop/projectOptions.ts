/**
 * A board's teardrop options from its project, for the sessions that build
 * teardrops (`EditorArea`).
 */
import { mmToNm } from '../../kicad/coordinates'
import { DEFAULT_DESIGN_RULES, extractDesignSettings } from '../../kicad/project'
import { extractTeardropSettings, patchTeardropSettings, type TeardropSettings } from './params'

/** What a board's teardrops are built with, from its project: max error (nm) and settings. */
export async function readProjectTeardropOptions(
  projectPath: string
): Promise<{ maxError: number; settings: TeardropSettings } | null> {
  const read = await window.api.readFile(projectPath)
  if (!read.success || read.content === undefined) return null
  const rules = extractDesignSettings(read.content)?.rules
  return {
    maxError: mmToNm(rules?.maxError ?? DEFAULT_DESIGN_RULES.maxError),
    settings: extractTeardropSettings(read.content)
  }
}

/** Write the board's teardrop settings to its project, as Board Setup saves them. */
export async function writeProjectTeardropSettings(
  projectPath: string,
  settings: TeardropSettings
): Promise<boolean> {
  const current = await window.api.readFile(projectPath)
  if (!current.success || current.content === undefined) return false
  const patched = patchTeardropSettings(current.content, settings)
  if (patched === null) return false
  if (patched === current.content) return true
  const written = await window.api.createFile(projectPath, patched)
  return written.success
}
