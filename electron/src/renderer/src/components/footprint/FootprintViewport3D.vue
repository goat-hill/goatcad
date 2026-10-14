<script setup lang="ts">
/**
 * The footprint editor's 3D preview: the part on a small piece of board.
 *
 * It used to render the linked `(model …)` alone, floating in space. That shows
 * you the model but not the thing you open this pane to check — whether the
 * part sits on its copper correctly, whether the silkscreen clears it, whether
 * the pads are where the body expects them. So the footprint is wrapped as a
 * one-part board (`footprintBoard.ts`) and handed to the same `BoardScene3D`
 * the PCB editor uses. Pads, silk, mask and drills therefore look identical to
 * how they will look on the real board, because it is the same code drawing
 * them, and the pane costs no renderer of its own.
 *
 * Chrome matches the board's 3D view exactly: same background, same right-hand
 * camera toolbar, same status pills, and the view switches in the right rail.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useGroupKeydown } from '../../lib/editorWorkspace'
import { Box3, Vector3 } from 'three'
import { useI18n } from 'vue-i18n'
import { Viewport3DEngine, type ViewPreset } from '../../lib/engine/Viewport3DEngine'
import {
  BoardScene3D,
  defaultBoard3DStats,
  type Board3DStats
} from '../../lib/engine/board3d/BoardScene3D'
import {
  ComponentModelLoader,
  type ComponentModelProgress
} from '../../lib/engine/board3d/componentModels'
import {
  boardFromFootprint,
  boardMarginFor,
  footprintExtent,
  hasOwnBoardEdge
} from '../../lib/engine/board3d/footprintBoard'
import { nm, nmToMm } from '../../lib/kicad/coordinates'
import { formatMm } from '../../lib/engine/extentGauge'
import { loadClipper } from '../../lib/geometry/clip'
import { board3dViewState } from '../../lib/board3dView'
import { KicadFootprint } from '../../lib/kicad/footprint'
import { isTypingTarget, matchesHotkey } from '../../lib/hotkeys'
import CubeIcon from '../shared/CubeIcon.vue'
import Icon from '../shared/Icon.vue'
import FitViewButton from '../shared/FitViewButton.vue'

const { t } = useI18n()

const props = defineProps<{
  footprint: KicadFootprint | null
  filePath?: string | null
  projectPath?: string | null
  /** Open straight down, framed as the 2D canvas frames the part — beside a 2D preview. */
  initialView?: 'iso' | 'top'
  /** No size readout, where the canvas is a thumbnail (the library chooser), as the 2D `bare`. */
  bare?: boolean
}>()

const options = board3dViewState()

const container = ref<HTMLDivElement | null>(null)
const isBuilding = ref(false)
const stats = ref<Board3DStats>(defaultBoard3DStats())
const modelProgress = ref<ComponentModelProgress>({
  total: 0,
  placed: 0,
  missing: 0,
  missingLinks: []
})
const dimensions = ref<{ x: number; y: number; z: number } | null>(null)

// WebGL state; never made reactive.
let engine: Viewport3DEngine | null = null
let scene: BoardScene3D | null = null
let loader: ComponentModelLoader | null = null
let disposed = false

const hasFootprint = computed(() => !!props.footprint)
const hasModelLink = computed(() => !!props.footprint?.model?.path.trim())

const modelsPending = computed(() => {
  const p = modelProgress.value
  return options.value.models && p.placed + p.missing < p.total
})

const modelProgressFraction = computed(() => {
  const p = modelProgress.value
  return p.total === 0 ? 0 : (p.placed + p.missing) / p.total
})

/**
 * Lines under the viewport. Unlike the board view these are about the one
 * model: a footprint with no link at all is a normal state worth naming, and a
 * link that will not resolve is the most common reason this pane looks wrong.
 */
const notices = computed<Array<{ text: string; detail?: string }>>(() => {
  if (!options.value.models) return []
  if (!hasModelLink.value) return [{ text: t('footprintEditor.viewport3d.noModelMsg') }]
  if (modelProgress.value.missing > 0) {
    return [
      {
        text: t('footprintEditor.viewport3d.notFoundMsg'),
        detail: [
          t('pcbEditor.viewport3d.missingModelsDetail'),
          ...modelProgress.value.missingLinks
        ].join('\n')
      }
    ]
  }
  return []
})

/**
 * The part's size, not the preview board's. The board under it is a backdrop we
 * invented; quoting its dimensions would be quoting our own margin back at the
 * user. So the pill measures the loaded model, falling back to the copper
 * extent when there is nothing to place.
 */
const readDimensions = (): void => {
  if (!scene) {
    dimensions.value = null
    return
  }
  const model = new Box3().setFromObject(scene.components)
  const bounds = model.isEmpty() ? scene.getBoardBounds() : model
  if (bounds.isEmpty()) {
    dimensions.value = null
    return
  }
  const size = bounds.getSize(new Vector3())
  dimensions.value = { x: size.x, y: size.y, z: size.z }
}

/**
 * The part's own extent in the scene — the preview board less the margin it
 * was given (`boardFromFootprint`) — which is what the 2D canvas fits.
 */
const partBounds = (footprint: KicadFootprint): Box3 => {
  const board = scene?.getBoardBounds() ?? new Box3()
  const extent = footprintExtent(footprint)
  if (board.isEmpty() || !extent || hasOwnBoardEdge(footprint)) return board
  const margin = boardMarginFor(
    nmToMm(nm(extent.maxX - extent.minX)),
    nmToMm(nm(extent.maxY - extent.minY))
  )
  return board.clone().expandByVector(new Vector3(-margin, -margin, 0))
}

/** Framed once; a later rebuild is an edit to the part already on screen. */
let framed = false

const rebuild = async (): Promise<void> => {
  if (!scene || !engine) return
  isBuilding.value = true
  await nextTick()
  // The clip engine, once — instant after the first await, and on failure the
  // part still builds, just with unclipped layers.
  await loadClipper()
  if (disposed || !scene || !engine) return
  try {
    scene.setBoard(props.footprint ? boardFromFootprint(props.footprint) : null, options.value)
    stats.value = scene.getStats()
    readDimensions()
    engine.refreshBounds()
    if (!framed && props.footprint) {
      if (props.initialView === 'top') engine.frameTop([partBounds(props.footprint)])
      else engine.setView('iso', false)
      framed = true
    }
  } finally {
    isBuilding.value = false
  }
  void reloadModels()
}

const reloadModels = async (): Promise<void> => {
  if (!loader || !scene) return
  if (!props.footprint || !options.value.models) {
    loader.clear()
    modelProgress.value = { total: 0, placed: 0, missing: 0, missingLinks: [] }
    readDimensions()
    engine?.refreshBounds()
    return
  }
  await loader.load(
    boardFromFootprint(props.footprint),
    props.filePath ?? null,
    props.projectPath ?? null,
    // No class filtering: there is exactly one part, and hiding it by its
    // `(attr …)` would read as the preview being broken rather than filtered.
    { tht: true, smd: true, unspecified: true, dnp: true, notInPosFiles: true },
    (progress) => {
      if (disposed) return
      modelProgress.value = progress
      engine?.requestRender()
    }
  )
  if (disposed) return
  readDimensions()
  engine?.refreshBounds()
}

// The parent re-parses the footprint after every command, so this fires on each
// edit — moving a pad updates the preview board under the part.
watch(
  () => props.footprint,
  (next, previous) => {
    // Another part entirely (a preview stepping through a library) is framed
    // afresh; the same part re-parsed after an edit keeps the camera.
    if (next?.name !== previous?.name) framed = false
    void rebuild()
  }
)

watch(
  () => options.value,
  (next, previous) => {
    scene?.setOptions(next)
    engine?.setGaugeVisible(next.gauge)
    stats.value = scene?.getStats() ?? defaultBoard3DStats()
    engine?.refreshBounds()
    engine?.requestRender()
    if (previous && next.models !== previous.models) void reloadModels()
  }
)

const fitView = (): void => engine?.fitView()
const setView = (preset: ViewPreset): void => engine?.setView(preset)

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
  scene = new BoardScene3D()
  loader = new ComponentModelLoader(scene.components)
  engine.setModel(scene.root, false)
  engine.setGaugeVisible(options.value.gauge)
  void rebuild()
})

onBeforeUnmount(() => {
  disposed = true
  loader?.dispose()
  loader = null
  engine?.destroy()
  engine = null
  scene?.dispose()
  scene = null
})
</script>

<template>
  <div class="footprint-viewport-3d">
    <div ref="container" class="model-canvas" :class="{ hidden: !hasFootprint }"></div>

    <!-- The camera, on the left rail: identical to the board's 3D view. -->
    <div v-if="hasFootprint" class="canvas-floating-toolbar toolbar-left-rail rail-solo">
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
        :title="t('modelViewer.topViewTitle')"
        @click="setView('top')"
      >
        <Icon name="cube-top" />
      </button>
      <button
        class="floating-btn tool-btn"
        :title="t('pcbEditor.viewport3d.bottomViewTitle')"
        @click="setView('bottom')"
      >
        <Icon name="cube-bottom" />
      </button>
      <button
        class="floating-btn tool-btn"
        :title="t('modelViewer.frontViewTitle')"
        @click="setView('front')"
      >
        <Icon name="cube-front" />
      </button>
    </div>

    <div v-if="hasFootprint && dimensions && !bare" class="dims-pill">
      {{
        t('modelViewer.dims', {
          x: formatMm(dimensions.x),
          y: formatMm(dimensions.y),
          z: formatMm(dimensions.z)
        })
      }}
    </div>

    <div
      v-if="hasFootprint && (isBuilding || modelsPending || notices.length)"
      class="status-stack"
    >
      <div v-if="isBuilding" class="status-pill">
        <span class="spinner"></span>
        <span>{{ t('pcbEditor.viewport3d.building') }}</span>
      </div>
      <div v-else-if="modelsPending" class="status-pill progress">
        <span>
          {{
            t('pcbEditor.viewport3d.loadingModels', {
              settled: modelProgress.placed + modelProgress.missing,
              total: modelProgress.total
            })
          }}
        </span>
        <span class="progress-track">
          <span
            class="progress-fill"
            :style="{ width: Math.round(modelProgressFraction * 100) + '%' }"
          ></span>
        </span>
      </div>
      <div
        v-for="notice in notices"
        :key="notice.text"
        class="status-pill notice"
        :class="{ detailed: !!notice.detail }"
        :title="notice.detail"
      >
        {{ notice.text }}
      </div>
    </div>

    <div v-if="!hasFootprint" class="viewport-3d-card-wrap">
      <div class="glass-card">
        <div class="icon-badge"><CubeIcon /></div>
        <h2>{{ t('footprintEditor.viewport3d.title') }}</h2>
        <p class="status-msg">{{ t('footprintEditor.viewport3d.noFootprintMsg') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.footprint-viewport-3d {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  /* The app's 3D-surface treatment, shared with the board view and the model
     viewer. */
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

.model-canvas.hidden {
  visibility: hidden;
}

.tool-btn svg {
  width: 15px;
  height: 15px;
}

.dims-pill {
  position: absolute;
  left: 12px;
  bottom: 12px;
  padding: 4px 10px;
  background: var(--vscode-overlay);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 6px;
  color: var(--vscode-text-muted, #748780);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-body-sm);
  pointer-events: none;
}

/* Progress and warnings stack above the dimension pill, sharing its corner. */
.status-stack {
  position: absolute;
  left: 12px;
  bottom: 40px;
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-start;
  gap: 6px;
  pointer-events: none;
}

.status-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: var(--vscode-overlay-strong);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 6px;
  color: var(--vscode-text, #c5d3cd);
  font-size: var(--text-body-sm);
}

.status-pill.progress {
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  min-width: 150px;
}

.progress-track {
  height: 3px;
  border-radius: 2px;
  background: var(--vscode-overlay-control-hover);
  overflow: hidden;
}

.progress-fill {
  display: block;
  height: 100%;
  background: var(--vscode-accent, #cca250);
}

@media (prefers-reduced-motion: no-preference) {
  .progress-fill {
    transition: width 120ms linear;
  }
}

.status-pill.notice {
  color: var(--vscode-text-muted, #748780);
}

.status-pill.notice.detailed {
  pointer-events: auto;
  cursor: help;
}

.spinner {
  width: 11px;
  height: 11px;
  border: 1.5px solid var(--vscode-border, #24302b);
  border-top-color: var(--vscode-accent, #cca250);
  border-radius: 50%;
}

@media (prefers-reduced-motion: no-preference) {
  .spinner {
    animation: spin 0.9s linear infinite;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Nothing parsed yet (still loading, or the file would not parse). */
.viewport-3d-card-wrap {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.glass-card {
  background: var(--vscode-overlay-muted);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--vscode-accent-border);
  border-radius: 16px;
  width: 100%;
  max-width: 420px;
  padding: 32px;
  text-align: center;
  box-shadow: 0 12px 40px var(--vscode-shadow-float);
}

.icon-badge {
  display: flex;
  justify-content: center;
  margin-bottom: 14px;
  color: var(--vscode-accent, #cca250);
}

.icon-badge :deep(svg) {
  width: 34px;
  height: 34px;
}

.glass-card h2 {
  font-size: 15px;
  font-weight: 700;
  color: var(--vscode-accent, #cca250);
  margin-bottom: 6px;
}

.status-msg {
  font-size: 12px;
  color: var(--vscode-text-muted, #748780);
}
</style>
