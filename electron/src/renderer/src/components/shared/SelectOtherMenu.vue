<script setup lang="ts" generic="T">
/**
 * Select Other: everything under the pointer, as a list to pick from — KiCad's
 * Clarify Selection, opened by holding a press on an item or from the canvas
 * menu. The row under the pointer (or the arrow keys) is
 * selected while it is there, so the canvas shows which item each row is;
 * 1–9 pick a row, A takes them all, and closing without a pick puts the
 * selection back as it was.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MenuNode } from '../../lib/menu'
import ContextMenu from './ContextMenu.vue'

const props = defineProps<{
  /** What is under the pointer, best first, as the editor would select each. */
  items: T[]
  /** How a row names its item. */
  label: (item: T) => string
  x: number
  y: number
}>()

const emit = defineEmits<{
  /** Show these as the selection while the row is focused; null restores. */
  (e: 'preview', items: T[] | null): void
  (e: 'commit', items: T[]): void
  /** Closed without a pick: the selection goes back as it was. */
  (e: 'cancel'): void
}>()

const { t } = useI18n()

const ALL = 'all'

const nodes = computed<MenuNode[]>(() => [
  { header: t('shared.selectOther.title') },
  ...props.items.map((item, index) => ({
    id: String(index),
    label: props.label(item),
    key: index < 9 ? String(index + 1) : undefined
  })),
  { divider: true },
  { id: ALL, label: t('shared.selectOther.all'), key: 'a' }
])

const picked = (id: string): T[] => {
  if (id === ALL) return [...props.items]
  const item = props.items[Number(id)]
  return item === undefined ? [] : [item]
}

let committed = false

const onSelect = (id: string): void => {
  committed = true
  emit('commit', picked(id))
}

const onClose = (): void => {
  if (!committed) emit('cancel')
}
</script>

<template>
  <ContextMenu
    :items="nodes"
    :x="x"
    :y="y"
    @focus="(id) => emit('preview', id === null ? null : picked(id))"
    @select="onSelect"
    @close="onClose"
  />
</template>
