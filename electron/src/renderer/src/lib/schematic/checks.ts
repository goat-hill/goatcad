// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Electrical rule checks over a built connectivity graph.
 *
 * KiCad 10's ERC, rule by rule, in our own code (`docs/design-health-workstream.md`
 * holds which rules run and which are left). They feed the health pill, and
 * every agent write reports what it broke in the same turn
 * (`docs/agent-api.md`).
 *
 * Results are **stable across calls**: same input, same list, same order. That
 * is what lets a write diff two runs and report only what it changed.
 */
import type {
  NetPin,
  SchematicConnectivity,
  SchematicNet,
  SheetConnectivityInput
} from './connectivity'
import { placedPinPosition, shownTextOn } from './connectivity'
import {
  definitionIdOf,
  flattenLibSymbolChain,
  getSymbolProperty,
  libSymbolChain,
  parseLibSymbol,
  pinText,
  placedPinUuid,
  referenceForSheetPath,
  sheetPinUuid,
  resolveSymbolGeometry,
  type KicadLabel,
  type KicadLibSymbol,
  type Point,
  type SymbolGraphic,
  type SchematicProperty,
  type SymbolPin
} from '../kicad/schematic'
import { nm, type Nm } from '../kicad/coordinates'
import { KICAD10_PIN_MAP } from '../kicad/projectDefaults'
import { CONNECTION_KICAD_KEYS, CONNECTION_RULES, connectionChecks } from './connectionChecks'
import { PART_KICAD_KEYS, PART_RULES, partChecks } from './partChecks'
import { NAMING_KICAD_KEYS, NAMING_RULES, namingChecks } from './namingChecks'
import { LIBRARY_KICAD_KEYS, LIBRARY_RULES, libraryChecks } from './libraryChecks'
import type { ErcContext } from './ercContext'
import { asMm, CONNECTION_GRID } from './schematicAgent'
import { wireId } from './schematicItems'

export type CheckSeverity = 'error' | 'warning'

export interface CheckMeasure {
  actual: number
  limit: number
  bound: 'min' | 'max'
  /** Millimeters, degrees, a count, or picoseconds (a delay rule). */
  unit: 'mm' | 'deg' | 'count' | 'ps'
  /** The rule that set the limit, as a report names it (`netclass 'Power'`). */
  rule?: string
}

export interface CheckResult {
  /** Stable identifier for the rule. Named, not numbered, because the reader
   *  is a model and `unconnected-pin` needs no lookup table. */
  code: string
  severity: CheckSeverity
  message: string
  /** What the finding is about: pin ids (`U1.VDD`) or net names. */
  items: string[]
  /** Millimetres in sheet space, when the finding has a place. */
  position?: { x: number; y: number }
  /** The sheet instance `position` is on (`/<root-uuid>/…`), for a schematic finding. */
  sheetPath?: string
  /** Uuids of the items to select on that sheet: stable where `items` are readable. */
  targets?: string[]
  /** Design names only, no prose (a pin id, a net, a lib id): what a list row shows. */
  subject?: string
  /**
   * The numbers it turns on, for a person's list row: what was measured, the
   * limit it breaks, whether that is a floor or a ceiling, and the rule that set it.
   */
  measure?: CheckMeasure
  /** What a row shows beside the subject where there are no numbers: the nets a short joins, pins' types. */
  detail?: string
  /** The copper layer a board finding is on, where KiCad reports one per layer. */
  layer?: string
  /** KiCad's ids of the items it is about (a pin's, a pad's own), for matching KiCad's exclusions. */
  kicadIds?: string[]
  /** A KiCad exclusion in the project names it (`lib/kicadExclusions.ts`): shown, never counted. */
  excluded?: { comment: string; /** The exclusion's string, its identity. */ exclusion: string }
  /**
   * The severity the rule that decided it sets (`(severity …)` in a custom
   * rule, a tuning profile's), which outranks the project's for its check
   * (`applySeverities`). Absent where the rule sets none.
   */
  ruleSeverity?: 'error' | 'warning' | 'ignore' | 'exclusion'
}

/**
 * Pin types in the order a project's `erc.pin_map` indexes them; the map's
 * cells are 0 (fine), 1 (warning) and 2 (error) for a pair sharing a net.
 */
export const PIN_MAP_TYPES = [
  'input',
  'output',
  'bidirectional',
  'tri_state',
  'passive',
  'free',
  'unspecified',
  'power_in',
  'power_out',
  'open_collector',
  'open_emitter',
  'no_connect'
] as const

export type PinMap = readonly (readonly number[])[]

/** Pins that need a driver on their net. */
const DRIVEN = new Set(['input', 'power_in'])
/** What drives a net with no power input on it. */
const DRIVERS = new Set(['output', 'power_out', 'passive', 'tri_state', 'bidirectional'])

const pinId = (reference: string, number: string): string => `${reference}.${number}`

/** Ordering that does not depend on how the graph happened to be walked. */
const byCodeThenItems = (a: CheckResult, b: CheckResult): number =>
  a.code.localeCompare(b.code) || a.items.join(',').localeCompare(b.items.join(','))

/** The symbols among `pins` on the first one's sheet: what a reveal can select there. */
const sheetTargets = (pins: NetPin[]): string[] => [
  ...new Set(
    pins
      .filter((entry) => entry.sheetPath === pins[0].sheetPath && entry.symbol.uuid)
      .map((entry) => entry.symbol.uuid as string)
  )
]

/** The pins' own KiCad ids, as KiCad's markers name them. */
const pinIds = (pins: NetPin[]): string[] =>
  pins.flatMap((entry) => placedPinUuid(entry.symbol, entry.pin.number) ?? [])

/** Where a pin conflict or an undriven net is reported: its first pin, and the symbols to select. */
const netFinding = (
  net: SchematicNet,
  pins: NetPin[]
): Pick<CheckResult, 'items' | 'position' | 'sheetPath' | 'targets' | 'kicadIds' | 'subject'> => ({
  items: [...new Set(pins.map((entry) => pinId(entry.reference, entry.pin.number)))].sort(),
  position: { x: asMm(pins[0].position.x), y: asMm(pins[0].position.y) },
  sheetPath: pins[0].sheetPath,
  targets: sheetTargets(pins),
  kicadIds: pinIds(pins),
  subject: net.name
})

/**
 * Pins whose types should not share a net, graded by the project's pin map:
 * one finding per net and grade, naming every pin in such a pair. Stacked
 * pins — one symbol's pins of one name and type at one place — are one pin.
 */
const pinConflicts = (net: SchematicNet, pinMap: PinMap): CheckResult[] => {
  const typeIndex = (type: string): number => PIN_MAP_TYPES.indexOf(type as never)
  const byType = new Map<number, NetPin[]>()
  for (const entry of net.pins) {
    const index = typeIndex(entry.pin.electricalType)
    if (index < 0) continue
    const list = byType.get(index) ?? []
    list.push(entry)
    byType.set(index, list)
  }
  const stackKey = (entry: NetPin): string =>
    `${entry.sheetPath}|${entry.symbol.uuid ?? entry.reference}|${entry.position.x},${entry.position.y}|${pinText(entry.pin.name)}`
  const graded = new Map<number, Set<NetPin>>()
  const types = [...byType.keys()].sort((a, b) => a - b)
  for (const [i, a] of types.entries()) {
    for (const b of types.slice(i)) {
      const grade = Math.max(pinMap[a]?.[b] ?? 0, pinMap[b]?.[a] ?? 0)
      if (!grade) continue
      const pins = a === b ? byType.get(a)! : [...byType.get(a)!, ...byType.get(b)!]
      // Two pins of one type conflict only when they are not one stack.
      if (a === b && new Set(pins.map(stackKey)).size < 2) continue
      const set = graded.get(grade) ?? new Set()
      for (const entry of pins) set.add(entry)
      graded.set(grade, set)
    }
  }
  return [...graded].map(([grade, set]): CheckResult => {
    const pins = [...set]
    const finding = netFinding(net, pins)
    const kinds = [...new Set(pins.map((entry) => entry.pin.electricalType))].sort()
    return {
      code: 'pin-conflict',
      severity: grade >= 2 ? 'error' : 'warning',
      message: `Pins of type ${kinds.join(', ')} share ${net.name}: ${finding.items.join(', ')}. The project's pin conflict map says they should not; fix the pin types or the wiring.`,
      detail: kinds.join(' · '),
      ...finding
    }
  })
}

/**
 * A net whose inputs nothing drives. A net with a power input on it is a
 * rail, and only a power output drives a rail — a regulator's output, or the
 * PWR_FLAG put there to say so; a power symbol is itself a power input. Any
 * other net takes an output, passive, tri-state or bidirectional pin. A
 * no-connect anywhere on the net excuses it.
 */
const undrivenNet = (net: SchematicNet): CheckResult | null => {
  if (net.hasNoConnect) return null
  const types = new Set(net.pins.map((entry) => entry.pin.electricalType))
  const rail = types.has('power_in')
  const driven = rail ? types.has('power_out') : [...types].some((type) => DRIVERS.has(type))
  if (driven) return null
  const sinks = net.pins.filter((entry) =>
    rail ? entry.pin.electricalType === 'power_in' : DRIVEN.has(entry.pin.electricalType)
  )
  if (!sinks.length) return null
  const finding = netFinding(net, sinks)
  return rail
    ? {
        code: 'power-input-undriven',
        severity: 'error',
        // Lead with the action. The wording that opened "a power input wants a
        // power output pin" read as "this pin is the wrong type", and an agent
        // acting on that first clause deleted the symbol instead of adding a flag.
        message: `${net.name} feeds power pins but nothing drives it. Add a PWR_FLAG (power:PWR_FLAG) wired to any pin of ${net.name}, or wire the output pin of whatever supplies it into the net. A power symbol is an input like the pins it feeds, so adding or removing one changes nothing here.`,
        ...finding
      }
    : {
        code: 'input-undriven',
        severity: 'error',
        message: `Nothing drives ${net.name}, which feeds input pins ${finding.items.join(', ')}. Wire an output (or a pull resistor) into it, or mark it no-connect if it is left open on purpose.`,
        ...finding
      }
}

/**
 * The pins nobody connected, and the wire ends that go nowhere. A reused
 * sheet's pin is one item in every instance, so it is reported once, on the
 * first, as KiCad does — wiring it there wires it everywhere.
 */
export const unconnectedChecks = (connectivity: SchematicConnectivity): CheckResult[] => {
  const seen = new Set<string>()
  return connectivity.dangling
    .filter((end) => {
      const item = end.kind === 'pin' ? end.pinUuid : end.wireUuid
      if (!item) return true
      // A wire has two ends; each is its own finding.
      const id = `${item}|${end.position.x},${end.position.y}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    .map((end): CheckResult => {
      const position = { x: asMm(end.position.x), y: asMm(end.position.y) }
      const pin = pinId(end.reference ?? '?', end.pinNumber ?? '?')
      return end.kind === 'pin'
        ? {
            code: 'unconnected-pin',
            severity: 'error',
            message: `${pin} is connected to nothing. Either it is work remaining, or it is a mistake; nothing else it can be.`,
            items: [pin],
            position,
            sheetPath: end.sheetPath,
            targets: end.symbolUuid ? [end.symbolUuid] : [],
            kicadIds: end.pinUuid ? [end.pinUuid] : [],
            subject: pin
          }
        : {
            code: 'unconnected-wire-end',
            severity: 'warning',
            message:
              'A wire ends in open space. It carries no signal and is usually a drag that missed.',
            // The wire's own id, as items_get and items_delete take it.
            items: end.wire && end.wireIndex !== undefined ? [wireId(end.wire, end.wireIndex)] : [],
            position,
            sheetPath: end.sheetPath,
            targets: end.wireUuid ? [end.wireUuid] : [],
            kicadIds: end.wireUuid ? [end.wireUuid] : [],
            // A person reads a wire end by where it is, not by its id.
            subject: `(${position.x}, ${position.y})`
          }
    })
    .sort(byCodeThenItems)
}

/** The rules that need the whole net, not just an endpoint. */
export const electricalChecks = (
  connectivity: SchematicConnectivity,
  pinMap: PinMap = KICAD10_PIN_MAP
): CheckResult[] => {
  const results: CheckResult[] = []
  for (const net of connectivity.nets) {
    results.push(...pinConflicts(net, pinMap))
    const undriven = undrivenNet(net)
    if (undriven) results.push(undriven)
  }
  return results.sort(byCodeThenItems)
}

const offGrid = (point: Point, grid: Nm): boolean => point.x % grid !== 0 || point.y % grid !== 0

/**
 * Wires, buses, bus entries and pins off the connection grid, as KiCad's ERC
 * finds them. A warning: a sheet drawn on another grid is legal, but a wire
 * drawn on this one cannot meet an end that is off it. One finding per item —
 * a wire or bus at its first off-grid end, a symbol at its first off-grid pin
 * (a no-connect pin is never wired, so it is not checked) — and one per file,
 * not per instance of a reused sheet.
 */
export const gridChecks = (
  sheets: SheetConnectivityInput[],
  grid: Nm = CONNECTION_GRID
): CheckResult[] => {
  const results: CheckResult[] = []
  const seen = new Set<object>()
  const finding = (
    sheetPath: string,
    position: Point,
    item: string,
    select: string | undefined,
    id: string | undefined,
    subject?: string
  ): CheckResult => ({
    code: 'off-grid',
    severity: 'warning',
    message: `${item} at (${asMm(position.x)}, ${asMm(position.y)}) is off the ${asMm(grid)} mm connection grid, so a wire or pin drawn on the grid cannot meet it. Move it by whole grid steps.`,
    items: [item],
    position: { x: asMm(position.x), y: asMm(position.y) },
    sheetPath,
    targets: select ? [select] : [],
    kicadIds: id ? [id] : [],
    ...(subject ? { subject } : {})
  })
  for (const { sheetPath, schematic } of sheets) {
    if (seen.has(schematic)) continue
    seen.add(schematic)
    for (const [kind, lines] of [
      ['wire', schematic.wires],
      ['bus', schematic.buses]
    ] as const) {
      for (const line of lines) {
        const ends = [line.points[0], line.points[line.points.length - 1]]
        const off = ends.find((end) => end && offGrid(end, grid))
        if (off) {
          results.push(
            finding(sheetPath, off, `${kind}@${asMm(off.x)},${asMm(off.y)}`, line.uuid, line.uuid)
          )
        }
      }
    }
    for (const entry of schematic.busEntries) {
      const ends = [
        entry.position,
        { x: nm(entry.position.x + entry.size.width), y: nm(entry.position.y + entry.size.height) }
      ]
      for (const end of ends.filter((point) => offGrid(point, grid))) {
        results.push(
          finding(sheetPath, end, `bus_entry@${asMm(end.x)},${asMm(end.y)}`, entry.uuid, entry.uuid)
        )
      }
    }
    for (const symbol of schematic.symbols) {
      const reference = referenceForSheetPath(symbol, sheetPath)
      if (!reference) continue
      for (const { pin } of resolveSymbolGeometry(schematic, symbol).pins) {
        if (pin.electricalType === 'no_connect') continue
        const position = placedPinPosition(symbol, pin)
        if (!offGrid(position, grid)) continue
        const id = pinId(reference, pin.number)
        results.push(
          finding(sheetPath, position, id, symbol.uuid, placedPinUuid(symbol, pin.number), id)
        )
        break
      }
    }
  }
  return results.sort(byCodeThenItems)
}

/** Everything applicable, which is what `schematic.check` answers with. */
/**
 * Both halves of a hierarchical boundary, which KiCad's own ERC reports and
 * this surface must too: a sheet pin on the parent and a hierarchical label of
 * the same name inside the child are ONE connection, and either alone is a net
 * that silently does not join. Unlike a collision, a mismatch here has a
 * netlist consequence — the design is wrong, not untidy.
 *
 * Rules over the sheet tree and the label lists; nothing is re-parsed. A child
 * whose file is missing or unreadable is not this rule's business: it never
 * reaches `sheets`, and reporting every one of its pins would bury the case
 * where the file is there and a name is wrong.
 */
export const hierarchyChecks = (
  sheets: SheetConnectivityInput[],
  textVariables?: Readonly<Record<string, string>>
): CheckResult[] => {
  const indexOf = new Map(sheets.map((sheet, index) => [sheet.sheetPath, index]))
  // Names as each child instance shows them: a reused sheet may name its
  // labels per instance (`${#}`, `${field}`, `@{…}`).
  const shown = shownTextOn(sheets, textVariables)
  const results: CheckResult[] = []
  const seen = new Set<string>()
  for (const parent of sheets) {
    for (const node of parent.schematic.sheets) {
      const childPath = `${parent.sheetPath}/${node.uuid ?? ''}`
      const childIndex = indexOf.get(childPath)
      if (childIndex === undefined) continue
      const child = sheets[childIndex]
      const pins = new Map(node.pins.map((pin) => [shown(childIndex, pin.name), pin]))
      const labels = new Map<string, KicadLabel>()
      for (const label of child.schematic.labels) {
        if (label.type === 'hierarchical_label') labels.set(shown(childIndex, label.text), label)
      }
      const sheetItemId = node.uuid ?? `sheet@${asMm(node.position.x)},${asMm(node.position.y)}`
      for (const [name, pin] of pins) {
        if (labels.has(name)) continue
        const id = sheetPinUuid(pin)
        if (!once(seen, `pin|${id ?? sheetItemId}|${name}`)) continue
        results.push({
          code: 'sheet-pin-unmatched',
          severity: 'error',
          message: `The sheet pin ${name} has no hierarchical label of that name in ${child.namePath}. Nothing inside the block is connected to it. Add one with items_create on that sheet (kind label, labelKind hierarchical), or rename the pin.`,
          items: [`${sheetItemId}#${name}`],
          position: { x: asMm(pin.position.x), y: asMm(pin.position.y) },
          sheetPath: parent.sheetPath,
          targets: node.uuid ? [node.uuid] : [],
          kicadIds: [id].filter((value): value is string => !!value),
          subject: name
        })
      }
      for (const [name, label] of labels) {
        if (pins.has(name)) continue
        if (!once(seen, `label|${label.uuid ?? childPath}|${name}`)) continue
        results.push({
          code: 'hierarchical-label-unmatched',
          severity: 'error',
          message: `The hierarchical label ${name} in ${child.namePath} has no sheet pin to carry it out of the block. Add one with items_create (kind sheet_pin, ofSheet ${sheetItemId}), or make it a local label if it does not leave.`,
          items: [label.uuid ?? `label@${asMm(label.position.x)},${asMm(label.position.y)}`],
          position: { x: asMm(label.position.x), y: asMm(label.position.y) },
          sheetPath: childPath,
          targets: label.uuid ? [label.uuid] : [],
          kicadIds: label.uuid ? [label.uuid] : [],
          subject: name
        })
      }
    }
  }
  return results
}

/** True the first time `key` is seen. */
const once = (seen: Set<string>, key: string): boolean => {
  if (seen.has(key)) return false
  seen.add(key)
  return true
}

// --- Library symbol mismatch --------------------------------------------------

/**
 * The library's current definition of a lib id, flattened (no `extends`), or
 * undefined when no library the project can see has it. What the editor
 * builds from its parsed library tiers; a library it has not parsed answers
 * undefined and the symbol is simply not compared.
 */
export type LibrarySymbolLookup = (libId: string) => KicadLibSymbol | undefined

/**
 * A definition with its `extends` chain folded in, resolved through `lookup`
 * for the parents. A definition with no parent is returned as it is: the
 * flatten clones the node, and most definitions — every embedded one KiCad or
 * this app wrote — are already flat.
 */
export const flattenedLibSymbol = (
  definition: KicadLibSymbol,
  lookup: (name: string) => KicadLibSymbol | undefined
): KicadLibSymbol => {
  const chain = libSymbolChain(definition, lookup)
  return chain.length === 1 ? definition : parseLibSymbol(flattenLibSymbolChain(chain))
}

/**
 * Every pin by unit, body style and number: a multi-unit part may reuse a
 * number across units, and those are different pins.
 */
const pinsByKey = (definition: KicadLibSymbol): Map<string, SymbolPin> => {
  const pins = new Map<string, SymbolPin>()
  for (const pin of definition.pins) pins.set(`0/0/${pinText(pin.number)}`, pin)
  for (const variant of definition.variants) {
    for (const pin of variant.pins) {
      pins.set(`${variant.unit}/${variant.style}/${pinText(pin.number)}`, pin)
    }
  }
  return pins
}

/** Where a pin's connection point sits: what a wire lands on. */
const pinPlace = (pin: SymbolPin): string => `${pin.position.x},${pin.position.y}`

/**
 * A body shape as geometry, stroke and fill; colors and text are not compared.
 * An arc is its circle and sweep, so the same arc written end to start is equal.
 */
const shapeKey = (graphic: SymbolGraphic): string | null => {
  if (!('stroke' in graphic)) return null
  const common = [
    graphic.type,
    graphic.stroke.width,
    graphic.stroke.type ?? 'default',
    graphic.fill
  ]
  switch (graphic.type) {
    case 'arc': {
      const ends = [graphic.start, graphic.end].sort((a, b) => a.x - b.x || a.y - b.y)
      return JSON.stringify([...common, ends, graphic.mid])
    }
    case 'circle':
      return JSON.stringify([...common, graphic.center, graphic.radius])
    case 'rectangle':
      return JSON.stringify([...common, graphic.start, graphic.end])
    case 'line':
    case 'bezier':
      return JSON.stringify([...common, graphic.points])
    default:
      return null
  }
}

/** Shapes per unit and style, as a sorted multiset: order in the file is not a change. */
const shapesOf = (definition: KicadLibSymbol): string[] => {
  const keys: string[] = []
  const add = (unit: number, style: number, graphics: SymbolGraphic[]): void => {
    for (const graphic of graphics) {
      const key = shapeKey(graphic)
      if (key) keys.push(`${unit}/${style} ${key}`)
    }
  }
  add(0, 0, definition.graphics)
  for (const variant of definition.variants) add(variant.unit, variant.style, variant.graphics)
  return keys.sort()
}

/** Every symbol has these, empty when its file leaves one out. */
const MANDATORY_FIELDS = ['Reference', 'Value', 'Footprint', 'Datasheet', 'Description']

/**
 * Older files spell the description `ki_description`. A `~` is literal: files
 * from before 20250318, where it meant empty, are migrated before they are read.
 */
const fieldsOf = (definition: KicadLibSymbol): Map<string, string> =>
  new Map([
    ...MANDATORY_FIELDS.map((key): [string, string] => [key, '']),
    ...definition.properties.map((property): [string, string] => [
      property.key === 'ki_description' ? 'Description' : property.key,
      property.key === 'ki_fp_filters'
        ? property.value.trim().split(/\s+/).join(' ')
        : property.value
    ])
  ])

const unitCount = (definition: KicadLibSymbol): number =>
  new Set(definition.variants.map((variant) => variant.unit).filter((unit) => unit > 0)).size

export interface LibSymbolDifference {
  /** `pins` changes what the netlist can carry; `drawing` and `fields` do not. */
  kind: 'pins' | 'drawing' | 'fields'
  detail: string
}

/**
 * How a sheet's embedded copy differs from the library's definition, or null
 * when it does not: KiCad's "doesn't match copy in library". Pins first — one
 * added or removed changes what the netlist can carry, one moved changes what
 * a wire lands on — then the body's shapes, then the fields' text. As in
 * KiCad, a pin is its unit, number and place: its name, type, length and
 * visibility are not compared, nor are show / hide options or field positions.
 */
export const compareLibSymbols = (
  embedded: KicadLibSymbol,
  library: KicadLibSymbol
): LibSymbolDifference | null => {
  const before = pinsByKey(embedded)
  const after = pinsByKey(library)
  const numberOf = (key: string): string => key.slice(key.lastIndexOf('/') + 1)
  const added = [...after.keys()]
    .filter((key) => !before.has(key))
    .map(numberOf)
    .sort()
  const removed = [...before.keys()]
    .filter((key) => !after.has(key))
    .map(numberOf)
    .sort()
  if (added.length || removed.length) {
    const parts: string[] = []
    if (added.length) parts.push(`added ${added.join(', ')}`)
    if (removed.length) parts.push(`removed ${removed.join(', ')}`)
    return { kind: 'pins', detail: `pins differ: ${parts.join('; ')}` }
  }
  const moved = [...after]
    .filter(([key, pin]) => pinPlace(before.get(key)!) !== pinPlace(pin))
    .map(([key]) => numberOf(key))
    .sort()
  if (moved.length) {
    return { kind: 'drawing', detail: `pins ${moved.join(', ')} moved` }
  }
  if (
    JSON.stringify(shapesOf(embedded)) !== JSON.stringify(shapesOf(library)) ||
    embedded.pinNameOffset !== library.pinNameOffset ||
    embedded.isPower !== library.isPower ||
    embedded.unitsLocked !== library.unitsLocked ||
    unitCount(embedded) !== unitCount(library)
  ) {
    return { kind: 'drawing', detail: 'the body is drawn differently' }
  }
  const was = fieldsOf(embedded)
  const is = fieldsOf(library)
  const fields = [...new Set([...was.keys(), ...is.keys()])]
    .filter((key) => was.get(key) !== is.get(key))
    .sort()
  if (fields.length) return { kind: 'fields', detail: `fields ${fields.join(', ')} differ` }
  return null
}

/**
 * Whether a copy still matches its library, for the properties panel's
 * library status: `compareLibSymbols`, then what that check leaves out on
 * purpose (KiCad's ERC compares no pin names, types, lengths or visibility, no
 * pin-text display and no field placement), so an edited copy never reads as
 * matching. Not a check; the mismatch rule stays KiCad's.
 */
export const libSymbolMatches = (embedded: KicadLibSymbol, library: KicadLibSymbol): boolean => {
  if (compareLibSymbols(embedded, library)) return false
  const pin = (p: SymbolPin): string =>
    JSON.stringify([
      pinText(p.name),
      p.electricalType,
      p.graphicStyle,
      p.length,
      p.hidden,
      p.position.angle
    ])
  const own = pinsByKey(embedded)
  for (const [key, theirs] of pinsByKey(library)) {
    const mine = own.get(key)
    if (mine && pin(mine) !== pin(theirs)) return false
  }
  const look = (s: KicadLibSymbol): string =>
    JSON.stringify([
      s.pinNamesHidden,
      s.pinNumbersHidden,
      s.inBom,
      s.onBoard,
      s.excludeFromSim,
      s.inPosFiles
    ])
  if (look(embedded) !== look(library)) return false
  const field = (p: SchematicProperty): string => JSON.stringify([p.position, p.hidden, p.effects])
  const theirs = new Map(library.properties.map((p) => [p.key, field(p)]))
  return embedded.properties.every((p) => !theirs.has(p.key) || theirs.get(p.key) === field(p))
}

/**
 * KiCad's "library symbol mismatch" ERC rule: a placed symbol is a copy, a
 * library edit never rewrites a design, and this is what tells the reader
 * the copy is behind. An error when the pin set differs, because a pin the
 * sheet's copy does not have is a pin no wire can reach — the fifth run's
 * regenerated codec had an exposed pad that never entered the netlist for
 * exactly this reason. A warning when only the drawing or the fields
 * differ. One finding per lib id per sheet, naming every instance.
 * The remedy is the conservative one: remove and re-place, so every pin is
 * wired on purpose and the check delta names anything missed.
 */
export const librarySymbolChecks = (
  sheets: SheetConnectivityInput[],
  lookup: LibrarySymbolLookup
): CheckResult[] => {
  const results: CheckResult[] = []
  for (const { sheetPath, schematic } of sheets) {
    // By the copy each symbol uses: a `lib_name` names a copy kept apart from the lib id's.
    const byCopy = new Map<
      string,
      { libId: string; references: string[]; uuids: string[]; position: { x: number; y: number } }
    >()
    for (const symbol of schematic.symbols) {
      const reference =
        referenceForSheetPath(symbol, sheetPath) ?? getSymbolProperty(symbol, 'Reference') ?? '?'
      const copy = definitionIdOf(symbol)
      const group = byCopy.get(copy) ?? {
        libId: symbol.libId,
        references: [],
        uuids: [],
        position: { x: asMm(symbol.position.x), y: asMm(symbol.position.y) }
      }
      group.references.push(reference)
      if (symbol.uuid) group.uuids.push(symbol.uuid)
      byCopy.set(copy, group)
    }
    for (const [copy, group] of byCopy) {
      const { libId } = group
      const library = lookup(libId)
      const cached = schematic.libSymbols.get(copy)
      if (!library || !cached) continue
      const embedded = flattenedLibSymbol(cached, (name) => schematic.libSymbols.get(name))
      const difference = compareLibSymbols(embedded, library)
      if (!difference) continue
      const items = [...new Set(group.references)].sort()
      results.push({
        code: 'symbol-library-mismatch',
        severity: difference.kind === 'pins' ? 'error' : 'warning',
        message: `The copy of ${libId} on this sheet is behind its library: ${difference.detail}. A library edit never rewrites a design, so ${items.join(', ')} still ${items.length === 1 ? 'uses' : 'use'} the old copy. Remove every instance (items_delete) and place the symbol again; the fresh definition is embedded once the last old one is gone. Read each instance's fields with items_get first and pass them back on schematic_place_symbol.`,
        items,
        position: group.position,
        sheetPath,
        targets: group.uuids,
        kicadIds: group.uuids,
        subject: libId
      })
    }
  }
  return results.sort(byCodeThenItems)
}

const NO_LIBRARIES: LibrarySymbolLookup = () => undefined

/**
 * The checks that read only the sheets and their nets: plain data in, plain
 * data out, so the check worker can run them (`worker/checkWorkerEngine.ts`).
 * Unsorted; `allChecks` and the session sort the whole set.
 */
export const sheetChecks = (
  connectivity: SchematicConnectivity,
  sheets: SheetConnectivityInput[],
  connectionGrid: Nm = CONNECTION_GRID,
  pinMap: PinMap = KICAD10_PIN_MAP,
  context: Pick<ErcContext, 'netclasses' | 'textVariables'> = {}
): CheckResult[] => [
  ...unconnectedChecks(connectivity),
  ...electricalChecks(connectivity, pinMap),
  ...hierarchyChecks(sheets, context.textVariables),
  ...gridChecks(sheets, connectionGrid),
  ...connectionChecks(connectivity, sheets),
  ...partChecks(connectivity, sheets),
  ...namingChecks(connectivity, sheets, context)
]

/** The checks that read the symbol libraries, which only the page holds. Unsorted. */
export const libraryBoundChecks = (
  sheets: SheetConnectivityInput[],
  libraries: LibrarySymbolLookup = NO_LIBRARIES,
  context: ErcContext = {}
): CheckResult[] => [
  ...librarySymbolChecks(sheets, libraries),
  ...libraryChecks(sheets, libraries, context)
]

/** Put a set of findings in the order every answer lists them. */
export const sortChecks = (results: CheckResult[]): CheckResult[] => results.sort(byCodeThenItems)

export const allChecks = (
  connectivity: SchematicConnectivity,
  sheets: SheetConnectivityInput[] = [],
  libraries: LibrarySymbolLookup = NO_LIBRARIES,
  connectionGrid: Nm = CONNECTION_GRID,
  pinMap: PinMap = KICAD10_PIN_MAP,
  context: ErcContext = {}
): CheckResult[] =>
  sortChecks([
    ...sheetChecks(connectivity, sheets, connectionGrid, pinMap, context),
    ...libraryBoundChecks(sheets, libraries, context)
  ])

/** A result's identity, for diffing two runs. Position is left out on purpose:
 *  moving a symbol does not resolve and re-raise the same finding. */
const identity = (result: CheckResult): string => `${result.code}|${result.items.join(',')}`

export interface CheckDelta {
  new: CheckResult[]
  resolved: CheckResult[]
}

/**
 * What a write broke and what it fixed.
 *
 * An agent reads its own success or failure in the turn it acted, rather than
 * remembering to look.
 */
export const checkDelta = (before: CheckResult[], after: CheckResult[]): CheckDelta => {
  const had = new Set(before.map(identity))
  const has = new Set(after.map(identity))
  return {
    new: after.filter((result) => !had.has(identity(result))),
    resolved: before.filter((result) => !has.has(identity(result)))
  }
}

// --- Shapes an agent reads ----------------------------------------------------

/** One sentence per rule, so a grouped answer can say what a code means once
 *  rather than once per finding. */
export const CHECK_RULES: Record<string, string> = {
  ...CONNECTION_RULES,
  ...PART_RULES,
  ...NAMING_RULES,
  ...LIBRARY_RULES,
  'unconnected-pin':
    'Connected to nothing: work remaining, or a mistake. A pin left open on purpose takes a no-connect flag (items_create) and stops being reported.',
  'unconnected-wire-end': 'A wire ends in open space; usually a drag that missed.',
  'off-grid':
    'A wire end or pin is off the 1.27 mm connection grid, so nothing drawn on the grid can meet it. A sheet placed at an off-grid origin puts every pin on its edge off grid; move it by whole grid steps.',
  'pin-conflict':
    "Pins whose types should not share a net do: two outputs fighting, an unspecified pin, a no-connect pin wired in. Graded by the project's pin conflict map.",
  'input-undriven':
    'Input pins on a net that nothing drives. Wire in an output, a passive (a pull resistor) or a bidirectional pin, or mark the net no-connect if it is open on purpose.',
  'sheet-pin-unmatched':
    "A block's boundary pin names a signal the block itself never declares, so nothing inside is joined to it. The pin and a hierarchical label of the same name inside the child sheet are one connection; either alone connects nothing.",
  'hierarchical-label-unmatched':
    "A signal inside a block is marked as leaving it, but the block's box has no pin to carry it. Same connection as above, missing the other half.",
  'symbol-library-mismatch':
    "A sheet's copy of a symbol is behind its library. A library edit never rewrites a design, as in KiCad. An error when the pins differ, since a pin the copy lacks is one no wire can reach; a warning when only the drawing or the fields do. Remove every instance and place the symbol again, passing its fields back.",
  'power-input-undriven':
    'A rail feeds power pins but nothing drives it. Add a PWR_FLAG (power:PWR_FLAG) wired to any pin of the rail, or wire in the output pin of whatever supplies it — a regulator output. A power symbol such as +3V3 or GND is itself an input and does not count, as in KiCad, so adding or removing one does not resolve this.'
}

/** Each rule's KiCad violation key (`erc_item.cpp`), as a project's `erc.rule_severities` names it. */
export const ERC_KICAD_KEYS: Record<string, string> = {
  ...CONNECTION_KICAD_KEYS,
  ...PART_KICAD_KEYS,
  ...NAMING_KICAD_KEYS,
  ...LIBRARY_KICAD_KEYS,
  'unconnected-pin': 'pin_not_connected',
  'unconnected-wire-end': 'unconnected_wire_endpoint',
  'off-grid': 'endpoint_off_grid',
  'pin-conflict': 'pin_to_pin',
  'input-undriven': 'pin_not_driven',
  'sheet-pin-unmatched': 'hier_label_mismatch',
  'hierarchical-label-unmatched': 'hier_label_mismatch',
  'symbol-library-mismatch': 'lib_symbol_mismatch',
  'power-input-undriven': 'power_pin_not_driven'
}

export interface CheckGroup {
  code: string
  severity: CheckSeverity
  count: number
  /** Every finding's items, flattened and sorted: pin ids or net names. */
  items: string[]
  /** What the code means, from `CHECK_RULES`. */
  rule: string
  /** Each finding on its own, up to the cap `groupChecks` was given. */
  findings?: CheckFinding[]
  /** More findings than `findings` holds. */
  truncated?: true
}

/**
 * One finding as an agent reads it: the items it is between, where, on which
 * layer, and the numbers it turns on. A board's (`board.check`), where a
 * finding's place and measure are what an agent fixes it from.
 */
export interface CheckFinding {
  /** Ids as the document's items op takes them. */
  items: string[]
  /** The document's millimeters, y down. */
  at?: { x: number; y: number }
  layer?: string
  /** What was measured, the limit it breaks, floor or ceiling, and the rule that set it. */
  measure?: CheckMeasure
  /** The facts beside the items where there are no numbers: the nets a short joins. */
  detail?: string
}

const round4 = (value: number): number => Math.round(value * 1e4) / 1e4

export const findingOf = (result: CheckResult): CheckFinding => ({
  items: result.items,
  ...(result.position ? { at: result.position } : {}),
  ...(result.layer ? { layer: result.layer } : {}),
  ...(result.measure
    ? {
        measure: {
          ...result.measure,
          actual: round4(result.measure.actual),
          limit: round4(result.measure.limit)
        }
      }
    : {}),
  ...(result.detail ? { detail: result.detail } : {})
})

/** Findings each rule's row lists in a board check without `codes` before it says `truncated`; with `codes`, every one. */
export const FINDINGS_PER_RULE = 20

/** A `*.check` request's `codes` named a code no rule of that document has. */
export interface UnknownCheckCode {
  error: 'unknown-check-code'
  detail: string
  candidates: string[]
}

/**
 * The findings a `*.check` request's `codes` keeps, or the refusal when one of
 * them is no rule's: a misspelled code would otherwise read as a clean pass.
 * Candidates share a word with the miss, else are the first codes.
 */
export const checkCodeFilter = (
  codes: string[] | undefined,
  rules: Record<string, string>
): ((results: CheckResult[]) => CheckResult[]) | UnknownCheckCode => {
  if (!codes?.length) return (results) => results
  const known = Object.keys(rules).sort()
  const unknown = codes.find((code) => !(code in rules))
  if (unknown !== undefined) {
    const words = unknown
      .toLowerCase()
      .split(/[-_\s]+/)
      .filter(Boolean)
    const near = known.filter((code) => words.some((word) => code.split('-').includes(word)))
    return {
      error: 'unknown-check-code',
      detail: `No rule has the code "${unknown}".`,
      candidates: (near.length ? near : known).slice(0, 8)
    }
  }
  const wanted = new Set(codes)
  return (results) => results.filter((result) => wanted.has(result.code))
}

/** The same findings, one row per rule: fifty identical sentences say one
 *  thing, and an agent reads the items, not the prose. With `findingCap`, each
 *  row also lists its first findings on their own. */
export const groupChecks = (
  results: CheckResult[],
  rules: Record<string, string> = CHECK_RULES,
  findingCap?: number
): CheckGroup[] => {
  const groups = new Map<string, CheckGroup>()
  for (const result of results) {
    const group = groups.get(result.code) ?? {
      code: result.code,
      severity: result.severity,
      count: 0,
      items: [],
      rule: rules[result.code] ?? result.message
    }
    group.count += 1
    group.items.push(...result.items)
    if (findingCap !== undefined) {
      const findings = (group.findings ??= [])
      if (findings.length < findingCap) findings.push(findingOf(result))
      else group.truncated = true
    }
    groups.set(result.code, group)
  }
  return [...groups.values()]
    .map((group) => ({ ...group, items: [...new Set(group.items)].sort() }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

/** A row a check's `codes` asked for that found nothing: clean is a fact the caller asked for. */
type CleanCheckRow = Omit<CheckGroup, 'severity'>

/** `rows` with a count-0 row, in code order, for each of `codes` no finding raised. */
export const withAskedCodes = <Row extends { code: string }>(
  rows: readonly Row[],
  codes: readonly string[] | undefined,
  rules: Record<string, string>
): Array<Row | CleanCheckRow> => {
  const present = new Set(rows.map((row) => row.code))
  const clean = [...new Set(codes ?? [])]
    .filter((code) => !present.has(code))
    .map((code): CleanCheckRow => ({ code, count: 0, items: [], rule: rules[code] ?? '' }))
  return clean.length ? [...rows, ...clean].sort((a, b) => a.code.localeCompare(b.code)) : [...rows]
}

/** One row per rule in a write's delta: the items while there are few, a
 *  count past `DELTA_ITEMS`. */
export interface CompactCheck {
  code: string
  severity: CheckSeverity
  items?: string[]
  count?: number
  /** With findings asked for: the first `DELTA_ITEMS` on their own. */
  findings?: CheckFinding[]
  /** More findings than `findings` holds. */
  truncated?: true
}

export interface CompactDelta {
  new: CompactCheck[]
  resolved: CompactCheck[]
}

/** Items a write's delta names per rule before it says a count instead. A
 *  small delta is where the reader confirms a wire resolved the pin it meant;
 *  a large one is a many-pin part it just placed, whose pins it already has,
 *  and a `*.check` op groups every item by rule when the list is wanted. */
export const DELTA_ITEMS = 8

const compactSide = (results: CheckResult[], findings: boolean): CompactCheck[] => {
  const groups = new Map<
    string,
    { code: string; severity: CheckSeverity; items: Set<string>; found: CheckResult[] }
  >()
  for (const result of results) {
    const key = `${result.code}\u0000${result.severity}`
    let group = groups.get(key)
    if (!group) {
      group = { code: result.code, severity: result.severity, items: new Set(), found: [] }
      groups.set(key, group)
    }
    for (const item of result.items) group.items.add(item)
    group.found.push(result)
  }
  return [...groups.values()]
    .map(({ code, severity, items, found }): CompactCheck => ({
      code,
      severity,
      ...(items.size <= DELTA_ITEMS ? { items: [...items].sort() } : { count: items.size }),
      ...(findings ? { findings: found.slice(0, DELTA_ITEMS).map(findingOf) } : {}),
      ...(findings && found.length > DELTA_ITEMS ? { truncated: true as const } : {})
    }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

/** A delta as a write answers with it: one row per rule, the items when there
 *  are few and a count when there are many, and with `findings` (a board's)
 *  the first few findings on their own. The sentence per rule is in a
 *  `*.check` op. */
export const compactDelta = (delta: CheckDelta, findings = false): CompactDelta => ({
  new: compactSide(delta.new, findings),
  resolved: compactSide(delta.resolved, findings)
})

/**
 * The findings a `*.check` op answered with, by document and revision, so a later
 * run can answer with what changed since one of them (`since`): a burst of
 * writes made without checks is verified once, as one delta. The newest few per
 * document are kept.
 */
export class CheckHistory {
  private readonly runs = new Map<string, Map<number, CheckResult[]>>()

  constructor(private readonly keep = 8) {}

  remember(document: string, revision: number, results: CheckResult[]): void {
    let byRevision = this.runs.get(document)
    if (!byRevision) this.runs.set(document, (byRevision = new Map()))
    byRevision.delete(revision)
    byRevision.set(revision, results)
    while (byRevision.size > this.keep) byRevision.delete(byRevision.keys().next().value!)
  }

  at(document: string, revision: number): CheckResult[] | undefined {
    return this.runs.get(document)?.get(revision)
  }
}

/** A `since` with no run to compare against: the remedy is a baseline. */
export const noCheckBaseline = (revision: number): { error: string; detail: string } => ({
  error: 'check-baseline-not-found',
  detail: `No check of this document answered at revision ${revision}, or it is no longer remembered. Call its check (schematic_check, board_check) without since for a baseline, and pass the revision it answers with.`
})
