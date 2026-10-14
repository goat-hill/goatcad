/**
 * The operation registry: the only definition of what an agent can do.
 *
 * MCP tools, the discovery endpoints, and (later) the Python client and the CLI
 * are all generated from this list — nothing is hand-written twice. Design:
 * `docs/agent-api.md`.
 *
 * The order is the order a client sees, and it is the reading order of the
 * workflow rather than the alphabet: status and project constraints first,
 * then the parts catalog, then the libraries, then the design.
 */
import { OpRegistry } from './registry'
import { partsStatus } from './parts/status'
import { partsSearch } from './parts/search'
import { partsCompareMpn } from './parts/compareMpn'
import { partsBrowseCategories } from './parts/browseCategories'
import { partsListFilters } from './parts/listFilters'
import { partsSearchCategory } from './parts/searchCategory'
import { partsCacheDatasheet } from './parts/cacheDatasheet'
import { partsReadDatasheet } from './parts/readDatasheet'
import { partsOpenSettings } from './parts/openSettings'
import { projectContext } from './project/context'
import { projectSave } from './project/save'
import { projectOpen } from './project/open'
import { projectCreate } from './project/create'
import { projectClose } from './project/close'
import { projectCreateFile } from './project/createFile'
import { symbolListLibraries } from './symbol/listLibraries'
import { symbolListLibrary } from './symbol/listLibrary'
import { symbolSearch } from './symbol/search'
import { symbolGet } from './symbol/get'
import { symbolCreate } from './symbol/create'
import { symbolCopy } from './symbol/copy'
import { symbolDelete } from './symbol/delete'
import { symbolCheck } from './symbol/check'
import { footprintListLibraries } from './footprint/listLibraries'
import { footprintListLibrary } from './footprint/listLibrary'
import { footprintSearch } from './footprint/search'
import { footprintGet } from './footprint/get'
import { footprintCreate } from './footprint/create'
import { footprintCopy } from './footprint/copy'
import { footprintDelete } from './footprint/delete'
import { footprintComputeLandPattern } from './footprint/computeLandPattern'
import { footprintCacheModel } from './footprint/cacheModel'
import { footprintCheck } from './footprint/check'
import { schematicDescribe } from './schematic/describe'
import { itemsGet } from './items/get'
import { itemsQuery } from './items/query'
import { itemsUpdate } from './items/update'
import { itemsDelete } from './items/delete'
import { itemsCreate } from './items/create'
import { itemsTransform } from './items/transform'
import { schematicPlaceSymbol } from './schematic/placeSymbol'
import { schematicBind } from './schematic/bind'
import { schematicUpdateSymbols } from './schematic/updateSymbols'
import { boardDescribe } from './board/describe'
import { boardSync } from './board/sync'
import { boardRefill } from './board/refill'
import { boardFanout } from './board/fanout'
import { boardCleanup } from './board/cleanup'
import { boardSetTeardrops } from './board/teardrops'
import { boardApplyInterfacePreset } from './board/interfacePreset'
import { viewportOpen } from './viewport/open'
import { viewportClose } from './viewport/close'
import { routeBegin } from './route/begin'
import { routeStep } from './route/step'
import { routePreview } from './route/preview'
import { routeFinish } from './route/finish'
import { boardPlaceFootprint } from './board/placeFootprint'
import { boardUpdateFootprints } from './board/updateFootprints'
import { boardUpdateTuningPatterns } from './board/updateTuningPatterns'
import { boardGetSetup, boardUpdateSetup } from './board/setup'
import { schematicGetSetup, schematicUpdateSetup } from './schematic/setup'
import { makeBoardBatch } from './board/batch'
import { bomGet } from './bom/get'
import { bomUpdate } from './bom/update'
import { schematicConnect } from './schematic/connect'
import { schematicWire } from './schematic/wire'
import { schematicAddSheet } from './schematic/addSheet'
import { schematicSetPaper } from './schematic/setPaper'
import { schematicAnnotate } from './schematic/annotate'
import { schematicCleanup } from './schematic/cleanup'
import { schematicCheck } from './schematic/check'
import { boardCheck } from './board/check'
import { boardExplainLimits } from './board/explain'
import { renderSchematic } from './render/schematic'
import { renderBoard } from './render/board'
import { renderBoard3d } from './render/board3d'
import { renderSymbol } from './render/symbol'
import { renderFootprint } from './render/footprint'
import { renderModel } from './render/model'
import { renderGerbers } from './render/gerbers'
import { exportProfiles } from './export/profiles'
import { exportGerbers } from './export/gerbers'
import { exportDrill } from './export/drill'
import { exportBom } from './export/bom'
import { exportPositions } from './export/positions'
import { exportPackage } from './export/package'
import { makeSchematicBatch } from './schematic/batch'
import { makeFootprintBatch } from './footprint/batch'
import { makeSymbolBatch } from './symbol/batch'
import { appScripting } from './app/scripting'
import {
  boardRedo,
  boardUndo,
  footprintRedo,
  footprintUndo,
  schematicRedo,
  schematicUndo,
  symbolRedo,
  symbolUndo
} from './history'

/**
 * Everything except `batch`.
 *
 * `batch` resolves the operations it is asked to run against *this* registry,
 * which is what makes a nested batch impossible without a rule anybody has to
 * remember: the name simply is not there to find.
 */
const core = [
  partsStatus,
  appScripting,
  projectContext,
  projectCreate,
  projectCreateFile,
  projectSave,
  projectOpen,
  projectClose,
  partsSearch,
  partsCompareMpn,
  partsBrowseCategories,
  partsListFilters,
  partsSearchCategory,
  symbolListLibraries,
  symbolListLibrary,
  symbolSearch,
  symbolGet,
  symbolCheck,
  symbolUndo,
  symbolRedo,
  footprintListLibraries,
  footprintListLibrary,
  footprintSearch,
  footprintGet,
  footprintCheck,
  footprintUndo,
  footprintRedo,
  schematicDescribe,
  itemsGet,
  itemsQuery,
  itemsUpdate,
  itemsDelete,
  itemsCreate,
  itemsTransform,
  schematicPlaceSymbol,
  schematicBind,
  schematicUpdateSymbols,
  boardDescribe,
  boardGetSetup,
  boardSync,
  boardPlaceFootprint,
  boardUpdateFootprints,
  boardRefill,
  boardFanout,
  boardCleanup,
  boardSetTeardrops,
  boardApplyInterfacePreset,
  viewportOpen,
  viewportClose,
  routeBegin,
  routeStep,
  routePreview,
  routeFinish,
  boardUpdateTuningPatterns,
  boardUpdateSetup,
  boardCheck,
  boardExplainLimits,
  boardUndo,
  boardRedo,
  bomGet,
  bomUpdate,
  schematicConnect,
  schematicWire,
  schematicAddSheet,
  schematicSetPaper,
  schematicGetSetup,
  schematicUpdateSetup,
  schematicAnnotate,
  schematicCleanup,
  schematicCheck,
  schematicUndo,
  schematicRedo,
  renderSchematic,
  renderBoard,
  renderBoard3d,
  renderSymbol,
  renderFootprint,
  renderModel,
  renderGerbers,
  exportProfiles,
  exportPackage,
  exportGerbers,
  exportDrill,
  exportBom,
  exportPositions,
  symbolCreate,
  symbolCopy,
  symbolDelete,
  footprintComputeLandPattern,
  footprintCreate,
  footprintCopy,
  footprintDelete,
  footprintCacheModel,
  partsCacheDatasheet,
  partsReadDatasheet,
  partsOpenSettings
]

const batchable = new OpRegistry(core)

export const registry = new OpRegistry([
  ...core,
  makeSchematicBatch(batchable),
  makeSymbolBatch(batchable),
  makeFootprintBatch(batchable),
  makeBoardBatch(batchable)
])

/** The wire version of the published schemas. Additive within a major. */
export const SCHEMA_VERSION = '1.0.0'

export type { OpContext, OpEffect, PartsService, DesignOutcome } from './context'
export type { OpError, OpErrorCode, OpOutcome } from './errors'
export type { RegisteredOp, OpScope } from './registry'
