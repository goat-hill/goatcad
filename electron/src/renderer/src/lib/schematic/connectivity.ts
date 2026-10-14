/**
 * Derives schematic nets from geometry. Items connect where their connection
 * points coincide; a wire's interior takes only a junction, a label or a sheet
 * pin, as in KiCad 10 — a wire end or a pin resting mid-wire stays apart until
 * a junction joins it (checked with `kicad-cli sch export netlist`). Name
 * priority: global label, power, local label, hierarchical label, sheet pin,
 * then a pin-derived fallback. A net that crosses sheets is named as KiCad's
 * `CONNECTION_GRAPH::propagateToNeighbors` names it: each sheet's subgraph
 * picks its driver, then the strongest driver wins at any depth, the
 * shallower sheet only breaking a tie between drivers of one kind.
 */
import {
  definitionIdOf,
  getSymbolProperty,
  pinText,
  placedPinUuid,
  referenceForSheetPath,
  resolveSymbolGeometry,
  sheetPinUuid,
  type KicadBusEntry,
  type KicadLabel,
  type KicadLibSymbol,
  type KicadSchematic,
  type KicadSchematicSymbol,
  type KicadSheet,
  type KicadSheetPin,
  type KicadWire,
  type Point,
  type SymbolPin
} from '../kicad/schematic'
import { nm } from '../kicad/coordinates'
import { shownText } from '../kicad/textExpressions'
import { findChild, findChildren, getFirstAtomValue } from '../kicad/sexpr'
import { matchBusMember, parseBusName, type BusAliases, type BusName } from './busNames'
import { letterSubReference as subReference } from './symbolUnits'
import { expandStackedPinNumber } from '../symbol/symbolChecks'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One sheet instance participating in connectivity (see hierarchy.ts). */
export interface SheetConnectivityInput {
  /** Hierarchical instance path `/<root-uuid>/<sheet-uuid>/...` (or '/'). */
  sheetPath: string
  /** The page this instance is numbered with, for `${#}` in a label. */
  page?: string
  /** The instance's sheet name, for `${SHEETNAME}`. */
  sheetName?: string
  /** Human name path: '/' for the root, '/Sensors' for a child. */
  namePath: string
  schematic: KicadSchematic
}

export type NetNameSource =
  | 'global_label'
  | 'power'
  | 'local_power'
  | 'local_label'
  | 'hierarchical_label'
  | 'sheet_pin'
  | 'pin'
  | 'none'

export interface NetPin {
  sheetPath: string
  symbol: KicadSchematicSymbol
  reference: string
  pin: SymbolPin
  /** Absolute sheet-space position of the pin's connection point. */
  position: Point
  /** True when a no_connect flag sits on this pin. */
  noConnect: boolean
  /** True on a power symbol's pin. KiCad's power ports are `power_in` pins
   *  whose symbol carries `(power)`; for ERC that pin is the rail's driver. */
  power: boolean
  /** The net name a power port drives, for a power symbol's power input pin. */
  powerName?: string
  /** True on a `(power local)` symbol's pin: its name is its sheet's alone. */
  localPower?: boolean
}

export interface NetWire {
  sheetPath: string
  wireIndex: number
  wire: KicadWire
}

export interface NetLabel {
  sheetPath: string
  label: KicadLabel
}

export interface NetSheetPin {
  /** Sheet path of the PARENT sheet holding the sheet symbol. */
  sheetPath: string
  sheet: KicadSheet
  pin: KicadSheetPin
}

export interface SchematicNet {
  name: string
  nameSource: NetNameSource
  /** A no-connect flag sits somewhere on this net (KiCad's `m_HasNoConnect`). */
  hasNoConnect: boolean
  pins: NetPin[]
  wires: NetWire[]
  labels: NetLabel[]
  sheetPins: NetSheetPin[]
  junctions: { sheetPath: string; position: Point }[]
}

/**
 * A label or sheet pin with nothing at its anchor: no wire, pin or other item
 * shares its point. KiCad draws a dangling mark there; ERC has its own rules for
 * labels, so these are not findings.
 */
export interface OpenAnchor {
  sheetPath: string
  position: Point
  kind: 'label' | 'global_label' | 'hierarchical_label' | 'sheet_pin' | 'bus'
}

export interface DanglingEnd {
  sheetPath: string
  position: Point
  kind: 'wire' | 'pin'
  reference?: string
  pinNumber?: string
  /** The pin's symbol, for selecting it. */
  symbolUuid?: string
  /** The pin's own KiCad id. */
  pinUuid?: string
  /** The open end's wire, for selecting it. */
  wireUuid?: string
  /** The open end's wire and its index on its sheet, for its item id. */
  wire?: KicadWire
  wireIndex?: number
}

/**
 * What is wired together on one sheet instance before names join anything:
 * KiCad's subgraph. The rules about labels, no-connects and dangling items
 * judge a piece, then look across the pieces of its net.
 */
export interface SchematicPiece {
  sheetPath: string
  pins: NetPin[]
  labels: KicadLabel[]
  wires: NetWire[]
  sheetPins: NetSheetPin[]
  junctions: Point[]
  noConnects: Point[]
  /** How many bus-entry ends it takes in. */
  busEntries: number
  /** For each bus entry joining it to a bus: the entry, and the members that bus carries. */
  busLinks: Array<{ entry: KicadBusEntry; members: string[] }>
  /** The net it is part of; none for a bare junction or flag. */
  net?: SchematicNet
}

/** A bus's pieces on one sheet instance: its wires, and every name on it. */
export interface SchematicBus {
  sheetPath: string
  wires: KicadWire[]
  names: Array<{
    text: string
    source: NetNameSource
    id?: string
    /** What the editor selects for it: the label, or a sheet pin's sheet box. */
    select?: string
    members: string[]
    position: Point
  }>
}

export interface SchematicConnectivity {
  nets: SchematicNet[]
  /** Every wired piece, per sheet instance. */
  pieces: SchematicPiece[]
  /** Every bus piece per sheet instance: its wires and the names on it. */
  buses: SchematicBus[]
  /**
   * `sheetPath|name` for each bus member whose bus leaves its sheet through a
   * sheet pin or hierarchical label: a label of that name is carried off the
   * sheet even when nothing on it reaches a pin.
   */
  busPorts: Set<string>
  /** Open wire ends and unconnected pins (no-connect-flagged pins excluded). */
  dangling: DanglingEnd[]
  /** Labels, sheet pins and bus ends with nothing attached, for the canvas's dangling marks. */
  openAnchors: OpenAnchor[]
  netOfPin(sheetPath: string, symbolUuid: string, pinNumber: string): SchematicNet | undefined
  netOfWire(sheetPath: string, wireIndex: number): SchematicNet | undefined
  /**
   * Net under a sheet-space point (on a wire, pin, junction, or label anchor).
   * `tolerance` widens the search radius in nm (e.g. a zoom-scaled cursor
   * radius for hover highlighting); the nearest hit wins.
   */
  netAt(sheetPath: string, point: Point, tolerance?: number): SchematicNet | undefined
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Coordinates are integer nanometers, so two items connect exactly when their
 * keys are the same integers — the dividend of the coordinate-units migration.
 * `placedPinPosition` rounds its trig once, everything else is parsed ints;
 * there is no float noise left for a bucket to absorb.
 */
const pointKey = (point: Point): string => `${point.x},${point.y}`

/** Max distance (nm) from a segment for a point to count as "on" it (10 µm). */
const ON_SEGMENT_TOLERANCE = 10_000

/** Pin types meant to be left open: never an unconnected end. */
const OPEN_BY_DESIGN = new Set(['no_connect', 'free'])

/** Cell size (nm) for bucketing wires by position; a tuning size, not a KiCad length. */
const WIRE_CELL = 2_540_000

/** Distance from a point to a segment (clamped to the segment's extent). */
const segmentDistance = (point: Point, a: Point, b: Point): number => {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const apx = point.x - a.x
  const apy = point.y - a.y
  const lengthSq = abx * abx + aby * aby
  if (lengthSq < 1) return Math.hypot(apx, apy)
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / lengthSq))
  return Math.hypot(apx - t * abx, apy - t * aby)
}

/** Whether a point lies on a segment, endpoints included. */
const onSegment = (point: Point, a: Point, b: Point): boolean =>
  segmentDistance(point, a, b) <= ON_SEGMENT_TOLERANCE

/** Whether a point lies strictly inside a segment (not at either endpoint). */
const insideSegment = (point: Point, a: Point, b: Point): boolean =>
  onSegment(point, a, b) && pointKey(point) !== pointKey(a) && pointKey(point) !== pointKey(b)

/** Trig produces fractional nm, so the result is deliberately unbranded. */
export const rotateCCW = (
  point: { x: number; y: number },
  angleDegrees: number
): { x: number; y: number } => {
  const angle = (angleDegrees * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos }
}

/**
 * Absolute sheet-space position of a lib-space pin on a placed symbol.
 * Lib symbols are y-up while sheets are y-down: rotate CCW in lib space,
 * flip onto the sheet, then mirror in sheet space and translate (matches
 * SchematicScene). The mirror comes last because that is how KiCad composes
 * it: `SCH_SYMBOL::SetOrientation` applies `(mirror x)` as an incremental
 * transform on top of the rotation, so `mirror x` flips the symbol about its
 * own horizontal axis *as drawn* — checked against KiCad's netlist for a
 * diode at 270° mirrored, whose pins swap ends. Rounded back onto the
 * integer-nm grid: this point becomes a pointMap key, and cardinal rotations
 * of integer coordinates are exact, so the round only absorbs trig residue.
 */
export const placedPinPosition = (symbol: KicadSchematicSymbol, pin: SymbolPin): Point =>
  placedPoint(symbol, pin.position)

/** The same transform for any lib-space point of a placed symbol — a graphic
 *  vertex, a pin's body end — so a bounding box is built the way a pin is. */
export const placedPoint = (
  symbol: KicadSchematicSymbol,
  point: { x: number; y: number }
): Point => {
  const rotated = rotateCCW(point, symbol.position.angle)
  const dx = symbol.mirror === 'y' ? -rotated.x : rotated.x
  const dy = symbol.mirror === 'x' ? rotated.y : -rotated.y
  return { x: nm(symbol.position.x + dx), y: nm(symbol.position.y + dy) }
}

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

class UnionFind {
  private readonly parent: number[] = []

  make(): number {
    this.parent.push(this.parent.length)
    return this.parent.length - 1
  }

  find(id: number): number {
    let root = id
    while (this.parent[root] !== root) root = this.parent[root]
    while (this.parent[id] !== root) {
      const next = this.parent[id]
      this.parent[id] = root
      id = next
    }
    return root
  }

  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b)
  }
}

const pinUuidOf = (entry: NetPin): { pinUuid?: string } => {
  const uuid = placedPinUuid(entry.symbol, entry.pin.number)
  return uuid ? { pinUuid: uuid } : {}
}

// ---------------------------------------------------------------------------
// Internal items
// ---------------------------------------------------------------------------

interface BaseItem {
  id: number
  sheet: number
  points: Point[]
}

type Item = BaseItem &
  (
    | { kind: 'wire'; wireIndex: number; wire: KicadWire }
    | { kind: 'pin'; netPin: NetPin }
    | { kind: 'label'; label: KicadLabel }
    | { kind: 'sheet_pin'; sheet_: KicadSheet; pin: KicadSheetPin }
    | { kind: 'junction' }
    | { kind: 'no_connect' }
    // One end of a bus entry: a wire or pin meeting it is attached, not dangling.
    | {
        kind: 'bus_entry'
        entry: KicadBusEntry
        /** The members of the bus at the entry's other end, when that end meets one. */
        busMembers?: string[]
        /** This end sits on the bus: it belongs to the bus, not to a net. */
        onBus?: boolean
      }
    // A net a bus carries: joins the net of its name on its sheet, and the
    // member it matches on every bus joined to it.
    | { kind: 'bus_member' }
  )

/** Omit that distributes over a discriminated union (plain Omit collapses it). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Whether an item's point touching a wire's interior joins the wire's net:
 *  KiCad's labels (a sheet pin is one) and junctions do, nothing else. */
const connectsOnWireInterior = (item: Item): boolean =>
  item.kind === 'label' || item.kind === 'sheet_pin' || item.kind === 'junction'

const isPowerSymbol = (schematic: KicadSchematic, symbol: KicadSchematicSymbol): boolean =>
  schematic.libSymbols.get(definitionIdOf(symbol))?.isPower || symbol.libId.startsWith('power:')

const isLocalPowerSymbol = (schematic: KicadSchematic, symbol: KicadSchematicSymbol): boolean =>
  schematic.libSymbols.get(definitionIdOf(symbol))?.isLocalPower ?? false

/** The net name a power symbol drives: its Value, falling back to pin name. */
/** KiCad's first schematic format after the release that stopped renaming legacy power pins. */
const LEGACY_POWER_BEFORE = 20230221

/**
 * The net name a power symbol drives: its Value, falling back to its pin's
 * name. In a file from before KiCad 7, a power symbol with a hidden pin is
 * named by the pin, as KiCad renames it on load (the value could disagree).
 */
const powerNetName = (
  symbol: KicadSchematicSymbol,
  pin: SymbolPin,
  schematic?: KicadSchematic
): string =>
  (pin.hidden && pin.name && (schematic?.version ?? Infinity) < LEGACY_POWER_BEFORE
    ? pin.name
    : getSymbolProperty(symbol, 'Value')) || pin.name

/** KiCad's `EscapeString(…, CTX_NETNAME)`: a slash becomes `{slash}`, line breaks are dropped. */
const escapeNetName = (text: string): string =>
  text.replace(/\//g, '{slash}').replace(/[\r\n]/g, '')

/** The definition that carries a placed symbol's pins, through `extends`. */
const definitionOf = (
  schematic: KicadSchematic | undefined,
  libId: string
): KicadLibSymbol | undefined => {
  let definition = schematic?.libSymbols.get(libId)
  for (let depth = 0; definition && depth < 8; depth++) {
    if (definition.pins.length || definition.variants.length || !definition.extends)
      return definition
    definition = schematic?.libSymbols.get(definition.extends)
  }
  return definition
}

/**
 * The name a pin gives a net that nothing else names — KiCad's
 * `SCH_PIN::GetDefaultNetName`, so the board's pad nets read as KiCad's would:
 * `Net-(D1-K)` from a named pin, `Net-(R1-Pad2)` from a numbered one, the pad
 * number added when the name is shared or the net is unconnected, and the
 * unit letter on a multi-unit part whose pin names repeat across units; an
 * unannotated part's pins by its uuid.
 */
const pinNetName = (
  schematic: KicadSchematic | undefined,
  netPin: NetPin,
  unconnected: boolean
): string => {
  const pin = netPin.pin
  const shownName = pinText(pin.name)
  const number = pin.number
  // A stacked pin (`[6,7,9-11]`) is named for its smallest pad (`GetEffectivePadNumber`).
  const pad = stackedPads(number)[0]
  const unnamed = unconnected || pin.electricalType === 'no_connect'
  let name = unnamed ? 'unconnected-(' : 'Net-('
  // An unannotated part has no reference to tell its copies apart: its uuid does.
  if (netPin.reference.endsWith('?') && netPin.symbol.uuid) {
    return `${name}${netPin.symbol.uuid}-Pad${escapeNetName(pad)})`
  }
  const definition = definitionOf(schematic, definitionIdOf(netPin.symbol))
  // `SCH_SYMBOL::GetPins` answers with the placed unit's pins, so a name that
  // repeats in another unit does not count as shared.
  const siblings = schematic
    ? resolveSymbolGeometry(schematic, netPin.symbol).pins.map((resolved) => resolved.pin)
    : []
  const hasMultiple = siblings.some(
    (other) =>
      pinText(other.name) === shownName &&
      other.number !== number &&
      unnamed === (other.electricalType === 'no_connect')
  )
  if (shownName && shownName !== number) {
    const units = new Set(
      (definition?.variants ?? []).map((variant) => variant.unit).filter((unit) => unit > 0)
    )
    const unit = units.size > 1 ? subReference(netPin.symbol.unit) : ''
    name += `${netPin.reference}${unit}-${escapeNetName(shownName)}`
    if (unnamed || hasMultiple) name += `-Pad${escapeNetName(pad)}`
  } else {
    name += `${netPin.reference}-Pad${escapeNetName(pad)}`
  }
  return `${name})`
}

/**
 * The pads a pin number stands for: a stacked pin's (`[1,3,5-7]`) in
 * ascending order, else the number itself.
 */
export const stackedPads = (number: string): string[] =>
  expandStackedPinNumber(number)?.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  ) ?? [number]

const scopedName = (namePath: string, text: string): string =>
  namePath === '/' ? `/${text}` : `${namePath}/${text}`

const NAME_PRIORITY: Record<NetNameSource, number> = {
  global_label: 7,
  power: 6,
  local_power: 5,
  local_label: 4,
  hierarchical_label: 3,
  sheet_pin: 2,
  pin: 1,
  none: 0
}

/** Every `(bus_alias "NAME" (members …))` the design's sheets define, by name,
 *  then those the project file defines (where KiCad 9 and later keep them). */
const busAliasesOf = (
  sheets: SheetConnectivityInput[],
  project: Record<string, string[]> = {}
): BusAliases => {
  const aliases = new Map<string, string[]>()
  for (const { schematic } of sheets) {
    for (const node of findChildren(schematic._root, 'bus_alias')) {
      const name = getFirstAtomValue(node)
      const members = findChild(node, 'members')
      if (!name || !members || aliases.has(name)) continue
      aliases.set(
        name,
        members.children.slice(1).flatMap((child) => (child.type === 'atom' ? [child.value] : []))
      )
    }
  }
  for (const [name, members] of Object.entries(project)) {
    if (!aliases.has(name)) aliases.set(name, members)
  }
  return aliases
}

/** A bus's pieces on one sheet: its wires, and the labels and sheet pins that name it. */
interface BusNode {
  sheet: number
  points: Point[]
  isBus: boolean
  /** The bus wire, for a wire node. */
  wire?: KicadWire
  /** KiCad's id of the label or sheet pin that names it. */
  id?: string
  driver?: { text: string; source: NetNameSource; bus: BusName }
  /** A sheet pin's child sheet, for the hierarchy link. */
  childSheet?: KicadSheet
}

/** What a design's project file adds to its sheets' naming. */
export interface ProjectNaming {
  /** `schematic.bus_aliases`: KiCad 9 and later keep a design's aliases here. */
  busAliases?: Record<string, string[]>
  /** `text_variables`, the last place a `${NAME}` is looked up. */
  textVariables?: Readonly<Record<string, string>>
}

/**
 * A text as KiCad shows it on each sheet instance: `${#}`, `${##}`,
 * `${SHEETNAME}`, `${SHEETPATH}` and the sheet symbol's own fields (a sheet's
 * `param` field is its `${param}`), then the project's text variables,
 * resolved, and `@{…}` evaluated — so one reused sheet can name its nets per
 * instance. A sheet pin's text is shown on its child sheet's instance.
 */
export const shownTextOn = (
  sheets: SheetConnectivityInput[],
  textVariables: Readonly<Record<string, string>> = {}
): ((sheetIndex: number, text: string) => string) => {
  const pages = new Set(sheets.map((sheet) => sheet.page).filter(Boolean)).size || sheets.length
  const byPath = new Map(sheets.map((sheet, index) => [sheet.sheetPath, index]))
  const fields = new Map<number, Map<string, string>>()
  const fieldsOf = (sheetIndex: number): Map<string, string> => {
    let own = fields.get(sheetIndex)
    if (own) return own
    own = new Map()
    const path = sheets[sheetIndex]?.sheetPath ?? ''
    const cut = path.lastIndexOf('/')
    const parent = cut > 0 ? byPath.get(path.slice(0, cut)) : undefined
    const uuid = path.slice(cut + 1)
    const node =
      parent !== undefined
        ? sheets[parent].schematic.sheets.find((sheet) => sheet.uuid === uuid)
        : undefined
    for (const property of node?.properties ?? []) own.set(property.key, property.value)
    fields.set(sheetIndex, own)
    return own
  }
  return (sheetIndex, text) =>
    shownText(text, (name) => {
      const sheet = sheets[sheetIndex]
      if (name === '#') return sheet?.page
      if (name === '##') return String(pages)
      if (name === 'SHEETNAME') return sheet?.sheetName
      if (name === 'SHEETPATH') return sheet?.namePath
      return fieldsOf(sheetIndex).get(name) ?? textVariables[name]
    })
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function buildConnectivity(
  sheets: SheetConnectivityInput[],
  project: ProjectNaming = {}
): SchematicConnectivity {
  const unionFind = new UnionFind()
  /** KiCad's subgraphs: what joins on one sheet instance, by wiring or by a
   *  name on that sheet. Unlike `unionFind`, no hierarchy or global name. */
  const sheetFind = new UnionFind()
  const items: Item[] = []
  /** point key -> item ids per sheet (`sheetIndex|x,y`). */
  const pointMap = new Map<string, number[]>()
  /** name -> item ids, for cross-sheet merges. */
  const globalNames = new Map<string, number[]>()
  const powerNames = new Map<string, number[]>()
  /** `sheetIndex|text` -> item ids: same-named labels on one sheet connect. */
  const sheetLocalNames = new Map<string, number[]>()

  const sheetKey = (sheet: number, point: Point): string => `${sheet}|${pointKey(point)}`
  const aliases = busAliasesOf(sheets, project.busAliases)
  const shown = shownTextOn(sheets, project.textVariables)
  const indexOfPath = new Map(sheets.map((sheet, index) => [sheet.sheetPath, index]))
  /** A sheet pin's text, shown on the instance of the sheet it leads into. */
  const shownPin = (sheetIndex: number, sheetNode: KicadSheet, text: string): string => {
    const child = indexOfPath.get(`${sheets[sheetIndex].sheetPath}/${sheetNode.uuid}`)
    return child === undefined ? text : shown(child, text)
  }

  const busNodes: BusNode[] = []
  /** Each bus entry's two end items, to learn which end meets a bus. */
  const entryEnds: Array<{ sheet: number; ends: Array<Item & { kind: 'bus_entry' }> }> = []
  const busPorts = new Set<string>()
  const buses: SchematicBus[] = []

  const addItem = (item: DistributiveOmit<Item, 'id'>): Item => {
    const id = unionFind.make()
    sheetFind.make()
    const full = { ...item, id } as Item
    items.push(full)
    for (const point of full.points) {
      const key = sheetKey(full.sheet, point)
      const bucket = pointMap.get(key)
      if (bucket) bucket.push(id)
      else pointMap.set(key, [id])
    }
    return full
  }

  // -- Pass 1: enumerate items per sheet ------------------------------------
  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
    const { sheetPath, schematic } = sheets[sheetIndex]

    schematic.wires.forEach((wire, wireIndex) => {
      if (wire.points.length < 2) return
      addItem({ sheet: sheetIndex, kind: 'wire', wireIndex, wire, points: wire.points })
    })

    for (const position of schematic.junctions) {
      addItem({ sheet: sheetIndex, kind: 'junction', points: [position] })
    }
    for (const position of schematic.noConnects) {
      addItem({ sheet: sheetIndex, kind: 'no_connect', points: [position] })
    }
    // Each end is its own item: an entry does not join its bus side to its wire side.
    for (const entry of schematic.busEntries) {
      const { position, size } = entry
      const far = { x: nm(position.x + size.width), y: nm(position.y + size.height) }
      const ends = [
        addItem({ sheet: sheetIndex, kind: 'bus_entry', entry, points: [position] }),
        addItem({ sheet: sheetIndex, kind: 'bus_entry', entry, points: [far] })
      ]
      entryEnds.push({ sheet: sheetIndex, ends: ends as Array<Item & { kind: 'bus_entry' }> })
    }

    for (const label of schematic.labels) {
      const text = shown(sheetIndex, label.text)
      const bus = parseBusName(text, aliases)
      if (bus) {
        const source: NetNameSource =
          label.type === 'global_label'
            ? 'global_label'
            : label.type === 'label'
              ? 'local_label'
              : 'hierarchical_label'
        busNodes.push({
          sheet: sheetIndex,
          points: [label.position],
          isBus: false,
          id: label.uuid,
          driver: { text, source, bus }
        })
        continue
      }
      const item = addItem({ sheet: sheetIndex, kind: 'label', label, points: [label.position] })
      // By the name as a net name spells it: `A/B` and `A{slash}B` are one name.
      const name = escapeNetName(text)
      if (label.type === 'global_label') {
        const bucket = globalNames.get(name)
        if (bucket) bucket.push(item.id)
        else globalNames.set(name, [item.id])
      } else {
        // Local and hierarchical labels connect by name within their sheet.
        const key = `${sheetIndex}|${name}`
        const bucket = sheetLocalNames.get(key)
        if (bucket) bucket.push(item.id)
        else sheetLocalNames.set(key, [item.id])
      }
    }

    for (const bus of schematic.buses) {
      if (bus.points.length >= 2) {
        busNodes.push({ sheet: sheetIndex, points: bus.points, isBus: true, wire: bus })
      }
    }
    for (const position of schematic.junctions) {
      busNodes.push({ sheet: sheetIndex, points: [position], isBus: false })
    }

    for (const sheetNode of schematic.sheets) {
      for (const pin of sheetNode.pins) {
        const pinText = shownPin(sheetIndex, sheetNode, pin.name)
        const bus = parseBusName(pinText, aliases)
        if (bus) {
          busNodes.push({
            sheet: sheetIndex,
            points: [pin.position],
            isBus: false,
            id: sheetPinUuid(pin),
            driver: { text: pinText, source: 'sheet_pin', bus },
            childSheet: sheetNode
          })
          continue
        }
        // Not merged by name: a net a sheet pin names is weakly driven, and
        // KiCad joins same-sheet nets by name only where a label or power port
        // names them — so a chain of one sheet's instances stays a chain.
        addItem({
          sheet: sheetIndex,
          kind: 'sheet_pin',
          sheet_: sheetNode,
          pin,
          points: [pin.position]
        })
      }
    }

    for (const symbol of schematic.symbols) {
      const geometry = resolveSymbolGeometry(schematic, symbol)
      const reference =
        referenceForSheetPath(symbol, sheetPath) ?? getSymbolProperty(symbol, 'Reference') ?? '?'
      const power = isPowerSymbol(schematic, symbol)
      for (const { pin } of geometry.pins) {
        const position = placedPinPosition(symbol, pin)
        const item = addItem({
          sheet: sheetIndex,
          kind: 'pin',
          netPin: {
            sheetPath,
            symbol,
            reference,
            pin,
            position,
            noConnect: false,
            power,
            ...(power && pin.electricalType === 'power_in'
              ? {
                  powerName: shown(sheetIndex, powerNetName(symbol, pin, schematic)),
                  ...(isLocalPowerSymbol(schematic, symbol) ? { localPower: true } : {})
                }
              : {})
          },
          points: [position]
        })
        // KiCad's `SCH_PIN::IsGlobalPower`: only a power_in pin of a power
        // symbol names and merges a net by its value. A PWR_FLAG is a power
        // symbol too, but its pin is power_out — it drives, it never names,
        // and two of them on two rails must not become one net.
        if (power && pin.electricalType === 'power_in') {
          const name = shown(sheetIndex, powerNetName(symbol, pin, schematic))
          if (name && isLocalPowerSymbol(schematic, symbol)) {
            // A local power port names its sheet's net, as a local label does.
            const key = `${sheetIndex}|${escapeNetName(name)}`
            const bucket = sheetLocalNames.get(key)
            if (bucket) bucket.push(item.id)
            else sheetLocalNames.set(key, [item.id])
          } else if (name) {
            const bucket = powerNames.get(name)
            if (bucket) bucket.push(item.id)
            else powerNames.set(name, [item.id])
          }
        } else if (pin.hidden && pin.electricalType === 'power_in' && pin.name) {
          // Legacy implicit power pin: connects globally by name.
          const bucket = powerNames.get(pin.name)
          if (bucket) bucket.push(item.id)
          else powerNames.set(pin.name, [item.id])
        }
      }
    }
  }

  // -- Pass 1b: buses ------------------------------------------------------
  // A bus is its wires and what sits on them, per sheet; the strongest label
  // or sheet pin on it names it, as a net is named. Buses join as nets do —
  // one name on one sheet, a global name anywhere, a sheet pin and its child's
  // hierarchical label — and each member it carries joins the net of that
  // name on its sheet, and the member it matches on every bus joined to it.
  {
    const busFind = new UnionFind()
    busNodes.forEach(() => busFind.make())
    const busPoints = new Map<string, number[]>()
    busNodes.forEach((node, id) => {
      const ends = node.isBus ? [node.points[0], node.points[node.points.length - 1]] : node.points
      for (const point of ends) {
        const key = sheetKey(node.sheet, point)
        const bucket = busPoints.get(key)
        if (bucket) bucket.push(id)
        else busPoints.set(key, [id])
      }
    })
    for (const bucket of busPoints.values()) {
      for (let index = 1; index < bucket.length; index++) busFind.union(bucket[0], bucket[index])
    }
    const busesOnSheet = new Map<number, number[]>()
    busNodes.forEach((node, id) => {
      if (!node.isBus) return
      const list = busesOnSheet.get(node.sheet) ?? []
      list.push(id)
      busesOnSheet.set(node.sheet, list)
    })
    busNodes.forEach((node, id) => {
      if (node.isBus) return
      for (const busId of busesOnSheet.get(node.sheet) ?? []) {
        const { points } = busNodes[busId]
        for (let index = 0; index + 1 < points.length; index++) {
          if (insideSegment(node.points[0], points[index], points[index + 1])) {
            busFind.union(id, busId)
            break
          }
        }
      }
    })

    // Each named piece: its sheet, its driver, and the member items it carries.
    interface Piece {
      sheet: number
      driver: NonNullable<BusNode['driver']>
      members: number[]
    }
    const pieceOf = new Map<number, Piece>()
    const rank = (source: NetNameSource): number => NAME_PRIORITY[source]
    busNodes.forEach((node, id) => {
      if (!node.driver) return
      const root = busFind.find(id)
      const piece = pieceOf.get(root)
      if (
        !piece ||
        rank(node.driver.source) > rank(piece.driver.source) ||
        (rank(node.driver.source) === rank(piece.driver.source) &&
          node.driver.text < piece.driver.text)
      ) {
        pieceOf.set(root, { sheet: node.sheet, driver: node.driver, members: [] })
      }
    })
    const ported = new Set<Piece>()
    busNodes.forEach((node, id) => {
      if (node.childSheet || node.driver?.source === 'hierarchical_label') {
        ported.add(pieceOf.get(busFind.find(id))!)
      }
    })
    for (const piece of pieceOf.values()) {
      if (ported.has(piece)) {
        for (const member of piece.driver.bus.members) {
          busPorts.add(`${sheets[piece.sheet].sheetPath}|${member.name}`)
        }
      }
      for (const member of piece.driver.bus.members) {
        const item = addItem({ sheet: piece.sheet, kind: 'bus_member', points: [] })
        piece.members.push(item.id)
        const key = `${piece.sheet}|${member.name}`
        const bucket = sheetLocalNames.get(key)
        if (bucket) bucket.push(item.id)
        else sheetLocalNames.set(key, [item.id])
      }
    }
    const busByRoot = new Map<number, SchematicBus>()
    busNodes.forEach((node, id) => {
      const root = busFind.find(id)
      let bus = busByRoot.get(root)
      if (!bus) {
        if (!node.isBus && !node.driver) return
        bus = { sheetPath: sheets[node.sheet].sheetPath, wires: [], names: [] }
        busByRoot.set(root, bus)
        buses.push(bus)
      }
      if (node.wire) bus.wires.push(node.wire)
      if (node.driver) {
        bus.names.push({
          text: node.driver.text,
          source: node.driver.source,
          ...(node.id ? { id: node.id } : {}),
          ...((node.childSheet ? node.childSheet.uuid : node.id)
            ? { select: node.childSheet ? node.childSheet.uuid : node.id }
            : {}),
          members: node.driver.bus.members.map((member) => member.name),
          position: node.points[0]
        })
      }
    })

    // A bus entry's end on a bus tells its other end which members it may carry.
    const busAt = (sheet: number, point: Point): Piece | null | undefined => {
      for (const id of busPoints.get(sheetKey(sheet, point)) ?? []) {
        if (busNodes[id].isBus) return pieceOf.get(busFind.find(id)) ?? null
      }
      for (const busId of busesOnSheet.get(sheet) ?? []) {
        const { points } = busNodes[busId]
        for (let index = 0; index + 1 < points.length; index++) {
          if (onSegment(point, points[index], points[index + 1])) {
            return pieceOf.get(busFind.find(busId)) ?? null
          }
        }
      }
      return undefined
    }
    for (const { sheet, ends } of entryEnds) {
      ends.forEach((end, index) => {
        const bus = busAt(sheet, end.points[0])
        if (bus === undefined) return
        end.onBus = true
        ends[1 - index].busMembers = bus ? bus.driver.bus.members.map((member) => member.name) : []
      })
    }

    /** Across a sheet boundary: `to`'s members join the ones of `from` they match. */
    const link = (from: Piece, to: Piece): void => {
      to.driver.bus.members.forEach((member, index) => {
        const match = matchBusMember(from.driver.bus, member)
        if (match >= 0) unionFind.union(from.members[match], to.members[index])
      })
    }
    /** Under one name: members of the same name are one net. */
    const join = (a: Piece, b: Piece): void => {
      const byMemberName = new Map(
        a.driver.bus.members.map((member, index) => [member.name, index])
      )
      b.driver.bus.members.forEach((member, index) => {
        const match = byMemberName.get(member.name)
        if (match !== undefined) unionFind.union(a.members[match], b.members[index])
      })
    }
    // Pieces that share a name: one local name on a sheet, one global name anywhere.
    const byName = new Map<string, Piece>()
    busNodes.forEach((node, id) => {
      if (!node.driver) return
      const piece = pieceOf.get(busFind.find(id))!
      const keys =
        node.driver.source === 'global_label'
          ? [`global|${node.driver.text}`, `${node.sheet}|${node.driver.text}`]
          : [`${node.sheet}|${node.driver.text}`]
      for (const key of keys) {
        const first = byName.get(key)
        if (!first) byName.set(key, piece)
        else if (first !== piece) join(first, piece)
      }
    })
    // A bus sheet pin and the child's hierarchical labels of its name.
    const sheetIndexOf = new Map(sheets.map((sheet, index) => [sheet.sheetPath, index]))
    const ports = new Map<string, number[]>()
    busNodes.forEach((node, id) => {
      if (node.driver?.source !== 'hierarchical_label') return
      const key = `${node.sheet}|${node.driver.text}`
      const list = ports.get(key) ?? []
      list.push(id)
      ports.set(key, list)
    })
    busNodes.forEach((node, id) => {
      if (!node.childSheet || !node.driver) return
      const child = sheetIndexOf.get(
        `${sheets[node.sheet].sheetPath}/${node.childSheet.uuid ?? ''}`
      )
      if (child === undefined) return
      const parent = pieceOf.get(busFind.find(id))!
      for (const otherId of ports.get(`${child}|${node.driver.text}`) ?? []) {
        link(parent, pieceOf.get(busFind.find(otherId))!)
      }
    })
  }

  // -- Pass 2: union coincident connection points ---------------------------
  // A pin typed no-connect joins nothing, as KiCad has it: whatever touches it,
  // it stays a net of its own.
  const isolated = (id: number): boolean => {
    const item = items[id]
    return item.kind === 'pin' && item.netPin.pin.electricalType === 'no_connect'
  }
  for (const bucket of pointMap.values()) {
    const joined = bucket.filter((id) => !isolated(id))
    for (let index = 1; index < joined.length; index++) {
      unionFind.union(joined[0], joined[index])
      sheetFind.union(joined[0], joined[index])
    }
  }

  // -- Pass 3: junctions and labels on wire interiors -----------------------
  // Each wire is bucketed into the grid cells its segments' tolerance boxes
  // cover, so a point tests only the wires near it.
  const cellOf = (value: number): number => Math.floor(value / WIRE_CELL)
  const cellKey = (sheet: number, cx: number, cy: number): string => `${sheet}|${cx}|${cy}`
  const wiresByCell = new Map<string, number[]>()
  for (const wire of items) {
    if (wire.kind !== 'wire') continue
    for (let index = 0; index + 1 < wire.points.length; index++) {
      const a = wire.points[index]
      const b = wire.points[index + 1]
      const cx1 = cellOf(Math.max(a.x, b.x) + ON_SEGMENT_TOLERANCE)
      const cy1 = cellOf(Math.max(a.y, b.y) + ON_SEGMENT_TOLERANCE)
      for (let cx = cellOf(Math.min(a.x, b.x) - ON_SEGMENT_TOLERANCE); cx <= cx1; cx++) {
        for (let cy = cellOf(Math.min(a.y, b.y) - ON_SEGMENT_TOLERANCE); cy <= cy1; cy++) {
          const key = cellKey(wire.sheet, cx, cy)
          const bucket = wiresByCell.get(key)
          // A wire's segments are bucketed together, so a repeat is always the last entry.
          if (!bucket) wiresByCell.set(key, [wire.id])
          else if (bucket[bucket.length - 1] !== wire.id) bucket.push(wire.id)
        }
      }
    }
  }
  for (const other of items) {
    if (!connectsOnWireInterior(other)) continue
    for (const point of other.points) {
      for (const id of wiresByCell.get(cellKey(other.sheet, cellOf(point.x), cellOf(point.y))) ??
        []) {
        const { points } = items[id]
        for (let index = 0; index + 1 < points.length; index++) {
          if (insideSegment(point, points[index], points[index + 1])) {
            unionFind.union(id, other.id)
            sheetFind.union(id, other.id)
            break
          }
        }
      }
    }
  }

  // The pieces, before any name joins them.
  const pieceRoots = items.map((item) => unionFind.find(item.id))

  // -- Pass 4: merges by name (local per sheet, global/power everywhere) ----
  for (const bucket of [
    ...sheetLocalNames.values(),
    ...globalNames.values(),
    ...powerNames.values()
  ]) {
    for (let index = 1; index < bucket.length; index++) unionFind.union(bucket[0], bucket[index])
  }
  for (const bucket of sheetLocalNames.values()) {
    for (let index = 1; index < bucket.length; index++) sheetFind.union(bucket[0], bucket[index])
  }
  // On one sheet, a local name joins a global label or power port of the same
  // name: KiCad merges same-sheet subgraphs whose unprefixed names match
  // (`CONNECTION_GRAPH::buildConnectionGraph`), so a local `GND` label lands
  // on the `GND` rail when a `power:GND` stands on the same sheet. A local
  // power port alone does not: its `GND` stays apart from a global `GND`.
  for (const [key, bucket] of sheetLocalNames) {
    if (!bucket.some((id) => items[id].kind === 'label')) continue
    const separator = key.indexOf('|')
    const sheetIndex = Number(key.slice(0, separator))
    const name = key.slice(separator + 1)
    for (const id of [...(globalNames.get(name) ?? []), ...(powerNames.get(name) ?? [])]) {
      if (items[id].sheet === sheetIndex) {
        unionFind.union(bucket[0], id)
        sheetFind.union(bucket[0], id)
      }
    }
  }
  // A global label and a power port of one name are one net, as in KiCad: the
  // `+3V3` label on a decoupling group joins the `+3V3` symbol on the rail.
  for (const [name, powerBucket] of powerNames) {
    const globalBucket = globalNames.get(name)
    if (globalBucket?.length && powerBucket.length) unionFind.union(globalBucket[0], powerBucket[0])
  }

  // -- Pass 5: hierarchical label <-> parent sheet pin ----------------------
  const sheetByPath = new Map<string, number>()
  sheets.forEach((sheet, index) => sheetByPath.set(sheet.sheetPath, index))
  /** `sheetIndex|text` -> the hierarchical labels of that name on that sheet. */
  const hierarchicalLabels = new Map<string, number[]>()
  for (const item of items) {
    if (item.kind !== 'label' || item.label.type !== 'hierarchical_label') continue
    const key = `${item.sheet}|${escapeNetName(shown(item.sheet, item.label.text))}`
    const bucket = hierarchicalLabels.get(key)
    if (bucket) bucket.push(item.id)
    else hierarchicalLabels.set(key, [item.id])
  }
  for (const item of items) {
    if (item.kind !== 'sheet_pin') continue
    const childPath = `${sheets[item.sheet].sheetPath}/${item.sheet_.uuid ?? ''}`
    const childIndex = sheetByPath.get(childPath)
    if (childIndex === undefined) continue
    // A sheet pin's name reads as the child instance shows it.
    for (const id of hierarchicalLabels.get(
      `${childIndex}|${escapeNetName(shown(childIndex, item.pin.name))}`
    ) ?? []) {
      unionFind.union(item.id, id)
    }
  }

  // -- Pass 6: group into nets and name them --------------------------------
  const groups = new Map<number, Item[]>()
  for (const item of items) {
    const root = unionFind.find(item.id)
    const group = groups.get(root)
    if (group) group.push(item)
    else groups.set(root, [item])
  }

  interface NameCandidate {
    name: string
    source: NetNameSource
    /** How deep the sheet the candidate sits on is; global names ignore it. */
    depth: number
    /** A sheet pin drawn as an output; it outranks its siblings. */
    output?: boolean
    /** The subgraph (`sheetFind` root) a label or sheet pin sits in. */
    subgraph?: number
  }

  const depthOf = (sheetPath: string): number => sheetPath.split('/').length
  const isGlobal = (candidate: NameCandidate): boolean =>
    candidate.source === 'global_label' || candidate.source === 'power'
  const byName = (a: NameCandidate, b: NameCandidate): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  /** A global label or power port names the net wherever it is, the stronger kind first. */
  const byGlobal = (a: NameCandidate, b: NameCandidate): number =>
    NAME_PRIORITY[b.source] - NAME_PRIORITY[a.source] || byName(a, b)
  /**
   * The driver of one subgraph (`CONNECTION_SUBGRAPH::ResolveDrivers`): the
   * strongest kind, then an output sheet pin over its siblings, then the
   * lowest name in code-point order.
   */
  const bySubgraphDriver = (a: NameCandidate, b: NameCandidate): number => {
    if (NAME_PRIORITY[a.source] !== NAME_PRIORITY[b.source])
      return NAME_PRIORITY[b.source] - NAME_PRIORITY[a.source]
    if (a.source === 'sheet_pin' && b.source === 'sheet_pin' && !!a.output !== !!b.output)
      return a.output ? -1 : 1
    return byName(a, b)
  }
  /**
   * Which subgraph's driver names a net that crosses sheets
   * (`CONNECTION_GRAPH::propagateToNeighbors`): a label at any depth beats a
   * sheet pin, the stronger kind wins at any depth, and only between drivers
   * of one kind does the shallower sheet win, then the lower name.
   */
  const byHierarchy = (a: NameCandidate, b: NameCandidate): number =>
    NAME_PRIORITY[b.source] - NAME_PRIORITY[a.source] || a.depth - b.depth || byName(a, b)

  const pickName = (candidates: NameCandidate[]): NameCandidate | undefined => {
    const globals = candidates.filter(isGlobal)
    if (globals.length) return globals.sort(byGlobal)[0]
    const drivers = new Map<number, NameCandidate>()
    for (const candidate of candidates) {
      if (candidate.subgraph === undefined) continue
      const driver = drivers.get(candidate.subgraph)
      if (!driver || bySubgraphDriver(candidate, driver) < 0)
        drivers.set(candidate.subgraph, candidate)
    }
    if (drivers.size) return [...drivers.values()].sort(byHierarchy)[0]
    return candidates[0]
  }

  const nets: SchematicNet[] = []
  const netByItem = new Map<number, SchematicNet>()
  let unnamedCounter = 0

  for (const group of groups.values()) {
    const net: SchematicNet = {
      name: '',
      nameSource: 'none',
      hasNoConnect: false,
      pins: [],
      wires: [],
      labels: [],
      sheetPins: [],
      junctions: []
    }
    const candidates: NameCandidate[] = []
    let noConnectPoints: Set<string> | null = null

    for (const item of group) {
      const { sheetPath, namePath } = sheets[item.sheet]
      switch (item.kind) {
        case 'wire':
          net.wires.push({ sheetPath, wireIndex: item.wireIndex, wire: item.wire })
          break
        case 'pin':
          net.pins.push(item.netPin)
          if (item.netPin.localPower && item.netPin.powerName)
            candidates.push({
              name: scopedName(namePath, escapeNetName(item.netPin.powerName)),
              source: 'local_power',
              depth: depthOf(sheetPath),
              subgraph: sheetFind.find(item.id)
            })
          break
        case 'label': {
          net.labels.push({ sheetPath, label: item.label })
          const { type } = item.label
          const depth = depthOf(sheetPath)
          const subgraph = sheetFind.find(item.id)
          const escaped = escapeNetName(shown(item.sheet, item.label.text))
          if (type === 'global_label')
            candidates.push({ name: escaped, source: 'global_label', depth })
          else
            candidates.push({
              name: scopedName(namePath, escaped),
              source: type === 'label' ? 'local_label' : 'hierarchical_label',
              depth,
              subgraph
            })
          break
        }
        case 'sheet_pin': {
          net.sheetPins.push({ sheetPath, sheet: item.sheet_, pin: item.pin })
          // Scoped to the sheet the pin is drawn on, as any driver there is.
          const pinName = escapeNetName(shownPin(item.sheet, item.sheet_, item.pin.name))
          candidates.push({
            name: scopedName(namePath, pinName),
            source: 'sheet_pin',
            depth: depthOf(sheetPath),
            output: item.pin.electricalType === 'output',
            subgraph: sheetFind.find(item.id)
          })
          break
        }
        case 'junction':
          net.junctions.push({ sheetPath, position: item.points[0] })
          break
        case 'no_connect':
          noConnectPoints ??= new Set()
          noConnectPoints.add(sheetKey(item.sheet, item.points[0]))
          break
        case 'bus_entry':
        case 'bus_member':
          break
      }
    }

    if (noConnectPoints) {
      net.hasNoConnect = true
      for (const pin of net.pins) {
        const sheetIndex = sheetByPath.get(pin.sheetPath) ?? -1
        if (noConnectPoints.has(sheetKey(sheetIndex, pin.position))) pin.noConnect = true
      }
    }

    // Power drivers: any pin belonging to a power symbol / implicit power pin.
    for (const pin of net.pins) {
      const schematicIndex = sheetByPath.get(pin.sheetPath)
      const schematic = schematicIndex !== undefined ? sheets[schematicIndex].schematic : undefined
      if (
        schematicIndex !== undefined &&
        schematic &&
        isPowerSymbol(schematic, pin.symbol) &&
        pin.pin.electricalType === 'power_in' &&
        !pin.localPower
      ) {
        const name = shown(schematicIndex, powerNetName(pin.symbol, pin.pin, schematic))
        if (name) candidates.push({ name, source: 'power', depth: 0 })
      } else if (
        !pin.localPower &&
        pin.pin.hidden &&
        pin.pin.electricalType === 'power_in' &&
        pin.pin.name
      ) {
        candidates.push({ name: pin.pin.name, source: 'power', depth: 0 })
      }
    }

    if (!candidates.length) {
      // Fallback: name from a pin, as KiCad does. Every pin proposes its
      // default name; a name built from a pad number loses to one built from
      // a pin name, then the lowest name wins (`compareDrivers`). Real
      // components outrank #PWR/#FLG bookkeeping references.
      // KiCad's `aForceNoConnect`: a flag anywhere on the net names it unconnected.
      const unconnected = net.pins.length === 1 || noConnectPoints !== null
      const real = net.pins.filter((pin) => !pin.reference.startsWith('#'))
      const proposals = (real.length ? real : net.pins)
        .map((pin) => {
          const sheetIndex = sheetByPath.get(pin.sheetPath)
          const schematic = sheetIndex !== undefined ? sheets[sheetIndex].schematic : undefined
          return pinNetName(schematic, pin, unconnected)
        })
        .sort((a, b) => {
          const aLow = a.includes('-Pad')
          const bLow = b.includes('-Pad')
          if (aLow !== bLow) return aLow ? 1 : -1
          return a < b ? -1 : a > b ? 1 : 0
        })
      if (proposals.length) candidates.push({ name: proposals[0], source: 'pin', depth: 0 })
    }

    // Bare markers (an isolated junction or no-connect) are not a net.
    if (!net.pins.length && !net.wires.length && !net.labels.length && !net.sheetPins.length) {
      continue
    }

    const winner = pickName(candidates)
    if (winner) {
      net.name = winner.name
      net.nameSource = winner.source
    } else {
      net.name = `Net-(unnamed-${unnamedCounter++})`
      net.nameSource = 'none'
    }

    nets.push(net)
    for (const item of group) netByItem.set(item.id, net)
  }

  // -- Pass 7: dangling ends -------------------------------------------------
  const dangling: DanglingEnd[] = []
  /**
   * Does this item attach `self`'s end?
   *
   * Not a hidden pin of `self`'s own symbol. Stacked pads — a symbol drawing
   * three grounds at one coordinate with two hidden — are a drawing device,
   * not a connection anyone made; with nothing else there the node floats, as
   * KiCad's ERC says. Any other symbol's pin attaches, hidden or not: a power
   * symbol's pin is hidden, and it is how most pins and wires reach a rail.
   *
   * The net is unaffected: stacked pads are one node either way.
   */
  const countsAsAttached = (id: number, self: Item): boolean => {
    const item = items[id]
    return !(
      item?.kind === 'pin' &&
      item.netPin.pin.hidden &&
      self.kind === 'pin' &&
      item.netPin.symbol === self.netPin.symbol
    )
  }

  /** What shares the point: a wire end or pin resting on another wire's
   *  interior is KiCad's "unconnected wire endpoint" / "pin not connected". */
  const connectionCount = (sheet: number, point: Point, self: Item): number => {
    let count = 0
    for (const id of pointMap.get(sheetKey(sheet, point)) ?? []) {
      if (id !== self.id && countsAsAttached(id, self)) count++
    }
    return count
  }

  for (const item of items) {
    const { sheetPath } = sheets[item.sheet]
    if (item.kind === 'wire') {
      for (const point of [item.points[0], item.points[item.points.length - 1]]) {
        if (!connectionCount(item.sheet, point, item)) {
          dangling.push({
            sheetPath,
            position: point,
            kind: 'wire',
            wire: item.wire,
            wireIndex: item.wireIndex,
            ...(item.wire.uuid ? { wireUuid: item.wire.uuid } : {})
          })
        }
      }
    } else if (
      item.kind === 'pin' &&
      !item.netPin.pin.hidden &&
      // Pins typed as left open are open on purpose.
      !OPEN_BY_DESIGN.has(item.netPin.pin.electricalType)
    ) {
      if (!item.netPin.noConnect && !connectionCount(item.sheet, item.netPin.position, item)) {
        dangling.push({
          sheetPath,
          position: item.netPin.position,
          kind: 'pin',
          reference: item.netPin.reference,
          pinNumber: item.netPin.pin.number,
          ...(item.netPin.symbol.uuid ? { symbolUuid: item.netPin.symbol.uuid } : {}),
          ...pinUuidOf(item.netPin)
        })
      }
    }
  }

  // A label or sheet pin alone in its piece — joined to nothing before names
  // join pieces — has nothing at its anchor.
  const pieceSize = new Map<number, number>()
  for (const root of pieceRoots) pieceSize.set(root, (pieceSize.get(root) ?? 0) + 1)
  const openAnchors: OpenAnchor[] = []
  items.forEach((item, index) => {
    if (item.kind !== 'label' && item.kind !== 'sheet_pin') return
    if (pieceSize.get(pieceRoots[index]) !== 1) return
    openAnchors.push({
      sheetPath: sheets[item.sheet].sheetPath,
      position: { x: item.points[0].x, y: item.points[0].y },
      kind: item.kind === 'label' ? item.label.type : 'sheet_pin'
    })
  })

  // A bus end with nothing on it — no other bus, bus entry, dot, or label or
  // sheet pin naming a bus — is marked as KiCad marks a dangling bus end. A
  // mark only: KiCad's unconnected-endpoint ERC is the wire's.
  const entryAt = new Set(
    entryEnds.flatMap(({ sheet, ends }) => ends.map((end) => sheetKey(sheet, end.points[0])))
  )
  const busNodesOn = new Map<number, BusNode[]>()
  for (const node of busNodes) {
    const list = busNodesOn.get(node.sheet)
    if (list) list.push(node)
    else busNodesOn.set(node.sheet, [node])
  }
  for (const node of busNodes) {
    if (!node.isBus || node.points.length < 2) continue
    for (const end of [node.points[0], node.points[node.points.length - 1]]) {
      if (entryAt.has(sheetKey(node.sheet, end))) continue
      const held = (busNodesOn.get(node.sheet) ?? []).some((other) =>
        other === node
          ? false
          : other.isBus
            ? other.points.some((p, i) => i > 0 && onSegment(end, other.points[i - 1], p))
            : other.points.some((p) => pointKey(p) === pointKey(end))
      )
      if (!held)
        openAnchors.push({
          sheetPath: sheets[node.sheet].sheetPath,
          position: { x: end.x, y: end.y },
          kind: 'bus'
        })
    }
  }

  // -- Pieces -----------------------------------------------------------------
  const pieceByRoot = new Map<number, SchematicPiece>()
  for (const item of items) {
    if (item.kind === 'bus_member' || (item.kind === 'bus_entry' && item.onBus)) continue
    const root = pieceRoots[item.id]
    const sheetPath = sheets[item.sheet].sheetPath
    let piece = pieceByRoot.get(root)
    if (!piece) {
      piece = {
        sheetPath,
        pins: [],
        labels: [],
        wires: [],
        sheetPins: [],
        junctions: [],
        noConnects: [],
        busEntries: 0,
        busLinks: []
      }
      pieceByRoot.set(root, piece)
    }
    piece.net ??= netByItem.get(item.id)
    switch (item.kind) {
      case 'pin':
        piece.pins.push(item.netPin)
        break
      case 'label':
        piece.labels.push(item.label)
        break
      case 'wire':
        piece.wires.push({ sheetPath, wireIndex: item.wireIndex, wire: item.wire })
        break
      case 'sheet_pin':
        piece.sheetPins.push({ sheetPath, sheet: item.sheet_, pin: item.pin })
        break
      case 'junction':
        piece.junctions.push(item.points[0])
        break
      case 'no_connect':
        piece.noConnects.push(item.points[0])
        break
      case 'bus_entry':
        piece.busEntries++
        if (item.busMembers) piece.busLinks.push({ entry: item.entry, members: item.busMembers })
        break
    }
  }
  const pieces = [...pieceByRoot.values()]

  // -- Lookups ----------------------------------------------------------------
  const pinIndex = new Map<string, SchematicNet>()
  const wireIndexMap = new Map<string, SchematicNet>()
  for (const item of items) {
    const net = netByItem.get(item.id)
    if (!net) continue
    if (item.kind === 'pin' && item.netPin.symbol.uuid) {
      pinIndex.set(
        `${item.netPin.sheetPath}|${item.netPin.symbol.uuid}|${item.netPin.pin.number}`,
        net
      )
    } else if (item.kind === 'wire') {
      wireIndexMap.set(`${sheets[item.sheet].sheetPath}|${item.wireIndex}`, net)
    }
  }

  const netAt = (
    sheetPath: string,
    point: Point,
    tolerance = ON_SEGMENT_TOLERANCE
  ): SchematicNet | undefined => {
    const sheet = sheetByPath.get(sheetPath)
    if (sheet === undefined) return undefined
    for (const id of pointMap.get(sheetKey(sheet, point)) ?? []) {
      const net = netByItem.get(id)
      if (net) return net
    }
    let best: SchematicNet | undefined
    let bestDistance = tolerance
    for (const item of items) {
      if (item.sheet !== sheet || item.kind === 'no_connect' || item.kind === 'bus_entry') continue
      if (item.kind === 'wire') {
        for (let index = 0; index + 1 < item.points.length; index++) {
          const distance = segmentDistance(point, item.points[index], item.points[index + 1])
          if (distance <= bestDistance) {
            bestDistance = distance
            best = netByItem.get(item.id)
          }
        }
      } else {
        for (const itemPoint of item.points) {
          const distance = Math.hypot(point.x - itemPoint.x, point.y - itemPoint.y)
          if (distance <= bestDistance) {
            bestDistance = distance
            best = netByItem.get(item.id)
          }
        }
      }
    }
    return best
  }

  return {
    nets,
    pieces,
    buses,
    busPorts,
    dangling,
    openAnchors,
    netOfPin: (sheetPath, symbolUuid, pinNumber) =>
      pinIndex.get(`${sheetPath}|${symbolUuid}|${pinNumber}`),
    netOfWire: (sheetPath, wireIndex) => wireIndexMap.get(`${sheetPath}|${wireIndex}`),
    netAt
  }
}

/** Connectivity for one standalone sheet (no hierarchy context). */
export const buildSheetConnectivity = (schematic: KicadSchematic): SchematicConnectivity =>
  buildConnectivity([{ sheetPath: '/', namePath: '/', schematic }])
