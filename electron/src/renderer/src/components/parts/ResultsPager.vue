<script setup lang="ts">
/**
 * "Showing 1–20 of 892,356", and the controls to move.
 *
 * Rendered twice, identically — above the list and below it — because a result
 * set worth paging is longer than a screen, and having to scroll to the end to
 * reach the controls is the thing pagination exists to avoid. `place` decides
 * only which edge gets the rule, never which controls are offered: a count with
 * no way to act on it is a readout, not a pager.
 *
 * Distributor modes only. Universal merges two catalogs into one row set, so an
 * offset means nothing to either API and the pager is simply not shown.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PAGE_GAP, PAGE_SIZES, pageCount, pageRange, pageWindow } from '../../lib/partsPaging'

const props = defineProps<{
  /** 0-based. */
  page: number
  pageSize: number
  total: number
  /** Which copy this is — the head sits under the filter strip, which already
   *  draws the rule above it, so only the foot carries its own. */
  place: 'head' | 'foot'
  searching: boolean
}>()

const emit = defineEmits<{
  (e: 'update:page', page: number): void
  (e: 'update:pageSize', size: number): void
}>()

const { t, n } = useI18n()

const pages = computed(() => pageCount(props.total, props.pageSize))
const range = computed(() => pageRange(props.page, props.pageSize, props.total))
const slots = computed(() => pageWindow(props.page, pages.value))

const label = computed(() =>
  range.value.to === 0
    ? t('parts.paging.none')
    : t('parts.paging.showing', {
        from: n(range.value.from),
        to: n(range.value.to),
        total: n(props.total)
      })
)
</script>

<template>
  <div class="pager" :class="place">
    <span class="pager-label">{{ label }}</span>

    <template v-if="pages > 1">
      <div class="pager-pages">
        <button
          class="btn-subtle btn-sm"
          :disabled="page === 0 || searching"
          @click="emit('update:page', page - 1)"
        >
          {{ t('parts.paging.previous') }}
        </button>

        <template v-for="(slot, index) in slots" :key="`${slot}-${index}`">
          <span v-if="slot === PAGE_GAP" class="pager-gap">…</span>
          <button
            v-else
            class="pager-page"
            :class="{ current: slot === page }"
            :disabled="searching"
            @click="emit('update:page', slot)"
          >
            {{ n(slot + 1) }}
          </button>
        </template>

        <button
          class="btn-subtle btn-sm"
          :disabled="page >= pages - 1 || searching"
          @click="emit('update:page', page + 1)"
        >
          {{ t('parts.paging.next') }}
        </button>
      </div>
    </template>

    <label class="pager-size">
      {{ t('parts.paging.perPage') }}
      <select
        class="field-sm"
        :value="pageSize"
        :disabled="searching"
        @change="emit('update:pageSize', Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  padding: 10px 24px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
}

/* Only the foot draws its own rule. Above the list, the filter strip's bottom
   border already separates the pager from what precedes it. */
.pager.foot {
  border-top: 1px solid var(--vscode-border);
}

.pager-label {
  font-variant-numeric: tabular-nums;
}

.pager-pages {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.pager-page {
  min-width: 26px;
  padding: 3px 6px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: none;
  color: var(--vscode-text);
  font-family: var(--font-family);
  font-size: var(--text-body-sm);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.pager-page:hover:not(:disabled):not(.current) {
  border-color: var(--vscode-border);
}

.pager-page.current {
  background: var(--vscode-accent-subtle-strong);
  color: var(--vscode-accent);
  font-weight: 600;
}

.pager-page:disabled {
  cursor: not-allowed;
}

.pager-gap {
  padding: 0 2px;
  color: var(--vscode-text-muted);
}

.pager-size {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
</style>
