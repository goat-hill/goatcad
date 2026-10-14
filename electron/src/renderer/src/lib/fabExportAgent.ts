/**
 * The agent's door to the fab writers: `export.gerbers`, `export.drill`,
 * `export.bom`, `export.positions`, `export.package` and `export.profiles`
 * (fabrication-export-workstream.md, "The export ops").
 *
 * Every export reads the board's saved file, so the package matches what is
 * committed, and refuses while the board's tab holds unsaved edits or stale
 * zones, naming the calls that clear them. The files go to disk through the
 * same channel the Manufacture tab's Export uses; the answer names each file
 * with its size and what it holds, never its content.
 */
import type {
  McpExportBoardRequest,
  McpExportProfilesRequest,
  McpRenderGerbersRequest,
  McpDesignRequest
} from '../../../preload/mcpTypes'
import type { FabExportPayload, FabExportResult } from '../../../preload/fabTypes'
import { parseKicadBoard, type KicadBoard } from './kicad/board'
import { basenameOf, dirnameOf, resolveRelativePath } from './kicad/paths'
import {
  BUILT_IN_EXPORT_PROFILES,
  findExportProfile,
  profileOutputs,
  type ExportProfile,
  type FabOutput
} from './exportProfiles'
import {
  exportBom,
  exportDrill,
  exportGerbers,
  exportPackage,
  exportPositions,
  type ExportContext,
  type FabFile
} from './fabExport'
import { preflightAllowsExport, preflightAudit, type PreflightFinding } from './fabPreflight'
import { boardBomComponents } from './fabBom'
import { collectDrillHits, drillPreviewGerber } from './gerber/drill'
import { parseGerber } from './gerber/parse'
import { parseExcellon } from './gerber/excellon'
import { identifyGerberLayer, isGerberFile } from './gerber/files'
import type { GerberCaptureLayer, GerberCaptureRequest } from './engine/gerberCapture'
import type { AgentCapture } from './schematic/schematicAgent'
import { loadClipper } from './geometry/clip'
import { activeFindings } from './kicadExclusions'
import { BoardSpatialIndex } from './board/spatialIndex'
import { computeConnectivity } from './board/boardConnectivity'
import { boardChecksSteps } from './board/boardChecks'
import type { BoardLibraries } from './board/boardLibraries'
import type { SchematicNetlist } from './board/schematicNetlist'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  type BoardDesignSettings
} from './kicad/project'

type ExportRequest = McpExportBoardRequest | McpExportProfilesRequest | McpRenderGerbersRequest

const EXPORT_KINDS: ReadonlySet<string> = new Set<ExportRequest['kind']>([
  'export-board',
  'export-profiles',
  'render-gerbers'
])

export const isFabExportRequest = (request: McpDesignRequest): request is ExportRequest =>
  EXPORT_KINDS.has(request.kind)

export interface FabExportAgentContext {
  /** The project's board files, absolute paths. */
  boardFiles(): string[]
  /** Resolve a name an agent gave — absolute, or bare — to one of them, or null. */
  resolveBoard(name: string): string | null
  /** Whether the board's tab holds edits its file does not. */
  unsaved(path: string): boolean
  /** The zones the board's open session holds stale; empty when no tab holds it. */
  staleZones(path: string): ReadonlySet<string>
  /** A file's text from disk, or null. */
  readText(path: string): Promise<string | null>
  /** The rules and text variables of the board's project; null for a board with none. */
  designSettings(path: string): Promise<BoardDesignSettings | null>
  /** The footprint libraries a board's parts came from, for the checks. */
  boardLibraries?(board: KicadBoard): Promise<BoardLibraries>
  /** The root schematic's live netlist, as `check_run` reads it; null with none. */
  schematicNetlist?(): Promise<SchematicNetlist | null>
  write(payload: FabExportPayload): Promise<FabExportResult>
  /** A folder's entries, or empty when it cannot be read. */
  listDir(path: string): Promise<Array<{ name: string; path: string; isDir: boolean }>>
  /** Draw a parsed fab set off-screen; null when the window has no viewport. */
  captureGerbers(request: GerberCaptureRequest): Promise<AgentCapture | null>
}

export interface FabExportAgent {
  dispatch(request: ExportRequest): Promise<unknown>
}

interface Refusal {
  error: string
  detail?: string
  candidates?: string[]
}

/** Files a render reads from one folder; a fab set is a few dozen at most. */
const GERBER_FILE_CAP = 64

/** Rows of a pre-flight finding's subjects an answer lists; past that, the count. */
const SUBJECT_CAP = 20

const findingRow = (finding: PreflightFinding): Record<string, unknown> => ({
  check: finding.check,
  level: finding.level,
  count: finding.count,
  ...(finding.breakdown
    ? { rules: finding.breakdown.slice(0, SUBJECT_CAP) }
    : finding.subjects.length
      ? { subjects: finding.subjects.slice(0, SUBJECT_CAP) }
      : {}),
  ...(finding.actual !== undefined ? { actual: finding.actual } : {}),
  ...(finding.limit !== undefined ? { limit: finding.limit } : {})
})

/** What one file holds, in a line. */
const summaryOf = (file: FabFile, rows: Map<string, number>): string => {
  if (file.output === 'gerber')
    return file.kicadLayer ? `${file.kicadLayer} Gerber` : 'Gerber job file'
  if (file.output === 'drill') return 'Excellon drill'
  const count = rows.get(file.name) ?? 0
  return file.output === 'bom' ? `BOM, ${count} rows` : `positions, ${count} placements`
}

/** A profile as `export.profiles` lists it: what it makes, and how sure we are. */
const profileRow = (profile: ExportProfile): Record<string, unknown> => ({
  id: profile.id,
  vendor: profile.vendor,
  outputs: profileOutputs(profile),
  archive: profile.archive,
  sources: profile.sources,
  ...(profile.todo.length ? { todo: profile.todo } : {})
})

export const createFabExportAgent = (ctx: FabExportAgentContext): FabExportAgent => {
  const resolve = (name: string | undefined): { path: string } | Refusal => {
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

  /** The saved board, or why it cannot be exported as it stands. */
  const savedBoard = async (path: string): Promise<{ board: KicadBoard } | Refusal> => {
    if (ctx.unsaved(path))
      return {
        error: 'board-unsaved',
        detail: `${basenameOf(path)} has unsaved edits and an export writes the saved file. Call workspace_save first.`
      }
    const stale = ctx.staleZones(path)
    if (stale.size)
      return {
        error: 'zones-stale',
        detail: `The zone fills on ${basenameOf(path)} are stale. Call board_refill, then workspace_save.`
      }
    const text = await ctx.readText(path)
    if (text === null) return { error: 'board-unreadable', detail: path }
    try {
      return { board: parseKicadBoard(text) }
    } catch (err) {
      return {
        error: 'board-unreadable',
        detail: `${path}: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  const settingsFor = async (path: string): Promise<BoardDesignSettings> =>
    (await ctx.designSettings(path)) ?? {
      rules: { ...DEFAULT_DESIGN_RULES },
      classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
      patterns: [],
      assignments: []
    }

  /** The Manufacture tab's checklist for this board and profile. */
  const preflight = async (
    board: KicadBoard,
    settings: BoardDesignSettings,
    profile: ExportProfile
  ): Promise<PreflightFinding[]> => {
    const index = BoardSpatialIndex.build(board)
    const connectivity = computeConnectivity(board, index)
    const libraries = ctx.boardLibraries ? await ctx.boardLibraries(board) : undefined
    const schematic = (await ctx.schematicNetlist?.()) ?? null
    const steps = boardChecksSteps({
      board,
      index,
      connectivity,
      settings,
      schematic,
      ...(libraries ? { libraries } : {})
    })
    let step = steps.next()
    while (!step.done) step = steps.next()
    return preflightAudit({
      board,
      profile,
      drc: activeFindings(step.value),
      bom: boardBomComponents(board.footprints),
      drillHits: collectDrillHits(board)
    })
  }

  /** The package's profile: the named built-in, the request's formats replacing its own. */
  const packageProfile = (request: McpExportBoardRequest): ExportProfile | Refusal => {
    const base = request.profile ? findExportProfile(request.profile) : null
    if (request.profile && !base)
      return {
        error: 'profile-not-found',
        detail: `No export profile is called ${request.profile}.`,
        candidates: BUILT_IN_EXPORT_PROFILES.map((p) => p.id)
      }
    const outputs = { ...(base?.outputs ?? {}) }
    if (request.gerber) outputs.gerber = request.gerber
    if (request.drill) outputs.drill = request.drill
    if (request.bom) outputs.bom = request.bom
    if (request.cpl) outputs.cpl = request.cpl
    const profile: ExportProfile = base
      ? { ...base, outputs, archive: request.archive ?? base.archive }
      : {
          id: 'custom',
          vendor: 'Custom',
          builtIn: false,
          outputs,
          archive: request.archive ?? [],
          sources: [],
          todo: []
        }
    if (!profileOutputs(profile).length)
      return {
        error: 'nothing-to-export',
        detail: 'The package names no output: pass a profile, or the formats to write.'
      }
    return profile
  }

  const exportBoard = async (request: McpExportBoardRequest): Promise<unknown> => {
    const resolved = resolve(request.board)
    if ('error' in resolved) return resolved
    const { path } = resolved
    const profile = request.output === 'package' ? packageProfile(request) : null
    if (profile && 'error' in profile) return profile
    const saved = await savedBoard(path)
    if ('error' in saved) return saved
    const { board } = saved
    const settings = await settingsFor(path)
    const boardName = basenameOf(path).replace(/\.kicad_pcb$/i, '')
    const context: ExportContext = { boardName, textVariables: settings.textVariables ?? {} }
    const directory = resolveRelativePath(dirnameOf(path), request.directory ?? 'fab')
    // Silk clipping and custom pads go through the geometry engine; without it
    // the Gerbers degrade to unclipped silk and say so in their warnings.
    await loadClipper()

    let files: FabFile[]
    let archive: { name: string; files: string[] } | null = null
    let warnings: string[] = []
    const rows = new Map<string, number>()
    let checklist: PreflightFinding[] | null = null
    if (profile) {
      checklist = await preflight(board, settings, profile)
      const pkg = exportPackage(board, profile, context)
      files = pkg.files
      archive = pkg.archive
      warnings = pkg.warnings
      for (const table of [pkg.bom, pkg.positions])
        if (table) rows.set(table.files[0].name, table.matrix.length - 1)
      const findings = checklist.filter((f) => f.level !== 'passed').map(findingRow)
      const blocked = !preflightAllowsExport(checklist)
      if (request.dryRun)
        return {
          board: path,
          profile: profileRow(profile),
          directory,
          verdict: blocked ? 'blocked' : findings.length ? 'review' : 'ready',
          findings,
          files: files.map((file) => ({ name: file.name, summary: summaryOf(file, rows) })),
          ...(archive ? { archive } : {}),
          ...(warnings.length ? { warnings } : {}),
          guidance:
            "Nothing was written. findings are the Manufacture tab's review and blocking items; call again without dryRun to write the files."
        }
      if (blocked)
        return {
          error: 'export-blocked',
          detail: `The pre-flight blocks this package: ${findings
            .filter((f) => f.level === 'blocking')
            .map((f) => f.check)
            .join(', ')}.`
        }
    } else {
      const output = request.output as FabOutput
      if (output === 'gerber') {
        const out = exportGerbers(board, request.gerber ?? {}, context)
        files = out.files
        warnings = out.warnings
      } else if (output === 'drill') {
        files = exportDrill(board, request.drill ?? {}, context).files
      } else {
        const out =
          output === 'bom'
            ? exportBom(board, request.bom ?? {}, context)
            : exportPositions(board, request.cpl ?? {}, context)
        files = out.files
        rows.set(out.files[0].name, out.matrix.length - 1)
      }
    }
    if (!files.length)
      return {
        error: 'nothing-to-export',
        detail: `${basenameOf(path)} has nothing this export writes (no holes, no parts, or no layers).`
      }

    const result = await ctx.write({
      directory,
      files: files.map((file) => ({ name: file.name, content: file.content })),
      archive
    })
    if (!result.success) return { error: 'write-failed', detail: result.error }
    const summaries = new Map(files.map((file) => [file.name, summaryOf(file, rows)]))
    const findings = checklist?.filter((f) => f.level !== 'passed').map(findingRow) ?? []
    return {
      board: path,
      ...(profile ? { profile: profileRow(profile) } : {}),
      directory: result.directory,
      files: (result.written ?? []).map((file) => ({
        path: file.path,
        bytes: file.bytes,
        summary: summaries.get(basenameOf(file.path)) ?? ''
      })),
      ...(result.archive ? { archive: result.archive } : {}),
      ...(findings.length ? { findings } : {}),
      ...(warnings.length ? { warnings } : {}),
      guidance: 'The files are on disk, not in this answer; read one only to check it.'
    }
  }

  const profiles = (request: McpExportProfilesRequest): unknown => {
    if (!request.profile) return { profiles: BUILT_IN_EXPORT_PROFILES.map(profileRow) }
    const profile = findExportProfile(request.profile)
    if (!profile)
      return {
        error: 'profile-not-found',
        detail: `No export profile is called ${request.profile}.`,
        candidates: BUILT_IN_EXPORT_PROFILES.map((p) => p.id)
      }
    return { ...profileRow(profile), formats: profile.outputs }
  }

  const renderGerbers = async (request: McpRenderGerbersRequest): Promise<unknown> => {
    const named = request.directory ?? 'fab'
    let directory = named
    if (!/^([\\/]|[a-zA-Z]:)/.test(named)) {
      const resolved = resolve(request.board)
      if ('error' in resolved) return resolved
      directory = resolveRelativePath(dirnameOf(resolved.path), named)
    }
    const entries = (await ctx.listDir(directory)).filter((entry) => !entry.isDir)
    const isDrill = (name: string): boolean => /\.(drl|xln|exc)$/i.test(name)
    const layers: Array<GerberCaptureLayer & { file: string; order: number }> = []
    const skipped: Array<{ file: string; reason: string }> = []
    for (const entry of entries.slice(0, GERBER_FILE_CAP)) {
      const drill = isDrill(entry.name)
      if (!drill && !isGerberFile(entry.name)) continue
      const text = await ctx.readText(entry.path)
      if (text === null) {
        skipped.push({ file: entry.name, reason: 'unreadable' })
        continue
      }
      try {
        if (drill) {
          const holes = parseExcellon(text)
          layers.push({
            id: entry.name,
            file: entry.name,
            image: parseGerber(drillPreviewGerber(holes.hits)),
            kicadLayer: null,
            drill: true,
            order: Number.MAX_SAFE_INTEGER
          })
        } else {
          const image = parseGerber(text)
          const identity = identifyGerberLayer(entry.name, image.fileFunction)
          layers.push({
            id: entry.name,
            file: entry.name,
            image,
            kicadLayer: identity.kicadLayer,
            order: identity.order
          })
        }
      } catch (err) {
        skipped.push({ file: entry.name, reason: err instanceof Error ? err.message : String(err) })
      }
    }
    if (!layers.length)
      return {
        error: 'nothing-to-export',
        detail: `${directory} holds no Gerber or drill file this viewer reads.`
      }
    const wanted = request.layers
    const drawn = wanted
      ? layers.filter(
          (l) => wanted.includes(l.file) || (!!l.kicadLayer && wanted.includes(l.kicadLayer))
        )
      : layers
    if (!drawn.length)
      return {
        error: 'layer-not-found',
        detail: `No file in ${directory} is ${wanted!.join(', ')}.`,
        candidates: layers.map((l) => l.kicadLayer ?? l.file)
      }
    drawn.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file))
    const box = request.box
      ? {
          minX: request.box.x,
          maxX: request.box.x + request.box.width,
          minY: request.box.y,
          maxY: request.box.y + request.box.height
        }
      : null
    const shot = await ctx.captureGerbers({ layers: drawn, box, maxPixels: request.maxPixels })
    if (!shot)
      return { error: 'renderer-failed', detail: 'The window has no viewport to draw into.' }
    const frame = shot.visible
    const round = (v: number): number => Math.round(v * 1000) / 1000
    return {
      directory,
      layers: drawn.map((l) => ({
        file: l.file,
        layer: l.drill ? 'drill' : (l.kicadLayer ?? null)
      })),
      ...(skipped.length ? { skipped } : {}),
      frame: {
        x: round(frame.minX),
        y: round(frame.minY),
        width: round(frame.maxX - frame.minX),
        height: round(frame.maxY - frame.minY)
      },
      width: shot.width,
      height: shot.height,
      image: { mimeType: 'image/png', base64: shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1) },
      guidance:
        "frame is the shown rectangle in the files' mm, y up (the export negates board y): x = frame.x + (px / width) * frame.width, y = frame.y + frame.height - (py / height) * frame.height. A layer named null was not identified. Describe what you see."
    }
  }

  return {
    dispatch: async (request) =>
      request.kind === 'export-profiles'
        ? profiles(request)
        : request.kind === 'render-gerbers'
          ? renderGerbers(request)
          : exportBoard(request)
  }
}
