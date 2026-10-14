/**
 * What changed between two versions of one `.kicad_sch`, item by item — the
 * model behind the visual diff.
 *
 * Items are matched by their KiCad uuid, which survives every edit that is not
 * a delete, so a moved resistor is one moved resistor rather than a removal and
 * an addition the way a text diff reads it. Junctions and no-connects carry no
 * uuid in the model and are matched by position, so they only ever appear as
 * added or removed. A matched item is `moved` when only its geometry differs
 * and `modified` when anything else does.
 */
import { serializeSExpr, type SExprList } from '../kicad/sexpr'
import type {
  KicadLabel,
  KicadSchematic,
  KicadSchematicPoint,
  KicadSchematicSymbol,
  SchematicProperty
} from '../kicad/schematic'

export type SchematicChangeKind = 'added' | 'removed' | 'modified' | 'moved'

export type SchematicItemKind =
  'symbol' | 'wire' | 'label' | 'text' | 'shape' | 'sheet' | 'junction' | 'no_connect'

/** One changed field or value, for the change list: "Value 10k → 4k7". */
export interface FieldChange {
  name: string
  before?: string
  after?: string
}

export interface SchematicChange {
  kind: SchematicChangeKind
  item: SchematicItemKind
  /** Stable id: the uuid, or `kind@x,y` for the uuid-less points. */
  id: string
  /** What a person calls it: a reference, a label's text, a sheet's name. */
  label: string
  /** Its render key (`symbol:3`) in each version that has it. */
  beforeKey?: string
  afterKey?: string
  fields: FieldChange[]
}

export interface SchematicDiff {
  changes: SchematicChange[]
  counts: Record<SchematicChangeKind, number>
}

// Geometry tokens: every list naming where a thing is, rather than what it is.
// Each holds only atoms, so a flat pattern strips it whole.
const GEOMETRY = /\((?:at|xy|start|end|mid|center|size|mirror) [^()]*\)/g

/** An item's serialized form with its geometry removed: what it is, not where. */
const contentSignature = (node: SExprList): string => serializeSExpr(node).replace(GEOMETRY, '')

/**
 * The reference a symbol shows. KiCad 6+ writes the real one per sheet path
 * in `(instances …)`; the Reference field may still say `R?`.
 */
const symbolReference = (symbol: KicadSchematicSymbol): string => {
  const instance = symbol.instances.find((i) => i.reference && !i.reference.endsWith('?'))
  const field = symbol.properties.find((p) => p.key === 'Reference')?.value
  return instance?.reference ?? field ?? symbol.libId
}

const fieldChanges = (
  before: readonly SchematicProperty[],
  after: readonly SchematicProperty[]
): FieldChange[] => {
  const changes: FieldChange[] = []
  const was = new Map(before.map((p) => [p.key, p.value]))
  const now = new Map(after.map((p) => [p.key, p.value]))
  for (const [name, value] of now) {
    const old = was.get(name)
    if (old !== value)
      changes.push({ name, ...(old !== undefined ? { before: old } : {}), after: value })
  }
  for (const [name, value] of was) {
    if (!now.has(name)) changes.push({ name, before: value })
  }
  return changes
}

/** One side's items, keyed for matching, with what each needs for a change row. */
interface Entry {
  item: SchematicItemKind
  id: string
  /** The scene's element key for it: `symbol:3`, `schematic-text:0`. */
  key: string
  label: string
  node: SExprList
  geometry: string
  properties?: readonly SchematicProperty[]
  text?: string
}

const labelEntry = (label: KicadLabel, id: string, index: number): Entry => ({
  item: 'label',
  id,
  key: `label:${index}`,
  label: label.text,
  node: label._node,
  geometry: `${label.position.x},${label.position.y},${label.position.angle}`,
  text: label.text
})

const pointEntry = (
  kind: 'junction' | 'no_connect',
  point: KicadSchematicPoint,
  index: number
): Entry => {
  const id = `${kind}@${point.x},${point.y}`
  return {
    item: kind,
    id,
    key: `${kind}:${index}`,
    label: kind,
    node: point._node,
    geometry: `${point.x},${point.y}`
  }
}

/** Every matchable item of one side. Items with no uuid fall back to a positional id. */
export function schematicEntries(doc: KicadSchematic): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  const add = (entry: Entry): void => {
    // Two items claiming one id (a copy-paste that kept its uuid) keep the first.
    if (!entries.has(entry.id)) entries.set(entry.id, entry)
  }
  doc.symbols.forEach((symbol, i) => {
    add({
      item: 'symbol',
      id: symbol.uuid ?? `symbol#${i}`,
      key: `symbol:${i}`,
      label: symbolReference(symbol),
      node: symbol._node,
      geometry: `${symbol.position.x},${symbol.position.y},${symbol.position.angle},${symbol.mirror ?? ''}`,
      properties: symbol.properties
    })
  })
  doc.wires.forEach((wire, i) => {
    add({
      item: 'wire',
      id: wire.uuid ?? `wire#${i}`,
      key: `wire:${i}`,
      label: 'wire',
      node: wire._node,
      geometry: wire.points.map((p) => `${p.x},${p.y}`).join(' ')
    })
  })
  doc.labels.forEach((label, i) => add(labelEntry(label, label.uuid ?? `label#${i}`, i)))
  doc.texts.forEach((text, i) => {
    add({
      item: 'text',
      id: text.uuid ?? `text#${i}`,
      key: `schematic-text:${i}`,
      label: text.text,
      node: text._node,
      geometry: `${text.position.x},${text.position.y},${text.position.angle}`,
      text: text.text
    })
  })
  doc.shapes.forEach((shape, i) => {
    add({
      item: 'shape',
      id: shape.uuid ?? `shape#${i}`,
      key: `shape:${i}`,
      label: 'rectangle',
      node: shape._node,
      geometry: `${shape.start.x},${shape.start.y},${shape.end.x},${shape.end.y}`
    })
  })
  doc.sheets.forEach((sheet, i) => {
    const name = sheet.properties.find((p) => p.key === 'Sheetname' || p.key === 'Sheet name')
    add({
      item: 'sheet',
      id: sheet.uuid ?? `sheet#${i}`,
      key: `sheet:${i}`,
      label: name?.value ?? 'sheet',
      node: sheet._node,
      geometry: `${sheet.position.x},${sheet.position.y},${sheet.size.width},${sheet.size.height}`,
      properties: sheet.properties
    })
  })
  doc.junctions.forEach((j, i) => add(pointEntry('junction', j, i)))
  doc.noConnects.forEach((n, i) => add(pointEntry('no_connect', n, i)))
  return entries
}

const row = (
  kind: SchematicChangeKind,
  entry: Entry,
  fields: FieldChange[] = []
): SchematicChange => ({
  kind,
  item: entry.item,
  id: entry.id,
  label: entry.label,
  fields
})

/** Order the list reads in: what a reviewer cares about first. */
const ITEM_ORDER: Record<SchematicItemKind, number> = {
  symbol: 0,
  sheet: 1,
  label: 2,
  wire: 3,
  junction: 4,
  no_connect: 5,
  text: 6,
  shape: 7
}

/**
 * Diff two parsed versions. Either may be null (a file that did not exist on
 * that side), which makes every item of the other side added or removed.
 */
export function diffSchematics(
  before: KicadSchematic | null,
  after: KicadSchematic | null
): SchematicDiff {
  const was = before ? schematicEntries(before) : new Map<string, Entry>()
  const now = after ? schematicEntries(after) : new Map<string, Entry>()
  const changes: SchematicChange[] = []

  for (const [id, entry] of now) {
    const old = was.get(id)
    if (!old) {
      changes.push({ ...row('added', entry), afterKey: entry.key })
      continue
    }
    const contentChanged = contentSignature(old.node) !== contentSignature(entry.node)
    const moved = old.geometry !== entry.geometry
    if (!contentChanged && !moved) continue
    let fields: FieldChange[] = []
    if (entry.properties && old.properties) fields = fieldChanges(old.properties, entry.properties)
    else if (entry.text !== undefined && old.text !== entry.text) {
      fields = [{ name: 'text', before: old.text, after: entry.text }]
    }
    const change = row(contentChanged ? 'modified' : 'moved', entry, fields)
    change.beforeKey = old.key
    change.afterKey = entry.key
    changes.push(change)
  }
  for (const [id, entry] of was) {
    if (!now.has(id)) changes.push({ ...row('removed', entry), beforeKey: entry.key })
  }

  changes.sort(
    (a, b) =>
      ITEM_ORDER[a.item] - ITEM_ORDER[b.item] ||
      a.label.localeCompare(b.label, undefined, { numeric: true })
  )
  const counts: Record<SchematicChangeKind, number> = {
    added: 0,
    removed: 0,
    modified: 0,
    moved: 0
  }
  for (const change of changes) counts[change.kind]++
  return { changes, counts }
}

/** The document array each render-key prefix indexes. */
const ARRAY_OF_PREFIX = {
  symbol: 'symbols',
  wire: 'wires',
  label: 'labels',
  'schematic-text': 'texts',
  shape: 'shapes',
  sheet: 'sheets',
  junction: 'junctions',
  no_connect: 'noConnects'
} as const satisfies Record<string, keyof KicadSchematic>

type ItemArray = (typeof ARRAY_OF_PREFIX)[keyof typeof ARRAY_OF_PREFIX]

const parseKey = (key: string): { prefix: keyof typeof ARRAY_OF_PREFIX; index: number } | null => {
  const at = key.lastIndexOf(':')
  const prefix = key.slice(0, at)
  const index = Number(key.slice(at + 1))
  return prefix in ARRAY_OF_PREFIX && Number.isInteger(index)
    ? { prefix: prefix as keyof typeof ARRAY_OF_PREFIX, index }
    : null
}

/** A document with the same header as `doc` and no items. */
const emptied = (doc: KicadSchematic): KicadSchematic => ({
  ...doc,
  symbols: [],
  wires: [],
  labels: [],
  texts: [],
  shapes: [],
  sheets: [],
  junctions: [],
  noConnects: []
})

/**
 * The "after" sheet with the removed items drawn back in where they were, so
 * one picture shows both what is new and what went away. Returns the combined
 * document (render only — it is never written) and the render key each removed
 * change landed on, by change id. Removed symbols keep drawing because the before file's
 * `lib_symbols` are merged under the after file's. Pure; exported for tests.
 */
export function withRemovedItems(
  after: KicadSchematic | null,
  before: KicadSchematic | null,
  changes: readonly SchematicChange[]
): { doc: KicadSchematic | null; removedKeys: Map<string, string> } {
  const removedKeys = new Map<string, string>()
  if (!before) return { doc: after, removedKeys }
  const base = after ?? emptied(before)
  const doc: KicadSchematic = {
    ...base,
    libSymbols: new Map([...before.libSymbols, ...base.libSymbols]),
    symbols: [...base.symbols],
    wires: [...base.wires],
    labels: [...base.labels],
    texts: [...base.texts],
    shapes: [...base.shapes],
    sheets: [...base.sheets],
    junctions: [...base.junctions],
    noConnects: [...base.noConnects]
  }
  for (const change of changes) {
    if (change.kind !== 'removed' || !change.beforeKey) continue
    const ref = parseKey(change.beforeKey)
    if (!ref) continue
    const name: ItemArray = ARRAY_OF_PREFIX[ref.prefix]
    const item = before[name][ref.index]
    if (!item) continue
    const target = doc[name] as unknown[]
    removedKeys.set(change.id, `${ref.prefix}:${target.length}`)
    target.push(item)
  }
  return { doc, removedKeys }
}
