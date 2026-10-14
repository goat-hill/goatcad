/**
 * The library facts ERC needs, read off the library index (`libraryIndex.ts`
 * `loadLibraryView`): which symbol and footprint libraries the project
 * reaches, and what each holds. A library the index found is there, and holds
 * exactly what the index read from it; one it cannot read goes unjudged.
 */
import { libraryState, type LibraryView } from '../libraryIndex'
import type { ErcContext } from './ercContext'

export const ercLibraryContext = (view: LibraryView): ErcContext => {
  /** Whether a readable library holds a part; undefined when that is not known. */
  const holds = (
    library: { library: { readable: boolean }; items: ReadonlyMap<string, unknown> } | undefined,
    name: string
  ): boolean | undefined => (library?.library.readable ? library.items.has(name) : undefined)
  return {
    symbolLibrary: (nickname) => libraryState(view.symbols.get(nickname)),
    hasSymbol: (libId) => {
      const colon = libId.indexOf(':')
      return holds(view.symbols.get(libId.slice(0, colon)), libId.slice(colon + 1))
    },
    footprintLibrary: (nickname) => libraryState(view.footprints.get(nickname)),
    hasFootprint: (nickname, name) => holds(view.footprints.get(nickname), name)
  }
}
