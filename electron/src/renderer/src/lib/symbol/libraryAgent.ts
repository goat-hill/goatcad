/**
 * The agent's door to the libraries: operations served by the window, never by
 * a sheet.
 *
 * The sheet agent (`sheetAgent.ts`) is a map from request kind to handler over
 * a context the editor or a background tab provides. This is the same shape
 * for what needs no sheet at all — a symbol written into the project library,
 * one deleted from it, one drawn from any tier — so `App.vue` asks one question
 * of each door ("is this request yours?") rather than growing an `if` per
 * operation. A footprint render, a library listing, anything else that reads
 * or writes a library without a document open, lands here.
 *
 * **A project is optional where the tiers allow it.** Rendering a global or
 * standard symbol needs no project, so `render-symbol` with none open reads
 * those tiers alone; writing into the project library does need one, and the
 * writer says so. The rule is per handler, not per door.
 *
 * Failures come back as `{ error, detail, candidates? }`, the sheet agent's
 * convention, which the window unwraps into the envelope's typed failure.
 */
import type {
  McpChanged,
  McpCheckAnswer,
  McpCopyFootprintRequest,
  McpCopySymbolRequest,
  McpCheckSymbolRequest,
  McpCreateFootprintRequest,
  McpCreateSymbolRequest,
  McpDeleteFootprintRequest,
  McpDeleteSymbolRequest,
  McpDesignRequest,
  McpFootprintTarget,
  McpGetFootprintRequest,
  McpGetSymbolRequest,
  McpLandPatternRequest,
  McpRenderFootprintRequest,
  McpRenderModelRequest,
  McpRenderSymbolRequest,
  McpSymbolTarget,
  McpWriteAnswer
} from '../../../../preload/mcpTypes'
import type { FootprintRecord } from '../../../../main/libraryIndexTypes'
import {
  getLibSymbolProperty,
  libSymbolChain,
  libSymbolUnitCount,
  libSymbolUnitPins,
  type KicadLibSymbol,
  type KicadSchematic
} from '../kicad/schematic'
import { parseKicadFootprint, type KicadFootprint } from '../kicad/footprint'
import { footprintExtents, type FootprintExtent } from '../footprint/footprintExtent'
import type { Nm } from '../kicad/coordinates'
import { placementGeometry } from '../schematic/schematicTools'
import { directionOf } from '../schematic/wireReshape'
import { entriesFromLibrary, type LibrarySymbol, type SymbolSources } from './symbolSources'
import { asMm, sheetFrameOf, type AgentCapture, type WorldBox } from '../schematic/schematicAgent'
import {
  buildSymbolPreviewFromDefinitions,
  namespaceSymbolLibrary,
  type KicadSymbolLibrary
} from '../kicad/symbolLibrary'
import type { SymbolPinSpec } from './symbolLayout'
import type {
  CopySymbolResult,
  CreateSymbolInput,
  CreateSymbolResult,
  DeleteSymbolResult,
  SymbolWriteContext
} from '../symbolCreation'
import { librarySymbolCopy } from './symbolCopy'
import { checkAnswer } from './checkAnswer'
import type { SExprList } from '../kicad/sexpr'
import type { MessageKey } from '../messageKey'
import type {
  CopyFootprintResult,
  CreateFootprintInput,
  CreateFootprintResult,
  DeleteFootprintResult,
  FootprintWriteContext
} from '../footprintCreation'
import type { ModelCapture } from '../engine/board3d/modelCapture'
import type { MmRect, ModelFacts, RawModelBounds } from '../engine/board3d/modelFacts'
import type { FootprintSpec } from '../footprint/footprintGenerate'
import { FOOTPRINT_CHECK_RULES } from '../footprint/footprintChecks'
import { pinCheck } from '../footprint/pinCheck'
import { footprintItems, footprintRecord, itemRow, padRecord } from '../footprint/footprintItems'
import { landPattern } from '../footprint/landPattern'
import { checkCodeFilter, groupChecks, type CheckResult } from '../schematic/checks'
import { SYMBOL_CHECK_RULES, symbolChecks } from './symbolChecks'
import { extractConnectionGrid } from '../kicad/project'

export type LibraryRequest =
  | McpCheckSymbolRequest
  | McpCreateSymbolRequest
  | McpDeleteSymbolRequest
  | McpRenderSymbolRequest
  | McpGetSymbolRequest
  | McpGetFootprintRequest
  | McpRenderFootprintRequest
  | McpCreateFootprintRequest
  | McpDeleteFootprintRequest
  | McpLandPatternRequest
  | McpRenderModelRequest
  | McpCopyFootprintRequest
  | McpCopySymbolRequest

const LIBRARY_KINDS: ReadonlySet<string> = new Set<LibraryRequest['kind']>([
  'check-symbol',
  'create-symbol',
  'delete-symbol',
  'create-footprint',
  'delete-footprint',
  'land-pattern',
  'render-symbol',
  'get-symbol',
  'get-footprint',
  'render-footprint',
  'render-model',
  'copy-footprint',
  'copy-symbol'
])

/** Whether this door serves the request; the window asks before the sheet is resolved. */
export const isLibraryRequest = (request: McpDesignRequest): request is LibraryRequest =>
  LIBRARY_KINDS.has(request.kind)

/** What the door reads through and writes with. The window supplies the real
 *  ones; a test supplies fakes. */
export interface LibraryAgentContext {
  /** The open workspace folder, or null. */
  projectPath(): string | null
  /** The active project's `.kicad_pro`, or null when none is active. */
  projectFile(): string | null
  /** Whether a tab holds this file with unsaved edits. */
  hasUnsavedEdits(path: string): boolean
  /** A tab holds this file: give it the text just written, as saved. */
  reloadOpenFile(path: string, text: string): void
  /** Re-read the project's library index, so a footprint just written resolves. */
  refreshIndex(): Promise<void>
  /** Run an agent's edit on an open library's document; false when no tab holds it. */
  editOpenLibrary(
    path: string,
    label: MessageKey,
    mutate: (library: KicadSymbolLibrary) => void
  ): boolean
  /** The library tiers visible from a project — or, for null, the global and
   *  standard tiers alone. */
  sources(projectPath: string | null): SymbolSources
  /** Draw a document off-screen; null when the window has no viewport. */
  capture(document: KicadSchematic, box: WorldBox | null, maxPixels: number): AgentCapture | null
  /** Draw a footprint off-screen; null when the window has no viewport. */
  captureFootprint(footprint: KicadFootprint, maxPixels: number): AgentCapture | null
  /** The index record for a footprint id across every tier, or undefined. */
  findFootprint(libId: string): Promise<FootprintRecord | undefined>
  /** A placed footprint's board copy as footprint text (`lib/board/footprintCopy.ts`). */
  placedFootprint(reference: string, board: string): Promise<PlacedCopy<{ libId: string }>>
  /** A placed symbol's definition as its sheet embeds it: the sheet's document and the copy's id. */
  placedSymbol(
    reference: string,
    sheet: string | undefined
  ): Promise<PlacedCopy<{ document: KicadSchematic; id: string }>>
  /** Footprint ids near a miss, for the refusal. */
  footprintCandidates(libId: string): Promise<string[]>
  /** Symbol ids near a miss, for the refusal. */
  symbolCandidates(libId: string): Promise<string[]>
  /** The revision of the session a tab holds for this library, or null. */
  libraryRevision(path: string): Promise<number | null>
  /** A file's text, or null when it cannot be read. */
  readFile(path: string): Promise<string | null>
  /** The symbol editor's grid, which the symbol checks use when no project sets one. */
  symbolGrid(): Nm
  /**
   * What a `(model …)` link is: whether the file is there, the box the part
   * fills where the footprint puts it, and how that box sits over the land
   * pattern (`engine/board3d/modelFacts.ts`). With no footprint, the status
   * and the file alone.
   */
  modelFacts(input: {
    path: string
    footprintFile: string | null
    footprint?: KicadFootprint
    boxes?: { fab: MmRect | null; courtyard: MmRect | null; pads: MmRect | null }
    decode?: boolean
  }): Promise<ModelFacts>
  /**
   * Draw one model alone in four fixed views, and measure the file while it is
   * decoded: the box is the model's OWN, with no footprint transform, since
   * this reads a file rather than a part on a board.
   */
  captureModel(
    resolvedPath: string,
    maxPixels: number
  ): Promise<{
    capture: ModelCapture | null
    bounds: RawModelBounds | null
    triangles: number
    meshes: number
  } | null>
  /** Draw a footprint as the one-part board its 3D pane builds, with its model
   *  on it. `placed` false means nothing was there to draw. */
  captureFootprintWithModel(
    footprint: KicadFootprint,
    footprintFile: string,
    maxPixels: number
  ): Promise<{ capture: ModelCapture | null; placed: boolean }>
  copyFootprint(
    input: { sourceText: string; name: string; library?: string },
    context: FootprintWriteContext
  ): Promise<CopyFootprintResult>
  copySymbol(
    input: { node: SExprList; name: string; library?: string },
    context: SymbolWriteContext
  ): Promise<CopySymbolResult>
  createSymbol(input: CreateSymbolInput, context: SymbolWriteContext): Promise<CreateSymbolResult>
  deleteSymbol(
    input: { name: string; library?: string },
    context: SymbolWriteContext
  ): Promise<DeleteSymbolResult>
  createFootprint(
    input: CreateFootprintInput,
    context: FootprintWriteContext
  ): Promise<CreateFootprintResult>
  deleteFootprint(
    input: { name: string; library?: string },
    context: FootprintWriteContext
  ): Promise<DeleteFootprintResult>
  /** A library file on disk changed (or appeared): every parsed copy of it is
   *  behind, and the open editors re-read their tiers on this. */
  libraryChanged(path: string, created: boolean): Promise<void>
  /**
   * Give a file a tab behind the one the person is on, never in its place: an
   * agent's write must not interrupt what they are doing. Bringing a tab to
   * the front is `project.open`'s job, so it happens on purpose or not at all.
   */
  openBehind(path: string): void
}

export interface LibraryAgent {
  dispatch(request: LibraryRequest): Promise<unknown>
}

/** A placed part's design copy, found — with the file holding it — or the refusal. */
export type PlacedCopy<T> =
  | ({ ok: true; file: string; text?: string } & T)
  | { ok: false; error: string; detail: string; candidates?: string[] }

/** A symbol definition and where it was read: a library tier, or a sheet's copy. */
interface SymbolSource {
  id: string
  sheet: KicadSchematic
  tier?: LibrarySymbol['tier']
  description?: string
  placed?: { reference: string; file: string }
}

/** A footprint read for an answer, from a library file or a board's copy. */
interface LoadedFootprint {
  footprint: KicadFootprint
  libId: string
  /** The library file, or the board for a copy: what a model path resolves against. */
  file: string
  tier: string
  models: string[]
  placed?: { reference: string; board: string }
}

type Refusal = { error: string; detail: string; candidates?: string[] }

const isRefusal = (value: object): value is Refusal => 'error' in value

const refusalOf = (placed: { error: string; detail: string; candidates?: string[] }): Refusal => ({
  error: placed.error,
  detail: placed.detail,
  ...(placed.candidates ? { candidates: placed.candidates } : {})
})

/** How an answer names a symbol: its definition's id and tier, and for a copy the placement. */
const symbolWhere = (source: SymbolSource): Record<string, unknown> =>
  source.placed
    ? {
        libId: source.id,
        reference: source.placed.reference,
        sheet: source.placed.file,
        tier: 'sheet'
      }
    : { libId: source.id, tier: source.tier }

/** How an answer names a footprint: its id and tier, and for a copy the placement. */
const footprintWhere = (loaded: LoadedFootprint): Record<string, unknown> =>
  loaded.placed
    ? {
        libId: loaded.libId,
        reference: loaded.placed.reference,
        board: loaded.placed.board,
        tier: loaded.tier
      }
    : { libId: loaded.libId, tier: loaded.tier }

/** A library write's answer: the ids it touched, and the revision when a tab's session took it. */
type LibraryWriteAnswer = Omit<McpWriteAnswer, 'revision'> & {
  revision?: number
  [key: string]: unknown
}

const created = (id: string): McpChanged => ({ created: [id], updated: [], deleted: [] })

/** "Nickname:Name" split at its first colon. */
const splitLibId = (libId: string): { nickname: string; name: string } => ({
  nickname: libId.slice(0, libId.indexOf(':')),
  name: libId.slice(libId.indexOf(':') + 1)
})

/** The unit and body style a read asks for, clamped to what the chain draws. */
const unitAndStyle = (
  chain: KicadLibSymbol[],
  request: { unit?: number; style?: number }
): { units: number; unit: number; styles: number; style: number } => {
  const units = libSymbolUnitCount(chain)
  const styles = Math.max(
    1,
    ...chain.flatMap((definition) => definition.variants.map((variant) => variant.style))
  )
  return {
    units,
    unit: Math.max(1, Math.min(request.unit ?? 1, units)),
    styles,
    style: Math.max(1, Math.min(request.style ?? 1, styles))
  }
}

export const createLibraryAgent = (ctx: LibraryAgentContext): LibraryAgent => {
  const unknownSymbol = async (libId: string): Promise<Refusal> => ({
    error: 'unknown-symbol',
    detail: libId,
    candidates: await ctx.symbolCandidates(libId)
  })

  /** The revision a write left on the library's tab, when one took it. */
  const revisionOf = async (path: string, inTab: boolean): Promise<{ revision?: number }> => {
    const revision = inTab ? await ctx.libraryRevision(path) : null
    return revision === null ? {} : { revision }
  }

  const symbolWriteContext = (): SymbolWriteContext => ({
    projectPath: ctx.projectPath(),
    projectFile: ctx.projectFile(),
    editOpenLibrary: ctx.editOpenLibrary
  })
  const footprintWriteContext = (): FootprintWriteContext => ({
    projectPath: ctx.projectPath(),
    projectFile: ctx.projectFile(),
    hasUnsavedEdits: ctx.hasUnsavedEdits,
    reloadOpenFile: ctx.reloadOpenFile
  })

  const createSymbol = async (request: McpCreateSymbolRequest): Promise<unknown> => {
    const result = await ctx.createSymbol(
      {
        name: request.name,
        library: request.library,
        groups: request.groups,
        pins: request.pins as SymbolPinSpec[] | undefined,
        ...(request.power ? { power: request.power } : {}),
        overwrite: request.overwrite,
        fields: {
          reference: request.reference ?? (request.power ? '#PWR' : 'U'),
          value: request.value ?? request.name,
          description: request.description,
          keywords: request.keywords,
          datasheet: request.datasheet,
          extra: request.properties
        }
      },
      symbolWriteContext()
    )
    if (!result.ok) return { error: result.error, detail: result.detail ?? result.remedy }
    // The library changed; every parsed copy of it is behind. The open
    // sheet's editor re-reads its tiers on this, so the next place embeds the
    // symbol as it is now and the mismatch check compares against it.
    await ctx.libraryChanged(result.libraryPath, result.created)
    // Generation gets the drafting right and cannot get taste right, so the
    // library is a tab the person can find for review — behind the one they
    // are on, since they may be mid-task on it.
    ctx.openBehind(result.libraryPath)
    const checks = await symbolCheckResults(result.libId)
    const layout = result.layout
    const answer: LibraryWriteAnswer = {
      libId: result.libId,
      file: result.libraryPath,
      ...(result.created ? { createdLibrary: true } : {}),
      changed: result.replaced
        ? { created: [], updated: [result.libId], deleted: [] }
        : created(result.libId),
      ...(await revisionOf(result.libraryPath, result.inTab)),
      ...(layout
        ? {
            pinsDrawn: layout.pins.length,
            omitted: layout.omitted,
            stacks: layout.stacks,
            ...(layout.warnings.length ? { warnings: layout.warnings } : {})
          }
        : {}),
      // A new definition: every finding is new.
      ...(checks?.length
        ? { checks: { new: groupChecks(checks, SYMBOL_CHECK_RULES), resolved: [] } }
        : {}),
      guidance: layout
        ? 'Look at it with render_symbol, then place it with schematic_place_symbol, symbol libId. Act on any warnings, and report omitted and stacked pads.'
        : 'Blank: draw its body and pins with symbol_batch (items_create with symbol libId), then look with render_symbol.'
    }
    return answer
  }

  const deleteSymbol = async (request: McpDeleteSymbolRequest): Promise<unknown> => {
    const readOnly = await readOnlySymbol(request.symbol)
    if (readOnly) return readOnly
    const { nickname, name } = splitLibId(request.symbol)
    const result = await ctx.deleteSymbol({ name, library: nickname }, symbolWriteContext())
    if (!result.ok) {
      return {
        error: result.error,
        detail: result.detail ?? result.remedy ?? request.symbol,
        ...(result.candidates?.length ? { candidates: result.candidates } : {})
      }
    }
    await ctx.libraryChanged(result.libraryPath, false)
    const answer: LibraryWriteAnswer = {
      changed: { created: [], updated: [], deleted: [result.libId] },
      ...(await revisionOf(result.libraryPath, result.inTab)),
      file: result.libraryPath,
      guidance: 'Placements keep their sheet copy.'
    }
    return answer
  }

  /** The refusal for a write to a symbol a read-only tier holds, or null. */
  const readOnlySymbol = async (libId: string): Promise<Refusal | null> => {
    const sources = ctx.sources(ctx.projectPath())
    await sources.ready()
    const nickname = libId.slice(0, libId.indexOf(':'))
    const entry =
      (await findSymbol(libId)) ??
      [...sources.tableSymbols.value, ...sources.standardSymbols.value].find((other) =>
        other.libId.startsWith(`${nickname}:`)
      )
    return entry && entry.tier !== 'project'
      ? { error: 'library-read-only', detail: `${libId} is in the ${entry.tier} library.` }
      : null
  }

  const copySymbol = async (request: McpCopySymbolRequest): Promise<unknown> => {
    const entry = await findSymbol(request.libId)
    const definition = entry?.sheet.libSymbols.get(request.libId)
    if (!entry || !definition) return unknownSymbol(request.libId)
    const { name: sourceName } = splitLibId(request.libId)
    const name = request.name?.trim() || sourceName
    const node = librarySymbolCopy(definition, (other) => entry.sheet.libSymbols.get(other), name)
    const result = await ctx.copySymbol(
      { node, name, ...(request.library ? { library: request.library } : {}) },
      symbolWriteContext()
    )
    if (!result.ok) {
      return { error: result.error, detail: result.detail ?? result.remedy ?? request.libId }
    }
    await ctx.libraryChanged(result.libraryPath, result.createdLibrary)
    ctx.openBehind(result.libraryPath)
    const answer: LibraryWriteAnswer = {
      libId: result.libId,
      source: request.libId,
      file: result.libraryPath,
      ...(result.createdLibrary ? { createdLibrary: true } : {}),
      changed: created(result.libId),
      ...(await revisionOf(result.libraryPath, result.inTab)),
      guidance:
        'Edit it with items_update or symbol_batch on libId; place it with schematic_place_symbol, symbol libId.'
    }
    return answer
  }

  // A picture of a library symbol needs libraries and a scene, and no sheet:
  // the definition is wrapped in a scratch document the way the symbol editor
  // previews it, and drawn by the window's off-screen engine.
  /** The definition for a lib id from any tier, parsing a standard library on
   *  demand — standard libraries are listed from the index and read only when
   *  something in them is wanted. A library a tab holds with unsaved edits is
   *  read from the tab, since the tiers are parsed from disk and the edits an
   *  agent just made are in the buffer. */
  const findSymbol = async (libId: string): Promise<LibrarySymbol | undefined> => {
    const sources = ctx.sources(ctx.projectPath())
    await sources.ready()
    const library = sources.registeredLibraries.value.get(libId.slice(0, libId.indexOf(':')))
    if (library && ctx.hasUnsavedEdits(library.path)) {
      const text = await ctx.readFile(library.path)
      if (text !== null) {
        const parsed = namespaceSymbolLibrary(text, library.nickname)
        return entriesFromLibrary(parsed, library.scope).find((entry) => entry.libId === libId)
      }
    }
    const find = (): LibrarySymbol | undefined =>
      [...sources.tableSymbols.value, ...sources.standardSymbols.value].find(
        (entry) => entry.libId === libId
      )
    let entry = find()
    if (!entry) {
      await sources.ensureStandardLibrary(libId)
      entry = find()
    }
    return entry
  }

  /** A library id from any tier, or a reference's definition on its sheet. */
  const symbolSource = async (target: McpSymbolTarget): Promise<SymbolSource | Refusal> => {
    if (target.symbol.includes(':')) {
      const entry = await findSymbol(target.symbol)
      return entry
        ? {
            id: entry.libId,
            sheet: entry.sheet,
            tier: entry.tier,
            ...(entry.description ? { description: entry.description } : {})
          }
        : unknownSymbol(target.symbol)
    }
    const placed = await ctx.placedSymbol(target.symbol, target.sheet)
    if (!placed.ok) return refusalOf(placed)
    return {
      id: placed.id,
      sheet: placed.document,
      placed: { reference: target.symbol, file: placed.file }
    }
  }

  const renderSymbol = async (request: McpRenderSymbolRequest): Promise<unknown> => {
    const source = await symbolSource(request)
    if (isRefusal(source)) return source
    const definition = source.sheet.libSymbols.get(source.id)
    if (!definition) return unknownSymbol(request.symbol)
    const chain = libSymbolChain(definition, (name) => source.sheet.libSymbols.get(name))
    const { units, unit, styles, style } = unitAndStyle(chain, request)
    const preview = buildSymbolPreviewFromDefinitions(
      source.sheet.libSymbols,
      source.id,
      unit,
      style
    )
    if (!preview) return unknownSymbol(request.symbol)
    const shot = ctx.capture(preview, null, request.maxPixels)
    if (!shot) {
      return { error: 'renderer-failed', detail: 'The window has no viewport to draw into.' }
    }
    return {
      ...symbolWhere(source),
      ...(units > 1 ? { unit, units } : {}),
      ...(styles > 1 ? { style, styles } : {}),
      frame: sheetFrameOf(shot.visible),
      width: shot.width,
      height: shot.height,
      // Said out loud rather than left to be noticed, as `render.schematic` does.
      ...(shot.limit === undefined
        ? {}
        : {
            note: `Drawn at ${shot.limit.pixels} rather than the ${request.maxPixels} asked for: ${shot.limit.reason === 'texture' ? `this GPU addresses ${shot.limit.texture} pixels a side` : 'the memory budget'}.`
          }),
      image: {
        mimeType: 'image/png',
        base64: shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1)
      },
      guidance:
        'frame is millimeters in symbol space. If names touch or the body is misshapen, regroup, set a group side or shorten names, then symbol_create with overwrite.'
    }
  }

  // A library symbol's geometry as items_get reports a placed one: pins as
  // offsets from the origin at angle 0, in sheet space (y down), so origin +
  // offset is where a pin lands and schematic_place_symbol's angle turns it from there.
  const getSymbol = async (request: McpGetSymbolRequest): Promise<unknown> => {
    const source = await symbolSource(request)
    if (isRefusal(source)) return source
    const definition = source.sheet.libSymbols.get(source.id)
    if (!definition) return unknownSymbol(request.symbol)
    const chain = libSymbolChain(definition, (name) => source.sheet.libSymbols.get(name))
    const { units, unit, styles, style } = unitAndStyle(chain, request)
    // Numeric pad order, as a datasheet's pin table reads; the drawing order
    // (side by side, top to bottom) is what items_get keeps for a placed part.
    const pins = [...libSymbolUnitPins(chain, unit, style)].sort((a, b) =>
      a.number.localeCompare(b.number, undefined, { numeric: true })
    )
    const outline = placementGeometry(chain, unit, style).outline
    const xs = outline.map((point) => point.x)
    const ys = outline.map((point) => point.y)
    const fields: Record<string, string> = {}
    for (const property of definition.properties) {
      if (property.key.startsWith('ki_')) continue
      if (property.value) fields[property.key] = property.value
    }
    const filters = getLibSymbolProperty(definition, 'ki_fp_filters') ?? ''
    const answer: Record<string, unknown> = {
      ...(source.description ? { description: source.description } : {}),
      ...(definition.isPower ? { isPower: true } : {}),
      units,
      unit,
      ...(styles > 1 ? { styles, style } : {}),
      box: {
        x: asMm(Math.min(...xs) as Nm),
        y: asMm(-Math.max(...ys) as Nm),
        width: asMm((Math.max(...xs) - Math.min(...xs)) as Nm),
        height: asMm((Math.max(...ys) - Math.min(...ys)) as Nm)
      },
      pins: pins.map((pin) => ({
        number: pin.number,
        name: pin.name,
        type: pin.electricalType,
        at: { x: asMm(pin.position.x), y: asMm(-pin.position.y as Nm) },
        angle: pin.position.angle,
        // A pin points into the body; its free side is the way back out.
        free: directionOf(pin.position.angle + 180),
        ...(pin.hidden ? { hidden: true } : {})
      })),
      fields,
      footprintFilters: filters.split(/\s+/).filter(Boolean)
    }
    const columns = request.columns
    return {
      ...symbolWhere(source),
      ...(columns
        ? Object.fromEntries(
            columns.filter((key) => key in answer).map((key) => [key, answer[key]])
          )
        : answer),
      guidance:
        "A pin lands at origin + at, turned counterclockwise by schematic_place_symbol's angle; free is the side a wire leaves from. Footprint pad numbers must match these pin numbers."
    }
  }

  /** The pin grid the symbol checks use: the project's connection grid, else the editor's. */
  const symbolCheckGrid = async (): Promise<Nm> => {
    const projectFile = ctx.projectFile()
    const text = projectFile ? await ctx.readFile(projectFile) : null
    return (text && extractConnectionGrid(text)) || ctx.symbolGrid()
  }

  /** The symbol checks over a definition, as the symbol editor's pill runs them; undefined when it has none. */
  const sourceCheckResults = async (source: SymbolSource): Promise<CheckResult[] | undefined> => {
    const definition = source.sheet.libSymbols.get(source.id)
    if (!definition) return undefined
    return symbolChecks(definition, await symbolCheckGrid(), (name) =>
      source.sheet.libSymbols.get(name)
    )
  }

  const symbolCheckResults = async (libId: string): Promise<CheckResult[] | undefined> => {
    const source = await symbolSource({ symbol: libId })
    return isRefusal(source) ? undefined : sourceCheckResults(source)
  }

  const checkSymbol = async (request: McpCheckSymbolRequest): Promise<unknown> => {
    const only = checkCodeFilter(request.codes, SYMBOL_CHECK_RULES)
    if (typeof only !== 'function') return only
    const source = await symbolSource(request)
    if (isRefusal(source)) return source
    const all = await sourceCheckResults(source)
    if (!all) return unknownSymbol(request.symbol)
    const answer: McpCheckAnswer = checkAnswer(
      only(all),
      SYMBOL_CHECK_RULES,
      'Positions in messages are millimeters in symbol space, y up, as the file stores them. Fix and check again, or place it with schematic_place_symbol when ok.',
      request.codes
    )
    return { ...symbolWhere(source), ...(request.codes ? { codes: request.codes } : {}), ...answer }
  }

  // The parsed file, since the index holds only a header scan of a footprint;
  // or a placed footprint's copy, brought to the library frame by its board.
  const loadFootprint = async (target: McpFootprintTarget): Promise<LoadedFootprint | Refusal> => {
    if (target.board) {
      const placed = await ctx.placedFootprint(target.footprint, target.board)
      if (!placed.ok) return refusalOf(placed)
      try {
        const footprint = parseKicadFootprint(placed.text ?? '')
        return {
          footprint,
          libId: placed.libId,
          file: placed.file,
          tier: 'board',
          models: footprint.model ? [footprint.model.path] : [],
          placed: { reference: target.footprint, board: placed.file }
        }
      } catch (error) {
        return {
          error: 'footprint-unreadable',
          detail: `${target.footprint} on ${placed.file}: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
    const libId = target.footprint
    const record = await ctx.findFootprint(libId)
    if (!record) {
      const candidates = await ctx.footprintCandidates(libId)
      return { error: 'unknown-footprint', detail: libId, candidates }
    }
    const source = await ctx.readFile(record.file)
    if (source === null) {
      return { error: 'footprint-unreadable', detail: record.file }
    }
    try {
      return {
        footprint: parseKicadFootprint(source),
        libId: record.id,
        file: record.file,
        tier: record.scope,
        models: record.models
      }
    } catch (error) {
      return {
        error: 'footprint-unreadable',
        detail: `${record.file}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  const frameOf = (extent: FootprintExtent | null): MmRect | null =>
    extent
      ? {
          x: asMm(extent.minX as Nm),
          y: asMm(extent.minY as Nm),
          width: asMm((extent.maxX - extent.minX) as Nm),
          height: asMm((extent.maxY - extent.minY) as Nm)
        }
      : null

  const getFootprint = async (request: McpGetFootprintRequest): Promise<unknown> => {
    const loaded = await loadFootprint(request)
    if (isRefusal(loaded)) return loaded
    const { footprint } = loaded
    const extents = footprintExtents(footprint)
    const listed = footprint.pads.slice(0, request.maxPads)
    const boxes = {
      courtyard: frameOf(extents.courtyard),
      fab: frameOf(extents.fab),
      pads: frameOf(extents.pads)
    }
    // The parser keeps the first (model …) node; the index scanned every path.
    // Only that one has a transform to measure through, so only it gets a box.
    const models = await Promise.all(
      loaded.models.map(async (path) => {
        const parsed = footprint.model?.path === path ? footprint.model : undefined
        const fit = request.modelFit === true
        const facts = await ctx.modelFacts({
          path,
          footprintFile: loaded.file,
          ...(parsed ? { footprint, boxes } : {}),
          decode: fit
        })
        return {
          path,
          resolved: facts.resolved,
          status: facts.status,
          ...(fit
            ? {
                bounds: facts.bounds,
                ...(facts.fit ? { fit: facts.fit } : {}),
                ...(facts.status === 'resolved'
                  ? { triangles: facts.triangles, meshes: facts.meshes }
                  : {})
              }
            : {}),
          ...(parsed?.offset
            ? {
                offset: {
                  x: asMm(parsed.offset.x),
                  y: asMm(parsed.offset.y),
                  z: asMm(parsed.offset.z)
                }
              }
            : {}),
          ...(parsed?.scale ? { scale: parsed.scale } : {}),
          ...(parsed?.rotate ? { rotate: parsed.rotate } : {})
        }
      })
    )
    return {
      ...footprintWhere(loaded),
      ...(loaded.placed ? {} : { file: loaded.file }),
      // The footprint's own record, as items_get reads id "footprint".
      ...footprintRecord(footprint),
      padCount: footprint.pads.length,
      pads: listed.map(padRecord),
      ...(listed.length < footprint.pads.length ? { truncated: true } : {}),
      boxes,
      models,
      ...(request.detail === 'full'
        ? {
            items: footprintItems(footprint)
              .filter((item) => item.kind !== 'pad' && item.kind !== 'footprint')
              .map(itemRow)
          }
        : {}),
      guidance: `${
        listed.length < footprint.pads.length
          ? `${listed.length} of ${footprint.pads.length} pads listed; items_query with itemKind pad and number or box reaches the rest. `
          : ''
      }boxes.courtyard is the room the part takes, fab its body outline, pads the copper. Model status: resolved, missing (folder present, file absent) or not-installed. In fit, leads past fab are normal; insideCourtyard is the containment test, dx/dy near zero is centered. Look with render_footprint view model.`
    }
  }

  /** The shape a four-view picture answers in, shared by both callers. */
  const modelPicture = (shot: ModelCapture): Record<string, unknown> => ({
    views: shot.views,
    width: shot.width,
    height: shot.height,
    mmPerPixel: Math.round(shot.mmPerPixel * 100000) / 100000,
    scaleBarMm: shot.scaleBarMm,
    image: {
      mimeType: 'image/png',
      base64: shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1)
    }
  })

  const MODEL_PICTURE_GUIDANCE =
    "Views top left to bottom right: top, front, right, angled, one scale, each with its bar; axes in the footprint's frame, y down. The top view shows rotation and pin 1; front and right show a model upside down, on its side, floating or sunk."

  const renderFootprintModel = async (
    request: McpRenderFootprintRequest,
    loaded: LoadedFootprint
  ): Promise<unknown> => {
    const link = loaded.footprint.model?.path.trim()
    if (!link) {
      return {
        error: 'model-unresolved',
        detail: `${request.footprint} links no 3D model.`
      }
    }
    const { capture, placed } = await ctx.captureFootprintWithModel(
      loaded.footprint,
      loaded.file,
      request.maxPixels
    )
    if (!placed) {
      const facts = await ctx.modelFacts({ path: link, footprintFile: loaded.file })
      return {
        error: 'model-unresolved',
        detail: `${link} is ${facts.status === 'resolved' ? 'there but could not be read' : facts.status}.`
      }
    }
    if (!capture) {
      return { error: 'renderer-failed', detail: 'The window has no viewport to draw into.' }
    }
    return {
      ...footprintWhere(loaded),
      view: 'model',
      model: link,
      ...modelPicture(capture),
      guidance: `${MODEL_PICTURE_GUIDANCE} Check pin 1 over pad 1 and the leads on the pads; fix with items_update on id model (offset, rotate).`
    }
  }

  const renderModel = async (request: McpRenderModelRequest): Promise<unknown> => {
    const facts = await ctx.modelFacts({ path: request.path, footprintFile: null })
    if (!facts.resolved) {
      return {
        error: 'model-unresolved',
        detail: `${request.path} is ${facts.status}.`
      }
    }
    const drawn = await ctx.captureModel(facts.resolved, request.maxPixels)
    if (!drawn?.capture) {
      return {
        error: 'not-step',
        detail: `${facts.resolved} holds no geometry this app can read.`
      }
    }
    return {
      path: request.path,
      file: facts.resolved,
      ...modelPicture(drawn.capture),
      bounds: drawn.bounds,
      triangles: drawn.triangles,
      meshes: drawn.meshes,
      guidance: `${MODEL_PICTURE_GUIDANCE} bounds is the file's own box in millimeters: check it against the datasheet's package; tens of millimeters for a small part means wrong units, many meshes an assembly.`
    }
  }

  const copyFootprint = async (request: McpCopyFootprintRequest): Promise<unknown> => {
    const loaded = await loadFootprint({ footprint: request.libId })
    if (isRefusal(loaded)) return loaded
    const source = await ctx.readFile(loaded.file)
    if (source === null) {
      return { error: 'footprint-unreadable', detail: loaded.file }
    }
    const sourceName = loaded.libId.split(':').pop() ?? loaded.footprint.name
    const result = await ctx.copyFootprint(
      {
        sourceText: source,
        name: request.name?.trim() || sourceName,
        ...(request.library ? { library: request.library } : {})
      },
      footprintWriteContext()
    )
    if (!result.ok) {
      return {
        error: result.error,
        detail: [result.detail, result.remedy].filter(Boolean).join(' ')
      }
    }
    await ctx.libraryChanged(result.file, !result.replaced)
    await ctx.refreshIndex()
    ctx.openBehind(result.file)

    const extents = footprintExtents(loaded.footprint)
    const boxes = {
      courtyard: frameOf(extents.courtyard),
      fab: frameOf(extents.fab),
      pads: frameOf(extents.pads)
    }
    const models = await Promise.all(
      loaded.models.map(async (path) => {
        const parsed = loaded.footprint.model?.path === path ? loaded.footprint.model : undefined
        // Where the link points, not where the file lands: decoding it is slow,
        // and footprint_get with modelFit measures it when wanted.
        const facts = await ctx.modelFacts({
          path,
          footprintFile: loaded.file,
          ...(parsed ? { footprint: loaded.footprint, boxes } : {}),
          decode: false
        })
        return { path, resolved: facts.resolved, status: facts.status }
      })
    )
    const answer: LibraryWriteAnswer = {
      libId: result.libId,
      source: request.libId,
      file: result.file,
      ...(result.createdLibrary ? { createdLibrary: true } : {}),
      changed: created(result.libId),
      models,
      guidance: `${
        models.length
          ? 'It links a model: repoint it with items_update, footprint libId, id "model", record { path }.'
          : 'It links no model: attach one with items_create, footprint libId, itemKind model, record { path }.'
      } Then point parts at libId with bom_update on Footprint.`
    }
    return answer
  }

  const renderFootprint = async (request: McpRenderFootprintRequest): Promise<unknown> => {
    const loaded = await loadFootprint(request)
    if (isRefusal(loaded)) return loaded
    if (request.view === 'model') return renderFootprintModel(request, loaded)
    const shot = ctx.captureFootprint(loaded.footprint, request.maxPixels)
    if (!shot) {
      return { error: 'renderer-failed', detail: 'The window has no viewport to draw into.' }
    }
    return {
      ...footprintWhere(loaded),
      frame: sheetFrameOf(shot.visible),
      width: shot.width,
      height: shot.height,
      ...(shot.limit === undefined
        ? {}
        : {
            note: `Drawn at ${shot.limit.pixels} rather than the ${request.maxPixels} asked for: ${shot.limit.reason === 'texture' ? `this GPU addresses ${shot.limit.texture} pixels a side` : 'the memory budget'}.`
          }),
      image: {
        mimeType: 'image/png',
        base64: shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1)
      },
      guidance:
        "frame is millimeters in the footprint's frame, y down, matching footprint_get. Check the package and pitch by eye; fix with items_update or footprint_create overwrite."
    }
  }

  /** Every pin number a symbol carries, across its units; null when no tier has it. */
  const symbolPinNumbers = async (libId: string): Promise<string[] | null> => {
    const entry = await findSymbol(libId)
    const definition = entry?.sheet.libSymbols.get(libId)
    if (!entry || !definition) return null
    const chain = libSymbolChain(definition, (name) => entry.sheet.libSymbols.get(name))
    const numbers = new Set<string>()
    for (let unit = 1; unit <= libSymbolUnitCount(chain); unit++) {
      for (const pin of libSymbolUnitPins(chain, unit)) numbers.add(pin.number)
    }
    return [...numbers]
  }

  const createFootprint = async (request: McpCreateFootprintRequest): Promise<unknown> => {
    const spec: FootprintSpec = {
      name: request.name,
      attributes: request.attributes,
      pads: request.pads,
      body: request.body,
      ...(request.description ? { description: request.description } : {}),
      ...(request.tags ? { tags: request.tags } : {}),
      ...(request.datasheet ? { datasheet: request.datasheet } : {}),
      ...(request.courtyard ? { courtyard: request.courtyard } : {}),
      ...(request.pin1 !== undefined ? { pin1: request.pin1 } : {})
    }
    const result = await ctx.createFootprint(
      { spec, style: request.style, library: request.library, overwrite: request.overwrite },
      footprintWriteContext()
    )
    if (!result.ok) {
      return {
        error: result.error,
        detail: [result.detail, result.remedy].filter(Boolean).join(' ')
      }
    }
    await ctx.libraryChanged(result.file, !result.replaced)
    await ctx.refreshIndex()
    ctx.openBehind(result.file)

    const report = result.report
    const pinNumbers = request.symbol ? await symbolPinNumbers(request.symbol) : null
    const listed = report.pads.slice(0, request.maxPads)
    const answer: LibraryWriteAnswer = {
      libId: result.libId,
      file: result.file,
      ...(result.createdLibrary ? { createdLibrary: true } : {}),
      changed: result.replaced
        ? { created: [], updated: [result.libId], deleted: [] }
        : created(result.libId),
      padCount: report.pads.length,
      pads: listed,
      ...(listed.length < report.pads.length ? { truncated: true } : {}),
      ...(report.sharedNumbers.length ? { sharedNumbers: report.sharedNumbers } : {}),
      box: report.box,
      derived: report.derived,
      checks: { new: groupChecks(result.checks, FOOTPRINT_CHECK_RULES), resolved: [] },
      ...(request.symbol
        ? {
            pinCheck: pinNumbers
              ? {
                  symbol: request.symbol,
                  ...pinCheck(
                    report.pads.map((pad) => pad.number),
                    pinNumbers
                  )
                }
              : {
                  symbol: request.symbol,
                  note: 'No library has that symbol, so no pins were compared. The footprint was written.'
                }
          }
        : {}),
      style: request.style,
      guidance: `${
        listed.length < report.pads.length
          ? `${listed.length} of ${report.pads.length} pads listed; footprint_get or items_query reaches the rest. `
          : ''
      }Look at it with render_footprint before assigning it. Report what a picture cannot show: silk cuts (derived.silk), sharedNumbers, pinCheck mismatches. Fix with footprint_create overwrite or items_update.`
    }
    return answer
  }

  const deleteFootprint = async (request: McpDeleteFootprintRequest): Promise<unknown> => {
    const record = await ctx.findFootprint(request.footprint)
    if (record && record.scope !== 'project') {
      return {
        error: 'library-read-only',
        detail: `${request.footprint} is in the ${record.scope} library.`
      }
    }
    const { nickname, name } = splitLibId(request.footprint)
    const result = await ctx.deleteFootprint({ name, library: nickname }, footprintWriteContext())
    if (!result.ok) {
      return {
        error: result.error,
        detail: [result.detail, result.remedy].filter(Boolean).join(' ') || request.footprint,
        ...(result.candidates?.length ? { candidates: result.candidates } : {})
      }
    }
    await ctx.libraryChanged(result.file, false)
    await ctx.refreshIndex()
    const answer: LibraryWriteAnswer = {
      changed: { created: [], updated: [], deleted: [result.libId] },
      file: result.file,
      guidance: 'Moved to the trash. Footprint fields naming it stop resolving; bom_get finds them.'
    }
    return answer
  }

  const LAND_PATTERN_COMMON =
    " Renumber if the part's pinout differs, then pass pads and body to footprint_create."
  const LAND_PATTERN_GUIDANCE = {
    surface:
      'JEDEC-numbered: pin 1 top of the left side, counter-clockwise, exposed pad last; notes carry Z, G and X.' +
      LAND_PATTERN_COMMON,
    grid:
      "Named from the top, A1 top left, one array per unbroken run. Check notes.ball's populated count against the datasheet. Pass courtyard 'bga' and pin1 'A1' (or the first ball present)." +
      LAND_PATTERN_COMMON,
    through_hole:
      "Pin 1 at the origin. notes.hole has the finished hole; use the datasheet's recommended hole if it prints one. Pass attributes 'tht'." +
      LAND_PATTERN_COMMON
  }

  // Pure arithmetic; it is here only because the footprint code is.
  const computeLandPattern = async (request: McpLandPatternRequest): Promise<unknown> => {
    const result = landPattern({
      leadType: request.leadType,
      density: request.density,
      body: request.body,
      lead: request.lead,
      ...(request.span ? { span: request.span } : {}),
      ...(request.pitch !== undefined ? { pitch: request.pitch } : {}),
      ...(request.pins ? { pins: request.pins } : {}),
      ...(request.exposedPad ? { exposedPad: request.exposedPad } : {}),
      ...(request.rowSpacing !== undefined ? { rowSpacing: request.rowSpacing } : {}),
      ...(request.numbering ? { numbering: request.numbering } : {}),
      ...(request.ball ? { ball: request.ball } : {}),
      ...(request.skip ? { skip: request.skip } : {})
    })
    if (!result.ok) return { error: result.error, detail: result.detail }
    return {
      pads: result.pads,
      body: result.body,
      notes: { ...result.notes, densitySource: request.densitySource },
      guidance:
        LAND_PATTERN_GUIDANCE[
          request.leadType === 'grid' || request.leadType === 'through_hole'
            ? request.leadType
            : 'surface'
        ]
    }
  }

  const handlers: { [K in LibraryRequest['kind']]: (request: LibraryRequest) => Promise<unknown> } =
    {
      'check-symbol': (request) => checkSymbol(request as McpCheckSymbolRequest),
      'create-symbol': (request) => createSymbol(request as McpCreateSymbolRequest),
      'delete-symbol': (request) => deleteSymbol(request as McpDeleteSymbolRequest),
      'create-footprint': (request) => createFootprint(request as McpCreateFootprintRequest),
      'delete-footprint': (request) => deleteFootprint(request as McpDeleteFootprintRequest),
      'land-pattern': (request) => computeLandPattern(request as McpLandPatternRequest),
      'render-symbol': (request) => renderSymbol(request as McpRenderSymbolRequest),
      'get-symbol': (request) => getSymbol(request as McpGetSymbolRequest),
      'get-footprint': (request) => getFootprint(request as McpGetFootprintRequest),
      'render-footprint': (request) => renderFootprint(request as McpRenderFootprintRequest),
      'render-model': (request) => renderModel(request as McpRenderModelRequest),
      'copy-footprint': (request) => copyFootprint(request as McpCopyFootprintRequest),
      'copy-symbol': (request) => copySymbol(request as McpCopySymbolRequest)
    }

  return {
    dispatch: (request) => handlers[request.kind](request)
  }
}
