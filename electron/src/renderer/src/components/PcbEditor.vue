<script lang="ts">
import type { BoardSession as OpenedSession } from '../lib/board/boardSession'

/**
 * The load each session's board was last wholly refilled for, kept across
 * this editor's mounts: a tab shown again is not a new load.
 */
const openRefilled = new WeakMap<OpenedSession, number>()
</script>

<script setup lang="ts">
import {
  DEFAULT_TEARDROP_SETTINGS,
  readTeardropParams,
  teardropRowEdit,
  writeTeardropParams,
  type TeardropSettings
} from '../lib/board/teardrop/params'
import { writeProjectTeardropSettings } from '../lib/board/teardrop/projectOptions'
import {
  applyTeardropEdit,
  editTeardrops,
  type TeardropDialogRequest,
  type TeardropEdit
} from '../lib/board/teardrop/edit'
import { sameRef } from '../lib/viewportSelection'
import { SELECTION_GROUP, intersectGroups } from '../lib/propertyTable'
import { cssColor } from '../lib/kicad/color'
import { vToolbarFit } from '../lib/canvasToolbar'
import {
  ref,
  watch,
  nextTick,
  onUnmounted,
  computed,
  shallowRef,
  inject,
  markRaw,
  reactive,
  toRefs
} from 'vue'
import { useContextPanels, useEditorGroup, useGroupKeydown } from '../lib/editorWorkspace'
import { pickHighlightNet } from '../lib/board/highlightNet'
import { heldMove, withHoverKeys, type HoverSelection } from '../lib/hoverSelection'
import {
  boardProbeTargets,
  emitCrossProbe,
  emitNetProbe,
  footprintIndicesFor,
  onCrossProbe
} from '../lib/crossProbe'
import { useI18n } from 'vue-i18n'
import {
  updateSegmentInAST,
  updateTrackArcInAST,
  updateViaInAST,
  moveBoardFootprintInAST,
  rotateBoardFootprintInAST,
  updateGrTextInAST,
  setGraphicNetInAST,
  updateBoardMetaInAST,
  addSegmentToBoardAST,
  addViaToBoardAST,
  addGrLineToBoardAST,
  addGrArcToBoardAST,
  addGrCircleToBoardAST,
  addGrRectToBoardAST,
  addGrPolyToBoardAST,
  addGrTextToBoardAST,
  addGrCurveToBoardAST,
  addGrTextBoxToBoardAST,
  addPointToBoardAST,
  addZoneToBoardAST,
  updateBoardZoneInAST,
  setZoneFilledPolysInAST,
  getNetName,
  removeBoardNodeFromAST,
  setBoardItemLockedInAST,
  setBoardOriginInAST,
  type BoardOrigin,
  type ZonePadConnection,
  setBoardStackupInAST,
  updateStackupLayerInAST,
  addStackupDielectricInAST,
  removeStackupLayerInAST,
  type StackupSpec,
  KicadBoard,
  KicadBoardFootprint,
  KicadBoardZone,
  KicadTrackSegment,
  KicadTrackArc,
  KicadVia,
  KicadGrText,
  type KicadTuningPattern,
  type TuningPatternData
} from '../lib/kicad/board'
import {
  updateLineInAST,
  updateArcInAST,
  updateCircleInAST,
  updateRectInAST,
  updatePolyInAST,
  updateTextBoxInAST,
  updateCurveInAST,
  updatePointInAST,
  updateTableInAST,
  updateFootprintMetaInAST,
  updatePadInAST,
  updatePropertyInAST,
  setFootprintFieldText,
  updateTextInAST,
  DEFAULT_POINT_SIZE,
  type KicadFpCurve,
  type KicadFpTextBox,
  type KicadFpText,
  type KicadProperty,
  type KicadPoint,
  type KicadTable,
  type TablePatch,
  type TextBoxPatch,
  type PadPatch,
  type KicadFpLine,
  type KicadFpArc,
  type KicadFpCircle,
  type KicadFpRect,
  type KicadFpPoly,
  type SExprNode,
  type SExprList
} from '../lib/kicad/footprint'
import {
  BOARD_ITEM_COLLECTIONS,
  boardCollection,
  boardOptions,
  buildBoardGroups,
  boardPatch,
  isBoardItemType,
  selectedPads,
  warningSourceOf,
  type BoardContext,
  type BoardItemType
} from '../lib/board/pcbPropertySchema'
import { boardGraphicPatch, footprintPatch } from '../lib/footprint/footprintPropertySchema'
import {
  boardPointInFootprint,
  footprintPointOnBoard,
  footprintTextOf
} from '../lib/board/footprintChildren'
import {
  addNetClass,
  addExtraSize,
  addNetClassPattern,
  applyBoardSetupEdit,
  buildBoardSetupSections,
  buildStackupRows,
  editNetClass,
  importSchematicColors,
  editExtraSize,
  editNetClassPattern,
  removeNetClass,
  removeExtraSize,
  removeNetClassPattern,
  stackupLayerPatch,
  copperNamesFor,
  netClassOptions,
  CUSTOM_PRESET_ID,
  type BoardSetupModel,
  type ExtraSizeField,
  type NetClassEditColumn,
  type StackupColumn
} from '../lib/board/boardSetupSchema'
import { assignableNets } from '../lib/board/netClassCoverage'
import { boardParameters, solverStackupOf, type ProfileSolveError } from '../lib/board/impedance'
import {
  planInterfacePreset,
  presetRuleNames,
  stackupSolver,
  type PresetPlan,
  type PresetRequest
} from '../lib/board/interfacePresets'
import { patchRules } from '../lib/board/rules/druRules'
import { customRuleRows, editCustomRule, removeCustomRule } from '../lib/board/customRuleRows'
import InterfacePresetDraft from './pcb/InterfacePresetDraft.vue'
import { previewPreset, type PresetInputs } from '../lib/board/presetDraft'
import { INTERFACE_PRESETS } from '../lib/board/interfacePresetData'
import {
  addProfileLayer,
  addTuningProfile,
  applyLayerSolve,
  profileRowReadout,
  solveProfileRow,
  editProfileLayer,
  editTuningProfile,
  removeProfileLayer,
  removeTuningProfile,
  type ProfileField,
  type ProfileLayerColumn
} from '../lib/board/tuningProfiles'
import { boardSetupSectionRequest, requestBoardSetupSection } from '../lib/board/boardSetupRequest'
import {
  DEFAULT_CLASS_NAME,
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  defaultNetClass,
  netClassForNet,
  findProjectFile,
  readProjectDesignSettings,
  readProjectLayerPairs,
  writeProjectLayerPairs,
  type ProjectLayerPair,
  customRulesPath,
  writeProjectBoardSetupChoice,
  writeProjectDesignSettings,
  writeProjectRuleSeverities,
  writeProjectTuningProfiles,
  tuningSettingsOf,
  type BoardDesignSettings,
  type BoardSetupChoice,
  type DesignRules,
  type RoutingDefaults,
  type NetClass,
  type NetClassAssignment,
  type ViaSize,
  type NetClassPattern
} from '../lib/kicad/project'
import {
  BUILT_IN_PROFILES,
  allStackupPresets,
  defaultStackupOf,
  matchesProfile,
  stackupPresetLabel
} from '../lib/manufacturingProfiles'
import {
  findAnyProfile,
  findAnyStackupPreset,
  isUserPresetId,
  loadUserSetupPresets,
  removeUserProfile,
  removeUserStackup,
  saveUserProfile,
  saveUserStackup,
  userProfiles,
  userStackupPresets
} from '../lib/board/userSetupPresets'
import type {
  EditorDescriptor,
  PropertyEditValue,
  PropertyField,
  PropertyGroup,
  PropertyValue
} from '../lib/propertyTable'
import type { RuleSeverity, SeverityMap } from '../lib/ruleSeverity'
import type { KicadExclusion } from '../lib/kicadExclusions'
import { emitProjectChange, fileChange, onProjectChange } from '../lib/projectBus'
import { samePath } from '../lib/kicad/paths'
import { boardLayerFlipper, isCopperLayer } from '../lib/kicad/layers'
import { NODE_TRANSFORM_TYPES, transformCenter } from '../lib/board/boardItemTransform'
import { kicadLayerColorsForTheme, useAppTheme } from '../lib/theme'
import { nextNonActiveDisplay, type NonActiveLayerDisplay } from '../lib/board/layerPresets'
import {
  adoptBoardLayers,
  boardViewFor,
  boardViewReady,
  prefetchBoardView
} from '../lib/board/boardViewStore'
import { GridSettings } from '../lib/engine/ViewportEngine'
import {
  gridKeyUpdate,
  updateGridSettings,
  PCB_GRID_DEFAULTS,
  useGridSettings,
  PCB_UNIT_SPACINGS
} from '../lib/gridPreferences'
import {
  BoardItemRef,
  boardItemKind,
  boardRefKey,
  footprintsOf,
  promotePads,
  type BoardEditDelta
} from '../lib/engine/BoardScene'
import type { BoardCommandOptions, BoardSession } from '../lib/board/boardSession'
import {
  matchesHotkey,
  hotkeyLabel,
  isTypingTarget,
  toolTitle,
  isHotkeyActionId,
  type HotkeyActionId
} from '../lib/hotkeys'
import { mergeBoardLoadProgress } from '../lib/boardLoadProgress'
import {
  buildEditMenu,
  dispatchEditAction,
  selectAllInField,
  usePublishedEditActions
} from '../lib/editActions'
import { usePublishedExportActions } from '../lib/exportActions'
import { board3dExportPath, type PixelSize } from '../lib/board3dExport'
import { canvasPngBase64, copyCanvasPng } from '../lib/engine/board3d/viewExport'
import ContextMenu from './shared/ContextMenu.vue'
import { boardItemLabel } from '../lib/board/boardItemLabel'
import {
  pairOpKeys,
  routeOpKeys,
  tuneOpKeys,
  type KeyRow,
  type OpKeys
} from '../lib/board/routeHints'
import type { MenuNode } from '../lib/menu'
import type { IconName } from '../lib/icons'
import type { KeyCap } from '../lib/keyCap'
import { matchDiffPair } from '../lib/board/rules/diffPairs'
import { setClipboard, usePasteable } from '../lib/documentClipboard'
import {
  copyBoardItems,
  insertIntoBoard,
  itemsAnchor,
  pasteOffset,
  prepareBoardPaste,
  type Point
} from '../lib/board/pcbClipboard'
import {
  flippedPlacementAngle,
  placeFootprintNode,
  placedReference,
  placementFootprint
} from '../lib/board/footprintPlace'
import { loadLibraryFootprint } from '../lib/libraryLoad'
import { openTargetFor } from '../lib/componentAssociations'
import type { IndexRecord } from '../lib/libraryIndex'
import LibraryChooser from './shared/LibraryChooser.vue'
import PartUpdateDialog from './shared/PartUpdateDialog.vue'
import CleanupTracksDialog from './pcb/CleanupTracksDialog.vue'
import EditTeardropsDialog from './pcb/EditTeardropsDialog.vue'
import {
  DEFAULT_CLEANUP_OPTIONS,
  applyTrackCleanup,
  planInSlices,
  planTrackCleanup,
  type CleanupPlan,
  type CleanupScope,
  type TrackRef
} from '../lib/board/trackCleanup'
import type { CleanupRequest, CleanupRow } from '../lib/board/cleanupDialog'
import Board3DExportDialog from './pcb/Board3DExportDialog.vue'
import {
  inScope,
  type PartUpdateMode,
  type PartUpdateRequest,
  type PartUpdateRow
} from '../lib/partUpdate'
import { compareReferencesNatural } from '../lib/componentsTable'
import {
  CHANGE_DEFAULTS as FOOTPRINT_CHANGE_DEFAULTS,
  EXCHANGE_OPTION_KEYS,
  UPDATE_DEFAULTS as FOOTPRINT_UPDATE_DEFAULTS,
  exchangeFootprints,
  exchangedFootprintNode,
  isSymbolOwned,
  type ExchangeOptions,
  type ExchangeTarget
} from '../lib/board/footprintExchange'
import { libraryDifference } from '../lib/board/footprintParity'
import { libraryPartOf, librarySyncStatus, type LibrarySync } from '../lib/librarySync'
import LibraryLinkSection from './shared/LibraryLinkSection.vue'
import { designCopyPath } from '../lib/designCopy'
import { findChild, getAtomValues, markNodeDirty } from '../lib/kicad/sexpr'
import { findFootprint, loadIndex as loadLibraryIndex, onIndexRebuilt } from '../lib/libraryIndex'
import { readonlyLibTabPath } from '../lib/tabs'
import {
  SCHEMATIC_SOURCE,
  driftOf,
  type SchematicRead,
  type SyncDrift
} from '../lib/board/syncDrift'
import type { KicadFootprint, KicadPad } from '../lib/kicad/footprint'
import { afterPaint } from '../lib/cooperate'
import { stackupSpecOf } from '../lib/board/boardSetup'
import { netsInUse } from '../lib/board/boardSync'
import { zoneKey } from '../lib/board/boardItems'
import { boardRules, type BoardRules } from '../lib/board/rules/boardRules'
import { explainLimits, explainTargetOf, type ExplainedLimit } from '../lib/board/rules/explain'
import LimitsSection from './pcb/LimitsSection.vue'
import {
  formatSize,
  formatVia,
  resolvePairSizes,
  resolveTrackWidth,
  resolveVia,
  selectionSizeLists,
  stepDrawn,
  stepIndex,
  tuningProfileOf,
  type RouteSizeChoice,
  type SizeEntry,
  type SizeRule,
  type WidthSource
} from '../lib/board/routeSizes'
import { stackupHeights } from '../lib/board/netLength'
import { pendingRouteLength } from '../lib/board/routeLength'
import { mmToNm, nm, nmToMm, spacingToMm, type Nm } from '../lib/kicad/coordinates'
import { pcbViewState, setPcbView } from '../lib/pcbView'
import {
  boardVertexShape,
  isVertexItemType,
  moveShapeVertex,
  normalizedShape,
  vertexShapeGhost,
  type VertexItemType,
  type VertexShape
} from '../lib/board/graphicVertices'
import {
  graphicDefaults,
  isGestureTool,
  nextRouteCornerMode,
  pcbToolClick,
  stepCopperLayer,
  pcbToolFinish,
  pcbToolShape,
  takesLineMode,
  type PcbTool,
  type PcbToolShape,
  type Point2,
  type RouteCornerMode
} from '../lib/board/pcbTools'
import { constrainChainPoint } from '../lib/lineMode'
import { tk } from '../lib/messageKey'
import type { MirrorAxis } from '../lib/board/boardMirror'
import {
  duplicateNodes,
  flipBoardItems,
  flipUnits,
  mirrorBoardItems,
  mirrorCenter,
  MIRROR_TYPES,
  mirrorEntries,
  moveElements,
  rotateBoardItems,
  rotateUnits,
  snapshotMoveElements,
  writeVertexShape,
  type MoveElement
} from '../lib/board/boardSelectionEdit'
import {
  applyFanout,
  fanoutEligible,
  fanoutRulesOf,
  planFanout,
  type FanoutOutcome,
  type FanoutPlan
} from '../lib/board/fanout'
import FanoutWidget, { type FanoutSettings } from './pcb/FanoutWidget.vue'
import { flipBoardFootprintInAST, footprintFlippable } from '../lib/board/footprintFlip'
import {
  connectedShapes,
  connectionWorldFromIndex,
  expandConnection,
  footprintPads,
  netItems,
  unrouteNeighbors,
  type ConnId,
  type ConnShape
} from '../lib/board/selectConnection'
import {
  RouteController,
  createRouteState,
  routerOptionsOf,
  routerWorldOf,
  selectedRouteRefs,
  selectedRouteStart,
  selectedFinishEdges,
  type CopperRef,
  type RouteDraft,
  type RouteOutcome,
  type RouteStart
} from '../lib/board/routeController'
import { applyRouterDelta } from '../lib/board/routeLanding'
import { useSelectionFilter } from '../lib/selectionFilter'
import type { TransformOp } from '../lib/schematic/schematicTransform'
import { BoardSpatialIndex, boardIndex, type CopperItem } from '../lib/board/spatialIndex'
import {
  dragAirwires,
  startDragRatsnest,
  draggedRefPredicate,
  translateAirwires,
  type BoardConnectivity
} from '../lib/board/boardConnectivity'
import { type RouteMode, type RouteOptions, type ViolationMark } from '../lib/board/router/engine'
import type { ShoveDelta } from '../lib/board/router/shove'
import { DragSession, type DragOptions } from '../lib/board/router/drag'
import { ViaDragSession } from '../lib/board/router/viaDrag'
import { ComponentDragSession } from '../lib/board/router/componentDrag'
import {
  nextLayerPair,
  viaSpan,
  type LayerPair,
  type RouteViaType
} from '../lib/board/viaPlacement'
import { MultiDragSession } from '../lib/board/router/multiDrag'
import { ArcDragSession } from '../lib/board/router/arcDrag'
import { DiffPairSession, type PairProposal, type PairViaSpec } from '../lib/board/router/diffPair'
import {
  beginPair as beginPairDraft,
  clickPair,
  pairEndAt as pairEndAtIn,
  pairLaid,
  pairMateOf as pairMateIn,
  pairPushes,
  pairSegments,
  pairSizesOf,
  pairTarget,
  proposePair,
  switchPairLayer,
  undoPair,
  writePair,
  type PairDraft
} from '../lib/board/pairRoute'
import {
  netTrackLength as netTrackLengthOf,
  startTune,
  tuneRuleFor as tuneRuleOf,
  tuneSeedAt,
  tuneSegments,
  tunedTrackLength as tunedTrackLengthOf,
  tuneTimeScale,
  inTuningPattern,
  type TuneSetup,
  writeTune
} from '../lib/board/tuneTool'
import {
  TUNE_MODE_OF,
  patternTimeOf as patternTimeIn,
  planRetunes,
  retuneOf as retunePatternOf,
  writeRetune,
  writeRetunes,
  type RetuneHost
} from '../lib/board/patternRetune'
import { gestureFree, redoAllowed, undoTarget, type LiveGestures } from '../lib/board/liveGesture'
import { netLengthStats } from '../lib/board/tuneLength'
import type { TuneMeterReading } from '../lib/board/tuneMeter'
import {
  dropOutcome,
  escapeAction,
  routerMenuRows,
  type RouterGesture,
  type RouterMenuId
} from '../lib/board/routerGesture'
import {
  TuneSession,
  stepMeander,
  tuneTargetOf,
  type TuneMode,
  statusOf,
  type TuneRule,
  type TuneTarget,
  type TuneTimeScale,
  type TuneUpdate
} from '../lib/board/router/tuning'
import {
  deletePatternInAST,
  handlesEdit,
  patternEdit,
  patternMembers,
  prunePatternsInAST,
  restorePatternInAST
} from '../lib/board/tuningPatterns'
import { DEFAULT_MEANDER, type MeanderSettings } from '../lib/board/router/meander'
import {
  DEFAULT_TUNING_PATTERN_SETTINGS,
  readProjectTuningPatternSettings,
  writeProjectTuningPatternSettings,
  type TuningPatternSettings
} from '../lib/kicad/project'
import type { RouteNetClusters } from '../lib/board/router/autocomplete'
import PcbViewport2D, { type RouteStateReport, type ToolClick } from './pcb/PcbViewport2D.vue'
import PcbPropertiesPanel from './pcb/PcbPropertiesPanel.vue'
import Pcb3DPanel from './pcb/Pcb3DPanel.vue'
import PcbBoardSetup from './pcb/PcbBoardSetup.vue'
import CollisionModeControl from './pcb/CollisionModeControl.vue'
import CustomSizeForm from './pcb/CustomSizeForm.vue'
import ResizeHandle from './shared/ResizeHandle.vue'
import HealthPill from './shared/HealthPill.vue'
import FindingsDrawer from './shared/FindingsDrawer.vue'
import LayersControl from './shared/LayersControl.vue'
import RailPinnedPanels from './shared/RailPinnedPanels.vue'
import { boardLayerListing } from '../lib/board/layerListing'
import {
  documentFindings,
  findingMarks,
  type HealthFinding,
  type HealthReport
} from '../lib/designHealth'
import { designHealthViewState } from '../lib/designHealthView'
import HealthViewSettings from './shared/HealthViewSettings.vue'
import { useHealthDrawer } from '../lib/designHealthDrawer'
import PerformancePanel, { type PerformanceTask } from './shared/PerformancePanel.vue'
import BoardAutomationSettings from './pcb/BoardAutomationSettings.vue'
import {
  boardAutomationFor,
  setBoardAutomation,
  type BoardAutomation
} from '../lib/board/boardAutomation'
import type { TaskTiming, TimedTask } from '../lib/board/worker/boardWorkerHost'
import { BOARD_KICAD_KEYS } from '../lib/board/boardChecks'
import { unpackFillPoly } from '../lib/board/worker/protocol'
import {
  commitsViolations,
  dragCorner,
  nextRouterCorner,
  nextRouterMode,
  ROUTER_CORNERS,
  ROUTER_MODES,
  type PcbRouterCorner,
  type PcbRouterMode,
  pcbRouterState,
  routeCorner,
  routerSettings,
  setPcbRouter
} from '../lib/pcbRouter'
import { readBoardLibraryData, type BoardLibraryData } from '../lib/board/boardLibraries'
import { boardLibraryIo } from '../lib/board/boardLibraryIo'
import { createLibraryFeed, touchesProjectLibraries } from '../lib/libraryFeed'
import { boardItemPosition, locateBoardItems } from '../lib/board/boardLocate'
import type { CheckResult } from '../lib/schematic/checks'
import { panelPinned, panelWidth, setPanelPinned, setPanelWidth } from '../lib/panelLayout'
import Icon from './shared/Icon.vue'
import NonActiveDisplayButton from './shared/NonActiveDisplayButton.vue'
import FitViewButton from './shared/FitViewButton.vue'
import Preview3dToggle from './shared/Preview3dToggle.vue'
import ToolbarSearch from './shared/ToolbarSearch.vue'
import CanvasFindWidget from './shared/CanvasFindWidget.vue'
import { useCanvasFind } from '../lib/useCanvasFind'
import { boardFindCandidates, type BoardFindTarget } from '../lib/board/boardFind'
import { isViewCommand, viewCommandFor, viewCommandOps } from '../lib/viewCommands'
import {
  fitViewOp,
  FIT_VIEW_OP_ID,
  isTransformOp,
  TRANSFORM_TOOLS,
  type ToolbarSearchOp
} from '../lib/toolSearch'

const { t } = useI18n()
const { groupId } = useEditorGroup()
const { show: showPanels, inline: panelsInline, rail: panelRail } = useContextPanels()

interface ViewportExposed {
  saveDragOrigins(items: BoardItemRef[]): void
  clearDragOrigins(): void
  translateElements(items: BoardItemRef[], delta: { x: number; y: number }): void
  rebuildAndRender(): void
  showShapeGhost(shape: PcbToolShape | null, layer: string): void
  zoomToFit(): void
  fit3D(): void
  view3DSize(): PixelSize | null
  export3DImage(size: PixelSize): HTMLCanvasElement | null
  focusPoint(x: number, y: number): void
}

const props = defineProps<{
  modelValue: string
  name: string
  filePath?: string | null
  isReadOnly?: boolean
  /** The open board this view draws (`lib/board/boardSession.ts`). */
  session: BoardSession
  /** True shows Board Setup (stackup + design rules) instead of the canvas: the board's setup tab. */
  boardSetup?: boolean
  /** True shows the 3D board instead of the canvas. */
  preview3d?: boolean
  /** Parts selected in a schematic, to select and reveal here (lib/crossProbe.ts). */
  probeRequest?: { symbolUuids: string[]; references: string[]; nonce: number } | null
  /** Items by uuid to select and reveal — a finding opened from another surface. */
  focusRequest?: { uuids: string[]; at?: { x: number; y: number }; nonce: number } | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  /** Open Manufacture mode for this board (from the properties panel). */
  (e: 'open-manufacture', boardPath: string): void
  /** Open this board's Board Setup tab (the properties panel, the size list's Edit sizes…). */
  (e: 'open-setup'): void
  /** Open Update PCB from Schematic for this board (the properties panel). */
  (e: 'update-from-schematic', boardPath: string): void
  /** Switch between the canvas and the 3D preview (the top-right toggle). */
  (e: 'toggle-preview3d'): void
  /** The chooser's Open: a library symbol in the symbol library viewer. */
  (e: 'open-library-symbol', path: string, symbol: string): void
  /** The chooser's Open: a footprint or model in its own tab. */
  (e: 'open-file', node: { name: string; path: string }): void
  /**
   * Load progress (0–1), null when settled: the parse and the 2D scene build
   * merged (lib/boardLoadProgress.ts). EditorArea folds it into the single
   * bar that spans file read → parse → first painted board, so the user sees
   * one continuous progress instead of stacked phases.
   */
  (e: 'load-progress', fraction: number | null): void
}>()

// Every mode is the tab's, held in EditorGroup: Board Setup is a tab of its
// own, and the 3D preview is a per-tab switch this editor's top-right toggle
// asks for. Nothing here decides which view is showing; this only orders the
// precedence.
const activeMode = computed<'visual' | '3d' | 'setup'>(() =>
  props.boardSetup ? 'setup' : props.preview3d ? '3d' : 'visual'
)

// Parsed board model
/** The session's board, re-read after every change it announces. */
const boardVersion = ref(0)
const board = computed<KicadBoard | null>(() => {
  void boardVersion.value
  return props.session.board()
})
const parseError = computed<string | null>(() => {
  void boardVersion.value
  return props.session.parseError()
})
// The refill's state, declared before the session subscriber that reads it.
let refillTimer: number | null = null
/** A load's whole refill has not landed yet: the next refill fills every zone. */
let refillAllOwed = false
let refillToken = 0
let refillRunning = false
let refillCommitting = false
/** Set while this editor's own command runs, which notes its change itself. */
let ownCommand = false
const stopSession = props.session.subscribe((): void => {
  const change = ownCommand ? null : props.session.lastChange()
  const before = board.value
  boardVersion.value++
  // Someone else's edit moved the board under a live gesture: its sessions
  // index copper that may be gone, so each ends rather than landing against a
  // stale world (route, drag, pair and tune alike).
  if (!ownCommand) {
    route.outsideChange()
    if (board.value !== before) {
      dropLiveGestures()
      // Route Selected's queue names copper by index on the old board.
      routeQueue.value = []
    }
  }
  // A command from elsewhere (an agent's) patches the scene as this editor's own do.
  if (change && board.value && change.fromBoard !== board.value) {
    const from = change.fromBoard
    editDelta.value = {
      id: ++editDeltaId,
      fromBoard: from,
      raws: change.raws,
      prev: {
        segments: from.segments.slice(),
        trackArcs: from.trackArcs.slice(),
        vias: from.vias.slice(),
        footprints: from.footprints.slice(),
        zones: from.zones.slice()
      }
    }
  }
  // Zones an agent's edit left stale refill on this editor's own debounce,
  // as a hand edit's would; the refill's own commit never schedules another.
  // An undo or redo, the person's or an agent's, restores its fills and never
  // refills (see `undo`).
  if (props.session.lastStep()) cancelScheduledRefill()
  else if (!refillCommitting && props.session.staleZones().size > 0) scheduleRefill()
})

// The last command's exact change, for the viewport's incremental scene
// apply (BoardScene.applyBoardEdit). Replaced whole per command.
const editDelta = shallowRef<BoardEditDelta | null>(null)
let editDeltaId = 0

// Selection state
const selectedItems = ref<BoardItemRef[]>([])

// Viewport ref
const viewportRef = ref<(InstanceType<typeof PcbViewport2D> & ViewportExposed) | null>(null)

// Grid is a session/view preference (persisted across tabs/restarts, per editor
// kind) — never written to the .kicad_pcb.
const gridSettings = useGridSettings('pcb', PCB_GRID_DEFAULTS)

// Tool state
const activeTool = ref<PcbTool>('select')
// Committed clicks of an armed graphics tool (scene coords, y up); the
// gesture rules that grow/commit it live in lib/board/pcbTools.ts.
const toolDraft = ref<Point2[]>([])

// ---------------------------------------------------------------------------
// Route state: the pending (uncommitted) trace, held by the headless route
// controller (lib/board/routeController.ts) that an agent's routing session
// drives too. Segments accumulate per click and land as ONE undo entry on
// finish; Esc ends the route keeping what was clicked. This editor is its
// adapter: the routed layer is the active layer, the cursor and magnet come
// from the viewport, the keys from the hotkeys. Scene coords (y up).
// ---------------------------------------------------------------------------
const route = markRaw(
  new RouteController(
    {
      board: () => board.value,
      index: () => spatialIndex.value,
      world: () => routerWorld.value,
      prefs: () => routerPrefs.value,
      useConnectedWidth: () => boardView.value.autoTrackWidth,
      setup: () => ({
        rules: setupRules.value,
        classes: setupClasses.value,
        patterns: setupPatterns.value,
        assignments: setupAssignments.value,
        tuning: setupTuning.value,
        extraSizes: setupExtraSizes.value,
        customRules: setupCustomRules.value
      }),
      sizeRules: () => sizeRules.value,
      layer: () => routingLayer.value,
      setLayer: (layer) => handleSetActiveLayer(layer),
      land: (mutate) => runCommand(t('pcbEditor.commands.routeTrack'), mutate),
      netAt: (point) => netAtPoint(point)
    },
    reactive(createRouteState())
  )
)
const {
  tail: routeTail,
  viaTarget: routeViaTarget,
  startVia: routeStartVia,
  net: routeNet,
  postureFlip: routePostureFlip,
  sizeChoice
} = toRefs(route.state)
/** The layer pair (R40): what a via toggles between and a blind via spans (R42 steps the presets). */
const layerPair = computed<LayerPair>(() => route.layerPair())
const layerPairPresets = ref<ProjectLayerPair[]>([])
/** The posture the live head is drawn in, as the viewport last reported it. */
const routeDiagFirst = ref(true)
/**
 * The router's settings, a user preference shared by every window
 * (lib/pcbRouter.ts) and set from the router pill in the corner.
 */
const routerPrefs = pcbRouterState()
/** Refuse to commit a violating segment (the preview shows it red either way). */
const blockViolations = computed(() => !commitsViolations(routerPrefs.value))
/**
 * The route's corners (R3): the router's corner mode, rounded into arcs in
 * KiCad's Arc 45 and Arc 90, or free in Highlight with *Free angle mode*.
 */
const routeCornerMode = computed<RouteCornerMode>(() => routeCorner(routerPrefs.value).cornerMode)
const routeRounded = computed(() => routeCorner(routerPrefs.value).rounded)
/** `Ctrl+/`: the next corner mode (KiCad's Track Corner Mode Switch). */
const nextRouteCorner = (): void =>
  setPcbRouter({ corner: nextRouterCorner(routerPrefs.value.corner ?? '45') })
/** The graphics tools' line mode (KiCad's, Shift+Space): apart from the route's corners. */
const lineMode = ref<RouteCornerMode>('45')
/** What the viewport constrains with: the line mode for a graphics tool, else the route's corners. */
const viewportCornerMode = computed<RouteCornerMode>(() =>
  takesLineMode(activeTool.value) ? lineMode.value : routeCornerMode.value
)

const routeDraft = computed<RouteDraft | null>(() => route.draft())

/**
 * Copper index for snapping and clearance. Rebuilt per command (the board
 * ref changes on every edit), but delta-aware: when the last command's
 * change set is available, unchanged items reuse their extracted shapes
 * (BoardSpatialIndex.buildFrom) and only the touched ones re-extract. A
 * board change without a matching delta — load, undo/redo, external reload —
 * takes the full build.
 */
let lastIndexBoard: KicadBoard | null = null
let lastIndex: BoardSpatialIndex | null = null
const spatialIndex = computed(() => {
  const b = board.value
  if (!b || activeMode.value !== 'visual') return null
  if (lastIndexBoard === b && lastIndex) return lastIndex
  const delta = editDelta.value
  const idx =
    delta && lastIndex && lastIndexBoard && delta.fromBoard === lastIndexBoard
      ? boardIndex(b, { from: lastIndex, prevArrays: delta.prev, raws: delta.raws })
      : boardIndex(b)
  lastIndexBoard = b
  lastIndex = idx
  return idx
})

/** The engine's world over the current index, held inside the edge and keepouts and clear of holes. */
const routerWorld = computed(() => {
  const idx = spatialIndex.value
  const b = board.value
  if (!idx || !b) return null
  return routerWorldOf(b, idx, {
    rules: setupRules.value,
    classes: setupClasses.value,
    patterns: setupPatterns.value,
    assignments: setupAssignments.value,
    tuning: setupTuning.value,
    customRules: setupCustomRules.value
  })
})

/**
 * How the router routes, drags and pushes: the router menu's settings, read
 * live, and nothing locked moves (docs/router-behavior.md P1).
 */
const pushOptions = (): RouteOptions & DragOptions =>
  routerOptionsOf(
    () => routerPrefs.value,
    () => board.value
  )

// --- Track and via drag (KiCad's gesture), reachable two ways: `D` grabs
// under the cursor with no selection needed (move follows, click commits) and
// the select tool's press-drag on a lone segment or via (release commits).
// Both pull the copper through the router; Esc/right-click cancels either. --
const trackDrag = shallowRef<
  DragSession | ViaDragSession | ComponentDragSession | MultiDragSession | ArcDragSession | null
>(null)
/** The footprints a footprint drag moves (D13), drawn moved by the viewport as a move is. */
let componentDragRefs: BoardItemRef[] = []
/** Set while the live track drag is the mouse gesture, not the `D` one. */
const mouseTrackDrag = ref(false)
/** Set once the mouse gesture has actually moved. */
const mouseTrackDragMoved = ref(false)

/**
 * Net the viewport gets focus-dim for. The mouse gesture arms it only once
 * movement begins: the session opens on mousedown, and dimming there would
 * flash the whole board on every plain click of a track. `D` dims at once —
 * it is an explicit drag command, and KiCad's does too.
 */
const trackDragNet = computed(() =>
  pairDraft.value
    ? pairDraft.value.nets.p
    : trackDrag.value && (!mouseTrackDrag.value || mouseTrackDragMoved.value)
      ? trackDrag.value.net
      : 0
)
/**
 * Highlight Net (`): the net held lit, 0 for none. KiCad's: a route or drag
 * focuses its own net meanwhile, and this one comes back after.
 */
const highlightedNet = ref(0)

const trackDragPreview = ref<{
  hiddenRefs: Array<{ type: string; index: number }>
  segments: Array<{
    x0: number
    y0: number
    x1: number
    y1: number
    width: number
    layer: string
    violation?: boolean
  }>
  vias?: Array<{ index: number; x: number; y: number; size: number }>
  marks?: ViolationMark[]
  /** The clearance the dragged track keeps, and where in `segments` it begins. */
  clearance?: { mm: number; from: number; viaFrom?: number }
} | null>(null)
/** The clearance the live track drag keeps: its net class's, as the session's. */
let trackDragClearance = 0
/** Where the live drag last stood legal: a refused drop in Push or Avoid lands there (D9). */
let lastValidDragPoint: { x: number; y: number } | null = null

/** What a refused drop or start violated, marked for a moment after it springs back (D9, R24). */
const refusalMarks = shallowRef<ViolationMark[]>([])
const REFUSAL_MARK_MS = 1000
let refusalTimer: ReturnType<typeof setTimeout> | undefined
const markRefusal = (marks: ViolationMark[]): void => {
  clearTimeout(refusalTimer)
  refusalMarks.value = marks
  if (marks.length > 0) refusalTimer = setTimeout(() => (refusalMarks.value = []), REFUSAL_MARK_MS)
}
onUnmounted(() => clearTimeout(refusalTimer))

/** End a drag whose drop was refused: it springs back, what it violated marked (D9). */
const springBackTrackDrag = (): void => {
  const marks = trackDragPreview.value?.marks ?? []
  endTrackDrag()
  markRefusal(marks)
}

const openTrackDrag = (seed: CopperItem, cursor: { x: number; y: number }): boolean => {
  const w = routerWorld.value
  if (!w || props.isReadOnly) return false
  const netName = board.value ? getNetName(board.value, seed.net) : ''
  const cls = netName
    ? netClassForNet(netName, setupClasses.value, setupPatterns.value, setupAssignments.value)
    : defaultNetClass(setupClasses.value)
  if (seed.ref.type === 'via' && board.value?.vias[seed.ref.index]?.locked) return false
  const session =
    seed.ref.type === 'via'
      ? new ViaDragSession(w, seed, cls.clearance, pushOptions())
      : new DragSession(w, seed, cursor, cls.clearance, pushOptions())
  if (!session.valid) return false
  trackDrag.value = session
  trackDragClearance = cls.clearance
  return true
}

/** D14: open a drag of the selected track segments together, the one under the cursor leading. */
const openMultiTrackDrag = (refs: BoardItemRef[], cursor: { x: number; y: number }): boolean => {
  const w = routerWorld.value
  const idx = spatialIndex.value
  if (!w || !idx || props.isReadOnly) return false
  const seeds = refs
    .map((r) => idx.items.find((it) => it?.ref.type === 'segment' && it.ref.index === r.index))
    .filter((it): it is CopperItem => it !== undefined)
  const clearance = defaultNetClass(setupClasses.value).clearance
  const session = new MultiDragSession(w, seeds, cursor, clearance, pushOptions())
  if (!session.valid) return false
  trackDrag.value = session
  trackDragClearance = clearance
  return true
}

/** The live track drag draws at free angle, whatever the corner mode (`G`, KiCad's). */
const trackDragFree = ref(false)

const beginTrackDrag = (free = false): void => {
  trackDragFree.value = free
  const idx = spatialIndex.value
  if (!idx) return
  const cursor = viewportRef.value?.getCursor()
  if (!cursor) return
  // D14: tracks of several lines selected drag together, the one under the cursor leading.
  const selectedTracks = selectedItems.value.filter((r) => r.type === 'segment')
  if (selectedTracks.length >= 2 && openMultiTrackDrag(selectedTracks, cursor)) {
    handleTrackDragMove(cursor)
    return
  }
  // A via under the cursor before a track near it (D6).
  const near = idx.near(cursor.x, cursor.y, 0.5, {})
  // An arc under the cursor drags its radius (D15).
  const arcHit = near.find((h) => h.item.ref.type === 'tarc' && h.dist === 0)?.item
  const arcWorld = routerWorld.value
  if (arcHit && arcWorld && !props.isReadOnly && !b0Locked(arcHit)) {
    const clearance = defaultNetClass(setupClasses.value).clearance
    const session = new ArcDragSession(arcWorld, arcHit, clearance, pushOptions())
    if (session.valid) {
      trackDrag.value = session
      trackDragClearance = clearance
      handleTrackDragMove(cursor)
      return
    }
  }
  const grabbed =
    near.find((h) => h.item.ref.type === 'via' && h.dist === 0)?.item ??
    near.find((h) => h.item.ref.type === 'segment')?.item
  // PR6: a half of a differential pair drags with its mate beside it, as a bus does (D14).
  const mate = grabbed ? pairMateOf(grabbed) : null
  const mateWorld = routerWorld.value
  if (grabbed && mate && mateWorld && !props.isReadOnly) {
    const clearance = defaultNetClass(setupClasses.value).clearance
    const session = new MultiDragSession(
      mateWorld,
      [grabbed, mate],
      cursor,
      clearance,
      pushOptions()
    )
    if (session.valid) {
      trackDrag.value = session
      trackDragClearance = clearance
      handleTrackDragMove(cursor)
      return
    }
  }
  if (grabbed) {
    if (openTrackDrag(grabbed, cursor)) handleTrackDragMove(cursor)
    return
  }
  openComponentDrag(cursor)
}

/**
 * D13: `D` on a footprint, or with footprints selected, drags them with the
 * tracks that end on their pads (KiCad's footprint drag). The selection's
 * footprints, else the one whose pad or body is under the cursor.
 */
const openComponentDrag = (cursor: { x: number; y: number }): void => {
  const b = board.value
  const w = routerWorld.value
  const idx = spatialIndex.value
  if (!b || !w || !idx || props.isReadOnly) return
  let footprints = selectedItems.value.filter((r) => r.type === 'footprint').map((r) => r.index)
  if (footprints.length === 0) {
    const hit = viewportRef.value?.itemAtCursor?.()
    const under =
      hit?.type === 'footprint' || hit?.type === 'pad'
        ? hit.index
        : idx.near(cursor.x, cursor.y, 0, {}).find((h) => h.item.ref.type === 'pad')?.item.ref.index
    if (under === undefined) return
    footprints = [under]
  }
  if (footprints.some((i) => b.footprints[i]?.footprint.locked)) return
  const set = new Set(footprints)
  const pads = idx.items.filter(
    (item): item is CopperItem => !!item && item.ref.type === 'pad' && set.has(item.ref.index)
  )
  const clearance = defaultNetClass(setupClasses.value).clearance
  trackDrag.value = new ComponentDragSession(w, pads, cursor, clearance)
  trackDragClearance = clearance
  componentDragRefs = footprints.map((index) => ({ type: 'footprint', index }))
  viewportRef.value?.saveDragOrigins(componentDragRefs)
  handleTrackDragMove(cursor)
}

const handleTrackDragMove = (pt: { x: number; y: number }): void => {
  if (tuneActive.value) {
    handleTuneMove(pt)
    return
  }
  if (pairActive.value) {
    handlePairMove(pt)
    return
  }
  const session = trackDrag.value
  if (!session) return
  if (mouseTrackDrag.value) mouseTrackDragMoved.value = true
  const cornerMode = trackDragFree.value ? 'free' : dragCorner(routerPrefs.value)
  if (session instanceof ComponentDragSession) {
    const u = session.update(pt, cornerMode)
    viewportRef.value?.translateElements(componentDragRefs, u.delta)
    trackDragPreview.value = {
      hiddenRefs: u.hiddenRefs,
      segments: u.lines.flatMap((line) =>
        line.path.slice(1).map((p, i) => ({
          x0: line.path[i].x,
          y0: line.path[i].y,
          x1: p.x,
          y1: p.y,
          width: line.width,
          layer: line.layer,
          violation: line.violations[i]
        }))
      ),
      marks: u.marks,
      clearance: { mm: trackDragClearance, from: 0 }
    }
    return
  }
  if (session instanceof ArcDragSession) {
    const u = session.update(pt, routeMode.value, cornerMode)
    if (!u.blocked) lastValidDragPoint = pt
    trackDragPreview.value = {
      hiddenRefs: u.hiddenRefs,
      segments: [
        ...u.preview.segments,
        ...u.pieces.map((p) => ({ ...p, width: session.width, layer: session.layer }))
      ],
      marks: u.marks,
      clearance: { mm: trackDragClearance, from: 0 }
    }
    return
  }
  if (session instanceof MultiDragSession) {
    const u = session.update(pt, routeMode.value, cornerMode)
    if (!u.blocked) lastValidDragPoint = pt
    trackDragPreview.value = {
      hiddenRefs: u.preview.hiddenRefs,
      segments: [
        ...u.preview.segments,
        ...u.lines.flatMap((line) =>
          line.path.slice(1).map((p, i) => ({
            x0: line.path[i].x,
            y0: line.path[i].y,
            x1: p.x,
            y1: p.y,
            width: line.width,
            layer: line.layer,
            violation: line.violations[i]
          }))
        )
      ],
      vias: u.preview.vias,
      marks: u.marks,
      clearance: { mm: trackDragClearance, from: u.preview.segments.length }
    }
    return
  }
  if (session instanceof ViaDragSession) {
    const u = session.update(pt, routeMode.value, cornerMode)
    if (!u.blocked) lastValidDragPoint = pt
    const segs: NonNullable<typeof trackDragPreview.value>['segments'] = u.lines.flatMap((line) =>
      line.path.slice(1).map((p, i) => ({
        x0: line.path[i].x,
        y0: line.path[i].y,
        x1: p.x,
        y1: p.y,
        width: line.width,
        layer: line.layer,
        violation: line.violations[i]
      }))
    )
    const size = session.via.shape.kind === 'circle' ? session.via.shape.r * 2 : 0
    trackDragPreview.value = {
      hiddenRefs: u.preview.hiddenRefs,
      segments: [...u.preview.segments, ...segs],
      vias: [...(u.preview.vias ?? []), { index: session.via.ref.index, ...u.at, size }],
      marks: u.marks,
      clearance: {
        mm: trackDragClearance,
        from: u.preview.segments.length,
        viaFrom: u.preview.vias?.length ?? 0
      }
    }
    return
  }
  const u = session.update(pt, routeMode.value, cornerMode)
  if (!u.blocked) lastValidDragPoint = pt
  const pathSegs: NonNullable<typeof trackDragPreview.value>['segments'] = []
  for (let i = 0; i < u.path.length - 1; i++) {
    pathSegs.push({
      x0: u.path[i].x,
      y0: u.path[i].y,
      x1: u.path[i + 1].x,
      y1: u.path[i + 1].y,
      width: session.line.width,
      layer: session.line.layer,
      violation: u.violations[i]
    })
  }
  trackDragPreview.value = {
    hiddenRefs: u.preview.hiddenRefs,
    segments: [...u.preview.segments, ...pathSegs],
    vias: u.preview.vias,
    marks: u.marks,
    clearance: { mm: trackDragClearance, from: u.preview.segments.length }
  }
}

const endTrackDrag = (): void => {
  lastValidDragPoint = null
  if (trackDrag.value instanceof ComponentDragSession) {
    viewportRef.value?.clearDragOrigins()
    componentDragRefs = []
  }
  trackDrag.value = null
  trackDragFree.value = false
  trackDragPreview.value = null
}

const commitTrackDrag = (commitAnyway = false): void => {
  if (routerMenuDismissing) return
  if (tuneActive.value) {
    const cursor = viewportRef.value?.getCursor()
    if (tuneSession.value) commitTune()
    else if (cursor) startTuneAt(cursor)
    return
  }
  if (pairActive.value) {
    pairClick()
    return
  }
  const session = trackDrag.value
  if (!session || !board.value) return
  if (session instanceof ComponentDragSession) {
    commitComponentDrag(session, commitAnyway)
    return
  }
  dropTrackDrag(session, commitAnyway, false)
}

/**
 * Drop a track, via or multi drag (D9): legal, it lands; else where it was
 * last legal in Push and Avoid (KiCad's dragger), else with Ctrl anyway; else
 * a click keeps dragging and a release springs back. A drop where it started
 * writes nothing (D7).
 */
const dropTrackDrag = (
  session: DragSession | ViaDragSession | MultiDragSession | ArcDragSession,
  commitAnyway: boolean,
  release: boolean
): void => {
  // An arc drag lands as a router diff, pushes and all (D15).
  const deltaOf = (): (ShoveDelta & { blocked: boolean }) | null =>
    session instanceof ArcDragSession ? session.routerDelta() : session.delta()
  const delta = deltaOf()
  if (!delta) {
    if (release) endTrackDrag()
    return
  }
  const outcome = dropOutcome({
    blocked: delta.blocked,
    mode: routerPrefs.value.mode,
    allowViolations: commitsViolations(routerPrefs.value),
    resolves: true,
    lastValid: lastValidDragPoint !== null,
    commitAnyway,
    release
  })
  if (outcome === 'stay') return
  if (outcome === 'revert') return springBackTrackDrag()
  if (outcome === 'commitLastValid' && lastValidDragPoint) {
    handleTrackDragMove(lastValidDragPoint)
    const settled = deltaOf()
    if (!settled || settled.blocked) return release ? springBackTrackDrag() : undefined
    if (session.unchanged()) return endTrackDrag()
    return applyTrackDragDelta(settled)
  }
  if (session.unchanged()) return endTrackDrag()
  applyTrackDragDelta(delta)
}

/**
 * Release-to-commit finish for the mouse gesture. Unlike `commitTrackDrag`
 * there is no "stay in the drag" once the button is up: an untouched grab
 * was just a click (select only) and a blocked drop reverts.
 */
const finishMouseTrackDrag = (): void => {
  const session = trackDrag.value
  if (!session) return // already cancelled (Esc / right-click) mid-gesture
  if (session instanceof ComponentDragSession) {
    commitTrackDrag(releaseCommitAnyway)
    return
  }
  dropTrackDrag(session, releaseCommitAnyway, true)
}

/** Ctrl (Cmd) held as the mouse button came up: a press-drag's commit anyway (D9). */
let releaseCommitAnyway = false
const noteRelease = (e: MouseEvent): void => {
  releaseCommitAnyway = e.ctrlKey || e.metaKey
}
// Capture on the window: seen before the viewport's own release ends the drag.
window.addEventListener('mouseup', noteRelease, true)
onUnmounted(() => window.removeEventListener('mouseup', noteRelease, true))

// --- Differential pairs (router-behavior.md PR1–PR6): `6`, KiCad's Route
// Differential Pair. A modal gesture, as a drag is: moves and clicks come
// through the viewport's drag channel while it lives.
/** `6` from the tool search: the next click on a pair's pad starts it. */
const pairArmed = ref(false)
const pairDraft = shallowRef<PairDraft | null>(null)
let pairSession: DiffPairSession | null = null
let pairProposal: PairProposal | null = null
let lastPairCursor: { x: number; y: number } | null = null
/** Dimensions typed in (PR6), for this session; null takes each pair's net class. */
const pairSizeOverride = ref<{ width: number; gap: number; viaGap: number } | null>(null)
const pairSizeForm = ref<{ x: number; y: number } | null>(null)
const pairActive = computed(() => pairArmed.value || pairDraft.value !== null)

/** The class of a pair's positive half: its width, gap and clearance (PR6). */
const pairClass = computed(() => {
  const b = board.value
  const net = pairDraft.value?.nets.p ?? 0
  const name = b && net > 0 ? getNetName(b, net) : ''
  return name
    ? netClassForNet(name, setupClasses.value, setupPatterns.value, setupAssignments.value)
    : defaultNetClass(setupClasses.value)
})
/** The project's pair sizes beyond the net classes' (`diff_pair_dimensions`). */
const setupPairSizes = ref<Array<{ width: number; gap: number; viaGap: number }>>([])
/** The row of the pair size list in force, the net class's first; kept as the track list's is (S5). */
const pairSizeIndex = ref(0)
/** The rules while a pair is routed, for its sizes on each layer (S13). */
const pairRules = computed(() => {
  const b = board.value
  if (!b || !pairDraft.value) return null
  return boardRules(
    b,
    {
      rules: setupRules.value,
      classes: setupClasses.value,
      patterns: setupPatterns.value,
      assignments: setupAssignments.value,
      tuning: setupTuning.value
    },
    setupCustomRules.value
  )
})
/** The width and gap the rules give the pair on the layer it is routed on (S13): the list's first row. */
const pairRule = computed(() => {
  const draft = pairDraft.value
  const rules = pairRules.value
  const cls = pairClass.value
  if (!draft || !rules) {
    const source = `netclass '${cls.name}'`
    return {
      width: { value: cls.diffPairWidth, min: 0, source },
      gap: { value: cls.diffPairGap, min: 0, source }
    }
  }
  return resolvePairSizes(rules, draft.nets, draft.layer, {
    width: setupRules.value.minTrackWidth,
    clearance: setupRules.value.minClearance
  })
})
const pairSizes = computed(() =>
  pairSizesOf(
    { width: pairRule.value.width.value, gap: pairRule.value.gap.value },
    setupPairSizes.value,
    pairSizeIndex.value,
    pairSizeOverride.value
  )
)
/** Sizes typed into *Differential pair dimensions…* (PR6): this session's alone, as KiCad writes nothing. */
const applyPairSizes = (v: Record<string, number>): void => {
  pairSizeOverride.value = { width: v.width, gap: v.gap, viaGap: v.viaGap }
  pairSizeForm.value = null
}
/** `W` / `Shift+W` while a pair is routed: the pair size list, wrapping (KiCad's). */
const stepPairSize = (dir: 1 | -1): void => {
  pairSizeIndex.value = stepIndex(setupPairSizes.value.length + 1, pairSizeIndex.value, dir)
  pairSizeOverride.value = null
  if (lastPairCursor) handlePairMove(lastPairCursor)
}

/** The pair end at a point (PR1), on the active layer where its copper has it; `onLayer`, only there (PR4). */
const pairEndAt = (
  point: { x: number; y: number },
  onLayer?: string
): ReturnType<typeof pairEndAtIn> => {
  const b = board.value
  const idx = spatialIndex.value
  return b && idx ? pairEndAtIn(b, idx, point, activeLayer.value, onLayer) : null
}

/**
 * The via pair `V` arms (PR5): the via a route's click places — the size
 * list's pick, else the pair's class's — at the pair's via gap, through
 * (KiCad's via type), the pair going on on the layer pair's other side.
 */
const pairViaSpec = (): PairViaSpec => {
  const state = route.viaState()
  const cls = pairClass.value
  const via =
    state.source === 'rules' ? { diameter: cls.viaDiameter, drill: cls.viaDrill } : state.via
  const copper = route.copper()
  return {
    size: via.diameter,
    drill: via.drill,
    gap: pairSizes.value.viaGap,
    layers: viaSpan('through', copper[0] ?? 'F.Cu', copper[copper.length - 1] ?? 'B.Cu', copper)
  }
}

/** PR6: the other half's track running beside a pair half's, within a little over its class's pitch. */
const pairMateOf = (seg: CopperItem): CopperItem | null => {
  const b = board.value
  const idx = spatialIndex.value
  if (!b || !idx) return null
  return pairMateIn(b, idx, seg, (name) => {
    const cls = netClassForNet(
      name,
      setupClasses.value,
      setupPatterns.value,
      setupAssignments.value
    )
    return cls.diffPairGap + cls.diffPairWidth
  })
}

/** `6`: route a pair from the copper under the cursor, else wait for a click on some. */
const beginPair = (): void => {
  if (props.isReadOnly || !gestureFree(liveGestures())) return
  pairArmed.value = true
  const cursor = viewportRef.value?.getCursor()
  if (cursor) startPairAt(cursor)
}

const startPairAt = (point: { x: number; y: number }): boolean => {
  const w = routerWorld.value
  const found = pairEndAt(point)
  if (!w || !found) return false
  pairArmed.value = false
  const origin = activeLayer.value
  if (found.layer !== activeLayer.value) handleSetActiveLayer(found.layer)
  pairSession = new DiffPairSession(w, pushOptions())
  pairDraft.value = beginPairDraft(pairSession, found, origin)
  handlePairMove(point)
  return true
}

const handlePairMove = (point: { x: number; y: number }): void => {
  lastPairCursor = point
  const draft = pairDraft.value
  const session = pairSession
  if (!draft || !session) return
  const sizes = pairSizes.value
  // Over the other end's copper on this layer: the pair heads for it and arrives (PR4).
  const proposal = proposePair(
    session,
    draft,
    {
      mode: routeMode.value,
      postureFlipped: routePostureFlip.value,
      sizes,
      clearance: pairClass.value.clearance,
      cursor: point
    },
    pairTarget(pairEndAt(point, draft.layer), draft),
    pairViaSpec()
  )
  pairProposal = proposal
  const displaced = session.displaced()
  const vias = draft.vias.map((v) => ({ index: -1, x: v.x, y: v.y, size: v.size }))
  const at = proposal.vias
  if (at) {
    vias.push(
      { index: -1, ...at.p, size: at.spec.size },
      { index: -1, ...at.n, size: at.spec.size }
    )
  }
  trackDragPreview.value = {
    hiddenRefs: displaced.hiddenRefs,
    segments: [
      ...displaced.segments,
      ...draft.p,
      ...draft.n,
      ...pairSegments(proposal.p, sizes.width, draft.layer, proposal.pViolations),
      ...pairSegments(proposal.n, sizes.width, draft.layer, proposal.nViolations)
    ],
    vias: [...(displaced.vias ?? []), ...vias],
    marks: proposal.marks,
    clearance: { mm: pairClass.value.clearance, from: displaced.segments.length }
  }
}

/** A click with a pair in hand: lay what is shown (R18), a via pair with it when armed (PR5). */
const pairClick = (finish = false): void => {
  const point = lastPairCursor ?? viewportRef.value?.getCursor()
  if (!point) return
  const draft = pairDraft.value
  const session = pairSession
  if (!draft || !session) {
    startPairAt(point)
    return
  }
  handlePairMove(point)
  const proposal = pairProposal
  if (!proposal || (proposal.blocked && blockViolations.value)) return
  const next = clickPair(
    session,
    draft,
    proposal,
    { postureFlipped: routePostureFlip.value, sizes: pairSizes.value },
    layerPair.value,
    { fixAll: routerSettings(routerPrefs.value).fixAllSegments, finish }
  )
  if (!next) return
  if (next.layer !== draft.layer) handleSetActiveLayer(next.layer)
  pairDraft.value = next
  if (proposal.arrived) commitPair()
  else handlePairMove(point)
}

/** Esc, right-click, or arriving: what is laid lands as one undo step (R25). */
const commitPair = (): void => {
  const b = board.value
  const draft = pairDraft.value
  const session = pairSession
  if (b && draft && session && pairLaid(draft)) {
    const pushed = pairPushes(session)
    runCommand(t('pcbEditor.commands.routePair'), () => writePair(b, draft, pushed))
  }
  endPair()
}

/** `End`, or Finish from the menu: the head laid as a click lays it, and the pair ends there (R21). */
const finishPair = (): void => {
  if (pairDraft.value) pairClick(true)
  commitPair()
}

const endPair = (): void => {
  const origin = pairDraft.value?.originLayer
  pairArmed.value = false
  pairDraft.value = null
  pairSession = null
  pairProposal = null
  trackDragPreview.value = null
  if (origin && origin !== activeLayer.value) handleSetActiveLayer(origin)
}

/**
 * The board moved under the live drag, pair or tune from elsewhere: each ends
 * with nothing landed, the tool still armed.
 */
const dropLiveGestures = (): void => {
  if (trackDrag.value) endTrackDrag()
  if (pairDraft.value) {
    const origin = pairDraft.value.originLayer
    pairDraft.value = null
    pairSession = null
    pairProposal = null
    trackDragPreview.value = null
    if (origin && origin !== activeLayer.value) handleSetActiveLayer(origin)
  }
  if (tuneSession.value) cancelTuneSession()
}

/** A layer key: with a pair in hand, the pair's (PR5); else the route's (R24). */
const switchLayerKey = (target: string): void => {
  const draft = pairDraft.value
  if (!draft || !pairSession) {
    route.switchLayer(target)
    return
  }
  const next = switchPairLayer(pairSession, draft, target)
  if (next === draft) return
  pairDraft.value = next
  if (next.layer !== draft.layer) handleSetActiveLayer(next.layer)
  if (lastPairCursor) handlePairMove(lastPairCursor)
}

/** Backspace with a pair in hand: the last click goes, with its via pair (R22). */
const unpairLast = (): void => {
  const draft = pairDraft.value
  if (!draft || !pairSession) return
  const next = undoPair(pairSession, draft)
  if (!next) {
    endPair()
    return
  }
  if (next.layer !== draft.layer) handleSetActiveLayer(next.layer)
  pairDraft.value = next
  // Disarming the via pair leaves the head as it is.
  if (!draft.armedVia && lastPairCursor) handlePairMove(lastPairCursor)
}

// --- Length and skew tuning (router-behavior.md T1–T6): `7`, `8`, `9`, KiCad's
// Tune Length of a Single Track, of a Differential Pair, and Tune Skew. The key
// arms the tuner; a click on a track starts a pattern, the next lays it. A
// modal gesture through the drag channel, as a pair route is.
const tuneSession = shallowRef<TuneSession | null>(null)
const tuneUpdate = shallowRef<TuneUpdate | null>(null)
/** The tuner armed (T1): the next click on a track starts a pattern. */
const tuneArmed = ref<TuneMode | null>(null)
const tuneActive = computed(() => tuneArmed.value !== null || tuneSession.value !== null)
let tuneMode: TuneMode = 'single'
/** Each tuner's meander defaults, the project's (T6); KiCad's where it saves none. */
const tuneDefaults = ref<TuningPatternSettings>(structuredClone(DEFAULT_TUNING_PATTERN_SETTINGS))
/** The project's teardrop settings, Board Setup's Teardrops page (`teardrop/params.ts`). */
const teardropDefaults = ref<TeardropSettings>(structuredClone(DEFAULT_TEARDROP_SETTINGS))
/** A tuner's defaults as its meanders take them. */
const tuneDefaultsOf = (mode: TuneMode): MeanderSettings => ({
  ...DEFAULT_MEANDER,
  ...tuneDefaults.value[mode]
})
/**
 * The armed (else last used) tuner's own copy of its settings, as KiCad's
 * tool keeps one: its spacing and amplitude keys (T1) and *Length tuning
 * settings…* (T6) edit it, never the defaults, and it goes when the tool is left.
 */
const tuneCopy = shallowRef<{ mode: TuneMode; settings: MeanderSettings } | null>(null)
const tuneToolSettings = (mode: TuneMode): MeanderSettings =>
  tuneCopy.value?.mode === mode ? tuneCopy.value.settings : tuneDefaultsOf(mode)
/** The settings form's tuner: the armed one, else the last used. */
const tuneFormMode = ref<TuneMode>('single')
const tuneSettings = computed<MeanderSettings>(() => tuneToolSettings(tuneFormMode.value))
/**
 * A target typed in (T2), mm; null for none. Used where there is no rule, or
 * with the override; the tool's alone, forgotten when it is left (T6).
 */
const tuneTargetOverride = ref<number | null>(null)
/** KiCad's *Override custom rules*: the typed target wins over the net's rule (T2). */
const tuneOverrideRules = ref(false)
const tuneSettingsForm = ref<{ x: number; y: number } | null>(null)

/** A net's routed length and pad-to-die, mm, apart, as a selected track's rows show them. */
const netLengthBreakdown = (net: number): { routed: number; padToDie: number } => {
  const b = board.value
  if (!b) return { routed: 0, padToDie: 0 }
  const stats = netLengthStats(b, net, {
    useHeight: setupRules.value.useHeightForLengthCalcs,
    maxError: setupRules.value.maxError
  })
  return { routed: (stats.total - stats.padToDie) / 1e6, padToDie: stats.padToDie / 1e6 }
}

/** A net's whole routed length, mm: what a live route's readout adds its head to (S11). */
const netTrackLength = (net: number): number => {
  const b = board.value
  return b ? netTrackLengthOf(b, net, setupRules.value) : 0
}

/** What the tuner measures through a track, mm: its path between its two pads (T2). */
const tunedTrackLength = (track: { ref: { type: string; index: number } }): number => {
  const b = board.value
  return b ? tunedTrackLengthOf(b, track, setupRules.value) : 0
}

/** The design settings the tuner reads its rules and delays from: Board Setup's. */
const tuneSetup = (): TuneSetup => ({
  rules: setupRules.value,
  classes: setupClasses.value,
  patterns: setupPatterns.value,
  assignments: setupAssignments.value,
  tuning: setupTuning.value,
  customRules: setupCustomRules.value
})

/** The length or skew rule a net's track is tuned to on a layer (T2). */
const tuneRuleFor = (net: number, layer: string, mode: TuneMode): TuneRule | null => {
  const b = board.value
  return b ? tuneRuleOf(b, tuneSetup(), net, layer, mode) : null
}

/** How the tune in hand's delay follows its length, where its net's profile tunes in time (T2). */
const tuneTime = shallowRef<TuneTimeScale | null>(null)

/** The target a net is tuned to (T2): its rule's, unless overridden or none; then typed; else none. */
const tuneTargetFor = (
  net: number,
  layer: string,
  mode: TuneMode,
  time: TuneTimeScale | null = tuneTime.value
): TuneTarget =>
  tuneTargetOf(
    mode,
    tuneTargetOverride.value,
    tuneRuleFor(net, layer, mode),
    tuneOverrideRules.value,
    time
  )

/** `7`/`8`/`9`: arm a tuner (T1), or switch the armed one, with its own copy of its defaults. */
const beginTune = (mode: TuneMode): void => {
  if (props.isReadOnly || tuneSession.value) return
  if (!tuneArmed.value && !gestureFree(liveGestures())) return
  tuneArmed.value = mode
  tuneMode = mode
  tuneFormMode.value = mode
  tuneCopy.value = { mode, settings: tuneToolSettings(mode) }
}

/** The armed tuner's first click: a pattern starts on the track under it (T1, T5). */
const startTuneAt = (point: { x: number; y: number }): void => {
  const w = routerWorld.value
  const idx = spatialIndex.value
  const mode = tuneArmed.value
  if (!w || !idx || !mode) return
  const seed = tuneSeedAt(idx, point)
  if (!seed) return refuseTune(t('pcbEditor.tune.coach.noTrack'))
  if (board.value && inTuningPattern(board.value, seed.ref))
    return refuseTune(t('pcbEditor.tune.coach.inPattern'))
  const mate = mode === 'single' ? null : pairMateOf(seed)
  if (mode !== 'single' && !mate) return refuseTune(t('pcbEditor.tune.coach.noMate'))
  const layer = seed.layers[0]
  const net = seed.net
  const name = board.value ? getNetName(board.value, net) : ''
  const cls = name
    ? netClassForNet(name, setupClasses.value, setupPatterns.value, setupAssignments.value)
    : defaultNetClass(setupClasses.value)
  tuneTime.value = board.value
    ? tuneTimeScale(board.value, tuneSetup(), mode, seed, mate, net, layer)
    : null
  const session = startTune(w, seed, point, {
    mode,
    settings: tuneToolSettings(mode),
    target: tuneTargetFor(net, layer, mode),
    clearance: cls.clearance,
    lengthOf: tunedTrackLength,
    mate
  })
  if (!session) return refuseTune(t('pcbEditor.tune.coach.cannot'))
  tuneRefusal.value = ''
  // KiCad's: the tuned track's layer becomes the active one.
  activeLayer.value = layer
  tuneSession.value = session
  handleTuneMove(point)
}

/** `1`–`4` mid-tune, KiCad's: spacing up, down, amplitude up, down, one step (T1). */
const stepTune = (what: 'spacing' | 'amplitude', sign: 1 | -1): void => {
  const session = tuneSession.value
  if (!session) return
  session.meanderSettings = stepMeander(session.meanderSettings, what, sign, session.spacingFloor)
  tuneCopy.value = { mode: tuneMode, settings: session.meanderSettings }
  const cursor = viewportRef.value?.getCursor()
  if (cursor) handleTuneMove(cursor)
}

/**
 * What the meter reads with no pattern in hand, as KiCad's status box: the
 * track under the armed tuner, or a pattern on the board while its handles move.
 */
const tuneGlance = shallowRef<TuneMeterReading | null>(null)

/** The track under the armed tuner as its tune would start (T4), kept while the pointer stays on it. */
let hoverGlance: { idx: unknown; key: string; reading: TuneMeterReading | null } | null = null
const hoverReading = (point: { x: number; y: number }): TuneMeterReading | null => {
  const b = board.value
  const idx = spatialIndex.value
  const mode = tuneArmed.value
  if (!b || !idx || !mode) return null
  const seed = tuneSeedAt(idx, point)
  if (!seed) return null
  const key = `${mode}:${boardRefKey(seed.ref)}`
  if (hoverGlance?.idx === idx && hoverGlance.key === key) return hoverGlance.reading
  const mate = mode === 'single' ? null : pairMateOf(seed)
  let reading: TuneMeterReading | null = null
  if (mode === 'single' || mate) {
    const layer = seed.layers[0]
    const length = tunedTrackLength(seed)
    const mateLength = mate ? tunedTrackLength(mate) : 0
    const value =
      mode === 'skew'
        ? length - mateLength
        : mode === 'pair'
          ? Math.max(length, mateLength)
          : length
    const time = tuneTimeScale(b, tuneSetup(), mode, seed, mate, seed.net, layer)
    const target = tuneTargetFor(seed.net, layer, mode, time)
    reading = {
      mode,
      net: getNetName(b, seed.net),
      value,
      target,
      status: statusOf(value, target),
      time
    }
  }
  hoverGlance = { idx, key, reading }
  return reading
}

const handleTuneMove = (point: { x: number; y: number }): void => {
  const session = tuneSession.value
  if (!session) {
    tuneGlance.value = hoverReading(point)
    return
  }
  const u = session.update(point)
  tuneUpdate.value = u
  trackDragPreview.value = tunePreview(
    u,
    u.lines.flatMap((l) => l.replaces)
  )
}

/** A tune drawn where it would land, over `hidden`, the tracks it replaces. */
const tunePreview = (
  u: TuneUpdate,
  hidden: Array<{ type: string; index: number }>
): NonNullable<typeof trackDragPreview.value> => ({
  hiddenRefs: hidden,
  segments: tuneSegments(u),
  marks: u.marks
})

/** A click with the tuner: the meanders land with their pattern, as one undo step (T4). */
const commitTune = (): void => {
  const b = board.value
  const u = tuneUpdate.value
  if (!b || !u || u.lines.length === 0) return
  if (u.blocked && blockViolations.value) return
  const settings = tuneSession.value?.meanderSettings ?? tuneToolSettings(tuneMode)
  const time = tuneTime.value
  runCommand(t('pcbEditor.commands.tune'), () =>
    writeTune(b, u, tuneMode, settings, tuneOverrideRules.value, time)
  )
  cancelTuneSession()
}

// --- A tuning pattern on the board (router-behavior.md T4): selected whole,
// re-tuned from its Properties rows or its handles, as KiCad regenerates one.

/** What a pattern on the board is re-tuned over: the board, its copper and router, Board Setup's rules. */
const retuneHost = (): RetuneHost | null => {
  const b = board.value
  const w = routerWorld.value
  const idx = spatialIndex.value
  return b && w && idx ? { board: b, index: idx, world: w, setup: tuneSetup() } : null
}

/** A pattern laid again with `data` its settings (`patternRetune.ts`). */
const retuneOf = (pattern: KicadTuningPattern, data: TuningPatternData): TuneUpdate | null => {
  const h = retuneHost()
  return h ? retunePatternOf(h, pattern, data) : null
}

/** How a pattern's delay follows its length (T2). */
const patternTimeOf = (
  pattern: KicadTuningPattern,
  data: TuningPatternData
): TuneTimeScale | null => {
  const h = retuneHost()
  return h ? patternTimeIn(h, pattern, data) : null
}

/** The tracks a pattern hides while it is re-tuned. */
const patternHidden = (pattern: KicadTuningPattern): Array<{ type: string; index: number }> =>
  board.value ? patternMembers(board.value, pattern) : []

/** A Properties row of the selected patterns changed: each re-tuned with it, as one step (T4). */
const editTuningPatterns = (key: string, value: PropertyEditValue): void => {
  const b = board.value
  if (!b) return
  const patterns = selectedItems.value.flatMap((ref) =>
    ref.type === 'tuning_pattern' ? (b.tuningPatterns[ref.index] ?? []) : []
  )
  if (patterns.length === 0) return
  runCommand(
    t('pcbEditor.commands.retune'),
    () =>
      retunePatterns(
        b,
        patterns.map((pattern) => [pattern, patternEdit(pattern, key, value)])
      ),
    { mergeKey: `tuning_pattern:${key}` }
  )
}

/** Patterns laid again, each with its data, every re-tune worked out before any is written. */
const retunePatterns = (
  b: KicadBoard,
  edits: ReadonlyArray<readonly [KicadTuningPattern, TuningPatternData]>
): void => {
  const h = retuneHost()
  if (h) writeRetunes(b, planRetunes(h, edits))
}

/** KiCad's Update All Tuning Patterns: each laid again where it lies, to the rules as they are now. */
const updateAllTuningPatterns = (): void => {
  const b = board.value
  if (!b || props.isReadOnly || b.tuningPatterns.length === 0) return
  runCommand(t('pcbEditor.commands.updateTuningPatterns'), () =>
    retunePatterns(
      b,
      b.tuningPatterns.map((pattern) => [pattern, pattern] as const)
    )
  )
}

/** A pattern's handles moved: its re-tune drawn over its tracks (T4). */
const previewPatternHandles = (
  index: number,
  shape: Extract<VertexShape, { kind: 'tuning' }>,
  vertex: number
): void => {
  const b = board.value
  const pattern = b?.tuningPatterns[index]
  if (!b || !pattern) return
  const data = handlesEdit(pattern, shape, vertex)
  const u = retuneOf(pattern, data)
  trackDragPreview.value = u ? tunePreview(u, patternHidden(pattern)) : null
  tuneGlance.value = u
    ? tuneReading(u, TUNE_MODE_OF[data.mode], patternTimeOf(pattern, data))
    : null
}

/** A pattern's handles let go: re-tuned there, as one step (T4). */
const commitPatternHandles = (
  index: number,
  shape: Extract<VertexShape, { kind: 'tuning' }>,
  vertex: number
): void => {
  trackDragPreview.value = null
  const b = board.value
  const pattern = b?.tuningPatterns[index]
  if (!b || !pattern) return
  const data = handlesEdit(pattern, shape, vertex)
  const u = retuneOf(pattern, data)
  if (!u || (u.blocked && blockViolations.value)) return
  const time = patternTimeOf(pattern, data)
  runCommand(t('pcbEditor.commands.retune'), () => writeRetune(b, pattern, data, u, time))
}

/** The pattern in hand dropped, the tuner still armed for the next (T1, as KiCad's tool). */
const cancelTuneSession = (): void => {
  tuneSession.value = null
  tuneUpdate.value = null
  tuneTime.value = null
  trackDragPreview.value = null
  // What the meter read before the pattern began is stale now: it reads the cursor again.
  tuneGlance.value = null
  hoverGlance = null
  const cursor = tuneArmed.value ? viewportRef.value?.getCursor() : null
  if (cursor) tuneGlance.value = hoverReading(cursor)
}

/** The tuner left altogether: its copy of the settings, the typed target and override go (T6). */
const endTune = (): void => {
  cancelTuneSession()
  tuneGlance.value = null
  hoverGlance = null
  tuneArmed.value = null
  tuneCopy.value = null
  tuneTargetOverride.value = null
  tuneOverrideRules.value = false
}

/** Why the last click started no pattern, shown in the coaching line a while (T1). */
const TUNE_REFUSAL_MS = 4000
const tuneRefusal = ref('')
let tuneRefusalTimer: ReturnType<typeof setTimeout> | undefined
const refuseTune = (why: string): void => {
  clearTimeout(tuneRefusalTimer)
  tuneRefusal.value = why
  tuneRefusalTimer = setTimeout(() => (tuneRefusal.value = ''), TUNE_REFUSAL_MS)
}
onUnmounted(() => clearTimeout(tuneRefusalTimer))

/** The tuner's coaching (T1): its click order, which no glyph says, or why a click did nothing. */
const tuneCoaching = computed(() => {
  if (!tuneActive.value) return ''
  if (tuneRefusal.value) return tuneRefusal.value
  if (tuneSession.value) return t('pcbEditor.tune.coach.lay')
  return tuneArmed.value === 'single'
    ? t('pcbEditor.tune.coach.start')
    : t('pcbEditor.tune.coach.startPair')
})

/** The pair tool's coaching (PR1): where its first click goes, until it does. */
const pairCoaching = computed(() =>
  pairArmed.value && !pairDraft.value ? t('pcbEditor.pair.coach') : ''
)

/** The number keys that step a setting, marked up or down in their caps (T1). */
const KEY_STEPS: Partial<Record<HotkeyActionId, 'up' | 'down'>> = {
  'pcb.tuneSpacingIncrease': 'up',
  'pcb.tuneSpacingDecrease': 'down',
  'pcb.tuneAmplitudeIncrease': 'up',
  'pcb.tuneAmplitudeDecrease': 'down'
}
const capOf = (id: HotkeyActionId): KeyCap => {
  const step = KEY_STEPS[id]
  return step ? { label: hotkeyLabel(id), step } : hotkeyLabel(id)
}

/** Another tool picked: a pair lands what it laid, as Esc does (R25); a tune drops its pattern. */
const leavePairAndTune = (): void => {
  if (pairActive.value) commitPair()
  if (tuneActive.value) endTune()
}

/** The Pair button: armed for a click on copper, whatever else was in hand put away first. */
const armPair = (): void => {
  if (props.isReadOnly || pairActive.value) return
  if (tuneActive.value) endTune()
  if (routeTail.value) commitRoute()
  if (gestureFree(liveGestures())) pairArmed.value = true
}

/** The Tune group: that tuner armed, whatever else was in hand put away first. */
const armTune = (mode: TuneMode): void => {
  if (props.isReadOnly) return
  if (pairActive.value) commitPair()
  if (routeTail.value) commitRoute()
  if (tuneSession.value && tuneMode !== mode) cancelTuneSession()
  beginTune(mode)
}

/**
 * The tool the toolbar lights: a pair or a tuner armed stands over the tool
 * beneath it, which takes the clicks back when it ends.
 */
const paletteTool = computed<PcbTool | 'pair' | 'tune'>(() =>
  pairActive.value ? 'pair' : tuneActive.value ? 'tune' : activeTool.value
)

const TUNE_TOOLS: ReadonlyArray<{ mode: TuneMode; icon: IconName; action: HotkeyActionId }> = [
  { mode: 'single', icon: 'tool-tune-single', action: 'pcb.tuneSingle' },
  { mode: 'pair', icon: 'tool-tune-pair', action: 'pcb.tunePair' },
  { mode: 'skew', icon: 'tool-tune-skew', action: 'pcb.tuneSkew' }
]
const tuneToolLabel = (mode: TuneMode): string =>
  mode === 'pair'
    ? t('pcbEditor.tune.tools.pair')
    : mode === 'skew'
      ? t('pcbEditor.tune.tools.skew')
      : t('pcbEditor.tune.tools.single')
/** The router gestures live now, which hold board indices history must not move (R22). */
const liveGestures = (): LiveGestures => ({
  drag: trackDrag.value !== null,
  pair: pairActive.value,
  tune: tuneActive.value,
  route: routeTail.value !== null
})

/** A tune as the meter reads it: the net, its length (a skew tune's skew), and its bounds. */
const tuneReading = (
  u: TuneUpdate,
  mode: TuneMode,
  time: TuneTimeScale | null
): TuneMeterReading => {
  const net = u.net
  return {
    mode,
    net: board.value?.nets.find((n) => n.number === net)?.name ?? '',
    value: mode === 'skew' ? (u.skew ?? 0) : u.length,
    target: u.target,
    status: u.status,
    time
  }
}

/**
 * The tuner's status at the cursor (T4): a pattern in hand, else a glance,
 * else a route's length where a rule bounds it. Properties keeps the selection.
 */
const tuneMeter = computed<TuneMeterReading | null>(() => {
  const u = tuneUpdate.value
  if (u && tuneSession.value) return tuneReading(u, tuneMode, tuneTime.value)
  return tuneGlance.value ?? routeMeter.value
})

/** What stands in for the selection in Properties while an operation runs: a route's, a pair's. */
const liveGroups = computed<PropertyGroup[] | null>(() =>
  routeTail.value ? routeGroups.value : pairDraft.value ? pairGroups.value : null
)

/**
 * *Length tuning settings…* (T6), as KiCad's in-tool dialog: the form's
 * tuner's own copy, and the target and its override, the tool's alone and
 * forgotten when it is left. A pattern in hand takes them at once.
 */
const applyTuneSettings = (v: Record<string, number>): void => {
  const mode = tuneFormMode.value
  const settings: MeanderSettings = {
    ...tuneToolSettings(mode),
    minAmplitude: v.minAmplitude,
    maxAmplitude: Math.max(v.maxAmplitude, v.minAmplitude),
    spacing: v.spacing,
    cornerRadiusPercent: Math.min(100, v.cornerRadiusPercent),
    singleSided: v.singleSided > 0
  }
  tuneCopy.value = { mode, settings }
  tuneTargetOverride.value = v.target > 0 ? v.target : null
  tuneOverrideRules.value = v.overrideRules > 0
  tuneSettingsForm.value = null
  const session = tuneSession.value
  if (session && tuneMode === mode) {
    session.meanderSettings = settings
    session.target = tuneTargetFor(session.net, session.layer, mode)
    const cursor = viewportRef.value?.getCursor()
    if (cursor) handleTuneMove(cursor)
  }
}

/**
 * The tuners' defaults changed in Board Setup's Length-tuning patterns (T6):
 * the armed tuner takes its new set, and the project keeps all three as KiCad does.
 */
const saveTuneDefaults = (next: TuningPatternSettings): void => {
  const before = tuneDefaults.value
  tuneDefaults.value = next
  // Only the armed tuner's own set moves its copy: its 1–4 steps last while it is armed (T1).
  const armed = tuneArmed.value
  if (armed && next[armed] !== before[armed]) {
    const settings = { ...tuneToolSettings(armed), ...next[armed] }
    tuneCopy.value = { mode: armed, settings }
    if (tuneSession.value) tuneSession.value.meanderSettings = settings
  }
  const file = projectPath.value
  if (file && !props.isReadOnly) void writeProjectTuningPatternSettings(file, next)
}

/**
 * The teardrop defaults changed in Board Setup: the project keeps them, the
 * session builds with them, and the track-to-track teardrops follow at once.
 */
const saveTeardropDefaults = (next: TeardropSettings): void => {
  const before = teardropDefaults.value
  teardropDefaults.value = next
  const options = props.session.teardropOptions()
  props.session.setTeardropOptions({ maxError: options.maxError, settings: next })
  if (JSON.stringify(before.track) !== JSON.stringify(next.track))
    props.session.rebuildTeardrops(t('pcbEditor.commands.rebuildTeardrops'))
  const file = projectPath.value
  if (file && !props.isReadOnly) void writeProjectTeardropSettings(file, next)
}

/** Whether a track or arc is locked: a drag leaves it be. */
const b0Locked = (item: CopperItem): boolean => {
  const b = board.value
  if (!b) return true
  if (item.ref.type === 'tarc') return b.trackArcs[item.ref.index]?.locked ?? true
  if (item.ref.type === 'segment') return b.segments[item.ref.index]?.locked ?? true
  return false
}

/** D13's drop: the footprints moved and their tracks re-drawn, as one step; refused while it violates (D9). */
const commitComponentDrag = (session: ComponentDragSession, commitAnyway: boolean): void => {
  const b = board.value
  const delta = session.delta()
  if (!b || !delta || !landsAsIs(delta.blocked, commitAnyway)) return // stay in the drag
  if (session.unchanged()) {
    endTrackDrag()
    return
  }
  const refs = componentDragRefs
  // Scene mm (y up) to the file's nm (y down).
  const dx = mmToNm(delta.move.x)
  const dy = mmToNm(-delta.move.y)
  runCommand(t('pcbEditor.commands.dragFootprint', { count: refs.length }, refs.length), () => {
    for (const { index } of refs) {
      const fp = b.footprints[index]
      if (fp) moveBoardFootprintInAST(fp, nm(fp.position.x + dx), nm(fp.position.y + dy))
    }
    applyRouterDelta(b, delta)
  })
  endTrackDrag()
}

/** A drag that neither pushes nor walks (D13, D15) lands as it is, or not at all (D9). */
const landsAsIs = (blocked: boolean, commitAnyway: boolean): boolean =>
  dropOutcome({
    blocked,
    mode: routerPrefs.value.mode,
    allowViolations: commitsViolations(routerPrefs.value),
    resolves: false,
    lastValid: false,
    commitAnyway,
    release: false
  }) === 'commit'

const applyTrackDragDelta = (delta: ShoveDelta): void => {
  const b = board.value
  if (!b) return
  const label =
    trackDrag.value instanceof ViaDragSession
      ? t('pcbEditor.commands.dragVia')
      : trackDrag.value instanceof ArcDragSession
        ? t('pcbEditor.commands.dragArc')
        : t('pcbEditor.commands.dragTrack')
  runCommand(label, () => applyRouterDelta(b, delta))
  endTrackDrag()
}

/**
 * How the router resolves collisions, for a route and a track drag alike:
 * shove, walkaround (the default), or highlight (the C1 guardrail).
 */
const routeMode = computed<RouteMode>(() => routerPrefs.value.mode)

/**
 * Board connectivity → the ratsnest. Airwires are world-space (y up) — scene
 * coordinates.
 *
 */
const connectivity = shallowRef<Pick<BoardConnectivity, 'airwires' | 'unrouted'> | null>(null)
// The board worker computes it after every change and sends the airwires
// (docs/performance-workstream.md, "The board worker"); a change's arrive a
// beat after its copper, the last revision's staying up until then.
const stopConnectivity = props.session.worker()?.onConnectivity((answer) => {
  connectivity.value = { airwires: answer.airwires, unrouted: answer.unrouted }
})
/** The last finished run of each worker task, for the drawer's Performance tab. */
const taskTimings = shallowRef<Partial<Record<TimedTask, TaskTiming>>>({})
const stopTimings = props.session.worker()?.onTimings((timings) => (taskTimings.value = timings))

/** Live drag delta in scene space (y up); null outside a drag. */
const sceneDragDelta = ref<{ x: number; y: number } | null>(null)

/**
 * The airwires the viewport draws: the computed set, with endpoints anchored
 * on dragged items following the drag rigidly each frame — the dynamic
 * ratsnest (routing workstream §5.2). The full recompute lands with the drop's
 * command.
 */
const displayedAirwires = computed(() => {
  if (!pcbView.value.ratsnest) return []
  let wires = connectivity.value?.airwires ?? []
  // The routed net's airwires are drawn by the route preview, from the head (F7).
  if (routeDraft.value && routeNet.value > 0) {
    const net = routeNet.value
    wires = wires.filter((w) => w.net !== net)
  }
  const delta = sceneDragDelta.value
  if (!delta || dragStartElements.value.length === 0) return wires
  const isDragged = draggedRefPredicate(actedSelection.value)
  // Once it has moved, the dragged copper has left whatever it touched, and
  // its nets re-span each frame to the copper nearest it now.
  const drag = delta.x !== 0 || delta.y !== 0 ? dragRatsnest.value : null
  if (!drag) return translateAirwires(wires, isDragged, delta.x, delta.y)
  const others = wires.filter((w) => !drag.nets.has(w.net))
  return [
    ...translateAirwires(others, isDragged, delta.x, delta.y),
    ...dragAirwires(drag, delta.x, delta.y)
  ]
})

/**
 * The drag's nets with the dragged copper pulled free (`startDragRatsnest`):
 * built when a drag first moves, and again when a turn or flip mid-drag
 * changes the board under it.
 */
const dragRatsnest = computed(() => {
  const b = board.value
  const idx = spatialIndex.value
  if (!b || !idx || dragStartElements.value.length === 0 || vertexDrag.value) return null
  return startDragRatsnest(b, idx, draggedRefPredicate(actedSelection.value))
})

/**
 * The net class governing what is being drawn right now: the routed net's
 * class via the Board Setup assignment patterns, Default when idle or the
 * net is unassigned.
 */
const routeClass = computed(() => route.netClass())

// --- Route sizes (docs/router-behavior.md S1–S9), the route controller's ------
/** The project's sizes beyond the net classes' (`track_widths`, `via_dimensions`). */
const setupExtraSizes = ref<{ tracks: number[]; vias: ViaSize[] }>({ tracks: [], vias: [] })

/**
 * The rules, while a tool that lays copper at a chosen size is armed: what
 * the net class row resolves from, custom rules included. Rebuilt per edit only then.
 */
const sizeRules = computed(() => {
  const b = board.value
  if (!b || (activeTool.value !== 'route' && activeTool.value !== 'via')) return null
  return boardRules(
    b,
    {
      rules: setupRules.value,
      classes: setupClasses.value,
      patterns: setupPatterns.value,
      assignments: setupAssignments.value,
      tuning: setupTuning.value
    },
    setupCustomRules.value
  )
})

/** The rules' width for the routed net on the layer being routed (S1). */
const widthRule = computed<SizeRule<number>>(() => route.widthRule())
const viaRule = computed<SizeRule<ViaSize>>(() => route.viaRule())
const widthList = computed(() => route.widthList())
const viaList = computed(() => route.viaList())

/**
 * *Use starting track width* (R1): whether the route draws at the started-from
 * track's width, what the first `W` leaves (S5). The project's, in its `.kicad_prl`.
 */
const useConnectedWidth = computed(() => boardView.value.autoTrackWidth)

/** The width a click lays now, and why (S1, R1). */
const routeWidthState = computed(() => route.widthState())
const routeWidth = computed(() => routeWidthState.value.width)

/** The via a click places now, and why. */
const routeViaState = computed(() => route.viaState())
const routeViaSize = computed<ViaSize>(() => routeViaState.value.via)

/** Take a new size choice. */
const setSizeChoice = (next: RouteSizeChoice): void => route.setSizeChoice(next)

/** `W` / `Shift+W` (S5). */
const stepWidth = (dir: 1 | -1): void => route.stepWidth(dir)
const stepVia = (dir: 1 | -1): void => route.stepVia(dir)

/** A row picked from the list: KiCad's menu, which also leaves a carried width. */
const pickWidthRow = (index: number): void => route.pickWidthRow(index)
const pickViaRow = (index: number): void => route.pickViaRow(index)

// --- Learning the routing keys (docs/router-behavior.md K1–K5) -------------
/** What the router is doing with the head, as the viewport last reported it. */
const routeState = ref<RouteStateReport | null>(null)
/** A key the person just did by mouse, shown in the hint once (K2). */
const hintEcho = ref<HotkeyActionId | null>(null)
let hintEchoTimer: ReturnType<typeof setTimeout> | null = null
const HINT_ECHO_MS = 4000
const echoKey = (id: HotkeyActionId): void => {
  hintEcho.value = id
  if (hintEchoTimer) clearTimeout(hintEchoTimer)
  hintEchoTimer = setTimeout(() => (hintEcho.value = null), HINT_ECHO_MS)
}
/** A routing key was used: its echo goes. */
const usedKey = (id: HotkeyActionId): void => {
  if (hintEcho.value === id) hintEcho.value = null
}

/**
 * The operation the hint and `?`'s card speak for (K1, K4): a tune, a pair
 * route, else the route tool's. Each lists its keys in the order they matter.
 */
const opKeys = computed<OpKeys>(() => {
  if (tuneActive.value)
    return tuneOpKeys({
      live: tuneSession.value !== null,
      short: tuneUpdate.value?.status === 'too_short'
    })
  if (pairActive.value) return pairOpKeys(pairDraft.value !== null)
  if (activeTool.value !== 'route') return { hint: [], max: 0, card: [] }
  return routeOpKeys({
    live: routeTail.value !== null,
    state: routeState.value?.state ?? null,
    viaArmed: routeViaTarget.value !== null,
    narrower:
      !routeState.value?.narrowerFails &&
      widthList.value.some((o) => !o.outOfRule && o.size < routeWidth.value - 1e-6),
    nearViaPad: routeState.value?.nearViaPad ?? false,
    echo: hintEcho.value
  })
})

type KeySection = 'route' | 'sizes' | 'vias' | 'layers'

/** A row's caps, its word in the hint, its line on the card, and the card's section for it. */
const keyRow = (
  row: KeyRow
): { caps: KeyCap[]; hint: string; card: string; section?: KeySection } => {
  const caps = (...ids: HotkeyActionId[]): KeyCap[] => ids.map(capOf)
  switch (row) {
    case 'via':
      return {
        caps: caps('pcb.routeVia'),
        hint: t('pcbEditor.viewport.hintKeys.routeVia'),
        card: t('pcbEditor.viewport.keysCard.via'),
        section: 'vias'
      }
    case 'width':
      return {
        caps: caps('pcb.trackWidthNext', 'pcb.trackWidthPrev'),
        hint: t('pcbEditor.viewport.hintKeys.trackWidthNext'),
        card: t('pcbEditor.viewport.keysCard.width'),
        section: 'sizes'
      }
    case 'narrower':
      return {
        caps: caps('pcb.trackWidthPrev'),
        hint: t('pcbEditor.viewport.hintKeys.trackWidthPrev'),
        card: t('pcbEditor.viewport.keysCard.width'),
        section: 'sizes'
      }
    case 'posture':
      return {
        caps: caps('pcb.routePosture'),
        hint: t('pcbEditor.viewport.hintKeys.routePosture'),
        card: t('pcbEditor.viewport.keysCard.posture'),
        section: 'route'
      }
    case 'finish': {
      const card = t('pcbEditor.viewport.keysCard.finish')
      return { caps: caps('pcb.finishRoute'), hint: card, card, section: 'route' }
    }
    case 'end': {
      const card = t('pcbEditor.viewport.keysCard.end')
      return { caps: caps('pcb.endRoute'), hint: card, card, section: 'route' }
    }
    case 'unroute': {
      const card = t('pcbEditor.viewport.keysCard.unroute')
      return { caps: caps('pcb.unrouteLast'), hint: card, card, section: 'route' }
    }
    case 'cancel': {
      const card = t('pcbEditor.viewport.keysCard.cancel')
      return { caps: caps('editor.cancel'), hint: card, card, section: 'route' }
    }
    case 'corner': {
      const card = t('pcbEditor.viewport.keysCard.corner')
      return { caps: caps('pcb.routeCorner'), hint: card, card, section: 'route' }
    }
    case 'mode': {
      const card = t('pcbEditor.viewport.keysCard.mode')
      return { caps: caps('pcb.cycleRouteMode'), hint: card, card, section: 'route' }
    }
    case 'viaSize':
      return {
        caps: caps('pcb.viaSizeNext', 'pcb.viaSizePrev'),
        hint: t('pcbEditor.viewport.hintKeys.viaSizeNext'),
        card: t('pcbEditor.viewport.keysCard.viaSize'),
        section: 'sizes'
      }
    case 'customSize': {
      const card = t('pcbEditor.viewport.keysCard.customSize')
      return { caps: caps('pcb.routeSizes'), hint: card, card, section: 'sizes' }
    }
    case 'dropVia': {
      const card = t('pcbEditor.viewport.hintKeys.dropVia')
      return { caps: caps('pcb.unrouteLast'), hint: card, card, section: 'vias' }
    }
    case 'blindVia': {
      const card = t('pcbEditor.viewport.keysCard.blindVia')
      return { caps: caps('pcb.routeBlindVia'), hint: card, card, section: 'vias' }
    }
    case 'microVia': {
      const card = t('pcbEditor.viewport.keysCard.microVia')
      return { caps: caps('pcb.paste'), hint: card, card, section: 'vias' }
    }
    case 'viaPickLayer': {
      const card = t('pcbEditor.viewport.keysCard.viaPickLayer')
      return {
        caps: caps('pcb.routeViaPickLayer', 'pcb.routeBlindViaPickLayer'),
        hint: card,
        card,
        section: 'vias'
      }
    }
    case 'layer': {
      const card = t('pcbEditor.viewport.keysCard.layer')
      return { caps: caps('pcb.layerNext', 'pcb.layerPrev'), hint: card, card, section: 'layers' }
    }
    case 'layerPair': {
      const card = t('pcbEditor.viewport.keysCard.layerPair')
      return { caps: caps('pcb.layerPairNext'), hint: card, card, section: 'layers' }
    }
    case 'pairVia':
      return {
        caps: caps('pcb.routeVia'),
        hint: t('pcbEditor.viewport.hintKeys.pairVia'),
        card: t('pcbEditor.viewport.keysCard.pairVia')
      }
    case 'pairSize':
      return {
        caps: caps('pcb.trackWidthNext', 'pcb.trackWidthPrev'),
        hint: t('pcbEditor.viewport.hintKeys.pairSize'),
        card: t('pcbEditor.viewport.keysCard.pairSize')
      }
    case 'spacing':
      return {
        caps: caps('pcb.tuneSpacingIncrease', 'pcb.tuneSpacingDecrease'),
        hint: t('pcbEditor.viewport.hintKeys.tuneSpacing'),
        card: t('pcbEditor.viewport.keysCard.tuneSpacing')
      }
    case 'amplitude':
      return {
        caps: caps('pcb.tuneAmplitudeIncrease', 'pcb.tuneAmplitudeDecrease'),
        hint: t('pcbEditor.viewport.hintKeys.tuneAmplitude'),
        card: t('pcbEditor.viewport.keysCard.tuneAmplitude')
      }
    case 'tighter': {
      const hint = t('pcbEditor.viewport.hintKeys.tuneTighter')
      return { caps: caps('pcb.tuneSpacingDecrease'), hint, card: hint }
    }
    case 'taller': {
      const hint = t('pcbEditor.viewport.hintKeys.tuneTaller')
      return { caps: caps('pcb.tuneAmplitudeIncrease'), hint, card: hint }
    }
  }
}

/** The hint's keys, every one in order: the viewport shows those that fit, then `?` for the card. */
const hintKeyItems = computed(() =>
  opKeys.value.hint.map((row) => {
    const { caps, hint } = keyRow(row)
    return { caps, text: hint }
  })
)
const hintMoreKey = computed(() => ({
  caps: [capOf('pcb.routeKeys')],
  text: t('pcbEditor.viewport.hintKeys.routeKeys')
}))

/**
 * `?`'s card (K4): the operation's keys the hint had no room for, with the
 * rest, a route's in sections (the route, sizes, vias, layers).
 */
const routeKeysOpen = ref(false)
/** The hint left keys out (the viewport fits it beside the right corner's pills): `?` shows them. */
const hintOverflow = ref(false)
const keysCardAllowed = computed(() => hintOverflow.value && opKeys.value.card.length > 0)
watch(keysCardAllowed, (allowed) => {
  if (!allowed) routeKeysOpen.value = false
})
const routeKeysCard = computed(() => {
  const rows = opKeys.value.card.map(keyRow)
  const titles: Record<KeySection, string> = {
    route: t('pcbEditor.viewport.keysCard.sections.route'),
    sizes: t('pcbEditor.viewport.keysCard.sections.sizes'),
    vias: t('pcbEditor.viewport.keysCard.sections.vias'),
    layers: t('pcbEditor.viewport.keysCard.sections.layers')
  }
  const order: Array<KeySection | undefined> = ['route', 'sizes', 'vias', 'layers', undefined]
  return {
    title: tuneActive.value
      ? t('pcbEditor.viewport.keysCard.titleTune')
      : pairActive.value
        ? t('pcbEditor.viewport.keysCard.titlePair')
        : t('pcbEditor.viewport.keysCard.title'),
    toggle: [hotkeyLabel('pcb.routeKeys')],
    sections: order.flatMap((section) => {
      const keys = rows
        .filter((r) => r.section === section)
        .map(({ caps, card }) => ({ caps, text: card }))
      return keys.length ? [{ ...(section ? { title: titles[section] } : {}), keys }] : []
    })
  }
})

/** What the head violates first, else hugs or stops at, as a handle into the index (S11). */
const routeViolator = ref<number | null>(null)

/** The routed net's `length` rule, null where none bounds it (S11). */
const routeLengthRule = computed(() => {
  const rules = sizeRules.value
  const net = routeNet.value
  if (!rules || net <= 0) return null
  const layer = routingLayer.value
  const r = rules.resolver.evaluate('length', rules.newItem('track', net, [layer]), null, layer)
  const bound = (v: number | undefined): number | undefined =>
    v !== undefined && Number.isFinite(v) ? v : undefined
  const min = bound(r.value.min)
  const max = bound(r.value.max)
  return min === undefined && max === undefined ? null : { min, max, source: r.name }
})

/** The net's committed length, mm, while a length rule bounds it; rebuilt per edit only then. */
const routeCommittedLength = computed(() =>
  routeLengthRule.value && routeTail.value ? netTrackLength(routeNet.value) : 0
)

/** Stackup height between two layers, mm, where the board counts via heights. */
const routeLayerDistance = computed(() => {
  const b = board.value
  if (!b || !routeLengthRule.value || !setupRules.value.useHeightForLengthCalcs) return null
  const heights = stackupHeights(b)
  return (a: string, c: string): number => heights(a, c) / 1e6
})

/** A read-only row of a live operation's group (S11). */
const liveRow = (
  key: string,
  label: string,
  editor: EditorDescriptor,
  value: PropertyValue
): PropertyField => ({ key, label, editor, value, readonly: true })

/** The class row of a live group: the class as its tag. */
const classRow = (cls: NetClass): PropertyField =>
  liveRow(
    'netClass',
    t('pcbEditor.viewport.facts.netClass'),
    {
      kind: 'select',
      tags: true,
      options: [
        {
          value: cls.name,
          label: cls.name,
          ...(cls.pcbColor ? { color: cssColor(cls.pcbColor) } : {})
        }
      ]
    },
    cls.name
  )

/** The note on a size the rules set, where a tuning profile, not the class, set it (S12). */
const profileNote = (source: string): string | undefined => {
  const name = tuningProfileOf(source)
  return name !== null ? t('pcbEditor.viewport.facts.profile', { name }) : undefined
}

/**
 * What a pair lays, in Properties in place of the selection while it is routed
 * (S13), as the Route group a route's: its nets, class and layer, and the
 * width, gap and via gap in force, noted where not the class's.
 */
const pairGroups = computed<PropertyGroup[]>(() => {
  const draft = pairDraft.value
  const b = board.value
  if (!draft || !b) return []
  const mmDist: EditorDescriptor = { kind: 'distance', step: 0.01 }
  const sizes = pairSizes.value
  const own = pairRule.value
  const note = (source: string): string | undefined =>
    pairSizeOverride.value
      ? t('pcbEditor.viewport.facts.custom')
      : pairSizeIndex.value > 0
        ? t('pcbEditor.viewport.facts.picked')
        : profileNote(source)
  const noted = (label: string, n: string | undefined): string => (n ? `${label} (${n})` : label)
  const fields: PropertyField[] = [
    liveRow(
      'nets',
      t('pcbEditor.viewport.facts.nets'),
      { kind: 'text' },
      `${getNetName(b, draft.nets.p)} / ${getNetName(b, draft.nets.n)}`
    ),
    classRow(pairClass.value),
    liveRow(
      'layer',
      t('shared.properties.layer'),
      { kind: 'select', options: boardContext.value.layers },
      draft.layer
    ),
    liveRow(
      'width',
      noted(t('pcbEditor.viewport.facts.width'), note(own.width.source)),
      mmDist,
      sizes.width
    ),
    liveRow(
      'gap',
      noted(t('pcbEditor.viewport.facts.gap'), note(own.gap.source)),
      mmDist,
      sizes.gap
    ),
    liveRow('viaGap', t('pcbEditor.viewport.facts.viaGap'), mmDist, sizes.viaGap)
  ]
  return [{ type: 'route', title: t('pcbEditor.viewport.facts.pairRoute'), count: 1, fields }]
})

/**
 * What the route lays and is held to, in the Properties panel in place of the
 * selection while it is live (router-behavior.md S11): the net and its class,
 * the layer, the width and via in force, the clearance only against what the
 * head hugs or meets, the length only where a rule bounds it. The top bar's
 * chips name the choice; this, what it comes to on this net.
 */
const routeGroups = computed<PropertyGroup[]>(() => {
  if (!routeTail.value) return []
  const b = board.value
  const net = routeNet.value
  const cls = routeClass.value
  const mmDist: EditorDescriptor = { kind: 'distance', step: 0.01 }
  const row = liveRow
  const width = routeWidthState.value
  const wRule = widthRule.value
  // A note only where the size is not the class's: the class row already names it.
  const sourceNote = (source: WidthSource): string | undefined =>
    source === 'track'
      ? t('pcbEditor.viewport.facts.continued')
      : source === 'custom'
        ? t('pcbEditor.viewport.facts.custom')
        : source === 'list'
          ? t('pcbEditor.viewport.facts.picked')
          : undefined
  const noted = (label: string, note: string | undefined): string =>
    note ? `${label} (${note})` : label
  const via = routeViaSize.value
  const viaNote = sourceNote(routeViaState.value.source)
  const fields: PropertyField[] = [
    row(
      'net',
      t('shared.properties.net'),
      { kind: 'text' },
      b?.nets.find((n) => n.number === net)?.name ?? ''
    ),
    classRow(cls),
    row(
      'layer',
      t('shared.properties.layer'),
      { kind: 'select', options: boardContext.value.layers },
      routingLayer.value
    ),
    {
      ...row(
        'width',
        noted(
          t('pcbEditor.viewport.facts.width'),
          width.source === 'rules' ? profileNote(wRule.source) : sourceNote(width.source)
        ),
        mmDist,
        width.width
      ),
      ...(width.outOfRule
        ? {
            warning: t('pcbEditor.viewport.facts.widthOutside', {
              min: formatSize(wRule.min),
              max: wRule.max !== undefined ? formatSize(wRule.max) : '—'
            }),
            warningSource: warningSourceOf(wRule.source, classColor)
          }
        : {})
    },
    row(
      'viaDiameter',
      noted(t('pcbEditor.viewport.facts.viaDiameter'), viaNote),
      mmDist,
      via.diameter
    ),
    row('viaDrill', t('pcbEditor.viewport.facts.viaDrill'), mmDist, via.drill)
  ]
  const rules = sizeRules.value
  const item =
    routeViolator.value !== null ? spatialIndex.value?.items[routeViolator.value] : undefined
  if (b && rules && item) {
    const layer = routingLayer.value
    const resolved = rules.resolver.evaluate(
      'clearance',
      rules.newItem('track', net, [layer]),
      rules.copperItem(item),
      layer
    )
    fields.push(
      row(
        'clearance',
        t('pcbEditor.viewport.facts.clearance'),
        mmDist,
        resolved.value.min ?? routeClearance.value
      ),
      row(
        'clearanceTo',
        t('pcbEditor.viewport.facts.clearanceTo'),
        { kind: 'text' },
        boardItemLabel(b, item.ref, t)
      )
    )
  }
  fields.push(...routeLengthFields.value)
  return [{ type: 'route', title: t('pcbEditor.viewport.facts.route'), count: 1, fields }]
})

/** The routed net's length with the head, mm, where a `length` rule bounds it; else null. */
const routeLiveLength = computed<number | null>(() => {
  const draft = routeDraft.value
  if (!routeLengthRule.value || !draft || !routeTail.value) return null
  return (
    routeCommittedLength.value +
    pendingRouteLength(
      draft,
      { length: routeState.value?.headLength ?? 0, layer: routingLayer.value },
      routeLayerDistance.value
    )
  )
})

/**
 * The tuner's meter beside the head while a `length` rule bounds the routed
 * net, so a run going long shows before the tuning pass. Its bounds are the
 * tuner's for the net; the needle warns only past the max, since a route
 * still being drawn is short by nature. A rule in ps needs the tuner's delay
 * scale, so it keeps to Properties.
 */
const routeMeter = computed<TuneMeterReading | null>(() => {
  const length = routeLiveLength.value
  const b = board.value
  if (length === null || !b) return null
  const rule = tuneRuleFor(routeNet.value, routingLayer.value, 'single')
  if (!rule || rule.timeDomain) return null
  const target = tuneTargetOf('single', null, rule)
  return {
    mode: 'single',
    net: getNetName(b, routeNet.value),
    value: length,
    target,
    status: statusOf(length, target) === 'too_long' ? 'too_long' : 'tuned'
  }
})

/** The live length (S11), where a `length` rule bounds the net: the one row that changes with every move of the head. */
const routeLengthFields = computed<PropertyField[]>(() => {
  const rule = routeLengthRule.value
  const length = routeLiveLength.value
  if (!rule || length === null) return []
  const bounds =
    rule.min !== undefined && rule.max !== undefined
      ? t('pcbEditor.viewport.facts.lengthBetween', {
          min: formatSize(rule.min),
          max: formatSize(rule.max)
        })
      : rule.max !== undefined
        ? t('pcbEditor.viewport.facts.lengthAtMost', { max: formatSize(rule.max) })
        : t('pcbEditor.viewport.facts.lengthAtLeast', { min: formatSize(rule.min ?? 0) })
  const over = rule.max !== undefined && length > rule.max + 1e-9
  return [
    {
      key: 'length',
      label: t('pcbEditor.viewport.facts.length'),
      editor: { kind: 'distance', step: 0.01 },
      value: length,
      readonly: true,
      ...(over
        ? { warning: t('pcbEditor.viewport.facts.lengthOver', { max: formatSize(rule.max!) }) }
        : {})
    },
    {
      key: 'lengthRule',
      label: t('pcbEditor.viewport.facts.lengthRule'),
      editor: { kind: 'text' },
      value: `${bounds} mm · ${rule.source}`,
      readonly: true
    }
  ]
})

/**
 * The chips name the choice, never the routed net: a size picked or typed, in
 * millimeters, else nothing beside the glyph, each net's own (KiCad's "use
 * netclass width"). What a route lays is the bottom-left corner's (S11).
 */
const widthChipLabel = computed(() =>
  routeWidthState.value.source === 'list' || routeWidthState.value.source === 'custom'
    ? formatSize(routeWidth.value)
    : null
)
const viaChipLabel = computed(() =>
  routeViaState.value.source !== 'rules' ? formatVia(routeViaSize.value) : null
)
/** A size other than the net's own is in force: the chip is gold, as that is the one that surprises. */
const widthPicked = computed(
  () => sizeChoice.value.custom !== null || sizeChoice.value.widthIndex > 0
)
const viaPicked = computed(() => routeViaState.value.source !== 'rules')

/** A tool that places vias is armed: the via keys and `Q` act. */
const placesVias = computed(() => activeTool.value === 'route' || activeTool.value === 'via')

/** The size list, open from a chip or at the cursor (`Q`, S6); viewport coordinates. */
const sizeMenu = ref<{
  kind: 'width' | 'via' | 'both'
  x: number
  y: number
  /** The chip it opened from: a second press on it shuts the list. */
  anchor?: HTMLElement
} | null>(null)
const openSizeMenu = (
  kind: 'width' | 'via' | 'both',
  at: { x: number; y: number },
  anchor?: HTMLElement
): void => {
  sizeMenu.value = { kind, x: at.x, y: at.y, ...(anchor ? { anchor } : {}) }
}
const widthChip = ref<HTMLElement | null>(null)
const viaChip = ref<HTMLElement | null>(null)
/** A chip's list, under the chip; at the pointer when the bar has hidden it. */
const openSizeChip = (op: 'trackWidth' | 'viaSize'): void => {
  const chip = (op === 'trackWidth' ? widthChip.value : viaChip.value) ?? undefined
  if (chip && sizeMenu.value?.anchor === chip) {
    sizeMenu.value = null
    return
  }
  const rect = chip?.getBoundingClientRect()
  openSizeMenu(
    op === 'trackWidth' ? 'width' : 'via',
    rect && rect.width > 0 ? { x: rect.left, y: rect.bottom + 4 } : lastPointer,
    rect && rect.width > 0 ? chip : undefined
  )
}
/**
 * The layer pair's list, under its chip (R40, R42): the project's presets,
 * the pair's two layers to pick, and the presets to save, drop, or turn on
 * and off for Shift+V. Or, for a via that picks its layer (`<`, R43), the
 * copper to send it to, at the pointer.
 */
const layerMenu = ref<{
  kind: 'pair' | 'via'
  type: RouteViaType
  x: number
  y: number
  anchor?: HTMLElement
} | null>(null)
const pairChip = ref<HTMLElement | null>(null)
const shortLayer = (name: string): string => name.replace(/\.Cu$/, '')
const pairLabel = (pair: LayerPair): string =>
  `${shortLayer(pair.top)} ⇄ ${shortLayer(pair.bottom)}`
const samePair = (a: LayerPair, b: LayerPair): boolean => a.top === b.top && a.bottom === b.bottom
/** A layer's chip in the layer menus, in the theme's layer color. */
const layerSwatch = (layer: string): string[] => {
  const color = layerColors.value[layer]
  return color ? [color] : []
}
const pairSwatches = (pair: LayerPair): string[] => [
  ...layerSwatch(pair.top),
  ...layerSwatch(pair.bottom)
]
const openPairChip = (): void => {
  const chip = pairChip.value ?? undefined
  if (chip && layerMenu.value?.anchor === chip) {
    layerMenu.value = null
    return
  }
  const rect = chip?.getBoundingClientRect()
  const at = rect && rect.width > 0 ? { x: rect.left, y: rect.bottom + 4 } : lastPointer
  layerMenu.value = {
    kind: 'pair',
    type: 'through',
    ...at,
    ...(rect && rect.width > 0 && chip ? { anchor: chip } : {})
  }
}
const layerMenuItems = computed<MenuNode[]>(() => {
  const menu = layerMenu.value
  if (!menu) return []
  const copper = copperLayerNames.value
  if (menu.kind === 'via') {
    return [
      { header: t('pcbEditor.viewport.layerPair.pickLayer') },
      ...copper.map((layer) => ({
        id: `layer:${layer}`,
        label: layer,
        swatches: layerSwatch(layer),
        disabled: layer === routingLayer.value
      }))
    ]
  }
  const pair = layerPair.value
  const presets = layerPairPresets.value
  const out: MenuNode[] = [{ header: t('pcbEditor.viewport.layerPair.title') }]
  presets.forEach((preset, i) => {
    if (!preset.enabled) return
    out.push({
      id: `preset:${i}`,
      label: preset.name ? `${preset.name} · ${pairLabel(preset)}` : pairLabel(preset),
      swatches: pairSwatches(preset),
      checked: samePair(preset, pair)
    })
  })
  if (out.length > 1) out.push({ divider: true })
  out.push({
    id: 'top',
    label: t('pcbEditor.viewport.layerPair.top'),
    shortcut: pair.top,
    shortcutSwatch: layerColors.value[pair.top],
    children: copper.map((layer) => ({
      id: `top:${layer}`,
      label: layer,
      swatches: layerSwatch(layer),
      checked: layer === pair.top
    }))
  })
  out.push({
    id: 'bottom',
    label: t('pcbEditor.viewport.layerPair.bottom'),
    shortcut: pair.bottom,
    shortcutSwatch: layerColors.value[pair.bottom],
    children: copper.map((layer) => ({
      id: `bottom:${layer}`,
      label: layer,
      swatches: layerSwatch(layer),
      checked: layer === pair.bottom
    }))
  })
  out.push({ divider: true })
  const saved = presets.findIndex((p) => samePair(p, pair))
  if (projectPath.value)
    out.push(
      saved < 0
        ? { id: 'save', label: t('pcbEditor.viewport.layerPair.save') }
        : { id: `remove:${saved}`, label: t('pcbEditor.viewport.layerPair.remove') }
    )
  if (presets.length > 0)
    out.push({
      id: 'presets',
      label: t('pcbEditor.viewport.layerPair.presets'),
      children: presets.map((preset, i) => ({
        id: `toggle:${i}`,
        label: preset.name ? `${preset.name} · ${pairLabel(preset)}` : pairLabel(preset),
        swatches: pairSwatches(preset),
        checked: preset.enabled
      }))
    })
  return out
})
const savePairPresets = (next: ProjectLayerPair[]): void => {
  layerPairPresets.value = next
  const file = projectPath.value
  if (file) void writeProjectLayerPairs(file, next)
}
const onLayerMenuSelect = (id: string): void => {
  const menu = layerMenu.value
  layerMenu.value = null
  if (!menu) return
  const [kind, value] = id.split(/:(.*)/s)
  if (menu.kind === 'via') {
    if (kind === 'layer' && value) route.armVia(value, menu.type)
    return
  }
  const pair = layerPair.value
  const presets = layerPairPresets.value
  if (kind === 'preset') {
    const preset = presets[Number(value)]
    if (preset) route.setLayerPair(preset)
  } else if (kind === 'top' && value) route.setLayerPair({ top: value, bottom: pair.bottom })
  else if (kind === 'bottom' && value) route.setLayerPair({ top: pair.top, bottom: value })
  else if (kind === 'save') savePairPresets([...presets, { ...pair, enabled: true }])
  else if (kind === 'remove') savePairPresets(presets.filter((_, i) => i !== Number(value)))
  else if (kind === 'toggle')
    savePairPresets(
      presets.map((p, i) => (i === Number(value) ? { ...p, enabled: !p.enabled } : p))
    )
}
/** Shift+V: the next enabled preset becomes the pair (R42). */
const cycleLayerPair = (): void => {
  const next = nextLayerPair(layerPairPresets.value, layerPair.value)
  if (next) route.setLayerPair(next)
}
/** `<`, Alt+`<`: the via's layer from a list at the pointer (R43). */
const pickViaLayer = (type: RouteViaType): void => {
  if (!routeTail.value) return
  layerMenu.value = { kind: 'via', type, ...lastPointer }
}

/** Where the pointer last was, so `Q` opens the list under it. */
let lastPointer = { x: 0, y: 0 }
const trackPointer = (e: MouseEvent): void => {
  lastPointer = { x: e.clientX, y: e.clientY }
}
window.addEventListener('mousemove', trackPointer, { passive: true })
onUnmounted(() => {
  window.removeEventListener('mousemove', trackPointer)
  if (hintEchoTimer) clearTimeout(hintEchoTimer)
})

const sizeNote = <T,>(row: SizeEntry<T>): string | undefined =>
  row.outOfRule === 'below'
    ? t('pcbEditor.viewport.sizes.below')
    : row.outOfRule === 'above'
      ? t('pcbEditor.viewport.sizes.above')
      : undefined

/**
 * The size list (S4, S6): a chip's, or the router menu's Track and via sizes
 * (R21) — KiCad's Select Track/Via Width menu. *Use starting track width*,
 * then the track widths with the net class's first (the pair's sizes while a
 * pair is routed), then the vias likewise. A row is ticked while it is what a
 * click lays.
 */
const sizeItems = (kind: 'width' | 'via' | 'both'): MenuNode[] => {
  const out: MenuNode[] = []
  const choice = sizeChoice.value
  if (kind !== 'via' && pairDraft.value) {
    const own = pairRule.value
    const rows = [{ width: own.width.value, gap: own.gap.value }, ...setupPairSizes.value]
    out.push({ header: t('pcbEditor.viewport.sizes.pairSize') })
    rows.forEach((row, i) =>
      out.push({
        id: `pair:${i}`,
        label:
          i === 0
            ? t('pcbEditor.viewport.sizes.netClass', {
                size: `${formatSize(row.width)} / ${formatSize(row.gap)}`
              })
            : t('pcbEditor.viewport.sizes.size', {
                size: `${formatSize(row.width)} / ${formatSize(row.gap)}`
              }),
        // What set the first row, as the track list's names its rule (S12).
        shortcut: i === 0 ? own.width.source : undefined,
        checked: !pairSizeOverride.value && pairSizeIndex.value === i
      })
    )
  } else if (kind !== 'via') {
    const width = routeWidthState.value
    const rule = widthRule.value
    out.push({
      header: !routeTail.value
        ? t('pcbEditor.viewport.sizes.trackWidth')
        : rule.max !== undefined
          ? t('pcbEditor.viewport.sizes.trackWidthBetween', {
              min: formatSize(rule.min),
              max: formatSize(rule.max)
            })
          : t('pcbEditor.viewport.sizes.trackWidthAtLeast', { min: formatSize(rule.min) })
    })
    out.push({
      id: 'useConnected',
      label: t('pcbEditor.viewport.sizes.useConnected'),
      shortcut: width.source === 'track' ? formatSize(width.width) : undefined,
      checked: useConnectedWidth.value
    })
    out.push({ divider: true })
    widthList.value.forEach((row, i) =>
      out.push({
        id: `width:${i}`,
        label: row.netClass
          ? routeTail.value
            ? t('pcbEditor.viewport.sizes.netClass', { size: formatSize(row.size) })
            : t('pcbEditor.viewport.sizes.netClassIdle')
          : t('pcbEditor.viewport.sizes.size', { size: formatSize(row.size) }),
        shortcut: row.netClass && routeTail.value ? widthRule.value.source : sizeNote(row),
        checked: width.source !== 'track' && !choice.custom && choice.widthIndex === i
      })
    )
  }
  if (kind !== 'width') {
    if (out.length > 0) out.push({ divider: true })
    out.push({
      header: routeTail.value
        ? t('pcbEditor.viewport.sizes.viaSizeAtLeast', { min: formatVia(viaRule.value.min) })
        : t('pcbEditor.viewport.sizes.viaSize')
    })
    viaList.value.forEach((row, i) =>
      out.push({
        id: `via:${i}`,
        label: row.netClass
          ? routeTail.value
            ? t('pcbEditor.viewport.sizes.netClass', { size: formatVia(row.size) })
            : t('pcbEditor.viewport.sizes.netClassIdle')
          : t('pcbEditor.viewport.sizes.size', { size: formatVia(row.size) }),
        shortcut: row.netClass && routeTail.value ? viaRule.value.source : sizeNote(row),
        checked: !choice.custom && choice.viaIndex === i
      })
    )
  }
  out.push({ divider: true })
  out.push({
    id: 'customSize',
    label: t('pcbEditor.viewport.sizes.custom'),
    shortcut: hotkeyLabel('pcb.routeSizes'),
    checked: choice.custom !== null
  })
  out.push({ id: 'editSizes', label: t('pcbEditor.viewport.sizes.edit') })
  return out
}
const sizeMenuItems = computed<MenuNode[]>(() =>
  sizeMenu.value ? sizeItems(sizeMenu.value.kind) : []
)

/** The typed size's form (S6, KiCad's custom size), where the list was; viewport coordinates. */
const customSize = ref<{ x: number; y: number } | null>(null)
const applyCustomSize = (size: Record<string, number>): void => {
  setSizeChoice({
    ...sizeChoice.value,
    custom: { width: size.width, via: { diameter: size.viaDiameter, drill: size.viaDrill } },
    override: true
  })
  customSize.value = null
}

/** The rules, while clearance outlines are shown: each item's own clearance. */
const clearanceRules = computed(() => {
  const b = board.value
  const view = pcbView.value
  if (!b || (!view.padClearance && view.trackClearance !== 'always')) return null
  return boardRules(
    b,
    {
      rules: setupRules.value,
      classes: setupClasses.value,
      patterns: setupPatterns.value,
      assignments: setupAssignments.value,
      tuning: setupTuning.value
    },
    setupCustomRules.value
  )
})

/**
 * "Why this limit?": what the rules require of one or two selected copper
 * items, and what set each value; null for any other selection.
 */
const selectionLimits = computed<ExplainedLimit[] | null>(() => {
  const b = board.value
  const refs = selectedItems.value
  if (!b || refs.length === 0 || refs.length > 2) return null
  const rules = boardRules(
    b,
    {
      rules: setupRules.value,
      classes: setupClasses.value,
      patterns: setupPatterns.value,
      assignments: setupAssignments.value,
      tuning: setupTuning.value
    },
    setupCustomRules.value
  )
  const index = boardIndex(b)
  const targets = refs.map((ref) => explainTargetOf(b, index, rules, ref))
  const [a, other] = targets
  if (!a || targets.some((target) => !target)) return null
  return explainLimits(rules, a, other)
})

/** The rules, while tracks or vias are selected: what their sizes reset from. */
const selectionRules = computed(() => {
  const b = board.value
  const sized = selectedItems.value.some(
    (r) => r.type === 'segment' || r.type === 'tarc' || r.type === 'via'
  )
  if (!b || !sized) return null
  return boardRules(
    b,
    {
      rules: setupRules.value,
      classes: setupClasses.value,
      patterns: setupPatterns.value,
      assignments: setupAssignments.value,
      tuning: setupTuning.value
    },
    setupCustomRules.value
  )
})
const viaMinimum = (): ViaSize => ({
  diameter: setupRules.value.minViaDiameter,
  drill: setupRules.value.minThroughHoleDiameter
})

/**
 * Resize the selected tracks' widths or vias' sizes through the list (S9), as
 * one undo step: its first row the Default class's size, whatever the item's
 * net, as KiCad's (`BOARD_EDITOR_CONTROL::TrackWidthInc`). False when the
 * selection holds anything but tracks and vias, so a key falls through.
 */
const resizeSelected = (
  kind: 'width' | 'via',
  label: string,
  next: <T>(list: ReadonlyArray<SizeEntry<T>>, measure: (s: T) => number, current: T) => T
): boolean => {
  const b = board.value
  const refs = selectedItems.value
  if (!b || props.isReadOnly || refs.length === 0) return false
  if (!refs.every((r) => r.type === 'segment' || r.type === 'tarc' || r.type === 'via'))
    return false
  const { widths, vias } = selectionSizeLists(
    defaultNetClass(setupClasses.value),
    setupExtraSizes.value
  )
  const edits: Array<() => void> = []
  for (const ref of refs) {
    if (kind === 'width' && ref.type !== 'via') {
      const segment = ref.type === 'segment' ? b.segments[ref.index] : undefined
      const arc = ref.type === 'tarc' ? b.trackArcs[ref.index] : undefined
      const track = segment ?? arc
      if (!track) continue
      const width = mmToNm(next(widths, (w) => w, nmToMm(track.width)))
      if (width === track.width) continue
      if (segment) edits.push(() => updateSegmentInAST(segment, { width }, b))
      else if (arc) edits.push(() => updateTrackArcInAST(arc, { width }))
    } else if (kind === 'via' && ref.type === 'via') {
      const via = b.vias[ref.index]
      if (!via) continue
      const current = { diameter: nmToMm(via.size), drill: nmToMm(via.drill) }
      const size = next(vias, (v) => v.diameter, current)
      const diameter = mmToNm(size.diameter)
      const drill = mmToNm(size.drill)
      if (diameter === via.size && drill === via.drill) continue
      edits.push(() => updateViaInAST(via, { size: diameter, drill }, b))
    }
  }
  if (edits.length > 0) runCommand(label, () => edits.forEach((edit) => edit()))
  return true
}

/** `W` / `'` with only tracks and vias selected and no tool armed (S9, KiCad's). */
const stepSelectedSizes = (kind: 'width' | 'via', dir: 1 | -1): boolean =>
  resizeSelected(
    kind,
    kind === 'width'
      ? t('pcbEditor.commands.changeTrackWidth')
      : t('pcbEditor.commands.changeViaSize'),
    (list, measure, current) => stepDrawn(list, measure, current, dir)
  )

/**
 * KiCad's Edit Track & Via Properties' "Set to net class / custom rule
 * values", for the selection: each track's width and via's size and drill
 * as its own net's rules ask, as one undo step.
 */
const setSizesFromRules = (): void => {
  const b = board.value
  const rules = selectionRules.value
  if (!b || !rules || props.isReadOnly) return
  const edits: Array<() => void> = []
  for (const ref of selectedCopper()) {
    if (ref.type === 'via') {
      const via = b.vias[ref.index]
      const size = resolveVia(rules, via.net, via.layers, viaMinimum()).value
      const diameter = mmToNm(size.diameter)
      const drill = mmToNm(size.drill)
      if (diameter !== via.size || drill !== via.drill)
        edits.push(() => updateViaInAST(via, { size: diameter, drill }, b))
      continue
    }
    const segment = ref.type === 'segment' ? b.segments[ref.index] : undefined
    const arc = ref.type === 'tarc' ? b.trackArcs[ref.index] : undefined
    const track = segment ?? arc
    if (!track) continue
    const width = mmToNm(
      resolveTrackWidth(rules, track.net, track.layer, setupRules.value.minTrackWidth).value
    )
    if (width === track.width) continue
    if (segment) edits.push(() => updateSegmentInAST(segment, { width }, b))
    else if (arc) edits.push(() => updateTrackArcInAST(arc, { width }))
  }
  if (edits.length > 0)
    runCommand(t('pcbEditor.setSizes.undo'), () => edits.forEach((edit) => edit()))
}

// ---------------------------------------------------------------------------
// Clean up tracks and vias: KiCad's Cleanup Tracks & Vias (lib/board/trackCleanup.ts),
// from its dialog, and as the dangling findings' quick fixes.
// ---------------------------------------------------------------------------

/** The pads and vias selected: what Edit teardrops' "Selected items only" reaches. */
const selectedTeardropItems = (): Array<KicadPad | KicadVia> => {
  const b = board.value
  if (!b) return []
  return [
    ...selectedPads(b, selectedItems.value),
    ...selectedItems.value.flatMap((r) =>
      r.type === 'via' && b.vias[r.index] ? [b.vias[r.index]] : []
    )
  ]
}

/** Edit teardrops while open; `selectionOnly` when it opened on the selection. */
const teardropDialog = ref<{ selectionOnly: boolean } | null>(null)
const openTeardrops = (selectionOnly = false): void => {
  if (props.isReadOnly || !board.value) return
  teardropDialog.value = { selectionOnly }
}
const teardropClassNames = computed(() => setupClasses.value.map((c) => c.name))

/** The dialog's request as an edit: its selection, net, class and layer resolved on the board. */
const teardropEditOf = (b: KicadBoard, request: TeardropDialogRequest): TeardropEdit => {
  let nets: Set<number> | undefined
  if (request.net !== null) nets = new Set([request.net])
  if (request.netClass !== null) {
    const inClass = new Set(
      b.nets
        .filter(
          (n) =>
            netClassForNet(n.name, setupClasses.value, setupPatterns.value, setupAssignments.value)
              .name === request.netClass
        )
        .map((n) => n.number)
    )
    nets = nets ? new Set([...nets].filter((n) => inClass.has(n))) : inClass
  }
  return {
    action: request.action,
    targets: request.targets,
    roundOnly: request.roundOnly,
    existingOnly: request.existingOnly,
    ...(request.selectionOnly ? { items: new Set(selectedTeardropItems()) } : {}),
    ...(nets ? { nets } : {}),
    ...(request.layer !== null ? { layers: new Set([request.layer]) } : {}),
    ...(request.action === 'set' ? { values: request.values } : {})
  }
}
const countTeardrops = (request: TeardropDialogRequest): number => {
  const b = board.value
  if (!b) return 0
  const done = applyTeardropEdit(b, teardropEditOf(b, request), teardropDefaults.value, false)
  return done.pads + done.vias
}
const runTeardrops = async (request: TeardropDialogRequest): Promise<void> => {
  const b = board.value
  if (!b) return
  const done = editTeardrops(
    props.session,
    t('pcbEditor.commands.editTeardrops'),
    teardropEditOf(b, request)
  )
  if (done) saveTeardropDefaults(done.settings)
}

/** The selected tracks, arcs and vias. */
const selectedCopper = (): BoardItemRef[] =>
  selectedItems.value.filter((r) => r.type === 'segment' || r.type === 'tarc' || r.type === 'via')

/** The dialog while open; `selectionOnly` when it opened on the selection. */
const cleanupDialog = ref<{ selectionOnly: boolean } | null>(null)
const openCleanup = (selectionOnly = false): void => {
  if (props.isReadOnly || !board.value) return
  cleanupDialog.value = { selectionOnly }
}
const cleanupNets = computed(() =>
  (board.value?.nets ?? [])
    .filter((n) => n.number > 0 && n.name)
    .map(({ number, name }) => ({ number, name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
)

/** Dangling copper is judged against the fills: refill first where they are out of date. */
const refillForCleanup = async (): Promise<void> => {
  if (props.session.staleZones().size === 0 && refillTimer === null) return
  if (refillTimer !== null) {
    window.clearTimeout(refillTimer)
    refillTimer = null
  }
  await runRefill('own')
}

/** The cleanup a request asks for, over the board as it stands once refilled. */
const planCleanup = async (
  request: CleanupRequest,
  seeds?: readonly TrackRef[]
): Promise<{ board: KicadBoard; plan: CleanupPlan } | null> => {
  if (request.refill) await refillForCleanup()
  // A board an agent edits under the plan is planned again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const b = board.value
    if (!b) return null
    const selected = new Set(selectedCopper().map((ref) => `${ref.type}:${ref.index}`))
    const scope: CleanupScope = (ref) => {
      if (request.selectionOnly && !selected.has(`${ref.type}:${ref.index}`)) return false
      const item =
        ref.type === 'segment'
          ? b.segments[ref.index]
          : ref.type === 'tarc'
            ? b.trackArcs[ref.index]
            : b.vias[ref.index]
      if (request.net !== null && item.net !== request.net) return false
      const on = 'layers' in item ? item.layers : [item.layer]
      return request.layer === null || on.includes(request.layer)
    }
    const plan = await planInSlices(
      planTrackCleanup(
        {
          board: b,
          index: spatialIndex.value ?? boardIndex(b),
          connectivity: null,
          settings: checkSettings.value
        },
        request.options,
        scope,
        seeds
      )
    )
    if (board.value === b) return { board: b, plan }
  }
  return null
}

/** The dialog's list: each change, by what it names and where. */
const previewCleanup = async (request: CleanupRequest): Promise<CleanupRow[]> => {
  const planned = await planCleanup(request)
  if (!planned) return []
  const { board: b, plan } = planned
  const at = (n: Nm): string => `${Math.round(nmToMm(n) * 1000) / 1000}`
  return plan.changes.map((change, i) => {
    const [first] = change.items
    const item =
      first.type === 'segment'
        ? b.segments[first.index]
        : first.type === 'tarc'
          ? b.trackArcs[first.index]
          : b.vias[first.index]
    return {
      key: `${i}`,
      kind: change.kind,
      at: `${at(change.at.x)}, ${at(change.at.y)}`,
      net: item.net > 0 ? getNetName(b, item.net) : '',
      layer: change.layer
    }
  })
}

/** Plan again and land the plan as one undo step. */
const runCleanup = async (request: CleanupRequest, seeds?: readonly TrackRef[]): Promise<void> => {
  const planned = await planCleanup(request, seeds)
  if (!planned || planned.plan.changes.length === 0) return
  // What the selection named may be gone, and the rest renumbered.
  selectedItems.value = []
  runCommand(t('pcbEditor.commands.cleanup'), () => applyTrackCleanup(planned.board, planned.plan))
  // The edit's own refill runs where auto-refill is on; "before and after" asks for it regardless.
  if (request.refill && !refillable()) refillNow()
}

const DANGLING_RULES: ReadonlySet<string> = new Set(['track-dangling', 'via-dangling'])

/** Remove what the dangling findings name, and what their removal leaves hanging. */
const removeDangling = (results: readonly CheckResult[]): void => {
  const b = board.value
  if (!b || props.isReadOnly) return
  const seeds = results
    .flatMap((result) => locateBoardItems(b, result.targets ?? []))
    .filter(
      (ref): ref is TrackRef => ref.type === 'segment' || ref.type === 'tarc' || ref.type === 'via'
    )
  if (seeds.length === 0) return
  // The findings were judged against fresh fills; so is their fix.
  void refillForCleanup().then(() =>
    runCleanup(
      {
        options: {
          ...DEFAULT_CLEANUP_OPTIONS,
          shorts: false,
          redundantVias: false,
          mergeTracks: false,
          tracksInPads: false,
          danglingTracks: true,
          danglingVias: true
        },
        refill: false,
        selectionOnly: false,
        net: null,
        layer: null
      },
      seeds
    )
  )
}

/** Board Setup's section to show when it opens from the size list (S6). */
const setupSectionRequest = boardSetupSectionRequest(() => props.filePath)

const onSizeMenuSelect = (id: string): void => {
  const at = sizeMenu.value
  sizeMenu.value = null
  pickSize(id, at ?? lastPointer)
}

/** A row of the size list picked, from a chip or the router menu; `at` places the custom form. */
const pickSize = (id: string, at: { x: number; y: number }): void => {
  if (id === 'customSize') {
    customSize.value = { x: at.x, y: at.y }
    return
  }
  if (id === 'editSizes') {
    if (props.filePath) requestBoardSetupSection(props.filePath, 'netClasses')
    emit('open-setup')
    return
  }
  if (id === 'useConnected') {
    // On again, the started-from width holds again, over a custom size (KiCad's).
    const on = !useConnectedWidth.value
    boardView.value.autoTrackWidth = on
    if (on) setSizeChoice({ ...sizeChoice.value, custom: null, override: false })
    return
  }
  const [kind, which] = id.split(':')
  if (kind === 'pair') {
    pairSizeIndex.value = Number(which)
    pairSizeOverride.value = null
    return
  }
  echoKey(kind === 'width' ? 'pcb.trackWidthNext' : 'pcb.viaSizeNext')
  if (kind === 'width') pickWidthRow(Number(which))
  else if (kind === 'via') pickViaRow(Number(which))
}

// --- The router's right-click menu (router-behavior.md R21): KiCad's Interactive
// Router menu, the items we support, while routing, pairing, dragging or tuning.
const routerMenu = ref<{ x: number; y: number; gesture: RouterGesture } | null>(null)
/** Set for the press that shuts the router menu, so it is not also a click on the board. */
let routerMenuDismissing = false

const openRouterMenu = (at: { clientX: number; clientY: number }): void => {
  // A press-drag holds the left button and offers no menu (KiCad's inline drag).
  if (mouseTrackDrag.value) return
  const gesture: RouterGesture = tuneActive.value
    ? 'tune'
    : pairActive.value
      ? 'pair'
      : trackDrag.value
        ? 'drag'
        : 'route'
  routerMenu.value = { x: at.clientX, y: at.clientY, gesture }
}

const closeRouterMenu = (): void => {
  routerMenu.value = null
  routerMenuDismissing = true
  setTimeout(() => (routerMenuDismissing = false), 0)
}

/** A corner mode as the router menu names it (KiCad's Track Corner Mode submenu). */
const cornerLabel = (corner: PcbRouterCorner): string =>
  corner === 'arc45' || corner === 'arc90'
    ? t('pcbEditor.routerMenu.cornerArc', { angle: corner.slice(3) })
    : t('pcbEditor.routerMenu.cornerAngle', { angle: corner })

const routerMenuLabel = (id: RouterMenuId): string => {
  switch (id) {
    case 'cancel':
      return t('pcbEditor.routerMenu.cancel')
    case 'finish':
      return t('pcbEditor.routerMenu.finish')
    case 'undoSegment':
      return t('pcbEditor.routerMenu.undoSegment')
    case 'routeFromOtherEnd':
      return t('pcbEditor.routeRun.fromOtherEnd')
    case 'attemptFinish':
      return t('pcbEditor.routerMenu.attemptFinish')
    case 'viaThrough':
      return t('pcbEditor.routerMenu.viaThrough')
    case 'viaBlind':
      return t('pcbEditor.routerMenu.viaBlind')
    case 'viaMicro':
      return t('pcbEditor.routerMenu.viaMicro')
    case 'viaPickThrough':
      return t('pcbEditor.routerMenu.viaPickThrough')
    case 'viaPickBlind':
      return t('pcbEditor.routerMenu.viaPickBlind')
    case 'posture':
      return t('pcbEditor.routerMenu.posture')
    case 'corner':
      return t('pcbEditor.routerMenu.corner')
    case 'sizes':
      return t('pcbEditor.routerMenu.sizes')
    case 'pairDimensions':
      return t('pcbEditor.pair.dimensionsOp')
    case 'tuneSettings':
      return t('pcbEditor.tune.settingsOp')
    case 'mode':
      return t('pcbEditor.routerMenu.mode')
  }
}

const routerMenuChildren = (id: RouterMenuId): MenuNode[] | undefined => {
  if (id === 'sizes') return sizeItems('both')
  if (id === 'corner')
    return ROUTER_CORNERS.map((corner) => ({
      id: `corner:${corner}`,
      label: cornerLabel(corner),
      checked: (routerPrefs.value.corner ?? '45') === corner
    }))
  if (id === 'mode')
    return ROUTER_MODES.map((mode) => ({
      id: `mode:${mode}`,
      label: t(`pcbEditor.viewport.routeModes.${mode}`),
      checked: routerPrefs.value.mode === mode
    }))
  return undefined
}

const routerMenuItems = computed<MenuNode[]>(() => {
  const menu = routerMenu.value
  if (!menu) return []
  const pair = menu.gesture === 'pair'
  const rows = routerMenuRows({
    gesture: menu.gesture,
    started: pair ? pairDraft.value !== null : routeTail.value !== null,
    clicked: pair
      ? (pairDraft.value?.stops.length ?? 0) > 0 || pairDraft.value?.armedVia === true
      : route.state.stops.length > 0 || routeViaTarget.value !== null,
    hasOtherEnd: routeAnchors.value.length > 0
  })
  return rows.map((row): MenuNode => {
    if ('divider' in row) return row
    const children = routerMenuChildren(row.id)
    return {
      id: row.id,
      label: routerMenuLabel(row.id),
      ...(row.hotkey ? { shortcut: hotkeyLabel(row.hotkey) } : {}),
      ...(row.id === 'corner' ? { shortcut: hotkeyLabel('pcb.routeCorner') } : {}),
      ...(row.disabled ? { disabled: true } : {}),
      ...(children ? { children } : {})
    }
  })
})

const onRouterMenuSelect = (id: string): void => {
  const menu = routerMenu.value
  routerMenu.value = null
  if (!menu) return
  const at = { x: menu.x, y: menu.y }
  const [group, value] = id.split(':')
  if (group === 'corner') setPcbRouter({ corner: value as PcbRouterCorner })
  else if (group === 'mode') setPcbRouter({ mode: value as PcbRouterMode })
  else if (
    group === 'width' ||
    group === 'via' ||
    group === 'pair' ||
    id === 'useConnected' ||
    id === 'customSize' ||
    id === 'editSizes'
  )
    pickSize(id, at)
  else runRouterMenuItem(id as RouterMenuId, menu.gesture, at)
  refreshGesturePreview()
}

const runRouterMenuItem = (
  id: RouterMenuId,
  gesture: RouterGesture,
  at: { x: number; y: number }
): void => {
  switch (id) {
    case 'cancel':
      return runEscape()
    case 'finish':
      if (gesture === 'route') return endRouteHere()
      if (gesture === 'pair') return finishPair()
      return commitTrackDrag()
    case 'undoSegment':
      return gesture === 'pair' ? unpairLast() : unrouteLast()
    case 'routeFromOtherEnd':
      return routeFromOtherEnd()
    case 'attemptFinish':
      return attemptAutoFinish()
    case 'viaThrough':
      if (gesture === 'pair') {
        if (pairDraft.value) pairDraft.value = { ...pairDraft.value, armedVia: true }
        return
      }
      if (routeTail.value) return route.armVia()
      route.setStartVia(true)
      return
    case 'viaBlind':
      return route.armVia(undefined, 'blind')
    case 'viaMicro':
      return route.armVia(undefined, 'micro')
    case 'viaPickThrough':
      layerMenu.value = { kind: 'via', type: 'through', ...at }
      return
    case 'viaPickBlind':
      layerMenu.value = { kind: 'via', type: 'blind', ...at }
      return
    case 'posture':
      route.flipPosture()
      return
    case 'pairDimensions':
      pairSizeForm.value = { ...at }
      return
    case 'tuneSettings':
      tuneSettingsForm.value = { ...at }
      return
  }
}

/** A choice from the menu shows at once in the gesture in hand, not at the next mouse move. */
const refreshGesturePreview = (): void => {
  const cursor = viewportRef.value?.getCursor()
  if (!cursor) return
  if (pairDraft.value) handlePairMove(lastPairCursor ?? cursor)
  else if (trackDrag.value && !mouseTrackDrag.value) handleTrackDragMove(cursor)
}
const routeClearance = computed(() => routeClass.value.clearance)

// Layer visibility, the active layer and the inactive-layer mode belong to the
// BOARD, not to this component and not to the app: `boardViewStore` keeps them
// across tab switches and, when the board has a project, in its `.kicad_prl`.
const boardView = computed(() => boardViewFor(props.filePath ?? ''))
// Asked for now, answered long before the parse is: the viewport waits on it
// below rather than drawing the defaults and rebuilding through them.
prefetchBoardView(props.filePath ?? '')
/** False until this board's remembered layers are in hand. */
const viewReady = computed(() => boardViewReady(props.filePath ?? ''))
const layerVisibility = computed({
  get: () => boardView.value.layerVisibility,
  set: (next) => (boardView.value.layerVisibility = next)
})
const activeLayer = computed({
  get: () => boardView.value.activeLayer,
  set: (next) => (boardView.value.activeLayer = next)
})

// Any layer can be active (for highlight/dim focus), but tracks only ever go
// on copper: remember the last copper choice for the routing tool
const lastCopperLayer = ref('F.Cu')
const routingLayer = computed(() =>
  isCopperLayer(activeLayer.value) ? activeLayer.value : lastCopperLayer.value
)

// View options: non-active layer display mode and flipped (view-from-back)
const nonActiveDisplay = computed({
  get: () => boardView.value.nonActiveDisplay,
  set: (next: NonActiveLayerDisplay) => (boardView.value.nonActiveDisplay = next)
})
const flipped = ref(false)

/**
 * Component bodies and their contact shadows over the editable layout. The
 * complete physical board already has a home in 3D Preview; keeping this a
 * plain toggle makes its job unambiguous and makes blink-comparison immediate.
 */
const ASSEMBLY_OVERLAY_OPACITY = 0.8
const assemblyOverlay = ref(false)
const toggleAssemblyOverlay = (): void => {
  assemblyOverlay.value = !assemblyOverlay.value
}

// Persisted display toggles behind the left view rail (lib/pcbView.ts):
// zone fills, per-class sketch modes. Shared and synced across windows.
const pcbView = pcbViewState()

const cycleRouteMode = (): void => setPcbRouter({ mode: nextRouterMode(routerPrefs.value.mode) })

// The tool search lists every control on the toolbar and the view rail
// (lib/toolSearch.ts): the ids are the tools' own, plus the actions below.
const insertSearch = ref<InstanceType<typeof ToolbarSearch> | null>(null)

/** The selection holds pads, vias or footprints to route from (R44, R46). */
const canRouteSelection = computed(() =>
  selectedItems.value.some((r) => r.type === 'pad' || r.type === 'via' || r.type === 'footprint')
)

const searchOps = computed<ToolbarSearchOp[]>(() => {
  const tool = (
    id: PcbTool,
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
    state: paletteTool.value === id ? 'current' : undefined,
    disabled: props.isReadOnly && id !== 'select'
  })
  const toggle = (
    id: string,
    icon: ToolbarSearchOp['icon'],
    label: string,
    group: ToolbarSearchOp['group'],
    on: boolean
  ): ToolbarSearchOp => ({ id, icon, label, group, state: on ? 'on' : undefined })
  const verb = (
    id: string,
    icon: ToolbarSearchOp['icon'],
    label: string,
    action: HotkeyActionId | undefined,
    enabled: boolean
  ): ToolbarSearchOp => ({
    id,
    icon,
    label,
    group: 'select',
    hotkey: action && hotkeyLabel(action),
    disabled: !enabled
  })
  return [
    tool('select', 'tool-select', t('pcbEditor.viewport.select'), 'select', 'editor.cancel'),
    ...TRANSFORM_TOOLS.map(({ op, icon, label }): ToolbarSearchOp => ({
      id: op,
      icon,
      label: t(label),
      group: 'select',
      hotkey: transformHotkeys[op] && hotkeyLabel(transformHotkeys[op]),
      disabled: !canTransform(op)
    })),
    verb('changeSide', 'tool-flip', t('pcbEditor.tools.flip'), 'pcb.flip', canFlip.value),
    verb('fanout', 'tool-via', t('pcbEditor.tools.fanout'), 'pcb.fanout', canFanout.value),
    verb(
      'toggleLock',
      'tool-lock',
      t('pcbEditor.selection.toggleLock'),
      'pcb.toggleLock',
      !props.isReadOnly && selectedItems.value.length > 0
    ),
    verb(
      'selectConnection',
      'tool-select-connection',
      t('pcbEditor.selection.selectConnection'),
      'pcb.selectConnection',
      true
    ),
    verb('selectNet', 'tool-select-net', t('pcbEditor.selection.selectNet'), undefined, true),
    verb(
      'deleteFullTrack',
      'tool-delete-track',
      t('pcbEditor.selection.deleteFullTrack'),
      'pcb.deleteFullTrack',
      !props.isReadOnly && selectedItems.value.length > 0
    ),
    tool(
      'footprint',
      'tool-footprint',
      t('pcbEditor.viewport.placeFootprint'),
      'place',
      'pcb.tool.footprint'
    ),
    tool('route', 'tool-route', t('pcbEditor.viewport.route'), 'connect', 'pcb.tool.route'),
    tool('via', 'tool-via', t('pcbEditor.viewport.via'), 'connect', 'pcb.tool.via'),
    {
      ...verb(
        'routeSelected',
        'tool-route',
        t('pcbEditor.routeRun.selected'),
        'pcb.routeSelected',
        !props.isReadOnly && canRouteSelection.value
      ),
      group: 'connect'
    },
    {
      ...verb(
        'routeSelectedFromEnd',
        'tool-route',
        t('pcbEditor.routeRun.selectedFromEnd'),
        'pcb.routeSelectedFromEnd',
        !props.isReadOnly && canRouteSelection.value
      ),
      group: 'connect'
    },
    {
      ...verb(
        'finishSelected',
        'tool-route',
        t('pcbEditor.routeRun.finishSelected'),
        undefined,
        !props.isReadOnly && canRouteSelection.value
      ),
      group: 'connect'
    },
    {
      ...verb(
        'routeFromOtherEnd',
        'tool-route',
        t('pcbEditor.routeRun.fromOtherEnd'),
        'pcb.routeFromOtherEnd',
        routeTail.value !== null
      ),
      group: 'connect'
    },
    {
      ...verb(
        'routeDiffPair',
        'tool-route-pair',
        t('pcbEditor.pair.route'),
        'pcb.routeDiffPair',
        !props.isReadOnly
      ),
      group: 'connect',
      state: pairActive.value ? 'current' : undefined
    },
    ...TUNE_TOOLS.map(({ mode, icon, action }): ToolbarSearchOp => ({
      ...verb(`tune:${mode}`, icon, tuneToolLabel(mode), action, !props.isReadOnly),
      group: 'connect',
      state: tuneArmed.value === mode ? 'current' : undefined
    })),
    {
      ...verb(
        'pairDimensions',
        'tool-track-width',
        t('pcbEditor.pair.dimensionsOp'),
        undefined,
        true
      ),
      group: 'routeOptions'
    },
    {
      ...verb(
        'updateTuningPatterns',
        'tool-tune-single',
        t('pcbEditor.commands.updateTuningPatterns'),
        undefined,
        !props.isReadOnly && (board.value?.tuningPatterns.length ?? 0) > 0
      ),
      group: 'connect'
    },
    {
      ...verb(
        'tuneSettings',
        'tool-track-width',
        t('pcbEditor.tune.settingsOp'),
        'pcb.tuneSettings',
        true
      ),
      group: 'routeOptions'
    },
    verb(
      'breakTrack',
      'tool-route',
      t('pcbEditor.edit.breakTrack'),
      undefined,
      !props.isReadOnly &&
        selectedItems.value.length === 1 &&
        selectedItems.value[0].type === 'segment'
    ),
    verb(
      'trackLayerNext',
      'tool-route',
      t('pcbEditor.edit.trackLayerNext'),
      undefined,
      !props.isReadOnly && selectedTracks().length > 0
    ),
    verb(
      'trackLayerPrev',
      'tool-route',
      t('pcbEditor.edit.trackLayerPrev'),
      undefined,
      !props.isReadOnly && selectedTracks().length > 0
    ),
    {
      ...verb(
        'skipQueuedRoute',
        'tool-route',
        t('pcbEditor.routeRun.skip'),
        undefined,
        routeQueue.value.length > 0
      ),
      group: 'connect'
    },
    {
      id: 'routeMode',
      icon: `route-${routerPrefs.value.mode}`,
      label: t('pcbEditor.viewport.routeMode', {
        mode: t(`pcbEditor.viewport.routeModes.${routerPrefs.value.mode}`)
      }),
      group: 'routeOptions',
      hotkey: hotkeyLabel('pcb.cycleRouteMode')
    },
    {
      id: 'cornerMode',
      icon:
        routeRounded.value && !takesLineMode(activeTool.value)
          ? routeCornerMode.value === '90'
            ? 'corner-arc90'
            : 'corner-arc45'
          : `corner-${viewportCornerMode.value}`,
      label: t('pcbEditor.viewport.cornerMode', {
        mode:
          viewportCornerMode.value === 'free'
            ? t('pcbEditor.viewport.cornerFree')
            : routeRounded.value && !takesLineMode(activeTool.value)
              ? t('pcbEditor.viewport.cornerRounded', { angle: routeCornerMode.value })
              : `${viewportCornerMode.value}°`
      }),
      // A graphics tool's line mode, else the route's corners: one entry, the armed tool's.
      group: takesLineMode(activeTool.value) ? 'draw' : 'routeOptions',
      hotkey: hotkeyLabel(takesLineMode(activeTool.value) ? 'pcb.lineMode' : 'pcb.routeCorner')
    },
    {
      id: 'posture',
      icon: routeDiagFirst.value ? 'posture-diagonal' : 'posture-straight',
      label: t('pcbEditor.viewport.posture'),
      group: 'routeOptions',
      hotkey: hotkeyLabel('pcb.routePosture')
    },
    {
      id: 'trackWidth',
      icon: 'tool-track-width',
      label: t('pcbEditor.viewport.trackWidthOp', { size: formatSize(routeWidth.value) }),
      group: 'routeOptions',
      hotkey: hotkeyLabel('pcb.trackWidthNext')
    },
    {
      id: 'viaSize',
      icon: 'tool-via',
      label: t('pcbEditor.viewport.viaSizeOp', { size: formatVia(routeViaSize.value) }),
      group: 'routeOptions',
      hotkey: hotkeyLabel('pcb.viaSizeNext')
    },
    tool('line', 'tool-line', t('pcbEditor.viewport.line'), 'draw', 'pcb.tool.line'),
    tool('arc', 'tool-arc', t('pcbEditor.viewport.arc'), 'draw', 'pcb.tool.arc'),
    tool('rectangle', 'tool-rect', t('pcbEditor.viewport.rectangle'), 'draw'),
    tool('circle', 'tool-circle', t('pcbEditor.viewport.circle'), 'draw', 'pcb.tool.circle'),
    tool('polygon', 'tool-polygon', t('pcbEditor.viewport.polygon'), 'draw', 'pcb.tool.polygon'),
    tool('bezier', 'tool-bezier', t('pcbEditor.viewport.bezier'), 'draw', 'pcb.tool.bezier'),
    tool('text', 'tool-text', t('pcbEditor.viewport.text'), 'draw', 'pcb.tool.text'),
    tool('textBox', 'tool-text-box', t('pcbEditor.viewport.textBox'), 'draw'),
    tool('point', 'tool-point', t('pcbEditor.viewport.point'), 'draw'),
    tool('zone', 'tool-zone', t('pcbEditor.viewport.zone'), 'zones', 'pcb.tool.zone'),
    tool('gridOrigin', 'tool-grid-origin', t('pcbEditor.origins.placeGrid'), 'utilities'),
    {
      id: 'resetGridOrigin',
      icon: 'tool-grid-origin',
      label: t('pcbEditor.origins.resetGrid'),
      group: 'utilities',
      disabled: props.isReadOnly || !board.value?.gridOrigin
    },
    tool('drillOrigin', 'tool-drill-origin', t('pcbEditor.origins.placeDrill'), 'utilities'),
    {
      id: 'resetDrillOrigin',
      icon: 'tool-drill-origin',
      label: t('pcbEditor.origins.resetDrill'),
      group: 'utilities',
      disabled: props.isReadOnly || !board.value?.auxOrigin
    },
    {
      id: 'refill',
      icon: 'tool-refill',
      label: t('pcbEditor.viewport.refill'),
      group: 'zones',
      hotkey: hotkeyLabel('pcb.refillZones'),
      disabled: props.isReadOnly
    },
    {
      id: 'rerunChecks',
      icon: 'refresh',
      label: t('pcbEditor.viewport.rerunChecks'),
      group: 'utilities'
    },
    {
      id: 'cleanup',
      icon: 'tool-cleanup',
      label: t('pcbEditor.cleanup.action'),
      group: 'utilities',
      disabled: props.isReadOnly || !board.value
    },
    {
      id: 'editTeardrops',
      icon: 'tool-teardrop',
      label: t('pcbEditor.teardrops.action'),
      group: 'utilities',
      disabled: props.isReadOnly || !board.value
    },
    {
      id: 'setSizes',
      icon: 'tool-track-width',
      label: t('pcbEditor.setSizes.action'),
      group: 'utilities',
      disabled: props.isReadOnly || selectedCopper().length === 0
    },
    {
      id: 'updateFootprints',
      icon: 'refresh',
      label: t('pcbEditor.footprintUpdate.updateAction'),
      group: 'utilities',
      disabled: props.isReadOnly || !board.value?.footprints.length
    },
    {
      id: 'changeFootprint',
      icon: 'tool-footprint',
      label: t('pcbEditor.footprintUpdate.changeAction'),
      group: 'utilities',
      disabled: props.isReadOnly || selectedFootprints.value.length === 0
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
      'zoneFills',
      'view-zone-fills',
      t('pcbEditor.viewRail.zoneOutlines'),
      'display',
      !pcbView.value.zoneFills
    ),
    {
      ...toggle(
        'sketchTracks',
        'view-sketch-tracks',
        t('pcbEditor.viewRail.sketchTracks'),
        'display',
        pcbView.value.sketchTracks
      ),
      hotkey: hotkeyLabel('pcb.sketchTracks')
    },
    toggle(
      'sketchVias',
      'view-sketch-vias',
      t('pcbEditor.viewRail.sketchVias'),
      'display',
      pcbView.value.sketchVias
    ),
    toggle(
      'sketchPads',
      'view-sketch-pads',
      t('shared.insertSearch.ops.sketchPads'),
      'display',
      pcbView.value.sketchPads
    ),
    toggle(
      'ratsnest',
      'view-ratsnest',
      t('pcbEditor.viewRail.hideRatsnest'),
      'display',
      !pcbView.value.ratsnest
    ),
    toggle(
      'boardArea',
      'view-board-area',
      t('pcbEditor.viewRail.boardArea'),
      'display',
      pcbView.value.boardArea
    ),
    // KiCad's footprint-text switches, here until the Objects section holds them.
    toggle(
      'fpReferences',
      'tool-text',
      t('pcbEditor.viewRail.fpReferences'),
      'display',
      pcbView.value.fpReferences
    ),
    toggle(
      'fpValues',
      'tool-text',
      t('pcbEditor.viewRail.fpValues'),
      'display',
      pcbView.value.fpValues
    ),
    toggle('fpText', 'tool-text', t('pcbEditor.viewRail.fpText'), 'display', pcbView.value.fpText),
    {
      ...toggle(
        'assembly',
        'view-assembly',
        t('pcbEditor.viewRail.assembly'),
        'display',
        assemblyOverlay.value
      ),
      hotkey: hotkeyLabel('pcb.toggleRender')
    },
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
      hotkey: hotkeyLabel('pcb.cycleInactiveLayers')
    },
    toggle('flip', 'view-flip', t('pcbEditor.viewRail.flip'), 'layers', flipped.value)
  ]
})

const onSearchPick = (id: string): void => {
  if (isTransformOp(id)) runTransform(id)
  else if (id === 'changeSide') flipHeldOrSelected()
  else if (id === 'fanout') openFanout()
  else if (id === 'routeSelected') queueSelectedRoutes(false)
  else if (id === 'routeSelectedFromEnd') queueSelectedRoutes(true)
  else if (id === 'finishSelected') finishSelectedRoutes()
  else if (id === 'routeFromOtherEnd') routeFromOtherEnd()
  else if (id === 'breakTrack') breakTrackAt(viewportRef.value?.getCursor() ?? null)
  else if (id === 'routeDiffPair') beginPair()
  else if (id.startsWith('tune:')) {
    const mode = TUNE_TOOLS.find((tool) => `tune:${tool.mode}` === id)?.mode
    if (mode) armTune(mode)
  } else if (id === 'pairDimensions') pairSizeForm.value = { ...lastPointer }
  else if (id === 'tuneSettings') tuneSettingsForm.value = { ...lastPointer }
  else if (id === 'updateTuningPatterns') updateAllTuningPatterns()
  else if (id === 'trackLayerNext') moveTracksLayer(1)
  else if (id === 'trackLayerPrev') moveTracksLayer(-1)
  else if (id === 'skipQueuedRoute') {
    // KiCad's Cancel Current Item: this route is dropped, the next begins.
    route.cancel()
    startNextQueuedRoute()
  } else if (id === 'toggleLock') toggleLockSelected()
  else if (id === 'selectConnection') selectConnection()
  else if (id === 'selectNet') selectNet()
  else if (id === 'deleteFullTrack') deleteFullTrack()
  else if (id === 'boardArea') setPcbView({ boardArea: !pcbView.value.boardArea })
  else if (id === 'resetGridOrigin') setOrigin('grid', null)
  else if (id === 'resetDrillOrigin') setOrigin('drill', null)
  else if (id === 'routeMode') cycleRouteMode()
  else if (id === 'cornerMode') {
    if (takesLineMode(activeTool.value)) lineMode.value = nextRouteCornerMode(lineMode.value)
    else nextRouteCorner()
  } else if (id === 'posture') route.flipPosture()
  else if (id === 'trackWidth' || id === 'viaSize') openSizeChip(id)
  else if (id === 'refill') refillNow()
  else if (id === 'rerunChecks') rerunChecks()
  else if (id === 'cleanup') openCleanup()
  else if (id === 'editTeardrops') openTeardrops()
  else if (id === 'setSizes') setSizesFromRules()
  else if (id === 'updateFootprints') openFootprintUpdate()
  else if (id === 'changeFootprint') openFootprintChange()
  else if (id === FIT_VIEW_OP_ID) fitView()
  else if (isViewCommand(id)) viewportRef.value?.runViewCommand(id)
  else if (id === 'find') find.openFind()
  else if (id === 'zoneFills') setPcbView({ zoneFills: !pcbView.value.zoneFills })
  else if (id === 'sketchTracks') setPcbView({ sketchTracks: !pcbView.value.sketchTracks })
  else if (id === 'sketchVias') setPcbView({ sketchVias: !pcbView.value.sketchVias })
  else if (id === 'sketchPads') setPcbView({ sketchPads: !pcbView.value.sketchPads })
  else if (id === 'ratsnest') setPcbView({ ratsnest: !pcbView.value.ratsnest })
  else if (id === 'fpReferences') setPcbView({ fpReferences: !pcbView.value.fpReferences })
  else if (id === 'fpValues') setPcbView({ fpValues: !pcbView.value.fpValues })
  else if (id === 'fpText') setPcbView({ fpText: !pcbView.value.fpText })
  else if (id === 'assembly') toggleAssemblyOverlay()
  else if (id === 'nonActive') nonActiveDisplay.value = nextNonActiveDisplay(nonActiveDisplay.value)
  else if (id === 'flip') flipped.value = !flipped.value
  else setTool(id as PcbTool)
}

/** The left rail's dim button cycles the same state the right rail selects. */
// Right properties panel resize state
/** Shared with the other editors' right bars and persisted globally — a panel
 *  size is a preference, not per-window or per-tab state (`panelLayout.ts`). */
const propertiesWidth = panelWidth()
let propertiesResizeStart = propertiesWidth.value

// The parsed board, its structural undo and the text it still owes all live in
// the session (`lib/board/boardSession.ts`), which outlives this mount.

const historyVersion = ref(0)

// The session parses, in chunks for a document large enough to need them, and
// reports progress here so the window can show it.
const parseProgress = ref<number | null>(null)
/**
 * Bumped only when a parse produces a new board. An edit command reassigns
 * `board` too (via `remapKicadBoard`), and the viewport must tell the two
 * apart: a load earns the sliced build with progress, an edit has to rebuild
 * in one go — the same scene half-drawn between frames reads as flicker.
 */
const boardLoadId = computed(() => {
  void boardVersion.value
  return props.session.loadId()
})
/** The 2D viewport's build progress, reported up while it assembles a board. */
const sceneProgress = ref<number | null>(null)
/** True across the parse → viewport-build handoff; see boardLoadProgress.ts. */
const awaitingScene = ref(false)

const loadProgress = computed(() =>
  mergeBoardLoadProgress(parseProgress.value, sceneProgress.value, awaitingScene.value)
)
watch(loadProgress, (fraction) => emit('load-progress', fraction))
/**
 * The board is open and drawn: the findings drawer waits for it, as with no
 * canvas above it yet it would sit at the top of the pane.
 */
const boardShown = computed(() => !!board.value && viewReady.value && loadProgress.value === null)

const handleBuildProgress = (fraction: number | null): void => {
  sceneProgress.value = fraction
  if (fraction === null) awaitingScene.value = false
}

/** The session load this mount last settled; null until its first, which the
 *  mounting viewport builds whether or not the session had to parse. */
let settledLoadId: number | null = null

const loadBoardFromText = (content: string, onLoaded?: () => void): void => {
  // The session holds the board while the tab is open, so a switch back is not
  // a reload: `load` returns at once when the text is already the board's.
  void props.session
    .load(content, (fraction) => {
      // The parse's end is settled below, with the handoff to the viewport:
      // settled here, a flush between the two drops the bar for a frame.
      if (fraction !== null) parseProgress.value = fraction
    })
    .then(() => {
      parseProgress.value = null
      // The viewport builds a scene when it mounts and when a parse hands it a
      // new board. The echo of this session's own serialized text is neither:
      // arming the handoff for it raises a bar no build will ever settle.
      const loadId = props.session.loadId()
      const echo = loadId === settledLoadId
      settledLoadId = loadId
      // A board's stored fills may predate its copper or its rules (KiCad
      // saves whatever was last poured): each load refills every zone, once
      // per parse of the session, not again when its tab is shown again.
      if (openRefilled.get(props.session) !== loadId) {
        openRefilled.set(props.session, loadId)
        refillAllOwed = refillable()
        if (refillAllOwed) scheduleRefill()
        // The check held off for this decision.
        checkWhenReady()
      }
      // An agent edited this board while no editor showed it.
      if (props.session.staleZones().size > 0) scheduleRefill()
      if (echo) return
      const parsed = board.value
      if (parsed) void adoptBoardLayers(props.filePath ?? '', parsed.layers)
      awaitingScene.value = !!parsed && activeMode.value === 'visual'
      onLoaded?.()
      if (!awaitingScene.value) {
        void (async () => {
          await nextTick()
          await afterPaint()
          emit('load-progress', null)
        })()
      }
    })
}

watch(
  () => props.modelValue,
  (newVal) => {
    historyVersion.value++
    if (newVal) {
      loadBoardFromText(newVal)
    } else {
      parseProgress.value = null
      awaitingScene.value = false
      // Nothing to parse still settles the tab-level load bar.
      emit('load-progress', null)
    }
  },
  { immediate: true }
)

// ---------------------------------------------------------------------------
// Command layer (same pattern as FootprintEditor: every mutation funnels
// through runCommand which records an undo/redo entry per file)
// ---------------------------------------------------------------------------

interface CommandOptions {
  mergeKey?: string
  /** Derived work (auto zone refill) undoes with the user command before it. */
  groupWithPrevious?: boolean
  afterApply?: () => void
  zones?: BoardCommandOptions['zones']
  /** A refill's own commit (`BoardCommandOptions.refill`). */
  refill?: boolean
}

/** Set on unmount: nothing left running may edit a board its document now holds. */
let unmounted = false

/** An edit that takes a tuning pattern's tracks takes the pattern too (T4). */
const withPatternsPruned =
  (mutate: () => void): (() => void) =>
  () => {
    mutate()
    const b = board.value
    if (b) prunePatternsInAST(b)
  }

const runCommand = (label: string, mutate: () => void, options?: CommandOptions): void => {
  if (unmounted) return
  // The board holds still under a route (R34): an edit ends it first, keeping
  // what was clicked (R33), so the route never commits against a board that
  // moved since its pushes were worked out.
  if (route.active && !route.landing) commitRoute()
  // Pointer copies, so old positions survive both the remap and the in-place
  // domain writes the mutators perform.
  const previous = board.value
  const deltaPrev = previous
    ? {
        segments: previous.segments.slice(),
        trackArcs: previous.trackArcs.slice(),
        vias: previous.vias.slice(),
        footprints: previous.footprints.slice(),
        zones: previous.zones.slice()
      }
    : null

  ownCommand = true
  let ran: boolean
  try {
    ran = props.session.runCommand(label, withPatternsPruned(mutate), {
      mergeKey: options?.mergeKey,
      groupWithPrevious: options?.groupWithPrevious,
      selection: {
        before: selectedItems.value.map((i) => ({ ...i })),
        after: () => selectedItems.value.map((i) => ({ ...i }))
      },
      afterApply: options?.afterApply,
      zones: options?.zones,
      refill: options?.refill
    })
  } finally {
    ownCommand = false
  }
  if (!ran) return
  historyVersion.value++

  // Hand the viewport this command's delta so it patches the scene in place
  // rather than rebuilding it (BoardScene.applyBoardEdit).
  const change = props.session.lastChange()
  if (change && deltaPrev) {
    editDelta.value = {
      id: ++editDeltaId,
      fromBoard: change.fromBoard,
      raws: change.raws,
      prev: deltaPrev
    }
  }

  // Any edit can invalidate a pour; the refill's own commit must not
  // re-trigger itself. Undo and redo deliberately don't refill — they restore
  // the fills their snapshot carried. The board worker tracks which zones the
  // edits since the last refill reach.
  if (!refillCommitting) scheduleRefill()
}

const collectionForType = (type: string): unknown[] | undefined =>
  board.value ? boardCollection(board.value, type) : undefined

const rawForItem = (item: BoardItemRef): SExprNode | null => {
  const collection = collectionForType(item.type) as Array<{ _raw: SExprNode }> | undefined
  return collection?.[item.index]?._raw ?? null
}

/** Tell a schematic beside this board what was just selected
 *  (lib/crossProbe.ts): the user's own gesture only, never a reveal. */
const onViewportSelect = (items: BoardItemRef[]): void => {
  selectedItems.value = items
  if (!board.value || !props.filePath) return
  // A pad probes its part, as its footprint would.
  const footprints = footprintsOf(items)
  emitCrossProbe('board', boardProbeTargets(board.value, props.filePath, footprints), groupId)
}

// A part selected in a schematic: select its footprint here and bring it into
// view. Held until the board has parsed, since a probe can open this tab.
const applyProbe = (): void => {
  const request = props.probeRequest
  if (!request || !board.value || request.nonce === appliedProbeNonce) return
  appliedProbeNonce = request.nonce
  const indices = footprintIndicesFor(board.value, request.symbolUuids, request.references)
  if (indices.length === 0) return
  selectedItems.value = indices.map((index) => ({ type: 'footprint', index }))
  void nextTick(() => viewportRef.value?.focusFootprints(indices))
}
let appliedProbeNonce = 0
watch(() => [props.probeRequest?.nonce, board.value], applyProbe, { immediate: true })

// A net highlighted in a schematic lights here by name; one the board lacks clears (KiCad's).
const stopNetProbe = onCrossProbe((probe) => {
  if (probe.net === undefined || probe.origin === 'board') return
  const name = probe.net
  highlightedNet.value = name ? (board.value?.nets.find((n) => n.name === name)?.number ?? 0) : 0
})
onUnmounted(stopNetProbe)

// Items another surface points at (the Manufacture pre-flight): select them
// and show the first. Held, like a probe, until the board has parsed.
const applyFocus = (): void => {
  const request = props.focusRequest
  const b = board.value
  if (!request || !b || request.nonce === appliedFocusNonce) return
  appliedFocusNonce = request.nonce
  const located = locateBoardItems(b, request.uuids)
  selectedItems.value = located
  const at =
    request.at ?? located.map((ref) => boardItemPosition(b, ref)).find((p) => p !== null) ?? null
  if (at) void nextTick(() => viewportRef.value?.focusPoint(at.x, at.y))
}
let appliedFocusNonce = 0
watch(() => [props.focusRequest?.nonce, board.value], applyFocus, { immediate: true })

/** Re-select what an undone or redone step had, dropping what the restored
 *  board no longer has. */
const restoreSelection = (selection: BoardItemRef[]): void => {
  selectedItems.value = selection.filter((item) => {
    if (item.type === 'pad')
      return (
        item.pad !== undefined && !!board.value?.footprints[item.index]?.footprint.pads[item.pad]
      )
    if (item.type === 'fp_field' || item.type === 'fp_text')
      return !!board.value && !!footprintTextOf(board.value, item)
    const collection = collectionForType(item.type)
    return !!collection && item.index >= 0 && item.index < collection.length
  })
}

/**
 * The selection as move, rotate, flip, mirror and copy act on it: a selected
 * pad stands for its footprint (`promotePads`), as in KiCad's board editor.
 */
const actedSelection = computed(() => withPatternTracks(promotePads(selectedItems.value)))

/** A selected tuning pattern's tracks beside it: what moves, turns and flips with it (T4). */
const withPatternTracks = <T extends BoardItemRef>(refs: readonly T[]): T[] => {
  const b = board.value
  if (!b || !refs.some((r) => r.type === 'tuning_pattern')) return [...refs]
  const keys = new Set(refs.map(boardRefKey))
  const out = [...refs]
  for (const ref of refs) {
    const pattern = ref.type === 'tuning_pattern' ? b.tuningPatterns[ref.index] : undefined
    if (!pattern) continue
    for (const member of patternMembers(b, pattern)) {
      if (keys.has(boardRefKey(member))) continue
      keys.add(boardRefKey(member))
      out.push(member as T)
    }
  }
  return out
}

/** A selection with each tuning pattern given as its tracks alone: what unrouting takes (T4). */
const patternsAsTracks = (refs: readonly BoardItemRef[]): BoardItemRef[] =>
  withPatternTracks(refs).filter((r) => r.type !== 'tuning_pattern')

const undo = (): void => {
  if (props.isReadOnly) return
  cancelScheduledRefill()
  const entry = props.session.undo()
  if (entry) {
    restoreSelection(entry.selectionBefore)
    historyVersion.value++
  }
}

const redo = (): void => {
  if (props.isReadOnly) return
  cancelScheduledRefill()
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
  void boardVersion.value
  return props.session.canUndo()
})
const canRedo = computed(() => {
  void historyVersion.value
  void boardVersion.value
  return props.session.canRedo()
})
const undoTitle = computed(() => {
  void historyVersion.value
  // An agent's command moves the session's history without touching this
  // view's counter, so the label must follow the session too or it goes stale.
  void boardVersion.value
  const label = props.session.undoLabel()
  return label
    ? t('common.undoWithLabel', { label, shortcut: undoShortcut })
    : t('common.undo', { shortcut: undoShortcut })
})
const redoTitle = computed(() => {
  void historyVersion.value
  // An agent's command moves the session's history without touching this
  // view's counter, so the label must follow the session too or it goes stale.
  void boardVersion.value
  const label = props.session.redoLabel()
  return label
    ? t('common.redoWithLabel', { label, shortcut: redoShortcut })
    : t('common.redo', { shortcut: redoShortcut })
})

watch(
  () => props.filePath,
  () => {
    selectedItems.value = []
    // Every live gesture holds the old board's indices: none may land on the new one.
    routeQueue.value = []
    if (trackDrag.value) endTrackDrag()
    pairDraft.value = null // its layer to hand back is the old board's
    endPair()
    endTune()
    route.cancel(false)
    toolDraft.value = []
    activeTool.value = 'select'
    if (board.value) void adoptBoardLayers(props.filePath ?? '', board.value.layers)
    historyVersion.value++
  }
)

// ---------------------------------------------------------------------------
// Dragging (object move) coordination
// ---------------------------------------------------------------------------

const dragStartElements = ref<MoveElement[]>([])
const lastDragDelta = ref<{ x: number; y: number }>({ x: 0, y: 0 })

/**
 * A handle being dragged: which item and point, plus the shape as it stood at
 * drag start (domain nm). The scene draws a ghost during the drag — a full
 * rebuild per mousemove is what large boards can't afford — and the real shape
 * lands once, on drop.
 */
interface VertexDragState {
  type: VertexItemType
  index: number
  vertexIndex: number
  shape: VertexShape
  layer: string
}
const vertexDrag = ref<VertexDragState | null>(null)

/** The dragged shape with the live delta applied. */
const vertexDragShape = (drag: VertexDragState): VertexShape =>
  moveShapeVertex(
    drag.shape,
    drag.vertexIndex,
    nm(lastDragDelta.value.x),
    nm(lastDragDelta.value.y)
  )

/** The layer a reshaped item's ghost is drawn on. */
const vertexItemLayer = (b: KicadBoard, type: VertexItemType, index: number): string => {
  switch (type) {
    case 'gr_line':
      return b.grLines[index]?.layer ?? 'Edge.Cuts'
    case 'gr_arc':
      return b.grArcs[index]?.layer ?? 'Edge.Cuts'
    case 'gr_circle':
      return b.grCircles[index]?.layer ?? 'Edge.Cuts'
    case 'gr_rect':
      return b.grRects[index]?.layer ?? 'Edge.Cuts'
    case 'gr_poly':
      return b.grPolys[index]?.layer ?? 'Edge.Cuts'
    case 'zone':
      return b.zones[index]?.layers[0] ?? 'F.Cu'
    case 'tuning_pattern':
      return b.tuningPatterns[index]?.layer ?? 'F.Cu'
  }
}

const handleDragStart = (type: 'object' | 'vertex', info?: Record<string, unknown>): void => {
  if (!board.value) return

  if (type === 'vertex') {
    const parentType = String(info?.parentType)
    const index = info?.parentIndex as number
    const shape = isVertexItemType(parentType)
      ? boardVertexShape(board.value, parentType, index)
      : null
    if (!shape || !isVertexItemType(parentType) || props.isReadOnly) return
    lastDragDelta.value = { x: 0, y: 0 }
    vertexDrag.value = {
      type: parentType,
      index,
      vertexIndex: info?.vertexIndex as number,
      shape,
      layer: vertexItemLayer(board.value, parentType, index)
    }
    return
  }
  vertexDrag.value = null

  // A press-drag on a lone track segment or via is KiCad's default drag: pull
  // the copper through the router (release commits) instead of translating it
  // away from what it connects. A press on one of several selected track
  // segments, and nothing else selected, drags them together as `D` does
  // (D14). Every other selection keeps the rigid move below. No update is
  // proposed until the cursor actually moves, so a plain click stays a click.
  if ((info?.type === 'segment' || info?.type === 'via') && !props.isReadOnly) {
    const sel = selectedItems.value
    const cursor = viewportRef.value?.getCursor()
    const pressed = sel.some((r) => r.type === info.type && r.index === info.index)
    let opened = false
    if (cursor && pressed && sel.length === 1) {
      const seed = spatialIndex.value?.items.find(
        (it) => it.ref.type === sel[0].type && it.ref.index === sel[0].index
      )
      opened = !!seed && openTrackDrag(seed, cursor)
    } else if (cursor && pressed && sel.every((r) => r.type === 'segment')) {
      opened = openMultiTrackDrag(sel, cursor)
    }
    if (opened) {
      mouseTrackDrag.value = true
      mouseTrackDragMoved.value = false
      return
    }
  }

  dragStartElements.value = snapshotDragElements()

  viewportRef.value?.saveDragOrigins(actedSelection.value)
}

/**
 * Where the acted selection stands on the board now: what a drop moves by
 * the drag's delta. Taken at drag start, and again after a turn or flip
 * mid-drag changes it.
 */
const snapshotDragElements = (): MoveElement[] =>
  snapshotMoveElements(board.value!, actedSelection.value)

const handleDragMove = (delta: { x: number; y: number }): void => {
  if (!board.value) return
  // The mouse track drag is driven by `track-drag-move` (the cursor, not a
  // delta); the engine's parallel drag stream must not also rigid-translate.
  if (mouseTrackDrag.value) return
  // delta is scene mm (y up); the KiCad data model is integer nm, y down
  lastDragDelta.value = { x: mmToNm(delta.x), y: mmToNm(-delta.y) }
  sceneDragDelta.value = delta
  const drag = vertexDrag.value
  if (drag) {
    const shape = vertexDragShape(drag)
    viewportRef.value?.showShapeGhost(vertexShapeGhost(shape), drag.layer)
    // A pattern's handle re-tunes it as it moves, as KiCad's does (T4).
    if (drag.type === 'tuning_pattern' && shape.kind === 'tuning')
      previewPatternHandles(drag.index, shape, drag.vertexIndex)
    return
  }
  viewportRef.value?.translateElements(actedSelection.value, delta)
}

/** The selection and the item under the cursor, for KiCad's hover selection (`lib/hoverSelection.ts`). */
const boardHover: HoverSelection<BoardItemRef> = {
  selected: selectedItems,
  hover: () => viewportRef.value?.itemAtCursor() ?? null,
  same: sameRef
}

/** KiCad's Move (M), held: Escape puts what it moved back, nothing committed. */
const move = heldMove(boardHover, {
  begin: () => viewportRef.value?.startHeldMove() ?? false,
  history: props.session,
  abandon: () => {
    viewportRef.value?.cancelHeldMove()
    viewportRef.value?.translateElements(actedSelection.value, { x: 0, y: 0 })
    viewportRef.value?.clearDragOrigins()
    sceneDragDelta.value = null
    dragStartElements.value = []
    lastDragDelta.value = { x: 0, y: 0 }
  }
})

const handleDragEnd = (): void => {
  finishDrag()
  move.end()
}

const finishDrag = (): void => {
  sceneDragDelta.value = null
  if (mouseTrackDrag.value) {
    mouseTrackDrag.value = false
    finishMouseTrackDrag()
    return
  }
  if (!board.value) return

  const drag = vertexDrag.value
  if (drag) {
    viewportRef.value?.showShapeGhost(null, drag.layer)
    if (drag.type === 'tuning_pattern') {
      const shape = vertexDragShape(drag)
      const moved = lastDragDelta.value.x !== 0 || lastDragDelta.value.y !== 0
      tuneGlance.value = null
      if (moved && shape.kind === 'tuning')
        commitPatternHandles(drag.index, shape, drag.vertexIndex)
      else trackDragPreview.value = null
    } else if (lastDragDelta.value.x !== 0 || lastDragDelta.value.y !== 0) {
      const shape = normalizedShape(vertexDragShape(drag))
      const label =
        drag.type === 'zone' ? t('pcbEditor.commands.editZone') : t('pcbEditor.commands.editShape')
      runCommand(label, () => writeVertexShape(board.value!, drag.type, drag.index, shape))
    }
    vertexDrag.value = null
    lastDragDelta.value = { x: 0, y: 0 }
    return
  }

  const count = dragStartElements.value.length
  const label = t('commandLabels.move', count)
  const fdx = lastDragDelta.value.x
  const fdy = lastDragDelta.value.y

  // A selection click enters the engine's drag path on mouse-down, but no
  // document command occurred unless the snapped delta actually moved. Apart
  // from polluting Undo, writing the same coordinates needlessly rebuilds the
  // assembly overlay and used to make a selected model flash.
  if (fdx === 0 && fdy === 0) {
    viewportRef.value?.clearDragOrigins()
    dragStartElements.value = []
    lastDragDelta.value = { x: 0, y: 0 }
    return
  }

  runCommand(label, () => moveElements(board.value!, dragStartElements.value, fdx, fdy))

  if (props.isReadOnly) {
    viewportRef.value?.rebuildAndRender()
  }

  viewportRef.value?.clearDragOrigins()
  dragStartElements.value = []
  lastDragDelta.value = { x: 0, y: 0 }
}

// ---------------------------------------------------------------------------
// Interactive tools: track routing and via placement
// ---------------------------------------------------------------------------

const setTool = (tool: PcbTool): void => {
  // Place Footprint arms only with a footprint in hand: the chooser comes first.
  if (tool === 'footprint' && !footprintPlacement.value) {
    openPlaceFootprint()
    return
  }
  leavePairAndTune()
  if (activeTool.value === tool) return
  // Leaving the route keeps what was clicked, as Esc does (R33), and ends a Route Selected run.
  routeQueue.value = []
  commitRoute()
  route.setStartVia(false)
  toolDraft.value = []
  activeTool.value = tool
}

// --- Place Footprint (lib/board/footprintPlace.ts) -----------------------------
// The chooser picks, the tool holds the footprint with its ghost on the cursor,
// each click lands one, and it stays armed for the next, as the schematic's
// symbol placement does.

const footprintChooserOpen = ref(false)
const footprintPlacement = shallowRef<{
  libId: string
  library: KicadFootprint
  angle: number
  /** On the back: F flips the footprint in hand as it flips a placed one. */
  flipped: boolean
} | null>(null)

/** The board's layer pairs for a footprint in hand on the back, else none. */
const placementFlipLayer = (
  flipped: boolean,
  b: KicadBoard
): ((layer: string) => string) | undefined => (flipped ? boardLayerFlipper(b.layers) : undefined)

/** The footprint the next click lands, as it will land: the viewport draws it as if selected. */
const placementGhost = computed(() => {
  const placement = footprintPlacement.value
  const b = board.value
  if (!placement || !b) return null
  return placementFootprint(placement.library, {
    libId: placement.libId,
    angle: placement.angle,
    flipLayer: placementFlipLayer(placement.flipped, b),
    reference: placedReference(
      placement.libId,
      placement.library,
      b.footprints.map((footprint) => footprint.reference ?? '')
    )
  })
})

const openPlaceFootprint = (): void => {
  if (props.isReadOnly) return
  footprintChooserOpen.value = true
}

/** A chooser pane's Open: the chooser goes, and the part opens read-only in its own tab. */
const openFromChooser = (record: IndexRecord): void => {
  footprintChooserOpen.value = false
  const target = openTargetFor(record)
  if (target.kind === 'library-symbol') emit('open-library-symbol', target.file, target.name)
  else emit('open-file', target.node)
}

const armFootprint = async (libId: string): Promise<void> => {
  footprintChooserOpen.value = false
  const library = await loadLibraryFootprint(libId)
  if (!library) return
  footprintPlacement.value = { libId, library, angle: 0, flipped: false }
  setTool('footprint')
}

watch(activeTool, (tool) => {
  if (tool !== 'footprint') footprintPlacement.value = null
})

/** Whether a footprint is in hand: turn and flip act on it before the selection. */
const heldFootprint = computed(() => activeTool.value === 'footprint' && !!footprintPlacement.value)

/** R and Shift+R, and the rotate chips: the footprint in hand, else the selection. */
const turnHeldOrSelected = (by: number): void => {
  const placement = footprintPlacement.value
  if (!heldFootprint.value || !placement) return rotateSelected(by)
  footprintPlacement.value = { ...placement, angle: (((placement.angle + by) % 360) + 360) % 360 }
}

/** F, and the flip chip: the footprint in hand, else the selection. */
const flipHeldOrSelected = (): void => {
  const placement = footprintPlacement.value
  if (!heldFootprint.value || !placement) return flipSelected()
  footprintPlacement.value = {
    ...placement,
    angle: flippedPlacementAngle(placement.angle),
    flipped: !placement.flipped
  }
}

const placeFootprintAt = (at: { x: Nm; y: Nm }): void => {
  const placement = footprintPlacement.value
  const b = board.value
  if (!placement || !b || props.isReadOnly) return
  const reference = placedReference(
    placement.libId,
    placement.library,
    b.footprints.map((footprint) => footprint.reference ?? '')
  )
  const node = placeFootprintNode(placement.library, {
    libId: placement.libId,
    at,
    angle: placement.angle,
    flipLayer: placementFlipLayer(placement.flipped, b),
    reference
  })
  runCommand(t('pcbEditor.commands.placeFootprint', { reference }), () => {
    selectedItems.value = insertIntoBoard(b, [node], { x: 0, y: 0 })
  })
}

/** The reference a highlighted footprint would land with (`H1`), for the chooser's previews. */
const placedFields = (library: KicadFootprint, libId: string): { reference: string } => ({
  reference: placedReference(
    libId,
    library,
    (board.value?.footprints ?? []).map((footprint) => footprint.reference ?? '')
  )
})

// ---- A placed footprint's library link (docs/libraries-workstream.md §5) ----

/** Library footprints read for the selection and the update sheet: null when no library holds one. */
const footprintLibraries = shallowRef(new Map<string, KicadFootprint | null>())
const librariesReading = new Set<string>()

const ensureFootprintLibraries = async (libIds: Iterable<string>): Promise<void> => {
  const wanted = [...new Set(libIds)].filter(
    (libId) => libId && !footprintLibraries.value.has(libId) && !librariesReading.has(libId)
  )
  if (!wanted.length) return
  for (const libId of wanted) librariesReading.add(libId)
  const read = await Promise.all(
    wanted.map(async (libId) => [libId, await loadLibraryFootprint(libId)] as const)
  )
  for (const libId of wanted) librariesReading.delete(libId)
  footprintLibraries.value = new Map([...footprintLibraries.value, ...read])
}

/** Read again on the next look: a library file may have changed under the board. */
const forgetFootprintLibraries = (): void => {
  footprintLibraries.value = new Map()
}

const selectedFootprints = computed((): KicadBoardFootprint[] => {
  const b = board.value
  if (!b) return []
  return selectedItems.value
    .filter((item) => item.type === 'footprint')
    .map((item) => b.footprints[item.index])
    .filter((fp): fp is KicadBoardFootprint => !!fp)
})

watch(selectedFootprints, (fps) => {
  if (fps.length) void ensureFootprintLibraries(fps.map((fp) => fp.libId))
})

/** How a footprint stands against its library copy, as DRC's library parity reads it. */
const librarySync = (fp: KicadBoardFootprint): LibrarySync => {
  const libraries = footprintLibraries.value
  if (!libraries.has(fp.libId)) return { state: 'checking' }
  const library = libraries.get(fp.libId)
  const b = board.value
  if (!library || !b) return { state: 'missing' }
  return libraryDifference(b, fp, library) ? { state: 'differs' } : { state: 'match' }
}

const footprintDialog = ref<{ mode: PartUpdateMode; libId: string } | null>(null)
/** The chooser over the dialog, for the footprint a change swaps to. */
const changeChooserOpen = ref(false)

const footprintLibraryStatus = computed(() =>
  librarySyncStatus(t, selectedFootprints.value.map(librarySync))
)

/** The library part the selection shares, as the chooser names it (read with the status, as the index loads). */
const footprintLibraryPart = computed(() => {
  void footprintLibraries.value
  return libraryPartOf(selectionLibId.value, findFootprint(selectionLibId.value))
})

/**
 * Edit footprint…: the board's own copy of the lone footprint, in a footprint
 * editor tab that belongs to the board (`lib/designCopy.ts`). The library is
 * not touched.
 */
const editDesignFootprint = (): void => {
  const lone = selectedFootprints.value.length === 1 ? selectedFootprints.value[0] : null
  const uuid = lone ? footprintUuid(lone) : ''
  if (!lone || !uuid || !props.filePath) return
  emit('open-file', {
    name: `${lone.reference || lone.libId.slice(lone.libId.indexOf(':') + 1)}.kicad_mod`,
    path: designCopyPath('footprint', props.filePath, uuid)
  })
}

const footprintUuid = (fp: KicadBoardFootprint): string => {
  const uuid = findChild(fp._raw as SExprList, 'uuid')
  return uuid ? (getAtomValues(uuid)[0] ?? '') : ''
}

/** Edit library footprint: the lone footprint's library file, read-only in the footprint editor. */
const openLibraryFootprint = (): void => {
  const lone = selectedFootprints.value.length === 1 ? selectedFootprints.value[0] : null
  const record = lone ? findFootprint(lone.libId) : undefined
  if (record) emit('open-file', { name: record.name, path: readonlyLibTabPath(record.file) })
}

/** Update footprints from library: the tool search, the canvas menu and the library section's Update. */
const openFootprintUpdate = (): void => {
  if (props.isReadOnly || !board.value) return
  forgetFootprintLibraries()
  footprintDialog.value = { mode: 'update', libId: selectionLibId.value }
}

/** Change footprint: the dialog first, its footprint chosen there. */
const openFootprintChange = (): void => {
  if (props.isReadOnly || !board.value) return
  forgetFootprintLibraries()
  footprintDialog.value = { mode: 'change', libId: selectionLibId.value }
}

/** The dialog's Browse: the chooser over it. */
const browseChangeFootprint = (): void => {
  void loadLibraryIndex().catch(() => {})
  changeChooserOpen.value = true
}

const onChangeFootprintPick = (libId: string): void => {
  changeChooserOpen.value = false
  if (footprintDialog.value) footprintDialog.value = { ...footprintDialog.value, libId }
  void ensureFootprintLibraries([libId])
}

const changeChooserTarget = computed(() => {
  const fps = selectedFootprints.value
  return fps.length === 1
    ? `${fps[0].reference ?? ''} · ${fps[0].libId}`
    : t('schematicEditor.footprintChooser.parts', { n: fps.length })
})

/** The lib id the selection shares: the dialog's starting footprint. */
const selectionLibId = computed(() => {
  const ids = new Set(selectedFootprints.value.map((fp) => fp.libId))
  return ids.size === 1 ? [...ids][0] : ''
})

/** The footprints a request's scope picks. */
const footprintUpdateTargets = (request: PartUpdateRequest): KicadBoardFootprint[] => {
  const b = board.value
  if (!b) return []
  const selected = new Set(selectedFootprints.value)
  return b.footprints.filter((fp) =>
    inScope(
      request,
      { reference: fp.reference ?? '', value: fp.value ?? '', libId: fp.libId },
      selected.has(fp)
    )
  )
}

const padList = (pads: Array<{ number: string; net: string }>): string =>
  pads.map((pad) => (pad.net ? `${pad.number} (${pad.net})` : pad.number)).join(', ')

/** Each target's outcome, from the same swap the run writes, on copies. */
const footprintUpdateRows = (request: PartUpdateRequest): PartUpdateRow[] => {
  const b = board.value
  if (!b) return []
  const targets = footprintUpdateTargets(request)
  const libIdOf = (fp: KicadBoardFootprint): string => request.libId || fp.libId
  void ensureFootprintLibraries(targets.map(libIdOf))
  const options = request.options as unknown as ExchangeOptions
  return targets
    .map((fp): PartUpdateRow => {
      const to = libIdOf(fp)
      const base = { reference: fp.reference ?? '', from: fp.libId, to }
      if (!footprintLibraries.value.has(to)) return { ...base, loading: true }
      const library = footprintLibraries.value.get(to)
      if (!library) return { ...base, notFound: true }
      const { report } = exchangedFootprintNode(b, fp, library, to, options)
      return {
        ...base,
        matches: !libraryDifference(b, fp, library),
        notes: [
          ...(to !== fp.libId && isSymbolOwned(fp)
            ? [t('pcbEditor.footprintUpdate.owned', { footprint: fp.libId })]
            : []),
          ...(report.addedPads.length
            ? [t('pcbEditor.footprintUpdate.addedPads', { pads: padList(report.addedPads) })]
            : [])
        ],
        warnings: report.droppedPads.length
          ? [t('pcbEditor.footprintUpdate.droppedPads', { pads: padList(report.droppedPads) })]
          : []
      }
    })
    .sort((a, b) => compareReferencesNatural(a.reference, b.reference))
}

const footprintUpdateOptions = computed(() =>
  EXCHANGE_OPTION_KEYS.map((key) => ({
    key,
    label: t(`pcbEditor.footprintUpdate.options.${key}`)
  }))
)

const footprintUpdateDefaults: Record<PartUpdateMode, Record<string, boolean>> = {
  update: { ...FOOTPRINT_UPDATE_DEFAULTS },
  change: { ...FOOTPRINT_CHANGE_DEFAULTS }
}

/** The lone selected footprint's reference, value and lib id: where the matching scopes start. */
const footprintUpdateSeeds = computed(() => {
  const lone = selectedFootprints.value.length === 1 ? selectedFootprints.value[0] : null
  return {
    reference: lone?.reference ?? '',
    value: lone?.value ?? '',
    libId: selectionLibId.value
  }
})

const confirmFootprintUpdate = (request: PartUpdateRequest): void => {
  const b = board.value
  footprintDialog.value = null
  if (!b || props.isReadOnly) return
  const targets: ExchangeTarget[] = footprintUpdateTargets(request).flatMap((footprint) => {
    const libId = request.libId || footprint.libId
    const library = footprintLibraries.value.get(libId)
    return library ? [{ footprint, library, libId }] : []
  })
  if (!targets.length) return
  // The board only, as KiCad's Change Footprints: a symbol-owned part's
  // Footprint field keeps naming the old one until the schematic changes it.
  const label =
    request.mode === 'change'
      ? t('pcbEditor.commands.changeFootprints', targets.length)
      : t('pcbEditor.commands.updateFootprints', targets.length)
  runCommand(label, () => {
    exchangeFootprints(b, targets, request.options as unknown as ExchangeOptions)
  })
}

/** Footprints the board already carries, for the chooser's first section. */
const boardFootprintIds = computed(() => [
  ...new Set((board.value?.footprints ?? []).map((footprint) => footprint.libId).filter(Boolean))
])

/** Net of the copper touching a scene point (pad-precise, via the index). */
/**
 * Whether copper on these layers is interactable under the current display:
 * the same rule the pointer and the route magnet follow (scene-side
 * isLayerSelectable) — a hidden layer never, a dimmed-away inactive layer
 * only when it IS the active layer. Owned here because netAtPoint consults
 * the raw spatial index, which knows nothing about display state.
 */
const layersInteractable = (layers: readonly string[]): boolean =>
  layers.some((l) => {
    if (!(layerVisibility.value[l] ?? true)) return false
    if (nonActiveDisplay.value === 'show') return true
    return l === activeLayer.value
  })

/** The net Highlight Net picks at a scene point (`lib/board/highlightNet.ts`); 0 for none. */
const highlightNetAt = (scenePt: { x: number; y: number }, reach: number): number =>
  pickHighlightNet({
    copper: (spatialIndex.value?.near(scenePt.x, scenePt.y, reach, {}) ?? []).map((hit) => ({
      net: hit.item.net,
      layers: hit.item.layers,
      dist: hit.dist
    })),
    zones: board.value?.zones ?? [],
    at: { x: mmToNm(scenePt.x), y: mmToNm(-scenePt.y) },
    activeLayer: activeLayer.value,
    interactable: layersInteractable
  })

/** Light a net, or none (0), and tell a schematic beside this board. */
const setHighlightedNet = (net: number): void => {
  if (net === highlightedNet.value) return
  highlightedNet.value = net
  const b = board.value
  emitNetProbe('board', b && net ? getNetName(b, net) : '', groupId)
}

const highlightNetAtPointer = (): void => {
  const pointer = viewportRef.value?.getPointer()
  if (!pointer) return
  const net = highlightNetAt(pointer, pointer.reach)
  setHighlightedNet(net === highlightedNet.value ? 0 : net)
}

const netAtPoint = (scenePt: { x: number; y: number }): number => {
  const hits = spatialIndex.value?.near(scenePt.x, scenePt.y, 0.05, {}) ?? []
  const hit = hits.find((h) => h.dist === 0 && layersInteractable(h.item.layers))
  return hit ? hit.item.net : 0
}

// --- The pending trace: the route controller's, adapted ---------------------

/**
 * Route Selected (R44): the pads and vias still to route from, in turn, each
 * from itself or — from the other end — from the nearest copper its net has
 * not yet joined. A route that arrives starts the next; Esc ends the run.
 */
interface QueuedRoute {
  ref: CopperRef
  fromEnd: boolean
}
const routeQueue = ref<QueuedRoute[]>([])

/** The selection's pads and vias — a footprint's pads among them — to route from (R44). */
const routeStartsInSelection = (): CopperRef[] => {
  const idx = spatialIndex.value
  return idx ? selectedRouteRefs(idx, selectedItems.value) : []
}

const queueSelectedRoutes = (fromEnd: boolean): void => {
  if (props.isReadOnly || routeTail.value) return
  const starts = routeStartsInSelection()
  if (starts.length === 0) return
  routeQueue.value = starts.map((ref) => ({ ref, fromEnd }))
  setTool('route')
  startNextQueuedRoute()
}

/** Begin the next queued route whose net still wants it; none left ends the run. */
const startNextQueuedRoute = (): void => {
  const b = board.value
  const idx = spatialIndex.value
  if (!b || !idx) {
    routeQueue.value = []
    return
  }
  while (routeQueue.value.length > 0) {
    const [next, ...rest] = routeQueue.value
    routeQueue.value = rest
    const start = selectedRouteStart(b, idx, next.ref, next.fromEnd)
    if (!start) continue // gone, netless, or already joined to the rest of its net
    beginRoute(start.point, { net: start.net, layers: start.layers })
    return
  }
}

/**
 * A route that got where it was going, or was ended on its net's copper short
 * of it (R20), has landed: Route Selected goes on to the next (R44).
 */
const afterRoute = (outcome: RouteOutcome): void => {
  if ((outcome === 'arrived' || outcome === 'ended') && routeQueue.value.length > 0)
    startNextQueuedRoute()
}

/**
 * Route From Other End (`Ctrl+E`, R45): what is clicked lands, and a new
 * route starts at the nearest copper of the net it has not yet joined.
 */
const routeFromOtherEnd = (): void => {
  if (route.fromOtherEnd()) selectedItems.value = []
}

/**
 * Attempt Finish Selected (R46, KiCad's "Autoroute"): from each selected pad
 * or via in turn, along each ratsnest line that ends on it, a route started
 * and finished as `F` finishes one, toward the copper nearest the start; each
 * that arrives lands, each that does not is dropped
 * (`RouteController.finishFrom`, which `route.finish` drives too).
 */
const finishSelectedRoutes = (): void => {
  if (props.isReadOnly || routeTail.value) return
  const starts = routeStartsInSelection()
  if (starts.length === 0) return
  setTool('route')
  routeQueue.value = []
  for (const ref of starts) {
    if (!board.value || !spatialIndex.value) return
    for (const edge of selectedFinishEdges(board.value, spatialIndex.value, ref) ?? []) {
      const b = board.value
      const idx = spatialIndex.value
      if (!b || !idx) return
      selectedItems.value = []
      const { refused } = route.finishFrom(edge.start)
      if (refused) markRefusal(refused)
    }
  }
}

/** Land the pending trace as one undo entry; the tool stays armed. */
const commitRoute = (): void => {
  route.commit()
}

/**
 * `End` mid-route (KiCad's End Track): the head lands where the preview shows
 * it, as a click lays it, and the route ends there (R21).
 */
const endRouteHere = (): void => {
  route.endHere(viewportRef.value?.getRouteCursor() ?? null)
}

/** `F` (KiCad's Attempt Finish): the head walks to the net's nearest unjoined copper. */
const attemptAutoFinish = (): void =>
  afterRoute(route.attemptFinish({ cursor: viewportRef.value?.getRouteCursor() ?? null }))

/** Backspace mid-route: an armed via first, else the last click (§6.7b). */
const unrouteLast = (): void => {
  if (route.unrouteLast() === 'via') usedKey('pcb.unrouteLast')
}

/** Where the route in progress may connect to the rest of its net (F7, R35). */
const routeClusters = computed<RouteNetClusters>(() => route.clusters())
const routeAnchors = computed(() => routeClusters.value.others.flat())
/** Pads of the routed net not yet joined that the routed layer does not reach: near one, `V` is hinted (K1). */
const routeViaPads = computed(() => route.viaPads())
/** What the viewport needs to draw the routed net's ratsnest as the head moves (F7). */
const routeRatsnestClusters = computed(() => ({
  origin: routeClusters.value.origin.map((a) => a.point),
  others: routeClusters.value.others.map((c) => c.map((a) => a.point)),
  airwires: pcbView.value.ratsnest
}))

/** This board's copper in stack order (file order — v9+ ordinals lie). */
const copperLayerNames = computed(() =>
  (board.value?.layers ?? []).filter((l) => isCopperLayer(l.name)).map((l) => l.name)
)

/**
 * Start a trace at `start` — by click, by `X`, or Route Selected — from
 * nothing selected, as KiCad's router does, so the route never lands under a
 * selection left from before it. A via armed for the start that cannot
 * stand refuses it, its violations marked (R37).
 */
const beginRoute = (start: { x: number; y: number }, from: RouteStart): void => {
  selectedItems.value = []
  const { refused } = route.begin(start, from)
  if (refused) markRefusal(refused)
}

/** A click with the route tool: the controller folds it into the trace (R18–R20). */
const handleRouteClick = (info: ToolClick): void => {
  if (!routeTail.value) {
    beginRoute(info.snapped, {
      net: info.magnetNet,
      trackWidth: info.magnetTrackWidth,
      layers: info.magnetLayers,
      cursor: info.point
    })
    return
  }
  afterRoute(route.click(info))
}

/**
 * The string a fresh board text carries. Deliberately NOT localized: it is
 * document content written into the .kicad_pcb, not UI copy — the point of
 * placing it is to type over it in the properties panel.
 */
const DEFAULT_GR_TEXT = 'Text'

/** Insert the shape a finished graphics gesture describes, as one command. */
/** Re-brand a domain-valued tool point (the draft is integer nm throughout). */
const P = (p: Point2): { x: Nm; y: Nm } => ({ x: nm(p.x), y: nm(p.y) })

const commitGraphicShape = (shape: PcbToolShape): void => {
  const b = board.value
  if (!b) return
  const layer = activeLayer.value
  const defaults = graphicDefaults(layer)
  const width = defaults.lineWidth
  switch (shape.kind) {
    case 'lines':
      runCommand(t('pcbEditor.commands.addLine', shape.segments.length), () => {
        shape.segments.forEach((s) =>
          addGrLineToBoardAST(b, { start: P(s.start), end: P(s.end), width, layer })
        )
      })
      break
    case 'arc':
      runCommand(t('pcbEditor.commands.addArc'), () => {
        addGrArcToBoardAST(b, {
          start: P(shape.start),
          mid: P(shape.mid),
          end: P(shape.end),
          width,
          layer
        })
      })
      break
    case 'rect':
      runCommand(t('pcbEditor.commands.addRectangle'), () => {
        addGrRectToBoardAST(b, { start: P(shape.start), end: P(shape.end), width, layer })
      })
      break
    case 'circle':
      runCommand(t('pcbEditor.commands.addCircle'), () => {
        addGrCircleToBoardAST(b, { center: P(shape.center), end: P(shape.end), width, layer })
      })
      break
    case 'poly':
      runCommand(t('pcbEditor.commands.addPolygon'), () => {
        addGrPolyToBoardAST(b, { points: shape.points.map(P), width, layer })
      })
      break
    case 'bezier':
      runCommand(t('pcbEditor.commands.addBezier'), () => {
        addGrCurveToBoardAST(b, { points: shape.points.map(P), width, layer })
      })
      break
    case 'point':
      // KiCad places points one after another, so the tool stays armed.
      runCommand(t('pcbEditor.commands.addPoint'), () => {
        addPointToBoardAST(b, { position: P(shape.position), size: DEFAULT_POINT_SIZE, layer })
      })
      break
    case 'textBox': {
      let index = -1
      runCommand(
        t('pcbEditor.commands.addTextBox'),
        () => {
          index = addGrTextBoxToBoardAST(b, {
            text: DEFAULT_GR_TEXT,
            start: P(shape.start),
            end: P(shape.end),
            layer,
            size: defaults.textSize,
            thickness: defaults.textThickness,
            width,
            mirror: layer.startsWith('B.')
          })
        },
        {
          afterApply: () => {
            if (index >= 0) selectedItems.value = [{ type: 'gr_text_box', index }]
          }
        }
      )
      break
    }
    case 'text': {
      let index = -1
      runCommand(
        t('pcbEditor.commands.addText'),
        () => {
          index = addGrTextToBoardAST(b, {
            text: DEFAULT_GR_TEXT,
            position: P(shape.position),
            layer,
            size: defaults.textSize,
            thickness: defaults.textThickness
          })
        },
        {
          // Select the fresh text so the properties panel is already the
          // "type the real string" surface when the click lands.
          afterApply: () => {
            if (index >= 0) selectedItems.value = [{ type: 'gr_text', index }]
          }
        }
      )
      break
    }
  }
}

/**
 * A closed zone outline lands as a copper zone on the routing layer, on the
 * highlighted net if one is lit (KiCad's `createNewZone`).
 */
const commitZone = (domainPts: Point2[]): void => {
  const b = board.value
  if (!b) return
  const shape = pcbToolShape('zone', domainPts)
  if (!shape || shape.kind !== 'poly') return
  const net = highlightedNet.value
  let index = -1
  runCommand(
    t('pcbEditor.commands.addZone'),
    () => {
      index = addZoneToBoardAST(b, {
        points: shape.points.map(P),
        layers: [routingLayer.value],
        net,
        netName: net ? getNetName(b, net) : ''
      })
    },
    {
      // Select the fresh zone: net/layer/keepout live in the properties
      // panel, so landing selected makes it the immediate next step.
      afterApply: () => {
        if (index >= 0) selectedItems.value = [{ type: 'zone', index }]
      }
    }
  )
}

/** Domain-space gesture points (nm, y down) → the shape to insert. */
const commitGraphicTool = (tool: PcbTool, domainPts: Point2[]): void => {
  if (tool === 'zone') {
    commitZone(domainPts)
    return
  }
  const shape = pcbToolShape(tool, domainPts)
  if (shape) commitGraphicShape(shape)
}

/**
 * A chain tool's next point under the line mode (lib/lineMode.ts) — the same
 * constraint the viewport's ghost applies to the live cursor.
 */
const lineModePoint = (point: { x: Nm; y: Nm }): { x: Nm; y: Nm } =>
  takesLineMode(activeTool.value)
    ? constrainChainPoint(lineMode.value, toolDraft.value, point)
    : point

const handleToolClick = (info: ToolClick): void => {
  if (!board.value || props.isReadOnly || routerMenuDismissing) return
  const scenePt = info.snapped
  // Scene mm (y up) → domain nm (y down), once, at the tool boundary.
  const domainPt = { x: mmToNm(scenePt.x), y: mmToNm(-scenePt.y) }

  if (isGestureTool(activeTool.value)) {
    const point = lineModePoint(domainPt)
    const { draft, commit } = pcbToolClick(activeTool.value, toolDraft.value, point)
    toolDraft.value = draft
    if (commit) commitGraphicTool(activeTool.value, commit)
    return
  }

  if (activeTool.value === 'footprint') {
    placeFootprintAt(domainPt)
    return
  }

  if (activeTool.value === 'gridOrigin' || activeTool.value === 'drillOrigin') {
    // A picker: one click places the origin, and the select tool is back.
    setOrigin(activeTool.value === 'gridOrigin' ? 'grid' : 'drill', domainPt)
    setTool('select')
  } else if (activeTool.value === 'route') {
    handleRouteClick(info)
  } else if (activeTool.value === 'via') {
    // A standalone via inherits the net under it, and the picked via or else
    // that net's rules' (router-behavior.md S1, S5).
    const net = info.magnetNet ?? netAtPoint(scenePt)
    const copper = copperLayerNames.value
    const via =
      (viaPicked.value ? routeViaSize.value : null) ??
      (sizeRules.value
        ? resolveVia(sizeRules.value, net, [copper[0] ?? 'F.Cu', copper.at(-1) ?? 'B.Cu'], {
            diameter: setupRules.value.minViaDiameter,
            drill: setupRules.value.minThroughHoleDiameter
          }).value
        : viaRule.value.value)
    runCommand(t('pcbEditor.commands.addVia'), () => {
      addViaToBoardAST(board.value!, {
        position: domainPt,
        size: mmToNm(via.diameter),
        drill: mmToNm(via.drill),
        layers: ['F.Cu', 'B.Cu'],
        net
      })
    })
  }
}

/**
 * The same reading `X` has (routing workstream §7c): a hotkey acts at the
 * cursor, so a tool drawn from a first point takes it from where the pointer
 * is. Off the canvas the tool only arms — `getCursor` is null there, so no
 * stale point is ever used.
 */
const startGestureAtCursor = (): void => {
  const cursor = viewportRef.value?.getCursor()
  if (cursor) handleToolClick({ point: cursor, snapped: cursor, hit: null })
}

const handleToolFinish = (): void => {
  if (isGestureTool(activeTool.value)) {
    const { commit } = pcbToolFinish(activeTool.value, toolDraft.value)
    if (commit) commitGraphicTool(activeTool.value, commit)
    // A span mid-draft (nothing to finish) cancels rather than lingering:
    // right-click is "I'm done here" in both readings.
    toolDraft.value = []
    return
  }
  // A double-click lays the head and ends the route there, as `End` does (R21).
  if (activeTool.value === 'route' && routeTail.value) endRouteHere()
}

// ---------------------------------------------------------------------------
// Zone refill (P0.6): debounced auto-refill after edits, manual `B` always.
// The board worker computes the fills, which land as one undoable command.
// How the auto-refill runs is the board's own setting (`boardAutomation.ts`):
// the zones an edit reached (greedy), every zone (full), or none (off).
// ---------------------------------------------------------------------------

const automation = boardAutomationFor(() => props.filePath ?? '')
const setAutomation = (patch: Partial<BoardAutomation>): void =>
  setBoardAutomation(props.filePath ?? '', patch)
const REFILL_DEBOUNCE_MS = 400

/** Whether a refill would run: auto-refill on, the file writable, a zone to fill. */
const refillable = (): boolean =>
  automation.value.zoneFill !== 'off' &&
  !props.isReadOnly &&
  !!board.value?.zones.some((z) => !z.isKeepout && z.points.length >= 3)

const scheduleRefill = (): void => {
  if (!refillable()) return
  if (refillTimer !== null) window.clearTimeout(refillTimer)
  refillTimer = window.setTimeout(() => {
    refillTimer = null
    void runRefill('edit')
  }, REFILL_DEBOUNCE_MS)
  syncRefillBusy()
}

/**
 * Undo/redo restore the fills their snapshot carried and deliberately don't
 * refill — so they must also disarm any refill an earlier edit scheduled.
 * One that fired after the undo would run against the restored board and
 * push a group-with-previous entry onto a command it never belonged to.
 */
const cancelScheduledRefill = (): void => {
  if (refillTimer !== null) {
    window.clearTimeout(refillTimer)
    refillTimer = null
  }
  refillToken++
  syncRefillBusy()
}

/** A refill scheduled or running: the design checks wait for it (they read the fills). */
const refillBusy = ref(false)
/** How far the running refill has got, 0–1; null when none runs. */
const refillProgress = ref<number | null>(null)
/** A refill ran since the findings were last the board's: the pill's progress counts it. */
const refilledSinceCheck = ref(false)
/** How long the last refill and check took, ms: how the pill splits its progress between them. */
const followUpMs = { refill: null as number | null, check: null as number | null }
let refillsInFlight = 0
const syncRefillBusy = (): void => {
  refillBusy.value = refillTimer !== null || refillsInFlight > 0
}
/**
 * Every refill fills every zone. An edit's (`edit`) joins the edit's undo
 * entry; a load's or a manual one (`own`) is an entry of its own.
 */
type RefillKind = 'edit' | 'own'
const runRefill = async (requested: RefillKind): Promise<void> => {
  const kind = refillAllOwed ? 'own' : requested
  refillsInFlight++
  syncRefillBusy()
  try {
    await refillZones(kind)
  } finally {
    refillsInFlight--
    syncRefillBusy()
  }
}

/** A refill that came due mid-route, held until the route ends (R34). */
let refillHeld: RefillKind | null = null
const holdRefill = (kind: RefillKind): void => {
  refillHeld = kind === 'own' || refillHeld === 'own' ? 'own' : 'edit'
}
watch(routeTail, (tail) => {
  if (tail || !refillHeld) return
  const kind = refillHeld
  refillHeld = null
  if (kind === 'own') refillNow()
  else scheduleRefill()
})

const refillZones = async (kind: RefillKind): Promise<void> => {
  const token = ++refillToken
  if (refillRunning || props.isReadOnly) return
  if (routeTail.value) return holdRefill(kind)
  const b = board.value
  const worker = props.session.worker()
  if (!b || !worker) return

  refillRunning = true
  try {
    // The board worker fills every zone, keeping each pour from each item as
    // far as DRC holds it to.
    refilledSinceCheck.value = true
    const started = performance.now()
    const result = await worker
      .refill({
        settings: checkSettings.value,
        progress: (done) => {
          if (token === refillToken) refillProgress.value = done
        }
      })
      .finally(() => (refillProgress.value = null))
    if (result) followUpMs.refill = performance.now() - started
    if (!result) {
      // An edit landed mid-compute and scheduled its own run, which this one
      // held off: let it run now.
      if (token !== refillToken || board.value !== b) scheduleRefill()
      return
    }
    if (board.value !== b) {
      // The board moved on under a load's whole refill: it is still owed.
      if (refillAllOwed) scheduleRefill()
      return
    }
    // A route begun while this computed: its fills land once it ends (R34).
    if (routeTail.value) return holdRefill(kind)
    refillAllOwed = false
    if (result.fills.length > 0) {
      const zones = new Map(b.zones.map((zone) => [zoneKey(zone), zone]))
      refillCommitting = true
      try {
        runCommand(
          t('pcbEditor.commands.refillZones'),
          () => {
            for (const { zone, polys } of result.fills) {
              const target = zones.get(zone)
              if (target) setZoneFilledPolysInAST(target, polys.map(unpackFillPoly))
            }
          },
          {
            // Auto refill is derived fallout from the preceding edit, not a
            // second gesture. Manual B remains its own undoable command.
            groupWithPrevious: kind === 'edit',
            zones: () => ({ filled: result.fills.map(({ zone }) => zone) }),
            refill: true
          }
        )
      } finally {
        refillCommitting = false
      }
    }
  } finally {
    refillRunning = false
  }
}

/** Manual refill — the `B` hotkey and the toolbar button. */
const refillNow = (): void => {
  if (refillTimer !== null) {
    window.clearTimeout(refillTimer)
    refillTimer = null
  }
  // Every teardrop first, as KiCad's Fill All Zones rebuilds them.
  props.session.rebuildTeardrops(t('pcbEditor.commands.rebuildTeardrops'))
  void runRefill('own')
}

// ---------------------------------------------------------------------------
// Editing operations
// ---------------------------------------------------------------------------

const deleteSelected = (): void => {
  // A pad is part of its footprint: Delete passes over it, as KiCad's does
  // with free pads off — delete the footprint, or the pad in the footprint editor.
  const doomed = selectedItems.value.filter((item) => item.type !== 'pad')
  const b = board.value
  if (!b || doomed.length === 0) return
  const patterns = doomed.flatMap((item) =>
    item.type === 'tuning_pattern' ? (b.tuningPatterns[item.index] ?? []) : []
  )
  // Tuning patterns alone give back the straight track they replaced; with
  // anything else they go with their tracks, as KiCad deletes them (T4).
  if (patterns.length === doomed.length) {
    runCommand(t('pcbEditor.commands.removeTuningPattern', patterns.length), () => {
      for (const pattern of patterns) restorePatternInAST(b, pattern)
      selectedItems.value = []
    })
    return
  }
  const count = doomed.length
  const label = t('commandLabels.delete', count)

  runCommand(label, () => {
    for (const pattern of patterns) deletePatternInAST(b, pattern)
    doomed.forEach((item) => {
      if (item.type === 'tuning_pattern') return
      // A footprint keeps its fields: Delete hides one, as KiCad's does, and
      // removes a text of its own (a v6 file's reference and value hide too).
      const owned = footprintTextOf(b, item)
      if (owned) {
        markNodeDirty(owned.footprint.footprint._raw)
        if (owned.kind === 'field') updatePropertyInAST(owned.item, { hide: true })
        else if (owned.item.type !== 'user') updateTextInAST(owned.item, { hide: true })
        else {
          const root = owned.footprint.footprint._raw as SExprList
          root.children = root.children.filter((c) => c !== owned.item._raw)
        }
        return
      }
      const raw = rawForItem(item)
      if (raw) removeBoardNodeFromAST(board.value!, raw)
    })
    selectedItems.value = []
  })
}

/**
 * `degrees` counterclockwise, as KiCad's board angles run: footprints, tracks,
 * vias, zones and graphics turn as one, about one item's own position or
 * several's grid-snapped middle (`lib/board/boardItemTransform.ts`).
 */
const rotateSelected = (degrees: number): void => {
  const b = board.value
  if (!b) return
  const units = rotateUnits(actedSelection.value)
  // A footprint's own field or text turns about itself; its angle is absolute.
  const texts = actedSelection.value.flatMap((ref) => footprintTextOf(b, ref) ?? [])
  // Mid-move a turn is about the grab anchor under the cursor, as KiCad's.
  const center =
    viewportRef.value?.dragAnchorStart() ?? transformCenter(b, units, 'rotate', gridNm())
  if ((units.length === 0 || !center) && texts.length === 0) return
  const label = units.every((i) => i.type === 'footprint')
    ? units.length
      ? t('pcbEditor.commands.rotateFootprints', units.length)
      : t('commandLabels.rotate', texts.length)
    : t('pcbEditor.commands.rotateItems', units.length)

  runCommand(label, () => rotateBoardItems(b, actedSelection.value, center, degrees))
  refreshDragAfterEdit()
}

/**
 * KiCad's Flip (F): the selected footprints change side, mirrored left-right
 * about a lone footprint's anchor or the selection's center.
 */
const flipSelected = (): void => {
  const b = board.value
  if (!b || props.isReadOnly) return
  // One unit, as KiCad flips a selection: one item about itself, several about their middle.
  const { footprints: fps, others, units } = flipUnits(b, actedSelection.value)
  // Mid-move one item flips about the grab anchor under the cursor, as KiCad's.
  const anchor = units.length === 1 ? viewportRef.value?.dragAnchorStart() : null
  const center = anchor ?? transformCenter(b, units, 'flip', 0)
  if (!center) return
  const label =
    others.length === 0
      ? t('pcbEditor.commands.flipFootprints', fps.length)
      : t('pcbEditor.commands.flipItems', units.length)
  runCommand(label, () => flipBoardItems(b, fps, others, center))
  refreshDragAfterEdit()
}

/** A turn or flip mid-drag: the drop moves the parts from where the edit left them. */
const refreshDragAfterEdit = (): void => {
  if (dragStartElements.value.length > 0) dragStartElements.value = snapshotDragElements()
}

const flippableSelection = (b: KicadBoard): KicadBoardFootprint[] =>
  flipUnits(b, actedSelection.value).footprints

const canFlip = computed(
  () =>
    !props.isReadOnly &&
    !!board.value &&
    (heldFootprint.value ||
      flippableSelection(board.value).length > 0 ||
      selectedItems.value.some((r) => NODE_TRANSFORM_TYPES.has(r.type)))
)

/**
 * Fan out (Altium's Route ▸ Fanout, Allegro's Create Fanout; KiCad has
 * none): the one selected footprint's pads each get a via, by the pattern
 * the pads call for, sized and spaced by Board Setup's rules
 * (`lib/board/fanout.ts`, which `board.fanout` runs too). The overlay
 * (`pcb/FanoutWidget.vue`) holds the settings and shows the plan for them
 * live — the planner is pure — so what will be placed, and every pad that
 * cannot take a via, is read before anything is written.
 */
/** The one selected footprint, when it has something to fan out; Fanout is available only then. */
const fanoutTarget = computed((): number | null => {
  const b = board.value
  const only = selectedItems.value.length === 1 ? selectedItems.value[0] : null
  const bfp = b && only?.type === 'footprint' ? b.footprints[only.index] : undefined
  return bfp && fanoutEligible(bfp) ? only!.index : null
})
const canFanout = computed(() => !props.isReadOnly && fanoutTarget.value !== null)
const fanoutOpen = ref(false)
const fanoutSettings = ref<FanoutSettings>({ style: 'auto', direction: 'out', surfaceRows: 0 })
/** The plan last written, shown until the settings or the footprint change. */
const fanoutApplied = shallowRef<FanoutPlan | null>(null)
watch([fanoutTarget, fanoutSettings], () => (fanoutApplied.value = null))
// The overlay works on the selection: it follows it to another footprint, and
// closes when the selection is no longer one it can fan out.
watch(fanoutTarget, (target) => {
  if (target === null) fanoutOpen.value = false
})

const fanoutReference = computed(() => {
  const target = fanoutTarget.value
  return target === null ? null : (board.value?.footprints[target]?.reference ?? null)
})
const fanoutPreview = computed((): FanoutOutcome | null => {
  const b = board.value
  const target = fanoutTarget.value
  const index = spatialIndex.value
  if (!fanoutOpen.value || !b || target === null || !index) return null
  return planFanout(b, index, target, fanoutSettings.value, fanoutRulesOf(checkSettings.value, b))
})

const openFanout = (): void => {
  if (canFanout.value) fanoutOpen.value = true
}

const applyFanoutPreview = (): void => {
  const b = board.value
  const outcome = fanoutPreview.value
  if (!b || !outcome?.ok || !outcome.plan.escapes.length || props.isReadOnly) return
  const { plan } = outcome
  runCommand(t('pcbEditor.commands.fanout', { reference: plan.footprint }), () => {
    applyFanout(b, plan)
  })
  fanoutApplied.value = plan
}

/**
 * Place (or, with null, reset to 0,0) the board's grid origin or its drill /
 * place file origin — KiCad's Grid Origin and Drill/Place File Origin, written
 * to `(setup …)` as one undo step.
 */
const setOrigin = (which: BoardOrigin, at: { x: Nm; y: Nm } | null): void => {
  const b = board.value
  if (!b || props.isReadOnly) return
  const key =
    which === 'grid'
      ? at
        ? tk('pcbEditor.commands.placeGridOrigin')
        : tk('pcbEditor.commands.resetGridOrigin')
      : at
        ? tk('pcbEditor.commands.placeDrillOrigin')
        : tk('pcbEditor.commands.resetDrillOrigin')
  runCommand(t(key), () => setBoardOriginInAST(b, which, at))
}

/** A selection key the connection walk shares (`type:index`, selectConnection.ts). */
const refId = (ref: BoardItemRef): ConnId => `${ref.type}:${ref.index}`
const refOf = (id: ConnId): BoardItemRef => {
  const [type, index] = id.split(':')
  return { type, index: Number(index) }
}

/** The selection with `ids` added, each item once. */
const withSelected = (ids: Iterable<ConnId>): BoardItemRef[] => {
  const have = new Set(selectedItems.value.map(refId))
  const added = [...ids].filter((id) => !have.has(id) && have.add(id)).map(refOf)
  return [...selectedItems.value, ...added]
}

// The selection filter bounds what the selection verbs take (KiCad's
// itemPassesFilter), as it bounds a click.
const { allows: filterAllows } = useSelectionFilter('pcb')
const itemLocked = (ref: BoardItemRef): boolean => {
  const collection = collectionForType(ref.type) as Array<{ locked?: boolean }> | undefined
  if (ref.type === 'footprint') return board.value?.footprints[ref.index]?.footprint.locked ?? false
  return collection?.[ref.index]?.locked ?? false
}
/** Pads have no switch of their own on the board, so the walk passes them. */
const filterPasses = (id: ConnId): boolean => {
  if (id.startsWith('pad:')) return true
  const ref = refOf(id)
  const ruleArea = ref.type === 'zone' && !!board.value?.zones[ref.index]?.isKeepout
  return filterAllows.value({ kind: boardItemKind(ref.type, ruleArea), locked: itemLocked(ref) })
}

// Find (Ctrl/Cmd+F, F3): references, values, board texts and nets (lib/board/boardFind.ts).
const findSelection = (target: BoardFindTarget): BoardItemRef[] => {
  if (target.type !== 'net') return [{ type: target.type, index: target.index }]
  const idx = spatialIndex.value
  return idx ? netItems(idx, new Set([target.net]), filterPasses).map(refOf) : []
}
const find = useCanvasFind({
  candidates: () => (board.value ? boardFindCandidates(board.value) : []),
  yDown: true,
  show: (hit) => {
    selectedItems.value = findSelection(hit.target)
    void nextTick(() => viewportRef.value?.revealSelection())
  }
})
const findState = find.state

/** The selection, or — with nothing selected — the item under the cursor (KiCad's hover selection). */
const selectionOrHover = (accept?: (ref: BoardItemRef) => boolean): BoardItemRef[] => {
  if (selectedItems.value.length) return selectedItems.value
  const hover = viewportRef.value?.itemAtCursor(accept)
  return hover ? [hover] : []
}

// --- Lock / unlock (L) -------------------------------------------------------

/** The object carrying an item's `locked` flag and top-level node. */
const lockable = (ref: BoardItemRef): { _raw: SExprNode; locked: boolean } | null => {
  const b = board.value
  if (!b) return null
  if (ref.type === 'footprint') return b.footprints[ref.index]?.footprint ?? null
  // KiCad's point has no lock in the format; its parser would refuse one.
  if (ref.type === 'point') return null
  const item = (collectionForType(ref.type) as Array<{ _raw: SExprNode; locked?: boolean }>)?.[
    ref.index
  ]
  return item && typeof item.locked === 'boolean'
    ? (item as { _raw: SExprNode; locked: boolean })
    : null
}

/**
 * KiCad's Toggle Lock: when anything in the selection is locked, unlock it
 * all; otherwise lock it all. Its key takes the item under the cursor when
 * nothing is selected (`hoverKeys`).
 */
const toggleLockSelected = (): void => {
  if (!board.value || props.isReadOnly) return
  const items = selectedItems.value
    .map(lockable)
    .filter((i): i is NonNullable<typeof i> => i !== null)
  if (items.length === 0) return
  const lock = !items.some((i) => i.locked)
  runCommand(
    t(lock ? tk('pcbEditor.commands.lock') : tk('pcbEditor.commands.unlock'), items.length),
    () => items.forEach((i) => setBoardItemLockedInAST(i, lock))
  )
}

// --- Select Connection (U), Select Net, Delete Full Track ----------------------

const COPPER_TYPES = new Set(['segment', 'tarc', 'via', 'zone', 'footprint'])
const WALK_START_TYPES = new Set(['segment', 'tarc', 'via', 'footprint', 'pad'])

/** The board's non-copper lines and arcs, the pieces an outline chains from. */
const outlineShapes = (): ConnShape[] => {
  const b = board.value
  if (!b) return []
  const shapes: ConnShape[] = []
  b.grLines.forEach((line, index) => {
    if (line.layer && !isCopperLayer(line.layer))
      shapes.push({
        id: `gr_line:${index}`,
        a: line.start,
        b: line.end,
        layer: line.layer,
        width: line.strokeWidth ?? 0
      })
  })
  b.grArcs.forEach((arc, index) => {
    if (arc.layer && !isCopperLayer(arc.layer))
      shapes.push({
        id: `gr_arc:${index}`,
        a: arc.start,
        b: arc.end,
        layer: arc.layer,
        width: arc.strokeWidth ?? 0
      })
  })
  return shapes
}

/**
 * KiCad's Select / Expand Connection: each press widens the selected copper's
 * connection one reach (junction, then pad, then everything joined). A
 * selected board-outline edge selects its outline; with nothing selected, the
 * copper under the cursor is the start.
 */
const selectConnection = (): void => {
  const idx = spatialIndex.value
  if (!board.value || !idx) return
  let selection = selectedItems.value
  const copperCount = selection.filter((r) => COPPER_TYPES.has(r.type)).length
  if (copperCount === 0) {
    const shapes = outlineShapes()
    const shapeIds = new Set(shapes.map((s) => s.id))
    const starts = selection.map(refId).filter((id) => shapeIds.has(id))
    if (starts.length > 0) {
      selectedItems.value = withSelected(connectedShapes(shapes, starts, filterPasses))
      return
    }
    const hover = viewportRef.value?.itemAtCursor((ref) => WALK_START_TYPES.has(ref.type))
    if (!hover) return
    selection = [...selection, hover]
    selectedItems.value = selection
  }
  const world = connectionWorldFromIndex(idx)
  const starts = selection.flatMap((ref) =>
    ref.type === 'footprint'
      ? footprintPads(world, refId(ref))
      : ref.type === 'pad'
        ? [`pad:${ref.index}/${ref.pad}`]
        : WALK_START_TYPES.has(ref.type)
          ? [refId(ref)]
          : []
  )
  const found = expandConnection(
    world,
    { copperCount, selectionSize: selection.length, starts },
    filterPasses
  )
  selectedItems.value = withSelected(found)
}

/** Double-click on a track with the select tool: its connection, as `U` from it alone. */
const selectTrackConnection = (): void => {
  const hit = viewportRef.value?.itemAtCursor(
    (ref) => ref.type === 'segment' || ref.type === 'tarc'
  )
  if (!hit) return
  selectedItems.value = [hit]
  selectConnection()
}

/**
 * KiCad's Select Net: the tracks and vias of every net the selected copper is
 * on (pads, zones and footprints stay as they are). With nothing selected,
 * the copper under the cursor names the net.
 */
const selectNet = (): void => {
  const b = board.value
  const idx = spatialIndex.value
  if (!b || !idx) return
  const netOf = (ref: BoardItemRef): number =>
    ref.type === 'segment'
      ? (b.segments[ref.index]?.net ?? 0)
      : ref.type === 'tarc'
        ? (b.trackArcs[ref.index]?.net ?? 0)
        : ref.type === 'via'
          ? (b.vias[ref.index]?.net ?? 0)
          : ref.type === 'zone'
            ? (b.zones[ref.index]?.net ?? 0)
            : 0
  const source = selectionOrHover((ref) => netOf(ref) > 0)
  const nets = new Set(source.map(netOf).filter((net) => net > 0))
  if (nets.size === 0) return
  if (selectedItems.value.length === 0) selectedItems.value = source
  selectedItems.value = withSelected(netItems(idx, nets, filterPasses))
}

/**
 * KiCad's Delete Full Track (Shift+Del): selected tracks or vias first widen
 * to their connection — one Select Connection reach — and then everything
 * selected is deleted, as one undo step.
 */
const deleteFullTrack = (): void => {
  if (props.isReadOnly) return
  selectedItems.value = patternsAsTracks(selectedItems.value)
  if (
    selectedItems.value.some((r) => r.type === 'segment' || r.type === 'tarc' || r.type === 'via')
  )
    selectConnection()
  deleteSelected()
}

const ROUTED_TYPES = new Set(['segment', 'tarc', 'via'])

/**
 * KiCad's Unroute Segment (Backspace on routed copper): delete the selected
 * tracks and vias and select what touched them, so each press walks one more
 * piece back along the route, as KiCad's does (`unrouteNeighbors`).
 */
const unrouteSegment = (): void => {
  const b = board.value
  const idx = spatialIndex.value
  // A tuning pattern unroutes whole, as KiCad's does (T4).
  const selection = patternsAsTracks(selectedItems.value)
  if (!b || !idx || props.isReadOnly || selection.length === 0) return
  const next = [
    ...unrouteNeighbors(connectionWorldFromIndex(idx), selection.map(refId), filterPasses)
  ]
    .map(refOf)
    .map((ref) => ({ type: ref.type, raw: rawForItem(ref) }))
  runCommand(
    t('commandLabels.delete', selection.length),
    () => {
      for (const ref of selection) {
        const raw = rawForItem(ref)
        if (raw) removeBoardNodeFromAST(b, raw)
      }
      selectedItems.value = []
    },
    {
      // Deleting renumbers the tracks, so the next step is found again by node.
      afterApply: () => {
        const after = props.session.board()
        if (!after) return
        const lists: Record<string, Array<{ _raw: SExprNode }>> = {
          segment: after.segments,
          tarc: after.trackArcs,
          via: after.vias
        }
        selectedItems.value = next.flatMap(({ type, raw }) => {
          const index = lists[type]?.findIndex((item) => item._raw === raw) ?? -1
          return index >= 0 ? [{ type, index }] : []
        })
      }
    }
  )
}

// --- Cut, copy, paste, duplicate (lib/board/pcbClipboard.ts) ------------------
// The app's one clipboard (lib/documentClipboard.ts): a footprint editor's
// items paste in here as a new footprint, and these paste into a footprint.

/**
 * The selection's top-level nodes: a selected pad copies its footprint, as
 * KiCad's does, and a tuning pattern its tracks with it (T4).
 */
const selectedNodes = (): SExprNode[] =>
  actedSelection.value.map(rawForItem).filter((raw): raw is SExprNode => !!raw)

const pasteable = usePasteable('board')
const hasSelection = computed(() => selectedItems.value.length > 0)
const canPaste = computed(() => !props.isReadOnly && !!pasteable.value)

/** One grid step in nm, snap or not: where a duplicate lands. */
const gridStepNm = (): Nm => {
  const g = gridSettings.value
  return g.unit === 'mil' ? nm(g.spacing * 25400) : mmToNm(g.spacing)
}

const copySelection = (): boolean => {
  const b = board.value
  if (!b) return false
  const names = new Map(b.nets.map((net) => [net.number, net.name]))
  const items = copyBoardItems(selectedNodes(), names)
  if (items.length) setClipboard('board', items)
  return items.length > 0
}

/** Copy, then delete what was copied, as one step. */
const cutSelection = (): void => {
  const b = board.value
  if (!b || props.isReadOnly) return
  const nodes = selectedNodes()
  if (!copySelection()) return
  runCommand(t('commandLabels.cut', nodes.length), () => {
    for (const raw of nodes) removeBoardNodeFromAST(b, raw)
    selectedItems.value = []
  })
}

/** Land prepared items, selected, as one step. */
const landPaste = (
  label: string,
  nodes: SExprList[],
  offset: (anchor: Point | null) => Point
): void => {
  const b = board.value
  if (!b || props.isReadOnly || !nodes.length) return
  const delta = offset(itemsAnchor(nodes))
  runCommand(label, () => {
    selectedItems.value = insertIntoBoard(b, nodes, delta)
  })
}

const pasteClipboard = (): void => {
  const contents = pasteable.value
  if (!contents || props.isReadOnly) return
  const { nodes } = prepareBoardPaste(contents)
  // The viewport's cursor is scene mm, y up; the board is nm, y down.
  const scene = viewportRef.value?.getCursor()
  const cursor = scene ? { x: mmToNm(scene.x), y: mmToNm(-scene.y) } : null
  landPaste(t('commandLabels.paste', nodes.length), nodes, (anchor) =>
    pasteOffset(anchor, {
      cursor,
      gridStep: gridStepNm(),
      sameKind: contents.kind === 'board',
      gridOrigin: board.value?.gridOrigin
    })
  )
}

/** KiCad's Duplicate: the selection again, a grid step down and right. */
const duplicateSelection = (): void => {
  const b = board.value
  if (!b) return
  const nodes = duplicateNodes(b, selectedNodes())
  const step = gridStepNm()
  landPaste(t('commandLabels.duplicate', nodes.length), nodes, () => ({ x: step, y: step }))
}

/** Select everything a sweep could take (the viewport's band, over everything). */
const selectAll = (): void => {
  selectedItems.value = viewportRef.value?.selectAll() ?? []
}

// --- Rotate and mirror, from a key or a toolbar chip ---------------------------

/** The grid a multi-item mirror center snaps to, nm; 0 with snap off. */
const gridNm = (): number => {
  const g = gridSettings.value
  if (!g.snap) return 0
  return mmToNm(spacingToMm(g.spacing, g.unit))
}

/**
 * KiCad's Mirror Horizontally / Vertically (lib/board/boardMirror.ts): one
 * item about its own position, several about their grid-snapped middle.
 */
const mirrorSelected = (axis: MirrorAxis): void => {
  const b = board.value
  if (!b || props.isReadOnly) return
  const entries = mirrorEntries(b, actedSelection.value)
  if (entries.length === 0) return
  const center = mirrorCenter(entries, selectedItems.value.length === 1, gridNm())
  if (!center) return
  runCommand(t('pcbEditor.commands.mirror', entries.length), () =>
    mirrorBoardItems(b, entries, center, axis)
  )
}

/** The rotate and mirror chips' hotkeys; the board binds no mirror key (DESIGN.md §Keymap). */
const transformHotkeys: Partial<Record<TransformOp, HotkeyActionId>> = {
  rotateCCW: 'pcb.rotate',
  rotateCW: 'pcb.rotateClockwise'
}

/** Whether a chip has something to act on: footprints to turn, graphics to mirror. */
const canTransform = (op: TransformOp): boolean => {
  if (props.isReadOnly) return false
  if ((op === 'rotateCCW' || op === 'rotateCW') && heldFootprint.value) return true
  const rotate = op === 'rotateCCW' || op === 'rotateCW'
  return selectedItems.value.some((r) =>
    rotate ? r.type === 'footprint' || NODE_TRANSFORM_TYPES.has(r.type) : MIRROR_TYPES.has(r.type)
  )
}

const runTransform = (op: TransformOp): void => {
  if (op === 'rotateCCW') turnHeldOrSelected(90)
  else if (op === 'rotateCW') turnHeldOrSelected(-90)
  else mirrorSelected(op === 'mirrorHorizontal' ? 'horizontal' : 'vertical')
}

// Properties: the shared PropertyTable schema + one edit channel that maps
// edit(groupType, key, value) to the board AST helpers, applied to every
// selected node of the group's type (mirrors the footprint editor).
// Swatches must show what the canvas shows, so they follow the theme's display
// palette rather than the canonical export one.
const appTheme = useAppTheme()
const layerColors = computed(() => kicadLayerColorsForTheme(appTheme.value))

const boardContext = computed<BoardContext>(() => ({
  ...boardOptions(board.value, layerColors.value),
  ...(selectionRules.value ? { rulesFor: rulesForSelection(selectionRules.value) } : {}),
  netLength: netLengthBreakdown,
  classColor
}))

/** A net class's PCB color, CSS, for its tag where a rule's source names it. */
const classColor = (name: string): string | undefined => {
  const color = setupClasses.value.find((c) => c.name === name)?.pcbColor
  return color ? cssColor(color) : undefined
}

const rulesForSelection = (rules: BoardRules): NonNullable<BoardContext['rulesFor']> => ({
  trackWidth: (net, layer) => {
    const r = resolveTrackWidth(rules, net, layer, setupRules.value.minTrackWidth)
    return {
      min: r.min,
      ...(r.max !== undefined ? { max: r.max } : {}),
      source: r.source
    }
  },
  via: (net, layers) => {
    const r = resolveVia(rules, net, layers, viaMinimum())
    return { min: r.min.diameter, source: r.source }
  }
})
const boardGroups = computed(() =>
  intersectGroups(
    buildBoardGroups(board.value, selectedItems.value, t, boardContext.value),
    t('shared.properties.selection')
  )
)

// The properties panel offers Manufacture only with nothing selected (the
// board-level state), on a real saved board — the tab it opens is titled by the
// file, so an untitled/unsaved board has nothing to key on.
const canManufacture = computed(
  () => selectedItems.value.length === 0 && !!board.value && !!props.filePath
)

const num = (v: PropertyEditValue): number => (typeof v === 'number' ? v : Number(v) || 0)

// Exhaustive over the selectable types: one made selectable without an edit
// path here does not compile.
const applyBoardEdit = (
  itemType: BoardItemType,
  node: unknown,
  key: string,
  value: PropertyEditValue
): void => {
  // Every item but a footprint locks the same way; a footprint's own row is below.
  if (key === 'locked' && itemType !== 'footprint') {
    setBoardItemLockedInAST(node as { _raw: SExprNode; locked: boolean }, !!value)
    return
  }
  // A drawing on copper carries a net, written as the board names its nets.
  if (key === 'net' && itemType.startsWith('gr_') && board.value) {
    setGraphicNetInAST(node as { _raw: SExprNode; net?: number }, num(value), board.value)
    return
  }
  const patch = boardPatch(key, value)
  // A graphic, text or text box takes the footprint's rows, and their patches.
  const graphic = (): Record<string, unknown> => boardGraphicPatch(itemType, key, value, node)
  switch (itemType) {
    case 'footprint': {
      const bfp = node as KicadBoardFootprint
      if (key === 'posX') moveBoardFootprintInAST(bfp, nm(num(value)), bfp.position.y)
      else if (key === 'posY') moveBoardFootprintInAST(bfp, bfp.position.x, nm(num(value)))
      else if (key === 'rotation') rotateBoardFootprintInAST(bfp, num(value))
      // KiCad's Side field flips the part about its anchor (`SetLayerAndFlip`).
      else if (key === 'side' && value !== bfp.layer && board.value && footprintFlippable(bfp))
        flipBoardFootprintInAST(board.value, bfp, bfp.position)
      else if (key === 'locked') setBoardItemLockedInAST(bfp.footprint, !!value)
      // Only a footprint no symbol owns gets these rows (pcbPropertySchema.ts).
      else if ((key === 'reference' || key === 'value') && !isSymbolOwned(bfp)) {
        markNodeDirty(bfp.footprint._raw)
        setFootprintFieldText(bfp.footprint, key, String(value))
        bfp[key] = String(value)
      }
      // Attributes and overrides: the footprint editor's rows, the same writer.
      else
        updateFootprintMetaInAST(
          bfp.footprint,
          footprintPatch('footprint', key, value, bfp.footprint) as Parameters<
            typeof updateFootprintMetaInAST
          >[1]
        )
      break
    }
    case 'segment':
      updateSegmentInAST(
        node as KicadTrackSegment,
        patch as Partial<KicadTrackSegment>,
        board.value ?? undefined
      )
      break
    case 'tarc':
      updateTrackArcInAST(
        node as KicadTrackArc,
        patch as Partial<KicadTrackArc>,
        board.value ?? undefined
      )
      break
    case 'via': {
      const via = node as KicadVia
      if (key.startsWith('teardrop')) {
        const next = teardropRowEdit(readTeardropParams(via._raw), key, value)
        if (next) writeTeardropParams(via._raw, next, 'via', via._raw)
        break
      }
      // Layer Top / Bottom: one end of the span it covers.
      const layers =
        key === 'layerTop'
          ? [String(value), via.layers[via.layers.length - 1]]
          : key === 'layerBottom'
            ? [via.layers[0], String(value)]
            : undefined
      updateViaInAST(
        via,
        layers ? { layers } : (patch as Partial<KicadVia>),
        board.value ?? undefined
      )
      break
    }
    case 'gr_line':
      updateLineInAST(node as KicadFpLine, graphic() as Partial<KicadFpLine>)
      break
    case 'gr_arc':
      updateArcInAST(node as KicadFpArc, graphic() as Partial<KicadFpArc>)
      break
    case 'gr_circle':
      updateCircleInAST(node as KicadFpCircle, graphic() as Partial<KicadFpCircle>)
      break
    case 'gr_rect':
      updateRectInAST(node as KicadFpRect, graphic() as Partial<KicadFpRect>)
      break
    case 'gr_poly':
      updatePolyInAST(node as KicadFpPoly, graphic() as Partial<KicadFpPoly>)
      break
    case 'gr_text':
      updateGrTextInAST(node as KicadGrText, graphic() as Partial<KicadGrText>)
      break
    case 'gr_curve':
      updateCurveInAST(node as KicadFpCurve, graphic() as Partial<KicadFpCurve>)
      break
    case 'point':
      updatePointInAST(node as KicadPoint, patch as Parameters<typeof updatePointInAST>[1])
      break
    case 'table':
      updateTableInAST(node as KicadTable, patch as TablePatch)
      break
    case 'gr_text_box':
      updateTextBoxInAST(node as KicadFpTextBox, graphic() as TextBoxPatch)
      break
    case 'zone': {
      const zone = node as KicadBoardZone
      const b = board.value
      if (!b) break
      if (key === 'net') {
        const netNumber = num(value)
        updateBoardZoneInAST(
          zone,
          { net: { number: netNumber, name: getNetName(b, netNumber) } },
          b
        )
      } else if (key === 'layer') {
        // Every layer named, as KiCad 10 writes a copper zone's set.
        const layers = String(value).split(',').filter(Boolean)
        if (layers.length > 0) updateBoardZoneInAST(zone, { layers })
      } else if (key === 'priority') {
        updateBoardZoneInAST(zone, { priority: num(value) })
      } else if (key === 'minThickness') {
        updateBoardZoneInAST(zone, { minThickness: nm(num(value)) })
      } else if (key === 'padConnection') {
        updateBoardZoneInAST(zone, { padConnection: String(value) as ZonePadConnection })
      } else if (key === 'padClearance') {
        updateBoardZoneInAST(zone, { padClearance: nm(num(value)) })
      } else if (key === 'thermalGap') {
        updateBoardZoneInAST(zone, { thermalGap: nm(num(value)) })
      } else if (key === 'thermalBridge') {
        updateBoardZoneInAST(zone, { thermalBridgeWidth: nm(num(value)) })
      } else if (key === 'zoneName') {
        updateBoardZoneInAST(zone, { name: String(value ?? '') })
      } else if (key === 'removeIslands') {
        const mode = num(value)
        updateBoardZoneInAST(zone, {
          islandRemovalMode: mode === 1 || mode === 2 ? mode : null,
          // "Below area" needs an area to compare against: KiCad's default, 10 mm².
          ...(mode === 2 && zone.minIslandArea === undefined ? { minIslandArea: 10 } : {})
        })
      } else if (key === 'minIslandArea') {
        updateBoardZoneInAST(zone, { minIslandArea: num(value) })
      } else if (key === 'keepout') {
        updateBoardZoneInAST(zone, { keepout: !!value })
      } else if (key === 'fillMode') {
        updateBoardZoneInAST(zone, { hatchFill: value === 'hatch' ? {} : null })
      } else if (key === 'hatchThickness') {
        updateBoardZoneInAST(zone, { hatchFill: { thickness: nmToMm(nm(num(value))) } })
      } else if (key === 'hatchGap') {
        updateBoardZoneInAST(zone, { hatchFill: { gap: nmToMm(nm(num(value))) } })
      } else if (key === 'hatchOrientation') {
        updateBoardZoneInAST(zone, { hatchFill: { orientation: num(value) } })
      } else if (key.startsWith('block')) {
        const rule = (
          {
            blockTracks: 'tracks',
            blockVias: 'vias',
            blockPads: 'pads',
            blockPour: 'copperpour',
            blockFootprints: 'footprints'
          } as const
        )[key]
        // Checked = blocked; the AST stores "allowed".
        if (rule) updateBoardZoneInAST(zone, { keepoutRules: { [rule]: !value } })
      }
      break
    }
    // Re-tuned as a whole in onBoardEdit (T4).
    case 'tuning_pattern':
      break
    default:
      itemType satisfies never
  }
}

const onBoardEdit = (
  groupType: string,
  key: string,
  value: PropertyEditValue,
  sharedKey?: string
): void => {
  const b = board.value
  if (!b || props.isReadOnly) return
  // A mixed selection's edit is each kind's, merged into one undo step.
  if (groupType === SELECTION_GROUP) {
    const members = boardGroups.value[0]?.members ?? []
    for (const member of members) onBoardEdit(member.type, key, value, `${SELECTION_GROUP}:${key}`)
    return
  }
  const mergeKey = sharedKey ?? `${groupType}:${key}`
  if (groupType === 'tuning_pattern') {
    editTuningPatterns(key, value)
    return
  }
  if (groupType === 'board') {
    const data = key === 'thickness' ? { thickness: nm(num(value)) } : { paper: String(value) }
    runCommand(t('pcbEditor.commands.editBoard'), () => updateBoardMetaInAST(b, data), { mergeKey })
    return
  }
  if (groupType === 'fp_field' || groupType === 'fp_text') {
    // A footprint's field or text: the text rows, the position given on the
    // board and kept in the footprint's frame.
    const owned = selectedItems.value
      .filter((i) => i.type === groupType)
      .flatMap((ref) => footprintTextOf(b, ref) ?? [])
    if (!owned.length) return
    runCommand(
      t('pcbEditor.commands.editItem'),
      () => {
        for (const { kind, footprint, item } of owned) {
          markNodeDirty(footprint.footprint._raw)
          let patch = footprintPatch(kind === 'field' ? 'property' : 'text', key, value, item)
          if ((key === 'posX' || key === 'posY') && item.position) {
            const onBoard = footprintPointOnBoard(footprint, item.position)
            const moved = { ...onBoard, [key === 'posX' ? 'x' : 'y']: num(value) }
            patch = { position: boardPointInFootprint(footprint, moved) }
          }
          if (kind === 'field') updatePropertyInAST(item, patch as Partial<KicadProperty>)
          else updateTextInAST(item, patch as Partial<KicadFpText>)
          // A board-only footprint's own name, as the footprint row reads it.
          if (key === 'text' && kind === 'field' && item.key === 'Reference')
            footprint.reference = String(value)
          if (key === 'text' && kind === 'field' && item.key === 'Value')
            footprint.value = String(value)
        }
      },
      { mergeKey }
    )
    return
  }
  if (groupType === 'pad') {
    // A pad's own rows (number, shape, size, hole, overrides) — its footprint's
    // copy of it, written where the board file keeps it.
    const pads = selectedPads(b, selectedItems.value)
    if (!pads.length) return
    // Each pad's footprint is the board's top-level node: dirty it so it reserializes.
    const owners = new Set(
      selectedItems.value.filter((i) => i.type === 'pad').map((i) => b.footprints[i.index])
    )
    runCommand(
      t('pcbEditor.commands.editItem'),
      () => {
        for (const bfp of owners) if (bfp) markNodeDirty(bfp.footprint._raw)
        pads.forEach((pad) =>
          updatePadInAST(pad, footprintPatch('pad', key, value, pad) as PadPatch)
        )
      },
      { mergeKey }
    )
    return
  }
  if (!isBoardItemType(groupType)) return
  const collection = b[BOARD_ITEM_COLLECTIONS[groupType]] as unknown[]
  const nodes = selectedItems.value
    .filter((i) => i.type === groupType)
    .map((i) => collection[i.index])
    .filter((n): n is NonNullable<typeof n> => !!n)
  if (!nodes.length) return
  runCommand(
    t('pcbEditor.commands.editItem'),
    () => nodes.forEach((n) => applyBoardEdit(groupType, n, key, value)),
    { mergeKey }
  )
}

// ---------------------------------------------------------------------------
// Board Setup (P0.4) — stackup + design rules + routing defaults
//
// The two halves persist to different files, and the seam must not leak into
// the UI: the stackup lives in this .kicad_pcb (so it goes through runCommand
// and is undoable with everything else), while design rules and the Default net
// class live in the sibling .kicad_pro (so they are written straight out, like
// the schematic's BOM presets, and are NOT on the board's undo stack). A board
// with no project file can still edit its stackup; rules have nowhere to go.
// ---------------------------------------------------------------------------

const projectPath = ref<string | null>(null)
const setupRules = ref<DesignRules>({ ...DEFAULT_DESIGN_RULES })
const setupClasses = ref<NetClass[]>(DEFAULT_NET_CLASSES.map((c) => ({ ...c })))
const setupPatterns = ref<NetClassPattern[]>([])
/** Per-net classes the schematic assigned: read for routing and checks, never edited here. */
const setupAssignments = ref<NetClassAssignment[]>([])
/** KiCad 10's tuning profiles: each layer's width and gap a class's profile gives, and its delays. */
const setupTuning = ref<BoardDesignSettings['tuning']>(undefined)
/** The project's DRC `rule_severities` (Board Setup's Design Rules). */
const setupSeverities = ref<SeverityMap>({})
/** The project's KiCad DRC exclusions (Board Setup's Exclusions), read-only. */
const setupExclusions = ref<KicadExclusion[]>([])
/** The project's `.kicad_dru`, read beside its `.kicad_pro`; DRC and the refill follow it. */
const setupCustomRules = ref<string | undefined>(undefined)
const setupEdited = ref(false)
const setupProfileId = ref<string | null>(null)

/** The stackup the form edits, read back from the board so undo is reflected. */
const setupStackup = computed<StackupSpec>(() => stackupSpecOf(board.value))

const setupStackupId = ref<string | null>(null)

/**
 * Take the presets the project says the user picked: Custom for none, or for an
 * id this version does not ship. The choice only names; the board's own values
 * stand, so a profile whose shipped numbers moved since reads as edited.
 */
const takeSetupChoice = (
  choice: BoardSetupChoice | undefined,
  rules: DesignRules,
  classes: readonly NetClass[]
): void => {
  const profile = choice?.profile ? findAnyProfile(choice.profile) : null
  setupProfileId.value = profile?.id ?? null
  setupEdited.value = profile ? !matchesProfile(profile, { rules, classes }) : false
  setupStackupId.value =
    choice?.stackup && findAnyStackupPreset(choice.stackup) ? choice.stackup : null
}

/** Store the picks in the project; a project-less board keeps them for the session. */
const persistSetupChoice = async (choice: Partial<BoardSetupChoice>): Promise<boolean> =>
  projectPath.value ? writeProjectBoardSetupChoice(projectPath.value, choice) : false

/** A stackup no longer the build it was picked as: Custom from here, stored. */
const leaveStackupPreset = (): void => {
  if (setupStackupId.value === null) return
  setupStackupId.value = null
  void persistSetupChoice({ stackup: null }).then((written) => {
    if (written) void emitProjectChange(null, fileChange('file-changed', projectPath.value!))
  })
}

const stackupPresetList = computed(() => [
  ...allStackupPresets().map((preset) => ({
    id: preset.id,
    name: stackupPresetLabel(preset.profile, preset)
  })),
  ...userStackupPresets().map(({ id, name }) => ({ id, name }))
])

/** The board's own rows — the stackup table's model and the diagram's. */
const stackupRows = computed(() => buildStackupRows(board.value?.stackup?.layers ?? [], t))

const boardSetupModel = computed<BoardSetupModel>(() => ({
  profiles: [...BUILT_IN_PROFILES, ...userProfiles()],
  // An id this window cannot resolve (a saved preset since removed) reads as Custom.
  activeProfileId:
    setupProfileId.value && findAnyProfile(setupProfileId.value) ? setupProfileId.value : null,
  edited: setupEdited.value,
  stackup: setupStackup.value,
  layers: board.value?.stackup?.layers ?? [],
  activeStackupId:
    setupStackupId.value && findAnyStackupPreset(setupStackupId.value)
      ? setupStackupId.value
      : null,
  stackupPresets: stackupPresetList.value,
  rules: setupRules.value,
  classes: setupClasses.value,
  patterns: setupPatterns.value,
  extraSizes: setupExtraSizes.value,
  tuning: tuneDefaults.value,
  tuningProfiles: setupTuning.value?.definitions ?? [],
  teardrops: teardropDefaults.value
}))

/** The board's build as the impedance solver reads it; KiCad's default where the board has none. */
const solverStackup = computed(() => (board.value ? solverStackupOf(board.value) : []))
/** Why a row's last Solve failed, by profile and layer, until that profile is edited. */
const profileSolveErrors = ref<ReadonlyMap<string, ProfileSolveError>>(new Map())
const solveErrorKey = (profile: string, layer: string): string => `${profile}\u0000${layer}`
const boardSetupSections = computed(() => {
  // A preset draft shows as the page Apply would leave, its rows marked.
  const preview = presetPreview.value
  return buildBoardSetupSections(
    preview?.model ?? boardSetupModel.value,
    t,
    (profile, layer) => {
      const failed = profileSolveErrors.value.get(solveErrorKey(profile.name, layer.layer))
      const read = failed
        ? ({ ok: false, error: failed } as const)
        : profileRowReadout(solverStackup.value, profile, layer)
      if (!read) return null
      return read.ok
        ? { ohms: read.ohms }
        : { error: t(`boardSetup.tuningProfiles.errors.${read.error}`) }
    },
    {
      rulesText: preview?.rulesText ?? setupCustomRules.value,
      ...(preview ? { pending: preview.pending } : {}),
      layerColors: layerColors.value
    }
  )
})
/** The nets the assignment table is about; read only while Board Setup shows. */
const setupNetNames = computed(() =>
  activeMode.value === 'setup' && board.value ? assignableNets(netsInUse(board.value)) : []
)

// Load the sibling project's rules when the board's path settles.
watch(
  () => props.filePath,
  async (path) => {
    projectPath.value = path ? await findProjectFile(path) : null
    const loaded = projectPath.value ? await readProjectDesignSettings(projectPath.value) : null
    layerPairPresets.value = projectPath.value ? await readProjectLayerPairs(projectPath.value) : []
    setupRules.value = loaded?.rules ?? { ...DEFAULT_DESIGN_RULES }
    setupClasses.value = loaded?.classes ?? DEFAULT_NET_CLASSES.map((c) => ({ ...c }))
    setupPatterns.value = loaded?.patterns ?? []
    setupAssignments.value = loaded?.assignments ?? []
    setupTuning.value = loaded?.tuning
    setupSeverities.value = loaded?.severities ?? {}
    setupExclusions.value = loaded?.exclusions ?? []
    setupCustomRules.value = loaded?.customRules
    setupExtraSizes.value = loaded?.extraSizes ?? { tracks: [], vias: [] }
    setupPairSizes.value = loaded?.pairSizes ?? []
    // A saved preset's id resolves only once the saved set is read.
    await loadUserSetupPresets()
    takeSetupChoice(loaded?.setupChoice, setupRules.value, setupClasses.value)
    teardropDefaults.value = loaded?.teardrops ?? structuredClone(DEFAULT_TEARDROP_SETTINGS)
  },
  { immediate: true }
)

// The project file changed — KiCad, an agent, another window:
// take what differs, so the checks and the router follow it. A setting this
// view already holds is left alone, which keeps its profile's "edited" mark.
const stopProjectWatch = onProjectChange(async (changes) => {
  const file = projectPath.value
  const watched = (path: string): boolean =>
    samePath(path, file ?? '') || samePath(path, customRulesPath(file ?? ''))
  if (!file || !changes.some((c) => 'path' in c && watched(c.path))) return
  const loaded = await readProjectDesignSettings(file)
  if (!loaded || file !== projectPath.value) return
  const pairs = await readProjectLayerPairs(file)
  if (JSON.stringify(pairs) !== JSON.stringify(layerPairPresets.value))
    layerPairPresets.value = pairs
  if (loaded.customRules !== setupCustomRules.value) setupCustomRules.value = loaded.customRules
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  if (!same(loaded.tuning, setupTuning.value)) setupTuning.value = loaded.tuning
  if (loaded.teardrops && !same(loaded.teardrops, teardropDefaults.value))
    teardropDefaults.value = loaded.teardrops
  if (!same(loaded.extraSizes, setupExtraSizes.value))
    setupExtraSizes.value = loaded.extraSizes ?? { tracks: [], vias: [] }
  if (!same(loaded.pairSizes ?? [], setupPairSizes.value))
    setupPairSizes.value = loaded.pairSizes ?? []
  if (!same(loaded.severities ?? {}, setupSeverities.value))
    setupSeverities.value = loaded.severities ?? {}
  if (!same(loaded.exclusions ?? [], setupExclusions.value))
    setupExclusions.value = loaded.exclusions ?? []
  if (!same(loaded.assignments, setupAssignments.value)) setupAssignments.value = loaded.assignments
  const choiceMoved =
    (loaded.setupChoice?.profile ?? null) !== setupProfileId.value ||
    (loaded.setupChoice?.stackup ?? null) !== setupStackupId.value
  const rulesMoved =
    !same(loaded.rules, setupRules.value) ||
    !same(loaded.classes, setupClasses.value) ||
    !same(loaded.patterns, savedPatterns.value)
  if (rulesMoved) {
    setupRules.value = loaded.rules
    setupClasses.value = loaded.classes
    // Drafts are this page's, not the file's: they outlive a reload.
    const drafts = setupPatterns.value.filter((p) => p.pattern.trim() === '')
    setupPatterns.value = [...loaded.patterns, ...drafts]
  }
  if (rulesMoved || choiceMoved) takeSetupChoice(loaded.setupChoice, loaded.rules, loaded.classes)
})
onUnmounted(stopProjectWatch)

// The tuners' defaults (T6) the project keeps, read when the board's project
// settles and again when the file changes elsewhere.
watch(
  projectPath,
  async (file) => {
    const read = file ? await readProjectTuningPatternSettings(file) : null
    if (file !== projectPath.value) return
    tuneDefaults.value = read ?? structuredClone(DEFAULT_TUNING_PATTERN_SETTINGS)
  },
  { immediate: true }
)
onUnmounted(
  onProjectChange(async (changes) => {
    const file = projectPath.value
    if (!file || !changes.some((c) => 'path' in c && samePath(c.path, file))) return
    const read = await readProjectTuningPatternSettings(file)
    if (file !== projectPath.value) return
    if (read && JSON.stringify(read) !== JSON.stringify(tuneDefaults.value))
      tuneDefaults.value = read
  })
)

/** Set one DRC rule's severity in the project, as KiCad's Violation Severity page does. */
const onSetSeverity = async (key: string, severity: RuleSeverity): Promise<void> => {
  const file = projectPath.value
  if (!file || props.isReadOnly) return
  setupSeverities.value = { ...setupSeverities.value, [key]: severity }
  if (await writeProjectRuleSeverities(file, 'drc', { [key]: severity })) {
    void emitProjectChange(null, fileChange('file-changed', file))
  }
}

// ---- Design health: the DRC pill and the findings drawer --------------------
// (design-health-workstream.md). The rules `board.check` runs. Each
// edit is checked at once round what it changed (the region rules,
// `drc/incremental.ts`); once the board holds still and its ratsnest is in,
// the board-wide rules run too. A load, an undo or new rules check the whole
// board. A run is cooperative, and an edit mid-run cancels it, so the pill
// shows the last finished result.
const healthDrawer = useHealthDrawer('pcb')
const healthOpen = healthDrawer.open
const healthHeight = healthDrawer.height
const healthPinned = panelPinned('pcb', 'health')
const checkResults = shallowRef<CheckResult[]>([])
/** The board the pill's findings are of. */
const checkedBoard = shallowRef<KicadBoard | null>(null)
/** What the pill's findings were checked against, as versions (`versionOf`). */
let checkedWith: { settings: number; libraries: number; schematic: number } | null = null
let checkToken = 0
/** The next check runs whole, whatever the board worker kept from the last. */
let checkWhole = false
/**
 * A number per object, new each time the object is: what the board worker is
 * told in place of the settings, libraries and schematic it already holds.
 */
const versions = new WeakMap<object, number>()
let nextVersion = 1
const versionOf = (value: object | null | undefined): number => {
  if (!value) return 0
  let version = versions.get(value)
  if (version === undefined) versions.set(value, (version = nextVersion++))
  return version
}
/** The rules the checks run under: one object until they change, so a run can tell. */
const checkSettings = computed<BoardDesignSettings>(() => ({
  rules: setupRules.value,
  classes: setupClasses.value,
  patterns: setupPatterns.value,
  assignments: setupAssignments.value,
  tuning: setupTuning.value,
  severities: setupSeverities.value,
  exclusions: setupExclusions.value,
  customRules: setupCustomRules.value
}))
/** Checks running now. */
const checkRunning = ref(0)
/** How far the latest check has got, 0–1; null before it starts. */
const checkProgress = ref<number | null>(null)
/**
 * How far the board's findings have got to catching up with it, 0–1, for the
 * pill: the refill (when one ran) and then the check, each its share by how
 * long the last of its kind took.
 */
const followUpProgress = computed(() => {
  const refill = followUpMs.refill ?? followUpMs.check ?? 1
  const check = followUpMs.check ?? refill
  if (refillBusy.value) return ((refillProgress.value ?? 0) * refill) / (refill + check)
  const before = refilledSinceCheck.value ? refill : 0
  return (before + (checkProgress.value ?? 0) * check) / (before + check)
})
/**
 * The pill's findings are not the board's yet: an edit is waiting on its
 * refill, its ratsnest or its check. The pill shows it past the loading threshold.
 */
const checkPending = computed(
  () =>
    checkRunning.value > 0 ||
    refillBusy.value ||
    (automation.value.drc !== 'off' && board.value !== null && board.value !== checkedBoard.value)
)
// The library rules compare each footprint with its library copy: the
// libraries are loaded for the board's parts, again when the parts change, the
// library index rebuilds, or one of the project's own libraries or tables is
// written (an agent's footprint_create). Until they are in, those rules stay quiet.
const boardLibraries = shallowRef<BoardLibraryData | undefined>(undefined)
const libraryIds = computed(() =>
  [...new Set(board.value?.footprints.map((bfp) => bfp.libId) ?? [])].sort().join('\n')
)
const boardLibraryFeed = createLibraryFeed(
  async () => {
    const b = board.value
    if (!b) return undefined
    return readBoardLibraryData(boardLibraryIo(props.filePath), b)
  },
  (libraries) => (boardLibraries.value = libraries)
)
// With no board there is nothing to read for; what was read stays.
const refreshBoardLibraries = (): void => {
  if (board.value) boardLibraryFeed.refresh()
}
watch(libraryIds, refreshBoardLibraries, { immediate: true })
onUnmounted(onIndexRebuilt(refreshBoardLibraries))
onUnmounted(
  onProjectChange((changes) => {
    if (board.value && touchesProjectLibraries(changes)) boardLibraryFeed.refreshSoon()
  })
)
onUnmounted(boardLibraryFeed.dispose)
// The schematic the parity rules hold the board to (lib/board/syncDrift.ts),
// read again a moment after any schematic changes. Until it is in, those rules
// stay quiet; with no schematic, or one not annotated, they never run.
const schematicSource = inject(SCHEMATIC_SOURCE, null)
/** undefined until first read; null when the project has no schematic. */
const schematicRead = shallowRef<SchematicRead | null | undefined>(undefined)
let schematicTimer: ReturnType<typeof setTimeout> | null = null
let schematicRequest = 0
const readSchematic = async (): Promise<void> => {
  if (!schematicSource) return
  const request = ++schematicRequest
  const read = await schematicSource.read()
  if (request === schematicRequest) schematicRead.value = read
}
void readSchematic()
const stopSchematicChange = schematicSource?.onChange(() => {
  if (schematicTimer) clearTimeout(schematicTimer)
  schematicTimer = setTimeout(() => {
    schematicTimer = null
    void readSchematic()
  }, 300)
})
onUnmounted(() => {
  stopSchematicChange?.()
  if (schematicTimer) clearTimeout(schematicTimer)
  schematicRequest++
})
const schematicNetlist = computed(() =>
  schematicRead.value?.state === 'ready' ? schematicRead.value.netlist : null
)

/**
 * Check the board once it is ready to be checked — its refill done, its
 * ratsnest in — and publish all of it at once: the region round the edits
 * since the last check and the board-wide rules together, so the pill moves
 * once per edit, to the answer a whole check would give. Where the edits
 * cannot be followed, or the rules changed, the whole board.
 */
const checkWhenReady = (): void => {
  const token = ++checkToken
  const b = board.value
  const worker = props.session.worker()
  if (!b || !worker || refillBusy.value) return
  // A load not yet past deciding on its whole refill: checking now would check fills about to go.
  if (openRefilled.get(props.session) !== props.session.loadId()) return
  // Off, only the re-run checks.
  if (automation.value.drc === 'off' && !checkWhole) return
  const settings = checkSettings.value
  const libraries = boardLibraries.value ?? null
  const schematic = schematicNetlist.value
  const using = {
    settings: versionOf(settings),
    libraries: versionOf(libraries),
    schematic: versionOf(schematic)
  }
  if (
    !checkWhole &&
    checkedBoard.value === b &&
    checkedWith?.settings === using.settings &&
    checkedWith.libraries === using.libraries &&
    checkedWith.schematic === using.schematic
  )
    return
  const whole = checkWhole || automation.value.drc === 'full'
  checkWhole = false
  checkProgress.value = null
  void (async () => {
    checkRunning.value++
    const started = performance.now()
    try {
      // The board worker checks round the edits since its last run, and the
      // board-wide rules after; a load, an undo or new rules, the whole board.
      const results = await worker.check({
        settings: { version: using.settings, value: settings },
        libraries: { version: using.libraries, value: libraries },
        schematic: { version: using.schematic, value: schematic },
        whole,
        progress: (done) => {
          if (token === checkToken) checkProgress.value = done
        }
      })
      // A newer edit or rule change since: its own check follows.
      if (token !== checkToken || board.value !== b) return
      // No answer for the board as it is (the worker failed and said why):
      // the last findings stand, and the pill stops waiting.
      checkedBoard.value = b
      checkedWith = using
      refilledSinceCheck.value = false
      if (results) {
        checkResults.value = results
        followUpMs.check = performance.now() - started
      }
    } finally {
      checkRunning.value--
      if (token === checkToken) checkProgress.value = null
    }
  })()
}
watch(
  [board, checkSettings, refillBusy, boardLibraries, schematicNetlist, () => automation.value.drc],
  checkWhenReady,
  { immediate: true }
)
/** Check the whole board again, whatever the last checks kept. */
const rerunChecks = (): void => {
  checkWhole = true
  checkedBoard.value = null
  checkWhenReady()
}
const healthFindings = computed<HealthFinding[]>(() => {
  const fix = props.isReadOnly ? undefined : t('pcbEditor.cleanup.fix')
  return documentFindings(checkResults.value).map((finding) =>
    fix && DANGLING_RULES.has(finding.code) ? { ...finding, fix } : finding
  )
})
/** "Remove all" beside a dangling rule with more than one finding. */
const healthGroupFixes = computed<Record<string, string> | undefined>(() => {
  if (props.isReadOnly) return undefined
  const counts = new Map<string, number>()
  for (const finding of healthFindings.value)
    if (finding.fix) counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1)
  const fixes: Record<string, string> = {}
  for (const [code, count] of counts) if (count > 1) fixes[code] = t('pcbEditor.cleanup.fixAll')
  return fixes
})
/** A finding's quick fix: the dangling copper it names. */
const fixFinding = (finding: HealthFinding): void => {
  const index = healthFindings.value.findIndex((entry) => entry.key === finding.key)
  const result = checkResults.value[index]
  if (result && DANGLING_RULES.has(result.code)) removeDangling([result])
}
/** A rule's quick fix: every finding of it the list shows. */
const fixFindingGroup = (code: string): void => {
  if (!DANGLING_RULES.has(code)) return
  const shown = new Set(
    healthFindings.value.filter((finding) => finding.code === code).map((finding) => finding.key)
  )
  removeDangling(
    checkResults.value.filter((_, index) => shown.has(healthFindings.value[index]?.key))
  )
}

// Each finding marked on the canvas; a click on one selects its row (design-health-workstream.md).
const healthView = designHealthViewState()
/** The finding the drawer or a marker last picked: its marker draws over the rest. */
const pickedFinding = ref<string | null>(null)
const findingMarkers = computed(() =>
  healthView.value.showMarkers
    ? findingMarks(checkResults.value, healthFindings.value, undefined, pickedFinding.value)
    : []
)
/** A picked finding on one of the board's layers makes that layer the active one. */
const showFindingLayer = (key: string): void => {
  const layer = checkResults.value[healthFindings.value.findIndex((f) => f.key === key)]?.layer
  if (layer && layer !== activeLayer.value && board.value?.layers.some((l) => l.name === layer))
    handleSetActiveLayer(layer)
}
const findingReveal = shallowRef<{ key: string; seq: number } | null>(null)
let revealSeq = 0
const revealFinding = (key: string): void => {
  if (!healthPinned.value) healthDrawer.show()
  findingReveal.value = { key, seq: ++revealSeq }
  pickedFinding.value = key
  showFindingLayer(key)
}

/** The drawer's Performance tab: the worker's tasks in the order they follow an edit. */
const TIMED_TASKS: TimedTask[] = ['refill', 'ratsnest', 'check']
const performanceTasks = computed<PerformanceTask[]>(() =>
  TIMED_TASKS.flatMap((task) => {
    const timing = taskTimings.value[task]
    if (!timing) return []
    return [
      {
        id: task,
        title:
          task === 'refill'
            ? t('designHealth.performance.tasks.refill')
            : task === 'check'
              ? t('designHealth.performance.tasks.check')
              : t('designHealth.performance.tasks.ratsnest'),
        scope: scopeLabel(timing.scope),
        ms: timing.ms,
        steps: timing.spans.map((span) => ({ name: span.name, ms: span.ms }))
      }
    ]
  })
)
const scopeLabel = (scope: string): string =>
  scope === 'all'
    ? t('designHealth.performance.scope.all')
    : scope === 'since'
      ? t('designHealth.performance.scope.since')
      : t('designHealth.performance.scope.whole')

/**
 * The board's drift from the schematic, for Update from schematic: what the
 * parity findings say once the schematic is read; nothing while it is being.
 */
const syncDrift = computed<SyncDrift | null>(() => {
  const read = schematicRead.value
  if (read === undefined) return null
  if (read === null) return { state: 'none' }
  if (read.state === 'unannotated') return { state: 'unannotated' }
  return driftOf(checkResults.value)
})
/** Findings per KiCad key, for Board Setup's Design Rules; null before the first run. */
const checksRan = ref(false)
watch(checkResults, () => (checksRan.value = true))
const ruleCounts = computed<ReadonlyMap<string, number> | null>(() => {
  if (!checksRan.value) return null
  const counts = new Map<string, number>()
  for (const result of checkResults.value) {
    if (result.excluded) continue
    const key = BOARD_KICAD_KEYS[result.code]
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
})
const healthReport = computed<HealthReport>(() =>
  checksRan.value ? { status: 'checked', findings: healthFindings.value } : { status: 'pending' }
)

/** Select what a finding names and bring its position into view. */
const locateFinding = (finding: HealthFinding, zoom = false): void => {
  const b = board.value
  const index = healthFindings.value.findIndex((entry) => entry.key === finding.key)
  const result = checkResults.value[index]
  if (!b || !result) return
  pickedFinding.value = finding.key
  showFindingLayer(finding.key)
  selectedItems.value = locateBoardItems(b, result.targets ?? [])
  if (result.position) viewportRef.value?.showFinding(result.position.x, result.position.y, zoom)
}

/**
 * The assignments worth saving: a row whose pattern is still blank is a draft
 * (just added, not yet typed into). It stays on the page and out of the file,
 * where an empty pattern would match nothing — and the reader drops one anyway.
 */
const savedPatterns = computed(() => setupPatterns.value.filter((p) => p.pattern.trim() !== ''))

const persistDesignRules = async (choice?: Partial<BoardSetupChoice>): Promise<void> => {
  const file = projectPath.value
  if (!file) return
  const written = await writeProjectDesignSettings(
    file,
    {
      rules: setupRules.value,
      classes: setupClasses.value,
      patterns: savedPatterns.value,
      extraSizes: setupExtraSizes.value
    },
    choice
  )
  if (written) void emitProjectChange(null, fileChange('file-changed', file))
}

const applyStackupSpec = (spec: StackupSpec, label: string, mergeKey?: string): void => {
  const b = board.value
  if (!b || props.isReadOnly) return
  // Note: this regenerates the whole stackup from the spec, so per-row hand
  // edits made outside Board Setup are not preserved across a change here.
  runCommand(label, () => setBoardStackupInAST(b, spec), mergeKey ? { mergeKey } : undefined)
}

/** Applying a profile seeds all three halves at once — the whole point of it. */
const applyProfile = async (id: string): Promise<void> => {
  const profile = findAnyProfile(id)
  if (!profile) return
  setupProfileId.value = profile.id
  setupEdited.value = false
  setupRules.value = { ...profile.rules }
  // A profile seeds the Default class only — it has no opinion on how many
  // classes a design wants, so any the user added keep their own geometry.
  setupClasses.value = setupClasses.value.map((netClass) =>
    netClass.name === DEFAULT_CLASS_NAME ? { ...netClass, ...profile.defaults } : netClass
  )
  // A saved configuration carries no build: the stackup stays as it is.
  if (profile.stackups.length) {
    setupStackupId.value = profile.stackups[0].id
    applyStackupSpec(defaultStackupOf(profile), t('pcbEditor.commands.applyProfile'))
  }
  await persistDesignRules({ profile: profile.id, stackup: setupStackupId.value })
}

/** The Default class's sizes, which a configuration seeds. */
const defaultClassSizes = (): RoutingDefaults => {
  const fallback = setupClasses.value.find((c) => c.name === DEFAULT_CLASS_NAME)
  return {
    trackWidth: fallback?.trackWidth ?? 0.25,
    clearance: fallback?.clearance ?? 0.2,
    viaDiameter: fallback?.viaDiameter ?? 0.6,
    viaDrill: fallback?.viaDrill ?? 0.3
  }
}

/** Save the section's values as the user's own preset, and pick it. */
const onSavePreset = async (section: string, name: string): Promise<void> => {
  if (section === 'constraints') {
    const id = saveUserProfile(name, setupRules.value, defaultClassSizes())
    if (!id) return
    setupProfileId.value = id
    setupEdited.value = false
    if (await persistSetupChoice({ profile: id }))
      void emitProjectChange(null, fileChange('file-changed', projectPath.value!))
  } else if (section === 'stackup') {
    const id = saveUserStackup(name, setupStackup.value)
    if (!id) return
    setupStackupId.value = id
    if (await persistSetupChoice({ stackup: id }))
      void emitProjectChange(null, fileChange('file-changed', projectPath.value!))
  }
}

/** Remove the picked preset, the user's own only; the board keeps its values, now Custom. */
const onRemovePreset = async (section: string): Promise<void> => {
  if (section === 'constraints' && isUserPresetId(setupProfileId.value)) {
    removeUserProfile(setupProfileId.value)
    await chooseCustom('profile')
  } else if (section === 'stackup' && isUserPresetId(setupStackupId.value)) {
    removeUserStackup(setupStackupId.value)
    await chooseCustom('stackup')
  }
}

/** Custom: the values stay exactly as they are, and no preset is named. */
const chooseCustom = async (half: keyof BoardSetupChoice): Promise<void> => {
  if (half === 'profile') {
    setupProfileId.value = null
    setupEdited.value = false
  } else setupStackupId.value = null
  if (await persistSetupChoice({ [half]: null }))
    void emitProjectChange(null, fileChange('file-changed', projectPath.value!))
}

const onBoardSetupEdit = async (
  section: string,
  key: string,
  value: PropertyEditValue
): Promise<void> => {
  if (props.isReadOnly) return
  if (section === 'profile') {
    if (value === CUSTOM_PRESET_ID) await chooseCustom('profile')
    else if (typeof value === 'string') await applyProfile(value)
    return
  }
  if (section === 'stackup' && key === 'stackupId') {
    if (value === CUSTOM_PRESET_ID) return chooseCustom('stackup')
    const preset = typeof value === 'string' ? findAnyStackupPreset(value) : null
    if (!preset) return
    setupStackupId.value = preset.id
    applyStackupSpec(preset.spec, t('pcbEditor.commands.applyStackup'))
    if (await persistSetupChoice({ stackup: preset.id }))
      void emitProjectChange(null, fileChange('file-changed', projectPath.value!))
    return
  }

  const next = applyBoardSetupEdit(boardSetupModel.value, section, key, value)
  if (next === boardSetupModel.value) return
  if (section === 'tuningPatterns') {
    saveTuneDefaults(next.tuning)
    return
  }
  if (section === 'teardrops') {
    saveTeardropDefaults(next.teardrops)
    return
  }
  setupEdited.value = next.edited
  if (section === 'stackup') {
    leaveStackupPreset()
    applyStackupSpec(next.stackup, t('pcbEditor.commands.editStackup'), `stackup:${key}`)
    return
  }
  await commitSetupModel(next)
}

/** Fold a new model back into state and persist the project-file half. */
const commitSetupModel = async (next: BoardSetupModel): Promise<void> => {
  setupEdited.value = next.edited
  setupRules.value = next.rules
  setupClasses.value = [...next.classes]
  syncSetupTuning(next)
  setupPatterns.value = [...next.patterns]
  setupExtraSizes.value = {
    tracks: [...next.extraSizes.tracks],
    vias: [...next.extraSizes.vias]
  }
  await persistDesignRules()
}

const onNetClassEdit = async (
  index: number,
  column: NetClassEditColumn,
  value: PropertyEditValue
): Promise<void> => {
  if (props.isReadOnly) return
  const next = editNetClass(boardSetupModel.value, index, column, value)
  if (next !== boardSetupModel.value) await commitSetupModel(next)
}

const onImportClassColors = async (): Promise<void> => {
  if (props.isReadOnly) return
  const next = importSchematicColors(boardSetupModel.value)
  if (next !== boardSetupModel.value) await commitSetupModel(next)
}

const onAddNetClass = async (): Promise<void> => {
  if (props.isReadOnly) return
  const next = addNetClass(boardSetupModel.value, t('boardSetup.netClasses.newName'))
  if (next !== boardSetupModel.value) await commitSetupModel(next)
}

const onRemoveNetClass = async (index: number): Promise<void> => {
  if (props.isReadOnly) return
  const next = removeNetClass(boardSetupModel.value, index)
  if (next !== boardSetupModel.value) await commitSetupModel(next)
}

const onPatternEdit = async (
  index: number,
  field: 'pattern' | 'netClass',
  value: PropertyEditValue
): Promise<void> => {
  if (props.isReadOnly) return
  const next = editNetClassPattern(boardSetupModel.value, index, field, value)
  if (next !== boardSetupModel.value) await commitSetupModel(next)
}

const onAddPattern = async (): Promise<void> => {
  if (props.isReadOnly) return
  const next = addNetClassPattern(boardSetupModel.value)
  if (next !== boardSetupModel.value) await commitSetupModel(next)
}

const onExtraSizeEdit = async (
  kind: 'track' | 'via',
  index: number,
  field: ExtraSizeField,
  value: PropertyEditValue
): Promise<void> => {
  if (props.isReadOnly) return
  const next = editExtraSize(boardSetupModel.value, kind, index, field, value)
  if (next !== boardSetupModel.value) await commitSetupModel(next)
}

const onAddExtraSize = async (kind: 'track' | 'via'): Promise<void> => {
  if (props.isReadOnly) return
  await commitSetupModel(addExtraSize(boardSetupModel.value, kind))
}

const onRemoveExtraSize = async (kind: 'track' | 'via', index: number): Promise<void> => {
  if (props.isReadOnly) return
  const next = removeExtraSize(boardSetupModel.value, kind, index)
  if (next !== boardSetupModel.value) await commitSetupModel(next)
}

const onRemovePattern = async (index: number): Promise<void> => {
  if (props.isReadOnly) return
  const next = removeNetClassPattern(boardSetupModel.value, index)
  if (next !== boardSetupModel.value) await commitSetupModel(next)
}

/** The checks and the router read the profiles at once, before the file round-trips. */
const syncSetupTuning = (next: BoardSetupModel): void => {
  const classProfiles = Object.fromEntries(next.classes.map((c) => [c.name, c.tuningProfile ?? '']))
  if (
    !setupTuning.value &&
    !next.tuningProfiles.length &&
    !Object.values(classProfiles).some(Boolean)
  )
    return
  setupTuning.value = tuningSettingsOf(next.tuningProfiles, classProfiles)
}

/**
 * A tuning profile edit (Board Setup's Tuning profiles): the profiles are
 * written whole, and the classes too where a rename or removal reached them.
 */
const commitTuningProfiles = async (next: BoardSetupModel): Promise<void> => {
  const before = boardSetupModel.value
  if (next === before) return
  // An edit is a new question: the last Solve's refusals no longer answer it.
  if (profileSolveErrors.value.size) profileSolveErrors.value = new Map()
  syncSetupTuning(next)
  const file = projectPath.value
  if (file) {
    const written = await writeProjectTuningProfiles(file, next.tuningProfiles)
    if (written) void emitProjectChange(null, fileChange('file-changed', file))
  }
  if (next.classes !== before.classes) await commitSetupModel(next)
}

/** Solve rows of a profile for its target, as KiCad's calculator does; a refusal shows in the row. */
const solveProfileRows = async (index: number, rows: readonly number[]): Promise<void> => {
  if (props.isReadOnly) return
  let next = boardSetupModel.value
  const profile = next.tuningProfiles[index]
  if (!profile) return
  const errors = new Map<string, ProfileSolveError>()
  for (const row of rows) {
    const layer = profile.layers[row]
    if (!layer) continue
    const solved = solveProfileRow(solverStackup.value, profile, layer)
    if (solved.ok) next = applyLayerSolve(next, index, row, solved.solve)
    else errors.set(solveErrorKey(profile.name, layer.layer), solved.error)
  }
  await commitTuningProfiles(next)
  profileSolveErrors.value = errors
}
const onSolveProfileLayer = (index: number, row: number): Promise<void> =>
  solveProfileRows(index, [row])
const onSolveProfile = (index: number): Promise<void> =>
  solveProfileRows(
    index,
    (boardSetupModel.value.tuningProfiles[index]?.layers ?? []).map((_, row) => row)
  )

// ---------------------------------------------------------------------------
// Interface presets (lib/board/interfacePresets.ts): an interface's budget as
// a profile, a class and rules for the nets the user names; never looked for.
// ---------------------------------------------------------------------------

/** The draft on Board Setup's Net classes while one is open: what it asks for. */
const presetRequest = ref<PresetRequest | null>(null)
const presetApplying = ref(false)
const openPresetSource = (url: string): void => void window.api.partsOpenExternal(url)
const startPresetDraft = (): void => {
  if (props.isReadOnly || !board.value || !projectPath.value || presetRequest.value) return
  // An existing class: the preset's own name where the project has it (the schematic's USB).
  const first = INTERFACE_PRESETS[0]
  const classes = boardSetupModel.value.classes.filter((c) => c.name !== DEFAULT_CLASS_NAME)
  const netClass = classes.find((c) => c.name === first.className)?.name ?? classes[0]?.name
  if (!netClass) return
  presetRequest.value = { preset: first.id, mode: first.defaultMode, netClass }
}
const presetResult = computed(() => (presetRequest.value ? planPreset(presetRequest.value) : null))
const presetPreview = computed(() => {
  const result = presetResult.value
  return result?.ok
    ? previewPreset(boardSetupModel.value, setupCustomRules.value, result.plan)
    : null
})
/** What the draft's solve reads besides its choices: the stackup per solved layer, the fab's limits. */
const presetInputs = computed((): PresetInputs => {
  const model = boardSetupModel.value
  const result = presetResult.value
  const profile = result?.ok
    ? result.plan.tuningProfiles.find((p) => p.name === result.plan.profileName)
    : undefined
  const mm = (m: number): string => `${Math.round(m * 1e7) / 1e4}`
  return {
    copperLayers: model.stackup.copperLayers,
    boardThickness: model.stackup.boardThickness,
    minTrackWidth: model.rules.minTrackWidth,
    minClearance: model.rules.minClearance,
    defaultClearance: model.classes.find((c) => c.name === DEFAULT_CLASS_NAME)?.clearance ?? 0,
    layers: (profile?.layers ?? []).flatMap((row) => {
      const read = boardParameters({
        stackup: solverStackup.value,
        signalLayer: row.layer,
        ...(row.topReference ? { topReference: row.topReference } : {}),
        ...(row.bottomReference ? { bottomReference: row.bottomReference } : {}),
        differential: false
      })
      if (!read.ok) return []
      const { params } = read
      const refs = [row.topReference, row.bottomReference].filter(Boolean)
      return [
        {
          layer: row.layer,
          references: refs.join(' / '),
          heights:
            refs.length > 1
              ? `${mm(params.topHeightM)} / ${mm(params.bottomHeightM)}`
              : mm(params.topHeightM),
          epsilonR: params.epsilonR,
          copperMm: params.signalThicknessM * 1000
        }
      ]
    })
  }
})
/** The custom rules a draft writes, as Custom rules lists them, each marked added or changed. */
const presetRules = computed(() => {
  const preview = presetPreview.value
  const result = presetResult.value
  if (!preview || !result?.ok) return []
  const names = new Set(result.plan.rules.map((r) => r.name))
  return customRuleRows(preview.rulesText)
    .rows.filter((row) => names.has(row.rule))
    .map((row) => {
      const pending = preview.pending.rules.get(row.rule)
      return pending ? { ...row, pending } : row
    })
})
const presetClassBefore = computed(() =>
  boardSetupModel.value.classes.find((c) => c.name === presetRequest.value?.netClass)
)
const presetClassOptions = computed(() =>
  netClassOptions(boardSetupModel.value.classes.filter((c) => c.name !== DEFAULT_CLASS_NAME))
)
const presetCopper = computed(() =>
  copperNamesFor(boardSetupModel.value.stackup.copperLayers).map((name) => ({
    name,
    color: layerColors.value[name] ?? 'transparent'
  }))
)
const applyPresetDraft = async (): Promise<void> => {
  const result = presetResult.value
  if (!result?.ok || presetApplying.value) return
  presetApplying.value = true
  try {
    await applyPreset(result.plan)
    presetRequest.value = null
  } finally {
    presetApplying.value = false
  }
}
/** Plan a preset over the board as it stands: its nets, copper, classes and profiles. */
const planPreset = (request: PresetRequest): ReturnType<typeof planInterfacePreset> => {
  const b = board.value
  const model = boardSetupModel.value
  return planInterfacePreset(
    {
      copperLayers: copperNamesFor(model.stackup.copperLayers),
      netNames: b ? assignableNets(netsInUse(b)) : [],
      classes: model.classes,
      // The page's rows, a just-added empty one too, so a draft's tables keep showing it.
      patterns: model.patterns,
      assignments: setupAssignments.value,
      tuningProfiles: model.tuningProfiles,
      minClearance: model.rules.minClearance,
      minTrackWidth: model.rules.minTrackWidth
    },
    request,
    stackupSolver(solverStackup.value)
  )
}
/** Write a preset's plan: the profile, class and patterns to the project, its rules to `.kicad_dru`. */
const applyPreset = async (plan: PresetPlan): Promise<void> => {
  const file = projectPath.value
  if (!file || props.isReadOnly) return
  const before = boardSetupModel.value
  const next: BoardSetupModel = {
    ...before,
    tuningProfiles: plan.tuningProfiles,
    classes: plan.classes,
    patterns: plan.patterns,
    edited: true
  }
  syncSetupTuning(next)
  if (!(await writeProjectTuningProfiles(file, next.tuningProfiles)))
    throw new Error(t('boardSetup.interfacePreset.writeFailed', { file }))
  await commitSetupModel(next)
  const rulesFile = customRulesPath(file)
  const rules = patchRules(setupCustomRules.value, presetRuleNames(plan.profileName), plan.rules)
  if (rules !== (setupCustomRules.value ?? '')) {
    const written = await window.api.createFile(rulesFile, rules)
    if (!written.success)
      throw new Error(t('boardSetup.interfacePreset.writeFailed', { file: rulesFile }))
    setupCustomRules.value = rules
    void emitProjectChange(null, fileChange('file-changed', rulesFile))
  }
}

/** Write the project's custom rules and say so, as Board Setup's other writes do. */
const writeCustomRules = async (text: string): Promise<boolean> => {
  const file = projectPath.value
  if (!file || props.isReadOnly) return false
  const rulesFile = customRulesPath(file)
  const written = await window.api.createFile(rulesFile, text)
  if (!written.success) return false
  setupCustomRules.value = text
  void emitProjectChange(null, fileChange('file-changed', rulesFile))
  return true
}
/** Custom rules: a rule typed in place of another (or new), checked as KiCad reads the file first. */
const saveCustomRule = async (name: string | null, text: string): Promise<string[]> => {
  const edited = editCustomRule(setupCustomRules.value, name, text, board.value?.layers ?? [])
  if (!edited.ok) return edited.errors
  return (await writeCustomRules(edited.text))
    ? []
    : [
        t('boardSetup.interfacePreset.writeFailed', {
          file: customRulesPath(projectPath.value ?? '')
        })
      ]
}
const deleteCustomRule = async (name: string): Promise<void> => {
  await writeCustomRules(removeCustomRule(setupCustomRules.value, name))
}

const onAddTuningProfile = async (): Promise<void> => {
  if (props.isReadOnly) return
  await commitTuningProfiles(
    addTuningProfile(boardSetupModel.value, t('boardSetup.tuningProfiles.newName'))
  )
}
const onRemoveTuningProfile = async (index: number): Promise<void> => {
  if (props.isReadOnly) return
  await commitTuningProfiles(removeTuningProfile(boardSetupModel.value, index))
}
const onEditTuningProfile = async (
  index: number,
  field: ProfileField,
  value: PropertyEditValue
): Promise<void> => {
  if (props.isReadOnly) return
  await commitTuningProfiles(editTuningProfile(boardSetupModel.value, index, field, value))
}
const onAddProfileLayer = async (index: number): Promise<void> => {
  if (props.isReadOnly) return
  const copper = copperNamesFor(boardSetupModel.value.stackup.copperLayers)
  await commitTuningProfiles(addProfileLayer(boardSetupModel.value, index, copper))
}
const onRemoveProfileLayer = async (index: number, row: number): Promise<void> => {
  if (props.isReadOnly) return
  await commitTuningProfiles(removeProfileLayer(boardSetupModel.value, index, row))
}
const onEditProfileLayer = async (
  index: number,
  row: number,
  column: ProfileLayerColumn,
  value: PropertyEditValue
): Promise<void> => {
  if (props.isReadOnly) return
  await commitTuningProfiles(editProfileLayer(boardSetupModel.value, index, row, column, value))
}

/**
 * One cell of the stackup table. Layers are the source of truth, so this edits
 * the row in place (undoable, lossless) instead of regenerating the stackup —
 * which is what makes hand edits survive. Applying a preset is the only path
 * that rewrites the whole node.
 */
const onStackupLayerEdit = (
  index: number,
  column: StackupColumn,
  value: PropertyEditValue
): void => {
  const stackup = board.value?.stackup
  const layer = stackup?.layers[index]
  if (!stackup || !layer || props.isReadOnly) return
  const patch = stackupLayerPatch(column, value)
  if (!patch) return
  // A hand edit means the board no longer matches a catalog build.
  leaveStackupPreset()
  setupEdited.value = true
  runCommand(
    t('pcbEditor.commands.editStackup'),
    () => updateStackupLayerInAST(stackup, layer, patch),
    { mergeKey: `stackup:${index}:${column}` }
  )
}

const onAddDielectric = (afterIndex: number): void => {
  const stackup = board.value?.stackup
  if (!stackup || props.isReadOnly) return
  leaveStackupPreset()
  runCommand(t('pcbEditor.commands.addDielectric'), () =>
    addStackupDielectricInAST(stackup, afterIndex)
  )
}

const onRemoveLayer = (index: number): void => {
  const stackup = board.value?.stackup
  if (!stackup || props.isReadOnly) return
  leaveStackupPreset()
  runCommand(t('pcbEditor.commands.removeLayer'), () => removeStackupLayerInAST(stackup, index))
}

const handleUpdateGrid = (settings: Partial<GridSettings>): void => {
  gridSettings.value = updateGridSettings(gridSettings.value, settings, PCB_UNIT_SPACINGS)
}

/** What the Layers panel lists, in the bar or behind the active-layer pill. */
const layerListing = computed(() =>
  boardLayerListing(board.value, (key) => t(`shared.layerPresets.${key}`))
)

const handleToggleLayerVisibility = (layer: string): void => {
  layerVisibility.value = {
    ...layerVisibility.value,
    [layer]: !(layerVisibility.value[layer] ?? true)
  }
}

const handleApplyLayerPreset = (visibility: Record<string, boolean>): void => {
  const next = { ...layerVisibility.value }
  for (const [layer, on] of Object.entries(visibility)) {
    if (next[layer] !== undefined) next[layer] = on
  }
  layerVisibility.value = next
}

const handleSetActiveLayer = (layer: string): void => {
  activeLayer.value = layer
  if (isCopperLayer(layer)) lastCopperLayer.value = layer
  layerVisibility.value = { ...layerVisibility.value, [layer]: true }
}

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

// Bindings live in lib/hotkeys.ts.
/** Zoom to fit: the whole board in layout, the camera's home in 3D. */
const fitView = (): void => {
  if (activeMode.value === '3d') viewportRef.value?.fit3D()
  else viewportRef.value?.zoomToFit()
}

/** Esc (R21): the gesture in hand ends at once, keeping what was clicked; else the tool goes. */
const runEscape = (): void => {
  switch (
    escapeAction({
      drag: trackDrag.value !== null,
      tune: tuneSession.value !== null,
      pair: pairActive.value,
      route: routeTail.value !== null,
      draft: toolDraft.value.length > 0,
      toolArmed: activeTool.value !== 'select'
    })
  ) {
    case 'endDrag':
      return endTrackDrag()
    case 'endTune':
      return endTune()
    case 'endPair':
      return commitPair()
    case 'endRoute':
      return commitRoute()
    case 'clearDraft':
      toolDraft.value = []
      return
    case 'putToolAway':
      // A via armed for the next route goes with the tool (R37).
      return setTool('select')
    case 'clearSelection':
      selectedItems.value = []
  }
}

const handleKeydown = (e: KeyboardEvent): void => {
  if (matchesHotkey(e, 'editor.undo')) {
    e.preventDefault()
    // Undo removes the thing being done RIGHT NOW first (§6.7e): a live
    // gesture, then history. Also insulates history from mutating under an
    // active engine session.
    const target = undoTarget(liveGestures())
    if (target === 'drag') endTrackDrag()
    else if (target === 'pair') pairDraft.value ? unpairLast() : endPair()
    else if (target === 'tune') tuneSession.value ? cancelTuneSession() : endTune()
    else if (target === 'route') route.undoStep()
    else undo()
    return
  }
  if (matchesHotkey(e, 'editor.redo')) {
    e.preventDefault()
    // Nothing a gesture took back can come back mid-gesture (R22).
    if (redoAllowed(liveGestures())) redo()
    return
  }
  if (activeMode.value === 'visual' && find.keydown(e)) return

  // The Fanout overlay, from the canvas as from inside it: Enter runs it, and
  // Escape closes it before it drops the selection the overlay is working on.
  if (fanoutOpen.value && activeMode.value === 'visual' && !isTypingTarget()) {
    if (matchesHotkey(e, 'pcb.finish')) {
      e.preventDefault()
      applyFanoutPreview()
      return
    }
    if (matchesHotkey(e, 'editor.cancel')) {
      e.preventDefault()
      fanoutOpen.value = false
      return
    }
  }

  if (
    matchesHotkey(e, 'editor.fitView') &&
    !isTypingTarget() &&
    (activeMode.value === 'visual' || activeMode.value === '3d')
  ) {
    e.preventDefault()
    fitView()
    return
  }

  if (matchesHotkey(e, 'editor.selectAll')) {
    if (selectAllInField(e)) return
    e.preventDefault()
    // Mid-gesture the selection is not the user's to replace.
    if (activeMode.value === 'visual' && !trackDrag.value && !routeTail.value) selectAll()
    return
  }

  if (isTypingTarget() || activeMode.value !== 'visual') return

  const viewCommand = viewCommandFor(e)
  if (viewCommand) {
    e.preventDefault()
    viewportRef.value?.runViewCommand(viewCommand)
    return
  }
  // Highlight Net is a view: any tool, mid-route too, and on a read-only board.
  if (matchesHotkey(e, 'pcb.highlightNet') || matchesHotkey(e, 'pcb.clearHighlight')) {
    e.preventDefault()
    if (matchesHotkey(e, 'pcb.highlightNet')) highlightNetAtPointer()
    else setHighlightedNet(0)
    return
  }
  if (matchesHotkey(e, 'editor.cancel') && move.active()) {
    e.preventDefault()
    move.cancel()
    return
  }
  const grid = gridKeyUpdate(e, 'pcb', gridSettings.value, PCB_UNIT_SPACINGS)
  if (grid) {
    e.preventDefault()
    handleUpdateGrid(grid)
    return
  }

  if (pairActive.value) {
    if (matchesHotkey(e, 'pcb.endRoute') && pairDraft.value) {
      e.preventDefault()
      finishPair()
      return
    }
    if (matchesHotkey(e, 'pcb.unrouteLast')) {
      e.preventDefault()
      unpairLast()
      return
    }
    if (matchesHotkey(e, 'pcb.trackWidthNext') || matchesHotkey(e, 'pcb.trackWidthPrev')) {
      e.preventDefault()
      stepPairSize(matchesHotkey(e, 'pcb.trackWidthNext') ? 1 : -1)
      return
    }
    if (matchesHotkey(e, 'pcb.routeVia') && pairDraft.value) {
      e.preventDefault()
      pairDraft.value = { ...pairDraft.value, armedVia: !pairDraft.value.armedVia }
      if (lastPairCursor) handlePairMove(lastPairCursor)
      return
    }
  }
  if (tuneActive.value && matchesHotkey(e, 'editor.cancel')) {
    // KiCad's: Esc drops the pattern in hand, and with none leaves the tuner.
    // The keys card is the topmost thing open: Esc closes it first, as while routing.
    e.preventDefault()
    if (routeKeysOpen.value) routeKeysOpen.value = false
    else if (tuneSession.value) cancelTuneSession()
    else endTune()
    return
  }
  if (tuneActive.value && matchesHotkey(e, 'pcb.tuneSettings')) {
    e.preventDefault()
    tuneSettingsForm.value = { ...lastPointer }
    return
  }
  if (tuneActive.value)
    for (const [action, what, sign] of [
      ['pcb.tuneSpacingIncrease', 'spacing', 1],
      ['pcb.tuneSpacingDecrease', 'spacing', -1],
      ['pcb.tuneAmplitudeIncrease', 'amplitude', 1],
      ['pcb.tuneAmplitudeDecrease', 'amplitude', -1]
    ] as const)
      if (matchesHotkey(e, action)) {
        e.preventDefault()
        // KiCad's: the keys shape a pattern in hand, and with none say so.
        if (tuneSession.value) stepTune(what, sign)
        else refuseTune(t('pcbEditor.tune.coach.selectFirst'))
        return
      }
  for (const [action, mode] of [
    ['pcb.tuneSingle', 'single'],
    ['pcb.tunePair', 'pair'],
    ['pcb.tuneSkew', 'skew']
  ] as const)
    if (matchesHotkey(e, action) && !props.isReadOnly && !tuneSession.value) {
      e.preventDefault()
      beginTune(mode)
      return
    }
  if (matchesHotkey(e, 'pcb.routeDiffPair') && !props.isReadOnly && !pairActive.value) {
    e.preventDefault()
    beginPair()
    return
  }
  if (matchesHotkey(e, 'editor.cancel') && routeKeysOpen.value && keysCardAllowed.value) {
    // The keys card is the topmost thing open: Esc closes it and leaves the route alone.
    e.preventDefault()
    routeKeysOpen.value = false
  } else if (matchesHotkey(e, 'editor.cancel')) {
    e.preventDefault()
    // Esc ends a Route Selected run; what is clicked lands as it always does.
    routeQueue.value = []
    runEscape()
  } else if (matchesHotkey(e, 'pcb.toggleRender')) {
    e.preventDefault()
    // A cycling action on key repeat strobes through states. This is a toggle,
    // so one physical key press must produce exactly one transition.
    if (!e.repeat) toggleAssemblyOverlay()
  } else if (matchesHotkey(e, 'pcb.tool.route') && !props.isReadOnly) {
    // KiCad's immediate action (§6.7c): X starts the trace AT the cursor,
    // magnet-adjusted onto the pad/track-end under it. Arm-only when the
    // pointer is off the canvas or a trace is already live.
    setTool('route')
    const cursor = viewportRef.value?.getCursor()
    if (cursor && !routeTail.value) {
      const magnet = viewportRef.value?.routeMagnetAt(cursor) ?? null
      beginRoute(magnet?.point ?? cursor, {
        net: magnet?.net,
        trackWidth: magnet?.trackWidth,
        layers: magnet?.layers,
        cursor
      })
    }
  } else if (
    activeTool.value === 'select' &&
    ((matchesHotkey(e, 'pcb.trackWidthNext') && stepSelectedSizes('width', 1)) ||
      (matchesHotkey(e, 'pcb.trackWidthPrev') && stepSelectedSizes('width', -1)) ||
      (matchesHotkey(e, 'pcb.viaSizeNext') && stepSelectedSizes('via', 1)) ||
      (matchesHotkey(e, 'pcb.viaSizePrev') && stepSelectedSizes('via', -1)))
  ) {
    e.preventDefault()
  } else if (activeTool.value === 'route' && matchesHotkey(e, 'pcb.trackWidthNext')) {
    e.preventDefault()
    usedKey('pcb.trackWidthNext')
    stepWidth(1)
  } else if (activeTool.value === 'route' && matchesHotkey(e, 'pcb.trackWidthPrev')) {
    e.preventDefault()
    usedKey('pcb.trackWidthPrev')
    stepWidth(-1)
  } else if (placesVias.value && matchesHotkey(e, 'pcb.viaSizeNext')) {
    e.preventDefault()
    usedKey('pcb.viaSizeNext')
    stepVia(1)
  } else if (placesVias.value && matchesHotkey(e, 'pcb.viaSizePrev')) {
    e.preventDefault()
    usedKey('pcb.viaSizeNext')
    stepVia(-1)
  } else if (keysCardAllowed.value && matchesHotkey(e, 'pcb.routeKeys')) {
    e.preventDefault()
    usedKey('pcb.routeKeys')
    routeKeysOpen.value = !routeKeysOpen.value
  } else if (placesVias.value && matchesHotkey(e, 'pcb.routeSizes')) {
    // KiCad's Q: the Custom Track/Via Size form, at the pointer (S6).
    e.preventDefault()
    customSize.value = { ...lastPointer }
  } else if (matchesHotkey(e, 'pcb.routeFromOtherEnd') && activeTool.value === 'route') {
    e.preventDefault()
    routeFromOtherEnd()
  } else if (matchesHotkey(e, 'pcb.routeSelected') && !props.isReadOnly) {
    e.preventDefault()
    queueSelectedRoutes(false)
  } else if (matchesHotkey(e, 'pcb.routeSelectedFromEnd') && !props.isReadOnly) {
    e.preventDefault()
    queueSelectedRoutes(true)
  } else if (matchesHotkey(e, 'pcb.routeBlindVia') && activeTool.value === 'route') {
    e.preventDefault()
    if (routeTail.value) route.armVia(undefined, 'blind')
  } else if (
    matchesHotkey(e, 'pcb.paste') &&
    activeTool.value === 'route' &&
    routeTail.value &&
    !props.isReadOnly
  ) {
    // Mid-route Ctrl+V is KiCad's microvia; paste waits for the route to end.
    e.preventDefault()
    route.armVia(undefined, 'micro')
  } else if (matchesHotkey(e, 'pcb.routeViaPickLayer') && activeTool.value === 'route') {
    e.preventDefault()
    pickViaLayer('through')
  } else if (matchesHotkey(e, 'pcb.routeBlindViaPickLayer') && activeTool.value === 'route') {
    e.preventDefault()
    pickViaLayer('blind')
  } else if (matchesHotkey(e, 'pcb.layerPairNext') && !props.isReadOnly) {
    e.preventDefault()
    cycleLayerPair()
  } else if (matchesHotkey(e, 'pcb.routeVia') && activeTool.value === 'route') {
    e.preventDefault()
    usedKey('pcb.routeVia')
    if (routeTail.value) route.armVia()
    else route.setStartVia(!routeStartVia.value)
  } else if (matchesHotkey(e, 'pcb.tool.via') && !props.isReadOnly) {
    e.preventDefault()
    setTool('via')
  } else if (matchesHotkey(e, 'pcb.routePosture') && activeTool.value === 'route') {
    // Mid-route `/` flips the elbow posture; idle it falls through to search
    // (the schematic wire tool's idiom).
    e.preventDefault()
    usedKey('pcb.routePosture')
    route.flipPosture()
  } else if (matchesHotkey(e, 'pcb.routeCorner') && activeTool.value === 'route') {
    e.preventDefault()
    usedKey('pcb.routeCorner')
    nextRouteCorner()
  } else if (matchesHotkey(e, 'pcb.lineMode') && takesLineMode(activeTool.value)) {
    e.preventDefault()
    lineMode.value = nextRouteCornerMode(lineMode.value)
  } else if (matchesHotkey(e, 'pcb.tool.line') && !props.isReadOnly) {
    e.preventDefault()
    setTool('line')
    startGestureAtCursor()
  } else if (matchesHotkey(e, 'pcb.tool.arc') && !props.isReadOnly) {
    e.preventDefault()
    setTool('arc')
    startGestureAtCursor()
  } else if (matchesHotkey(e, 'pcb.tool.circle') && !props.isReadOnly) {
    e.preventDefault()
    setTool('circle')
    startGestureAtCursor()
  } else if (matchesHotkey(e, 'pcb.tool.polygon') && !props.isReadOnly) {
    e.preventDefault()
    setTool('polygon')
    startGestureAtCursor()
  } else if (matchesHotkey(e, 'pcb.tool.bezier') && !props.isReadOnly) {
    e.preventDefault()
    setTool('bezier')
    startGestureAtCursor()
  } else if (matchesHotkey(e, 'pcb.tool.text') && !props.isReadOnly) {
    e.preventDefault()
    setTool('text')
  } else if (matchesHotkey(e, 'pcb.tool.zone') && !props.isReadOnly) {
    e.preventDefault()
    setTool('zone')
    startGestureAtCursor()
  } else if (matchesHotkey(e, 'pcb.sketchTracks')) {
    e.preventDefault()
    // A toggle: one press, one transition, however long the key is held.
    if (!e.repeat) setPcbView({ sketchTracks: !pcbView.value.sketchTracks })
  } else if (matchesHotkey(e, 'pcb.cycleRouteMode')) {
    e.preventDefault()
    if (!e.repeat) cycleRouteMode()
  } else if (matchesHotkey(e, 'pcb.cycleInactiveLayers')) {
    e.preventDefault()
    if (!e.repeat) nonActiveDisplay.value = nextNonActiveDisplay(nonActiveDisplay.value)
  } else if (matchesHotkey(e, 'pcb.toggleLock') && !props.isReadOnly) {
    e.preventDefault()
    if (!e.repeat) toggleLockSelected()
  } else if (matchesHotkey(e, 'pcb.selectConnection') && activeTool.value === 'select') {
    e.preventDefault()
    selectConnection()
  } else if (matchesHotkey(e, 'pcb.deleteFullTrack') && !props.isReadOnly) {
    e.preventDefault()
    deleteFullTrack()
  } else if (matchesHotkey(e, 'pcb.refillZones') && !props.isReadOnly) {
    e.preventDefault()
    refillNow()
  } else if (matchesHotkey(e, 'pcb.unrouteLast') && routeTail.value && !props.isReadOnly) {
    // Must outrank editor.delete, which also binds Backspace.
    e.preventDefault()
    unrouteLast()
  } else if (
    matchesHotkey(e, 'pcb.unrouteLast') &&
    !props.isReadOnly &&
    selectedItems.value.length > 0 &&
    selectedItems.value.every((ref) => ROUTED_TYPES.has(ref.type) || ref.type === 'tuning_pattern')
  ) {
    // Off the route, Backspace on routed copper unroutes it a step at a time.
    e.preventDefault()
    unrouteSegment()
  } else if (matchesHotkey(e, 'pcb.layerTop') && !props.isReadOnly) {
    e.preventDefault()
    switchLayerKey(copperLayerNames.value[0] ?? 'F.Cu')
  } else if (matchesHotkey(e, 'pcb.layerBottom') && !props.isReadOnly) {
    e.preventDefault()
    switchLayerKey(copperLayerNames.value[copperLayerNames.value.length - 1] ?? 'B.Cu')
  } else if (matchesHotkey(e, 'pcb.layerNext') && !props.isReadOnly) {
    e.preventDefault()
    switchLayerKey(stepCopperLayer(copperLayerNames.value, routingLayer.value, 1))
  } else if (matchesHotkey(e, 'pcb.layerPrev') && !props.isReadOnly) {
    e.preventDefault()
    switchLayerKey(stepCopperLayer(copperLayerNames.value, routingLayer.value, -1))
  } else if (
    matchesHotkey(e, 'pcb.finishRoute') &&
    activeTool.value === 'route' &&
    routeTail.value &&
    !props.isReadOnly
  ) {
    // Mid-route F finishes the trace; otherwise it falls through to flip.
    e.preventDefault()
    attemptAutoFinish()
  } else if (matchesHotkey(e, 'pcb.fanout') && canFanout.value) {
    e.preventDefault()
    openFanout()
  } else if (matchesHotkey(e, 'pcb.flip') && !props.isReadOnly) {
    e.preventDefault()
    flipHeldOrSelected()
  } else if (matchesHotkey(e, 'pcb.move') && !props.isReadOnly) {
    if (!trackDrag.value && activeTool.value === 'select') {
      e.preventDefault()
      move.start()
    }
  } else if (matchesHotkey(e, 'pcb.dragTrack') && !props.isReadOnly) {
    if (!trackDrag.value && activeTool.value === 'select') {
      e.preventDefault()
      beginTrackDrag()
    }
  } else if (matchesHotkey(e, 'pcb.dragTrackFree') && !props.isReadOnly) {
    if (!trackDrag.value && activeTool.value === 'select') {
      e.preventDefault()
      beginTrackDrag(true)
    }
  } else if (
    matchesHotkey(e, 'pcb.endRoute') &&
    activeTool.value === 'route' &&
    routeTail.value &&
    !props.isReadOnly
  ) {
    e.preventDefault()
    endRouteHere()
  } else if (matchesHotkey(e, 'pcb.rotate') && !props.isReadOnly) {
    turnHeldOrSelected(90)
  } else if (matchesHotkey(e, 'pcb.rotateClockwise') && !props.isReadOnly) {
    turnHeldOrSelected(-90)
  } else if (matchesHotkey(e, 'pcb.tool.footprint') && !props.isReadOnly) {
    e.preventDefault()
    openPlaceFootprint()
  } else if (matchesHotkey(e, 'editor.delete') && !props.isReadOnly) {
    deleteSelected()
  } else if (matchesHotkey(e, 'pcb.copy')) {
    e.preventDefault()
    copySelection()
  } else if (matchesHotkey(e, 'pcb.cut') && !props.isReadOnly && !routeTail.value) {
    e.preventDefault()
    cutSelection()
  } else if (matchesHotkey(e, 'pcb.paste') && !props.isReadOnly && !routeTail.value) {
    e.preventDefault()
    pasteClipboard()
  } else if (matchesHotkey(e, 'pcb.duplicate') && !props.isReadOnly && !routeTail.value) {
    e.preventDefault()
    duplicateSelection()
  } else if (matchesHotkey(e, 'editor.focusSearch')) {
    e.preventDefault()
    insertSearch.value?.focus()
  }
}

// ---------------------------------------------------------------------------
// Edit commands — published for the title bar's Edit menu (lib/editActions.ts),
// each named by the key it replays, as the other editors do.
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
      hotkey: 'pcb.cut' as HotkeyActionId,
      label: t('pcbEditor.edit.cut'),
      enabled: !props.isReadOnly && hasSelection.value
    },
    {
      hotkey: 'pcb.copy' as HotkeyActionId,
      label: t('pcbEditor.edit.copy'),
      enabled: hasSelection.value
    },
    {
      hotkey: 'pcb.paste' as HotkeyActionId,
      label: t('pcbEditor.edit.paste'),
      enabled: canPaste.value
    },
    {
      hotkey: 'pcb.duplicate' as HotkeyActionId,
      label: t('pcbEditor.edit.duplicate'),
      enabled: !props.isReadOnly && hasSelection.value
    },
    {
      hotkey: 'editor.delete' as HotkeyActionId,
      label: t('pcbEditor.edit.delete'),
      enabled: !props.isReadOnly && hasSelection.value
    }
  ],
  [
    {
      hotkey: 'editor.selectAll' as HotkeyActionId,
      label: t('common.selectAllLabel'),
      enabled: !!board.value
    }
  ],
  [
    {
      hotkey: 'pcb.rotate' as HotkeyActionId,
      label: t('pcbEditor.edit.rotate'),
      enabled: canTransform('rotateCCW')
    },
    {
      hotkey: 'pcb.rotateClockwise' as HotkeyActionId,
      label: t('pcbEditor.edit.rotateClockwise'),
      enabled: canTransform('rotateCW')
    },
    {
      hotkey: 'pcb.flip' as HotkeyActionId,
      label: t('pcbEditor.edit.flip'),
      enabled: canFlip.value
    },
    {
      hotkey: 'pcb.fanout' as HotkeyActionId,
      label: t('pcbEditor.edit.fanout'),
      enabled: canFanout.value
    }
  ]
])

usePublishedEditActions(editGroups)

// ---- Export image: the 3D view as a PNG (lib/board3dExport.ts) ----------------
/** The 3D pane's size while the dialog is open; null shuts it. */
const exportImageView = ref<PixelSize | null>(null)
const exportImageStatus = ref('')

const openExportImage = (): void => {
  const size = activeMode.value === '3d' ? viewportRef.value?.view3DSize() : null
  if (!size) return
  exportImageStatus.value = ''
  exportImageView.value = size
}

const previewExportImage = (size: PixelSize): string | null =>
  viewportRef.value?.export3DImage(size)?.toDataURL('image/png') ?? null

const saveExportImage = async (size: PixelSize): Promise<void> => {
  const target = await window.api.saveFileDialog(board3dExportPath(props.filePath, props.name))
  if (!target) return
  const picture = viewportRef.value?.export3DImage(size) ?? null
  const result = picture
    ? await window.api.writeFileBase64(target, canvasPngBase64(picture))
    : { success: false, error: undefined }
  if (result.success) {
    exportImageView.value = null
    return
  }
  await window.api.chooseDialog({
    message: t('pcbEditor.viewport3d.exportImage.failed'),
    detail: result.error,
    buttons: ['OK']
  })
}

const copyExportImage = async (size: PixelSize): Promise<void> => {
  const picture = viewportRef.value?.export3DImage(size) ?? null
  const copied = picture ? await copyCanvasPng(picture) : false
  exportImageStatus.value = copied
    ? t('pcbEditor.viewport3d.exportImage.copied')
    : t('pcbEditor.viewport3d.exportImage.copyFailed')
}

usePublishedExportActions(
  computed(() =>
    !board.value || activeMode.value === 'setup'
      ? []
      : [
          {
            id: 'export-board-3d-image',
            label: t('pcbEditor.viewport3d.exportImage.menu'),
            enabled: activeMode.value === '3d',
            disabledReason: t('pcbEditor.viewport3d.exportImage.needs3d'),
            run: openExportImage
          }
        ]
  )
)

// ---- Canvas context menu ------------------------------------------------------
// The Edit menu's commands on what was right-clicked, as the schematic's: each
// enabled only where it applies (Rotate, Change side, Fanout…), run by
// replaying its key so the menu and the shortcut cannot drift apart.
const canvasMenu = ref<{ x: number; y: number } | null>(null)
/** Where the canvas menu was opened, data-scene mm: where Break Track cuts. */
let canvasMenuPoint: { x: number; y: number } | null = null
/** The net Highlight Net would pick where the menu was opened; 0 for none. */
const canvasMenuNet = ref(0)

/** Right-click selects what is under the cursor first, keeping a selection it
 *  is part of — acting on what the user did not select is the classic trap. */
const onCanvasContextMenu = (payload: {
  clientX: number
  clientY: number
  hit: BoardItemRef | null
  point: { x: number; y: number }
}): void => {
  const { hit } = payload
  canvasMenuPoint = payload.point
  canvasMenuNet.value = highlightNetAt(payload.point, viewportRef.value?.getPointer()?.reach ?? 0)
  const same = (a: BoardItemRef, b: BoardItemRef): boolean =>
    a.type === b.type && a.index === b.index && a.pad === b.pad
  if (hit) {
    if (!selectedItems.value.some((item) => same(item, hit))) selectedItems.value = [hit]
  } else if (selectedItems.value.length) {
    selectedItems.value = []
  }
  canvasMenu.value = { x: payload.clientX, y: payload.clientY }
}

/**
 * Select Other and the net highlight, over what is at the menu's point:
 * Highlight Net while a net other than the lit one is there.
 */
const canvasViewItems = (): MenuNode[] => [
  { id: 'selectOther', label: t('shared.selectOther.menu') },
  ...(canvasMenuNet.value && canvasMenuNet.value !== highlightedNet.value
    ? [
        {
          id: 'pcb.highlightNet',
          label: t('shared.netHighlight.highlight'),
          shortcut: hotkeyLabel('pcb.highlightNet')
        }
      ]
    : []),
  ...(highlightedNet.value
    ? [
        {
          id: 'pcb.clearHighlight',
          label: t('shared.netHighlight.clearMenu'),
          shortcut: hotkeyLabel('pcb.clearHighlight')
        }
      ]
    : []),
  { divider: true }
]

// Undo and redo act on history, not on what was clicked: they stay in the Edit menu.
const canvasMenuItems = computed<MenuNode[]>(() => {
  const nodes = buildEditMenu(
    editGroups.value.map((group) =>
      group.filter((action) => action.hotkey !== 'editor.undo' && action.hotkey !== 'editor.redo')
    )
  )
  const editable = !props.isReadOnly
  // The schematic's Update / Change for symbols, for the footprints selected.
  const footprints: MenuNode[] =
    editable && selectedFootprints.value.length
      ? [
          { divider: true },
          { id: 'updateFootprints', label: t('pcbEditor.footprintUpdate.updateAction') },
          { id: 'changeFootprint', label: t('pcbEditor.footprintUpdate.changeAction') }
        ]
      : []
  // KiCad's Cleanup and Edit Track & Via Properties, over the tracks and vias selected.
  const copper: MenuNode[] = selectedCopper().length
    ? [
        { divider: true },
        {
          id: 'cleanupSelection',
          label: t('pcbEditor.cleanup.selectionAction'),
          disabled: !editable
        },
        { id: 'setSizes', label: t('pcbEditor.setSizes.action'), disabled: !editable }
      ]
    : []
  // KiCad's Edit Teardrops, over the pads and vias selected.
  const teardrops: MenuNode[] = selectedTeardropItems().length
    ? [
        ...(copper.length ? [] : [{ divider: true } as MenuNode]),
        {
          id: 'teardropsSelection',
          label: t('pcbEditor.teardrops.selectionAction'),
          disabled: !editable
        }
      ]
    : []
  const tracks = selectedTracks()
  const view = canvasViewItems()
  if (tracks.length === 0) return [...view, ...nodes, ...footprints, ...copper, ...teardrops]
  return [
    ...view,
    ...nodes,
    ...footprints,
    ...copper,
    ...teardrops,
    { divider: true },
    {
      id: 'breakTrack',
      label: t('pcbEditor.edit.breakTrack'),
      disabled: !editable || tracks.length !== 1 || tracks[0].type !== 'segment'
    },
    { id: 'trackLayerNext', label: t('pcbEditor.edit.trackLayerNext'), disabled: !editable },
    { id: 'trackLayerPrev', label: t('pcbEditor.edit.trackLayerPrev'), disabled: !editable },
    ...trackRouteItems(tracks)
  ]
})

/**
 * One track right-clicked: the pair and the tuners, started where it was
 * clicked, as their keys start them under the cursor. Pair entries only on a
 * pair half whose complement is on the board.
 */
const trackRouteItems = (tracks: BoardItemRef[]): MenuNode[] => {
  const b = board.value
  const seg =
    tracks.length === 1 && tracks[0].type === 'segment' ? b?.segments[tracks[0].index] : undefined
  if (!b || !seg || props.isReadOnly) return []
  const pair = matchDiffPair(getNetName(b, seg.net))
  const paired = pair !== null && b.nets.some((n) => n.name === pair.complement)
  const tune = (mode: TuneMode, action: HotkeyActionId): MenuNode => ({
    id: `tune:${mode}`,
    label: tuneToolLabel(mode),
    shortcut: hotkeyLabel(action)
  })
  return [
    { divider: true },
    ...(paired
      ? [
          {
            id: 'routeDiffPair',
            label: t('pcbEditor.pair.route'),
            shortcut: hotkeyLabel('pcb.routeDiffPair')
          }
        ]
      : []),
    tune('single', 'pcb.tuneSingle'),
    ...(paired ? [tune('pair', 'pcb.tunePair'), tune('skew', 'pcb.tuneSkew')] : [])
  ]
}

const onCanvasMenuSelect = (id: string): void => {
  const tuneMode = TUNE_TOOLS.find((tool) => `tune:${tool.mode}` === id)?.mode
  if (id === 'selectOther') {
    if (canvasMenu.value) viewportRef.value?.selectOtherAt(canvasMenu.value)
  } else if (id === 'pcb.highlightNet') setHighlightedNet(canvasMenuNet.value)
  else if (id === 'pcb.clearHighlight') setHighlightedNet(0)
  else if (id === 'breakTrack') breakTrackAt(canvasMenuPoint)
  else if (id === 'routeDiffPair') {
    armPair()
    if (pairArmed.value && canvasMenuPoint) startPairAt(canvasMenuPoint)
  } else if (tuneMode) {
    armTune(tuneMode)
    if (tuneArmed.value === tuneMode && canvasMenuPoint) startTuneAt(canvasMenuPoint)
  } else if (id === 'trackLayerNext') moveTracksLayer(1)
  else if (id === 'trackLayerPrev') moveTracksLayer(-1)
  else if (id === 'updateFootprints') openFootprintUpdate()
  else if (id === 'changeFootprint') openFootprintChange()
  else if (id === 'cleanupSelection') openCleanup(true)
  else if (id === 'teardropsSelection') openTeardrops(true)
  else if (id === 'setSizes') setSizesFromRules()
  else if (isHotkeyActionId(id)) dispatchEditAction(id)
}

/** The selected tracks and arcs. */
const selectedTracks = (): BoardItemRef[] =>
  selectedItems.value.filter((ref) => ref.type === 'segment' || ref.type === 'tarc')

/**
 * KiCad's Break Track: the selected segment split in two where it was
 * right-clicked, the point taken onto its centerline.
 */
const breakTrackAt = (at: { x: number; y: number } | null): void => {
  const b = board.value
  const ref = selectedTracks()[0]
  const seg = ref?.type === 'segment' ? b?.segments[ref.index] : undefined
  if (!b || !seg || !at || props.isReadOnly) return
  const ax = seg.start.x
  const ay = seg.start.y
  const ex = seg.end.x - ax
  const ey = seg.end.y - ay
  const len2 = ex * ex + ey * ey
  if (len2 === 0) return
  const px = mmToNm(at.x)
  const py = mmToNm(-at.y)
  const along = ((px - ax) * ex + (py - ay) * ey) / len2
  if (along <= 0 || along >= 1) return
  const cut = { x: nm(Math.round(ax + along * ex)), y: nm(Math.round(ay + along * ey)) }
  const { end, width, layer, net } = seg
  runCommand(t('pcbEditor.commands.breakTrack'), () => {
    updateSegmentInAST(seg, { end: cut }, b)
    addSegmentToBoardAST(b, { start: cut, end, width, layer, net })
  })
}

/**
 * KiCad's Switch Track to Next / Previous Layer: the selected tracks one
 * copper layer down (or up) the stack, stopping at its ends.
 */
const moveTracksLayer = (step: 1 | -1): void => {
  const b = board.value
  const copper = copperLayerNames.value
  const tracks = selectedTracks()
  if (!b || props.isReadOnly || tracks.length === 0 || copper.length < 2) return
  const items = tracks.flatMap((ref) =>
    ref.type === 'segment' ? (b.segments[ref.index] ?? []) : (b.trackArcs[ref.index] ?? [])
  )
  const target = stepCopperLayer(copper, items[0]?.layer ?? routingLayer.value, step)
  runCommand(
    t('pcbEditor.commands.moveTracksToLayer', { count: items.length, layer: target }, items.length),
    () => {
      for (const ref of tracks) {
        if (ref.type === 'segment') {
          const seg = b.segments[ref.index]
          if (seg) updateSegmentInAST(seg, { layer: stepCopperLayer(copper, seg.layer, step) }, b)
        } else {
          const arc = b.trackArcs[ref.index]
          if (arc) updateTrackArcInAST(arc, { layer: stepCopperLayer(copper, arc.layer, step) })
        }
      }
    }
  )
}

/**
 * The edit keys KiCad's `RequestSelection` serves: with nothing selected they
 * act on the item under the pointer, and let it go after. M is its own (held).
 */
useGroupKeydown(
  withHoverKeys(handleKeydown, {
    ...boardHover,
    keys: [
      'pcb.rotate',
      'pcb.rotateClockwise',
      'pcb.flip',
      'editor.delete',
      'pcb.deleteFullTrack',
      'pcb.copy',
      'pcb.cut',
      'pcb.duplicate',
      'pcb.toggleLock',
      'pcb.trackWidthNext',
      'pcb.trackWidthPrev',
      'pcb.viaSizeNext',
      'pcb.viaSizePrev'
    ],
    ready: () =>
      activeMode.value === 'visual' &&
      activeTool.value === 'select' &&
      !trackDrag.value &&
      !move.active()
  })
)

onUnmounted((): void => {
  stopConnectivity?.()
  stopTimings?.()
  unmounted = true
  // The session keeps the board, its history and any text it still owes; this
  // view only stops what it started.
  cancelScheduledRefill()
  stopSession()
})

const resizeProperties = (grow: number): void => {
  setPanelWidth(propertiesResizeStart + grow)
}
/** One config write per drag, not one per pixel. */
const commitProperties = (): void => setPanelWidth(propertiesWidth.value, true)

// Save must not read a document the deferred serialize still owes; EditorArea
// awaits this before writing (cooperative — a save never blocks the thread).
defineExpose({ flushDocument: () => props.session.flush() })
</script>

<template>
  <div class="pcb-editor-container">
    <div class="editor-workspace-main">
      <div class="viewport-host-area">
        <!-- Floating toolbar: history | tools | tool search. Canvas-only —
             every control on it edits the board, and the 3D view has its own
             camera toolbar on the right. Gated on the parsed board like the
             right rail: chrome for a document that is not there yet is just
             flicker over the load bar. -->
        <div v-if="activeMode === 'visual' && board" v-toolbar-fit class="canvas-floating-toolbar">
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

          <!-- Rotate, mirror and flip are a selection's, and its menu and keys
               have them too: they give way before the tools that make things. -->
          <button
            v-for="entry in TRANSFORM_TOOLS"
            :key="entry.op"
            data-toolbar-early
            data-toolbar-group="transform"
            :data-tool-op="entry.op"
            class="floating-btn tool-btn"
            :disabled="!canTransform(entry.op)"
            :title="toolTitle(t(entry.label), transformHotkeys[entry.op])"
            @click="runTransform(entry.op)"
          >
            <Icon :name="entry.icon" />
          </button>
          <button
            data-toolbar-early
            data-toolbar-group="transform"
            data-tool-op="changeSide"
            class="floating-btn tool-btn"
            :disabled="!canFlip"
            :title="toolTitle(t('pcbEditor.tools.flip'), 'pcb.flip')"
            @click="flipHeldOrSelected"
          >
            <Icon name="tool-flip" />
          </button>

          <div class="toolbar-divider"></div>

          <button
            data-tool-op="select"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'select' }"
            :title="toolTitle(t('pcbEditor.viewport.select'), 'editor.cancel')"
            @click="setTool('select')"
          >
            <Icon name="tool-select" />
          </button>
          <button
            data-tool-op="footprint"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'footprint' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('pcbEditor.viewport.placeFootprint'), 'pcb.tool.footprint')"
            @click="setTool('footprint')"
          >
            <Icon name="tool-footprint" />
          </button>
          <button
            data-tool-op="route"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'route' }"
            :title="toolTitle(t('pcbEditor.viewport.route'), 'pcb.tool.route')"
            @click="setTool('route')"
          >
            <Icon name="tool-route" />
          </button>
          <button
            data-tool-op="routeDiffPair"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'pair' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('pcbEditor.pair.route'), 'pcb.routeDiffPair')"
            @click="armPair"
          >
            <Icon name="tool-route-pair" />
          </button>
          <!-- The one tuner the bar carries, a track's length (KiCad's 7); the pair's and
               the skew's are in the tool search, on their keys and on a track's menu. -->
          <button
            data-tool-op="tune:single"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'tune' && tuneArmed === 'single' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('pcbEditor.tune.tools.single'), 'pcb.tuneSingle')"
            @click="armTune('single')"
          >
            <Icon name="tool-tune-single" />
          </button>
          <button
            data-tool-op="via"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'via' }"
            :title="toolTitle(t('pcbEditor.viewport.via'), 'pcb.tool.via')"
            @click="setTool('via')"
          >
            <Icon name="tool-via" />
          </button>
          <button
            data-tool-op="zone"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'zone' }"
            :title="toolTitle(t('pcbEditor.viewport.zone'), 'pcb.tool.zone')"
            @click="setTool('zone')"
          >
            <Icon name="tool-zone" />
          </button>
          <button
            data-tool-op="refill"
            class="floating-btn tool-btn"
            :title="t('pcbEditor.viewport.refillTitle', { hotkey: hotkeyLabel('pcb.refillZones') })"
            @click="refillNow"
          >
            <Icon name="tool-refill" />
          </button>
          <div class="toolbar-divider"></div>

          <!-- What the route and via tools lay, always in view (router-behavior.md S10);
               the three read together, so they show and hide together. -->
          <button
            ref="widthChip"
            data-toolbar-group="sizes"
            data-tool-op="trackWidth"
            class="floating-btn tool-btn size-chip"
            :class="{
              fixed: widthPicked,
              open: sizeMenu?.anchor !== undefined && sizeMenu?.anchor === widthChip
            }"
            :title="toolTitle(t('pcbEditor.viewport.sizes.trackWidth'), 'pcb.trackWidthNext')"
            @click="openSizeChip('trackWidth')"
          >
            <Icon name="tool-track-width" />
            <span v-if="widthChipLabel" class="size-chip-value size-chip-size">
              <span>{{ widthChipLabel }}</span
              ><span class="size-chip-unit">mm</span>
            </span>
          </button>
          <button
            ref="viaChip"
            data-toolbar-group="sizes"
            data-tool-op="viaSize"
            class="floating-btn tool-btn size-chip"
            :class="{
              fixed: viaPicked,
              open: sizeMenu?.anchor !== undefined && sizeMenu?.anchor === viaChip
            }"
            :title="toolTitle(t('pcbEditor.viewport.sizes.viaSize'), 'pcb.viaSizeNext')"
            @click="openSizeChip('viaSize')"
          >
            <Icon name="tool-via" />
            <span v-if="viaChipLabel" class="size-chip-value size-chip-size">
              <span>{{ viaChipLabel }}</span
              ><span class="size-chip-unit">mm</span>
            </span>
          </button>
          <button
            ref="pairChip"
            data-toolbar-group="sizes"
            data-tool-op="layerPair"
            class="floating-btn tool-btn size-chip"
            :class="{ open: layerMenu?.anchor !== undefined && layerMenu?.anchor === pairChip }"
            :title="
              toolTitle(
                `${t('pcbEditor.viewport.layerPair.title')} · ${pairLabel(layerPair)}`,
                'pcb.layerPairNext'
              )
            "
            @click="openPairChip"
          >
            <Icon name="tool-layer-pair" />
          </button>

          <div class="toolbar-divider"></div>

          <button
            data-tool-op="line"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'line' }"
            :title="toolTitle(t('pcbEditor.viewport.line'), 'pcb.tool.line')"
            @click="setTool('line')"
          >
            <Icon name="tool-line" />
          </button>
          <button
            data-tool-op="arc"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'arc' }"
            :title="toolTitle(t('pcbEditor.viewport.arc'), 'pcb.tool.arc')"
            @click="setTool('arc')"
          >
            <Icon name="tool-arc" />
          </button>
          <button
            data-tool-op="rectangle"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'rectangle' }"
            :title="t('pcbEditor.viewport.rectangle')"
            @click="setTool('rectangle')"
          >
            <Icon name="tool-rect" />
          </button>
          <button
            data-tool-op="circle"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'circle' }"
            :title="toolTitle(t('pcbEditor.viewport.circle'), 'pcb.tool.circle')"
            @click="setTool('circle')"
          >
            <Icon name="tool-circle" />
          </button>
          <button
            data-tool-op="polygon"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'polygon' }"
            :title="toolTitle(t('pcbEditor.viewport.polygon'), 'pcb.tool.polygon')"
            @click="setTool('polygon')"
          >
            <Icon name="tool-polygon" />
          </button>
          <button
            data-tool-op="bezier"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'bezier' }"
            :title="toolTitle(t('pcbEditor.viewport.bezier'), 'pcb.tool.bezier')"
            @click="setTool('bezier')"
          >
            <Icon name="tool-bezier" />
          </button>
          <button
            data-tool-op="text"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'text' }"
            :title="toolTitle(t('pcbEditor.viewport.text'), 'pcb.tool.text')"
            @click="setTool('text')"
          >
            <Icon name="tool-text" />
          </button>
          <button
            data-tool-op="textBox"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'textBox' }"
            :title="t('pcbEditor.viewport.textBox')"
            @click="setTool('textBox')"
          >
            <Icon name="tool-text-box" />
          </button>
          <button
            data-tool-op="point"
            class="floating-btn tool-btn"
            :class="{ active: paletteTool === 'point' }"
            :title="t('pcbEditor.viewport.point')"
            @click="setTool('point')"
          >
            <Icon name="tool-point" />
          </button>

          <!-- The line mode, while a tool it constrains is armed: the same
               setting as the route's corners (lib/lineMode.ts). -->
          <template v-if="takesLineMode(activeTool)">
            <div class="toolbar-divider" data-toolbar-late></div>
            <button
              data-toolbar-late
              data-tool-op="cornerMode"
              class="floating-btn tool-btn"
              :title="
                t('pcbEditor.viewport.lineModeTitle', { hotkey: hotkeyLabel('pcb.lineMode') })
              "
              @click="lineMode = nextRouteCornerMode(lineMode)"
            >
              <Icon :name="`corner-${lineMode}`" />
            </button>
          </template>

          <ToolbarSearch ref="insertSearch" :ops="searchOps" @pick="onSearchPick" />
        </div>

        <!-- Left view rail: zoom to fit, then display toggles (KiCad's
             left-toolbar idiom). Zone fills + sketch modes persist app-wide
             (lib/pcbView.ts); dim and flip are per-tab state. -->
        <div
          v-if="activeMode === 'visual' && board"
          class="canvas-floating-toolbar toolbar-left-rail"
        >
          <FitViewButton @fit="fitView" />
          <div class="toolbar-divider"></div>
          <button
            data-tool-op="zoneFills"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: !pcbView.zoneFills }"
            :title="t('pcbEditor.viewRail.zoneOutlines')"
            @click="setPcbView({ zoneFills: !pcbView.zoneFills })"
          >
            <Icon name="view-zone-fills" />
          </button>
          <button
            data-tool-op="sketchTracks"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: pcbView.sketchTracks }"
            :title="toolTitle(t('pcbEditor.viewRail.sketchTracks'), 'pcb.sketchTracks')"
            @click="setPcbView({ sketchTracks: !pcbView.sketchTracks })"
          >
            <Icon name="view-sketch-tracks" />
          </button>
          <button
            data-tool-op="sketchVias"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: pcbView.sketchVias }"
            :title="t('pcbEditor.viewRail.sketchVias')"
            @click="setPcbView({ sketchVias: !pcbView.sketchVias })"
          >
            <Icon name="view-sketch-vias" />
          </button>
          <button
            data-tool-op="sketchPads"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: pcbView.sketchPads }"
            :title="t('shared.insertSearch.ops.sketchPads')"
            @click="setPcbView({ sketchPads: !pcbView.sketchPads })"
          >
            <Icon name="view-sketch-pads" />
          </button>
          <button
            data-tool-op="ratsnest"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: !pcbView.ratsnest }"
            :title="t('pcbEditor.viewRail.hideRatsnest')"
            @click="setPcbView({ ratsnest: !pcbView.ratsnest })"
          >
            <Icon name="view-ratsnest" />
          </button>
          <button
            data-tool-op="boardArea"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: pcbView.boardArea }"
            :title="t('pcbEditor.viewRail.boardArea')"
            @click="setPcbView({ boardArea: !pcbView.boardArea })"
          >
            <Icon name="view-board-area" />
          </button>
          <div class="toolbar-divider"></div>
          <NonActiveDisplayButton
            v-model:mode="nonActiveDisplay"
            data-tool-op="nonActive"
            action="pcb.cycleInactiveLayers"
          />
          <button
            data-tool-op="flip"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: flipped }"
            :title="t('pcbEditor.viewRail.flip')"
            @click="flipped = !flipped"
          >
            <Icon name="view-flip" />
          </button>
          <button
            data-tool-op="assembly"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: assemblyOverlay }"
            :title="toolTitle(t('pcbEditor.viewRail.assembly'), 'pcb.toggleRender')"
            @click="toggleAssemblyOverlay"
          >
            <Icon name="view-assembly" />
          </button>
        </div>

        <PcbViewport2D
          v-if="(activeMode === 'visual' || activeMode === '3d') && board && viewReady"
          ref="viewportRef"
          :finding-markers="findingMarkers"
          class="canvas-fill"
          :mode="activeMode === '3d' ? '3d' : 'layout'"
          :board="board"
          :load-id="boardLoadId"
          :selected-items="selectedItems"
          :grid-settings="gridSettings"
          :tune-meter="tuneMeter"
          :layer-visibility="layerVisibility"
          :active-layer="activeLayer"
          :non-active-display="nonActiveDisplay"
          :flipped="flipped"
          :view-options="pcbView"
          :clearance-rules="clearanceRules"
          :active-tool="activeTool"
          :route-draft="routeDraft"
          :route-net-clusters="routeRatsnestClusters"
          :route-start-via="
            routeStartVia ? { size: routeViaSize.diameter, drill: routeViaSize.drill } : null
          "
          :refusal-marks="refusalMarks"
          :tool-draft="toolDraft"
          :placement-ghost="placementGhost"
          :route-width="routeWidth"
          :route-hint-keys="hintKeyItems"
          :route-hint-max="opKeys.max"
          :route-hint-more="hintMoreKey"
          :coaching="tuneCoaching || pairCoaching"
          :route-via-pads="routeViaPads"
          :route-measure-head="routeLengthRule !== null"
          :route-keys-card="routeKeysOpen && keysCardAllowed ? routeKeysCard : null"
          :route-layer="routingLayer"
          :route-corner-mode="viewportCornerMode"
          :route-diag-first="routePostureFlip"
          :route-clearance="routeClearance"
          :route-mode="routeMode"
          :route-preview="route"
          :track-dragging="trackDrag !== null || pairActive || tuneActive"
          :track-drag-net="trackDragNet"
          :highlighted-net="highlightedNet"
          :track-drag-preview="trackDragPreview"
          :airwires="displayedAirwires"
          :spatial-index="spatialIndex"
          :edit-delta="editDelta"
          :file-path="props.filePath"
          :project-path="projectPath"
          :render-layer="assemblyOverlay"
          :render-layer-opacity="ASSEMBLY_OVERLAY_OPACITY"
          @finding-marker="revealFinding"
          @track-drag-move="handleTrackDragMove"
          @track-drag-commit="commitTrackDrag"
          @gesture-menu="openRouterMenu"
          @route-posture="(diagFirst: boolean) => (routeDiagFirst = diagFirst)"
          @route-violator="(id: number | null) => (routeViolator = id)"
          @route-state="(report: RouteStateReport | null) => (routeState = report)"
          @close-route-keys="routeKeysOpen = false"
          @hint-overflow="hintOverflow = $event"
          @context-menu="onCanvasContextMenu"
          @tool-click="handleToolClick"
          @tool-finish="handleToolFinish"
          @select-double-click="selectTrackConnection"
          @update:selected-items="onViewportSelect"
          @update-grid="handleUpdateGrid"
          @drag-start="handleDragStart"
          @drag-move="handleDragMove"
          @drag-end="handleDragEnd"
          @build-progress="handleBuildProgress"
        >
          <template #status>
            <LayersControl
              v-if="activeMode === 'visual'"
              editor="pcb"
              :listing="layerListing"
              :layer-visibility="layerVisibility"
              :active-layer="activeLayer"
              @toggle-layer-visibility="handleToggleLayerVisibility"
              @set-active-layer="handleSetActiveLayer"
              @apply-layer-preset="handleApplyLayerPreset"
            />
            <CollisionModeControl v-if="!props.isReadOnly" />
            <HealthPill
              editor="pcb"
              :report="healthReport"
              :open="healthOpen"
              :checking="checkPending"
              :progress="followUpProgress"
              @toggle="healthDrawer.toggle"
            />
          </template>
        </PcbViewport2D>

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
          <LibraryChooser
            v-if="footprintChooserOpen"
            kind="footprint"
            icon="tool-footprint"
            :title="t('pcbEditor.viewport.placeFootprint')"
            :verb="t('shared.libraryChooser.place')"
            :in-design="boardFootprintIds"
            :fields-for="placedFields"
            @pick="armFootprint"
            @close="footprintChooserOpen = false"
            @open="openFromChooser"
          />
          <LibraryChooser
            v-if="changeChooserOpen"
            kind="footprint"
            icon="libraries"
            :title="t('pcbEditor.commands.changeFootprints', 1)"
            :verb="t('shared.libraryChooser.change')"
            :target="changeChooserTarget"
            :initial-id="footprintDialog?.libId ?? selectionLibId"
            :in-design="boardFootprintIds"
            @pick="onChangeFootprintPick"
            @close="changeChooserOpen = false"
            @open="openFromChooser"
          />
          <PartUpdateDialog
            v-if="footprintDialog"
            v-model:lib-id="footprintDialog.libId"
            :mode="footprintDialog.mode"
            kind="footprint"
            :selection-count="selectedFootprints.length"
            :seeds="footprintUpdateSeeds"
            :options="footprintUpdateOptions"
            :defaults="footprintUpdateDefaults"
            :preview="footprintUpdateRows"
            :paused="changeChooserOpen"
            @confirm="confirmFootprintUpdate"
            @choose="browseChangeFootprint"
            @close="footprintDialog = null"
          />
          <CleanupTracksDialog
            v-if="cleanupDialog"
            :nets="cleanupNets"
            :layers="copperLayerNames"
            :selected="selectedCopper().length"
            :selection-only="cleanupDialog.selectionOnly"
            :preview="previewCleanup"
            :apply="runCleanup"
            @close="cleanupDialog = null"
          />
          <EditTeardropsDialog
            v-if="teardropDialog"
            :nets="cleanupNets"
            :classes="teardropClassNames"
            :layers="copperLayerNames"
            :selected="selectedTeardropItems().length"
            :selection-only="teardropDialog.selectionOnly"
            :targets="{
              vias: teardropDefaults.targets.vias,
              pthPads: teardropDefaults.targets.pthPads,
              smdPads: teardropDefaults.targets.smdPads,
              trackToTrack: teardropDefaults.targets.trackToTrack
            }"
            :round-only="teardropDefaults.targets.roundShapesOnly"
            :count="countTeardrops"
            :apply="runTeardrops"
            @close="teardropDialog = null"
          />
          <Board3DExportDialog
            v-if="exportImageView"
            :view-size="exportImageView"
            :preview="previewExportImage"
            :status="exportImageStatus"
            @save="saveExportImage"
            @copy="copyExportImage"
            @close="exportImageView = null"
          />
          <FanoutWidget
            v-if="fanoutOpen && activeMode === 'visual' && fanoutReference"
            v-model:settings="fanoutSettings"
            :reference="fanoutReference"
            :preview="fanoutPreview"
            :applied="fanoutApplied"
            :read-only="isReadOnly"
            @apply="applyFanoutPreview"
            @close="fanoutOpen = false"
          />
          <!-- Last, so it holds the corner while find and the overlays line up beside it. -->
          <Preview3dToggle
            v-if="activeMode !== 'setup' && board"
            :on="activeMode === '3d'"
            :title="t('shared.preview3dToggle.board')"
            @toggle="emit('toggle-preview3d')"
          />
        </div>

        <ContextMenu
          v-if="sizeMenu"
          :items="sizeMenuItems"
          :x="sizeMenu.x"
          :y="sizeMenu.y"
          :anchor="sizeMenu.anchor"
          @select="onSizeMenuSelect"
          @close="sizeMenu = null"
        />
        <CustomSizeForm
          v-if="customSize"
          :x="customSize.x"
          :y="customSize.y"
          :title="t('pcbEditor.viewport.sizes.customTitle')"
          :fields="[
            { key: 'width', label: t('pcbEditor.viewport.sizes.trackWidth'), value: routeWidth },
            {
              key: 'viaDiameter',
              label: t('pcbEditor.viewport.sizes.customViaDiameter'),
              value: routeViaSize.diameter
            },
            {
              key: 'viaDrill',
              label: t('pcbEditor.viewport.sizes.customViaDrill'),
              value: routeViaSize.drill
            }
          ]"
          :valid="(v) => v.viaDrill < v.viaDiameter"
          @apply="applyCustomSize"
          @close="customSize = null"
        />
        <CustomSizeForm
          v-if="tuneSettingsForm"
          :x="tuneSettingsForm.x"
          :y="tuneSettingsForm.y"
          :title="
            tuneFormMode === 'pair'
              ? t('pcbEditor.tune.settingsPair')
              : tuneFormMode === 'skew'
                ? t('pcbEditor.tune.settingsSkew')
                : t('pcbEditor.tune.settings')
          "
          :fields="[
            {
              key: 'target',
              label: t('pcbEditor.tune.targetField'),
              value: tuneTargetOverride ?? 0,
              zero: true
            },
            {
              key: 'overrideRules',
              label: t('pcbEditor.tune.overrideRules'),
              value: tuneOverrideRules ? 1 : 0,
              toggle: true
            },
            {
              key: 'minAmplitude',
              label: t('pcbEditor.tune.minAmplitude'),
              value: tuneSettings.minAmplitude
            },
            {
              key: 'maxAmplitude',
              label: t('pcbEditor.tune.maxAmplitude'),
              value: tuneSettings.maxAmplitude
            },
            { key: 'spacing', label: t('pcbEditor.tune.spacing'), value: tuneSettings.spacing },
            {
              key: 'cornerRadiusPercent',
              label: t('pcbEditor.tune.cornerRadius'),
              value: tuneSettings.cornerRadiusPercent,
              zero: true,
              unit: '%'
            },
            {
              key: 'singleSided',
              label: t('pcbEditor.tune.singleSided'),
              value: tuneSettings.singleSided ? 1 : 0,
              toggle: true
            }
          ]"
          @apply="applyTuneSettings"
          @close="tuneSettingsForm = null"
        />
        <CustomSizeForm
          v-if="pairSizeForm"
          :x="pairSizeForm.x"
          :y="pairSizeForm.y"
          :title="t('pcbEditor.pair.dimensions')"
          :fields="[
            { key: 'width', label: t('pcbEditor.pair.width'), value: pairSizes.width },
            { key: 'gap', label: t('pcbEditor.pair.gap'), value: pairSizes.gap },
            { key: 'viaGap', label: t('pcbEditor.pair.viaGap'), value: pairSizes.viaGap }
          ]"
          @apply="applyPairSizes"
          @close="pairSizeForm = null"
        />
        <ContextMenu
          v-if="layerMenu"
          :items="layerMenuItems"
          :x="layerMenu.x"
          :y="layerMenu.y"
          :anchor="layerMenu.anchor"
          @select="onLayerMenuSelect"
          @close="layerMenu = null"
        />
        <ContextMenu
          v-if="routerMenu"
          :items="routerMenuItems"
          :x="routerMenu.x"
          :y="routerMenu.y"
          @select="onRouterMenuSelect"
          @close="closeRouterMenu"
        />
        <ContextMenu
          v-if="canvasMenu"
          :items="canvasMenuItems"
          :x="canvasMenu.x"
          :y="canvasMenu.y"
          @select="onCanvasMenuSelect"
          @close="canvasMenu = null"
        />
        <FindingsDrawer
          v-if="healthOpen && !healthPinned && activeMode === 'visual' && boardShown"
          :findings="healthFindings"
          :height="healthHeight"
          :pending="!checksRan"
          :checking="checkPending"
          rerunnable
          :reveal="findingReveal"
          :group-fixes="healthGroupFixes"
          @locate="locateFinding"
          @fix="fixFinding"
          @fix-group="fixFindingGroup"
          @pin="setPanelPinned('pcb', 'health', true)"
          @close="healthDrawer.close"
          @resize="healthDrawer.resize"
          @rerun="rerunChecks"
        >
          <template #performance>
            <PerformancePanel :tasks="performanceTasks" />
          </template>
          <template #settings>
            <HealthViewSettings>
              <BoardAutomationSettings :automation="automation" @set="setAutomation" />
            </HealthViewSettings>
          </template>
        </FindingsDrawer>

        <div v-if="activeMode === 'visual' && parseError" class="parse-error-panel">
          <h4>{{ t('pcbEditor.parseError.title') }}</h4>
          <p>{{ parseError }}</p>
        </div>

        <PcbBoardSetup
          v-else-if="activeMode === 'setup'"
          :sections="boardSetupSections"
          :show-section="setupSectionRequest"
          :memory-key="filePath ? `board-setup:${filePath}` : undefined"
          :stackup="setupStackup"
          :layer-rows="stackupRows"
          :layer-colors="layerColors"
          :rules-read-only="!projectPath"
          :read-only="isReadOnly"
          :profile-edited="setupEdited"
          :severities="setupSeverities"
          :rule-counts="ruleCounts"
          :exclusions="setupExclusions"
          :check-results="checksRan ? checkResults : null"
          :net-names="setupNetNames"
          :net-assignments="setupAssignments"
          :custom-rules-text="setupCustomRules"
          :save-custom-rule="saveCustomRule"
          :remove-custom-rule="deleteCustomRule"
          @edit="onBoardSetupEdit"
          @save-preset="onSavePreset"
          @remove-preset="onRemovePreset"
          @edit-layer="onStackupLayerEdit"
          @add-dielectric="onAddDielectric"
          @remove-layer="onRemoveLayer"
          @edit-net-class="onNetClassEdit"
          @import-class-colors="onImportClassColors"
          @add-net-class="onAddNetClass"
          @remove-net-class="onRemoveNetClass"
          @edit-pattern="onPatternEdit"
          @add-pattern="onAddPattern"
          @remove-pattern="onRemovePattern"
          @edit-extra-size="onExtraSizeEdit"
          @add-extra-size="onAddExtraSize"
          @remove-extra-size="onRemoveExtraSize"
          @set-severity="onSetSeverity"
          @add-tuning-profile="onAddTuningProfile"
          @remove-tuning-profile="onRemoveTuningProfile"
          @edit-tuning-profile="onEditTuningProfile"
          @add-profile-layer="onAddProfileLayer"
          @remove-profile-layer="onRemoveProfileLayer"
          @edit-profile-layer="onEditProfileLayer"
          @solve-profile-layer="onSolveProfileLayer"
          @solve-profile="onSolveProfile"
          @start-interface-preset="startPresetDraft"
        >
          <template v-if="presetRequest && presetResult" #presetDraft>
            <InterfacePresetDraft
              :request="presetRequest"
              :result="presetResult"
              :class-options="presetClassOptions"
              :copper-layers="presetCopper"
              :applying="presetApplying"
              :inputs="presetInputs"
              :rules="presetRules"
              :class-before="presetClassBefore"
              :profile-pending="
                presetResult?.ok
                  ? presetPreview?.pending.profiles.get(presetResult.plan.profileName)
                  : undefined
              "
              @update="(next) => (presetRequest = next)"
              @apply="applyPresetDraft"
              @discard="presetRequest = null"
              @open-source="openPresetSource"
            />
          </template>
        </PcbBoardSetup>
      </div>

      <!-- Right properties panel -->
      <Teleport v-if="showPanels" :to="panelRail" :disabled="panelsInline">
        <div
          v-if="board && activeMode !== 'setup'"
          class="right-sidebar-panel"
          :style="{ width: propertiesWidth + 'px' }"
        >
          <ResizeHandle
            edge="left"
            @resize-start="propertiesResizeStart = propertiesWidth"
            @resize="resizeProperties"
            @resize-end="commitProperties"
          />

          <Pcb3DPanel v-if="activeMode === '3d'" @export-image="openExportImage" />

          <PcbPropertiesPanel
            v-else
            :board="board"
            :property-groups="liveGroups ?? boardGroups"
            :grid-settings="gridSettings"
            :layer-visibility="layerVisibility"
            :active-layer="activeLayer"
            :read-only="isReadOnly"
            :can-manufacture="canManufacture && !liveGroups"
            :sync-drift="syncDrift"
            :format-file-path="selectedItems.length === 0 && !liveGroups ? props.filePath : null"
            @edit="onBoardEdit"
            @manufacture="props.filePath && emit('open-manufacture', props.filePath)"
            @setup="emit('open-setup')"
            @update-from-schematic="props.filePath && emit('update-from-schematic', props.filePath)"
            @update-grid="handleUpdateGrid"
            @toggle-layer-visibility="handleToggleLayerVisibility"
            @apply-layer-preset="handleApplyLayerPreset"
            @set-active-layer="handleSetActiveLayer"
          >
            <!-- A live route or tune stands in for the selection, its actions too. -->
            <template v-if="!liveGroups" #selection-actions>
              <LimitsSection
                v-if="selectionLimits"
                :class-color="classColor"
                :limits="selectionLimits"
                :unit="gridSettings.unit"
                :pair="selectedItems.length === 2"
              />
              <LibraryLinkSection
                v-if="selectedFootprints.length"
                kind="footprint"
                :status="footprintLibraryStatus"
                :part="footprintLibraryPart"
                :can-edit="
                  selectedFootprints.length === 1 && !!footprintUuid(selectedFootprints[0])
                "
                :read-only="isReadOnly"
                @edit="editDesignFootprint"
                @update="openFootprintUpdate"
                @change="openFootprintChange"
                @edit-library="openLibraryFootprint"
              />
            </template>
            <RailPinnedPanels
              editor="pcb"
              :grid-settings="gridSettings"
              :findings="healthFindings"
              :pending="!checksRan"
              :checking="checkPending"
              rerunnable
              :reveal="findingReveal"
              :group-fixes="healthGroupFixes"
              @update-grid="handleUpdateGrid"
              @locate="locateFinding"
              @fix="fixFinding"
              @fix-group="fixFindingGroup"
              @rerun="rerunChecks"
            >
              <template #settings>
                <HealthViewSettings>
                  <BoardAutomationSettings :automation="automation" @set="setAutomation" />
                </HealthViewSettings>
              </template>
            </RailPinnedPanels>
          </PcbPropertiesPanel>
        </div>
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
/* A value chip: the size it sets beside its glyph (router-behavior.md S10). */
/* Square as any tool while it shows its glyph alone; wide only with a size. */
.tool-btn.size-chip:has(.size-chip-value) {
  width: auto;
  padding: 0 8px 0 6px;
  gap: 4px;
}

.size-chip-value {
  font-family: var(--font-mono, monospace);
  font-size: var(--text-body-sm);
}

/* A size over its unit, in the chip's height: the number reads, the unit says which. */
.size-chip-size {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1;
}

.size-chip-unit {
  font-family: var(--font-family);
  font-size: var(--text-caption);
  font-weight: normal;
  opacity: 0.75;
}

/* Pressed while its list is open, in the hover's neutral box: not copper,
   which says "the tool you are in", and not gold, which reports the setting. */
.size-chip.open {
  background-color: var(--vscode-overlay-control-hover);
  border-color: var(--vscode-input-border);
}

/* Fixed is the setting that surprises (S2); outside the rule warns (S7). */
.size-chip.fixed {
  color: var(--vscode-accent, #cca250);
}

.pcb-editor-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background-color: var(--vscode-bg-editor, #151c19);
  color: var(--vscode-text, #c5d3cd);
}

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
  /* The canvas clear color, so file read → parse → first canvas frame is one
     unbroken shade instead of flashing editor-green in the middle. */
  background-color: var(--vscode-bg-viewport, #101513);
}

/* Takes what the drawer leaves: a flex basis, not the viewport's own 100%. */
.canvas-fill {
  flex: 1 1 0;
  min-height: 0;
}

.right-sidebar-panel {
  flex-shrink: 0;
  position: relative;
  height: 100%;
  background-color: var(--vscode-bg-sidebar, #1a221f);
  border-left: 1px solid var(--vscode-border, #24302b);
  display: flex;
  flex-direction: column;
}

.parse-error-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.parse-error-panel h4 {
  color: var(--vscode-error);
  font-size: 13px;
}

.parse-error-panel p {
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted, #748780);
  max-width: 420px;
  font-family: var(--font-mono, monospace);
}
</style>
