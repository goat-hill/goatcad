<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ViewportEngine, STANDARD_GRID_APPEARANCE } from '../../lib/engine/ViewportEngine'
import { useAppTheme } from '../../lib/theme'
import {
  GerberScene,
  type GerberNonActiveDisplay,
  type GerberSceneLayer
} from '../../lib/engine/GerberScene'

const { t } = useI18n()

const props = defineProps<{
  /** Stack-ordered layers, bottom first (see GerberViewer). */
  layers: GerberSceneLayer[]
  activeLayer: string | null
  visibility: Record<string, boolean>
  nonActiveDisplay: GerberNonActiveDisplay
}>()

const container = ref<HTMLDivElement | null>(null)
const coordinates = ref('')

let engine: ViewportEngine | null = null
let scene: GerberScene | null = null
const appTheme = useAppTheme()

// mm; a lone fiducial layer still frames at a sane zoom.
const FIT_MIN_EXTENT = 25

const pushSpecs = (): void => {
  if (engine && scene) engine.setCompositeLayers(scene.getSpecs())
}

const rebuild = (): void => {
  if (!engine || !scene) return
  scene.build(props.layers)
  scene.setActiveLayer(props.activeLayer)
  scene.setNonActiveDisplay(props.nonActiveDisplay)
  scene.setVisibilityMap(props.visibility)
  pushSpecs()
  engine.zoomToFit(scene.getBounds(), FIT_MIN_EXTENT)
}

const zoomToFit = (): void => {
  if (engine && scene) engine.zoomToFit(scene.getBounds(), FIT_MIN_EXTENT)
}

defineExpose({ zoomToFit })

onMounted(() => {
  if (!container.value) return
  engine = new ViewportEngine(container.value)
  scene = new GerberScene()
  engine.setGridSettings({ spacing: 1, unit: 'mm', visible: true, snap: false })
  // Same subdued grid as the schematic/symbol viewports.
  engine.setGridAppearance(STANDARD_GRID_APPEARANCE)
  engine.applyTheme()
  engine.onResetView(zoomToFit)
  engine.onMouseMoveCoords((world) => {
    coordinates.value = t('gerberViewer.coords', {
      x: world.x.toFixed(3),
      y: world.y.toFixed(3)
    })
  })
  rebuild()
})

watch(() => props.layers, rebuild)
watch(appTheme, () => engine?.applyTheme())
watch(
  () => props.activeLayer,
  (id) => {
    scene?.setActiveLayer(id)
    pushSpecs()
  }
)
watch(
  () => props.visibility,
  (map) => {
    scene?.setVisibilityMap(map)
    pushSpecs()
  },
  { deep: true }
)
watch(
  () => props.nonActiveDisplay,
  (mode) => {
    scene?.setNonActiveDisplay(mode)
    pushSpecs()
  }
)

onUnmounted(() => {
  engine?.setCompositeLayers([])
  scene?.dispose()
  engine?.destroy()
  engine = null
  scene = null
})
</script>

<template>
  <div ref="container" class="gerber-viewport">
    <div class="gerber-coordinates">{{ coordinates }}</div>
  </div>
</template>

<style scoped>
.gerber-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.gerber-coordinates {
  position: absolute;
  right: 12px;
  bottom: 10px;
  z-index: 12;
  padding: 4px 8px;
  border: 1px solid var(--vscode-border);
  border-radius: 3px;
  background: var(--vscode-overlay);
  color: var(--vscode-text-muted);
  font: 10px var(--font-mono);
  pointer-events: none;
}
</style>
