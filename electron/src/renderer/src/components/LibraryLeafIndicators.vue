<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ComponentTypeIcon from './shared/ComponentTypeIcon.vue'
import {
  symbolHasFootprint,
  symbolHasModel,
  footprintHasSymbol,
  footprintHasModel,
  modelHasSymbol,
  modelHasFootprint,
  type IndexRecord
} from '../lib/libraryIndex'

/**
 * The three availability columns at the right of a Libraries row — symbol,
 * footprint, model, in fixed order so they align down the list. The row's own
 * type is always filled and carries its color; the other two show a neutral
 * mark when the association exists and reserve blank space when it doesn't. So a
 * "full" component (all three filled) reads at a glance, and each section's own
 * column is the only colored one. All edges are O(1) off the index reverse maps.
 */
const props = defineProps<{
  record: IndexRecord
  /** Leave out the row's own column, where the list is all one kind (the library chooser). */
  hideOwn?: boolean
  /**
   * Paint every present mark in its kind's color. With the own column hidden
   * there is nothing for neutral marks to stand back from, and the color is
   * what tells a footprint from a model at a glance.
   */
  colored?: boolean
}>()
const { t } = useI18n()

type Kind = 'symbol' | 'footprint' | 'model'
interface Column {
  type: Kind
  present: boolean
  own: boolean
}

const columns = computed<Column[]>(() => {
  const r = props.record
  const present: Record<Kind, boolean> = {
    symbol:
      r.type === 'symbol'
        ? true
        : r.type === 'footprint'
          ? footprintHasSymbol(r.id)
          : modelHasSymbol(r.file),
    footprint:
      r.type === 'footprint'
        ? true
        : r.type === 'symbol'
          ? symbolHasFootprint(r.id)
          : modelHasFootprint(r.file),
    model:
      r.type === 'model'
        ? true
        : r.type === 'symbol'
          ? symbolHasModel(r.id)
          : footprintHasModel(r.id)
  }
  return (['symbol', 'footprint', 'model'] as const)
    .filter((type) => !(props.hideOwn && type === r.type))
    .map((type) => ({
      type,
      present: present[type],
      own: type === r.type
    }))
})

// Only the association columns get a tooltip; the own-type column is self-evident.
const tip = (c: Column): string | undefined => {
  if (!c.present || c.own) return undefined
  if (c.type === 'symbol') return t('libraryBrowser.nav.hasSymbol')
  if (c.type === 'footprint') return t('libraryBrowser.nav.hasFootprint')
  return t('libraryBrowser.nav.has3dModel')
}
</script>

<template>
  <span class="leaf-indicators">
    <span
      v-for="c in columns"
      :key="c.type"
      class="ind-slot"
      :class="[c.type, { own: c.own || colored, present: c.present }]"
      :title="tip(c)"
    >
      <ComponentTypeIcon v-if="c.present" :type="c.type" />
    </span>
  </span>
</template>

<style scoped>
.leaf-indicators {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* Fixed-width whether filled or empty, so the columns line up down the list. */
.ind-slot {
  width: 12px;
  height: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* Association marks stay neutral; only the row's own-type column is colored. */
.ind-slot.present {
  color: var(--vscode-kind-present);
}
.ind-slot.own.symbol {
  color: var(--vscode-kind-symbol);
}
.ind-slot.own.footprint {
  color: var(--vscode-kind-footprint);
}
.ind-slot.own.model {
  color: var(--vscode-kind-model);
}
</style>
