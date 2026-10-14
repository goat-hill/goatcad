/**
 * A snapshot derived from the libraries a project reaches, re-read when they
 * change: ERC's library facts (`schematic/ercLibraries.ts`) and the board's
 * library footprints (`board/boardLibraries.ts`). The app's layer of the view
 * is memoized (`loadLibraryView`), so a re-read costs the project's own
 * tables and libraries only.
 */
import type { ProjectChange } from './projectBus'

const LIBRARY_PATH = /(?:\.kicad_sym|\.kicad_mod|\.pretty[\\/]?|(?:^|[\\/])(?:sym|fp)-lib-table)$/i

/**
 * Whether a change batch can move what the project's own libraries hold: a
 * library file or `.pretty` folder, either table, or a project registration.
 */
export const touchesProjectLibraries = (changes: readonly ProjectChange[]): boolean =>
  changes.some((change) => {
    if ('scope' in change) return change.scope === 'project'
    if ('path' in change) return LIBRARY_PATH.test(change.path)
    return LIBRARY_PATH.test(change.from) || LIBRARY_PATH.test(change.to)
  })

export interface LibraryFeed {
  /** Read now; a read still in flight is superseded. */
  refresh(): void
  /** Read after a quiet spell, so a burst of library writes is read once. */
  refreshSoon(): void
  /** Settles once the latest read, or one still waiting to start, has answered. */
  ready(): Promise<void>
  dispose(): void
}

/** `load` answers the snapshot; a failed read publishes undefined, so the rules stay quiet. */
export function createLibraryFeed<T>(
  load: () => Promise<T>,
  publish: (value: T | undefined) => void,
  delayMs = 150
): LibraryFeed {
  let request = 0
  let read: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null
  let waiting: { promise: Promise<void>; resolve: () => void } | null = null
  const refresh = (): void => {
    const mine = ++request
    read = load()
      .then((value) => {
        if (mine === request) publish(value)
      })
      .catch(() => {
        if (mine === request) publish(undefined)
      })
  }
  return {
    refresh,
    refreshSoon: () => {
      if (timer) clearTimeout(timer)
      if (!waiting) {
        let resolve: () => void = () => {}
        const promise = new Promise<void>((done) => (resolve = done))
        waiting = { promise, resolve }
      }
      timer = setTimeout(() => {
        timer = null
        const settled = waiting
        waiting = null
        refresh()
        void read.then(() => settled?.resolve())
      }, delayMs)
    },
    // A check asked during the quiet spell must see the read it is waiting for.
    ready: () => waiting?.promise ?? read,
    dispose: () => {
      if (timer) clearTimeout(timer)
      timer = null
      waiting?.resolve()
      waiting = null
      request++
    }
  }
}
