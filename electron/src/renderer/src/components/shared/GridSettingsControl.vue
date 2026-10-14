<script setup lang="ts">
/**
 * The grid's home: a pill in the viewport's bottom-right corner showing the
 * live spacing, with the settings panel in a popover above it.
 *
 * The label doubles as the readout's unit marker, which is why the coordinate
 * pills carry no unit of their own — `1.27` is meaningless without knowing
 * whether it is millimeters, and stating it twice in one corner is noise. It
 * also puts the number that governs the coordinates beside them.
 *
 * Deliberately NOT gold when snap is on: the accent means "this setting is
 * doing something you might not expect", and snap is the ordinary state. It
 * lights when snap is OFF, which is the surprising one — an unsnapped drag is
 * exactly the thing people spend a while not noticing.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ViewportPopover from './ViewportPopover.vue'
import GridSettingsPanel from './GridSettingsPanel.vue'
import type { GridSettings } from '../../lib/engine/ViewportEngine'
import type { PanelLayoutEditor } from '../../lib/panelLayout'

const { t } = useI18n()

const props = defineProps<{ gridSettings: GridSettings; editor: PanelLayoutEditor }>()

const emit = defineEmits<{ (e: 'update-grid', settings: Partial<GridSettings>): void }>()

/**
 * `1.27 mm` while snapping, bare `mm` when not.
 *
 * With snap off the spacing governs nothing the readout shows, so quoting it
 * would describe a grid the cursor is ignoring — but the UNIT still qualifies
 * the coordinates beside it, and this pill is the only place that says it.
 *
 * `parseFloat(toFixed(4))` trims the float tail a unit conversion leaves
 * (1.2700000000000002) without padding whole numbers with zeroes — the rule the
 * settings panel's own dropdown already uses.
 */
const label = computed(() => {
  const { spacing, unit, snap } = props.gridSettings
  if (!snap) {
    if (unit === 'mil') return t('shared.viewportStatus.unitMil')
    return unit === 'in' ? t('shared.viewportStatus.unitIn') : t('shared.viewportStatus.unitMm')
  }
  const value = parseFloat(spacing.toFixed(4))
  if (unit === 'mil') return t('shared.viewportStatus.gridMil', { value })
  return unit === 'in'
    ? t('shared.viewportStatus.gridIn', { value })
    : t('shared.viewportStatus.gridMm', { value })
})
</script>

<template>
  <ViewportPopover
    icon="grid"
    :label="label"
    :title="t('shared.gridSettingsPanel.buttonTitle')"
    :panel-title="t('shared.gridSettingsPanel.title')"
    :active="!props.gridSettings.snap"
    :editor="props.editor"
    panel="grid"
  >
    <GridSettingsPanel
      hide-header
      :grid-settings="props.gridSettings"
      @update-grid="(g) => emit('update-grid', g)"
    />
  </ViewportPopover>
</template>
