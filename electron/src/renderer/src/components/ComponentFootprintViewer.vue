<script setup lang="ts">
import { ref, watch } from 'vue'
import FootprintViewport2D from './footprint/FootprintViewport2D.vue'
import type { KicadFootprint } from '../lib/kicad/footprint'
import { readFootprintFile } from '../lib/libraryLoad'
import type { GridSettings } from '../lib/engine/ViewportEngine'

/**
 * Read-only footprint renderer for the Component view and the library chooser
 * — the real `FootprintViewport2D` (canvas only; its toolbar lives in
 * FootprintEditor) fed a parsed `.kicad_mod`, or the `parsed` one given. No
 * selection/edit handlers, so it's pan/zoom view only.
 */
const props = defineProps<{
  file: string
  parsed?: KicadFootprint | null
  /** Drop the canvas's status pills (`FootprintViewport2D.bare`). */
  bare?: boolean
}>()
const footprint = ref<KicadFootprint | null>(null)

const grid: GridSettings = { spacing: 1.0, unit: 'mm', visible: true, snap: true }
const layerVisibility: Record<string, boolean> = {
  'F.Cu': true,
  'B.Cu': true,
  'F.SilkS': true,
  'B.SilkS': true,
  'F.Mask': true,
  'B.Mask': true,
  'F.Paste': true,
  'B.Paste': true,
  'F.CrtYd': true,
  'B.CrtYd': true,
  'F.Fab': true,
  'B.Fab': true
}

watch(
  () => [props.file, props.parsed] as const,
  async ([file, parsed]) => {
    footprint.value = parsed ?? null
    if (parsed || !file) return
    footprint.value = await readFootprintFile(file)
  },
  { immediate: true }
)
</script>

<template>
  <div class="cfv">
    <FootprintViewport2D
      :footprint="footprint"
      :file-path="file"
      :selected-pad-index="null"
      :selected-line-index="null"
      :selected-poly-index="null"
      :selected-items="[]"
      :grid-settings="grid"
      :layer-visibility="layerVisibility"
      active-layer="F.SilkS"
      non-active-display="show"
      preview
      :bare="bare"
    />
  </div>
</template>

<style scoped>
.cfv {
  width: 100%;
  height: 100%;
  position: relative;
}
</style>
