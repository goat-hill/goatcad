/**
 * The pure half of the MCP design surface — what an agent reads back from a
 * sheet, and where a symbol it asks for actually goes.
 *
 * Extracted from `SchematicEditor.vue` for the same reason `schematicTools.ts`
 * was: an SFC is not unit-testable here, and the two things most likely to be
 * wrong in this feature — the grid check on a placement and the projection an
 * agent reasons from — are exactly the two that are pure functions of their input.
 * The editor keeps the parts that need its reactive state (loading a library,
 * running a command); everything below is data in, data out.
 */
import { nm, nmToMm, type Nm, mmToNm, spacingToMm } from '../kicad/coordinates'
import type { PlacementGeometry } from './schematicTools'
import {
  referenceForSheetPath,
  resolveSymbolGeometry,
  type KicadPaper,
  type KicadSchematic,
  type KicadSchematicSymbol,
  type Point
} from '../kicad/schematic'
import { placedPinPosition, rotateCCW } from './connectivity'
import type { SchematicConnectivity } from './connectivity'
import { unitItemId, type SubpartSettings } from './symbolUnits'
import type { McpChanged } from '../../../../preload/mcpTypes'
import type { GraphicKind } from './sheetGraphicItems'

/** Millimetres, rounded to the µm. A schematic never needs finer, and full
 *  nanometres in JSON is noise a model has to read past. */
export const asMm = (value: Nm): number => Math.round(nmToMm(value) * 1000) / 1000

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Half-extents of a placement outline, which is all a placed box needs. */
export const halfExtents = (geometry: PlacementGeometry): { halfW: number; halfH: number } => {
  const xs = geometry.outline.map((point) => Math.abs(point.x))
  const ys = geometry.outline.map((point) => Math.abs(point.y))
  return {
    halfW: xs.length ? Math.max(...xs) : 0,
    halfH: ys.length ? Math.max(...ys) : 0
  }
}

// --- Framing a render ---------------------------------------------------------

/** A rectangle in the engine's world: millimetres, y up. */
export interface WorldBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** A rectangle in sheet space as an agent reads it: millimetres, y down,
 *  origin at the top-left — the frame `render.schematic` reports. */
export interface SheetFrame {
  x: number
  y: number
  width: number
  height: number
}

/** What the viewport hands back for `render.schematic`. */
export interface AgentCapture {
  dataUrl: string
  width: number
  height: number
  /** Set when the requested `maxPixels` could not be served. */
  limit?: { pixels: number; reason: 'memory' | 'texture'; texture: number }
  /** The world rectangle the picture shows after the fit. */
  visible: WorldBox
  /** Zone fills missing from a board picture: still triangulating when it was taken. */
  unfinishedFills?: number
}

/** The smallest box holding all of `boxes`; null for none. */
export const unionBoxes = (boxes: readonly Box[]): Box | null => {
  if (!boxes.length) return null
  return boxes.reduce((all, box) => ({
    minX: Math.min(all.minX, box.minX),
    minY: Math.min(all.minY, box.minY),
    maxX: Math.max(all.maxX, box.maxX),
    maxY: Math.max(all.maxY, box.maxY)
  }))
}

export const inflateBox = (box: Box, margin: number): Box => ({
  minX: box.minX - margin,
  minY: box.minY - margin,
  maxX: box.maxX + margin,
  maxY: box.maxY + margin
})

/** A sheet-space box in nanometres as the engine's world box. The y flip is
 *  the one `enginePoint` applies to every point the scene draws. */
export const worldBoxOf = (box: Box): WorldBox => ({
  minX: nmToMm(box.minX as Nm),
  maxX: nmToMm(box.maxX as Nm),
  minY: -nmToMm(box.maxY as Nm),
  maxY: -nmToMm(box.minY as Nm)
})

/** A millimetre frame from the agent's schema as a sheet-space box in nm. */
export const boxOfFrame = (frame: SheetFrame): Box => ({
  minX: mmToNm(frame.x),
  minY: mmToNm(frame.y),
  maxX: mmToNm(frame.x + frame.width),
  maxY: mmToNm(frame.y + frame.height)
})

/** The world rectangle a capture shows, reported the way the sheet is read. */
export const sheetFrameOf = (visible: WorldBox): SheetFrame => {
  const round = (value: number): number => Math.round(value * 1000) / 1000
  return {
    x: round(visible.minX),
    y: round(-visible.maxY),
    width: round(visible.maxX - visible.minX),
    height: round(visible.maxY - visible.minY)
  }
}

/**
 * The page as an agent reads it: its KiCad name and the rectangle it covers,
 * which starts at the sheet origin. Answered by `describe` and by `render`
 * beside the frame that was actually drawn, so "is this block off the page?"
 * is a comparison rather than a check that has to fire.
 */
export const paperFrame = (
  paper: KicadPaper
): { size: string; portrait: boolean; box: SheetFrame } => ({
  size: paper.size,
  portrait: paper.portrait,
  box: { x: 0, y: 0, width: asMm(paper.width), height: asMm(paper.height) }
})

/** Sheet-space box of an outline placed at `position`. */
export const boxAt = (geometry: PlacementGeometry, position: Point): Box => {
  const { halfW, halfH } = halfExtents(geometry)
  return {
    minX: position.x - halfW,
    minY: position.y - halfH,
    maxX: position.x + halfW,
    maxY: position.y + halfH
  }
}

/**
 * KiCad's default connection grid, 50 mil: the pitch a pin or wire end must sit
 * on for a wire drawn on the grid to meet it, and what its ERC measures against
 * (`ERCE_ENDPOINT_OFF_GRID`). A project sets its own
 * (`schematic.connection_grid_size`, `kicad/project.ts`); this is the one a
 * sheet with no project gets. The checks warn on it; the agent's writes refuse
 * a point that would miss it.
 */
export const CONNECTION_GRID = mmToNm(spacingToMm(50, 'mil'))

/** The pitch library pins are drawn on, and the grid the agent's wire bends on. */
export const PIN_GRID = mmToNm(2.54)

/** Distance from `value` down to the grid line below it, in [0, grid). */
const gridResidue = (value: number, grid: Nm): number => ((value % grid) + grid) % grid

/**
 * Which of `points` miss the connection grid, and the one shift that would put
 * every point on it.
 *
 * `null` when none miss — and also when no single shift could put them all
 * there, because points at mixed offsets are the drawing's (a library symbol
 * with pins on two pitches) and KiCad places that too. Only the caller's
 * choice of where the drawing goes is ever refused.
 */
export function offGridPoints(
  points: Point[],
  grid: Nm = CONNECTION_GRID
): { points: Point[]; shift: Point } | null {
  const isOff = (point: Point, dx = 0, dy = 0): boolean =>
    gridResidue(point.x + dx, grid) !== 0 || gridResidue(point.y + dy, grid) !== 0
  const off = points.filter((point) => isOff(point))
  if (!off.length) return null
  // Half a step either way is equally near; a tie moves toward the origin.
  const toward = (residue: number): number => (residue * 2 <= grid ? -residue : grid - residue)
  const shift: Point = {
    x: nm(toward(gridResidue(off[0].x, grid))),
    y: nm(toward(gridResidue(off[0].y, grid)))
  }
  if (points.some((point) => isOff(point, shift.x, shift.y))) return null
  return { points: off, shift }
}

/**
 * Where placing a symbol at `at` would leave pins off the connection grid, and
 * the nearest origin that would not. `null` on the terms of `offGridPoints`.
 */
export function offGridPlacement(
  geometry: PlacementGeometry,
  at: Point,
  angle: number,
  grid: Nm = CONNECTION_GRID
): { pins: Point[]; nearest: Point } | null {
  const placed: Point[] = geometry.pins.map((pin) => {
    const rotated = rotateCCW(pin, angle)
    return { x: nm(at.x + rotated.x), y: nm(at.y - rotated.y) }
  })
  const off = offGridPoints(placed, grid)
  if (!off) return null
  return { pins: off.points, nearest: { x: nm(at.x + off.shift.x), y: nm(at.y + off.shift.y) } }
}

/**
 * The origin that puts pin `number` at `pinAt` when the symbol is turned by
 * `angle` — the inverse of the placement `offGridPlacement` checks, so the two
 * agree on where a pin lands. `null` when the unit has no such pin.
 *
 * This is how a person places a passive: by the pin end, onto the wire end or
 * the pad it serves. Without it an agent placed somewhere, read the pins back,
 * and moved — and a move follows any wire a pin happened to sit on.
 */
export function originForPin(
  pins: ReadonlyArray<{ number: string; position: Point }>,
  number: string,
  pinAt: Point,
  angle: number
): Point | null {
  const pin = pins.find((candidate) => candidate.number === number)
  if (!pin) return null
  const rotated = rotateCCW(pin.position, angle)
  return { x: nm(pinAt.x - rotated.x), y: nm(pinAt.y + rotated.y) }
}

/**
 * A symbol's part fields.
 *
 * Reference and Value are reported as their own columns, and `ki_*` keys are
 * library bookkeeping rather than anything about the physical part.
 */
export const partPropertyMap = (symbol: KicadSchematicSymbol): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const property of symbol.properties) {
    if (property.key === 'Reference' || property.key === 'Value') continue
    if (property.key.startsWith('ki_')) continue
    if (property.value) out[property.key] = property.value
  }
  return out
}

export const symbolValue = (symbol: KicadSchematicSymbol): string =>
  symbol.properties.find((property) => property.key === 'Value')?.value ?? ''

/** Rows past this and the answer stops being readable. Reported, never silently
 *  cut — a truncated list an agent reads as complete is how a design gets a
 *  second copy of a part it already has. */
export const DESCRIBE_CAP = 400

export interface DescribeInput {
  schematic: KicadSchematic
  connectivity: SchematicConnectivity | null
  /** This file's hierarchical instance path, which is what a reference is keyed
   *  on — the same symbol is R1 under one sheet path and R5 under another. */
  sheetPath: string
  /** How a unit is written after its reference; KiCad's default when absent. */
  subpart?: SubpartSettings
  filePath: string
  name: string
  readOnly: boolean
  /**
   * Every sheet instance in the project, root first. This IS the hierarchy —
   * `namePath` and `depth` give the tree without a second list of the same
   * rows under another key, which the answer-size discipline would not pay
   * for. A single-sheet project is the degenerate case: one row, depth 0.
   */
  sheets: {
    path: string
    name: string
    sheetPath: string
    /** Human path built from sheet names: `/`, `/Power`, `/Power/Reg`. */
    namePath: string
    /** 0 for the root, increasing with nesting. */
    depth: number
    /** Symbols placed on this instance, so a reader can tell a populated
     *  block from an empty one before opening it. */
    symbolCount: number
  }[]
  /** The document's revision counter, so an answer says which state it is of. */
  revision?: number
}

/** What `schematic_describe` answers with. */
export function describeSchematic(input: DescribeInput): Record<string, unknown> {
  const { schematic, connectivity, sheetPath } = input
  // Connectivity is the design's; the answer is this sheet instance's part of it.
  const here = (item: { sheetPath: string }): boolean => item.sheetPath === sheetPath
  const allNets = connectivity?.nets ?? []
  const nets = allNets.filter(
    (net) =>
      net.pins.some(here) ||
      net.wires.some(here) ||
      net.labels.some(here) ||
      net.sheetPins.some(here)
  )
  const allUnconnected = (connectivity?.dangling ?? []).filter((end) => end.kind === 'pin')
  const unconnected = allUnconnected.filter(here)
  const truncated =
    schematic.symbols.length > DESCRIBE_CAP ||
    nets.length > DESCRIBE_CAP ||
    unconnected.length > DESCRIBE_CAP

  return {
    sheet: { path: input.filePath, name: input.name },
    readOnly: input.readOnly,
    // The token for `since`, and the one an agent quotes to say which
    // state it read. Bumped by every committed mutation.
    revision: input.revision ?? 0,
    sheets: input.sheets,
    // Reported, never enforced. The page is a KiCad-compatibility fact — where
    // a print or plot cuts — and a GoatCAD design is not bound to it: the
    // drawing may run past the edge and `render.schematic` still frames the content.
    // An agent that cannot see the sheet has no other way to tell the two
    // apart. Absent when the file names no page.
    ...(schematic.paper ? { paper: paperFrame(schematic.paper) } : {}),
    symbols: schematic.symbols.slice(0, DESCRIBE_CAP).map((symbol) => {
      const reference = referenceForSheetPath(symbol, sheetPath) ?? ''
      return {
        id: unitItemId(schematic, symbol, reference, input.subpart),
        reference,
        libId: symbol.libId,
        value: symbolValue(symbol),
        unit: symbol.unit,
        at: { x: asMm(symbol.position.x), y: asMm(symbol.position.y) },
        angle: symbol.position.angle,
        // Present-or-absent: `dnp: false` on every row of a large sheet is weight
        // with no information in it.
        ...(symbol.dnp ? { dnp: true } : {}),
        ...(symbol.inBom ? {} : { inBom: false }),
        properties: partPropertyMap(symbol)
      }
    }),
    nets: nets.slice(0, DESCRIBE_CAP).map((net) => ({
      name: net.name,
      // A net named only by the pin that lands on it is not a net anyone chose;
      // saying so is what stops an agent citing "Net-(R1-Pad1)" as a signal.
      named: net.nameSource !== 'none' && net.nameSource !== 'pin',
      pins: net.pins.filter(here).map((pin) => `${pin.reference}.${pin.pin.number}`)
    })),
    // The whole point of reading back: what is not finished. A pin connected to
    // nothing is either work remaining or a mistake, and either way it is the
    // thing to report rather than leave for the user to find.
    unconnected: unconnected.slice(0, DESCRIBE_CAP).map((end) => ({
      reference: end.reference ?? '',
      pin: end.pinNumber ?? '',
      at: { x: asMm(end.position.x), y: asMm(end.position.y) }
    })),
    // Complete whatever the lists hold. What else is drawn is counted by kind —
    // enough to know a sheet has wires and notes; `items.query` is the list.
    counts: {
      symbols: schematic.symbols.length,
      nets: nets.length,
      netsElsewhere: allNets.length - nets.length,
      unconnected: unconnected.length,
      unconnectedElsewhere: allUnconnected.length - unconnected.length,
      labels: schematic.labels.length,
      wires: schematic.wires.length,
      junctions: schematic.junctions.length,
      noConnects: schematic.noConnects.length,
      texts: schematic.texts.length,
      sheets: schematic.sheets.length
    },
    ...(truncated ? { truncated: true } : {}),
    guidance: [
      'This answer covers the one sheet named at the top: its nets list only the pins on it, and counts.netsElsewhere and unconnectedElsewhere count the rest of the design. "sheets" lists the whole project, and other sheets are reached with the sheet argument. Positions are sheet mm from the page\'s top-left. A pin under "unconnected" has no net. For pin positions, boxes or a region\'s contents, call items_get or items_query.',
      ...(truncated
        ? [
            `Each list stops at ${DESCRIBE_CAP} rows; counts are complete. Page the rest with items_query by kind or box.`
          ]
        : [])
    ].join(' ')
  }
}

// --- Which sheet an agent means ---------------------------------------------

export interface SheetCandidate {
  name: string
  path: string
}

/** A node of the project tree, structurally — enough of `App`'s `FileItem` to
 *  walk it, without this module knowing what else that carries. */
export interface SheetTreeNode extends SheetCandidate {
  children?: SheetTreeNode[]
  isDirectory?: boolean
}

const isSchematic = (path: string): boolean => path.toLowerCase().endsWith('.kicad_sch')

/** Depth-first search of the project tree for a schematic by file name. */
export function findSheetInTree(
  nodes: readonly SheetTreeNode[] | null | undefined,
  wanted: string
): SheetCandidate | null {
  for (const node of nodes ?? []) {
    if (node.name.toLowerCase() === wanted && isSchematic(node.path)) return node
    const hit = node.children ? findSheetInTree(node.children, wanted) : null
    if (hit) return hit
  }
  return null
}

/**
 * Resolve the sheet an agent named to a path in this project.
 *
 * Accepts an absolute path or a bare file name, because a model that has seen
 * `schematic_describe` output has the path and one that has not has only a name.
 * With nothing named it takes the project's root sheet (`rootPath`), as a board
 * op takes the project's board, else the only schematic open — **never the tab
 * in front, and never a guess between several open tabs**: which tab a person
 * is looking at must not decide where an agent writes (`main/workspaces.ts`).
 */
export function resolveAgentSheet(
  sheet: string | undefined,
  context: {
    openTabs: readonly SheetCandidate[]
    files: readonly SheetTreeNode[]
    rootPath?: string | null
  }
): string | null {
  const open = context.openTabs.filter((tab) => isSchematic(tab.path))
  if (!sheet) return context.rootPath ?? (open.length === 1 ? open[0].path : null)

  const wanted = sheet.toLowerCase()
  const byPath = open.find((tab) => tab.path.toLowerCase() === wanted)
  if (byPath) return byPath.path
  const byName = open.find((tab) => tab.name.toLowerCase() === wanted)
  if (byName) return byName.path
  if (sheet.includes('/') || sheet.includes('\\')) return isSchematic(sheet) ? sheet : null
  return findSheetInTree(context.files, wanted)?.path ?? null
}

// --- Which file an agent means, any kind ------------------------------------

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Every file (not directory) in the project tree, depth first. */
const treeFiles = (nodes: readonly SheetTreeNode[] | null | undefined): SheetCandidate[] => {
  const out: SheetCandidate[] = []
  for (const node of nodes ?? []) {
    if (node.children) out.push(...treeFiles(node.children))
    else if (!node.isDirectory) out.push(node)
  }
  return out
}

/**
 * Resolve a file an agent named — any kind, for `project.open` — to a path in
 * this project. Open tabs first, by path or name; then the project tree by
 * absolute path or bare name. A name that matches several files is refused
 * (null) rather than guessed, and nothing outside the tree is ever opened: an
 * absolute path has to be one the tree lists, or the verb would open whatever
 * a model made up.
 */
export function resolveAgentFile(
  file: string,
  context: { openTabs: readonly SheetCandidate[]; files: readonly SheetTreeNode[] }
): string | null {
  const wanted = file.trim().toLowerCase()
  if (!wanted) return null
  const byTabPath = context.openTabs.find((tab) => tab.path.toLowerCase() === wanted)
  if (byTabPath) return byTabPath.path
  const byTabName = context.openTabs.filter((tab) => tab.name.toLowerCase() === wanted)
  if (byTabName.length === 1) return byTabName[0].path
  const files = treeFiles(context.files)
  const byPath = files.find((entry) => entry.path.toLowerCase() === wanted)
  if (byPath) return byPath.path
  const byName = files.filter((entry) => entry.name.toLowerCase() === wanted)
  return byName.length === 1 ? byName[0].path : null
}

/** Files whose name shares a stem with what was asked for, for a refusal. */
export function fileCandidates(
  nodes: readonly SheetTreeNode[] | null | undefined,
  wanted: string,
  cap = 12
): string[] {
  const stem = baseName(wanted)
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
  const files = treeFiles(nodes)
  const near = stem
    ? files.filter((entry) => entry.name.toLowerCase().includes(stem)).map((entry) => entry.path)
    : []
  return (near.length ? near : files.map((entry) => entry.path)).slice(0, cap)
}

/** What kind of editor a path opens, by extension. */
export const documentKindOf = (
  path: string
): 'schematic' | 'board' | 'symbol-library' | 'footprint' | 'project' | 'text' => {
  const lower = path.toLowerCase()
  if (lower.endsWith('.kicad_sch')) return 'schematic'
  if (lower.endsWith('.kicad_pcb')) return 'board'
  if (lower.endsWith('.kicad_sym')) return 'symbol-library'
  if (lower.endsWith('.kicad_mod')) return 'footprint'
  if (lower.endsWith('.kicad_pro')) return 'project'
  return 'text'
}

// --- Connecting pins by label ------------------------------------------------
//
// `docs/agent-api.md`. `connect` places a net label at each
// pin and never draws a wire: that is netlist-correct and ERC-clean, and wire
// geometry is an aesthetic problem a model does badly.
// A model cannot see the sheet, so a route it invents crosses whatever is there.

/** A pin an agent can name, with everything a label needs to sit on it. */
export interface AddressablePin {
  reference: string
  number: string
  name: string
  electricalType: string
  symbol: KicadSchematicSymbol
  /** Sheet-space connection point, integer nm. */
  position: Point
  /** Degrees, snapped to a cardinal: which way the label should read. */
  labelAngle: number
}

/** The id an agent addresses this pin by, and the one `describe` prints. */
export const pinRefOf = (pin: { reference: string; number: string }): string =>
  `${pin.reference}.${pin.number}`

const normalizeAngle = (angle: number): number => ((angle % 360) + 360) % 360

/**
 * Which way a label on this pin should point: away from the symbol body.
 *
 * A pin's `at` is its *connection* point and its angle points back toward the
 * body (`pinExtentPoints` in `symbolEdit.ts` is the same fact from the other
 * side), so the free side is 180° from it. The placement transform then matches
 * `placedPinPosition`: rotate by the symbol's own angle, then mirror. The sheet's
 * y-down flip cancels out for a direction, because KiCad stores schematic angles
 * counter-clockwise as displayed either way.
 */
export const labelAngleForPin = (symbol: KicadSchematicSymbol, pinAngle: number): number => {
  let angle = pinAngle + 180 + symbol.position.angle
  if (symbol.mirror === 'x') angle = -angle
  if (symbol.mirror === 'y') angle = 180 - angle
  angle = normalizeAngle(angle)
  // Cardinal only: KiCad's own label tool never produces anything else, and a
  // symbol at 45° would otherwise put text at an angle nobody can read.
  return normalizeAngle(Math.round(angle / 90) * 90)
}

/** Every pin on a sheet, in the form an agent addresses. */
export const addressablePins = (schematic: KicadSchematic, sheetPath: string): AddressablePin[] => {
  const pins: AddressablePin[] = []
  for (const symbol of schematic.symbols) {
    const reference = referenceForSheetPath(symbol, sheetPath) ?? ''
    if (!reference) continue
    for (const { pin } of resolveSymbolGeometry(schematic, symbol).pins) {
      pins.push({
        reference,
        number: pin.number,
        name: pin.name,
        electricalType: pin.electricalType,
        symbol,
        position: placedPinPosition(symbol, pin),
        labelAngle: labelAngleForPin(symbol, pin.position.angle)
      })
    }
  }
  return pins
}

export type PinLookup =
  { ok: true; pin: AddressablePin } | { ok: false; reason: string; candidates: string[] }

/**
 * Resolve `R1.2` or `U3.VDD` against the sheet.
 *
 * Both forms are accepted because both are what an engineer says, but a name
 * that matches more than one pad is **refused rather than guessed**: `GND` on a
 * part with four ground pads names no single pin, and picking one silently is
 * how an agent connects the wrong pad and never finds out.
 */
export const resolvePinRef = (ref: string, pins: AddressablePin[]): PinLookup => {
  const trimmed = ref.trim()
  const dot = trimmed.indexOf('.')
  if (dot <= 0 || dot === trimmed.length - 1) {
    return {
      ok: false,
      reason: `"${ref}" is not a pin id. Pin ids are <reference>.<pin>, e.g. "R1.2" or "U3.VDD".`,
      candidates: []
    }
  }
  const reference = trimmed.slice(0, dot)
  const wanted = trimmed.slice(dot + 1)

  const onSymbol = pins.filter((pin) => pin.reference === reference)
  if (!onSymbol.length) {
    return {
      ok: false,
      reason: `No symbol on this sheet is called ${reference}.`,
      candidates: [...new Set(pins.map((pin) => pin.reference))].sort().slice(0, 12)
    }
  }

  const byNumber = onSymbol.filter((pin) => pin.number === wanted)
  if (byNumber.length === 1) return { ok: true, pin: byNumber[0] }

  const byName = onSymbol.filter((pin) => pin.name === wanted)
  if (byName.length === 1) return { ok: true, pin: byName[0] }
  if (byName.length > 1) {
    return {
      ok: false,
      reason: `${reference} has ${byName.length} pins named ${wanted}; address one by pad number.`,
      candidates: byName.map(pinRefOf)
    }
  }

  return {
    ok: false,
    reason: `${reference} has no pin ${wanted}.`,
    candidates: onSymbol.map(pinRefOf).slice(0, 24)
  }
}

// --- What a write answers with -----------------------------------------------

/** One touched item, projected the way `describe` projects it. */
export interface ChangeRecord {
  /** The KiCad uuid where the item has one, the reference where it is a symbol
   *  (`docs/agent-api.md`). */
  id: string
  kind:
    | 'symbol'
    | 'field'
    | 'label'
    | 'wire'
    | 'junction'
    | 'no_connect'
    | 'text'
    | 'sheet_pin'
    | 'sheet'
    | GraphicKind
  [field: string]: unknown
}

export interface ChangeSet {
  created: ChangeRecord[]
  updated: ChangeRecord[]
  deleted: ChangeRecord[]
}

export const emptyChangeSet = (): ChangeSet => ({ created: [], updated: [], deleted: [] })

/** A change set as a write answers it: the ids alone, each once. */
export const changedIds = (set: ChangeSet): McpChanged => ({
  created: [...new Set(set.created.map((record) => record.id))],
  updated: [...new Set(set.updated.map((record) => record.id))],
  deleted: [...new Set(set.deleted.map((record) => record.id))]
})

/**
 * What several writes came to, as one: an item made and then deleted inside
 * them never existed, and one made and then changed is only made.
 */
export const netChanged = (steps: readonly McpChanged[]): McpChanged => {
  const created = new Set<string>()
  const updated = new Set<string>()
  const deleted = new Set<string>()
  for (const step of steps) {
    for (const id of step.created) {
      deleted.delete(id)
      created.add(id)
    }
    for (const id of step.updated) if (!created.has(id)) updated.add(id)
    for (const id of step.deleted) {
      updated.delete(id)
      if (created.has(id)) created.delete(id)
      else deleted.add(id)
    }
  }
  return { created: [...created], updated: [...updated], deleted: [...deleted] }
}

/**
 * Find the labels a `connect` just wrote, so the answer can carry their real
 * ids rather than a promise that they exist.
 *
 * Matched on text and position because the AST is re-derived after every
 * command — the node objects from before the write are gone, and the uuid is
 * minted inside `addSchematicLabelToAST` where nothing hands it back.
 */
export const labelsAt = (
  schematic: KicadSchematic,
  text: string,
  positions: readonly Point[]
): ChangeRecord[] => {
  const wanted = new Set(positions.map((point) => `${point.x},${point.y}`))
  return schematic.labels
    .filter((label) => label.text === text && wanted.has(`${label.position.x},${label.position.y}`))
    .map((label) => ({
      id: label.uuid ?? `${label.position.x},${label.position.y}`,
      kind: 'label' as const,
      net: label.text,
      at: { x: asMm(label.position.x), y: asMm(label.position.y) },
      angle: label.position.angle
    }))
}

// --- Incremental describe ----------------------------------------------------

/**
 * A sheet is read whole once, and paid for per change after.
 *
 * `describe({ since })` answers with the rows that moved since that revision
 * plus the ids that went away, which on a real board is a handful of lines
 * instead of a few hundred. v1 computes it by diffing two projections rather
 * than having the command layer report touched ids: the projection is small,
 * the diff is trivial, and the alternative is bookkeeping in every mutation
 * path that would be wrong the first time somebody forgot it.
 */
type Row = Record<string, unknown>

const rowsOf = (payload: Record<string, unknown>, key: string): Row[] =>
  Array.isArray(payload[key]) ? (payload[key] as Row[]) : []

/** How each list names its members — the same ids `describe` already prints. */
const IDENTITY: Record<string, (row: Row) => string> = {
  symbols: (row) => String(row.reference ?? ''),
  nets: (row) => String(row.name ?? ''),
  unconnected: (row) => `${String(row.reference ?? '')}.${String(row.pin ?? '')}`
}

export interface ListDiff {
  created: Row[]
  updated: Row[]
  deleted: string[]
}

const diffList = (before: Row[], after: Row[], id: (row: Row) => string): ListDiff => {
  const had = new Map(before.map((row) => [id(row), JSON.stringify(row)]))
  const has = new Set(after.map(id))
  return {
    created: after.filter((row) => !had.has(id(row))),
    updated: after.filter((row) => {
      const was = had.get(id(row))
      return was !== undefined && was !== JSON.stringify(row)
    }),
    deleted: [...had.keys()].filter((key) => !has.has(key))
  }
}

/**
 * What changed between two `describe` answers.
 *
 * Capped lists make this approximate at the edges — a row that fell past
 * `DESCRIBE_CAP` reads as deleted — which is why the answer keeps the counts
 * and says so rather than pretending the lists are the whole design.
 */
export const diffDescribe = (
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, unknown> => {
  const lists: Record<string, ListDiff> = {}
  for (const [key, id] of Object.entries(IDENTITY)) {
    lists[key] = diffList(rowsOf(before, key), rowsOf(after, key), id)
  }
  const touched = Object.values(lists).reduce(
    (total, list) => total + list.created.length + list.updated.length + list.deleted.length,
    0
  )
  return {
    sheet: after.sheet,
    since: before.revision ?? 0,
    revision: after.revision ?? 0,
    ...lists,
    counts: after.counts,
    guidance:
      touched === 0
        ? 'Nothing changed on this sheet since that revision.'
        : 'Lists hold only what changed since that revision; counts are of the whole sheet. Call without since to read it all.'
  }
}
