<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { GridSettings } from '../../lib/engine/ViewportEngine'
import PropertyTable from './PropertyTable.vue'
import { gridSpacingsFor } from '../../lib/gridPreferences'
import { formatNanometersToUnit, mmToNm, spacingToMm } from '../../lib/kicad/coordinates'
import type { PropertyEditValue, PropertyGroup } from '../../lib/propertyTable'

const { t } = useI18n()

const props = defineProps<{
  gridSettings: GridSettings
  /** Suppress the built-in title (when hosted in a CollapsiblePanel that titles it). */
  hideHeader?: boolean
}>()

const emit = defineEmits<{
  (e: 'update-grid', settings: Partial<GridSettings>): void
}>()

// The options always include the *current* spacing, so the dropdown can never
// render blank when a value (e.g. a 50 mil / 1.27 mm grid) isn't in the presets.
const spacings = computed<number[]>(() => gridSpacingsFor(props.gridSettings))
const formatSpacing = (s: number): string =>
  `${formatNanometersToUnit(mmToNm(spacingToMm(s, props.gridSettings.unit)), props.gridSettings.unit)} ${props.gridSettings.unit}`

// Render through the shared PropertyTable so grid settings match the symbol /
// schematic / PCB property panels. One group, four fields; the owning
// CollapsiblePanel already titles it, so the group header is suppressed.
const groups = computed<PropertyGroup[]>(() => [
  {
    type: 'grid',
    title: t('shared.gridSettingsPanel.title'),
    count: 1,
    fields: [
      {
        key: 'unit',
        label: t('shared.gridSettingsPanel.unit'),
        editor: {
          kind: 'segmented',
          options: [
            { value: 'mm', label: 'MM' },
            { value: 'mil', label: 'MIL' },
            { value: 'in', label: 'IN' }
          ]
        },
        value: props.gridSettings.unit
      },
      {
        key: 'spacing',
        label: t('shared.gridSettingsPanel.spacing'),
        editor: {
          kind: 'select',
          options: spacings.value.map((s) => ({ value: String(s), label: formatSpacing(s) }))
        },
        value: props.gridSettings.spacing
      },
      {
        key: 'visible',
        label: t('shared.gridSettingsPanel.showGrid'),
        editor: { kind: 'checkbox' },
        value: props.gridSettings.visible
      },
      {
        key: 'snap',
        label: t('shared.gridSettingsPanel.snap'),
        editor: { kind: 'checkbox' },
        value: props.gridSettings.snap
      }
    ]
  }
])

// Translate the table's generic edit event back into a GridSettings partial.
// The unit/spacing selects hand back strings; checkboxes hand back booleans.
const onEdit = (_groupType: string, key: string, value: PropertyEditValue): void => {
  if (key === 'unit') emit('update-grid', { unit: value as GridSettings['unit'] })
  else if (key === 'spacing') emit('update-grid', { spacing: Number(value) })
  else if (key === 'visible') emit('update-grid', { visible: Boolean(value) })
  else if (key === 'snap') emit('update-grid', { snap: Boolean(value) })
}
</script>

<template>
  <div class="grid-settings-panel">
    <h3 v-if="!hideHeader" class="grid-settings-title">
      {{ t('shared.gridSettingsPanel.title') }}
    </h3>
    <PropertyTable :groups="groups" hide-group-titles @edit="onEdit" />
  </div>
</template>

<style scoped>
.grid-settings-title {
  padding: 12px 14px 0;
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vscode-accent, #cca250);
  font-weight: 700;
}
</style>
