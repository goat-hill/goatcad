import { isImageFile } from './imageFiles'
import { isGerberFile } from './gerber/files'
import { isPdfFile, isHtmlFile } from './documentFiles'

/**
 * Which files GoatCAD is willing to open, and how. Anything not recognized
 * here gets the read-only file-info tab (FileInfoViewer) instead of the text
 * editor — opening arbitrary binaries (zip, sqlite, …) as text helps no one.
 *
 * Classification is by name only (extension allowlist plus a few well-known
 * extension-less basenames): the file explorer needs the answer synchronously
 * for every row, without reading file contents.
 */

/** Extensions that open in the plain text editor. */
const TEXT_EXTENSIONS = new Set([
  // Prose / data
  'txt',
  'md',
  'markdown',
  'json',
  'yaml',
  'yml',
  'xml',
  // html/htm route to the rendered-HTML viewer (documentFiles.ts); its source
  // toggle reuses the text editor, so they are deliberately not listed here.
  'css',
  'csv',
  'tsv',
  'log',
  // Config
  'ini',
  'cfg',
  'conf',
  'toml',
  'env',
  'gitignore',
  'gitattributes',
  'editorconfig',
  // Code commonly living next to hardware projects
  'js',
  'mjs',
  'cjs',
  'ts',
  'py',
  'sh',
  'bat',
  'ps1',
  'c',
  'h',
  'cpp',
  'hpp',
  'ino',
  'rs',
  'lua',
  'sql',
  // ECAD text formats (KiCad support files, netlists, spice, fab outputs)
  'kicad_pro',
  'kicad_dru',
  'kicad_wks',
  'kicad_prl',
  'net',
  'cir',
  'sp',
  'dcm',
  'gbrjob',
  'drl',
  'pos',
  'rpt'
])

/** Extension-less files that are conventionally text. */
const TEXT_BASENAMES = new Set([
  'readme',
  'license',
  'changelog',
  'makefile',
  'dockerfile',
  // KiCad library tables (s-expression text)
  'fp-lib-table',
  'sym-lib-table'
])

/** Extensions with a dedicated (non-text) editor or viewer. */
const EDITOR_EXTENSIONS = new Set([
  'kicad_sch',
  'kicad_pcb',
  'kicad_sym',
  'kicad_mod',
  'step',
  'stp',
  'wrl'
])

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** True when the file should open in the plain text editor. */
export const isTextFile = (name: string): boolean => {
  const ext = extensionOf(name)
  if (ext !== '') return TEXT_EXTENSIONS.has(ext)
  return TEXT_BASENAMES.has(name.toLowerCase())
}

/**
 * True when GoatCAD opens this file with real content — any editor, viewer,
 * or the text editor. False means the file-info tab (and a dimmed explorer
 * row).
 */
export const isOpenableFile = (name: string): boolean =>
  EDITOR_EXTENSIONS.has(extensionOf(name)) ||
  isImageFile(name) ||
  isGerberFile(name) ||
  isPdfFile(name) ||
  isHtmlFile(name) ||
  isTextFile(name)
