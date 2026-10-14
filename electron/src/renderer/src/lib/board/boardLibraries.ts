/**
 * The footprint libraries a board's checks compare its footprints against
 * (`drc/rules/libraryParity.ts`): which libraries the project reaches, and
 * each library footprint the board places, parsed — both read off the library
 * index, as ERC's library rules are (`schematic/ercLibraries.ts`). Loaded
 * before a check, since the checks themselves read no files; a library that
 * cannot be read keeps its footprints unjudged rather than guess.
 */
import type { KicadBoard } from '../kicad/board'
import { parseKicadFootprint, type KicadFootprint } from '../kicad/footprint'
import { libraryState, type LibraryView } from '../libraryIndex'

/** A library nickname's state in the project's tables, as KiCad's DRC tells them apart. */
export type FootprintLibraryState = 'ok' | 'missing' | 'disabled' | 'unreadable'

export interface BoardLibraries {
  /** A nickname's state; undefined while not known. */
  library(nickname: string): FootprintLibraryState | undefined
  /** The footprint, parsed; null when its library lacks it, undefined while not known. */
  footprint(nickname: string, name: string): KicadFootprint | null | undefined
  /** Where a library was looked for, for a finding that says it was not there. */
  location?(nickname: string): string | undefined
}

/** A board footprint's `Nickname:Name`, split; null for one with no library. */
export const splitFootprintId = (libId: string): { nickname: string; name: string } | null => {
  const colon = libId.indexOf(':')
  if (colon <= 0) return null
  return { nickname: libId.slice(0, colon), name: libId.slice(colon + 1) }
}

export interface BoardLibraryIo {
  /** The libraries the board's project reaches, and what each holds (`libraryIndex.ts`). */
  libraries(): Promise<LibraryView>
  readFile(path: string): Promise<string | null>
}

/**
 * The libraries a board's footprints come from, as data: each nickname's state
 * and file, and the text of each library footprint the board places (null when
 * its library lacks it). What a thread with no file access needs to check
 * against them (`lib/board/worker/`), and what `boardLibrariesOf` reads.
 */
export interface BoardLibraryData {
  states: Map<string, FootprintLibraryState>
  locations: Map<string, string>
  /** By `Nickname:Name`. */
  texts: Map<string, string | null>
}

/** Read the library footprints a board places, and its libraries' states. */
export async function readBoardLibraryData(
  io: BoardLibraryIo,
  board: KicadBoard
): Promise<BoardLibraryData> {
  const view = await io.libraries()
  const data: BoardLibraryData = { states: new Map(), locations: new Map(), texts: new Map() }
  for (const [nickname, library] of view.footprints) {
    data.states.set(nickname, libraryState(library))
    data.locations.set(nickname, library.library.file)
  }
  const ids = new Set(board.footprints.map((bfp) => bfp.libId))
  await Promise.all(
    [...ids].map(async (libId) => {
      const id = splitFootprintId(libId)
      const library = id && view.footprints.get(id.nickname)
      if (!id || !library?.library.readable) return
      const record = library.items.get(id.name)
      if (!record) {
        data.texts.set(libId, null)
        return
      }
      const text = await io.readFile(record.file)
      if (text !== null) data.texts.set(libId, text)
    })
  )
  return data
}

/** Parsed library footprints by text, so a board's many placements of one part parse it once. */
const parsed = new Map<string, KicadFootprint | undefined>()

/** The libraries as the checks read them, each footprint parsed from its text. */
export function boardLibrariesOf(data: BoardLibraryData): BoardLibraries {
  const footprints = new Map<string, KicadFootprint | null>()
  for (const [libId, text] of data.texts) {
    if (text === null) {
      footprints.set(libId, null)
      continue
    }
    if (!parsed.has(text)) {
      // A file the parser cannot read goes unjudged: KiCad's reader may take it.
      let footprint: KicadFootprint | undefined
      try {
        footprint = parseKicadFootprint(text)
      } catch {
        footprint = undefined
      }
      parsed.set(text, footprint)
    }
    const footprint = parsed.get(text)
    if (footprint) footprints.set(libId, footprint)
  }
  return {
    library: (nickname) => data.states.get(nickname) ?? 'missing',
    footprint: (nickname, name) => footprints.get(`${nickname}:${name}`),
    location: (nickname) => data.locations.get(nickname)
  }
}

/** The libraries for a board's footprints: each one it places, read and parsed. */
export async function loadBoardLibraries(
  io: BoardLibraryIo,
  board: KicadBoard
): Promise<BoardLibraries> {
  return boardLibrariesOf(await readBoardLibraryData(io, board))
}
