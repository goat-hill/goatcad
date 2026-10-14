/**
 * The agent surface over one schematic sheet (`docs/agent-api.md`):
 * what every `schematic.*`, `items.*`, `check.*` and `render.schematic` request does
 * to a sheet, and what it answers.
 *
 * It is written against a `SheetAgentContext` rather than the editor component,
 * so the same handlers serve a sheet with an editor mounted and one without —
 * the context is what differs. Three rules hold it together:
 *
 * 1. **Every mutation goes through the context's `runCommand`**, exactly as a
 *    click does. That is what makes an agent's edit undoable and mark the tab
 *    dirty — the consent mechanism (RULES.md §8).
 * 2. **It reuses the placement path**, not a parallel one. `ensureStandardLibrary`
 *    → `libSymbolChain` → `ensureLibSymbolsInAST` → `addSchematicSymbolToAST` is
 *    the sequence the editor's own placement runs; a second implementation
 *    would drift on exactly the parts that are easy to get wrong (the `extends`
 *    chain, the per-hierarchical-path instances).
 * 3. **It refuses rather than guesses.** An unknown lib_id, a taken reference or
 *    a read-only sheet come back as typed failures, because the caller is a
 *    model that will otherwise narrate a success it did not have.
 */
import type { SchematicSvg } from '../engine/schematicSvg'
import type {
  McpAddSheetRequest,
  McpAnnotateRequest,
  McpBatchRequest,
  McpBindRequest,
  McpChanged,
  McpCheckAnswer,
  McpCheckRequest,
  McpCheckRow,
  McpCleanupRequest,
  McpConnectRequest,
  McpCreateItemRequest,
  McpDeleteItemsRequest,
  McpDescribeRequest,
  McpDesignRequest,
  McpGetBomRequest,
  McpGetItemsRequest,
  McpPlaceRequest,
  McpPlaced,
  McpPlacedTerminal,
  McpQueryItemsRequest,
  McpRenderRequest,
  McpSetPaperRequest,
  McpUpdateBomRequest,
  McpUpdateItemRequest,
  McpUpdateSymbolsSchematicRequest,
  McpUndoSheetRequest,
  McpWireRequest,
  McpWriteAnswer
} from '../../../../preload/mcpTypes'
import {
  addSchematicBusToAST,
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
  getSymbolProperty,
  libSymbolChain,
  libSymbolUnitCount,
  libSymbolUnitPins,
  moveSchematicPointItemInAST,
  moveSchematicSheetInAST,
  moveSchematicWireInAST,
  parseKicadSchematic,
  resizeSchematicSheetInAST,
  referenceForSheetPath,
  removeSchematicNodesFromAST,
  removeSheetPinFromAST,
  serializeKicadSchematic,
  setSchematicLabelPlacement,
  setSchematicLabelShape,
  setSchematicLabelText,
  setSchematicFieldsAutoplaced,
  setSchematicPaper,
  setSchematicPropertyHidden,
  setSchematicPropertyPlacement,
  setSchematicSymbolFlag,
  setSchematicSymbolPoseInAST,
  setSchematicSymbolProperty,
  setSchematicTextContent,
  setSchematicTextPlacement,
  setSheetPinFields,
  setSheetPinPlacement,
  setSymbolInstanceReference,
  SHEET_PIN_PITCH,
  sheetPinSlot,
  sheetSideOf,
  type KicadLabel,
  type SheetPinShape,
  type KicadSchematic,
  type KicadSchematicSymbol,
  type Point
} from '../kicad/schematic'
import { nextReference, placementGeometry } from './schematicTools'
import { mmToNm, nm, pointsEqualNm, type Nm } from '../kicad/coordinates'
import { applyMovePlan, planMovedPoints, selectionOf, type MovePlan } from './schematicMove'
import { directionOf, type MovedPoint } from './wireReshape'
import { cleanupChanged, routeContacts, type CleanupReport } from './wireCleanup'
import {
  BOM_FIELD_MODEL,
  bomFieldNames,
  buildProjectComponentRecords,
  canonicalBomField,
  compareReferencesNatural,
  compressReferences,
  planBomUpdate,
  projectBom,
  unknownBomFields,
  type ComponentRecord,
  type SheetSource
} from '../componentsTable'
import type { DocumentEdit, SymbolEdit } from './symbolEdits'
import {
  CHANGE_DEFAULTS,
  UPDATE_DEFAULTS,
  updateSymbolsWithWires,
  type SymbolUpdateOptions
} from './symbolUpdate'
import { planSymbolUpdate, simulateSymbolUpdate } from './symbolUpdateAgent'
import { unitItemId, type SubpartSettings } from './symbolUnits'
import { planNextUnit, siblingUnits, unitsInOtherFiles, type NextUnitPlan } from './partUnits'
import type { SchematicHierarchy } from './hierarchy'
import type { SchematicConnectivity, SchematicNet, SheetConnectivityInput } from './connectivity'
import { dirnameOf, samePath, separatorOf } from '../kicad/paths'
import { blankFileContent } from '../project/scaffold'
import { tk, type MessageKey } from '../messageKey'
import { pinCheck, pinCheckClean } from '../footprint/pinCheck'
import {
  planAnnotation,
  type AnnotateRequest,
  type AnnotateSource,
  type AnnotationPlan
} from './annotate'
import {
  attachedToSymbol,
  autoplaceFieldsInAST,
  fieldAngleForSheetAngle,
  getItems,
  junctionsForRoutedWire,
  pinsAfterTransform,
  queryItems,
  resolveItem,
  planSheetResize,
  resolveSheetPinEnd,
  routeWire,
  sheetId,
  sheetItems,
  textId,
  wireId,
  type ItemsInput,
  type ResolvedItem,
  type WireEnd
} from './schematicItems'
import {
  addressablePins,
  asMm,
  boxAt,
  boxOfFrame,
  DESCRIBE_CAP,
  changedIds,
  describeSchematic,
  diffDescribe,
  emptyChangeSet,
  inflateBox,
  labelsAt,
  netChanged,
  offGridPlacement,
  originForPin,
  offGridPoints,
  PIN_GRID,
  paperFrame,
  partPropertyMap,
  pinRefOf,
  resolvePinRef,
  sheetFrameOf,
  symbolValue,
  unionBoxes,
  worldBoxOf,
  type AgentCapture,
  type Box,
  type ChangeRecord,
  type ChangeSet,
  type SheetFrame,
  type WorldBox
} from './schematicAgent'
import type { SExprNode } from '../kicad/sexpr'
import type { ErcContext } from './ercContext'
import {
  allChecks,
  CHECK_RULES,
  checkCodeFilter,
  withAskedCodes,
  checkDelta,
  compactDelta,
  CheckHistory,
  noCheckBaseline,
  groupChecks,
  type CheckResult,
  type LibrarySymbolLookup,
  type PinMap
} from './checks'
import { applySeverities, type SeverityMap } from '../ruleSeverity'
import { ercRuleOf } from './ercCatalog'
import { pageAllocator, pagesOf } from './sheetPages'
import { activeFindings, applyExclusions, type KicadExclusion } from '../kicadExclusions'
import { cappedGuidance } from '../queryPage'
import { changedBetween, historyAnswer, historyGuidance, stepHistory } from '../historyStep'
import {
  connectionPointsAfter,
  graphicChangeRefusal,
  graphicItemId,
  graphicItems,
  isGraphicKind,
  textEffectsPatch,
  writeGraphicChange,
  writeGraphicCreate,
  writeWireStroke,
  type GraphicChange,
  type GraphicItem,
  type GraphicKind
} from './sheetGraphicItems'
import { pngFromImageFile } from './imageImport'
import { setTextEffects } from '../symbol/symbolEdit'
import { findChildren } from '../kicad/sexpr'
import { checkRecord } from '../../../../shared/recordRules'

/** A symbol definition the sheet can place: its lib id and the parsed sheet or
 *  library whose `lib_symbols` carries it (and its `extends` parents). */
export interface PlaceableSymbol {
  libId: string
  sheet: KicadSchematic
}

/** What one batch of commands came to: `changed` is whether the document text
 *  differs from before the batch, whether or not the change was kept. */
export interface BatchOutcome<T> {
  result: T
  changed: boolean
}

/**
 * What the handlers need from whoever holds the sheet. The mounted editor
 * builds one from its reactive state; a sheet with no editor builds one from
 * its tab buffer. Everything is a function because the state behind it moves:
 * the document is re-parsed after every command, and the tree and libraries
 * resolve asynchronously after mount.
 */
export interface SheetAgentContext {
  filePath(): string
  name(): string
  readOnly(): boolean
  /** The parsed document as it is now, or null when there is none. */
  document(): KicadSchematic | null
  /** Replace the parsed document mid-command, after a serialize → re-parse. */
  setDocument(document: KicadSchematic): void
  /** Bumped on every change to the document, so an answer can be dated. */
  revision(): number
  /** This file's instance path within the hierarchy. */
  sheetPath(): string
  /** This file's instance paths — one per reuse of the sheet. */
  instancePaths(): string[]
  /** The project name new `(instances …)` blocks are written under. */
  instanceProjectName(): string
  sheetSources(): SheetSource[]
  hierarchy(): SchematicHierarchy | null
  connectivity(): SchematicConnectivity | null
  connectivityInputs(): SheetConnectivityInput[]
  /** Every reference across every sheet instance. */
  existingReferences(): string[]
  /** Every symbol definition currently placeable, by lib id. */
  availableSymbols(): PlaceableSymbol[]
  /** Parse the standard library that owns `libId`, so it becomes placeable. */
  ensureStandardLibrary(libId: string): Promise<void>
  librarySymbolLookup: LibrarySymbolLookup
  /** The project's connection grid (`kicad/project.ts`), in sheet nanometers. */
  connectionGrid(): Nm
  /** The project's ERC pin conflict map. */
  pinMap(): PinMap
  /** The project's net class names, when it lists them. */
  netclasses(): string[] | null
  /** How a unit is written after its reference: the project's sub-reference settings. */
  subpart(): SubpartSettings
  /** The project's text variables, when it has any. */
  textVariables(): Record<string, string> | null
  /** Which libraries the project reaches, when known. */
  ercLibraries(): ErcContext | undefined
  /** The project's ERC `rule_severities`; empty keeps KiCad's defaults. */
  ercSeverities(): SeverityMap
  /** The project's KiCad ERC exclusions: what they name an agent never sees. */
  ercExclusions(): KicadExclusion[]
  /** The wire grid step, in sheet nanometers. */
  gridStep(): Nm
  /** A command label in the user's language; `count` selects the plural. */
  label(key: MessageKey, count?: number): string
  /**
   * One undoable step: `mutate` edits the document in place. With `cleanup`,
   * the sheet is tidied after the edit — duplicate and overlapping wires
   * joined, junction dots put exactly where three things meet
   * (`wireCleanup.ts`) — inside the same step, and the answer says what that
   * changed; null when the command layer could not run at all. Only a write
   * that touches a wire or a connection point asks for it: a field or text
   * edit does not, so retyping a value on an untidy legacy file leaves its
   * wires as they were.
   */
  runCommand(
    label: string,
    mutate: () => void,
    options?: { cleanup?: boolean }
  ): CleanupReport | null
  /**
   * Everything `body` runs as one history entry, or none: when `keep` comes
   * back false, or nothing changed, the document is restored to how it was
   * before `body` ran and no entry is pushed.
   */
  batch<T>(
    label: string,
    body: () => Promise<{ result: T; keep: boolean }>
  ): Promise<BatchOutcome<T>>
  /** Edit ▸ Undo on the sheet's undo list: the step taken, or null with none to take. */
  undo(): { label: string } | null
  /** Edit ▸ Redo: the step taken, or null with none to take. */
  redo(): { label: string } | null
  /** What undo and redo would take next. */
  undoLabel(): string | null
  redoLabel(): string | null
  /** Apply an annotation plan as one command across every sheet it touches. */
  applyAnnotationPlan(plan: AnnotationPlan): void
  /** Edits to placed symbols on this sheet and any sibling, as one command. */
  applySymbolEdits(label: string, edits: SymbolEdit[]): void
  /**
   * Edits to whole sheet files, this one and any sibling, as one command; with
   * `cleanup`, this sheet is tidied inside the same step.
   */
  applyDocumentEdits(label: string, edits: DocumentEdit[], options?: { cleanup?: boolean }): void
  /** The sheet instances an annotation scope covers. */
  annotationScope(request: AnnotateRequest): AnnotateSource[]
  /** Create a file on disk (a new child sheet). */
  createFile(path: string, content: string): Promise<{ success: boolean; error?: string }>
  /** A file was created on disk — the tree and Project view should pick it up. */
  fileCreated(path: string): void
  /** Re-resolve the sheet tree, after a command changed it. */
  reloadHierarchy(): Promise<void>
  /** Draw the sheet as it is now, framed to `box` (or the whole drawing) at up
   *  to `maxPixels` on the longest edge; null when nothing can draw it. */
  capture(box: WorldBox | null, maxPixels: number): Promise<AgentCapture | null>
  /** The sheet as it is now as SVG, framed the same way; null when nothing can
   *  draw it, absent where no scene is kept for it. */
  captureSvg?(box: WorldBox | null, background: boolean): Promise<SchematicSvg | null>
  /** Resolves once the sheet tree and the library tiers have been read. */
  ready(): Promise<void>
  /** Resolves once a write has reached every reader — the tab store, siblings. */
  settle(): Promise<void>
  /** The pad numbers of a library footprint, or null when none can be read. */
  footprintPads?(libId: string): Promise<string[] | null>
  /**
   * Whether each footprint's 3D model file is on this machine, for the
   * `${MODEL}` column. Keyed by
   * the lib id as a Footprint field spells it. Absent where no library index
   * is reachable, in which case the column is not offered.
   */
  footprintModelStatus?(libIds: string[]): Promise<Record<string, string>>
}

/** The schematic side as a board sync reads it (`boardSync.ts`). */
export interface DesignInputs {
  sheets: SheetSource[]
  inputs: SheetConnectivityInput[]
  connectivity: SchematicConnectivity
}

export interface SheetAgent {
  /** Every sheet of the design with its connectivity, for the board door; null with no document. */
  designInputs(): Promise<DesignInputs | null>
  describe(request?: McpDescribeRequest): unknown
  place(request: McpPlaceRequest): Promise<unknown>
  bind(request: McpBindRequest): Promise<unknown>
  connect(request: McpConnectRequest): unknown
  check(request: McpCheckRequest): unknown
  render(request: McpRenderRequest): Promise<unknown>
  dispatch(request: McpDesignRequest): Promise<unknown>
  batch(request: McpBatchRequest): Promise<unknown>
  /** Each item's box by id, sheet mm, for a viewport framing a write. */
  itemFrames(): Map<string, SheetFrame>
}

/** `record` without `keys`. */
const omitKeys = (record: object, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))

/** Pins a placement answers with in full. Past this a part is an IC, and its
 *  rows come from items_get on request rather than into every batch entry. */
const PLACE_PIN_ROWS = 12

/** An edit's undo label, as the properties panel names it (`SHEET_ITEM_EDIT_LABELS`). */
const EDIT_LABELS: Record<GraphicKind, MessageKey> = {
  rect: tk('schematicEditor.commands.editGraphic'),
  polyline: tk('schematicEditor.commands.editGraphic'),
  circle: tk('schematicEditor.commands.editGraphic'),
  arc: tk('schematicEditor.commands.editGraphic'),
  bezier: tk('schematicEditor.commands.editGraphic'),
  rule_area: tk('schematicEditor.commands.editGraphic'),
  text_box: tk('schematicEditor.commands.editTextBox'),
  image: tk('schematicEditor.commands.editImage'),
  table: tk('schematicEditor.commands.editTable'),
  bus: tk('schematicEditor.commands.editBus'),
  bus_entry: tk('schematicEditor.commands.editBusEntry'),
  directive_label: tk('schematicEditor.commands.editDirectiveLabel')
}

/** A new item's undo label, as the drawing tool names it (`DRAW_LABELS`). */
const CREATE_LABELS: Record<Exclude<GraphicKind, 'bus'>, MessageKey> = {
  rect: tk('commandLabels.addRectangle'),
  polyline: tk('commandLabels.addLine'),
  circle: tk('commandLabels.addCircle'),
  arc: tk('commandLabels.addArc'),
  bezier: tk('commandLabels.addBezier'),
  rule_area: tk('commandLabels.addRuleArea'),
  text_box: tk('commandLabels.addTextBox'),
  image: tk('commandLabels.addImage'),
  table: tk('commandLabels.addTable'),
  bus_entry: tk('commandLabels.addBusEntry'),
  directive_label: tk('commandLabels.addDirectiveLabel')
}

export const createSheetAgent = (ctx: SheetAgentContext): SheetAgent => {
  /** How every answer names the sheet it is about. */
  const sheetRef = (): { path: string; name: string } => ({
    path: ctx.filePath(),
    name: ctx.name()
  })

  /** Find a placed symbol by its reference on this sheet. */
  const symbolByReference = (reference: string): KicadSchematicSymbol | null => {
    const sheetPath = ctx.sheetPath()
    for (const symbol of ctx.document()?.symbols ?? []) {
      if (referenceForSheetPath(symbol, sheetPath) === reference) return symbol
    }
    return null
  }

  /**
   * A part write refused because units of the part sit in other sheet files,
   * which one sheet's step cannot reach; null when every unit is on this one.
   */
  const unitsElsewhere = (reference: string): { error: string; detail: string } | null => {
    const sheets = unitsInOtherFiles(ctx.sheetSources(), ctx.filePath(), reference)
    return sheets.length
      ? {
          error: 'units-elsewhere',
          detail: `${reference} has units on ${sheets.join(', ')} as well, and a field is the part's. Write it with bom_update on ${reference}, which writes every unit.`
        }
      : null
  }

  /** Write Value and the part fields onto a symbol. Shared so a place and a bind
   *  cannot disagree about what a part binding writes. */
  const applyPartFields = (
    symbol: KicadSchematicSymbol,
    value: string | undefined,
    properties: Record<string, string> | undefined
  ): void => {
    if (value !== undefined) setSchematicSymbolProperty(symbol, 'Value', value)
    for (const [key, fieldValue] of Object.entries(properties ?? {})) {
      setSchematicSymbolProperty(symbol, key, fieldValue)
    }
  }

  /**
   * What a Footprint write should warn about: a pad count that differs from the
   * pin count, and pin numbers the pads do not match. Warnings, never
   * refusals: a pad
   * a symbol omits on purpose is a mismatch that is meant.
   */
  const footprintWarningsFor = async (
    chain: ReturnType<typeof libSymbolChain>,
    symbolLibId: string,
    footprintId: string
  ): Promise<Array<Record<string, unknown>>> => {
    const pads = ctx.footprintPads ? await ctx.footprintPads(footprintId) : null
    if (!pads) return []
    const pins = new Set<string>()
    for (let unit = 1; unit <= libSymbolUnitCount(chain); unit++) {
      for (const pin of libSymbolUnitPins(chain, unit)) pins.add(pin.number)
    }
    const padNumbers = [...new Set(pads.filter(Boolean))]
    const out: Array<Record<string, unknown>> = []
    if (padNumbers.length !== pins.size) {
      out.push({
        code: 'pad-count',
        message: `${footprintId} has ${padNumbers.length} numbered pads and ${symbolLibId} has ${pins.size} pins.`
      })
    }
    const check = pinCheck(padNumbers, [...pins])
    if (!pinCheckClean(check)) {
      out.push({
        code: 'pin-mismatch',
        message:
          'Pad numbers and pin numbers differ; unless the symbol omits a pad on purpose, a pin wires to the wrong copper.',
        ...check
      })
    }
    return out
  }

  /**
   * Recent projections, so `since` can be answered by diffing.
   *
   * Small and bounded: an agent asks about the revision it just read, not one
   * from an hour ago, and a miss is answered honestly with the whole sheet rather
   * than with a short list that would read as "nothing much changed".
   */
  const DESCRIBE_MEMORY = 8
  const describeHistory = new Map<number, Record<string, unknown>>()
  /** Batches in progress. A revision names committed text, and a batch's middle is not it. */
  let batching = 0

  const agentDescribe = (request?: McpDescribeRequest): unknown => {
    const active = ctx.document()
    if (!active) return { error: 'no-schematic' }
    const full = describeSchematic({
      schematic: active,
      connectivity: ctx.connectivity(),
      sheetPath: ctx.sheetPath(),
      subpart: ctx.subpart(),
      filePath: ctx.filePath(),
      name: ctx.name(),
      readOnly: ctx.readOnly(),
      revision: ctx.revision(),
      sheets: ctx.sheetSources().map((source) => {
        const instance = ctx
          .hierarchy()
          ?.instances.find((entry) => entry.sheetPath === source.sheetPath)
        return {
          path: source.filePath,
          name: instance?.sheetName || ctx.name(),
          sheetPath: source.sheetPath,
          namePath: instance?.namePath ?? '/',
          depth: instance?.depth ?? 0,
          symbolCount: source.schematic.symbols.filter((symbol) =>
            referenceForSheetPath(symbol, source.sheetPath)
          ).length
        }
      })
    })

    if (batching === 0) {
      describeHistory.set(ctx.revision(), full)
      if (describeHistory.size > DESCRIBE_MEMORY) {
        const oldest = Math.min(...describeHistory.keys())
        describeHistory.delete(oldest)
      }
    }

    if (request?.since === undefined) return full
    const previous = describeHistory.get(request.since)
    if (!previous) {
      return {
        ...full,
        since: request.since,
        sinceUnavailable: `Revision ${request.since} has expired; this is the whole sheet. Pass this answer's revision next time.`
      }
    }
    return diffDescribe(previous, full)
  }

  const agentItemsGet = (request: McpGetItemsRequest): unknown => {
    const active = ctx.document()
    if (!active) return { error: 'no-schematic' }
    const result = getItems(
      { schematic: active, connectivity: ctx.connectivity(), sheetPath: ctx.sheetPath() },
      request.ids
    )
    if (!result.ok) {
      return { error: 'item-not-found', detail: result.missing, candidates: result.candidates }
    }
    return {
      sheet: sheetRef(),
      revision: ctx.revision(),
      items: result.items,
      guidance:
        'Sheet mm, y down; a box is x, y, width, height, and two boxes that intersect overlap on the sheet. A pin\'s "free" side is where a label or a neighboring part goes; a label\'s "extends" is the direction its text runs.'
    }
  }

  const agentItemsQuery = (request: McpQueryItemsRequest): unknown => {
    const active = ctx.document()
    if (!active) return { error: 'no-schematic' }
    const revision = ctx.revision()
    if (request.revision !== undefined && request.revision !== revision)
      return {
        error: 'revision-moved',
        detail: `The sheet is at revision ${revision}, not ${request.revision}.`
      }
    const result = queryItems(
      { schematic: active, connectivity: ctx.connectivity(), sheetPath: ctx.sheetPath() },
      {
        kind: request.itemKind,
        box: request.box,
        near: request.near,
        radius: request.radius,
        net: request.net,
        limit: request.limit,
        offset: request.offset
      }
    )
    if (!result.ok)
      return { error: result.error, detail: result.detail, candidates: result.candidates }
    return {
      sheet: sheetRef(),
      revision,
      items: result.rows,
      count: result.total,
      ...(result.offset ? { offset: result.offset } : {}),
      ...(result.truncated ? { truncated: true } : {}),
      guidance: [
        ...(result.truncated ? [cappedGuidance(result, result.narrowings, revision)] : []),
        'Rows are in reading order with their id and box in sheet mm; pass ids to items_get for detail.'
      ].join(' ')
    }
  }

  const agentPlace = async (request: McpPlaceRequest): Promise<unknown> => {
    if (ctx.readOnly()) return { error: 'read-only' }
    if (!ctx.document()) return { error: 'no-schematic' }

    let available = ctx.availableSymbols().find((entry) => entry.libId === request.libId)
    if (!available) {
      // Same first-pick parse the chooser does; a standard-tier library is listed
      // from the index and only read when something in it is actually wanted.
      await ctx.ensureStandardLibrary(request.libId)
      available = ctx.availableSymbols().find((entry) => entry.libId === request.libId)
    }
    const definition = available?.sheet.libSymbols.get(request.libId)
    if (!available || !definition) return { error: 'unknown-symbol', detail: request.libId }

    const source = available
    const chain = libSymbolChain(definition, (name) => source.sheet.libSymbols.get(name))

    // A taken reference with a unit is the next unit of that part.
    let nextUnit: Extract<NextUnitPlan, { ok: true }> | null = null
    if (request.reference && ctx.existingReferences().includes(request.reference)) {
      if (request.unit === undefined) {
        return {
          error: 'reference-taken',
          detail: `${request.reference} is already used. Pass unit to place another unit of it, or omit reference.`
        }
      }
      const planned = planNextUnit(ctx.sheetSources(), {
        reference: request.reference,
        libId: request.libId,
        unit: request.unit,
        unitCount: libSymbolUnitCount(chain),
        filePath: ctx.filePath(),
        sheetPath: ctx.sheetPath(),
        instancePaths: ctx.instancePaths(),
        document: ctx.document() ?? source.sheet,
        value: request.value,
        properties: request.properties,
        subpart: ctx.subpart()
      })
      if (!planned.ok) return planned
      nextUnit = planned
    }
    const unit = Math.max(1, Math.min(request.unit ?? 1, libSymbolUnitCount(chain)))
    const pins = libSymbolUnitPins(chain, unit)
    const geometry = placementGeometry(chain, unit)

    const rawPrefix = getLibSymbolProperty(definition, 'Reference') ?? 'U'
    const prefix = rawPrefix.replace(/[?\d]+$/, '') || 'U'
    const reference = request.reference ?? nextReference(ctx.existingReferences(), prefix)

    const angle = request.angle ?? 0
    const requested: Point = { x: mmToNm(request.at.x), y: mmToNm(request.at.y) }
    // `pin` makes `at` the pin's landing point rather than the origin.
    const anchored = request.pin ? originForPin(pins, request.pin, requested, angle) : requested
    if (!anchored) {
      return {
        error: 'pin-not-found',
        detail: `pin: ${request.libId} unit ${unit} has no pin "${request.pin}".`,
        candidates: pins.map((pin) => pin.number)
      }
    }
    const at = anchored
    const offGrid = offGridPlacement(geometry, at, angle, ctx.connectionGrid())
    if (offGrid) {
      return {
        error: 'off-grid',
        detail: `${offGrid.pins.length} of ${geometry.pins.length} pins of ${request.libId} would miss the ${asMm(ctx.connectionGrid())} mm connection grid at (${asMm(at.x)}, ${asMm(at.y)}); the nearest origin that puts every pin on it is (${asMm(offGrid.nearest.x)}, ${asMm(offGrid.nearest.y)}).`
      }
    }
    const project = ctx.instanceProjectName()
    const instances = ctx.instancePaths().map((path) => ({ project, path }))
    const footprintId = nextUnit ? undefined : request.properties?.Footprint
    const warnings = footprintId
      ? await footprintWarningsFor(chain, request.libId, footprintId)
      : []

    // The fields go INTO the insertion, not onto the symbol afterwards:
    // `addSchematicSymbolToAST` writes the AST and leaves `schematic.symbols` to be
    // re-derived on the next reparse, so reaching for the "last" symbol here would
    // find the previously placed one and brand it with this part's identity.
    const fields = nextUnit ? { ...nextUnit.fields } : { ...(request.properties ?? {}) }
    if (!nextUnit && request.value !== undefined) fields.Value = request.value
    const isPlaced = (candidate: KicadSchematicSymbol): boolean =>
      referenceForSheetPath(candidate, ctx.sheetPath()) === reference && candidate.unit === unit

    const before = agentChecks(request)
    const cleanup = ctx.runCommand(
      ctx.label(tk('commandLabels.addSymbol')),
      () => {
        const target = ctx.document()
        if (!target) return
        ensureLibSymbolsInAST(target, chain)
        addSchematicSymbolToAST(
          target,
          definition,
          { x: at.x, y: at.y, angle },
          reference,
          pins,
          instances,
          unit,
          1,
          fields
        )
        // The library's fields are laid out for 0°; turned with the body they
        // read across it. Autoplace them, as KiCad's placement tool does, which
        // also marks them so for a later turn.
        if (angle !== 0 || nextUnit) {
          const parsed = parseKicadSchematic(serializeKicadSchematic(target))
          const placed = parsed.symbols.find(isPlaced)
          if (placed) {
            if (nextUnit) {
              for (const [path, named] of nextUnit.references) {
                setSymbolInstanceReference(placed, path, named)
              }
              setSchematicSymbolFlag(placed, 'dnp', nextUnit.flags.dnp)
              setSchematicSymbolFlag(placed, 'in_bom', nextUnit.flags.inBom)
              setSchematicSymbolFlag(placed, 'on_board', nextUnit.flags.onBoard)
              setSchematicSymbolFlag(placed, 'exclude_from_sim', nextUnit.flags.excludeFromSim)
            }
            if (angle !== 0) autoplaceFieldsInAST(parsed, ctx.sheetPath(), placed)
            ctx.setDocument(parsed)
          }
        }
      },
      { cleanup: true }
    )

    // A pin that landed on a wire or another pin joined that net on arrival.
    // Said plainly, because a part placed "somewhere for now" and moved later
    // takes that wire along with it.
    const written = ctx.document()
    const graph = ctx.connectivity()
    const placedSymbol = written?.symbols.find(isPlaced)
    const ownPins = written
      ? addressablePins(written, ctx.sheetPath()).filter((pin) => pin.symbol === placedSymbol)
      : []
    // Where each pin landed and which way is free, so the next wire needs no
    // read and no knowledge of the rotation convention. A part with more pins
    // than a passive or a small IC is read with items_get, as before.
    const landed =
      ownPins.length <= PLACE_PIN_ROWS
        ? ownPins.map((pin): McpPlacedTerminal => ({
            id: pinRefOf(pin),
            number: pin.number,
            name: pin.name,
            at: { x: asMm(pin.position.x), y: asMm(pin.position.y) },
            free: directionOf(pin.labelAngle)
          }))
        : null
    const touching =
      written && graph
        ? ownPins.flatMap((pin) => {
            const net = graph.netOfPin(ctx.sheetPath(), pin.symbol.uuid ?? '', pin.number)
            return net && (net.wires.length > 0 || net.pins.length > 1 || net.labels.length > 0)
              ? [{ pin: pinRefOf(pin), net: net.name }]
              : []
          })
        : []

    const placedId =
      written && placedSymbol
        ? unitItemId(written, placedSymbol, reference, ctx.subpart())
        : reference
    const placed: McpPlaced = {
      id: placedId,
      reference,
      libId: request.libId,
      at: { x: asMm(at.x), y: asMm(at.y) },
      angle,
      unit,
      ...(landed ? { pins: landed } : { pinCount: ownPins.length })
    }
    return {
      placed,
      ...(touching.length ? { touching } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(cleanup && cleanupChanged(cleanup) ? { cleanup } : {}),
      sheet: sheetRef(),
      ...agentReport(before, {
        created: [{ id: placedId, kind: 'symbol' }],
        updated: [],
        deleted: []
      }),
      guidance: `${placedId !== reference ? `Unit ${placedId} of ${reference}: move, turn or delete it by ${placedId}; a field or value written on ${reference} reaches every unit. ` : ''}Placed with no wires. pins lists where each landed and its free side (pinCount instead for a large part; items_get for the rows): wire from them with schematic_wire, or label with schematic_connect.`
    }
  }

  const labelIdOf = (label: KicadLabel): string =>
    label.uuid ?? `label@${asMm(label.position.x)},${asMm(label.position.y)}`
  const pointIdOf = (kind: 'junction' | 'no_connect', point: Point): string =>
    `${kind}@${asMm(point.x)},${asMm(point.y)}`
  const itemsInput = (): ItemsInput | null => {
    const active = ctx.document()
    return active
      ? {
          schematic: active,
          connectivity: ctx.connectivity(),
          sheetPath: ctx.sheetPath(),
          subpart: ctx.subpart()
        }
      : null
  }
  /**
   * A move, turn, mirror or delete names one unit of a multi-unit part, never
   * the part: refused with the unit ids. Null when `item` is one placement.
   */
  const wholePart = (
    item: ResolvedItem,
    verb: string
  ): { error: string; detail: string; candidates: string[] } | null =>
    item.kind === 'symbol' && item.units
      ? {
          error: 'unit-required',
          detail: `${item.reference} is a part of several units, and ${verb} acts on one: name a unit (${item.units.join(', ')}).`,
          candidates: item.units
        }
      : null
  /** The id an agent reads for an item, as `sheetItems` answers it. */
  const describeItemId = (item: ResolvedItem): string => {
    switch (item.kind) {
      case 'symbol':
        return item.id
      case 'field':
        return `${item.reference}#${item.property.key}`
      case 'label':
        return labelIdOf(item.label)
      case 'junction':
      case 'no_connect':
        return pointIdOf(item.kind, item.point)
      case 'wire':
        return wireId(item.wire, item.index)
      case 'text':
        return textId(item.text, item.index)
      case 'sheet':
        return sheetId(item.sheet, item.index)
      case 'sheet_pin':
        return `${sheetId(item.sheet, item.index)}#${item.pin.name}`
      default:
        return graphicItemId(item.graphic)
    }
  }
  const mmPoint = (at: { x: number; y: number }): Point => ({ x: mmToNm(at.x), y: mmToNm(at.y) })

  /**
   * The refusal a write earns when the connection points it would leave —
   * pins, wire ends, a dot — miss the grid a wire can meet. `at` is the
   * caller's anchor and `anchor` what to call it; the answer names the nearest
   * one that puts every point on grid, the same shape `place` refuses with.
   */
  const offGridRefusal = (
    subject: string,
    points: Point[],
    at: Point,
    anchor: string,
    noun = 'connection point'
  ): { error: 'off-grid'; detail: string } | null => {
    const off = offGridPoints(points, ctx.connectionGrid())
    if (!off) return null
    const grid = `${asMm(ctx.connectionGrid())} mm connection grid`
    const nearest = `(${asMm(nm(at.x + off.shift.x))}, ${asMm(nm(at.y + off.shift.y))})`
    const here = `(${asMm(at.x)}, ${asMm(at.y)})`
    if (points.length === 1) {
      return {
        error: 'off-grid',
        detail: `${subject} at ${here} would miss the ${grid}; the nearest ${anchor} on it is ${nearest}.`
      }
    }
    return {
      error: 'off-grid',
      detail: `${off.points.length} of ${points.length} ${noun}s of ${subject} would miss the ${grid} at ${here}; the nearest ${anchor} that puts every ${noun} on it is ${nearest}.`
    }
  }

  /** Where an item's connection points would land if moved to `at`, refused if off grid. */
  const offGridMove = (
    item: ResolvedItem,
    at: Point,
    request: McpUpdateItemRequest
  ): { error: 'off-grid'; detail: string } | null => {
    const input = itemsInput()
    if (!input) return null
    switch (item.kind) {
      case 'symbol': {
        const after = pinsAfterTransform(input.schematic, item.symbol, {
          at,
          ...(request.angle !== undefined ? { angle: request.angle } : {}),
          ...(request.mirror
            ? { mirror: request.mirror === 'none' ? undefined : request.mirror }
            : {})
        })
        const pins = [...after.values()].map((landing) => landing.position)
        return offGridRefusal(item.reference, pins, at, 'origin', 'pin')
      }
      case 'wire': {
        const first = item.wire.points[0]
        if (!first) return null
        const delta = { x: at.x - first.x, y: at.y - first.y }
        const ends = item.wire.points.map((point) => ({
          x: nm(point.x + delta.x),
          y: nm(point.y + delta.y)
        }))
        return offGridRefusal(describeItemId(item), ends, at, 'first point', 'end')
      }
      case 'junction':
      case 'no_connect':
      case 'sheet_pin':
        return offGridRefusal(describeItemId(item), [at], at, 'point')
      case 'sheet': {
        const delta = { x: at.x - item.sheet.position.x, y: at.y - item.sheet.position.y }
        const pins = item.sheet.pins.map((pin) => ({
          x: nm(pin.position.x + delta.x),
          y: nm(pin.position.y + delta.y)
        }))
        return offGridRefusal(describeItemId(item), [at, ...pins], at, 'corner')
      }
      default:
        return null
    }
  }

  /**
   * A graphic, bus, bus entry, table, image or directive label changed as the
   * editor changes it: a move by the drag's placement, the rest by the
   * properties panel's setters, under the panel's undo label.
   */
  const updateGraphic = (
    graphic: GraphicItem,
    id: string,
    request: McpUpdateItemRequest
  ): unknown => {
    const change: GraphicChange = request
    const refusal = graphicChangeRefusal(graphic, change)
    if (refusal) return { error: 'invalid-record', detail: refusal }
    const points = connectionPointsAfter(graphic, change)
    const anchor = request.at ? mmPoint(request.at) : points[0]
    if (anchor) {
      const refused = offGridRefusal(id, points, anchor, request.at ? 'point' : 'end', 'end')
      if (refused) return refused
    }
    const before = agentChecks(request)
    // Moving a bus or an entry moves wire ends, which the editor's move tidies.
    const tidy =
      (graphic.kind === 'bus' || graphic.kind === 'bus_entry') &&
      (request.at !== undefined || request.end !== undefined)
    const cleanup = ctx.runCommand(
      request.at ? ctx.label(tk('commandLabels.move'), 1) : ctx.label(EDIT_LABELS[graphic.kind]),
      () => writeGraphicChange(graphic, change),
      { cleanup: tidy }
    )
    return {
      ...(cleanup && cleanupChanged(cleanup) ? { cleanup } : {}),
      sheet: sheetRef(),
      ...agentReport(before, {
        created: [],
        updated: [{ id, kind: graphic.kind }],
        deleted: []
      }),
      guidance: 'Changed. items_get reads it back.'
    }
  }

  const agentItemsUpdate = (request: McpUpdateItemRequest): unknown => {
    if (ctx.readOnly()) return { error: 'read-only' }
    const input = itemsInput()
    if (!input) return { error: 'no-schematic' }
    const resolved = resolveItem(input, request.id)
    if (!resolved.ok) {
      return { error: 'item-not-found', detail: resolved.missing, candidates: resolved.candidates }
    }
    const item = resolved.item
    const id = describeItemId(item)

    // A sheet pin's angle is its edge, and `side` is how that is said.
    if (item.kind === 'sheet_pin' && request.angle !== undefined) {
      return {
        error: 'not-applicable',
        detail: 'A sheet pin faces out of the edge it is on; move it with side, not angle.'
      }
    }
    // Refused up front, before any write, so a partial update is never applied.
    const invalid = checkRecord(
      'sheet',
      item.kind,
      omitKeys(request, ['kind', 'id', 'sheet', 'wires', 'checks', 'viewport', 'action']),
      'update'
    )
    if (invalid) return { error: invalid.error, detail: invalid.detail }
    if (
      (request.fields && 'Reference' in request.fields) ||
      (item.kind === 'field' && item.property.key === 'Reference' && request.value !== undefined)
    ) {
      return {
        error: 'not-applicable',
        detail: `The Reference is assigned by annotation and is not written through ${item.kind === 'field' ? 'its field' : 'fields'}; renumber with schematic_annotate.`
      }
    }
    if (request.shape !== undefined && item.kind === 'label' && item.label.type === 'label')
      return {
        error: 'not-applicable',
        detail: `${id} is a local label, which has no shape; a global or hierarchical one does.`
      }
    if ('graphic' in item) return updateGraphic(item.graphic, id, request)
    if (request.at || request.angle !== undefined || request.mirror) {
      const refused = wholePart(item, 'a move, turn or mirror')
      if (refused) return refused
    }
    // A field or flag is the part's, so it is written on every unit of it.
    const partWrite =
      item.kind === 'symbol'
        ? request.value !== undefined ||
          request.fields !== undefined ||
          request.dnp !== undefined ||
          request.inBom !== undefined ||
          request.onBoard !== undefined
        : item.kind === 'field' && request.value !== undefined
    const units =
      item.kind === 'symbol' || item.kind === 'field'
        ? siblingUnits(input.schematic, input.sheetPath, item.symbol, item.reference)
        : []
    if (partWrite && (item.kind === 'symbol' || item.kind === 'field')) {
      const refused = unitsElsewhere(item.reference)
      if (refused) return refused
    }

    const before = agentChecks(request)
    const carried: ChangeRecord[] = []
    const followed: ChangeRecord[] = []
    const removed: ChangeRecord[] = []
    let wiresAdded = 0
    // A moved symbol, wire, dot or sheet changes where wires meet; a field or
    // a label does not, and a whole-sheet tidy on a text edit would be a
    // surprise in the diff.
    const tidy = ['symbol', 'wire', 'junction', 'sheet', 'sheet_pin'].includes(item.kind)
    const at = request.at ? mmPoint(request.at) : undefined

    // A size is the box's from its top-left corner; its pins keep their edges.
    const resize =
      item.kind === 'sheet' && request.size && typeof request.size !== 'number'
        ? planSheetResize(
            item.sheet,
            { width: mmToNm(request.size.width), height: mmToNm(request.size.height) },
            ctx.connectionGrid(),
            id
          )
        : null
    if (resize && !resize.ok) return { error: resize.error, detail: resize.detail }
    const movedPins = resize?.ok ? resize.pins.filter((entry) => entry.moved) : []
    // A wire or label left where a moved pin was no longer meets it.
    const unwired = movedPins
      .filter(
        ({ pin }) =>
          input.schematic.wires.some((wire) =>
            wire.points.some((point) => pointsEqualNm(point, pin.position))
          ) || input.schematic.labels.some((label) => pointsEqualNm(label.position, pin.position))
      )
      .map(({ pin }) => `${id}#${pin.name}`)

    // A point the caller chose is checked against the connection grid before
    // anything is written, as `place` checks an origin: a pin or wire end off
    // it is a net silently broken. A turn or mirror alone keeps the points the
    // item already had and is not second-guessed.
    if (at) {
      const refused = offGridMove(item, at, request)
      if (refused) return refused
    }

    const cleanup = ctx.runCommand(
      ctx.label(tk('commandLabels.move'), 1),
      () => {
        const target = ctx.document()
        if (!target) return
        switch (item.kind) {
          case 'symbol': {
            const { symbol } = item
            const attached = attachedToSymbol(target, input.sheetPath, symbol)
            const after = pinsAfterTransform(target, symbol, {
              ...(at ? { at } : {}),
              ...(request.angle !== undefined ? { angle: request.angle } : {}),
              ...(request.mirror
                ? { mirror: request.mirror === 'none' ? undefined : request.mirror }
                : {})
            })
            const posed = Boolean(at || request.angle !== undefined || request.mirror)
            // Wires on the pins follow unless told to stay: the same plan a drag
            // makes, from where each pin lands, read before the symbol moves.
            let plan: MovePlan | null = null
            if (posed && request.wires !== 'leave') {
              const moved: MovedPoint[] = []
              for (const pin of attached.pins) {
                const landing = after.get(pin.number)
                if (!landing) continue
                moved.push({
                  from: pin.position,
                  to: landing.position,
                  direction: directionOf(landing.labelAngle),
                  directionBefore: directionOf(pin.labelAngle)
                })
              }
              const selection = selectionOf([
                { type: 'symbol', index: target.symbols.indexOf(symbol) }
              ])
              plan = planMovedPoints(target, moved, selection, {
                grid: PIN_GRID,
                wires: true,
                carryAttached: false
              })
              for (const edit of plan.reshape.edits) {
                const wire = target.wires[edit.index]
                if (!wire) continue
                const record: ChangeRecord = { id: wireId(wire, edit.index), kind: 'wire' }
                if (edit.points.length >= 2) followed.push(record)
                else removed.push(record)
              }
              wiresAdded = plan.reshape.added.length
            }
            // The fields ride with the body through the move, turn and flip.
            setSchematicSymbolPoseInAST(symbol, {
              position: {
                x: at?.x ?? symbol.position.x,
                y: at?.y ?? symbol.position.y,
                angle: request.angle ?? symbol.position.angle
              },
              mirror: request.mirror
                ? request.mirror === 'none'
                  ? undefined
                  : request.mirror
                : symbol.mirror
            })
            for (const entry of posed ? attached.labels : []) {
              const landing = after.get(entry.pin.number)
              if (!landing) continue
              setSchematicLabelPlacement(entry.label, {
                ...landing.position,
                angle: landing.labelAngle
              })
              carried.push({
                id: labelIdOf(entry.label),
                kind: 'label',
                net: entry.label.text,
                pin: pinRefOf(entry.pin)
              })
            }
            for (const entry of posed ? attached.noConnects : []) {
              const landing = after.get(entry.pin.number)
              if (!landing) continue
              moveSchematicPointItemInAST(entry.point, {
                x: nm(landing.position.x - entry.point.x),
                y: nm(landing.position.y - entry.point.y)
              })
              carried.push({
                id: pointIdOf('no_connect', entry.point),
                kind: 'no_connect',
                pin: pinRefOf(entry.pin)
              })
            }
            // Autoplaced fields are placed again after a turn or flip, as KiCad
            // does; ones placed by hand keep their place on the body.
            if ((request.angle !== undefined || request.mirror) && symbol.fieldsAutoplaced) {
              autoplaceFieldsInAST(target, input.sheetPath, symbol)
            }
            for (const unit of [symbol, ...units]) {
              if (request.value !== undefined)
                setSchematicSymbolProperty(unit, 'Value', request.value)
              if (request.dnp !== undefined) setSchematicSymbolFlag(unit, 'dnp', request.dnp)
              if (request.inBom !== undefined) setSchematicSymbolFlag(unit, 'in_bom', request.inBom)
              if (request.onBoard !== undefined)
                setSchematicSymbolFlag(unit, 'on_board', request.onBoard)
              for (const [key, value] of Object.entries(request.fields ?? {})) {
                setSchematicSymbolProperty(unit, key, value)
              }
            }
            if (plan) applyMovePlan(target, plan)
            break
          }
          case 'field': {
            if (request.value !== undefined) {
              for (const unit of [item.symbol, ...units])
                setSchematicSymbolProperty(unit, item.property.key, request.value)
            }
            if (at || request.angle !== undefined) {
              // Placed by hand: a later turn must not autoplace it back.
              setSchematicFieldsAutoplaced(item.symbol, false)
              setSchematicPropertyPlacement(item.property, {
                x: at?.x ?? item.property.position.x,
                y: at?.y ?? item.property.position.y,
                // The record reports a field's angle in sheet space; the file keeps
                // it in the symbol's frame. Convert back, so what is written is
                // what was asked for and what reads back.
                ...(request.angle !== undefined
                  ? {
                      angle: fieldAngleForSheetAngle(request.angle, item.symbol.position.angle)
                    }
                  : {})
              })
            }
            if (request.hidden !== undefined)
              setSchematicPropertyHidden(item.property, request.hidden)
            break
          }
          case 'sheet_pin': {
            const live = target.sheets[item.index]
            const pin = live?.pins.find((candidate) => candidate.name === item.pin.name)
            if (!live || !pin) break
            if (request.name !== undefined || request.shape !== undefined) {
              setSheetPinFields(pin, {
                ...(request.name !== undefined ? { name: request.name.trim() } : {}),
                ...(request.shape !== undefined ? { shape: request.shape as SheetPinShape } : {})
              })
            }
            if (at || request.side !== undefined) {
              // A pin belongs to an edge, so a move is resolved onto one: an
              // explicit side wins, a bare point takes the edge nearest it.
              const side = request.side ?? sheetSideOf(live, at ?? pin.position)
              const taken = live.pins.filter(
                (candidate) => candidate !== pin && sheetSideOf(live, candidate.position) === side
              ).length
              setSheetPinPlacement(pin, {
                position: at ?? sheetPinSlot(live, side, taken + 1),
                side
              })
            }
            break
          }
          case 'label': {
            if (request.text !== undefined) setSchematicLabelText(item.label, request.text)
            if (at || request.angle !== undefined) {
              setSchematicLabelPlacement(item.label, {
                x: at?.x ?? item.label.position.x,
                y: at?.y ?? item.label.position.y,
                ...(request.angle !== undefined ? { angle: request.angle } : {})
              })
            }
            if (request.shape) setSchematicLabelShape(item.label, request.shape as SheetPinShape)
            setTextEffects(item.label._node, textEffectsPatch(request))
            break
          }
          case 'text': {
            if (request.text !== undefined) setSchematicTextContent(item.text, request.text)
            if (at || request.angle !== undefined) {
              setSchematicTextPlacement(item.text, {
                x: at?.x ?? item.text.position.x,
                y: at?.y ?? item.text.position.y,
                ...(request.angle !== undefined ? { angle: request.angle } : {})
              })
            }
            setTextEffects(item.text._node, textEffectsPatch(request))
            break
          }
          case 'wire':
            if (at) {
              const first = item.wire.points[0]
              if (first)
                moveSchematicWireInAST(item.wire, { x: nm(at.x - first.x), y: nm(at.y - first.y) })
            }
            writeWireStroke(item.wire, request)
            break
          case 'junction':
          case 'no_connect':
            if (at)
              moveSchematicPointItemInAST(item.point, {
                x: nm(at.x - item.point.x),
                y: nm(at.y - item.point.y)
              })
            break
          case 'sheet':
            if (resize?.ok && request.size && typeof request.size !== 'number') {
              resizeSchematicSheetInAST(
                item.sheet,
                { ...item.sheet.position },
                { width: mmToNm(request.size.width), height: mmToNm(request.size.height) }
              )
              // Exactly where the plan put them: the shared writer snaps a pin
              // onto the pin pitch, which would move one KiCad left between.
              for (const { pin, side, to } of resize.pins) {
                setSheetPinPlacement(pin, { position: to, side })
              }
            }
            if (at) {
              moveSchematicSheetInAST(item.sheet, {
                x: nm(at.x - item.sheet.position.x),
                y: nm(at.y - item.sheet.position.y)
              })
            }
            break
        }
      },
      { cleanup: tidy }
    )

    return {
      ...(wiresAdded ? { counts: { wiresAdded } } : {}),
      ...(unwired.length ? { unwired } : {}),
      ...(cleanup && cleanupChanged(cleanup) ? { cleanup } : {}),
      sheet: sheetRef(),
      ...agentReport(before, {
        created: [],
        updated: [
          { id, kind: item.kind },
          ...movedPins.map(({ pin }): ChangeRecord => ({
            id: `${id}#${pin.name}`,
            kind: 'sheet_pin'
          })),
          ...carried,
          ...followed
        ],
        deleted: removed
      }),
      guidance: resize
        ? unwired.length
          ? 'Resized; the pins on its right and bottom edges moved with them, and the wires and labels on the ones under unwired stayed behind: wire them again.'
          : 'Resized; the pins on its right and bottom edges moved with them.'
        : followed.length + removed.length + wiresAdded > 0
          ? 'Moved; wires on its pins were reshaped and labels and no-connects followed. New bend segments have new ids: items_get or render_schematic to see the result.'
          : carried.length
            ? 'Moved; labels and no-connects on its pins followed, turned to read away from the body.'
            : 'Changed. items_get reads it back.'
    }
  }

  const isNamedNet = (net: SchematicNet | undefined): net is SchematicNet =>
    net !== undefined && net.nameSource !== 'none' && net.nameSource !== 'pin'

  /**
   * The one name a net takes from the hierarchy alone: every name on it is a
   * sheet pin or a hierarchical label, all spelled the same. Null otherwise.
   * Two such nets of one name are the two ends of a hierarchical link, so
   * wiring them together is what they are for, not a merge.
   */
  const hierarchyName = (net: SchematicNet): string | null => {
    if (net.nameSource !== 'sheet_pin' && net.nameSource !== 'hierarchical_label') return null
    if (net.labels.some(({ label }) => label.type !== 'hierarchical_label')) return null
    if (net.pins.some((pin) => pin.power)) return null
    const names = new Set([
      ...net.labels.map(({ label }) => label.text),
      ...net.sheetPins.map(({ pin }) => pin.name)
    ])
    return names.size === 1 ? [...names][0] : null
  }

  /**
   * A bus run, routed as a wire is and drawn as the editor's bus tool draws
   * one: a segment per leg, no junction dots and no tidy. A leg already on the
   * sheet is not drawn twice.
   */
  const agentBus = (request: McpWireRequest, input: ItemsInput): unknown => {
    for (const end of [request.start, request.end]) {
      if (end.pin && !resolveSheetPinEnd(input.schematic, end.pin))
        return {
          error: 'invalid-args',
          detail: `A bus ends on a point or a sheet pin, and ${end.pin} is not a sheet pin here; end it beside the part and run wires through bus entries.`
        }
    }
    const endOf = (end: McpWireRequest['start']): WireEnd =>
      end.pin ? { pin: end.pin } : { x: end.x ?? 0, y: end.y ?? 0 }
    const routed = routeWire(input, endOf(request.start), endOf(request.end), request.posture)
    if (!routed.ok)
      return { error: routed.error, detail: routed.detail, candidates: routed.candidates }
    const { points, fromSheetPin, toSheetPin } = routed.wire
    const refused = offGridRefusal('the bus', points, points[0], 'start', 'point')
    if (refused) return refused
    const mm = (point: Point): { x: number; y: number } => ({ x: asMm(point.x), y: asMm(point.y) })
    const wired = {
      from: fromSheetPin?.id ?? mm(points[0]),
      to: toSheetPin?.id ?? mm(points[points.length - 1]),
      points: points.map(mm)
    }
    const segments = points.slice(1).map((point, index) => [points[index], point] as const)
    const missing = segments.filter(
      ([a, b]) =>
        !input.schematic.buses.some(
          (bus) =>
            bus.points.length === 2 &&
            ((pointsEqualNm(bus.points[0], a) && pointsEqualNm(bus.points[1], b)) ||
              (pointsEqualNm(bus.points[0], b) && pointsEqualNm(bus.points[1], a)))
        )
    )
    if (!missing.length) {
      return {
        wired,
        alreadyDrawn: true,
        sheet: sheetRef(),
        ...agentReport(null, emptyChangeSet()),
        guidance: 'Every segment was already on the sheet; nothing was drawn.'
      }
    }
    const busIds = (): Set<string> =>
      new Set(
        graphicItems(ctx.document() ?? input.schematic)
          .filter((item) => item.kind === 'bus')
          .map(graphicItemId)
      )
    const had = busIds()
    const before = agentChecks(request)
    ctx.runCommand(ctx.label(tk('commandLabels.addBus')), () => {
      const target = ctx.document()
      if (target) for (const segment of missing) addSchematicBusToAST(target, [...segment])
    })
    const created: ChangeRecord[] = [...busIds()]
      .filter((id) => !had.has(id))
      .map((id) => ({ id, kind: 'bus' }))
    return {
      wired,
      sheet: sheetRef(),
      ...agentReport(before, { created, updated: [], deleted: [] }),
      guidance:
        'Drawn. Name it with a label on it (items_create kind label at a point of the run), then a bus_entry, a wire and a member-name label per member.'
    }
  }

  const agentWire = (request: McpWireRequest): unknown => {
    if (ctx.readOnly()) return { error: 'read-only' }
    const input = itemsInput()
    if (!input) return { error: 'no-schematic' }
    if (request.bus) return agentBus(request, input)
    const endOf = (end: McpWireRequest['start']): WireEnd =>
      end.pin ? { pin: end.pin } : { x: end.x ?? 0, y: end.y ?? 0 }
    const routed = routeWire(input, endOf(request.start), endOf(request.end), request.posture)
    if (!routed.ok)
      return { error: routed.error, detail: routed.detail, candidates: routed.candidates }
    const { points, fromPin, toPin, fromSheetPin, toSheetPin } = routed.wire
    const mm = (point: Point): { x: number; y: number } => ({ x: asMm(point.x), y: asMm(point.y) })
    const wired = {
      from: fromPin ? pinRefOf(fromPin) : (fromSheetPin?.id ?? mm(points[0])),
      to: toPin ? pinRefOf(toPin) : (toSheetPin?.id ?? mm(points[points.length - 1])),
      points: points.map(mm)
    }

    // What the run would join, read before it is drawn. A run along another
    // net's wire is one net on the sheet and two to the eye — never meant; and
    // joining two nets that are both named is the merge `connect` refuses for
    // the same reason, unless the caller says so.
    const graph = input.connectivity
    const sheetPath = input.sheetPath
    const endNets = [
      fromPin
        ? graph?.netOfPin(sheetPath, fromPin.symbol.uuid ?? '', fromPin.number)
        : graph?.netAt(sheetPath, points[0]),
      toPin
        ? graph?.netOfPin(sheetPath, toPin.symbol.uuid ?? '', toPin.number)
        : graph?.netAt(sheetPath, points[points.length - 1])
    ]
    const contacts = routeContacts(input.schematic.wires, points)
    for (const index of contacts.overlapping) {
      const net = graph?.netOfWire(sheetPath, index)
      if (net && endNets.includes(net)) continue
      const other = input.schematic.wires[index]
      const [a, b] = [other.points[0], other.points[other.points.length - 1]]
      return {
        error: 'would-overlap',
        detail: `The run would lie along ${net ? `a wire of ${net.name}` : 'another wire'} between (${asMm(a.x)}, ${asMm(a.y)}) and (${asMm(b.x)}, ${asMm(b.y)}). End the run on that wire if they belong together, or route through a free point.`
      }
    }
    const named = new Map<string, SchematicNet>()
    for (const net of endNets) if (isNamedNet(net)) named.set(net.name, net)
    for (const index of [...contacts.landing, ...contacts.teed]) {
      const net = graph?.netOfWire(sheetPath, index)
      if (isNamedNet(net)) named.set(net.name, net)
    }
    const linked = new Set([...named.values()].map(hierarchyName))
    const hierarchyLink = linked.size === 1 && !linked.has(null)
    if (named.size > 1 && request.merge !== true && !hierarchyLink) {
      const names = [...named.keys()].sort()
      return {
        error: 'would-merge',
        detail: `This run would merge ${names.join(' and ')} into one net. Pass merge: true to allow it, or end the run elsewhere.`,
        candidates: names
      }
    }

    const segments = points.slice(1).map((point, index) => [points[index], point] as const)
    const drawn = (segment: readonly [Point, Point]): boolean =>
      input.schematic.wires.some(
        (wire) =>
          wire.points.length === 2 &&
          ((pointsEqualNm(wire.points[0], segment[0]) &&
            pointsEqualNm(wire.points[1], segment[1])) ||
            (pointsEqualNm(wire.points[0], segment[1]) &&
              pointsEqualNm(wire.points[1], segment[0])))
      )
    const missing = segments.filter((segment) => !drawn(segment))
    if (!missing.length) {
      return {
        wired: { ...wired, junctions: [] },
        alreadyDrawn: true,
        sheet: sheetRef(),
        ...agentReport(null, emptyChangeSet()),
        guidance: 'Every segment was already on the sheet; nothing was drawn.'
      }
    }

    const junctionPoints = junctionsForRoutedWire(input, points)
    const before = agentChecks(request)
    const cleanup = ctx.runCommand(
      ctx.label(tk('commandLabels.addWire')),
      () => {
        const target = ctx.document()
        if (!target) return
        addSchematicWireToAST(target, points)
        for (const point of junctionPoints) addSchematicJunctionToAST(target, point)
      },
      { cleanup: true }
    )
    // One wire node per segment on the sheet, so a bent run is several ids;
    // the dots are read back from the sheet, since cleanup has the last word.
    const written = ctx.document()
    const junctions = (written?.junctions ?? []).filter((junction) =>
      points.some((point) => pointsEqualNm(junction, point))
    )
    const created: ChangeRecord[] = [
      ...missing.map(([a, b]): ChangeRecord => {
        const wire = written?.wires.find(
          (candidate) =>
            candidate.points.length === 2 &&
            candidate.points[0].x === a.x &&
            candidate.points[0].y === a.y &&
            candidate.points[1].x === b.x &&
            candidate.points[1].y === b.y
        )
        return {
          id: wire?.uuid ?? `wire@${asMm(a.x)},${asMm(a.y)}`,
          kind: 'wire',
          points: [a, b].map(mm)
        }
      }),
      ...junctions
        .filter((junction) => junctionPoints.some((point) => pointsEqualNm(junction, point)))
        .map((point): ChangeRecord => ({ id: pointIdOf('junction', point), kind: 'junction' }))
    ]
    return {
      wired: { ...wired, junctions: junctions.map(mm) },
      ...(cleanup && cleanupChanged(cleanup) ? { cleanup } : {}),
      sheet: sheetRef(),
      ...agentReport(before, { created, updated: [], deleted: [] }),
      guidance:
        points.length === 2
          ? 'Drawn straight. With checks: true, checks says which pins it joined.'
          : 'Drawn with one bend; render_schematic on the two parts shows the run. With checks: true, checks says which pins it joined.'
    }
  }

  const agentItemsDelete = (request: McpDeleteItemsRequest): unknown => {
    if (ctx.readOnly()) return { error: 'read-only' }
    const input = itemsInput()
    if (!input) return { error: 'no-schematic' }
    const resolvedItems: ResolvedItem[] = []
    for (const id of request.ids) {
      const resolved = resolveItem(input, id)
      if (!resolved.ok) {
        return {
          error: 'item-not-found',
          detail: resolved.missing,
          candidates: resolved.candidates
        }
      }
      if (resolved.item.kind === 'field') {
        return {
          error: 'not-applicable',
          detail: `${id} is a field; hide it with items_update rather than deleting it.`
        }
      }
      const refused = wholePart(resolved.item, 'a delete')
      if (refused) return refused
      resolvedItems.push(resolved.item)
    }

    const before = agentChecks(request)
    const deleted: ChangeRecord[] = []
    const nodes = new Set<SExprNode>()
    for (const item of resolvedItems) {
      switch (item.kind) {
        case 'symbol': {
          nodes.add(item.symbol._node)
          deleted.push({ id: item.id, kind: 'symbol', libId: item.symbol.libId })
          const attached = attachedToSymbol(input.schematic, input.sheetPath, item.symbol)
          for (const entry of attached.labels) {
            nodes.add(entry.label._node)
            deleted.push({
              id: labelIdOf(entry.label),
              kind: 'label',
              net: entry.label.text,
              pin: pinRefOf(entry.pin)
            })
          }
          for (const entry of attached.noConnects) {
            nodes.add(entry.point._node)
            deleted.push({
              id: pointIdOf('no_connect', entry.point),
              kind: 'no_connect',
              pin: pinRefOf(entry.pin)
            })
          }
          break
        }
        case 'label':
          nodes.add(item.label._node)
          deleted.push({ id: labelIdOf(item.label), kind: 'label', net: item.label.text })
          break
        case 'wire':
          nodes.add(item.wire._node)
          deleted.push({ id: describeItemId(item), kind: 'wire' })
          break
        case 'junction':
        case 'no_connect':
          nodes.add(item.point._node)
          deleted.push({ id: pointIdOf(item.kind, item.point), kind: item.kind })
          break
        case 'text':
          nodes.add(item.text._node)
          deleted.push({ id: describeItemId(item), kind: 'text' })
          break
        case 'sheet':
          nodes.add(item.sheet._node)
          deleted.push({ id: describeItemId(item), kind: 'sheet' })
          break
        case 'sheet_pin':
          // Nested in its sheet, so it is not a top-level node to collect —
          // removed directly, inside the same command below.
          deleted.push({ id: describeItemId(item), kind: 'sheet_pin' })
          break
        case 'field':
          break
        default:
          nodes.add(item.graphic.entry.item._node)
          deleted.push({ id: describeItemId(item), kind: item.kind })
      }
    }
    const cleanup = ctx.runCommand(
      ctx.label(tk('commandLabels.delete'), nodes.size),
      () => {
        const target = ctx.document()
        if (!target) return
        // Sheet pins live inside their sheet, so they are removed by index against
        // the live document rather than collected as top-level nodes.
        for (const item of resolvedItems) {
          if (item.kind !== 'sheet_pin') continue
          const live = target.sheets[item.index]
          const pin = live?.pins.find((candidate) => candidate.name === item.pin.name)
          if (live && pin) removeSheetPinFromAST(live, pin)
        }
        if (nodes.size) removeSchematicNodesFromAST(target, [...nodes])
      },
      { cleanup: true }
    )
    return {
      ...(cleanup && cleanupChanged(cleanup) ? { cleanup } : {}),
      sheet: sheetRef(),
      ...agentReport(before, { created: [], updated: [], deleted }),
      guidance:
        'Deleted; a symbol took the labels and no-connects on its pins. With checks: true, checks says which pins are now open.'
    }
  }

  /** The picture an image is made from, as the editor's Place Image reads it. */
  const imagePng = async (path: string): Promise<string | null> => {
    const separator = separatorOf(ctx.filePath())
    const absolute = /^([a-z]:)?[\\/]/i.test(path)
      ? path
      : `${dirnameOf(ctx.filePath())}${separator}${path}`
    return pngFromImageFile(absolute)
  }

  /**
   * A graphic, bus entry, table, image or directive label, drawn by its tool's
   * writer as one step. A directive label on a pin stands on the pin's point.
   */
  const createGraphic = async (
    kind: Exclude<GraphicKind, 'bus'>,
    request: McpCreateItemRequest,
    input: ItemsInput
  ): Promise<unknown> => {
    const change: GraphicChange = { ...request }
    if (kind === 'directive_label' && request.pin) {
      const found = resolvePinRef(request.pin, addressablePins(input.schematic, input.sheetPath))
      if (!found.ok)
        return { error: 'pin-not-found', detail: found.reason, candidates: found.candidates }
      change.at = { x: asMm(found.pin.position.x), y: asMm(found.pin.position.y) }
    }
    if (change.box && (change.box.width === 0 || change.box.height === 0))
      return {
        error: 'invalid-record',
        detail: 'box must span something: a width and a height other than 0.'
      }
    if (
      kind === 'table' &&
      change.cells &&
      (change.cells.length !== request.rowHeights?.length ||
        change.cells.some((row) => row.length !== request.columnWidths?.length))
    )
      return {
        error: 'invalid-record',
        detail: 'cells must be one row per rowHeights entry, each one text per columnWidths entry.'
      }
    if ((kind === 'bus_entry' || kind === 'directive_label') && change.at) {
      const at = mmPoint(change.at)
      const end = change.end ? mmPoint(change.end) : null
      const refused = offGridRefusal(`a ${kind}`, end ? [at, end] : [at], at, 'point')
      if (refused) return refused
    }
    const png = kind === 'image' && request.path ? await imagePng(request.path) : undefined
    if (png === null)
      return {
        error: 'invalid-record',
        detail: `${request.path} is not a picture GoatCAD can read: PNG, JPEG, BMP, GIF or WebP.`
      }
    const ids = (): Set<string> =>
      new Set(
        graphicItems(ctx.document() ?? input.schematic)
          .filter((item) => item.kind === kind)
          .map(graphicItemId)
      )
    const had = ids()
    const before = agentChecks(request)
    ctx.runCommand(ctx.label(CREATE_LABELS[kind]), () => {
      const target = ctx.document()
      if (target) writeGraphicCreate(target, kind, change, { png })
    })
    const created: ChangeRecord[] = [...ids()]
      .filter((id) => !had.has(id))
      .map((id) => ({ id, kind }))
    return {
      sheet: sheetRef(),
      ...agentReport(before, { created, updated: [], deleted: [] }),
      guidance:
        kind === 'directive_label'
          ? "The class applies to the net under the label's foot; with checks: true, checks says what it touches."
          : kind === 'bus_entry'
            ? 'Wire its end to the member and label the wire with the member name.'
            : 'Drawn; it connects nothing. items_update and items_delete take the ids in changed.created.'
    }
  }

  const agentItemsCreate = async (request: McpCreateItemRequest): Promise<unknown> => {
    if (ctx.readOnly()) return { error: 'read-only' }
    const input = itemsInput()
    if (!input) return { error: 'no-schematic' }

    const invalid = checkRecord(
      'sheet',
      request.itemKind,
      omitKeys(request, ['kind', 'itemKind', 'sheet', 'checks', 'viewport', 'action']),
      'create'
    )
    if (invalid) return { error: invalid.error, detail: invalid.detail }
    if (isGraphicKind(request.itemKind)) return createGraphic(request.itemKind, request, input)

    if (request.itemKind === 'sheet_pin') {
      const name = request.name?.trim()
      if (!name) return { error: 'invalid-args', detail: 'name: a sheet pin needs a name.' }
      const ofSheet = request.ofSheet ?? ''
      const target = resolveItem(input, ofSheet)
      if (!target.ok || target.item.kind !== 'sheet') {
        return {
          error: 'item-not-found',
          detail: `ofSheet must name a sheet on this page: ${ofSheet || '(missing)'}`,
          candidates: sheetItems(input)
            .filter((entry) => entry.kind === 'sheet')
            .map((entry) => entry.id)
        }
      }
      const box = target.item.sheet
      const sheetIndex = target.item.index
      if (box.pins.some((pin) => pin.name === name)) {
        return { error: 'invalid-args', detail: `name: ${name} is already a pin on this sheet.` }
      }
      const shape = (request.shape as SheetPinShape | undefined) ?? 'passive'
      const side = request.side ?? (shape === 'output' ? 'right' : 'left')
      // Stack down the edge from the pins already there, so two calls do not
      // land on one point.
      const taken = box.pins.filter((pin) => sheetSideOf(box, pin.position) === side).length
      const at = request.at ? mmPoint(request.at) : sheetPinSlot(box, side, taken + 1)
      const placed = request.at ? sheetSideOf(box, at) : side
      if (request.at) {
        const refused = offGridRefusal(`sheet pin ${name}`, [at], at, 'point')
        if (refused) return refused
      }
      const before = agentChecks(request)
      ctx.runCommand(ctx.label(tk('commandLabels.addSheetPin')), () => {
        const current = ctx.document()
        const live = current?.sheets[sheetIndex]
        if (live) addSheetPinToAST(live, { name, shape, position: at, side: placed })
      })
      const created: ChangeRecord[] = [{ id: `${ofSheet}#${name}`, kind: 'sheet_pin' }]
      return {
        sheet: sheetRef(),
        ...agentReport(before, { created, updated: [], deleted: [] }),
        guidance: `The pin carries a signal once the child has a hierarchical label of the same name (items_create on the child, kind "label", labelKind "hierarchical") and the pin is wired on the parent.`
      }
    }

    let position: Point
    let angle = request.angle ?? 0
    if (request.pin) {
      const found = resolvePinRef(request.pin, addressablePins(input.schematic, input.sheetPath))
      if (!found.ok)
        return { error: 'pin-not-found', detail: found.reason, candidates: found.candidates }
      position = found.pin.position
      if (request.angle === undefined) angle = found.pin.labelAngle
    } else if (request.at) {
      position = mmPoint(request.at)
      if (request.itemKind === 'junction' || request.itemKind === 'no_connect') {
        const refused = offGridRefusal(`a ${request.itemKind}`, [position], position, 'point')
        if (refused) return refused
      }
    } else {
      return { error: 'invalid-args', detail: 'pin or at: say where it goes.' }
    }

    const before = agentChecks(request)
    const labelType =
      request.labelKind === 'global'
        ? 'global_label'
        : request.labelKind === 'hierarchical'
          ? 'hierarchical_label'
          : 'label'
    const commandLabel =
      request.itemKind === 'label'
        ? tk('commandLabels.addLabel')
        : request.itemKind === 'text'
          ? tk('commandLabels.addText')
          : request.itemKind === 'no_connect'
            ? tk('commandLabels.addNoConnect')
            : tk('commandLabels.addJunction')
    // What the text tools leave at their defaults, written onto the new node as an edit would.
    const styled = request.itemKind === 'label' ? labelType : request.itemKind
    ctx.runCommand(ctx.label(commandLabel), () => {
      const target = ctx.document()
      if (!target) return
      const had = new Set(findChildren(target._root, styled))
      switch (request.itemKind) {
        case 'label':
          addSchematicLabelToAST(
            target,
            labelType,
            request.text ?? '',
            { ...position, angle },
            (request.shape as SheetPinShape | undefined) ?? 'input'
          )
          break
        case 'text':
          addSchematicTextToAST(
            target,
            request.text ?? '',
            { ...position, angle },
            {
              ...(request.size !== undefined ? { size: mmToNm(request.size) } : {}),
              ...(request.bold ? { bold: true } : {})
            }
          )
          break
        case 'no_connect':
          addSchematicNoConnectToAST(target, position)
          break
        case 'junction':
          addSchematicJunctionToAST(target, position)
          break
      }
      const effects = textEffectsPatch(request)
      if (request.itemKind === 'label' || request.itemKind === 'text')
        for (const node of findChildren(target._root, styled))
          if (!had.has(node)) setTextEffects(node, effects)
    })

    const written = ctx.document()
    let created: ChangeRecord[] = []
    if (written) {
      if (request.itemKind === 'label') {
        created = labelsAt(written, request.text ?? '', [position])
      } else if (request.itemKind === 'text') {
        created = written.texts
          .filter(
            (text) =>
              text.text === request.text &&
              text.position.x === position.x &&
              text.position.y === position.y
          )
          .map((text) => ({
            id: text.uuid ?? `text@${asMm(position.x)},${asMm(position.y)}`,
            kind: 'text' as const,
            text: text.text
          }))
      } else {
        created = [
          {
            id: pointIdOf(request.itemKind, position),
            kind: request.itemKind,
            ...(request.pin ? { pin: request.pin } : {})
          }
        ]
      }
    }
    return {
      sheet: sheetRef(),
      ...agentReport(before, { created, updated: [], deleted: [] }),
      guidance:
        request.itemKind === 'no_connect'
          ? 'The pin is flagged as open on purpose; it no longer counts as unconnected.'
          : 'Added; items_update and items_delete take the id in changed.created.'
    }
  }

  const agentBind = async (request: McpBindRequest): Promise<unknown> => {
    if (ctx.readOnly()) return { error: 'read-only' }
    const active = ctx.document()
    if (!active) return { error: 'no-schematic' }
    const symbol = symbolByReference(request.reference)
    if (!symbol) return { error: 'reference-not-found', detail: request.reference }
    const elsewhere = unitsElsewhere(request.reference)
    if (elsewhere) return elsewhere
    const units = siblingUnits(active, ctx.sheetPath(), symbol, request.reference)
    const definitions = ctx.document()?.libSymbols
    const definition = definitions?.get(symbol.libId)
    const footprintId = request.properties.Footprint
    const warnings =
      footprintId && definition && definitions
        ? await footprintWarningsFor(
            libSymbolChain(definition, (name) => definitions.get(name)),
            symbol.libId,
            footprintId
          )
        : []

    const before = agentChecks(request)
    ctx.runCommand(ctx.label(tk('commandLabels.bindPart')), () => {
      for (const unit of [symbol, ...units])
        applyPartFields(unit, request.value, request.properties)
    })

    return {
      ...(warnings.length ? { warnings } : {}),
      bound: {
        reference: request.reference,
        libId: symbol.libId,
        value: symbolValue(symbol),
        properties: partPropertyMap(symbol)
      },
      sheet: sheetRef(),
      ...agentReport(before, {
        created: [],
        updated: [
          {
            id: request.reference,
            kind: 'symbol',
            value: symbolValue(symbol),
            properties: partPropertyMap(symbol)
          }
        ],
        deleted: []
      })
    }
  }

  /**
   * What every write answers with (`docs/agent-api.md`): what it
   * changed, and with `checks` what that broke or fixed, so act and verify are
   * one turn when the agent asks for it. `before` is captured by the caller
   * ahead of the mutation, because the delta is only meaningful against the
   * state the write actually started from.
   */
  /** Findings as the project ranks and excludes them: what the pill counts. */
  const projectSeverities = (results: CheckResult[]): CheckResult[] =>
    activeFindings(
      applyExclusions(
        applySeverities(results, ercRuleOf, ctx.ercSeverities()),
        ctx.ercExclusions(),
        ercRuleOf
      )
    )

  const ercNaming = (): ErcContext => {
    const netclasses = ctx.netclasses()
    const textVariables = ctx.textVariables()
    return {
      ...ctx.ercLibraries(),
      ...(netclasses ? { netclasses } : {}),
      ...(textVariables ? { textVariables } : {})
    }
  }

  /** What each schematic_check answered with, for a later one's `since`. */
  const checkHistory = new CheckHistory()

  const runAgentChecks = (): CheckResult[] => {
    const active = ctx.connectivity()
    return active
      ? projectSeverities(
          allChecks(
            active,
            ctx.connectivityInputs(),
            ctx.librarySymbolLookup,
            ctx.connectionGrid(),
            ctx.pinMap(),
            ercNaming()
          )
        )
      : []
  }

  /**
   * The checks before an edit, when its request asked for them; null skips
   * them, so a write costs only its edit (docs/agent-api.md).
   */
  const agentChecks = (request: { checks?: boolean }): CheckResult[] | null =>
    request.checks ? runAgentChecks() : null

  /** What a write answers with: the ids it touched, and the check delta when it took a `before`. */
  const agentReport = (
    before: CheckResult[] | null,
    changed: ChangeSet
  ): Pick<McpWriteAnswer, 'changed' | 'checks' | 'revision'> => ({
    changed: changedIds(changed),
    ...(before ? { checks: compactDelta(checkDelta(before, runAgentChecks())) } : {}),
    revision: ctx.revision()
  })

  const agentConnect = (request: McpConnectRequest): unknown => {
    if (ctx.readOnly()) return { error: 'read-only' }
    const active = ctx.document()
    if (!active) return { error: 'no-schematic' }

    const sheetPath = ctx.sheetPath()
    const available = addressablePins(active, sheetPath)
    // A local label's text never carries the sheet path; describe prints the
    // net as "/GND", and an agent quoting it back means the same net.
    const netText = request.net.replace(/^\/+/, '')
    const labelType = request.labelKind === 'global' ? 'global_label' : 'label'
    const isTargetNet = (name: string): boolean =>
      labelType === 'global_label'
        ? name === netText
        : name === netText || name.endsWith(`/${netText}`)
    // A symbol pin or a sheet pin, by the ids describe and items_get answer.
    const graph = ctx.connectivity()
    const targets: Array<{
      id: string
      position: Point
      labelAngle: number
      net: SchematicNet | undefined
    }> = []
    for (const ref of request.pins) {
      const sheetPin = resolveSheetPinEnd(active, ref)
      if (sheetPin) {
        targets.push({ ...sheetPin, net: graph?.netAt(sheetPath, sheetPin.position) })
        continue
      }
      const found = resolvePinRef(ref, available)
      if (!found.ok) {
        return { error: 'pin-not-found', detail: found.reason, candidates: found.candidates }
      }
      const pin = found.pin
      targets.push({
        id: pinRefOf(pin),
        position: pin.position,
        labelAngle: pin.labelAngle,
        net: graph?.netOfPin(sheetPath, pin.symbol.uuid ?? '', pin.number)
      })
    }

    // Which nets these pins already sit on. A pin already on the target net needs
    // no label; a pin on a *different* named net is a merge.
    const named = new Set<string>()
    const needsLabel: typeof targets = []
    for (const pin of targets) {
      const net = pin.net
      const isNamed = net && net.nameSource !== 'none' && net.nameSource !== 'pin'
      if (net && isTargetNet(net.name)) continue
      if (isNamed && net) named.add(net.name)
      needsLabel.push(pin)
    }

    // Joining two nets that are both already named is a merge, and a silent merge
    // is the one schematic error nobody can see. Both names are echoed
    // so the caller has to have read them.
    if (named.size > 0 && request.merge !== true) {
      return {
        error: 'would-merge',
        detail: `Connecting these pins to ${netText} would merge it with ${[...named].sort().join(', ')}. Pass merge: true to allow it, or use one of those names as net.`,
        candidates: [...named].sort()
      }
    }

    if (!needsLabel.length) {
      return {
        connected: { net: netText, labelled: [], alreadyOn: request.pins },
        sheet: sheetRef(),
        ...agentReport(null, emptyChangeSet()),
        guidance: 'Every pin was already on that net; nothing was written.'
      }
    }

    const before = agentChecks(request)
    const positions = needsLabel.map((pin) => ({ ...pin.position }))
    ctx.runCommand(ctx.label(tk('commandLabels.addLabel')), () => {
      const target = ctx.document()
      if (!target) return
      for (const pin of needsLabel) {
        addSchematicLabelToAST(target, labelType, netText, {
          x: pin.position.x,
          y: pin.position.y,
          angle: pin.labelAngle
        })
      }
    })

    const written = ctx.document()
    const created = written ? labelsAt(written, netText, positions) : []
    return {
      connected: {
        net: netText,
        labelKind: request.labelKind ?? 'local',
        labelled: needsLabel.map((pin) => pin.id),
        merged: named.size ? [...named].sort() : undefined
      },
      sheet: sheetRef(),
      ...agentReport(before, { created, updated: [], deleted: [] }),
      guidance:
        'Connected with net labels; no wire was drawn. Tell the user the pins are joined by labels.'
    }
  }

  /** Clear space around framed symbols, so their labels and neighbours show. */
  const RENDER_MARGIN_NM = 5_080_000

  /**
   * A picture of the sheet (`render.schematic`).
   *
   * Read-only, so no history entry, and the user's view is left where it was:
   * the capture is the mounted editor's own canvas, fitted and restored in one
   * synchronous step. The frame comes back in sheet millimetres so a pixel in
   * the picture maps to a coordinate `describe` reports.
   */
  const agentRender = async (request: McpRenderRequest): Promise<unknown> => {
    const active = ctx.document()
    if (!active) return { error: 'no-schematic' }

    let frame: Box | null
    if (request.box) {
      frame = boxOfFrame(request.box)
    } else if (request.symbols?.length) {
      const boxes: Box[] = []
      const missing: string[] = []
      for (const reference of request.symbols) {
        const symbol = symbolByReference(reference)
        const definition = symbol ? active.libSymbols.get(symbol.libId) : undefined
        if (!symbol || !definition) {
          missing.push(reference)
          continue
        }
        const chain = libSymbolChain(definition, (name) => active.libSymbols.get(name))
        boxes.push(boxAt(placementGeometry(chain, symbol.unit), symbol.position))
      }
      if (missing.length) {
        return {
          error: 'reference-not-found',
          detail: `No symbol on this sheet is called ${missing.join(', ')}.`,
          candidates: ctx.existingReferences().slice(0, 24)
        }
      }
      const union = unionBoxes(boxes)
      frame = union ? inflateBox(union, RENDER_MARGIN_NM) : null
    } else {
      // The whole drawing means the items, not the page: fitting to everything
      // the engine holds put a 260 × 90 mm sheet in a third of the picture.
      const input = itemsInput()
      const union = input ? unionBoxes(sheetItems(input).map((item) => item.box)) : null
      frame = union ? inflateBox(union, RENDER_MARGIN_NM) : null
    }

    if (request.format === 'svg') {
      if (!ctx.captureSvg)
        return { error: 'renderer-failed', detail: 'This sheet has no scene to write as SVG.' }
      const vector = await ctx.captureSvg(
        frame ? worldBoxOf(frame) : null,
        request.background ?? true
      )
      if (!vector) return { error: 'renderer-failed', detail: 'The sheet has nothing to draw.' }
      const { minX, minY, maxX, maxY } = vector.frame
      const skipped = vector.skipped.typefaceText + vector.skipped.images
      return {
        sheet: sheetRef(),
        revision: ctx.revision(),
        frame: sheetFrameOf({ minX, minY, maxX, maxY }),
        ...(active.paper ? { paper: paperFrame(active.paper) } : {}),
        // One SVG unit is one millimetre, so the picture can be placed at scale.
        units: 'mm',
        ...(skipped
          ? {
              note: `Not in the SVG: ${vector.skipped.typefaceText} TrueType text item(s) and ${vector.skipped.images} image(s), which the editor draws as bitmaps.`
            }
          : {}),
        svg: vector.svg
      }
    }

    const shot = await ctx.capture(frame ? worldBoxOf(frame) : null, request.maxPixels)
    if (!shot)
      return { error: 'renderer-failed', detail: 'The sheet has no viewport to draw into.' }

    const base64 = shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1)
    return {
      sheet: sheetRef(),
      revision: ctx.revision(),
      frame: sheetFrameOf(shot.visible),
      // The page, beside the frame that was drawn. A whole-sheet render frames
      // the CONTENT, which may run past the page; without both an agent reads a
      // frame larger than A3 as a broken render rather than as a block it left
      // off the paper.
      ...(active.paper ? { paper: paperFrame(active.paper) } : {}),
      width: shot.width,
      height: shot.height,
      // Said out loud rather than left to be noticed: a request served at a size
      // it did not ask for, silently, is the defect this op was fixed for.
      ...(shot.limit === undefined
        ? {}
        : {
            note:
              shot.limit.reason === 'texture'
                ? `Drawn at ${shot.limit.pixels}, not ${request.maxPixels}: this GPU draws at most ${shot.limit.texture} pixels a side. Frame a smaller region for more detail.`
                : `Drawn at ${shot.limit.pixels}, not ${request.maxPixels}: a picture this shape exceeds the capture's memory. Frame a smaller region for more detail.`
          }),
      image: { mimeType: 'image/png', base64 },
      guidance:
        'frame is the rectangle shown, in sheet mm: x = frame.x + (px / width) * frame.width. A whole-sheet render frames the items, not the page; frame outside paper.box means items are off the page, which only matters for printing.'
    }
  }

  /**
   * `schematic.add_sheet`: the child file first (not undoable — it is a file on
   * disk), then the `(sheet ...)` node and its pins as one history entry. The
   * order matters: a page that names a file which was never created is a broken
   * hierarchy, while a file with no sheet pointing at it is just an unused file.
   */
  const agentAddSheet = async (request: McpAddSheetRequest): Promise<unknown> => {
    if (ctx.readOnly()) return { error: 'read-only' }
    const input = itemsInput()
    if (!input) return { error: 'no-schematic' }

    const stem = (request.file ?? `${request.name}.kicad_sch`)
      .replace(/\.kicad_sch$/i, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase()
    if (!stem) return { error: 'invalid-args', detail: 'file: a sheet needs a file name.' }
    const fileName = `${stem}.kicad_sch`
    const dir = dirnameOf(ctx.filePath())
    const childPath = `${dir}${separatorOf(ctx.filePath())}${fileName}`
    if (input.schematic.sheets.some((sheet) => getSheetProperty(sheet, 'Sheetfile') === fileName)) {
      return {
        error: 'refused',
        detail: `${fileName} is already a sheet on this page.`
      }
    }

    const pins = (request.pins ?? []).map((pin) => {
      const shape = pin.shape ?? 'passive'
      return { name: pin.name, shape, side: pin.side ?? (shape === 'output' ? 'right' : 'left') }
    })
    const perSide = (side: string): number => pins.filter((pin) => pin.side === side).length
    const rows = Math.max(perSide('left'), perSide('right'))
    const columns = Math.max(perSide('top'), perSide('bottom'))
    const size = request.size
      ? { width: mmToNm(request.size.width), height: mmToNm(request.size.height) }
      : {
          width: gridUp(nm(Math.max(mmToNm(50.8), SHEET_PIN_PITCH * (columns + 2)))),
          height: gridUp(nm(Math.max(mmToNm(25.4), SHEET_PIN_PITCH * (rows + 2))))
        }
    const position = request.at ? mmPoint(request.at) : freeSheetCorner(input, size)
    if (request.at) {
      // The pins are stacked down the edges from this corner at the pin pitch,
      // so a corner on grid puts every pin on it, and one off grid puts none.
      const refused = offGridRefusal(`sheet ${request.name}`, [position], position, 'corner')
      if (refused) return refused
    }

    const created = await ctx.createFile(childPath, blankFileContent('schematic', fileName))
    if (!created.success) {
      return { error: 'write-failed', detail: `Could not create ${fileName}: ${created.error}` }
    }

    const before = agentChecks(request)
    const project = ctx.instanceProjectName()
    // KiCad's GetNextPageNumber: the lowest page the whole design leaves free,
    // one per instance when this sheet is placed more than once.
    const nextPage = pageAllocator(pagesOf(ctx.sheetSources()))
    const instances = ctx.instancePaths().map((path) => ({ project, path, page: nextPage() }))
    ctx.runCommand(ctx.label(tk('commandLabels.addSheet')), () => {
      const target = ctx.document()
      if (!target) return
      addSchematicSheetToAST(target, {
        position,
        size,
        sheetName: request.name,
        sheetFile: fileName,
        instances,
        pins
      })
    })
    ctx.fileCreated(childPath)
    // The sheet tree is resolved on mount; this call just changed it. Re-resolve
    // before the checks below, or the hierarchy rules cannot see the block that
    // was only now created and the answer reports a boundary as fine.
    await ctx.reloadHierarchy()

    const made = ctx
      .document()
      ?.sheets.find((sheet) => getSheetProperty(sheet, 'Sheetfile') === fileName)
    const changes: ChangeRecord[] = [
      {
        id: made?.uuid ?? `sheet@${asMm(position.x)},${asMm(position.y)}`,
        kind: 'sheet'
      }
    ]
    return {
      file: childPath,
      name: request.name,
      box: {
        x: asMm(position.x),
        y: asMm(position.y),
        width: asMm(size.width),
        height: asMm(size.height)
      },
      pins: (made?.pins ?? []).map((pin) => ({
        name: pin.name,
        shape: pin.electricalType,
        at: { x: asMm(pin.position.x), y: asMm(pin.position.y) }
      })),
      sheet: sheetRef(),
      ...agentReport(before, { created: changes, updated: [], deleted: [] }),
      guidance: `${fileName} is open in a background tab; pass it as sheet to draw on it. Give each pin a hierarchical label of the same name in the child with items_create (kind "label", labelKind "hierarchical").`
    }
  }

  /** Round a length up to the pin grid, so a sheet's edges stay on it. */
  const gridUp = (value: Nm): Nm => nm(Math.ceil(value / SHEET_PIN_PITCH) * SHEET_PIN_PITCH)

  /** A corner for a new sheet box: clear to the right of everything drawn, or the
   *  top-left margin on an empty page. */
  const freeSheetCorner = (input: ItemsInput, size: { width: Nm; height: Nm }): Point => {
    void size
    const boxes = sheetItems(input).map((item) => item.box)
    if (!boxes.length) return { x: mmToNm(25.4), y: mmToNm(25.4) }
    const right = boxes.reduce((most, box) => Math.max(most, box.maxX), -Infinity)
    const top = boxes.reduce((least, box) => Math.min(least, box.minY), Infinity)
    return { x: gridUp(nm(right + mmToNm(12.7))), y: gridUp(nm(top)) }
  }

  /**
   * `schematic.set_paper`. Reported, not enforced: the answer says what is now
   * outside the page rather than refusing or moving anything, because a drawing
   * that runs off the paper is a printing question and not a wrong design.
   */
  /**
   * `schematic.annotate`. The same plan and command as the dialog. The answer's
   * `renamed` map is the point: every id the agent holds changes with the run,
   * and a check delta (`checks`) is computed through the map, so a finding that
   * merely moved from R3.1 to R1.1 is neither resolved nor new.
   */
  const agentAnnotate = (request: McpAnnotateRequest): unknown => {
    if (ctx.readOnly() && !request.dryRun) return { error: 'read-only' }
    const active = ctx.document()
    if (!active) return { error: 'no-schematic' }

    let selection: Set<number> | undefined
    if (request.symbols) {
      const wanted = new Set(request.symbols)
      const missing = new Set(request.symbols)
      selection = new Set<number>()
      const sheetPath = ctx.sheetPath()
      active.symbols.forEach((symbol, index) => {
        const reference =
          referenceForSheetPath(symbol, sheetPath) ?? getSymbolProperty(symbol, 'Reference')
        if (reference && wanted.has(reference)) {
          selection!.add(index)
          missing.delete(reference)
        }
      })
      if (missing.size) {
        return {
          error: 'reference-not-found',
          detail: `Not on this sheet: ${[...missing].join(', ')}`,
          candidates: ctx.existingReferences().slice(0, 24)
        }
      }
    }

    const options: AnnotateRequest = {
      scope: request.symbols ? 'selection' : request.scope,
      recurse: request.recurse,
      order: request.order,
      numbering: request.numbering,
      start: request.start,
      reset: request.reset
    }
    const plan = planAnnotation(
      { sources: ctx.sheetSources(), scope: ctx.annotationScope(options), selection },
      options
    )
    const renamed = plan.changes.map((change) => ({
      from: change.from,
      to: change.to,
      ...(samePath(change.filePath, ctx.filePath()) ? {} : { sheet: change.filePath })
    }))
    const summary = {
      renamed,
      counts: { renamed: plan.changes.length, considered: plan.considered },
      sheet: sheetRef()
    }
    const renamedHere = (): ChangeRecord[] =>
      plan.changes
        .filter((change) => samePath(change.filePath, ctx.filePath()))
        .map((change) => ({ id: change.to, kind: 'symbol' }))
    if (request.dryRun) {
      return {
        ...summary,
        dryRun: true,
        ...agentReport(null, { created: [], updated: renamedHere(), deleted: [] }),
        guidance: plan.changes.length
          ? 'Nothing was changed; call again without dryRun to apply this map.'
          : 'Nothing would change: every designator in scope is numbered and unique.'
      }
    }

    // The delta is read through the rename map, so a finding that only moved
    // with its part is neither resolved nor new.
    const map = new Map(plan.changes.map((change) => [change.from, change.to]))
    const renameItem = (item: string): string => {
      const dot = item.indexOf('.')
      const reference = dot < 0 ? item : item.slice(0, dot)
      const to = map.get(reference)
      return to ? `${to}${dot < 0 ? '' : item.slice(dot)}` : item
    }
    const before =
      agentChecks(request)?.map((result) => ({
        ...result,
        items: result.items.map(renameItem)
      })) ?? null
    ctx.applyAnnotationPlan(plan)
    return {
      ...summary,
      ...agentReport(before, { created: [], updated: renamedHere(), deleted: [] }),
      guidance: plan.changes.length
        ? 'Renumbered; sheets without a tab opened in the background, unsaved. Ids from before this call are stale: map them through `renamed` (R3.1 now names whatever R3 became).'
        : 'Nothing changed: every designator in scope was numbered and unique.'
    }
  }

  const agentSetPaper = (request: McpSetPaperRequest): unknown => {
    if (ctx.readOnly()) return { error: 'read-only' }
    const input = itemsInput()
    if (!input) return { error: 'no-schematic' }
    const before = agentChecks(request)
    ctx.runCommand(ctx.label(tk('commandLabels.setPaper')), () => {
      const target = ctx.document()
      if (!target) return
      setSchematicPaper(target, {
        size: request.size,
        ...(request.portrait !== undefined ? { portrait: request.portrait } : {}),
        ...(request.width !== undefined ? { width: request.width } : {}),
        ...(request.height !== undefined ? { height: request.height } : {})
      })
    })
    const paper = ctx.document()?.paper
    if (!paper) {
      return { error: 'invalid-args', detail: `size: ${request.size} is not a page KiCad names.` }
    }
    const outside = sheetItems(itemsInput() ?? input)
      .filter(
        (item) =>
          item.box.minX < 0 ||
          item.box.minY < 0 ||
          item.box.maxX > paper.width ||
          item.box.maxY > paper.height
      )
      .map((item) => item.id)
    return {
      paper: paperFrame(paper),
      ...(outside.length
        ? {
            outside,
            counts: { outside: outside.length }
          }
        : {}),
      sheet: sheetRef(),
      ...agentReport(before, { created: [], updated: [], deleted: [] }),
      guidance: outside.length
        ? 'Set. Items under "outside" fall off the page, which only matters for printing.'
        : 'Set. Everything drawn fits on the page.'
    }
  }

  const agentCheck = (request: McpCheckRequest): unknown => {
    const graph = ctx.connectivity()
    if (!graph) return { error: 'no-schematic' }
    const only = checkCodeFilter(request.codes, CHECK_RULES)
    if (typeof only !== 'function') return only
    const all = projectSeverities(
      allChecks(
        graph,
        ctx.connectivityInputs(),
        ctx.librarySymbolLookup,
        ctx.connectionGrid(),
        ctx.pinMap(),
        ercNaming()
      )
    )
    // History keeps every finding, so a baseline taken with one set of codes
    // answers a later call with another.
    const document = ctx.filePath()
    const revision = ctx.revision()
    const base = request.since !== undefined ? checkHistory.at(document, request.since) : null
    if (request.since !== undefined && !base) return noCheckBaseline(request.since)
    checkHistory.remember(document, revision, all)
    // A named sheet answers for every instance of its file; what is found on
    // other sheets, or on none, is counted.
    const paths = new Set(ctx.instancePaths())
    const onSheet = (entry: CheckResult): boolean =>
      request.sheet === undefined || (entry.sheetPath !== undefined && paths.has(entry.sheetPath))
    const matched = only(all)
    const results = matched.filter(onSheet)
    const elsewhere = matched.length - results.length
    const codes = request.codes ? { codes: request.codes } : {}
    const verdict = (checks: McpCheckAnswer['checks']): McpCheckAnswer => ({
      ok: !results.some((entry) => entry.severity === 'error'),
      checks,
      counts: {
        error: results.filter((entry) => entry.severity === 'error').length,
        warning: results.filter((entry) => entry.severity === 'warning').length,
        ...(request.sheet !== undefined ? { elsewhere } : {})
      },
      revision
    })
    const elsewhereNote =
      request.sheet !== undefined
        ? ` This is the named sheet's findings; counts.elsewhere is the rest of the design's, which schematic_check without sheet lists.`
        : ''
    const sheet = sheetRef()
    if (base)
      return {
        sheet,
        ...codes,
        since: request.since,
        ...verdict(compactDelta(checkDelta(only(base).filter(onSheet), results))),
        guidance: `checks is the change since that revision: new is what broke, resolved what was fixed. Call without since for every finding in full.${elsewhereNote}`
      }
    // One row per rule with every item it names: fifty identical sentences
    // say one thing, and the reader acts on the items.
    // Capped per rule unless codes names the rules, which answers them whole.
    const cap = request.codes ? Infinity : DESCRIBE_CAP
    const rows = withAskedCodes(groupChecks(results), request.codes, CHECK_RULES).map(
      (group): McpCheckRow => ({
        ...group,
        items: group.items.slice(0, cap),
        ...(group.items.length > cap ? { truncated: true } : {})
      })
    )
    return {
      sheet,
      ...codes,
      ...verdict(rows),
      guidance:
        (results.length
          ? 'One row per rule with the pins or nets it names; ok is false while any error remains. A pin open on purpose takes a no-connect flag; a rail nothing drives takes a power symbol or PWR_FLAG.'
          : "No findings from GoatCAD's checks; this is not KiCad's full ERC.") +
        (rows.some((row) => row.truncated)
          ? ` A truncated row lists its first ${DESCRIBE_CAP} items; pass its code in codes for every one.`
          : '') +
        elsewhereNote
    }
  }

  /**
   * One schematic request to the handler that serves it.
   *
   * The map lives here rather than in `App.vue` because `agentBatch` needs it
   * too: a batch is exactly "run these through the same door, without the door
   * writing history each time".
   */
  const agentDispatch = async (request: McpDesignRequest): Promise<unknown> => {
    await ctx.ready()
    const answer = await route(request)
    // An edit reaches the tab store through an emit and a post-flush watch, one
    // tick behind the write. Until it lands, a cross-sheet read on ANOTHER sheet
    // sees this one as it was — a hierarchical label added here would not clear
    // the parent's finding, for a caller quick enough to ask. Settle before
    // answering, so the tick is never the agent's problem to know about.
    await ctx.settle()
    return answer
  }

  /** Each item by id, fingerprinted by its record; nets are left out, as a step's own change is what counts. */
  const itemPrints = (): Map<string, unknown> => {
    const active = ctx.document()
    if (!active) return new Map()
    const input = {
      schematic: active,
      connectivity: null,
      sheetPath: ctx.sheetPath(),
      subpart: ctx.subpart()
    }
    return new Map(sheetItems(input).map((item) => [item.id, JSON.stringify(item.record())]))
  }

  /** Edit ▸ Undo or Redo on the sheet's tab, `steps` times or not at all. */
  const agentStep = (request: McpUndoSheetRequest): unknown => {
    if (ctx.readOnly()) return { error: 'read-only' }
    if (!ctx.document()) return { error: 'no-schematic' }
    const redo = request.redo === true
    const before = itemPrints()
    const stepped = stepHistory(ctx, redo, request.steps, 'The sheet')
    if (!stepped.ok) return { error: stepped.error, detail: stepped.detail }
    return {
      sheet: sheetRef(),
      ...historyAnswer(
        redo,
        stepped.labels,
        changedBetween(before, itemPrints()),
        ctx,
        ctx.revision()
      ),
      guidance: historyGuidance(redo)
    }
  }

  const agentCleanup = (request: McpCleanupRequest): unknown => {
    void request
    if (ctx.readOnly()) return { error: 'read-only' }
    if (!ctx.document()) return { error: 'no-schematic' }
    const before = agentChecks(request)
    const cleanup = ctx.runCommand(ctx.label(tk('commandLabels.cleanup')), () => {}, {
      cleanup: true
    }) ?? {
      wiresRemoved: 0,
      wiresMerged: 0,
      junctionsRemoved: 0,
      junctionsAdded: 0,
      wiresSplit: 0
    }
    return {
      cleanup,
      sheet: sheetRef(),
      ...agentReport(before, emptyChangeSet()),
      guidance: cleanupChanged(cleanup)
        ? 'Tidied; the counts say what was removed and joined.'
        : 'Nothing to tidy.'
    }
  }

  /** A column the design has none of is refused with the ones it has: a
   *  condition on a misspelt field would match every part, or none. */
  const unknownFields = (records: ComponentRecord[], names: string[]): unknown => {
    const unknown = unknownBomFields(records, names)
    if (!unknown.length) return null
    return {
      error: 'field-not-found',
      detail: `No part in the design has a field named ${unknown.map((name) => `"${name}"`).join(', ')}.`,
      candidates: bomFieldNames(records)
    }
  }

  /**
   * `bom.get`. The Components table's records and rows, so the agent and the
   * panel read one BOM. Rows are arrays in column order, because a key repeated
   * on every row of a large board would be most of the answer.
   */
  /**
   * The parts, with `${MODEL}` filled in when the query asks for it.
   *
   * Derived per distinct footprint rather than per part — a board is dozens of
   * parts over a handful of footprints — and only on request, since it reads
   * the library index and the disk.
   */
  const withModelColumn = async (
    records: ComponentRecord[],
    asked: string[]
  ): Promise<ComponentRecord[]> => {
    const wanted = asked.map(canonicalBomField).includes(BOM_FIELD_MODEL)
    if (!wanted || !ctx.footprintModelStatus) return records
    const footprintOf = (record: ComponentRecord): string => {
      const value = (record.fields.Footprint ?? '').trim()
      return value === '~' ? '' : value
    }
    const status = await ctx.footprintModelStatus([
      ...new Set(records.map(footprintOf).filter(Boolean))
    ])
    return records.map((record) => {
      const footprint = footprintOf(record)
      return {
        ...record,
        fields: {
          ...record.fields,
          [BOM_FIELD_MODEL]: footprint ? (status[footprint] ?? 'unknown') : ''
        }
      }
    })
  }

  const agentGetBom = async (request: McpGetBomRequest): Promise<unknown> => {
    if (!ctx.document()) return { error: 'no-schematic' }
    const parts = buildProjectComponentRecords(ctx.sheetSources())
    const records = await withModelColumn(parts, [
      ...(request.fields ?? []),
      ...(request.groupBy ?? []),
      ...(request.where ?? []).map((filter) => filter.field),
      ...(request.sortBy ? [request.sortBy] : [])
    ])
    const refusal = unknownFields(records, [
      ...(request.fields ?? []),
      ...(request.groupBy ?? []),
      ...(request.where ?? []).map((filter) => filter.field),
      ...(request.sortBy ? [request.sortBy] : [])
    ])
    if (refusal) return refusal
    const table = projectBom(records, {
      fields: request.fields,
      groupBy: request.groupBy,
      where: request.where,
      sortBy: request.sortBy,
      limit: request.limit ?? DESCRIBE_CAP
    })
    return {
      ...table,
      available: bomFieldNames(records),
      revision: ctx.revision(),
      ...(table.total > table.rows.length
        ? {
            truncated: true,
            guidance: `The first ${table.rows.length} of ${table.total} rows. Narrow with where, merge with groupBy, or raise limit.`
          }
        : {})
    }
  }

  /**
   * `schematic.update_symbols`: the editor's Update / Change symbols
   * (`updateSymbolsWithWires`) over the parts a request names, across every
   * sheet, as one step under the dialog's label. The answer's pin rows come
   * from the same edit run on copies (`symbolUpdateAgent.ts`).
   */
  const agentUpdateSymbols = async (
    request: McpUpdateSymbolsSchematicRequest
  ): Promise<unknown> => {
    if (ctx.readOnly() && !request.dryRun) return { error: 'read-only' }
    if (!ctx.document()) return { error: 'no-schematic' }
    const change = request.symbol?.trim() || null
    const options: SymbolUpdateOptions = {
      ...(change ? CHANGE_DEFAULTS : UPDATE_DEFAULTS),
      ...request.options
    }
    const lookup = ctx.librarySymbolLookup
    const selection = {
      ...(request.references ? { references: request.references } : {}),
      ...(request.match ? { match: request.match } : {}),
      change
    }
    // The libraries load before the write, which is synchronous: every lib id
    // the targets could take, read once.
    const unread = planSymbolUpdate(ctx.sheetSources(), selection, () => undefined).notFound
    for (const libId of new Set(change ? [change] : unread.map((miss) => miss.libId))) {
      if (!lookup(libId)) await ctx.ensureStandardLibrary(libId).catch(() => {})
    }
    if (change && !lookup(change))
      return {
        error: 'unknown-symbol',
        detail: `No library holds ${change}. Find its lib id with symbol_search.`
      }
    const plan = planSymbolUpdate(ctx.sheetSources(), selection, lookup, ctx.subpart())
    if (plan.missing.length)
      return {
        error: 'reference-not-found',
        detail: `No part in the design is ${plan.missing.join(', ')}.`,
        candidates: plan.references.slice(0, 24)
      }
    if (!plan.parts.length) {
      if (plan.skipped.length)
        return {
          error: 'too-few-units',
          detail: `${plan.skipped.map((unit) => `${unit.libId} has no unit for ${unit.id}`).join('; ')}; nothing was written.`
        }
      if (plan.notFound.length)
        return {
          error: 'unknown-symbol',
          detail: `No library holds ${[...new Set(plan.notFound.map((miss) => miss.libId))].join(', ')}; nothing was written.`
        }
      const libIds = new Set(
        ctx
          .sheetSources()
          .flatMap((source) => source.schematic.symbols.map((symbol) => symbol.libId))
      )
      return {
        error: 'nothing-to-update',
        detail: request.match
          ? `No symbol in the design has the lib id ${request.match}; nothing was written.`
          : 'The design has no symbol to update; nothing was written.',
        candidates: [...libIds].slice(0, 24)
      }
    }

    const grid = ctx.gridStep()
    const outcome = simulateSymbolUpdate(
      plan,
      ctx.connectivityInputs(),
      ctx.connectivity(),
      lookup,
      options,
      grid
    )
    const answer = {
      symbols: outcome.rows,
      counts: {
        updated: outcome.rows.length,
        current: outcome.current.length,
        skipped: plan.skipped.length
      },
      ...(plan.skipped.length ? { skipped: plan.skipped } : {}),
      ...(plan.notFound.length ? { notFound: plan.notFound } : {})
    }
    const changed: ChangeSet = {
      created: [],
      updated: outcome.rows.map((row) => ({ id: row.reference, kind: 'symbol' })),
      deleted: []
    }
    const left = outcome.rows.some((row) => row.unwiredPins || row.droppedPins)
    const kept = plan.skipped.length
      ? ' Each skipped unit has no counterpart in the new symbol and stays on its old one; delete it with items_delete if the part should not keep it.'
      : ''
    const guidance = `${
      left
        ? 'unwiredPins and droppedPins left their wires: rewire them with schematic_wire or schematic_connect.'
        : 'No pin left its wire; movedPins took their wires along.'
    }${kept}`
    if (request.dryRun)
      return {
        ...answer,
        changed: changedIds(changed),
        dryRun: true,
        revision: ctx.revision(),
        sheet: sheetRef(),
        guidance: `Nothing was written. ${guidance}`
      }
    const before = agentChecks(request)
    if (outcome.rows.length) {
      const count = plan.files.reduce((sum, file) => sum + file.targets.length, 0)
      ctx.applyDocumentEdits(
        ctx.label(
          change ? tk('commandLabels.changeSymbols') : tk('commandLabels.updateSymbols'),
          count
        ),
        plan.files.map(({ filePath, targets }) => ({
          filePath,
          apply: (document: KicadSchematic) => {
            updateSymbolsWithWires(document, targets, lookup, options, grid)
          }
        })),
        { cleanup: true }
      )
    }
    return {
      ...answer,
      sheet: sheetRef(),
      ...agentReport(before, changed),
      guidance: outcome.rows.length
        ? `One undo step, unsaved. ${guidance}`
        : `Nothing changed: every ${kept ? 'other ' : ''}target already matches its library symbol.${kept}`
    }
  }

  /**
   * `bom.update`. One command across every sheet the matched parts sit on,
   * through the edit path annotate and the Components table share. The answer
   * names every non-empty value it replaced, because a write by condition is
   * the one edit whose reach the caller did not list.
   */
  const agentUpdateBom = (request: McpUpdateBomRequest): unknown => {
    if (ctx.readOnly() && !request.dryRun) return { error: 'read-only' }
    if (!ctx.document()) return { error: 'no-schematic' }
    const records = buildProjectComponentRecords(ctx.sheetSources())
    const refusal = unknownFields(
      records,
      (request.where ?? []).map((filter) => filter.field)
    )
    if (refusal) return refusal
    const fields = request.fields ?? {}
    const known = bomFieldNames(records)
    for (const name of Object.keys(fields)) {
      const spelled = known.find(
        (candidate) => candidate !== name && candidate.toLowerCase() === name.toLowerCase()
      )
      if (spelled) {
        return {
          error: 'field-spelling',
          detail: `The design spells "${name}" as "${spelled}".`,
          candidates: [spelled]
        }
      }
    }

    const plan = planBomUpdate(
      records,
      { references: request.references, where: request.where },
      request
    )
    if (plan.missing.length) {
      return {
        error: 'reference-not-found',
        detail: `No part in the design is ${plan.missing.join(', ')}.`,
        candidates: records
          .map((record) => record.reference)
          .sort(compareReferencesNatural)
          .slice(0, 24)
      }
    }
    if (request.expect !== undefined && plan.matched.length !== request.expect) {
      const matched = compressReferences(plan.matched.map((record) => record.reference))
      return {
        error: 'count-mismatch',
        detail: `The target matched ${plan.matched.length} parts, not ${request.expect}${matched ? `: ${matched}` : ''}.`
      }
    }

    const changed: McpChanged = {
      created: [],
      updated: [...new Set(plan.changed.map((record) => record.reference))],
      deleted: []
    }
    const answer = {
      changed,
      counts: { matched: plan.matched.length, parts: plan.changed.length },
      ...(plan.overwritten.length
        ? {
            overwrote: plan.overwritten.map((entry) => ({
              field: entry.field,
              was: entry.was,
              references: compressReferences(entry.references)
            }))
          }
        : {})
    }
    if (request.dryRun) {
      return {
        ...answer,
        dryRun: true,
        revision: ctx.revision(),
        guidance: 'Nothing was changed; call again without dryRun to apply it.'
      }
    }
    if (plan.changed.length) {
      const edits = plan.changed.flatMap((record) =>
        record.locations.map((location): SymbolEdit => ({
          filePath: location.filePath,
          symbolIndex: location.symbolIndex,
          apply: (symbol) => {
            for (const [key, value] of Object.entries(fields)) {
              setSchematicSymbolProperty(symbol, key, value)
            }
            if (request.dnp !== undefined) setSchematicSymbolFlag(symbol, 'dnp', request.dnp)
            if (request.inBom !== undefined) {
              setSchematicSymbolFlag(symbol, 'in_bom', request.inBom)
            }
            if (request.onBoard !== undefined) {
              setSchematicSymbolFlag(symbol, 'on_board', request.onBoard)
            }
          }
        }))
      )
      ctx.applySymbolEdits(
        ctx.label(tk('commandLabels.editComponents'), plan.changed.length),
        edits
      )
    }
    return {
      ...answer,
      revision: ctx.revision(),
      guidance: plan.changed.length
        ? 'Written as one undo step; sheets without a tab opened in the background, unsaved. `overwrote` lists every non-empty value replaced.'
        : 'Nothing changed: every matched part already had these values.'
    }
  }

  const route = async (request: McpDesignRequest): Promise<unknown> => {
    switch (request.kind) {
      case 'describe-schematic':
        return agentDescribe(request)
      case 'get-bom':
        return agentGetBom(request)
      case 'update-bom':
        return agentUpdateBom(request)
      case 'update-symbols-schematic':
        return agentUpdateSymbols(request)
      case 'get-items':
        return agentItemsGet(request)
      case 'query-items':
        return agentItemsQuery(request)
      case 'update-item':
        return agentItemsUpdate(request)
      case 'delete-items':
        return agentItemsDelete(request)
      case 'create-item':
        return agentItemsCreate(request)
      case 'place-symbol':
        return agentPlace(request)
      case 'bind-part':
        return agentBind(request)
      case 'connect-pins':
        return agentConnect(request)
      case 'draw-wire':
        return agentWire(request)
      case 'check-schematic':
        return agentCheck(request)
      case 'render-sheet':
        return agentRender(request)
      case 'add-sheet':
        return agentAddSheet(request)
      case 'set-paper':
        return agentSetPaper(request)
      case 'cleanup-schematic':
        return agentCleanup(request)
      case 'annotate-schematic':
        return agentAnnotate(request)
      case 'undo-sheet':
        return agentStep(request)
      default:
        return { error: 'renderer-failed', detail: `${request.kind} is not a sheet operation` }
    }
  }

  /**
   * One operation's answer as it appears inside a batch: what it made, without
   * the check delta, revision, sheet and guidance every answer carries on its
   * own. The batch says those once. Fifty places answered fifty deltas before
   * this, at 80 KB.
   */
  const batchEntry = (payload: unknown): unknown => {
    if (!payload || typeof payload !== 'object') return payload
    return omitKeys(payload as Record<string, unknown>, ['checks', 'revision', 'sheet', 'guidance'])
  }

  const failureOf = (
    payload: unknown
  ): { error: string; detail?: string; candidates?: string[] } | null => {
    const candidate = payload as { error?: unknown; detail?: string; candidates?: string[] } | null
    return candidate && typeof candidate === 'object' && typeof candidate.error === 'string'
      ? {
          error: candidate.error,
          detail: candidate.detail,
          ...(candidate.candidates?.length ? { candidates: candidate.candidates } : {})
        }
      : null
  }

  /**
   * N edits, one history entry — or none at all.
   *
   * Atomicity is the context's (`SheetAgentContext.batch`), and it is free
   * there: the command layer stores whole document snapshots, so "roll back" is
   * "re-parse the text we started from" and a partially applied batch is not a
   * state this code can be in. `dryRun` is the same move with the entry never
   * pushed, which is what lets a script test a placement before committing it.
   */
  const agentBatch = async (request: McpBatchRequest): Promise<unknown> => {
    if (ctx.readOnly()) return { error: 'read-only' }
    if (!ctx.document()) return { error: 'no-schematic' }

    await ctx.ready()
    const before = agentChecks(request)

    const results: unknown[] = []
    const touched: McpChanged[] = []
    let failed: {
      index: number
      failure: { error: string; detail?: string; candidates?: string[] }
    } | null = null

    batching += 1
    const outcome = await ctx
      .batch(ctx.label(tk('commandLabels.agentBatch'), request.ops.length), async () => {
        for (let index = 0; index < request.ops.length; index += 1) {
          const payload = await agentDispatch(request.ops[index])
          const failure = failureOf(payload)
          if (failure) {
            failed = { index, failure }
            break
          }
          const changed = (payload as { changed?: McpChanged } | null)?.changed
          if (changed) touched.push(changed)
          results.push(batchEntry(payload))
        }
        // The delta is computed against the state the batch produced; on a dry
        // run that state is then discarded — which is the whole point of asking.
        return {
          result: before ? compactDelta(checkDelta(before, runAgentChecks())) : null,
          keep: failed === null && request.dryRun !== true
        }
      })
      .finally(() => {
        batching -= 1
      })
    const checks = outcome.result

    if (failed) {
      const { index, failure } = failed as {
        index: number
        failure: { error: string; detail?: string; candidates?: string[] }
      }
      const name = request.names?.[index] ?? request.ops[index].kind
      return {
        error: failure.error,
        detail: `Operation ${index} (\`${name}\`): ${failure.detail ?? failure.error}. The batch rolled back; nothing was written.`,
        ...(failure.candidates ? { candidates: failure.candidates } : {})
      }
    }
    const changed = netChanged(touched)
    const wrote = changed.created.length + changed.updated.length + changed.deleted.length > 0
    return {
      ...(request.dryRun ? { dryRun: true } : {}),
      results,
      changed,
      ...(checks ? { checks } : {}),
      revision: ctx.revision(),
      sheet: sheetRef(),
      guidance: request.dryRun
        ? 'Nothing was written; run again without dryRun to commit it.'
        : wrote || outcome.changed
          ? 'Every op succeeded; the batch is one undo step.'
          : 'Every op succeeded; none changed the sheet.'
    }
  }

  /** Each item's box by id, sheet mm, for a viewport framing a write; empty before the sheet is read. */
  const itemFrames = (): Map<string, SheetFrame> => {
    const input = itemsInput()
    const frames = new Map<string, SheetFrame>()
    if (input)
      for (const item of sheetItems(input)) frames.set(item.id, sheetFrameOf(worldBoxOf(item.box)))
    return frames
  }

  const designInputs = async (): Promise<DesignInputs | null> => {
    if (!ctx.document()) return null
    await ctx.ready()
    const connectivity = ctx.connectivity()
    if (!connectivity) return null
    return { sheets: ctx.sheetSources(), inputs: ctx.connectivityInputs(), connectivity }
  }

  return {
    designInputs,
    describe: agentDescribe,
    place: agentPlace,
    bind: agentBind,
    connect: agentConnect,
    check: agentCheck,
    render: agentRender,
    dispatch: agentDispatch,
    batch: agentBatch,
    itemFrames
  }
}
