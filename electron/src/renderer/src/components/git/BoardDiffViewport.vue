<script setup lang="ts">
/**
 * A board drawn for the visual diff: view-only, painted by
 * `BoardScene.applyDiffPaint`, with the board editor's view rail and its
 * properties panel in the shell's right rail, in review (`PcbPropertiesPanel`).
 * A click picks one item for the panel; nothing moves.
 *
 * Zone fills start off — a refill repaints whole pours on any copper change
 * and would bury the tracks that did change — and net names stay off, since a
 * removed track's net may name another net in this board. The copper sketch
 * modes and board-area tint are the editor's own app-wide switches
 * (`lib/pcbView.ts`); layers, the inactive-layer display, flip and fills are
 * this tab's alone.
 *
 * Not `PcbViewport2D`: that is the editor's canvas, and nearly all of it
 * (tools, routing, selection, 3D) has no meaning here.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type * as THREE from 'three'
import type { KicadBoard } from '../../lib/kicad/board'
import { BoardScene, type BoardDiffPaint, type BoardItemRef } from '../../lib/engine/BoardScene'
import { STANDARD_GRID_APPEARANCE, ViewportEngine } from '../../lib/engine/ViewportEngine'
import { NETNAMES_PSEUDO_LAYER } from '../../lib/kicad/layers'
import { loadClipper } from '../../lib/geometry/clip'
import { useAppTheme } from '../../lib/theme'
import { pcbViewState, setPcbView } from '../../lib/pcbView'
import { boardLayerListing } from '../../lib/board/layerListing'
import type { NonActiveLayerDisplay } from '../../lib/board/layerPresets'
import { useContextPanels } from '../../lib/editorWorkspace'
import { resolveHit } from '../../lib/selectionResolve'
import { useSelectionFilter } from '../../lib/selectionFilter'
import { PCB_GRID_DEFAULTS, useGridSettings } from '../../lib/gridPreferences'
import type { PropertyGroup } from '../../lib/propertyTable'
import { panelWidth, setPanelWidth } from '../../lib/panelLayout'
import FitViewButton from '../shared/FitViewButton.vue'
import Icon from '../shared/Icon.vue'
import PcbPropertiesPanel from '../pcb/PcbPropertiesPanel.vue'
import NonActiveDisplayButton from '../shared/NonActiveDisplayButton.vue'
import ResizeHandle from '../shared/ResizeHandle.vue'
import SelectionFilterControl from '../shared/SelectionFilterControl.vue'
import ViewportStatusBar, { type StatusCoords } from '../shared/ViewportStatusBar.vue'

const { t } = useI18n()

const props = defineProps<{
  board: KicadBoard
  paint: BoardDiffPaint
  /** Bumped when the versions are re-read, so the scene rebuilds. */
  revision: number
  /** The picked item, as `board` indexes it. */
  selectedItems: BoardItemRef[]
  /** The properties panel's table, the picked item's as both versions have it. */
  groups: PropertyGroup[]
}>()

const emit = defineEmits<{
  (e: 'update:selectedItems', items: BoardItemRef[]): void
}>()

/** Distances read in the board editor's unit. */
const gridSettings = useGridSettings('pcb', PCB_GRID_DEFAULTS)
const { allows } = useSelectionFilter('pcb')

/** Where the pointer is, in the file's orientation: X back from a flip, Y down. */
const cursor = ref({ x: 0, y: 0 })
const statusCoords = computed<StatusCoords>(() => ({
  ...cursor.value,
  unit: gridSettings.value.unit
}))

const container = ref<HTMLDivElement | null>(null)
const appTheme = useAppTheme()
const pcbView = pcbViewState()
let engine: ViewportEngine | null = null
let scene: BoardScene | null = null
let bounds: THREE.Box3 | null = null

// ---- View state ------------------------------------------------------------

const listing = computed(() =>
  boardLayerListing(props.board, (key) => t(`shared.layerPresets.${key}`))
)
/** Every listed layer shown, until the Layers panel says otherwise. */
const layerVisibility = ref<Record<string, boolean>>({})
watch(
  listing,
  (next) => {
    const seen = layerVisibility.value
    layerVisibility.value = Object.fromEntries(
      next.layers.map(({ name }) => [name, seen[name] ?? true])
    )
  },
  { immediate: true }
)
const activeLayer = ref('F.Cu')
const nonActiveDisplay = ref<NonActiveLayerDisplay>('show')
const flipped = ref(false)
const zoneFills = ref(false)

const toggleLayer = (layer: string): void => {
  layerVisibility.value = { ...layerVisibility.value, [layer]: !layerVisibility.value[layer] }
}
const setActiveLayer = (layer: string): void => {
  activeLayer.value = layer
  layerVisibility.value = { ...layerVisibility.value, [layer]: true }
}
const applyPreset = (visibility: Record<string, boolean>): void => {
  const next = { ...layerVisibility.value }
  for (const [layer, on] of Object.entries(visibility)) if (layer in next) next[layer] = on
  layerVisibility.value = next
}

const { show: showPanels, inline: panelsInline, rail: panelRail } = useContextPanels()
const railWidth = panelWidth()
let railResizeStart = 0

// ---- Scene -------------------------------------------------------------------

const build = (fit: boolean): void => {
  if (!engine || !scene) return
  const view = pcbView.value
  bounds = scene.rebuild(
    props.board,
    { ...layerVisibility.value, [NETNAMES_PSEUDO_LAYER]: false },
    activeLayer.value,
    {
      nonActiveDisplay: nonActiveDisplay.value,
      flipped: flipped.value,
      zoneFills: zoneFills.value,
      sketchTracks: view.sketchTracks,
      sketchVias: view.sketchVias,
      sketchPads: view.sketchPads,
      boardArea: view.boardArea,
      fpReferences: view.fpReferences,
      fpValues: view.fpValues,
      fpText: view.fpText
    }
  )
  scene.applyDiffPaint(props.paint)
  scene.highlightSelection(props.selectedItems)
  if (fit) engine.zoomToFit(bounds)
  else engine.render()
}

const fit = (): void => {
  if (bounds) engine?.zoomToFit(bounds)
}

let unmounted = false
onMounted(async () => {
  // Custom pads draw as one merged outline: the scene waits for the geometry engine.
  await loadClipper()
  if (unmounted || !container.value) return
  engine = new ViewportEngine(container.value)
  engine.setViewOnly(true)
  scene = new BoardScene(engine.scene)
  engine.setCompositeLayers(scene.compositeLayers())
  scene.applyTheme(appTheme.value)
  scene.setDeferredGeometryCallback(() => engine?.render())
  engine.setGridSettings({ spacing: 1, unit: 'mm', visible: false, snap: false })
  engine.setGridAppearance(STANDARD_GRID_APPEARANCE)
  engine.applyTheme()
  engine.setCustomHitTest(() => null)
  engine.onMouseMoveCoords((world) => {
    cursor.value = { x: flipped.value ? -world.x : world.x, y: -world.y }
  })
  engine.onViewClick((point) => {
    if (!engine || !scene) return
    const hit = resolveHit(scene.hitCandidates(point, engine.hitRadius()), allows.value)
    emit(
      'update:selectedItems',
      hit
        ? [
            {
              type: hit.type,
              index: hit.index,
              ...(hit.pad !== undefined ? { pad: hit.pad } : {}),
              ...(hit.child !== undefined ? { child: hit.child } : {})
            }
          ]
        : []
    )
  })
  engine.onResetView(fit)
  build(true)
})

onUnmounted(() => {
  unmounted = true
  scene?.dispose()
  engine?.destroy()
  scene = null
  engine = null
})

watch(
  [
    () => props.board,
    () => props.paint,
    () => props.revision,
    layerVisibility,
    activeLayer,
    nonActiveDisplay,
    zoneFills,
    pcbView
  ],
  () => build(false)
)

watch(
  () => props.selectedItems,
  (items) => {
    scene?.highlightSelection(items)
    engine?.render()
  }
)

watch(flipped, () => {
  // Keep the board under the camera as the view mirrors about x = 0.
  if (engine) {
    const state = engine.getCameraState2D()
    engine.setCameraState2D({ ...state, x: -state.x })
  }
  build(false)
})

watch(appTheme, (theme) => {
  scene?.applyTheme(theme)
  engine?.applyTheme()
  build(false)
})
</script>

<template>
  <div class="board-diff">
    <div class="viewport-host-area">
      <div ref="container" class="board-diff-viewport" />
      <!-- The board editor's view rail, less what has no meaning in a diff. -->
      <div class="canvas-floating-toolbar toolbar-left-rail rail-solo">
        <FitViewButton @fit="fit" />
        <div class="toolbar-divider"></div>
        <button
          class="floating-btn tool-btn toggle-btn"
          :class="{ active: !zoneFills }"
          :title="t('pcbEditor.viewRail.zoneOutlines')"
          @click="zoneFills = !zoneFills"
        >
          <Icon name="view-zone-fills" />
        </button>
        <button
          class="floating-btn tool-btn toggle-btn"
          :class="{ active: pcbView.sketchTracks }"
          :title="t('pcbEditor.viewRail.sketchTracks')"
          @click="setPcbView({ sketchTracks: !pcbView.sketchTracks })"
        >
          <Icon name="view-sketch-tracks" />
        </button>
        <button
          class="floating-btn tool-btn toggle-btn"
          :class="{ active: pcbView.sketchVias }"
          :title="t('pcbEditor.viewRail.sketchVias')"
          @click="setPcbView({ sketchVias: !pcbView.sketchVias })"
        >
          <Icon name="view-sketch-vias" />
        </button>
        <button
          class="floating-btn tool-btn toggle-btn"
          :class="{ active: pcbView.sketchPads }"
          :title="t('shared.insertSearch.ops.sketchPads')"
          @click="setPcbView({ sketchPads: !pcbView.sketchPads })"
        >
          <Icon name="view-sketch-pads" />
        </button>
        <button
          class="floating-btn tool-btn toggle-btn"
          :class="{ active: pcbView.boardArea }"
          :title="t('pcbEditor.viewRail.boardArea')"
          @click="setPcbView({ boardArea: !pcbView.boardArea })"
        >
          <Icon name="view-board-area" />
        </button>
        <div class="toolbar-divider"></div>
        <NonActiveDisplayButton v-model:mode="nonActiveDisplay" />
        <button
          class="floating-btn tool-btn toggle-btn"
          :class="{ active: flipped }"
          :title="t('pcbEditor.viewRail.flip')"
          @click="flipped = !flipped"
        >
          <Icon name="view-flip" />
        </button>
      </div>
      <ViewportStatusBar :coords="statusCoords">
        <SelectionFilterControl editor="pcb" pinless />
      </ViewportStatusBar>
    </div>

    <Teleport v-if="showPanels" :to="panelRail" :disabled="panelsInline">
      <aside class="board-diff-panel" :style="{ width: railWidth + 'px' }">
        <ResizeHandle
          edge="left"
          @resize-start="railResizeStart = railWidth"
          @resize="(grow: number) => setPanelWidth(railResizeStart + grow)"
          @resize-end="setPanelWidth(railWidth, true)"
        />
        <PcbPropertiesPanel
          review
          :board="board"
          :property-groups="groups"
          :grid-settings="gridSettings"
          :layer-visibility="layerVisibility"
          :active-layer="activeLayer"
          @toggle-layer-visibility="toggleLayer"
          @set-active-layer="setActiveLayer"
          @apply-layer-preset="applyPreset"
        />
      </aside>
    </Teleport>
  </div>
</template>

<style scoped>
.board-diff {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: row;
}

.viewport-host-area {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
  display: flex;
}

.board-diff-viewport {
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

/* Width inline, the rail's shared one; `relative` places the resize handle. */
.board-diff-panel {
  position: relative;
  flex: none;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--vscode-border);
  background: var(--vscode-bg-sidebar);
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
}
</style>
