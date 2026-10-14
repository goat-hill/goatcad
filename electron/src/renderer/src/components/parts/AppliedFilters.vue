<script setup lang="ts">
/**
 * Applied filters, as removable chips.
 *
 * Not a convenience: facets are computed against the current result set, so
 * narrowing by a manufacturer can leave a response whose Manufacturer facet
 * holds only that one value — or drops out entirely. The checkbox that set a
 * filter is not guaranteed to still exist, which makes these chips the only
 * reliable way to take one back off.
 *
 * They report what is **applied** — what the results on screen were actually
 * fetched with — not the draft. A chip appearing the instant a box is ticked
 * would claim a narrowing that has not happened yet.
 *
 * Removing one therefore takes effect immediately: editing only the draft would
 * leave the chip in place with nothing visibly changed. That makes this the one
 * filter interaction that spends a request by itself, which is right — removing
 * a filter you can see is a decision, not an exploration.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import type { PartsFilterState } from '../../../../preload/partsTypes'
import {
  describeAppliedFilters,
  emptyFilterState,
  removeAppliedFilter,
  type AppliedChip,
  type FilterLabels
} from '../../lib/partsFilter'

const props = defineProps<{
  /** The filters the visible results were fetched with. */
  applied: PartsFilterState
  /** The keywords those results were fetched with — narrowing too, and shown
   *  alongside the facets so the whole scope reads in one place. */
  query: string
  searchWithin: string
  labels: FilterLabels
  busy: boolean
}>()

const emit = defineEmits<{
  /** The filter state to apply, since removal takes effect at once. */
  (e: 'apply', state: PartsFilterState): void
  (e: 'clear-query'): void
  (e: 'clear-within'): void
}>()

const { t } = useI18n()

const chips = computed(() => describeAppliedFilters(props.applied, props.labels))

/** Anything at all narrowing the results — keywords included. */
const anyApplied = computed(
  () => chips.value.length > 0 || props.query.length > 0 || props.searchWithin.length > 0
)

/** A parameter value reads as "Capacitance: 0.1 µF" — the value alone rarely
 *  says what was narrowed. */
const chipText = (chip: AppliedChip): string => {
  if (chip.kind === 'flag') return t(`parts.filters.${chip.flag}`)
  if (chip.kind === 'parameter' && chip.group) return `${chip.group}: ${chip.label}`
  return chip.label
}

const remove = (chip: AppliedChip): void => emit('apply', removeAppliedFilter(props.applied, chip))
</script>

<template>
  <div v-if="anyApplied" class="applied">
    <!-- The query is narrowing too, so it belongs here rather than only in the
         box that produced it. -->
    <button
      v-if="query"
      class="chip is-query"
      :disabled="busy"
      :title="t('parts.filters.removeFilter')"
      @click="emit('clear-query')"
    >
      <span class="chip-text">{{ query }}</span>
      <Icon name="close-sm" class="chip-x" aria-hidden="true" />
    </button>
    <button
      v-if="searchWithin"
      class="chip is-query"
      :disabled="busy"
      :title="t('parts.filters.removeFilter')"
      @click="emit('clear-within')"
    >
      <span class="chip-text">{{ searchWithin }}</span>
      <Icon name="close-sm" class="chip-x" aria-hidden="true" />
    </button>
    <button
      v-for="chip in chips"
      :key="chip.key"
      class="chip"
      :disabled="busy"
      :title="t('parts.filters.removeFilter')"
      @click="remove(chip)"
    >
      <span class="chip-text">{{ chipText(chip) }}</span>
      <Icon name="close-sm" class="chip-x" aria-hidden="true" />
    </button>
    <button
      v-if="chips.length"
      class="btn-subtle btn-sm"
      :disabled="busy"
      @click="emit('apply', emptyFilterState())"
    >
      {{ t('parts.filters.clearAll') }}
    </button>
  </div>
</template>

<style scoped>
.applied {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 11px;
  border: 1px solid var(--vscode-border);
  border-radius: 999px;
  background: var(--vscode-accent-subtle-strong);
  color: var(--vscode-accent);
  font-family: var(--font-family);
  /* A chip is a control you click to undo something, not a label on top of
     something else — it sizes with the buttons beside it, not at the caption
     floor (DESIGN.md: size to the space, not to the floor). */
  font-size: var(--text-body-sm);
  font-weight: 600;
  cursor: pointer;
}

.chip:hover:not(:disabled) {
  border-color: var(--vscode-accent);
}

.chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chip-text {
  white-space: nowrap;
}

/* Keywords read as a different kind of narrowing from a facet value, so they
   are toned apart rather than mixed into the same run of copper chips. */
.chip.is-query {
  background: var(--vscode-overlay-control);
  color: var(--vscode-text);
}

.chip.is-query:hover:not(:disabled) {
  border-color: var(--vscode-text-muted);
}

.chip-x {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  opacity: 0.7;
}

.chip:hover .chip-x {
  opacity: 1;
}
</style>
