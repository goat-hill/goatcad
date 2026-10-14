/**
 * What "create a file" means for each design file type — the single place that
 * turns a chosen name into bytes on disk (docs/projects.md
 * §3/§4.1). Both the new-project scaffold and the explorer's `New ▸` commands
 * go through here, so a project's files and an added file are built the same
 * way.
 *
 * Lives in the renderer because the templates serialize through the S-expression
 * writer, which is renderer-side by design (main deliberately carries no
 * S-expr machinery — see `libraryIndexExtract.ts`).
 */
import {
  boardTemplate,
  footprintTemplate,
  projectTemplate,
  schematicTemplate,
  symbolLibraryTemplate
} from './templates'

export type NewFileKind = 'schematic' | 'board' | 'symbol-library' | 'footprint'

/** Extension each kind is created with; also what the New command suggests. */
export const EXTENSION_FOR_KIND: Record<NewFileKind, string> = {
  schematic: '.kicad_sch',
  board: '.kicad_pcb',
  'symbol-library': '.kicad_sym',
  footprint: '.kicad_mod'
}

export interface ScaffoldedFile {
  name: string
  content: string
}

/** Strip a known design extension to get the stem a template should carry. */
export const stemOf = (fileName: string): string => fileName.replace(/\.[^.]+$/, '')

/**
 * Blank content for a new file of `kind`, named `fileName`. The footprint
 * template embeds its own name, so the file name is not merely decoration.
 */
export function blankFileContent(kind: NewFileKind, fileName: string): string {
  switch (kind) {
    case 'schematic':
      return schematicTemplate(crypto.randomUUID())
    case 'board':
      return boardTemplate()
    case 'symbol-library':
      return symbolLibraryTemplate()
    case 'footprint':
      return footprintTemplate(stemOf(fileName))
  }
}

/**
 * Infer the kind from a typed file name — the explorer's free-text create path
 * still exists, and a `.kicad_pcb` typed by hand should get its template rather
 * than land as an empty file. Null means "not a design file", for which an
 * empty file is the right answer.
 */
export function kindForFileName(fileName: string): NewFileKind | null {
  const lower = fileName.toLowerCase()
  for (const [kind, extension] of Object.entries(EXTENSION_FOR_KIND)) {
    if (lower.endsWith(extension)) return kind as NewFileKind
  }
  return null
}

/** Default stem a `New ▸` command proposes, before the user renames it. */
export const DEFAULT_STEM_FOR_KIND: Record<NewFileKind, string> = {
  schematic: 'schematic',
  board: 'board',
  'symbol-library': 'symbols',
  footprint: 'footprint'
}

/**
 * A name not already taken in `siblings`, suffixed `-1`, `-2`, … Auto-suffixing
 * is deliberately limited to programmatic creates like this one; a name the
 * user typed is rejected on collision instead (workstream §4.3).
 */
export function uniqueFileName(stem: string, extension: string, siblings: string[]): string {
  const taken = new Set(siblings.map((name) => name.toLowerCase()))
  if (!taken.has(`${stem}${extension}`.toLowerCase())) return `${stem}${extension}`
  for (let index = 1; ; index++) {
    const candidate = `${stem}-${index}${extension}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * The file set for a fresh project, named after its folder so the hierarchy
 * resolver recognizes the schematic as the root (`hierarchy.ts` matches by
 * basename). One uuid is generated and shared: KiCad's `.kicad_pro` keys its
 * root sheet by the schematic's uuid, so the two files have to agree.
 */
export function newProjectFiles(projectName: string): ScaffoldedFile[] {
  const rootUuid = crypto.randomUUID()
  return [
    { name: `${projectName}.kicad_pro`, content: projectTemplate(projectName, rootUuid) },
    { name: `${projectName}.kicad_sch`, content: schematicTemplate(rootUuid) },
    { name: `${projectName}.kicad_pcb`, content: boardTemplate() }
  ]
}
