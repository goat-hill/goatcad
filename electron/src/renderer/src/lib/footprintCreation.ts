/**
 * Putting a generated footprint into the project's own footprint library.
 *
 * The orchestration behind `create_footprint`, and the mirror of
 * `symbolCreation.ts`: draw it (`footprint/footprintGenerate.ts`), write the
 * `.kicad_mod` into the project's `.pretty`, register that library in the
 * project's `fp-lib-table` when no row names it, and hand back the lib id.
 *
 * A footprint is one file, so the write is the file: not undoable, like
 * New Child Schematic's. A tab that holds
 * the file with unsaved edits is therefore refused rather than written under;
 * a clean one is handed the new text as saved.
 */
import {
  FOOTPRINT_REFUSAL_REMEDY,
  generateFootprint,
  type FootprintSpec,
  type GenerateReport
} from './footprint/footprintGenerate'
import type { FootprintStyleChoices } from './footprint/footprintStyle'
import { footprintChecks } from './footprint/footprintChecks'
import {
  parseKicadFootprint,
  serializeKicadFootprint,
  updateFootprintMetaInAST,
  updatePropertyInAST
} from './kicad/footprint'
import type { CheckResult } from './schematic/checks'
import { TABLE_FILENAME, tableNicknameFor } from './kicad/libraryTableWrite'
import { registerProjectLibrary } from './libraryRegistration'
import {
  nearNames,
  resolveProjectLibrary,
  type ProjectLibraryContext
} from './projectLibraryTarget'

export interface FootprintWriteContext extends ProjectLibraryContext {
  /** Whether a tab holds this file with edits not yet saved. */
  hasUnsavedEdits(path: string): boolean
  /** A tab holds this file: give it the text just written, as saved. */
  reloadOpenFile(path: string, text: string): void
}

export interface CreateFootprintInput {
  spec: FootprintSpec
  style: FootprintStyleChoices
  /** `.pretty` stem. Defaults to the project's own name. */
  library?: string
  overwrite?: boolean
}

export interface CreateFootprintSuccess {
  libId: string
  /** The `.pretty` folder. */
  libraryPath: string
  file: string
  createdLibrary: boolean
  replaced: boolean
  report: GenerateReport
  checks: CheckResult[]
}

type Failure = {
  ok: false
  error: string
  detail?: string
  remedy?: string
  candidates?: string[]
}

export type CreateFootprintResult = ({ ok: true } & CreateFootprintSuccess) | Failure

export interface CopyFootprintSuccess {
  libId: string
  libraryPath: string
  file: string
  createdLibrary: boolean
  replaced: boolean
  /** The file was written exactly as it was read. False only for a rename,
   *  which rewrites the name atom through the AST. */
  verbatim: boolean
}

export type CopyFootprintResult = ({ ok: true } & CopyFootprintSuccess) | Failure

export type DeleteFootprintResult =
  { ok: true; libId: string; libraryPath: string; file: string; remaining: string[] } | Failure

const FOOTPRINT_EXTENSION = '.kicad_mod'

const stemOf = (path: string): string =>
  (path.split(/[/\\]/).pop() ?? '').replace(/\.kicad_mod$/i, '')

/** The footprints a `.pretty` folder holds, by name. Empty when it is missing. */
const listFootprints = async (dir: string): Promise<string[]> => {
  const entries = await window.api.readDirectory(dir).catch(() => [])
  // Subfolders nest under `children`, so the top level is the folder's own files.
  return (entries as Array<{ name?: unknown; isDirectory?: unknown }>)
    .filter(
      (entry): entry is { name: string } =>
        entry.isDirectory !== true &&
        typeof entry.name === 'string' &&
        entry.name.toLowerCase().endsWith(FOOTPRINT_EXTENSION)
    )
    .map((entry) => stemOf(entry.name))
    .sort()
}

/** The nickname the project's table gives this folder, registering it if none does. */
const nicknameFor = async (
  projectFile: string,
  projectDir: string,
  libraryPath: string
): Promise<{ ok: true; nickname: string } | Failure> => {
  const table = await window.api
    .readProjectLibTable(projectFile, TABLE_FILENAME.footprint)
    .catch(() => ({ content: null, dir: null }))
  const existing = tableNicknameFor(table.content, libraryPath, table.dir ?? projectDir)
  if (existing) return { ok: true, nickname: existing }
  try {
    return {
      ok: true,
      nickname: await registerProjectLibrary('footprint', projectFile, libraryPath)
    }
  } catch (err) {
    return {
      ok: false,
      error: 'register-failed',
      detail: err instanceof Error ? err.message : String(err),
      remedy:
        "The footprint was written, but its library could not be added to the project's fp-lib-table, so it cannot be assigned yet."
    }
  }
}

/**
 * A footprint's text with its name set to `name`, or null when it already has
 * that name and nothing needs rewriting.
 *
 * KiCad reads a footprint's name from its **file**, so a `.kicad_mod` renamed
 * on disk — by a copy taken under another name, or by a rename in the Project
 * view — otherwise keeps the old name in its `(footprint …)` atom, and a file
 * whose two names disagree is one nobody can explain. The Value property
 * follows only when it still held the old name: a Value someone edited is
 * theirs, and it is what prints on the fab layer.
 */
export function footprintTextRenamed(text: string, name: string): string | null {
  const parsed = parseKicadFootprint(text)
  const was = parsed.name
  if (was === name) return null
  updateFootprintMetaInAST(parsed, { name })
  const value = parsed.properties.find((property) => property.key === 'Value')
  if (value && value.value === was) updatePropertyInAST(value, { value: name })
  return serializeKicadFootprint(parsed)
}

export async function createProjectFootprint(
  input: CreateFootprintInput,
  context: FootprintWriteContext
): Promise<CreateFootprintResult> {
  const target = resolveProjectLibrary(context, 'footprint', input.library)
  if (!target.ok) return target

  const generated = generateFootprint(input.spec, input.style)
  if (!generated.ok) {
    return {
      ok: false,
      error: generated.error,
      detail: generated.detail,
      remedy: FOOTPRINT_REFUSAL_REMEDY[generated.error]
    }
  }

  const name = input.spec.name.trim()
  const libraryPath = target.path
  const file = `${libraryPath}/${name}${FOOTPRINT_EXTENSION}`
  const existing = await listFootprints(libraryPath)
  const createdLibrary = !(await window.api.pathExists(libraryPath).catch(() => false))
  const replaced = existing.includes(name)
  if (replaced && input.overwrite !== true) {
    return {
      ok: false,
      error: 'footprint-exists',
      detail: `${target.stem}:${name}`,
      remedy: 'is already in this library.'
    }
  }
  if (context.hasUnsavedEdits(file)) {
    return { ok: false, error: 'footprint-unsaved', detail: file }
  }

  if (createdLibrary) {
    const made = await window.api.createDirectory(libraryPath)
    if (!made.success) return { ok: false, error: 'write-failed', detail: made.error }
  }
  const written = await window.api.createFile(file, generated.text)
  if (!written.success) return { ok: false, error: 'write-failed', detail: written.error }
  context.reloadOpenFile(file, generated.text)

  const named = await nicknameFor(target.projectFile, target.projectDir, libraryPath)
  if (!named.ok) return named

  return {
    ok: true,
    libId: `${named.nickname}:${name}`,
    libraryPath,
    file,
    createdLibrary,
    replaced,
    report: generated.report,
    // Generated footprints are drawn to KLC, so its style rules run too.
    checks: footprintChecks(parseKicadFootprint(generated.text), { klc: true })
  }
}

/**
 * Copy a footprint into the project's own library, unchanged.
 *
 * The route to giving a standard footprint a 3D model: the standard libraries are
 * read-only, and redrawing the part with `footprint_create` would
 * restyle silk, courtyard and texts to the house style — changing the land
 * pattern to attach a model. So the file is copied as it is, and the model
 * goes on the copy.
 *
 * Verbatim, with one exception: a copy taken under another name rewrites the
 * name atom through the AST, because KiCad reads a footprint's name from the
 * file and a copy whose two names disagree is a file nobody can explain.
 */
export async function copyProjectFootprint(
  input: { sourceText: string; name: string; library?: string; overwrite?: boolean },
  context: FootprintWriteContext
): Promise<CopyFootprintResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'blank-name' }
  if (/[/\\:*?"<>|]/.test(name)) return { ok: false, error: 'bad-name', detail: name }
  const target = resolveProjectLibrary(context, 'footprint', input.library)
  if (!target.ok) return target

  let text = input.sourceText
  let verbatim = true
  try {
    const renamed = footprintTextRenamed(input.sourceText, name)
    if (renamed !== null) {
      text = renamed
      verbatim = false
    }
  } catch (err) {
    return {
      ok: false,
      error: 'footprint-unreadable',
      detail: err instanceof Error ? err.message : String(err)
    }
  }

  const libraryPath = target.path
  const file = `${libraryPath}/${name}${FOOTPRINT_EXTENSION}`
  const existing = await listFootprints(libraryPath)
  const createdLibrary = !(await window.api.pathExists(libraryPath).catch(() => false))
  const replaced = existing.includes(name)
  if (replaced && input.overwrite !== true) {
    return {
      ok: false,
      error: 'footprint-exists',
      detail: `${target.stem}:${name}`,
      remedy: 'is already in this library; pass another name for the copy.'
    }
  }
  if (context.hasUnsavedEdits(file)) return { ok: false, error: 'footprint-unsaved', detail: file }

  if (createdLibrary) {
    const made = await window.api.createDirectory(libraryPath)
    if (!made.success) return { ok: false, error: 'write-failed', detail: made.error }
  }
  const written = await window.api.createFile(file, text)
  if (!written.success) return { ok: false, error: 'write-failed', detail: written.error }
  context.reloadOpenFile(file, text)

  const named = await nicknameFor(target.projectFile, target.projectDir, libraryPath)
  if (!named.ok) return named

  return {
    ok: true,
    libId: `${named.nickname}:${name}`,
    libraryPath,
    file,
    createdLibrary,
    replaced,
    verbatim
  }
}

/**
 * Remove a footprint from the project's own library, to the OS trash. The
 * `.pretty` folder and its table row stay. Project tier only, resolved as
 * `createProjectFootprint` resolves it; a placed footprint on a board carries
 * its own copy, so nothing on a board goes blank.
 */
export async function deleteProjectFootprint(
  input: { name: string; library?: string },
  context: FootprintWriteContext
): Promise<DeleteFootprintResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'blank-name' }
  const target = resolveProjectLibrary(context, 'footprint', input.library)
  if (!target.ok) return target
  const libraryPath = target.path
  const existing = await listFootprints(libraryPath)
  if (!existing.length && !(await window.api.pathExists(libraryPath).catch(() => false))) {
    return { ok: false, error: 'library-not-found', detail: libraryPath }
  }
  if (!existing.includes(name)) {
    return {
      ok: false,
      error: 'footprint-not-found',
      detail: `${target.stem}:${name}`,
      candidates: nearNames(name, existing).map((entry) => `${target.stem}:${entry}`)
    }
  }
  const file = `${libraryPath}/${name}${FOOTPRINT_EXTENSION}`
  if (context.hasUnsavedEdits(file)) return { ok: false, error: 'footprint-unsaved', detail: file }
  const removed = await window.api.deletePath(file)
  if (!removed.success) return { ok: false, error: 'write-failed', detail: removed.error }
  const table = await window.api
    .readProjectLibTable(target.projectFile, TABLE_FILENAME.footprint)
    .catch(() => ({ content: null, dir: null }))
  const nickname =
    tableNicknameFor(table.content, libraryPath, table.dir ?? target.projectDir) ?? target.stem
  return {
    ok: true,
    libId: `${nickname}:${name}`,
    libraryPath,
    file,
    remaining: existing.filter((entry) => entry !== name)
  }
}
