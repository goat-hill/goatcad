<script setup lang="ts">
/**
 * Part Search (`goatcad://parts`) — distributor catalog search as a full tab.
 *
 * **One row per physical part, not per listing.** A search asks every connected
 * distributor at once and groups the answers by manufacturer part;
 * each distributor that stocks it gets its
 * own line underneath with its own order code, stock, price and link. That is
 * the model Altium and Octopart both use, and it is also what the API terms
 * require: their data may not be blended with a competitor's "without
 * distinction", so there is deliberately no merged "cheapest" row —
 * which would be misleading anyway, since prices carry different minimum
 * quantities and packaging.
 *
 * **Attribution is not optional**. Every distributor line names its
 * distributor and keeps a working link out to the product page. Stripping either
 * to tidy the row would breach the agreement we search under.
 *
 * **Results outlive the component**, in `lib/partsSearch.ts`. This tab unmounts
 * every time you switch to another one, and losing a result set on a glance at
 * the board — then spending quota to get it back — is not a tradeoff worth
 * making. Holding data for as long as its view exists is what supporting a view
 * means; what the API terms forbid is a persisted database, and nothing here
 * touches disk. Photos are fetched by main and arrive as `data:` URLs,
 * so the renderer's CSP stays closed to remote hosts.
 *
 * **No search-as-you-type.** The published quotas are ~1000 calls/day, so a
 * keystroke must never be a request.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  PartCategory,
  PartGroup,
  PartGroupSource,
  PartsProviderId,
  PartsSearchMode,
  PartsSortField
} from '../../../preload/partsTypes'
import { priceAtQuantity, totalStock } from '../lib/partsDisplay'
import {
  FIXED_COLUMNS,
  nextSort,
  parameterValue,
  parametricColumns,
  SORT_LABEL_KEY,
  type PartsColumn
} from '../lib/partsColumns'
import {
  categories,
  categoriesLoading,
  browsing,
  cancelled,
  cancelSearch,
  clearQuery,
  clearSearchWithin,
  categoryPath,
  applyPartsFilters,
  expandedKey,
  filterHeight,
  filterLabels,
  filters,
  goToPage,
  loadCategories,
  loadProviders,
  page,
  pageSize,
  pendingFilters,
  pendingSearchWithin,
  providers,
  providersReady,
  mode,
  photos,
  query,
  appliedQuery,
  quantity,
  result,
  dropAppliedFilter,
  rememberFilterLabel,
  retrySearch,
  runPartsSearch,
  searchError,
  searching,
  searchWithin,
  setCategoryPath,
  setFilterHeight,
  setPendingFilters,
  setPendingSearchWithin,
  sort,
  applySort,
  setMode,
  setPageSize,
  showBrowser,
  statuses
} from '../lib/partsSearch'
import CategoryBrowser from './parts/CategoryBrowser.vue'
import { delayedVisible } from '../lib/delayedVisible'
import FilterBar from './parts/FilterBar.vue'
import ResultsPager from './parts/ResultsPager.vue'

import Icon from './shared/Icon.vue'

const emit = defineEmits<{ (e: 'open-settings', category: string): void }>()

const { t, n, locale } = useI18n()

const configured = computed(() => statuses.value.filter((status) => status.configured))
const anyConfigured = computed(() => configured.value.length > 0)

const providerName = (id: PartsProviderId): string =>
  providers.value.find((info) => info.id === id)?.name ?? id

let stopCredentialListener: (() => void) | null = null

onMounted(() => {
  void loadProviders()
  stopCredentialListener = window.api.onPartsCredentialsChanged((next) => {
    statuses.value = next
  })
})

onBeforeUnmount(() => {
  stopCredentialListener?.()
  observer?.disconnect()
})

/** The rows the distributor returned for the applied filters. There is no
 *  second, client-side narrowing: the rail edits the request. */
const groups = computed(() => result.value?.groups ?? [])

/**
 * Paging is a distributor-mode affordance. Universal merges two catalogs, so an
 * offset means nothing to either API.
 */
const paged = computed(() => mode.value !== 'universal')

/** The provider's own count for this search — DigiKey's `ProductsCount`,
 *  Mouser's `NumberOfResult`, normalized. */
const total = computed(() => result.value?.providers[0]?.total ?? 0)

/** The page scroller. The whole surface scrolls as one, so this is the element
 *  that moves — not a results pane with its own scrollbar. */
const pageEl = ref<HTMLElement | null>(null)

/**
 * Loading policy, DESIGN.md §Loading feedback: work that settles inside 150 ms
 * shows nothing at all — an indicator that flashes is noise. Past that it earns
 * a bar, which stays until the work settles.
 *
 * One indicator for one wait, so the category fetch shares it: opening DigiKey
 * browse is a network request like any other, and a second loading style for it
 * would make the same wait look like two different things.
 */
const busy = computed(() => searching.value || categoriesLoading.value)
const showProgress = delayedVisible(() => busy.value)

/** Anything that left the surface without results and wants a way back. */
const failures = computed(() => (result.value?.providers ?? []).filter((entry) => !entry.ok))
const canRetry = computed(
  () =>
    !searching.value && (searchError.value !== null || cancelled.value || failures.value.length > 0)
)

/** The category path, shown while its results are on screen so the scope of what
 *  you are looking at is never a thing you have to remember. */
const showCrumbs = computed(
  () => mode.value !== 'universal' && !browsing.value && categoryPath.value.length > 0
)

/**
 * A new page starts at the top. Landing halfway down a fresh list is
 * disorienting, and the row you were looking at is not there any more. Since the
 * page scrolls as one, this returns to the search box rather than to the first
 * row — the controls that produced the new page are back in view with it.
 */
const changePage = async (next: number): Promise<void> => {
  await goToPage(next)
  pageEl.value?.scrollTo({ top: 0 })
}

const changePageSize = async (size: number): Promise<void> => {
  await setPageSize(size)
  pageEl.value?.scrollTo({ top: 0 })
}

/**
 * The table scrolls sideways, but its own scrollbar sits under the last row —
 * and the table is as tall as the page. So the bar is proxied by a sticky strip
 * that is always in reach, and the two are kept in step.
 *
 * `syncing` breaks the feedback loop: setting `scrollLeft` on either element
 * fires its own scroll event, which would set it back.
 */
const tableEl = ref<HTMLElement | null>(null)
const tableInnerEl = ref<HTMLElement | null>(null)
const scrollbarEl = ref<HTMLElement | null>(null)
const scrollWidth = ref(0)
const clientWidth = ref(0)
const overflows = computed(() => scrollWidth.value > clientWidth.value + 1)

let syncing = false

const syncFromTable = (): void => {
  if (syncing || !tableEl.value || !scrollbarEl.value) return
  syncing = true
  scrollbarEl.value.scrollLeft = tableEl.value.scrollLeft
  syncing = false
}

const syncFromBar = (): void => {
  if (syncing || !tableEl.value || !scrollbarEl.value) return
  syncing = true
  tableEl.value.scrollLeft = scrollbarEl.value.scrollLeft
  syncing = false
}

/** Remeasured on any layout change: the column set moves with the category, so
 *  whether the table overflows at all is not knowable once and cached. */
const measure = (): void => {
  const el = tableEl.value
  if (!el) {
    scrollWidth.value = 0
    clientWidth.value = 0
    return
  }
  scrollWidth.value = el.scrollWidth
  clientWidth.value = el.clientWidth
}

let observer: ResizeObserver | null = null

watch(
  () => [tableEl.value, tableInnerEl.value] as const,
  ([host, inner]) => {
    observer?.disconnect()
    if (!host || !inner) {
      measure()
      return
    }
    observer = new ResizeObserver(measure)
    observer.observe(host)
    observer.observe(inner)
    measure()
  },
  { flush: 'post' }
)

/** Facets as the distributor reported them for this result set. */
const facets = computed(
  () =>
    result.value?.facets ?? {
      manufacturers: [],
      packaging: [],
      status: [],
      series: [],
      parametric: []
    }
)

/**
 * The columns, and which of them sort.
 *
 * Parametric columns exist only in DigiKey mode with a category chosen — that
 * scope is what makes the set finite, and it is the distributor's own list
 * rather than one we author.
 */
const parametric = computed(() => parametricColumns(mode.value, facets.value, groups.value))
const columns = computed(() => [...FIXED_COLUMNS, ...parametric.value])

const columnLabel = (column: PartsColumn): string =>
  column.label ?? t(`parts.columns.${column.key}`)

/** A sort control says what it orders by, which for the stacked part column is
 *  not the column's own name. */
const sortLabel = (field: PartsSortField): string => t(`parts.columns.${SORT_LABEL_KEY[field]}`)

const toggleSort = async (field: PartsSortField): Promise<void> => {
  await applySort(nextSort(sort.value, field))
}

const ariaSort = (column: PartsColumn): 'ascending' | 'descending' | 'none' | undefined => {
  if (!column.sorts.length) return undefined
  const active = column.sorts.find((field) => field === sort.value?.field)
  if (!active) return 'none'
  return sort.value?.order === 'asc' ? 'ascending' : 'descending'
}

/** The bar appears once a search has run — including one that returned nothing,
 *  since over-narrow filters are exactly when you need to loosen them. */
const showFilters = computed(() => !showBrowse.value && result.value !== null)

/** Modes offered: Universal only earns its place with more than one connected
 *  distributor, since with one it would be the same search under two names. */
const modes = computed<PartsSearchMode[]>(() => {
  const ids = configured.value.map((status) => status.provider)
  return ids.length > 1 ? ['universal', ...ids] : ids
})

const modeLabel = (value: PartsSearchMode): string =>
  value === 'universal' ? t('parts.modes.universal') : providerName(value)

const chooseMode = async (next: PartsSearchMode): Promise<void> => {
  setMode(next)
  // Browse is the landing state for a distributor that has a tree; fetching it
  // here rather than on tab open means a user who only ever searches by part
  // number never spends the call.
  if (next !== 'universal') await loadCategories()
}

/** Browse shows when a distributor mode has a tree and nothing has been searched
 *  — the catalog is the useful thing to look at before you know what you want. */
const showBrowse = computed(
  () =>
    mode.value !== 'universal' &&
    browsing.value &&
    (categories.value.length > 0 || categoriesLoading.value)
)

const searchCategory = (category: PartCategory): void => {
  void runPartsSearch(category.id)
}

const toggle = (group: PartGroup): void => {
  expandedKey.value = expandedKey.value === group.key ? null : group.key
}

const openExternal = (url: string | null): void => {
  if (url) void window.api.partsOpenExternal(url)
}

const priceLabel = (source: PartGroupSource): string | null => {
  const price = priceAtQuantity(source.record, quantity.value)
  if (!price) return null
  return n(price.unitPrice, { style: 'currency', currency: price.currency })
}

const stockOf = (source: PartGroupSource): number | null => totalStock(source.record)

const lifecycleTone = (group: PartGroup): string =>
  group.lifecycle === 'obsolete' ? 'is-error' : 'is-pending'

/** Stock figures run to six digits; grouped separators make them scannable. */
const countFormatter = computed(() => new Intl.NumberFormat(locale.value))
const formatCount = (value: number): string => countFormatter.value.format(value)
</script>

<template>
  <div ref="pageEl" class="parts-view">
    <div class="parts-header">
      <span class="parts-title">{{ t('parts.title') }}</span>
    </div>

    <!-- Nothing until the provider load resolves: drawing the setup card from a
         state we have not read yet flashes "connect a distributor" at someone
         who already has. -->
    <div v-if="!providersReady" class="parts-loading" />

    <!-- No key for any distributor: a setup card, not an empty list. -->
    <div v-else-if="!anyConfigured" class="parts-empty">
      <Icon name="part-search" />
      <p class="parts-empty-title">{{ t('parts.setup.title') }}</p>
      <p class="parts-empty-body">{{ t('parts.setup.body') }}</p>
      <button class="btn-cta btn-md" @click="emit('open-settings', 'parts')">
        {{ t('parts.setup.action') }}
      </button>
    </div>

    <template v-else>
      <div class="parts-query">
        <!-- Scope, chosen up front rather than inferred from a filter click.
             Universal answers "who has this part"; a distributor mode unlocks
             that vendor's own browse and filters. -->
        <div v-if="modes.length > 1" class="mode-bar" role="tablist">
          <button
            v-for="value in modes"
            :key="value"
            class="mode-btn"
            :class="{ active: mode === value }"
            role="tab"
            :aria-selected="mode === value"
            @click="chooseMode(value)"
          >
            {{ modeLabel(value) }}
          </button>
        </div>

        <input
          v-model="query"
          class="field-md parts-input"
          type="search"
          spellcheck="false"
          :placeholder="t('parts.searchPlaceholder')"
          @keydown.enter="() => runPartsSearch()"
        />
        <button
          class="btn-cta btn-md"
          :disabled="searching || !query.trim()"
          @click="() => runPartsSearch()"
        >
          {{ searching ? t('parts.searching') : t('parts.search') }}
        </button>
        <button v-if="showProgress" class="btn-subtle btn-md" @click="cancelSearch">
          {{ t('parts.cancel') }}
        </button>

        <!-- The row's own bottom rule, animated. Nothing moves when it appears,
             which is what keeps a 200 ms wait from shoving the page around
             (DESIGN.md §Loading feedback). -->
        <div v-if="showProgress" class="query-progress"><div class="progress-fill" /></div>
      </div>

      <!-- A distributor that failed is named. "No results" and "your key expired"
           must never look the same. -->
      <p v-if="cancelled" class="parts-hint">{{ t('parts.cancelled') }}</p>

      <!-- A failure before any distributor was reached — a bug on our side. It
           gets a line rather than a blank screen, which is what hid a Proxy
           crossing the IPC bridge once already. -->
      <p v-if="searchError" class="parts-failure">
        {{ t('parts.searchFailed', { error: searchError }) }}
      </p>

      <p v-for="entry in failures" :key="entry.provider" class="parts-failure">
        {{
          t('parts.providerFailed', {
            name: providerName(entry.provider),
            reason: t(`parts.errors.${entry.error?.kind ?? 'provider-error'}`, {
              detail: entry.error?.detail ?? ''
            })
          })
        }}
      </p>

      <!-- A distributor mode with a category tree lands on browse. Universal has
           none to show, so it keeps the prompt. -->
      <CategoryBrowser
        v-if="showBrowse"
        :categories="categories"
        :path="categoryPath"
        :loading="categoriesLoading"
        @update:path="setCategoryPath"
        @search="searchCategory"
      />

      <p v-if="canRetry" class="parts-retry">
        <button class="btn-outline btn-sm" @click="retrySearch">{{ t('parts.retry') }}</button>
      </p>

      <p v-else-if="!result && !searching && !cancelled" class="parts-hint">
        {{ t('parts.emptyPrompt') }}
      </p>
      <!-- Above the filters, because it names the scope everything below is
           narrowing: which category these results came from, and the way out. -->
      <div v-if="showCrumbs" class="browse-crumbs">
        <button class="btn-subtle btn-sm" @click="showBrowser">
          <Icon name="arrow-back" />
          {{ t('parts.browse.backToCategories') }}
        </button>
        <span class="crumb-path">
          <template v-for="(node, depth) in categoryPath" :key="node.id">
            <Icon v-if="depth > 0" name="chevron-right" class="breadcrumb-sep" />
            <span class="crumb-name">{{ node.name }}</span>
          </template>
        </span>
      </div>

      <template v-if="showFilters">
        <FilterBar
          :pending="pendingFilters"
          :applied="filters"
          :facets="facets"
          :mode="mode"
          :searching="searching"
          :height="filterHeight"
          :labels="filterLabels"
          :query="appliedQuery"
          :search-within="searchWithin"
          :pending-search-within="pendingSearchWithin"
          @update:pending="setPendingFilters"
          @apply="applyPartsFilters"
          @update:height="setFilterHeight"
          @remember-label="rememberFilterLabel"
          @apply-state="dropAppliedFilter"
          @update:pending-search-within="setPendingSearchWithin"
          @clear-query="clearQuery"
          @clear-within="clearSearchWithin"
        />

        <div class="parts-results">
          <!-- The same pager as the foot, so the controls are reachable without
               reading to the end of the page first. -->
          <ResultsPager
            v-if="paged && groups.length"
            :page="page"
            :page-size="pageSize"
            :total="total"
            place="head"
            :searching="searching"
            @update:page="changePage"
            @update:page-size="changePageSize"
          />
          <p v-else-if="groups.length" class="parts-count">
            {{ t('parts.groupCount', { count: groups.length }, groups.length) }}
          </p>

          <!-- A table, and one that scrolls sideways: a category's parameters
               are columns here, so the row is wider than the pane by design.
               Text cells opt back into selection — the app shell turns it off
               globally, and a catalog you cannot copy an MPN out of is a
               catalog you have to retype. -->
          <div v-if="groups.length" ref="tableEl" class="table-scroll" @scroll="syncFromTable">
            <table ref="tableInnerEl" class="parts-table">
              <thead>
                <tr>
                  <th class="col-caret"></th>
                  <th class="col-photo"></th>
                  <th
                    v-for="column in columns"
                    :key="column.key"
                    :class="[
                      `col-${column.key.replace(':', '-')}`,
                      { 'is-parametric': column.parameterId !== null }
                    ]"
                    :aria-sort="ariaSort(column)"
                  >
                    <!-- Sortable only where the distributor sorts. A parametric
                         heading is plain text: DigiKey rejects Parameter as a
                         sort field, and ordering the page here would rank
                         twenty rows against the whole catalog.
                         The part column offers two, because its cell stacks two
                         separately sortable lines. -->
                    <span v-if="column.sorts.length" class="sort-group">
                      <button
                        v-for="field in column.sorts"
                        :key="field"
                        class="col-sort"
                        :class="{ active: sort?.field === field }"
                        :disabled="searching"
                        :title="t('parts.columns.sortBy', { name: sortLabel(field) })"
                        @click="toggleSort(field)"
                      >
                        {{ sortLabel(field) }}
                        <Icon
                          v-if="sort?.field === field"
                          :name="sort.order === 'asc' ? 'arrow-up' : 'arrow-down'"
                          class="sort-indicator"
                        />
                        <span v-else class="sort-slot" />
                      </button>
                    </span>
                    <template v-else>{{ columnLabel(column) }}</template>
                  </th>
                  <!-- Takes every pixel the real columns did not need, so they
                       hug left instead of being stretched apart — while the
                       table still spans the pane, which is what keeps the row
                       rules running the whole way across. -->
                  <th class="col-filler"></th>
                </tr>
              </thead>

              <tbody>
                <template v-for="group in groups" :key="group.key">
                  <tr class="part-row" :class="{ expanded: expandedKey === group.key }">
                    <td class="col-caret">
                      <button
                        class="caret-btn"
                        :aria-expanded="expandedKey === group.key"
                        :title="t('parts.columns.expand')"
                        @click="toggle(group)"
                      >
                        <Icon
                          name="chevron-right"
                          class="disclosure"
                          :class="{ open: expandedKey === group.key }"
                        />
                      </button>
                    </td>

                    <!-- Proportional box only: the API terms forbid cropping or
                         obscuring a product image. -->
                    <td class="col-photo">
                      <span class="part-photo">
                        <img
                          v-if="group.photoUrl && photos[group.photoUrl]"
                          :src="photos[group.photoUrl]"
                          :alt="group.mpn"
                        />
                      </span>
                    </td>

                    <!-- These cells are written out rather than looped, because
                         each renders differently enough that a loop would be a
                         switch in a template. Their order must stay in step with
                         FIXED_COLUMNS, which is what the headings iterate.

                         Part number, manufacturer and description share one
                         column: they answer "which part is this" together, and
                         width is what a parametric table runs out of first. -->
                    <td class="col-part">
                      <div class="part-stack">
                        <span class="part-mpn selectable">{{ group.mpn }}</span>
                        <span class="part-mfr selectable">{{ group.manufacturer }}</span>
                        <span class="part-desc selectable">{{ group.description }}</span>
                      </div>
                    </td>
                    <td class="col-status">
                      <span
                        v-if="group.lifecycle !== 'unknown' && group.lifecycle !== 'active'"
                        class="status-badge"
                        :class="lifecycleTone(group)"
                      >
                        {{ t(`parts.lifecycle.${group.lifecycle}`) }}
                      </span>
                      <span v-else class="selectable">{{
                        t(`parts.lifecycle.${group.lifecycle}`)
                      }}</span>
                    </td>

                    <!-- Per-distributor, and stacked rather than merged. A row
                         in Universal can carry two sellers, and blending them
                         into one figure is what the API terms forbid — so each keeps
                         its own name, order code, stock, price and link. -->
                    <td class="col-seller">
                      <span
                        v-for="source in group.sources"
                        :key="source.provider"
                        class="cell-line"
                      >
                        <button
                          class="btn-outline btn-sm seller-btn"
                          :disabled="!source.record.productUrl"
                          :title="t('parts.part.product', { name: providerName(source.provider) })"
                          @click="openExternal(source.record.productUrl)"
                        >
                          {{ providerName(source.provider) }}
                        </button>
                        <span class="seller-pn selectable">{{
                          source.record.offers[0]?.distributorPartNumber ?? '—'
                        }}</span>
                      </span>
                    </td>

                    <td class="col-stock">
                      <span
                        v-for="source in group.sources"
                        :key="source.provider"
                        class="cell-line selectable"
                      >
                        <template v-if="stockOf(source) === null">{{
                          t('parts.part.stockUnknown')
                        }}</template>
                        <template v-else-if="stockOf(source) === 0">{{
                          t('parts.part.outOfStock')
                        }}</template>
                        <template v-else>{{ formatCount(stockOf(source) ?? 0) }}</template>
                      </span>
                    </td>

                    <td class="col-price">
                      <span
                        v-for="source in group.sources"
                        :key="source.provider"
                        class="cell-line selectable"
                      >
                        <template v-if="priceLabel(source)">{{ priceLabel(source) }}</template>
                        <template v-else>{{ t('parts.part.noPrice') }}</template>
                      </span>
                    </td>

                    <td
                      v-for="column in parametric"
                      :key="column.key"
                      class="col-parametric selectable"
                    >
                      {{ parameterValue(group, column.parameterId ?? -1) || '—' }}
                    </td>

                    <td class="col-filler"></td>
                  </tr>

                  <tr v-if="expandedKey === group.key" class="detail-row">
                    <td :colspan="columns.length + 3">
                      <div class="part-detail">
                        <div class="part-actions">
                          <button
                            v-if="group.datasheetUrl"
                            class="btn-outline btn-sm"
                            @click="openExternal(group.datasheetUrl)"
                          >
                            {{ t('parts.part.datasheet') }}
                          </button>
                        </div>

                        <!-- Every parameter the part reports, including any the
                             table dropped for reading the same on every row. -->
                        <template v-for="source in group.sources" :key="`p-${source.provider}`">
                          <p v-if="source.record.parameters.length" class="part-section">
                            {{
                              t('parts.part.parametersFrom', {
                                name: providerName(source.provider)
                              })
                            }}
                          </p>
                          <dl v-if="source.record.parameters.length" class="part-params">
                            <div
                              v-for="parameter in source.record.parameters"
                              :key="`${source.provider}-${parameter.name}`"
                              class="part-param"
                            >
                              <dt>{{ parameter.name }}</dt>
                              <dd class="selectable">{{ parameter.value }}</dd>
                            </div>
                          </dl>
                        </template>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>

          <!-- A scrollbar for the table, pinned to the viewport rather than to
               the table's bottom edge. The table is as tall as the page, so its
               own bar sits below the last row — reachable only by reading to the
               end of a result set first, which is no use when you want to see a
               column that is off to the right *now*. This proxies it: same
               width, always in reach, scroll position synced both ways. -->
          <div
            v-if="groups.length && overflows"
            ref="scrollbarEl"
            class="table-scrollbar"
            @scroll="syncFromBar"
          >
            <div class="table-scrollbar-span" :style="{ width: `${scrollWidth}px` }"></div>
          </div>

          <!-- Every row filtered away — a state of the rail, not of the search,
             so it says which and offers the way back. -->
          <p v-if="groups.length === 0" class="parts-hint">{{ t('parts.noResults') }}</p>

          <ResultsPager
            v-if="paged && groups.length"
            :page="page"
            :page-size="pageSize"
            :total="total"
            place="foot"
            :searching="searching"
            @update:page="changePage"
            @update:page-size="changePageSize"
          />

          <!-- Required attribution, on the surface showing the data. -->
          <p class="parts-attribution">
            {{
              t('parts.attribution', {
                names: configured.map((s) => providerName(s.provider)).join(', ')
              })
            }}
          </p>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.parts-loading {
  flex: 1;
}

/* The whole surface is one scroller: the title, the query row and the filter
   strip scroll away with the results rather than pinning a shrinking viewport
   above them. Both axes are set, never `overflow-y` alone — declaring one axis
   computes the other from `visible` to `auto`, which is what grew a stray
   horizontal scrollbar on the filter groups. */
.parts-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--vscode-bg-editor);
  color: var(--vscode-text);
  overflow-x: hidden;
  overflow-y: auto;
}

.parts-header {
  display: flex;
  align-items: center;
  padding: 16px 24px;
  border-bottom: 1px solid var(--vscode-border);
}

.parts-title {
  font-size: var(--text-heading);
  font-weight: 600;
  color: var(--vscode-text-light);
}

/* ------------------------------------------------------------------- empty */

.parts-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  max-width: 520px;
  padding: 32px;
}

.parts-empty :deep(svg) {
  width: 28px;
  height: 28px;
  opacity: 0.5;
}

.parts-empty-title {
  margin: 0;
  font-size: var(--text-heading);
  font-weight: 600;
  color: var(--vscode-text-light);
}

.parts-empty-body {
  margin: 0 0 6px;
  font-size: var(--text-body);
  line-height: 1.6;
  color: var(--vscode-text-muted);
}

/* ------------------------------------------------------------------- query */

.parts-query {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--vscode-border);
}

/* A segmented control: the options are few, fixed, and mutually exclusive, so
   they read better laid out than hidden behind a select. */
.mode-bar {
  display: flex;
  flex: none;
  border: 1px solid var(--vscode-border);
  border-radius: 4px;
  overflow: hidden;
}

.mode-btn {
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--vscode-text-muted);
  font-family: var(--font-family);
  font-size: var(--text-body-sm);
  font-weight: 600;
  cursor: pointer;
}

.mode-btn:hover:not(.active) {
  color: var(--vscode-text);
}

.mode-btn.active {
  background: var(--vscode-accent-subtle-strong);
  color: var(--vscode-accent);
}

.parts-input {
  flex: 1;
  min-width: 0;
  max-width: 560px;
}

/* ----------------------------------------------------------- results header */

/* ------------------------------------------------------------ browse crumbs */

.browse-crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 24px;
  border-bottom: 1px solid var(--vscode-border);
  font-size: var(--text-body-sm);
}

.crumb-path {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-text-muted);
}

.crumb-name {
  color: var(--vscode-text);
}

/* ---------------------------------------------------------------- progress */

/* Sits on the row's existing bottom border rather than adding a band: the
   indicator replaces a line that is already there, so nothing reflows. */
.query-progress {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  overflow: hidden;
}

/* Indeterminate: a distributor reports no progress, so the bar shows that work
   is happening rather than claiming to know how much is left. */
.progress-fill {
  width: 35%;
  height: 100%;
  border-radius: 2px;
  background: var(--vscode-accent);
  animation: parts-progress-slide 1.1s ease-in-out infinite;
}

@keyframes parts-progress-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(350%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .progress-fill {
    width: 100%;
    animation: none;
    opacity: 0.6;
  }
}

.parts-retry {
  margin: 0;
  padding: 0 24px 12px;
}

/* ----------------------------------------------------------------- results */

.parts-hint,
.parts-count,
.parts-failure,
.parts-attribution {
  margin: 0;
  padding: 12px 24px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
}

.parts-failure {
  color: var(--vscode-error);
}

.parts-attribution {
  border-top: 1px solid var(--vscode-border);
}

/* Grows to its full height and lets the page scroll, rather than taking the
   leftover space and scrolling inside it. `flex: none` so a long list is never
   compressed to fit a viewport it is meant to overflow. */
.parts-results {
  flex: none;
  min-width: 0;
}

/* The table's own scroller. A category can contribute a dozen parametric
   columns, so the row is wider than the pane by design and scrolls sideways —
   the same answer the filter strip reached for facet values too long to truncate. Both
   axes are declared: naming one computes the other from `visible` to `auto`,
   which would hand the table a second vertical scrollbar inside a page that
   already scrolls. */
.table-scroll {
  overflow-x: auto;
  overflow-y: hidden;
}

/* Its own bar is hidden, not absent — the element still scrolls, the sticky
   proxy below is just the handle you actually get to touch. Two bars for one
   axis would be the worse answer. */
.table-scroll {
  scrollbar-width: none;
}

.table-scroll::-webkit-scrollbar {
  height: 0;
}

/* Sticks to the bottom of the viewport for as long as the table is on screen,
   so a column off to the right is reachable without reading to the last row. */
.table-scrollbar {
  position: sticky;
  bottom: 0;
  z-index: 1;
  overflow-x: auto;
  overflow-y: hidden;
  background: var(--vscode-bg-editor);
  border-top: 1px solid var(--vscode-border);
}

.table-scrollbar-span {
  height: 1px;
}

.parts-table {
  border-collapse: collapse;
  width: max-content;
  min-width: 100%;
  font-size: var(--text-body-sm);
}

.parts-table th {
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-border);
  text-align: left;
  font-weight: 600;
  color: var(--vscode-text-muted);
  white-space: nowrap;
}

.parts-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-border);
  vertical-align: top;
}

.part-row:hover td {
  background: var(--vscode-overlay-control);
}

/* Text the user can take away with them. The app shell sets `user-select: none`
   globally, which is right for a desktop chrome and wrong for a catalog — an
   MPN you cannot copy is an MPN you retype into a purchase order. Scoped to the
   data itself, so dragging across the row still does not select its controls. */
.selectable {
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

/* -------------------------------------------------------------- sortable th */

/* Only where the distributor sorts — see partsColumns.ts. */
.col-sort {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.col-sort:hover:not(:disabled) {
  color: var(--vscode-text-light);
}

.col-sort.active {
  color: var(--vscode-accent);
}

.col-sort:disabled {
  cursor: not-allowed;
}

/* Holds the arrow's width so a heading does not shift when it appears. */
.sort-slot {
  display: inline-block;
  width: 12px;
}

/* ------------------------------------------------------------------ columns */

.col-caret {
  width: 28px;
  padding-left: 16px;
  padding-right: 0;
}

.caret-btn {
  display: flex;
  align-items: center;
  padding: 2px;
  border: none;
  background: none;
  color: var(--vscode-text-muted);
  cursor: pointer;
}

/* No vertical padding: the row's height is set by the three stacked identity
   lines, so the thumbnail may as well use all of it. Cropping is still
   forbidden — it grows within the box, it is never filled to it. */
.col-photo {
  width: 60px;
  padding-top: 0;
  padding-bottom: 0;
}

.part-photo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border: 1px solid var(--vscode-border);
  border-radius: 3px;
  background: var(--vscode-overlay-control);
  overflow: hidden;
}

/* `contain`, never `cover`: cropping a product image is prohibited. */
.part-photo img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

/* Three lines, one column. Identity is read down, not compared across, and the
   width it gives back is what a parametric table needs most.

   The cap belongs on the lines, not on the column. A fixed column width wraps a
   short description that had room to sit on one line; a `max-width` on the cell
   does the opposite, leaving dead space, because the table is `width:
   max-content` and sizes the column to the longest *unwrapped* text before the
   cell is capped. Constraining the blocks inside instead makes the column's own
   max-content contribution clamp to this — so it fits the description exactly
   until the description is longer than this, and only then wraps. */
/* The floor that stops the squeeze, and it has to live on a block inside the
   cell rather than on the cell. The filler column asks for 100% of the table,
   and auto table layout answers by shrinking whatever can shrink — this column,
   the only one whose text wraps. `min-width: max-content` is the right floor,
   but Chromium ignores an intrinsic-keyword min-width on a table cell: measured
   against real rows, the cell stayed at 151px while its text wanted 193px. On a
   block it is honoured, and the block's own max-content already respects the
   440px cap on the lines below — so the column asks for exactly the text width
   up to the cap, and no more. */
.part-stack {
  min-width: max-content;
}

.part-mpn,
.part-mfr,
.part-desc {
  display: block;
  max-width: 440px;
}

.part-mpn {
  font-weight: 600;
  color: var(--vscode-text-light);
}

.part-mfr,
.part-desc {
  color: var(--vscode-text-muted);
}

/* A part number can be one long unbroken token, which would otherwise push the
   column past the cap above rather than wrapping inside it. */
.part-mpn,
.part-desc {
  overflow-wrap: anywhere;
}

.col-stock,
.col-price {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.col-parametric {
  white-space: nowrap;
}

.parts-table th.is-parametric {
  color: var(--vscode-text-muted);
}

/* One line per distributor, never merged into a single figure. */
.cell-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 1px 0;
}

.col-stock .cell-line,
.col-price .cell-line {
  justify-content: flex-end;
}

/* The distributor's name *is* the button out to its product page — attribution
   and a working link are both required, so they are one control rather than a
   label beside one. The order code sits under it: it belongs to that
   distributor, and reading down keeps a two-seller row narrow. */
.col-seller .cell-line {
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding-bottom: 4px;
}

.seller-btn {
  white-space: nowrap;
}

.seller-pn {
  font-family: var(--font-mono, monospace);
  color: var(--vscode-text-muted);
  white-space: nowrap;
}

/* Absorbs the slack so the real columns hug left. Zero padding, no content —
   it exists only to be the column that stretches. */
.col-filler {
  width: 100%;
  padding: 0;
}

.detail-row td {
  padding: 0;
  background: var(--vscode-overlay-control);
}

/* ------------------------------------------------------------------ detail */

/* Indented past the caret and photo columns, so the detail reads as belonging to
   the row above rather than as a row of its own. */
.part-detail {
  padding: 12px 24px 14px 84px;
}

.part-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.part-section {
  margin: 12px 0 4px;
  font-size: var(--text-body-sm);
  font-weight: 600;
  color: var(--vscode-text-light);
}

.part-params {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 2px 20px;
  font-size: var(--text-body-sm);
}

.part-param {
  display: flex;
  gap: 10px;
  justify-content: space-between;
  padding: 2px 0;
  border-bottom: 1px solid var(--vscode-border);
}

.part-params dt {
  color: var(--vscode-text-muted);
}

.part-params dd {
  margin: 0;
  color: var(--vscode-text);
  text-align: right;
}
</style>
