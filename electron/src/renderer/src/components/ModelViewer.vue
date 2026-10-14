<script setup lang="ts">
import { Box3 } from 'three'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useGroupKeydown } from '../lib/editorWorkspace'
import { useI18n } from 'vue-i18n'
import { Viewport3DEngine, type ViewPreset } from '../lib/engine/Viewport3DEngine'
import { buildStepGroup, buildVrmlGroup } from '../lib/engine/modelGeometry'
import { formatMm } from '../lib/engine/extentGauge'
import { matchesHotkey, isTypingTarget } from '../lib/hotkeys'
import CubeIcon from './shared/CubeIcon.vue'
import Icon from './shared/Icon.vue'
import FitViewButton from './shared/FitViewButton.vue'

const { t } = useI18n()

const props = defineProps<{
  filePath: string
  name: string
  /** Open straight down, framed as a 2D canvas frames the part — beside a footprint's 2D pane. */
  initialView?: 'iso' | 'top'
}>()

const container = ref<HTMLDivElement | null>(null)
const isLoading = ref(true)
const loadError = ref<string | null>(null)
const gaugeVisible = ref(false)
const dimensions = ref<{ x: number; y: number; z: number } | null>(null)

// The engine holds WebGL state and must never be made reactive.
let engine: Viewport3DEngine | null = null
let disposed = false
// Bumped per load; a stale async import that resolves after a newer switch
// (the Component view reuses this instance) must not overwrite the new model.
let loadToken = 0

const isVrml = (): boolean => props.name.toLowerCase().endsWith('.wrl')

const loadModel = async (): Promise<void> => {
  const token = ++loadToken
  try {
    let group
    if (isVrml()) {
      const res = await window.api.readFile(props.filePath)
      if (!res.success || res.content === undefined) {
        throw new Error(res.error || 'read failed')
      }
      group = buildVrmlGroup(res.content)
    } else {
      const res = await window.api.loadStepModel(props.filePath)
      if (!res.success) throw new Error(res.error || 'import failed')
      group = buildStepGroup(res.meshes)
    }
    if (disposed || !engine || token !== loadToken) return
    if (props.initialView === 'top') {
      engine.setModel(group, false)
      engine.frameTop([new Box3().setFromObject(group)])
    } else engine.setModel(group)
    dimensions.value = engine.getDimensions()
  } catch (err: unknown) {
    if (token !== loadToken) return
    console.error('Failed to load 3D model:', err)
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (token === loadToken) isLoading.value = false
  }
}

// The Component view keeps one ModelViewer mounted and swaps the file when the
// user picks a different 3D model, so reload on path change (not just on mount).
watch(
  () => props.filePath,
  () => {
    if (!engine) return
    isLoading.value = true
    loadError.value = null
    dimensions.value = null
    // Clear the previous model so the spinner sits over an empty viewport
    // rather than the stale one — same meaning as the first-load state.
    engine.setModel(null)
    void loadModel()
  }
)

// Fit hotkey, same binding as the 2D editors (lib/hotkeys.ts).
const handleKeydown = (e: KeyboardEvent): void => {
  if (isTypingTarget()) return
  if (matchesHotkey(e, 'editor.fitView')) {
    e.preventDefault()
    engine?.fitView()
  }
}

useGroupKeydown(handleKeydown)

onMounted(() => {
  if (!container.value) return
  engine = new Viewport3DEngine(container.value)
  void loadModel()
})

onBeforeUnmount(() => {
  disposed = true
  engine?.destroy()
  engine = null
})

const fitView = (): void => engine?.fitView()
const setView = (preset: ViewPreset): void => engine?.setView(preset)
const toggleGauge = (): void => {
  gaugeVisible.value = !gaugeVisible.value
  engine?.setGaugeVisible(gaugeVisible.value)
}
</script>

<template>
  <div class="model-viewer">
    <div ref="container" class="model-canvas"></div>

    <!-- The camera and gauge, on the left rail every view keeps its view
         controls in (same chrome as the editors). -->
    <div class="canvas-floating-toolbar toolbar-left-rail rail-solo">
      <FitViewButton @fit="fitView" />

      <div class="toolbar-divider"></div>

      <button
        class="floating-btn tool-btn"
        :title="t('modelViewer.isoViewTitle')"
        @click="setView('iso')"
      >
        <CubeIcon />
      </button>
      <button
        class="floating-btn tool-btn"
        :title="t('modelViewer.frontViewTitle')"
        @click="setView('front')"
      >
        <Icon name="cube-front" />
      </button>
      <button
        class="floating-btn tool-btn"
        :title="t('modelViewer.topViewTitle')"
        @click="setView('top')"
      >
        <Icon name="cube-top" />
      </button>
      <button
        class="floating-btn tool-btn"
        :title="t('modelViewer.rightViewTitle')"
        @click="setView('right')"
      >
        <Icon name="cube-right" />
      </button>

      <div class="toolbar-divider"></div>

      <button
        class="floating-btn tool-btn toggle-btn"
        :class="{ active: gaugeVisible }"
        :title="t('modelViewer.gaugeTitle')"
        @click="toggleGauge"
      >
        <Icon name="gauge" />
      </button>
    </div>

    <!-- Overall model size readout -->
    <div v-if="dimensions" class="dims-pill">
      {{
        t('modelViewer.dims', {
          x: formatMm(dimensions.x),
          y: formatMm(dimensions.y),
          z: formatMm(dimensions.z)
        })
      }}
    </div>

    <div v-if="isLoading" class="viewer-overlay">
      <div class="spinner"></div>
      <span>{{ t('modelViewer.loading') }}</span>
    </div>
    <div v-else-if="loadError" class="viewer-overlay">
      <span class="error-title">{{ t('modelViewer.loadFailed') }}</span>
      <span class="error-detail">{{ loadError }}</span>
    </div>
  </div>
</template>

<style scoped>
.model-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  /* Matches the app's 3D-surface treatment (see viewport-3d placeholders),
     with a slightly lifted center so models read against a soft halo. */
  background: radial-gradient(
    ellipse at 50% 38%,
    var(--vscode-bg-3d-near) 0%,
    var(--vscode-bg-3d-mid) 48%,
    var(--vscode-bg-3d-far) 100%
  );
}

.model-canvas {
  position: absolute;
  inset: 0;
}

.tool-btn svg {
  width: 15px;
  height: 15px;
}

/* Bottom right, as in the board 3D view and the 2D editors' readout. */
.dims-pill {
  position: absolute;
  right: 12px;
  bottom: 12px;
  padding: 5px 12px;
  background: var(--vscode-overlay);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 6px;
  color: var(--vscode-text-muted, #748780);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-body-sm);
  line-height: 18px;
  pointer-events: none;
}

.viewer-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--vscode-text-muted, #748780);
  font-size: 12px;
  pointer-events: none;
}

.spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--vscode-border, #24302b);
  border-top-color: var(--vscode-accent, #cca250);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-title {
  color: var(--vscode-text-light, #ffffff);
  font-size: 13px;
  font-weight: 600;
}

.error-detail {
  max-width: 420px;
  text-align: center;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}
</style>
