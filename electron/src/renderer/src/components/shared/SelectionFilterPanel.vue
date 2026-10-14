<script setup lang="ts">
/**
 * Which kinds of item a click or a rubber-band sweep may land on, in this
 * editor. One checkbox per kind, plus an "All items" master row and — where the
 * format has the flag — Locked.
 *
 * Laid out as a bespoke two-column grid rather than through the shared
 * `PropertyTable`. That table is built for label/value rows of mixed editor
 * kinds and gives each its own full-width row; here every row is the same
 * control and the label IS the content, so a second column halves the height at
 * no cost to legibility. This panel shares a right bar with Properties, Layers
 * and Grid, and is the one most often wanted at a glance rather than read.
 *
 * Unlike its sibling panels this one reads and writes the shared store directly
 * rather than emitting up. The filter is app-global state with no owning editor
 * — every host would forward an event to the same setter — so the round trip
 * would add plumbing at four mount sites and no control.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  allKindsAllowed,
  filterMiss,
  LOCKED_TARGET,
  filterableKinds,
  selectionFilterState,
  setAllKindsAllowed,
  setKindAllowed,
  setLockedAllowed,
  supportsLocked,
  type SelectionFilterEditor
} from '../../lib/selectionFilter'

const { t } = useI18n()

const props = defineProps<{ editor: SelectionFilterEditor }>()

const state = selectionFilterState(props.editor)
const kinds = computed(() => filterableKinds(props.editor))

const isKindAllowed = (kind: string): boolean => !state.value.excludedKinds.includes(kind)

const allChecked = computed(() => allKindsAllowed(props.editor, state.value))
/** Neither all nor none: the master row shows a dash rather than a lie. */
const someChecked = computed(
  () => !allChecked.value && kinds.value.some((kind) => isKindAllowed(kind))
)

const checked = (event: Event): boolean => (event.target as HTMLInputElement).checked

/** The row that just turned a click away, lit for a moment (`noteFilterMiss`). */
const FLASH_MS = 900
const flashed = ref<string | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | null = null
const miss = filterMiss(props.editor)
watch(
  () => miss.value?.seq,
  () => {
    if (!miss.value) return
    const target = miss.value.target
    flashed.value = null
    if (flashTimer) clearTimeout(flashTimer)
    // A frame between, so a repeat on the same row restarts its animation.
    requestAnimationFrame(() => {
      flashed.value = target
      flashTimer = setTimeout(() => (flashed.value = null), FLASH_MS)
    })
  }
)
onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer)
})
</script>

<template>
  <div class="selection-filter-panel">
    <!-- The two switches that are not kinds, sharing the grid's columns. -->
    <div class="filter-grid filter-header">
      <label class="filter-row">
        <input
          type="checkbox"
          :checked="allChecked"
          :indeterminate="someChecked"
          @change="setAllKindsAllowed(props.editor, checked($event))"
        />
        <span>{{ t('shared.selectionFilterPanel.allItems') }}</span>
      </label>

      <label
        v-if="supportsLocked(props.editor)"
        class="filter-row"
        :class="{ flashed: flashed === LOCKED_TARGET }"
      >
        <input
          type="checkbox"
          :checked="state.allowLocked"
          @change="setLockedAllowed(props.editor, checked($event))"
        />
        <span>{{ t('shared.selectionFilterPanel.locked') }}</span>
      </label>
    </div>

    <div class="filter-grid">
      <label
        v-for="kind in kinds"
        :key="kind"
        class="filter-row"
        :class="{ flashed: flashed === kind }"
      >
        <input
          type="checkbox"
          :checked="isKindAllowed(kind)"
          @change="setKindAllowed(props.editor, kind, checked($event))"
        />
        <span>{{ t(`shared.selectionFilterPanel.kinds.${kind}`) }}</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.selection-filter-panel {
  padding: 6px 10px 8px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text, #c5d3cd);
}

/* Two columns is the whole point of the bespoke layout: the kind list is what
   makes this panel tall, and the labels are short enough to pair up. Fills
   row-wise, so an odd count leaves the gap at the end rather than mid-list. */
.filter-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 10px;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  /* DESIGN.md's 24px target floor: the whole row toggles. */
  min-height: 24px;
  cursor: pointer;
  /* The label wraps the input, so clicking the text toggles it — the whole row
     is one hit target without any JS. */
  user-select: none;
}

.filter-row:hover {
  color: var(--vscode-accent, #cca250);
}

.filter-row.flashed {
  /* Net zero, so the lit row grows no wider than its neighbors' layout. */
  margin: 0 -4px;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--vscode-accent, #cca250) 28%, transparent);
  color: var(--vscode-text);
}

@media (prefers-reduced-motion: no-preference) {
  .filter-row.flashed {
    animation: filter-row-flash 0.9s ease-out forwards;
  }
}

@keyframes filter-row-flash {
  0%,
  45% {
    background: color-mix(in srgb, var(--vscode-accent, #cca250) 35%, transparent);
  }
  100% {
    background: transparent;
  }
}

.filter-row input {
  flex: none;
  margin: 0;
  accent-color: var(--vscode-accent, #cca250);
}

.filter-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Neither of these is a kind — one governs every kind below, the other is a
   state an item carries — so a rule separates them from the list rather than a
   heading, and they are muted to keep the list itself the thing being read.
   Sharing `.filter-grid` puts Locked in the second column, aligned with the
   kinds under it, so the pair costs one row instead of two. */
.filter-header {
  margin-bottom: 5px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--vscode-border, #24302b);
  color: var(--vscode-text-muted, #748780);
}
</style>
