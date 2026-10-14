<script setup lang="ts">
/**
 * The filter bar — edits the **search**, not the rows on screen.
 *
 * A horizontal strip above the results rather than a column beside them: facet
 * values are things like `0.1 pF` and `Tape & Reel (TR)` and manufacturer names
 * of arbitrary length, and **a filter value that is cut off is useless** — you
 * cannot pick what you cannot read. A narrow rail forces ellipsis; a strip lets
 * each group be as wide as its widest value and scrolls sideways instead.
 *
 * Each group fills the strip's height and scrolls on its own, so one facet with
 * four hundred values cannot push the others off screen and the strip stays the
 * same height as facets come and go. That height is dragged by the grip along
 * the strip's bottom edge and held in the store, so a strip sized to your screen
 * survives a look at the board.
 *
 * Options and their counts come from the distributor in each response
 * (`PartsFacets`), so the rail offers exactly what this result set can be
 * narrowed by. That is why a client-side rail was replaced: it could only sieve
 * the twenty rows already fetched, and would report "none" for a manufacturer
 * whose parts simply had not come back.
 *
 * **Changes accumulate behind Apply.** Every filter is a re-query against a
 * ~1000-call day, so five checkboxes must cost one request rather than five.
 * The rail edits a draft; Apply commits it and re-runs the search.
 *
 * Capabilities vary and the rail shows only what a mode can honor: Universal
 * gets the two switches both APIs implement, Mouser the same two (its entire
 * filter surface), DigiKey those plus its own facets. Offering more would be a
 * filter that silently applies to one distributor and not the other.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  PartFacetValue,
  PartsFacets,
  PartsFilterState,
  PartsSearchMode
} from '../../../../preload/partsTypes'
import AppliedFilters from './AppliedFilters.vue'
import ResizeHandle from '../shared/ResizeHandle.vue'
import {
  filterCapabilities,
  filtersEqual,
  labelKey,
  matchFacetOptions,
  parameterScope,
  toggleParameter,
  toggleValue,
  type FilterLabels
} from '../../lib/partsFilter'

const props = defineProps<{
  /** The draft being edited. */
  pending: PartsFilterState
  /** What the visible results were actually fetched with. */
  applied: PartsFilterState
  facets: PartsFacets
  mode: PartsSearchMode
  searching: boolean
  /** Height of the scrolling strip, in px — dragged by the grip below it. */
  height: number
  /** Display text captured for every id ever ticked — see AppliedFilters. */
  labels: FilterLabels
  /** The keywords the visible results were fetched with. */
  query: string
  searchWithin: string
  /** The draft second keyword, committed by the same Apply as the filters. */
  pendingSearchWithin: string
}>()

const emit = defineEmits<{
  (e: 'update:pending', state: PartsFilterState): void
  (e: 'apply'): void
  (e: 'update:height', px: number): void
  (e: 'remember-label', key: string, label: string, group?: string): void
  /** A chip removal, which applies at once rather than editing the draft. */
  (e: 'apply-state', state: PartsFilterState): void
  (e: 'update:pendingSearchWithin', value: string): void
  (e: 'clear-query'): void
  (e: 'clear-within'): void
}>()

/** The height when the drag began; the handle reports a cumulative delta. */
let heightAtDragStart = props.height
const onResizeStart = (): void => {
  heightAtDragStart = props.height
}
const onResize = (grow: number): void => emit('update:height', heightAtDragStart + grow)

const { t, n } = useI18n()

const caps = computed(() => filterCapabilities(props.mode))
/** Apply commits the filters *and* the second keyword — they share a row and a
 *  button, so they must share a notion of "not applied yet". */
const dirty = computed(
  () =>
    !filtersEqual(props.pending, props.applied) ||
    props.pendingSearchWithin.trim() !== props.searchWithin.trim()
)

const patch = (change: Partial<PartsFilterState>): void =>
  emit('update:pending', { ...props.pending, ...change })

/**
 * Toggle a facet value, remembering its display text.
 *
 * The label has to be captured here because facets are recomputed per result
 * set: the group that offered this value may not exist in the next response,
 * and then a chip could only show a bare id.
 */
const toggleFacetValue = (
  dimension: 'manufacturerIds' | 'packagingIds' | 'statusIds' | 'seriesIds',
  option: PartFacetValue
): void => {
  emit('remember-label', labelKey(dimension, option.id), option.label)
  patch({ [dimension]: toggleValue(props.pending[dimension], option.id) })
}

const toggleParameterValue = (
  facet: { parameterId: number; name: string },
  option: PartFacetValue
): void => {
  emit(
    'remember-label',
    labelKey(parameterScope(facet.parameterId), option.id),
    option.label,
    facet.name
  )
  patch({ parameters: toggleParameter(props.pending.parameters, facet.parameterId, option.id) })
}

/**
 * Past this many options, scrolling stops being a way to *find* one — roughly
 * two screenfuls of the group's fixed height — so the group grows a local search
 * box. DigiKey's Capacitance facet alone runs to hundreds of values.
 */
const OPTION_SEARCH_THRESHOLD = 20

/** Per-group search text, keyed by group. Local to the options list: it narrows
 *  what is *offered*, never what is searched — Apply is still the only thing
 *  that touches the request. */
const optionSearch = ref<Record<string, string>>({})

const setSearch = (key: string, value: string): void => {
  optionSearch.value = { ...optionSearch.value, [key]: value }
}

/** The options a group shows, for its current search term. */
const visibleOptions = (
  key: string,
  options: PartFacetValue[],
  selected: readonly string[]
): PartFacetValue[] => matchFacetOptions(options, optionSearch.value[key] ?? '', selected)

/** No truncation: every group scrolls vertically within a fixed height, so even
 *  a facet with hundreds of values stays fully reachable without a "show all". */
const hasFacets = computed(
  () =>
    props.facets.manufacturers.length > 0 ||
    props.facets.packaging.length > 0 ||
    props.facets.parametric.length > 0
)
</script>

<template>
  <div class="filters">
    <!-- Apply leads, with what is currently applied beside it: the button and
         the chips are the same subject, and the strip below is what they act on. -->
    <div class="actions">
      <button class="btn-cta btn-sm" :disabled="!dirty || searching" @click="emit('apply')">
        {{ searching ? t('parts.searching') : t('parts.filters.apply') }}
      </button>
      <span v-if="dirty" class="actions-pending">{{ t('parts.filters.pending') }}</span>
      <span v-else-if="!caps.facets && !hasFacets" class="actions-note">
        {{ t('parts.filters.scopeNote') }}
      </span>

      <AppliedFilters
        :applied="applied"
        :query="query"
        :search-within="searchWithin"
        :labels="labels"
        :busy="searching"
        @apply="(next) => emit('apply-state', next)"
        @clear-query="emit('clear-query')"
        @clear-within="emit('clear-within')"
      />

      <!-- Narrows without replacing: appended to the query rather than sent as
           its own field, since both APIs take a single Keywords string. -->
      <input
        class="field-sm within-input"
        type="search"
        spellcheck="false"
        :placeholder="t('parts.filters.searchWithin')"
        :value="pendingSearchWithin"
        @input="emit('update:pendingSearchWithin', ($event.target as HTMLInputElement).value)"
        @keydown.enter="dirty && emit('apply')"
      />
    </div>

    <!-- Horizontally scrollable: a group is as wide as its widest value, never
         narrower, so nothing is ever cut off. -->
    <div class="strip-wrap" :style="{ height: `${height}px` }">
      <div class="strip">
        <section v-if="caps.basics" class="group">
          <p class="group-heading">{{ t('parts.filters.availability') }}</p>
          <div class="group-body">
            <label class="option">
              <input
                type="checkbox"
                :checked="pending.inStock"
                @change="patch({ inStock: !pending.inStock })"
              />
              <span class="option-label">{{ t('parts.filters.inStock') }}</span>
            </label>
            <label class="option">
              <input
                type="checkbox"
                :checked="pending.rohs"
                @change="patch({ rohs: !pending.rohs })"
              />
              <span class="option-label">{{ t('parts.filters.rohs') }}</span>
            </label>
            <template v-if="caps.digikeyOptions">
              <label class="option">
                <input
                  type="checkbox"
                  :checked="pending.hasDatasheet"
                  @change="patch({ hasDatasheet: !pending.hasDatasheet })"
                />
                <span class="option-label">{{ t('parts.filters.hasDatasheet') }}</span>
              </label>
              <label class="option">
                <input
                  type="checkbox"
                  :checked="pending.has3dModel"
                  @change="patch({ has3dModel: !pending.has3dModel })"
                />
                <span class="option-label">{{ t('parts.filters.has3dModel') }}</span>
              </label>
            </template>
          </div>
        </section>

        <template v-if="caps.facets">
          <section v-if="facets.manufacturers.length" class="group">
            <p class="group-heading">{{ t('parts.filters.manufacturer') }}</p>
            <input
              v-if="facets.manufacturers.length > OPTION_SEARCH_THRESHOLD"
              class="field-sm group-search"
              type="search"
              spellcheck="false"
              :placeholder="t('parts.filters.findOption')"
              :value="optionSearch['mfr'] ?? ''"
              @input="setSearch('mfr', ($event.target as HTMLInputElement).value)"
            />
            <div class="group-body">
              <p
                v-if="!visibleOptions('mfr', facets.manufacturers, pending.manufacturerIds).length"
                class="group-empty"
              >
                {{ t('parts.filters.noOptions') }}
              </p>
              <label
                v-for="option in visibleOptions(
                  'mfr',
                  facets.manufacturers,
                  pending.manufacturerIds
                )"
                :key="option.id"
                class="option"
              >
                <input
                  type="checkbox"
                  :checked="pending.manufacturerIds.includes(option.id)"
                  @change="
                    patch({ manufacturerIds: toggleValue(pending.manufacturerIds, option.id) })
                  "
                />
                <span class="option-label">{{ option.label }}</span>
                <span class="option-count">{{ n(option.productCount) }}</span>
              </label>
            </div>
          </section>

          <section v-if="facets.packaging.length" class="group">
            <p class="group-heading">{{ t('parts.filters.packaging') }}</p>
            <input
              v-if="facets.packaging.length > OPTION_SEARCH_THRESHOLD"
              class="field-sm group-search"
              type="search"
              spellcheck="false"
              :placeholder="t('parts.filters.findOption')"
              :value="optionSearch['pkg'] ?? ''"
              @input="setSearch('pkg', ($event.target as HTMLInputElement).value)"
            />
            <div class="group-body">
              <p
                v-if="!visibleOptions('pkg', facets.packaging, pending.packagingIds).length"
                class="group-empty"
              >
                {{ t('parts.filters.noOptions') }}
              </p>
              <label
                v-for="option in visibleOptions('pkg', facets.packaging, pending.packagingIds)"
                :key="option.id"
                class="option"
              >
                <input
                  type="checkbox"
                  :checked="pending.packagingIds.includes(option.id)"
                  @change="toggleFacetValue('packagingIds', option)"
                />
                <span class="option-label">{{ option.label }}</span>
                <span class="option-count">{{ n(option.productCount) }}</span>
              </label>
            </div>
          </section>

          <section v-if="facets.status.length > 1" class="group">
            <p class="group-heading">{{ t('parts.filters.status') }}</p>
            <div class="group-body">
              <label v-for="option in facets.status" :key="option.id" class="option">
                <input
                  type="checkbox"
                  :checked="pending.statusIds.includes(option.id)"
                  @change="toggleFacetValue('statusIds', option)"
                />
                <span class="option-label">{{ option.label }}</span>
                <span class="option-count">{{ n(option.productCount) }}</span>
              </label>
            </div>
          </section>

          <section v-if="facets.series.length" class="group">
            <p class="group-heading">{{ t('parts.filters.series') }}</p>
            <input
              v-if="facets.series.length > OPTION_SEARCH_THRESHOLD"
              class="field-sm group-search"
              type="search"
              spellcheck="false"
              :placeholder="t('parts.filters.findOption')"
              :value="optionSearch['series'] ?? ''"
              @input="setSearch('series', ($event.target as HTMLInputElement).value)"
            />
            <div class="group-body">
              <p
                v-if="!visibleOptions('series', facets.series, pending.seriesIds).length"
                class="group-empty"
              >
                {{ t('parts.filters.noOptions') }}
              </p>
              <label
                v-for="option in visibleOptions('series', facets.series, pending.seriesIds)"
                :key="option.id"
                class="option"
              >
                <input
                  type="checkbox"
                  :checked="pending.seriesIds.includes(option.id)"
                  @change="toggleFacetValue('seriesIds', option)"
                />
                <span class="option-label">{{ option.label }}</span>
                <span class="option-count">{{ n(option.productCount) }}</span>
              </label>
            </div>
          </section>

          <!-- Parametric facets only exist once a search is category-scoped —
             DigiKey returns none for a bare keyword search. So these
             appearing *is* the signal that you are inside a category. -->
          <section v-for="facet in facets.parametric" :key="facet.parameterId" class="group">
            <p class="group-heading">{{ facet.name }}</p>
            <input
              v-if="facet.values.length > OPTION_SEARCH_THRESHOLD"
              class="field-sm group-search"
              type="search"
              spellcheck="false"
              :placeholder="t('parts.filters.findOption')"
              :value="optionSearch[`p${facet.parameterId}`] ?? ''"
              @input="setSearch(`p${facet.parameterId}`, ($event.target as HTMLInputElement).value)"
            />
            <div class="group-body">
              <p
                v-if="
                  !visibleOptions(
                    `p${facet.parameterId}`,
                    facet.values,
                    pending.parameters[facet.parameterId] ?? []
                  ).length
                "
                class="group-empty"
              >
                {{ t('parts.filters.noOptions') }}
              </p>
              <label
                v-for="option in visibleOptions(
                  `p${facet.parameterId}`,
                  facet.values,
                  pending.parameters[facet.parameterId] ?? []
                )"
                :key="option.id"
                class="option"
              >
                <input
                  type="checkbox"
                  :checked="(pending.parameters[facet.parameterId] ?? []).includes(option.id)"
                  @change="toggleParameterValue(facet, option)"
                />
                <span class="option-label">{{ option.label }}</span>
                <span class="option-count">{{ n(option.productCount) }}</span>
              </label>
            </div>
          </section>
        </template>
      </div>

      <!-- Anchored to the strip wrapper, not to the whole bar: on `.filters` it
           would sit below the Apply row and appear to resize the results. -->
      <ResizeHandle edge="bottom" @resize-start="onResizeStart" @resize="onResize" />
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-direction: column;
  flex: none;
  border-bottom: 1px solid var(--vscode-border);
}

/* Positioned so the drag grip anchors to the strip's own bottom edge. */
.strip-wrap {
  position: relative;
  flex: none;
  min-height: 0;
}

/* The strip scrolls sideways; groups never shrink, so no value is ever cut. */
.strip {
  display: flex;
  align-items: stretch;
  height: 100%;
  gap: 0;
  /* Only the strip scrolls sideways; groups are sized to their content. */
  overflow-x: auto;
  overflow-y: hidden;
}

.group {
  display: flex;
  flex-direction: column;
  flex: none;
  /* Fills the strip, whose height the grip below sets: uniform, so the strip is
     stable as facets come and go and one facet with hundreds of values cannot
     push the rest off screen. */
  height: 100%;
  /* Sized to its widest option, which is what keeps the horizontal scroll on
     the strip alone: a group that fits its content has nothing to scroll. */
  width: max-content;
  min-width: 150px;
  padding: 8px 12px;
  border-right: 1px solid var(--vscode-border);
}

.group-heading {
  margin: 0 0 5px;
  font-size: var(--text-caption);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-text-muted);
  white-space: nowrap;
}

.group-search {
  width: 100%;
  min-width: 0;
  margin-bottom: 5px;
}

.group-empty {
  margin: 2px 0;
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
  white-space: nowrap;
}

/* Each group scrolls vertically on its own — and only vertically. `overflow-y`
   alone would compute `overflow-x` to `auto` (a non-visible value on one axis
   forces the other), giving every group its own horizontal scrollbar; the
   `hidden` is what keeps sideways scrolling on the strip. It clips nothing,
   because the group is sized to its content above, and the padding reserves
   room for the vertical scrollbar so the widest option never lands under it. */
.group-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 12px;
}

.option {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 0;
  font-size: var(--text-body-sm);
  /* The whole point of the horizontal layout: a value is never truncated, so
     the group takes the width its widest option needs. */
  white-space: nowrap;
  cursor: pointer;
}

.option input {
  flex: none;
  margin: 0;
  accent-color: var(--vscode-accent);
}

.option-label {
  color: var(--vscode-text);
}

/* Pushed right, so counts line up down a group without constraining its width. */
.option-count {
  margin-left: auto;
  padding-left: 14px;
  color: var(--vscode-text-muted);
  font-variant-numeric: tabular-nums;
}

.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-border);
}

.actions-pending {
  font-size: var(--text-caption);
  color: var(--vscode-accent);
}

.actions-note {
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
}

/* Floated right, away from Apply and the chips: it is a different verb. */
.within-input {
  margin-left: auto;
  width: 190px;
}
</style>
