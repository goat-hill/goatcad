<script setup lang="ts">
import { heldMove, withHoverKeys, type HoverSelection } from '../lib/hoverSelection'
import { SELECTION_GROUP, intersectGroups } from '../lib/propertyTable'
import { vToolbarFit } from '../lib/canvasToolbar'
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useContextPanels, useEditorGroup, useGroupKeydown } from '../lib/editorWorkspace'
import { emitCrossProbe, emitNetProbe, onCrossProbe } from '../lib/crossProbe'
import { useI18n } from 'vue-i18n'
import type { SheetEdit, SheetSession } from '../lib/schematic/sheetSession'
import {
  matchesHotkey,
  isHotkeyActionId,
  isTypingTarget,
  hotkeyLabel,
  type HotkeyActionId,
  toolTitle
} from '../lib/hotkeys'
import type { GridSettings } from '../lib/engine/ViewportEngine'
import {
  gridKeyUpdate,
  SCHEMATIC_GRID_DEFAULTS,
  SCHEMATIC_UNIT_SPACINGS,
  useGridSettings
} from '../lib/gridPreferences'
import { isViewCommand, viewCommandFor, viewCommandOps } from '../lib/viewCommands'
import {
  addSchematicJunctionToAST,
  addSchematicLabelToAST,
  addSchematicNoConnectToAST,
  addSchematicSheetToAST,
  addSchematicSymbolToAST,
  addSchematicTextToAST,
  addSchematicWireToAST,
  addSheetPinToAST,
  ensureLibSymbolsInAST,
  getLibSymbolProperty,
  getSheetProperty,
  definitionIdOf,
  getSymbolProperty,
  referenceForSheetPath,
  setSchematicSymbolBodyStyle,
  setSchematicSymbolUnit,
  setSymbolInstanceReference,
  libSymbolChain,
  libSymbolUnitCount,
  libSymbolUnitPins,
  moveSchematicLabelInAST,
  moveSchematicSymbolInAST,
  removeSchematicItemsFromAST,
  schematicItemExists,
  resizeSchematicSheetInAST,
  setSchematicSymbolFlag,
  setSchematicWirePointsInAST,
  rotateSchematicSymbolInAST,
  mirrorSchematicSymbolInAST,
  updateSchematicWireInAST,
  updateSchematicJunctionInAST,
  setSchematicLabelText,
  setSchematicLabelShape,
  itemRefsWithUuids,
  type DirectiveLabelShape,
  type KicadLibSymbol,
  type KicadSchematic,
  type KicadSchematicSymbol,
  type KicadLabel,
  type KicadSheet,
  type Point,
  type SheetPinShape,
  type SheetSide
} from '../lib/kicad/schematic'
import {
  BEZIER_CLICKS,
  BUS_ENTRY_SIZE,
  BUS_ENTRY_SIZE_FLIPPED,
  draftItem,
  isRunTool,
  isTwoClickTool,
  rotateBusEntrySize,
  sheetPinTarget,
  unplacedSheetPins,
  writeDrawItem,
  type DraftOptions,
  type DrawItem
} from '../lib/schematic/drawTools'
import {
  applySheetItemEdit,
  buildSchematicGroups,
  strokePatch,
  screenSheetEdits,
  sheetItemSelection,
  SYMBOL_ROW_ACTIONS,
  EDIT_FIELDS_ACTION,
  USER_FIELD_PREFIX,
  type SchematicContext,
  type ScreenSheet,
  type SheetPageContext,
  type SymbolLinks
} from '../lib/schematic/schematicPropertySchema'
import type { PinRef } from '../lib/pinPadMatch'
import type { PropertyEditValue, PropertyGroup, Rgba } from '../lib/propertyTable'
import PropertyTable from './shared/PropertyTable.vue'
import { resetActivePane, useActivePane } from '../lib/activePane'
import CollapsiblePanel from './shared/CollapsiblePanel.vue'
import Icon from './shared/Icon.vue'
import ResizeHandle from './shared/ResizeHandle.vue'
import HealthPill from './shared/HealthPill.vue'
import FindingsDrawer from './shared/FindingsDrawer.vue'
import RailPinnedPanels from './shared/RailPinnedPanels.vue'
import {
  findingMarks,
  schematicFindings,
  type HealthFinding,
  type HealthReport
} from '../lib/designHealth'
import { designHealthViewState } from '../lib/designHealthView'
import HealthViewSettings from './shared/HealthViewSettings.vue'
import { useHealthDrawer } from '../lib/designHealthDrawer'
import { flattenedLibSymbol, libSymbolMatches, type CheckResult } from '../lib/schematic/checks'
import { libraryPartOf, librarySyncStatus, type LibrarySync } from '../lib/librarySync'
import LibraryLinkSection from './shared/LibraryLinkSection.vue'
import { designCopyPath } from '../lib/designCopy'
import { panelPinned, panelWidth, setPanelPinned, setPanelWidth } from '../lib/panelLayout'
import {
  elbowPoints,
  isWireAttachPoint,
  junctionsForNewWire,
  mergeCollinearPoints,
  nextReference,
  placementGeometry,
  sheetDraftRect,
  SHEET_DEFAULT_HEIGHT,
  type PlacementGeometry,
  type SchematicTool,
  type WirePosture,
  wireTerminals,
  busTerminals
} from '../lib/schematic/schematicTools'
import { cleanupChanged, type CleanupReport } from '../lib/schematic/wireCleanup'
import {
  mmToNm,
  mmToSpacing,
  nm,
  NM_PER_MM,
  nmToMm,
  pointsEqualNm,
  spacingToMm,
  type Nm
} from '../lib/kicad/coordinates'
import type { SchematicItemRef } from '../lib/engine/SchematicScene'
import {
  applyMovePlan,
  applyTransform,
  applyVertexDrag,
  loneFields,
  planBusVertexDrag,
  planMove,
  planPlacement,
  planTransform,
  planVertexDrag,
  transformedItemCount,
  transformSchematicFieldInAST,
  translateSchematicItems,
  type PlacementStep,
  type VertexTarget
} from '../lib/schematic/schematicMove'
import { transformOrientation, type TransformOp } from '../lib/schematic/schematicTransform'
import {
  buildProjectComponentRecords,
  type ComponentRecord,
  type FlagKey,
  type SheetSource
} from '../lib/componentsTable'
import {
  loadIndex,
  findFootprint,
  findLibrarySymbol,
  findSymbol,
  type IndexRecord
} from '../lib/libraryIndex'
import { basenameOf, dirnameOf, resolveRelativePath, separatorOf } from '../lib/kicad/paths'
import { blankFileContent, uniqueFileName } from '../lib/project/scaffold'
import { openSheetsVersion } from '../lib/schematic/openSheets'
import { symbolSourcesFor, type LibrarySymbol } from '../lib/symbol/symbolSources'
import { setGraphicVertex } from '../lib/symbol/symbolEdit'
import {
  SHEET_GRAPHIC_GROUPS,
  sheetGraphicOf,
  type SheetGraphicType
} from '../lib/schematic/sheetGraphicEdit'
import SchematicViewport2D from './schematic/SchematicViewport2D.vue'
import SchematicLabelPopover, { type PopoverKind } from './schematic/SchematicLabelPopover.vue'
import SchematicSheetPopover from './schematic/SchematicSheetPopover.vue'
import SchematicAnnotateDialog, {
  type AnnotateRequest
} from './schematic/SchematicAnnotateDialog.vue'
import {
  planAnnotation,
  planIncrementAnnotations,
  type AnnotateSource,
  type AnnotationPlan
} from '../lib/schematic/annotate'
import SchematicIncrementAnnotationsDialog, {
  type IncrementRequest
} from './schematic/SchematicIncrementAnnotationsDialog.vue'
import {
  findUnitHolder,
  letterSubReference,
  nextBodyStyle,
  placedSymbolChain,
  placedSymbolChoices,
  type UnitHolder
} from '../lib/schematic/symbolUnits'
import { datasheetTarget } from '../lib/schematic/datasheet'
import { IMAGE_IMPORT_EXTENSIONS, pngFromImageFile } from '../lib/schematic/imageImport'
import type { SymbolEdit } from '../lib/schematic/symbolEdits'
import ToolbarSearch from './shared/ToolbarSearch.vue'
import FitViewButton from './shared/FitViewButton.vue'
import {
  fitViewOp,
  FIT_VIEW_OP_ID,
  isTransformOp,
  TRANSFORM_TOOLS,
  type ToolbarSearchOp
} from '../lib/toolSearch'
import { schematicViewState, setSchematicView } from '../lib/schematicView'
import LibraryChooser from './shared/LibraryChooser.vue'
import { commandTitle, type ChooserItem, type ChooserScope } from '../lib/libraryChooser'
import { libSymbolPins, symbolPreviewSheet } from '../lib/libraryLoad'
import { openTargetFor } from '../lib/componentAssociations'
import { readonlyLibTabPath } from '../lib/tabs'
import {
  FLAG_TOKENS,
  fieldEdits,
  fieldListEdits,
  flagEdits,
  type FieldListOp
} from '../lib/schematic/componentEdits'
import type {} from '../lib/kicad/sexpr'
import { tk, type MessageKey } from '../lib/messageKey'
import type { IconName } from '../lib/icons'
import { useSchematicClipboard } from '../lib/schematic/useSchematicClipboard'
import {
  buildEditMenu,
  dispatchEditAction,
  selectAllInField,
  usePublishedEditActions,
  usePublishedNavActions
} from '../lib/editActions'
import ContextMenu from './shared/ContextMenu.vue'
import type { MenuNode } from '../lib/menu'
import { sameSchematicRef } from '../lib/engine/SchematicScene'
import {
  adjacentSheet,
  childInstance,
  childSheetPath,
  enteredInstancePath,
  noteEnteredInstance,
  sheetBreadcrumb,
  sheetHistory,
  type SheetVisit
} from '../lib/schematic/sheetNavigation'
import type { SheetInstance } from '../lib/schematic/hierarchy'
import { inPageOrder, pageAllocator, pagesOf } from '../lib/schematic/sheetPages'
import PartUpdateDialog from './shared/PartUpdateDialog.vue'
import SymbolFieldsDialog from './symbol/SymbolFieldsDialog.vue'
import {
  inScope,
  type PartUpdateMode,
  type PartUpdateRequest,
  type PartUpdateRow
} from '../lib/partUpdate'
import { compareReferencesNatural } from '../lib/componentsTable'
import {
  checkSymbolUpdate,
  updateSymbolsWithWires,
  CHANGE_DEFAULTS,
  UPDATE_DEFAULTS,
  type SymbolUpdateOptions,
  type SymbolUpdateTarget
} from '../lib/schematic/symbolUpdate'
import type { DocumentEdit } from '../lib/schematic/symbolEdits'
import CanvasFindWidget from './shared/CanvasFindWidget.vue'
import {
  alignableItems,
  alignDeltas,
  applyItemShifts,
  distributeDeltas,
  planItemShifts,
  type AlignBox,
  type AlignOp,
  type DistributeOp
} from '../lib/schematic/alignItems'
import { findHandoff, findState } from '../lib/schematic/findState'
import { compileQuery, findStepFor } from '../lib/canvasFind'
import {
  applyReplaceEdit,
  duplicateReferences,
  findMatches,
  replaceEdits,
  type FindMatch,
  type FindSource,
  type FindTarget,
  type ReplaceEdit
} from '../lib/schematic/schematicFind'
import FormatNotice from './shared/FormatNotice.vue'

const { t } = useI18n()
const { groupId, focused: groupFocused } = useEditorGroup()
const { show: showPanels, inline: panelsInline, rail: panelRail } = useContextPanels()

/**
 * The right bar's width. The schematic editor was the only one of the four
 * whose bar was a fixed 270px with no grip at all; it now reads the same shared,
 * persisted width as the other three (`panelLayout.ts`).
 */
const propertiesWidth = panelWidth()
let propertiesResizeStart = propertiesWidth.value
const resizeProperties = (grow: number): void => {
  setPanelWidth(propertiesResizeStart + grow)
}
/** One config write per drag, not one per pixel. */
const commitProperties = (): void => setPanelWidth(propertiesWidth.value, true)

interface ViewportExposed {
  zoomToFit(): void
  focusIndices(indices: number[]): void
  focusAt(point: { x: number; y: number }): void
  focusCanvas(): void
  /** A turn or flip about the cursor mid-drag; false when no drag is running. */
  applyDragTransform(op: TransformOp): boolean
  /** Abandon the drag in progress, nothing committed; false when none is. */
  cancelDrag(): boolean
  /** Pick the selection up at the pointer (M: alone, G: wires following). */
  startHeldDrag(mode: 'move' | 'drag'): boolean
  /** The canvas menu's Select Other, at the client point it was opened. */
  selectOtherAt(client: { x: number; y: number }): void
  /** The name of the net under the pointer, or null. */
  netAtPointer(): string | null
  /** What a click at the pointer would select, or null. */
  itemAtCursor(): SchematicItemRef | null
}

const props = defineProps<{
  /** The open document this view draws (`lib/schematic/sheetSession.ts`). */
  session: SheetSession
  modelValue: string
  filePath: string
  name: string
  isReadOnly?: boolean
  /**
   * A request to reveal symbols by uuid once this sheet is open (cross-sheet
   * navigation from the components table, or a cross-select from the board).
   * The nonce lets the same target be requested again.
   */
  focusRequest?: {
    uuids: string[]
    at?: { x: number; y: number }
    /** A finding picked on another sheet: selected in this editor's list too, the drawer shown. */
    finding?: string
    nonce: number
  } | null
}>()

const emit = defineEmits<{
  (event: 'open-symbol', path: string, symbolUuid: string): void
  /** Open a library symbol in the symbol editor (Ctrl/Cmd+E on a placed part). */
  (event: 'open-library-symbol', path: string, symbol: string): void
  /** Open another sheet of the design and reveal items on it, or a point (mm). */
  (
    event: 'reveal-in-sheet',
    path: string,
    uuids: string[],
    at?: { x: number; y: number },
    finding?: string
  ): void
  /** A file was created on disk (a new child sheet) — refresh the file tree. */
  (event: 'file-created', path: string): void
  /** Open the design's Components tab, named by its root sheet. */
  (event: 'open-components', rootSheetPath: string): void
  /** Open the design's Schematic Setup, by its root sheet (from the properties panel). */
  (event: 'open-schematic-setup', rootSheetPath: string): void
  /** Open a file in its own tab: a datasheet, a footprint read-only. */
  (event: 'open-file', node: { name: string; path: string }): void
}>()

/**
 * The session's sheet, and the counter that re-reads it. Every command goes
 * through the session, which re-parses and tells this view to look again, so
 * the document on screen is the one an agent edits — there is only one.
 */
const revision = ref(0)
const schematic = computed<KicadSchematic | null>(() => {
  void revision.value
  return props.session.document()
})
const parseError = computed<string | null>(() => {
  void revision.value
  const reason = props.session.parseError()
  return reason === 'empty' ? t('schematicEditor.errors.empty') : reason
})
const stopSession = props.session.subscribe(() => {
  revision.value++
})
const selectedItems = ref<SchematicItemRef[]>([])
// Symbol subset of the selection, for the components table and properties.
const selectedIndices = computed(() =>
  selectedItems.value.filter((item) => item.type === 'symbol').map((item) => item.index)
)
const viewport = ref<(InstanceType<typeof SchematicViewport2D> & ViewportExposed) | null>(null)

// Which pane owns the keyboard. Tracked for the Escape handover only — the
// canvas no longer mutes its halo for it; see lib/activePane.ts.
const { setActivePane } = useActivePane()

/** Escape in a property field hands the keyboard back to the canvas. */
const returnFocusToCanvas = (): void => {
  setActivePane('canvas')
  viewport.value?.focusCanvas()
}
const historyVersion = ref(0)
// KiCad schematics work in mils on a 50 mil grid by default (wires/pins snap to
// 50 mil). Grid is a session/view preference (persisted across tabs/restarts,
// per editor kind) — never written to the .kicad_sch.
const gridSettings = useGridSettings('schematic', SCHEMATIC_GRID_DEFAULTS)

// ---- Placement tools -------------------------------------------------------
const activeTool = ref<SchematicTool>('select')
const wireDraft = ref<Point[]>([])
const wirePosture = ref<WirePosture>('hv')
const insertSearch = ref<InstanceType<typeof ToolbarSearch> | null>(null)
/**
 * A label/text placement awaiting its text (popover anchored at the click). A
 * text box carries the rectangle its two clicks drew; a sheet pin, where on
 * which sheet it lands and the child's labels it can import.
 */
const pendingLabel = ref<{
  kind: PopoverKind
  position: Point
  screen: { x: number; y: number }
  box?: { position: Point; size: { width: Nm; height: Nm } }
  sheetPin?: {
    sheetIndex: number
    side: SheetSide
    names: { name: string; shape: SheetPinShape }[]
  }
  initialText?: string
} | null>(null)
/** The clicks a drawing tool has so far: a line's or bus's vertices, or the
 *  first corner, center or end of a two-click shape (lib/schematic/drawTools.ts). */
const drawDraft = ref<Point[]>([])
/** The bus entry's diagonal, as Z, Shift+Z and R leave it. */
const busEntrySize = ref<{ width: Nm; height: Nm }>(BUS_ENTRY_SIZE)
/** The last directive label's flag, which the next one takes (KiCad's habit). */
const directiveShape = ref<DirectiveLabelShape>('round')
/** The picture the image tool holds, as PNG base64, until a click places it. */
const pendingImage = ref<string | null>(null)
/** A drawn item held on screen while its popover asks for its text. */
const heldDraft = computed<DrawItem | null>(() => {
  const box = pendingLabel.value?.box
  return box ? { kind: 'text_box', ...box, text: '' } : null
})
/**
 * A child sheet drawn but not yet named/committed: the rectangle (sheet space),
 * the popover anchor, and the sibling file names for collision validation. The
 * rectangle previews on the canvas until commit or cancel.
 */
const pendingSheet = ref<{
  rect: { x0: Nm; y0: Nm; x1: Nm; y1: Nm }
  screen: { x: number; y: number }
  siblings: string[]
  defaultStem: string
} | null>(null)
/** First-click anchor of a two-click sheet draw (sheet space), or null. */
const sheetDraftStart = ref<Point | null>(null)

const pendingSheetRect = computed(() => pendingSheet.value?.rect ?? null)

const isLabelTool = (tool: SchematicTool): boolean =>
  tool === 'label' ||
  tool === 'global_label' ||
  tool === 'hierarchical_label' ||
  tool === 'directive_label'

const setTool = (tool: SchematicTool): void => {
  if (props.isReadOnly && tool !== 'select') return
  wireDraft.value = []
  drawDraft.value = []
  pendingLabel.value = null
  pendingSheet.value = null
  sheetDraftStart.value = null
  placement.value = null
  pendingImage.value = null
  activeTool.value = tool
}

// ---- Symbol / power placement (chooser → armed ghost → click to place) -----
const chooserMode = ref<'symbol' | 'power' | null>(null)
/** Armed symbol placement: which lib id, at what rotation, with ghost geometry. */
/**
 * The armed placement. A multi-unit package (a quad NAND is four gates) is
 * placed one gate at a time: `unit` is the gate being placed next, and
 * `reference` pins the package the sequence belongs to so units 2..N land as
 * U1B, U1C … rather than starting a new package each click. Null reference
 * means "the next click starts a fresh package".
 */
const placement = ref<{
  libId: string
  /** Fields written onto each placement — the footprint picked in the chooser. */
  fields: Record<string, string>
  angle: number
  /** KiCad's `(mirror …)`: the body turned by `angle`, then flipped (`SymbolPose`). */
  mirror?: 'x' | 'y'
  geometry: PlacementGeometry
  unit: number
  unitCount: number
  reference: string | null
} | null>(null)

const placementGhost = computed(() =>
  placement.value
    ? {
        ...placement.value.geometry,
        angle: placement.value.angle,
        mirror: placement.value.mirror
      }
    : null
)

/**
 * The part the next click places, as it will land — its unit, turn, reference
 * and fields — on a one-part sheet the viewport draws as the ghost
 * (`symbolPreviewSheet`), so what follows the cursor is what appears.
 */
const placementSheet = computed<KicadSchematic | null>(() => {
  const current = placement.value
  if (!current) return null
  const available = availableSymbols.value.find((entry) => entry.libId === current.libId)
  const definition = available?.sheet.libSymbols.get(current.libId)
  if (!available || !definition) return null
  const chain = libSymbolChain(definition, (name) => available.sheet.libSymbols.get(name))
  const prefix =
    (getLibSymbolProperty(definition, 'Reference') ?? 'U').replace(/[?\d]+$/, '') || 'U'
  return symbolPreviewSheet(chain, {
    unit: current.unit,
    angle: current.angle,
    mirror: current.mirror,
    reference: current.reference ?? nextReference(existingReferences.value, prefix),
    fields: current.fields
  })
})

interface AvailableSymbol {
  libId: string
  description: string
  isPower: boolean
  scope: ChooserScope
  /** The parsed sheet whose lib_symbols carries this definition (and its
   *  extends parents) — placement copies the chain from here. */
  sheet: KicadSchematic
}

// Symbols reachable through the symbol library table — a second chooser source
// beside the symbols already embedded in the project's sheets. The tiers and
// their loading live in `lib/symbol/symbolSources.ts`, shared with every other
// reader of this sheet's directory; each namespaced library shares one parsed
// doc across its symbols, and the `sheet` is that doc, so placement copies the
// extends chain exactly as for an embedded symbol.
const symbolSources = symbolSourcesFor(props.filePath)

const TIER_SCOPES: Record<LibrarySymbol['tier'], ChooserScope> = {
  project: 'project',
  global: 'global',
  standard: 'system'
}

/** Every lib symbol embedded in the project, plus everything already parsed
 *  from the symbol library table. Embedded (self-contained) definitions win on
 *  a lib-id clash — the sheet is the source of truth for what it carries. */
const availableSymbols = computed<AvailableSymbol[]>(() => {
  void revision.value
  void openSheetsVersion.value
  return props.session.availableSymbols().map((entry) => {
    if ('tier' in entry) {
      const tiered = entry as LibrarySymbol
      return { ...tiered, scope: TIER_SCOPES[tiered.tier] }
    }
    const definition = entry.sheet.libSymbols.get(entry.libId)
    return {
      libId: entry.libId,
      description: definition
        ? (getLibSymbolProperty(definition, 'Description') ??
          getLibSymbolProperty(definition, 'ki_description') ??
          '')
        : '',
      isPower: definition?.isPower === true || entry.libId.startsWith('power:'),
      scope: 'design' as const,
      sheet: entry.sheet
    }
  })
})

/** What the chooser lists ahead of the index: the design's own and its tables' symbols. */
const chooserItems = (kind: 'symbol' | 'power'): ChooserItem[] =>
  availableSymbols.value
    .filter((entry) => entry.isPower === (kind === 'power'))
    .map((entry) => {
      const separator = entry.libId.indexOf(':')
      return {
        id: entry.libId,
        name: separator >= 0 ? entry.libId.slice(separator + 1) : entry.libId,
        library: separator >= 0 ? entry.libId.slice(0, separator) : '',
        description: entry.description,
        keywords: '',
        scope: entry.scope,
        count: findSymbol(entry.libId)?.pins ?? 0
      }
    })

/** A symbol's definition chain from the design or its tables, for the chooser's preview. */
const resolveChooserSymbol = async (libId: string): Promise<KicadLibSymbol[] | null> => {
  const entry = availableSymbols.value.find((candidate) => candidate.libId === libId)
  const definition = entry?.sheet.libSymbols.get(libId)
  return entry && definition
    ? libSymbolChain(definition, (name) => entry.sheet.libSymbols.get(name))
    : null
}

/** Lib ids the design's placed symbols use, every sheet. */
const designSymbolIds = computed<string[]>(() => [
  ...new Set(sheetSources.value.flatMap((source) => source.schematic.symbols.map((s) => s.libId)))
])

/** Footprints the design's parts already name. */
const designFootprintIds = computed<string[]>(() => [
  ...new Set(
    records.value
      .map((record) => record.fields.Footprint?.trim())
      .filter((id): id is string => !!id)
  )
])

const openChooser = (mode: 'symbol' | 'power'): void => {
  if (props.isReadOnly) return
  chooserMode.value = mode
  // Refetch if a library was added since this editor mounted; a no-op
  // otherwise, so opening the chooser stays instant (libraryIndex.ts §stale).
  void loadIndex().catch(() => {})
}

const armPlacement = async (libId: string, choice?: { footprint: string }): Promise<void> => {
  const mode = chooserMode.value ?? 'symbol'
  chooserMode.value = null
  let available = availableSymbols.value.find((entry) => entry.libId === libId)
  if (!available) {
    // A standard-tier pick: its library isn't parsed yet — load just that one.
    await symbolSources.ensureStandardLibrary(libId)
    available = availableSymbols.value.find((entry) => entry.libId === libId)
  }
  const definition = available?.sheet.libSymbols.get(libId)
  if (!available || !definition) return
  const source = available
  setTool(mode)
  const chain = libSymbolChain(definition, (name) => source.sheet.libSymbols.get(name))
  placement.value = {
    libId,
    fields: choice ? { Footprint: choice.footprint } : {},
    angle: 0,
    geometry: placementGeometry(chain, 1),
    unit: 1,
    unitCount: libSymbolUnitCount(chain),
    reference: null
  }
}

/** References across every sheet instance, feeding annotate-on-place. */
const existingReferences = computed<string[]>(() => {
  void revision.value
  void openSheetsVersion.value
  return props.session.existingReferences()
})

/** This file's hierarchical instance paths (one per reuse of the sheet). */
const activeInstancePaths = computed<string[]>(() => {
  void revision.value
  return props.session.instancePaths()
})

/** Project name for new (instances ...) blocks, as the session resolves it. */
const instanceProjectName = computed<string>(() => {
  void revision.value
  return props.session.instanceProjectName()
})

const placeSymbolAt = (point: Point): void => {
  const current = placement.value
  if (!current) return
  const available = availableSymbols.value.find((entry) => entry.libId === current.libId)
  const definition = available?.sheet.libSymbols.get(current.libId)
  if (!available || !definition) return
  const chain = libSymbolChain(definition, (name) => available.sheet.libSymbols.get(name))
  const pins = libSymbolUnitPins(chain, current.unit)
  // Annotate on placement: never drop an R? on the sheet. Units 2..N of a
  // package reuse the reference the sequence started with — KiCad stores the
  // bare "U1" and derives the A/B suffix from the unit field.
  const rawPrefix = getLibSymbolProperty(definition, 'Reference') ?? 'U'
  const prefix = rawPrefix.replace(/[?\d]+$/, '') || 'U'
  const reference = current.reference ?? nextReference(existingReferences.value, prefix)
  const project = instanceProjectName.value
  const instances = activeInstancePaths.value.map((path) => ({ project, path }))
  runCommand(t('commandLabels.addSymbol'), () => {
    const target = schematic.value
    if (!target) return
    ensureLibSymbolsInAST(target, chain)
    addSchematicSymbolToAST(
      target,
      definition,
      { x: point.x, y: point.y, angle: current.angle, mirror: current.mirror },
      reference,
      pins,
      instances,
      current.unit,
      1,
      current.fields
    )
  })
  advancePlacementUnit(reference)
}

/**
 * After placing a gate, arm the next one of the same package; after the last,
 * start fresh so the following click begins a new package. Mirrors KiCad's
 * place-the-next-unit behavior, which is what makes a quad NAND bearable.
 */
const advancePlacementUnit = (reference: string): void => {
  const current = placement.value
  if (!current) return
  const more = current.unit < current.unitCount
  placement.value = {
    ...current,
    unit: more ? current.unit + 1 : 1,
    reference: more ? reference : null,
    geometry: placementGeometryFor(current.libId, more ? current.unit + 1 : 1) ?? current.geometry
  }
}

/** Ghost outline for a given unit of an armed symbol. */
const placementGeometryFor = (libId: string, unit: number): PlacementGeometry | null => {
  const available = availableSymbols.value.find((entry) => entry.libId === libId)
  const definition = available?.sheet.libSymbols.get(libId)
  if (!available || !definition) return null
  return placementGeometry(
    libSymbolChain(definition, (name) => available.sheet.libSymbols.get(name)),
    unit
  )
}

/** Pin connection points on the active sheet (attach targets, junction math). */
const sheetPinPoints = computed<Point[]>(() => {
  const net = connectivity.value
  if (!net) return []
  const sheet = activeSheetPath.value
  const points: Point[] = []
  for (const candidate of net.nets) {
    for (const pin of candidate.pins) {
      if (pin.sheetPath === sheet) points.push(pin.position)
    }
  }
  return points
})

/** Net names offered by the label autocomplete (KiCad fallback names excluded). */
const netNames = computed<string[]>(() => {
  const net = connectivity.value
  if (!net) return []
  return net.nets
    .map((candidate) => candidate.name)
    .filter((name) => !name.startsWith('Net-('))
    .sort()
})

const finishWire = (): void => {
  const points = mergeCollinearPoints(wireDraft.value)
  wireDraft.value = []
  const doc = schematic.value
  if (points.length < 2 || !doc) return
  const junctionPoints = junctionsForNewWire(
    doc.wires.map((wire) => wire.points),
    doc.junctions,
    sheetPinPoints.value,
    points
  )
  runCommand(
    t('commandLabels.addWire'),
    () => {
      const target = schematic.value
      if (!target) return
      addSchematicWireToAST(target, points)
      for (const point of junctionPoints) addSchematicJunctionToAST(target, point)
    },
    { cleanup: true }
  )
}

/** What the drawing tools read beyond their clicks. */
const draftOptions = (): DraftOptions => ({
  posture: wirePosture.value,
  busEntrySize: busEntrySize.value,
  directiveShape: directiveShape.value,
  buses: schematic.value?.buses.map((bus) => bus.points) ?? [],
  grid: gridStepNm(),
  image: pendingImage.value
})

const DRAW_LABELS: Record<DrawItem['kind'], MessageKey> = {
  polyline: tk('commandLabels.addLine'),
  bus: tk('commandLabels.addBus'),
  rectangle: tk('commandLabels.addRectangle'),
  circle: tk('commandLabels.addCircle'),
  arc: tk('commandLabels.addArc'),
  bezier: tk('commandLabels.addBezier'),
  table: tk('commandLabels.addTable'),
  rule_area: tk('commandLabels.addRuleArea'),
  image: tk('commandLabels.addImage'),
  text_box: tk('commandLabels.addTextBox'),
  bus_entry: tk('commandLabels.addBusEntry'),
  directive_label: tk('commandLabels.addDirectiveLabel')
}

/** Write a drawn item as one undo step; a bus is tidied as a wire is (`wireCleanup.ts`). */
const commitDrawItem = (item: DrawItem): void => {
  runCommand(
    t(DRAW_LABELS[item.kind]),
    () => {
      if (schematic.value) writeDrawItem(schematic.value, item)
    },
    { cleanup: item.kind === 'bus' || item.kind === 'bus_entry' }
  )
}

/** Close out a line, bus or rule area: its clicked vertices, corners merged.
 *  A rule area needs three corners to enclose anything (KiCad scraps fewer). */
const finishRun = (): void => {
  const points = mergeCollinearPoints(drawDraft.value)
  drawDraft.value = []
  const tool = activeTool.value
  if (tool === 'rule_area') {
    if (points.length >= 3) commitDrawItem({ kind: 'rule_area', points })
    return
  }
  if (points.length < 2) return
  commitDrawItem(tool === 'bus' ? { kind: 'bus', points } : { kind: 'polyline', points })
}

/**
 * The image tool: pick a picture, then it rides the cursor until a click
 * places it (KiCad's Place Image). A file that is not a picture arms nothing.
 */
const armImage = async (): Promise<void> => {
  if (props.isReadOnly) return
  const path = await window.api.pickFile({
    title: t('schematicEditor.image.pickTitle'),
    filters: [{ name: t('schematicEditor.image.filter'), extensions: IMAGE_IMPORT_EXTENSIONS }]
  })
  if (!path) return
  const data = await pngFromImageFile(path)
  if (!data) {
    window.alert(t('schematicEditor.image.unreadable'))
    return
  }
  setTool('image')
  pendingImage.value = data
}

/** The parsed child behind a sheet box, for the labels a pin can import. */
const childSchematicOf = (sheet: KicadSheet): KicadSchematic | null => {
  const childPath = `${activeSheetPath.value}/${sheet.uuid ?? ''}`
  return sheetSources.value.find((source) => source.sheetPath === childPath)?.schematic ?? null
}

const handleToolClick = (point: Point, screen: { x: number; y: number }): void => {
  const tool = activeTool.value
  if (tool === 'select' || props.isReadOnly) return
  if (isRunTool(tool)) {
    const draft = drawDraft.value
    if (!draft.length) {
      drawDraft.value = [point]
      return
    }
    const last = draft[draft.length - 1]
    // A rule area closes on its first corner, as KiCad's polygon tools do.
    const closes = tool === 'rule_area' && draft.length >= 3 && pointsEqualNm(draft[0], point)
    if (pointsEqualNm(last, point) || closes) {
      finishRun()
      return
    }
    drawDraft.value = [
      ...draft,
      ...(tool === 'bus' ? elbowPoints(last, point, wirePosture.value) : [point])
    ]
    // A bus landing on another bus, a sheet pin or a label completes, as a
    // wire does on what it connects to (KiCad's `IsTerminalPoint`).
    const doc = schematic.value
    if (
      tool === 'bus' &&
      doc &&
      isWireAttachPoint(
        point,
        doc.buses.map((bus) => bus.points),
        busTerminals(doc)
      )
    )
      finishRun()
  } else if (isTwoClickTool(tool)) {
    if (!drawDraft.value.length) {
      drawDraft.value = [point]
      return
    }
    // A second click that spans nothing is not the end of the shape.
    const item = draftItem(tool, drawDraft.value, point, draftOptions())
    if (!item) return
    drawDraft.value = []
    if (item.kind === 'text_box') {
      pendingLabel.value = {
        kind: 'text_box',
        position: item.position,
        screen,
        box: { position: item.position, size: item.size }
      }
    } else {
      commitDrawItem(item)
    }
  } else if (tool === 'bezier') {
    const draft = drawDraft.value
    // The end must be somewhere else than the start; the control points may be anywhere.
    if (draft.length === 1 && pointsEqualNm(draft[0], point)) return
    if (draft.length < BEZIER_CLICKS - 1) {
      drawDraft.value = [...draft, point]
      return
    }
    const item = draftItem(tool, draft, point, draftOptions())
    drawDraft.value = []
    if (item) commitDrawItem(item)
  } else if (tool === 'image') {
    const item = draftItem(tool, [], point, draftOptions())
    if (!item) return
    commitDrawItem(item)
    setTool('select')
  } else if (tool === 'bus_entry') {
    const item = draftItem(tool, [], point, draftOptions())
    if (item) commitDrawItem(item)
  } else if (tool === 'sheet_pin') {
    const sheets = schematic.value?.sheets ?? []
    const target = sheetPinTarget(sheets, point)
    const sheet = target ? sheets[target.sheetIndex] : null
    if (!target || !sheet) return
    const names = unplacedSheetPins(sheet, childSchematicOf(sheet))
    pendingLabel.value = {
      kind: 'sheet_pin',
      position: target.position,
      screen,
      sheetPin: { sheetIndex: target.sheetIndex, side: target.side, names },
      initialText: names[0]?.name ?? ''
    }
  } else if (tool === 'wire') {
    const draft = wireDraft.value
    if (!draft.length) {
      wireDraft.value = [point]
      return
    }
    const last = draft[draft.length - 1]
    // Clicking the current end again reads as "done here".
    if (pointsEqualNm(last, point)) {
      finishWire()
      return
    }
    wireDraft.value = [...draft, ...elbowPoints(last, point, wirePosture.value)]
    // Landing on a pin, a sheet pin, a label or an existing wire completes the wire, KiCad-style.
    const doc = schematic.value
    if (
      doc &&
      isWireAttachPoint(
        point,
        doc.wires.map((wire) => wire.points),
        [...sheetPinPoints.value, ...wireTerminals(doc)]
      )
    ) {
      finishWire()
    }
  } else if (tool === 'symbol' || tool === 'power') {
    placeSymbolAt(point)
  } else if (tool === 'junction') {
    runCommand(t('commandLabels.addJunction'), () => {
      if (schematic.value) addSchematicJunctionToAST(schematic.value, point)
    })
  } else if (tool === 'no_connect') {
    runCommand(t('commandLabels.addNoConnect'), () => {
      if (schematic.value) addSchematicNoConnectToAST(schematic.value, point)
    })
  } else if (tool === 'sheet') {
    // Two clicks: the first anchors the top-left, the second sets the height
    // (width is the default until the resize handles adjust it).
    if (!sheetDraftStart.value) {
      sheetDraftStart.value = point
    } else {
      const rect = sheetDraftRect(sheetDraftStart.value, point)
      // A near-coincident second click (under 1 mm apart) gives a default-height sheet.
      if (rect.y1 - rect.y0 < NM_PER_MM) rect.y1 = nm(rect.y0 + SHEET_DEFAULT_HEIGHT)
      // sheetDraftStart is cleared inside openSheetPopover, after pendingSheet is
      // set, so the preview outline never flickers between the two states.
      void openSheetPopover(rect, screen)
    }
  } else {
    pendingLabel.value = { kind: tool, position: point, screen }
  }
}

/** Commit a sheet corner-drag resize (undoable). */
const handleResizeSheet = (
  index: number,
  position: Point,
  size: { width: Nm; height: Nm }
): void => {
  runCommand(t('commandLabels.resizeSheet'), () => {
    const sheet = schematic.value?.sheets[index]
    if (sheet) resizeSchematicSheetInAST(sheet, position, size)
  })
}

/** A free graphic's vertex dragged by its handle to `point` (sheet nm). */
const handleResizeGraphic = (
  item: { type: SheetGraphicType; index: number },
  vertexIndex: number,
  point: Point
): void => {
  runCommand(t('commandLabels.resizeGraphic'), () => {
    const doc = schematic.value
    const found = doc ? sheetGraphicOf(doc, item) : null
    if (found) setGraphicVertex(found.node, vertexIndex, point)
  })
}

/**
 * The sheet rectangle is fixed (two clicks done): gather the sibling file names
 * and a unique default stem, then open the in-place name/file popover. Nothing
 * is written until the popover commits.
 */
const openSheetPopover = async (
  rect: { x0: Nm; y0: Nm; x1: Nm; y1: Nm },
  screen: { x: number; y: number }
): Promise<void> => {
  if (props.isReadOnly) return
  const dir = dirnameOf(props.filePath)
  const entries = dir ? ((await window.api.readDirectory(dir)) as Array<{ name?: unknown }>) : []
  const siblings = entries
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === 'string')
  const defaultStem = uniqueFileName('sheet', '.kicad_sch', siblings).replace(/\.kicad_sch$/i, '')
  pendingSheet.value = { rect, screen, siblings, defaultStem }
  sheetDraftStart.value = null
}

/**
 * Commit the drawn sheet: write the child file (the non-undoable half) then
 * insert the `(sheet)` node into this sheet (the undoable half — §5.5). A
 * collision can't reach here (the popover blocks Enter), but the write is still
 * guarded.
 */
const commitPendingSheet = async (name: string, fileStem: string): Promise<void> => {
  const target = schematic.value
  const drawn = pendingSheet.value
  if (!target || !drawn) return
  const dir = dirnameOf(props.filePath)
  const fileName = `${fileStem}.kicad_sch`
  const childPath = `${dir}${separatorOf(props.filePath)}${fileName}`

  const res = await window.api.createFile(childPath, blankFileContent('schematic', fileName))
  if (!res.success) {
    window.alert(t('app.errors.createFile', { error: res.error }))
    return
  }

  const position = { x: nm(drawn.rect.x0), y: nm(drawn.rect.y0) }
  const size = {
    width: nm(drawn.rect.x1 - drawn.rect.x0),
    height: nm(drawn.rect.y1 - drawn.rect.y0)
  }
  const project = instanceProjectName.value
  // KiCad's GetNextPageNumber: the lowest page the whole design leaves free,
  // one per instance when this sheet is placed more than once.
  const nextPage = pageAllocator(pagesOf(sheetSources.value))
  const instances = activeInstancePaths.value.map((path) => ({ project, path, page: nextPage() }))
  runCommand(t('commandLabels.addSheet'), () => {
    const current = schematic.value
    if (!current) return
    addSchematicSheetToAST(current, {
      position,
      size,
      sheetName: name,
      sheetFile: basenameOf(childPath),
      instances
    })
  })
  pendingSheet.value = null
  emit('file-created', childPath)
}

/** Double click or right click: close out the wire or run, drop a half-drawn
 *  shape, or disarm the tool. */
const handleToolFinish = (): void => {
  const tool = activeTool.value
  if (tool === 'wire' && wireDraft.value.length) finishWire()
  else if (isRunTool(tool) && drawDraft.value.length) finishRun()
  else if (drawDraft.value.length) drawDraft.value = []
  else setTool('select')
}

const commitPendingLabel = (text: string, kind: PopoverKind, shape: DirectiveLabelShape): void => {
  const pending = pendingLabel.value
  pendingLabel.value = null
  const value = text.trim()
  if (!pending || !value) return
  if (kind === 'text') {
    runCommand(t('commandLabels.addText'), () => {
      if (schematic.value) addSchematicTextToAST(schematic.value, value, pending.position)
    })
  } else if (kind === 'text_box') {
    if (pending.box) commitDrawItem({ kind: 'text_box', ...pending.box, text: value })
  } else if (kind === 'sheet_pin') {
    const target = pending.sheetPin
    if (!target) return
    const sheet = schematic.value?.sheets[target.sheetIndex]
    // KiCad refuses a second pin of one name on a sheet; so does this.
    if (!sheet || sheet.pins.some((pin) => pin.name === value)) return
    const pinShape = target.names.find((entry) => entry.name === value)?.shape ?? 'input'
    runCommand(t('commandLabels.addSheetPin'), () => {
      const live = schematic.value?.sheets[target.sheetIndex]
      if (live) {
        addSheetPinToAST(live, {
          name: value,
          shape: pinShape,
          position: pending.position,
          side: target.side
        })
      }
    })
  } else if (kind === 'directive_label') {
    directiveShape.value = shape
    commitDrawItem({
      kind: 'directive_label',
      position: pending.position,
      shape,
      netclass: value
    })
    activeTool.value = kind
  } else {
    runCommand(t('commandLabels.addLabel'), () => {
      if (schematic.value) addSchematicLabelToAST(schematic.value, kind, value, pending.position)
    })
    // Switching kind in the popover re-arms the tool as that kind, so the
    // next click places the same thing.
    activeTool.value = kind
  }
}

// Every control on the toolbar, plus the placement tools only the search and
// their hotkeys reach (lib/toolSearch.ts). Ids are the tools' own.
const searchOps = computed<ToolbarSearchOp[]>(() => {
  const tool = (
    id: SchematicTool,
    icon: ToolbarSearchOp['icon'],
    label: string,
    group: ToolbarSearchOp['group'],
    action?: HotkeyActionId
  ): ToolbarSearchOp => ({
    id,
    icon,
    label,
    group,
    hotkey: action ? hotkeyLabel(action) : undefined,
    state: activeTool.value === id ? 'current' : undefined,
    disabled: props.isReadOnly && id !== 'select'
  })
  const op = (key: string): string => t(`schematicEditor.insertOverlay.ops.${key}`)
  return [
    tool('select', 'tool-select', t('schematicEditor.tools.select'), 'select', 'editor.cancel'),
    ...TRANSFORM_TOOLS.map(({ op, icon, label }): ToolbarSearchOp => ({
      id: op,
      icon,
      label: t(label),
      group: 'select',
      hotkey: hotkeyLabel(transformHotkeys[op]),
      disabled: !canTransform(op)
    })),
    tool('symbol', 'tool-symbol', op('symbol'), 'place', 'schematic.tool.symbol'),
    tool('power', 'tool-ground', op('power'), 'place', 'schematic.tool.power'),
    tool('sheet', 'tool-sheet', op('sheet'), 'place', 'schematic.tool.sheet'),
    tool('sheet_pin', 'tool-sheet-pin', op('sheetPin'), 'place'),
    tool('wire', 'tool-wire', op('wire'), 'connect', 'schematic.tool.wire'),
    tool('bus', 'tool-bus', op('bus'), 'connect', 'schematic.tool.bus'),
    tool('bus_entry', 'tool-bus-entry', op('busEntry'), 'connect', 'schematic.tool.busEntry'),
    tool('label', 'tool-label', op('label'), 'connect', 'schematic.tool.label'),
    tool('global_label', 'tool-flag', op('globalLabel'), 'connect', 'schematic.tool.globalLabel'),
    tool(
      'hierarchical_label',
      'tool-flag',
      op('hierarchicalLabel'),
      'connect',
      'schematic.tool.hierarchicalLabel'
    ),
    tool('directive_label', 'tool-directive', op('directiveLabel'), 'connect'),
    tool('no_connect', 'tool-no-connect', op('noConnect'), 'connect', 'schematic.tool.noConnect'),
    tool('junction', 'tool-junction', op('junction'), 'connect', 'schematic.tool.junction'),
    tool('text', 'tool-text', op('text'), 'draw', 'schematic.tool.text'),
    tool('text_box', 'tool-text-box', op('textBox'), 'draw'),
    tool('line', 'tool-line', op('line'), 'draw', 'schematic.tool.line'),
    tool('rectangle', 'tool-rect', op('rectangle'), 'draw'),
    tool('circle', 'tool-circle', op('circle'), 'draw', 'schematic.tool.circle'),
    tool('arc', 'tool-arc', op('arc'), 'draw', 'schematic.tool.arc'),
    tool('bezier', 'tool-bezier', op('bezier'), 'draw', 'schematic.tool.bezier'),
    tool('table', 'tool-table', op('table'), 'draw'),
    tool('image', 'tool-image', op('image'), 'draw'),
    tool('rule_area', 'tool-rule-area', op('ruleArea'), 'connect', 'schematic.tool.ruleArea'),
    {
      id: 'annotate',
      icon: 'tool-annotate',
      label: t('schematicEditor.tools.annotateTitle'),
      group: 'utilities',
      disabled: props.isReadOnly
    },
    {
      id: 'incrementAnnotations',
      icon: 'tool-annotate',
      label: t('schematicEditor.incrementAnnotations.action'),
      group: 'utilities',
      disabled: props.isReadOnly
    },
    {
      id: 'cycleBodyStyle',
      icon: 'tool-unit',
      label: t('schematicEditor.units.cycleBodyStyle'),
      group: 'select',
      disabled: props.isReadOnly || !bodyStyleSymbols.value.length
    },
    ...[...ALIGN_OPS, ...DISTRIBUTE_OPS].map((entry): ToolbarSearchOp => ({
      id: entry.id,
      icon: entry.icon,
      label: t(entry.label),
      group: 'select',
      disabled:
        props.isReadOnly || alignableCount.value < (entry.id.startsWith('distribute.') ? 3 : 2)
    })),
    {
      id: 'find',
      icon: 'search',
      label: t('schematicEditor.find.title'),
      group: 'utilities',
      hotkey: hotkeyLabel('editor.find')
    },
    {
      id: 'updateSymbols',
      icon: 'refresh',
      label: t('schematicEditor.symbolUpdate.updateAction'),
      group: 'utilities',
      disabled: props.isReadOnly
    },
    {
      id: 'changeSymbol',
      icon: 'tool-symbol',
      label: t('schematicEditor.symbolUpdate.changeAction'),
      group: 'utilities',
      disabled: props.isReadOnly || selectedSymbolIndices.value.size === 0
    },
    fitViewOp(t('shared.insertSearch.ops.fitView'), hotkeyLabel('editor.fitView')),
    ...viewCommandOps(t, selectedItems.value.length > 0),
    {
      id: 'enterSheet',
      icon: 'tool-sheet',
      label: t('schematicEditor.hierarchy.enterSheet'),
      group: 'navigate',
      disabled: selectedSheetIndex.value === null
    },
    {
      id: 'leaveSheet',
      icon: 'arrow-up',
      label: t('schematicEditor.hierarchy.leaveSheet'),
      group: 'navigate',
      hotkey: hotkeyLabel('schematic.leaveSheet'),
      disabled: !canLeaveSheet.value
    },
    {
      id: 'netHighlight',
      icon: 'view-net-highlight',
      label: t('schematicEditor.viewRail.netHighlight'),
      group: 'display',
      state: schematicView.value.netHighlight ? 'on' : undefined
    },
    {
      id: 'showHiddenPins',
      icon: 'view-hidden-pins',
      label: t('schematicEditor.viewRail.showHiddenPins'),
      group: 'display',
      state: schematicView.value.showHiddenPins ? 'on' : undefined
    },
    {
      id: 'showHiddenFields',
      icon: 'view-hidden-fields',
      label: t('schematicEditor.viewRail.showHiddenFields'),
      group: 'display',
      state: schematicView.value.showHiddenFields ? 'on' : undefined
    }
  ]
})

// ---- Left view rail: zoom to fit and the display switches ----------------
// The switches persist app-wide (lib/schematicView.ts).
const schematicView = schematicViewState()
const toggleNetHighlight = (): void =>
  setSchematicView({ netHighlight: !schematicView.value.netHighlight })
const toggleHiddenPins = (): void =>
  setSchematicView({ showHiddenPins: !schematicView.value.showHiddenPins })
const toggleHiddenFields = (): void =>
  setSchematicView({ showHiddenFields: !schematicView.value.showHiddenFields })

const onSearchPick = (id: string): void => {
  if (id === FIT_VIEW_OP_ID) viewport.value?.zoomToFit()
  else if (isViewCommand(id)) viewport.value?.runViewCommand(id)
  else if (id === 'netHighlight') toggleNetHighlight()
  else if (id === 'showHiddenPins') toggleHiddenPins()
  else if (id === 'showHiddenFields') toggleHiddenFields()
  else if (id === 'annotate') annotateOpen.value = true
  else if (isTransformOp(id)) runTransform(id)
  else if (runEditorAction(id)) return
  // Symbol/power need a part picked first — route through the chooser.
  else if (id === 'symbol' || id === 'power') openChooser(id)
  else setTool(id as SchematicTool)
}

// ---- Project hierarchy (comprehensive multi-sheet components view) --------
const normalizePath = (path: string): string => path.replace(/[\\/]+/g, '/').toLowerCase()
const samePath = (a: string, b: string): boolean => normalizePath(a) === normalizePath(b)
const canUndo = computed(() => {
  void historyVersion.value
  void revision.value
  return props.session.canUndo()
})
const canRedo = computed(() => {
  void historyVersion.value
  void revision.value
  return props.session.canRedo()
})

// Text the session did not write — a rename's forwarding, a sibling's
// annotate, an agent's edit — arrives as the tab's buffer changing under it.
watch(
  () => props.modelValue,
  () => props.session.sync()
)

/**
 * One undoable step, run by the session: `mutate` edits the sheet in place and
 * may return the sibling sheets it rewrote as text. The selection rides along
 * so undo puts it back, and a tidy that renumbered wires drops theirs.
 */
const runCommand = (
  label: string,
  mutate: () => void | SheetEdit[],
  options: { cleanup?: boolean } = {}
): CleanupReport | null => {
  if (props.isReadOnly) return null
  const noteRepeat = clipboard.beforeCommand(label)
  const selectionBefore = selectedItems.value.map((item) => ({ ...item }))
  const report = props.session.runCommand(label, mutate, {
    cleanup: options.cleanup,
    selection: {
      before: selectionBefore,
      after: (tidy) => {
        if (tidy && cleanupChanged(tidy)) {
          selectedItems.value = selectedItems.value.filter(
            (item) => item.type !== 'wire' && item.type !== 'bus' && item.type !== 'junction'
          )
        }
        return selectedItems.value.map((item) => ({ ...item }))
      }
    }
  })
  historyVersion.value++
  noteRepeat?.()
  return report
}

/** Which turn or flip a key asks for. */
const transformOpFor = (event: KeyboardEvent): TransformOp | null => {
  if (matchesHotkey(event, 'schematic.rotate')) return 'rotateCCW'
  if (matchesHotkey(event, 'schematic.rotateClockwise')) return 'rotateCW'
  if (matchesHotkey(event, 'schematic.mirrorHorizontal')) return 'mirrorHorizontal'
  if (matchesHotkey(event, 'schematic.mirrorVertical')) return 'mirrorVertical'
  return null
}

/** The rotate and mirror chips' hotkeys (`TRANSFORM_TOOLS`). */
const transformHotkeys: Record<TransformOp, HotkeyActionId> = {
  rotateCCW: 'schematic.rotate',
  rotateCW: 'schematic.rotateClockwise',
  mirrorHorizontal: 'schematic.mirrorHorizontal',
  mirrorVertical: 'schematic.mirrorVertical'
}

/**
 * Turn or flip, from a key or a toolbar chip: the armed ghost first, then a
 * drag in flight (about the cursor, landing with the drop), then the selection
 * in place. False when there is nothing for it to act on.
 */
const runTransform = (op: TransformOp): boolean => {
  if (props.isReadOnly) return false
  if (placement.value) {
    const { angle, mirror } = transformOrientation(placement.value, op)
    placement.value = { ...placement.value, angle, mirror }
  } else if (op === 'rotateCCW' && activeTool.value === 'bus_entry') {
    busEntrySize.value = rotateBusEntrySize(busEntrySize.value)
  } else if (viewport.value?.applyDragTransform(op)) {
    // Landed on the drag.
  } else if (selectedItems.value.length) {
    transformSelection(op)
  } else return false
  return true
}

/** Whether a chip has something to act on; a drag in flight is never one. */
const canTransform = (op: TransformOp): boolean =>
  !props.isReadOnly &&
  (selectedItems.value.length > 0 ||
    !!placement.value ||
    (op === 'rotateCCW' && activeTool.value === 'bus_entry'))

/** Turn or flip the selection, wires following and riders carried — the same
 *  plan a drag makes, from where each pin lands (`schematicMove.ts`). */
const transformSelection = (op: TransformOp): void => {
  const doc = schematic.value
  if (!doc || props.isReadOnly) return
  const plan = planTransform(doc, selectedItems.value, op, gridStepNm())
  const fields = loneFields(selectedItems.value)
  if (!plan && !fields.length) return
  const count = transformedItemCount(selectedItems.value)
  const label =
    op === 'rotateCCW' || op === 'rotateCW'
      ? tk('commandLabels.rotate')
      : tk('commandLabels.mirror')
  runCommand(
    t(label, count),
    () => {
      const target = schematic.value
      if (!target) return
      if (plan) applyTransform(target, activeSheetPath.value, plan)
      for (const { index, field } of fields) {
        const symbol = target.symbols[index]
        if (symbol) transformSchematicFieldInAST(symbol, field, op)
      }
    },
    { cleanup: true }
  )
}

/** The grid step in sheet nanometers: how far a wire leaves a pin before bending. */
const gridStepNm = (): Nm =>
  mmToNm(spacingToMm(gridSettings.value.spacing, gridSettings.value.unit))

const handleMove = (
  items: SchematicItemRef[],
  delta: Point,
  options: { wires: boolean; steps?: PlacementStep[] } = { wires: true }
): void => {
  // A drag that turned mid-way lands as one step: the turns about where the
  // cursor stood, then the shift, wires following from where every pin ends.
  if (options.steps?.length) {
    runCommand(
      t('commandLabels.move', items.length),
      () => {
        const doc = schematic.value
        if (!doc) return
        const plan = planPlacement(doc, items, options.steps ?? [], delta, {
          grid: gridStepNm(),
          wires: options.wires
        })
        if (plan) applyTransform(doc, activeSheetPath.value, plan)
      },
      { cleanup: true }
    )
    return
  }
  runCommand(
    t('commandLabels.move', items.length),
    () => {
      const doc = schematic.value
      if (!doc) return
      // Planned before anything moves: the plan reads the sheet as it is, and
      // is the same one the drag previewed (`schematicMove.ts`).
      const plan = planMove(doc, items, delta, { grid: gridStepNm(), wires: options.wires })
      translateSchematicItems(doc, items, delta)
      applyMovePlan(doc, plan)
    },
    { cleanup: true }
  )
}

/**
 * One point of a wire or bus dragged by its handle: the plan the drag
 * previewed, recomputed from the sheet as it is, then the tidy — which joins
 * what the point landed on and drops what it left.
 */
const handleDragVertex = (
  target: VertexTarget,
  delta: Point,
  options: { wires: boolean }
): void => {
  runCommand(
    target.type === 'bus' ? t('commandLabels.dragBusEnd') : t('commandLabels.dragWireEnd'),
    () => {
      const doc = schematic.value
      if (!doc) return
      if (target.type === 'bus') {
        for (const edit of planBusVertexDrag(doc, target, delta, options.wires)) {
          const bus = doc.buses[edit.index]
          if (bus) setSchematicWirePointsInAST(bus, edit.points)
        }
        return
      }
      const plan = planVertexDrag(doc, target, delta, {
        grid: gridStepNm(),
        wires: options.wires
      })
      if (plan) applyVertexDrag(doc, plan, delta)
    },
    { cleanup: true }
  )
}

/** Re-select what an undone or redone step had selected, dropping anything the
 *  restored sheet no longer has. */
const restoreSelection = (selection: Array<{ type: string; index: number }>): void => {
  const doc = schematic.value
  if (!doc) {
    selectedItems.value = []
    return
  }
  selectedItems.value = selection
    .filter((item) => schematicItemExists(doc, item))
    .map((item) => ({ ...item }) as SchematicItemRef)
}

const deleteSelected = (): void => {
  const items = selectedItems.value
  if (!items.length) return
  const label = t('commandLabels.delete', items.length)
  runCommand(
    label,
    () => {
      if (schematic.value) removeSchematicItemsFromAST(schematic.value, items)
      // Clear inside the command so the history's after-selection is empty
      // rather than pointing at deleted (reshuffled) indices.
      selectedItems.value = []
    },
    { cleanup: true }
  )
}

const undo = (): void => {
  if (props.isReadOnly) return
  const entry = props.session.undo()
  if (entry) {
    restoreSelection(entry.selectionBefore)
    historyVersion.value++
  }
}

const redo = (): void => {
  if (props.isReadOnly) return
  const entry = props.session.redo()
  if (entry) {
    restoreSelection(entry.selectionAfter)
    historyVersion.value++
  }
}

const initializeBlank = (): void => {
  const content = `(kicad_sch\n  (version 20231120)\n  (generator "goatcad")\n  (generator_version "1.0")\n  (uuid "${crypto.randomUUID()}")\n  (paper "A4")\n  (lib_symbols)\n  (sheet_instances\n    (path "/" (page "1")))\n)\n`
  props.session.initializeBlank(content)
}

// ---- Components (the design-wide table is its own tab) --------------------

// The design this sheet belongs to, by its top-level schematic: the root of the
// resolved hierarchy, or the sheet itself while that is unread or it stands alone.
const designRootPath = computed(() => {
  void revision.value
  void openSheetsVersion.value
  return props.session.hierarchy()?.rootFilePath ?? props.filePath
})

/** Offered with nothing selected, like the board's Fabrication outputs. */
const canOpenComponents = computed(
  () => selectedItems.value.length === 0 && !!props.filePath && !!schematic.value
)

// Each sheet instance contributes its parsed schematic; the active file uses
// the live (edited) schematic, other files their disk-loaded copies. A file
// reused as a repeated sheet appears once per instance with distinct paths.
const sheetSources = computed<SheetSource[]>(() => {
  void revision.value
  void openSheetsVersion.value
  return props.session.sheetSources()
})

const records = computed(() => buildProjectComponentRecords(sheetSources.value))

// ---- Connectivity (geometry → netlist; powers hover net highlighting) ------
// Rebuilt whole-project on every edit: the engine is pure and fast enough for
// typical sheets, and staleness bugs cost more than the rebuild.
/**
 * The per-sheet inputs the graph is built from — shared with the hierarchy
 * checks, which need the sheet tree and not just the nets it produces.
 */
// The nets the checks, the hover highlight and the agent all read: one graph,
// built by the session over every sheet of the design.
const connectivity = computed(() => {
  void revision.value
  void openSheetsVersion.value
  return props.session.connectivity()
})
/** The project's classes, which style wires and buses; the session re-reads them with the project. */
const netClasses = computed(() => {
  void revision.value
  return { classOf: props.session.netClassOf, fallback: props.session.defaultNetClass() }
})

// This file's instance path within the hierarchy: the one it was entered
// through (lib/schematic/sheetNavigation.ts), else its first — a repeated
// sheet's geometry is identical under every path.
const activeSheetPath = computed<string>(() => {
  void revision.value
  const entered = enteredInstancePath(props.filePath)
  return entered && props.session.instancePaths().includes(entered)
    ? entered
    : props.session.sheetPath()
})

// ---- Hierarchy navigation (KiCad's Enter sheet / Leave sheet) ---------------
const hierarchyTree = computed(() => {
  void revision.value
  void openSheetsVersion.value
  return props.session.hierarchy()
})

/** The instances from the root down to the one on screen (one on a flat
 *  design): what Leave sheet climbs. */
const breadcrumb = computed(() => sheetBreadcrumb(hierarchyTree.value, activeSheetPath.value))
const canLeaveSheet = computed(() => breadcrumb.value.length > 1)

/** Show an instance: this tab when it is this file, else the file's tab. */
const goToInstance = (instance: SheetVisit, uuids: string[] = []): void => {
  noteEnteredInstance(instance.filePath, instance.sheetPath)
  if (!samePath(instance.filePath, props.filePath)) {
    emit('reveal-in-sheet', instance.filePath, uuids)
  }
}

/** The sheet box selected alone (or by one of its fields), or null. */
const selectedSheetIndex = computed<number | null>(() => {
  const items = selectedItems.value
  const item = items[0]
  if (!item || items.some((other) => other.index !== item.index || other.type !== item.type))
    return null
  return item.type === 'sheet' || item.type === 'sheet_field' ? item.index : null
})

/** Open the child a sheet box names, as the instance under this one. */
const enterSheet = (index: number): void => {
  const sheet = schematic.value?.sheets[index]
  if (!sheet?.uuid) return
  const child = childInstance(hierarchyTree.value, activeSheetPath.value, sheet.uuid)
  if (child) {
    goToInstance(child)
    return
  }
  // A sheet the tree has not read yet (drawn a moment ago): its file, as written.
  const file = getSheetProperty(sheet, 'Sheetfile')
  if (!file) return
  const path = resolveRelativePath(dirnameOf(props.filePath), file)
  noteEnteredInstance(path, childSheetPath(activeSheetPath.value, sheet.uuid))
  emit('reveal-in-sheet', path, [])
}

/** Up to the parent instance, with the sheet box just left selected there. */
const leaveSheet = (): void => {
  const crumbs = breadcrumb.value
  const parent = crumbs[crumbs.length - 2]
  const here = crumbs[crumbs.length - 1]
  if (!parent || !here) return
  goToInstance(parent, [here.sheetPath.slice(here.sheetPath.lastIndexOf('/') + 1)])
}

// ---- Back / forward and previous / next sheet (KiCad's navigation) ---------
// Every instance this editor shows while it holds the keyboard is a visit; a
// step back or forward shows its entry, which the history does not count again.
watch(
  [activeSheetPath, () => props.filePath, groupFocused],
  ([sheetPath, filePath, focused]) => {
    if (focused && sheetPath && filePath) sheetHistory.visit({ filePath, sheetPath })
  },
  { immediate: true }
)

/** The design's instance a visit names, when it still has it. */
const instanceOf = (visit: SheetVisit): SheetInstance | null =>
  hierarchyTree.value?.instances.find(
    (instance) =>
      instance.sheetPath === visit.sheetPath && samePath(instance.filePath, visit.filePath)
  ) ?? null

const goBack = (): void => {
  const visit = sheetHistory.back((entry) => !!instanceOf(entry))
  if (visit) goToInstance(visit)
}

const goForward = (): void => {
  const visit = sheetHistory.forward((entry) => !!instanceOf(entry))
  if (visit) goToInstance(visit)
}

/** The design's instances by page, as KiCad numbers its virtual pages. */
const pageOrder = computed(() => inPageOrder(sheetSources.value))
const neighborSheet = (delta: 1 | -1): SheetVisit | null =>
  adjacentSheet(pageOrder.value, activeSheetPath.value, delta)

const stepSheet = (delta: 1 | -1): void => {
  const next = neighborSheet(delta)
  if (next) goToInstance(next)
}

/** The Go menu's rows (lib/editActions.ts), replayed as their keys. */
const schematicNavGroups = computed(() => [
  [
    {
      hotkey: 'schematic.sheetBack' as HotkeyActionId,
      label: t('titleBar.menu.goBack'),
      enabled: sheetHistory.canBack()
    },
    {
      hotkey: 'schematic.sheetForward' as HotkeyActionId,
      label: t('titleBar.menu.goForward'),
      enabled: sheetHistory.canForward()
    }
  ],
  [
    {
      hotkey: 'schematic.leaveSheet' as HotkeyActionId,
      label: t('titleBar.menu.goLeaveSheet'),
      enabled: canLeaveSheet.value
    }
  ],
  [
    {
      hotkey: 'schematic.previousSheet' as HotkeyActionId,
      label: t('titleBar.menu.goPreviousSheet'),
      enabled: !!neighborSheet(-1)
    },
    {
      hotkey: 'schematic.nextSheet' as HotkeyActionId,
      label: t('titleBar.menu.goNextSheet'),
      enabled: !!neighborSheet(1)
    }
  ]
])
usePublishedNavActions(schematicNavGroups)

const onItemDblclick = (item: SchematicItemRef): void => {
  if (item.type === 'sheet' || item.type === 'sheet_field') enterSheet(item.index)
}

// ---- Canvas context menu ------------------------------------------------------
const canvasMenu = ref<{ x: number; y: number } | null>(null)

/** Right-click selects what is under the cursor first, keeping a selection it
 *  is part of — acting on what the user did not select is the classic trap. */
const onCanvasContextMenu = (payload: {
  clientX: number
  clientY: number
  hit: SchematicItemRef | null
}): void => {
  const { hit } = payload
  if (hit) {
    if (!selectedItems.value.some((item) => sameSchematicRef(item, hit))) {
      selectedItems.value = [hit]
      probeSelection()
    }
  } else if (selectedItems.value.length) {
    selectedItems.value = []
  }
  canvasMenu.value = { x: payload.clientX, y: payload.clientY }
  menuPoint = viewport.value?.getCursor()?.point
  menuNet.value = viewport.value?.netAtPointer() ?? null
}

/** The net under the point the menu was opened at, for its Highlight Net. */
const menuNet = ref<string | null>(null)

/** The sheet point the menu was opened over (sheet nm), while it is open. */
let menuPoint: Point | undefined

/** Commands the menu and the tool search run by id, beside the edit keys. */
const runEditorAction = (id: string): boolean => {
  if (id === 'enterSheet') {
    if (selectedSheetIndex.value !== null) enterSheet(selectedSheetIndex.value)
  } else if (id === 'leaveSheet') leaveSheet()
  else if (id === 'updateSymbols') openSymbolUpdate()
  else if (id === 'changeSymbol') openSymbolChange()
  else if (id === 'find') openFind()
  else if (id === 'incrementAnnotations') incrementOpen.value = true
  else if (id === 'cycleBodyStyle') setSelectedBodyStyle('next')
  else if (id === 'image') void armImage()
  else if (id.startsWith('unit:')) void setSelectedUnit(Number(id.slice('unit:'.length)))
  else if (id.startsWith('align.')) alignSelection(id.slice('align.'.length) as AlignOp)
  else if (id.startsWith('distribute.'))
    distributeSelection(id.slice('distribute.'.length) as DistributeOp)
  else if (id === 'selectOther') {
    if (canvasMenu.value) viewport.value?.selectOtherAt(canvasMenu.value)
  } else if (id === 'schematic.highlightNet') setHighlightedNet(menuNet.value)
  else if (id === 'schematic.clearHighlight') setHighlightedNet(null)
  else return false
  return true
}

const canvasMenuItems = computed<MenuNode[]>(() => {
  // Select Other and the net highlight, over what is at the menu's point.
  const view: MenuNode[] = [{ id: 'selectOther', label: t('shared.selectOther.menu') }]
  if (menuNet.value && menuNet.value !== highlightedNet.value)
    view.push({
      id: 'schematic.highlightNet',
      label: t('shared.netHighlight.highlight'),
      shortcut: hotkeyLabel('schematic.highlightNet')
    })
  if (highlightedNet.value)
    view.push({
      id: 'schematic.clearHighlight',
      label: t('shared.netHighlight.clearMenu'),
      shortcut: hotkeyLabel('schematic.clearHighlight')
    })
  const navigation: MenuNode[] = []
  if (selectedSheetIndex.value !== null)
    navigation.push({ id: 'enterSheet', label: t('schematicEditor.hierarchy.enterSheet') })
  if (canLeaveSheet.value)
    navigation.push({
      id: 'leaveSheet',
      label: t('schematicEditor.hierarchy.leaveSheet'),
      shortcut: hotkeyLabel('schematic.leaveSheet')
    })
  const symbols: MenuNode[] = []
  if (unitMenu.value) symbols.push(unitMenu.value)
  if (bodyStyleSymbols.value.length && !props.isReadOnly)
    symbols.push({ id: 'cycleBodyStyle', label: t('schematicEditor.units.cycleBodyStyle') })
  if (loneSymbol.value) {
    symbols.push({
      id: 'schematic.openInLibraryEditor',
      label: t('schematicEditor.units.openInLibraryEditor'),
      shortcut: hotkeyLabel('schematic.openInLibraryEditor'),
      disabled: !findLibrarySymbol(loneSymbol.value.libId)
    })
    symbols.push({
      id: 'schematic.showDatasheet',
      label: t('schematicEditor.units.showDatasheet'),
      shortcut: hotkeyLabel('schematic.showDatasheet'),
      disabled: !datasheetTarget(getSymbolProperty(loneSymbol.value, 'Datasheet'), projectDir.value)
    })
  }
  if (selectedSymbolIndices.value.size && !props.isReadOnly) {
    symbols.push(
      { id: 'updateSymbols', label: t('schematicEditor.symbolUpdate.updateAction') },
      { id: 'changeSymbol', label: t('schematicEditor.symbolUpdate.changeAction') }
    )
  }
  const arrange: MenuNode[] = []
  if (!props.isReadOnly && alignableCount.value >= 2) {
    arrange.push({
      id: 'align',
      label: t('schematicEditor.align.menu'),
      children: [
        ...ALIGN_OPS.slice(0, 3).map(alignMenuItem),
        { divider: true },
        ...ALIGN_OPS.slice(3).map(alignMenuItem)
      ]
    })
    arrange.push({
      id: 'distribute',
      label: t('schematicEditor.align.distributeMenu'),
      disabled: alignableCount.value < 3,
      children: DISTRIBUTE_OPS.map(alignMenuItem)
    })
  }
  const groups: MenuNode[][] = [
    view,
    navigation,
    symbols,
    arrange,
    buildEditMenu(schematicEditGroups.value)
  ]
  return groups
    .filter((group) => group.length)
    .flatMap((group, index) => (index ? [{ divider: true } as MenuNode, ...group] : group))
})

const closeCanvasMenu = (): void => {
  canvasMenu.value = null
  menuPoint = undefined
}

const onCanvasMenuSelect = (id: string): void => {
  if (!runEditorAction(id) && isHotkeyActionId(id)) dispatchEditAction(id)
}

// ---- Design health: the pill and the findings drawer ------------------------
// (design-health-workstream.md). The same checks `schematic.check` answers with, over
// the whole design; a finding on another sheet opens that sheet.
const healthDrawer = useHealthDrawer('schematic')
const healthOpen = healthDrawer.open
const healthHeight = healthDrawer.height

/**
 * The design around the sheet has been read — its other sheets, the library
 * tiers, the project's ERC settings and libraries. Until then the checks see
 * part of it and their counts would move as each piece lands, so the pill
 * holds as not yet checked.
 */
const checksReady = ref(false)
void props.session.ready().then(() => (checksReady.value = true))

/**
 * The last findings the checks answered with. They run off this thread
 * (`session.backgroundChecks`), so an edit draws at once and its findings land
 * a moment later; meanwhile the pill holds the last ones and shows the check
 * running.
 */
const checkResults = shallowRef<CheckResult[]>([])
const checksAnswered = ref(false)
const checksRunning = ref(false)
let checksAsked = 0
watch(
  () => [
    checksReady.value,
    revision.value,
    openSheetsVersion.value,
    ...props.session.checkSources()
  ],
  () => {
    if (!checksReady.value) return
    const asked = ++checksAsked
    checksRunning.value = true
    void props.session.backgroundChecks().then((results) => {
      // A newer edit's check is on its way; it answers instead.
      if (!results || asked !== checksAsked) return
      checkResults.value = results
      checksAnswered.value = true
      checksRunning.value = false
    })
  },
  { immediate: true, flush: 'post' }
)

/** Every instance of the sheet on screen: a finding on any of them is here. */
const hereSheetPaths = computed(() => {
  void revision.value
  return new Set([activeSheetPath.value, ...props.session.instancePaths()])
})

const healthFindings = computed<HealthFinding[]>(() => {
  const names = new Map(
    (props.session.hierarchy()?.instances ?? []).map((instance) => [
      instance.sheetPath,
      instance.namePath
    ])
  )
  const fix = props.isReadOnly ? undefined : t('schematicEditor.symbolUpdate.quickFix')
  return schematicFindings(checkResults.value, names).map((finding) =>
    fix && finding.code === 'symbol-library-mismatch' ? { ...finding, fix } : finding
  )
})

const healthPinned = panelPinned('schematic', 'health')

// Each finding on the sheet instance in view, marked on the canvas; a click
// on one selects its row.
const healthView = designHealthViewState()
/** The finding the drawer or a marker last picked: its marker draws over the rest. */
const pickedFinding = ref<string | null>(null)
const findingMarkers = computed(() =>
  healthView.value.showMarkers && checksAnswered.value
    ? findingMarks(
        checkResults.value,
        healthFindings.value,
        (result) =>
          result.sheetPath === undefined || result.sheetPath === activeSheetPath.value
            ? (result.position ?? null)
            : null,
        pickedFinding.value
      )
    : []
)
const findingReveal = shallowRef<{ key: string; seq: number } | null>(null)
let revealSeq = 0
const revealFinding = (key: string): void => {
  if (!healthPinned.value) healthDrawer.show()
  findingReveal.value = { key, seq: ++revealSeq }
  pickedFinding.value = key
}
const healthReport = computed<HealthReport>(() =>
  checksAnswered.value
    ? { status: 'checked', findings: healthFindings.value }
    : { status: 'pending' }
)

const locateFinding = (finding: HealthFinding, zoom = false): void => {
  pickedFinding.value = finding.key
  // Findings are built index for index from the results.
  const index = healthFindings.value.findIndex((entry) => entry.key === finding.key)
  const result = checkResults.value[index]
  if (!result) return
  const sheetPath = result.sheetPath
  if (sheetPath && !hereSheetPaths.value.has(sheetPath)) {
    const file = props.session
      .hierarchy()
      ?.instances.find((instance) => instance.sheetPath === sheetPath)?.filePath
    if (file) emit('reveal-in-sheet', file, result.targets ?? [], result.position, finding.key)
    return
  }
  const at = result.position
  if (!at) return reveal(itemsWithUuids(result.targets ?? []))
  selectedItems.value = itemsWithUuids(result.targets ?? [])
  void nextTick(() => viewport.value?.showFinding(at, zoom))
}

// ---- Selection inspector (first selected item drives the right panel) ------
const selectedItem = computed(() => selectedItems.value[0] ?? null)

const selectedNetName = computed(() => {
  const item = selectedItem.value
  const net = connectivity.value
  if (!item || !net) return null
  if (item.type === 'wire') return net.netOfWire(activeSheetPath.value, item.index)?.name ?? null
  const position =
    item.type === 'label'
      ? schematic.value?.labels[item.index]?.position
      : item.type === 'junction'
        ? schematic.value?.junctions[item.index]
        : null
  return position ? (net.netAt(activeSheetPath.value, position)?.name ?? null) : null
})

const recordsById = computed(() => new Map(records.value.map((record) => [record.id, record])))

// Symbol indices (into the active schematic) contributed by a record.
const activeIndicesOf = (record: ComponentRecord): number[] =>
  record.locations
    .filter((location) => samePath(location.filePath, props.filePath))
    .map((location) => location.symbolIndex)

const selectedComponentIds = computed(() => {
  const selected = new Set(selectedIndices.value)
  return records.value
    .filter(
      (record) =>
        samePath(record.filePath, props.filePath) &&
        activeIndicesOf(record).some((index) => selected.has(index))
    )
    .map((record) => record.id)
})

/** Tell a board beside this sheet what was just selected (lib/crossProbe.ts).
 *  Called from the user's own selection gestures only, never from a reveal. */
const probeSelection = (): void => {
  const sheet = schematic.value
  if (!sheet || !props.filePath) return
  const targets = selectedItems.value
    .filter((item) => item.type === 'symbol')
    .map((item) => sheet.symbols[item.index])
    .filter((symbol) => !!symbol?.uuid)
    .map((symbol) => {
      // A single-instance symbol's reference; on a reused sheet the instances
      // disagree, and the uuid link is what finds the footprint.
      const reference = symbol.instances.length === 1 ? symbol.instances[0].reference : ''
      return {
        symbolUuid: symbol.uuid as string,
        sheetFile: props.filePath,
        ...(reference ? { reference } : {})
      }
    })
  emitCrossProbe('schematic', targets, groupId)
}

const onViewportSelect = (items: SchematicItemRef[]): void => {
  selectedItems.value = items
  probeSelection()
}

/**
 * Highlight Net (`): the net held lit by name, so it carries across the
 * design's sheets; null for none.
 */
const highlightedNet = ref<string | null>(null)

/** Light a net, or none, and tell the board and the other sheets. */
const setHighlightedNet = (name: string | null): void => {
  if (name === highlightedNet.value) return
  highlightedNet.value = name
  emitNetProbe('schematic', name ?? '', groupId)
}

/** The net under the pointer lights; the same net again, or none there, clears (KiCad's). */
const highlightNetAtPointer = (): void => {
  const name = viewport.value?.netAtPointer() ?? null
  setHighlightedNet(name === highlightedNet.value ? null : name)
}

// A net highlighted on the board or another sheet lights here too; one this
// design lacks clears (KiCad's). Its own probe finds the name already held.
const stopNetProbe = onCrossProbe((probe) => {
  const name = probe.net
  if (name === undefined) return
  highlightedNet.value =
    name && connectivity.value?.nets.some((net) => net.name === name) ? name : null
})
onUnmounted(stopNetProbe)

/**
 * One command over placed symbols on this sheet and its siblings: this file
 * through its AST, every other sheet as a fresh parse of its live text — the
 * parsed sibling is a shared cache, and the command layer's discipline is text
 * in, text out — handed back to `runCommand` as sibling edits. Shared by the
 * Components table, annotate and the agent's `bom.update`.
 */
const applySymbolEditsCommand = (label: string, edits: SymbolEdit[]): void => {
  if (props.isReadOnly) return
  props.session.applySymbolEdits(label, edits)
  historyVersion.value++
}

/** The records behind `ids`, on whichever sheets their symbols live. */
const recordsFor = (ids: string[]): ComponentRecord[] =>
  ids.flatMap((id) => recordsById.value.get(id) ?? [])

const onEditField = (ids: string[], field: string, value: string): void => {
  const label =
    ids.length > 1
      ? t('schematicEditor.commands.editFieldMultiple', { field, count: ids.length })
      : t('schematicEditor.commands.editField', { field })
  applySymbolEditsCommand(label, fieldEdits(recordsFor(ids), field, value))
}

// ---- Annotate (KiCad's Annotate Schematic) ---------------------------------
const annotateOpen = ref(false)

/** Symbols in the selection, a field's symbol included, as indices. */
const selectedSymbolIndices = computed<Set<number>>(
  () =>
    new Set(
      selectedItems.value
        .filter((item) => item.type === 'symbol' || item.type === 'field')
        .map((item) => item.index)
    )
)

/** The sheet instances a request names, in hierarchy order. */
const annotationScope = (request: AnnotateRequest): AnnotateSource[] =>
  props.session.annotationScope(request)

/**
 * The plan for a set of options — the dialog's live preview and, on confirm,
 * what is applied. The pool it numbers against is every sheet instance,
 * whatever the scope.
 */
const annotationPlanFor = (request: AnnotateRequest): AnnotationPlan => {
  if (!schematic.value) return { changes: [], considered: 0 }
  return planAnnotation(
    {
      sources: sheetSources.value,
      scope: annotationScope(request),
      selection: request.scope === 'selection' ? selectedSymbolIndices.value : undefined
    },
    request
  )
}

/** The plan for the dialog's options, applied. Shared by the dialog and the
 *  agent's `schematic.annotate`. */
const applyAnnotation = (request: AnnotateRequest): void => {
  const plan = annotationPlanFor(request)
  annotateOpen.value = false
  applyAnnotationPlan(plan)
}

const applyAnnotationPlan = (plan: AnnotationPlan): void => {
  props.session.applyAnnotationPlan(plan)
  historyVersion.value++
}

// ---- Increment Annotations From… (KiCad's Tools menu) ----------------------
const incrementOpen = ref(false)

/** The start field's seed: the designator of the one symbol selected. */
const incrementInitial = computed(() => {
  const symbol = loneSymbol.value
  return symbol ? (referenceForSheetPath(symbol, activeSheetPath.value) ?? '') : ''
})

/** The sheet on screen, or every instance of the design. */
const incrementScope = (allSheets: boolean): AnnotateSource[] => {
  if (allSheets) return sheetSources.value
  const here = sheetSources.value.filter(
    (source) =>
      source.sheetPath === activeSheetPath.value && samePath(source.filePath, props.filePath)
  )
  if (here.length || !schematic.value) return here
  return [
    { schematic: schematic.value, sheetPath: activeSheetPath.value, filePath: props.filePath }
  ]
}

const incrementPlanFor = (request: IncrementRequest): AnnotationPlan =>
  planIncrementAnnotations(incrementScope(request.allSheets), request.first, request.increment)

const applyIncrement = (request: IncrementRequest): void => {
  incrementOpen.value = false
  const plan = incrementPlanFor(request)
  if (!plan.changes.length) return
  applySymbolEditsCommand(
    t('commandLabels.incrementAnnotations', plan.changes.length),
    plan.changes.map((change) => ({
      filePath: change.filePath,
      symbolIndex: change.symbolIndex,
      apply: (symbol) => setSymbolInstanceReference(symbol, change.sheetPath, change.to)
    }))
  )
}

// ---- One placed part: its fields, datasheet, library symbol, unit, body style
const propertyTable = ref<InstanceType<typeof PropertyTable> | null>(null)

/** The one placed symbol selected (alone, or through one of its fields), or null. */
const loneSymbolIndex = computed<number | null>(() => {
  const indices = [...selectedSymbolIndices.value]
  return indices.length === 1 ? indices[0] : null
})
const loneSymbol = computed<KicadSchematicSymbol | null>(() =>
  loneSymbolIndex.value === null ? null : (schematic.value?.symbols[loneSymbolIndex.value] ?? null)
)

/** KiCad's U / V / F: its edit dialog is our property row, so the key lands there. */
const FIELD_HOTKEYS: Array<[HotkeyActionId, string]> = [
  ['schematic.editReference', 'Reference'],
  ['schematic.editValue', 'Value'],
  ['schematic.editFootprint', 'Footprint']
]

const editSymbolField = (field: string): boolean => {
  if (!loneSymbol.value || !showPanels.value || !propertyTable.value) return false
  setActivePane('properties')
  propertyTable.value.focusField(field)
  return true
}

/** The design's folder, which a `${KIPRJMOD}` datasheet path is relative to. */
const projectDir = computed(() => (designRootPath.value ? dirnameOf(designRootPath.value) : null))

/** Open what a Datasheet value names: a web address in the browser, a file in its own tab. */
const openDatasheet = (value: string | undefined): boolean => {
  const target = datasheetTarget(value, projectDir.value)
  if (!target) return false
  // The window's open handler hands every new window to the system browser.
  if (target.kind === 'url') window.open(target.url, '_blank', 'noopener')
  else emit('open-file', { name: basenameOf(target.path), path: target.path })
  return true
}

/** KiCad's Show Datasheet (D): the part's datasheet. */
const showDatasheet = (): boolean => {
  const symbol = loneSymbol.value
  return openDatasheet(symbol ? getSymbolProperty(symbol, 'Datasheet') : undefined)
}

/** A footprint's library file, read-only in the footprint editor. */
const openFootprint = (libId: string): boolean => {
  const record = findFootprint(libId)
  if (!record) return false
  emit('open-file', { name: record.name, path: readonlyLibTabPath(record.file) })
  return true
}

// ---- Footprint chooser (docs/libraries-workstream.md) ---------------
const footprintChooser = ref<{
  ids: string[]
  target: string
  /** The lone part's reference and value, shown on the footprint previews. */
  fields: { reference?: string; value?: string }
  initial: string
  fit: { filters: string[]; pins: PinRef[] } | null
} | null>(null)

/** Choose a footprint for the selected parts, fitted to their symbol when they share one. */
const openFootprintChooser = (): void => {
  const doc = schematic.value
  if (props.isReadOnly || !doc) return
  const symbols = [...selectedSymbolIndices.value]
    .map((index) => doc.symbols[index])
    .filter((symbol): symbol is KicadSchematicSymbol => !!symbol)
  if (!symbols.length) return
  const libIds = new Set(symbols.map((symbol) => symbol.libId))
  const definition = libIds.size === 1 ? doc.libSymbols.get(symbols[0].libId) : undefined
  const chain = definition ? libSymbolChain(definition, (name) => doc.libSymbols.get(name)) : null
  const filters = (definition ? (getLibSymbolProperty(definition, 'ki_fp_filters') ?? '') : '')
    .split(/\s+/)
    .filter(Boolean)
  const footprints = new Set(symbols.map((symbol) => getSymbolProperty(symbol, 'Footprint') ?? ''))
  const lone = symbols.length === 1 ? symbols[0] : null
  footprintChooser.value = {
    ids: selectedComponentIds.value,
    fields: lone
      ? {
          reference: getSymbolProperty(lone, 'Reference'),
          value: getSymbolProperty(lone, 'Value')
        }
      : {},
    target: lone
      ? `${getSymbolProperty(lone, 'Reference') ?? ''} · ${getSymbolProperty(lone, 'Value') ?? lone.libId}`
      : t('schematicEditor.footprintChooser.parts', { n: symbols.length }),
    initial: footprints.size === 1 ? [...footprints][0] : '',
    fit: chain ? { filters, pins: libSymbolPins(chain) } : null
  }
  void loadIndex().catch(() => {})
}

/** A chooser pane's Open: the chooser goes, and the part opens read-only in its own tab. */
const openFromChooser = (record: IndexRecord): void => {
  chooserMode.value = null
  changeChooserOpen.value = false
  footprintChooser.value = null
  const target = openTargetFor(record)
  if (target.kind === 'library-symbol') emit('open-library-symbol', target.file, target.name)
  else emit('open-file', target.node)
}

const onFootprintPick = (libId: string): void => {
  const chooser = footprintChooser.value
  footprintChooser.value = null
  if (chooser) onEditField(chooser.ids, 'Footprint', libId)
}

/** A property row's button. */
const onSchematicAction = (
  groupType: string,
  actionId: string,
  _groupId?: string,
  fieldKey?: string
): void => {
  if (groupType !== 'symbol') return
  const symbol = loneSymbol.value ?? schematic.value?.symbols[[...selectedSymbolIndices.value][0]]
  if (actionId === EDIT_FIELDS_ACTION) fieldsDialogOpen.value = true
  else if (actionId === SYMBOL_ROW_ACTIONS.browseFootprint) openFootprintChooser()
  else if (actionId === SYMBOL_ROW_ACTIONS.openFootprint && symbol)
    openFootprint(getSymbolProperty(symbol, 'Footprint') ?? '')
  else if (actionId === SYMBOL_ROW_ACTIONS.openDatasheet && symbol && fieldKey === 'Datasheet')
    openDatasheet(getSymbolProperty(symbol, 'Datasheet'))
}

// ---- Edit fields (the structural half, as in the symbol editor) -------------
const fieldsDialogOpen = ref(false)

/** The lone part's fields as the sheet lists them, current after every edit. */
const loneSymbolFields = computed(() => {
  void revision.value
  return [...(loneSymbol.value?.properties ?? [])]
})

// The sheet edits one part; selecting anything else closes it.
watch(loneSymbol, (symbol) => {
  if (!symbol) fieldsDialogOpen.value = false
})

/** One change to the part's field list, on every unit of it, as one step. */
const runFieldListOp = (label: string, change: FieldListOp): void =>
  applySymbolEditsCommand(label, fieldListEdits(recordsFor(selectedComponentIds.value), change))

/** A field name the part is not using yet, so Add never collides. */
const newFieldKey = (): string => {
  const taken = new Set(loneSymbolFields.value.map((property) => property.key))
  const base = t('symbolEditor.fieldsDialog.defaultName')
  if (!taken.has(base)) return base
  let n = 1
  while (taken.has(`${base}${n}`)) n++
  return `${base}${n}`
}

const onFieldAdd = (): void =>
  runFieldListOp(t('symbolEditor.commands.addField'), { op: 'add', key: newFieldKey() })
const onFieldRemove = (key: string): void =>
  runFieldListOp(t('symbolEditor.commands.removeField'), { op: 'remove', key })
const onFieldRename = (key: string, newKey: string): void =>
  runFieldListOp(t('symbolEditor.commands.renameField'), { op: 'rename', key, newKey })
const onFieldMove = (key: string, delta: 1 | -1): void =>
  runFieldListOp(t('symbolEditor.commands.reorderFields'), { op: 'move', key, delta })
const onFieldSetVisible = (key: string, visible: boolean): void =>
  runFieldListOp(t('symbolEditor.commands.editFieldStyle'), { op: 'visible', key, visible })
const onFieldSetValue = (key: string, value: string): void =>
  onEditField(selectedComponentIds.value, key, value)

/** What a symbol's link rows can open. */
const symbolLinks: SymbolLinks = {
  footprint: (libId) => !!findFootprint(libId),
  datasheet: (value) => !!datasheetTarget(value, projectDir.value)
}

/** Ctrl/Cmd+E: the library symbol the part was placed from, in the symbol editor. */
const openInLibraryEditor = (): boolean => {
  const symbol = loneSymbol.value
  const record = symbol ? findLibrarySymbol(symbol.libId) : undefined
  if (!record) return false
  emit('open-library-symbol', record.file, record.name)
  return true
}

/** The pins a placement shows as `unit` in `style`, from its sheet's copy of the part. */
const placedPins = (
  document: KicadSchematic,
  symbol: KicadSchematicSymbol,
  unit: number,
  style: number
): ReturnType<typeof libSymbolUnitPins> =>
  libSymbolUnitPins(placedSymbolChain(document, symbol), unit, style)

/** The design name of an instance, for the unit-already-placed question. */
const sheetNameOf = (sheetPath: string): string =>
  hierarchyTree.value?.instances.find((instance) => instance.sheetPath === sheetPath)?.namePath ||
  t('schematicEditor.units.rootSheet')

/**
 * KiCad's Change Unit: the selection shows `unit`. When one part is selected
 * and another placement already shows that unit, KiCad asks whether to swap
 * the two or place the unit twice, and so does this.
 */
const setSelectedUnit = async (unit: number): Promise<void> => {
  const doc = schematic.value
  if (!doc || props.isReadOnly) return
  const indices = [...selectedSymbolIndices.value].filter((index) => {
    const symbol = doc.symbols[index]
    return symbol && symbol.unit !== unit && placedSymbolChoices(doc, symbol).units >= unit
  })
  if (!indices.length) return
  const sheetPath = activeSheetPath.value
  let swap: (UnitHolder & { unit: number }) | null = null
  if (indices.length === 1) {
    const self = doc.symbols[indices[0]]
    const reference = referenceForSheetPath(self, sheetPath)
    const holder = reference
      ? findUnitHolder(
          sheetSources.value,
          reference,
          unit,
          { filePath: props.filePath, sheetPath, symbolIndex: indices[0] },
          samePath
        )
      : null
    if (holder) {
      const target = letterSubReference(unit)
      const current = letterSubReference(self.unit)
      const choice = await window.api.chooseDialog({
        message: t('schematicEditor.units.alreadyPlaced', {
          unit: target,
          sheet: sheetNameOf(holder.sheetPath)
        }),
        buttons: [
          t('schematicEditor.units.swap', { target, current }),
          t('schematicEditor.units.duplicate', { unit: target }),
          t('common.cancel')
        ],
        cancelId: 2
      })
      if (choice !== 0 && choice !== 1) return
      if (choice === 0) swap = { ...holder, unit: self.unit }
    }
  }
  const edits: DocumentEdit[] = []
  // The other placement first: when it is this very node under another
  // instance, the one on screen must be written last to keep its unit.
  if (swap) {
    const holder = swap
    edits.push({
      filePath: holder.filePath,
      apply: (document) => {
        const symbol = document.symbols[holder.symbolIndex]
        if (symbol) {
          const pins = placedPins(document, symbol, holder.unit, symbol.bodyStyle)
          setSchematicSymbolUnit(symbol, holder.unit, holder.sheetPath, pins)
        }
      }
    })
  }
  for (const index of indices) {
    edits.push({
      filePath: props.filePath,
      apply: (document) => {
        const symbol = document.symbols[index]
        if (symbol) {
          const pins = placedPins(document, symbol, unit, symbol.bodyStyle)
          setSchematicSymbolUnit(symbol, unit, sheetPath, pins)
        }
      }
    })
  }
  const selection = selectedItems.value.map((item) => ({ ...item }))
  props.session.applyDocumentEdits(
    swap ? t('commandLabels.swapUnits') : t('commandLabels.changeUnit'),
    edits,
    { selection: { before: selection, after: () => selectedItems.value.map((i) => ({ ...i })) } }
  )
  historyVersion.value++
}

/** The selected parts that draw more than one body. */
const bodyStyleSymbols = computed<number[]>(() => {
  const doc = schematic.value
  if (!doc) return []
  return [...selectedSymbolIndices.value].filter((index) => {
    const symbol = doc.symbols[index]
    return !!symbol && placedSymbolChoices(doc, symbol).bodyStyles > 1
  })
})

/** KiCad's Change Body Style: a given style, or the next one (Cycle Body Style). */
const setSelectedBodyStyle = (style: number | 'next'): void => {
  const doc = schematic.value
  if (!doc || props.isReadOnly) return
  const targets = bodyStyleSymbols.value.flatMap((index) => {
    const symbol = doc.symbols[index]
    const count = placedSymbolChoices(doc, symbol).bodyStyles
    const to = style === 'next' ? nextBodyStyle(symbol.bodyStyle, count) : Math.min(style, count)
    return to === symbol.bodyStyle ? [] : [{ index, to }]
  })
  if (!targets.length) return
  runCommand(t('commandLabels.changeBodyStyle'), () => {
    const target = schematic.value
    if (!target) return
    for (const { index, to } of targets) {
      const symbol = target.symbols[index]
      if (symbol)
        setSchematicSymbolBodyStyle(symbol, to, placedPins(target, symbol, symbol.unit, to))
    }
  })
}

/** The Unit ▸ submenu of a lone multi-unit part, as KiCad's context menu has it. */
const unitMenu = computed<MenuNode | null>(() => {
  const doc = schematic.value
  const symbol = loneSymbol.value
  if (!doc || !symbol || props.isReadOnly) return null
  const units = placedSymbolChoices(doc, symbol).units
  if (units <= 1) return null
  return {
    id: 'unit',
    label: t('schematicEditor.units.menu'),
    children: Array.from({ length: units }, (_, i) => ({
      id: `unit:${i + 1}`,
      label: t('schematicEditor.units.unitLabel', { unit: letterSubReference(i + 1) }),
      checked: symbol.unit === i + 1
    }))
  }
})

// ---- Update from library / Change symbol (lib/schematic/symbolUpdate.ts) ---
const symbolDialog = ref<{ mode: PartUpdateMode; libId: string } | null>(null)
/** The chooser over the dialog, for the symbol a change swaps to. */
const changeChooserOpen = ref(false)

/** The library's current definition; reactive to the tiers as they load. */
const libraryDefinition = (libId: string): ReturnType<typeof symbolSources.lookup> =>
  symbolSources.lookup(libId)

/** Parse the standard libraries these ids live in, where not already read. */
const ensureLibraries = async (libIds: Iterable<string>): Promise<void> => {
  await symbolSources.ready()
  const missing = [...new Set(libIds)].filter((libId) => !libraryDefinition(libId))
  await Promise.all(
    missing.map((libId) => symbolSources.ensureStandardLibrary(libId).catch(() => {}))
  )
}

/** Each sheet file of the design once, with its parsed sheet — this one live. */
const designFiles = (): Array<{ filePath: string; schematic: KicadSchematic }> => {
  const seen = new Set<string>()
  const files: Array<{ filePath: string; schematic: KicadSchematic }> = []
  for (const source of sheetSources.value) {
    const key = normalizePath(source.filePath)
    if (seen.has(key)) continue
    seen.add(key)
    files.push({ filePath: source.filePath, schematic: source.schematic })
  }
  if (!files.length && schematic.value)
    files.push({ filePath: props.filePath, schematic: schematic.value })
  return files
}

interface SymbolUpdateFile {
  filePath: string
  schematic: KicadSchematic
  targets: SymbolUpdateTarget[]
}

/** A placement's references, one per sheet instance of its file. */
const placementReferences = (filePath: string, symbol: KicadSchematicSymbol): string[] => {
  const references = sheetSources.value
    .filter((source) => samePath(source.filePath, filePath))
    .map((source) => referenceForSheetPath(symbol, source.sheetPath) ?? '')
    .filter(Boolean)
  return references.length ? references : [getSymbolProperty(symbol, 'Reference') ?? '']
}

/** What a request runs on, file by file: the parts its scope picks, each to its own id or the change's. */
const symbolUpdateFiles = (request: PartUpdateRequest): SymbolUpdateFile[] => {
  if (!schematic.value) return []
  return designFiles().map((file) => {
    const here = samePath(file.filePath, props.filePath)
    const targets = file.schematic.symbols.flatMap((symbol, index): SymbolUpdateTarget[] => {
      const selected = here && selectedSymbolIndices.value.has(index)
      const value = getSymbolProperty(symbol, 'Value') ?? ''
      const picked = placementReferences(file.filePath, symbol).some((reference) =>
        inScope(request, { reference, value, libId: symbol.libId }, selected)
      )
      if (!picked) return []
      return [{ index, libId: request.libId || symbol.libId }]
    })
    return { ...file, targets }
  })
}

/** Ask for the libraries these ids live in; until each is read, its parts read as loading. */
const requestSymbolLibraries = (libIds: Iterable<string>): void => {
  const unread = [...new Set(libIds)].filter(
    (libId) => libId && !symbolLibrariesRead.value.has(libId) && !symbolLibrariesAsked.has(libId)
  )
  if (!unread.length) return
  for (const libId of unread) symbolLibrariesAsked.add(libId)
  void ensureLibraries(unread).then(() => {
    symbolLibrariesRead.value = new Set([...symbolLibrariesRead.value, ...unread])
  })
}
const symbolLibrariesAsked = new Set<string>()

/** Each part's outcome, before anything is written. */
const symbolUpdateRows = (request: PartUpdateRequest): PartUpdateRow[] => {
  const files = symbolUpdateFiles(request)
  requestSymbolLibraries(files.flatMap((file) => file.targets.map((target) => target.libId)))
  const rows = files.flatMap((file) =>
    file.targets.map((target): PartUpdateRow => {
      const symbol = file.schematic.symbols[target.index]
      const base = {
        reference: placementReferences(file.filePath, symbol).join(', '),
        from: symbol.libId,
        to: target.libId
      }
      const library = libraryDefinition(target.libId)
      if (!library)
        return symbolLibrariesRead.value.has(target.libId)
          ? { ...base, notFound: true }
          : { ...base, loading: true }
      const check = checkSymbolUpdate(file.schematic, [target], libraryDefinition)
      const cached = file.schematic.libSymbols.get(definitionIdOf(symbol))
      return {
        ...base,
        matches:
          !!cached &&
          libSymbolMatches(
            flattenedLibSymbol(cached, (name) => file.schematic.libSymbols.get(name)),
            library
          ),
        ...(check.tooFewUnits.length
          ? { warnings: [t('schematicEditor.symbolUpdate.tooFewUnits', 1)] }
          : {})
      }
    })
  )
  return rows.sort((a, b) => compareReferencesNatural(a.reference, b.reference))
}

/** KiCad's update options, as the dialog lists them; Reference and Value are never touched. */
const SYMBOL_OPTION_KEYS = [
  'resetFieldText',
  'resetEmptyFields',
  'removeExtraFields',
  'resetFieldVisibility',
  'resetFieldEffects',
  'resetFieldPositions',
  'resetPinTextVisibility',
  'resetAlternatePins',
  'resetAttributes',
  'resetCustomPower'
] as const

const symbolUpdateOptions = computed(() =>
  SYMBOL_OPTION_KEYS.map((key) => ({
    key,
    label: t(`schematicEditor.symbolUpdate.options.${key}`)
  }))
)

const symbolUpdateDefaults: Record<PartUpdateMode, Record<string, boolean>> = {
  update: Object.fromEntries(SYMBOL_OPTION_KEYS.map((key) => [key, UPDATE_DEFAULTS[key]])),
  change: Object.fromEntries(SYMBOL_OPTION_KEYS.map((key) => [key, CHANGE_DEFAULTS[key]]))
}

/**
 * KiCad's fields list: every field the design's symbols carry. Reference and
 * Value lead it, unticked to begin with as in KiCad — a part keeps its
 * designator and value unless asked.
 */
const SYMBOL_FIELDS_OFF = ['Reference', 'Value']
const symbolFieldNames = computed(() => {
  const names = new Set<string>(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'])
  for (const file of designFiles())
    for (const symbol of file.schematic.symbols)
      for (const property of symbol.properties)
        if (!property.key.startsWith('ki_')) names.add(property.key)
  const leading = ['Reference', 'Value', 'Footprint', 'Datasheet', 'Description']
  return [...leading, ...[...names].filter((name) => !leading.includes(name)).sort()]
})

/** The lone selected symbol's reference, value and lib id: where the matching scopes start. */
const symbolUpdateSeeds = computed(() => {
  const lone = selectedSymbols.value.length === 1 ? selectedSymbols.value[0] : null
  if (!lone) return { reference: '', value: '', libId: changeChooserInitial.value }
  return {
    reference: referenceForSheetPath(lone, activeSheetPath.value) ?? '',
    value: getSymbolProperty(lone, 'Value') ?? '',
    libId: lone.libId
  }
})

/**
 * One undo step over every file: each sheet's copies refreshed and its
 * placements relinked, the wires on a pin that moved following it (the move
 * plan, read before the write), then the tidy.
 */
const runSymbolUpdate = (
  label: string,
  files: Array<{ filePath: string; targets: SymbolUpdateTarget[] }>,
  options: SymbolUpdateOptions
): void => {
  if (props.isReadOnly) return
  const grid = gridStepNm()
  const edits: DocumentEdit[] = files
    .filter((file) => file.targets.length)
    .map(({ filePath, targets }) => ({
      filePath,
      apply: (document) => {
        updateSymbolsWithWires(document, targets, libraryDefinition, options, grid)
      }
    }))
  const before = selectedItems.value.map((item) => ({ ...item }))
  props.session.applyDocumentEdits(label, edits, {
    cleanup: true,
    selection: {
      before,
      after: (tidy) => {
        if (tidy && cleanupChanged(tidy)) {
          selectedItems.value = selectedItems.value.filter(
            (item) => item.type !== 'wire' && item.type !== 'junction'
          )
        }
        return selectedItems.value.map((item) => ({ ...item }))
      }
    }
  })
  historyVersion.value++
}

const openSymbolUpdate = (): void => {
  if (props.isReadOnly || !schematic.value) return
  symbolDialog.value = { mode: 'update', libId: changeChooserInitial.value }
}

/** The parts Change Symbol acts on, for the chooser's header. */
const changeChooserTarget = computed(() => {
  const doc = schematic.value
  const symbols = [...selectedSymbolIndices.value].map((index) => doc?.symbols[index])
  const lone = symbols.length === 1 ? symbols[0] : null
  return lone
    ? `${getSymbolProperty(lone, 'Reference') ?? ''} · ${lone.libId}`
    : t('schematicEditor.footprintChooser.parts', { n: symbols.length })
})

/** The lib id the selection shares: the dialog's starting part. */
const changeChooserInitial = computed(() => {
  const ids = new Set(
    [...selectedSymbolIndices.value].map((index) => schematic.value?.symbols[index]?.libId)
  )
  return ids.size === 1 ? ([...ids][0] ?? '') : ''
})

/** Change Symbol: the dialog first, its part to be chosen there. */
const openSymbolChange = (): void => {
  if (props.isReadOnly || !schematic.value) return
  symbolDialog.value = { mode: 'change', libId: changeChooserInitial.value }
}

/** The dialog's Browse: the chooser over it. */
const browseChangeSymbol = (): void => {
  void loadIndex().catch(() => {})
  changeChooserOpen.value = true
}

const onChangePick = (libId: string): void => {
  changeChooserOpen.value = false
  if (symbolDialog.value) symbolDialog.value = { ...symbolDialog.value, libId }
  requestSymbolLibraries([libId])
}

const confirmSymbolUpdate = (request: PartUpdateRequest): void => {
  const files = symbolUpdateFiles(request)
  const count = files.reduce(
    (sum, file) =>
      sum + checkSymbolUpdate(file.schematic, file.targets, libraryDefinition).valid.length,
    0
  )
  symbolDialog.value = null
  if (!count) return
  const options: SymbolUpdateOptions = {
    ...UPDATE_DEFAULTS,
    ...request.options,
    updateReference: request.fields.includes('Reference'),
    updateValue: request.fields.includes('Value'),
    fields: request.fields
  }
  runSymbolUpdate(
    request.mode === 'change'
      ? t('commandLabels.changeSymbols', count)
      : t('commandLabels.updateSymbols', count),
    files,
    options
  )
}

/** The mismatch finding's quick fix: that sheet's copy refreshed, every field kept. */
const fixFinding = (finding: HealthFinding): void => {
  const index = healthFindings.value.findIndex((entry) => entry.key === finding.key)
  const result = checkResults.value[index]
  if (!result || result.code !== 'symbol-library-mismatch' || !result.subject) return
  const elsewhere = result.sheetPath && !hereSheetPaths.value.has(result.sheetPath)
  const filePath = elsewhere
    ? props.session.hierarchy()?.instances.find((i) => i.sheetPath === result.sheetPath)?.filePath
    : props.filePath
  const file = filePath && designFiles().find((entry) => samePath(entry.filePath, filePath))
  if (!file) return
  const libId = result.subject
  const targets = file.schematic.symbols.flatMap((symbol, at) =>
    symbol.libId === libId ? [{ index: at, libId }] : []
  )
  runSymbolUpdate(t('commandLabels.updateSymbols', targets.length), [{ ...file, targets }], {
    ...UPDATE_DEFAULTS,
    resetFieldText: false
  })
}

// ---- A placed symbol's library link (docs/libraries-workstream.md §5) ----

const selectedSymbols = computed((): KicadSchematicSymbol[] => {
  const doc = schematic.value
  if (!doc) return []
  return [...selectedSymbolIndices.value]
    .map((index) => doc.symbols[index])
    .filter((symbol): symbol is KicadSchematicSymbol => !!symbol)
})

/** Lib ids whose library has been looked for: absent, the status still says it is checking. */
const symbolLibrariesRead = shallowRef(new Set<string>())

watch(
  () => selectedSymbols.value.map((symbol) => symbol.libId),
  (libIds) => {
    const unread = libIds.filter((libId) => !symbolLibrariesRead.value.has(libId))
    if (!unread.length) return
    void ensureLibraries(unread).then(() => {
      symbolLibrariesRead.value = new Set([...symbolLibrariesRead.value, ...unread])
    })
  },
  { immediate: true }
)

/** How a placed symbol's copy stands against its library: any edit to the copy reads as a difference. */
const symbolLibrarySync = (symbol: KicadSchematicSymbol): LibrarySync => {
  const doc = schematic.value
  const library = libraryDefinition(symbol.libId)
  if (!library)
    return symbolLibrariesRead.value.has(symbol.libId)
      ? { state: 'missing' }
      : { state: 'checking' }
  const cached = doc?.libSymbols.get(definitionIdOf(symbol))
  if (!doc || !cached) return { state: 'differs' }
  const matches = libSymbolMatches(
    flattenedLibSymbol(cached, (name) => doc.libSymbols.get(name)),
    library
  )
  return matches ? { state: 'match' } : { state: 'differs' }
}

/**
 * Edit symbol…: this sheet's own copy of the lone symbol's definition, in a
 * symbol editor tab that belongs to the sheet (`lib/designCopy.ts`). Every
 * placement here drawn from that copy changes with it; the library does not.
 */
const editDesignSymbol = (): void => {
  const symbol = selectedSymbols.value.length === 1 ? selectedSymbols.value[0] : null
  if (!symbol || !props.filePath) return
  const id = definitionIdOf(symbol)
  emit('open-file', {
    name: `${id.slice(id.indexOf(':') + 1)}.kicad_sym`,
    path: designCopyPath(
      'symbol',
      props.filePath,
      id,
      symbol.uuid ? { uuid: symbol.uuid, sheetPath: activeSheetPath.value } : undefined
    )
  })
}

const symbolLibraryStatus = computed(() =>
  librarySyncStatus(t, selectedSymbols.value.map(symbolLibrarySync))
)

/** The library part the selected symbols share, as the chooser names it. */
const symbolLibraryPart = computed(() => {
  void symbolLibrariesRead.value
  const ids = new Set(selectedSymbols.value.map((symbol) => symbol.libId))
  const libId = ids.size === 1 ? [...ids][0] : ''
  return libraryPartOf(libId, libId ? findLibrarySymbol(libId) : undefined)
})

// ---- Align and distribute (lib/schematic/alignItems.ts) ----------------------
const ALIGN_OPS: Array<{ id: string; icon: IconName; label: MessageKey }> = [
  { id: 'align.left', icon: 'align-left', label: tk('schematicEditor.align.left') },
  { id: 'align.centerX', icon: 'align-center-x', label: tk('schematicEditor.align.centerX') },
  { id: 'align.right', icon: 'align-right', label: tk('schematicEditor.align.right') },
  { id: 'align.top', icon: 'align-top', label: tk('schematicEditor.align.top') },
  { id: 'align.centerY', icon: 'align-center-y', label: tk('schematicEditor.align.centerY') },
  { id: 'align.bottom', icon: 'align-bottom', label: tk('schematicEditor.align.bottom') }
]
const DISTRIBUTE_OPS: Array<{ id: string; icon: IconName; label: MessageKey }> = [
  {
    id: 'distribute.horizontal',
    icon: 'distribute-horizontal',
    label: tk('schematicEditor.align.distributeHorizontal')
  },
  {
    id: 'distribute.vertical',
    icon: 'distribute-vertical',
    label: tk('schematicEditor.align.distributeVertical')
  }
]
const alignMenuItem = (entry: { id: string; label: MessageKey }): MenuNode => ({
  id: entry.id,
  label: t(entry.label)
})

/** The selection's items that align on their own (a field or pin goes with its owner). */
const alignableCount = computed(() =>
  schematic.value ? alignableItems(schematic.value, selectedItems.value).length : 0
)

/** Shift each selected item by its own delta, the wires following, as one step. */
const shiftSelection = (label: string, deltasFor: (boxes: AlignBox[]) => Point[]): void => {
  const doc = schematic.value
  if (!doc || props.isReadOnly) return
  const aligned = alignableItems(doc, selectedItems.value)
  const deltas = deltasFor(aligned.map((entry) => entry.box))
  const shifts = aligned.map((entry, index) => ({ item: entry.item, delta: deltas[index] }))
  if (shifts.every(({ delta }) => delta.x === 0 && delta.y === 0)) return
  runCommand(
    label,
    () => {
      const target = schematic.value
      if (!target) return
      applyItemShifts(target, shifts, planItemShifts(target, shifts, gridStepNm()))
    },
    { cleanup: true }
  )
}

/** Where the pointer was when the menu opened, else where it is: KiCad's target. */
const alignCursor = (): Point | undefined => menuPoint ?? viewport.value?.getCursor()?.point

const alignSelection = (op: AlignOp): void =>
  shiftSelection(t('commandLabels.align', alignableCount.value), (boxes) =>
    alignDeltas(boxes, op, gridStepNm(), alignCursor())
  )

const distributeSelection = (op: DistributeOp): void =>
  shiftSelection(t('commandLabels.distribute', alignableCount.value), (boxes) =>
    distributeDeltas(boxes, op, gridStepNm())
  )

// ---- Find and replace (lib/schematic/schematicFind.ts) ------------------------
// The query lives in `findState`, shared by every schematic tab, so a search
// across the hierarchy carries on in the tab it steps into.
const findOpen = ref(false)
const findWidget = ref<InstanceType<typeof CanvasFindWidget> | null>(null)
const findScopes = computed(() => [
  { value: 'sheet', label: t('schematicEditor.find.scopeSheet') },
  { value: 'design', label: t('schematicEditor.find.scopeDesign') }
])
const pendingReplace = ref<{ edits: ReplaceEdit[]; duplicates: string[] } | null>(null)

/** The instances a search covers: the one on screen, or every sheet of the design. */
const findSources = computed<FindSource[]>(() => {
  const doc = schematic.value
  if (!doc) return []
  if (findState.scope === 'sheet')
    return [{ filePath: props.filePath, sheetPath: activeSheetPath.value, schematic: doc }]
  // Sheet by sheet in page order, as KiCad's find walks the design.
  return inPageOrder(sheetSources.value).map(({ filePath, sheetPath, schematic: sheet }) => ({
    filePath,
    sheetPath,
    schematic: sheet
  }))
})

const findResults = computed<FindMatch[]>(() =>
  findOpen.value ? findMatches(findSources.value, findState.query, findState.options) : []
)
const findInvalid = computed(
  () => findOpen.value && !!findState.query && !compileQuery(findState.query, findState.options)
)
const findIndex = computed(() =>
  findResults.value.findIndex((match) => match.key === findState.currentKey)
)
const findCountLabel = computed(() => {
  if (!findState.query) return ''
  const total = findResults.value.length
  if (!total) return t('editorArea.find.noResults')
  return t('editorArea.find.results', { current: Math.max(findIndex.value, 0) + 1, total })
})

/** The selection a hit stands for: the field, label, text or sheet name itself. */
const findRef = (target: FindTarget): SchematicItemRef =>
  target.kind === 'field' || target.kind === 'sheet_field'
    ? { type: target.kind, index: target.index, field: target.field }
    : { type: target.kind, index: target.index }

/** Select a hit and bring it into view — in another sheet's tab if it is there. */
const showMatch = (match: FindMatch): void => {
  findState.currentKey = match.key
  noteEnteredInstance(match.filePath, match.sheetPath)
  const at = { x: nmToMm(match.position.x), y: nmToMm(match.position.y) }
  if (samePath(match.filePath, props.filePath)) {
    reveal([findRef(match.target)], at)
    return
  }
  findHandoff.value = match.filePath
  emit('reveal-in-sheet', match.filePath, match.uuid ? [match.uuid] : [], at)
}

/** Step through the hits; the first step starts on this sheet when it has any. */
const stepFind = (delta: number): void => {
  const list = findResults.value
  if (!list.length) return
  const at = findIndex.value
  let next: number
  if (at >= 0) next = (at + delta + list.length) % list.length
  else {
    const here = list.findIndex((match) => match.sheetPath === activeSheetPath.value)
    next = here >= 0 ? here : delta > 0 ? 0 : list.length - 1
  }
  showMatch(list[next])
}

/** KiCad's Find Next / Previous: the last query again, or the widget when there is none. */
const findAgain = (delta: 1 | -1): void => {
  if (!findState.query) {
    openFind()
    return
  }
  findOpen.value = true
  stepFind(delta)
}

/** Seed the query from a lone selected text, as a text editor seeds it from a selection. */
const selectedText = (): string => {
  const item = selectedItems.value.length === 1 ? selectedItems.value[0] : null
  const doc = schematic.value
  if (!item || !doc) return ''
  if (item.type === 'field')
    return doc.symbols[item.index]?.properties.find((p) => p.key === item.field)?.value ?? ''
  if (item.type === 'label') return doc.labels[item.index]?.text ?? ''
  if (item.type === 'text') return doc.texts[item.index]?.text ?? ''
  return ''
}

const openFind = (): void => {
  const seed = selectedText()
  if (seed && !seed.includes('\n')) findState.query = seed
  findOpen.value = true
  findWidget.value?.focus()
  void nextTick(() => findWidget.value?.focus())
}

const closeFind = (): void => {
  findOpen.value = false
  pendingReplace.value = null
  returnFocusToCanvas()
}

// A step onto this sheet from another tab's search opens the widget here.
const takeFindHandoff = (): void => {
  if (findHandoff.value && samePath(findHandoff.value, props.filePath)) {
    findHandoff.value = null
    findOpen.value = true
  }
}
watch(findHandoff, takeFindHandoff)

/** Every instance of the design, for the duplicate check whatever the scope. */
const designSources = (): FindSource[] =>
  sheetSources.value.map(({ filePath, sheetPath, schematic: sheet }) => ({
    filePath,
    sheetPath,
    schematic: sheet
  }))

/** Run the edits, unless they rename a part onto another — then ask first. */
const stageReplace = (edits: ReplaceEdit[]): boolean => {
  if (!edits.length || props.isReadOnly) return false
  const duplicates = duplicateReferences(designSources(), edits)
  if (duplicates.length) {
    pendingReplace.value = { edits, duplicates }
    return false
  }
  commitReplace(edits)
  return true
}

/** One undo step over every sheet a replace writes. */
const commitReplace = (edits: ReplaceEdit[]): void => {
  pendingReplace.value = null
  const selection = selectedItems.value.map((item) => ({ ...item }))
  props.session.applyDocumentEdits(
    t('commandLabels.replaceText', edits.length),
    edits.map((edit) => ({
      filePath: edit.filePath,
      apply: (document: KicadSchematic) => applyReplaceEdit(document, edit)
    })),
    { selection: { before: selection, after: () => selectedItems.value.map((i) => ({ ...i })) } }
  )
  historyVersion.value++
}

/** Replace the hit on screen and move on; with none on screen, find one first. */
const replaceCurrent = (): void => {
  const at = findIndex.value
  const current = findResults.value[at]
  if (!current) {
    stepFind(1)
    return
  }
  const replaced = stageReplace(
    replaceEdits(
      findResults.value,
      findState.query,
      findState.replacement,
      findState.options,
      current
    )
  )
  if (!replaced) return
  const list = findResults.value
  if (!list.length) return
  // The hit replaced has gone, so the one now at its place is the next.
  let next = Math.min(at, list.length - 1)
  if (list[next].key === current.key) next = (next + 1) % list.length
  showMatch(list[next])
}

const replaceAll = (): void => {
  stageReplace(
    replaceEdits(findResults.value, findState.query, findState.replacement, findState.options)
  )
}

const onEditFlag = (ids: string[], flag: FlagKey, value: boolean): void => {
  const { token } = FLAG_TOKENS[flag]
  const label =
    ids.length > 1
      ? t('schematicEditor.commands.editFlagMultiple', { token, count: ids.length })
      : t('schematicEditor.commands.editFlag', { token })
  applySymbolEditsCommand(label, flagEdits(recordsFor(ids), flag, value))
}

// ---- Right-bar property table (the shared schema-driven editor) ------------
/** The page row's instance and the design's pages, read only while a sheet is selected. */
const selectedSheetPages = computed<SheetPageContext | undefined>(() =>
  selectedItems.value.some((item) => item.type === 'sheet' || item.type === 'sheet_field')
    ? { parentPath: activeSheetPath.value, designPages: pagesOf(sheetSources.value) }
    : undefined
)

/**
 * The sheet instance on screen, for the group shown with nothing selected: its
 * name and page are read off its box in the parent instance's file.
 */
const screenSheet = computed<ScreenSheet | undefined>(() => {
  const document = schematic.value
  if (selectedItems.value.length || !document) return undefined
  const uuids = activeSheetPath.value.split('/').filter(Boolean)
  const root = uuids.length <= 1
  const parentPath = `/${uuids.slice(0, -1).join('/')}`
  const owner = root
    ? undefined
    : sheetSources.value.find((source) => source.sheetPath === parentPath)
  const box = owner?.schematic.sheets.find((sheet) => sheet.uuid === uuids[uuids.length - 1])
  return {
    filePath: props.filePath,
    document,
    root,
    ...(owner && box
      ? { parent: { filePath: owner.filePath, sheetPath: parentPath, sheet: box } }
      : {}),
    designPages: pagesOf(sheetSources.value),
    project: instanceProjectName.value
  }
})

/** What the drag in hand would do to the nets, at the head of Properties while it runs (§6). */
const dragVerdict = ref<{ kind: 'merges' | 'splits' | 'connects'; text: string } | null>(null)
const dragGroups = computed<PropertyGroup[]>(() => {
  const v = dragVerdict.value
  if (!v) return []
  return [
    {
      type: 'drag',
      title: t('schematicEditor.drag.title'),
      count: 1,
      fields: [
        {
          key: 'nets',
          label: t('schematicEditor.drag.nets'),
          editor: { kind: 'text' },
          value: v.text,
          readonly: true,
          ...(v.kind === 'connects' ? {} : { warning: t('schematicEditor.drag.netsChange') })
        }
      ]
    }
  ]
})

const schematicGroups = computed(() =>
  intersectGroups(
    buildSchematicGroups(selectedItems.value, t, {
      symbols: schematic.value?.symbols ?? [],
      labels: schematic.value?.labels ?? [],
      wires: schematic.value?.wires ?? [],
      junctions: schematic.value?.junctions ?? [],
      noConnects: schematic.value?.noConnects ?? [],
      netName: selectedNetName.value,
      document: schematic.value,
      sheetPages: selectedSheetPages.value,
      screen: screenSheet.value,
      links: symbolLinks
    } satisfies SchematicContext),
    t('shared.properties.selection')
  )
)

const num = (v: PropertyEditValue): number => (typeof v === 'number' ? v : Number(v) || 0)

// Nodes of a given selected type, resolved to their typed views.
const selectedOfType = <T,>(type: string, coll: T[]): T[] =>
  selectedItems.value
    .filter((i) => i.type === type)
    .map((i) => coll[i.index])
    .filter((n): n is NonNullable<T> => !!n)

const SYMBOL_FIELDS = new Set(['Reference', 'Value', 'Footprint', 'Datasheet'])

/** Undo labels for the groups `applySheetItemEdit` writes. */
const SHEET_ITEM_EDIT_LABELS: Record<string, MessageKey> = {
  text: tk('schematicEditor.commands.editText'),
  text_box: tk('schematicEditor.commands.editTextBox'),
  // Every free-graphic primitive group (`SHEET_GRAPHIC_GROUPS`).
  graphic: tk('schematicEditor.commands.editGraphic'),
  sheet: tk('schematicEditor.commands.editSheet'),
  sheet_pin: tk('schematicEditor.commands.editSheetPin'),
  netclass_flag: tk('schematicEditor.commands.editDirectiveLabel'),
  bus: tk('schematicEditor.commands.editBus'),
  bus_entry: tk('schematicEditor.commands.editBusEntry'),
  image: tk('schematicEditor.commands.editImage'),
  table: tk('schematicEditor.commands.editTable')
}

/**
 * The one property-edit channel. Symbol identity fields/flags route through the
 * EXISTING hierarchical onEditField/onEditFlag (they already run a command and
 * fix per-sheet References); transform + other primitives use the AST helpers.
 */
const onSchematicEdit = (groupType: string, key: string, value: PropertyEditValue): void => {
  if (props.isReadOnly || !schematic.value) return
  // A mixed selection's edit is each kind's (one undo step per kind).
  if (groupType === SELECTION_GROUP) {
    for (const member of schematicGroups.value[0]?.members ?? [])
      onSchematicEdit(member.type, key, value)
    return
  }
  if (groupType === 'screen_sheet') {
    const screen = screenSheet.value
    const edits = screen ? screenSheetEdits(screen, key, value) : []
    // Name and page live in the parent's file: one step over both files.
    if (edits.length) {
      props.session.applyDocumentEdits(t('schematicEditor.commands.editSheet'), edits)
      historyVersion.value++
    }
    return
  }
  const sheetItemLabel = SHEET_GRAPHIC_GROUPS.has(groupType)
    ? SHEET_ITEM_EDIT_LABELS.graphic
    : SHEET_ITEM_EDIT_LABELS[groupType]
  if (sheetItemLabel) {
    const items = selectedItems.value
    const page = { parentPath: activeSheetPath.value, project: instanceProjectName.value }
    runCommand(t(sheetItemLabel), () => {
      const doc = schematic.value
      if (doc) applySheetItemEdit(sheetItemSelection(doc, items), groupType, key, value, page)
    })
    return
  }
  if (groupType === 'symbol') {
    if (SYMBOL_FIELDS.has(key)) {
      onEditField(selectedComponentIds.value, key, String(value))
      return
    }
    if (key.startsWith(USER_FIELD_PREFIX)) {
      onEditField(selectedComponentIds.value, key.slice(USER_FIELD_PREFIX.length), String(value))
      return
    }
    if (key === 'dnp') return onEditFlag(selectedComponentIds.value, 'dnp', !!value)
    if (key === 'excludeFromBom')
      return onEditFlag(selectedComponentIds.value, 'excludeFromBom', !!value)
    if (key === 'excludeFromBoard')
      return onEditFlag(selectedComponentIds.value, 'excludeFromBoard', !!value)
    if (key === 'unit') return void setSelectedUnit(Number(value))
    if (key === 'bodyStyle') return setSelectedBodyStyle(Number(value))
    const symbols = selectedOfType('symbol', schematic.value.symbols)
    if (!symbols.length) return
    runCommand(t('schematicEditor.commands.editSymbol'), () => {
      for (const s of symbols) {
        if (key === 'excludeFromSim') setSchematicSymbolFlag(s, 'exclude_from_sim', !!value)
        else if (key === 'posX')
          moveSchematicSymbolInAST(s, { x: nm(num(value) - s.position.x), y: nm(0) })
        else if (key === 'posY')
          moveSchematicSymbolInAST(s, { x: nm(0), y: nm(num(value) - s.position.y) })
        else if (key === 'rotation') rotateSchematicSymbolInAST(s, num(value))
        else if (key === 'mirror')
          mirrorSchematicSymbolInAST(s, value === '' ? undefined : (value as 'x' | 'y'))
      }
    })
    return
  }
  if (groupType === 'label') {
    const labels = selectedOfType('label', schematic.value.labels)
    if (!labels.length) return
    runCommand(t('schematicEditor.commands.editLabel'), () => {
      for (const l of labels) {
        if (key === 'text') setSchematicLabelText(l, String(value))
        else if (key === 'shape') setSchematicLabelShape(l, value as KicadLabel['shape'])
        else if (key === 'posX')
          moveSchematicLabelInAST(l, { x: nm(num(value) - l.position.x), y: nm(0) })
        else if (key === 'posY')
          moveSchematicLabelInAST(l, { x: nm(0), y: nm(num(value) - l.position.y) })
      }
    })
    return
  }
  if (groupType === 'wire') {
    const wires = selectedOfType('wire', schematic.value.wires)
    if (!wires.length) return
    const patch = strokePatch(key, value)
    if (!patch) return
    runCommand(t('schematicEditor.commands.editWire'), () => {
      for (const w of wires) updateSchematicWireInAST(w, patch)
    })
    return
  }
  if (groupType === 'junction') {
    const junctions = selectedOfType('junction', schematic.value.junctions)
    if (!junctions.length) return
    runCommand(t('schematicEditor.commands.editJunction'), () => {
      for (const j of junctions) {
        if (key === 'diameter') updateSchematicJunctionInAST(j, { diameter: nm(num(value)) })
        else if (key === 'color') updateSchematicJunctionInAST(j, { color: value as Rgba | null })
      }
    })
  }
}

const handleUpdateGrid = (settings: Partial<GridSettings>): void => {
  const next = { ...gridSettings.value, ...settings }
  // On a unit toggle, convert the spacing so the physical grid is unchanged
  // (50 mil ↔ 1.27 mm), rather than reinterpreting the number in the new unit.
  if (settings.unit && settings.unit !== gridSettings.value.unit) {
    const mm = spacingToMm(gridSettings.value.spacing, gridSettings.value.unit)
    next.spacing = mmToSpacing(mm, settings.unit)
  }
  gridSettings.value = next
}

// --------------------------------------------------------------------------

// ---- Cross-sheet focus (a components table row, a board cross-select, or a
// finding on another sheet) ---------------------------------------------------
const pendingFocus = ref<{ uuids: string[]; at?: { x: number; y: number } } | null>(null)

/** The items on this sheet with these uuids. */
const itemsWithUuids = (uuids: string[]): SchematicItemRef[] =>
  schematic.value && uuids.length ? itemRefsWithUuids(schematic.value, uuids) : []

/** Select these items and bring them — or the point, when there is one — into view. */
const reveal = (refs: SchematicItemRef[], at?: { x: number; y: number }): void => {
  selectedItems.value = refs
  const symbols = refs.filter((ref) => ref.type === 'symbol').map((ref) => ref.index)
  void nextTick(() => {
    // A point is sharper than a symbol's box — a pin, a wire end — unless the
    // finding spans several symbols, which only their bounds together frame.
    if (at && symbols.length <= 1) viewport.value?.focusAt(at)
    else if (symbols.length) viewport.value?.focusIndices(symbols)
  })
}

const tryFocusPending = (): void => {
  const want = pendingFocus.value
  if (!want || !schematic.value) return
  const refs = itemsWithUuids(want.uuids)
  // Nothing matched and no point to show — the sheet may still be parsing;
  // `revision` retries.
  if (refs.length === 0 && !want.at) return
  pendingFocus.value = null
  reveal(refs, want.at)
}

watch(
  () => props.focusRequest?.nonce,
  () => {
    const request = props.focusRequest
    if (request?.finding) revealFinding(request.finding)
    if (request && (request.uuids.length > 0 || request.at)) {
      pendingFocus.value = { uuids: request.uuids, ...(request.at ? { at: request.at } : {}) }
      tryFocusPending()
    }
  },
  { immediate: true }
)
// The sheet may still be parsing when the request lands; retry once ready.
watch(revision, () => tryFocusPending())

// KiCad-compatible tool hotkeys; bindings live in lib/hotkeys.ts
// (see docs/research/schematic-editor-features.md §2).
const TOOL_ACTIONS: Array<[HotkeyActionId, SchematicTool]> = [
  ['schematic.tool.wire', 'wire'],
  ['schematic.tool.label', 'label'],
  ['schematic.tool.globalLabel', 'global_label'],
  ['schematic.tool.hierarchicalLabel', 'hierarchical_label'],
  ['schematic.tool.noConnect', 'no_connect'],
  ['schematic.tool.junction', 'junction'],
  ['schematic.tool.text', 'text'],
  ['schematic.tool.sheet', 'sheet'],
  ['schematic.tool.bus', 'bus'],
  ['schematic.tool.busEntry', 'bus_entry'],
  ['schematic.tool.busEntryFlipped', 'bus_entry'],
  ['schematic.tool.line', 'line'],
  ['schematic.tool.circle', 'circle'],
  ['schematic.tool.arc', 'arc'],
  ['schematic.tool.bezier', 'bezier'],
  ['schematic.tool.ruleArea', 'rule_area']
]

const keydown = (event: KeyboardEvent): void => {
  if (clipboard.floating.value && !isTypingTarget() && floatKeydown(event)) return
  if (matchesHotkey(event, 'editor.undo')) {
    event.preventDefault()
    undo()
    return
  }
  if (matchesHotkey(event, 'editor.redo')) {
    event.preventDefault()
    redo()
    return
  }
  // EditorArea's global save handler writes the schematic itself.
  if (matchesHotkey(event, 'editor.save')) return
  if (matchesHotkey(event, 'editor.find')) {
    event.preventDefault()
    openFind()
    return
  }
  if (matchesHotkey(event, 'editor.selectAll')) {
    if (selectAllInField(event)) return
    event.preventDefault()
    // A draft in hand is a gesture, not a selection to replace.
    if (activeTool.value === 'select') selectedItems.value = viewport.value?.selectAll() ?? []
    return
  }
  // F3 / ⌘G type nothing, so they step the find from any field, its own included.
  const findStep = findStepFor(event)
  if (findStep) {
    event.preventDefault()
    findAgain(findStep)
    return
  }
  if (isTypingTarget()) return
  const viewCommand = viewCommandFor(event)
  const grid = gridKeyUpdate(event, 'schematic', gridSettings.value, SCHEMATIC_UNIT_SPACINGS)
  if (matchesHotkey(event, 'editor.cancel')) {
    // Unwind one layer at a time: drag → chooser → popover → draft → tool →
    // selection. (The insert search and the chooser's input handle their
    // own Esc while focused; this is the unfocused fallback.)
    if (move.active()) {
      event.preventDefault()
      move.cancel()
    } else if (viewport.value?.cancelDrag()) event.preventDefault()
    else if (chooserMode.value) chooserMode.value = null
    else if (pendingLabel.value) pendingLabel.value = null
    else if (pendingSheet.value) pendingSheet.value = null
    else if (sheetDraftStart.value) sheetDraftStart.value = null
    else if (wireDraft.value.length) wireDraft.value = []
    else if (drawDraft.value.length) drawDraft.value = []
    else if (activeTool.value !== 'select') setTool('select')
    else selectedItems.value = []
  } else if (matchesHotkey(event, 'editor.fitView')) {
    event.preventDefault()
    viewport.value?.zoomToFit()
  } else if (viewCommand) {
    event.preventDefault()
    viewport.value?.runViewCommand(viewCommand)
  } else if (matchesHotkey(event, 'schematic.highlightNet')) {
    event.preventDefault()
    highlightNetAtPointer()
  } else if (matchesHotkey(event, 'schematic.clearHighlight')) {
    event.preventDefault()
    setHighlightedNet(null)
  } else if (grid) {
    event.preventDefault()
    handleUpdateGrid(grid)
  } else if (matchesHotkey(event, 'schematic.leaveSheet')) {
    event.preventDefault()
    leaveSheet()
  } else if (matchesHotkey(event, 'schematic.sheetBack')) {
    event.preventDefault()
    goBack()
  } else if (matchesHotkey(event, 'schematic.sheetForward')) {
    event.preventDefault()
    goForward()
  } else if (matchesHotkey(event, 'schematic.previousSheet')) {
    event.preventDefault()
    stepSheet(-1)
  } else if (matchesHotkey(event, 'schematic.nextSheet')) {
    event.preventDefault()
    stepSheet(1)
  } else if (matchesHotkey(event, 'schematic.openInLibraryEditor')) {
    if (openInLibraryEditor()) event.preventDefault()
  } else if (matchesHotkey(event, 'schematic.showDatasheet')) {
    if (showDatasheet()) event.preventDefault()
  } else if (FIELD_HOTKEYS.some(([action]) => matchesHotkey(event, action))) {
    // Swallowed when a row takes it, so the letter never types into that row.
    const field = FIELD_HOTKEYS.find(([action]) => matchesHotkey(event, action))?.[1]
    if (field && editSymbolField(field)) event.preventDefault()
  } else if (matchesHotkey(event, 'editor.delete')) {
    if (activeTool.value === 'wire' && wireDraft.value.length) {
      // Backspace un-places the last wire point while drawing.
      event.preventDefault()
      wireDraft.value = wireDraft.value.slice(0, -1)
    } else if (
      (isRunTool(activeTool.value) || activeTool.value === 'bezier') &&
      drawDraft.value.length
    ) {
      event.preventDefault()
      drawDraft.value = drawDraft.value.slice(0, -1)
    } else if (!props.isReadOnly) {
      event.preventDefault()
      deleteSelected()
    }
  } else if (matchesHotkey(event, 'schematic.finishWire')) {
    if (activeTool.value === 'wire' && wireDraft.value.length) {
      event.preventDefault()
      finishWire()
    } else if (isRunTool(activeTool.value) && drawDraft.value.length) {
      event.preventDefault()
      finishRun()
    }
  } else if (matchesHotkey(event, 'editor.focusSearch')) {
    event.preventDefault()
    // Mid-wire, `/` toggles the elbow posture (KiCad); idle, it focuses the
    // insert search (spacebar is deliberately untouched — pros expect it
    // to rotate/toggle in Altium and reset the origin in KiCad).
    if (activeTool.value === 'wire' || activeTool.value === 'bus') {
      wirePosture.value = wirePosture.value === 'hv' ? 'vh' : 'hv'
    } else insertSearch.value?.focus()
  } else if (clipboardKeydown(event)) {
    event.preventDefault()
  } else if (!props.isReadOnly) {
    if (
      matchesHotkey(event, 'schematic.tool.symbol') ||
      matchesHotkey(event, 'schematic.tool.power')
    ) {
      event.preventDefault()
      openChooser(matchesHotkey(event, 'schematic.tool.symbol') ? 'symbol' : 'power')
    } else if (transformOpFor(event) && runTransform(transformOpFor(event) as TransformOp)) {
      event.preventDefault()
    } else if (
      activeTool.value === 'select' &&
      (matchesHotkey(event, 'schematic.move') || matchesHotkey(event, 'schematic.drag'))
    ) {
      // KiCad's Move (M, connections left behind) and Drag (G, connections
      // kept): the selection picks up at the pointer; a click drops it.
      moveMode = matchesHotkey(event, 'schematic.drag') ? 'drag' : 'move'
      event.preventDefault()
      move.start()
    } else {
      const match = TOOL_ACTIONS.find(([action]) => matchesHotkey(event, action))
      if (match) {
        event.preventDefault()
        setTool(match[1])
        if (match[1] === 'bus_entry') {
          busEntrySize.value = matchesHotkey(event, 'schematic.tool.busEntryFlipped')
            ? BUS_ENTRY_SIZE_FLIPPED
            : BUS_ENTRY_SIZE
        }
        // KiCad's reading: a hotkey acts at the cursor. A tool that draws from
        // a first point takes it from where the pointer is; off the canvas,
        // the tool arms and waits for the click, so no stale point is used.
        if (match[1] === 'wire' || match[1] === 'sheet' || isRunTool(match[1])) {
          const cursor = viewport.value?.getCursor()
          if (cursor) handleToolClick(cursor.point, cursor.screen)
        }
      }
    }
  }
}

/** The selection and the item under the cursor, for KiCad's hover selection (`lib/hoverSelection.ts`). */
const schematicHover: HoverSelection<SchematicItemRef> = {
  selected: selectedItems,
  hover: () => viewport.value?.itemAtCursor() ?? null,
  same: sameSchematicRef
}

/** KiCad's Move (M, wires stay) and Drag (G, wires follow), held: Escape puts it back. */
let moveMode: 'move' | 'drag' = 'move'
const move = heldMove(schematicHover, {
  begin: () => viewport.value?.startHeldDrag(moveMode) ?? false,
  abandon: () => void viewport.value?.cancelDrag(),
  history: props.session
})

// The edit keys KiCad's `RequestSelection` serves: with nothing selected they
// act on the item under the pointer, and let it go after — but U / V / F open
// its row, so it stays.
useGroupKeydown(
  withHoverKeys(keydown, {
    ...schematicHover,
    keys: [
      'schematic.rotate',
      'schematic.rotateClockwise',
      'schematic.mirrorHorizontal',
      'schematic.mirrorVertical',
      'editor.delete',
      'schematic.editReference',
      'schematic.editValue',
      'schematic.editFootprint',
      'schematic.showDatasheet',
      'schematic.openInLibraryEditor'
    ],
    keep: ['schematic.editReference', 'schematic.editValue', 'schematic.editFootprint'],
    ready: () =>
      activeTool.value === 'select' &&
      !placement.value &&
      !clipboard.floating.value &&
      !move.active()
  })
)

// ---- Clipboard and repeat (lib/schematic/useSchematicClipboard.ts) ----------
const clipboard = useSchematicClipboard({
  session: props.session,
  schematic: () => schematic.value,
  selectedItems,
  readOnly: () => !!props.isReadOnly,
  viewport: () => viewport.value,
  sheetPath: () => activeSheetPath.value,
  instancePaths: () => activeInstancePaths.value,
  project: () => instanceProjectName.value,
  sources: () => sheetSources.value,
  grid: gridStepNm,
  label: (key, count) => t(key, count),
  historyChanged: () => historyVersion.value++,
  deleteSelected,
  clipboard: {
    read: () => window.api.readClipboardText(),
    write: (text) => window.api.writeClipboardText(text)
  }
})

/** While a paste floats, only the keys that steer or drop it act. */
const floatKeydown = (event: KeyboardEvent): boolean => {
  if (
    matchesHotkey(event, 'editor.cancel') ||
    matchesHotkey(event, 'editor.undo') ||
    matchesHotkey(event, 'editor.redo')
  ) {
    event.preventDefault()
    viewport.value?.cancelDrag()
    return true
  }
  const op = transformOpFor(event)
  if (op) {
    event.preventDefault()
    viewport.value?.applyDragTransform(op)
    return true
  }
  return (
    !matchesHotkey(event, 'editor.fitView') &&
    !viewCommandFor(event) &&
    !matchesHotkey(event, 'editor.save')
  )
}

/** Copy, cut, paste, duplicate and repeat; true when the key was one of them. */
const clipboardKeydown = (event: KeyboardEvent): boolean => {
  if (matchesHotkey(event, 'schematic.copy')) {
    clipboard.copy()
    return true
  }
  if (props.isReadOnly) return false
  const run = (action: () => void): true => {
    setTool('select')
    action()
    return true
  }
  if (matchesHotkey(event, 'schematic.cut')) return run(clipboard.cut)
  if (matchesHotkey(event, 'schematic.paste')) return run(() => void clipboard.paste())
  if (matchesHotkey(event, 'schematic.duplicate')) return run(clipboard.duplicate)
  if (matchesHotkey(event, 'schematic.repeat')) return run(clipboard.repeat)
  return false
}

// The Edit menu's rows, replayed as their keys (lib/editActions.ts).
const editHasSelection = computed(() => selectedItems.value.length > 0)
const editEnabled = computed(() => !props.isReadOnly && !!schematic.value)
const schematicEditGroups = computed(() => [
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
      hotkey: 'schematic.cut' as HotkeyActionId,
      label: t('schematicEditor.edit.cut'),
      enabled: editEnabled.value && editHasSelection.value
    },
    {
      hotkey: 'schematic.copy' as HotkeyActionId,
      label: t('schematicEditor.edit.copy'),
      enabled: editHasSelection.value
    },
    {
      hotkey: 'schematic.paste' as HotkeyActionId,
      label: t('schematicEditor.edit.paste'),
      enabled: editEnabled.value
    },
    {
      hotkey: 'schematic.duplicate' as HotkeyActionId,
      label: t('schematicEditor.edit.duplicate'),
      enabled: editEnabled.value && editHasSelection.value
    },
    {
      hotkey: 'schematic.repeat' as HotkeyActionId,
      label: t('schematicEditor.edit.repeat'),
      enabled: editEnabled.value && clipboard.canRepeat.value
    },
    {
      hotkey: 'editor.delete' as HotkeyActionId,
      label: t('schematicEditor.edit.delete'),
      enabled: editEnabled.value && editHasSelection.value
    }
  ],
  [
    {
      hotkey: 'editor.selectAll' as HotkeyActionId,
      label: t('common.selectAllLabel'),
      enabled: !!schematic.value
    }
  ],
  [
    {
      hotkey: 'editor.find' as HotkeyActionId,
      label: t('schematicEditor.find.title'),
      enabled: !!schematic.value
    }
  ]
])
usePublishedEditActions(schematicEditGroups)

onMounted(() => {
  resetActivePane()
  takeFindHandoff()
  void loadIndex().catch((err) => console.error('Failed to load library index', err))
})
onUnmounted(() => {
  stopSession()
})
</script>

<template>
  <div class="schematic-editor">
    <div v-if="parseError" class="schematic-error">
      <strong>{{ t('schematicEditor.errors.parseTitle') }}</strong>
      <span>{{ parseError }}</span>
      <button v-if="!modelValue.trim() && !isReadOnly" @click="initializeBlank">
        {{ t('schematicEditor.actions.initializeBlank') }}
      </button>
    </div>

    <template v-else-if="schematic">
      <div class="viewport-host-area" @mousedown="setActivePane('canvas')">
        <div v-toolbar-fit class="canvas-floating-toolbar">
          <button
            data-tool-op="undo"
            class="floating-btn history-btn"
            :disabled="!canUndo || isReadOnly"
            :title="t('schematicEditor.toolbar.undoTitle')"
            @click="undo"
          >
            <Icon name="undo" />
          </button>
          <button
            data-tool-op="redo"
            class="floating-btn history-btn"
            :disabled="!canRedo || isReadOnly"
            :title="t('schematicEditor.toolbar.redoTitle')"
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
            :disabled="!canTransform(entry.op)"
            :title="toolTitle(t(entry.label), transformHotkeys[entry.op])"
            @click="runTransform(entry.op)"
          >
            <Icon :name="entry.icon" />
          </button>
          <div class="toolbar-divider"></div>
          <button
            data-tool-op="select"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'select' }"
            :title="toolTitle(t('schematicEditor.tools.select'), 'editor.cancel')"
            @click="setTool('select')"
          >
            <Icon name="tool-select" />
          </button>
          <button
            data-tool-op="symbol"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'symbol' }"
            :disabled="isReadOnly"
            :title="
              toolTitle(t('schematicEditor.insertOverlay.ops.symbol'), 'schematic.tool.symbol')
            "
            @click="openChooser('symbol')"
          >
            <Icon name="tool-symbol" />
          </button>
          <button
            data-tool-op="power"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'power' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('schematicEditor.insertOverlay.ops.power'), 'schematic.tool.power')"
            @click="openChooser('power')"
          >
            <Icon name="tool-ground" />
          </button>
          <button
            data-tool-op="wire"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'wire' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('schematicEditor.insertOverlay.ops.wire'), 'schematic.tool.wire')"
            @click="setTool('wire')"
          >
            <Icon name="tool-wire" />
          </button>
          <button
            data-tool-op="bus"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'bus' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('schematicEditor.insertOverlay.ops.bus'), 'schematic.tool.bus')"
            @click="setTool('bus')"
          >
            <Icon name="tool-bus" />
          </button>
          <button
            data-tool-op="bus_entry"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'bus_entry' }"
            :disabled="isReadOnly"
            :title="
              toolTitle(t('schematicEditor.insertOverlay.ops.busEntry'), 'schematic.tool.busEntry')
            "
            @click="setTool('bus_entry')"
          >
            <Icon name="tool-bus-entry" />
          </button>
          <button
            data-tool-op="no_connect"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'no_connect' }"
            :disabled="isReadOnly"
            :title="
              toolTitle(
                t('schematicEditor.insertOverlay.ops.noConnect'),
                'schematic.tool.noConnect'
              )
            "
            @click="setTool('no_connect')"
          >
            <Icon name="tool-no-connect" />
          </button>
          <button
            data-tool-op="label global_label hierarchical_label directive_label"
            class="floating-btn tool-btn"
            :class="{ active: isLabelTool(activeTool) }"
            :disabled="isReadOnly"
            :title="toolTitle(t('schematicEditor.insertOverlay.ops.label'), 'schematic.tool.label')"
            @click="setTool('label')"
          >
            <Icon name="tool-label" />
          </button>
          <button
            data-tool-op="sheet_pin"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'sheet_pin' }"
            :disabled="isReadOnly"
            :title="t('schematicEditor.insertOverlay.ops.sheetPin')"
            @click="setTool('sheet_pin')"
          >
            <Icon name="tool-sheet-pin" />
          </button>
          <div class="toolbar-divider"></div>
          <button
            data-tool-op="text"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'text' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('schematicEditor.insertOverlay.ops.text'), 'schematic.tool.text')"
            @click="setTool('text')"
          >
            <Icon name="tool-text" />
          </button>
          <button
            data-tool-op="text_box"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'text_box' }"
            :disabled="isReadOnly"
            :title="t('schematicEditor.insertOverlay.ops.textBox')"
            @click="setTool('text_box')"
          >
            <Icon name="tool-text-box" />
          </button>
          <button
            data-tool-op="line"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'line' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('schematicEditor.insertOverlay.ops.line'), 'schematic.tool.line')"
            @click="setTool('line')"
          >
            <Icon name="tool-line" />
          </button>
          <button
            data-tool-op="rectangle"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'rectangle' }"
            :disabled="isReadOnly"
            :title="t('schematicEditor.insertOverlay.ops.rectangle')"
            @click="setTool('rectangle')"
          >
            <Icon name="tool-rect" />
          </button>
          <button
            data-tool-op="circle"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'circle' }"
            :disabled="isReadOnly"
            :title="
              toolTitle(t('schematicEditor.insertOverlay.ops.circle'), 'schematic.tool.circle')
            "
            @click="setTool('circle')"
          >
            <Icon name="tool-circle" />
          </button>
          <button
            data-tool-op="arc"
            class="floating-btn tool-btn"
            :class="{ active: activeTool === 'arc' }"
            :disabled="isReadOnly"
            :title="toolTitle(t('schematicEditor.insertOverlay.ops.arc'), 'schematic.tool.arc')"
            @click="setTool('arc')"
          >
            <Icon name="tool-arc" />
          </button>
          <div class="toolbar-divider"></div>
          <!-- Not a placement tool: it runs on what is already there, so it
               sits in its own section and opens a dialog rather than arming. -->
          <button
            data-tool-op="annotate"
            class="floating-btn tool-btn"
            :disabled="isReadOnly"
            :title="t('schematicEditor.tools.annotateTitle')"
            @click="annotateOpen = true"
          >
            <Icon name="tool-annotate" />
          </button>
          <ToolbarSearch ref="insertSearch" :ops="searchOps" @pick="onSearchPick" />
        </div>

        <!-- Left view rail: zoom to fit, then display toggles (KiCad's
             left-toolbar idiom), as on the board and footprint editors. -->
        <div class="canvas-floating-toolbar toolbar-left-rail">
          <FitViewButton @fit="viewport?.zoomToFit()" />
          <div class="toolbar-divider"></div>
          <button
            data-tool-op="netHighlight"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: schematicView.netHighlight }"
            :title="t('schematicEditor.viewRail.netHighlight')"
            @click="toggleNetHighlight"
          >
            <Icon name="view-net-highlight" />
          </button>
          <button
            data-tool-op="showHiddenPins"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: schematicView.showHiddenPins }"
            :title="t('schematicEditor.viewRail.showHiddenPins')"
            @click="toggleHiddenPins"
          >
            <Icon name="view-hidden-pins" />
          </button>
          <button
            data-tool-op="showHiddenFields"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: schematicView.showHiddenFields }"
            :title="t('schematicEditor.viewRail.showHiddenFields')"
            @click="toggleHiddenFields"
          >
            <Icon name="view-hidden-fields" />
          </button>
        </div>

        <div class="viewport-pane">
          <SchematicViewport2D
            ref="viewport"
            :finding-markers="findingMarkers"
            :schematic="schematic"
            :revision="revision"
            :selected-items="selectedItems"
            :grid-settings="gridSettings"
            :connectivity="connectivity"
            :highlighted-net="highlightedNet"
            :net-highlight="schematicView.netHighlight"
            :show-hidden-pins="schematicView.showHiddenPins"
            :show-hidden-fields="schematicView.showHiddenFields"
            :sheet-path="activeSheetPath"
            :net-classes="netClasses"
            :file-path="props.filePath"
            :active-tool="activeTool"
            :wire-draft="wireDraft"
            :wire-posture="wirePosture"
            :placement="placementGhost"
            :placement-sheet="placementSheet"
            :pending-sheet-rect="pendingSheetRect"
            :sheet-draft-start="sheetDraftStart"
            :draw-draft="drawDraft"
            :held-draft="heldDraft"
            :bus-entry-size="busEntrySize"
            :directive-shape="directiveShape"
            :draw-grid="gridStepNm()"
            :image-data="pendingImage"
            @drag-verdict="dragVerdict = $event"
            @finding-marker="revealFinding"
            @update:selected-items="onViewportSelect"
            @update-grid="handleUpdateGrid"
            @move="(items, delta, options) => handleMove(items, delta, options)"
            @tool-click="handleToolClick"
            @tool-finish="handleToolFinish"
            @resize-sheet="handleResizeSheet"
            @drag-vertex="handleDragVertex"
            @resize-graphic="handleResizeGraphic"
            @float-land="clipboard.land"
            @float-cancel="clipboard.cancel"
            @drag-end="move.end()"
            @item-dblclick="onItemDblclick"
            @context-menu="onCanvasContextMenu"
          >
            <template #status>
              <HealthPill
                editor="schematic"
                :report="healthReport"
                :open="healthOpen"
                :checking="!checksAnswered || checksRunning"
                @toggle="healthDrawer.toggle"
              />
            </template>
          </SchematicViewport2D>
        </div>
        <div class="canvas-top-right">
          <CanvasFindWidget
            v-if="findOpen"
            ref="findWidget"
            v-model:query="findState.query"
            v-model:options="findState.options"
            v-model:replacement="findState.replacement"
            v-model:replace-open="findState.replaceOpen"
            v-model:scope="findState.scope"
            :count-label="findCountLabel"
            :has-matches="findResults.length > 0"
            :invalid="findInvalid"
            can-replace
            :read-only="isReadOnly"
            :scopes="findScopes"
            :scope-title="t('schematicEditor.find.scope')"
            @next="stepFind(1)"
            @previous="stepFind(-1)"
            @replace="replaceCurrent"
            @replace-all="replaceAll"
            @close="closeFind"
          >
            <template #replace-options>
              <label class="find-check">
                <input
                  type="checkbox"
                  :checked="findState.options.replaceReferences"
                  @change="
                    findState.options = {
                      ...findState.options,
                      replaceReferences: !findState.options.replaceReferences
                    }
                  "
                />
                <span>{{ t('schematicEditor.find.replaceReferences') }}</span>
              </label>
            </template>
            <template #notice>
              <div
                v-if="pendingReplace?.duplicates.length"
                class="find-row notice-row"
                role="alert"
              >
                <Icon name="status-warning" class="notice-glyph" />
                <span class="notice-text">{{
                  t('schematicEditor.find.duplicates', {
                    references: pendingReplace.duplicates.join(', ')
                  })
                }}</span>
                <button
                  type="button"
                  class="btn-outline btn-sm"
                  @click="commitReplace(pendingReplace.edits)"
                >
                  {{ t('schematicEditor.find.replaceAnyway') }}
                </button>
                <button type="button" class="btn-subtle btn-sm" @click="pendingReplace = null">
                  {{ t('schematicEditor.find.cancel') }}
                </button>
              </div>
            </template>
          </CanvasFindWidget>
        </div>
        <ContextMenu
          v-if="canvasMenu"
          :items="canvasMenuItems"
          :x="canvasMenu.x"
          :y="canvasMenu.y"
          @select="onCanvasMenuSelect"
          @close="closeCanvasMenu"
        />
        <FindingsDrawer
          v-if="healthOpen && !healthPinned"
          :findings="checksAnswered ? healthFindings : []"
          :pending="!checksAnswered"
          :checking="!checksAnswered || checksRunning"
          :height="healthHeight"
          :reveal="findingReveal"
          @locate="locateFinding"
          @fix="fixFinding"
          @pin="setPanelPinned('schematic', 'health', true)"
          @close="healthDrawer.close"
          @resize="healthDrawer.resize"
        >
          <template #settings><HealthViewSettings /></template>
        </FindingsDrawer>
        <LibraryChooser
          v-if="chooserMode"
          :kind="chooserMode"
          :design-footprints="designFootprintIds"
          :icon="chooserMode === 'power' ? 'tool-ground' : 'tool-symbol'"
          :title="
            chooserMode === 'power'
              ? t('shared.libraryChooser.title.placePower')
              : t('shared.libraryChooser.title.placeSymbol')
          "
          :verb="t('shared.libraryChooser.place')"
          :extra-items="chooserItems(chooserMode)"
          :in-design="designSymbolIds"
          :resolve-symbol="resolveChooserSymbol"
          @pick="armPlacement"
          @close="chooserMode = null"
          @open="openFromChooser"
        />
        <LibraryChooser
          v-if="changeChooserOpen"
          kind="symbol"
          icon="tool-symbol"
          :title="commandTitle(t('schematicEditor.symbolUpdate.changeAction'))"
          :verb="t('shared.libraryChooser.change')"
          :target="changeChooserTarget"
          :initial-id="symbolDialog?.libId ?? changeChooserInitial"
          :extra-items="chooserItems('symbol')"
          :in-design="designSymbolIds"
          :resolve-symbol="resolveChooserSymbol"
          @pick="onChangePick"
          @close="changeChooserOpen = false"
          @open="openFromChooser"
        />
        <LibraryChooser
          v-if="footprintChooser"
          kind="footprint"
          icon="tool-footprint"
          :title="commandTitle(t('shared.properties.browseFootprint'))"
          :verb="
            footprintChooser.ids.length > 1
              ? t('shared.libraryChooser.assignMany', { n: footprintChooser.ids.length })
              : t('shared.libraryChooser.assign')
          "
          :target="footprintChooser.target"
          :initial-id="footprintChooser.initial"
          :fit="footprintChooser.fit"
          :fields-for="() => footprintChooser?.fields ?? {}"
          :in-design="designFootprintIds"
          @pick="onFootprintPick"
          @close="footprintChooser = null"
          @open="openFromChooser"
        />
        <SymbolFieldsDialog
          v-if="fieldsDialogOpen && loneSymbol"
          :properties="loneSymbolFields"
          :read-only="isReadOnly"
          @add="onFieldAdd"
          @remove="onFieldRemove"
          @rename="onFieldRename"
          @move="onFieldMove"
          @set-value="onFieldSetValue"
          @set-visible="onFieldSetVisible"
          @close="fieldsDialogOpen = false"
        />
        <PartUpdateDialog
          v-if="symbolDialog"
          v-model:lib-id="symbolDialog.libId"
          :mode="symbolDialog.mode"
          kind="symbol"
          :selection-count="selectedSymbolIndices.size"
          :seeds="symbolUpdateSeeds"
          :options="symbolUpdateOptions"
          :defaults="symbolUpdateDefaults"
          :field-names="symbolFieldNames"
          :fields-off="SYMBOL_FIELDS_OFF"
          :preview="symbolUpdateRows"
          :paused="changeChooserOpen"
          @confirm="confirmSymbolUpdate"
          @choose="browseChangeSymbol"
          @close="symbolDialog = null"
        />
        <SchematicLabelPopover
          v-if="pendingLabel"
          :key="`${pendingLabel.screen.x}:${pendingLabel.screen.y}`"
          :kind="pendingLabel.kind"
          :screen="pendingLabel.screen"
          :net-names="
            pendingLabel.sheetPin
              ? pendingLabel.sheetPin.names.map((entry) => entry.name)
              : pendingLabel.kind === 'text' || pendingLabel.kind === 'text_box'
                ? []
                : netNames
          "
          :initial-text="pendingLabel.initialText"
          :directive-shape="directiveShape"
          @commit="commitPendingLabel"
          @cancel="pendingLabel = null"
        />
        <SchematicSheetPopover
          v-if="pendingSheet"
          :key="`${pendingSheet.screen.x}:${pendingSheet.screen.y}`"
          :screen="pendingSheet.screen"
          :default-stem="pendingSheet.defaultStem"
          :siblings="pendingSheet.siblings"
          @commit="commitPendingSheet"
          @cancel="pendingSheet = null"
        />
        <SchematicIncrementAnnotationsDialog
          v-if="incrementOpen"
          :initial="incrementInitial"
          :plan="incrementPlanFor"
          @confirm="applyIncrement"
          @close="incrementOpen = false"
        />
        <SchematicAnnotateDialog
          v-if="annotateOpen"
          :selection-count="selectedSymbolIndices.size"
          :plan="annotationPlanFor"
          @confirm="applyAnnotation"
          @close="annotateOpen = false"
        />
      </div>

      <Teleport v-if="showPanels" :to="panelRail" :disabled="panelsInline">
        <aside
          class="schematic-properties"
          :style="{ width: propertiesWidth + 'px' }"
          @mousedown="setActivePane('properties')"
        >
          <ResizeHandle
            edge="left"
            @resize-start="propertiesResizeStart = propertiesWidth"
            @resize="resizeProperties"
            @resize-end="commitProperties"
          />
          <CollapsiblePanel :title="t('shared.propertiesPanel.title')" flex>
            <FormatNotice v-if="selectedItems.length === 0" :file-path="props.filePath" />
            <PropertyTable
              ref="propertyTable"
              :groups="[...dragGroups, ...schematicGroups]"
              :distance-unit="gridSettings.unit"
              :read-only="isReadOnly"
              @edit="onSchematicEdit"
              @action="onSchematicAction"
              @escape="returnFocusToCanvas"
            />
            <LibraryLinkSection
              v-if="selectedSymbols.length"
              kind="symbol"
              :status="symbolLibraryStatus"
              :part="symbolLibraryPart"
              :can-edit="selectedSymbols.length === 1"
              :read-only="isReadOnly"
              @edit="editDesignSymbol"
              @update="openSymbolUpdate"
              @change="openSymbolChange"
              @edit-library="openInLibraryEditor"
            />
            <!-- The design's own pages, setup first, as on the board and in File. -->
            <div v-if="canOpenComponents" class="page-buttons">
              <button
                class="btn-outline btn-md btn-panel"
                @click="emit('open-schematic-setup', designRootPath)"
              >
                <Icon name="settings" />
                {{ t('shared.propertiesPanel.schematicSetup') }}
              </button>
              <button
                class="btn-outline btn-md btn-panel"
                @click="emit('open-components', designRootPath)"
              >
                <Icon name="components-table" />
                {{ t('shared.propertiesPanel.components') }}
              </button>
            </div>
          </CollapsiblePanel>
          <RailPinnedPanels
            editor="schematic"
            :grid-settings="gridSettings"
            :findings="checksAnswered ? healthFindings : []"
            :pending="!checksAnswered"
            :checking="!checksAnswered || checksRunning"
            :reveal="findingReveal"
            @update-grid="handleUpdateGrid"
            @locate="locateFinding"
            @fix="fixFinding"
          >
            <template #settings><HealthViewSettings /></template>
          </RailPinnedPanels>
        </aside>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.schematic-editor {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  background: var(--vscode-bg-viewport);
}

.viewport-host-area {
  flex: 1;
  min-width: 0;
  height: 100%;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.viewport-pane {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* Layout only — the look is `btn-panel` (DESIGN.md §3); the board's Board
   setup and Fabrication outputs pair is its twin. */
.page-buttons {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 10px;
}

/* Toolbar chrome (.canvas-floating-toolbar, .floating-btn, .tool-btn, …)
   comes from assets/canvasToolbar.css */

/* Container matches the footprint/PCB side panels (bg-sidebar) so the shared
   CollapsiblePanel header (bg-editor) stands out identically across editors. */
.schematic-properties {
  /* Width is set inline from `propertiesWidth`; `position: relative` is what the
     ResizeHandle positions against. */
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--vscode-border);
  background: var(--vscode-bg-sidebar, #1a221f);
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
}
.schematic-error {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--vscode-text-muted);
}
.schematic-error strong {
  color: var(--vscode-error);
}
.schematic-error button {
  padding: 6px 10px;
  border: 1px solid var(--vscode-accent);
  border-radius: 3px;
  color: var(--vscode-accent);
  background: var(--vscode-input-bg);
}
</style>
