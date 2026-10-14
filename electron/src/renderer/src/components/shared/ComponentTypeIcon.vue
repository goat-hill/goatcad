<script setup lang="ts">
import Icon from './Icon.vue'
import type { IconName } from '../../lib/icons'

/**
 * The three primitive-type glyphs — symbol / footprint / 3D model — shared by the
 * Libraries row indicators and the Component viewer pane headers so the two read
 * as one iconography. Fills its container; color comes from `currentColor`, set
 * by the caller. Geometry lives in the icon registry (lib/icons.ts).
 */
type ComponentType = 'symbol' | 'footprint' | 'model'

defineProps<{ type: ComponentType }>()

const ICON_NAME: Record<ComponentType, IconName> = {
  symbol: 'ctype-symbol',
  footprint: 'ctype-footprint',
  model: 'cube'
}
</script>

<template>
  <Icon :name="ICON_NAME[type]" class="ctype" />
</template>

<style scoped>
.ctype {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
