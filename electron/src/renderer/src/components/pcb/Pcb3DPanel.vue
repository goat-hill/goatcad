<script setup lang="ts">
/**
 * The right rail while the board is in 3D — what this view has instead of
 * Properties / Layers / Grid.
 *
 * Those three answer questions the 3D view cannot: nothing is selectable, the
 * 2D layer stack does not apply, and there is no grid to snap to. So the rail
 * carries what *is* adjustable here — what is drawn, how it is presented, and
 * the way out as a picture — and the viewport's floating toolbar is left
 * holding camera controls only.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import CollapsiblePanel from '../shared/CollapsiblePanel.vue'
import Icon from '../shared/Icon.vue'
import PropertyTable from '../shared/PropertyTable.vue'
import Pcb3DOptionsPanel from './Pcb3DOptionsPanel.vue'
import {
  BOARD3D_EXPOSURE_RANGE,
  BOARD3D_PRESENTATION_CHOICES,
  board3dPresentation,
  isDefaultBoard3DPresentation,
  resetBoard3DPresentation,
  setBoard3DPresentation,
  type Board3DPresentation
} from '../../lib/board3dView'
import type { PropertyEditValue, PropertyGroup } from '../../lib/propertyTable'

const { t } = useI18n()

const emit = defineEmits<{
  /** Export image…; the host owns the dialog and the picture. */
  (e: 'export-image'): void
}>()

const presentation = board3dPresentation()
const presentationIsDefault = computed(() => isDefaultBoard3DPresentation(presentation.value))

// Through the shared PropertyTable, as the Grid panel is: one group, titled by
// its CollapsiblePanel.
const presentationGroups = computed<PropertyGroup[]>(() => [
  {
    type: 'presentation',
    title: t('pcbEditor.viewport3d.presentation.title'),
    count: 1,
    fields: [
      {
        key: 'background',
        label: t('pcbEditor.viewport3d.presentation.background'),
        editor: {
          kind: 'select',
          options: BOARD3D_PRESENTATION_CHOICES.background.map((value) => ({
            value,
            label: t(`pcbEditor.viewport3d.presentation.backgrounds.${value}`)
          }))
        },
        value: presentation.value.background
      },
      {
        key: 'projection',
        label: t('pcbEditor.viewport3d.presentation.projection'),
        editor: {
          kind: 'select',
          options: BOARD3D_PRESENTATION_CHOICES.projection.map((value) => ({
            value,
            label: t(`pcbEditor.viewport3d.presentation.projections.${value}`)
          }))
        },
        value: presentation.value.projection
      },
      {
        key: 'lighting',
        label: t('pcbEditor.viewport3d.presentation.lighting'),
        editor: {
          kind: 'select',
          options: BOARD3D_PRESENTATION_CHOICES.lighting.map((value) => ({
            value,
            label: t(`pcbEditor.viewport3d.presentation.lightings.${value}`)
          }))
        },
        value: presentation.value.lighting
      },
      {
        // Shown as a percent of the preset as tuned; held as a factor.
        key: 'lightLevel',
        label: t('pcbEditor.viewport3d.presentation.lightLevel'),
        editor: {
          kind: 'number',
          unit: '%',
          step: 10,
          min: BOARD3D_EXPOSURE_RANGE.min * 100,
          max: BOARD3D_EXPOSURE_RANGE.max * 100
        },
        value: Math.round(presentation.value.exposure * 100)
      }
    ]
  }
])

const isChoice = <K extends keyof typeof BOARD3D_PRESENTATION_CHOICES>(
  key: K,
  value: unknown
): value is Board3DPresentation[K] =>
  (BOARD3D_PRESENTATION_CHOICES[key] as readonly unknown[]).includes(value)

const onPresentationEdit = (_groupType: string, key: string, value: PropertyEditValue): void => {
  if (key === 'projection' && isChoice('projection', value)) {
    setBoard3DPresentation({ projection: value })
  } else if (key === 'lighting' && isChoice('lighting', value)) {
    setBoard3DPresentation({ lighting: value })
  } else if (key === 'background' && isChoice('background', value)) {
    setBoard3DPresentation({ background: value })
  } else if (key === 'lightLevel') {
    const percent = Number(value)
    if (!Number.isFinite(percent)) return
    const { min, max } = BOARD3D_EXPOSURE_RANGE
    setBoard3DPresentation({ exposure: Math.min(max, Math.max(min, percent / 100)) })
  }
}
</script>

<template>
  <div class="board3d-panel">
    <CollapsiblePanel id="pcb3d.layers" :title="t('pcbEditor.viewport3d.options.layersGroup')" fit>
      <Pcb3DOptionsPanel subject="board" />
    </CollapsiblePanel>

    <CollapsiblePanel
      id="pcb3d.presentation"
      :title="t('pcbEditor.viewport3d.presentation.title')"
      fit
    >
      <PropertyTable :groups="presentationGroups" hide-group-titles @edit="onPresentationEdit" />
      <div class="section-actions">
        <button
          type="button"
          class="btn-outline btn-md btn-panel"
          :disabled="presentationIsDefault"
          @click="resetBoard3DPresentation()"
        >
          <Icon name="discard" />
          {{ t('pcbEditor.viewport3d.options.reset') }}
        </button>
      </div>
    </CollapsiblePanel>

    <CollapsiblePanel id="pcb3d.export" :title="t('pcbEditor.viewport3d.exportImage.section')" fit>
      <div class="section-actions">
        <button type="button" class="btn-outline btn-md btn-panel" @click="emit('export-image')">
          <Icon name="tool-export" />
          {{ t('pcbEditor.viewport3d.exportImage.button') }}
        </button>
      </div>
    </CollapsiblePanel>
  </div>
</template>

<style scoped>
/* The sections stack at their own heights, in order; a short window scrolls
   the stack rather than squeezing it. */
.board3d-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden auto;
  color: var(--vscode-text);
  font-family: var(--font-family);
  font-size: var(--text-body-sm);
}

/* Layout only — the look is `btn-panel` (DESIGN.md §3), inset as the
   Properties panel's page buttons are. */
.section-actions {
  margin: 12px 10px;
}
</style>
