/**
 * The symbol library tiers a sheet can place from, held once per sheet
 * directory and shared by every reader of it: the mounted editor's chooser,
 * the mismatch check, and a sheet an agent writes to with no editor mounted.
 *
 * Two tiers with different loading strategies:
 *  - the **table** tier — the user's global rows plus the project's
 *    `sym-lib-table` — is a handful of files, read and parsed eagerly;
 *  - the **standard** tier — hundreds of provisioned KiCad libraries, tens of
 *    megabytes — is listed from the library index and parsed one library at a
 *    time on first pick (`ensureStandardLibrary`), behind a bounded cache.
 *
 * Keyed by the sheet's directory because that is where the project table is
 * read from: a child sheet in a subfolder with no `.kicad_pro` of its own reads
 * its own directory's table, which is what KiCad does too.
 */
import { shallowRef, type ShallowRef } from 'vue'
import { findProjectFile } from '../kicad/project'
import { namespaceSymbolLibrary, type KicadSymbolLibrary } from '../kicad/symbolLibrary'
import { parseSymLibTable, type RegisteredSymbolLibrary } from '../kicad/symbolLibraryTable'
import { findLibrarySymbol, loadIndex } from '../libraryIndex'
import { getLibSymbolProperty, type KicadSchematic } from '../kicad/schematic'
import { flattenedLibSymbol, type LibrarySymbolLookup } from '../schematic/checks'
import { onProjectChange } from '../projectBus'
import { dirnameOf } from '../kicad/paths'

export type SymbolTier = 'project' | 'global' | 'standard'

/** A placeable symbol from a library: its id, what the chooser shows for it,
 *  and the parsed library whose `lib_symbols` carries it and its parents. */
export interface LibrarySymbol {
  libId: string
  description: string
  isPower: boolean
  tier: SymbolTier
  sheet: KicadSchematic
}

export interface SymbolSources {
  /** The table tier, parsed; empty until `ready()` resolves. */
  tableSymbols: ShallowRef<LibrarySymbol[]>
  /** Every standard library parsed so far, expanded. */
  standardSymbols: ShallowRef<LibrarySymbol[]>
  /** Table-tier libraries by nickname; these shadow a same-named standard library. */
  registeredLibraries: ShallowRef<Map<string, RegisteredSymbolLibrary>>
  /** Resolves when the table tier has been read (re-armed on a library change). */
  ready(): Promise<void>
  /** Re-read the table tier now. */
  reload(): Promise<void>
  /** Parse the standard library that owns `libId`, so it becomes placeable. */
  ensureStandardLibrary(libId: string): Promise<void>
  /**
   * The library's current definition of a lib id, for the mismatch check —
   * never a sheet's embedded copy, which is the thing being compared. A library
   * not parsed answers undefined and its symbols go uncompared.
   */
  lookup: LibrarySymbolLookup
}

/** What the sources read through; the app's `window.api`, or a test's fake. */
export interface SymbolSourceIo {
  globalLibraries(): Promise<Array<{ nickname: string; path: string; standard: boolean }>>
  projectTable(projectPath: string): Promise<{ content: string | null; dir: string | null }>
  readLibrary(path: string): Promise<string | null>
  /** The index record for a standard-tier symbol id: its library and file. */
  standardLibraryOf(libId: string): Promise<{ library: string; file: string } | undefined>
}

const STANDARD_LIB_CACHE_MAX = 8
/** Parsed standard libraries, shared across every sources instance. */
const standardLibCache = new Map<string, KicadSymbolLibrary>()

export const entriesFromLibrary = (
  parsed: KicadSymbolLibrary,
  tier: SymbolTier
): LibrarySymbol[] => {
  const entries: LibrarySymbol[] = []
  for (const name of parsed.names) {
    const definition = parsed.doc.libSymbols.get(name)
    if (!definition) continue
    entries.push({
      libId: name,
      description:
        getLibSymbolProperty(definition, 'Description') ??
        getLibSymbolProperty(definition, 'ki_description') ??
        '',
      isPower: definition.isPower || name.startsWith('power:'),
      tier,
      sheet: parsed.doc
    })
  }
  return entries
}

export const createSymbolSources = (filePath: string, io: SymbolSourceIo): SymbolSources => {
  const tableSymbols = shallowRef<LibrarySymbol[]>([])
  const standardSymbols = shallowRef<LibrarySymbol[]>([])
  const registeredLibraries = shallowRef(new Map<string, RegisteredSymbolLibrary>())
  // By file, not nickname: the index records a symbol a sheet embeds under its
  // own library's nickname with the sheet as its file, so a nickname would mark
  // `Connector` loaded when only one sheet's copy of `Connector:RJ11` had been,
  // and every other `Connector:` symbol would then never be found.
  const loadedStandardFiles = new Set<string>()

  // Best-effort and non-blocking: a missing or unparseable library is skipped
  // so it never denies the sheet the rest.
  const reload = async (): Promise<void> => {
    // project ∪ global, project shadowing global on a nickname clash.
    const registered = new Map<string, RegisteredSymbolLibrary>()
    try {
      for (const lib of await io.globalLibraries()) {
        if (lib.standard) continue // index-listed, parsed on pick
        registered.set(lib.nickname, { nickname: lib.nickname, path: lib.path, scope: 'global' })
      }
    } catch (err) {
      console.error('Failed to read global symbol library table', err)
    }
    const project = await findProjectFile(filePath)
    if (project) {
      try {
        const table = await io.projectTable(project)
        if (table.content) {
          for (const lib of parseSymLibTable(table.content, table.dir)) {
            registered.set(lib.nickname, lib)
          }
        }
      } catch (err) {
        console.error('Failed to read project sym-lib-table', err)
      }
    }
    registeredLibraries.value = registered

    const entries: LibrarySymbol[] = []
    for (const lib of registered.values()) {
      const content = await io.readLibrary(lib.path).catch(() => null)
      if (!content) continue
      try {
        entries.push(
          ...entriesFromLibrary(namespaceSymbolLibrary(content, lib.nickname), lib.scope)
        )
      } catch (err) {
        console.error(`Failed to parse symbol library ${lib.nickname}`, err)
      }
    }
    tableSymbols.value = entries
  }

  let ready = reload()

  const ensureStandardLibrary = async (libId: string): Promise<void> => {
    const record = await io.standardLibraryOf(libId)
    if (!record || loadedStandardFiles.has(record.file)) return
    let parsed = standardLibCache.get(record.file)
    if (!parsed) {
      const content = await io.readLibrary(record.file).catch(() => null)
      if (!content) return
      try {
        parsed = namespaceSymbolLibrary(content, record.library)
      } catch (err) {
        console.error(`Failed to parse symbol library ${record.library}`, err)
        return
      }
      standardLibCache.set(record.file, parsed)
      if (standardLibCache.size > STANDARD_LIB_CACHE_MAX) {
        const oldest = standardLibCache.keys().next().value
        if (oldest !== undefined) standardLibCache.delete(oldest)
      }
    }
    loadedStandardFiles.add(record.file)
    standardSymbols.value = [...standardSymbols.value, ...entriesFromLibrary(parsed, 'standard')]
  }

  const lookup: LibrarySymbolLookup = (libId) => {
    const entry = [...tableSymbols.value, ...standardSymbols.value].find(
      (candidate) => candidate.libId === libId
    )
    const definition = entry?.sheet.libSymbols.get(libId)
    if (!entry || !definition) return undefined
    return flattenedLibSymbol(definition, (name) => entry.sheet.libSymbols.get(name))
  }

  return {
    tableSymbols,
    standardSymbols,
    registeredLibraries,
    ready: () => ready,
    reload: () => {
      ready = reload()
      return ready
    },
    ensureStandardLibrary,
    lookup
  }
}

const appIo: SymbolSourceIo = {
  globalLibraries: async () =>
    (await window.api.getSymbolLibraries()).libraries.map((lib) => ({
      nickname: lib.nickname,
      path: lib.path,
      standard: lib.source === 'standard'
    })),
  projectTable: (projectPath) => window.api.readProjectSymbolLibTable(projectPath),
  readLibrary: async (path) => {
    const read = await window.api.readSymbolLibrary(path)
    return read.success && read.content ? read.content : null
  },
  standardLibraryOf: async (libId) => {
    // Loaded here rather than trusted to be: the schematic editor loads the
    // index when it mounts, but an agent can ask for a symbol with no sheet open.
    // A no-op once loaded, and a refetch after a library was added.
    await loadIndex().catch(() => {})
    const record = findLibrarySymbol(libId)
    return record ? { library: record.library, file: record.file } : undefined
  }
}

const byDirectory = new Map<string, SymbolSources>()
let watching = false

/**
 * The sources for the sheet at `filePath`, shared with every other sheet in
 * its directory. A library written under a project — the agent's
 * `symbol_create`, a save in the symbol editor — re-reads every
 * instance, so a symbol regenerated is what the next check compares against
 * and what the next place embeds.
 */
export const symbolSourcesFor = (filePath: string): SymbolSources => {
  const key = dirnameOf(filePath)
  let sources = byDirectory.get(key)
  if (!sources) {
    sources = createSymbolSources(filePath, appIo)
    byDirectory.set(key, sources)
  }
  if (!watching) {
    watching = true
    onProjectChange((changes) => {
      const touchesLibrary = changes.some(
        (change) =>
          (change.kind === 'file-created' ||
            change.kind === 'file-changed' ||
            change.kind === 'file-deleted' ||
            change.kind === 'file-renamed') &&
          change.fileType === 'symbol-library'
      )
      if (touchesLibrary) for (const entry of byDirectory.values()) void entry.reload()
    })
  }
  return sources
}
