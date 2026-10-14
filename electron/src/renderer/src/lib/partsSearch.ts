/**
 * Part Search state, held outside the component.
 *
 * The tab unmounts whenever you switch to another editor tab, so component-local
 * state would throw your results away every time you looked at the board — and
 * re-running the search would spend quota to recover something you never asked
 * to lose. A module-level store is how the app already keeps cross-mount state
 * (`lib/pcbView.ts`, `lib/selectionFilter.ts`); this one is session-only, since
 * there is nothing here worth persisting.
 *
 * On the API terms: holding a result set for as long as its view exists is
 * exactly what "cache it to support the view" means, and is not the persisted
 * database the agreements prohibit. Nothing
 * here is written to disk and nothing survives a restart.
 */
import { ref, type Ref } from 'vue'
import type {
  PartCategory,
  PartsCredentialStatus,
  PartsFilterState,
  PartsProviderInfo,
  PartsSearchMode,
  PartsSort,
  PartsUniversalResult
} from '../../../preload/partsTypes'
import { groupSingleProvider } from './partsDisplay'
import { emptyFilterState, toPlainFilters, type FilterLabels } from './partsFilter'
import { DEFAULT_PAGE_SIZE } from './partsPaging'

/**
 * Dev-only: carry this state across a hot reload.
 *
 * Vite re-executes this module whenever it or anything it imports changes, and a
 * re-executed module builds every ref from its initial value again — so editing
 * one line of `partsFilter.ts` drops you back to an empty Universal search. The
 * cost is not the retyping: recovering the results means spending more of a
 * ~1000/day quota on a search you had already paid for.
 *
 * `dispose` hands the outgoing instance's values to the incoming one through
 * Vite's `data` object, so a ref declared with `hotRef` picks up where it left
 * off. A production build replaces `import.meta.hot` with `undefined`, which
 * makes every guard here statically false and leaves `hotRef` a plain `ref`;
 * none of this machinery survives into `out/renderer`.
 *
 * The no-persistence rule is untouched: this is the same process memory
 * surviving a module swap, never disk, and it dies with the window like any other session state.
 */
const hotRefs = new Map<string, Ref<unknown>>()
const restored = import.meta.hot?.data.partsState as Record<string, unknown> | undefined

const hotRef = <T>(name: string, initial: T): Ref<T> => {
  const state = ref(initial) as Ref<T>
  if (!import.meta.hot) return state
  if (restored && name in restored) state.value = restored[name] as T
  hotRefs.set(name, state as Ref<unknown>)
  return state
}

import.meta.hot?.dispose((data) => {
  const snapshot: Record<string, unknown> = {}
  for (const [name, state] of hotRefs) snapshot[name] = state.value
  data.partsState = snapshot
})

/**
 * The provider registry and which of them have a key.
 *
 * In the store rather than the component because the tab unmounts on every
 * switch to another editor tab: component-local, these start empty on each
 * remount and the setup card renders for a frame before the real state arrives.
 * `providersReady` is what the view waits on, so nothing is drawn from a state
 * we simply have not loaded yet.
 */
export const providers = hotRef<PartsProviderInfo[]>('providers', [])
export const statuses = hotRef<PartsCredentialStatus[]>('statuses', [])
export const providersReady = hotRef('providersReady', false)

/** Idempotent: the registry does not change within a session, and credentials
 *  arrive by broadcast rather than by polling. */
export async function loadProviders(): Promise<void> {
  if (providersReady.value) return
  const [info, status] = await Promise.all([
    window.api.partsProviders(),
    window.api.partsCredentialStatus()
  ])
  providers.value = info
  statuses.value = status
  providersReady.value = true
}

/**
 * Which catalog is being asked. Universal fans out and groups; a distributor
 * mode asks one API and can therefore use its paging and its filters.
 * Deliberately not persisted — a mode is about the task in
 * front of you, not a preference.
 */
export const mode = hotRef<PartsSearchMode>('mode', 'universal')

/** DigiKey's category tree, fetched at most once a session by main. */
export const categories = hotRef<PartCategory[]>('categories', [])
export const categoriesLoading = ref(false)
/** The browse path currently open, root-first. Empty means the top level. */
export const categoryPath = hotRef<PartCategory[]>('categoryPath', [])
/**
 * Whether the category browser is showing, held explicitly rather than inferred
 * from "no query yet". A category search deliberately has *no* keyword, so
 * inferring would flip straight back to the tree and hide the results it just
 * fetched.
 */
export const browsing = hotRef('browsing', false)

/**
 * Two copies on purpose. `filters` is what the last search actually ran with;
 * `pendingFilters` is what the rail is editing. Apply copies one to the other
 * and re-searches — so five checkboxes cost one request, not five, and the
 * results on screen always match the filters shown as applied.
 */
export const filters = hotRef<PartsFilterState>('filters', emptyFilterState())
export const pendingFilters = hotRef<PartsFilterState>('pendingFilters', emptyFilterState())

/**
 * Display text for every id ever ticked, so an applied-filter chip can name
 * itself after the facet that offered it has gone. Grows
 * within a search and resets with it — a stale label is only ever a few bytes.
 */
export const filterLabels = hotRef<FilterLabels>('filterLabels', {})

/**
 * Mutations the view calls, rather than assigning the refs from a template.
 *
 * A template writing `pendingFilters = next` leans on the compiler's ref-unwrap
 * handling for an *imported* binding, which is a subtlety no reader should have
 * to reason about — and one that fails silently if it ever stops holding. The
 * store owns its own state, as it already does for mode, page and height.
 */
export const setPendingFilters = (next: PartsFilterState): void => {
  pendingFilters.value = next
}

export const setPendingSearchWithin = (next: string): void => {
  pendingSearchWithin.value = next
}

export const setCategoryPath = (next: PartCategory[]): void => {
  categoryPath.value = next
}

export const setQuantity = (next: number): void => {
  quantity.value = Number.isFinite(next) && next >= 1 ? Math.trunc(next) : 1
}

export const rememberFilterLabel = (key: string, label: string, group?: string): void => {
  filterLabels.value = { ...filterLabels.value, [key]: { label, ...(group ? { group } : {}) } }
}

/** The scope the current results were fetched under, so Apply re-runs the same
 *  search rather than dropping back to an unscoped one. */
export const activeCategoryId = hotRef<number | null>('activeCategoryId', null)

/**
 * Column ordering, applied by the distributor rather than to the rows on screen.
 *
 * Null is the distributor's own ordering, and it has to be a real state: DigiKey's
 * `SortField` publishes no relevance member, so relevance is reachable only by
 * sending no sort at all. Sorting locally instead would rank one page
 * against a total in the hundreds of thousands — the same lie the filter rail
 * refuses.
 */
export const sort = hotRef<PartsSort | null>('sort', null)

/** Re-orders at the distributor, so it costs a request and returns to page 1 —
 *  page 3 of one ordering is not page 3 of another. */
export async function applySort(next: PartsSort | null): Promise<void> {
  if (searching.value) return
  sort.value = next
  page.value = 0
  await execute(activeCategoryId.value ?? undefined)
}

/**
 * Height of the filter strip, in px. Session state like the other panel sizes —
 * a facet list you have sized to your screen should not snap back when you look
 * at the board and come back.
 */
export const DEFAULT_FILTER_HEIGHT = 315
export const MIN_FILTER_HEIGHT = 120
export const MAX_FILTER_HEIGHT = 640
export const filterHeight = hotRef('filterHeight', DEFAULT_FILTER_HEIGHT)

export const setFilterHeight = (px: number): void => {
  filterHeight.value = Math.round(Math.min(MAX_FILTER_HEIGHT, Math.max(MIN_FILTER_HEIGHT, px)))
}

/**
 * Paging, distributor modes only. Universal merges two catalogs, so an offset
 * means nothing to either of them and its pager is hidden.
 * `page` is 0-based; the UI renders it 1-based.
 */
export const page = hotRef('page', 0)
export const pageSize = hotRef('pageSize', DEFAULT_PAGE_SIZE)

export const query = hotRef('query', '')

/**
 * The keyword the results on screen were actually fetched with.
 *
 * Separate from `query`, which is the box you are still typing in. The applied
 * chips describe what is narrowing the current results, so binding them to the
 * live box makes a chip appear letter by letter and claim a narrowing that has
 * not happened — the same lie the filter chips were fixed for. Committed here at
 * request time, exactly like `filters`.
 */
export const appliedQuery = hotRef('appliedQuery', '')

/**
 * A second keyword that narrows the current search without replacing it.
 *
 * Both APIs take a single `Keywords` string, so "search within" is not a
 * separate mechanism — it is appended to the primary query. Keeping the two
 * apart is what makes them separately removable and separately meaningful: the
 * top bar is *what you are looking for*, this is *and also*.
 *
 * Draft/applied like the filters, because it sits on the Apply row and is
 * committed by the same button.
 */
export const searchWithin = hotRef('searchWithin', '')
export const pendingSearchWithin = hotRef('pendingSearchWithin', '')

/** What actually goes to the API. */
const effectiveKeyword = (): string =>
  [query.value.trim(), searchWithin.value.trim()].filter(Boolean).join(' ')
/** Target quantity — picks which price break is shown, never re-runs a search. */
export const quantity = hotRef('quantity', 10)
export const searching = ref(false)
export const result = hotRef<PartsUniversalResult | null>('result', null)
export const expandedKey = hotRef<string | null>('expandedKey', null)
/**
 * Why the last search failed, when it failed *before* reaching a distributor —
 * a rejected IPC rather than an API error. Without this a bug on our side
 * renders as an empty screen with nothing to read, which is how a Proxy crossing
 * the bridge went unnoticed once already.
 */
export const searchError = hotRef<string | null>('searchError', null)
/** Set when the user cancelled the last request, which is not a failure but does
 *  leave the surface without results and wanting a way back. */
export const cancelled = hotRef('cancelled', false)

/**
 * What the last request was, so it can be run again after a failure or a cancel.
 * Retry re-issues exactly the same search rather than reconstructing one from
 * current state, which may have moved on.
 */
const lastRequest = hotRef<{ keyword: string; categoryId?: number } | null>('lastRequest', null)

/**
 * Orphans an in-flight reply. Main's own deadline still ends the request; this
 * only decides whether we still care about the answer, which is the honest limit
 * of what a renderer can cancel over an already-sent IPC.
 */
let requestToken = 0

/** Product photos as data URLs, keyed by source URL. Kept alongside the results
 *  they belong to so a tab switch does not re-fetch every thumbnail. */
export const photos = hotRef<Record<string, string>>('photos', {})

/** Fetch any thumbnail we do not already have. Failures are silent — a missing
 *  photo is a cosmetic gap, never a failed search. */
const loadPhotos = (next: PartsUniversalResult): void => {
  for (const group of next.groups) {
    const url = group.photoUrl
    if (!url || photos.value[url]) continue
    void window.api.partsImage(url).then((dataUrl) => {
      if (dataUrl) photos.value = { ...photos.value, [url]: dataUrl }
    })
  }
}

/**
 * Run a search in the current mode.
 *
 * Universal fans out and groups; a distributor mode asks that one API and its
 * single answer is grouped the same way, so the result shape — and therefore the
 * whole results UI — is identical either way. That is what lets one screen serve
 * three modes.
 *
 * `categoryId` scopes the search to a DigiKey category, which is what a browse
 * click is: a search with a scope and usually no keyword.
 */
export async function runPartsSearch(categoryId?: number): Promise<void> {
  const keyword = query.value.trim()
  if (!keyword && categoryId === undefined) return
  if (searching.value) return

  // A new query starts unfiltered: facets belong to the result set that offered
  // them, and carrying a manufacturer id into a different search would narrow by
  // something the user can no longer see.
  // The top bar always starts over: a new query with the previous query's
  // narrowing still applied would silently answer a question nobody asked.
  filters.value = emptyFilterState()
  pendingFilters.value = emptyFilterState()
  filterLabels.value = {}
  searchWithin.value = ''
  pendingSearchWithin.value = ''
  // Ordering belongs to a result set too. Carrying "cheapest first" into a
  // different search would answer a question about the previous one.
  sort.value = null
  activeCategoryId.value = categoryId ?? null
  page.value = 0
  await execute(categoryId)
}

/** Jump to a page of the current search. One request, like any other. */
export async function goToPage(next: number): Promise<void> {
  if (searching.value || next === page.value || next < 0) return
  page.value = next
  await execute(activeCategoryId.value ?? undefined)
}

/** Changing rows-per-page returns to the first page: page 3 of 20-row pages is
 *  not page 3 of 50-row pages, and silently landing somewhere else is worse
 *  than starting over. */
export async function setPageSize(size: number): Promise<void> {
  if (searching.value || size === pageSize.value) return
  pageSize.value = size
  page.value = 0
  await execute(activeCategoryId.value ?? undefined)
}

/**
 * Re-run the current search with the rail's draft filters.
 *
 * This is the one place a filter costs anything: the rail edits a draft freely
 * and Apply spends exactly one request, however many boxes were ticked.
 */
export async function applyPartsFilters(): Promise<void> {
  if (searching.value) return
  filters.value = pendingFilters.value
  searchWithin.value = pendingSearchWithin.value
  // Narrowing changes what is on page 1, so staying on page 7 would land in a
  // different result set at an arbitrary depth.
  page.value = 0
  await execute(activeCategoryId.value ?? undefined)
}

/** Drop the primary query, keeping the category scope if there is one. */
export async function clearQuery(): Promise<void> {
  if (searching.value) return
  query.value = ''
  page.value = 0
  if (!effectiveKeyword() && activeCategoryId.value === null) {
    // Nothing left to search: back to the prompt rather than an empty list.
    result.value = null
    appliedQuery.value = ''
    return
  }
  await execute(activeCategoryId.value ?? undefined)
}

/** Drop the secondary keyword. */
export async function clearSearchWithin(): Promise<void> {
  if (searching.value) return
  searchWithin.value = ''
  pendingSearchWithin.value = ''
  page.value = 0
  await execute(activeCategoryId.value ?? undefined)
}

const execute = async (categoryId?: number): Promise<void> => {
  const token = ++requestToken
  const current = (): boolean => token === requestToken
  const keyword = effectiveKeyword()

  lastRequest.value = { keyword, ...(categoryId === undefined ? {} : { categoryId }) }
  appliedQuery.value = query.value.trim()
  searching.value = true
  browsing.value = false
  expandedKey.value = null
  searchError.value = null
  cancelled.value = false
  // Plain object, not the reactive ref's value — see toPlainFilters.
  const plain = toPlainFilters(filters.value)
  // Same reason: a Proxy has no structured clone, so the sort is rebuilt as a
  // plain object rather than handed across the bridge off the ref.
  const plainSort = sort.value ? { field: sort.value.field, order: sort.value.order } : null
  try {
    const next =
      mode.value === 'universal'
        ? await window.api.partsSearchAll(keyword, undefined, plain)
        : groupSingleProvider(
            mode.value,
            await window.api.partsSearch(
              mode.value,
              keyword,
              pageSize.value,
              page.value * pageSize.value,
              categoryId,
              plain,
              plainSort
            )
          )
    // A cancelled or superseded reply is dropped rather than landing late over
    // whatever the user is looking at now.
    if (!current()) return
    result.value = next
    loadPhotos(next)
  } catch (err) {
    if (current()) searchError.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (current()) searching.value = false
  }
}

/** Stop waiting on the current search. */
export function cancelSearch(): void {
  if (!searching.value) return
  requestToken += 1
  searching.value = false
  cancelled.value = true
}

/** Run the last request again, unchanged. */
export async function retrySearch(): Promise<void> {
  const last = lastRequest.value
  if (!last || searching.value) return
  await execute(last.categoryId)
}

/**
 * Take one applied filter back off, immediately.
 *
 * Chips report what is *applied*, so removing one has to change the results —
 * editing only the draft would leave the chip sitting there with nothing having
 * happened. That makes this the one filter interaction that spends a request on
 * its own, and it is the right one: removing a filter you can see is a decision,
 * not an exploration.
 */
export async function dropAppliedFilter(next: PartsFilterState): Promise<void> {
  if (searching.value) return
  filters.value = next
  pendingFilters.value = next
  page.value = 0
  await execute(activeCategoryId.value ?? undefined)
}

/**
 * Load the current mode's category tree. Main memoizes it for the session, so
 * re-entering browse costs nothing; this guard only avoids a duplicate in-flight
 * request.
 */
export async function loadCategories(): Promise<void> {
  if (mode.value === 'universal' || categoriesLoading.value || categories.value.length) return
  categoriesLoading.value = true
  try {
    const result = await window.api.partsCategories(mode.value)
    if (result.ok) categories.value = result.value
  } finally {
    categoriesLoading.value = false
  }
}

/** Reset everything a mode switch invalidates: results belong to one catalog. */
export function setMode(next: PartsSearchMode): void {
  if (mode.value === next) return
  mode.value = next
  result.value = null
  expandedKey.value = null
  categoryPath.value = []
  categories.value = []
  filters.value = emptyFilterState()
  pendingFilters.value = emptyFilterState()
  filterLabels.value = {}
  searchWithin.value = ''
  pendingSearchWithin.value = ''
  // Only DigiKey sorts, so a sort cannot survive the move to a mode that would
  // silently ignore it while its header still claimed to be ordering.
  sort.value = null
  activeCategoryId.value = null
  searchError.value = null
  page.value = 0
  // A distributor mode lands on its catalog; Universal has none to land on.
  browsing.value = next !== 'universal'
}

/** Return to the tree from a result set, keeping the path you browsed to. */
export function showBrowser(): void {
  browsing.value = true
}
