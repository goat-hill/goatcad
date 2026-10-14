/**
 * Putting a generated symbol into the project's own library.
 *
 * The orchestration behind `create_symbol`: plan the geometry
 * (`kicad/symbolLayout.ts`), write it into a `.kicad_sym`
 * (`kicad/symbolGenerate.ts`), create and register that library if the project
 * has none, and hand back the `lib_id` so the caller can place it.
 *
 * Sits beside
 * `libraryRegistration.ts` and uses `window.api` the same way, so the pure
 * halves stay pure and this holds the IO.
 */
import {
  generateBlankSymbol,
  generateSymbol,
  parseOrCreateLibrary,
  type SymbolFields
} from './symbol/symbolGenerate'
import { serializeKicadSymbolLibrary, type KicadSymbolLibrary } from './kicad/symbolLibrary'
import {
  planSymbol,
  type SymbolGroupSpec,
  type SymbolLayout,
  type SymbolPinSpec
} from './symbol/symbolLayout'
import { removeSymbol, type SymbolPowerKind } from './symbol/symbolEdit'
import { registerProjectLibrary } from './libraryRegistration'
import {
  nearNames,
  resolveProjectLibrary,
  type ProjectLibraryContext
} from './projectLibraryTarget'
import { tk, type MessageKey } from './messageKey'
import type { SExprList } from './kicad/sexpr'

/** Where a symbol write goes: through an open tab's session when one holds the
 *  library, else to the file. */
export interface SymbolWriteContext extends ProjectLibraryContext {
  /** Run the edit on the open library's document; false when no tab holds it. */
  editOpenLibrary(
    path: string,
    label: MessageKey,
    mutate: (library: KicadSymbolLibrary) => void
  ): boolean
}

export interface CreateSymbolInput {
  name: string
  /** Library file stem. Defaults to the project's own name. */
  library?: string
  /** With neither groups nor pins, the symbol is blank: fields only. */
  groups?: SymbolGroupSpec[]
  pins?: SymbolPinSpec[]
  /** A blank symbol's power port kind. */
  power?: SymbolPowerKind
  fields: SymbolFields
  /** Replace a symbol of the same name rather than refusing. */
  overwrite?: boolean
}

export interface CreateSymbolSuccess {
  libId: string
  libraryPath: string
  nickname: string
  created: boolean
  replaced: boolean
  /** The generated drawing; absent for a blank symbol. */
  layout?: SymbolLayout
  /** A tab held the library, so the write is a step on its session. */
  inTab: boolean
}

export type CreateSymbolResult =
  | ({ ok: true } & CreateSymbolSuccess)
  | { ok: false; error: string; detail?: string; remedy?: string }

/**
 * Create (or update) a symbol in the project's own library.
 *
 * A library a tab holds is edited through that tab's session (`editOpenLibrary`),
 * so the write lands in the buffer as one undoable step rather than on the file
 * underneath an unsaved edit. Only a library no tab holds is written to disk,
 * where the write is not undoable — the same split New Child Schematic makes.
 */
export async function createProjectSymbol(
  input: CreateSymbolInput,
  context: SymbolWriteContext
): Promise<CreateSymbolResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'blank-name' }
  const target = resolveProjectLibrary(context, 'symbol', input.library)
  if (!target.ok) return target

  const blank = !input.pins?.length && !input.groups?.length
  const plan = blank
    ? null
    : planSymbol(input.groups ?? [], input.pins ?? [], { reference: input.fields.reference })
  // The remedy for each refusal is the op's (`DESIGN_REMEDY`, main/ops/design.ts).
  if (plan && !plan.ok) return { ok: false, error: plan.error, detail: plan.detail }
  const write = (into: KicadSymbolLibrary): void => {
    if (plan) generateSymbol(into, name, plan.layout, input.fields)
    else generateBlankSymbol(into, name, input.fields, input.power)
  }

  const { path: libraryPath, stem: libraryStem } = target

  const read = await window.api.readSymbolLibrary(libraryPath).catch(() => null)
  const existed = read?.success === true && typeof read.content === 'string'
  let library
  try {
    library = parseOrCreateLibrary(existed ? (read!.content as string) : null)
  } catch (err) {
    return {
      ok: false,
      error: 'library-unparseable',
      detail: err instanceof Error ? err.message : String(err),
      remedy: 'The project library could not be parsed, so nothing was written.'
    }
  }

  if (library.symbols.has(name) && input.overwrite !== true) {
    return {
      ok: false,
      error: 'symbol-exists',
      detail: name,
      remedy:
        'A symbol of that name is already in this library. Pass overwrite only if you mean to replace it — doing so discards any hand edits made to it since.'
    }
  }

  // A tab holds it: the edit is a command on that document, undoable and
  // visible as an unsaved tab. Otherwise the file is written.
  const inTab = context.editOpenLibrary(libraryPath, tk('commandLabels.generateSymbol'), write)
  const replaced = library.symbols.has(name)
  if (!inTab) {
    write(library)
    const written = await window.api.createFile(libraryPath, serializeKicadSymbolLibrary(library))
    if (!written.success) {
      return { ok: false, error: 'write-failed', detail: written.error }
    }
  }

  // Register only a library the project did not already have; re-registering
  // would add a second row under a uniquified nickname and shadow the first.
  let nickname = libraryStem
  if (!existed) {
    try {
      nickname = await registerProjectLibrary('symbol', target.projectFile, libraryPath)
    } catch (err) {
      return {
        ok: false,
        error: 'register-failed',
        detail: err instanceof Error ? err.message : String(err),
        remedy:
          "The library file was written but could not be added to the project's sym-lib-table, so the symbol is not placeable yet."
      }
    }
  }

  return {
    ok: true,
    libId: `${nickname}:${name}`,
    libraryPath,
    nickname,
    created: !existed,
    replaced,
    ...(plan ? { layout: plan.layout } : {}),
    inTab
  }
}

export type DeleteSymbolResult =
  | { ok: true; libId: string; libraryPath: string; remaining: number; inTab: boolean }
  | { ok: false; error: string; detail?: string; remedy?: string; candidates?: string[] }

export type CopySymbolResult =
  | {
      ok: true
      libId: string
      libraryPath: string
      createdLibrary: boolean
      /** A tab held the library, so the copy is a step on its session. */
      inTab: boolean
    }
  | { ok: false; error: string; detail?: string; remedy?: string }

/**
 * Put a copy of a library symbol into the project's own library: `node` is the
 * definition already flattened and named (`symbol/symbolCopy.ts`). Refused
 * when the name is taken. Written as `createProjectSymbol` writes.
 */
export async function copyProjectSymbol(
  input: { node: SExprList; name: string; library?: string },
  context: SymbolWriteContext
): Promise<CopySymbolResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'blank-name' }
  if (/[/\\:]/.test(name)) return { ok: false, error: 'bad-name', detail: name }
  const target = resolveProjectLibrary(context, 'symbol', input.library)
  if (!target.ok) return target
  const { path: libraryPath, stem: libraryStem } = target

  const read = await window.api.readSymbolLibrary(libraryPath).catch(() => null)
  const existed = read?.success === true && typeof read.content === 'string'
  let library
  try {
    library = parseOrCreateLibrary(existed ? (read!.content as string) : null)
  } catch (err) {
    return {
      ok: false,
      error: 'library-unparseable',
      detail: err instanceof Error ? err.message : String(err)
    }
  }
  if (library.symbols.has(name)) {
    return { ok: false, error: 'symbol-exists', detail: `${libraryStem}:${name}` }
  }

  const inTab = context.editOpenLibrary(libraryPath, tk('commandLabels.copySymbol'), (open) => {
    if (!open.symbols.has(name)) open.root.children.push(input.node)
  })
  if (!inTab) {
    library.root.children.push(input.node)
    const written = await window.api.createFile(libraryPath, serializeKicadSymbolLibrary(library))
    if (!written.success) return { ok: false, error: 'write-failed', detail: written.error }
  }

  let nickname = libraryStem
  if (!existed) {
    try {
      nickname = await registerProjectLibrary('symbol', target.projectFile, libraryPath)
    } catch (err) {
      return {
        ok: false,
        error: 'register-failed',
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }
  return {
    ok: true,
    libId: `${nickname}:${name}`,
    libraryPath,
    createdLibrary: !existed,
    inTab
  }
}

/**
 * Remove a symbol from the project's own library.
 *
 * **Only the project tier.** The standard and global libraries are read-only
 * (`libraries-workstream.md` §1), and there is no path here that could reach
 * them — the library is resolved the same way `createProjectSymbol` resolves it.
 *
 * Deliberately does NOT check whether the symbol is placed on a sheet. A
 * placement keeps its own copy of the definition in the schematic's
 * `lib_symbols`, so deleting the library entry does not blank an existing
 * placement; it only stops the symbol being placed again. Refusing on a
 * placement would therefore block the ordinary case — deleting a generated
 * symbol you have already decided against — for a hazard that is not real.
 */
export async function deleteProjectSymbol(
  input: { name: string; library?: string },
  context: SymbolWriteContext
): Promise<DeleteSymbolResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'blank-name' }
  const target = resolveProjectLibrary(context, 'symbol', input.library)
  if (!target.ok) return target
  const { path: libraryPath, stem: libraryStem } = target

  const read = await window.api.readSymbolLibrary(libraryPath).catch(() => null)
  if (!read?.success || typeof read.content !== 'string') {
    return { ok: false, error: 'library-not-found', detail: libraryPath }
  }

  let library
  try {
    library = parseOrCreateLibrary(read.content)
  } catch (err) {
    return {
      ok: false,
      error: 'library-unparseable',
      detail: err instanceof Error ? err.message : String(err)
    }
  }

  const symbol = library.symbols.get(name)
  if (!symbol) {
    return {
      ok: false,
      error: 'symbol-not-found',
      detail: `${libraryStem}:${name}`,
      candidates: nearNames(name, library.names).map((entry) => `${libraryStem}:${entry}`)
    }
  }

  // As above: a tab holds it, the removal is that document's command.
  const inTab = context.editOpenLibrary(libraryPath, tk('commandLabels.deleteSymbol'), (open) => {
    const node = open.symbols.get(name)
    if (node) removeSymbol(open.root, node._node)
  })
  if (!inTab) {
    removeSymbol(library.root, symbol._node)
    const written = await window.api.createFile(libraryPath, serializeKicadSymbolLibrary(library))
    if (!written.success) return { ok: false, error: 'write-failed', detail: written.error }
  }

  return {
    ok: true,
    libId: `${libraryStem}:${name}`,
    libraryPath,
    remaining: library.names.length - 1,
    inTab
  }
}
