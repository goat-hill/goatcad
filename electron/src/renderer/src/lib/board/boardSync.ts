// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Schematic → board sync, as a plan and an apply (netlist-sync-workstream.md,
 * agent-api.md).
 *
 * The mechanism is KiCad's *Update PCB from Schematic*, read off
 * `pcbnew/netlist_reader/board_netlist_updater.cpp` and the netlist exporter,
 * and the file shapes are what `pcb_io_kicad_sexpr.cpp` writes:
 *
 * - A board footprint is linked to its symbol by `(path "/<sheet-uuid>…/<symbol-uuid>")`,
 *   the sheet-instance path with the root sheet's uuid left out
 *   (`SCH_SHEET_PATH::PathAsString`), plus the symbol's uuid. A multi-unit
 *   part is linked by the uuid KiCad's netlist lists first (`syncParts` says
 *   which).
 * - Every part that has a footprint lands; a part with none, or with one no
 *   library holds, is reported and skipped and the rest still applies.
 * - What crosses: Reference, Value, every non-mandatory field plus Datasheet
 *   and Description (never Footprint), the symbol's footprint filters, `path`,
 *   `sheetname` (`/Name/`, or `/` for the root) and `sheetfile`, the `dnp` and
 *   `exclude_from_bom` attributes, and on every copper pad its net, pin type
 *   (`+no_connect` when the pin carries a flag and stands alone) and pin
 *   function. Power symbols and `on_board: no` parts stay off the board.
 * - New footprints are placed unrotated, in rows grouped by sheet below the
 *   board outline (KiCad drops them at one point below it and starts a move;
 *   an agent has no cursor, so the rows are the equivalent).
 * - Nothing existing is deleted unless asked: a board footprint whose path
 *   matches no symbol is an orphan, reported, and removed only with `prune`.
 *
 * Pure: the planner reads the design and the board and answers with what
 * would change; the applier writes a plan onto the board's AST. The caller
 * runs the apply inside its command layer and remaps the board afterwards.
 */
import {
  buildProjectComponentRecords,
  compareReferencesNatural,
  type ComponentRecord,
  type SheetSource
} from '../componentsTable'
import type { KicadBoard, KicadBoardFootprint } from '../kicad/board'
import {
  stackedPads,
  type SchematicConnectivity,
  type SheetConnectivityInput
} from '../schematic/connectivity'
import { formatNmAtom, mmToNm, nm, type Nm } from '../kicad/coordinates'
import { footprintExtents, type FootprintExtent } from '../footprint/footprintExtent'
import {
  makeAtom,
  makeList,
  parsePointList,
  setPointsChild,
  FOOTPRINT_ATTR_ORDER,
  type KicadFootprint
} from '../kicad/footprint'
import { dirnameOf } from '../kicad/paths'
import { CHANGE_DEFAULTS, exchangedFootprintNode } from './footprintExchange'
import {
  definitionIdOf,
  getLibSymbolProperty,
  pinText,
  type KicadLibSymbol,
  type KicadSchematicSymbol
} from '../kicad/schematic'
import {
  cloneNodeDeep,
  findChild,
  findChildren,
  getAtomValues,
  getFirstAtomValue,
  getToken,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The schematic side, as the sheet agents already hold it. */
export interface SyncDesign {
  sheets: SheetSource[]
  /** One per sheet instance, in hierarchy order; carries the name path. */
  inputs: SheetConnectivityInput[]
  connectivity: SchematicConnectivity
}

/** A library footprint by id, parsed, or null when no library holds it. */
export type FootprintLoader = (libId: string) => KicadFootprint | null

export interface SyncOptions {
  /** Remove board footprints whose path matches no symbol. Off by default, as in KiCad. */
  prune?: boolean
}

/** What Update PCB from Schematic writes beyond reference, value, link and pad nets: KiCad's options of these names. */
export interface SyncScope {
  /** Rebuild a footprint whose symbol names another. On by default, as in KiCad. */
  replaceFootprints?: boolean
  /** Write the symbol's fields and its Do not populate / Exclude from BOM onto the footprint. On by default, as in KiCad. */
  updateFields?: boolean
}

/**
 * A plan narrowed to a scope: with replacing off, no footprint is rebuilt;
 * with fields off, an update leaves fields and attributes as they are, and a
 * footprint that differed only there is unchanged.
 */
export const scopePlan = (plan: SyncPlan, scope: SyncScope): SyncPlan => {
  const replace = scope.replaceFootprints !== false
  const fields = scope.updateFields !== false
  const update: SyncUpdate[] = []
  let unchanged = plan.unchanged
  for (const entry of plan.update) {
    const changes = fields
      ? entry.changes
      : entry.changes.filter((change) => change !== 'fields' && change !== 'attributes')
    if (changes.length) update.push(changes === entry.changes ? entry : { ...entry, changes })
    else unchanged++
  }
  return {
    ...plan,
    update,
    unchanged,
    footprintChanged: replace ? plan.footprintChanged : []
  }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface SyncPadNet {
  net: string
  pinType: string
  pinFunction?: string
}

/** One schematic part as the board should carry it. */
export interface SyncPart {
  reference: string
  /** The board-side link: `/<sheet-uuid>…/<symbol-uuid>`. */
  path: string
  /** The same link through the part's other units, any of which KiCad may have used. */
  altPaths: string[]
  sheetName: string
  sheetFile: string
  /** The Footprint field, or '' when the part has none. */
  libId: string
  value: string
  /** Datasheet and Description first, then the user's fields, in the symbol's order. */
  fields: Array<[string, string]>
  fpFilters?: string
  dnp: boolean
  excludeFromBom: boolean
  /** Per pad number. A pad with no entry is unconnected. */
  pads: Map<string, SyncPadNet>
  /** Position of the part's sheet in the hierarchy, for grouping. */
  sheetOrder: number
  /** The home sheet instance: its `/<root-uuid>/…` path and its name path. */
  sheetPath: string
  namePath: string
  /** The unit the part is linked by, and the sheet it is drawn on. */
  primary: { symbol: KicadSchematicSymbol; source: SheetSource }
  /** Every unit's uuid, the linked one last — the order a netlist's `tstamps` lists them. */
  uuids: string[]
}

export interface SyncAddition {
  part: SyncPart
  footprint: KicadFootprint
  at: { x: Nm; y: Nm }
}

export type SyncChange =
  | 'reference'
  | 'value'
  | 'path'
  | 'sheet'
  | 'fields'
  | 'filters'
  | 'attributes'
  | 'nets'
  /** A pad's pin type or pin function, its net unchanged. */
  | 'pins'

export interface SyncUpdate {
  part: SyncPart
  footprint: KicadBoardFootprint
  changes: SyncChange[]
  /** Matched by reference to a footprint that carried no usable path. */
  relinked: boolean
}

export type SyncSkipReason = 'no-footprint' | 'footprint-not-found' | 'no-uuid'

export interface SyncSkip {
  reference: string
  reason: SyncSkipReason
  libId?: string
}

export interface SyncOrphan {
  reference: string
  libId: string
  path: string
  footprint: KicadBoardFootprint
}

/**
 * A part whose Footprint field no longer names the footprint on the board:
 * the footprint is swapped for the one the field names (`footprintExchange.ts`,
 * with Change's options), or, when no library holds it, reported and kept.
 */
export interface SyncFootprintChange {
  reference: string
  board: string
  schematic: string
  footprint: KicadBoardFootprint
  /** The footprint the field names; null when no library holds it, and the board keeps its own. */
  library: KicadFootprint | null
}

export interface SyncPlan {
  add: SyncAddition[]
  update: SyncUpdate[]
  unchanged: number
  orphans: SyncOrphan[]
  skipped: SyncSkip[]
  footprintChanged: SyncFootprintChange[]
  nets: { added: string[]; removed: string[] }
}

// ---------------------------------------------------------------------------
// Paths and names
// ---------------------------------------------------------------------------

/**
 * The board's link for a symbol: its sheet-instance path with the root
 * sheet's uuid dropped, then the symbol's uuid. KiCad's
 * `SCH_SHEET_PATH::PathAsString` starts at index 1 "to avoid the root sheet,
 * which does not need to be added to the path".
 */
export const boardPathFor = (sheetPath: string, symbolUuid: string): string => {
  const rest = sheetPath.replace(/^\/[^/]*/, '')
  return `${rest}/${symbolUuid}`
}

/** `(sheetname …)`: `/` for the root, `/Name/` and `/Outer/Inner/` below it. */
export const sheetNameFor = (namePath: string): string =>
  namePath === '/' || namePath === '' ? '/' : `${namePath}/`

/** The `(path …)` a board footprint carries, or '' when it carries none. */
export const footprintPath = (footprint: KicadBoardFootprint): string => {
  const node = findChild(footprint._raw, 'path')
  return node ? (getFirstAtomValue(node) ?? '') : ''
}

const attrTokens = (node: SExprList): string[] => {
  const attr = findChild(node, 'attr')
  return attr ? getAtomValues(attr) : []
}

// ---------------------------------------------------------------------------
// Parts: the schematic as the board should carry it
// ---------------------------------------------------------------------------

const padNetKey = (sheetPath: string, reference: string): string => `${sheetPath}\0${reference}`

/** Every copper connection the netlist would carry, by part then pad number. */
const collectPadNets = (
  connectivity: SchematicConnectivity
): Map<string, Map<string, SyncPadNet>> => {
  const byPart = new Map<string, Map<string, SyncPadNet>>()
  for (const net of connectivity.nets) {
    // Power symbols are not netlist nodes: their pins name the net and never land on a pad.
    const nodes = net.pins.filter((pin) => !pin.power && !pin.reference.startsWith('#'))
    for (const pin of nodes) {
      const key = padNetKey(pin.sheetPath, pin.reference)
      let pads = byPart.get(key)
      if (!pads) {
        pads = new Map()
        byPart.set(key, pads)
      }
      const name = pinText(pin.pin.name)
      // `netlist_exporter_xml.cpp`: a no-connect anywhere on the net, and this pin its only node.
      const noConnect = net.hasNoConnect && nodes.length === 1
      // A stacked pin is a node on each of its pads.
      for (const number of stackedPads(pin.pin.number)) {
        if (pads.has(number)) continue
        // `netlist_exporter_xml.cpp`: the pin's name and its pad number, joined.
        pads.set(number, {
          net: net.name,
          pinType: `${pin.pin.electricalType}${noConnect ? '+no_connect' : ''}`,
          ...(name ? { pinFunction: `${name}_${number}` } : {})
        })
      }
    }
  }
  return byPart
}

const symbolAt = (
  sheets: SheetSource[],
  record: ComponentRecord,
  index: number
): { symbol: KicadSchematicSymbol; source: SheetSource } | null => {
  const location = record.locations[index]
  if (!location) return null
  const source = sheets.find((sheet) => sheet.sheetPath === location.sheetPath)
  const symbol = source?.schematic.symbols[location.symbolIndex]
  return source && symbol ? { symbol, source } : null
}

const fpFiltersOf = (source: SheetSource, libId: string): string | undefined => {
  let definition: KicadLibSymbol | undefined = source.schematic.libSymbols.get(libId)
  for (let depth = 0; definition && depth < 8; depth++) {
    const filters = getLibSymbolProperty(definition, 'ki_fp_filters')
    if (filters !== undefined) return filters.trim() || undefined
    definition = definition.extends
      ? source.schematic.libSymbols.get(definition.extends)
      : undefined
  }
  return undefined
}

const MANDATORY = new Set(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'])

/**
 * A placed symbol's fields as KiCad loads them (`parseSchField`): a field
 * named like a mandatory one in any case is that field, the later in the file
 * winning, and a mandatory field's text is stripped of surrounding whitespace
 * (`SCH_FIELD::SetText`).
 */
const loadedFields = (raw: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    const mandatory = [...MANDATORY].find((name) => name.toLowerCase() === key.toLowerCase())
    if (mandatory) out[mandatory] = value.trim()
    else out[key] = value
  }
  return out
}

/**
 * A field as KiCad reads it: in files older than 20250318 a `~` was the
 * spelling of empty and the loader clears it (`sch_io_kicad_sexpr_parser.cpp`);
 * a newer file keeps the text as written.
 */
const LEGACY_TILDE_BEFORE = 20250318
const shownField = (value: string | undefined, version: number | undefined): string =>
  value === undefined || (value === '~' && (version ?? 0) < LEGACY_TILDE_BEFORE) ? '' : value

/** `sheetfile` as KiCad writes it: the file relative to the root sheet's folder. */
const sheetFileFor = (rootDir: string, filePath: string): string => {
  const split = (path: string): string[] =>
    path
      .replace(/[\\/]+/g, '/')
      .split('/')
      .filter(Boolean)
  const base = split(rootDir)
  const file = split(filePath)
  let common = 0
  while (common < base.length && common < file.length - 1 && base[common] === file[common]) common++
  const up = base.slice(common).map(() => '..')
  return [...up, ...file.slice(common)].join('/')
}

/** The parts a sync carries, and the ones it cannot link. */
/**
 * The references the schematic has not annotated (`R?`), sorted. A part is one
 * reference, so two unannotated resistors would sync as one footprint: the
 * sync is refused until they are numbered, as KiCad's netlist refuses a
 * schematic that is not fully annotated (`ReadyToNetlist`).
 */
export const unannotatedReferences = (design: SyncDesign): string[] => {
  const references = new Set<string>()
  for (const record of buildProjectComponentRecords(design.sheets)) {
    if (!record.flags.excludeFromBoard && record.reference.endsWith('?'))
      references.add(record.reference)
  }
  return [...references].sort(compareReferencesNatural)
}

export const syncParts = (design: SyncDesign): { parts: SyncPart[]; skipped: SyncSkip[] } => {
  const records = buildProjectComponentRecords(design.sheets)
  const padNets = collectPadNets(design.connectivity)
  const namePaths = new Map(design.inputs.map((input) => [input.sheetPath, input.namePath]))
  const sheetOrder = new Map(design.inputs.map((input, index) => [input.sheetPath, index]))
  const parts: SyncPart[] = []
  const skipped: SyncSkip[] = []
  // Sheets come in hierarchy order, the root first; sheetfile is spelled from its folder.
  const rootDir = dirnameOf(design.sheets[0]?.filePath ?? '')

  // A part is one reference across the whole design: a multi-unit symbol may
  // spread its units over several sheets, and KiCad emits it once, from the
  // first sheet in hierarchy order that holds a unit (`findNextSymbol`), with
  // that sheet as its home. Records arrive in hierarchy order already.
  const byReference = new Map<string, ComponentRecord[]>()
  for (const record of records) {
    if (record.flags.excludeFromBoard) continue
    const group = byReference.get(record.reference)
    if (group) group.push(record)
    else byReference.set(record.reference, [record])
  }

  for (const group of byReference.values()) {
    const home = group[0]
    type Unit = { symbol: KicadSchematicSymbol; source: SheetSource; sheetPath: string }
    const units: Unit[] = []
    for (const record of group) {
      for (let index = 0; index < record.locations.length; index++) {
        const unit = symbolAt(design.sheets, record, index)
        if (unit?.symbol.uuid) units.push({ ...unit, sheetPath: record.sheetPath })
      }
    }
    // KiCad's netlist lists every unit's uuid and the board links by the first
    // listed, which the exporter takes from an iteration order the file does
    // not fix; a re-sync matches any of them (`board_netlist_updater.cpp`
    // tries each). So a new footprint is linked by the largest uuid on the
    // home sheet — the first listed whenever two units are involved — and an
    // existing one is matched by any unit's path.
    const homeUnits = units
      .filter((unit) => unit.sheetPath === home.sheetPath)
      .sort((a, b) => ((a.symbol.uuid ?? '') < (b.symbol.uuid ?? '') ? 1 : -1))
    const primary = homeUnits[0] ?? null
    if (!primary?.symbol.uuid) {
      skipped.push({ reference: home.reference, reason: 'no-uuid' })
      continue
    }
    const fields: Record<string, string> = loadedFields(home.fields)
    for (const record of group.slice(1)) {
      for (const [key, value] of Object.entries(loadedFields(record.fields)))
        if (!(key in fields)) fields[key] = value
    }
    const definitionId = definitionIdOf(primary.symbol)
    // A field the placed symbol does not carry is empty, not its library symbol's:
    // KiCad's netlist writes the instance's own (`netlist_exporter_xml.cpp`).
    const partFields: Array<[string, string]> = [
      ['Datasheet', shownField(fields.Datasheet, primary.source.schematic.version)],
      ['Description', fields.Description ?? '']
    ]
    for (const [key, value] of Object.entries(fields)) {
      if (!MANDATORY.has(key))
        partFields.push([key, shownField(value, primary.source.schematic.version)])
    }
    const pads = new Map<string, SyncPadNet>()
    for (const record of group) {
      for (const [number, pad] of padNets.get(padNetKey(record.sheetPath, record.reference)) ?? [])
        if (!pads.has(number)) pads.set(number, pad)
    }
    const namePath = namePaths.get(home.sheetPath) ?? '/'
    const filters = fpFiltersOf(primary.source, definitionId)
    parts.push({
      reference: home.reference,
      path: boardPathFor(home.sheetPath, primary.symbol.uuid),
      altPaths: units
        .filter((unit) => unit !== primary)
        .map((unit) => boardPathFor(unit.sheetPath, unit.symbol.uuid ?? '')),
      sheetName: sheetNameFor(namePath),
      sheetFile: sheetFileFor(rootDir, home.filePath),
      libId: (fields.Footprint ?? '').trim(),
      value: fields.Value ?? '',
      fields: partFields,
      ...(filters ? { fpFilters: filters } : {}),
      dnp: group.some((record) => record.flags.dnp),
      excludeFromBom: group.some((record) => record.flags.excludeFromBom),
      pads,
      sheetOrder: sheetOrder.get(home.sheetPath) ?? 0,
      sheetPath: home.sheetPath,
      namePath,
      primary: { symbol: primary.symbol, source: primary.source },
      uuids: [
        ...homeUnits
          .filter((unit) => unit !== primary)
          .map((unit) => unit.symbol.uuid ?? '')
          .reverse(),
        primary.symbol.uuid
      ]
    })
  }
  parts.sort(
    (a, b) => a.sheetOrder - b.sheetOrder || compareReferencesNatural(a.reference, b.reference)
  )
  return { parts, skipped }
}

// ---------------------------------------------------------------------------
// Reading what a board footprint carries, for the diff
// ---------------------------------------------------------------------------

const propertyNodes = (node: SExprList): SExprList[] => findChildren(node, 'property')

const propertyKey = (property: SExprList): string => getAtomValues(property)[0] ?? ''
const propertyText = (property: SExprList): string => getAtomValues(property)[1] ?? ''

const findProperty = (node: SExprList, key: string): SExprList | null =>
  propertyNodes(node).find((property) => propertyKey(property) === key) ?? null

const childText = (node: SExprList, token: string): string => {
  const child = findChild(node, token)
  return child ? (getFirstAtomValue(child) ?? '') : ''
}

const isCopperPad = (pad: SExprList): boolean => {
  const layers = findChild(pad, 'layers')
  return !!layers && getAtomValues(layers).some((layer) => layer.endsWith('.Cu'))
}

const padNumber = (pad: SExprList): string => getAtomValues(pad)[0] ?? ''

interface PadNetState {
  net: string
  pinType: string
  pinFunction: string
}

const padNetState = (pad: SExprList): PadNetState => {
  const netNode = findChild(pad, 'net')
  const atoms = netNode ? getAtomValues(netNode) : []
  // `(net 3 "GND")` in a numbered file, `(net "GND")` in a named one.
  const net =
    atoms.length >= 2 ? atoms[1] : atoms.length === 1 && !/^-?\d+$/.test(atoms[0]) ? atoms[0] : ''
  return { net, pinType: childText(pad, 'pintype'), pinFunction: childText(pad, 'pinfunction') }
}

const wantedPadState = (part: SyncPart, pad: SExprList): PadNetState => {
  const wanted = isCopperPad(pad) ? part.pads.get(padNumber(pad)) : undefined
  return wanted
    ? { net: wanted.net, pinType: wanted.pinType, pinFunction: wanted.pinFunction ?? '' }
    : { net: '', pinType: '', pinFunction: '' }
}

const changesFor = (part: SyncPart, footprint: KicadBoardFootprint): SyncChange[] => {
  const node = footprint._raw
  const changes: SyncChange[] = []
  if ((footprint.reference ?? '') !== part.reference) changes.push('reference')
  if ((footprint.value ?? '') !== part.value) changes.push('value')
  if (footprintPath(footprint) !== part.path) changes.push('path')
  if (
    childText(node, 'sheetname') !== part.sheetName ||
    childText(node, 'sheetfile') !== part.sheetFile
  )
    changes.push('sheet')
  if (
    part.fields.some(
      ([key, value]) => propertyText(findProperty(node, key) ?? makeList([], 0)) !== value
    )
  )
    changes.push('fields')
  const filters = findProperty(node, 'ki_fp_filters')
  if ((filters ? propertyText(filters) : '') !== (part.fpFilters ?? '')) changes.push('filters')
  const attrs = attrTokens(node)
  if (
    attrs.includes('dnp') !== part.dnp ||
    attrs.includes('exclude_from_bom') !== part.excludeFromBom
  )
    changes.push('attributes')
  // A pad's net apart from its pin's type and function: the net is the board's
  // connectivity, the pin details bookkeeping KiCad's DRC never compares.
  let nets = false
  let pins = false
  for (const pad of findChildren(node, 'pad')) {
    const have = padNetState(pad)
    const want = wantedPadState(part, pad)
    if (have.net !== want.net) nets = true
    else if (have.pinType !== want.pinType || have.pinFunction !== want.pinFunction) pins = true
  }
  if (nets) changes.push('nets')
  if (pins) changes.push('pins')
  return changes
}

// ---------------------------------------------------------------------------
// Placement: rows by sheet, below the outline
// ---------------------------------------------------------------------------

const PAGE_SIZES_MM: Record<string, { width: number; height: number }> = {
  A0: { width: 1189, height: 841 },
  A1: { width: 841, height: 594 },
  A2: { width: 594, height: 420 },
  A3: { width: 420, height: 297 },
  A4: { width: 297, height: 210 },
  A5: { width: 210, height: 148 },
  A: { width: 279.4, height: 215.9 },
  B: { width: 431.8, height: 279.4 },
  C: { width: 558.8, height: 431.8 },
  D: { width: 863.6, height: 558.8 },
  E: { width: 1117.6, height: 863.6 },
  USLetter: { width: 279.4, height: 215.9 },
  USLegal: { width: 355.6, height: 215.9 },
  USLedger: { width: 431.8, height: 279.4 }
}

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const grow = (box: Box | null, x: number, y: number): Box =>
  box
    ? {
        minX: Math.min(box.minX, x),
        minY: Math.min(box.minY, y),
        maxX: Math.max(box.maxX, x),
        maxY: Math.max(box.maxY, y)
      }
    : { minX: x, minY: y, maxX: x, maxY: y }

/** The bounding box of the board's Edge.Cuts graphics, in nm; null when it has none. */
export const boardOutlineBox = (board: KicadBoard): Box | null => {
  let box: Box | null = null
  const onEdge = (layer: string | undefined): boolean => layer === 'Edge.Cuts'
  for (const line of board.grLines) {
    if (!onEdge(line.layer)) continue
    box = grow(grow(box, line.start.x, line.start.y), line.end.x, line.end.y)
  }
  for (const arc of board.grArcs) {
    if (!onEdge(arc.layer)) continue
    box = grow(
      grow(grow(box, arc.start.x, arc.start.y), arc.mid.x, arc.mid.y),
      arc.end.x,
      arc.end.y
    )
  }
  for (const rect of board.grRects) {
    if (!onEdge(rect.layer)) continue
    box = grow(grow(box, rect.start.x, rect.start.y), rect.end.x, rect.end.y)
  }
  for (const circle of board.grCircles) {
    if (!onEdge(circle.layer)) continue
    const radius = Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y)
    box = grow(
      grow(box, circle.center.x - radius, circle.center.y - radius),
      circle.center.x + radius,
      circle.center.y + radius
    )
  }
  for (const poly of board.grPolys) {
    if (!onEdge(poly.layer)) continue
    for (const point of poly.points) box = grow(box, point.x, point.y)
  }
  return box
}

const STAGING_GAP_MM = 10
const PART_GAP_MM = 1
const MIN_ROW_WIDTH_MM = 100
const DEFAULT_HALF_EXTENT_MM = 2.5

const extentOf = (footprint: KicadFootprint): FootprintExtent => {
  const extents = footprintExtents(footprint)
  const box = extents.courtyard ?? extents.fab ?? extents.pads
  if (box) return box
  const half = mmToNm(DEFAULT_HALF_EXTENT_MM)
  return { minX: -half, minY: -half, maxX: half, maxY: half }
}

/**
 * Where new footprints go: rows below the outline (or below what is on the
 * board, or from the page's middle on an empty one), a new row per sheet,
 * wrapping at the outline's width or 100 mm. Positions are the footprint
 * origins, which is what `(at …)` takes.
 */
export const stagingPositions = (
  board: KicadBoard,
  additions: Array<{ part: SyncPart; footprint: KicadFootprint }>
): Array<{ x: Nm; y: Nm }> => {
  let anchor = boardOutlineBox(board)
  if (!anchor && board.footprints.length) {
    for (const footprint of board.footprints)
      anchor = grow(anchor, footprint.position.x, footprint.position.y)
  }
  let left: number
  let top: number
  let rowWidth: number
  if (anchor) {
    left = anchor.minX
    top = anchor.maxY + mmToNm(STAGING_GAP_MM)
    rowWidth = Math.max(anchor.maxX - anchor.minX, mmToNm(MIN_ROW_WIDTH_MM))
  } else {
    const page = PAGE_SIZES_MM[board.paper ?? 'A4'] ?? PAGE_SIZES_MM.A4
    left = mmToNm(page.width / 2)
    top = mmToNm(page.height / 2)
    rowWidth = mmToNm(MIN_ROW_WIDTH_MM)
  }
  const gap = mmToNm(PART_GAP_MM)
  const positions: Array<{ x: Nm; y: Nm }> = []
  let x = left
  let y = top
  let rowHeight = 0
  let sheet: number | null = null
  for (const { part, footprint } of additions) {
    const extent = extentOf(footprint)
    const width = extent.maxX - extent.minX
    const height = extent.maxY - extent.minY
    const newRow = sheet !== null && part.sheetOrder !== sheet
    if (newRow || (x > left && x + width > left + rowWidth)) {
      x = left
      y += rowHeight + gap
      rowHeight = 0
    }
    sheet = part.sheetOrder
    positions.push({ x: nm(x - extent.minX), y: nm(y - extent.minY) })
    x += width + gap
    rowHeight = Math.max(rowHeight, height)
  }
  return positions
}

// ---------------------------------------------------------------------------
// Nets in use, for the table and the report
// ---------------------------------------------------------------------------

const padNetsOf = (footprint: SExprList): string[] =>
  findChildren(footprint, 'pad').map((pad) => padNetState(pad).net)

/**
 * Every net name something on the board uses: a pad, track, arc, via or zone.
 * `board.nets` is not that set, since a session's re-parse keeps the nets of the
 * parse before (`kicad/board.ts`). Pads are read from the footprints' AST
 * (`footprints`, default the parsed ones), so a caller that wrote footprints
 * since the parse passes the root's, and `padNets` can stand in a pad's
 * planned net.
 */
export const netsInUse = (
  board: KicadBoard,
  padNets: (footprint: SExprList) => readonly string[] = padNetsOf,
  footprints: readonly SExprList[] = board.footprints.map((footprint) => footprint._raw)
): Set<string> => {
  const names = new Set<string>()
  for (const footprint of footprints) for (const name of padNets(footprint)) names.add(name)
  const byNumber = new Map(board.nets.map((net) => [net.number, net.name]))
  const nameOf = (number: number): string => byNumber.get(number) ?? ''
  for (const segment of board.segments) if (segment.net) names.add(nameOf(segment.net))
  for (const arc of board.trackArcs) if (arc.net) names.add(nameOf(arc.net))
  for (const via of board.vias) if (via.net) names.add(nameOf(via.net))
  for (const zone of board.zones) names.add(zone.netName ?? (zone.net ? nameOf(zone.net) : ''))
  names.delete('')
  return names
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export const planBoardSync = (
  design: SyncDesign,
  board: KicadBoard,
  loadFootprint: FootprintLoader
): SyncPlan => {
  const { parts, skipped } = syncParts(design)
  const byPath = new Map<string, KicadBoardFootprint>()
  const byReference = new Map<string, KicadBoardFootprint>()
  for (const footprint of board.footprints) {
    const path = footprintPath(footprint)
    if (path && !byPath.has(path)) byPath.set(path, footprint)
    if (footprint.reference && !byReference.has(footprint.reference))
      byReference.set(footprint.reference, footprint)
  }
  const partPaths = new Set(parts.flatMap((part) => [part.path, ...part.altPaths]))
  const matched = new Set<KicadBoardFootprint>()
  const additions: Array<{ part: SyncPart; footprint: KicadFootprint }> = []
  const update: SyncUpdate[] = []
  const footprintChanged: SyncFootprintChange[] = []
  let unchanged = 0

  for (const part of parts) {
    let existing = byPath.get(part.path)
    let relinked = false
    if (!existing) {
      // Linked through another unit: keep the path KiCad chose.
      const linked = part.altPaths.find((path) => byPath.has(path))
      if (linked) {
        existing = byPath.get(linked)
        part.path = linked
      }
    }
    if (!existing) {
      // A footprint with the same reference and no path any symbol claims:
      // a hand-placed or reference-synced board. Take it over and write the path.
      const candidate = byReference.get(part.reference)
      if (candidate && !matched.has(candidate) && !partPaths.has(footprintPath(candidate))) {
        existing = candidate
        relinked = true
      }
    }
    if (existing) {
      matched.add(existing)
      if (part.libId && existing.libId !== part.libId)
        footprintChanged.push({
          reference: part.reference,
          board: existing.libId,
          schematic: part.libId,
          footprint: existing,
          library: loadFootprint(part.libId)
        })
      const changes = changesFor(part, existing)
      if (changes.length) update.push({ part, footprint: existing, changes, relinked })
      else unchanged++
      continue
    }
    if (!part.libId) {
      skipped.push({ reference: part.reference, reason: 'no-footprint' })
      continue
    }
    const footprint = loadFootprint(part.libId)
    if (!footprint) {
      skipped.push({ reference: part.reference, reason: 'footprint-not-found', libId: part.libId })
      continue
    }
    additions.push({ part, footprint })
  }

  const orphans: SyncOrphan[] = board.footprints
    .filter(
      (footprint) => !matched.has(footprint) && !attrTokens(footprint._raw).includes('board_only')
    )
    .map((footprint) => ({
      reference: footprint.reference ?? '',
      libId: footprint.libId,
      path: footprintPath(footprint),
      footprint
    }))

  const positions = stagingPositions(board, additions)
  const add: SyncAddition[] = additions.map((addition, index) => ({
    ...addition,
    at: positions[index]
  }))

  // Net names before and after, over everything on the board that carries one.
  const before = netsInUse(board)
  const wantedFor = new Map<SExprList, SyncPart>()
  for (const entry of update) wantedFor.set(entry.footprint._raw, entry.part)
  const after = netsInUse(board, (footprint) => {
    const part = wantedFor.get(footprint)
    return part
      ? findChildren(footprint, 'pad').map((pad) => wantedPadState(part, pad).net)
      : padNetsOf(footprint)
  })
  for (const { part } of add) for (const pad of part.pads.values()) after.add(pad.net)
  const added = [...after].filter((name) => !before.has(name)).sort()
  const removed = [...before].filter((name) => !after.has(name)).sort()

  return { add, update, unchanged, orphans, skipped, footprintChanged, nets: { added, removed } }
}

// ---------------------------------------------------------------------------
// Applying: writing the plan onto the AST
// ---------------------------------------------------------------------------

const atom = (value: string, quoted = false): SExprNode => makeAtom(value, quoted, 0)
const list = (token: string, ...items: SExprNode[]): SExprList =>
  makeList([atom(token), ...items], 0)
const valueList = (token: string, ...values: Array<[string, boolean]>): SExprList =>
  list(token, ...values.map(([value, quoted]) => atom(value, quoted)))

const uuidNode = (): SExprList => valueList('uuid', [crypto.randomUUID(), true])

const removeChildren = (node: SExprList, tokens: ReadonlySet<string>): SExprNode[] => {
  const removed: SExprNode[] = []
  node.children = node.children.filter((child) => {
    const token = child.type === 'list' ? getToken(child) : null
    if (token && tokens.has(token)) {
      removed.push(child)
      return false
    }
    return true
  })
  return removed
}

const indexOfFirst = (node: SExprList, tokens: ReadonlySet<string>): number =>
  node.children.findIndex((child) => {
    const token = child.type === 'list' ? getToken(child) : null
    return token !== null && tokens.has(token)
  })

const indexAfterLast = (node: SExprList, tokens: ReadonlySet<string>): number => {
  for (let index = node.children.length - 1; index >= 0; index--) {
    const child = node.children[index]
    const token = child.type === 'list' ? getToken(child) : null
    if (token && tokens.has(token)) return index + 1
  }
  return -1
}

const setAtom = (node: SExprList, index: number, value: string, quoted: boolean): void => {
  const existing = node.children[index]
  if (existing?.type === 'atom') {
    existing.value = value
    existing.quoted = quoted
  } else node.children.splice(index, 0, atom(value, quoted))
}

/** Fresh uuids on the node and everything under it, so two instances of one library footprint never share one. */
const regenerateUuids = (node: SExprList): void => {
  for (const child of node.children) {
    if (child.type !== 'list') continue
    if (getToken(child) === 'uuid') setAtom(child, 1, crypto.randomUUID(), true)
    else regenerateUuids(child)
  }
}

const fontEffects = (size: string): SExprList =>
  list(
    'effects',
    list(
      'font',
      valueList('size', [size, false], [size, false]),
      valueList('thickness', ['0.15', false])
    )
  )

/** A hidden field on the fab side, as `board_netlist_updater.cpp` styles a new one. */
const hiddenProperty = (
  key: string,
  value: string,
  angle: number,
  unlocked: boolean,
  size: string
): SExprList =>
  list(
    'property',
    atom(key, true),
    atom(value, true),
    valueList('at', ['0', false], ['0', false], [formatAngle(angle), false]),
    ...(unlocked ? [valueList('unlocked', ['yes', false])] : []),
    valueList('layer', ['F.Fab', true]),
    valueList('hide', ['yes', false]),
    uuidNode(),
    fontEffects(size)
  )

const formatAngle = (angle: number): string => {
  const normalized = ((angle % 360) + 360) % 360
  return Number.isInteger(normalized)
    ? String(normalized)
    : normalized.toFixed(2).replace(/\.?0+$/, '')
}

const footprintAngle = (node: SExprList): number => {
  const at = findChild(node, 'at')
  const atoms = at ? getAtomValues(at) : []
  return atoms.length >= 3 ? Number(atoms[2]) || 0 : 0
}

const setPropertyText = (node: SExprList, key: string, value: string, angle: number): boolean => {
  const property = findProperty(node, key)
  if (property) {
    if (propertyText(property) === value) return false
    setAtom(property, 2, value, true)
    return true
  }
  // Datasheet and Description are KiCad's mandatory fields and take its
  // constructor defaults; anything else is a user field the updater styles.
  const mandatory = key === 'Datasheet' || key === 'Description'
  const created = hiddenProperty(key, value, angle, !mandatory, mandatory ? '1.27' : '1')
  const last = indexAfterLast(node, new Set(['property']))
  const after =
    last >= 0 ? last : indexAfterLast(node, new Set(['tags', 'descr', 'at', 'uuid', 'layer']))
  node.children.splice(after >= 0 ? after : node.children.length, 0, created)
  return true
}

const setAttributes = (node: SExprList, part: SyncPart): boolean =>
  setFootprintAttributes(node, (want) => {
    if (part.dnp) want.add('dnp')
    else want.delete('dnp')
    if (part.excludeFromBom) want.add('exclude_from_bom')
    else want.delete('exclude_from_bom')
  })

/** Rewrite a footprint's `(attr …)` flags in KiCad's order; false when nothing changed. */
export const setFootprintAttributes = (
  node: SExprList,
  edit: (want: Set<string>) => void
): boolean => {
  const have = new Set(attrTokens(node))
  const want = new Set(have)
  edit(want)
  if (have.size === want.size && [...have].every((token) => want.has(token))) return false
  const ordered = FOOTPRINT_ATTR_ORDER.filter((token) => want.has(token))
  const existing = findChild(node, 'attr')
  if (existing) {
    if (!ordered.length) removeChildren(node, new Set(['attr']))
    else existing.children = [atom('attr'), ...ordered.map((token) => atom(token))]
    return true
  }
  if (!ordered.length) return false
  const created = list('attr', ...ordered.map((token) => atom(token)))
  const after = indexAfterLast(
    node,
    new Set(['sheetfile', 'sheetname', 'path', 'property', 'tags', 'descr'])
  )
  node.children.splice(after >= 0 ? after : node.children.length, 0, created)
  return true
}

/** Children that follow `(net …)`, `(pinfunction …)` and `(pintype …)` in KiCad's pad order. */
const AFTER_PAD_NET = new Set([
  'die_length',
  'solder_mask_margin',
  'solder_paste_margin',
  'solder_paste_margin_ratio',
  'clearance',
  'zone_connect',
  'thermal_bridge_width',
  'thermal_bridge_angle',
  'thermal_gap',
  'teardrops',
  'options',
  'primitives',
  'uuid',
  'tstamp'
])

export type NetRef = (name: string) => SExprList

const setPadNet = (pad: SExprList, want: PadNetState, netRef: NetRef): boolean => {
  const have = padNetState(pad)
  if (
    have.net === want.net &&
    have.pinType === want.pinType &&
    have.pinFunction === want.pinFunction
  )
    return false
  removeChildren(pad, new Set(['net', 'pinfunction', 'pintype']))
  const nodes: SExprNode[] = []
  if (want.net) nodes.push(netRef(want.net))
  if (want.pinFunction) nodes.push(valueList('pinfunction', [want.pinFunction, true]))
  if (want.pinType) nodes.push(valueList('pintype', [want.pinType, true]))
  if (nodes.length) {
    const before = indexOfFirst(pad, AFTER_PAD_NET)
    pad.children.splice(before >= 0 ? before : pad.children.length, 0, ...nodes)
  }
  return true
}

const setPadNets = (node: SExprList, part: SyncPart, netRef: NetRef): boolean => {
  let changed = false
  for (const pad of findChildren(node, 'pad')) {
    if (setPadNet(pad, wantedPadState(part, pad), netRef)) changed = true
  }
  return changed
}

const setSheetLink = (node: SExprList, part: SyncPart): boolean => {
  let changed = false
  const links: Array<[string, string]> = [
    ['path', part.path],
    ['sheetname', part.sheetName],
    ['sheetfile', part.sheetFile]
  ]
  for (const [token, value] of links) {
    const existing = findChild(node, token)
    if (existing) {
      if (getFirstAtomValue(existing) !== value) {
        setAtom(existing, 1, value, true)
        changed = true
      }
      continue
    }
    const created = valueList(token, [value, true])
    const previous =
      token === 'path'
        ? ['property', 'tags', 'descr', 'at', 'uuid', 'layer']
        : token === 'sheetname'
          ? ['path']
          : ['sheetname', 'path']
    const after = indexAfterLast(node, new Set(previous))
    node.children.splice(after >= 0 ? after : node.children.length, 0, created)
    changed = true
  }
  return changed
}

const setFilters = (node: SExprList, part: SyncPart): boolean => {
  const existing = findProperty(node, 'ki_fp_filters')
  if (!part.fpFilters) {
    if (!existing) return false
    node.children = node.children.filter((child) => child !== existing)
    return true
  }
  if (existing) {
    if (propertyText(existing) === part.fpFilters) return false
    setAtom(existing, 2, part.fpFilters, true)
    return true
  }
  // KiCad writes it after the fields and before the path.
  const created = list('property', atom('ki_fp_filters'), atom(part.fpFilters, true))
  const before = indexOfFirst(node, new Set(['path', 'sheetname', 'sheetfile', 'attr']))
  const after = indexAfterLast(node, new Set(['property']))
  node.children.splice(before >= 0 ? before : after >= 0 ? after : node.children.length, 0, created)
  return true
}

/** Write a part's identity onto a footprint node the board already has. */
/** Write a part onto a footprint; `changes`, from a plan, leaves out fields or attributes it does not name. */
const updateFootprintNode = (
  node: SExprList,
  part: SyncPart,
  netRef: NetRef,
  changes?: readonly SyncChange[]
): void => {
  const angle = footprintAngle(node)
  setPropertyText(node, 'Reference', part.reference, angle)
  setPropertyText(node, 'Value', part.value, angle)
  if (!changes || changes.includes('fields'))
    for (const [key, value] of part.fields) setPropertyText(node, key, value, angle)
  setFilters(node, part)
  setSheetLink(node, part)
  if (!changes || changes.includes('attributes')) setAttributes(node, part)
  setPadNets(node, part, netRef)
}

const LIBRARY_ONLY = new Set(['version', 'generator', 'generator_version', 'tedit'])
const PLACEMENT = new Set(['uuid', 'at', 'path', 'sheetname', 'sheetfile'])

/**
 * A library footprint as a board carries it: the lib id as its name, no
 * library header, a fresh uuid, a position, the part's fields and link, and
 * every uuid under it regenerated. The order of what is added is KiCad's
 * (`pcb_io_kicad_sexpr.cpp`, `format( const FOOTPRINT* )`).
 */
export const instantiateFootprint = (
  library: KicadFootprint,
  part: SyncPart,
  at: { x: Nm; y: Nm },
  netRef: NetRef
): SExprList => {
  const node = instantiateLibraryFootprint(library, part.libId, at)
  updateFootprintNode(node, part, netRef)
  return node
}

/**
 * The part-free half of `instantiateFootprint`: the library footprint named
 * `libId`, at `at`, its uuids fresh, its pads netless and its zones
 * board-absolute. Place Footprint lands this as it is.
 */
export const instantiateLibraryFootprint = (
  library: KicadFootprint,
  libId: string,
  at: { x: Nm; y: Nm }
): SExprList => {
  const node = cloneNodeDeep(library._raw) as SExprList
  setAtom(node, 1, libId, true)
  removeChildren(node, LIBRARY_ONLY)
  removeChildren(node, PLACEMENT)
  for (const pad of findChildren(node, 'pad'))
    removeChildren(pad, new Set(['net', 'pinfunction', 'pintype']))
  // The layer leads; uuid and at follow it.
  const layerIndex = indexOfFirst(node, new Set(['layer']))
  let insertAt: number
  if (layerIndex >= 0) insertAt = layerIndex + 1
  else {
    const afterFlags = indexAfterLast(node, new Set(['locked', 'placed']))
    insertAt = afterFlags >= 0 ? afterFlags : 2
    node.children.splice(insertAt, 0, valueList('layer', ['F.Cu', true]))
    insertAt++
  }
  node.children.splice(
    insertAt,
    0,
    uuidNode(),
    valueList('at', [formatNmAtom(at.x), false], [formatNmAtom(at.y), false])
  )
  regenerateUuids(node)
  placeZones(node, at)
  return node
}

/**
 * A library footprint's zones are footprint-local; a board holds them
 * board-absolute (KiCad's own format), so a new placement shifts them there.
 */
const placeZones = (node: SExprList, at: { x: Nm; y: Nm }): void =>
  mapFootprintNodeZones(node, (p) => ({ x: nm(p.x + at.x), y: nm(p.y + at.y) }))

/** Apply a point map to every zone of a footprint node — outline and fills. */
export const mapFootprintNodeZones = (
  node: SExprList,
  map: (p: { x: Nm; y: Nm }) => { x: Nm; y: Nm }
): void => {
  for (const zone of findChildren(node, 'zone')) {
    for (const holder of [findChild(zone, 'polygon'), ...findChildren(zone, 'filled_polygon')]) {
      if (!holder) continue
      setPointsChild(holder, parsePointList(findChild(holder, 'pts')).map(map))
    }
  }
}

/** Where a new footprint node goes in the board: with the others, else after the nets, else after setup. */
export const footprintInsertIndex = (root: SExprList): number => {
  const after = indexAfterLast(root, new Set(['footprint']))
  if (after >= 0) return after
  const afterNets = indexAfterLast(root, new Set(['net']))
  if (afterNets >= 0) return afterNets
  const afterSetup = indexAfterLast(root, new Set(['setup', 'layers', 'paper', 'general']))
  return afterSetup >= 0 ? afterSetup : root.children.length
}

/**
 * The net reference a pad writes, in the file's own dialect. A numbered file
 * keeps a `(net N "name")` table at the root, which grows here for names it
 * has not seen; a named file (KiCad 10) carries only the name.
 */
export const makeNetRef = (board: KicadBoard): { netRef: NetRef; finish: () => void } => {
  const root = board._raw as SExprList
  if (board.netRefStyle === 'name') {
    return { netRef: (name) => valueList('net', [name, true]), finish: () => {} }
  }
  const numbers = new Map(board.nets.map((net) => [net.name, net.number]))
  let next = board.nets.reduce((max, net) => Math.max(max, net.number), 0) + 1
  const created: SExprList[] = []
  const netRef: NetRef = (name) => {
    let number = numbers.get(name)
    if (number === undefined) {
      number = next++
      numbers.set(name, number)
      created.push(valueList('net', [String(number), false], [name, true]))
    }
    return valueList('net', [String(number), false], [name, true])
  }
  const finish = (): void => {
    if (!created.length) return
    const after = indexAfterLast(root, new Set(['net']))
    const afterSetup = indexAfterLast(root, new Set(['setup', 'layers', 'paper', 'general']))
    const index = after >= 0 ? after : afterSetup >= 0 ? afterSetup : root.children.length
    root.children.splice(index, 0, ...created)
  }
  return { netRef, finish }
}

/** Drop `(net N "name")` rows nothing on the board refers to any more, as KiCad's `RemoveUnusedNets`. */
const pruneNetTable = (board: KicadBoard, inUse: ReadonlySet<string>): void => {
  if (board.netRefStyle === 'name') return
  const root = board._raw as SExprList
  root.children = root.children.filter((child) => {
    if (child.type !== 'list' || getToken(child) !== 'net') return true
    const atoms = getAtomValues(child)
    const number = Number(atoms[0])
    const name = atoms[1] ?? ''
    return number === 0 || inUse.has(name)
  })
}

/**
 * Write the plan onto the board's AST. Mutates `board._raw` only; the caller
 * remaps the board (`remapKicadBoard`) and owns the undo entry.
 */
export const applyBoardSync = (
  board: KicadBoard,
  plan: SyncPlan,
  options: SyncOptions = {}
): void => {
  const root = board._raw as SExprList
  const { netRef, finish } = makeNetRef(board)

  // A footprint whose field names another is rebuilt from that library
  // footprint, keeping its place and nets, as Change Footprint does.
  const swapped = new Map<KicadBoardFootprint, SExprList>()
  for (const change of plan.footprintChanged) {
    if (!change.library) continue
    swapped.set(
      change.footprint,
      exchangedFootprintNode(
        board,
        change.footprint,
        change.library,
        change.schematic,
        CHANGE_DEFAULTS
      ).node
    )
  }

  // An updated footprint is swapped for a fresh clone rather than edited in
  // place: the board's remap reuses a domain object whose node it has seen,
  // and the editor's history reads a swap as a structural change.
  const updated = new Set<KicadBoardFootprint>()
  for (const entry of plan.update) {
    const fresh = swapped.get(entry.footprint) ?? (cloneNodeDeep(entry.footprint._raw) as SExprList)
    updateFootprintNode(fresh, entry.part, netRef, entry.changes)
    const index = root.children.indexOf(entry.footprint._raw)
    if (index >= 0) root.children[index] = fresh
    updated.add(entry.footprint)
  }
  for (const [footprint, node] of swapped) {
    if (updated.has(footprint)) continue
    const index = root.children.indexOf(footprint._raw)
    if (index >= 0) root.children[index] = node
  }

  const created = plan.add.map((addition) =>
    instantiateFootprint(addition.footprint, addition.part, addition.at, netRef)
  )
  if (created.length) root.children.splice(footprintInsertIndex(root), 0, ...created)

  if (options.prune) {
    const gone = new Set<SExprNode>(plan.orphans.map((orphan) => orphan.footprint._raw))
    root.children = root.children.filter((child) => !gone.has(child))
  }

  finish()

  // The table after the writes: every name a pad, track, via or zone names.
  pruneNetTable(board, netsInUse(board, padNetsOf, findChildren(root, 'footprint')))
}
