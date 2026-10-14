<script setup lang="ts">
import { heldMove, withHoverKeys, type HoverSelection } from '../lib/hoverSelection'
import { SELECTION_GROUP, intersectGroups } from '../lib/propertyTable'
import { vToolbarFit } from '../lib/canvasToolbar'
import { computed, inject, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useContextPanels, useGroupKeydown } from '../lib/editorWorkspace'
import { useI18n } from 'vue-i18n'
import { buildSymbolPreviewSchematic, type KicadSymbolLibrary } from '../lib/kicad/symbolLibrary'
import {
  addArc,
  addBezier,
  addCircle,
  addPin,
  addPolyline,
  addRectangle,
  addPinAlternate,
  addSymbol,
  addText,
  addTextBox,
  addUnit,
  appendNodeCopy,
  appendRepeatCopy,
  boundsCenter,
  defaultUnitNodeFor,
  deleteGraphic,
  deletePin,
  maxPinNumber,
  mirrorGraphicNode,
  mirrorPinNode,
  movePartToUnit,
  owningUnitNode,
  removePinAlternate,
  removeSymbol,
  removeUnit,
  renameSymbol,
  rotateGraphicNode,
  rotatePinNode,
  setSymbolFlag,
  setSymbolPinDisplay,
  setSymbolFootprintFilters,
  setSymbolPowerKind,
  setSymbolProperty,
  setSymbolUnitName,
  setSymbolUnitsInterchangeable,
  setSymbolPropertyVisible,
  symbolPropertyNode,
  addSymbolProperty,
  removeSymbolProperty,
  renameSymbolProperty,
  moveSymbolProperty,
  moveSymbolAnchor,
  updateSymbolProperty,
  type FieldPatch,
  graphicVertexPoints,
  setGraphicVertex,
  addressOfPartNode,
  incrementPinLabel,
  sameAddress,
  symbolItemsBounds,
  symbolPartGraphic,
  symbolPartNode,
  symbolPartPin,
  symbolBodyStyleCount,
  symbolUnitCount,
  symbolUnitName,
  unitLetter,
  translateGraphicNode,
  translatePinNode,
  translateSymbolPropertyNode,
  updatePin,
  updatePinAlternate,
  type MirrorAxis,
  type PinAlternatePatch,
  type PinPatch,
  fillKindWithColor,
  changedSymbolName,
  type SymbolPartAddress
} from '../lib/symbol/symbolEdit'
import { applyGraphicEdit, graphicPatchFor } from '../lib/symbol/graphicEdit'
import {
  type KicadLibSymbol,
  type KicadSchematic,
  type KicadTextEffects
} from '../lib/kicad/schematic'
import { strokeOptionsFromTextEffects } from '../lib/kicad/newstroke'
import {
  ADD_ALTERNATE_ACTION,
  alternateIndexOf,
  buildPendingGroups,
  buildSymbolGroups,
  REMOVE_ALTERNATE_ACTION,
  SYMBOL_GROUP_TYPES
} from '../lib/symbol/symbolPropertySchema'
import type { PropertyEditValue } from '../lib/propertyTable'
import { getToken, parseSExpr, serializeSExpr, type SExprList } from '../lib/kicad/sexpr'
import type { TextSession } from '../lib/document/textSession'
import { matchesHotkey, hotkeyLabel, isTypingTarget, toolTitle } from '../lib/hotkeys'
import SymbolViewport2D from './symbol/SymbolViewport2D.vue'
import PropertyTable from './shared/PropertyTable.vue'
import CollapsiblePanel from './shared/CollapsiblePanel.vue'
import { type GridSettings } from '../lib/engine/ViewportEngine'
import {
  gridKeyUpdate,
  SYMBOL_GRID_DEFAULTS,
  SYMBOL_UNIT_SPACINGS,
  useGridSettings
} from '../lib/gridPreferences'
import { isViewCommand, viewCommandFor, viewCommandOps } from '../lib/viewCommands'
import { mmToNm, mmToSpacing, nm, nmToMm, spacingToMm, type Nm } from '../lib/kicad/coordinates'
import Icon from './shared/Icon.vue'
import ToolbarSearch from './shared/ToolbarSearch.vue'
import CanvasFindWidget from './shared/CanvasFindWidget.vue'
import { useCanvasFind } from '../lib/useCanvasFind'
import { symbolFindCandidates } from '../lib/symbol/symbolFind'
import { setSymbolView, symbolViewState } from '../lib/symbolView'
import FitViewButton from './shared/FitViewButton.vue'
import {
  fitViewOp,
  FIT_VIEW_OP_ID,
  isTransformOp,
  TRANSFORM_TOOLS,
  type ToolbarSearchOp
} from '../lib/toolSearch'
import ContextMenu from './shared/ContextMenu.vue'
import SymbolFieldsDialog from './symbol/SymbolFieldsDialog.vue'
import PinTablePanel from './symbol/PinTablePanel.vue'
import ResizeHandle from './shared/ResizeHandle.vue'
import HealthPill from './shared/HealthPill.vue'
import FindingsDrawer from './shared/FindingsDrawer.vue'
import RailPinnedPanels from './shared/RailPinnedPanels.vue'
import {
  documentFindings,
  findingMarks,
  type HealthFinding,
  type HealthReport
} from '../lib/designHealth'
import { designHealthViewState } from '../lib/designHealthView'
import type { CheckResult } from '../lib/schematic/checks'
import HealthViewSettings from './shared/HealthViewSettings.vue'
import { useHealthDrawer } from '../lib/designHealthDrawer'
import { symbolChecks, symbolTargetAddress } from '../lib/symbol/symbolChecks'
import { EDITOR_WORKSPACE } from '../lib/editorWorkspace'
import { panelPinned, panelWidth, setPanelPinned, setPanelWidth } from '../lib/panelLayout'
import {
  addressCsvKey,
  buildPinTableRows,
  formatPinCsv,
  layoutImportedPins,
  parsePinCsv,
  type PinTableRow
} from '../lib/schematic/pinTable'
import {
  buildEditMenu,
  dispatchEditAction,
  selectAllInField,
  usePublishedEditActions
} from '../lib/editActions'
import { setClipboard, usePasteable } from '../lib/documentClipboard'
import type { HotkeyActionId } from '../lib/hotkeys'
import type { MenuNode } from '../lib/menu'
import {
  DEFAULT_ORIENTATION,
  PIN_LENGTH,
  toolClick,
  toolFinish,
  toolGesture,
  toolItems,
  toolTemplate,
  type Point2,
  type SymbolTool,
  type ToolClickResult,
  type ToolDefaults,
  type ToolOrientation
} from '../lib/symbolTools'
import type { SymbolGraphic, SymbolPin } from '../lib/kicad/schematic'
import type { TransformOp } from '../lib/schematic/schematicTransform'
import type { Rgba } from '../lib/kicad/color'
import { repeatOffset, REPEAT_NUMBER_STEP } from '../lib/symbolRepeat'
import { resetActivePane, useActivePane } from '../lib/activePane'
import FormatNotice from './shared/FormatNotice.vue'
import { captureSchematicDocument } from '../lib/engine/schematicCapture'
import { dataUrlBase64, symbolExportPath } from '../lib/symbol/symbolExport'

const { t } = useI18n()
const { show: showPanels, inline: panelsInline, rail: panelRail } = useContextPanels()

const props = defineProps<{
  /** The open library this view draws (`lib/document/textSession.ts`). */
  session: TextSession<KicadSymbolLibrary, SymbolPartAddress>
  modelValue: string
  name: string
  isReadOnly?: boolean
  filePath?: string | null
  /** Reveal a specific symbol on open (Component viewer's Open button). */
  focusRequest?: { symbol: string; nonce: number } | null
  /** The symbol this tab last showed, to show again when it comes back to the front. */
  shownSymbol?: string
  /**
   * A symbol lifecycle op driven from the File Explorer / Project pane
   * (add / rename / delete) — the left bar owns these, like other file types.
   * `symbol` names the target; `newName` carries the tree's inline-rename input.
   */
  opRequest?: {
    op: 'add' | 'rename' | 'delete'
    symbol?: string
    newName?: string
    nonce: number
  } | null
}>()

const emit = defineEmits<{
  /** The symbol now shown — App puts it in the tab title. */
  (e: 'active-symbol', name: string | null): void
  /** Every symbol this library now holds — the left bar lists these, buffer
   *  included, rather than waiting for a save. */
  (e: 'symbol-names', names: string[]): void
}>()

const readOnly = computed(() => props.isReadOnly ?? false)

/** The session's library, re-read after every change it announces. */
const modelVersion = ref(0)
const library = computed<KicadSymbolLibrary | null>(() => {
  void modelVersion.value
  return props.session.model()
})
const parseError = computed<string | null>(() => {
  void modelVersion.value
  const reason = props.session.parseError()
  return reason === 'empty' ? t('symbolEditor.errors.empty') : reason
})
const selectedName = ref<string | null>(null)
/**
 * What is selected, named the way the renderer names it. Not a flat index:
 * those count across units, so adding a pin to an earlier unit silently
 * retargeted a held selection. See ARCHITECTURE.md §3.7.
 */
const selectedItems = ref<SymbolPartAddress[]>([])

// Grid is a session/view preference (persisted across tabs/restarts, per
// editor kind) — never written to the .kicad_sym.
const gridSettings = useGridSettings('symbol', SYMBOL_GRID_DEFAULTS)
const handleUpdateGrid = (settings: Partial<GridSettings>): void => {
  const next = { ...gridSettings.value, ...settings }
  // On a unit toggle, convert so the physical grid is unchanged (50 mil ↔ 1.27 mm).
  if (settings.unit && settings.unit !== gridSettings.value.unit) {
    const mm = spacingToMm(gridSettings.value.spacing, gridSettings.value.unit)
    next.spacing = mmToSpacing(mm, settings.unit)
  }
  gridSettings.value = next
}

const requestedName = (): string | null => {
  const want = props.focusRequest?.symbol
  return want && library.value?.names.includes(want) ? want : null
}

/**
 * The symbol to show: the one already shown, else the one this tab last showed
 * (App sets it to a request's too), else the one asked for, else the first. A
 * request made while the editor is up lands through its nonce, below.
 */
const reconcileSelectedName = (): void => {
  const names = library.value?.names ?? []
  if (selectedName.value && names.includes(selectedName.value)) return
  const shown = props.shownSymbol
  selectedName.value =
    (shown && names.includes(shown) ? shown : null) ?? requestedName() ?? names[0] ?? null
}

const stopSession = props.session.subscribe((): void => {
  modelVersion.value++
  reconcileSelectedName()
})
reconcileSelectedName()

// Text this view did not write — an agent's symbol, a rename's forwarding —
// arrives as the tab's buffer changing under it.
watch(
  () => props.modelValue,
  () => props.session.sync()
)

watch(
  () => props.focusRequest?.nonce,
  () => {
    const requested = requestedName()
    if (requested) selectedName.value = requested
  }
)

// Symbol add/rename/delete driven from the File Explorer / Project pane. Runs
// once the library is parsed (the tab may have just opened for this op).
watch(
  () => props.opRequest?.nonce,
  () => {
    const req = props.opRequest
    if (!req || !library.value || readOnly.value) return
    if (req.op === 'add') {
      handleAddSymbol()
    } else if (req.op === 'rename' && req.symbol && library.value.names.includes(req.symbol)) {
      selectedName.value = req.symbol
      if (req.newName) renameSelectedTo(req.newName)
    } else if (req.op === 'delete' && req.symbol && library.value.names.includes(req.symbol)) {
      selectedName.value = req.symbol
      handleDeleteSymbol()
    }
  }
)

// Keep the tab title in sync with the symbol being edited.
watch(selectedName, (name) => emit('active-symbol', name), { immediate: true })

// …and the left bar's lists with what the library holds. Keyed on the names, so
// every add / rename / delete reports itself and no other command does.
watch(
  () => library.value?.names.join('\n') ?? null,
  () => emit('symbol-names', library.value?.names ?? []),
  { immediate: true }
)

const definition = computed(() =>
  library.value && selectedName.value
    ? (library.value.symbols.get(selectedName.value) ?? null)
    : null
)

// ---------------------------------------------------------------------------
// Units — which gate of a multi-unit package is being edited. Unit 0 (the body
// common to every unit) always renders alongside, so it is never "selected".
// ---------------------------------------------------------------------------
const selectedUnit = ref(1)

const unitCount = computed(() => (definition.value ? symbolUnitCount(definition.value._node) : 1))
/** The selector only earns its space on a symbol that actually has gates. */
const isMultiUnit = computed(() => unitCount.value > 1)

const unitOptions = computed(() =>
  Array.from({ length: unitCount.value }, (_, i) => {
    const unit = i + 1
    const name = definition.value ? symbolUnitName(definition.value._node, unit) : null
    return {
      unit,
      // KiCad 7+ lets a unit carry a name ("NMOS"/"PMOS"); fall back to its letter.
      label: name
        ? t('symbolEditor.units.namedOption', { letter: unitLetter(unit), name })
        : t('symbolEditor.units.option', { letter: unitLetter(unit) })
    }
  })
)

// A symbol switch must not leave the selector pointing at a gate the new symbol
// doesn't have.
watch([definition, unitCount], () => {
  if (selectedUnit.value > unitCount.value) selectedUnit.value = 1
})

// Switching gates re-scopes what is on screen, and a selection is only ever of
// visible things: KiCad deselects too. Keeping it would leave a drag moving
// parts of a unit nobody can see.
watch(selectedUnit, () => {
  selectedItems.value = []
})

// ---------------------------------------------------------------------------
// Body styles — the alternate representations of one symbol (a NAND drawn as an
// OR with inverted inputs is the "De Morgan equivalent"). Style 0 is the body
// common to all of them and always renders, so it is never "selected".
//
// Viewing only: authoring an alternate is deferred — see the workstream log.
// ---------------------------------------------------------------------------
const selectedBodyStyle = ref(1)

const bodyStyleCount = computed(() =>
  definition.value ? symbolBodyStyleCount(definition.value._node) : 1
)
/** The selector only earns its space on a symbol that actually has alternates. */
const hasBodyStyles = computed(() => bodyStyleCount.value > 1)

const bodyStyleOptions = computed(() =>
  Array.from({ length: bodyStyleCount.value }, (_, i) => {
    const style = i + 1
    return {
      style,
      // KiCad names the first two; further styles are KiCad 10 customs, which
      // carry names we do not parse yet, so they fall back to their number.
      label:
        style === 1
          ? t('symbolEditor.bodyStyles.standard')
          : style === 2
            ? t('symbolEditor.bodyStyles.alternate')
            : t('symbolEditor.bodyStyles.option', { number: style })
    }
  })
)

// A symbol switch must not leave the selector pointing at a style the new symbol
// doesn't have.
watch([definition, bodyStyleCount], () => {
  if (selectedBodyStyle.value > bodyStyleCount.value) selectedBodyStyle.value = 1
})

watch(selectedBodyStyle, () => {
  selectedItems.value = []
})

const handleAddUnit = (): void => {
  const def = definition.value
  if (!def || readOnly.value) return
  let added = 1
  runCommand(t('symbolEditor.commands.addUnit'), () => void (added = addUnit(def._node)), {
    afterApply: () => {
      selectedUnit.value = added
      selectedItems.value = []
    }
  })
}

const handleRemoveUnit = (): void => {
  const def = definition.value
  if (!def || readOnly.value || !isMultiUnit.value) return
  const target = selectedUnit.value
  runCommand(t('symbolEditor.commands.removeUnit'), () => removeUnit(def._node, target), {
    afterApply: () => {
      selectedUnit.value = Math.min(target, symbolUnitCount(def._node))
      selectedItems.value = []
    }
  })
}

const preview = shallowRef<KicadSchematic | null>(null)
watch(
  [library, selectedName, selectedUnit, selectedBodyStyle],
  () => {
    try {
      preview.value =
        library.value && selectedName.value
          ? buildSymbolPreviewSchematic(
              library.value,
              selectedName.value,
              selectedUnit.value,
              selectedBodyStyle.value
            )
          : null
    } catch (err) {
      console.error('Failed to build symbol preview:', err)
      preview.value = null
    }
  },
  { immediate: true }
)

// ---------------------------------------------------------------------------
// Command layer — every mutation funnels through runCommand(), which mutates
// the real (kicad_symbol_lib …) root, serializes losslessly, emits, re-parses,
// and records an undo entry. Mirrors FootprintEditor.
// ---------------------------------------------------------------------------
const historyVersion = ref(0)

interface CommandOptions {
  mergeKey?: string
  afterApply?: () => void
}

const runCommand = (label: string, mutate: () => void, options?: CommandOptions): void => {
  if (readOnly.value) return
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

/** Re-select what an undone or redone step had. A name that no longer resolves
 *  belongs to a part the restored library does not have; dropping it beats
 *  holding an address that points at nothing. */
const restoreSelection = (selection: SymbolPartAddress[]): void => {
  const node = definition.value?._node
  selectedItems.value = node ? selection.filter((s) => !!symbolPartNode(node, s)) : []
}

/** Bring forward the symbol an undo or redo changed, so no step lands out of sight. */
const showChangedSymbol = (now: string, was: string): void => {
  const name = library.value ? changedSymbolName(library.value, now, was) : null
  if (name) selectedName.value = name
}

const undo = (): void => {
  const entry = props.session.undo()
  if (entry) {
    showChangedSymbol(entry.before, entry.after)
    restoreSelection(entry.selectionBefore)
    historyVersion.value++
  }
}
const redo = (): void => {
  const entry = props.session.redo()
  if (entry) {
    showChangedSymbol(entry.after, entry.before)
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

// Reset selection on file switch (history is per-file, picked back up by key).
watch(
  () => props.filePath,
  () => {
    selectedItems.value = []
    historyVersion.value++
  }
)

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
// The schema PropertyTable renders, rebuilt whenever the selection or document
// changes. definition/selectedItems are already reactive.
/**
 * What the tool will place, minus where — the panel edits this and `toolItems`
 * builds from it, so setting the electrical type once places every pin that way
 * instead of correcting each one after the fact. Reset with the tool, since
 * these are the tool's settings rather than the document's.
 */
const toolDefaults = ref<ToolDefaults>({})

/** Grid-snapped cursor, so the pending item's position rows tell the truth. */
const cursorPoint = ref<Point2 | null>(null)

/**
 * The item the armed tool is about to place. Built from the real point chain
 * where there is one — `toolItems` is what the ghost draws, so the panel reports
 * the same geometry the canvas is showing — and from the bare template before
 * the first click, when a span tool has nothing to describe yet.
 */
const pendingItems = computed(() => {
  if (!isPlacing.value) return null
  const at = cursorPoint.value
  if (at) {
    const built = toolItems(
      activeTool.value,
      [...toolDraft.value, at],
      toolOrientation.value,
      toolDefaults.value
    )
    if (built.pins.length || built.graphics.length) return built
  }
  return toolTemplate(activeTool.value, toolDefaults.value, at ?? undefined)
})

/**
 * The panel follows the pending item while a tool is armed: what is about to
 * land is the thing you are working on, so it is what the panel should describe.
 * Falls back to the selection the moment the tool is put away.
 */
const symbolGroups = computed(() => {
  const pending = pendingItems.value
  if (pending) {
    const groups = buildPendingGroups(pending, t, {
      multiUnit: isMultiUnit.value,
      commonToAllUnits: !!toolDefaults.value.commonToAllUnits
    })
    if (groups.length) return groups
  }
  return intersectGroups(
    buildSymbolGroups(definition.value, selectedItems.value, t, { unit: selectedUnit.value }),
    t('shared.properties.selection')
  )
})

// ---------------------------------------------------------------------------
// Fields editor (the structural half — see SymbolFieldsDialog)
// ---------------------------------------------------------------------------

const fieldsDialogOpen = ref(false)

/** A key no field is using yet, so Add never collides with an existing one. */
const uniqueFieldKey = (def: KicadLibSymbol): string => {
  const taken = new Set(def.properties.map((property) => property.key))
  const base = t('symbolEditor.fieldsDialog.defaultName')
  if (!taken.has(base)) return base
  let n = 1
  while (taken.has(`${base}${n}`)) n++
  return `${base}${n}`
}

/**
 * Run one fields-list operation as an undoable command. Each writer refuses its
 * illegal cases by mutating nothing, and `runCommand` drops a command whose
 * serialization is unchanged — so a refusal leaves no empty undo step.
 */
const runFieldOp = (label: string, apply: (def: KicadLibSymbol) => boolean): void => {
  const def = definition.value
  if (!def || readOnly.value) return
  runCommand(label, () => void apply(def))
}

const onFieldAdd = (): void => {
  const def = definition.value
  if (!def) return
  const key = uniqueFieldKey(def)
  runFieldOp(t('symbolEditor.commands.addField'), (d) => addSymbolProperty(d._node, key))
}

const onFieldRemove = (key: string): void => {
  runFieldOp(t('symbolEditor.commands.removeField'), (d) => removeSymbolProperty(d._node, key))
  // A removed field cannot stay selected: its address names nothing.
  selectedItems.value = selectedItems.value.filter(
    (item) => !(item.kind === 'field' && item.field === key)
  )
}

const onFieldRename = (key: string, newKey: string): void => {
  runFieldOp(t('symbolEditor.commands.renameField'), (d) =>
    renameSymbolProperty(d._node, key, newKey)
  )
  selectedItems.value = selectedItems.value.map((item) =>
    item.kind === 'field' && item.field === key ? { ...item, field: newKey } : item
  )
}

const onFieldMove = (key: string, delta: 1 | -1): void => {
  runFieldOp(t('symbolEditor.commands.reorderFields'), (d) =>
    moveSymbolProperty(d._node, key, delta)
  )
}

const onFieldSetValue = (key: string, value: string): void => {
  const def = definition.value
  if (!def || readOnly.value) return
  runCommand(t('symbolEditor.commands.editField', { field: key }), () =>
    setSymbolProperty(def._node, key, value)
  )
}

const onFieldSetVisible = (key: string, visible: boolean): void => {
  const def = definition.value
  if (!def || readOnly.value) return
  const node = symbolPropertyNode(def._node, key)
  if (!node) return
  runCommand(t('symbolEditor.commands.editFieldStyle'), () =>
    setSymbolPropertyVisible(node, visible)
  )
}

/** Apply a symbol-group edit (a field or a flag) to the current definition. */
const applySymbolEdit = (def: KicadLibSymbol, key: string, value: PropertyEditValue): void => {
  if (key === 'inBom') setSymbolFlag(def._node, 'in_bom', !!value)
  else if (key === 'onBoard') setSymbolFlag(def._node, 'on_board', !!value)
  else if (key === 'excludeFromSim') setSymbolFlag(def._node, 'exclude_from_sim', !!value)
  else if (key === 'inPosFiles') setSymbolFlag(def._node, 'in_pos_files', !!value)
  else if (key === 'duplicatePinNumbersAreJumpers')
    setSymbolFlag(def._node, 'duplicate_pin_numbers_are_jumpers', !!value)
  else if (key === 'power') {
    const kind = String(value)
    if (kind === 'none' || kind === 'global' || kind === 'local')
      setSymbolPowerKind(def._node, kind)
  } else if (key === 'fpFilters') setSymbolFootprintFilters(def._node, String(value))
  else if (key === 'unitName') setSymbolUnitName(def._node, selectedUnit.value, String(value))
  else if (key === 'unitsInterchangeable') setSymbolUnitsInterchangeable(def._node, !!value)
  // The panel asks these positively ("show"); the file stores the negative.
  else if (key === 'showPinNames') setSymbolPinDisplay(def._node, { namesHidden: !value })
  else if (key === 'showPinNumbers') setSymbolPinDisplay(def._node, { numbersHidden: !value })
  else if (key === 'pinNameOffset')
    setSymbolPinDisplay(def._node, { nameOffset: nm(Number(value)) })
  // A field row: `key` IS the property key, since the panel enumerates the
  // symbol's own properties rather than a fixed list.
  else setSymbolProperty(def._node, key, String(value))
}

/** The weight (nm) the armed text tool's ghost is drawn at, or null when none is. */
const pendingTextThickness = (): number | null => {
  const pending = pendingItems.value?.graphics.find(
    (graphic) => graphic.type === 'text' || graphic.type === 'textBox'
  )
  return pending && 'effects' in pending
    ? mmToNm(strokeOptionsFromTextEffects(pending.effects).thickness)
    : null
}

/** Text-box panel rows that belong to the shared TEXT template, not the border. */
const TEXT_TEMPLATE_KEYS = new Set([
  'text',
  'size',
  'thickness',
  'thicknessAuto',
  'bold',
  'italic',
  'hAlign',
  'vAlign',
  'color'
])

/** Text-box margin rows → the field each one writes. */
const MARGIN_KEYS: Record<string, 'left' | 'top' | 'right' | 'bottom'> = {
  marginLeft: 'left',
  marginTop: 'top',
  marginRight: 'right',
  marginBottom: 'bottom'
}

/**
 * Retarget the armed tool. Mirrors `applyGraphicEdit`'s dispatch, but writes the
 * typed template instead of an AST node — the same split as
 * `setTypedGraphicVertex` against `setGraphicVertex`. The panel only offers rows
 * a tool can carry (position rows are filtered out by `buildPendingGroups`), so
 * this handles exactly what the panel can show.
 */
const applyPendingEdit = (groupType: string, key: string, value: PropertyEditValue): void => {
  const current = toolDefaults.value
  // Not a property of the item at all — it decides which unit sub-symbol the
  // insert writes into, so it lives on the tool rather than on either template.
  if (key === 'commonToAllUnits') {
    toolDefaults.value = { ...current, commonToAllUnits: !!value }
    return
  }
  if (groupType === 'pin') {
    // Two rows are a FONT on the pin's name/number node rather than a scalar on
    // the pin, so they retarget the effects the ghost is already drawn with —
    // which keeps everything else about those effects (notably `hidden`) intact.
    if (key === 'nameSize' || key === 'numberSize') {
      const which = key === 'nameSize' ? 'nameEffects' : 'numberEffects'
      const base = pendingItems.value?.pins[0]?.[which]
      if (!base) return
      const height = Number(value)
      toolDefaults.value = {
        ...current,
        pin: { ...current.pin, [which]: { ...base, fontSize: { height, width: height } } }
      }
      return
    }
    toolDefaults.value = { ...current, pin: { ...current.pin, [key]: value } }
    return
  }
  // A text box's rows come from three places at once — its string and font are
  // `text` defaults, its border and fill are `graphic` defaults, its margins its
  // own — so it routes by key rather than by group. Falling through to the
  // stroke/fill branch below would have silently dropped every font and margin
  // edit made while the tool was armed.
  if (groupType === 'textBox' && MARGIN_KEYS[key]) {
    toolDefaults.value = {
      ...current,
      textBox: {
        ...current.textBox,
        margins: { ...current.textBox?.margins, [MARGIN_KEYS[key]]: Number(value) }
      }
    }
    return
  }
  if (groupType === 'text' || (groupType === 'textBox' && TEXT_TEMPLATE_KEYS.has(key))) {
    const text = { ...current.text }
    if (key === 'text') text.text = String(value)
    else if (key === 'size') {
      const height = nm(Number(value))
      text.effects = { ...text.effects, fontSize: { height, width: height } }
    } else if (key === 'thickness') {
      text.effects = { ...text.effects, thickness: nm(Number(value)) }
    } else if (key === 'thicknessAuto') {
      // Auto is the ABSENCE of a thickness, here as in the file. Leaving it
      // writes the weight the ghost is already drawn at, so the preview does
      // not jump when the checkbox changes.
      const rest: Partial<KicadTextEffects> = { ...text.effects }
      delete rest.thickness
      const drawn = pendingTextThickness()
      text.effects = value || drawn === null ? rest : { ...rest, thickness: nm(drawn) }
    } else if (key === 'hAlign') {
      const align = String(value)
      if (align === 'left' || align === 'center' || align === 'right') {
        text.effects = { ...text.effects, horizontalAlign: align }
      }
    } else if (key === 'vAlign') {
      const align = String(value)
      if (align === 'top' || align === 'center' || align === 'bottom') {
        text.effects = { ...text.effects, verticalAlign: align }
      }
    } else if (key === 'color') {
      text.effects = { ...text.effects, color: (value as Rgba | null) ?? undefined }
    } else {
      // bold / italic
      text.effects = { ...text.effects, [key]: !!value }
    }
    toolDefaults.value = { ...current, text }
    return
  }
  // Every other graphic group carries only stroke and fill.
  const graphic = { ...current.graphic }
  if (key === 'strokeWidth') graphic.stroke = { ...graphic.stroke, width: nm(Number(value)) }
  else if (key === 'strokeType') graphic.stroke = { ...graphic.stroke, type: String(value) }
  else if (key === 'strokeColor') graphic.stroke = { ...graphic.stroke, color: value as Rgba }
  else if (key === 'fill') graphic.fill = String(value)
  else if (key === 'fillColor') {
    graphic.fillColor = value as Rgba
    if (value) graphic.fill = fillKindWithColor(graphic.fill)
  }
  toolDefaults.value = { ...current, graphic }
}

/**
 * The one property-edit channel: apply the edit to every selected node of the
 * group's type inside a single undoable command (mergeKey coalesces typing).
 */
const onEdit = (
  groupType: string,
  key: string,
  value: PropertyEditValue,
  groupId?: string,
  sharedKey?: string
): void => {
  // A mixed selection's edit is each kind's, merged into one undo step.
  if (groupType === SELECTION_GROUP) {
    const members = symbolGroups.value[0]?.members ?? []
    for (const member of members)
      onEdit(member.type, key, value, member.id, `${SELECTION_GROUP}:${key}`)
    return
  }
  // While a tool is armed the panel is describing the PENDING item, so an edit
  // retargets the tool rather than the document — and must not reach the command
  // layer at all: there is nothing placed yet to undo.
  if (pendingItems.value) {
    applyPendingEdit(groupType, key, value)
    return
  }
  const def = definition.value
  if (!def) return
  const mergeKey = sharedKey ?? `${groupType}:${key}`
  // Moving a part between unit sub-symbols, not patching one: it re-parents the
  // node, so it cannot go through the per-type patch dispatch below — and the
  // selection has to be re-derived afterwards, since a part's address names the
  // unit that holds it.
  if (key === 'commonToAllUnits') {
    const moved = selectedItems.value
      .map((address) => ({ address, node: symbolPartNode(def._node, address) }))
      .filter((entry): entry is { address: SymbolPartAddress; node: SExprList } => !!entry.node)
    let landed: SymbolPartAddress[] = []
    runCommand(
      t('symbolEditor.commands.editUnitScope'),
      () => {
        landed = []
        for (const { address, node } of moved) {
          movePartToUnit(def._node, node, value ? 0 : selectedUnit.value, address.style)
          const next = addressOfPartNode(def._node, node)
          if (next) landed.push(next)
        }
      },
      { afterApply: () => (selectedItems.value = landed) }
    )
    return
  }
  if (SYMBOL_GROUP_TYPES.has(groupType)) {
    // The symbol's own name, not one of its properties. Intercepted before
    // `applySymbolEdit`, whose fallback treats an unrecognized key as a field
    // key — left to it, renaming would quietly write `(property "symbolName")`.
    // `renameSelectedTo` owns its own command, its collision guard and the
    // selected-name update, and is what the File Explorer's rename calls too.
    if (key === 'symbolName') {
      if (typeof value === 'string') renameSelectedTo(value)
      return
    }
    runCommand(
      t('symbolEditor.commands.editField', { field: key }),
      () => applySymbolEdit(def, key, value),
      {
        mergeKey
      }
    )
    return
  }
  // The styling half of field editing, applied to every selected field.
  if (groupType === 'field') {
    // …except the key, which is structure rather than styling: it re-parents
    // nothing but it renames the node the selection points at, so it goes
    // through the same writer the Fields dialog uses (which refuses a mandatory
    // key, a collision and an empty string) and re-targets the selection after.
    if (key === 'name') {
      const current = selectedItems.value.find((item) => item.kind === 'field')?.field
      if (current && typeof value === 'string') onFieldRename(current, value.trim())
      return
    }
    const nodes = selectedNodesOfKind('field')
    runCommand(
      t('symbolEditor.commands.editFieldStyle'),
      () => nodes.forEach((n) => updateSymbolProperty(n, { [key]: value } as FieldPatch)),
      { mergeKey }
    )
    return
  }
  if (groupType === 'pin') {
    const nodes = selectedNodesOfKind('pin')
    runCommand(
      t('symbolEditor.commands.editPin'),
      () => nodes.forEach((n) => updatePin(n, { [key]: value } as PinPatch)),
      { mergeKey }
    )
    return
  }
  // One alternate pin function of the (single) selected pin. The group id says
  // which; the field key says which of its three atoms.
  if (groupType === 'alternate') {
    const index = alternateIndexOf(groupId)
    const [pinNode] = selectedNodesOfKind('pin')
    if (index === null || !pinNode) return
    runCommand(
      t('symbolEditor.commands.editAlternate'),
      () => updatePinAlternate(pinNode, index, { [key]: String(value) } as PinAlternatePatch),
      { mergeKey: `${groupId}:${key}` }
    )
    return
  }
  // A graphic subtype group ('rectangle'/'line'/'circle'/'arc'/'text').
  // The typed graphic travels with its node: one row (`thicknessAuto`) needs the
  // weight the item is currently drawn at, which only the typed side knows.
  const targets = selectedItems.value
    .map((a) => ({ graphic: symbolPartGraphic(def, a), node: symbolPartNode(def._node, a) }))
    .filter(
      (target): target is { graphic: SymbolGraphic; node: SExprList } =>
        target.graphic?.type === groupType && !!target.node
    )
  runCommand(
    t('symbolEditor.commands.editGraphic'),
    () =>
      targets.forEach(({ graphic, node }) =>
        applyGraphicEdit(groupType, node, graphicPatchFor(key, value, graphic))
      ),
    { mergeKey }
  )
}

/**
 * A section-header button — the add/remove half of the alternate pin functions
 * list, which is the one part of the panel that is a repeating list rather than
 * a fixed set of fields.
 *
 * A fresh alternate is named from its position rather than left blank: an empty
 * name is what KiCad reads as no alternate at all, so a blank row would look
 * added and behave as absent.
 */
const onPanelAction = (
  _groupType: string,
  actionId: string,
  groupId?: string,
  fieldKey?: string
): void => {
  if (readOnly.value) return
  // The panel names a field, the canvas selects it, and the panel re-renders
  // describing that selection — the route to the styling rows.
  if (actionId === 'focusField') {
    if (fieldKey)
      selectedItems.value = [{ kind: 'field', unit: 0, style: 0, index: 0, field: fieldKey }]
    return
  }
  if (actionId === 'editFields') {
    fieldsDialogOpen.value = true
    return
  }
  const [pinNode] = selectedNodesOfKind('pin')
  if (!pinNode) return
  if (actionId === ADD_ALTERNATE_ACTION) {
    runCommand(t('symbolEditor.commands.addAlternate'), () => {
      addPinAlternate(pinNode, t('symbolEditor.alternates.defaultName'))
    })
    return
  }
  if (actionId === REMOVE_ALTERNATE_ACTION) {
    const index = alternateIndexOf(groupId)
    if (index === null) return
    runCommand(t('symbolEditor.commands.removeAlternate'), () => removePinAlternate(pinNode, index))
  }
}

// A derived symbol inherits its whole body from the symbol it `extends` and
// carries no geometry of its own — KiCad's model, and what the preview draws.
// Adding a pin here would scaffold a unit sub-symbol KiCad would not expect, so
// the geometry tools are gated off; its fields stay editable.
const isDerived = computed(() => !!definition.value?.extends)
/**
 * An alternate body style is viewable but not yet authorable: every insert
 * routes to style 1 (`getOrCreateUnitNode`), so a pin added while style 2 is on
 * screen would land in geometry that is not rendered and read as a delete.
 * Gating the tools is the honest version of that gap.
 */
const isAlternateBodyStyle = computed(() => selectedBodyStyle.value !== 1)
const canAddGeometry = computed(
  () => !readOnly.value && !!definition.value && !isDerived.value && !isAlternateBodyStyle.value
)
watch(canAddGeometry, (allowed) => {
  if (!allowed && activeTool.value !== 'anchor') activeTool.value = 'select'
})
/**
 * Moving the anchor shifts every unit and body style at once, so unlike an
 * insert it is not held back on an alternate style; a derived symbol has no
 * body of its own to shift.
 */
const canMoveAnchor = computed(() => !readOnly.value && !!definition.value && !isDerived.value)
watch(canMoveAnchor, (allowed) => {
  if (!allowed && activeTool.value === 'anchor') activeTool.value = 'select'
})

// ---- Design health: the pill and the findings drawer ------------------------
// (design-health-workstream.md). The open symbol, checked as `symbol.check` checks
// it: pins against the project's connection grid, else the editor's grid.
const workspace = inject(EDITOR_WORKSPACE, null)
const healthDrawer = useHealthDrawer('symbol')
const healthOpen = healthDrawer.open
const healthHeight = healthDrawer.height
const checkGrid = computed(
  () =>
    workspace?.projectConnectionGrid.value ??
    mmToNm(spacingToMm(gridSettings.value.spacing, gridSettings.value.unit))
)
const checkResults = computed(() => {
  const lib = library.value
  return definition.value && lib
    ? symbolChecks(definition.value, checkGrid.value, (name) => lib.symbols.get(name))
    : []
})
const healthFindings = computed<HealthFinding[]>(() => documentFindings(checkResults.value))
const healthPinned = panelPinned('symbol', 'health')
const healthReport = computed<HealthReport>(() => ({
  status: 'checked',
  findings: healthFindings.value
}))

/**
 * Select what a finding names and bring it into view. A part in another unit
 * or body style switches the view to it first; the switch clears the
 * selection, so the selection lands after it.
 */
const locateFinding = async (finding: HealthFinding, zoom = false): Promise<void> => {
  pickedFinding.value = finding.key
  const index = healthFindings.value.findIndex((entry) => entry.key === finding.key)
  const result = checkResults.value[index]
  const place = result && findingPlace(result)
  if (!place) return
  const { addresses, lead, at } = place
  if (lead && lead.unit > 0) selectedUnit.value = lead.unit
  if (lead && lead.style > 0) selectedBodyStyle.value = lead.style
  await nextTick()
  selectedItems.value = addresses.filter(
    (address) =>
      address.kind === 'field' ||
      ((address.unit === 0 || address.unit === selectedUnit.value) &&
        (address.style === 0 || address.style === selectedBodyStyle.value))
  )
  if (at) viewportRef.value?.showFinding(at, zoom)
}

/**
 * Where a finding is: what it names, the part that leads it (whose unit and
 * body style show it) and its point — its own position, else its field's.
 */
const findingPlace = (
  result: CheckResult
): {
  addresses: SymbolPartAddress[]
  lead: SymbolPartAddress | undefined
  at: { x: number; y: number } | null
} | null => {
  const symbol = definition.value
  if (!symbol) return null
  const addresses = (result.targets ?? []).flatMap((target) => symbolTargetAddress(target) ?? [])
  const lead = addresses.find((address) => address.kind !== 'field')
  const field = addresses.find((address) => address.kind === 'field')
  const fieldAt = field && symbol.properties.find((property) => property.key === field.field)
  const at =
    result.position ??
    (fieldAt ? { x: nmToMm(fieldAt.position.x), y: nmToMm(fieldAt.position.y) } : null)
  return { addresses, lead, at }
}

// Each finding on the unit and body style in view, marked on the canvas; a
// click on one selects its row.
const healthView = designHealthViewState()
/** The finding the drawer or a marker last picked: its marker draws over the rest. */
const pickedFinding = ref<string | null>(null)
const findingMarkers = computed(() =>
  healthView.value.showMarkers
    ? findingMarks(
        checkResults.value,
        healthFindings.value,
        (result) => {
          const place = findingPlace(result)
          const lead = place?.lead
          if (lead && lead.unit > 0 && lead.unit !== selectedUnit.value) return null
          if (lead && lead.style > 0 && lead.style !== selectedBodyStyle.value) return null
          return place?.at ?? null
        },
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

// ---------------------------------------------------------------------------
// Insert tools — arm, then click to place, staying armed for repeats. Items
// land where the cursor is rather than at a fixed origin, so an insert never
// needs a follow-up drag to find it.
// ---------------------------------------------------------------------------
const activeTool = ref<SymbolTool>('select')
/**
 * How the pending item is turned. R / X / Y retarget to this while a tool is
 * armed, so an item can be oriented before it is committed rather than placed
 * and then fixed. It survives repeats — ten pins at the same heading — and
 * resets when the tool is put away.
 */
const toolOrientation = ref<ToolOrientation>({ ...DEFAULT_ORIENTATION })

/**
 * Points the armed tool has collected so far — empty for a pin, one corner for a
 * half-spanned rectangle, a vertex per click for a polyline in progress. The
 * viewport draws the preview from these plus the cursor, so the shape on screen
 * is built from the same chain the commit will use.
 */
const toolDraft = ref<Point2[]>([])

const setTool = (tool: SymbolTool): void => {
  const allowed = tool === 'anchor' ? canMoveAnchor.value : canAddGeometry.value
  activeTool.value = allowed ? tool : 'select'
  toolOrientation.value = { ...DEFAULT_ORIENTATION }
  // Settings belong to the tool in hand: a stroke width chosen for a rectangle
  // should not silently become a pin's when you switch.
  toolDefaults.value = {}
}

// Every route out of a tool goes through the tool itself — Esc, right-click, the
// toolbar chips, a symbol that turns out to be read-only — so abandoning the
// points here covers all of them, and a half-drawn shape can never outlive the
// tool that was drawing it.
watch(activeTool, () => {
  toolDraft.value = []
})

const isPlacing = computed(() => activeTool.value !== 'select')

/**
 * Whether R / X / Y turn the pending item. Only a drop tool has an orientation
 * to turn: a spanned or chained shape is oriented by where its clicks land.
 */
const orientsPending = computed(() => isPlacing.value && toolGesture(activeTool.value) === 'drop')

const rotatePending = (quarterTurns: number): void => {
  toolOrientation.value = {
    ...toolOrientation.value,
    quarterTurns: toolOrientation.value.quarterTurns + quarterTurns
  }
}

const mirrorPending = (axis: MirrorAxis): void => {
  // Mirroring twice on the same axis is the identity, so the key toggles.
  toolOrientation.value = {
    ...toolOrientation.value,
    mirror: toolOrientation.value.mirror === axis ? null : axis
  }
}

/**
 * Place what the collected points describe. Geometry comes from `toolItems` —
 * the same call that drew the preview — so what lands is exactly what was on
 * screen.
 */
const commitTool = (points: Point2[]): void => {
  const tool = activeTool.value
  if (tool === 'select') return
  toolDraft.value = []
  if (tool === 'anchor') {
    if (points[0]) handleMoveAnchor(points[0])
    return
  }
  const { graphics, pins } = toolItems(tool, points, toolOrientation.value, toolDefaults.value)
  if (pins[0]) handleAddPin(pins[0])
  if (graphics[0]) handleAddGraphicItem(graphics[0])
  // Tools stay armed after placing, matching the schematic editor.
}

/**
 * Apply what a click or drag did to the collected points. The rules themselves
 * are `symbolTools`' — a click means something different per gesture, and that
 * belongs where it can be tested rather than in a mouse handler.
 */
const applyToolResult = (result: ToolClickResult): void => {
  toolDraft.value = result.draft
  if (result.commit) commitTool(result.commit)
}

const onToolClick = (point: Point2): void => {
  applyToolResult(toolClick(activeTool.value, toolDraft.value, point))
}

/**
 * Right-click while a tool is armed, one level per press: it ends a polyline in
 * progress (the wire tool's idiom), abandons a half-spanned shape, and only then
 * puts the tool away.
 */
const onToolCancel = (): void => {
  const finished = toolFinish(activeTool.value, toolDraft.value)
  if (finished.commit) {
    applyToolResult(finished)
    return
  }
  if (toolDraft.value.length > 0) {
    toolDraft.value = []
    return
  }
  activeTool.value = 'select'
}

const nextPinNumber = (): string => {
  const def = definition.value
  if (!def) return '1'
  const numbers = def.variants
    .flatMap((v) => v.pins)
    .map((p) => parseInt(p.number, 10))
    .filter((n) => !isNaN(n))
  return String((numbers.length ? Math.max(...numbers) : 0) + 1)
}

/**
 * What an insert leaves behind: nothing selected.
 *
 * Every insert comes from an armed tool, and an armed tool keeps the properties
 * panel on the **pending** item — so selecting what just landed puts a halo on
 * one object while the panel describes a different one, and a string typed into
 * that panel retargets the next item rather than the haloed one. The tool stays
 * armed for repeats, so the honest state during a placement run is that the
 * ghost is the only thing claiming to be current.
 *
 * The cost, accepted: `Insert` (Repeat Last Item) works off the selection, so it
 * no longer chains directly off a just-placed item. With the tool still armed,
 * the next click is the repeat.
 */
const clearForNextPlacement = (): void => {
  selectedItems.value = []
}

const handleAddPin = (pin: SymbolPin): void => {
  const def = definition.value
  if (!def || !canAddGeometry.value) return
  runCommand(
    t('symbolEditor.commands.addPin'),
    () => {
      const node = addPin(
        def._node,
        {
          name: pin.name,
          // A number typed into the pending panel is deliberate, so it wins; the
          // blank default falls back to continuing the symbol's own sequence.
          number: pin.number || nextPinNumber(),
          x: pin.position.x,
          y: pin.position.y,
          angle: pin.position.angle,
          length: pin.length,
          electricalType: pin.electricalType,
          graphicStyle: pin.graphicStyle
        },
        pinUnit()
      )
      // `addPin` writes the geometry and the two text nodes; their FONTS are a
      // second write, since the template can carry a name/number size the way it
      // carries an electrical type.
      updatePin(node, {
        nameSize: pin.nameEffects.fontSize.height,
        numberSize: pin.numberEffects.fontSize.height
      })
    },
    {
      afterApply: () => {
        clearForNextPlacement()
        // Step the pending pin on, so holding the tool down a row does not place
        // forty pins sharing one number. Names follow by the same rule as Repeat.
        const pending = toolDefaults.value.pin
        if (pending?.number) {
          toolDefaults.value = {
            ...toolDefaults.value,
            pin: {
              ...pending,
              number: incrementPinLabel(pending.number, 1),
              ...(pending.name ? { name: incrementPinLabel(pending.name, 1) } : {})
            }
          }
        }
      }
    }
  )
}

/**
 * Where a new part belongs. On a single-unit symbol KiCad keeps body graphics
 * in the common unit 0 (`R_0_1`) — matching that keeps our output shaped like
 * theirs. Once a symbol has real gates, a part is drawn into the gate you are
 * editing unless the tool's "common to all units" says otherwise.
 */
const commonPlacement = (): boolean => !!toolDefaults.value.commonToAllUnits
const graphicUnit = (): number => (commonPlacement() || !isMultiUnit.value ? 0 : selectedUnit.value)
const pinUnit = (): number => (commonPlacement() ? 0 : selectedUnit.value)

// ---------------------------------------------------------------------------
// Pin table — the panel the right bar shows when nothing is selected.
//
// The split it keeps is `pinTable.ts`'s: the grid edits what a pin IS (number,
// name, electrical type) and never where it sits, so every row here maps onto
// `updatePin` and nothing here touches geometry except the two operations that
// must create it (add, import).
// ---------------------------------------------------------------------------

/**
 * The pin table is PERMANENT — its own collapsible panel, present whatever is
 * selected.
 *
 * An earlier pass showed it only when nothing was selected, so that a row click
 * could not swap the panel out from under the cursor. Making it permanent is
 * the better answer to the same problem and unlocks the feature that version had
 * to work around: a row click can now simply BE the selection, because the table
 * is not what a selection replaces. What the selection replaces is the property
 * groups in the panel above.
 */
const showPinTable = computed(() => !!definition.value)

const pinTableRows = computed(() => buildPinTableRows(definition.value, selectedBodyStyle.value))

/** The selection, as the table renders it — pins only; a selected rectangle
 *  simply highlights no row. */
const pinTableSelectedKeys = computed(() =>
  selectedItems.value.filter((item) => item.kind === 'pin').map(addressCsvKey)
)

/** The row's AST node, or null when its address no longer resolves. */
const pinNodeForRow = (row: PinTableRow): SExprList | null => {
  const def = definition.value
  return def ? symbolPartNode(def._node, row.address) : null
}

const onPinTableEdit = (
  key: 'number' | 'name' | 'electricalType',
  row: PinTableRow,
  value: string
): void => {
  const node = pinNodeForRow(row)
  if (!node || readOnly.value) return
  // Same command label as the panel's own pin rows: editing a pin is one act,
  // and the undo history should not care which surface asked for it.
  runCommand(t('symbolEditor.commands.editPin'), () =>
    updatePin(node, { [key]: value } as PinPatch)
  )
}

/**
 * Add one pin from the table's `+`.
 *
 * The insert tool places at the CURSOR; there is no cursor here, so the pin
 * goes where an import would put it — the next free slot in the left column.
 * Landing it at the origin instead would drop it inside the body on most
 * symbols, which reads as nothing having happened.
 */
const onPinTableAdd = (): void => {
  const def = definition.value
  if (!def || !canAddGeometry.value) return
  const [placed] = layoutImportedPins(
    [{ number: nextPinNumber(), name: '', electricalType: 'passive', unit: selectedUnit.value }],
    existingPinPoints()
  )
  const unit = pinUnit()
  runCommand(
    t('symbolEditor.commands.addPin'),
    () => {
      addPin(
        def._node,
        {
          name: placed.name,
          number: placed.number,
          x: placed.x,
          y: placed.y,
          angle: placed.angle,
          length: PIN_LENGTH,
          electricalType: placed.electricalType,
          graphicStyle: 'line'
        },
        unit
      )
    },
    {
      // Select the pin that was just added: the table scrolls its row into view
      // (a new pin on a 48-row list is otherwise added off screen, which reads
      // as nothing having happened) and the panel above switches to describing
      // it, which is where its position and length are set.
      //
      // The address is derived from the RE-PARSED definition rather than from
      // the node `addPin` returned — `runCommand` reparses, so that node belongs
      // to an AST nothing points at any more. `addPin` appends, so the new pin
      // is the last of its unit.
      afterApply: () => {
        const variant = definition.value?.variants.find((v) => v.unit === unit && v.style === 1)
        if (!variant?.pins.length) return
        selectedItems.value = [{ kind: 'pin', unit, style: 1, index: variant.pins.length - 1 }]
      }
    }
  )
}

/** Every drawn pin's connection point — what an import must not land on. */
const existingPinPoints = (): { x: Nm; y: Nm }[] => {
  const def = definition.value
  if (!def) return []
  return def.variants
    .filter((v) => v.style === 0 || v.style === selectedBodyStyle.value)
    .flatMap((v) => v.pins.map((p) => ({ x: p.position.x, y: p.position.y })))
}

/**
 * Remove the rows picked in the table, in ONE command.
 *
 * Nodes are resolved before anything is removed, for the reason the canvas
 * delete has the same dance: an address is a position within its unit, so
 * removing one pin renumbers its later siblings.
 */
const onPinTableRemove = (rows: PinTableRow[]): void => {
  const def = definition.value
  if (!def || !canAddGeometry.value) return
  const nodes = rows.map(pinNodeForRow).filter((n): n is SExprList => !!n)
  if (!nodes.length) return
  runCommand(t('symbolEditor.commands.removePins', nodes.length), () => {
    for (const node of nodes) deletePin(def._node, node)
  })
}

/**
 * A row click is the selection — the canvas highlights the pin and the property
 * groups above switch to describing it.
 *
 * **The table lists every gate; the canvas draws one.** Selecting a pin of
 * another unit without switching to it hands back a selection nothing on screen
 * shows. So the
 * clicked row's unit wins, and any row of the resulting selection that does not
 * live in that unit (or in unit 0, which is drawn alongside every gate) is
 * dropped rather than selected invisibly. A shift-range across gates therefore
 * selects the part of itself you can see, which is the honest outcome.
 */
const onPinTableSelect = (rows: PinTableRow[], anchor: PinTableRow): void => {
  const unit = anchor.address.unit === 0 ? selectedUnit.value : anchor.address.unit
  const visible = rows
    .filter((row) => row.address.unit === 0 || row.address.unit === unit)
    .map((row) => ({ ...row.address }))
  if (unit === selectedUnit.value) {
    selectedItems.value = visible
    return
  }
  selectedUnit.value = unit
  // Switching units CLEARS the selection (a held address belongs to the gate
  // that is leaving), so the new one has to land after that watcher has run —
  // set it synchronously and it is wiped a tick later.
  void nextTick(() => (selectedItems.value = visible))
}

const onPinTableExport = async (): Promise<void> => {
  const rows = pinTableRows.value
  if (!rows.length) return
  const suggested = `${selectedName.value ?? 'symbol'}-pins.csv`
  const target = await window.api.saveFileDialog(suggested)
  if (!target) return
  const result = await window.api.createFile(target, formatPinCsv(rows, isMultiUnit.value))
  if (!result.success) console.error('Pin table export failed:', result.error)
}

/**
 * Import a pin table.
 *
 * The replace-vs-append choice is made AFTER the file is read and reported on,
 * not as a radio set before it — KiCad asks first, which means answering before
 * you know whether the file even parsed. What lands is one command either way:
 * a 48-pin paste that undid in 48 steps would be worse than no undo at all.
 */
const onPinTableImport = async (): Promise<void> => {
  const def = definition.value
  if (!def || !canAddGeometry.value) return
  const path = await window.api.pickFile({
    title: t('symbolEditor.pinTable.importTitle'),
    buttonLabel: t('symbolEditor.pinTable.importButton'),
    filters: [{ name: t('symbolEditor.pinTable.csvFilter'), extensions: ['csv', 'tsv', 'txt'] }]
  })
  if (!path) return
  const file = await window.api.readFile(path)
  if (!file.success || file.content === undefined) {
    await window.api.chooseDialog({
      message: t('symbolEditor.pinTable.importFailed'),
      detail: file.error,
      buttons: ['OK']
    })
    return
  }

  const { pins, errors } = parsePinCsv(file.content)
  if (!pins.length) {
    await window.api.chooseDialog({
      message: t('symbolEditor.pinTable.importEmpty'),
      // The line-numbered skips are the whole diagnosis; capped so a wholly
      // unsuitable file cannot produce a message box taller than the screen.
      detail: errors.slice(0, 12).join('\n') || undefined,
      buttons: ['OK']
    })
    return
  }

  const choice = await window.api.chooseDialog({
    message: t('symbolEditor.pinTable.importPrompt', pins.length),
    detail: errors.length
      ? [t('symbolEditor.pinTable.importSkipped', errors.length), ...errors.slice(0, 12)].join('\n')
      : undefined,
    buttons: [
      t('symbolEditor.pinTable.importAppend'),
      t('symbolEditor.pinTable.importReplace'),
      t('symbolEditor.pinTable.importCancel')
    ],
    cancelId: 2
  })
  if (choice === 2) return
  const replace = choice === 1

  // Replacing means the incoming column starts from an empty sheet, so the
  // layout is asked about the pins that will SURVIVE, not the ones on screen.
  const survivors = replace ? [] : existingPinPoints()
  const placed = layoutImportedPins(pins, survivors)
  const doomed = replace
    ? pinTableRows.value.map(pinNodeForRow).filter((n): n is SExprList => !!n)
    : []

  runCommand(t('symbolEditor.commands.importPins'), () => {
    for (const node of doomed) deletePin(def._node, node)
    for (const pin of placed) {
      addPin(
        def._node,
        {
          name: pin.name,
          number: pin.number,
          x: pin.x,
          y: pin.y,
          angle: pin.angle,
          length: PIN_LENGTH,
          electricalType: pin.electricalType,
          graphicStyle: 'line'
        },
        // A CSV that names units is honoured; one that does not lands every pin
        // in the gate being edited, which is where the insert tool puts them.
        isMultiUnit.value ? pin.unit : pinUnit()
      )
    }
    selectedItems.value = []
  })
}

// ---------------------------------------------------------------------------
// The right bar's width — the shared, persisted one every editor now reads.
// ---------------------------------------------------------------------------
/** Shared with the other editors' right bars and persisted globally — a panel
 *  size is a preference, not per-window or per-tab state (`panelLayout.ts`). */
const propertiesWidth = panelWidth()
let propertiesResizeStart = propertiesWidth.value
const resizeProperties = (grow: number): void => {
  setPanelWidth(propertiesResizeStart + grow)
}
/** One config write per drag, not one per pixel. */
const commitProperties = (): void => setPanelWidth(propertiesWidth.value, true)

const addGraphic = (label: string, add: (node: SExprList, unit: number) => SExprList): void => {
  const def = definition.value
  if (!def || !canAddGeometry.value) return
  runCommand(
    label,
    () => {
      add(def._node, graphicUnit())
    },
    { afterApply: clearForNextPlacement }
  )
}
/**
 * Insert a built primitive. Taking the typed item rather than a point means the
 * thing written is the same object the preview drew, orientation included.
 */
const handleAddGraphicItem = (graphic: SymbolGraphic): void => {
  if (graphic.type === 'rectangle') {
    addGraphic(t('symbolEditor.commands.addRectangle'), (node, unit) =>
      addRectangle(node, graphic.start, graphic.end, unit)
    )
  } else if (graphic.type === 'line') {
    // A polygon is stored as the closed polyline it draws; only its label differs.
    const label =
      activeTool.value === 'polygon'
        ? t('symbolEditor.commands.addPolygon')
        : t('symbolEditor.commands.addLine')
    addGraphic(label, (node, unit) => addPolyline(node, graphic.points, unit))
  } else if (graphic.type === 'circle') {
    addGraphic(t('symbolEditor.commands.addCircle'), (node, unit) =>
      addCircle(node, graphic.center, graphic.radius, unit)
    )
  } else if (graphic.type === 'bezier') {
    addGraphic(t('symbolEditor.commands.addBezier'), (node, unit) =>
      addBezier(node, graphic.points, unit)
    )
  } else if (graphic.type === 'arc') {
    addGraphic(t('symbolEditor.commands.addArc'), (node, unit) =>
      addArc(node, graphic.start, graphic.mid, graphic.end, unit)
    )
  } else if (graphic.type === 'text') {
    // The string is the tool's template, edited in the pending panel BEFORE the
    // click — so a text lands already saying what it should, and the panel is
    // still describing the next one afterwards.
    addGraphic(t('symbolEditor.commands.addText'), (node, unit) =>
      addText(node, graphic.text, graphic.position, unit)
    )
  } else if (graphic.type === 'textBox') {
    addGraphic(t('symbolEditor.commands.addTextBox'), (node, unit) =>
      addTextBox(node, graphic.text, graphic.position, graphic.size, unit, graphic.margins)
    )
  }
}

/**
 * KiCad's Move Symbol Anchor: the clicked point becomes the origin, and every
 * part and field shifts the other way in one step. The camera moves with the
 * drawing, so the symbol stays put on screen and the origin mark is what
 * jumps — to where you clicked. The tool stays armed, as KiCad's does.
 */
const handleMoveAnchor = (point: Point2): void => {
  const def = definition.value
  if (!def || !canMoveAnchor.value) return
  let moved = false
  runCommand(
    t('symbolEditor.commands.moveAnchor'),
    () => void (moved = moveSymbolAnchor(def._node, point)),
    { afterApply: () => moved && viewportRef.value?.shiftView(-nmToMm(point.x), -nmToMm(point.y)) }
  )
}

const handleDeleteSelected = (): void => {
  const def = definition.value
  if (!def || selectedItems.value.length === 0) return
  const count = selectedItems.value.length
  // Resolved to nodes BEFORE anything is removed, so each delete targets the
  // node itself. Names are resolved by position within a unit, so removing one
  // part shifts the names of its later siblings — the descending-index dance
  // the flat version needed for the same reason.
  const pins = selectedNodesOfKind('pin')
  const graphics = selectedNodesOfKind('graphic')
  runCommand(t('symbolEditor.commands.deleteItems', count), () => {
    for (const node of pins) deletePin(def._node, node)
    for (const node of graphics) deleteGraphic(def._node, node)
    selectedItems.value = []
  })
}

const uniqueSymbolName = (): string => {
  const names = new Set(library.value?.names ?? [])
  const base = 'NewSymbol'
  if (!names.has(base)) return base
  let n = 1
  while (names.has(`${base}${n}`)) n++
  return `${base}${n}`
}

const handleAddSymbol = (): void => {
  if (!library.value) return
  const root = library.value.root
  const name = uniqueSymbolName()
  runCommand(t('symbolEditor.commands.newSymbol'), () => void addSymbol(root, name), {
    afterApply: () => {
      selectedName.value = name
      selectedItems.value = []
    }
  })
}

const handleDeleteSymbol = (): void => {
  const def = definition.value
  if (!def || !library.value) return
  const root = library.value.root
  runCommand(t('symbolEditor.commands.deleteSymbol'), () => removeSymbol(root, def._node), {
    afterApply: () => {
      selectedName.value = library.value?.names[0] ?? null
      selectedItems.value = []
    }
  })
}

// Rename the currently-selected symbol. The new name comes from the File
// Explorer's inline-rename primitive (op.newName) — the left bar owns the input,
// like any other file type; the editor just applies it through the command layer.
const renameSelectedTo = (newName: string): void => {
  const def = definition.value
  const trimmed = newName.trim()
  const previous = selectedName.value
  if (!def || !trimmed || trimmed === previous) return
  if (library.value?.names.includes(trimmed)) return // collision — tree already guards
  runCommand(t('symbolEditor.commands.renameSymbol'), () => renameSymbol(def._node, trimmed), {
    afterApply: () => {
      // The viewport keys its camera on the name; a rename shows the same
      // symbol, so the framing goes with it rather than re-fitting.
      if (previous) viewportRef.value?.retargetView(previous, trimmed)
      selectedName.value = trimmed
    }
  })
}

/**
 * Rotate / mirror the selection about the center of its own bounding box, as
 * KiCad's symbol editor does. Both walk the same node lists the canvas indexes
 * against, so a transform hits exactly what is selected and visible.
 */
const transformSelection = (
  label: string,
  applyPin: (node: SExprList, pivot: Point2) => void,
  applyGraphic: (node: SExprList, pivot: Point2) => void
): void => {
  const def = definition.value
  if (!def || readOnly.value || selectedItems.value.length === 0) return
  const items = [...selectedItems.value]
  const bounds = symbolItemsBounds(
    items.map((a) => symbolPartPin(def, a)).filter((p): p is SymbolPin => !!p),
    items.map((a) => symbolPartGraphic(def, a)).filter((g): g is SymbolGraphic => !!g)
  )
  if (!bounds) return
  // KiCad's: one item turns about its own position — a pin about its
  // connection point, a text about its anchor — several about their middle on
  // the half grid. Rounded, the fixed point moves at most 0.5 nm.
  const only = items.length === 1 ? items[0] : null
  const graphic = only ? symbolPartGraphic(def, only) : null
  const own =
    (only ? symbolPartPin(def, only)?.position : null) ??
    (graphic?.type === 'text' || graphic?.type === 'textBox' ? graphic.position : null)
  const center = boundsCenter(bounds)
  const half = mmToNm(spacingToMm(gridSettings.value.spacing, gridSettings.value.unit)) / 2
  const pivot = own
    ? { x: nm(own.x), y: nm(own.y) }
    : only
      ? { x: nm(center.x), y: nm(center.y) }
      : { x: nm(Math.round(center.x / half) * half), y: nm(Math.round(center.y / half) * half) }
  const pins = selectedNodesOfKind('pin')
  const graphics = selectedNodesOfKind('graphic')
  runCommand(label, () => {
    for (const node of pins) applyPin(node, pivot)
    for (const node of graphics) applyGraphic(node, pivot)
  })
}

/** `quarterTurns` 1 is counterclockwise (the symbol's y points up), -1 clockwise. */
const handleRotate = (quarterTurns: number): void =>
  transformSelection(
    t('symbolEditor.commands.rotate'),
    (node, pivot) => rotatePinNode(node, pivot, quarterTurns),
    (node, pivot) => rotateGraphicNode(node, pivot, quarterTurns)
  )

const handleMirror = (axis: MirrorAxis): void =>
  transformSelection(
    axis === 'horizontal'
      ? t('symbolEditor.commands.mirrorHorizontal')
      : t('symbolEditor.commands.mirrorVertical'),
    (node, pivot) => mirrorPinNode(node, pivot, axis),
    (node, pivot) => mirrorGraphicNode(node, pivot, axis)
  )

/**
 * Rotate or mirror, from a key or a toolbar chip. While placing, the transforms
 * turn the pending item instead of the selection — orient it, then commit. With
 * a spanned or chained tool armed there is no pending orientation to turn, so
 * they do nothing rather than quietly transforming a selection the tool is
 * standing in front of.
 */
const runTransform = (op: TransformOp): void => {
  if (readOnly.value) return
  if (orientsPending.value) {
    if (op === 'rotateCCW' || op === 'rotateCW') rotatePending(op === 'rotateCCW' ? 1 : -1)
    else mirrorPending(op === 'mirrorHorizontal' ? 'horizontal' : 'vertical')
  } else if (!isPlacing.value) {
    if (op === 'rotateCCW' || op === 'rotateCW') handleRotate(op === 'rotateCCW' ? 1 : -1)
    else handleMirror(op === 'mirrorHorizontal' ? 'horizontal' : 'vertical')
  }
}

const canTransform = computed(
  () =>
    !readOnly.value &&
    !!definition.value &&
    (orientsPending.value || (!isPlacing.value && selectedItems.value.length > 0))
)

// The app's one clipboard (lib/documentClipboard.ts), module-scoped so a copy
// outlives this editor instance. A symbol pastes only into a symbol.
const pasteable = usePasteable('symbol')

/** One grid step, the offset a duplicate or paste lands at. */
const gridStepMm = (): number => spacingToMm(gridSettings.value.spacing, gridSettings.value.unit)

/**
 * Clone `sources` into the symbol, offset one grid step down-right so the copies
 * are visibly separate, renumbering pins from the current maximum. `unitFor`
 * decides the destination unit: a duplicate stays in its source's unit, a paste
 * (whose source may be another symbol entirely) goes to the conventional home.
 */
const insertCopies = (
  label: string,
  sources: SExprList[],
  unitFor: (node: SExprList) => SExprList | null
): void => {
  const def = definition.value
  if (!def || readOnly.value || sources.length === 0) return
  const step = mmToNm(gridStepMm())
  runCommand(label, () => {
    let nextPin = maxPinNumber(def._node) + 1
    const clones: SExprList[] = []
    for (const source of sources) {
      const unit = unitFor(source) ?? defaultUnitNodeFor(def._node, source)
      const clone = appendNodeCopy(unit, source)
      if (getToken(clone) === 'pin') {
        translatePinNode(clone, step, nm(-step))
        updatePin(clone, { number: String(nextPin++) })
      } else {
        translateGraphicNode(clone, step, nm(-step))
      }
      clones.push(clone)
    }
    // Named from the nodes themselves, so the selection lands on the copies
    // wherever each unit put them.
    selectedItems.value = clones
      .map((clone) => addressOfPartNode(def._node, clone))
      .filter((a): a is SymbolPartAddress => !!a)
  })
}

/** The AST nodes behind the current selection, in selection order. */
const selectedNodes = (): SExprList[] => {
  const def = definition.value
  if (!def) return []
  return selectedItems.value
    .map((address) => symbolPartNode(def._node, address))
    .filter((n): n is SExprList => !!n)
}

/** Those of them that are pins, or graphics. */
const selectedNodesOfKind = (kind: SymbolPartAddress['kind']): SExprList[] => {
  const def = definition.value
  if (!def) return []
  return selectedItems.value
    .filter((address) => address.kind === kind)
    .map((address) => symbolPartNode(def._node, address))
    .filter((n): n is SExprList => !!n)
}

const handleDuplicate = (): void => {
  const def = definition.value
  if (!def) return
  const sources = selectedNodes()
  insertCopies(t('symbolEditor.commands.duplicateItems', sources.length), sources, (node) =>
    owningUnitNode(def._node, node)
  )
}

const handleCopy = (): void => {
  const nodes = selectedNodes()
  if (nodes.length)
    setClipboard(
      'symbol',
      nodes.map((node) => serializeSExpr(node))
    )
}

/**
 * Copy, then delete what was copied, as one undo step labelled Cut — KiCad's
 * Ctrl+X. Fields are not parts to remove (KiCad's cut leaves them too), so a
 * selection of only fields copies nothing and removes nothing.
 */
const handleCut = (): void => {
  const def = definition.value
  if (!def || readOnly.value) return
  const pins = selectedNodesOfKind('pin')
  const graphics = selectedNodesOfKind('graphic')
  const parts = [...pins, ...graphics]
  if (!parts.length) return
  setClipboard(
    'symbol',
    parts.map((node) => serializeSExpr(node))
  )
  runCommand(t('symbolEditor.commands.cutItems', parts.length), () => {
    for (const node of pins) deletePin(def._node, node)
    for (const node of graphics) deleteGraphic(def._node, node)
    selectedItems.value = []
  })
}

const handlePaste = (): void => {
  const def = definition.value
  if (!def || !canPaste.value) return
  const sources: SExprList[] = []
  for (const text of pasteable.value?.items ?? []) {
    try {
      const parsed = parseSExpr(text)
      if (parsed.type === 'list') sources.push(parsed)
    } catch (err) {
      console.error('Failed to parse clipboard symbol item:', err)
    }
  }
  insertCopies(t('symbolEditor.commands.pasteItems', sources.length), sources, () => null)
}

// ---------------------------------------------------------------------------
// Repeat Last Item — stamp another copy one step on, numbers ticking up. Press
// it once per pin and the row grows under you; a connector's pin column stops
// being an insert per pin. KiCad's `Insert` idiom, and deliberately
// parameterless — no count, no direction picker, no dialog.
// ---------------------------------------------------------------------------
const canRepeat = computed(() => canAddGeometry.value && selectedItems.value.length > 0)
/**
 * A paste lands in the conventional home (`defaultUnitNodeFor` — style 1), not
 * in whatever is on screen, so it needs the same guard an insert does: on a
 * derived symbol it would scaffold a unit node, and on an alternate body style
 * it would land out of sight. A duplicate is exempt — `owningUnitNode` keeps it
 * with its source, which is by definition rendered.
 */
const canPaste = computed(() => canAddGeometry.value && !!pasteable.value)

/**
 * The heading the row runs relative to: the first selected pin's. One direction
 * for the whole selection rather than one per item, so repeating a PAIR of pins
 * moves them as a rigid group instead of scattering them along their own
 * headings. Null when nothing selected is a pin — a graphic has no heading.
 */
const repeatHeading = (def: KicadLibSymbol): number | null => {
  for (const address of selectedItems.value) {
    const pin = symbolPartPin(def, address)
    if (pin) return pin.position.angle
  }
  return null
}

const handleRepeat = (): void => {
  const def = definition.value
  if (!def || !canRepeat.value) return
  const sources = selectedNodes()
  if (sources.length === 0) return
  const offset = repeatOffset(repeatHeading(def))
  runCommand(t('symbolEditor.commands.repeatItems', sources.length), () => {
    const clones = sources.map((source) =>
      appendRepeatCopy(def._node, source, offset, REPEAT_NUMBER_STEP)
    )
    // The COPY becomes the selection, which is what makes the key chain: press
    // again and the next one continues the row rather than repeating the
    // original on top of the copy already there.
    selectedItems.value = clones
      .map((clone) => addressOfPartNode(def._node, clone))
      .filter((a): a is SymbolPartAddress => !!a)
  })
}

/**
 * Vertex drag: resizing a graphic by its corner rather than moving it whole.
 * The grabbed vertex's original position is read at drag start, so the commit
 * is origin + delta and repeated drags never compound rounding.
 */
const vertexDrag = ref<{
  address: SymbolPartAddress
  vertexIndex: number
  origin: Point2
} | null>(null)

const handleVertexDragStart = (info: { address: SymbolPartAddress; vertexIndex: number }): void => {
  const def = definition.value
  const graphic = def ? symbolPartGraphic(def, info.address) : null
  if (!graphic) return
  const origin = graphicVertexPoints(graphic)[info.vertexIndex]
  if (origin) vertexDrag.value = { ...info, origin: { x: nm(origin.x), y: nm(origin.y) } }
}

const commitVertexDrag = (delta: { x: number; y: number }): boolean => {
  const drag = vertexDrag.value
  const def = definition.value
  vertexDrag.value = null
  if (!drag || !def) return false
  if (delta.x === 0 && delta.y === 0) return true
  runCommand(t('symbolEditor.commands.resizeGraphic'), () => {
    const node = symbolPartNode(def._node, drag.address)
    if (node) {
      setGraphicVertex(node, drag.vertexIndex, {
        x: nm(drag.origin.x + delta.x),
        y: nm(drag.origin.y + delta.y)
      })
    }
  })
  return true
}

// Drag: the viewport moves the real geometry as the cursor goes; this writes
// the same cumulative delta — already domain nm at the viewport's emit — into
// the document on release.
const dragDelta = ref<{ x: number; y: number }>({ x: 0, y: 0 })
const handleDragMove = (delta: { x: number; y: number }): void => {
  dragDelta.value = delta
}
const handleDragEnd = (): void => {
  finishDrag()
  move.end()
}

/** The selection and the item under the cursor, for KiCad's hover selection (`lib/hoverSelection.ts`). */
const symbolHover: HoverSelection<SymbolPartAddress> = {
  selected: selectedItems,
  hover: () => viewportRef.value?.itemAtCursor() ?? null,
  same: sameAddress
}

/** KiCad's Move (M), held: Escape puts what it moved back, nothing committed. */
const move = heldMove(symbolHover, {
  begin: () => viewportRef.value?.startHeldMove() ?? false,
  history: props.session,
  abandon: () => {
    viewportRef.value?.cancelHeldMove()
    dragDelta.value = { x: 0, y: 0 }
  }
})

const finishDrag = (): void => {
  const { x, y } = dragDelta.value
  dragDelta.value = { x: 0, y: 0 }
  // A vertex drag resizes one graphic; it must not also translate the selection.
  if (commitVertexDrag({ x, y })) return
  if (x === 0 && y === 0) return
  const count = selectedItems.value.length
  const pins = selectedNodesOfKind('pin')
  const graphics = selectedNodesOfKind('graphic')
  const fields = selectedNodesOfKind('field')
  runCommand(t('commandLabels.move', count), () => {
    for (const node of pins) translatePinNode(node, nm(x), nm(y))
    for (const node of graphics) translateGraphicNode(node, nm(x), nm(y))
    for (const node of fields) translateSymbolPropertyNode(node, nm(x), nm(y))
  })
}

// ---------------------------------------------------------------------------
// Toolbar search + hotkeys
// ---------------------------------------------------------------------------
const insertSearch = ref<InstanceType<typeof ToolbarSearch> | null>(null)
// Every control on the toolbars (lib/toolSearch.ts), plus what only the search
// offers: a text box (KiCad gives it a Place-menu entry and no toolbar button
// either — 18 instances across the 222 standard libraries do not earn a chip)
// and Repeat, which acts on the selection.
/** The rotate and mirror chips' hotkeys (`TRANSFORM_TOOLS`). */
const transformHotkeys: Record<TransformOp, HotkeyActionId> = {
  rotateCCW: 'symbol.rotate',
  rotateCW: 'symbol.rotateClockwise',
  mirrorHorizontal: 'symbol.mirrorHorizontal',
  mirrorVertical: 'symbol.mirrorVertical'
}

// ---- Left view rail: whether hidden pins and fields draw ------------------
// The switches persist app-wide (lib/symbolView.ts).
const symbolView = symbolViewState()
const toggleHiddenPins = (): void =>
  setSymbolView({ showHiddenPins: !symbolView.value.showHiddenPins })
const toggleHiddenFields = (): void =>
  setSymbolView({ showHiddenFields: !symbolView.value.showHiddenFields })

const searchOps = computed<ToolbarSearchOp[]>(() => {
  const tool = (
    id: SymbolTool,
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
    disabled: !canAddGeometry.value
  })
  const canEditUnits = !readOnly.value && !!definition.value
  return [
    {
      id: 'repeat',
      icon: 'tool-repeat',
      label: t('symbolEditor.tools.repeat'),
      group: 'select',
      hotkey: hotkeyLabel('symbol.repeat'),
      disabled: !canRepeat.value
    },
    ...TRANSFORM_TOOLS.map(({ op, icon, label }): ToolbarSearchOp => ({
      id: op,
      icon,
      label: t(label),
      group: 'select',
      hotkey: hotkeyLabel(transformHotkeys[op]),
      disabled: !canTransform.value
    })),
    tool('pin', 'tool-pin', t('symbolEditor.tools.pin'), 'place', 'symbol.tool.pin'),
    tool('rectangle', 'tool-rect', t('symbolEditor.tools.rectangle'), 'draw'),
    tool('line', 'tool-line', t('symbolEditor.tools.line'), 'draw', 'symbol.tool.line'),
    tool('polygon', 'tool-polygon', t('symbolEditor.tools.polygon'), 'draw', 'symbol.tool.polygon'),
    tool('circle', 'tool-circle', t('symbolEditor.tools.circle'), 'draw', 'symbol.tool.circle'),
    tool('arc', 'tool-arc', t('symbolEditor.tools.arc'), 'draw', 'symbol.tool.arc'),
    tool('bezier', 'tool-bezier', t('symbolEditor.tools.bezier'), 'draw', 'symbol.tool.bezier'),
    tool('text', 'tool-text', t('symbolEditor.tools.text'), 'draw', 'symbol.tool.text'),
    tool('textBox', 'tool-text-box', t('symbolEditor.tools.textBox'), 'draw'),
    // Search only, like KiCad's, which keeps it off the drawing toolbar: it is
    // set once per symbol, if at all, and unbound (DESIGN.md §Keymap).
    {
      ...tool('anchor', 'tool-anchor', t('symbolEditor.tools.anchor'), 'utilities'),
      disabled: !canMoveAnchor.value
    },
    // The only route to a second gate on a symbol that has none — the unit
    // selector cannot offer it, because it is hidden until one exists.
    {
      id: 'addUnit',
      icon: 'tool-unit',
      label: t('symbolEditor.units.add'),
      group: 'units',
      disabled: !canEditUnits
    },
    {
      id: 'removeUnit',
      icon: 'tool-remove',
      label: t('symbolEditor.units.remove'),
      group: 'units',
      disabled: !canEditUnits || !isMultiUnit.value
    },
    {
      id: 'exportPng',
      icon: 'tool-export',
      label: t('symbolEditor.export.png'),
      group: 'utilities',
      disabled: !definition.value
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
    {
      id: 'showHiddenPins',
      icon: 'view-hidden-pins',
      label: t('symbolEditor.viewRail.showHiddenPins'),
      group: 'display',
      state: symbolView.value.showHiddenPins ? 'on' : undefined
    },
    {
      id: 'showHiddenFields',
      icon: 'view-hidden-fields',
      label: t('symbolEditor.viewRail.showHiddenFields'),
      group: 'display',
      state: symbolView.value.showHiddenFields ? 'on' : undefined
    }
  ]
})
const onSearchPick = (id: string): void => {
  if (id === 'repeat') handleRepeat()
  else if (isTransformOp(id)) runTransform(id)
  else if (id === 'addUnit') handleAddUnit()
  else if (id === 'removeUnit') handleRemoveUnit()
  else if (id === 'exportPng') void handleExportPng()
  else if (id === FIT_VIEW_OP_ID) viewportRef.value?.zoomToFit()
  else if (isViewCommand(id)) viewportRef.value?.runViewCommand(id)
  else if (id === 'find') find.openFind()
  else if (id === 'showHiddenPins') toggleHiddenPins()
  else if (id === 'showHiddenFields') toggleHiddenFields()
  else setTool(id as SymbolTool)
}

const viewportRef = ref<InstanceType<typeof SymbolViewport2D> | null>(null)

/** Longest edge of an exported picture, px: sharp on a slide or a datasheet page. */
const EXPORT_PIXELS = 2048

/**
 * KiCad's File ▸ Export ▸ PNG: the unit and body style on screen, framed to
 * its own extent, drawn as a placed symbol (no hidden pins or fields, no
 * selection or grid) by the same scene that draws a sheet.
 */
const handleExportPng = async (): Promise<void> => {
  const name = selectedName.value
  if (!preview.value || !name) return
  const target = await window.api.saveFileDialog(symbolExportPath(props.filePath, name, 'png'))
  const schematic = preview.value
  if (!target || !schematic) return
  const capture = captureSchematicDocument(schematic, null, EXPORT_PIXELS)
  const data = capture ? dataUrlBase64(capture.dataUrl) : null
  const result = data
    ? await window.api.writeFileBase64(target, data)
    : { success: false, error: undefined }
  if (!result.success) {
    await window.api.chooseDialog({
      message: t('symbolEditor.export.failed'),
      detail: result.error,
      buttons: ['OK']
    })
  }
}

// ---------------------------------------------------------------------------
// Which pane owns the keyboard. Tracked for the Escape handover only — the
// canvas no longer mutes its halo for it; see lib/activePane.ts.
// ---------------------------------------------------------------------------
const { setActivePane } = useActivePane()

/**
 * Escape in a property field hands the keyboard back to the canvas. The field
 * has already reverted its own text and blurred, so this is only the handover —
 * and focusing the canvas is what makes the NEXT Escape reach the editor's own
 * ladder (draft points, armed tool, selection) rather than the panel.
 */
const returnFocusToCanvas = (): void => {
  setActivePane('canvas')
  viewportRef.value?.focusCanvas()
}
// Find (Ctrl/Cmd+F, F3): pin names and numbers, fields and texts
// (lib/symbol/symbolFind.ts). A hit in another unit or body style switches the
// view first; the switch clears the selection, so the selection lands after it.
const find = useCanvasFind({
  candidates: () =>
    definition.value
      ? symbolFindCandidates(definition.value, {
          pins: symbolView.value.showHiddenPins,
          fields: symbolView.value.showHiddenFields
        })
      : [],
  yDown: false,
  show: async (hit) => {
    const address = hit.target
    if (address.unit > 0) selectedUnit.value = address.unit
    if (address.style > 0) selectedBodyStyle.value = address.style
    await nextTick()
    selectedItems.value = [{ ...address }]
    if (hit.position)
      viewportRef.value?.focusAt({
        x: nmToMm(hit.position.x as Nm),
        y: nmToMm(hit.position.y as Nm)
      })
  },
  onClose: returnFocusToCanvas
})
const findState = find.state

/** The draw tools a key arms and nothing more; the line starts at the cursor, below. */
const SYMBOL_TOOL_KEYS: ReadonlyArray<readonly [HotkeyActionId, SymbolTool]> = [
  ['symbol.tool.polygon', 'polygon'],
  ['symbol.tool.circle', 'circle'],
  ['symbol.tool.arc', 'arc'],
  ['symbol.tool.bezier', 'bezier'],
  ['symbol.tool.text', 'text']
]
const symbolToolFor = (e: KeyboardEvent): SymbolTool | undefined =>
  SYMBOL_TOOL_KEYS.find(([action]) => matchesHotkey(e, action))?.[1]
const handleKeydown = (e: KeyboardEvent): void => {
  if (matchesHotkey(e, 'editor.undo')) {
    e.preventDefault()
    undo()
    return
  }
  if (matchesHotkey(e, 'editor.selectAll')) {
    if (selectAllInField(e)) return
    e.preventDefault()
    // Placing a pin or drawing a shape is a gesture in hand, not a selection.
    if (activeTool.value === 'select' && toolDraft.value.length === 0) {
      selectedItems.value = viewportRef.value?.selectAll() ?? []
    }
    return
  }
  if (matchesHotkey(e, 'editor.redo')) {
    e.preventDefault()
    redo()
    return
  }
  if (find.keydown(e)) return
  if (matchesHotkey(e, 'editor.cancel')) {
    // Esc unwinds one step at a time: the points of a half-drawn shape, then the
    // armed tool, then the selection. Esc ABANDONS a polyline where right-click
    // finishes it — same split as the wire tool, and the reason to keep both.
    if (move.active()) move.cancel()
    else if (toolDraft.value.length > 0) toolDraft.value = []
    else if (activeTool.value !== 'select') activeTool.value = 'select'
    else selectedItems.value = []
    return
  }
  if (isTypingTarget()) return
  const viewCommand = viewCommandFor(e)
  const grid = gridKeyUpdate(e, 'symbol', gridSettings.value, SYMBOL_UNIT_SPACINGS)
  if (matchesHotkey(e, 'editor.fitView')) {
    e.preventDefault()
    viewportRef.value?.zoomToFit()
  } else if (viewCommand) {
    e.preventDefault()
    viewportRef.value?.runViewCommand(viewCommand)
  } else if (grid) {
    e.preventDefault()
    handleUpdateGrid(grid)
  } else if (matchesHotkey(e, 'editor.delete') && !readOnly.value) {
    handleDeleteSelected()
  } else if (matchesHotkey(e, 'symbol.tool.pin')) {
    setTool('pin')
  } else if (symbolToolFor(e)) {
    e.preventDefault()
    setTool(symbolToolFor(e) as SymbolTool)
  } else if (matchesHotkey(e, 'symbol.tool.line')) {
    e.preventDefault()
    setTool('line')
    // A hotkey acts at the cursor: the line's first point is where the
    // pointer is, when it is over the canvas; off it, the tool arms and waits.
    const cursor = viewportRef.value?.getCursor()
    if (cursor && activeTool.value === 'line') onToolClick(cursor)
  } else if (matchesHotkey(e, 'symbol.move') && !readOnly.value) {
    if (activeTool.value === 'select') move.start()
  } else if (matchesHotkey(e, 'symbol.rotate')) {
    runTransform('rotateCCW')
  } else if (matchesHotkey(e, 'symbol.rotateClockwise')) {
    runTransform('rotateCW')
  } else if (matchesHotkey(e, 'symbol.mirrorHorizontal')) {
    runTransform('mirrorHorizontal')
  } else if (matchesHotkey(e, 'symbol.mirrorVertical')) {
    runTransform('mirrorVertical')
  } else if (matchesHotkey(e, 'symbol.duplicate') && !readOnly.value) {
    e.preventDefault()
    handleDuplicate()
  } else if (matchesHotkey(e, 'symbol.copy')) {
    handleCopy()
  } else if (matchesHotkey(e, 'symbol.cut') && !readOnly.value) {
    e.preventDefault()
    handleCut()
  } else if (matchesHotkey(e, 'symbol.paste') && !readOnly.value) {
    e.preventDefault()
    handlePaste()
  } else if (matchesHotkey(e, 'symbol.repeat') && !readOnly.value) {
    e.preventDefault()
    handleRepeat()
  } else if (matchesHotkey(e, 'editor.focusSearch') && canAddGeometry.value) {
    e.preventDefault()
    insertSearch.value?.focus()
  }
}
// ---------------------------------------------------------------------------
// Edit commands — published for the title bar's Edit menu and mirrored into the
// canvas right-click menu, since a shortcut alone advertises itself to no one.
// ---------------------------------------------------------------------------
const hasSelection = computed(() => selectedItems.value.length > 0)
const canEdit = computed(() => !readOnly.value && !!definition.value)
/** A pin or graphic is selected — what Cut can take (fields stay behind). */
const hasSelectedParts = computed(() =>
  selectedItems.value.some((item) => item.kind === 'pin' || item.kind === 'graphic')
)

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
      hotkey: 'symbol.cut' as HotkeyActionId,
      label: t('symbolEditor.edit.cut'),
      enabled: canEdit.value && hasSelectedParts.value
    },
    {
      hotkey: 'symbol.copy' as HotkeyActionId,
      label: t('symbolEditor.edit.copy'),
      enabled: hasSelection.value
    },
    {
      hotkey: 'symbol.paste' as HotkeyActionId,
      label: t('symbolEditor.edit.paste'),
      enabled: canPaste.value
    },
    {
      hotkey: 'symbol.duplicate' as HotkeyActionId,
      label: t('symbolEditor.edit.duplicate'),
      enabled: canEdit.value && hasSelection.value
    },
    {
      hotkey: 'symbol.repeat' as HotkeyActionId,
      label: t('symbolEditor.edit.repeat'),
      enabled: canRepeat.value
    },
    {
      hotkey: 'editor.delete' as HotkeyActionId,
      label: t('symbolEditor.edit.delete'),
      enabled: canEdit.value && hasSelection.value
    }
  ],
  [
    {
      hotkey: 'editor.selectAll' as HotkeyActionId,
      label: t('common.selectAllLabel'),
      enabled: !!definition.value
    }
  ],
  [
    {
      hotkey: 'symbol.rotate' as HotkeyActionId,
      label: t('symbolEditor.edit.rotate'),
      enabled: canEdit.value && hasSelection.value
    },
    {
      hotkey: 'symbol.rotateClockwise' as HotkeyActionId,
      label: t('symbolEditor.edit.rotateClockwise'),
      enabled: canEdit.value && hasSelection.value
    },
    {
      hotkey: 'symbol.mirrorHorizontal' as HotkeyActionId,
      label: t('symbolEditor.edit.mirrorHorizontal'),
      enabled: canEdit.value && hasSelection.value
    },
    {
      hotkey: 'symbol.mirrorVertical' as HotkeyActionId,
      label: t('symbolEditor.edit.mirrorVertical'),
      enabled: canEdit.value && hasSelection.value
    }
  ],
  [
    {
      hotkey: 'editor.find' as HotkeyActionId,
      label: t('shared.insertSearch.ops.find'),
      enabled: !!definition.value
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
  hit: SymbolPartAddress | null
}): void => {
  const { hit } = payload
  if (hit) {
    const already = selectedItems.value.some((item) => sameAddress(item, hit))
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
    ...symbolHover,
    keys: [
      'symbol.rotate',
      'symbol.rotateClockwise',
      'symbol.mirrorHorizontal',
      'symbol.mirrorVertical',
      'editor.delete',
      'symbol.copy',
      'symbol.cut',
      'symbol.duplicate'
    ],
    ready: () => activeTool.value === 'select' && !move.active()
  })
)

onMounted(() => {
  resetActivePane()
})
onUnmounted(() => {
  stopSession()
})
</script>

<template>
  <div class="symbol-editor">
    <div v-if="parseError" class="symbol-error">
      <strong>{{ t('symbolEditor.errors.parseTitle') }}</strong>
      <span>{{ parseError }}</span>
    </div>

    <template v-else>
      <div class="viewport-host-area" @mousedown="setActivePane('canvas')">
        <div v-toolbar-fit class="canvas-floating-toolbar">
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
            @click="runTransform(entry.op)"
          >
            <Icon :name="entry.icon" />
          </button>
          <div class="toolbar-divider"></div>
          <button
            data-tool-op="pin"
            class="floating-btn tool-btn"
            :class="{ armed: activeTool === 'pin' }"
            :disabled="!canAddGeometry"
            :title="toolTitle(t('symbolEditor.tools.pin'), 'symbol.tool.pin')"
            @click="setTool('pin')"
          >
            <Icon name="tool-pin" />
          </button>
          <button
            data-tool-op="rectangle"
            class="floating-btn tool-btn"
            :class="{ armed: activeTool === 'rectangle' }"
            :disabled="!canAddGeometry"
            :title="t('symbolEditor.tools.rectangle')"
            @click="setTool('rectangle')"
          >
            <Icon name="tool-rect" />
          </button>
          <button
            data-tool-op="line"
            class="floating-btn tool-btn"
            :class="{ armed: activeTool === 'line' }"
            :disabled="!canAddGeometry"
            :title="toolTitle(t('symbolEditor.tools.line'), 'symbol.tool.line')"
            @click="setTool('line')"
          >
            <Icon name="tool-line" />
          </button>
          <button
            data-tool-op="polygon"
            class="floating-btn tool-btn"
            :class="{ armed: activeTool === 'polygon' }"
            :disabled="!canAddGeometry"
            :title="toolTitle(t('symbolEditor.tools.polygon'), 'symbol.tool.polygon')"
            @click="setTool('polygon')"
          >
            <Icon name="tool-polygon" />
          </button>
          <button
            data-tool-op="circle"
            class="floating-btn tool-btn"
            :class="{ armed: activeTool === 'circle' }"
            :disabled="!canAddGeometry"
            :title="toolTitle(t('symbolEditor.tools.circle'), 'symbol.tool.circle')"
            @click="setTool('circle')"
          >
            <Icon name="tool-circle" />
          </button>
          <button
            data-tool-op="arc"
            class="floating-btn tool-btn"
            :class="{ armed: activeTool === 'arc' }"
            :disabled="!canAddGeometry"
            :title="toolTitle(t('symbolEditor.tools.arc'), 'symbol.tool.arc')"
            @click="setTool('arc')"
          >
            <Icon name="tool-arc" />
          </button>
          <button
            data-tool-op="bezier"
            class="floating-btn tool-btn"
            :class="{ armed: activeTool === 'bezier' }"
            :disabled="!canAddGeometry"
            :title="toolTitle(t('symbolEditor.tools.bezier'), 'symbol.tool.bezier')"
            @click="setTool('bezier')"
          >
            <Icon name="tool-bezier" />
          </button>
          <button
            data-tool-op="text"
            class="floating-btn tool-btn"
            :class="{ armed: activeTool === 'text' }"
            :disabled="!canAddGeometry"
            :title="toolTitle(t('symbolEditor.tools.text'), 'symbol.tool.text')"
            @click="setTool('text')"
          >
            <Icon name="tool-text" />
          </button>
          <ToolbarSearch ref="insertSearch" :ops="searchOps" @pick="onSearchPick" />
        </div>
        <div class="canvas-top-right">
          <!-- Mode selectors: which slice of the document am I looking at —
               which gate, which body style. Both sit opposite the top-left
               insert toolbar, left of find, and each earns its space only on a
               symbol that actually has more than one. -->
          <div v-if="isMultiUnit || hasBodyStyles" class="canvas-floating-toolbar unit-toolbar">
            <template v-if="isMultiUnit">
              <label class="unit-label" for="symbol-unit-select">
                {{ t('symbolEditor.units.label') }}
              </label>
              <select
                id="symbol-unit-select"
                v-model.number="selectedUnit"
                class="unit-select"
                :title="t('symbolEditor.units.title')"
              >
                <option v-for="option in unitOptions" :key="option.unit" :value="option.unit">
                  {{ option.label }}
                </option>
              </select>
              <div class="toolbar-divider"></div>
              <button
                data-tool-op="addUnit"
                class="floating-btn tool-btn"
                :disabled="readOnly || !definition"
                :title="t('symbolEditor.units.addTitle')"
                @click="handleAddUnit"
              >
                <Icon name="tool-add" />
              </button>
              <button
                data-tool-op="removeUnit"
                class="floating-btn tool-btn"
                :disabled="readOnly || !definition"
                :title="t('symbolEditor.units.removeTitle')"
                @click="handleRemoveUnit"
              >
                <Icon name="tool-remove" />
              </button>
            </template>
            <div v-if="isMultiUnit && hasBodyStyles" class="toolbar-divider"></div>
            <template v-if="hasBodyStyles">
              <label class="unit-label" for="symbol-body-style-select">
                {{ t('symbolEditor.bodyStyles.label') }}
              </label>
              <select
                id="symbol-body-style-select"
                v-model.number="selectedBodyStyle"
                class="unit-select"
                :title="t('symbolEditor.bodyStyles.title')"
              >
                <option
                  v-for="option in bodyStyleOptions"
                  :key="option.style"
                  :value="option.style"
                >
                  {{ option.label }}
                </option>
              </select>
              <!-- The drawing tools go inert on an alternate, so say why rather
                     than leaving a toolbar that silently does nothing. -->
              <span
                v-if="isAlternateBodyStyle"
                class="mode-note"
                :title="t('symbolEditor.bodyStyles.viewOnlyTitle')"
              >
                {{ t('symbolEditor.bodyStyles.viewOnly') }}
              </span>
            </template>
          </div>
          <CanvasFindWidget
            v-if="find.open.value"
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
        </div>

        <!-- Left view rail: zoom to fit, then the display switches, as on the
             other editors. -->
        <div class="canvas-floating-toolbar toolbar-left-rail">
          <FitViewButton @fit="viewportRef?.zoomToFit()" />
          <div class="toolbar-divider"></div>
          <button
            data-tool-op="showHiddenPins"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: symbolView.showHiddenPins }"
            :title="t('symbolEditor.viewRail.showHiddenPins')"
            @click="toggleHiddenPins"
          >
            <Icon name="view-hidden-pins" />
          </button>
          <button
            data-tool-op="showHiddenFields"
            class="floating-btn tool-btn toggle-btn"
            :class="{ active: symbolView.showHiddenFields }"
            :title="t('symbolEditor.viewRail.showHiddenFields')"
            @click="toggleHiddenFields"
          >
            <Icon name="view-hidden-fields" />
          </button>
        </div>

        <SymbolViewport2D
          ref="viewportRef"
          :finding-markers="findingMarkers"
          class="canvas-fill"
          :schematic="preview"
          :symbol="definition"
          :selected-items="selectedItems"
          :read-only="readOnly"
          :grid-settings="gridSettings"
          :file-path="filePath"
          :rendered-unit="selectedUnit"
          :rendered-body-style="selectedBodyStyle"
          :active-tool="activeTool"
          :tool-orientation="toolOrientation"
          :tool-draft="toolDraft"
          :tool-defaults="toolDefaults"
          @finding-marker="revealFinding"
          @update-grid="handleUpdateGrid"
          @update:selected-items="(items) => (selectedItems = items)"
          @drag-move="handleDragMove"
          @drag-end="handleDragEnd"
          @context-menu="onCanvasContextMenu"
          @tool-click="onToolClick"
          @tool-cancel="onToolCancel"
          @cursor-move="(p) => (cursorPoint = p)"
          @vertex-drag-start="handleVertexDragStart"
        >
          <template #status>
            <HealthPill
              editor="symbol"
              :report="healthReport"
              :open="healthOpen"
              @toggle="healthDrawer.toggle"
            />
          </template>
        </SymbolViewport2D>
        <FindingsDrawer
          v-if="healthOpen && !healthPinned"
          :findings="healthFindings"
          :height="healthHeight"
          :reveal="findingReveal"
          @locate="locateFinding"
          @pin="setPanelPinned('symbol', 'health', true)"
          @close="healthDrawer.close"
          @resize="healthDrawer.resize"
        >
          <template #settings><HealthViewSettings /></template>
        </FindingsDrawer>
        <ContextMenu
          v-if="canvasMenu"
          :items="canvasMenuItems"
          :x="canvasMenu.x"
          :y="canvasMenu.y"
          @select="onCanvasMenuSelect"
          @close="canvasMenu = null"
        />
      </div>

      <Teleport v-if="showPanels" :to="panelRail" :disabled="panelsInline">
        <aside
          class="symbol-properties"
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
              :groups="symbolGroups"
              :read-only="readOnly"
              :distance-unit="gridSettings.unit"
              @edit="onEdit"
              @action="onPanelAction"
              @escape="returnFocusToCanvas"
            />
          </CollapsiblePanel>
          <!--
          Permanent, stacked BELOW the properties: the panel above describes what
          is selected, this one lists what there is to select, and neither
          replaces the other. Its fixed, drag-resizable height is
          CollapsiblePanel's stacked mode — the properties panel is the `flex`
          absorber, so collapsing this one gives the rows back.
        -->
          <CollapsiblePanel
            v-if="showPinTable"
            id="symbol.pins"
            :title="t('symbolEditor.pinTable.title')"
            :initial-height="300"
            :min-height="120"
          >
            <PinTablePanel
              :rows="pinTableRows"
              :selected-keys="pinTableSelectedKeys"
              :read-only="!canAddGeometry"
              :multi-unit="isMultiUnit"
              @edit="onPinTableEdit"
              @add="onPinTableAdd"
              @remove="onPinTableRemove"
              @select="onPinTableSelect"
              @import="onPinTableImport"
              @export="onPinTableExport"
            />
          </CollapsiblePanel>
          <RailPinnedPanels
            editor="symbol"
            :grid-settings="gridSettings"
            :findings="healthFindings"
            :reveal="findingReveal"
            @update-grid="handleUpdateGrid"
            @locate="locateFinding"
          >
            <template #settings><HealthViewSettings /></template>
          </RailPinnedPanels>
        </aside>
      </Teleport>

      <SymbolFieldsDialog
        v-if="fieldsDialogOpen && definition"
        :properties="definition.properties"
        :read-only="readOnly"
        @add="onFieldAdd"
        @remove="onFieldRemove"
        @rename="onFieldRename"
        @move="onFieldMove"
        @set-value="onFieldSetValue"
        @set-visible="onFieldSetVisible"
        @close="fieldsDialogOpen = false"
      />
    </template>
  </div>
</template>

<style scoped>
.symbol-editor {
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

/* Takes what the drawer leaves: a flex basis, not the viewport's own 100%. */
.canvas-fill {
  flex: 1 1 0;
  min-height: 0;
}

/* Toolbar chrome comes from assets/canvasToolbar.css */

/* The armed tool reads as pressed, so the toolbar says which mode you are in. */
.floating-btn.tool-btn.armed {
  border-color: var(--vscode-accent);
  color: var(--vscode-text-light);
}

.unit-toolbar {
  gap: 6px;
}

.unit-label {
  padding-left: 4px;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.mode-note {
  padding: 1px 6px;
  border: 1px solid var(--vscode-border);
  border-radius: 3px;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.unit-select {
  padding: 3px 4px;
  border: 1px solid var(--vscode-border);
  border-radius: 3px;
  background: var(--vscode-bg-input, #151c19);
  color: var(--vscode-text);
  font: inherit;
  font-size: var(--text-body-sm);
}

.symbol-properties {
  /* Width is set inline from `propertiesWidth`; `position: relative` is what the
     ResizeHandle positions against. */
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--vscode-border);
  /* Match footprint/PCB side panels so the shared CollapsiblePanel header reads
     identically across editors. */
  background: var(--vscode-bg-sidebar, #1a221f);
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
}

.symbol-error {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--vscode-text-muted);
}

.symbol-error strong {
  color: var(--vscode-error);
}
</style>
