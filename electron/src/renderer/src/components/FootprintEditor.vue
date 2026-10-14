<script setup lang="ts">
import { heldMove, withHoverKeys, type HoverSelection } from '../lib/hoverSelection'
import { sameRef } from '../lib/viewportSelection'
import Modal from './shared/Modal.vue'
import { SELECTION_GROUP, intersectGroups } from '../lib/propertyTable'
import { vToolbarFit } from '../lib/canvasToolbar'
import { ref, watch, onMounted, onUnmounted, computed, nextTick, shallowRef } from 'vue'
import { useContextPanels, useGroupKeydown } from '../lib/editorWorkspace'
import { useI18n } from 'vue-i18n'
import {
  serializeKicadFootprint,
  updateFootprintMetaInAST,
  updatePadInAST,
  updateLineInAST,
  updateArcInAST,
  updateCircleInAST,
  updateRectInAST,
  updatePolyInAST,
  updateZoneInAST,
  updatePropertyInAST,
  updateTextInAST,
  KicadFootprint,
  KicadPad,
  KicadFpLine,
  KicadFpArc,
  KicadFpCircle,
  KicadFpRect,
  KicadFpText,
  KicadProperty,
  KicadFpPoly,
  KicadZone,
  SExprList,
  SExprNode,
  addFpArcToFootprintAST,
  addFpCircleToFootprintAST,
  addFpLineToFootprintAST,
  addFpPolyToFootprintAST,
  addFpRectToFootprintAST,
  addPadToFootprintAST,
  translateGraphicInAST,
  addFpCurveToFootprintAST,
  addFpTextBoxToFootprintAST,
  addPointToFootprintAST,
  DEFAULT_POINT_SIZE,
  updateTextBoxInAST,
  updateCurveInAST,
  updatePointInAST,
  updateTableInAST,
  type KicadExtraGraphic,
  type KicadTable,
  type PadPatch,
  type TablePatch,
  type TextBoxPatch,
  type KicadFpCurve,
  type KicadFpTextBox,
  type KicadPoint
} from '../lib/kicad/footprint'
import {
  buildFootprintGroups,
  footprintCollection,
  FOOTPRINT_ITEM_COLLECTIONS,
  isFootprintItemType,
  type FootprintItemType,
  footprintLayerOptions,
  footprintPatch,
  type FootprintContext
} from '../lib/footprint/footprintPropertySchema'
import type { PropertyEditValue } from '../lib/propertyTable'
import { formatNmAtom, mmToNm, nm, nmToMm, spacingToMm, type Nm } from '../lib/kicad/coordinates'
import { GridSettings } from '../lib/engine/ViewportEngine'
import {
  gridKeyUpdate,
  updateGridSettings,
  useGridSettings,
  FOOTPRINT_UNIT_SPACINGS
} from '../lib/gridPreferences'
import { nextNonActiveDisplay, type NonActiveLayerDisplay } from '../lib/board/layerPresets'
import { footprintViewState, setFootprintView } from '../lib/footprintView'
import type { SelectionItem } from '../lib/history'
import type { TextSession } from '../lib/document/textSession'
import {
  matchesHotkey,
  hotkeyLabel,
  isTypingTarget,
  toolTitle,
  type HotkeyActionId
} from '../lib/hotkeys'
import { footprintGestureTool, type FootprintTool } from '../lib/footprint/footprintTools'
import {
  graphicDefaults,
  pcbToolClick,
  pcbToolFinish,
  pcbToolShape,
  takesLineMode,
  type PcbToolShape
} from '../lib/board/pcbTools'
import { constrainChainPoint, nextLineMode, type LineMode } from '../lib/lineMode'
import {
  hasPadstack,
  moveFootprintAnchor,
  transformFootprintItems,
  transformPivot,
  type FootprintTransform
} from '../lib/footprint/footprintTransform'
import { snapToGrid } from '../lib/engine/ViewportEngine'
import type { TransformOp } from '../lib/schematic/schematicTransform'
import {
  buildEditMenu,
  dispatchEditAction,
  selectAllInField,
  usePublishedEditActions
} from '../lib/editActions'
import { setClipboard, usePasteable } from '../lib/documentClipboard'
import {
  copiesFromFootprint,
  copyFootprintItems,
  insertIntoFootprint,
  itemsAnchor,
  pasteOffset,
  prepareFootprintPaste
} from '../lib/board/pcbClipboard'
import type { MenuNode } from '../lib/menu'
import { tk, type MessageKey } from '../lib/messageKey'
import ContextMenu from './shared/ContextMenu.vue'
import FootprintViewport2D from './footprint/FootprintViewport2D.vue'
import FootprintViewport3D from './footprint/FootprintViewport3D.vue'
import FootprintPropertiesPanel from './footprint/FootprintPropertiesPanel.vue'
import Footprint3DPanel from './footprint/Footprint3DPanel.vue'
import ResizeHandle from './shared/ResizeHandle.vue'
import HealthPill from './shared/HealthPill.vue'
import FindingsDrawer from './shared/FindingsDrawer.vue'
import LayersControl from './shared/LayersControl.vue'
import RailPinnedPanels from './shared/RailPinnedPanels.vue'
import {
  documentFindings,
  findingMarks,
  type HealthFinding,
  type HealthReport
} from '../lib/designHealth'
import { designHealthViewState } from '../lib/designHealthView'
import HealthViewSettings from './shared/HealthViewSettings.vue'
import { useHealthDrawer } from '../lib/designHealthDrawer'
import { footprintChecks } from '../lib/footprint/footprintChecks'
import { locateItems } from '../lib/footprint/footprintItems'
import { panelPinned, panelWidth, setPanelPinned, setPanelWidth } from '../lib/panelLayout'
import { footprintLayerListing } from '../lib/board/layerListing'
import Icon from './shared/Icon.vue'
import FileIcon from './shared/FileIcon.vue'
import NonActiveDisplayButton from './shared/NonActiveDisplayButton.vue'
import FitViewButton from './shared/FitViewButton.vue'
import Preview3dToggle from './shared/Preview3dToggle.vue'
import ToolbarSearch from './shared/ToolbarSearch.vue'
import CanvasFindWidget from './shared/CanvasFindWidget.vue'
import { useCanvasFind } from '../lib/useCanvasFind'
import { footprintFindCandidates } from '../lib/footprint/footprintFind'
import { isViewCommand, viewCommandFor, viewCommandOps } from '../lib/viewCommands'
import {
  fitViewOp,
  FIT_VIEW_OP_ID,
  isTransformOp,
  TRANSFORM_TOOLS,
  type ToolbarSearchOp
} from '../lib/toolSearch'
import { formatUpgrader } from '../lib/formatUpgrade'

const { t } = useI18n()
const { show: showPanels, inline: panelsInline, rail: panelRail } = useContextPanels()

// Type for the exposed viewport methods
interface ViewportExposed {
  selectOtherAt(client: { x: number; y: number }): void
  focusBox(box: { minX: number; minY: number; maxX: number; maxY: number }): void
  saveDragOrigins(items: Array<{ type: string; index: number }>): void
  clearDragOrigins(): void
  translateElements(
    items: Array<{ type: string; index: number }>,
    delta: { x: number; y: number }
  ): void
  rebuildSingleElement(
    type: string,
    index: number,
    fp: KicadFootprint,
    selectedItems: Array<{ type: string; index: number }>
  ): void
  rebuildAndRender(): void
  zoomToFit(): void
}

const props = defineProps<{
  /** The open footprint this view draws (`lib/document/textSession.ts`). */
  session: TextSession<KicadFootprint, SelectionItem>
  modelValue: string
  isReadOnly: boolean
  name: string
  projectPath: string | null
  filePath?: string | null
  /** True shows the linked 3D model instead of the canvas. */
  preview3d?: boolean
}>()

const emit = defineEmits<{
  (e: 'save-file', path: string, content: string): void
  /** Switch between the canvas and the 3D preview (the top-right toggle). */
  (e: 'toggle-preview3d'): void
}>()

// The 3D preview is the tab's, held in EditorGroup, which this editor's
// top-right toggle asks to switch. This only orders the modes.
const activeMode = computed<'visual' | '3d'>(() => (props.preview3d ? '3d' : 'visual'))

// Parsed Footprint model
/** The session's footprint, re-read after every change it announces. */
const modelVersion = ref(0)
const footprint = computed<KicadFootprint | null>(() => {
  void modelVersion.value
  return props.session.model()
})
const stopSession = props.session.subscribe((): void => {
  modelVersion.value++
})
const footprintRevision = ref(0)

// Selection State
const selectedItems = ref<Array<{ type: string; index: number }>>([])
/** Read-only because a KiCad we do not write made the file, not because it is a library's. */
const formatReadOnly = computed(() => !!props.filePath && formatUpgrader.isReadOnly(props.filePath))

// Viewport component ref for direct method calls during drags
const viewportRef = ref<(InstanceType<typeof FootprintViewport2D> & ViewportExposed) | null>(null)

// Find (Ctrl/Cmd+F, F3): pad numbers, fields and texts (lib/footprint/footprintFind.ts).
const find = useCanvasFind({
  candidates: () => (footprint.value ? footprintFindCandidates(footprint.value) : []),
  yDown: true,
  show: (hit) => {
    selectedItems.value = [{ type: hit.target.type, index: hit.target.index }]
    void nextTick(() => viewportRef.value?.revealSelection())
  }
})
const findState = find.state

const selectedPadIndex = computed({
  get() {
    const padItem = selectedItems.value.find((item) => item.type === 'pad')
    return padItem !== undefined ? padItem.index : null
  },
  set(val) {
    if (val === null) {
      selectedItems.value = selectedItems.value.filter((item) => item.type !== 'pad')
    } else {
      selectedItems.value = [{ type: 'pad', index: val }]
    }
  }
})

const selectedLineIndex = computed({
  get() {
    const lineItem = selectedItems.value.find((item) =>
      ['line', 'arc', 'circle', 'rect'].includes(item.type)
    )
    return lineItem !== undefined ? lineItem.index : null
  },
  set(val) {
    if (val === null) {
      selectedItems.value = selectedItems.value.filter(
        (item) => !['line', 'arc', 'circle', 'rect'].includes(item.type)
      )
    } else {
      selectedItems.value = [{ type: 'line', index: val }]
    }
  }
})

const selectedPolyIndex = computed({
  get() {
    const polyItem = selectedItems.value.find((item) => item.type === 'poly')
    return polyItem !== undefined ? polyItem.index : null
  },
  set(val) {
    if (val === null) {
      selectedItems.value = selectedItems.value.filter((item) => item.type !== 'poly')
    } else {
      selectedItems.value = [{ type: 'poly', index: val }]
    }
  }
})

// ---- Design health: the pill and the findings drawer ------------------------
// (design-health-workstream.md). The rules `footprint.check` runs.
const healthDrawer = useHealthDrawer('footprint')
const healthOpen = healthDrawer.open
const healthHeight = healthDrawer.height
const checkResults = computed(() => (footprint.value ? footprintChecks(footprint.value) : []))
const healthFindings = computed<HealthFinding[]>(() => documentFindings(checkResults.value))
const healthPinned = panelPinned('footprint', 'health')
const healthReport = computed<HealthReport>(() => ({
  status: 'checked',
  findings: healthFindings.value
}))

// Each finding marked on the canvas at the middle of what it names (the
// footprint checks give no position); a click on one selects its row.
const healthView = designHealthViewState()
/** The finding the drawer or a marker last picked: its marker draws over the rest. */
const pickedFinding = ref<string | null>(null)
const findingMarkers = computed(() => {
  const fp = footprint.value
  if (!fp || !healthView.value.showMarkers) return []
  return findingMarks(
    checkResults.value,
    healthFindings.value,
    (result) => {
      const { box } = locateItems(fp, result.targets ?? result.items)
      return box
        ? {
            x: nmToMm(((box.minX + box.maxX) / 2) as Nm),
            y: nmToMm(((box.minY + box.maxY) / 2) as Nm)
          }
        : null
    },
    pickedFinding.value
  )
})
const findingReveal = shallowRef<{ key: string; seq: number } | null>(null)
let revealSeq = 0
const revealFinding = (key: string): void => {
  if (!healthPinned.value) healthDrawer.show()
  findingReveal.value = { key, seq: ++revealSeq }
  pickedFinding.value = key
}

/** Select what a finding names and bring it into view. */
const locateFinding = (finding: HealthFinding, zoom = false): void => {
  pickedFinding.value = finding.key
  const fp = footprint.value
  const index = healthFindings.value.findIndex((entry) => entry.key === finding.key)
  const result = checkResults.value[index]
  if (!fp || !result) return
  const { selection, box } = locateItems(fp, result.targets ?? result.items)
  selectedItems.value = selection
  if (box) viewportRef.value?.showFinding(box, zoom)
}

// Grid Settings State
// Grid is a session/view preference (persisted across tabs/restarts, per editor
// kind) — never written to the .kicad_mod.
const gridSettings = useGridSettings('footprint', {
  spacing: 1.0,
  unit: 'mm',
  visible: true,
  snap: true
})

/**
 * Where the grid is laid from (KiCad's grid origin), footprint space. A view
 * setting like the grid itself: never written to the .kicad_mod, which has no
 * place for one, and gone with the tab, as it is with KiCad's editor window.
 */
const gridOrigin = ref<{ x: Nm; y: Nm }>({ x: nm(0), y: nm(0) })
const gridOriginMoved = computed(() => gridOrigin.value.x !== 0 || gridOrigin.value.y !== 0)

// Layer visibility, the active layer and the inactive-layer mode are one set
// shared by every footprint and every window (`footprintView.ts`): every
// footprint has the same layers, and there is no project file to hold them.
const footprintView = footprintViewState()
const layerVisibility = computed({
  get: () => footprintView.value.layerVisibility,
  set: (next: Record<string, boolean>) => setFootprintView({ layerVisibility: next })
})
const activeLayer = computed({
  get: () => footprintView.value.activeLayer,
  set: (next: string) => setFootprintView({ activeLayer: next })
})

// ---- Insert tools: arm, click, ghost (the schematic's pattern) --------------
const activeTool = ref<FootprintTool>('select')
/** Points a chain tool has collected, file space (nm, y-down). */
const toolDraft = ref<Array<{ x: Nm; y: Nm }>>([])
/** The line and polygon tools' angle constraint (lib/lineMode.ts); KiCad's footprint default. */
const lineMode = ref<LineMode>('45')
/** Whether the armed tool is one the line mode constrains. */
const lineModeArmed = computed(() => takesLineMode(footprintGestureTool(activeTool.value)))
const setTool = (tool: FootprintTool): void => {
  // The grid origin is a view setting, so a read-only footprint may move it too.
  if (props.isReadOnly && tool !== 'select' && tool !== 'gridOrigin') return
  toolDraft.value = []
  activeTool.value = tool
}

// How non-active layers render: normal, faded, or hidden
const nonActiveDisplay = computed({
  get: () => footprintView.value.nonActiveDisplay,
  set: (next: NonActiveLayerDisplay) => setFootprintView({ nonActiveDisplay: next })
})
const sketch = computed(() => ({
  pads: footprintView.value.sketchPads,
  graphics: footprintView.value.sketchGraphics,
  text: footprintView.value.sketchText
}))

/** What the Layers panel lists, in the bar or behind the active-layer pill. */
const layerListing = computed(() => footprintLayerListing((key) => t(`shared.layerPresets.${key}`)))

const handleSetActiveLayer = (layer: string): void => {
  // Whole objects rather than in-place writes: the store is the owner, and a
  // set is what persists it.
  setFootprintView({
    activeLayer: layer,
    // Ensure the active layer is visible
    ...(layerVisibility.value[layer] !== undefined
      ? { layerVisibility: { ...layerVisibility.value, [layer]: true } }
      : {})
  })
}

const handleToggleLayerVisibility = (layer: string): void => {
  if (layerVisibility.value[layer] === undefined) return
  layerVisibility.value = { ...layerVisibility.value, [layer]: !layerVisibility.value[layer] }
}

const handleApplyLayerPreset = (newVisibility: Record<string, boolean>): void => {
  const next = { ...layerVisibility.value }
  for (const [layer, on] of Object.entries(newVisibility)) {
    if (next[layer] !== undefined) next[layer] = on
  }
  layerVisibility.value = next
}

// Right properties panel resize state
/** Shared with the other editors' right bars and persisted globally — a panel
 *  size is a preference, not per-window or per-tab state (`panelLayout.ts`). */
const propertiesWidth = panelWidth()
let propertiesResizeStart = propertiesWidth.value

// Save Destination Modal State
const showSaveModal = ref(false)
const saveLocalName = ref('')

// The last document text this editor committed (emitted or received).
// Used as the authoritative "before" state for commands, and to skip
// re-parsing when our own emit echoes back through the modelValue prop.

// Initialize and watch modelValue
// Text this view did not write — a rename's forwarding, an agent's edit —
// arrives as the tab's buffer changing under it.
watch(
  () => props.modelValue,
  () => props.session.sync()
)

// ---------------------------------------------------------------------------
// Command layer: every mutation funnels through runCommand(), which records
// a labeled undo/redo entry (with selection) into a per-file CommandHistory.
// ---------------------------------------------------------------------------

// Bumped on every history change so the computeds below re-evaluate.
const historyVersion = ref(0)

interface CommandOptions {
  /** Consecutive commands with the same key merge into one undo step */
  mergeKey?: string
  /** Runs after the document is re-parsed; use to select newly added elements */
  afterApply?: () => void
}

/**
 * Execute a document mutation as an undoable command. `mutate` edits the
 * footprint AST/domain model; the command layer serializes, records the
 * before/after states plus selection, emits the new content, and re-parses.
 * No-op mutations (serialized text unchanged) are discarded.
 */
const runCommand = (label: string, mutate: () => void, options?: CommandOptions): void => {
  if (props.isReadOnly) return
  const ran = props.session.runCommand(label, () => mutate(), {
    selection: {
      before: selectedItems.value.map((i) => ({ ...i })),
      after: () => selectedItems.value.map((i) => ({ ...i }))
    }
  })
  if (!ran) return
  options?.afterApply?.()
  historyVersion.value++
}

const collectionForType = (type: string): unknown[] | undefined =>
  footprint.value ? footprintCollection(footprint.value, type) : undefined

/** The item types whose every position moves as one (`translateGraphicInAST`). */
const EXTRA_GRAPHIC_TYPES = new Set(['curve', 'textbox', 'table', 'point'])

/** Re-select what an undone or redone step had, dropping stale indices. */
const restoreSelection = (selection: SelectionItem[]): void => {
  selectedItems.value = selection.filter((s) => {
    const collection = collectionForType(s.type)
    return !!collection && s.index >= 0 && s.index < collection.length
  })
}

const undo = (): void => {
  const entry = props.session.undo()
  if (entry) {
    restoreSelection(entry.selectionBefore)
    historyVersion.value++
  }
}

const redo = (): void => {
  const entry = props.session.redo()
  if (entry) {
    restoreSelection(entry.selectionAfter)
    historyVersion.value++
  }
}

const undoShortcut = hotkeyLabel('editor.undo')
const redoShortcut = hotkeyLabel('editor.redo')

const canUndo = computed(() => {
  void historyVersion.value
  void modelVersion.value
  return props.session.canUndo()
})
const canRedo = computed(() => {
  void historyVersion.value
  void modelVersion.value
  return props.session.canRedo()
})
const undoTitle = computed(() => {
  void historyVersion.value
  // An agent's command moves the session's history without touching this
  // view's counter, so the label must follow the session too or it goes stale.
  void modelVersion.value
  const label = props.session.undoLabel()
  return label
    ? t('common.undoWithLabel', { label, shortcut: undoShortcut })
    : t('common.undo', { shortcut: undoShortcut })
})
const redoTitle = computed(() => {
  void historyVersion.value
  // An agent's command moves the session's history without touching this
  // view's counter, so the label must follow the session too or it goes stale.
  void modelVersion.value
  const label = props.session.redoLabel()
  return label
    ? t('common.redoWithLabel', { label, shortcut: redoShortcut })
    : t('common.redo', { shortcut: redoShortcut })
})

// Reset selection state when switching between files (history is the file's document's)
watch(
  () => props.filePath,
  () => {
    selectedItems.value = []
    historyVersion.value++
  }
)

// Event Handlers for Sidebar mutations. Each becomes an undoable command;
// the mergeKey coalesces rapid edits to the same fields (e.g. typing digits
// into a size input) into a single undo step.

// The PropertyTable schema for the current selection, and the one edit channel
// that maps `edit(groupType, key, value)` back to the AST helpers — applied to
// every selected node of the group's type (mirrors the symbol editor).
const footprintContext: FootprintContext = { layers: footprintLayerOptions() }
const footprintGroups = computed(() =>
  intersectGroups(
    buildFootprintGroups(footprint.value, selectedItems.value, t, footprintContext),
    t('shared.properties.selection')
  )
)

// Exhaustive over the selectable types: one made selectable without an edit
// path here does not compile.
const applyFootprintPatch = (
  groupType: FootprintItemType,
  node: unknown,
  key: string,
  value: PropertyEditValue
): void => {
  const patch = footprintPatch(groupType, key, value, node)
  switch (groupType) {
    case 'pad':
      updatePadInAST(node as KicadPad, patch as PadPatch)
      break
    case 'line':
      updateLineInAST(node as KicadFpLine, patch as Partial<KicadFpLine>)
      break
    case 'arc':
      updateArcInAST(node as KicadFpArc, patch as Partial<KicadFpArc>)
      break
    case 'circle':
      updateCircleInAST(node as KicadFpCircle, patch as Partial<KicadFpCircle>)
      break
    case 'rect':
      updateRectInAST(node as KicadFpRect, patch as Partial<KicadFpRect>)
      break
    case 'poly':
      updatePolyInAST(node as KicadFpPoly, patch as Partial<KicadFpPoly>)
      break
    case 'text':
      updateTextInAST(node as KicadFpText, patch as Partial<KicadFpText>)
      break
    case 'property':
      updatePropertyInAST(node as KicadProperty, patch as Partial<KicadProperty>)
      break
    case 'zone':
      updateZoneInAST(node as KicadZone, patch as Partial<KicadZone>)
      break
    case 'textbox':
      updateTextBoxInAST(node as KicadFpTextBox, patch as TextBoxPatch)
      break
    case 'curve':
      updateCurveInAST(node as KicadFpCurve, patch as Partial<KicadFpCurve>)
      break
    case 'point':
      updatePointInAST(node as KicadPoint, patch as Parameters<typeof updatePointInAST>[1])
      break
    case 'table':
      updateTableInAST(node as KicadTable, patch as TablePatch)
      break
    default:
      groupType satisfies never
  }
}

const onFootprintEdit = (
  groupType: string,
  key: string,
  value: PropertyEditValue,
  sharedKey?: string
): void => {
  const fp = footprint.value
  if (!fp || props.isReadOnly) return
  // A mixed selection's edit is each kind's, merged into one undo step.
  if (groupType === SELECTION_GROUP) {
    const members = footprintGroups.value[0]?.members ?? []
    for (const member of members)
      onFootprintEdit(member.type, key, value, `${SELECTION_GROUP}:${key}`)
    return
  }
  const mergeKey = sharedKey ?? `${groupType}:${key}`
  if (groupType === 'footprint') {
    runCommand(
      t('footprintEditor.commands.editFootprintProperties'),
      () =>
        updateFootprintMetaInAST(
          fp,
          footprintPatch('footprint', key, value, fp) as Parameters<
            typeof updateFootprintMetaInAST
          >[1]
        ),
      { mergeKey }
    )
    return
  }
  if (!isFootprintItemType(groupType)) return
  const collection = fp[FOOTPRINT_ITEM_COLLECTIONS[groupType]] as unknown[]
  const nodes = selectedItems.value
    .filter((i) => i.type === groupType)
    .map((i) => collection[i.index])
    .filter((n): n is NonNullable<typeof n> => !!n)
  if (!nodes.length) return
  runCommand(
    t('footprintEditor.commands.editShape'),
    () => nodes.forEach((n) => applyFootprintPatch(groupType, n, key, value)),
    { mergeKey }
  )
}

interface DragStartElement {
  type: string
  index: number
  pos?: { x: number; y: number }
  start?: { x: number; y: number }
  end?: { x: number; y: number }
  mid?: { x: number; y: number }
  center?: { x: number; y: number }
  points?: Array<{ x: number; y: number }>
}

interface DragStartVertex {
  type: string
  index: number
  vertexIndex: number
  initialVal: { x: number; y: number }
}

// Dragging coordination state
const dragStartElements = ref<DragStartElement[]>([])
const dragStartVertex = ref<DragStartVertex | null>(null)
const lastDragDelta = ref<{ x: number; y: number }>({ x: 0, y: 0 })

/** The selection and the item under the cursor, for KiCad's hover selection (`lib/hoverSelection.ts`). */
const footprintHover: HoverSelection<{ type: string; index: number }> = {
  selected: selectedItems,
  hover: () => viewportRef.value?.itemAtCursor() ?? null,
  same: sameRef
}

/** KiCad's Move (M), held: Escape puts what it moved back, nothing committed. */
const move = heldMove(footprintHover, {
  begin: () => viewportRef.value?.startHeldMove() ?? false,
  history: props.session,
  abandon: () => {
    viewportRef.value?.cancelHeldMove()
    viewportRef.value?.translateElements(selectedItems.value, { x: 0, y: 0 })
    viewportRef.value?.clearDragOrigins()
    dragStartElements.value = []
    lastDragDelta.value = { x: 0, y: 0 }
  }
})

const handleDragStart = (type: 'object' | 'vertex', info?: Record<string, unknown>): void => {
  if (!footprint.value) return

  if (type === 'vertex' && info) {
    const parentType = info.parentType as string
    const parentIndex = info.parentIndex as number
    const vertexIndex = info.vertexIndex as number

    let initialVal = { x: 0, y: 0 }
    if (parentType === 'line') {
      const line = footprint.value.fpLines[parentIndex]
      if (line) {
        const pt = vertexIndex === 0 ? line.start : line.end
        initialVal = { x: pt.x, y: pt.y }
      }
    } else if (parentType === 'poly') {
      const poly = footprint.value.fpPolys[parentIndex]
      if (poly && poly.points[vertexIndex]) {
        const pt = poly.points[vertexIndex]
        initialVal = { x: pt.x, y: pt.y }
      }
    } else if (parentType === 'arc') {
      const arc = footprint.value.fpArcs[parentIndex]
      if (arc) {
        const pt = vertexIndex === 0 ? arc.start : vertexIndex === 1 ? arc.mid : arc.end
        initialVal = { x: pt.x, y: pt.y }
      }
    } else if (parentType === 'circle') {
      const circle = footprint.value.fpCircles[parentIndex]
      if (circle) {
        const pt = vertexIndex === 0 ? circle.center : circle.end
        initialVal = { x: pt.x, y: pt.y }
      }
    } else if (parentType === 'rect') {
      const rect = footprint.value.fpRects[parentIndex]
      if (rect) {
        const pt = vertexIndex === 0 ? rect.start : rect.end
        initialVal = { x: pt.x, y: pt.y }
      }
    } else if (parentType === 'zone') {
      const zone = footprint.value.zones[parentIndex]
      if (zone && zone.points[vertexIndex]) {
        const pt = zone.points[vertexIndex]
        initialVal = { x: pt.x, y: pt.y }
      }
    }

    dragStartVertex.value = {
      type: parentType,
      index: parentIndex,
      vertexIndex,
      initialVal
    }
  } else {
    dragStartVertex.value = null
    dragStartElements.value = snapshotDragElements()

    // Snapshot Three.js positions for position-only translation
    viewportRef.value?.saveDragOrigins(selectedItems.value)
  }
}

/** Where the selection stands now: what a drop moves by the drag's delta. */
const snapshotDragElements = (): DragStartElement[] =>
  selectedItems.value
    .map(({ type, index }) => {
      if (type === 'pad') {
        const pad = footprint.value!.pads[index]
        return { type, index, pos: { ...pad.position } }
      } else if (type === 'line') {
        const line = footprint.value!.fpLines[index]
        return { type, index, start: { ...line.start }, end: { ...line.end } }
      } else if (type === 'arc') {
        const arc = footprint.value!.fpArcs[index]
        return { type, index, start: { ...arc.start }, mid: { ...arc.mid }, end: { ...arc.end } }
      } else if (type === 'circle') {
        const circle = footprint.value!.fpCircles[index]
        return { type, index, center: { ...circle.center }, end: { ...circle.end } }
      } else if (type === 'rect') {
        const rect = footprint.value!.fpRects[index]
        return { type, index, start: { ...rect.start }, end: { ...rect.end } }
      } else if (type === 'poly') {
        const poly = footprint.value!.fpPolys[index]
        return { type, index, points: poly.points.map((pt) => ({ ...pt })) }
      } else if (type === 'zone') {
        const zone = footprint.value!.zones[index]
        return { type, index, points: zone.points.map((pt) => ({ ...pt })) }
      } else if (type === 'property') {
        const prop = footprint.value!.properties[index]
        return { type, index, pos: prop.position ? { ...prop.position } : undefined }
      } else if (type === 'text') {
        const txt = footprint.value!.fpTexts[index]
        return { type, index, pos: txt.position ? { ...txt.position } : undefined }
      } else if (EXTRA_GRAPHIC_TYPES.has(type)) {
        // Moved by the final delta alone, so nothing to snapshot.
        return collectionForType(type)?.[index] ? { type, index } : null
      }
      return null
    })
    .filter(Boolean) as DragStartElement[]

/**
 * A turn or flip mid-move: the drop moves the parts from where the edit left
 * them, and the rebuilt scene carries them again by the move so far.
 */
const refreshDragAfterEdit = (): void => {
  if (dragStartElements.value.length === 0) return
  dragStartElements.value = snapshotDragElements()
  const { x, y } = lastDragDelta.value
  void nextTick(() => {
    viewportRef.value?.saveDragOrigins(selectedItems.value)
    viewportRef.value?.translateElements(selectedItems.value, {
      x: nmToMm(nm(x)),
      y: -nmToMm(nm(y))
    })
  })
}

const handleDragMove = (delta: { x: number; y: number }): void => {
  if (!footprint.value) return

  // Engine mm delta → domain nm (y flips into KiCad's y-down frame).
  const dx = mmToNm(delta.x)
  const dy = mmToNm(-delta.y)
  lastDragDelta.value = { x: dx, y: dy }

  if (dragStartVertex.value) {
    // VERTEX DRAG: mutate only the affected element's coordinates in-place,
    // then do a targeted single-element rebuild (not a full scene rebuild)
    const { type, index, vertexIndex, initialVal } = dragStartVertex.value
    if (type === 'line') {
      const line = footprint.value.fpLines[index]
      if (line) {
        const pt = vertexIndex === 0 ? line.start : line.end
        pt.x = nm(initialVal.x + dx)
        pt.y = nm(initialVal.y + dy)
      }
    } else if (type === 'poly') {
      const poly = footprint.value.fpPolys[index]
      if (poly && poly.points[vertexIndex]) {
        poly.points[vertexIndex].x = nm(initialVal.x + dx)
        poly.points[vertexIndex].y = nm(initialVal.y + dy)
      }
    } else if (type === 'arc') {
      const arc = footprint.value.fpArcs[index]
      if (arc) {
        const pt = vertexIndex === 0 ? arc.start : vertexIndex === 1 ? arc.mid : arc.end
        pt.x = nm(initialVal.x + dx)
        pt.y = nm(initialVal.y + dy)
      }
    } else if (type === 'circle') {
      const circle = footprint.value.fpCircles[index]
      if (circle) {
        const pt = vertexIndex === 0 ? circle.center : circle.end
        pt.x = nm(initialVal.x + dx)
        pt.y = nm(initialVal.y + dy)
      }
    } else if (type === 'rect') {
      const rect = footprint.value.fpRects[index]
      if (rect) {
        const pt = vertexIndex === 0 ? rect.start : rect.end
        pt.x = nm(initialVal.x + dx)
        pt.y = nm(initialVal.y + dy)
      }
    } else if (type === 'zone') {
      const zone = footprint.value.zones[index]
      if (zone && zone.points[vertexIndex]) {
        zone.points[vertexIndex].x = nm(initialVal.x + dx)
        zone.points[vertexIndex].y = nm(initialVal.y + dy)
      }
    }

    // Targeted rebuild: only re-render this one element
    viewportRef.value?.rebuildSingleElement(type, index, footprint.value, selectedItems.value)
  } else {
    // OBJECT DRAG: position-only translation via Three.js — zero allocation.
    // Data model is NOT mutated here; that happens in handleDragEnd. The scene
    // is engine space (mm, y up), as the delta is.
    viewportRef.value?.translateElements(selectedItems.value, delta)
  }
}

const handleDragEnd = (): void => {
  finishDrag()
  move.end()
}

const finishDrag = (): void => {
  if (!footprint.value) return

  // A selection click enters the engine's drag path on mouse-down; unless the
  // snapped delta moved, nothing happened to the document, and recording a
  // move would dirty the tab and fill Undo (as PcbEditor's handleDragEnd).
  if (lastDragDelta.value.x === 0 && lastDragDelta.value.y === 0) {
    viewportRef.value?.clearDragOrigins()
    dragStartElements.value = []
    dragStartVertex.value = null
    return
  }

  const isVertexDrag = dragStartVertex.value !== null
  const dragCount = dragStartElements.value.length
  const dragLabel = isVertexDrag
    ? t('footprintEditor.commands.editShape')
    : t('commandLabels.move', dragCount)

  const commitDrag = (): void => {
    if (dragStartVertex.value) {
      // Vertex drags: data model was mutated during drag-move,
      // now commit the final coordinates to the AST
      const { type, index } = dragStartVertex.value
      if (type === 'line') {
        const line = footprint.value!.fpLines[index]
        if (line) updateLineInAST(line, { start: line.start, end: line.end })
      } else if (type === 'poly') {
        const poly = footprint.value!.fpPolys[index]
        if (poly) updatePolyInAST(poly, { points: poly.points })
      } else if (type === 'arc') {
        const arc = footprint.value!.fpArcs[index]
        if (arc) updateArcInAST(arc, { start: arc.start, mid: arc.mid, end: arc.end })
      } else if (type === 'circle') {
        const circle = footprint.value!.fpCircles[index]
        if (circle) updateCircleInAST(circle, { center: circle.center, end: circle.end })
      } else if (type === 'rect') {
        const rect = footprint.value!.fpRects[index]
        if (rect) updateRectInAST(rect, { start: rect.start, end: rect.end })
      } else if (type === 'zone') {
        const zone = footprint.value!.zones[index]
        if (zone) updateZoneInAST(zone, { points: zone.points })
      }
    } else {
      // Object drags: data model was NOT mutated during drag-move (only Three.js positions moved),
      // so we must apply the final delta to the data model now using the stored drag origins
      const fdx = lastDragDelta.value.x
      const fdy = lastDragDelta.value.y
      dragStartElements.value.forEach((item) => {
        const { type, index } = item
        if (type === 'pad') {
          const pad = footprint.value!.pads[index]
          if (pad && item.pos) {
            pad.position.x = nm(item.pos.x + fdx)
            pad.position.y = nm(item.pos.y + fdy)
            updatePadInAST(pad, { position: pad.position })
          }
        } else if (type === 'line') {
          const line = footprint.value!.fpLines[index]
          if (line && item.start && item.end) {
            line.start.x = nm(item.start.x + fdx)
            line.start.y = nm(item.start.y + fdy)
            line.end.x = nm(item.end.x + fdx)
            line.end.y = nm(item.end.y + fdy)
            updateLineInAST(line, { start: line.start, end: line.end })
          }
        } else if (type === 'arc') {
          const arc = footprint.value!.fpArcs[index]
          if (arc && item.start && item.mid && item.end) {
            arc.start.x = nm(item.start.x + fdx)
            arc.start.y = nm(item.start.y + fdy)
            arc.mid.x = nm(item.mid.x + fdx)
            arc.mid.y = nm(item.mid.y + fdy)
            arc.end.x = nm(item.end.x + fdx)
            arc.end.y = nm(item.end.y + fdy)
            updateArcInAST(arc, { start: arc.start, mid: arc.mid, end: arc.end })
          }
        } else if (type === 'circle') {
          const circle = footprint.value!.fpCircles[index]
          if (circle && item.center && item.end) {
            circle.center.x = nm(item.center.x + fdx)
            circle.center.y = nm(item.center.y + fdy)
            circle.end.x = nm(item.end.x + fdx)
            circle.end.y = nm(item.end.y + fdy)
            updateCircleInAST(circle, { center: circle.center, end: circle.end })
          }
        } else if (type === 'rect') {
          const rect = footprint.value!.fpRects[index]
          if (rect && item.start && item.end) {
            rect.start.x = nm(item.start.x + fdx)
            rect.start.y = nm(item.start.y + fdy)
            rect.end.x = nm(item.end.x + fdx)
            rect.end.y = nm(item.end.y + fdy)
            updateRectInAST(rect, { start: rect.start, end: rect.end })
          }
        } else if (type === 'poly') {
          const poly = footprint.value!.fpPolys[index]
          if (poly && item.points) {
            poly.points.forEach((pt, i) => {
              pt.x = nm(item.points![i].x + fdx)
              pt.y = nm(item.points![i].y + fdy)
            })
            updatePolyInAST(poly, { points: poly.points })
          }
        } else if (type === 'zone') {
          const zone = footprint.value!.zones[index]
          if (zone && item.points) {
            zone.points.forEach((pt, i) => {
              pt.x = nm(item.points![i].x + fdx)
              pt.y = nm(item.points![i].y + fdy)
            })
            updateZoneInAST(zone, { points: zone.points })
          }
        } else if (type === 'property') {
          const prop = footprint.value!.properties[index]
          if (prop && prop.position && item.pos) {
            prop.position.x = nm(item.pos.x + fdx)
            prop.position.y = nm(item.pos.y + fdy)
            updatePropertyInAST(prop, { position: prop.position })
          }
        } else if (type === 'text') {
          const txt = footprint.value!.fpTexts[index]
          if (txt && txt.position && item.pos) {
            txt.position.x = nm(item.pos.x + fdx)
            txt.position.y = nm(item.pos.y + fdy)
            updateTextInAST(txt, { position: txt.position })
          }
        } else if (EXTRA_GRAPHIC_TYPES.has(type)) {
          const extra = collectionForType(type)?.[index] as KicadExtraGraphic | undefined
          if (extra) translateGraphicInAST(extra, nm(fdx), nm(fdy))
        }
      })
    }
  }

  runCommand(dragLabel, commitDrag)

  // In read-only mode the drag moved things visually but the command was
  // blocked — snap the viewport back to the unchanged model
  if (props.isReadOnly) {
    viewportRef.value?.rebuildAndRender()
  }

  // Clean up drag state
  viewportRef.value?.clearDragOrigins()
  dragStartElements.value = []
  dragStartVertex.value = null
  lastDragDelta.value = { x: 0, y: 0 }
}

const handleUpdateGrid = (settings: Partial<GridSettings>): void => {
  gridSettings.value = updateGridSettings(gridSettings.value, settings, FOOTPRINT_UNIT_SPACINGS)
}

const resizeProperties = (grow: number): void => {
  setPanelWidth(propertiesResizeStart + grow)
}
/** One config write per drag, not one per pixel. */
const commitProperties = (): void => setPanelWidth(propertiesWidth.value, true)

// Adding / Deleting Manual pads and lines
const addManualPad = (at: { x: Nm; y: Nm } = { x: nm(0), y: nm(0) }): void => {
  const fp = footprint.value
  if (!fp) return

  // Get next pin number
  const numbers = fp.pads.map((p) => parseInt(p.number)).filter((n) => !isNaN(n))
  const nextNum = numbers.length > 0 ? Math.max(...numbers) + 1 : 1

  const isActiveBack = activeLayer.value.startsWith('B.')
  const padCopper = isActiveBack ? 'B.Cu' : 'F.Cu'
  const padPaste = isActiveBack ? 'B.Paste' : 'F.Paste'
  const padMask = isActiveBack ? 'B.Mask' : 'F.Mask'

  runCommand(
    t('footprintEditor.commands.addPad'),
    () =>
      addPadToFootprintAST(fp, {
        number: nextNum.toString(),
        type: 'smd',
        shape: 'rect',
        at,
        size: { w: mmToNm(1.2), h: mmToNm(1.5) },
        layers: [padCopper, padPaste, padMask]
      }),
    {
      afterApply: () => {
        if (footprint.value) {
          selectedItems.value = [{ type: 'pad', index: footprint.value.pads.length - 1 }]
        }
      }
    }
  )
}

const addManualText = (at: { x: Nm; y: Nm } = { x: nm(0), y: nm(0) }): void => {
  if (!footprint.value) return
  const root = footprint.value._raw as SExprList
  const startPos = root.start

  // Create text: (fp_text user "Text" (at 0 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  const newTextNode: SExprList = {
    type: 'list',
    children: [
      { type: 'atom', value: 'fp_text', quoted: false, start: startPos, end: startPos },
      { type: 'atom', value: 'user', quoted: false, start: startPos, end: startPos },
      { type: 'atom', value: 'Text', quoted: true, start: startPos, end: startPos },
      {
        type: 'list',
        children: [
          { type: 'atom', value: 'at', quoted: false, start: startPos, end: startPos },
          {
            type: 'atom',
            value: formatNmAtom(at.x),
            quoted: false,
            start: startPos,
            end: startPos
          },
          { type: 'atom', value: formatNmAtom(at.y), quoted: false, start: startPos, end: startPos }
        ],
        start: startPos,
        end: startPos
      } as SExprList,
      {
        type: 'list',
        children: [
          { type: 'atom', value: 'layer', quoted: false, start: startPos, end: startPos },
          { type: 'atom', value: activeLayer.value, quoted: true, start: startPos, end: startPos }
        ],
        start: startPos,
        end: startPos
      } as SExprList,
      {
        type: 'list',
        children: [
          { type: 'atom', value: 'effects', quoted: false, start: startPos, end: startPos },
          {
            type: 'list',
            children: [
              { type: 'atom', value: 'font', quoted: false, start: startPos, end: startPos },
              {
                type: 'list',
                children: [
                  { type: 'atom', value: 'size', quoted: false, start: startPos, end: startPos },
                  { type: 'atom', value: '1', quoted: false, start: startPos, end: startPos },
                  { type: 'atom', value: '1', quoted: false, start: startPos, end: startPos }
                ],
                start: startPos,
                end: startPos
              } as SExprList,
              {
                type: 'list',
                children: [
                  {
                    type: 'atom',
                    value: 'thickness',
                    quoted: false,
                    start: startPos,
                    end: startPos
                  },
                  { type: 'atom', value: '0.15', quoted: false, start: startPos, end: startPos }
                ],
                start: startPos,
                end: startPos
              } as SExprList
            ],
            start: startPos,
            end: startPos
          } as SExprList
        ],
        start: startPos,
        end: startPos
      } as SExprList
    ],
    start: startPos,
    end: startPos
  }

  runCommand(t('footprintEditor.commands.addText'), () => root.children.push(newTextNode), {
    afterApply: () => {
      if (footprint.value) {
        selectedItems.value = [{ type: 'text', index: footprint.value.fpTexts.length - 1 }]
      }
    }
  })
}

const deleteSelected = (): void => {
  if (!footprint.value || selectedItems.value.length === 0) return
  const root = footprint.value._raw as SExprList
  const count = selectedItems.value.length
  const label = t('commandLabels.delete', count)

  runCommand(label, () => {
    selectedItems.value.forEach(({ type, index }) => {
      let itemRaw: SExprNode | null = null
      if (type === 'pad') {
        itemRaw = footprint.value!.pads[index]?._raw
      } else if (type === 'line') {
        itemRaw = footprint.value!.fpLines[index]?._raw
      } else if (type === 'arc') {
        itemRaw = footprint.value!.fpArcs[index]?._raw
      } else if (type === 'circle') {
        itemRaw = footprint.value!.fpCircles[index]?._raw
      } else if (type === 'rect') {
        itemRaw = footprint.value!.fpRects[index]?._raw
      } else if (type === 'poly') {
        itemRaw = footprint.value!.fpPolys[index]?._raw
      } else if (type === 'zone') {
        itemRaw = footprint.value!.zones[index]?._raw
      } else if (type === 'property') {
        itemRaw = footprint.value!.properties[index]?._raw
      } else if (type === 'text') {
        itemRaw = footprint.value!.fpTexts[index]?._raw
      } else if (EXTRA_GRAPHIC_TYPES.has(type)) {
        itemRaw = (collectionForType(type)?.[index] as KicadExtraGraphic | undefined)?._raw ?? null
      }

      if (itemRaw) {
        const idx = root.children.indexOf(itemRaw)
        if (idx !== -1) {
          root.children.splice(idx, 1)
        }
      }
    })
    selectedItems.value = []
  })
}

// ---- Cut, copy, paste, duplicate (lib/board/pcbClipboard.ts) -----------------
// The app's one clipboard (lib/documentClipboard.ts): a board's items paste in
// here, and these paste onto a board.

/** The selected items' nodes that travel on the clipboard (fields do not). */
const copyableNodes = (): SExprNode[] =>
  selectedItems.value
    .map(
      ({ type, index }) =>
        (collectionForType(type) as Array<{ _raw: SExprNode }> | undefined)?.[index]?._raw
    )
    .filter((raw): raw is SExprNode => !!raw && copiesFromFootprint(raw))

const pasteable = usePasteable('footprint')
const canCopy = computed(() => {
  void modelVersion.value
  return copyableNodes().length > 0
})
const canPaste = computed(() => !props.isReadOnly && !!pasteable.value)

/** The grid step in footprint nm: where a duplicate lands, and what a paste snaps by. */
const gridStepNm = (): Nm =>
  mmToNm(spacingToMm(gridSettings.value.spacing, gridSettings.value.unit))

const copySelection = (): boolean => {
  const items = copyFootprintItems(copyableNodes())
  if (items.length) setClipboard('footprint', items)
  return items.length > 0
}

/** Copy, then delete what was copied, as one step (fields are neither). */
const cutSelection = (): void => {
  const fp = footprint.value
  if (!fp || props.isReadOnly) return
  const nodes = copyableNodes()
  if (!copySelection()) return
  const root = fp._raw as SExprList
  runCommand(t('commandLabels.cut', nodes.length), () => {
    root.children = root.children.filter((child) => !nodes.includes(child))
    selectedItems.value = []
  })
}

/** Land prepared items, selected, as one step. */
const landPaste = (
  label: string,
  nodes: SExprList[],
  offset: (anchor: { x: number; y: number } | null) => { x: number; y: number }
): void => {
  const fp = footprint.value
  if (!fp || props.isReadOnly || !nodes.length) return
  const delta = offset(itemsAnchor(nodes))
  runCommand(label, () => {
    selectedItems.value = insertIntoFootprint(fp, nodes, delta)
  })
}

const pasteClipboard = (): void => {
  const contents = pasteable.value
  if (!contents || props.isReadOnly) return
  const { nodes, dropped } = prepareFootprintPaste(contents)
  const count = nodes.length
  const label = dropped
    ? t('commandLabels.pasteLeavingOut', { count, dropped }, count)
    : t('commandLabels.paste', count)
  landPaste(label, nodes, (anchor) =>
    pasteOffset(anchor, {
      cursor: viewportRef.value?.getCursor() ?? null,
      gridStep: gridStepNm(),
      sameKind: contents.kind === 'footprint',
      gridOrigin: gridOrigin.value
    })
  )
}

/** KiCad's Duplicate: the selection again, a grid step down and right. */
const duplicateSelection = (): void => {
  const items = copyFootprintItems(copyableNodes())
  const { nodes } = prepareFootprintPaste({ kind: 'footprint', items })
  const step = gridStepNm()
  landPaste(t('commandLabels.duplicate', nodes.length), nodes, () => ({ x: step, y: step }))
}

/** Select everything a sweep could take (the viewport's band, over everything). */
const selectAll = (): void => {
  selectedItems.value = viewportRef.value?.selectAll() ?? []
}

// ---- Rotate, mirror, flip (KiCad's EDIT_TOOL, lib/footprint/footprintTransform.ts)

/** The grid's step in footprint nm, for a multi-selection's snapped pivot. */
const snapToFootprintGrid = (p: { x: number; y: number }): { x: number; y: number } => {
  if (!gridSettings.value.snap) return p
  const step = mmToNm(spacingToMm(gridSettings.value.spacing, gridSettings.value.unit))
  return {
    x: snapToGrid(p.x, step, gridOrigin.value.x),
    y: snapToGrid(p.y, step, gridOrigin.value.y)
  }
}

const hasSelection = computed(() => selectedItems.value.length > 0)
const canTransform = computed(() => !props.isReadOnly && hasSelection.value)
/**
 * A pad with a KiCad 9 padstack keeps per-layer copper that a flip would have
 * to swap front for back; that is not modelled, so such a selection does not
 * flip rather than flipping half of it.
 */
const canFlip = computed(() => {
  const fp = footprint.value
  if (!canTransform.value || !fp) return false
  return !selectedItems.value.some(
    (item) => item.type === 'pad' && !!fp.pads[item.index] && hasPadstack(fp.pads[item.index])
  )
})

const TRANSFORM_LABELS: Record<FootprintTransform['kind'], MessageKey> = {
  rotate: tk('footprintEditor.commands.rotate'),
  mirror: tk('footprintEditor.commands.mirror'),
  flip: tk('footprintEditor.commands.flip')
}

const runTransform = (transform: FootprintTransform): void => {
  const fp = footprint.value
  if (!fp || !canTransform.value) return
  if (transform.kind === 'flip' && !canFlip.value) return
  const refs = selectedItems.value.map((item) => ({ ...item }))
  // Mid-move a turn is about the grab anchor under the cursor, as KiCad's (a
  // flip of several items keeps the footprint anchor).
  const anchor = viewportRef.value?.dragAnchorStart()
  const pivot =
    anchor && (transform.kind !== 'flip' || refs.length === 1)
      ? anchor
      : transformPivot(fp, refs, transform, snapToFootprintGrid)
  runCommand(t(TRANSFORM_LABELS[transform.kind]), () =>
    transformFootprintItems(fp, refs, transform, pivot)
  )
  refreshDragAfterEdit()
}

/** The chips' ops (`TRANSFORM_TOOLS`) as footprint transforms. R turns counter-clockwise. */
const transformFor = (op: TransformOp): FootprintTransform =>
  op === 'rotateCCW'
    ? { kind: 'rotate', angle: 90 }
    : op === 'rotateCW'
      ? { kind: 'rotate', angle: -90 }
      : { kind: 'mirror', direction: op === 'mirrorHorizontal' ? 'leftRight' : 'topBottom' }

/** The rotate chips' keys; mirror is unbound in the footprint editor (DESIGN.md §Keymap). */
const transformHotkeys: Partial<Record<TransformOp, HotkeyActionId>> = {
  rotateCCW: 'footprint.rotate',
  rotateCW: 'footprint.rotateClockwise'
}

/** Place Footprint Anchor: the click becomes 0,0 and every item shifts the other way. */
const placeAnchor = (point: { x: Nm; y: Nm }): void => {
  const fp = footprint.value
  if (!fp) return
  runCommand(t('footprintEditor.commands.moveAnchor'), () => moveFootprintAnchor(fp, point))
}

const resetGridOrigin = (): void => {
  gridOrigin.value = { x: nm(0), y: nm(0) }
}

// Toolbar tool search (same discovery pattern as the schematic insert search)
const insertSearch = ref<InstanceType<typeof ToolbarSearch> | null>(null)

// The tool search lists every control on the toolbar and the view rail
// (lib/toolSearch.ts): the ids are the tools' own, plus the actions below.
const searchOps = computed<ToolbarSearchOp[]>(() => {
  const tool = (
    id: FootprintTool,
    icon: ToolbarSearchOp['icon'],
    label: string,
    group: ToolbarSearchOp['group'],
    action?: HotkeyActionId
  ): ToolbarSearchOp => ({
    id,
    icon,
    label,
    group,
    hotkey: action && hotkeyLabel(action),
    state: activeTool.value === id ? 'current' : undefined,
    disabled: props.isReadOnly
  })
  const toggle = (
    id: string,
    icon: ToolbarSearchOp['icon'],
    label: string,
    group: ToolbarSearchOp['group'],
    on: boolean
  ): ToolbarSearchOp => ({ id, icon, label, group, state: on ? 'on' : undefined })
  return [
    ...TRANSFORM_TOOLS.map(({ op, icon, label }): ToolbarSearchOp => {
      const action = transformHotkeys[op]
      return {
        id: op,
        icon,
        label: t(label),
        group: 'select',
        hotkey: action && hotkeyLabel(action),
        disabled: !canTransform.value
      }
    }),
    {
      id: 'flip',
      icon: 'tool-flip',
      label: t('footprintEditor.tools.flip'),
      group: 'select',
      hotkey: hotkeyLabel('footprint.flip'),
      disabled: !canFlip.value
    },
    tool('pad', 'tool-pad', t('footprintEditor.viewport.pad'), 'place', 'footprint.tool.pad'),
    tool('line', 'tool-line', t('footprintEditor.viewport.line'), 'draw', 'footprint.tool.line'),
    tool('arc', 'tool-arc', t('footprintEditor.viewport.arc'), 'draw', 'footprint.tool.arc'),
    tool('rectangle', 'tool-rect', t('footprintEditor.viewport.rectangle'), 'draw'),
    tool(
      'circle',
      'tool-circle',
      t('footprintEditor.viewport.circle'),
      'draw',
      'footprint.tool.circle'
    ),
    tool(
      'polygon',
      'tool-polygon',
      t('footprintEditor.viewport.polygon'),
      'draw',
      'footprint.tool.polygon'
    ),
    tool(
      'bezier',
      'tool-bezier',
      t('footprintEditor.viewport.bezier'),
      'draw',
      'footprint.tool.bezier'
    ),
    tool('text', 'tool-text', t('footprintEditor.viewport.text'), 'draw', 'footprint.tool.text'),
    tool('textBox', 'tool-text-box', t('footprintEditor.viewport.textBox'), 'draw'),
    tool('point', 'tool-point', t('footprintEditor.viewport.point'), 'draw'),
    tool('anchor', 'tool-anchor', t('footprintEditor.tools.anchor'), 'utilities'),
    {
      ...tool('gridOrigin', 'tool-grid-origin', t('footprintEditor.tools.gridOrigin'), 'utilities'),
      disabled: false
    },
    {
      id: 'resetGridOrigin',
      icon: 'tool-grid-origin',
      label: t('footprintEditor.tools.resetGridOrigin'),
      group: 'utilities',
      disabled: !gridOriginMoved.value
    },
    {
      id: 'lineMode',
      icon: `corner-${lineMode.value}`,
      label: t('footprintEditor.viewport.lineMode', {
        mode:
          lineMode.value === 'free' ? t('footprintEditor.viewport.lineFree') : `${lineMode.value}°`
      }),
      group: 'draw',
      hotkey: hotkeyLabel('footprint.lineMode'),
      disabled: props.isReadOnly
    },
    {
      id: 'find',
      icon: 'search',
      label: t('shared.insertSearch.ops.find'),
      group: 'utilities',
      hotkey: hotkeyLabel('editor.find')
    },
    fitViewOp(t('shared.insertSearch.ops.fitView'), hotkeyLabel('editor.fitView')),
    ...viewCommandOps(t, selectedItems.value.length > 0),
    toggle(
      'sketchPads',
      'view-sketch-pads',
      t('shared.insertSearch.ops.sketchPads'),
      'display',
      footprintView.value.sketchPads
    ),
    toggle(
      'sketchGraphics',
      'view-sketch-graphics',
      t('footprintEditor.viewRail.sketchGraphics'),
      'display',
      footprintView.value.sketchGraphics
    ),
    toggle(
      'sketchText',
      'view-sketch-text',
      t('footprintEditor.viewRail.sketchText'),
      'display',
      footprintView.value.sketchText
    ),
    {
      ...toggle(
        'nonActive',
        'view-dim',
        t('shared.insertSearch.ops.inactiveLayers', {
          mode: t(`shared.nonActiveDisplay.modes.${nonActiveDisplay.value}`)
        }),
        'layers',
        nonActiveDisplay.value !== 'show'
      ),
      hotkey: hotkeyLabel('footprint.inactiveLayers')
    }
  ]
})

const onSearchPick = (id: string): void => {
  const view = footprintView.value
  if (id === FIT_VIEW_OP_ID) viewportRef.value?.zoomToFit()
  else if (isViewCommand(id)) viewportRef.value?.runViewCommand(id)
  else if (id === 'find') find.openFind()
  else if (id === 'lineMode') lineMode.value = nextLineMode(lineMode.value)
  else if (id === 'sketchPads') setFootprintView({ sketchPads: !view.sketchPads })
  else if (id === 'sketchGraphics') setFootprintView({ sketchGraphics: !view.sketchGraphics })
  else if (id === 'sketchText') setFootprintView({ sketchText: !view.sketchText })
  else if (id === 'nonActive') nonActiveDisplay.value = nextNonActiveDisplay(nonActiveDisplay.value)
  else if (isTransformOp(id)) runTransform(transformFor(id))
  else if (id === 'flip') runTransform({ kind: 'flip' })
  else if (id === 'resetGridOrigin') resetGridOrigin()
  else setTool(id as FootprintTool)
}

/** Select the item a command just appended to `collection`. */
const selectLast =
  (type: string): (() => void) =>
  () => {
    const collection = collectionForType(type)
    if (collection?.length) selectedItems.value = [{ type, index: collection.length - 1 }]
  }

/** What a shape tool's collected points become on the footprint, as one command. */
const commitToolShape = (tool: FootprintTool, points: Array<{ x: number; y: number }>): void => {
  const fp = footprint.value
  const gesture = footprintGestureTool(tool)
  if (!fp || !gesture) return
  const shape: PcbToolShape | null = pcbToolShape(gesture, points)
  if (!shape) return
  const layer = activeLayer.value
  const width = graphicDefaults(layer).lineWidth
  const P = (p: { x: number; y: number }): { x: Nm; y: Nm } => ({ x: nm(p.x), y: nm(p.y) })
  switch (shape.kind) {
    case 'lines':
      runCommand(
        t('footprintEditor.commands.addLine'),
        () => {
          for (const seg of shape.segments) {
            addFpLineToFootprintAST(fp, { start: P(seg.start), end: P(seg.end), width, layer })
          }
        },
        { afterApply: selectLast('line') }
      )
      break
    case 'poly':
      runCommand(
        t('footprintEditor.commands.addPolygon'),
        () =>
          addFpPolyToFootprintAST(fp, { points: shape.points.map(P), width, layer, fill: 'solid' }),
        { afterApply: selectLast('poly') }
      )
      break
    case 'rect':
      runCommand(
        t('footprintEditor.commands.addRectangle'),
        () =>
          addFpRectToFootprintAST(fp, { start: P(shape.start), end: P(shape.end), width, layer }),
        { afterApply: selectLast('rect') }
      )
      break
    case 'circle':
      runCommand(
        t('footprintEditor.commands.addCircle'),
        () =>
          addFpCircleToFootprintAST(fp, {
            center: P(shape.center),
            end: P(shape.end),
            width,
            layer
          }),
        { afterApply: selectLast('circle') }
      )
      break
    case 'arc':
      runCommand(
        t('footprintEditor.commands.addArc'),
        () =>
          addFpArcToFootprintAST(fp, {
            start: P(shape.start),
            mid: P(shape.mid),
            end: P(shape.end),
            width,
            layer
          }),
        { afterApply: selectLast('arc') }
      )
      break
    case 'bezier':
      runCommand(
        t('footprintEditor.commands.addBezier'),
        () => addFpCurveToFootprintAST(fp, { points: shape.points.map(P), width, layer }),
        { afterApply: selectLast('curve') }
      )
      break
    case 'textBox': {
      const defaults = graphicDefaults(layer)
      runCommand(
        t('footprintEditor.commands.addTextBox'),
        () =>
          addFpTextBoxToFootprintAST(fp, {
            // Document content, not UI copy: the string to type over.
            text: 'Text',
            start: P(shape.start),
            end: P(shape.end),
            layer,
            size: defaults.textSize,
            thickness: defaults.textThickness,
            width,
            mirror: layer.startsWith('B.')
          }),
        { afterApply: selectLast('textbox') }
      )
      break
    }
    case 'point':
      // KiCad places points one after another, so the tool stays armed.
      runCommand(t('footprintEditor.commands.addPoint'), () =>
        addPointToFootprintAST(fp, { position: P(shape.position), size: DEFAULT_POINT_SIZE, layer })
      )
      break
  }
}

/**
 * A click with a tool armed: a pad or text lands there; a picker acts there and
 * puts itself away; a shape tool collects the point.
 */
const handleToolClick = (point: { x: Nm; y: Nm }): void => {
  if (activeTool.value === 'gridOrigin') {
    gridOrigin.value = { x: point.x, y: point.y }
    setTool('select')
    return
  }
  if (props.isReadOnly) return
  if (activeTool.value === 'pad') {
    addManualPad(point)
    return
  }
  if (activeTool.value === 'text') {
    addManualText(point)
    return
  }
  if (activeTool.value === 'anchor') {
    placeAnchor(point)
    setTool('select')
    return
  }
  const gesture = footprintGestureTool(activeTool.value)
  if (!gesture) return
  const constrained = takesLineMode(gesture)
    ? constrainChainPoint(lineMode.value, toolDraft.value, point)
    : point
  const { draft, commit } = pcbToolClick(gesture, toolDraft.value, constrained)
  toolDraft.value = draft.map((p) => ({ x: nm(p.x), y: nm(p.y) }))
  if (commit) commitToolShape(activeTool.value, commit)
}

/** Right-click, double-click or Enter: a chain ends where it is; a half-drawn span is dropped. */
const handleToolFinish = (): void => {
  const gesture = footprintGestureTool(activeTool.value)
  if (!gesture) return
  const { commit } = pcbToolFinish(gesture, toolDraft.value)
  if (commit) commitToolShape(activeTool.value, commit)
  toolDraft.value = []
}

/** Arm a draw tool from its key: it starts at the cursor when the pointer is over the canvas. */
const armAtCursor = (tool: FootprintTool): void => {
  setTool(tool)
  const cursor = viewportRef.value?.getCursor()
  if (cursor) handleToolClick(cursor)
}

// Hotkey coordinator (bindings in lib/hotkeys.ts)
const handleKeydown = (e: KeyboardEvent): void => {
  if (matchesHotkey(e, 'editor.undo')) {
    e.preventDefault()
    undo()
    return
  }
  if (matchesHotkey(e, 'editor.redo')) {
    e.preventDefault()
    redo()
    return
  }
  if (matchesHotkey(e, 'editor.selectAll')) {
    if (selectAllInField(e)) return
    e.preventDefault()
    if (activeMode.value === 'visual') selectAll()
    return
  }
  if (activeMode.value === 'visual' && find.keydown(e)) return
  if (matchesHotkey(e, 'editor.cancel')) {
    // One step per press: a held move, the points in hand, the tool, the selection.
    if (move.active()) {
      move.cancel()
      return
    }
    if (activeTool.value !== 'select') {
      if (toolDraft.value.length) toolDraft.value = []
      else setTool('select')
      return
    }
    selectedItems.value = []
    return
  }
  if (isTypingTarget() || activeMode.value !== 'visual') return
  const viewCommand = viewCommandFor(e)
  const grid = gridKeyUpdate(e, 'footprint', gridSettings.value, FOOTPRINT_UNIT_SPACINGS)
  if (matchesHotkey(e, 'editor.fitView')) {
    e.preventDefault()
    viewportRef.value?.zoomToFit()
  } else if (viewCommand) {
    e.preventDefault()
    viewportRef.value?.runViewCommand(viewCommand)
  } else if (grid) {
    e.preventDefault()
    handleUpdateGrid(grid)
  } else if (matchesHotkey(e, 'footprint.tool.pad') && !props.isReadOnly) {
    setTool('pad')
  } else if (matchesHotkey(e, 'footprint.tool.polygon') && !props.isReadOnly) {
    e.preventDefault()
    setTool('polygon')
  } else if (matchesHotkey(e, 'footprint.tool.text') && !props.isReadOnly) {
    e.preventDefault()
    setTool('text')
  } else if (matchesHotkey(e, 'footprint.tool.line') && !props.isReadOnly) {
    e.preventDefault()
    // A hotkey acts at the cursor: the line's first point is where the
    // pointer is, when it is over the canvas; off it, the tool arms and waits.
    armAtCursor('line')
  } else if (matchesHotkey(e, 'footprint.tool.arc') && !props.isReadOnly) {
    e.preventDefault()
    armAtCursor('arc')
  } else if (matchesHotkey(e, 'footprint.tool.bezier') && !props.isReadOnly) {
    e.preventDefault()
    armAtCursor('bezier')
  } else if (matchesHotkey(e, 'footprint.tool.circle') && !props.isReadOnly) {
    e.preventDefault()
    armAtCursor('circle')
  } else if (matchesHotkey(e, 'footprint.move') && !props.isReadOnly) {
    if (activeTool.value === 'select') move.start()
  } else if (matchesHotkey(e, 'footprint.rotate')) {
    runTransform({ kind: 'rotate', angle: 90 })
  } else if (matchesHotkey(e, 'footprint.rotateClockwise')) {
    runTransform({ kind: 'rotate', angle: -90 })
  } else if (matchesHotkey(e, 'footprint.flip')) {
    runTransform({ kind: 'flip' })
  } else if (matchesHotkey(e, 'footprint.inactiveLayers')) {
    nonActiveDisplay.value = nextNonActiveDisplay(nonActiveDisplay.value)
  } else if (matchesHotkey(e, 'footprint.lineMode') && lineModeArmed.value) {
    e.preventDefault()
    lineMode.value = nextLineMode(lineMode.value)
  } else if (matchesHotkey(e, 'editor.delete') && !props.isReadOnly) {
    deleteSelected()
  } else if (matchesHotkey(e, 'footprint.copy')) {
    e.preventDefault()
    copySelection()
  } else if (matchesHotkey(e, 'footprint.cut') && !props.isReadOnly) {
    e.preventDefault()
    cutSelection()
  } else if (matchesHotkey(e, 'footprint.paste') && !props.isReadOnly) {
    e.preventDefault()
    pasteClipboard()
  } else if (matchesHotkey(e, 'footprint.duplicate') && !props.isReadOnly) {
    e.preventDefault()
    duplicateSelection()
  } else if (matchesHotkey(e, 'editor.focusSearch') && !props.isReadOnly) {
    e.preventDefault()
    insertSearch.value?.focus()
  }
}

// ---------------------------------------------------------------------------
// Edit commands — published for the title bar's Edit menu and mirrored into the
// canvas right-click menu, as the schematic and symbol editors do.
// ---------------------------------------------------------------------------
const editGroups = computed(() => [
  [
    {
      hotkey: 'editor.undo' as HotkeyActionId,
      label: t('common.undoLabel'),
      enabled: canUndo.value
    },
    {
      hotkey: 'editor.redo' as HotkeyActionId,
      label: t('common.redoLabel'),
      enabled: canRedo.value
    }
  ],
  [
    {
      hotkey: 'footprint.cut' as HotkeyActionId,
      label: t('footprintEditor.edit.cut'),
      enabled: !props.isReadOnly && canCopy.value
    },
    {
      hotkey: 'footprint.copy' as HotkeyActionId,
      label: t('footprintEditor.edit.copy'),
      enabled: canCopy.value
    },
    {
      hotkey: 'footprint.paste' as HotkeyActionId,
      label: t('footprintEditor.edit.paste'),
      enabled: canPaste.value
    },
    {
      hotkey: 'footprint.duplicate' as HotkeyActionId,
      label: t('footprintEditor.edit.duplicate'),
      enabled: !props.isReadOnly && canCopy.value
    },
    {
      hotkey: 'editor.delete' as HotkeyActionId,
      label: t('footprintEditor.edit.delete'),
      enabled: !props.isReadOnly && hasSelection.value
    }
  ],
  [
    {
      hotkey: 'editor.selectAll' as HotkeyActionId,
      label: t('common.selectAllLabel'),
      enabled: !!footprint.value
    }
  ],
  [
    {
      hotkey: 'footprint.rotate' as HotkeyActionId,
      label: t('footprintEditor.edit.rotate'),
      enabled: canTransform.value
    },
    {
      hotkey: 'footprint.rotateClockwise' as HotkeyActionId,
      label: t('footprintEditor.edit.rotateClockwise'),
      enabled: canTransform.value
    },
    {
      hotkey: 'footprint.flip' as HotkeyActionId,
      label: t('footprintEditor.edit.flip'),
      enabled: canFlip.value
    }
  ],
  [
    {
      hotkey: 'editor.find' as HotkeyActionId,
      label: t('shared.insertSearch.ops.find'),
      enabled: !!footprint.value && activeMode.value === 'visual'
    }
  ]
])

usePublishedEditActions(editGroups)

const canvasMenu = ref<{ x: number; y: number } | null>(null)
const canvasMenuItems = computed<MenuNode[]>(() => [
  { id: 'selectOther', label: t('shared.selectOther.menu') },
  { divider: true },
  ...buildEditMenu(editGroups.value)
])

/**
 * Right-click selects what is under the cursor first — acting on something the
 * user did not select is the classic context-menu footgun — but an already
 * selected item leaves a multi-selection intact.
 */
const onCanvasContextMenu = (payload: {
  clientX: number
  clientY: number
  hit: { type: string; index: number } | null
}): void => {
  const { hit } = payload
  if (hit) {
    const already = selectedItems.value.some(
      (item) => item.type === hit.type && item.index === hit.index
    )
    if (!already) selectedItems.value = [hit]
  } else {
    selectedItems.value = []
  }
  canvasMenu.value = { x: payload.clientX, y: payload.clientY }
}

const onCanvasMenuSelect = (id: string): void => {
  if (id === 'selectOther') {
    if (canvasMenu.value) viewportRef.value?.selectOtherAt(canvasMenu.value)
  } else dispatchEditAction(id as HotkeyActionId)
}

// The edit keys KiCad's `RequestSelection` serves: with nothing selected they
// act on the item under the pointer, and let it go after.
useGroupKeydown(
  withHoverKeys(handleKeydown, {
    ...footprintHover,
    keys: [
      'footprint.rotate',
      'footprint.rotateClockwise',
      'footprint.flip',
      'editor.delete',
      'footprint.copy',
      'footprint.cut',
      'footprint.duplicate'
    ],
    ready: () => activeMode.value === 'visual' && activeTool.value === 'select' && !move.active()
  })
)

onMounted((): void => {
  saveLocalName.value = props.name.replace('.kicad_mod', '_copy.kicad_mod')
})

onUnmounted((): void => {
  stopSession()
})

// Save Destination routines
const saveToProjectLocal = (): void => {
  if (!props.projectPath || !footprint.value) return
  const fullPath = `${props.projectPath}/${saveLocalName.value}`
  const content = serializeKicadFootprint(footprint.value)
  emit('save-file', fullPath, content)
  showSaveModal.value = false
}
</script>

<template>
  <div class="footprint-editor-container">
    <!-- MAIN EDITOR WORKSPACE -->
    <div class="editor-workspace-main">
      <!-- Main view based on active mode -->
      <div class="viewport-host-area">
        <!-- Floating toolbar: history | add tools | 3D view | tool search.
             Lives here (not in the 2D viewport) so the 3D toggle stays
             reachable while the 3D view is showing. -->
        <!-- Canvas-only: every control on it edits the footprint, and the 3D
             preview brings its own camera toolbar. -->
        <div v-if="activeMode === 'visual'" v-toolbar-fit class="canvas-floating-toolbar">
          <button
            data-tool-op="undo"
            class="floating-btn history-btn"
            :disabled="!canUndo"
            :title="undoTitle"
            @click="undo"
          >
            <Icon name="undo" />
          </button>
          <button
            data-tool-op="redo"
            class="floating-btn history-btn"
            :disabled="!canRedo"
            :title="redoTitle"
            @click="redo"
          >
            <Icon name="redo" />
          </button>

          <div class="toolbar-divider"></div>

          <button
            v-for="entry in TRANSFORM_TOOLS"
            :key="entry.op"
            data-toolbar-early
            data-toolbar-group="transform"
            :data-tool-op="entry.op"
            class="floating-btn tool-btn"
            :disabled="!canTransform"
            :title="toolTitle(t(entry.label), transformHotkeys[entry.op])"
            @click="runTransform(transformFor(entry.op))"
          >
            <Icon :name="entry.icon" />
          </button>
          <button
            data-tool-op="flip"
            class="floating-btn tool-btn"
            :disabled="!canFlip"
            :title="toolTitle(t('footprintEditor.tools.flip'), 'footprint.flip')"
            @click="runTransform({ kind: 'flip' })"
          >
            <Icon name="tool-flip" />
          </button>

          <div class="toolbar-divider"></div>

          <button
            data-tool-op="pad"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'pad' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('footprintEditor.viewport.pad'), 'footprint.tool.pad')"
            @click="setTool('pad')"
          >
            <Icon name="tool-pad" />
          </button>
          <button
            data-tool-op="line"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'line' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('footprintEditor.viewport.line'), 'footprint.tool.line')"
            @click="setTool('line')"
          >
            <Icon name="tool-line" />
          </button>
          <button
            data-tool-op="arc"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'arc' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('footprintEditor.viewport.arc'), 'footprint.tool.arc')"
            @click="setTool('arc')"
          >
            <Icon name="tool-arc" />
          </button>
          <button
            data-tool-op="rectangle"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'rectangle' }"
            :disabled="isReadOnly"
            :title="t('footprintEditor.viewport.rectangle')"
            @click="setTool('rectangle')"
          >
            <Icon name="tool-rect" />
          </button>
          <button
            data-tool-op="circle"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'circle' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('footprintEditor.viewport.circle'), 'footprint.tool.circle')"
            @click="setTool('circle')"
          >
            <Icon name="tool-circle" />
          </button>
          <button
            data-tool-op="polygon"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'polygon' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('footprintEditor.viewport.polygon'), 'footprint.tool.polygon')"
            @click="setTool('polygon')"
          >
            <Icon name="tool-polygon" />
          </button>
          <button
            data-tool-op="bezier"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'bezier' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('footprintEditor.viewport.bezier'), 'footprint.tool.bezier')"
            @click="setTool('bezier')"
          >
            <Icon name="tool-bezier" />
          </button>
          <button
            data-tool-op="text"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'text' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('footprintEditor.viewport.text'), 'footprint.tool.text')"
            @click="setTool('text')"
          >
            <Icon name="tool-text" />
          </button>
          <button
            data-tool-op="textBox"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'textBox' }"
            :disabled="isReadOnly"
            :title="t('footprintEditor.viewport.textBox')"
            @click="setTool('textBox')"
          >
            <Icon name="tool-text-box" />
          </button>
          <button
            data-tool-op="point"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'point' }"
            :disabled="isReadOnly"
            :title="t('footprintEditor.viewport.point')"
            @click="setTool('point')"
          >
            <Icon name="tool-point" />
          </button>

          <div class="toolbar-divider"></div>

          <button
            data-tool-op="anchor"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'anchor' }"
            :disabled="isReadOnly"
            :title="t('footprintEditor.tools.anchor')"
            @click="setTool('anchor')"
          >
            <Icon name="tool-anchor" />
          </button>
          <button
            data-tool-op="gridOrigin"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'gridOrigin' }"
            :title="t('footprintEditor.tools.gridOrigin')"
            @click="setTool('gridOrigin')"
          >
            <Icon name="tool-grid-origin" />
          </button>

          <!-- The line mode, while the line or polygon tool is armed. -->
          <template v-if="lineModeArmed">
            <div class="toolbar-divider" data-toolbar-late></div>
            <button
              data-toolbar-late
              data-tool-op="lineMode"
              class="floating-btn tool-btn"
              :title="
                t('footprintEditor.viewport.lineModeTitle', {
                  hotkey: hotkeyLabel('footprint.lineMode')
                })
              "
              @click="lineMode = nextLineMode(lineMode)"
            >
              <Icon :name="`corner-${lineMode}`" />
            </button>
          </template>

          <ToolbarSearch ref="insertSearch" :ops="searchOps" @pick="onSearchPick" />
        </div>

        <!-- Left view rail: zoom to fit, then display toggles (KiCad's
             left-toolbar idiom), as on the board editor. The toggles are
             app-wide, like the rest of lib/footprintView.ts. -->
        <div v-if="activeMode === 'visual'" class="canvas-floating-toolbar toolbar-left-rail">
          <FitViewButton @fit="viewportRef?.zoomToFit()" />
          <div class="toolbar-divider"></div>
          <button
            data-tool-op="sketchPads"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: footprintView.sketchPads }"
            :title="t('shared.insertSearch.ops.sketchPads')"
            @click="setFootprintView({ sketchPads: !footprintView.sketchPads })"
          >
            <Icon name="view-sketch-pads" />
          </button>
          <button
            data-tool-op="sketchGraphics"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: footprintView.sketchGraphics }"
            :title="t('footprintEditor.viewRail.sketchGraphics')"
            @click="setFootprintView({ sketchGraphics: !footprintView.sketchGraphics })"
          >
            <Icon name="view-sketch-graphics" />
          </button>
          <button
            data-tool-op="sketchText"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: footprintView.sketchText }"
            :title="t('footprintEditor.viewRail.sketchText')"
            @click="setFootprintView({ sketchText: !footprintView.sketchText })"
          >
            <Icon name="view-sketch-text" />
          </button>
          <div class="toolbar-divider"></div>
          <NonActiveDisplayButton
            v-model:mode="nonActiveDisplay"
            action="footprint.inactiveLayers"
            data-tool-op="nonActive"
          />
        </div>

        <FootprintViewport2D
          v-if="activeMode === 'visual'"
          ref="viewportRef"
          :finding-markers="findingMarkers"
          class="canvas-fill"
          :footprint="footprint"
          :revision="footprintRevision"
          :selected-pad-index="selectedPadIndex"
          :selected-line-index="selectedLineIndex"
          :selected-poly-index="selectedPolyIndex"
          :selected-items="selectedItems"
          :grid-settings="gridSettings"
          :layer-visibility="layerVisibility"
          :active-layer="activeLayer"
          :non-active-display="nonActiveDisplay"
          :sketch="sketch"
          :file-path="props.filePath"
          :active-tool="activeTool"
          :tool-draft="toolDraft"
          :grid-origin="gridOrigin"
          :line-mode="lineModeArmed ? lineMode : 'free'"
          @finding-marker="revealFinding"
          @tool-click="handleToolClick"
          @tool-finish="handleToolFinish"
          @context-menu="onCanvasContextMenu"
          @select-pad="(idx) => (selectedPadIndex = idx)"
          @select-line="(idx) => (selectedLineIndex = idx)"
          @select-poly="(idx) => (selectedPolyIndex = idx)"
          @update:selected-items="(items) => (selectedItems = items)"
          @update-grid="handleUpdateGrid"
          @drag-start="handleDragStart"
          @drag-move="handleDragMove"
          @drag-end="handleDragEnd"
        >
          <template #status>
            <LayersControl
              editor="footprint"
              :listing="layerListing"
              :layer-visibility="layerVisibility"
              :active-layer="activeLayer"
              @toggle-layer-visibility="handleToggleLayerVisibility"
              @set-active-layer="handleSetActiveLayer"
              @apply-layer-preset="handleApplyLayerPreset"
            />
            <HealthPill
              editor="footprint"
              :report="healthReport"
              :open="healthOpen"
              @toggle="healthDrawer.toggle"
            />
          </template>
        </FootprintViewport2D>

        <FootprintViewport3D
          v-else-if="activeMode === '3d'"
          class="canvas-fill"
          :footprint="footprint"
          :file-path="props.filePath"
          :project-path="props.projectPath"
        />

        <div class="canvas-top-right">
          <CanvasFindWidget
            v-if="find.open.value && activeMode === 'visual'"
            ref="findWidget"
            v-model:query="findState.query"
            v-model:options="findState.options"
            :count-label="find.countLabel.value"
            :has-matches="find.results.value.length > 0"
            :invalid="find.invalid.value"
            @next="find.step(1)"
            @previous="find.step(-1)"
            @close="find.closeFind"
          />
          <Preview3dToggle
            v-if="footprint"
            :on="activeMode === '3d'"
            :title="t('shared.preview3dToggle.footprint')"
            @toggle="emit('toggle-preview3d')"
          />
        </div>

        <ContextMenu
          v-if="canvasMenu && activeMode === 'visual'"
          :items="canvasMenuItems"
          :x="canvasMenu.x"
          :y="canvasMenu.y"
          @select="onCanvasMenuSelect"
          @close="canvasMenu = null"
        />

        <FindingsDrawer
          v-if="healthOpen && !healthPinned && activeMode === 'visual'"
          :findings="healthFindings"
          :height="healthHeight"
          :reveal="findingReveal"
          @locate="locateFinding"
          @pin="setPanelPinned('footprint', 'health', true)"
          @close="healthDrawer.close"
          @resize="healthDrawer.resize"
        >
          <template #settings><HealthViewSettings /></template>
        </FindingsDrawer>
      </div>

      <!-- RIGHT SIDEBAR PROPERTY PANEL (hidden on code viewer) -->
      <Teleport v-if="showPanels" :to="panelRail" :disabled="panelsInline">
        <div class="right-sidebar-panel" :style="{ width: propertiesWidth + 'px' }">
          <!-- Horizontal Resizer bar -->
          <ResizeHandle
            edge="left"
            @resize-start="propertiesResizeStart = propertiesWidth"
            @resize="resizeProperties"
            @resize-end="commitProperties"
          />

          <!-- Render status warning if read-only -->
          <div v-if="isReadOnly && !formatReadOnly" class="readonly-sticky-banner">
            <h4>{{ t('footprintEditor.readonlyBanner.title') }}</h4>
            <p>
              {{ t('footprintEditor.readonlyBanner.body') }}
            </p>
            <button
              class="accent-btn"
              style="margin-top: 8px; width: 100%"
              :title="t('footprintEditor.readonlyBanner.exportComponentTitle')"
              @click="showSaveModal = true"
            >
              {{ t('footprintEditor.readonlyBanner.exportPart') }}
            </button>
          </div>

          <Footprint3DPanel v-if="activeMode === '3d'" />

          <FootprintPropertiesPanel
            v-else
            :property-groups="footprintGroups"
            :grid-settings="gridSettings"
            :layer-visibility="layerVisibility"
            :active-layer="activeLayer"
            :read-only="isReadOnly"
            :format-file-path="selectedItems.length === 0 ? props.filePath : null"
            @edit="onFootprintEdit"
            @update-grid="handleUpdateGrid"
            @toggle-layer-visibility="handleToggleLayerVisibility"
            @apply-layer-preset="handleApplyLayerPreset"
            @set-active-layer="handleSetActiveLayer"
          >
            <RailPinnedPanels
              editor="footprint"
              :grid-settings="gridSettings"
              :findings="healthFindings"
              :reveal="findingReveal"
              @update-grid="handleUpdateGrid"
              @locate="locateFinding"
            >
              <template #settings><HealthViewSettings /></template>
            </RailPinnedPanels>
          </FootprintPropertiesPanel>
        </div>
      </Teleport>
    </div>

    <!-- SAVE OVERLAY MODAL -->
    <Modal v-if="showSaveModal" @dismiss="showSaveModal = false">
      <div class="save-modal-content">
        <h3>{{ t('footprintEditor.saveModal.title') }}</h3>
        <p>
          {{ t('footprintEditor.saveModal.subtitle') }}
        </p>

        <div class="option-card" @click="saveToProjectLocal">
          <div class="option-icon"><FileIcon kind="footprint" /></div>
          <div class="option-details">
            <strong>{{ t('footprintEditor.saveModal.saveLocalTitle') }}</strong>
            <span>{{ t('footprintEditor.saveModal.saveLocalDesc') }}</span>
            <input
              v-model="saveLocalName"
              class="modal-text-input"
              :placeholder="t('footprintEditor.saveModal.saveLocalPlaceholder')"
              @click.stop
            />
          </div>
        </div>

        <div class="modal-actions">
          <button class="modal-cancel-btn" @click="showSaveModal = false">
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.footprint-editor-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background-color: var(--vscode-bg-editor, #151c19);
  color: var(--vscode-text, #c5d3cd);
}

/* Toolbar chrome (.canvas-floating-toolbar, .floating-btn, .tool-btn, …)
   comes from assets/canvasToolbar.css */

.accent-btn {
  background-color: var(--vscode-accent, #cca250);
  border: none;
  color: var(--vscode-on-accent);
  font-size: var(--text-body-sm);
  font-weight: bold;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  transition: opacity 0.2s;
}

.accent-btn:hover {
  opacity: 0.9;
}

/* main workspace */
.editor-workspace-main {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.viewport-host-area {
  flex: 1;
  height: 100%;
  position: relative;
  overflow: hidden;
  /* The canvas above, the findings drawer below it. */
  display: flex;
  flex-direction: column;
}

/* Takes what the drawer leaves: a flex basis, not the viewport's own 100%. */
.canvas-fill {
  flex: 1 1 0;
  min-height: 0;
}

/* right properties panel */
.right-sidebar-panel {
  flex-shrink: 0;
  position: relative;
  height: 100%;
  background-color: var(--vscode-bg-sidebar, #1a221f);
  border-left: 1px solid var(--vscode-border, #24302b);
  display: flex;
  flex-direction: column;
}

.readonly-sticky-banner {
  background-color: var(--vscode-accent-subtle);
  border-bottom: 1px solid var(--vscode-accent-border);
  padding: 10px 14px;
  font-size: var(--text-body-sm);
  line-height: 1.4;
}

.readonly-sticky-banner h4 {
  font-size: var(--text-body-sm);
  color: var(--vscode-accent, #cca250);
  font-weight: bold;
  margin-bottom: 2px;
}

.readonly-sticky-banner p {
  color: var(--vscode-text-muted, #748780);
}

.save-modal-content {
  background-color: var(--vscode-bg-sidebar, #1a221f);
  border: 1px solid var(--vscode-border, #24302b);
  width: 440px;
  padding: 24px;
  border-radius: 12px;
  box-shadow: 0 16px 40px var(--vscode-shadow-modal);
}

.save-modal-content h3 {
  color: var(--vscode-accent, #cca250);
  margin-bottom: 8px;
  font-size: 15px;
}

.save-modal-content p {
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted, #748780);
  line-height: 1.5;
  margin-bottom: 20px;
}

.option-card {
  display: flex;
  gap: 14px;
  padding: 14px;
  background-color: var(--vscode-property-value-bg);
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 12px;
  transition: all 0.2s ease;
}

.option-card:hover {
  border-color: var(--vscode-accent, #cca250);
  background-color: var(--vscode-overlay-control);
}

.option-icon {
  display: flex;
  align-items: center;
}

.option-details {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 2px;
}

.option-details strong {
  font-size: 12px;
  color: var(--vscode-text-light, #ffffff);
}

.option-details span {
  font-size: var(--text-caption);
  color: var(--vscode-text-muted, #748780);
}

.modal-text-input {
  background-color: var(--vscode-input-bg);
  border: 1px solid var(--vscode-border, #24302b);
  color: var(--vscode-text-light);
  font-size: var(--text-body-sm);
  padding: 4px 8px;
  border-radius: 4px;
  outline: none;
  margin-top: 6px;
}

.modal-text-input:focus {
  border-color: var(--vscode-accent, #cca250);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
}

.modal-cancel-btn {
  background: transparent;
  border: 1px solid var(--vscode-border, #24302b);
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-body-sm);
  padding: 6px 14px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.modal-cancel-btn:hover {
  color: var(--vscode-text-light);
  border-color: var(--vscode-text-muted);
}
</style>
