<script setup lang="ts">
/**
 * The selection filter's home: a pill in the viewport's bottom-right corner,
 * with the switch panel in a popover above it (`ViewportPopover` owns that
 * shell and the reasoning for moving out of the right rail).
 *
 * Gold while the filter is NARROWED — a state report, which is what lets this
 * one control also replace the badge that used to appear elsewhere in the
 * viewport for exactly that purpose.
 *
 * The pointer glyph supplies what the short label drops: "Filter" alone does not
 * say filter of WHAT, and in a board editor that could as easily mean layers or
 * nets.
 *
 * A click the filter turns away (`noteFilterMiss`) flashes the pill while the
 * popover is shut, and the row that turned it away while the panel is showing.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ViewportPopover from './ViewportPopover.vue'
import SelectionFilterPanel from './SelectionFilterPanel.vue'
import {
  allKindsAllowed,
  filterMiss,
  useSelectionFilter,
  type SelectionFilterEditor
} from '../../lib/selectionFilter'

const { t } = useI18n()

const props = defineProps<{
  editor: SelectionFilterEditor
  /** Never pins into the right bar: a surface whose rail has no pinned panels (the visual diff). */
  pinless?: boolean
}>()

const { state } = useSelectionFilter(props.editor)

/**
 * Gold when a KIND is switched off — deliberately not when Locked alone is.
 *
 * Locked is a state, not a kind (the distinction the panel already draws by
 * keeping its row apart from the grid), and "a locked item does not take
 * clicks" is what a locked item is FOR. Lighting the pill for it would spend
 * the warning on the one narrowing nobody is surprised by, and leave the pill
 * gold on boards where that is simply how the user works.
 */
const narrowed = computed(() => !allKindsAllowed(props.editor, state.value))

const miss = filterMiss(props.editor)
</script>

<template>
  <ViewportPopover
    icon="cursor"
    :label="t('shared.selectionFilterPanel.button')"
    :title="t('shared.selectionFilterPanel.buttonTitle')"
    :panel-title="t('shared.selectionFilterPanel.title')"
    :active="narrowed"
    :editor="pinless ? undefined : props.editor"
    :panel="pinless ? undefined : 'filter'"
    steady
    :flash="miss?.seq ?? 0"
  >
    <SelectionFilterPanel :editor="props.editor" />
  </ViewportPopover>
</template>
