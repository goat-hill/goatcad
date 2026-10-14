<script setup lang="ts">
/**
 * Layers, unpinned from the right bar: a pill in the viewport's corner naming
 * the active layer in its own color, with the Layers panel in a popover above
 * it (`ViewportPopover`). Pinned, the bar holds the panel and this is gone.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ViewportPopover from './ViewportPopover.vue'
import LayersPanel from './LayersPanel.vue'
import { layerTitle, type LayerListing } from '../../lib/board/layerListing'
import { kicadLayerColorsForTheme, useAppTheme } from '../../lib/theme'
import type { PanelLayoutEditor } from '../../lib/panelLayout'

const { t } = useI18n()
const appTheme = useAppTheme()

const props = defineProps<{
  editor: PanelLayoutEditor
  listing: LayerListing
  layerVisibility: Record<string, boolean>
  activeLayer: string
}>()

const emit = defineEmits<{
  (e: 'toggle-layer-visibility', layer: string): void
  (e: 'set-active-layer', layer: string): void
  (e: 'apply-layer-preset', visibility: Record<string, boolean>): void
}>()

const color = computed(() => kicadLayerColorsForTheme(appTheme.value)[props.activeLayer])
</script>

<template>
  <ViewportPopover
    :swatch="color"
    :label="layerTitle(props.listing, props.activeLayer)"
    :title="t('shared.layersPanel.buttonTitle')"
    :panel-title="t('shared.layersPanel.title')"
    :editor="props.editor"
    panel="layers"
    steady
  >
    <div class="layers-popover-body">
      <LayersPanel
        hide-header
        :layers="props.listing.layers"
        :layer-visibility="props.layerVisibility"
        :active-layer="props.activeLayer"
        :activatable="props.listing.activatable"
        :presets="props.listing.presets"
        @toggle-layer-visibility="(l) => emit('toggle-layer-visibility', l)"
        @set-active-layer="(l) => emit('set-active-layer', l)"
        @apply-layer-preset="(v) => emit('apply-layer-preset', v)"
      />
    </div>
  </ViewportPopover>
</template>

<style scoped>
/* The right bar's default width (DEFAULT_PANEL_WIDTH, lib/panelLayout.ts), so
   the panel lays out as it does pinned rather than clipping its names. A
   board's layer table outgrows the canvas above the corner; the list scrolls. */
.layers-popover-body {
  width: 300px;
  max-height: min(60vh, 520px);
  overflow-y: auto;
}
</style>
