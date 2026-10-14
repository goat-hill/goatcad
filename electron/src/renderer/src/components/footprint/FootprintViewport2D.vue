<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import * as THREE from 'three'
import {
  ViewportEngine,
  GridSettings,
  STANDARD_GRID_APPEARANCE
} from '../../lib/engine/ViewportEngine'
import { FootprintScene, type FootprintSketch } from '../../lib/engine/FootprintScene'
import { footprintGestureTool, type FootprintTool } from '../../lib/footprint/footprintTools'
import {
  graphicDefaults,
  pcbToolShape,
  previewToScene,
  shapePreviewPrimitives,
  takesLineMode
} from '../../lib/board/pcbTools'
import { constrainChainPoint, type LineMode } from '../../lib/lineMode'
import type { ViewCommand } from '../../lib/viewCommands'
import { mmToNm, nmToMm, type Nm } from '../../lib/kicad/coordinates'
import { KicadFootprint } from '../../lib/kicad/footprint'
import type { NonActiveLayerDisplay } from '../../lib/board/layerPresets'
import { loadCamera, saveCamera, type CameraState2D } from '../../lib/engine/cameraStore'
import { loadClipper } from '../../lib/geometry/clip'
import { resolveHit } from '../../lib/selectionResolve'
import { useCanvasSelection } from '../../lib/canvasSelection'
import { footprintItemAnchors, footprintSnapTargets, type AnchorPoint } from '../../lib/moveAnchors'
import { expandLayerToken } from '../../lib/kicad/layers'
import { footprintItemLabel } from '../../lib/footprint/footprintItemLabel'
import SelectOtherMenu from '../shared/SelectOtherMenu.vue'
import { useSelectionFilter } from '../../lib/selectionFilter'
import { useAppTheme } from '../../lib/theme'
import SelectionFilterControl from '../shared/SelectionFilterControl.vue'
import GridSettingsControl from '../shared/GridSettingsControl.vue'
import ViewportStatusBar, { type StatusCoords } from '../shared/ViewportStatusBar.vue'
import { measureViewportInsets } from '../../lib/engine/viewportInsets'
import { findingMarkersLayer, type DocumentMarker } from '../../lib/engine/findingMarkersLayer'
import { MARKER_UNIT_MM } from '../../lib/engine/FindingMarkers'

const props = defineProps<{
  footprint: KicadFootprint | null
  revision?: number
  selectedPadIndex: number | null
  selectedLineIndex: number | null
  selectedPolyIndex: number | null
  selectedItems: Array<{ type: string; index: number }>
  gridSettings: GridSettings
  /**
   * A non-interactive render of the document (the Component view's panes),
   * as opposed to an editor. Distinct from a read-only FILE, where selecting
   * still works and the filter still earns its place.
   */
  preview?: boolean
  /** No status pills at all — not even the readouts — where the canvas is a thumbnail (the library chooser). */
  bare?: boolean
  layerVisibility: Record<string, boolean>
  activeLayer?: string
  nonActiveDisplay?: NonActiveLayerDisplay
  /** Outline-only modes per item class (lib/footprintView.ts); omit for none. */
  sketch?: FootprintSketch
  filePath?: string | null
  /** The armed insert tool; the engine's own select and drag stand down while one is. */
  activeTool?: FootprintTool
  /** The points a chain tool has collected so far, in file space (nm, y-down). */
  toolDraft?: Array<{ x: Nm; y: Nm }>
  /** Where the grid is laid from, file space (nm, y-down); the anchor when omitted. */
  gridOrigin?: { x: Nm; y: Nm }
  /** The line mode the next point takes (lib/lineMode.ts); omit for free. */
  lineMode?: LineMode
  /** The checks' findings to mark on the canvas, mm, y down. */
  findingMarkers?: readonly DocumentMarker[]
}>()

const emit = defineEmits<{
  (e: 'tool-click', point: { x: Nm; y: Nm }): void
  /** A finding's canvas marker was clicked, by its finding's key. */
  (e: 'finding-marker', key: string): void
  (e: 'tool-finish'): void
  /**
   * Right-click with no tool armed: where, and what is under the cursor
   * (the editor selects it before its menu opens).
   */
  (
    e: 'context-menu',
    payload: {
      clientX: number
      clientY: number
      hit: { type: string; index: number } | null
    }
  ): void
  (e: 'select-pad', index: number | null): void
  (e: 'select-line', index: number | null): void
  (e: 'select-poly', index: number | null): void
  (e: 'update:selectedItems', items: Array<{ type: string; index: number }>): void
  (e: 'update-grid', settings: Partial<GridSettings>): void
  (e: 'drag-start', type: 'object' | 'vertex', info?: Record<string, unknown>): void
  (e: 'drag-move', delta: { x: number; y: number }): void
  (e: 'drag-end'): void
}>()

const { allows } = useSelectionFilter('footprint')
const { t } = useI18n()
const appTheme = useAppTheme()

type FootprintItemRef = { type: string; index: number }

const viewportContainer = ref<HTMLDivElement | null>(null)
/** Snapped cursor in engine space (mm, y-up), for a key that acts as a click. */
let lastSnapped = { x: NaN, y: NaN }
/** A key gesture must not act on a stale point from before the mouse left. */
let pointerInside = false
const onContainerMouseEnter = (): void => {
  pointerInside = true
}
const onContainerMouseLeave = (): void => {
  pointerInside = false
}
/** The snapped cursor in file space (nm, y-down) as a tool click reports it,
 *  or null when the pointer is not over the canvas. */
const getCursor = (): { x: Nm; y: Nm } | null =>
  pointerInside && Number.isFinite(lastSnapped.x)
    ? { x: mmToNm(lastSnapped.x), y: mmToNm(-lastSnapped.y) }
    : null

/**
 * The armed tool's ghost: the shape the next click would commit, live under
 * the cursor. The same `pcbToolShape` the commit uses, so the two cannot
 * disagree; an unfinished polygon previews as its open edges.
 */
const refreshDraftPreview = (): void => {
  if (!sceneBuilder || !engine) return
  const layer = props.activeLayer ?? 'F.SilkS'
  const gesture = footprintGestureTool(props.activeTool ?? 'select')
  const draft = props.toolDraft ?? []
  if (!gesture || draft.length === 0) {
    sceneBuilder.setDraftPreview(null, 0, layer)
    engine.render()
    return
  }
  const cursor = getCursor()
  const live =
    cursor && takesLineMode(gesture)
      ? constrainChainPoint(props.lineMode ?? 'free', draft, cursor)
      : cursor
  const pts = live ? [...draft, live] : [...draft]
  let shape = pcbToolShape(gesture, pts)
  if (!shape && gesture === 'polygon') shape = pcbToolShape('line', pts)
  sceneBuilder.setDraftPreview(
    shape ? previewToScene(shapePreviewPrimitives(shape)) : null,
    nmToMm(graphicDefaults(layer).lineWidth),
    layer
  )
  engine.render()
}

/** The snapped cursor in file space (nm, y-down). */
const snappedFilePoint = (): { x: Nm; y: Nm } => ({
  x: mmToNm(engine?.mouseSnapped.x ?? 0),
  y: mmToNm(-(engine?.mouseSnapped.y ?? 0))
})

// Tool clicks are taken in the capture phase, so the engine's own select and
// drag never see them — the schematic viewport's guard, reused.
const markersLayer = findingMarkersLayer(
  toRef(props, 'findingMarkers'),
  (x, y) => ({ x, y: -y }),
  MARKER_UNIT_MM.board
)

const onMouseDownCapture = (e: MouseEvent): void => {
  if ((props.activeTool ?? 'select') === 'select' && e.button === 0 && !e.ctrlKey && !e.metaKey) {
    const key = markersLayer.hitAt(e)
    if (key) {
      e.stopPropagation()
      e.preventDefault()
      emit('finding-marker', key)
      return
    }
  }
  if ((props.activeTool ?? 'select') === 'select' || !engine) return
  if (e.button === 1 || ((e.ctrlKey || e.metaKey) && e.button === 0)) return // pan
  e.stopPropagation()
  e.preventDefault()
  if (e.button === 2) {
    emit('tool-finish')
    return
  }
  if (e.button !== 0) return
  emit('tool-click', snappedFilePoint())
}

// Click, band, pointer and Select Other: one model for every 2D editor
// (lib/canvasSelection.ts). The footprint's scene ranks and sweeps; the
// policy and the user's filter resolve.
const selection = useCanvasSelection<FootprintItemRef>({
  engine: () => engine,
  filterEditor: 'footprint',
  pointCandidates: (point, radius) => sceneBuilder?.hitCandidates(point, radius) ?? [],
  boxCandidates: (bounds, crossing) => sceneBuilder?.boxCandidates(bounds, crossing) ?? [],
  allows: () => allows.value,
  key: (ref) => `${ref.type}:${ref.index}`,
  selected: () => props.selectedItems,
  select: (items) => emit('update:selectedItems', items),
  active: () => (props.activeTool ?? 'select') === 'select' && !props.preview
})
const { itemAtCursor, selectOther } = selection

const labelFootprintItem = (ref: FootprintItemRef): string =>
  props.footprint ? footprintItemLabel(props.footprint, ref, t) : ref.type

const onContextMenu = (e: MouseEvent): void => {
  e.preventDefault()
  // With a tool armed, right-click puts it away — the capture-phase mousedown
  // already said so — and the menu stays shut.
  if ((props.activeTool ?? 'select') !== 'select' || props.preview) return
  emit('context-menu', { clientX: e.clientX, clientY: e.clientY, hit: itemAtCursor() })
}

/** The grid origin carried from file space into the engine's (mm, y up). */
const applyGridOrigin = (): void => {
  const origin = props.gridOrigin
  engine?.setGridOrigin(origin ? nmToMm(origin.x) : 0, origin ? -nmToMm(origin.y) : 0)
}
const onDblClickCapture = (e: MouseEvent): void => {
  if ((props.activeTool ?? 'select') === 'select') return
  e.stopPropagation()
  e.preventDefault()
  emit('tool-finish')
}
let engine: ViewportEngine | null = null
let sceneBuilder: FootprintScene | null = null

/**
 * Where the pointer last was, already in footprint (file) orientation. Seeded at the
 * origin rather than left empty so the readout is present from the first frame:
 * a pill that materializes on the first mouse move reads as the panel changing
 * shape, and 0,0 is the honest answer before the pointer has been anywhere.
 */
const cursor = ref({ x: 0, y: 0 })
const statusCoords = computed<StatusCoords>(() => ({
  ...cursor.value,
  unit: props.gridSettings.unit,
  spacing: props.gridSettings.snap ? props.gridSettings.spacing : undefined
}))

let lastSeenFilePath: string | null | undefined = undefined

/**
 * What a footprint's framing is filed under, or null when there is none to
 * file: a preview is sized to the pane it sits in, and saving its camera would
 * hand the editor the thumbnail's frame the next time that file is opened.
 */
const cameraKey = (path: string | null | undefined): string | null =>
  props.preview ? null : (path ?? null)

const rememberCamera = (path: string | null | undefined): void => {
  const key = cameraKey(path)
  if (key && engine) saveCamera(key, engine.getCameraState2D())
}

const rememberedCamera = (path: string | null | undefined): CameraState2D | null => {
  const key = cameraKey(path)
  return (key && loadCamera(key)) || null
}

// Zoom to fit the whole footprint; middle-double-click (engine.onResetView)
// and the editor's fit hotkey both land here.
const zoomToFit = (): void => {
  if (!props.footprint || !sceneBuilder || !engine) return
  const bounds = sceneBuilder.rebuild(
    props.footprint,
    props.layerVisibility,
    props.activeLayer,
    props.nonActiveDisplay
  )
  sceneBuilder.highlightSelection(props.selectedItems)
  sceneBuilder.renderVertexHandles(props.selectedItems)
  engine.zoomToFit(bounds)
}

/** What floats over the footprint canvas, kept clear by a reveal. */
const FOOTPRINT_CHROME = ['.viewport-status-corner', '.canvas-floating-toolbar']
/** Smallest extent a reveal frames, mm: a lone small pad is not blown up to fill the view. */
const FOCUS_MIN_EXTENT_MM = 2

/** A picked finding's box in footprint space (nm, y down): centered, or with `zoom`, framed close. */
const showFinding = (
  box: { minX: number; minY: number; maxX: number; maxY: number },
  zoom: boolean
): void => {
  const w = nmToMm((box.maxX - box.minX) as Nm)
  const h = nmToMm((box.maxY - box.minY) as Nm)
  engine?.showPoint(
    nmToMm(((box.minX + box.maxX) / 2) as Nm),
    -nmToMm(((box.minY + box.maxY) / 2) as Nm),
    zoom,
    Math.max(FOCUS_MIN_EXTENT_MM, w, h)
  )
}

/** Reveal a box in footprint space (nm, y down), as the other editors reveal a selection. */
const focusBox = (box: { minX: number; minY: number; maxX: number; maxY: number }): void => {
  if (!engine) return
  engine.bringIntoView(
    new THREE.Box3(
      new THREE.Vector3(nmToMm(box.minX as Nm), -nmToMm(box.maxY as Nm), 0),
      new THREE.Vector3(nmToMm(box.maxX as Nm), -nmToMm(box.minY as Nm), 0)
    ),
    {
      insets: measureViewportInsets(
        viewportContainer.value,
        FOOTPRINT_CHROME,
        viewportContainer.value?.closest<HTMLElement>('.viewport-host-area')
      ),
      minExtent: FOCUS_MIN_EXTENT_MM
    }
  )
}

onMounted(async () => {
  // A custom pad draws as one merged outline (`lib/board/padCopper.ts`): the
  // scene waits for the geometry engine, started at launch, before it builds.
  await loadClipper()
  if (unmounted || !viewportContainer.value) return

  engine = new ViewportEngine(viewportContainer.value)
  engine.setViewOnly(!!props.preview)
  engine.setSnapCrosshair(true)
  viewportContainer.value.addEventListener('mouseenter', onContainerMouseEnter)
  viewportContainer.value.addEventListener('mouseleave', onContainerMouseLeave)
  // A viewport can mount with a tool already armed (a view switch keeps the
  // editor's tool state), so the pointer is set here as well as on change.
  engine.setDrawMode((props.activeTool ?? 'select') !== 'select')
  sceneBuilder = new FootprintScene(engine.scene)
  if (props.sketch) sceneBuilder.setSketch(props.sketch)
  sceneBuilder.setRebuiltCallback(() => {
    // A rebuild resets the batch, ghost included; put it back once the build has settled.
    queueMicrotask(refreshDraftPreview)
  })
  sceneBuilder.applyTheme(appTheme.value)
  // Handles are chrome: constant on-screen size, not world size.
  for (const t of sceneBuilder.screenScaledTargets()) engine.registerScreenScaled(t)
  markersLayer.install(engine)

  engine.setGridSettings(props.gridSettings)
  applyGridOrigin()
  engine.setGridAppearance(STANDARD_GRID_APPEARANCE)
  engine.applyTheme()

  // Selection resolves through the editor's policy and the user's filter.
  engine.setCustomHitTest((point, threshold) => {
    if (!sceneBuilder) return null
    return resolveHit(sceneBuilder.hitCandidates(point, threshold), allows.value)
  })

  engine.setSelectedKeys(new Set(props.selectedItems.map((item) => `${item.type}:${item.index}`)))
  selection.install(engine)

  engine.onMouseMoveCoords((worldPos, snappedPos) => {
    // Footprint space is y-down against the engine's y-up, so the reported
    // point negates — a readout states FILE coordinates. It is the point the
    // editor would ACT on: snapped while snap is on, the raw cursor otherwise.
    const point = props.gridSettings.snap ? snappedPos : worldPos
    cursor.value = { x: point.x, y: -point.y }
    lastSnapped = { x: snappedPos.x, y: snappedPos.y }
    if ((props.activeTool ?? 'select') !== 'select') refreshDraftPreview()
  })

  // Where a move grabs and what it snaps to (lib/moveAnchors.ts).
  const world = (p: AnchorPoint): THREE.Vector2 =>
    new THREE.Vector2(nmToMm(p.x as Nm), -nmToMm(p.y as Nm))
  engine.onDragAnchors(() =>
    props.footprint
      ? props.selectedItems.flatMap((ref) => footprintItemAnchors(props.footprint!, ref).map(world))
      : []
  )
  engine.onDragTargets(() => {
    const active = props.activeLayer
    return props.footprint && active
      ? footprintSnapTargets(props.footprint, props.selectedItems, (layers) =>
          layers.some((layer) => expandLayerToken(layer).includes(active))
        ).map(world)
      : []
  })
  engine.onDragStart((type, info) => {
    emit('drag-start', type, info)
  })

  engine.onDragMove((delta) => {
    emit('drag-move', { x: delta.x, y: delta.y })
  })

  engine.onDragEnd(() => {
    emit('drag-end')
  })

  engine.onResetView(zoomToFit)
  // See PcbViewport2D: a window that closes never unmounts its components.
  engine.onViewChanged(() => {
    rememberCamera(props.filePath)
  })

  // 5. Draw the initial footprint
  lastSeenFilePath = props.filePath
  if (props.footprint) {
    const bounds = sceneBuilder.rebuild(
      props.footprint,
      props.layerVisibility,
      props.activeLayer,
      props.nonActiveDisplay
    )
    sceneBuilder.highlightSelection(props.selectedItems)
    sceneBuilder.renderVertexHandles(props.selectedItems)

    const savedState = rememberedCamera(props.filePath)
    if (savedState) {
      engine.setCameraState2D(savedState)
    } else {
      engine.zoomToFit(bounds)
    }
  }

  engine.render()
})

let unmounted = false
onUnmounted(() => {
  unmounted = true
  viewportContainer.value?.removeEventListener('mouseenter', onContainerMouseEnter)
  viewportContainer.value?.removeEventListener('mouseleave', onContainerMouseLeave)
  if (engine) {
    rememberCamera(lastSeenFilePath)
    markersLayer.dispose()
    sceneBuilder?.dispose()
    engine.destroy()
    engine = null
    sceneBuilder = null
  }
})

// Watchers for reactive updates
watch(
  () => props.footprint,
  (newFp) => {
    if (newFp && sceneBuilder && engine) {
      rememberCamera(lastSeenFilePath)

      const bounds = sceneBuilder.rebuild(
        newFp,
        props.layerVisibility,
        props.activeLayer,
        props.nonActiveDisplay
      )
      sceneBuilder.highlightSelection(props.selectedItems)
      sceneBuilder.renderVertexHandles(props.selectedItems)

      if (props.filePath !== lastSeenFilePath) {
        const savedState = rememberedCamera(props.filePath)
        if (savedState) {
          engine.setCameraState2D(savedState)
          engine.render()
        } else {
          engine.zoomToFit(bounds)
        }
        lastSeenFilePath = props.filePath
      } else {
        engine.render()
      }
    }
  }
)

watch(
  () => props.revision,
  () => {
    if (props.footprint && sceneBuilder && engine) {
      sceneBuilder.rebuild(
        props.footprint,
        props.layerVisibility,
        props.activeLayer,
        props.nonActiveDisplay
      )
      sceneBuilder.highlightSelection(props.selectedItems)
      sceneBuilder.renderVertexHandles(props.selectedItems)
      engine.render()
    }
  }
)

watch(
  () => props.layerVisibility,
  (newVisibility) => {
    if (props.footprint && sceneBuilder && engine) {
      sceneBuilder.rebuild(
        props.footprint,
        newVisibility,
        props.activeLayer,
        props.nonActiveDisplay
      )
      sceneBuilder.highlightSelection(props.selectedItems)
      sceneBuilder.renderVertexHandles(props.selectedItems)
      engine.render()
    }
  },
  { deep: true }
)

watch(
  () => props.activeLayer,
  (newActiveLayer) => {
    if (props.footprint && sceneBuilder && engine) {
      sceneBuilder.rebuild(
        props.footprint,
        props.layerVisibility,
        newActiveLayer,
        props.nonActiveDisplay
      )
      sceneBuilder.highlightSelection(props.selectedItems)
      sceneBuilder.renderVertexHandles(props.selectedItems)
      engine.render()
    }
  }
)

watch(
  () => [props.nonActiveDisplay, props.sketch?.pads, props.sketch?.graphics, props.sketch?.text],
  () => {
    if (props.sketch) sceneBuilder?.setSketch(props.sketch)
    if (props.footprint && sceneBuilder && engine) {
      sceneBuilder.rebuild(
        props.footprint,
        props.layerVisibility,
        props.activeLayer,
        props.nonActiveDisplay
      )
      sceneBuilder.highlightSelection(props.selectedItems)
      sceneBuilder.renderVertexHandles(props.selectedItems)
      engine.render()
    }
  }
)

watch(
  () => props.selectedItems,
  (newItems) => {
    if (sceneBuilder && engine) {
      sceneBuilder.highlightSelection(newItems)
      sceneBuilder.renderVertexHandles(newItems)
      engine.setSelectedKeys(new Set(newItems.map((item) => `${item.type}:${item.index}`)))
      engine.render()
    }
  },
  { deep: true }
)

watch(
  () => props.gridSettings,
  (newSettings) => {
    if (engine) {
      engine.setGridSettings(newSettings)
    }
  },
  { deep: true }
)
watch(() => [props.gridOrigin?.x, props.gridOrigin?.y], applyGridOrigin)
watch(
  () => props.activeTool,
  (tool) => {
    engine?.setDrawMode((tool ?? 'select') !== 'select')
    refreshDraftPreview()
  }
)
watch(() => props.toolDraft, refreshDraftPreview, { deep: true })

watch(appTheme, (theme) => {
  engine?.applyTheme()
  sceneBuilder?.applyTheme(theme)
  if (props.footprint && sceneBuilder && engine) {
    sceneBuilder.rebuild(
      props.footprint,
      props.layerVisibility,
      props.activeLayer,
      props.nonActiveDisplay
    )
    sceneBuilder.highlightSelection(props.selectedItems)
    sceneBuilder.renderVertexHandles(props.selectedItems)
    engine.render()
  }
})

// Expose optimized drag methods for the parent to call directly,
// bypassing the full-rebuild revision watcher path.
/** Bring the selection into view as a reveal does: a find hit, say. */
const revealSelection = (): void => {
  if (!engine || !sceneBuilder) return
  const bounds = sceneBuilder.selectionBounds(props.selectedItems)
  if (bounds.isEmpty()) return
  engine.bringIntoView(bounds, {
    insets: measureViewportInsets(
      viewportContainer.value,
      FOOTPRINT_CHROME,
      viewportContainer.value?.closest<HTMLElement>('.viewport-host-area')
    ),
    minExtent: FOCUS_MIN_EXTENT_MM
  })
}

/** Zoom in / out, center on cursor, zoom to selection (`lib/viewCommands.ts`). */
const runViewCommand = (command: ViewCommand): void => {
  if (!engine) return
  if (command === 'zoomIn' || command === 'zoomOut') engine.zoomStep(command === 'zoomIn' ? 1 : -1)
  else if (command === 'centerOnCursor') engine.centerOnCursor()
  else if (sceneBuilder)
    engine.frameBounds(sceneBuilder.selectionBounds(props.selectedItems), FOCUS_MIN_EXTENT_MM)
}

defineExpose({
  getCursor,
  focusBox,
  showFinding,
  runViewCommand,
  selectOtherAt: selection.selectOtherAt,
  revealSelection,
  /** Every item the selection filter allows — Select All. */
  selectAll(): FootprintItemRef[] {
    return selection.selectAll()
  },
  itemAtCursor,
  /** Where the running move grabbed what it moves, footprint nm before it moved; null when none runs. */
  dragAnchorStart(): { x: Nm; y: Nm } | null {
    const at = engine?.dragAnchorStart()
    return at ? { x: mmToNm(at.x), y: mmToNm(-at.y) } : null
  },
  /** KiCad's Move (M): what the editor picked up follows the pointer until a click drops it. */
  startHeldMove(): boolean {
    return engine?.beginHeldDrag({ held: true }) ?? false
  },
  /** Abandon a held move, nothing dropped; false when none is running. */
  cancelHeldMove(): boolean {
    return engine?.cancelDrag() ?? false
  },
  /** Snapshot element positions at drag start */
  saveDragOrigins(items: Array<{ type: string; index: number }>): void {
    sceneBuilder?.saveDragOrigins(items)
  },
  /** Clear snapshots at drag end */
  clearDragOrigins(): void {
    sceneBuilder?.clearDragOrigins()
  },
  /** Move elements by position only (zero allocation) */
  translateElements(
    items: Array<{ type: string; index: number }>,
    delta: { x: number; y: number }
  ): void {
    if (sceneBuilder && engine) {
      sceneBuilder.translateElements(items, delta)
      engine.render()
    }
  },
  /** Rebuild a single element for vertex drags */
  rebuildSingleElement(
    type: string,
    index: number,
    fp: KicadFootprint,
    selectedItems: Array<{ type: string; index: number }>
  ): void {
    if (sceneBuilder && engine) {
      sceneBuilder.rebuildSingleElement(type, index, fp, props.layerVisibility, selectedItems)
      engine.render()
    }
  },
  /** Full rebuild + render (used on drag-end to sync scene with final data model) */
  rebuildAndRender(): void {
    if (props.footprint && sceneBuilder && engine) {
      sceneBuilder.rebuild(
        props.footprint,
        props.layerVisibility,
        props.activeLayer,
        props.nonActiveDisplay
      )
      sceneBuilder.highlightSelection(props.selectedItems)
      sceneBuilder.renderVertexHandles(props.selectedItems)
      engine.render()
    }
  },
  zoomToFit
})
</script>

<template>
  <div class="viewport-2d-layout">
    <!-- The floating toolbar lives in FootprintEditor.vue so it survives the
         2D/3D view switch -->

    <!-- Main WebGL/WebGPU render host container -->
    <div
      ref="viewportContainer"
      class="canvas-host-container"
      @mousedown.capture="onMouseDownCapture"
      @dblclick.capture="onDblClickCapture"
      @contextmenu="onContextMenu"
    ></div>

    <SelectOtherMenu
      v-if="selectOther"
      :items="selectOther.items"
      :label="labelFootprintItem"
      :x="selectOther.x"
      :y="selectOther.y"
      @preview="selection.previewSelectOther"
      @commit="selection.closeSelectOther"
      @cancel="selection.closeSelectOther()"
    />

    <ViewportStatusBar v-if="!bare" :coords="statusCoords">
      <GridSettingsControl
        editor="footprint"
        :grid-settings="gridSettings"
        @update-grid="(g) => emit('update-grid', g)"
      />
      <SelectionFilterControl v-if="!preview" editor="footprint" />
      <slot v-if="!preview" name="status" />
    </ViewportStatusBar>
  </div>
</template>

<style scoped>
.viewport-2d-layout {
  position: relative;
  width: 100%;
  height: 100%;
  background-color: var(--vscode-bg-viewport);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.canvas-host-container {
  flex: 1;
  width: 100%;
  height: 100%;
}
</style>
