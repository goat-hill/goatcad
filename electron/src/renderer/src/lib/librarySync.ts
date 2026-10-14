/**
 * How a placed part stands against its library copy, as the properties
 * panel's library section shows it (docs/libraries-workstream.md §5).
 * Shared by the board's footprints and the schematic's symbols, so both read
 * alike. A state of the link, not a property of the part: it sits below the
 * property table with the actions on that link, not in it.
 */

/** How one placed part stands against its library. */
export type LibrarySync =
  | { state: 'match' }
  | { state: 'differs' }
  /** No library holds its lib id. */
  | { state: 'missing' }
  /** Its library is still being read. */
  | { state: 'checking' }

export type LibrarySyncTone = 'ok' | 'warn' | 'muted'

export interface LibrarySyncStatus {
  tone: LibrarySyncTone
  label: string
  /** Some part is in a library, so Update from library can rebuild it — matching or not, since the sheet can reset its texts. */
  inLibrary: boolean
  /** One part, in a library: Edit library can open it. */
  loneInLibrary: boolean
}

export type LibrarySyncTranslate = (
  key: string,
  params?: number | Record<string, unknown>
) => string

/** The status a selection of parts shows. */
export function librarySyncStatus(
  t: LibrarySyncTranslate,
  states: readonly LibrarySync[]
): LibrarySyncStatus {
  const total = states.length
  const differs = states.filter((s) => s.state === 'differs')
  const missing = states.filter((s) => s.state === 'missing').length
  const loneInLibrary =
    total === 1 && states[0].state !== 'missing' && states[0].state !== 'checking'
  const inLibrary = states.some((s) => s.state === 'match' || s.state === 'differs')
  const base = { inLibrary, loneInLibrary }
  if (states.some((s) => s.state === 'checking'))
    return { ...base, tone: 'muted', label: t('shared.librarySync.checking') }
  if (!differs.length && !missing)
    return { ...base, tone: 'ok', label: t('shared.librarySync.matches', total) }
  if (total === 1)
    return differs.length
      ? { ...base, tone: 'warn', label: t('shared.librarySync.differs') }
      : { ...base, tone: 'muted', label: t('shared.librarySync.missing') }
  if (differs.length)
    return {
      ...base,
      tone: 'warn',
      label: t('shared.librarySync.differsSome', { count: differs.length, total })
    }
  return {
    ...base,
    tone: 'muted',
    label: t('shared.librarySync.missingSome', { count: missing, total })
  }
}

/**
 * A lib id as the chooser and the Component view name it — its index record's
 * scope, library and name, or, with no record, the id's own library and name.
 * Null for no id (a selection naming several).
 */
export function libraryPartOf(
  libId: string,
  record?: { library: string; name: string; scope?: string }
): { library: string; name: string; scope?: string } | null {
  if (!libId) return null
  if (record) return { library: record.library, name: record.name, scope: record.scope }
  const colon = libId.indexOf(':')
  return colon < 0
    ? { library: '', name: libId }
    : { library: libId.slice(0, colon), name: libId.slice(colon + 1) }
}
