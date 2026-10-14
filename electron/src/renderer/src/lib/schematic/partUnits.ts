/**
 * The units of one placed part, for the agent door: placing the next unit
 * under an existing reference, and the sibling units a field or flag write
 * carries to. KiCad keeps a copy of every field on each unit and its symbol
 * properties dialog writes them to all units of the reference (everything but
 * the reference itself, and the flags), as the Components table here does;
 * `componentEdits.ts` is that GUI path. Pure.
 */
import {
  referenceForSheetPath,
  type KicadSchematic,
  type KicadSchematicSymbol
} from '../kicad/schematic'
import { samePath } from '../kicad/paths'
import {
  KICAD_SUBPART,
  findUnitHolder,
  isAnnotated,
  libUnitName,
  placedSymbolChain,
  subReference,
  unitPlacements,
  type SubpartSettings,
  type UnitPlacement,
  type UnitSource
} from './symbolUnits'

/** A source as the agent context lists it: a sheet instance with its file. */
export interface PartSource extends UnitSource {
  /** How a person names the sheet instance. */
  sheetName?: string
}

/** The flags a unit shares with the rest of its part. */
export interface PartFlags {
  dnp: boolean
  inBom: boolean
  onBoard: boolean
  excludeFromSim: boolean
}

export interface NextUnitRequest {
  reference: string
  libId: string
  unit: number
  /** How many units the library symbol draws. */
  unitCount: number
  /** This sheet file, its instance in front, and every instance of it. */
  filePath: string
  sheetPath: string
  instancePaths: readonly string[]
  document: KicadSchematic
  value?: string
  properties?: Record<string, string>
  /** The project's unit naming (`ctx.subpart()`), so a candidate is the id the unit takes. */
  subpart?: SubpartSettings
}

export type NextUnitPlan =
  | {
      ok: true
      /** Every field of the part but its reference, to write on the new unit. */
      fields: Record<string, string>
      flags: PartFlags
      /** The reference the new unit takes under each instance path of this file. */
      references: Map<string, string>
    }
  | { ok: false; error: string; detail: string; candidates?: string[] }

const NO_SELF = { filePath: '', sheetPath: '', symbolIndex: -1 }

/** Every placement of the part named `reference`, across the design. */
const partPlacements = (
  sources: readonly PartSource[],
  reference: string
): UnitPlacement<PartSource>[] =>
  unitPlacements(sources).filter((placement) => placement.reference === reference)

/** The units of `reference` no placement shows yet, as unit numbers. */
function freeUnits(sources: readonly PartSource[], reference: string, unitCount: number): number[] {
  const free: number[] = []
  for (let unit = 1; unit <= unitCount; unit++) {
    if (!findUnitHolder(sources, reference, unit, NO_SELF, samePath)) free.push(unit)
  }
  return free
}

/** The fields a unit copies from its part: all but the reference and KiCad's private keys. */
export const partFields = (symbol: KicadSchematicSymbol): Record<string, string> =>
  Object.fromEntries(
    symbol.properties
      .filter((property) => property.key !== 'Reference' && !property.key.startsWith('ki_'))
      .map((property) => [property.key, property.value])
  )

/**
 * Whether unit `unit` of the existing part `reference` can be placed on this
 * sheet, and what it is written with. Refused when the part draws another
 * symbol, has no such unit, or already shows it under any instance path of
 * this file, and when `value` or `properties` disagree with the part's.
 */
export function planNextUnit(
  sources: readonly PartSource[],
  request: NextUnitRequest
): NextUnitPlan {
  const { reference, unit } = request
  const placements = partPlacements(sources, reference)
  const part = placements[0]?.symbol
  if (!part) {
    return { ok: false, error: 'reference-not-found', detail: `No part is called ${reference}.` }
  }
  if (part.libId !== request.libId) {
    return {
      ok: false,
      error: 'unit-symbol-mismatch',
      detail: `${reference} is a ${part.libId}, not a ${request.libId}; a unit of it is placed with symbol "${part.libId}".`,
      candidates: [part.libId]
    }
  }
  const free = freeUnits(sources, reference, request.unitCount)
  // As the part's items are named: its sheet copy's unit names, the project's separator and first id.
  const chain = placedSymbolChain(placements[0].source.schematic, part)
  const unitId = (named: string, each: number): string =>
    `${named}${subReference(each, request.subpart ?? KICAD_SUBPART, libUnitName(chain, each))}`
  const unitNames = (units: number[]): string[] =>
    units.map((each) => `${each} (${unitId(reference, each)})`)
  if (unit > request.unitCount) {
    return {
      ok: false,
      error: 'unit-not-found',
      detail: `${part.libId} has ${request.unitCount} unit${request.unitCount === 1 ? '' : 's'}; there is no unit ${unit}.`,
      candidates: unitNames(free)
    }
  }

  // References are per instance path: under a sheet used twice, this unit
  // joins whatever the part on this file is called under each path.
  const sibling = request.document.symbols.find(
    (symbol) => referenceForSheetPath(symbol, request.sheetPath) === reference
  )
  if (!sibling) {
    // The name of a part on this file under another use of the sheet: here the part has its own.
    const other = request.document.symbols.find((symbol) =>
      request.instancePaths.some((path) => referenceForSheetPath(symbol, path) === reference)
    )
    const here = other && referenceForSheetPath(other, request.sheetPath)
    if (here)
      return {
        ok: false,
        error: 'reference-taken',
        detail: `${reference} names this part under another use of the sheet; on this one it is ${here}.`,
        candidates: [here]
      }
  }
  const references = new Map<string, string>()
  for (const path of request.instancePaths) {
    references.set(path, (sibling && referenceForSheetPath(sibling, path)) || reference)
  }
  for (const [path, named] of references) {
    const holder = findUnitHolder(sources, named, unit, NO_SELF, samePath)
    if (!holder) continue
    const where = sources.find(
      (source) =>
        source.sheetPath === holder.sheetPath && samePath(source.filePath, holder.filePath)
    )
    return {
      ok: false,
      error: 'unit-taken',
      detail: `${unitId(named, unit)} is already placed${where?.sheetName ? ` on ${where.sheetName}` : ''}${path !== request.sheetPath ? ` (instance ${path})` : ''}.${free.length ? ` Free units: ${unitNames(free).join(', ')}.` : ` Every unit of ${reference} is placed.`}`,
      candidates: unitNames(free)
    }
  }

  const fields = partFields(part)
  const differs: string[] = []
  if (request.value !== undefined && request.value !== (fields.Value ?? '')) {
    differs.push(`Value "${request.value}" (the part's is "${fields.Value ?? ''}")`)
  }
  for (const [key, value] of Object.entries(request.properties ?? {})) {
    if (value !== (fields[key] ?? '')) {
      differs.push(`${key} "${value}" (the part's is "${fields[key] ?? ''}")`)
    }
  }
  if (differs.length) {
    return {
      ok: false,
      error: 'unit-fields',
      detail: `A unit takes ${reference}'s fields, and this call names ${differs.join(', ')}.`
    }
  }
  return {
    ok: true,
    fields,
    flags: {
      dnp: part.dnp,
      inBom: part.inBom,
      onBoard: part.onBoard,
      excludeFromSim: part.excludeFromSim
    },
    references
  }
}

/** The part's other units in this sheet file, which a field or flag write carries to. */
export const siblingUnits = (
  document: KicadSchematic,
  sheetPath: string,
  symbol: KicadSchematicSymbol,
  reference: string
): KicadSchematicSymbol[] =>
  isAnnotated(reference)
    ? document.symbols.filter(
        (candidate) =>
          candidate !== symbol && referenceForSheetPath(candidate, sheetPath) === reference
      )
    : []

/** The sheets other than this file that hold a unit of `reference`, as their names. */
export const unitsInOtherFiles = (
  sources: readonly PartSource[],
  filePath: string,
  reference: string
): string[] =>
  isAnnotated(reference)
    ? [
        ...new Set(
          partPlacements(sources, reference)
            .filter(({ source }) => !samePath(source.filePath, filePath))
            .map(({ source }) => source.sheetName || source.filePath)
        )
      ]
    : []
