import { basename, dirname, extname, isAbsolute, resolve } from 'path'
import type { TabState } from './appConfig'

/**
 * Turns "the OS asked us to open these files" into "open these windows".
 *
 * Files reach the app three ways: `process.argv` on a cold launch (Windows and
 * Linux), the `second-instance` event when the app is already running, and the
 * macOS `open-file` event. All three funnel through here. The functions are pure
 * — the filesystem and packaging state are injected — so they can be tested.
 */

/** File types GoatCAD registers as a handler for. Keep in sync with electron-builder.yml. */
export const KICAD_EXTENSIONS = [
  '.kicad_pro',
  '.kicad_sch',
  '.kicad_pcb',
  '.kicad_mod',
  '.kicad_sym',
  // Gerber fabrication output (viewer); unambiguously ECAD, per the
  // file-association policy in docs/RULES.md
  '.gbr'
] as const

export const isKicadFile = (filePath: string): boolean =>
  (KICAD_EXTENSIONS as readonly string[]).includes(extname(filePath).toLowerCase())

export interface ParseArgvOptions {
  /** `app.isPackaged`. Unpackaged runs carry an extra leading app-path argument. */
  isPackaged: boolean
  cwd: string
  exists: (path: string) => boolean
}

/**
 * Extract openable KiCad file paths from a process argv.
 *
 * Packaged:   [exe, file, ...]
 * Unpackaged: [electron, appPath, file, ...]  (e.g. `electron . foo.kicad_sch`)
 *
 * Chromium/Electron switches and the `.` app path are skipped, relative paths are
 * resolved against `cwd`, and anything that isn't an existing KiCad file is dropped
 * — argv is untrusted and carries plenty of noise in dev.
 */
export const parseFileArgs = (argv: readonly string[], options: ParseArgvOptions): string[] => {
  const start = options.isPackaged ? 1 : 2
  const files: string[] = []
  for (const arg of argv.slice(start)) {
    if (!arg || arg.startsWith('-') || arg === '.') continue
    const filePath = isAbsolute(arg) ? arg : resolve(options.cwd, arg)
    if (!isKicadFile(filePath) || !options.exists(filePath)) continue
    if (!files.includes(filePath)) files.push(filePath)
  }
  return files
}

/** A window to open for a set of files that share a project directory. */
export interface OpenTarget {
  projectPath: string
  tabs: TabState[]
}

/**
 * Group files into one window per containing directory.
 *
 * The containing directory becomes the window's project folder: the Schematics
 * hierarchy and the multi-sheet Components table resolve the project root from
 * the filesystem, so opening a bare `.kicad_sch` without a folder would leave
 * them with nothing to walk.
 *
 * `.kicad_pro` is the project file itself, so it opens its folder without a tab
 * — the same result as File > Open Folder.
 */
export const groupOpenTargets = (files: readonly string[]): OpenTarget[] => {
  const targets = new Map<string, OpenTarget>()
  for (const filePath of files) {
    const projectPath = dirname(filePath)
    let target = targets.get(projectPath)
    if (!target) {
      target = { projectPath, tabs: [] }
      targets.set(projectPath, target)
    }
    if (extname(filePath).toLowerCase() === '.kicad_pro') continue
    if (!target.tabs.some((tab) => tab.path === filePath)) {
      target.tabs.push({ name: basename(filePath), path: filePath })
    }
  }
  return [...targets.values()]
}
