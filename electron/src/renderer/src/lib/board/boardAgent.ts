/**
 * The agent's door to a board: `board.describe`, `board.sync`, `board.batch`,
 * `board.refill`, `board.check`, the routing sessions (`route.*`, over
 * `routeAgent.ts`) and the `items.*` ops with a `board` argument,
 * served by the window over the board's session, or its tab buffer or disk
 * copy for a read when no tab holds it.
 *
 * Every write runs through the board's session (`boardSession.ts`), opened
 * behind the active tab when none holds it, so it is one step on the editor's
 * undo list and the tab goes dirty like a hand edit. The edits themselves are
 * `boardItems.ts`, over the mutators the editor's own commands call. A write
 * answers with what changed, the DRC delta and the revision, as every door
 * does (`docs/agent-api.md`).
 *
 * Zone fills are not refilled by a write: every zone is marked stale in the
 * session (which zones an edit changes is not known well enough to name
 * fewer), the answer says the fills are stale, and the fill-dependent rules
 * are left out of the delta until `board.refill` (or the open editor's own
 * refill) rewrites them — derived work that can take seconds on a dense board
 * is the caller's to ask for, never a hidden cost of a move.
 */
import { activeFindings } from '../kicadExclusions'
import type {
  McpBatchBoardRequest,
  McpChanged,
  McpCheckAnswer,
  McpPlaced,
  McpPlacedTerminal,
  McpWriteAnswer,
  McpCheckBoardRequest,
  McpExplainBoardLimitsRequest,
  McpCreateBoardItemRequest,
  McpDeleteBoardItemsRequest,
  McpDescribeBoardRequest,
  McpDesignRequest,
  McpFanoutBoardRequest,
  McpCleanupBoardRequest,
  McpSetTeardropsBoardRequest,
  McpBeginRouteRequest,
  McpStepRouteRequest,
  McpPreviewRouteRequest,
  McpFinishRoutesRequest,
  McpRouteGesture,
  McpPlaceFootprintBoardRequest,
  McpUpdateFootprintsBoardRequest,
  McpGetBoardItemsRequest,
  McpGetBoardSetupRequest,
  McpUpdateBoardSetupRequest,
  McpApplyInterfacePresetRequest,
  McpQueryBoardItemsRequest,
  McpRefillBoardRequest,
  McpRenderBoardRequest,
  McpRenderBoard3DRequest,
  McpSyncBoardRequest,
  McpUpdateBoardItemRequest,
  McpUpdateTuningPatternsBoardRequest,
  McpTransformBoardItemsRequest,
  McpUndoBoardRequest
} from '../../../../preload/mcpTypes'
import {
  parseKicadBoard,
  remapKicadBoard,
  rotateBoardFootprintInAST,
  serializeKicadBoard,
  setBoardOriginInAST,
  setBoardStackupInAST,
  setZoneFilledPolysInAST,
  updateBoardMetaInAST,
  type KicadBoard,
  type KicadBoardFootprint,
  type KicadBoardZone,
  type KicadTrackArc,
  type KicadTrackSegment,
  type KicadTuningPattern,
  type KicadVia,
  type TuningPatternData
} from '../kicad/board'
import { beginNodeCapture, endNodeCapture, type SExprList, type SExprNode } from '../kicad/sexpr'
import { computeConnectivity } from './boardConnectivity'
import { applyNetChanges, propagationFor } from './netPropagation'
import type { SchematicNetlist } from './schematicNetlist'
import type { BoardLibraries } from './boardLibraries'
import { BOARD_CHECK_RULES, BOARD_KICAD_KEYS, boardCheckRun } from './boardChecks'
import type { BoardCheckRun, BoardEdit } from './drc/incremental'
import {
  CheckHistory,
  checkCodeFilter,
  withAskedCodes,
  checkDelta,
  compactDelta,
  groupChecks,
  FINDINGS_PER_RULE,
  noCheckBaseline,
  type CheckResult
} from '../schematic/checks'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  defaultNetClass,
  netClassForNet,
  patchBoardSetupChoice,
  patchDesignSettings,
  patchTuningPatternSettings,
  patchTuningProfiles,
  tuningSettingsOf,
  patchRuleSeverities,
  customRulesPath,
  type BoardDesignSettings
} from '../kicad/project'
import {
  applyBoardSync,
  boardOutlineBox,
  footprintPath,
  netsInUse,
  planBoardSync,
  scopePlan,
  unannotatedReferences,
  type SyncDesign,
  type SyncPlan
} from './boardSync'
import { syncWouldChange } from './syncPreview'
import { applyStackupEdits } from './stackupEdits'
import { mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import { placeFootprintNode, placedReference } from './footprintPlace'
import {
  CHANGE_DEFAULTS,
  UPDATE_DEFAULTS,
  exchangeFootprints,
  isSymbolOwned,
  type ExchangeReport
} from './footprintExchange'
import { insertIntoBoard } from './pcbClipboard'
import type { KicadFootprint } from '../kicad/footprint'
import { BoardSpatialIndex } from './spatialIndex'
import { tk, type MessageKey } from '../messageKey'
import type { AgentCapture } from '../schematic/schematicAgent'
import type { BoardCaptureRequest } from '../engine/boardCapture'
import type { Board3DCaptureRequest, Board3DCaptureResult } from '../engine/board3d/boardCapture3D'
import { VIEW_BEARINGS } from '../engine/board3d/viewBearings'
import type { BoardSession } from './boardSession'
import { cappedGuidance } from '../queryPage'
import { boardField, boardFieldIds, boardFieldRecord, updateBoardField } from './boardFields'
import {
  boardItems,
  mmBox,
  boardNarrowings,
  createItem,
  deleteItems,
  itemRecord,
  itemRow,
  queryItems,
  resolveItem,
  resolveWritable,
  tuningPatternUpdate,
  updateItem,
  zoneKey,
  boardItemIds,
  type BoardEditDefaults,
  type BoardItem,
  type BoardItemQuery,
  type ItemFailure
} from './boardItems'
import { computeRefill, fillable } from './zoneRefill'
import { applyTeardropEdit, type TeardropEdit, type TeardropEditResult } from './teardrop/edit'
import { applyTeardropPlan, clearLegacyTeardrops, planTeardrops } from './teardrop/manager'
import { boardIndex } from './spatialIndex'
import type { KicadPad } from '../kicad/footprint'
import {
  extractTeardropSettings,
  patchTeardropSettings,
  type TeardropSettings
} from './teardrop/params'
import { planRetunes, retuneRow, writeRetunes } from './patternRetune'
import { drainSteps } from '../geometry/regionClips'
import { transformBoardItemsById, type TransformFailure } from './boardItemsTransform'
import { boardRules } from './rules/boardRules'
import { explainLimits, explainTarget, type ExplainTarget } from './rules/explain'
import {
  BOARD_SETUP_SECTIONS,
  MATCHED_NETS_CAP,
  boardSetupRecord,
  planBoardSetup,
  severityCounts,
  stackupSpecOf,
  type BoardSetupSection,
  type SetupPlan
} from './boardSetup'
import { copperNamesFor } from './boardSetupSchema'
import { assignableNets } from './netClassCoverage'
import { solverStackupOf } from './impedance'
import { planInterfacePreset, presetRuleNames, stackupSolver } from './interfacePresets'
import { patchRules } from './rules/druRules'
import { DRC_CATALOG } from './drcCatalog'
import { applyFanout, fanoutRulesOf, planFanout, type FanoutPlan } from './fanout'
import {
  DEFAULT_CLEANUP_OPTIONS,
  applyTrackCleanup,
  planTrackCleanup,
  type CleanupPlan,
  type CleanupScope,
  type TrackRef
} from './trackCleanup'
import {
  AgentRouteSession,
  DEFAULT_FOLLOW,
  RouteRefused,
  boardPt,
  gestureShape,
  roundMm,
  routePrefsWith,
  viewWith,
  type RouteEnv,
  RouteRun,
  type RouteViewState,
  type RouteWorkScene
} from './routeAgent'
import { routeToolSpec } from './routeAgentTools'
import { netLengthRows } from './tuneTool'
import { createRouteState, routerWorldOf, type RouteSetup } from './routeController'
import { applyRouterDelta } from './routeLanding'
import { carriedTracks } from './router/componentDrag'
import {
  CLOSED_BY_AGENT,
  changedFrame,
  createAgentViewports,
  type AgentViewports
} from '../agentViewports'
import { changedBetween, historyAnswer, historyGuidance, stepHistory } from '../historyStep'
import type { ViewportFrame } from '../agentViewportView'
import { routerSettings } from '../pcbRouter'
import type { PcbRouterState } from '../../../../preload/pcbRouterTypes'
import type { WorldBox } from '../schematic/schematicAgent'

import { loadClipper } from '../geometry/clip'
import {
  DIM_ALPHA_FACTOR,
  PCB_LAYER_STACK,
  boardLayerFlipper,
  isCopperLayer
} from '../kicad/layers'
import { boardRenderPresetLayers } from './renderPresets'

type BoardRequest =
  | McpDescribeBoardRequest
  | McpSyncBoardRequest
  | McpRenderBoardRequest
  | McpRenderBoard3DRequest
  | McpCheckBoardRequest
  | McpExplainBoardLimitsRequest
  | McpGetBoardItemsRequest
  | McpQueryBoardItemsRequest
  | McpUpdateBoardItemRequest
  | McpDeleteBoardItemsRequest
  | McpCreateBoardItemRequest
  | McpTransformBoardItemsRequest
  | McpBatchBoardRequest
  | McpRefillBoardRequest
  | McpFanoutBoardRequest
  | McpCleanupBoardRequest
  | McpSetTeardropsBoardRequest
  | McpBeginRouteRequest
  | McpStepRouteRequest
  | McpPreviewRouteRequest
  | McpFinishRoutesRequest
  | McpPlaceFootprintBoardRequest
  | McpUpdateFootprintsBoardRequest
  | McpUpdateTuningPatternsBoardRequest
  | McpGetBoardSetupRequest
  | McpUpdateBoardSetupRequest
  | McpApplyInterfacePresetRequest
  | McpUndoBoardRequest

/** The item requests a board batch holds. */
type ItemRequest =
  | McpGetBoardItemsRequest
  | McpQueryBoardItemsRequest
  | McpUpdateBoardItemRequest
  | McpDeleteBoardItemsRequest
  | McpCreateBoardItemRequest
  | McpTransformBoardItemsRequest

/** What a board batch holds: the item requests, and placing a footprint. */
type BatchEntry = ItemRequest | McpPlaceFootprintBoardRequest

/** Each batch entry's op, as the failure detail names it. */
const OP_NAMES: Record<BatchEntry['kind'], string> = {
  'get-board-items': 'items.get',
  'query-board-items': 'items.query',
  'update-board-item': 'items.update',
  'delete-board-items': 'items.delete',
  'create-board-item': 'items.create',
  'transform-board-items': 'items.transform',
  'place-footprint-board': 'board.place_footprint'
}

const BOARD_KINDS: ReadonlySet<string> = new Set<BoardRequest['kind']>([
  'describe-board',
  'sync-board',
  'render-board',
  'render-board-3d',
  'check-board',
  'explain-board-limits',
  'get-board-items',
  'query-board-items',
  'update-board-item',
  'delete-board-items',
  'create-board-item',
  'transform-board-items',
  'batch-board',
  'refill-board',
  'fanout-board',
  'cleanup-board',
  'set-teardrops-board',
  'begin-route',
  'step-route',
  'preview-route',
  'finish-routes',
  'place-footprint-board',
  'update-footprints-board',
  'update-tuning-patterns-board',
  'get-board-setup',
  'update-board-setup',
  'apply-interface-preset',
  'undo-board'
])

const BATCH_KINDS: ReadonlySet<string> = new Set<BatchEntry['kind']>([
  'get-board-items',
  'query-board-items',
  'update-board-item',
  'delete-board-items',
  'create-board-item',
  'transform-board-items',
  'place-footprint-board'
])

/** Whether this door serves the request; the window asks before the sheet is resolved. */
export const isBoardRequest = (request: McpDesignRequest): request is BoardRequest =>
  BOARD_KINDS.has(request.kind)

/** What the door reads through and writes with. The window supplies the real
 *  ones; a test supplies fakes. */
export interface BoardAgentContext {
  /** The project's board files, absolute paths. */
  boardFiles(): string[]
  /** Resolve a name an agent gave — absolute, or bare — to one of them, or null. */
  resolveBoard(name: string): string | null
  /** The board's live text: its tab buffer, else its disk copy; null when unreadable. */
  boardText(path: string): Promise<string | null>
  /** Land new text for a board file in its tab buffer, when no session can take the edit. */
  commitBoard(path: string, content: string, loaded: string): void
  /** The schematic side of the project, or null when it has no schematic. */
  design(): Promise<SyncDesign | null>
  /** The schematic's netlist as the board checks read it, live; null with no schematic. */
  schematicNetlist?(): Promise<SchematicNetlist | null>
  /** A library footprint by id, parsed, or null when no library holds it. */
  loadFootprint(libId: string): Promise<KicadFootprint | null>
  /**
   * The footprint libraries a board's footprints came from, as the board
   * editor loads them for its checks; absent where none can be read.
   */
  boardLibraries?(board: KicadBoard): Promise<BoardLibraries>
  /** Keep an open board's document loaded while an operation runs on it; returns the release. */
  hold(path: string): () => void
  /** The board's session when a tab already holds one; opens nothing. */
  openSession(path: string): BoardSession | null
  /** The board's session, loaded, its tab opened behind the active one when none holds it. */
  session(path: string): Promise<BoardSession | null>
  /** A command label in the user's language. */
  label(key: MessageKey, values?: number | Record<string, string>): string
  /** Draw a parsed board off-screen; null when the window has no viewport. */
  capture(board: KicadBoard, request: BoardCaptureRequest): Promise<AgentCapture | null>
  /** Render a parsed board in 3D off-screen, its models resolved beside `path`. */
  capture3D(
    board: KicadBoard,
    path: string,
    request: Board3DCaptureRequest
  ): Promise<Board3DCaptureResult>
  /** The rules and net classes of the board's project; null for a board with no `.kicad_pro`. */
  designSettings(path: string): Promise<BoardDesignSettings | null>
  /** The board's project file, or null for a board with none. */
  projectFile(path: string): Promise<string | null>
  /** A file's text from disk, or null. */
  readText(path: string): Promise<string | null>
  /** Write the project file and tell every open view it changed, as Board Setup does. */
  writeProject(path: string, content: string): Promise<boolean>
  readOnly(): boolean
  /** The person's router preferences, which a routing session starts from and never writes. */
  routerPrefs?(): PcbRouterState
  /** The board's *Use starting track width* (R1): its editor's, else its project's `.kicad_prl`. */
  autoTrackWidth?(path: string): Promise<boolean>
  /** The person's board grid step, mm: a routing session's default. */
  gridSpacing?(): number
  /** A scene for a routing session's pictures; absent where the window has no viewport. */
  routeScene?(): RouteWorkScene
  /** The window's agent viewports, where a render or a routing session shows the person its work. */
  viewports?: AgentViewports
}

/** A refusal, as every door answers one. */
export interface BoardAgentError {
  error: string
  detail?: string
  candidates?: string[]
}

/** What a sync would do to one board — the dry run a person reads before applying. */
export interface SyncPreview {
  board: string
  plan: SyncPlan
}

export interface BoardAgent {
  dispatch(request: BoardRequest): Promise<unknown>
  /** The plan `sync-board` would apply to a board (the project's only one when unnamed). */
  previewSync(board?: string): Promise<SyncPreview | BoardAgentError>
}

const mm = (value: Nm | number): number => Math.round(nmToMm(value as Nm) * 1000) / 1000

/** A read or delete's filter and page as the item query takes it. */
const boardQueryOf = (
  request: Omit<BoardItemQuery, 'kind'> & { itemKind?: BoardItemQuery['kind'] }
): BoardItemQuery => ({
  ...(request.itemKind ? { kind: request.itemKind } : {}),
  ...(request.layer ? { layer: request.layer } : {}),
  ...(request.net !== undefined ? { net: request.net } : {}),
  ...(request.box ? { box: request.box } : {}),
  ...(request.near ? { near: request.near } : {}),
  ...(request.radius !== undefined ? { radius: request.radius } : {}),
  ...(request.limit !== undefined ? { limit: request.limit } : {}),
  ...(request.offset !== undefined ? { offset: request.offset } : {})
})

/** A captured picture's data URL as an answer's image. */
const png = (dataUrl: string): { mimeType: 'image/png'; base64: string } => ({
  mimeType: 'image/png',
  base64: dataUrl.slice(dataUrl.indexOf(',') + 1)
})

/** How every answer names the board it is of. */
const boardRef = (path: string): { path: string; name: string } => ({
  path,
  name: path.split(/[\\/]/).pop() ?? path
})

const sideOf = (footprint: KicadBoardFootprint): 'front' | 'back' =>
  footprint.layer === 'B.Cu' ? 'back' : 'front'

/** The board's references most like the ones that missed: same prefix first. */
const nearestReferences = (board: KicadBoard, missing: readonly string[]): string[] => {
  const references = board.footprints.map((fp) => fp.reference ?? '').filter(Boolean)
  const prefixes = new Set(missing.map((reference) => reference.replace(/\d.*$/, '')))
  const alike = references.filter((reference) => prefixes.has(reference.replace(/\d.*$/, '')))
  return (alike.length ? alike : references).slice(0, 24)
}

/** Pad rows a placement answers with; past that, `padCount`. */
const PLACED_PAD_CAP = 64

/** Footprint rows a describe answers with in full; past that, counts. */
const DESCRIBE_CAP = 400

/** Revisions `describe({ since })` can diff against, per board. */
const DESCRIBE_MEMORY = 8

/**
 * The time `board.refill` spends filling before it commits what it has: the
 * bridge gives a call 30 s, and the checks after it need their share (some
 * 6 s on KiCad's Jetson demo, whose whole refill is some 15 s).
 */
const REFILL_BUDGET_MS = 10_000

/**
 * The rules whose findings read the stored fills beyond the zones they name:
 * connectivity runs through the pour, so a stale one can hide or invent an
 * unrouted pad, an island, a starved thermal or a dangling end.
 */
const FILL_RULES: ReadonlySet<string> = new Set([
  'unconnected-items',
  'isolated-copper',
  'starved-thermal',
  'track-dangling',
  'via-dangling'
])

/** A routing session idle this long ends, its scene released. */
const ROUTE_SESSION_IDLE_MS = 10 * 60_000

/** How often live routing sessions are checked for a closed board or an idle timeout. */
const ROUTE_SWEEP_MS = 30_000

/** A routing session's picture, longest edge: small, as a working view is read often. Main's `route.begin` sends its own default (`ROUTE_MAX_PIXELS`). */
const ROUTE_DEFAULT_MAX_PIXELS = 768

/** Each candidate's tile in a preview's picture; main's `ROUTE_PREVIEW_TILE`. */
const ROUTE_PREVIEW_TILE_PIXELS = 512

/** Ended sessions whose reason a late call is still told. */
const ENDED_ROUTE_MEMORY = 16

/** The unjoined copper a routing answer lists, nearest first. */
const ROUTE_TARGET_CAP = 8

/** The grid a routing session snaps to when the window gives none: the PCB editor's default, mm. */
const DEFAULT_ROUTE_GRID = 0.25

const DEFAULT_ROUTE_VIEW: RouteViewState = {
  otherLayers: 'dim',
  side: 'front',
  follow: DEFAULT_FOLLOW,
  ratsnest: true,
  highlight: true
}

/** Board mm round what a write changed, in its viewport's frame: the neighbors show. */
const WRITE_FRAME_MARGIN_MM = 2

const WRITE_GUIDANCE = 'One undo step on the board tab, now unsaved; workspace_save writes it.'

/** What a board picture says when its own zone fills had not all landed in time (`AgentCapture.unfinishedFills`). */
const unfinishedNote = (fills: number): string =>
  fills === 1
    ? 'One zone fill was still being drawn when the picture was taken and is missing from it. Render again to draw it.'
    : `${fills} zone fills were still being drawn when the picture was taken and are missing from it. Render again to draw them.`

/** The `incomplete` and `note` fields of a board picture's answer; `note` joins any other note. */
const pictureNotes = (fills: number | undefined, other?: string): Record<string, unknown> => {
  const notes = [...(fills ? [unfinishedNote(fills)] : []), ...(other ? [other] : [])]
  return {
    ...(fills ? { incomplete: { fills } } : {}),
    ...(notes.length ? { note: notes.join(' ') } : {})
  }
}

/** What the answer says about the checks: read them, or how to ask for them. */
const checksGuidance = (checked: boolean): string =>
  checked
    ? 'checks lists what it broke or fixed.'
    : 'No checks ran: pass checks: true, or call board_check after the burst.'

const STALE_GUIDANCE =
  'Zone fills predate the edits (stale.fills), and findings of the rules under stale.rules are held back until board_refill. Refill once after the burst.'

const describeBoard = (
  path: string,
  board: KicadBoard,
  unrouted: number
): Record<string, unknown> => {
  const outline = boardOutlineBox(board)
  const copper = board.layers.filter((layer) => layer.name.endsWith('.Cu'))
  const footprints = board.footprints.slice(0, DESCRIBE_CAP).map((footprint) => ({
    reference: footprint.reference ?? '',
    libId: footprint.libId,
    value: footprint.value ?? '',
    at: { x: mm(footprint.position.x), y: mm(footprint.position.y) },
    angle: footprint.position.angle ?? 0,
    side: sideOf(footprint),
    ...(footprintPath(footprint) ? { path: footprintPath(footprint) } : {})
  }))
  const netNames = board.nets.filter((net) => net.number !== 0).map((net) => net.name)
  const truncated = board.footprints.length > footprints.length
  return {
    board: boardRef(path),
    version: board.version ?? null,
    paper: board.paper ?? null,
    layers: { copper: copper.length, total: board.layers.length },
    ...(board.stackup ? { stackup: board.stackup.layers.length } : {}),
    outline: outline
      ? {
          x: mm(outline.minX),
          y: mm(outline.minY),
          width: mm(outline.maxX - outline.minX),
          height: mm(outline.maxY - outline.minY)
        }
      : null,
    footprints,
    counts: {
      footprints: board.footprints.length,
      nets: netNames.length,
      tracks: board.segments.length + board.trackArcs.length,
      vias: board.vias.length,
      zones: board.zones.length
    },
    ...(truncated ? { truncated: true } : {}),
    unrouted,
    ...(truncated
      ? {
          guidance: `footprints holds the first ${footprints.length} of counts.footprints. Read the rest with items_query, narrowed by kind "footprint" and box.`
        }
      : {})
  }
}

/** What moved between two describes: footprints by reference, and the totals that changed. */
const diffDescribe = (
  previous: Record<string, unknown>,
  full: Record<string, unknown>,
  since: number
): Record<string, unknown> => {
  type Row = { reference: string }
  const key = (row: Row): string => row.reference
  const before = new Map((previous.footprints as Row[]).map((row) => [key(row), row]))
  const after = new Map((full.footprints as Row[]).map((row) => [key(row), row]))
  const created = [...after.values()].filter((row) => !before.has(key(row)))
  const deleted = [...before.keys()].filter((reference) => !after.has(reference))
  const updated = [...after.values()].filter(
    (row) => before.has(key(row)) && JSON.stringify(before.get(key(row))) !== JSON.stringify(row)
  )
  const same = (field: string): boolean =>
    JSON.stringify(previous[field]) === JSON.stringify(full[field])
  return {
    board: full.board,
    since,
    revision: full.revision,
    footprints: { created, updated, deleted },
    ...(same('counts') ? {} : { counts: full.counts }),
    ...(same('outline') ? {} : { outline: full.outline }),
    unrouted: full.unrouted,
    ...(full.stale ? { stale: full.stale } : {})
  }
}

const planSummary = (plan: SyncPlan): Record<string, unknown> => ({
  added: plan.add.map((addition) => ({
    reference: addition.part.reference,
    libId: addition.part.libId,
    at: { x: mm(addition.at.x), y: mm(addition.at.y) }
  })),
  updated: plan.update.map((update) => ({
    reference: update.part.reference,
    changes: update.changes,
    ...(update.relinked ? { relinked: true } : {})
  })),
  unchanged: plan.unchanged,
  orphans: plan.orphans.map((orphan) => ({ reference: orphan.reference, libId: orphan.libId })),
  skipped: plan.skipped,
  footprintReplaced: plan.footprintChanged
    .filter((change) => change.library)
    .map(({ reference, board, schematic }) => ({ reference, from: board, to: schematic })),
  nets: plan.nets
})

/** What to do about the parts that could not land. */
const fixFor = (plan: SyncPlan): string | undefined => {
  const missing = plan.skipped.filter((skip) => skip.reason === 'no-footprint').length
  const unknown = plan.skipped.filter((skip) => skip.reason === 'footprint-not-found').length
  const parts: string[] = []
  if (missing)
    parts.push(
      `${missing} part${missing === 1 ? ' has' : 's have'} no footprint: bom_get with where [{ field: "Footprint", match: "empty" }] lists them, footprint_search finds one, bom_update or schematic_bind writes it; then sync again.`
    )
  if (unknown)
    parts.push(
      `${unknown} part${unknown === 1 ? ' names' : 's name'} a footprint no library holds: find the id with footprint_search, write it with bom_update, then sync again.`
    )
  const kept = plan.footprintChanged.filter((change) => !change.library).length
  if (kept)
    parts.push(
      `${kept} placed part${kept === 1 ? "'s" : "s'"} Footprint field names a footprint no library holds, so the board keeps its own: find the id with footprint_search, write it with bom_update, then sync again.`
    )
  return parts.length ? parts.join(' ') : undefined
}

/** The DRC over one board, and the index and ratsnest it stood on. */
interface CheckState {
  board: KicadBoard
  index: BoardSpatialIndex
  results: CheckResult[]
  unrouted: number
  /** The run itself, which the next write's check is taken from; its results mark exclusions. */
  run: BoardCheckRun & { results: CheckResult[] }
}

/**
 * A board and its spatial index: what a write without checks starts from and
 * leaves, read for the zones it left stale. A `CheckState` is one too.
 */
type BoardBase = Pick<CheckState, 'board' | 'index'>
const isChecked = (state: BoardBase): state is CheckState => 'run' in state

/** An edit refused partway: the session puts the board back and this is the answer. */
class EditRefused extends Error {
  constructor(readonly failure: BoardAgentError) {
    super(failure.detail ?? failure.error)
  }
}

interface ChangeLists {
  created: string[]
  updated: string[]
  deleted: string[]
}

const itemFailure = (outcome: ItemFailure | TransformFailure): BoardAgentError => ({
  error: outcome.error,
  detail: outcome.detail,
  ...(outcome.candidates?.length ? { candidates: outcome.candidates } : {})
})

/** Every node a write added, removed or mutated at the top level: what the zone scoping reads. */
const captureRaws = <T>(board: KicadBoard, run: () => T): { value: T; raws: Set<SExprNode> } => {
  const root = board._raw as SExprList
  const before = root.children.slice()
  beginNodeCapture()
  let value: T
  try {
    value = run()
  } catch (error) {
    endNodeCapture()
    throw error
  }
  const clones = endNodeCapture()
  const had = new Set(before)
  const has = new Set(root.children)
  const raws = new Set<SExprNode>(clones.keys())
  for (const node of root.children) if (!had.has(node)) raws.add(node)
  for (const node of before) if (!has.has(node)) raws.add(node)
  return { value, raws }
}

/** The track, track arc or via a cleanup names. */
const trackOf = (board: KicadBoard, ref: TrackRef): KicadTrackSegment | KicadTrackArc | KicadVia =>
  ref.type === 'segment'
    ? board.segments[ref.index]
    : ref.type === 'tarc'
      ? board.trackArcs[ref.index]
      : board.vias[ref.index]

/**
 * A fanout as its answer reads: each via by the id items_get takes and where
 * it is, the pads left for the surface, and what was skipped or refused and why.
 * Whole: an MCP answer caps the lists (`board.fanout`'s `lists`, `main/ops/answerLists.ts`).
 */
const fanoutAnswer = (
  plan: FanoutPlan,
  vias: readonly SExprNode[],
  added: readonly SExprNode[],
  after: KicadBoard
): { changed: McpChanged } & Record<string, unknown> => {
  const ids = new Map(
    boardItems(after)
      .filter((item) => item.kind === 'via' || item.kind === 'track')
      .map((item) => [item.raw, item.id])
  )
  const escapes = plan.escapes.map((escape, index) => ({
    pad: escape.pad,
    net: escape.netName,
    // A dry run's vias are not on the board yet, so they have no id to give.
    ...(vias.length ? { via: ids.get(vias[index]) ?? null } : {}),
    at: { x: mm(escape.via.x), y: mm(escape.via.y) },
    ...(escape.track ? { layer: escape.track.layer } : {})
  }))
  return {
    footprint: plan.footprint,
    layout: plan.layout,
    style: plan.style,
    changed: {
      created: added.flatMap((node) => ids.get(node) ?? []),
      updated: [],
      deleted: []
    } satisfies McpChanged,
    counts: {
      vias: plan.escapes.length,
      tracks: plan.escapes.filter((escape) => escape.track).length
    },
    escapes,
    ...(plan.surface.length ? { surface: plan.surface } : {}),
    ...(plan.skipped.length ? { skipped: plan.skipped } : {}),
    ...(plan.refused.length ? { refused: plan.refused } : {})
  }
}

export const createBoardAgent = (ctx: BoardAgentContext): BoardAgent => {
  const viewports =
    ctx.viewports ?? createAgentViewports({ isOpen: (path) => ctx.openSession(path) !== null })
  const resolve = (
    name: string | undefined
  ): { path: string } | { error: string; detail?: string; candidates?: string[] } => {
    const boards = ctx.boardFiles()
    if (name) {
      const path = ctx.resolveBoard(name)
      return path
        ? { path }
        : {
            error: 'board-not-found',
            detail: `No board called ${name} is in this project.`,
            candidates: boards
          }
    }
    if (!boards.length) return { error: 'no-board', detail: 'This project has no .kicad_pcb file.' }
    if (boards.length > 1)
      return {
        error: 'board-ambiguous',
        detail: 'This project has several boards; pass board to say which.',
        candidates: boards
      }
    return { path: boards[0] }
  }

  const load = async (
    path: string
  ): Promise<{ board: KicadBoard; text: string } | { error: string; detail?: string }> => {
    const text = await ctx.boardText(path)
    if (text === null) return { error: 'board-unreadable', detail: path }
    try {
      return { board: parseKicadBoard(text), text }
    } catch (err) {
      return {
        error: 'board-unreadable',
        detail: `${path}: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  // The last parse of each board no tab holds, by its text: a dense board
  // takes a second to parse, and a burst of reads sees the same bytes.
  const parsed = new Map<string, { text: string; board: KicadBoard }>()

  /** The board as it is now, to read: the open session's, else parsed from its text. Nothing opens. */
  const current = async (
    path: string
  ): Promise<{ board: KicadBoard; session: BoardSession | null } | BoardAgentError> => {
    const session = ctx.openSession(path)
    const live = session?.board()
    if (session && live) {
      parsed.delete(path)
      return { board: live, session }
    }
    const text = await ctx.boardText(path)
    if (text === null) return { error: 'board-unreadable', detail: path }
    const known = parsed.get(path)
    if (known?.text === text) return { board: known.board, session: null }
    try {
      const board = parseKicadBoard(text)
      parsed.set(path, { text, board })
      return { board, session: null }
    } catch (err) {
      return {
        error: 'board-unreadable',
        detail: `${path}: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  // One settings object per board while its rules read the same: an
  // incremental check takes a different object for different rules.
  const settingsMemo = new Map<string, { key: string; settings: BoardDesignSettings }>()
  const settingsFor = async (path: string): Promise<BoardDesignSettings> => {
    const fresh = (await ctx.designSettings(path)) ?? {
      rules: { ...DEFAULT_DESIGN_RULES },
      classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
      patterns: [],
      assignments: []
    }
    const key = JSON.stringify(fresh)
    const known = settingsMemo.get(path)
    if (known?.key === key) return known.settings
    settingsMemo.set(path, { key, settings: fresh })
    return fresh
  }

  const defaultsOf = (settings: BoardDesignSettings): BoardEditDefaults => ({
    classOf: (netName) =>
      netName
        ? netClassForNet(netName, settings.classes, settings.patterns, settings.assignments)
        : defaultNetClass(settings.classes)
  })

  // The checks each open board last answered with, by path: the `before` of
  // the next write, so a burst of edits pays for one DRC run each.
  /** What each board_check answered with, for a later one's `since`. */
  const checkHistory = new CheckHistory()

  const checkCache = new Map<
    string,
    { session: BoardSession; revision: number; state: CheckState }
  >()

  /**
   * The DRC as the pill counts it: the project's severities, its KiCad
   * exclusions set aside. Given the check a write started from and what it
   * touched, only round the edit (`drc/incremental.ts`).
   */
  // The footprint libraries a board's parts come from, loaded once per set of
  // parts: a run of writes that moves footprints reads no library again.
  let libraryCache: { key: string; libraries: Promise<BoardLibraries> } | null = null
  const librariesOf = (board: KicadBoard): Promise<BoardLibraries> | undefined => {
    if (!ctx.boardLibraries) return undefined
    const key = [...new Set(board.footprints.map((bfp) => bfp.libId))].sort().join('\n')
    if (libraryCache?.key !== key) libraryCache = { key, libraries: ctx.boardLibraries(board) }
    return libraryCache.libraries
  }

  const runChecks = async (
    board: KicadBoard,
    settings: BoardDesignSettings,
    built?: BoardSpatialIndex,
    since?: { from: CheckState; raws: ReadonlySet<SExprNode> }
  ): Promise<CheckState> => {
    await loadClipper()
    const index = built ?? BoardSpatialIndex.build(board)
    const connectivity = computeConnectivity(board, index)
    const edit: BoardEdit | undefined = since && {
      fromBoard: since.from.board,
      fromIndex: since.from.index,
      raws: since.raws
    }
    const libraries = await librariesOf(board)
    const schematic = (await ctx.schematicNetlist?.()) ?? null
    const steps = boardCheckRun(
      {
        board,
        index,
        connectivity,
        settings,
        ...(libraries ? { libraries } : {}),
        ...(schematic ? { schematic } : {})
      },
      since && edit ? { run: since.from.run, edit } : undefined
    )
    let step = steps.next()
    while (!step.done) step = steps.next()
    return {
      board,
      index,
      run: step.value,
      results: activeFindings(step.value.results),
      unrouted: connectivity.unrouted
    }
  }

  const checksFor = async (
    path: string,
    session: BoardSession,
    settings: BoardDesignSettings
  ): Promise<CheckState> => {
    const schematic = (await ctx.schematicNetlist?.()) ?? null
    const cached = checkCache.get(path)
    const live = session.board()!
    if (
      cached &&
      cached.session === session &&
      cached.revision === session.revision() &&
      cached.state.board === live &&
      cached.state.run.input.settings === settings &&
      (cached.state.run.input.schematic ?? null) === schematic
    )
      return cached.state
    const state = await runChecks(live, settings)
    checkCache.set(path, { session, revision: session.revision(), state })
    return state
  }

  // The board and index each open board was last written or checked from, by
  // path: a write without checks reads its stale zones against it, so a burst
  // of them builds no index twice.
  const baseCache = new Map<string, { session: BoardSession; revision: number; base: BoardBase }>()

  /** The board as it stands, with its index: the last checks' when they are current. */
  const baseFor = (path: string, session: BoardSession): BoardBase => {
    const live = session.board()!
    const checked = checkCache.get(path)
    if (
      checked &&
      checked.session === session &&
      checked.revision === session.revision() &&
      checked.state.board === live
    )
      return checked.state
    const cached = baseCache.get(path)
    if (
      cached &&
      cached.session === session &&
      cached.revision === session.revision() &&
      cached.base.board === live
    )
      return cached.base
    const base = { board: live, index: BoardSpatialIndex.build(live) }
    baseCache.set(path, { session, revision: session.revision(), base })
    return base
  }

  /** Before a write: the checks when it asked for them, else the board and its index. */
  const startFrom = async (
    path: string,
    session: BoardSession,
    settings: BoardDesignSettings,
    checks: boolean | undefined
  ): Promise<BoardBase> =>
    checks ? await checksFor(path, session, settings) : baseFor(path, session)

  const remember = (path: string, session: BoardSession, state: BoardBase): void => {
    const revision = session.revision()
    baseCache.set(path, { session, revision, base: { board: state.board, index: state.index } })
    if (isChecked(state)) checkCache.set(path, { session, revision, state })
  }

  // ---- stale fills --------------------------------------------------------

  /** A finding that reads a stale fill: it names the zone, or its rule runs through the pour. */
  const readsStaleFill = (result: CheckResult, stale: ReadonlySet<string>): boolean =>
    stale.size > 0 &&
    (FILL_RULES.has(result.code) ||
      result.items.some((item) => stale.has(item)) ||
      (result.targets ?? []).some((target) => stale.has(target)))

  /** Whether a zone that still exists is stale, and the rules with findings held back for it. */
  const staleReport = (
    board: KicadBoard,
    stale: ReadonlySet<string>,
    results: readonly CheckResult[] | null
  ): McpWriteAnswer['stale'] => {
    if (!board.zones.some((zone) => stale.has(zoneKey(zone)))) return undefined
    if (!results) return { fills: true }
    const rules = new Set<string>()
    for (const result of results)
      if (readsStaleFill(result, stale)) rules.add(BOARD_KICAD_KEYS[result.code] ?? result.code)
    return { fills: true, rules: [...rules].sort() }
  }

  const liveStale = (board: KicadBoard, session: BoardSession | null): Set<string> => {
    const keys = session?.staleZones() ?? new Set<string>()
    return new Set(board.zones.map(zoneKey).filter((key) => keys.has(key)))
  }

  /**
   * What a write answers with beyond its own fields: the zones it left stale,
   * and, when it asked for checks, the delta and the unrouted count.
   */
  const report = (
    before: BoardBase,
    after: BoardBase,
    stale: ReadonlySet<string>
  ): Pick<McpWriteAnswer, 'checks' | 'stale'> & { unrouted?: number } => {
    if (!isChecked(before) || !isChecked(after)) {
      const staleBlock = staleReport(after.board, stale, null)
      return staleBlock ? { stale: staleBlock } : {}
    }
    const fresh = (results: CheckResult[]): CheckResult[] =>
      results.filter((result) => !readsStaleFill(result, stale))
    const staleBlock = staleReport(after.board, stale, after.results)
    return {
      checks: compactDelta(checkDelta(fresh(before.results), fresh(after.results)), true),
      unrouted: after.unrouted,
      ...(staleBlock ? { stale: staleBlock } : {})
    }
  }

  /** What a write leaves stale: every zone, as which ones it changed is not known. */
  const zonesStaleAfter = (after: KicadBoard, raws: ReadonlySet<SExprNode>): string[] =>
    raws.size > 0 ? after.zones.filter(fillable).map(zoneKey) : []

  // ---- reads --------------------------------------------------------------

  const describeHistory = new Map<string, Map<number, Record<string, unknown>>>()

  /** `board.describe`, with the routed lengths asked for beside it, outside what `since` diffs. */
  const describe = async (request: McpDescribeBoardRequest): Promise<unknown> => {
    const answer = await describeOnly(request)
    if (!request.lengths || typeof answer !== 'object' || answer === null || 'error' in answer)
      return answer
    const target = resolve(request.board)
    if ('error' in target) return target
    const found = await current(target.path)
    if ('error' in found) return found
    const rows = netLengthRows(found.board, await settingsFor(target.path), request.lengths)
    return 'error' in rows ? rows : { ...answer, lengths: rows.rows }
  }

  const describeOnly = async (request: McpDescribeBoardRequest): Promise<unknown> => {
    const target = resolve(request.board)
    if ('error' in target) return target
    const release = ctx.hold(target.path)
    try {
      const found = await current(target.path)
      if ('error' in found) return found
      const { board, session } = found
      const index = BoardSpatialIndex.build(board)
      const unrouted = computeConnectivity(board, index).unrouted
      const stale = liveStale(board, session)
      const full = {
        ...describeBoard(target.path, board, unrouted),
        ...(stale.size ? { stale: { fills: true } } : {}),
        ...(session ? { revision: session.revision() } : {})
      }
      if (!session) return full
      let history = describeHistory.get(target.path)
      if (!history) describeHistory.set(target.path, (history = new Map()))
      history.set(session.revision(), full)
      if (history.size > DESCRIBE_MEMORY) history.delete(Math.min(...history.keys()))
      if (request.since === undefined) return full
      const previous = history.get(request.since)
      if (!previous)
        return {
          ...full,
          since: request.since,
          sinceUnavailable: `Revision ${request.since} is no longer remembered, so this is the whole board rather than a change list. Read it, and pass the revision below next time.`
        }
      return diffDescribe(previous, full, request.since)
    } finally {
      release()
    }
  }

  /**
   * The rectangle the picture shows, back in board coordinates: millimetres,
   * y down, the space `board.describe` reports. The scene is y-up, and mirrors
   * x when the board is drawn from the back, so both are undone here — a frame
   * an agent cannot read a coordinate out of is worse than no frame.
   */
  const boardFrameOf = (
    visible: { minX: number; minY: number; maxX: number; maxY: number },
    flipped: boolean
  ): { x: number; y: number; width: number; height: number } => {
    const round = (value: number): number => Math.round(value * 1000) / 1000
    return {
      x: round(flipped ? -visible.maxX : visible.minX),
      y: round(-visible.maxY),
      width: round(visible.maxX - visible.minX),
      height: round(visible.maxY - visible.minY)
    }
  }

  const render3D = async (request: McpRenderBoard3DRequest): Promise<unknown> => {
    const target = resolve(request.board)
    if ('error' in target) return target
    const release = ctx.hold(target.path)
    try {
      const loaded = await load(target.path)
      if ('error' in loaded) return loaded
      const bearing = VIEW_BEARINGS[request.view ?? 'iso']
      const result = await ctx.capture3D(loaded.board, target.path, {
        azimuth: request.azimuth ?? bearing.azimuth,
        elevation: request.elevation ?? bearing.elevation,
        roll: request.roll,
        projection: request.projection ?? 'perspective',
        fov: request.fov,
        zoom: request.zoom ?? 1,
        box: request.box ?? null,
        footprints: request.footprints,
        center: request.center ?? null,
        width: request.width,
        height: request.height,
        show: request.show,
        hide: request.hide,
        only: request.only,
        lighting: request.lighting ?? 'studio',
        exposure: request.exposure,
        background: request.background ?? 'theme',
        mask: request.mask,
        silk: request.silk
      })
      if (!result.ok)
        return {
          error: result.error,
          detail: result.detail,
          ...(result.error === 'reference-not-found'
            ? {
                candidates: loaded.board.footprints
                  .map((footprint) => footprint.reference ?? '')
                  .filter(Boolean)
                  .slice(0, 24)
              }
            : {})
        }
      const shot = result.capture
      const { models } = shot
      return {
        board: boardRef(target.path),
        width: shot.width,
        height: shot.height,
        ...(shot.mmPerPixel !== null
          ? { mmPerPixel: Math.round(shot.mmPerPixel * 100000) / 100000 }
          : {}),
        ...(shot.frame ? { frame: shot.frame } : {}),
        finish: shot.palette,
        models: {
          linked: models.total,
          placed: models.placed,
          missing: models.missing,
          ...(models.missingLinks.length ? { missingLinks: models.missingLinks } : {})
        },
        ...(shot.clampedFrom
          ? {
              note: `Drawn at ${shot.width}×${shot.height} rather than ${shot.clampedFrom.width}×${shot.clampedFrom.height}: that is the largest picture this GPU draws.`
            }
          : {}),
        image: png(shot.dataUrl),
        guidance:
          "finish is the mask and silk colors drawn. models.missing parts draw without a body, so a bare footprint is a missing model, not an unplaced part. frame (straight-down or -up orthographic only) is in board_describe's mm; the bottom view is mirrored, x running right to left. Describe what you see."
      }
    } finally {
      release()
    }
  }

  /** Each item's box on a board by id, board mm; empty for no board. */
  const boxesOf = (board: KicadBoard | null | undefined): Map<string, ViewportFrame> => {
    const boxes = new Map<string, ViewportFrame>()
    if (board)
      for (const item of boardItems(board)) if (item.box) boxes.set(item.id, mmBox(item.box))
    return boxes
  }

  /**
   * A layout write in a viewport: refused before it runs when the viewport is
   * not on this board; after, its box frames what the write changed. Deleted
   * items are framed where they were only when `deletes`, which reads the
   * board's boxes before the write.
   */
  const inViewport = async (
    request: { board?: string; viewport?: string; action?: string },
    deletes: boolean,
    run: () => Promise<unknown>
  ): Promise<unknown> => {
    if (request.viewport === undefined) return run()
    const target = resolve(request.board)
    if ('error' in target) return target
    let was = new Map<string, ViewportFrame>()
    return viewports.framed(
      request,
      target.path,
      async () => {
        if (deletes) was = boxesOf((await ctx.session(target.path))?.board())
        return run()
      },
      (answer) => {
        const now = boxesOf(ctx.openSession(target.path)?.board())
        return changedFrame(
          answer,
          { now: (id) => now.get(id), was: (id) => was.get(id) },
          WRITE_FRAME_MARGIN_MM
        )
      }
    )
  }

  const render = async (request: McpRenderBoardRequest): Promise<unknown> => {
    const target = resolve(request.board)
    if ('error' in target) return target
    return viewports.framed(request, target.path, () => renderOn(target, request))
  }

  const renderOn = async (
    target: { path: string },
    request: McpRenderBoardRequest
  ): Promise<unknown> => {
    const release = ctx.hold(target.path)
    try {
      const loaded = await load(target.path)
      if ('error' in loaded) return loaded
      const { board } = loaded
      const flipped = request.side === 'back'

      let footprints: number[] | undefined
      if (request.footprints?.length) {
        const wanted = new Map(request.footprints.map((reference) => [reference, -1]))
        board.footprints.forEach((footprint, index) => {
          const reference = footprint.reference ?? ''
          if (wanted.get(reference) === -1) wanted.set(reference, index)
        })
        const missing = [...wanted].filter(([, index]) => index < 0).map(([reference]) => reference)
        if (missing.length)
          return {
            error: 'reference-not-found',
            detail: `No footprint on this board is called ${missing.join(', ')}.`,
            candidates: board.footprints
              .map((footprint) => footprint.reference ?? '')
              .filter(Boolean)
              .slice(0, 24)
          }
        footprints = [...wanted.values()]
      }

      // The board's own layers, and the non-copper ones every board has; the
      // stack names all 32 copper layers, which a board may not.
      const known = new Set([
        ...PCB_LAYER_STACK.filter((layer) => !isCopperLayer(layer) && !layer.startsWith('(')),
        ...board.layers.map((layer) => layer.name)
      ])
      let layers: string[] | undefined
      if (request.layers?.length) {
        const unknown = request.layers.filter((layer) => !known.has(layer))
        if (unknown.length)
          return {
            error: 'layer-not-found',
            detail: `The board has no layer ${unknown.join(', ')}.`,
            candidates: board.layers.map((layer) => layer.name)
          }
        layers = request.layers
      } else if (request.preset) {
        layers =
          boardRenderPresetLayers(
            request.preset,
            board.layers.map((layer) => layer.name)
          ) ?? undefined
      }

      const activeLayer = request.activeLayer
      if (activeLayer !== undefined) {
        if (!known.has(activeLayer))
          return {
            error: 'layer-not-found',
            detail: `The board has no layer ${activeLayer}.`,
            candidates: board.layers.map((layer) => layer.name)
          }
        if (layers && !layers.includes(activeLayer))
          return {
            error: 'invalid-args',
            detail: `activeLayer ${activeLayer} is not among the layers drawn (${layers.join(', ')}); name one of them, or add it to layers.`
          }
      }

      // Board millimetres (y down, x mirrored when drawn from the back) into
      // the scene's own space, which is what the capture frames with.
      const box = request.box
        ? {
            minX: flipped ? -(request.box.x + request.box.width) : request.box.x,
            maxX: flipped ? -request.box.x : request.box.x + request.box.width,
            minY: -(request.box.y + request.box.height),
            maxY: -request.box.y
          }
        : null

      const shot = await ctx.capture(board, {
        ...(box ? { box } : {}),
        ...(footprints ? { footprints } : {}),
        ...(layers ? { layers } : {}),
        ...(request.fills ? { fills: true } : {}),
        ...(activeLayer !== undefined ? { activeLayer, dim: request.dim ?? DIM_ALPHA_FACTOR } : {}),
        flipped,
        maxPixels: request.maxPixels
      })
      if (!shot)
        return { error: 'renderer-failed', detail: 'The window has no viewport to draw into.' }

      return {
        board: boardRef(target.path),
        frame: boardFrameOf(shot.visible, flipped),
        side: flipped ? 'back' : 'front',
        ...(request.preset ? { preset: request.preset } : {}),
        ...(layers ? { layers } : {}),
        ...(activeLayer !== undefined ? { activeLayer } : {}),
        width: shot.width,
        height: shot.height,
        unrouted: computeConnectivity(board, BoardSpatialIndex.build(board)).unrouted,
        ...pictureNotes(
          shot.unfinishedFills,
          shot.limit === undefined
            ? undefined
            : shot.limit.reason === 'texture'
              ? `Drawn at ${shot.limit.pixels} rather than the ${request.maxPixels} asked for: this GPU addresses ${shot.limit.texture} pixels a side. Frame a smaller region for more detail.`
              : `Drawn at ${shot.limit.pixels} rather than the ${request.maxPixels} asked for: a picture this shape would need more memory than a capture is given. Frame a smaller region for more detail — the same pixels over less board.`
        ),
        image: png(shot.dataUrl),
        guidance:
          'frame is the shown rectangle in board mm, y down: x = frame.x + (px / width) * frame.width, y = frame.y + (py / height) * frame.height. Thin lines between pads are the ratsnest (unrouted connections); zones are outlines unless fills was passed. Describe what you see.'
      }
    } finally {
      release()
    }
  }

  /** The design rule checks, as the board's health pill reads them. */
  const check = async (request: McpCheckBoardRequest): Promise<unknown> => {
    const only = checkCodeFilter(request.codes, BOARD_CHECK_RULES)
    if (typeof only !== 'function') return only
    const target = resolve(request.board)
    if ('error' in target) return target
    const release = ctx.hold(target.path)
    try {
      const found = await current(target.path)
      if ('error' in found) return found
      const { board, session } = found
      const settings = await settingsFor(target.path)
      const state = session
        ? await checksFor(target.path, session, settings)
        : await runChecks(board, settings)
      const stale = liveStale(board, session)
      const unfiltered = state.results.filter((result) => !readsStaleFill(result, stale))
      const fresh = only(unfiltered)
      const codes = request.codes ? { codes: request.codes } : {}
      const staleBlock = staleReport(board, stale, state.results)
      const hidden = state.run.results.filter((result) => result.excluded).length
      const verdict = (checks: McpCheckAnswer['checks']): McpCheckAnswer => ({
        ok: !fresh.some((result) => result.severity === 'error'),
        checks,
        counts: {
          error: fresh.filter((result) => result.severity === 'error').length,
          warning: fresh.filter((result) => result.severity === 'warning').length
        },
        ...(session ? { revision: session.revision() } : {})
      })
      if (session) {
        const base =
          request.since !== undefined ? checkHistory.at(target.path, request.since) : null
        if (request.since !== undefined && !base) return noCheckBaseline(request.since)
        checkHistory.remember(target.path, session.revision(), unfiltered)
        if (base)
          return {
            board: boardRef(target.path),
            ...codes,
            since: request.since,
            ...verdict(compactDelta(checkDelta(only(base), fresh), true)),
            unrouted: state.unrouted,
            ...(staleBlock ? { stale: staleBlock } : {}),
            guidance: [
              'checks.new is what the writes since that revision broke, checks.resolved what they fixed. Call board_check without since for every finding.',
              ...(staleBlock ? [STALE_GUIDANCE] : [])
            ].join(' ')
          }
      } else if (request.since !== undefined) return noCheckBaseline(request.since)
      const rows = withAskedCodes(
        groupChecks(fresh, BOARD_CHECK_RULES, request.codes ? Infinity : FINDINGS_PER_RULE),
        request.codes,
        BOARD_CHECK_RULES
      )
      return {
        board: boardRef(target.path),
        ...codes,
        ...verdict(rows),
        unrouted: state.unrouted,
        ...(hidden ? { hiddenByExclusions: hidden } : {}),
        ...(staleBlock ? { stale: staleBlock } : {}),
        guidance: [
          'One row per rule; ok is false while any error remains. Each finding names its items, at (mm, y down), layer and measure. Barcodes are not checked.',
          ...(rows.some((row) => row.truncated)
            ? [
                `A truncated row lists its first ${FINDINGS_PER_RULE} findings; pass its code in codes for every one.`
              ]
            : []),
          ...(staleBlock ? [STALE_GUIDANCE] : []),
          ...(hidden
            ? [
                `${hidden} finding${hidden === 1 ? ' is' : 's are'} hidden by KiCad exclusions; board_get_setup with sections ["exclusions"] lists them.`
              ]
            : [])
        ].join(' ')
      }
    } finally {
      release()
    }
  }

  const explain = async (request: McpExplainBoardLimitsRequest): Promise<unknown> => {
    const target = resolve(request.board)
    if ('error' in target) return target
    const release = ctx.hold(target.path)
    try {
      const found = await current(target.path)
      if ('error' in found) return found
      const { board, session } = found
      const settings = await settingsFor(target.path)
      await loadClipper()
      const index = session ? baseFor(target.path, session).index : BoardSpatialIndex.build(board)
      const rules = boardRules(board, settings, settings.customRules)
      const items = boardItems(board)
      const targets: ExplainTarget[] = []
      for (const id of request.items) {
        // A field, as a finding names one, has no limits of its own.
        const hit = boardField(board, id) ? null : resolveItem(items, id)
        if (hit && !hit.ok) return itemFailure(hit)
        const explained = hit ? explainTarget(board, index, rules, hit.item) : null
        if (!explained)
          return {
            error: 'invalid-args',
            detail: `${id} is a ${hit ? hit.item.kind : 'field'}; the rules set limits on pads, tracks, vias and zones.`
          }
        targets.push(explained)
      }
      if (request.layer && !targets.every((t) => t.copper.includes(request.layer!)))
        return {
          error: 'invalid-args',
          detail: `Not every item is on ${request.layer}; omit layer for every layer they share.`
        }
      const limits = explainLimits(rules, targets[0], targets[1] ?? null, request.layer)
      return {
        board: boardRef(target.path),
        items: request.items,
        limits: limits.map((limit) => ({
          ...limit,
          steps: limit.steps.map((step) => ({
            ...(step.rule ? { rule: step.rule } : {}),
            outcome: step.outcome,
            ...(step.value !== undefined ? { value: step.value } : {})
          }))
        })),
        ...(session ? { revision: session.revision() } : {}),
        guidance: limits.length
          ? "Each limit names its source; a rule is changed in the project's .kicad_dru or board_update_setup."
          : request.items.length > 1
            ? 'No rule sets a limit on these items together: they share no copper layer and no hole.'
            : 'No rule sets a size for this item: only tracks, vias and drilled pads are held to one.'
      }
    } finally {
      release()
    }
  }

  /**
   * `tracks: "follow"` on a footprint's update: the tracks its pads carry
   * through the move, as the PCB editor's D drag carries them
   * (`router/componentDrag.ts`); null when the record does not move it.
   * Vias stay put. Throws `EditRefused`.
   */
  const followingTracks = (
    board: KicadBoard,
    item: BoardItem,
    record: Record<string, unknown>,
    settings: BoardDesignSettings
  ): ReturnType<typeof carriedTracks> => {
    if (item.kind !== 'footprint')
      throw new EditRefused({
        error: 'invalid-args',
        detail: `tracks is for a footprint; ${item.id} is a ${item.kind}. Drop tracks.`
      })
    const bfp = item.footprint
    const turned =
      (record.angle !== undefined && record.angle !== (bfp.position.angle ?? 0)) ||
      (record.side !== undefined && record.side !== (bfp.layer === 'B.Cu' ? 'back' : 'front'))
    if (turned)
      throw new EditRefused({
        error: 'not-applicable',
        detail: `tracks "follow" carries a move, not a turn or a flip, as the editor's drag does. Move ${item.id} with at and tracks "follow", then send angle or side on their own.`
      })
    const at = record.at as { x?: unknown; y?: unknown } | undefined
    if (typeof at?.x !== 'number' || typeof at.y !== 'number') return null
    const index = BoardSpatialIndex.build(board)
    const fp = board.footprints.indexOf(bfp)
    const pads = index.items.filter(
      (copper) => copper.ref.type === 'pad' && copper.ref.index === fp
    )
    // Board mm (y down) to the router's scene (y up).
    const move = { x: at.x - nmToMm(bfp.position.x), y: -(at.y - nmToMm(bfp.position.y)) }
    if (Math.abs(move.x) < 1e-9 && Math.abs(move.y) < 1e-9) return null
    return carriedTracks(routerWorldOf(board, index, settings), pads, move)
  }

  /**
   * Tuning patterns laid again with their data (`patternRetune.ts`), as the
   * editor's Properties rows and *Update all tuning patterns* do: every
   * re-tune worked out before any is written. What changed is the patterns
   * and their tracks, by id; a row per pattern says what each tune laid.
   */
  const retuneOn = (
    board: KicadBoard,
    settings: BoardDesignSettings,
    edits: ReadonlyArray<readonly [KicadTuningPattern, TuningPatternData]>
  ): { board: KicadBoard; changed: McpChanged; rows: Array<Record<string, unknown>> } => {
    const index = BoardSpatialIndex.build(board)
    const world = routerWorldOf(board, index, settings)
    const plans = planRetunes({ board, index, world, setup: settings }, edits)
    const was = boardItemIds(board).byObject
    const before = new Map(
      [...board.segments, ...board.trackArcs].flatMap((track) => {
        const id = was.get(track)
        return id ? [[track._raw, id] as const] : []
      })
    )
    const patternIds = plans.map((plan) => was.get(plan.pattern) ?? plan.pattern.uuid)
    writeRetunes(board, plans)
    const next = remapKicadBoard(board)
    const now = boardItemIds(next).byObject
    const tracks = [...next.segments, ...next.trackArcs]
    const kept = new Set(tracks.map((track) => track._raw))
    return {
      board: next,
      changed: {
        created: tracks
          .flatMap((track) => (before.has(track._raw) ? [] : [now.get(track) ?? '']))
          .filter(Boolean),
        updated: patternIds,
        deleted: [...before].flatMap(([raw, id]) => (kept.has(raw) ? [] : [id]))
      },
      rows: plans.map((plan, i) => retuneRow(next, plan, patternIds[i]))
    }
  }

  /** An item by id; a miss whose left side is a footprint's reference offers that footprint's field ids. */
  const resolveFieldOrItem = (
    board: KicadBoard,
    items: readonly BoardItem[],
    id: string
  ): ReturnType<typeof resolveWritable> => {
    const found = resolveWritable(items, id)
    if (found.ok) return found
    const fields = boardFieldIds(board, id)
    return fields.length ? { ...found, candidates: fields } : found
  }

  const itemsGuidance =
    'Millimeters in board space, y down. A footprint id is its reference, a pad <reference>.<number>, a field <reference>#<field> (at, angle and layer as the board shows it), anything else its uuid. Change one with items_update, sending only the keys that change.'

  /** One read or write against `board`, the batch's state so far. Throws `EditRefused`. */
  const applyItem = (
    board: KicadBoard,
    request: BatchEntry,
    context: {
      settings: BoardDesignSettings
      defaults: BoardEditDefaults
      changed: ChangeLists
      stale: ReadonlySet<string>
      libraries: ReadonlyMap<string, KicadFootprint>
      /** The live board's revision, which a capped query's next page is pinned to. */
      revision?: number
    }
  ): { board: KicadBoard; result: unknown; capped?: string } => {
    const { defaults, changed, stale } = context
    const refuse = (outcome: ItemFailure | TransformFailure): never => {
      throw new EditRefused(itemFailure(outcome))
    }
    const wrote = (
      next: KicadBoard,
      own: Partial<McpChanged>,
      extra: Record<string, unknown> = {}
    ): { board: KicadBoard; result: unknown } => {
      const entry: McpChanged = {
        created: own.created ?? [],
        updated: own.updated ?? [],
        deleted: own.deleted ?? []
      }
      changed.created.push(...entry.created)
      changed.updated.push(...entry.updated)
      changed.deleted.push(...entry.deleted)
      return { board: next, result: { changed: entry, ...extra } }
    }
    if (request.kind === 'place-footprint-board') {
      const placed = placeOn(board, request, context.libraries)
      return wrote(placed.board, { created: [placed.placed.id] }, { placed: placed.placed })
    }
    const items = boardItems(board)
    switch (request.kind) {
      case 'get-board-items': {
        const rows = request.ids.map((id) => {
          const field = boardField(board, id)
          if (field) return boardFieldRecord(field)
          const found = resolveFieldOrItem(board, items, id)
          return found.ok ? itemRecord(board, items, found.item, stale) : refuse(found)
        })
        return { board, result: { items: rows, count: rows.length } }
      }
      case 'query-board-items': {
        const query = boardQueryOf(request)
        const found = queryItems(board, items, query)
        if ('ok' in found) return refuse(found)
        return {
          board,
          result: {
            items: found.rows.map((item) => itemRow(board, item, stale)),
            count: found.total,
            ...(found.offset ? { offset: found.offset } : {}),
            ...(found.truncated ? { truncated: true } : {})
          },
          ...(found.truncated
            ? {
                capped: cappedGuidance(
                  found,
                  boardNarrowings(board, found.matches, query),
                  context.revision
                )
              }
            : {})
        }
      }
      case 'update-board-item': {
        const field = boardField(board, request.id)
        if (field) {
          const outcome = updateBoardField(board, field, request.record)
          if (!outcome.ok) return refuse(outcome)
          return wrote(outcome.board, { updated: [outcome.id] })
        }
        const found = resolveFieldOrItem(board, items, request.id)
        if (!found.ok) return refuse(found)
        if (found.item.kind === 'tuning_pattern') {
          if (request.tracks)
            return refuse({
              ok: false,
              error: 'invalid-args',
              detail: `tracks is for a footprint; ${found.item.id} is a tuning_pattern. Drop tracks.`
            })
          const edit = tuningPatternUpdate(found.item.pattern, request.record)
          if (!edit.ok) return refuse(edit)
          const retuned = retuneOn(board, context.settings, [[found.item.pattern, edit.data]])
          return wrote(retuned.board, retuned.changed, { tuned: retuned.rows[0] })
        }
        const follow =
          request.tracks === 'follow'
            ? followingTracks(board, found.item, request.record, context.settings)
            : null
        const outcome = updateItem(board, found.item, request.record)
        if (!outcome.ok) return refuse(outcome)
        if (!follow) return wrote(outcome.board, { updated: [outcome.id] })
        // The carried tracks land as the drag lands them, in the same step.
        const removed = follow.removed.flatMap((ref) => {
          const track =
            ref.type === 'segment' ? board.segments[ref.index] : board.trackArcs[ref.index]
          return track?.uuid ? [track.uuid] : []
        })
        const before = new Set(board.segments.map((seg) => seg.uuid))
        applyRouterDelta(outcome.board, follow)
        const next = remapKicadBoard(outcome.board)
        const after = new Set(next.segments.map((seg) => seg.uuid))
        return wrote(next, {
          created: next.segments.flatMap((seg) =>
            seg.uuid && !before.has(seg.uuid) ? [seg.uuid] : []
          ),
          updated: [outcome.id, ...removed.filter((uuid) => after.has(uuid))],
          deleted: removed.filter((uuid) => !after.has(uuid))
        })
      }
      case 'delete-board-items': {
        const targets: BoardItem[] = []
        if (request.ids) {
          for (const id of request.ids) {
            const found = resolveWritable(items, id)
            if (!found.ok) return refuse(found)
            targets.push(found.item)
          }
        } else {
          const found = queryItems(board, items, boardQueryOf(request))
          if ('ok' in found) return refuse(found)
          if (found.total !== request.expect)
            return refuse({
              ok: false,
              error: 'count-mismatch',
              detail: `The filter matches ${found.total} items, not ${request.expect}; nothing was deleted.`
            })
          // A footprint's zones count as items_query counts them, and stay: they go with their footprint.
          targets.push(
            ...found.matches.filter(
              (item) => !(item.kind === 'zone' && item.zone.footprint !== undefined)
            )
          )
        }
        const outcome = deleteItems(board, targets)
        if (!outcome.ok) return refuse(outcome)
        // A tuning pattern's tracks go with it, or the track it replaced comes back.
        return wrote(outcome.board, {
          created: outcome.created,
          deleted: [...targets.map((item) => item.id), ...outcome.deleted]
        })
      }
      case 'create-board-item': {
        const outcome = createItem(board, request.itemKind, request.record, defaults)
        if (!outcome.ok) return refuse(outcome)
        return wrote(outcome.board, { created: outcome.ids })
      }
      case 'transform-board-items': {
        const outcome = transformBoardItemsById(board, request)
        if (!outcome.ok) return refuse(outcome)
        return wrote(outcome.board, outcome.changed)
      }
    }
  }

  /**
   * A library footprint placed on `board` (`footprintPlace.ts`, as the PCB
   * editor's Place Footprint lands it), board-only, flipped as the editor's F
   * flips it when it goes on the back. Throws `EditRefused`.
   */
  const placeOn = (
    board: KicadBoard,
    request: McpPlaceFootprintBoardRequest,
    libraries: ReadonlyMap<string, KicadFootprint>
  ): { board: KicadBoard; placed: McpPlaced } => {
    const library = libraries.get(request.footprint)
    if (!library)
      throw new EditRefused({
        error: 'unknown-footprint',
        detail: `No library holds ${request.footprint}. Find its lib id with footprint_search.`
      })
    const references = board.footprints.map((footprint) => footprint.reference ?? '')
    if (request.reference && references.includes(request.reference))
      throw new EditRefused({
        error: 'reference-taken',
        detail: `${request.reference} is already on the board; omit reference for the next free one.`
      })
    const reference = request.reference ?? placedReference(request.footprint, library, references)
    const back = request.side === 'back'
    const node = placeFootprintNode(library, {
      libId: request.footprint,
      at: { x: mmToNm(request.at.x), y: mmToNm(request.at.y) },
      angle: back ? 0 : (request.angle ?? 0),
      reference,
      ...(back ? { flipLayer: boardLayerFlipper(board.layers) } : {})
    })
    insertIntoBoard(board, [node], { x: 0, y: 0 })
    let after = remapKicadBoard(board)
    // On the back, angle is the record's, as items_update writes it after a flip.
    const flipped = after.footprints.find((footprint) => footprint._raw === node)
    if (back && flipped && request.angle) {
      rotateBoardFootprintInAST(flipped, request.angle)
      after = remapKicadBoard(after)
    }
    const items = boardItems(after)
    const own = items.find(
      (item) => item.kind === 'footprint' && item.footprint.reference === reference
    )
    if (own?.kind !== 'footprint')
      throw new EditRefused({
        error: 'renderer-failed',
        detail: `${reference} was placed but could not be read back.`
      })
    const footprint = own.footprint
    const pads: McpPlacedTerminal[] = items.flatMap((item) =>
      item.kind === 'pad' && item.footprint === footprint
        ? [
            {
              id: item.id,
              number: item.pad.number,
              at: { x: mm(item.at.x), y: mm(item.at.y) },
              ...(item.pad.net?.name ? { net: item.pad.net.name } : {})
            }
          ]
        : []
    )
    return {
      board: after,
      placed: {
        id: own.id,
        reference,
        libId: footprint.libId,
        at: { x: mm(footprint.position.x), y: mm(footprint.position.y) },
        angle: footprint.position.angle ?? 0,
        side: sideOf(footprint),
        ...(pads.length > PLACED_PAD_CAP ? { padCount: pads.length } : { pads })
      }
    }
  }

  /** The libraries a run of placements reads, loaded before the write, which is synchronous. */
  const librariesFor = async (
    entries: readonly BatchEntry[],
    batch: boolean
  ): Promise<Map<string, KicadFootprint> | BoardAgentError> => {
    const libraries = new Map<string, KicadFootprint>()
    for (const [index, entry] of entries.entries()) {
      if (entry.kind !== 'place-footprint-board' || libraries.has(entry.footprint)) continue
      const library = await ctx.loadFootprint(entry.footprint)
      if (!library)
        return {
          error: 'unknown-footprint',
          detail: `${batch ? `Operation ${index} (\`${OP_NAMES[entry.kind]}\`): ` : ''}No library holds ${entry.footprint}. Find its lib id with footprint_search.`
        }
      libraries.set(entry.footprint, library)
    }
    return libraries
  }

  /** A read on its own: the live board when a tab holds it, else the file. Nothing opens. */
  const read = async (
    request: McpGetBoardItemsRequest | McpQueryBoardItemsRequest
  ): Promise<unknown> => {
    const target = resolve(request.board)
    if ('error' in target) return target
    const release = ctx.hold(target.path)
    try {
      const found = await current(target.path)
      if ('error' in found) return found
      const revision = found.session?.revision()
      if (
        request.kind === 'query-board-items' &&
        request.revision !== undefined &&
        request.revision !== revision
      )
        return {
          error: 'revision-moved',
          detail:
            revision === undefined
              ? `No tab holds ${boardRef(target.path).name} now, so revision ${request.revision} cannot be checked.`
              : `The board is at revision ${revision}, not ${request.revision}.`
        }
      const stale = liveStale(found.board, found.session)
      const settings = await settingsFor(target.path)
      try {
        const { result, capped } = applyItem(found.board, request, {
          settings,
          defaults: defaultsOf(settings),
          changed: { created: [], updated: [], deleted: [] },
          stale,
          libraries: new Map(),
          ...(revision !== undefined ? { revision } : {})
        })
        const answer = result as Record<string, unknown>
        return {
          board: boardRef(target.path),
          ...answer,
          ...(revision !== undefined ? { revision } : {}),
          guidance:
            request.kind === 'query-board-items'
              ? [
                  ...(capped ? [capped] : []),
                  'Rows are compact; items_get has the full record.',
                  itemsGuidance
                ].join(' ')
              : itemsGuidance
        }
      } catch (error) {
        if (error instanceof EditRefused) return error.failure
        throw error
      }
    } finally {
      release()
    }
  }

  /** A transform's undo label, as the editor's own gesture names it. */
  const transformLabel = (request: McpTransformBoardItemsRequest, board: KicadBoard): string => {
    const count = request.ids.length
    const footprints = request.ids.every((id) =>
      board.footprints.some((bfp) => bfp.reference === id || bfp.uuid === id)
    )
    switch (request.transform) {
      case 'rotate':
        return footprints
          ? ctx.label(tk('pcbEditor.commands.rotateFootprints'), count)
          : ctx.label(tk('pcbEditor.commands.rotateItems'), count)
      case 'flip':
        return footprints
          ? ctx.label(tk('pcbEditor.commands.flipFootprints'), count)
          : ctx.label(tk('pcbEditor.commands.flipItems'), count)
      case 'mirror':
        return ctx.label(tk('pcbEditor.commands.mirror'), count)
      case 'duplicate':
        return ctx.label(tk('commandLabels.duplicate'), count)
      default:
        return ctx.label(tk('commandLabels.move'), count)
    }
  }

  const labelFor = (
    request: BatchEntry,
    board: KicadBoard,
    libraries: ReadonlyMap<string, KicadFootprint>
  ): string => {
    switch (request.kind) {
      case 'place-footprint-board': {
        const library = libraries.get(request.footprint)
        const reference =
          request.reference ??
          (library
            ? placedReference(
                request.footprint,
                library,
                board.footprints.map((footprint) => footprint.reference ?? '')
              )
            : request.footprint)
        return ctx.label(tk('pcbEditor.commands.placeFootprint'), { reference })
      }
      case 'delete-board-items':
        return ctx.label(tk('commandLabels.delete'), request.ids?.length ?? request.expect ?? 0)
      case 'create-board-item': {
        const keys: Record<McpCreateBoardItemRequest['itemKind'], MessageKey> = {
          track: tk('pcbEditor.commands.routeTrack'),
          via: tk('pcbEditor.commands.addVia'),
          zone: tk('pcbEditor.commands.addZone'),
          line: tk('pcbEditor.commands.addLine'),
          arc: tk('pcbEditor.commands.addArc'),
          circle: tk('pcbEditor.commands.addCircle'),
          rect: tk('pcbEditor.commands.addRectangle'),
          poly: tk('pcbEditor.commands.addPolygon'),
          bezier: tk('pcbEditor.commands.addBezier'),
          text: tk('pcbEditor.commands.addText'),
          text_box: tk('pcbEditor.commands.addTextBox'),
          point: tk('pcbEditor.commands.addPoint')
        }
        return request.itemKind === 'line'
          ? ctx.label(keys.line, 1)
          : ctx.label(keys[request.itemKind])
      }
      case 'update-board-item': {
        const footprint = board.footprints.find(
          (bfp) => bfp.reference === request.id || bfp.uuid === request.id
        )
        const keys = Object.keys(request.record)
        if (footprint?.reference && keys.length === 1 && keys[0] === 'at')
          return ctx.label(tk('pcbEditor.commands.moveFootprint'), {
            reference: footprint.reference
          })
        if (footprint?.reference && keys.length === 1 && keys[0] === 'angle')
          return ctx.label(tk('pcbEditor.commands.rotateFootprint'), {
            reference: footprint.reference
          })
        if (footprint && keys.length === 1 && keys[0] === 'side')
          return ctx.label(tk('pcbEditor.commands.flipFootprints'), 1)
        if (board.tuningPatterns.some((pattern) => pattern.uuid === request.id))
          return ctx.label(tk('pcbEditor.commands.retune'))
        return ctx.label(tk('pcbEditor.commands.editItem'))
      }
      case 'transform-board-items':
        return transformLabel(request, board)
      default:
        return ctx.label(tk('pcbEditor.commands.editItem'))
    }
  }

  /**
   * One write: its edits, its undo label, and what its answer carries beyond
   * the check delta. `apply` edits the board it is handed — the live one, or
   * a scratch parse on a dry run — and throws `EditRefused` to leave it
   * untouched; `answer` reads the board the edits left.
   */
  interface WriteSpec {
    label(live: KicadBoard): string
    apply(
      board: KicadBoard,
      context: {
        settings: BoardDesignSettings
        defaults: BoardEditDefaults
        stale: ReadonlySet<string>
        index: BoardSpatialIndex
      }
    ): KicadBoard
    /** `dryRun`: `after` is a scratch board, whose new ids are not the live board's. */
    answer(after: KicadBoard, dryRun: boolean): { changed: McpChanged } & Record<string, unknown>
    /** The guidance of a dry run: what was not written. */
    dryRun: string
  }

  /**
   * Land a write on the board as one command, or, with `dryRun`, on a scratch
   * parse that is thrown away. A refusal partway leaves the board untouched.
   */
  const write = async (
    boardName: string | undefined,
    spec: WriteSpec,
    options: { dryRun?: boolean; refill?: boolean; checks?: boolean; teardrops?: boolean }
  ): Promise<unknown> => {
    const target = resolve(boardName)
    if ('error' in target) return target
    const path = target.path
    const release = ctx.hold(path)
    try {
      const session = await ctx.session(path)
      const live = session?.board()
      if (!session || !live)
        return { error: 'board-unreadable', detail: session?.parseError() ?? path }
      if (!options.dryRun && session.readOnly()) return { error: 'read-only' }
      const settings = await settingsFor(path)
      const defaults = defaultsOf(settings)
      const before = await startFrom(path, session, settings, options.checks)
      const staleBefore = liveStale(live, session)

      if (options.dryRun) {
        const scratch = parseKicadBoard(serializeKicadBoard(live))
        const baseIndex = BoardSpatialIndex.build(scratch)
        const arrays = {
          segments: scratch.segments.slice(),
          trackArcs: scratch.trackArcs.slice(),
          vias: scratch.vias.slice(),
          footprints: scratch.footprints.slice()
        }
        let captured: { value: KicadBoard; raws: Set<SExprNode> }
        try {
          captured = captureRaws(scratch, () =>
            spec.apply(scratch, { settings, defaults, stale: staleBefore, index: baseIndex })
          )
        } catch (error) {
          if (error instanceof EditRefused) return error.failure
          throw error
        }
        // The nets the session's command would propagate (`netPropagation.ts`).
        const applied = remapKicadBoard(captured.value)
        const propagated = captureRaws(applied, () => {
          const changes = propagationFor(
            applied,
            captured.raws,
            () => BoardSpatialIndex.buildFrom(baseIndex, arrays, applied, captured.raws),
            { index: baseIndex, arrays }
          )
          if (changes) applyNetChanges(applied, changes)
          return applied
        })
        for (const raw of propagated.raws) captured.raws.add(raw)
        const afterBoard = propagated.raws.size > 0 ? remapKicadBoard(applied) : applied
        const after: BoardBase = options.checks
          ? await runChecks(afterBoard, settings)
          : { board: afterBoard, index: BoardSpatialIndex.build(afterBoard) }
        const stale = new Set([...staleBefore, ...zonesStaleAfter(afterBoard, captured.raws)])
        const preview: McpWriteAnswer & Record<string, unknown> = {
          board: boardRef(path),
          dryRun: true,
          ...spec.answer(afterBoard, true),
          ...report(before, after, stale),
          revision: session.revision(),
          guidance: [spec.dryRun, checksGuidance(options.checks === true)].join(' ')
        }
        return preview
      }

      let afterIndex: BoardSpatialIndex | null = null
      let touched: ReadonlySet<SExprNode> = new Set()
      try {
        session.runCommand(
          spec.label(live),
          () => {
            spec.apply(live, { settings, defaults, stale: staleBefore, index: before.index })
          },
          {
            ...(options.teardrops === false ? { teardrops: false } : {}),
            zones: (after, raws) => {
              afterIndex = BoardSpatialIndex.buildFrom(before.index, before.board, after, raws)
              touched = raws
              return { stale: zonesStaleAfter(after, raws) }
            }
          }
        )
      } catch (error) {
        if (error instanceof EditRefused) return error.failure
        throw error
      }
      const afterBoard = session.board()!
      let after: BoardBase =
        afterBoard === before.board
          ? before
          : isChecked(before)
            ? await runChecks(afterBoard, settings, afterIndex ?? undefined, {
                from: before,
                raws: touched
              })
            : { board: afterBoard, index: afterIndex ?? BoardSpatialIndex.build(afterBoard) }
      remember(path, session, after)

      let refilled: Record<string, unknown> | null = null
      if (options.refill && liveStale(afterBoard, session).size > 0) {
        const outcome = await refillZones(
          path,
          session,
          settings,
          after,
          'stale',
          true,
          options.checks === true
        )
        if ('error' in outcome) return outcome
        refilled = outcome.answer
        after = outcome.after
      }

      const stale = liveStale(session.board()!, session)
      const written: McpWriteAnswer & Record<string, unknown> = {
        board: boardRef(path),
        ...spec.answer(session.board()!, false),
        ...(refilled ? { refill: refilled } : {}),
        ...report(before, after, stale),
        revision: session.revision(),
        guidance: [
          WRITE_GUIDANCE,
          checksGuidance(options.checks === true),
          ...(stale.size ? [STALE_GUIDANCE] : [])
        ].join(' ')
      }
      return written
    } finally {
      release()
    }
  }

  /** Item ops as one write: a batch, or a single `items.*` or `board.place_footprint` call. */
  const edit = (
    boardName: string | undefined,
    ops: BatchEntry[],
    options: {
      label?: string
      dryRun?: boolean
      refill?: boolean
      batch?: boolean
      checks?: boolean
      libraries?: ReadonlyMap<string, KicadFootprint>
    }
  ): Promise<unknown> => {
    const changed: ChangeLists = { created: [], updated: [], deleted: [] }
    const results: unknown[] = []
    const libraries = options.libraries ?? new Map<string, KicadFootprint>()
    return write(
      boardName,
      {
        label: (live) => options.label ?? labelFor(ops[0], live, libraries),
        apply: (board, { settings, defaults, stale }) => {
          let working = board
          for (const [index, op] of ops.entries()) {
            try {
              const applied = applyItem(working, op, {
                settings,
                defaults,
                changed,
                stale,
                libraries
              })
              working = applied.board
              results.push(applied.result)
            } catch (error) {
              if (error instanceof EditRefused && options.batch)
                throw new EditRefused({
                  ...error.failure,
                  detail: `Operation ${index} (\`${OP_NAMES[op.kind]}\`): ${(error.failure.detail ?? error.failure.error).replace(/\.?$/, '.')} Nothing was written.`
                })
              throw error
            }
          }
          return working
        },
        answer: () =>
          options.batch
            ? { changed, results }
            : { ...(results[0] as Record<string, unknown>), changed },
        dryRun: 'Nothing was written; run again without dryRun to apply it.'
      },
      options
    )
  }

  // ---- fanout -------------------------------------------------------------

  /**
   * One footprint's pads taken to vias (`lib/board/fanout.ts`): planned
   * against the board's rules and written as one command. What it could not
   * place is answered, measured, never forced.
   */
  const fanout = (request: McpFanoutBoardRequest): Promise<unknown> => {
    let plan: FanoutPlan | null = null
    let vias: SExprNode[] = []
    let added: SExprNode[] = []
    return write(
      request.board,
      {
        label: () => ctx.label(tk('pcbEditor.commands.fanout'), { reference: request.footprint }),
        apply: (board, { settings, index }) => {
          const found = resolveItem(boardItems(board), request.footprint)
          if (!found.ok) throw new EditRefused(itemFailure(found))
          if (found.item.kind !== 'footprint')
            throw new EditRefused({
              error: 'not-applicable',
              detail: `${request.footprint} is a ${found.item.kind}; fanout takes a footprint.`
            })
          const outcome = planFanout(
            board,
            index,
            board.footprints.indexOf(found.item.footprint),
            {
              ...(request.pads ? { pads: request.pads } : {}),
              ...(request.nets ? { nets: request.nets } : {}),
              ...(request.style ? { style: request.style } : {}),
              ...(request.direction ? { direction: request.direction } : {}),
              ...(request.surfaceRows !== undefined ? { surfaceRows: request.surfaceRows } : {}),
              ...(request.via ? { via: request.via } : {})
            },
            fanoutRulesOf(settings, board)
          )
          if (!outcome.ok)
            throw new EditRefused({
              error: outcome.error,
              detail: outcome.detail,
              ...(outcome.candidates ? { candidates: outcome.candidates } : {})
            })
          plan = outcome.plan
          const root = board._raw as SExprList
          const before = root.children.length
          vias = applyFanout(board, plan)
          added = root.children.slice(before)
          return board
        },
        // A dry run's items are not on the board, so they have no id to give.
        answer: (after, dryRun) =>
          plan
            ? fanoutAnswer(plan, dryRun ? [] : vias, dryRun ? [] : added, after)
            : { changed: { created: [], updated: [], deleted: [] } },
        dryRun: 'Nothing was written; run again without dryRun to place it.'
      },
      { dryRun: request.dryRun === true, checks: request.checks === true }
    )
  }

  // ---- cleanup -------------------------------------------------------------

  const cleanup = (request: McpCleanupBoardRequest): Promise<unknown> => {
    let rows: Array<{
      kind: string
      items: string[]
      at: { x: number; y: number }
      layer: string
    }> = []
    let changed: McpChanged = { created: [], updated: [], deleted: [] }
    return write(
      request.board,
      {
        label: () => ctx.label(tk('pcbEditor.commands.cleanup')),
        apply: (board, { settings, stale, index }) => {
          const options = { ...DEFAULT_CLEANUP_OPTIONS, ...request.passes }
          if ((options.danglingTracks || options.danglingVias) && stale.size > 0)
            throw new EditRefused({
              error: 'zones-stale',
              detail: `${stale.size} zone fill${stale.size === 1 ? ' predates' : 's predate'} the last edits, and dangling copper is judged against the fills. Call board_refill first, or pass passes { danglingTracks: false, danglingVias: false }.`
            })
          const scope = cleanupScope(board, request)
          const plan: CleanupPlan = drainSteps(
            planTrackCleanup({ board, index, connectivity: null, settings }, options, scope)
          )
          const ids = boardItemIds(board).byObject
          const idOf = (ref: TrackRef): string =>
            ids.get(trackOf(board, ref)) ?? `${ref.type}:${ref.index}`
          rows = plan.changes.map((change) => ({
            kind: change.kind,
            items: change.items.map(idOf),
            at: { x: mm(change.at.x), y: mm(change.at.y) },
            layer: change.layer
          }))
          changed = {
            created: [],
            updated: plan.update.map((u) => idOf({ type: 'segment', index: u.index })),
            deleted: [
              ...plan.remove.segments.map((index) => idOf({ type: 'segment', index })),
              ...plan.remove.arcs.map((index) => idOf({ type: 'tarc', index })),
              ...plan.remove.vias.map((index) => idOf({ type: 'via', index }))
            ]
          }
          applyTrackCleanup(board, plan)
          return board
        },
        answer: () => {
          const counts: Record<string, number> = {}
          for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1
          return { changed, changes: rows, counts }
        },
        dryRun: 'Nothing was written; run again without dryRun to clean up.'
      },
      { dryRun: request.dryRun === true, checks: request.checks === true }
    )
  }

  // ---- teardrops -----------------------------------------------------------

  const setTeardrops = async (request: McpSetTeardropsBoardRequest): Promise<unknown> => {
    const target = resolve(request.board)
    if ('error' in target) return target
    const session = await ctx.session(target.path)
    if (!session) return { error: 'board-unreadable', detail: target.path }
    const projectFile = await ctx.projectFile(target.path)
    const projectText = projectFile ? await ctx.readText(projectFile) : null
    const settings = extractTeardropSettings(projectText)
    const maxError = session.teardropOptions().maxError
    const out: { result: TeardropEditResult | null } = { result: null }
    let updated: string[] = []
    let teardropCount = 0
    const answer = await write(
      request.board,
      {
        label: () => ctx.label(tk('pcbEditor.commands.editTeardrops')),
        apply: (board) => {
          const edit = teardropEditOf(board, request, settings)
          clearLegacyTeardrops(board)
          const done = applyTeardropEdit(board, edit, settings)
          out.result = done
          const ids = boardItemIds(board).byObject
          updated = done.touched.map((item) => ids.get(item) ?? '').filter((id) => id !== '')
          const options = {
            maxError,
            settings: done.settings,
            maskExpansion: board.padToMaskClearance
          }
          const plan = planTeardrops(board, boardIndex(board), 'all', options)
          // The live board keeps its owner map; a dry run's scratch copy has none.
          applyTeardropPlan(
            board,
            plan,
            board === session.board() ? session.teardropOwners() : undefined
          )
          teardropCount = plan.add.length
          return board
        },
        answer: () => ({
          changed: { created: [], updated, deleted: [] },
          counts: {
            pads: out.result?.pads ?? 0,
            vias: out.result?.vias ?? 0,
            teardrops: teardropCount
          }
        }),
        dryRun: 'Nothing was written; run again without dryRun to set the teardrops.'
      },
      { dryRun: request.dryRun === true, checks: request.checks === true, teardrops: false }
    )
    const done = out.result
    if (request.dryRun || !done || (answer as { error?: unknown }).error) return answer
    session.setTeardropOptions({ maxError, settings: done.settings })
    const patched =
      projectFile && projectText !== null ? patchTeardropSettings(projectText, done.settings) : null
    if (projectFile && patched !== null && patched !== projectText)
      await ctx.writeProject(projectFile, patched)
    return answer
  }

  /** The request as an edit: its nets, layers and items resolved, its targets the project's when absent. */
  const teardropEditOf = (
    board: KicadBoard,
    request: McpSetTeardropsBoardRequest,
    settings: TeardropSettings
  ): TeardropEdit => {
    const nets = request.nets ? namedNets(board, request.nets) : undefined
    const copper = board.layers.filter((layer) => isCopperLayer(layer.name)).map((l) => l.name)
    for (const layer of request.layers ?? [])
      if (!copper.includes(layer))
        throw new EditRefused({
          error: 'layer-not-found',
          detail: `The board has no copper layer ${layer}.`,
          candidates: copper
        })
    let items: Set<KicadPad | KicadVia> | undefined
    if (request.items) {
      const all = boardItems(board)
      items = new Set()
      for (const id of request.items) {
        const found = resolveItem(all, id)
        if (!found.ok) throw new EditRefused(itemFailure(found))
        if (found.item.kind === 'pad') items.add(found.item.pad)
        else if (found.item.kind === 'via') items.add(found.item.via)
        else
          throw new EditRefused({
            error: 'not-applicable',
            detail: `${id} is a ${found.item.kind}; teardrops are set on pads and vias.`
          })
      }
    }
    const t = request.targets
    const v = request.values
    return {
      action: request.mode,
      targets: t
        ? {
            vias: t.includes('vias'),
            pthPads: t.includes('pthPads'),
            smdPads: t.includes('smdPads'),
            trackToTrack: t.includes('trackToTrack')
          }
        : { ...settings.targets },
      ...(request.roundOnly ? { roundOnly: true } : {}),
      ...(request.existingOnly ? { existingOnly: true } : {}),
      ...(items ? { items } : {}),
      ...(nets ? { nets } : {}),
      ...(request.layers ? { layers: new Set(request.layers) } : {}),
      ...(v
        ? {
            values: {
              ...v,
              ...(v.maxLength !== undefined ? { maxLength: mmToNm(v.maxLength) } : {}),
              ...(v.maxWidth !== undefined ? { maxWidth: mmToNm(v.maxWidth) } : {})
            }
          }
        : {})
    }
  }

  /** The numbers of nets named, refused by name when one is not on the board. */
  const namedNets = (board: KicadBoard, names: readonly string[]): Set<number> => {
    const nets = new Set<number>()
    for (const name of names) {
      const found = board.nets.find((n) => n.name === name && n.number !== 0)
      if (!found)
        throw new EditRefused({
          error: 'net-not-found',
          detail: `No net called ${name} is on the board.`,
          candidates: board.nets
            .filter((n) => n.number !== 0)
            .map((n) => n.name)
            .filter((n) => n.toLowerCase().includes(name.toLowerCase().slice(0, 3)))
            .slice(0, 12)
        })
      nets.add(found.number)
    }
    return nets
  }

  /** What a cleanup may touch: the request's nets, layers and items, each when given. */
  const cleanupScope = (board: KicadBoard, request: McpCleanupBoardRequest): CleanupScope => {
    let nets: Set<number> | null = null
    if (request.nets) {
      nets = new Set()
      for (const name of request.nets) {
        const found = board.nets.find((n) => n.name === name && n.number !== 0)
        if (!found)
          throw new EditRefused({
            error: 'net-not-found',
            detail: `No net called ${name} is on the board.`,
            candidates: board.nets
              .filter((n) => n.number !== 0)
              .map((n) => n.name)
              .filter((n) => n.toLowerCase().includes(name.toLowerCase().slice(0, 3)))
              .slice(0, 12)
          })
        nets.add(found.number)
      }
    }
    const copper = board.layers.filter((layer) => isCopperLayer(layer.name)).map((l) => l.name)
    for (const layer of request.layers ?? [])
      if (!copper.includes(layer))
        throw new EditRefused({
          error: 'layer-not-found',
          detail: `The board has no copper layer ${layer}.`,
          candidates: copper
        })
    let only: Set<object> | null = null
    if (request.items) {
      const items = boardItems(board)
      only = new Set()
      for (const id of request.items) {
        const found = resolveItem(items, id)
        if (!found.ok) throw new EditRefused(itemFailure(found))
        if (found.item.kind === 'track') only.add(found.item.track)
        else if (found.item.kind === 'via') only.add(found.item.via)
        else
          throw new EditRefused({
            error: 'not-applicable',
            detail: `${id} is a ${found.item.kind}; cleanup takes tracks and vias.`
          })
      }
    }
    const layers = request.layers ? new Set(request.layers) : null
    return (ref) => {
      const item = trackOf(board, ref)
      if (only && !only.has(item)) return false
      if (nets && !nets.has(item.net)) return false
      const on = 'layers' in item ? item.layers : [item.layer]
      return !layers || on.some((layer) => layers.has(layer))
    }
  }

  // ---- place footprint ----------------------------------------------------

  const placeFootprint = async (request: McpPlaceFootprintBoardRequest): Promise<unknown> => {
    const libraries = await librariesFor([request], false)
    if ('error' in libraries) return libraries
    return edit(request.board, [request], {
      dryRun: request.dryRun === true,
      checks: request.checks === true,
      libraries
    })
  }

  // ---- update / change footprints -----------------------------------------

  const updateFootprints = async (request: McpUpdateFootprintsBoardRequest): Promise<unknown> => {
    const change = request.footprint?.trim() || null
    const options = { ...(change ? CHANGE_DEFAULTS : UPDATE_DEFAULTS), ...request.options }
    const targetsOf = (board: KicadBoard): KicadBoardFootprint[] => {
      if (request.references?.length) {
        const wanted = new Set(request.references)
        const found = board.footprints.filter((fp) => wanted.has(fp.reference ?? ''))
        const missing = request.references.filter(
          (reference) => !found.some((fp) => fp.reference === reference)
        )
        if (missing.length)
          throw new EditRefused({
            error: 'reference-not-found',
            detail: `No footprint on the board is ${missing.join(', ')}.`,
            candidates: nearestReferences(board, missing)
          })
        return found
      }
      if (request.match) return board.footprints.filter((fp) => fp.libId === request.match)
      return [...board.footprints]
    }

    // The libraries load before the write, which is synchronous: every lib id
    // the targets could take, read once.
    const resolved = resolve(request.board)
    if ('error' in resolved) return resolved
    const loaded = await current(resolved.path)
    if ('error' in loaded) return loaded
    let preview: KicadBoardFootprint[]
    try {
      preview = targetsOf(loaded.board)
    } catch (error) {
      if (error instanceof EditRefused) return error.failure
      throw error
    }
    if (change) {
      const owned = preview.filter(isSymbolOwned).map((fp) => fp.reference ?? '')
      if (owned.length)
        return {
          error: 'refused',
          detail: `${owned.join(', ')} belong${owned.length === 1 ? 's' : ''} to the schematic, which owns which footprint a part uses: write the symbol's Footprint field (bom_update) and run board_sync, which replaces the footprint the same way. Change only board-only footprints here.`
        }
    }
    const libIds = new Set(change ? [change] : preview.map((fp) => fp.libId))
    const libraries = new Map<string, KicadFootprint | null>()
    await Promise.all(
      [...libIds].map(async (libId) => libraries.set(libId, await ctx.loadFootprint(libId)))
    )
    if (change && !libraries.get(change))
      return {
        error: 'unknown-footprint',
        detail: `No library holds ${change}. Find its lib id with footprint_search.`
      }

    let reports: ExchangeReport[] = []
    let notFound: Array<{ reference: string; libId: string }> = []
    return write(
      request.board,
      {
        label: (live) =>
          ctx.label(
            change
              ? tk('pcbEditor.commands.changeFootprints')
              : tk('pcbEditor.commands.updateFootprints'),
            targetsOf(live).length
          ),
        apply: (board) => {
          const targets = targetsOf(board)
          notFound = []
          const exchange = targets.flatMap((footprint) => {
            const libId = change ?? footprint.libId
            const library = libraries.get(libId)
            if (!library) {
              notFound.push({ reference: footprint.reference ?? '', libId })
              return []
            }
            return [{ footprint, library, libId }]
          })
          if (!exchange.length)
            throw new EditRefused(
              notFound.length
                ? {
                    error: 'unknown-footprint',
                    detail: `No library holds ${[...new Set(notFound.map((miss) => miss.libId))].join(', ')}; nothing was written.`
                  }
                : {
                    error: 'nothing-to-update',
                    detail: request.match
                      ? `No footprint on the board has the lib id ${request.match}; nothing was written.`
                      : 'The board has no footprint to update; nothing was written.',
                    candidates: [...new Set(board.footprints.map((fp) => fp.libId))].slice(0, 24)
                  }
            )
          reports = exchangeFootprints(board, exchange, options)
          return board
        },
        answer: (after) => {
          const ids = new Map(
            boardItems(after)
              .filter((item) => item.kind === 'footprint')
              .map((item) => [item.footprint.reference ?? '', item.id])
          )
          return {
            changed: {
              created: [],
              updated: reports.map((row) => ids.get(row.reference) ?? row.reference),
              deleted: []
            } satisfies McpChanged,
            footprints: reports,
            ...(notFound.length ? { notFound } : {}),
            options
          }
        },
        dryRun: 'Nothing was written; run again without dryRun to rebuild them.'
      },
      { dryRun: request.dryRun === true, checks: request.checks === true }
    )
  }

  // ---- update tuning patterns ---------------------------------------------

  /** KiCad's Update All Tuning Patterns: each laid again where it lies, to the rules as they are now (T4). */
  const updateTuningPatterns = (request: McpUpdateTuningPatternsBoardRequest): Promise<unknown> => {
    let rows: Array<Record<string, unknown>> = []
    let changed: McpChanged = { created: [], updated: [], deleted: [] }
    return write(
      request.board,
      {
        label: () => ctx.label(tk('pcbEditor.commands.updateTuningPatterns')),
        apply: (board, context) => {
          if (board.tuningPatterns.length === 0)
            throw new EditRefused({
              error: 'no-tuning-patterns',
              detail: 'The board has no tuning patterns; nothing was written.'
            })
          const retuned = retuneOn(
            board,
            context.settings,
            board.tuningPatterns.map((pattern) => [pattern, pattern] as const)
          )
          rows = retuned.rows
          changed = retuned.changed
          return retuned.board
        },
        answer: () => ({ changed, patterns: rows }),
        dryRun: 'Nothing was written; run again without dryRun to lay them.'
      },
      { dryRun: request.dryRun === true, checks: request.checks === true }
    )
  }

  // ---- refill -------------------------------------------------------------

  /**
   * Refill zones on the session's board as one command (grouped with the
   * command before it when `group`), within the time budget. Answers with
   * what was refilled, what the budget left, and the checks after.
   */
  const refillZones = async (
    path: string,
    session: BoardSession,
    settings: BoardDesignSettings,
    before: BoardBase,
    which: 'stale' | 'all',
    group: boolean,
    checks: boolean
  ): Promise<
    { answer: Record<string, unknown>; after: BoardBase; remaining: number } | BoardAgentError
  > => {
    // Every teardrop first, as KiCad's Fill All Zones rebuilds them.
    session.rebuildTeardrops(ctx.label(tk('pcbEditor.commands.rebuildTeardrops')))
    const board = session.board()!
    try {
      await loadClipper()
    } catch {
      return {
        error: 'renderer-failed',
        detail: 'The geometry kernel did not load, so no zone can be filled.'
      }
    }
    const rules = boardRules(board, settings)
    const stale = session.staleZones()
    const targets: ReadonlySet<KicadBoardZone> | 'all' =
      which === 'all' ? 'all' : new Set(board.zones.filter((zone) => stale.has(zoneKey(zone))))
    const started = performance.now()
    const index = before.board === board ? before.index : BoardSpatialIndex.build(board)
    const result = await computeRefill(board, index, rules, targets, {
      deadline: started + REFILL_BUDGET_MS,
      cancelled: () => session.board() !== board
    })
    if (!result) {
      const wanted = targets === 'all' ? board.zones : [...targets]
      if (!wanted.some((zone) => session.staleZones().has(zoneKey(zone))) && which === 'stale') {
        const after = await startFrom(path, session, settings, checks)
        return {
          answer: {
            counts: { refilled: 0 },
            note: 'The open board editor refilled these zones first, as it does after an edit.'
          },
          after,
          remaining: 0
        }
      }
      return {
        error: 'board-changed',
        detail:
          'The board changed while the zones were filling, so nothing was written. Call board_refill again.'
      }
    }
    let touched: ReadonlySet<SExprNode> = new Set()
    if (result.fills.length) {
      session.runCommand(
        ctx.label(tk('pcbEditor.commands.refillZones')),
        () => {
          for (const { zone, polys } of result.fills) setZoneFilledPolysInAST(zone, polys)
        },
        {
          groupWithPrevious: group,
          zones: (_after, raws) => {
            touched = raws
            return { filled: result.fills.map(({ zone }) => zoneKey(zone)) }
          }
        }
      )
    }
    const refilled = session.board()!
    const after: BoardBase =
      refilled === board
        ? before
        : checks
          ? await runChecks(
              refilled,
              settings,
              undefined,
              isChecked(before) && before.board === board
                ? { from: before, raws: touched }
                : undefined
            )
          : { board: refilled, index: BoardSpatialIndex.build(refilled) }
    remember(path, session, after)
    return {
      answer: {
        counts: {
          refilled: result.fills.length,
          ...(result.remaining.length ? { remaining: result.remaining.length } : {})
        },
        ms: Math.round(performance.now() - started)
      },
      after,
      remaining: result.remaining.length
    }
  }

  const refill = async (request: McpRefillBoardRequest): Promise<unknown> => {
    const target = resolve(request.board)
    if ('error' in target) return target
    const path = target.path
    const release = ctx.hold(path)
    try {
      const session = await ctx.session(path)
      const live = session?.board()
      if (!session || !live)
        return { error: 'board-unreadable', detail: session?.parseError() ?? path }
      if (session.readOnly()) return { error: 'read-only' }
      const settings = await settingsFor(path)
      const checks = request.checks === true
      const before = await startFrom(path, session, settings, checks)

      // Zones a budget-cut refill left are filled next, in fill order; with none, every zone.
      const which = liveStale(live, session).size > 0 ? 'stale' : 'all'
      const outcome = await refillZones(path, session, settings, before, which, false, checks)
      if ('error' in outcome) return outcome
      const stale = liveStale(session.board()!, session)
      return {
        board: boardRef(path),
        ...outcome.answer,
        ...report(before, outcome.after, stale),
        revision: session.revision(),
        guidance: [
          'One undo step on the board tab, now unsaved.',
          checks
            ? 'checks lists what the new fills changed.'
            : 'No checks ran: pass checks: true, or call board_check.',
          ...(outcome.remaining
            ? [
                'The time budget ran out: counts.remaining zones are still stale. Call board_refill again to continue.'
              ]
            : [])
        ].join(' ')
      }
    } finally {
      release()
    }
  }

  // ---- sync ---------------------------------------------------------------

  const sync = async (request: McpSyncBoardRequest): Promise<unknown> => {
    if (ctx.readOnly() && !request.dryRun) return { error: 'read-only' }
    const target = resolve(request.board)
    if ('error' in target) return target
    const release = ctx.hold(target.path)
    try {
      return await syncBoard(request, target.path)
    } finally {
      release()
    }
  }

  /**
   * The plan for one board, over the board's live text and the design's
   * footprints; `planOver` plans the same design again over another copy of
   * the board — the open session's, whose footprints an apply must name.
   */
  const planFor = async (
    path: string
  ): Promise<
    | { plan: SyncPlan; board: KicadBoard; text: string; planOver: (b: KicadBoard) => SyncPlan }
    | BoardAgentError
  > => {
    const design = await ctx.design()
    if (!design)
      return {
        error: 'no-schematic',
        detail: 'This project has no schematic to sync from.'
      }
    // A part is one reference, so unannotated parts would sync as one: refused, as KiCad does.
    const unannotated = unannotatedReferences(design)
    if (unannotated.length)
      return {
        error: 'not-annotated',
        detail: `${unannotated.length} unannotated part${unannotated.length === 1 ? '' : 's'}.`,
        candidates: unannotated.slice(0, 8)
      }
    const loaded = await load(path)
    if ('error' in loaded) return loaded
    const { board, text } = loaded

    // The loader is asynchronous and the planner is not: fetch every footprint
    // the design names once, then plan over the cache.
    const wanted = new Set<string>()
    for (const source of design.sheets) {
      for (const symbol of source.schematic.symbols) {
        const footprint = symbol.properties.find((property) => property.key === 'Footprint')?.value
        if (footprint?.trim()) wanted.add(footprint.trim())
      }
    }
    const library = new Map<string, KicadFootprint | null>()
    await Promise.all(
      [...wanted].map(async (libId) => library.set(libId, await ctx.loadFootprint(libId)))
    )
    const planOver = (b: KicadBoard): SyncPlan =>
      planBoardSync(design, b, (libId) => library.get(libId) ?? null)
    return { plan: planOver(board), board, text, planOver }
  }

  const previewSync = async (name?: string): Promise<SyncPreview | BoardAgentError> => {
    const target = resolve(name)
    if ('error' in target) return target
    const release = ctx.hold(target.path)
    try {
      const planned = await planFor(target.path)
      return 'error' in planned ? planned : { board: target.path, plan: planned.plan }
    } finally {
      release()
    }
  }

  const syncBoard = async (request: McpSyncBoardRequest, path: string): Promise<unknown> => {
    const planned = await planFor(path)
    if ('error' in planned) return planned
    const { board, text } = planned
    const plan = scopePlan(planned.plan, request)
    const summary = planSummary(plan)
    const fix = fixFor(plan)
    const checks = request.checks === true
    // Connectivity is a check's work: answered only when the sync asked for checks.
    const unroutedOf = (b: KicadBoard): Record<string, number> =>
      checks ? { unrouted: computeConnectivity(b, BoardSpatialIndex.build(b)).unrouted } : {}

    // Footprints by reference, as `board.describe` lists them.
    const changed = (written: boolean): McpChanged => ({
      created: written ? plan.add.map((addition) => addition.part.reference) : [],
      updated: written ? plan.update.map((update) => update.part.reference) : [],
      deleted: written && request.prune ? plan.orphans.map((orphan) => orphan.reference) : []
    })
    if (request.dryRun) {
      return {
        board: boardRef(path),
        dryRun: true,
        changed: changed(true),
        ...summary,
        ...(fix ? { fix } : {})
      }
    }
    if (!syncWouldChange(plan, request.prune === true)) {
      return {
        board: boardRef(path),
        changed: changed(false),
        ...summary,
        ...unroutedOf(board),
        ...(fix ? { fix } : {}),
        ...(ctx.openSession(path) ? { revision: ctx.openSession(path)!.revision() } : {}),
        guidance: 'The board already matches the schematic; nothing was written.'
      }
    }
    const done = {
      board: boardRef(path),
      changed: changed(true),
      ...summary,
      ...(request.prune ? { removed: plan.orphans.map((orphan) => orphan.reference) } : {}),
      ...(fix ? { fix } : {})
    }
    // The board's own session applies it, so the sync is one step on the board
    // editor's undo stack rather than text landing from outside. Only a window
    // with no session to give falls back to landing text.
    const session = await ctx.session(path)
    const live = session?.board()
    if (!session || !live) {
      applyBoardSync(board, plan, { prune: request.prune === true })
      const after = remapKicadBoard(board)
      ctx.commitBoard(path, serializeKicadBoard(after), text)
      return {
        ...done,
        ...unroutedOf(after),
        guidance:
          'The board tab holds the change, unsaved and not on an undo list. New footprints sit in rows below the outline, unrouted: place them with items_update or board_batch.'
      }
    }
    if (session.readOnly()) return { error: 'read-only' }
    // The plan names the footprints of the copy it was made over; the session's
    // board is another copy, so it is planned again there before it is applied.
    const livePlan = live === board ? plan : scopePlan(planned.planOver(live), request)
    const settings = await settingsFor(path)
    const before = await startFrom(path, session, settings, checks)
    let afterIndex: BoardSpatialIndex | null = null
    let touched: ReadonlySet<SExprNode> = new Set()
    session.runCommand(
      ctx.label(tk('commandLabels.boardSync')),
      () => applyBoardSync(live, livePlan, { prune: request.prune === true }),
      {
        zones: (after, raws) => {
          afterIndex = BoardSpatialIndex.buildFrom(before.index, before.board, after, raws)
          touched = raws
          return { stale: zonesStaleAfter(after, raws) }
        }
      }
    )
    const synced = session.board()!
    const after: BoardBase = isChecked(before)
      ? await runChecks(synced, settings, afterIndex ?? undefined, { from: before, raws: touched })
      : { board: synced, index: afterIndex ?? BoardSpatialIndex.build(synced) }
    remember(path, session, after)
    const stale = liveStale(session.board()!, session)
    return {
      ...done,
      ...report(before, after, stale),
      revision: session.revision(),
      guidance: [
        'One undo step on the board tab, now unsaved. New footprints sit in rows below the outline, unrouted: place them with items_update or board_batch.',
        checksGuidance(checks),
        ...(stale.size ? [STALE_GUIDANCE] : [])
      ].join(' ')
    }
  }

  // ---- setup --------------------------------------------------------------

  const getSetup = async (request: McpGetBoardSetupRequest): Promise<unknown> => {
    const target = resolve(request.board)
    if ('error' in target) return target
    const release = ctx.hold(target.path)
    try {
      const found = await current(target.path)
      if ('error' in found) return found
      const settings = await settingsFor(target.path)
      const sections: readonly BoardSetupSection[] = request.sections?.length
        ? request.sections
        : BOARD_SETUP_SECTIONS
      const state = sections.includes('exclusions')
        ? found.session
          ? await checksFor(target.path, found.session, settings)
          : await runChecks(found.board, settings)
        : null
      const record = boardSetupRecord(
        {
          board: found.board,
          settings,
          catalog: DRC_CATALOG,
          results: state?.run.results ?? null,
          hasProject: (await ctx.projectFile(target.path)) !== null
        },
        sections
      )
      const matched = (
        record.netClasses as { matched?: Array<{ truncated?: boolean }> } | undefined
      )?.matched
      return {
        board: boardRef(target.path),
        project: await ctx.projectFile(target.path),
        ...record,
        ...(found.session ? { revision: found.session.revision() } : {}),
        guidance: [
          'Millimeters. Send any section back, changed, to board_update_setup. hides counts the current findings each exclusion keeps out of board_check.',
          ...(matched?.some((row) => row.truncated)
            ? [
                `A truncated matched row lists its first ${MATCHED_NETS_CAP} nets of count, in Board Setup's order.`
              ]
            : [])
        ].join(' ')
      }
    } finally {
      release()
    }
  }

  /** The board half of a setup plan, on `board`: a regenerated stackup, the page, the origins. */
  const applyBoardHalf = (board: KicadBoard, plan: SetupPlan): void => {
    if (plan.board.stackup) setBoardStackupInAST(board, plan.board.stackup)
    if (plan.board.stackupEdits && board.stackup)
      applyStackupEdits(board.stackup, plan.board.stackupEdits)
    if (plan.board.paper) updateBoardMetaInAST(board, { paper: plan.board.paper })
    if (plan.board.gridOrigin !== undefined)
      setBoardOriginInAST(board, 'grid', plan.board.gridOrigin)
    if (plan.board.drillOrigin !== undefined)
      setBoardOriginInAST(board, 'drill', plan.board.drillOrigin)
  }

  /** The project half, patched into the file's text in one pass. */
  const patchProject = (text: string, plan: SetupPlan): string | null => {
    let next: string | null = text
    if (plan.project.design) next = patchDesignSettings(next, plan.project.design)
    if (next !== null && plan.project.tuning)
      next = patchTuningPatternSettings(next, plan.project.tuning)
    if (next !== null && plan.project.teardrops)
      next = patchTeardropSettings(next, plan.project.teardrops)
    if (next !== null && plan.project.tuningProfiles)
      next = patchTuningProfiles(next, plan.project.tuningProfiles)
    if (next !== null && plan.project.severities)
      next = patchRuleSeverities(next, 'drc', plan.project.severities)
    if (next !== null && plan.project.choice)
      next = patchBoardSetupChoice(next, plan.project.choice)
    return next
  }

  const updateSetup = async (request: McpUpdateBoardSetupRequest): Promise<unknown> => {
    const target = resolve(request.board)
    if ('error' in target) return target
    const path = target.path
    const release = ctx.hold(path)
    try {
      const session = await ctx.session(path)
      const live = session?.board()
      if (!session || !live)
        return { error: 'board-unreadable', detail: session?.parseError() ?? path }
      if (!request.dryRun && session.readOnly()) return { error: 'read-only' }
      const projectFile = await ctx.projectFile(path)
      const settings = await settingsFor(path)
      const planned = planBoardSetup(
        { board: live, settings, catalog: DRC_CATALOG, hasProject: projectFile !== null },
        request.changes
      )
      if (!planned.ok)
        return {
          error: planned.error,
          detail: planned.detail,
          ...(planned.candidates ? { candidates: planned.candidates } : {})
        }
      const { plan } = planned
      const checks = request.checks === true
      const before = await startFrom(path, session, settings, checks)
      const touchesBoard = Object.keys(plan.board).length > 0
      // New rules or a new stackup change what every pour keeps clear of.
      const refills = Boolean(plan.project.design || plan.board.stackup)
      const nextSettings: BoardDesignSettings = {
        ...settings,
        ...(plan.project.design ?? {}),
        ...(plan.project.tuningProfiles
          ? {
              tuning: tuningSettingsOf(
                plan.project.tuningProfiles,
                Object.fromEntries(
                  (plan.project.design?.classes ?? settings.classes).map((c) => [
                    c.name,
                    c.tuningProfile ?? ''
                  ])
                )
              )
            }
          : {}),
        severities: { ...(settings.severities ?? {}), ...(plan.project.severities ?? {}) }
      }

      if (request.dryRun) {
        const scratch = parseKicadBoard(serializeKicadBoard(live))
        applyBoardHalf(scratch, plan)
        const scratchBoard = remapKicadBoard(scratch)
        const after: BoardBase = checks
          ? await runChecks(scratchBoard, nextSettings)
          : { board: scratchBoard, index: BoardSpatialIndex.build(scratchBoard) }
        const stale = refills
          ? new Set(after.board.zones.filter(fillable).map(zoneKey))
          : liveStale(live, session)
        return {
          board: boardRef(path),
          dryRun: true,
          sections: plan.changed,
          before: plan.before,
          ...report(before, after, stale),
          revision: session.revision(),
          guidance: [
            'Nothing was written; send again without dryRun to apply it.',
            checksGuidance(checks)
          ].join(' ')
        }
      }

      let projectText: string | null = null
      const { design, tuning, teardrops, tuningProfiles, severities, choice } = plan.project
      if (
        projectFile &&
        (design || tuning || teardrops || tuningProfiles || severities || choice)
      ) {
        const text = await ctx.readText(projectFile)
        projectText = text === null ? null : patchProject(text, plan)
        if (projectText === null)
          return {
            error: 'write-failed',
            detail: `${projectFile} could not be read as a project file, so nothing was written.`
          }
      }
      if (touchesBoard) {
        session.runCommand(
          ctx.label(
            plan.board.stackup || plan.board.stackupEdits
              ? plan.changed.profile
                ? tk('pcbEditor.commands.applyProfile')
                : tk('pcbEditor.commands.editStackup')
              : tk('pcbEditor.commands.editBoard')
          ),
          () => applyBoardHalf(live, plan),
          refills
            ? { zones: (after) => ({ stale: after.zones.filter(fillable).map(zoneKey) }) }
            : {}
        )
      }
      if (projectFile && projectText !== null) {
        if (!(await ctx.writeProject(projectFile, projectText)))
          return {
            error: 'write-failed',
            detail: touchesBoard
              ? `${projectFile} was not written; the board half landed as one undoable step on its tab.`
              : `${projectFile} was not written.`
          }
        if (plan.project.design)
          session.markZonesStale(session.board()!.zones.filter(fillable).map(zoneKey))
      }
      const updated = session.board()!
      const after: BoardBase = checks
        ? await runChecks(updated, await settingsFor(path))
        : { board: updated, index: BoardSpatialIndex.build(updated) }
      remember(path, session, after)
      const stale = liveStale(session.board()!, session)
      return {
        board: boardRef(path),
        sections: plan.changed,
        before: plan.before,
        ...(projectText !== null ? { written: projectFile } : {}),
        ...report(before, after, stale),
        ...(plan.project.severities && isChecked(before) && isChecked(after)
          ? {
              counts: {
                before: severityCounts(before.results),
                after: severityCounts(after.results)
              }
            }
          : {}),
        revision: session.revision(),
        guidance: [
          touchesBoard
            ? 'Stackup and general are one undo step on the board tab, now unsaved.'
            : '',
          projectText !== null
            ? 'The project file is written and not undoable: send before back to revert it.'
            : '',
          plan.board.stackup ? 'The stackup was regenerated, replacing per-layer hand edits.' : '',
          checks ? 'checks lists what the new setup changed.' : checksGuidance(false),
          ...(stale.size ? [STALE_GUIDANCE] : [])
        ]
          .filter(Boolean)
          .join(' ')
      }
    } finally {
      release()
    }
  }

  /**
   * `board.apply_interface_preset`: the dialog's plan, for the nets the agent
   * names. The project file takes the profile, class and patterns; `.kicad_dru`
   * the class's block of rules. Neither is undoable; the answer says what was there.
   */
  const applyPreset = async (request: McpApplyInterfacePresetRequest): Promise<unknown> => {
    const target = resolve(request.board)
    if ('error' in target) return target
    const path = target.path
    const release = ctx.hold(path)
    try {
      const session = await ctx.session(path)
      const live = session?.board()
      if (!session || !live)
        return { error: 'board-unreadable', detail: session?.parseError() ?? path }
      if (!request.dryRun && session.readOnly()) return { error: 'read-only' }
      const projectFile = await ctx.projectFile(path)
      if (!projectFile)
        return {
          error: 'no-project-file',
          detail:
            'A preset writes net classes and rules, which live in the project file; this board has none.'
        }
      const settings = await settingsFor(path)
      const planned = planInterfacePreset(
        {
          copperLayers: copperNamesFor(stackupSpecOf(live).copperLayers),
          netNames: assignableNets(netsInUse(live)),
          classes: settings.classes,
          patterns: settings.patterns,
          assignments: settings.assignments,
          tuningProfiles: settings.tuning?.definitions ?? [],
          minClearance: settings.rules.minClearance,
          minTrackWidth: settings.rules.minTrackWidth
        },
        {
          preset: request.preset,
          netClass: request.netClass,
          patterns: request.patterns,
          ...(request.mode ? { mode: request.mode } : {}),
          ...(request.gap !== undefined ? { gap: request.gap } : {}),
          ...(request.width !== undefined ? { width: request.width } : {}),
          ...(request.layers ? { layers: request.layers } : {})
        },
        stackupSolver(solverStackupOf(live))
      )
      if (!planned.ok)
        return {
          error: 'invalid-record',
          detail: planned.detail,
          ...(planned.candidates ? { candidates: planned.candidates } : {})
        }
      const { plan } = planned
      const answer = {
        board: boardRef(path),
        preset: plan.preset.id,
        mode: plan.mode.id,
        netClass: plan.profileName,
        nets: plan.report.nets,
        ...(plan.report.pairs.length ? { pairs: plan.report.pairs } : {}),
        ...(plan.report.controlled
          ? {
              gap: plan.report.gap,
              gapSource: plan.report.gapSource,
              layers: plan.report.layers
            }
          : {
              impedance:
                "Not held at this speed: the class takes the Default class's sizes and no tuning profile."
            }),
        ...(plan.report.alternatives.length ? { alternatives: plan.report.alternatives } : {}),
        rules: plan.report.rules,
        sources: plan.sources.map((s) => ({
          title: s.title,
          url: s.url,
          where: s.where
        }))
      }
      if (request.dryRun)
        return {
          ...answer,
          dryRun: true,
          guidance: 'Nothing was written; send again without dryRun to apply it.'
        }
      const text = await ctx.readText(projectFile)
      let projectText: string | null = text
      if (projectText !== null) projectText = patchTuningProfiles(projectText, plan.tuningProfiles)
      if (projectText !== null)
        projectText = patchDesignSettings(projectText, {
          rules: settings.rules,
          classes: plan.classes,
          patterns: plan.patterns,
          extraSizes: settings.extraSizes ?? { tracks: [], vias: [] }
        })
      if (projectText === null || !(await ctx.writeProject(projectFile, projectText)))
        return { error: 'write-failed', detail: `${projectFile} was not written; nothing changed.` }
      const rulesFile = customRulesPath(projectFile)
      const rulesBefore = (await ctx.readText(rulesFile)) ?? undefined
      const rulesText = patchRules(rulesBefore, presetRuleNames(plan.profileName), plan.rules)
      if (rulesText !== (rulesBefore ?? '') && !(await ctx.writeProject(rulesFile, rulesText)))
        return {
          error: 'write-failed',
          detail: `${projectFile} was written; ${rulesFile} was not, so the class has no rules yet.`
        }
      session.markZonesStale(session.board()!.zones.filter(fillable).map(zoneKey))
      return {
        ...answer,
        written: [projectFile, ...(rulesText !== (rulesBefore ?? '') ? [rulesFile] : [])],
        before: {
          classes: settings.classes.map((c) => c.name),
          tuningProfiles: (settings.tuning?.definitions ?? []).map((p) => p.name)
        },
        guidance:
          'The project file and its rules are written and not undoable. Route the class with route_begin; board_check measures the rules.'
      }
    } finally {
      release()
    }
  }

  // ---- routing sessions -----------------------------------------------------

  interface RouteEntry {
    agent: AgentRouteSession
    session: BoardSession
    /** The viewport the person sees it in. */
    viewport: string
    settings: BoardDesignSettings
    /** What each landing in the step under way changed; `net` is the route's. */
    landings: Landing[]
  }

  interface Landing {
    before: KicadBoard
    after: KicadBoard
    raws: ReadonlySet<SExprNode>
    /** The route's nets: one, or a pair's two. */
    nets: readonly number[]
  }

  /** The tracks and vias routes landed, by id: the routes' own new copper, not what they pushed. */
  interface LandedCopper {
    tracks: string[]
    vias: string[]
  }

  type LandingDiff = McpChanged & LandedCopper

  /** How a session ended, for the call that next asks after it or its board. */
  interface EndedRoute {
    path: string
    reason: string
    /** What it had clicked, landed as the session ended (R21, R33). */
    landed?: { changed: McpChanged; landed: LandedCopper }
    /** Answered already, by the call that ended it or a later one. */
    told: boolean
  }

  /** Live routing sessions by id; one per board. */
  const routeSessions = new Map<string, RouteEntry>()
  let routeSessionCount = 0
  let routeSweep: ReturnType<typeof setInterval> | null = null

  /** Why each recently ended session ended, and what it landed, for a caller that still holds its id. */
  const endedRoutes = new Map<string, EndedRoute>()

  /**
   * Land what a session clicked, as the route tool's Esc does (R21, R33): the
   * head and an armed via dropped, one undo step. Over a board edited since
   * the last call the route is replayed first; one that no longer replays
   * lands nothing, as an outside edit ends a route in the editor (R34).
   */
  const landClicked = (entry: RouteEntry): EndedRoute['landed'] | 'stale' | null => {
    const { agent, session } = entry
    if (ctx.openSession(agent.path) !== session || session.readOnly()) return null
    try {
      agent.rebase()
    } catch (error) {
      if (error instanceof RouteRefused) return 'stale'
      throw error
    }
    entry.landings.length = 0
    try {
      if (!agent.live.commit()) return null
      return landedOf(entry.landings)
    } finally {
      entry.landings.length = 0
    }
  }

  /** End a session, landing what it clicked; its viewport stays open. */
  const endRouteSession = (id: string, reason: string): EndedRoute | null => {
    const entry = routeSessions.get(id)
    if (!entry) return null
    routeSessions.delete(id)
    let landed: ReturnType<typeof landClicked>
    try {
      landed = landClicked(entry)
    } finally {
      entry.agent.dispose()
    }
    const ended: EndedRoute = {
      path: entry.agent.path,
      reason:
        landed === 'stale'
          ? `${reason} What it had clicked did not land: the board changed and the route no longer replays on it.`
          : reason,
      ...(landed && landed !== 'stale' ? { landed } : {}),
      told: false
    }
    endedRoutes.set(id, ended)
    if (endedRoutes.size > ENDED_ROUTE_MEMORY) endedRoutes.delete(endedRoutes.keys().next().value!)
    if (routeSessions.size === 0 && routeSweep) {
      clearInterval(routeSweep)
      routeSweep = null
    }
    return ended
  }

  /** An ended session as an answer lists it, marked told. */
  const endedRow = (id: string, ended: EndedRoute): Record<string, unknown> => {
    ended.told = true
    return {
      session: id,
      reason: ended.reason,
      ...(ended.landed ? { landed: ended.landed.landed, changed: ended.landed.changed } : {})
    }
  }

  /** Why a session ended and what it landed, as a refusal's detail says it. */
  const endedText = (ended: EndedRoute): string => {
    const landed = ended.landed?.landed
    if (!landed) return ended.reason
    const parts = [
      ...(landed.tracks.length ? [`tracks ${landed.tracks.join(', ')}`] : []),
      ...(landed.vias.length ? [`vias ${landed.vias.join(', ')}`] : [])
    ]
    return `${ended.reason} What it had clicked landed as one undo step: ${parts.join('; ') || 'nothing new'}.`
  }

  /** Sessions on `path` that ended since the agent last heard, as `ended` rows. */
  const untoldEndings = (path: string): Array<Record<string, unknown>> =>
    [...endedRoutes]
      .filter(([, ended]) => !ended.told && ended.path === path)
      .map(([id, ended]) => endedRow(id, ended))

  // Routing is an activity in a viewport: closing the viewport ends it.
  viewports.onClose((viewport, reason) => {
    for (const [id, entry] of routeSessions)
      if (entry.viewport === viewport.id) {
        const ended = endRouteSession(id, `Its viewport ${viewport.id} closed. ${reason}`)
        if (ended && reason === CLOSED_BY_AGENT) ended.told = true
        return ended?.landed
          ? { session: id, landed: ended.landed.landed, changed: ended.landed.changed }
          : id
      }
    return undefined
  })

  /** Sessions whose board closed, or that sat idle past their time, end. */
  const sweepRouteSessions = (): void => {
    const now = Date.now()
    for (const [id, entry] of routeSessions)
      if (ctx.openSession(entry.agent.path) !== entry.session)
        endRouteSession(id, 'Its board was closed.')
      else if (now - entry.agent.lastUsed > ROUTE_SESSION_IDLE_MS)
        endRouteSession(id, 'It sat idle for 10 minutes.')
  }

  const routeFailure = (error: unknown): BoardAgentError => {
    if (error instanceof RouteRefused)
      return {
        error: error.error,
        detail: error.detail,
        ...(error.candidates?.length ? { candidates: error.candidates } : {})
      }
    throw error
  }

  /**
   * The ids one landing added, changed and removed, as every write answers
   * them, and of what it added the route's own tracks and vias (on its net).
   */
  const landingDiff = ({ before, after, raws, nets }: Landing): LandingDiff => {
    const diff: LandingDiff = { created: [], updated: [], deleted: [], tracks: [], vias: [] }
    const was = new Set(boardItems(before).map((item) => item.id))
    const now = boardItems(after)
    for (const item of now) {
      if (!was.has(item.id)) {
        diff.created.push(item.id)
        if (item.kind === 'track' && nets.includes(item.track.net)) diff.tracks.push(item.id)
        else if (item.kind === 'via' && nets.includes(item.via.net)) diff.vias.push(item.id)
      } else if (raws.has(item.raw) && item.kind !== 'footprint' && item.kind !== 'pad')
        diff.updated.push(item.id)
    }
    const ids = new Set(now.map((item) => item.id))
    for (const id of was) if (!ids.has(id)) diff.deleted.push(id)
    return diff
  }

  /** Landings' diffs as one answer: the changed ids once each, the routes' copper in order. */
  const mergeLanded = (
    diffs: readonly LandingDiff[]
  ): { changed: McpChanged; landed: LandedCopper } => {
    const ids = (key: 'created' | 'updated' | 'deleted'): string[] => [
      ...new Set(diffs.flatMap((diff) => diff[key]))
    ]
    return {
      changed: { created: ids('created'), updated: ids('updated'), deleted: ids('deleted') },
      landed: { tracks: diffs.flatMap((d) => d.tracks), vias: diffs.flatMap((d) => d.vias) }
    }
  }

  const landedOf = (landings: readonly Landing[]): { changed: McpChanged; landed: LandedCopper } =>
    mergeLanded(landings.map(landingDiff))

  /** Board mm, y down, as a box in the scene's space (y up, x mirrored from the back). */
  const sceneBoxOf = (
    box: { x: number; y: number; width: number; height: number },
    flipped: boolean
  ): WorldBox => ({
    minX: flipped ? -(box.x + box.width) : box.x,
    maxX: flipped ? -box.x : box.x + box.width,
    minY: -(box.y + box.height),
    maxY: -box.y
  })

  /** What a session's picture frames: its view's rectangle, else `around` padded by half the follow. */
  const routeFrame = (
    view: RouteViewState,
    around: ReadonlyArray<{ x: number; y: number }>
  ): { x: number; y: number; width: number; height: number } | null => {
    if (view.frame) return view.frame
    if (around.length === 0) return null
    const xs = around.map((p) => p.x)
    const ys = around.map((p) => p.y)
    const half = view.follow / 2
    const minX = Math.min(...xs) - half
    const minY = Math.min(...ys) - half
    return {
      x: minX,
      y: minY,
      width: Math.max(...xs) + half - minX,
      height: Math.max(...ys) + half - minY
    }
  }

  /** Where a run is working, board mm: its head and tail, else its cursor, and the route laid so far. */
  const aroundOf = (run: RouteRun): Array<{ x: number; y: number }> => {
    const state = run.routeState()
    const tail = run.controller.state.tail
    return [
      ...(state.head ? [state.head.at] : []),
      ...(tail ? [boardPt(tail)] : []),
      ...(!tail && run.cursor ? [boardPt(run.cursor)] : []),
      ...run.laidPoints()
    ]
  }

  /**
   * Move the session's viewport to where it works, labeled with the call's
   * action. What it has not landed is drawn only in the pictures its calls
   * answer, never on the person's canvas.
   */
  const publishRoute = (entry: RouteEntry, action?: string): void => {
    const frame = routeFrame(entry.agent.view, aroundOf(entry.agent.live))
    if (frame || action)
      viewports.update(entry.viewport, {
        ...(frame ? { frame } : {}),
        ...(action ? { label: action } : {})
      })
  }

  /** Each run drawn in the session's view, framed alike: one shot per run. */
  const routeShots = async (
    entry: RouteEntry,
    runs: readonly RouteRun[],
    maxPixels: number
  ): Promise<
    | {
        shots: AgentCapture[]
        frame: { x: number; y: number; width: number; height: number }
        /** Zone fills missing across the shots (`AgentCapture.unfinishedFills`). */
        unfinishedFills: number
      }
    | BoardAgentError
  > => {
    const ended = (): BoardAgentError | null =>
      routeSessions.get(entry.agent.id) === entry ? null : routeGone(entry.agent.id)
    if (ended()) return ended()!
    const scene = (entry.agent.scene ??= ctx.routeScene?.() ?? null)
    if (!scene)
      return { error: 'renderer-failed', detail: 'The window has no viewport to draw into.' }
    const view = entry.agent.view
    const flipped = view.side === 'back'
    const frame = routeFrame(view, runs.flatMap(aroundOf))
    const box = frame ? sceneBoxOf(frame, flipped) : null
    const markHalfWidth = frame ? Math.max(frame.width, frame.height) / maxPixels : 0.02
    const shots: AgentCapture[] = []
    for (const run of runs) {
      const change = entry.session.lastChange()
      scene.show(
        run.board,
        {
          ...(view.layers ? { layers: view.layers } : {}),
          activeLayer: run.env.layer,
          options: {
            nonActiveDisplay: view.otherLayers,
            flipped,
            highlightNet: view.highlight && run.controller.active ? run.controller.state.net : 0
          }
        },
        change
      )
      scene.overlay(run.overlay(view.ratsnest), markHalfWidth)
      const shot = await scene.capture(box, maxPixels)
      if (ended()) return ended()!
      if (!shot) return { error: 'nothing-drawn', detail: 'The frame holds nothing to draw.' }
      shots.push(shot)
    }
    return {
      shots,
      frame: boardFrameOf(shots[0].visible, flipped),
      unfinishedFills: shots.reduce((sum, shot) => sum + (shot.unfinishedFills ?? 0), 0)
    }
  }

  /**
   * The picture fields an answer carries: frame, scale, the PNG, and what it
   * is missing. `shown` is the image sent when it is not `shot` (tiles of it).
   */
  const pictureFields = (
    shot: { dataUrl: string; width: number; height: number },
    frame: { x: number; y: number; width: number; height: number },
    unfinishedFills: number,
    shown = shot
  ): Record<string, unknown> => ({
    frame,
    width: shown.width,
    height: shown.height,
    mmPerPixel: Math.round((frame.width / shot.width) * 100000) / 100000,
    ...pictureNotes(unfinishedFills),
    image: png(shown.dataUrl)
  })

  /** What a session answers about its route: the router's state, sizes, what is laid and what is left. */
  const routeFacts = (run: RouteRun): Record<string, unknown> => {
    // A pair or a tune answers its own sizes and lengths (routeAgentTools.ts).
    if (run.tool) return { ...run.routeState(), layer: run.env.layer }
    const ctl = run.controller
    const width = ctl.widthState()
    const via = ctl.viaState()
    const state = run.routeState()
    const net = run.netName()
    return {
      ...state,
      ...(ctl.active ? { net } : {}),
      layer: run.env.layer,
      width: {
        value: roundMm(width.width),
        source: width.source,
        ...(width.outOfRule ? { outOfRule: true } : {})
      },
      via: {
        size: roundMm(via.via.diameter),
        drill: roundMm(via.via.drill),
        source: via.source
      },
      ...(ctl.state.viaTarget
        ? { armedVia: { to: ctl.state.viaTarget, type: ctl.state.viaType } }
        : {}),
      ...(ctl.active
        ? {
            placed: run.placed(),
            pushed: ctl.pushedCount(),
            remaining: ctl.clusters().others.length,
            targets: run.targets(ROUTE_TARGET_CAP)
          }
        : {})
    }
  }

  const ENDED_GUIDANCE =
    'ended lists the sessions on this board that ended since you last heard, and why; landed is the tracks and vias each landed from what it had clicked, as one undo step on the board tab, unsaved.'

  const ROUTE_STEP_GUIDANCE =
    'results lists what each gesture did; a blocked click lays nothing (nothing). laid is the copper this step clicked that has not landed yet (board mm); landed is the tracks and vias a landing wrote, by id. state is the head at the cursor; blockedBy names what is in the way and violations are its findings as board_check answers them. Preview candidates with route_preview, then step; commit lands the route as one undo step.'

  /** The project's rules and sizes a route is drawn with. */
  const routeSetupOf = (settings: BoardDesignSettings): RouteSetup => ({
    rules: settings.rules,
    classes: settings.classes,
    patterns: settings.patterns,
    assignments: settings.assignments,
    ...(settings.tuning ? { tuning: settings.tuning } : {}),
    extraSizes: settings.extraSizes ?? { tracks: [], vias: [] },
    ...(settings.customRules !== undefined ? { customRules: settings.customRules } : {})
  })

  /** A route's landing: one board command, as the route tool's, and what it changed. */
  const landRouteInto =
    (session: BoardSession, landings: Landing[]) =>
    (mutate: () => void, net: number, how?: { nets: number[]; label: MessageKey }): void => {
      const before = session.board()!
      session.runCommand(ctx.label(how?.label ?? tk('pcbEditor.commands.routeTrack')), mutate, {
        zones: (after, raws) => ({ stale: zonesStaleAfter(after, raws) })
      })
      const change = session.lastChange()
      landings.push({
        before,
        after: session.board()!,
        raws: change?.raws ?? new Set(),
        nets: how?.nets ?? [net]
      })
    }

  /**
   * Run a route call's `work` with the board at `path` held: open and writable,
   * its settings, and the env its runs draw with on the requested copper layer.
   */
  const withRouteBoard = async (
    path: string,
    request: Pick<McpBeginRouteRequest, 'layer' | 'settings' | 'grid'>,
    work: (board: {
      session: BoardSession
      live: KicadBoard
      settings: BoardDesignSettings
      env: RouteEnv
    }) => Promise<unknown>
  ): Promise<unknown> => {
    const release = ctx.hold(path)
    try {
      const session = await ctx.session(path)
      const live = session?.board()
      if (!session || !live)
        return { error: 'board-unreadable', detail: session?.parseError() ?? path }
      if (session.readOnly()) return { error: 'read-only' }
      const settings = await settingsFor(path)
      const copper = live.layers.filter((layer) => isCopperLayer(layer.name)).map((l) => l.name)
      if (request.layer !== undefined && !copper.includes(request.layer))
        return {
          error: 'layer-not-found',
          detail: `The board has no copper layer ${request.layer}.`,
          candidates: copper
        }
      const env: RouteEnv = {
        layer: request.layer ?? copper[0] ?? 'F.Cu',
        prefs: routePrefsWith(ctx.routerPrefs?.() ?? { mode: 'walkaround' }, request.settings),
        useConnectedWidth:
          request.settings?.useConnectedWidth ?? (await ctx.autoTrackWidth?.(path)) ?? true,
        grid: {
          spacing: request.grid?.spacing ?? ctx.gridSpacing?.() ?? DEFAULT_ROUTE_GRID,
          snap: request.grid?.snap ?? 'copper'
        },
        state: createRouteState()
      }
      return await work({ session, live, settings, env })
    } finally {
      release()
    }
  }

  /** What a call's landings answer: what they broke or fixed when `before` was checked, else what they left stale. */
  const landingChecks = async (
    path: string,
    session: BoardSession,
    settings: BoardDesignSettings,
    before: CheckState | null
  ): Promise<Record<string, unknown>> => {
    const afterBoard = session.board()!
    if (before) {
      const after = await runChecks(afterBoard, settings)
      remember(path, session, after)
      return report(before, after, liveStale(afterBoard, session))
    }
    const block = staleReport(afterBoard, liveStale(afterBoard, session), null)
    return block ? { stale: block } : {}
  }

  const beginRoute = async (request: McpBeginRouteRequest): Promise<unknown> => {
    sweepRouteSessions()
    if ((request.start === undefined) === (request.at === undefined))
      return { error: 'invalid-args', detail: 'Pass start (an item id) or at (a point), not both.' }
    const target = resolve(request.board)
    if ('error' in target) return target
    const path = target.path
    const attached = viewports.find(request.viewport, path)
    if ('error' in attached) return attached
    return withRouteBoard(path, request, async ({ session, live, settings, env }) => {
      const projectFile = request.tune ? await ctx.projectFile(path) : null
      const tool = routeToolSpec(
        request,
        settings.pairSizes ?? [],
        projectFile ? await ctx.readText(projectFile) : null
      )
      if (tool && 'error' in tool) return tool
      if (tool) env.tool = tool
      let net: number | undefined
      if (request.net !== undefined) {
        const found = live.nets.find((n) => n.name === request.net && n.number !== 0)
        if (!found)
          return {
            error: 'net-not-found',
            detail: `No net called ${request.net} is on the board.`,
            candidates: live.nets
              .filter((n) => n.number !== 0)
              .map((n) => n.name)
              .filter((name) => name.toLowerCase().includes(request.net!.toLowerCase().slice(0, 3)))
              .slice(0, 12)
          }
        net = found.number
      }
      const id = `route-${++routeSessionCount}`
      const landings: Landing[] = []
      const agent = new AgentRouteSession(
        id,
        path,
        () => (ctx.openSession(path) === session ? session.board() : null),
        routeSetupOf(settings),
        env,
        viewWith(DEFAULT_ROUTE_VIEW, request.view),
        landRouteInto(session, landings)
      )
      const entry: RouteEntry = { agent, session, viewport: attached.id, settings, landings }
      try {
        agent.begin({ to: request.start, at: request.at }, net)
        const sizes: McpRouteGesture[] = [
          ...(request.widthRow !== undefined ? [{ widthRow: request.widthRow }] : []),
          ...(request.width !== undefined ? [{ width: request.width }] : []),
          ...(request.viaRow !== undefined ? [{ viaRow: request.viaRow }] : []),
          ...(request.viaSize !== undefined ? [{ viaSize: request.viaSize }] : [])
        ]
        agent.step(sizes)
        // The session it replaces lands what it clicked, as Esc does (R21), once this one began.
        for (const [old, other] of routeSessions)
          if (other.agent.path === path)
            endRouteSession(old, 'route_begin started another on its board.')
        agent.rebase()
      } catch (error) {
        agent.dispose()
        return routeFailure(error)
      }
      const ended = untoldEndings(path)
      routeSessions.set(id, entry)
      routeSweep ??= setInterval(sweepRouteSessions, ROUTE_SWEEP_MS)
      publishRoute(entry, request.action)

      const run = agent.live
      const ctl = run.controller
      let picture: Record<string, unknown> = {}
      if (request.render) {
        const drawn = await routeShots(entry, [run], request.maxPixels ?? ROUTE_DEFAULT_MAX_PIXELS)
        if ('error' in drawn) {
          // A session the agent never heard of ends at once rather than at the idle sweep.
          const gone = endRouteSession(id, 'Its first picture failed.')
          if (gone) gone.told = true
          return drawn
        }
        picture = pictureFields(drawn.shots[0], drawn.frame, drawn.unfinishedFills)
      }
      return {
        board: boardRef(path),
        session: id,
        viewport: entry.viewport,
        ...routeFacts(run),
        ...(run.tool
          ? {}
          : {
              widths: ctl.widthList().map((row) => roundMm(row.size)),
              vias: ctl.viaList().map((row) => ({
                size: roundMm(row.size.diameter),
                drill: roundMm(row.size.drill)
              }))
            }),
        settings: {
          mode: env.prefs.mode,
          corner: env.prefs.corner ?? '45',
          ...routerSettings(env.prefs)
        },
        grid: {
          ...env.grid,
          origin: live.gridOrigin
            ? { x: mm(live.gridOrigin.x), y: mm(live.gridOrigin.y) }
            : { x: 0, y: 0 }
        },
        ...(ended.length ? { ended } : {}),
        revision: session.revision(),
        ...picture,
        guidance: [
          run.tool === 'pair'
            ? "pair names the halves, the sizes in force and the list widthRow picks from; placed is each half's length laid, mm. Step with route_step: { to } moves the cursor and the pair follows, { click: true } lays it, and over the far pads it arrives and lands as one undo step; { via: {} } arms a via pair."
            : run.tool === 'tune'
              ? 'tune is the net as the tuner reads it: length (skew for a skew tune), before, the target and the status. Step with route_step: { at } a point along the track ends the meanders there, on its side; { click: true } lays them with their tuning pattern as one undo step, and tuned answers what was laid.'
              : 'targets are the net copper not yet joined, nearest first. Step with route_step: { to } moves the cursor and the router proposes, { click: true } lays what it proposed. Nothing is written until the route arrives or commits.',
          ...(ended.length ? [ENDED_GUIDANCE] : [])
        ].join(' ')
      }
    })
  }

  /** Why session `id` is not live: how it ended, or that there is none. */
  const routeGone = (id: string): BoardAgentError => {
    const ended = endedRoutes.get(id)
    if (ended) {
      ended.told = true
      return {
        error: 'route-session-ended',
        detail: `Routing session ${id} ended. ${endedText(ended)}`
      }
    }
    return {
      error: 'route-session-not-found',
      detail: `No routing session ${id} is live: it ended, expired or never began.`,
      candidates: [...routeSessions.keys()]
    }
  }

  /** The live session a step or preview names, current with the board; or why there is none. */
  const routeEntry = (id: string): { entry: RouteEntry; rebased: boolean } | BoardAgentError => {
    sweepRouteSessions()
    viewports.sweep()
    const entry = routeSessions.get(id)
    // A call on the session is activity in its viewport.
    if (entry) viewports.find(entry.viewport)
    if (!entry) return routeGone(id)
    try {
      return { entry, rebased: entry.agent.rebase() }
    } catch (error) {
      // It no longer replays, so nothing of it lands (R34).
      endRouteSession(id, 'The board changed and the route no longer replays on it.')
      endedRoutes.get(id)!.told = true
      if (error instanceof RouteRefused)
        return {
          error: 'route-session-ended',
          detail: `The board changed and the route no longer replays on it: ${error.detail}`
        }
      throw error
    }
  }

  const stepRoute = async (request: McpStepRouteRequest): Promise<unknown> => {
    try {
      request.gestures.forEach((g, i) => gestureShape(g, i))
    } catch (error) {
      return routeFailure(error)
    }
    const found = routeEntry(request.session)
    if ('error' in found) return found
    const { entry, rebased } = found
    const { agent, session } = entry
    const path = agent.path
    const release = ctx.hold(path)
    try {
      const lands = request.gestures.some((g) => g.click || g.commit || g.finish !== undefined)
      if (lands && session.readOnly()) return { error: 'read-only' }
      const before = request.checks && lands ? await checksFor(path, session, entry.settings) : null
      // The session can end while the checks run (its viewport closed).
      if (routeSessions.get(agent.id) !== entry) return routeGone(agent.id)
      agent.view = viewWith(agent.view, request.view)
      const snap = agent.snapshot()
      const clicked = agent.live.clicked()
      entry.landings.length = 0
      let stepped: ReturnType<AgentRouteSession['step']>
      try {
        stepped = agent.step(request.gestures)
      } catch (error) {
        const failure = routeFailure(error)
        agent.restore(snap)
        return { ...failure, detail: `${failure.detail ?? failure.error} Nothing changed.` }
      }
      const run = agent.live
      publishRoute(entry, request.action)
      let committed: Record<string, unknown> = {}
      if (entry.landings.length > 0) {
        const checks = await landingChecks(path, session, entry.settings, before)
        const { landed, changed } = landedOf(entry.landings)
        committed = { landed, changed, ...checks }
      }
      const laid = entry.landings.length ? null : run.laidSince(clicked)
      let picture: Record<string, unknown> = {}
      if (request.render) {
        const drawn = await routeShots(entry, [run], request.maxPixels ?? ROUTE_DEFAULT_MAX_PIXELS)
        if ('error' in drawn) return drawn
        picture = pictureFields(drawn.shots[0], drawn.frame, drawn.unfinishedFills)
      }
      return {
        board: boardRef(path),
        session: agent.id,
        ...(rebased ? { rebased: true } : {}),
        results: stepped.results,
        ...(stepped.arrived.length ? { arrived: stepped.arrived } : {}),
        ...(stepped.skipped ? { skipped: stepped.skipped } : {}),
        ...(stepped.tuned ? { tuned: stepped.tuned } : {}),
        ...routeFacts(run),
        ...(laid && (laid.segments.length || laid.vias.length) ? { laid } : {}),
        ...committed,
        revision: session.revision(),
        ...picture,
        guidance: [
          ROUTE_STEP_GUIDANCE,
          ...(entry.landings.length ? [WRITE_GUIDANCE, checksGuidance(before !== null)] : []),
          ...(stepped.skipped
            ? [
                `The route landed at gesture ${stepped.results.length - 1}, so the ${stepped.skipped} after it were not applied (skipped); send them again to go on.`
              ]
            : []),
          ...(rebased
            ? [
                'The board changed since the last step, so the route was replayed over it (rebased); pushes were worked out again.'
              ]
            : [])
        ].join(' ')
      }
    } finally {
      entry.landings.length = 0
      release()
    }
  }

  const previewRoute = async (request: McpPreviewRouteRequest): Promise<unknown> => {
    try {
      request.candidates.forEach((gestures, c) =>
        gestures.forEach((g, i) => {
          gestureShape(g, i)
          if (g.commit || g.cancel || g.finish === 'here')
            throw new RouteRefused(
              'invalid-args',
              `Candidate ${c}, gesture ${i}: a preview never lands or ends the route; commit with route_step.`
            )
        })
      )
    } catch (error) {
      return routeFailure(error)
    }
    const found = routeEntry(request.session)
    if ('error' in found) return found
    const { entry, rebased } = found
    const release = ctx.hold(entry.agent.path)
    try {
      let previews: ReturnType<AgentRouteSession['preview']>
      try {
        previews = entry.agent.preview(request.candidates)
      } catch (error) {
        return routeFailure(error)
      }
      // A preview moves nothing, but the box says what is being compared.
      if (request.action) viewports.update(entry.viewport, { label: request.action })
      const candidates = previews.map(({ run, results, length }) => {
        const state = run.routeState()
        return {
          results,
          ...(run.landed ? { arrives: true } : {}),
          state: run.landed ? 'arrived' : state.state,
          ...(state.head ? { head: state.head } : {}),
          ...(state.blockedBy ? { blockedBy: state.blockedBy } : {}),
          ...(state.violations ? { violations: state.violations } : {}),
          length,
          ...(state.pair ? { pair: state.pair } : {}),
          ...(state.tune ? { tune: state.tune } : {}),
          ...(run.tuned() ? { tuned: run.tuned() } : {})
        }
      })
      let picture: Record<string, unknown> = {}
      if (request.render) {
        const tile = request.maxPixels ?? ROUTE_PREVIEW_TILE_PIXELS
        const drawn = await routeShots(
          entry,
          previews.map((p) => p.run),
          tile
        )
        if ('error' in drawn) return drawn
        const scene = entry.agent.scene!
        const tiled = drawn.shots.length > 1 ? await scene.tile(drawn.shots) : drawn.shots[0]
        picture = pictureFields(drawn.shots[0], drawn.frame, drawn.unfinishedFills, tiled)
      }
      // A preview drew its candidates on the session's scene; the next picture redraws it.
      return {
        board: boardRef(entry.agent.path),
        session: entry.agent.id,
        ...(rebased ? { rebased: true } : {}),
        candidates,
        ...picture,
        guidance:
          'Each candidate ran from the session as it stands; nothing changed. The image holds one tile per candidate, left to right, each showing frame. Step with the one to keep.'
      }
    } finally {
      release()
    }
  }

  /**
   * Attempt Finish Selected (`route.finish`, R46): from each pad and via in
   * turn, the editor's finish over the board as the last one left it; each
   * that arrives lands as its own undo step, each that does not is dropped.
   */
  const finishRoutes = async (request: McpFinishRoutesRequest): Promise<unknown> => {
    sweepRouteSessions()
    const target = resolve(request.board)
    if ('error' in target) return target
    const path = target.path
    return withRouteBoard(path, request, async ({ session, live, settings, env }) => {
      const setup = routeSetupOf(settings)
      const landings: Landing[] = []
      const land = landRouteInto(session, landings)
      // Each landing diffed once, in order, for its route's answer and the call's.
      const diffs: LandingDiff[] = []
      const diffed = (): LandingDiff[] => {
        while (diffs.length < landings.length) diffs.push(landingDiff(landings[diffs.length]))
        return diffs
      }
      let starts: string[]
      let prev: RouteRun
      try {
        const first = (prev = new RouteRun(live, setup, env, null))
        starts = [...new Set(request.starts.flatMap((id) => first.finishStarts(id)))]
      } catch (error) {
        return routeFailure(error)
      }
      const before = request.checks ? await checksFor(path, session, settings) : null
      const arrived: Array<{
        from: string
        to?: string
        length: number
        created: string[]
      }> = []
      const dropped: Array<{
        from: string
        reason: 'no-net' | 'joined' | 'stopped'
        to?: string
      }> = []
      // A run over the board the last landing left; its index is reused while nothing landed.
      const nextRun = (): RouteRun =>
        (prev = new RouteRun(session.board()!, setup, env, land, prev))
      for (const from of starts) {
        // Along each ratsnest line that ends on the start, gathered once (KiCad's Route Selected).
        const edges = nextRun().finishEdges(from)
        if ('dropped' in edges) {
          dropped.push({ from, reason: edges.dropped })
          continue
        }
        for (const edge of edges) {
          const landed = landings.length
          const outcome = nextRun().finishAlong(edge)
          if ('dropped' in outcome)
            dropped.push({
              from,
              reason: outcome.dropped,
              ...(outcome.to ? { to: outcome.to } : {})
            })
          else
            arrived.push({
              from,
              ...(outcome.to ? { to: outcome.to } : {}),
              length: outcome.length,
              created: mergeLanded(diffed().slice(landed)).changed.created
            })
        }
      }
      const written = {
        changed: mergeLanded(diffed()).changed,
        ...(landings.length ? await landingChecks(path, session, settings, before) : {})
      }
      return {
        board: boardRef(path),
        arrived,
        dropped,
        ...written,
        revision: session.revision(),
        guidance: [
          'arrived lists each route that landed, from its start to the copper it reached, the track length laid, mm, and created, the ids its landing wrote. dropped lists each left as it was: no-net, joined (no ratsnest line ends on it) or stopped (the finish did not reach to, the copper it headed for; route it with route_begin).',
          ...(landings.length
            ? [
                'Each landing is its own undo step on the board tab, now unsaved; workspace_save writes it.',
                checksGuidance(before !== null)
              ]
            : [])
        ].join(' ')
      }
    })
  }

  // ---- undo and redo ------------------------------------------------------

  /** Each item by id, fingerprinted by its top-level node: a step swaps the nodes it changed. */
  const nodePrints = (board: KicadBoard | null): Map<string, unknown> =>
    new Map(
      board
        ? boardItems(board)
            .filter((item) => item.kind !== 'pad')
            .map((item) => [item.id, item.raw])
        : []
    )

  /** Edit ▸ Undo or Redo on the board's tab, `steps` times or not at all. */
  const stepBoard = async (request: McpUndoBoardRequest): Promise<unknown> => {
    const target = resolve(request.board)
    if ('error' in target) return target
    const path = target.path
    const redo = request.redo === true
    const release = ctx.hold(path)
    try {
      const session = ctx.openSession(path)
      if (!session) {
        const detail = `No tab holds ${boardRef(path).name}, so its ${redo ? 'redo' : 'undo'} list is empty.`
        return redo ? { error: 'nothing-to-redo', detail } : { error: 'nothing-to-undo', detail }
      }
      if (session.readOnly()) return { error: 'read-only' }
      const before = nodePrints(session.board())
      const stepped = stepHistory(session, redo, request.steps, 'The board')
      if (!stepped.ok) return { error: stepped.error, detail: stepped.detail }
      const after = session.board()
      const stale = after ? staleReport(after, liveStale(after, session), null) : undefined
      return {
        board: boardRef(path),
        ...historyAnswer(
          redo,
          stepped.labels,
          changedBetween(before, nodePrints(after)),
          session,
          session.revision()
        ),
        ...(stale ? { stale } : {}),
        guidance: historyGuidance(redo)
      }
    } finally {
      release()
    }
  }

  // ---- dispatch -----------------------------------------------------------

  const batch = async (request: McpBatchBoardRequest): Promise<unknown> => {
    const ops = request.ops.filter((op): op is BatchEntry => BATCH_KINDS.has(op.kind))
    if (ops.length !== request.ops.length)
      return {
        error: 'not-applicable',
        detail:
          'A board batch holds items_get, items_query, items_update, items_delete, items_create, items_transform and board_place_footprint.'
      }
    const libraries = await librariesFor(ops, true)
    if ('error' in libraries) return libraries
    return edit(request.board, ops, {
      label: ctx.label(tk('commandLabels.agentBatch'), ops.length),
      dryRun: request.dryRun === true,
      refill: request.refill === true,
      batch: true,
      checks: request.checks === true,
      libraries
    })
  }

  const handlers: {
    [K in BoardRequest['kind']]: (request: Extract<BoardRequest, { kind: K }>) => Promise<unknown>
  } = {
    'describe-board': describe,
    'render-board': render,
    'render-board-3d': render3D,
    'check-board': check,
    'explain-board-limits': explain,
    'sync-board': sync,
    'get-board-items': read,
    'query-board-items': read,
    'update-board-item': (request) =>
      inViewport(request, false, () =>
        edit(request.board, [request], { checks: request.checks === true })
      ),
    'delete-board-items': (request) =>
      inViewport(request, true, () =>
        edit(request.board, [request], { checks: request.checks === true })
      ),
    'create-board-item': (request) =>
      inViewport(request, false, () =>
        edit(request.board, [request], { checks: request.checks === true })
      ),
    'transform-board-items': (request) =>
      inViewport(request, false, () =>
        edit(request.board, [request], { checks: request.checks === true })
      ),
    'batch-board': (request) =>
      inViewport(
        request,
        request.ops.some((op) => op.kind === 'delete-board-items'),
        () => batch(request)
      ),
    'refill-board': refill,
    'fanout-board': (request) => inViewport(request, false, () => fanout(request)),
    'cleanup-board': (request) => inViewport(request, true, () => cleanup(request)),
    'set-teardrops-board': (request) => inViewport(request, true, () => setTeardrops(request)),
    'begin-route': beginRoute,
    'step-route': stepRoute,
    'preview-route': previewRoute,
    'finish-routes': (request) => inViewport(request, false, () => finishRoutes(request)),
    'place-footprint-board': (request) => inViewport(request, false, () => placeFootprint(request)),
    'update-footprints-board': updateFootprints,
    'update-tuning-patterns-board': (request) =>
      inViewport(request, false, () => updateTuningPatterns(request)),
    'get-board-setup': getSetup,
    'update-board-setup': updateSetup,
    'apply-interface-preset': applyPreset,
    'undo-board': (request) => inViewport(request, true, () => stepBoard(request))
  }

  return {
    previewSync,
    dispatch: (request) =>
      (handlers[request.kind] as (request: BoardRequest) => Promise<unknown>)(request)
  }
}
