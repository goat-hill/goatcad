<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useGroupKeydown } from '../lib/editorWorkspace'
import { useI18n } from 'vue-i18n'
import { imageMimeType } from '../lib/imageFiles'
import { matchesHotkey, isTypingTarget, MIDDLE_DOUBLE_CLICK_INTERVAL_MS } from '../lib/hotkeys'
import FitViewButton from './shared/FitViewButton.vue'

/**
 * Read-only image viewer tab (see lib/imageFiles.ts for the routed types).
 * Same camera conventions as the other editors: wheel zooms at the cursor,
 * left/middle drag pans, and middle-double-click / Home / the toolbar chip
 * fit the view. Content loads over IPC as a data: URL because the dev page
 * is served over http, where a file:// <img> src is blocked.
 */

const { t } = useI18n()

const props = defineProps<{
  filePath: string
  name: string
}>()

const container = ref<HTMLDivElement | null>(null)
const isLoading = ref(true)
const loadError = ref<string | null>(null)
const dataUrl = ref<string | null>(null)

// Natural pixel size, known once the <img> decodes.
const naturalSize = ref<{ w: number; h: number } | null>(null)

// View transform: screen = translate + image-point × scale.
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
/** True after a manual wheel/pan; blocks auto-refit on container resizes. */
let userTransformed = false
let lastMiddleDownTime = 0
let resizeObserver: ResizeObserver | null = null

// Reactive: `active` drives the grabbing cursor class in the template.
const drag = reactive({ active: false, pointerId: 0, x: 0, y: 0 })

/** Zoom multiplier per wheel notch (matches ViewportEngine's ZOOM_STEP). */
const ZOOM_STEP = 1.15
const MIN_SCALE = 0.05
const MAX_SCALE = 40

const imageStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
  // Crisp texels when inspecting pixels, smooth when merely enlarged a bit.
  imageRendering: scale.value >= 3 ? ('pixelated' as const) : ('auto' as const)
}))

const zoomPercent = computed(() => Math.round(scale.value * 100))

const loadImage = async (): Promise<void> => {
  const mime = imageMimeType(props.name)
  if (!mime) {
    loadError.value = props.name
    isLoading.value = false
    return
  }
  try {
    const res = await window.api.readFileBase64(props.filePath)
    if (!res.success || res.data === undefined) {
      throw new Error(res.error || 'read failed')
    }
    dataUrl.value = `data:${mime};base64,${res.data}`
  } catch (err: unknown) {
    console.error('Failed to load image:', err)
    loadError.value = err instanceof Error ? err.message : String(err)
    isLoading.value = false
  }
}

const onImageLoad = (e: Event): void => {
  const img = e.target as HTMLImageElement
  // SVGs without an intrinsic size report 0; Chromium's 300×150 CSS default
  // is what actually renders, so mirror it.
  naturalSize.value = { w: img.naturalWidth || 300, h: img.naturalHeight || 150 }
  isLoading.value = false
  fitView()
}

const onImageError = (): void => {
  isLoading.value = false
  loadError.value = props.name
}

/**
 * Fit: contain within the viewport with a little padding, but never upscale
 * past 100% (VS Code behavior — a 16px icon blown to screen size is noise).
 */
const fitView = (): void => {
  const el = container.value
  const size = naturalSize.value
  if (!el || !size) return
  const cw = el.clientWidth
  const ch = el.clientHeight
  if (cw === 0 || ch === 0) return
  const contain = Math.min(cw / size.w, ch / size.h) * 0.94
  scale.value = Math.min(contain, 1)
  tx.value = (cw - size.w * scale.value) / 2
  ty.value = (ch - size.h * scale.value) / 2
  userTransformed = false
}

const actualSize = (): void => {
  const el = container.value
  const size = naturalSize.value
  if (!el || !size) return
  scale.value = 1
  tx.value = (el.clientWidth - size.w) / 2
  ty.value = (el.clientHeight - size.h) / 2
  userTransformed = true
}

const onWheel = (e: WheelEvent): void => {
  if (!naturalSize.value) return
  e.preventDefault()
  const rect = container.value?.getBoundingClientRect()
  if (!rect) return
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top
  const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value * factor))
  const ratio = next / scale.value
  tx.value = cx - (cx - tx.value) * ratio
  ty.value = cy - (cy - ty.value) * ratio
  scale.value = next
  userTransformed = true
}

const onPointerDown = (e: PointerEvent): void => {
  if (e.button === 1) {
    // dblclick only fires for the primary button; detect manually, like the
    // canvas engines do.
    const now = performance.now()
    if (now - lastMiddleDownTime < MIDDLE_DOUBLE_CLICK_INTERVAL_MS) {
      lastMiddleDownTime = 0
      fitView()
      e.preventDefault()
      return
    }
    lastMiddleDownTime = now
  }
  if (e.button !== 0 && e.button !== 1) return
  drag.active = true
  drag.pointerId = e.pointerId
  drag.x = e.clientX
  drag.y = e.clientY
  container.value?.setPointerCapture(e.pointerId)
  e.preventDefault()
}

const onPointerMove = (e: PointerEvent): void => {
  if (!drag.active || e.pointerId !== drag.pointerId) return
  tx.value += e.clientX - drag.x
  ty.value += e.clientY - drag.y
  drag.x = e.clientX
  drag.y = e.clientY
  userTransformed = true
}

const onPointerUp = (e: PointerEvent): void => {
  if (!drag.active || e.pointerId !== drag.pointerId) return
  drag.active = false
  container.value?.releasePointerCapture(e.pointerId)
}

const handleKeydown = (e: KeyboardEvent): void => {
  if (isTypingTarget()) return
  if (matchesHotkey(e, 'editor.fitView')) {
    e.preventDefault()
    fitView()
  }
}

useGroupKeydown(handleKeydown)

onMounted(() => {
  if (container.value) {
    resizeObserver = new ResizeObserver(() => {
      if (!userTransformed) fitView()
    })
    resizeObserver.observe(container.value)
  }
  void loadImage()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <div
    ref="container"
    class="image-viewer"
    :class="{ panning: drag.active }"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @dblclick="fitView"
  >
    <img
      v-if="dataUrl && !loadError"
      class="image-content"
      :src="dataUrl"
      :alt="name"
      :style="imageStyle"
      draggable="false"
      @load="onImageLoad"
      @error="onImageError"
    />

    <!-- The camera, on the left rail every view keeps its view controls in. -->
    <div class="canvas-floating-toolbar toolbar-left-rail rail-solo">
      <FitViewButton @fit="fitView" />
      <button
        class="floating-btn tool-btn actual-size-btn"
        :title="t('imageViewer.actualSizeTitle')"
        @click.stop="actualSize"
      >
        1:1
      </button>
    </div>

    <!-- Pixel size + zoom readout -->
    <div v-if="naturalSize && !loadError" class="dims-pill">
      {{ t('imageViewer.dims', { w: naturalSize.w, h: naturalSize.h, zoom: zoomPercent }) }}
    </div>

    <div v-if="isLoading && !loadError" class="viewer-overlay">
      <div class="spinner"></div>
      <span>{{ t('imageViewer.loading') }}</span>
    </div>
    <div v-else-if="loadError" class="viewer-overlay">
      <span class="error-title">{{ t('imageViewer.loadFailed') }}</span>
      <span class="error-detail">{{ loadError }}</span>
    </div>
  </div>
</template>

<style scoped>
.image-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  cursor: grab;
  background-color: var(--vscode-bg, #151c19);
  /* Subtle checkerboard so transparency reads as transparency. */
  background-image:
    linear-gradient(45deg, var(--vscode-overlay-control) 25%, transparent 25%),
    linear-gradient(-45deg, var(--vscode-overlay-control) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--vscode-overlay-control) 75%),
    linear-gradient(-45deg, transparent 75%, var(--vscode-overlay-control) 75%);
  background-size: 16px 16px;
  background-position:
    0 0,
    0 8px,
    8px -8px,
    -8px 0;
}

.image-viewer.panning {
  cursor: grabbing;
}

.image-content {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  pointer-events: none;
  user-select: none;
  max-width: none;
}

.actual-size-btn {
  font-family: var(--font-mono, monospace);
  font-size: var(--text-body-sm);
  letter-spacing: -0.5px;
}

.dims-pill {
  position: absolute;
  left: 12px;
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
