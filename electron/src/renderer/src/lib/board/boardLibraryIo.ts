/**
 * Where the board editor finds its footprint libraries for the library
 * rules (`boardLibraries.ts`): the library index, with the board's project's
 * own libraries over the app's — the same facts ERC's library rules read
 * (`schematic/ercLibraries.ts`).
 */
import type { BoardLibraryIo } from './boardLibraries'
import { loadLibraryView } from '../libraryIndex'

/** `projectPath` is the project file, its directory, or a file in it (the board). */
export const boardLibraryIo = (projectPath: string | null | undefined): BoardLibraryIo => ({
  libraries: () => loadLibraryView(projectPath),
  readFile: async (path) => {
    const result = await window.api.readFile(path)
    return result.success && typeof result.content === 'string' ? result.content : null
  }
})
