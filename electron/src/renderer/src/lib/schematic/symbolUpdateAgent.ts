/**
 * `schematic.update_symbols` around the shared swap (`symbolUpdate.ts`): which
 * placements a request reaches across the design, and what each part's pins
 * did. Pure.
 *
 * A part is every placement under one reference, and a request reaches all of
 * its units. As KiCad's `processSymbols` does, a unit the new symbol lacks is
 * left as it was, on its old definition and lib id, while the part's other
 * units are written, so a part can end drawn from two. The pin report is read
 * from a simulation of the same edit on copies of the files, so a dry run and
 * a write answer alike.
 */
import {
  definitionIdOf,
  libSymbolUnitCount,
  parseKicadSchematic,
  resolveSymbolGeometry,
  serializeKicadSchematic,
  type KicadSchematic,
  type KicadSchematicSymbol,
  type Point
} from '../kicad/schematic'
import { serializeSExpr } from '../kicad/sexpr'
import { samePath } from '../kicad/paths'
import type { Nm } from '../kicad/coordinates'
import {
  buildConnectivity,
  placedPinPosition,
  type SchematicConnectivity,
  type SheetConnectivityInput
} from './connectivity'
import {
  updateSymbolsWithWires,
  type LibraryDefinitionLookup,
  type SymbolUpdateOptions,
  type SymbolUpdateTarget
} from './symbolUpdate'
import { compareReferencesNatural } from '../componentsTable'
import { asMm } from './schematicAgent'
import {
  KICAD_SUBPART,
  isAnnotated,
  unitItemId,
  unitPlacements,
  type SubpartSettings,
  type UnitPlacement,
  type UnitSource
} from './symbolUnits'

interface Part {
  reference: string
  placements: UnitPlacement[]
  from: string
  to: string
}

export interface SymbolUpdateSelection {
  references?: string[]
  match?: string
  /** Change to this lib id; absent, each placement's own. */
  change?: string | null
}

export interface SymbolUpdatePlan {
  /** References that name no placement. */
  missing: string[]
  /** Parts written, each with the placements written. */
  parts: Part[]
  /** Units left as they are: the unit's item id, its part, the lib id it lacks a counterpart in. */
  skipped: Array<{ id: string; reference: string; libId: string; reason: 'unit-missing' }>
  /** Parts whose lib id no library the sheet sees has. */
  notFound: Array<{ reference: string; libId: string }>
  /** Each file's targets, once per placement however many instances show it. */
  files: Array<{ filePath: string; schematic: KicadSchematic; targets: SymbolUpdateTarget[] }>
  /** Every reference in the design, for a miss's candidates. */
  references: string[]
}

/** An unannotated reference names no part: each such placement is its own. */
const partKey = (placement: UnitPlacement): string =>
  !isAnnotated(placement.reference) || !placement.reference
    ? `${placement.source.filePath}\0${placement.index}\0${placement.source.sheetPath}`
    : placement.reference

/**
 * The placements `selection` reaches, grouped into parts, and the files to
 * write. `subpart` is the project's unit naming, for a skipped unit's id.
 */
export function planSymbolUpdate(
  sources: readonly UnitSource[],
  selection: SymbolUpdateSelection,
  lookup: LibraryDefinitionLookup,
  subpart: SubpartSettings = KICAD_SUBPART
): SymbolUpdatePlan {
  const all = unitPlacements(sources)
  const references = [...new Set(all.map((p) => p.reference).filter(Boolean))].sort(
    compareReferencesNatural
  )
  const wanted = selection.references?.length ? new Set(selection.references) : null
  const missing = wanted ? [...wanted].filter((reference) => !references.includes(reference)) : []
  const picked = all.filter((placement) =>
    wanted
      ? wanted.has(placement.reference)
      : selection.match
        ? placement.symbol.libId === selection.match
        : true
  )
  // A part is all of its units, whichever of them the selection named.
  const keys = new Set(picked.map(partKey))
  const byPart = new Map<string, UnitPlacement[]>()
  for (const placement of all) {
    const key = partKey(placement)
    if (!keys.has(key)) continue
    const list = byPart.get(key) ?? []
    list.push(placement)
    byPart.set(key, list)
  }
  const parts: Part[] = []
  const skipped: SymbolUpdatePlan['skipped'] = []
  const notFound: SymbolUpdatePlan['notFound'] = []
  for (const placements of byPart.values()) {
    const first = placements[0]
    const to = selection.change || first.symbol.libId
    const definition = lookup(to)
    if (!definition) {
      notFound.push({ reference: first.reference, libId: to })
      continue
    }
    const units = libSymbolUnitCount([definition])
    const fits = placements.filter((placement) => placement.symbol.unit <= units)
    for (const placement of placements) {
      if (fits.includes(placement)) continue
      const { source, symbol, reference } = placement
      const id = unitItemId(source.schematic, symbol, reference, subpart)
      if (skipped.some((row) => row.id === id)) continue
      skipped.push({ id, reference, libId: to, reason: 'unit-missing' })
    }
    if (fits.length)
      parts.push({ reference: first.reference, placements: fits, from: fits[0].symbol.libId, to })
  }
  const files: SymbolUpdatePlan['files'] = []
  for (const part of parts) {
    for (const { source, index } of part.placements) {
      let file = files.find((entry) => samePath(entry.filePath, source.filePath))
      if (!file) {
        file = { filePath: source.filePath, schematic: source.schematic, targets: [] }
        files.push(file)
      }
      if (!file.targets.some((target) => target.index === index))
        file.targets.push({ index, libId: part.to })
    }
  }
  parts.sort((a, b) => compareReferencesNatural(a.reference, b.reference))
  skipped.sort((a, b) => compareReferencesNatural(a.id, b.id))
  return { missing, parts, skipped, notFound, files, references }
}

/** A pin row: its id, and where it is drawn in mm. */
export interface PinMoveRow {
  id: string
  from: { x: number; y: number }
  to: { x: number; y: number }
}

export interface PinRow {
  id: string
  /** The net it was on, when it was on a wire, label or another pin. */
  net?: string
}

/** What one part's update did, as the answer names it. */
export interface SymbolUpdateRow {
  reference: string
  from: string
  to: string
  /** Placements written: one per unit shown, per instance; a unit the new symbol lacks is in the answer's `skipped`. */
  units: number
  movedPins?: PinMoveRow[]
  /** Pins the new symbol does not have; a wire on one is left dangling. */
  droppedPins?: PinRow[]
  addedPins?: string[]
  /** Pins on a wire, label or another pin before, on nothing after. */
  unwiredPins?: PinRow[]
}

export interface SymbolUpdateOutcome {
  /** Parts whose placement or definition changed, in reference order. */
  rows: SymbolUpdateRow[]
  /** Parts already current. */
  current: string[]
}

interface PinState {
  name: string
  at: Point
  net: string | null
}

const pinsOf = (
  schematic: KicadSchematic,
  symbol: KicadSchematicSymbol,
  sheetPath: string,
  graph: SchematicConnectivity | null
): Map<string, PinState> => {
  const pins = new Map<string, PinState>()
  for (const { pin } of resolveSymbolGeometry(schematic, symbol).pins) {
    if (pins.has(pin.number)) continue
    const net = graph?.netOfPin(sheetPath, symbol.uuid ?? '', pin.number)
    const attached =
      !!net &&
      (net.wires.length > 0 ||
        net.labels.length > 0 ||
        net.sheetPins.length > 0 ||
        net.pins.length > 1 ||
        net.hasNoConnect)
    pins.set(pin.number, {
      name: pin.name,
      at: placedPinPosition(symbol, pin),
      net: attached && net ? net.name : null
    })
  }
  return pins
}

/** A placement's symbol node and the definition it draws from, as text. */
const fingerprint = (schematic: KicadSchematic, symbol: KicadSchematicSymbol): string =>
  `${serializeSExpr(symbol._node)}\n${(() => {
    const definition = schematic.libSymbols.get(definitionIdOf(symbol))
    return definition ? serializeSExpr(definition._node) : ''
  })()}`

/**
 * Run the edit on copies of the plan's files and read what each part's pins
 * did: moved, dropped, added, and those that left their wire. `before` is the
 * design's connectivity now; `inputs` its sheet instances.
 */
export function simulateSymbolUpdate(
  plan: SymbolUpdatePlan,
  inputs: readonly SheetConnectivityInput[],
  before: SchematicConnectivity | null,
  lookup: LibraryDefinitionLookup,
  options: SymbolUpdateOptions,
  grid: Nm
): SymbolUpdateOutcome {
  const copies = new Map<string, KicadSchematic>()
  for (const file of plan.files) {
    const copy = parseKicadSchematic(serializeKicadSchematic(file.schematic))
    updateSymbolsWithWires(copy, file.targets, lookup, options, grid)
    copies.set(file.filePath, parseKicadSchematic(serializeKicadSchematic(copy)))
  }
  const copyOf = (filePath: string): KicadSchematic | undefined =>
    [...copies.entries()].find(([path]) => samePath(path, filePath))?.[1]
  const afterInputs = inputs.map((input) => {
    const file = plan.files.find((entry) => entry.schematic === input.schematic)
    const copy = file && copyOf(file.filePath)
    return copy ? { ...input, schematic: copy } : input
  })
  let after: SchematicConnectivity | null
  try {
    after = afterInputs.length ? buildConnectivity([...afterInputs]) : null
  } catch {
    after = null
  }
  const point = (at: Point): { x: number; y: number } => ({ x: asMm(at.x), y: asMm(at.y) })

  const rows: SymbolUpdateRow[] = []
  const current: string[] = []
  for (const part of plan.parts) {
    const movedPins: PinMoveRow[] = []
    const droppedPins: PinRow[] = []
    const addedPins: string[] = []
    const unwiredPins: PinRow[] = []
    let changed = false
    for (const { source, index, symbol, reference } of part.placements) {
      const copy = copyOf(source.filePath)
      const next = copy?.symbols[index]
      if (!copy || !next) continue
      if (fingerprint(source.schematic, symbol) !== fingerprint(copy, next)) changed = true
      const was = pinsOf(source.schematic, symbol, source.sheetPath, before)
      const now = pinsOf(copy, next, source.sheetPath, after)
      const id = (number: string): string => `${reference}.${number}`
      for (const [number, pin] of was) {
        const moved = now.get(number)
        if (!moved) {
          droppedPins.push({ id: id(number), ...(pin.net ? { net: pin.net } : {}) })
          continue
        }
        if (moved.at.x !== pin.at.x || moved.at.y !== pin.at.y)
          movedPins.push({ id: id(number), from: point(pin.at), to: point(moved.at) })
        if (pin.net && !moved.net) unwiredPins.push({ id: id(number), net: pin.net })
      }
      for (const number of now.keys()) if (!was.has(number)) addedPins.push(id(number))
    }
    if (!changed) {
      current.push(part.reference)
      continue
    }
    rows.push({
      reference: part.reference,
      from: part.from,
      to: part.to,
      units: part.placements.length,
      ...(movedPins.length ? { movedPins } : {}),
      ...(droppedPins.length ? { droppedPins } : {}),
      ...(addedPins.length ? { addedPins } : {}),
      ...(unwiredPins.length ? { unwiredPins } : {})
    })
  }
  return { rows, current }
}
