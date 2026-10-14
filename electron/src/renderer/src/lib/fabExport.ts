/**
 * The fab writers and the package (fabrication-export-workstream.md, "The
 * export ops"). One writer per file kind, each taking only format arguments;
 * a package is a profile run through them. The Manufacture tab's Export and
 * the `export.*` ops both call these, so the button and the agent write the
 * same bytes.
 *
 * Pure: the board in, named files out. Writing them is the caller's.
 */
import type { KicadBoard } from './kicad/board'
import type {
  DrillFormat,
  ExportProfile,
  FabOutput,
  GerberFormat,
  BomFormat,
  PositionFormat
} from './exportProfiles'
import { defaultExportLayers } from './gerberExportLayers'
import { writeGerberSet, type GeneratedGerberLayer } from './gerber/write'
import { collectDrillHits, partitionHits, writeExcellon } from './gerber/drill'
import { buildJobFile, drillFileName, gerberFileName } from './gerber/fabPackage'
import { boardBomComponents, bomMatrix } from './fabBom'
import { boardCplComponents, positionsMatrix } from './fabCpl'
import { serializeCsv } from './bomCsv'

/** One file to write. */
export interface FabFile {
  name: string
  content: string
  output: FabOutput
  /** For a Gerber: the KiCad layer it plots. */
  kicadLayer?: string
}

export interface ExportContext {
  /** The file-name stem, e.g. the board's name without `.kicad_pcb`. */
  boardName: string
  /** The project's `text_variables`, which plotted text resolves `${NAME}` from. */
  textVariables?: Readonly<Record<string, string>>
}

export interface GerberExport {
  files: FabFile[]
  layers: GeneratedGerberLayer[]
  /** Soft issues across every layer, deduplicated. */
  warnings: string[]
}

const copperCount = (board: KicadBoard): number =>
  Math.max(2, board.layers.filter((l) => l.name.endsWith('.Cu')).length)

/** The layers a Gerber set plots when its format names none. */
export const defaultGerberLayers = (board: KicadBoard): string[] =>
  defaultExportLayers(copperCount(board))
    .filter((l) => l.defaultOn)
    .map((l) => l.name)

export function exportGerbers(
  board: KicadBoard,
  format: GerberFormat,
  context: ExportContext
): GerberExport {
  const naming = format.naming ?? 'kicad'
  const layers = writeGerberSet(board, format.layers ?? defaultGerberLayers(board), {
    decimals: format.precision ?? 6,
    subtractMaskFromSilk: format.subtractMaskFromSilk ?? true,
    textVariables: context.textVariables
  })
  const files: FabFile[] = layers.map((layer) => ({
    name: gerberFileName(layer.kicadLayer, context.boardName, naming),
    content: layer.content,
    output: 'gerber',
    kicadLayer: layer.kicadLayer
  }))
  if ((format.jobFile ?? naming === 'kicad') && layers.length > 0) {
    files.push({
      name: `${context.boardName}.gbrjob`,
      content: buildJobFile(context.boardName, layers, naming),
      output: 'gerber'
    })
  }
  return { files, layers, warnings: [...new Set(layers.flatMap((layer) => layer.warnings))] }
}

export interface DrillExport {
  files: FabFile[]
  holes: number
  tools: number
}

export function exportDrill(
  board: KicadBoard,
  format: DrillFormat,
  context: ExportContext
): DrillExport {
  const hits = collectDrillHits(board)
  const copperLayers = copperCount(board)
  const files: FabFile[] = []
  if (format.separatePlated ?? true) {
    const { plated, nonPlated } = partitionHits(hits)
    if (plated.length)
      files.push({
        name: drillFileName(context.boardName, 'PTH'),
        content: writeExcellon(plated, { file: 'pth', copperLayers }),
        output: 'drill'
      })
    if (nonPlated.length)
      files.push({
        name: drillFileName(context.boardName, 'NPTH'),
        content: writeExcellon(nonPlated, { file: 'npth', copperLayers }),
        output: 'drill'
      })
  } else if (hits.length) {
    files.push({
      name: drillFileName(context.boardName),
      content: writeExcellon(hits, { copperLayers }),
      output: 'drill'
    })
  }
  const tools = new Set(hits.map((hit) => Math.round(hit.diameter * 1000)))
  return { files, holes: hits.length, tools: tools.size }
}

export interface TableExport {
  files: FabFile[]
  /** The header and rows written. */
  matrix: string[][]
}

export function exportBom(
  board: KicadBoard,
  format: BomFormat,
  context: ExportContext
): TableExport {
  const matrix = bomMatrix(boardBomComponents(board.footprints), format)
  return {
    files: [{ name: `${context.boardName}-bom.csv`, content: serializeCsv(matrix), output: 'bom' }],
    matrix
  }
}

export function exportPositions(
  board: KicadBoard,
  format: PositionFormat,
  context: ExportContext
): TableExport {
  const matrix = positionsMatrix(boardCplComponents(board.footprints), format)
  return {
    files: [{ name: `${context.boardName}-pos.csv`, content: serializeCsv(matrix), output: 'cpl' }],
    matrix
  }
}

export interface FabPackage {
  files: FabFile[]
  /** The zip and the files it holds, or null when the profile zips nothing. */
  archive: { name: string; files: string[] } | null
  warnings: string[]
  gerbers?: GerberExport
  drill?: DrillExport
  bom?: TableExport
  positions?: TableExport
}

/** A profile run through the writers: every output it names, and the zip it asks for. */
export function exportPackage(
  board: KicadBoard,
  profile: ExportProfile,
  context: ExportContext
): FabPackage {
  const { gerber, drill, bom, cpl } = profile.outputs
  const gerbers = gerber && exportGerbers(board, gerber, context)
  const holes = drill && exportDrill(board, drill, context)
  const bomOut = bom && exportBom(board, bom, context)
  const positions = cpl && exportPositions(board, cpl, context)
  const files = [gerbers, holes, bomOut, positions].flatMap((out) => out?.files ?? [])
  const zipped = files.filter((file) => profile.archive.includes(file.output))
  return {
    files,
    archive: zipped.length
      ? { name: `${context.boardName}-gerbers.zip`, files: zipped.map((file) => file.name) }
      : null,
    warnings: gerbers?.warnings ?? [],
    ...(gerbers ? { gerbers } : {}),
    ...(holes ? { drill: holes } : {}),
    ...(bomOut ? { bom: bomOut } : {}),
    ...(positions ? { positions } : {})
  }
}
