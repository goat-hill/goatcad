<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { GridSettings } from '../../lib/engine/ViewportEngine'
import LayersPanel from '../shared/LayersPanel.vue'
import PropertyTable from '../shared/PropertyTable.vue'
import CollapsiblePanel from '../shared/CollapsiblePanel.vue'
import { footprintLayerListing } from '../../lib/board/layerListing'
import { panelPinned, setPanelPinned } from '../../lib/panelLayout'
import type { PropertyEditValue, PropertyGroup } from '../../lib/propertyTable'
import FormatNotice from '../shared/FormatNotice.vue'

const { t } = useI18n()

defineProps<{
  /** Selection-driven property groups (built by FootprintEditor). When nothing
      is selected these are the footprint-level group (name/side/description/…). */
  propertyGroups: PropertyGroup[]
  gridSettings: GridSettings
  layerVisibility: Record<string, boolean>
  activeLayer: string
  readOnly?: boolean
  /** The footprint's file, at the document level (nothing selected), for its KiCad-version note. */
  formatFilePath?: string | null
}>()

const emit = defineEmits<{
  (e: 'edit', groupType: string, key: string, value: PropertyEditValue): void
  (e: 'update-grid', settings: Partial<GridSettings>): void
  (e: 'toggle-layer-visibility', layer: string): void
  (e: 'apply-layer-preset', layers: Record<string, boolean>): void
  (e: 'set-active-layer', layer: string): void
}>()

const listing = computed(() => footprintLayerListing((key) => t(`shared.layerPresets.${key}`)))
const layersPinned = panelPinned('footprint', 'layers')
</script>

<template>
  <div class="properties-panel-content">
    <!-- 3D-model editing is deferred to a future 3D mode. -->
    <CollapsiblePanel :title="t('shared.propertiesPanel.title')" flex>
      <FormatNotice :file-path="formatFilePath" />
      <PropertyTable
        :groups="propertyGroups"
        :distance-unit="gridSettings.unit"
        :read-only="readOnly"
        @edit="(groupType, key, value) => emit('edit', groupType, key, value)"
      />
    </CollapsiblePanel>

    <CollapsiblePanel
      v-if="layersPinned"
      id="footprint.layers"
      :title="t('shared.layersPanel.title')"
      :initial-height="220"
      unpinnable
      @unpin="setPanelPinned('footprint', 'layers', false)"
    >
      <LayersPanel
        hide-header
        :layers="listing.layers"
        :layer-visibility="layerVisibility"
        :active-layer="activeLayer"
        :presets="listing.presets"
        @toggle-layer-visibility="(l) => emit('toggle-layer-visibility', l)"
        @set-active-layer="(l) => emit('set-active-layer', l)"
        @apply-layer-preset="(v) => emit('apply-layer-preset', v)"
      />
    </CollapsiblePanel>

    <!-- The corner's panels, pinned here (RailPinnedPanels). -->
    <slot />
  </div>
</template>

<style scoped>
.properties-panel-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  color: var(--vscode-text, #c5d3cd);
  font-family: var(--font-family);
  font-size: var(--text-body-sm);
}
</style>
