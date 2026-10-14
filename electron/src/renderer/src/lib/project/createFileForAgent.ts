/**
 * `project.create_file`: New ▸ for an agent. A sheet or a board is the blank
 * file the explorer's New writes (`scaffold.ts`), a symbol or footprint
 * library the one the Project view's New library writes and registers in the
 * project's table (`libraryRegistration.ts`). Both land in the active
 * project's folder, as the Project view's group `+` does.
 *
 * The name is taken as given: where the GUI suffixes a free name and lets the
 * person rename it, an agent names the file and a taken name is refused. Each
 * kind is checked as its GUI path checks it: a file name as the explorer's
 * rename (`validateFileName`), a library name as New library's prompt, which
 * also refuses a nickname the table already has.
 */
import { validateFileName } from '../fileMenu'
import { TABLE_FILENAME, tableNicknames, type LibraryTableKind } from '../kicad/libraryTableWrite'
import { blankFileContent, type NewFileKind } from './scaffold'

export type AgentFileKind = 'schematic' | 'board' | 'symbol_library' | 'footprint_library'

interface KindSpec {
  extension: string
  /** A library's table; a library is written by New library, everything else is scaffolded. */
  library?: LibraryTableKind
  scaffold?: NewFileKind
  /** What a footprint library's `.pretty` folder is not: a document a tab holds. */
  opensAsTab: boolean
  guidance: string
}

const KINDS: Record<AgentFileKind, KindSpec> = {
  schematic: {
    extension: '.kicad_sch',
    scaffold: 'schematic',
    opensAsTab: true,
    guidance:
      'The sheet is open in a tab behind the active one. No sheet symbol names it yet, so it is outside the hierarchy.'
  },
  board: {
    extension: '.kicad_pcb',
    scaffold: 'board',
    opensAsTab: true,
    guidance:
      'The board is open in a tab behind the active one, with no outline or layers set; set them with board_update_setup. With two boards in the project, board ops need board.'
  },
  symbol_library: {
    extension: '.kicad_sym',
    library: 'symbol',
    opensAsTab: true,
    guidance:
      'The library is registered in sym-lib-table and open behind the active tab. symbol_create with library set to its name adds symbols.'
  },
  footprint_library: {
    extension: '.pretty',
    library: 'footprint',
    opensAsTab: false,
    guidance:
      'The library is registered in fp-lib-table. footprint_create with library set to its name adds footprints.'
  }
}

export interface CreateFileFailure {
  error:
    'no-project' | 'no-active-project' | 'blank-name' | 'bad-name' | 'name-taken' | 'write-failed'
  detail: string
  candidates?: string[]
}

/**
 * Why `name` cannot be a new file of `kind` beside `siblings` (the folder's
 * entry names) and `nicknames` (the library table's), or null when it can.
 */
export function refuseFileName(
  kind: AgentFileKind,
  name: string,
  siblings: string[],
  nicknames: string[]
): CreateFileFailure | null {
  const { extension, library } = KINDS[kind]
  if (!name.trim()) return { error: 'blank-name', detail: 'The name is empty.' }
  if (name.toLowerCase().endsWith(extension))
    return {
      error: 'bad-name',
      detail: `name is the file stem; ${extension} is added for a ${kind}. Pass "${name.slice(0, -extension.length)}".`
    }
  const fileName = `${name}${extension}`
  if (library && /[\\/:*?"<>|]/.test(name))
    return {
      error: 'bad-name',
      detail: `"${name}" holds a character a library name cannot: \\ / : * ? " < > |.`
    }
  const problem = validateFileName(fileName, siblings)
  if (problem === 'exists')
    return {
      error: 'name-taken',
      detail: `The project folder already holds ${fileName}.`,
      candidates: siblings.filter((sibling) => sibling.toLowerCase() === fileName.toLowerCase())
    }
  if (problem)
    return {
      error: 'bad-name',
      detail:
        problem === 'separator'
          ? `"${name}" holds a path separator; pass a name, and the file lands in the project folder.`
          : problem === 'reserved'
            ? `"${name}" is a name Windows reserves for a device.`
            : `"${name}" starts or ends with a dot or a space.`
    }
  const taken =
    library && nicknames.find((nickname) => nickname.toLowerCase() === name.toLowerCase())
  if (taken)
    return {
      error: 'name-taken',
      detail: `The project's ${TABLE_FILENAME[library]} already has a library called ${taken}.`,
      candidates: [taken]
    }
  return null
}

/** What the op needs of the window: the disk, the project bus and the tabs. */
export interface CreateFileIo {
  /** The names of the folder's own entries. */
  listNames(directory: string): Promise<string[]>
  createFile(path: string, content: string): Promise<{ success: boolean; error?: string }>
  /** The project's library table, null when it has none. */
  readTable(kind: LibraryTableKind): Promise<string | null>
  /** Write the empty library and register it in the project's table, as New library does. */
  createLibrary(kind: LibraryTableKind, name: string): Promise<string>
  /** Announce the new file (and the registration) to everything derived from the project. */
  announce(path: string, nickname?: string): Promise<void>
  /** Open the file in a tab behind the active one. */
  openBehind(path: string): void
}

export interface CreateFileAnswer {
  path: string
  kind: AgentFileKind
  /** A library's nickname, the `Nickname` of its `Nickname:Name` ids. */
  library?: string
  changed: { created: string[]; updated: string[]; deleted: string[] }
  opened: boolean
  guidance: string
}

/** Create the file in the active project; `project` null when the window has none active. */
export async function createFileForAgent(
  project: { path: string; dir: string } | null,
  hasFolder: boolean,
  request: { fileKind: AgentFileKind; name: string },
  io: CreateFileIo
): Promise<CreateFileAnswer | CreateFileFailure> {
  if (!project)
    return hasFolder
      ? {
          error: 'no-active-project',
          detail: 'The open folder has no single active project to create the file in.'
        }
      : { error: 'no-project', detail: 'No project is open to create the file in.' }
  const { fileKind: kind, name } = request
  const { extension, library, scaffold, opensAsTab: opened, guidance } = KINDS[kind]
  const table = library ? await io.readTable(library) : null
  const refusal = refuseFileName(
    kind,
    name,
    await io.listNames(project.dir),
    table ? tableNicknames(table) : []
  )
  if (refusal) return refusal
  const fileName = `${name}${extension}`
  let path = `${project.dir}/${fileName}`
  if (scaffold) {
    const written = await io.createFile(path, blankFileContent(scaffold, fileName))
    if (!written.success) return { error: 'write-failed', detail: written.error ?? path }
  } else if (library) {
    try {
      path = await io.createLibrary(library, name)
    } catch (err) {
      return { error: 'write-failed', detail: err instanceof Error ? err.message : String(err) }
    }
  }
  await io.announce(path, library ? name : undefined)
  if (opened) io.openBehind(path)
  const tablePath = library ? `${project.dir}/${TABLE_FILENAME[library]}` : null
  return {
    path,
    kind,
    ...(library ? { library: name } : {}),
    changed: {
      created: [path, ...(tablePath && table === null ? [tablePath] : [])],
      updated: tablePath && table !== null ? [tablePath] : [],
      deleted: []
    },
    opened,
    guidance
  }
}
