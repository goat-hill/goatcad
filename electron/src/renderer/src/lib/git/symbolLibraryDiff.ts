/**
 * The visual diff of a `.kicad_sym`: which symbols changed between two
 * versions of a library, and how one of them changed.
 *
 * Symbols pair by name. Inside a changed symbol, pins and graphics have no
 * uuid, so they pair by CONTENT — a part whose serialized node appears in both
 * versions is unchanged, one only in the new version is changed (added, moved
 * or edited), one only in the old version is removed. That makes a moved pin a
 * removal plus a change, which is what it looks like: the old place in red, the
 * new place in color. Fields pair by key and value.
 *
 * A diff draws one symbol, one unit at a time. Paint follows the schematic
 * diff: changes in their own colors, everything else dimmed, and — in the Diff
 * view only — removals drawn back in red (`SchematicDiffPaint`).
 */
import { parseSExpr, serializeSExpr, type SExprList } from '../kicad/sexpr'
import {
  addSchematicSymbolToAST,
  getLibSymbolProperty,
  libSymbolChain,
  libSymbolUnitPins,
  parseKicadSchematic,
  schematicFieldKey,
  serializeKicadSchematic,
  symbolPartKey,
  type KicadLibSymbol,
  type KicadSchematic
} from '../kicad/schematic'
import type { KicadSymbolLibrary } from '../kicad/symbolLibrary'
import {
  getOrCreateUnitNode,
  symbolPartAddresses,
  symbolPartNode,
  symbolUnitCount,
  type SymbolPartAddress
} from '../symbol/symbolEdit'
import { nm } from '../kicad/coordinates'
import { compareNames } from '../nameOrder'
import type { SchematicDiffPaint } from '../engine/SchematicScene'
import type { DiffVersion } from './diffPreferences'

export type SymbolChangeKind = 'added' | 'removed' | 'modified'

export interface SymbolChange {
  name: string
  kind: SymbolChangeKind
}

/** Which symbols changed, by name, in name order. Pure; exported for tests. */
export function diffSymbolLibraries(
  before: KicadSymbolLibrary | null,
  after: KicadSymbolLibrary | null
): SymbolChange[] {
  const was = before?.symbols ?? new Map<string, KicadLibSymbol>()
  const now = after?.symbols ?? new Map<string, KicadLibSymbol>()
  const changes: SymbolChange[] = []
  for (const [name, symbol] of now) {
    const old = was.get(name)
    if (!old) changes.push({ name, kind: 'added' })
    else if (serializeSExpr(old._node) !== serializeSExpr(symbol._node)) {
      changes.push({ name, kind: 'modified' })
    }
  }
  for (const name of was.keys()) if (!now.has(name)) changes.push({ name, kind: 'removed' })
  return changes.sort((a, b) => compareNames(a.name, b.name))
}

/** A multiset of serialized parts, consumed as they are matched. */
class PartBag {
  private readonly counts = new Map<string, number>()
  add(sig: string): void {
    this.counts.set(sig, (this.counts.get(sig) ?? 0) + 1)
  }
  /** Take one copy if present. */
  take(sig: string): boolean {
    const n = this.counts.get(sig) ?? 0
    if (n === 0) return false
    this.counts.set(sig, n - 1)
    return true
  }
}

/** Parts are compared within their unit and kind: the same line in another unit is another line. */
const bucketOf = (a: SymbolPartAddress): string => `${a.kind}.${a.unit}.${a.style}`

const partsOf = (node: SExprList): { address: SymbolPartAddress; node: SExprList }[] =>
  symbolPartAddresses(node).flatMap((address) => {
    const part = symbolPartNode(node, address)
    return part ? [{ address, node: part }] : []
  })

const bagOf = (node: SExprList): PartBag => {
  const bag = new PartBag()
  for (const part of partsOf(node)) {
    bag.add(`${bucketOf(part.address)}|${serializeSExpr(part.node)}`)
  }
  return bag
}

/**
 * Each field's whole definition by key — value, position, size, visibility —
 * so moving a field is a change to it, not only editing its text.
 */
const fieldValues = (symbol: KicadLibSymbol): Map<string, string> =>
  new Map(symbol.properties.map((p) => [p.key, serializeSExpr(p._node)]))

/**
 * A symbol that differs where no part or field shows it (a pin-name offset, a
 * flag) is painted whole: nothing on it would say why it is listed otherwise.
 */
const orWhole = (paint: PartPaint): PartPaint =>
  paint.changed.length === 0 && paint.removed.length === 0 ? { ...paint, whole: 'changed' } : paint

/** How one placed definition is painted, by part key relative to its symbol. */
interface PartPaint {
  /** The whole symbol, or null to paint part by part. */
  whole: 'changed' | 'removed' | null
  changed: string[]
  removed: string[]
}

const partKey = (address: SymbolPartAddress): string =>
  address.kind === 'field'
    ? schematicFieldKey(address.field ?? '')
    : symbolPartKey(address.kind, {
        depth: 0,
        unit: address.unit,
        style: address.style,
        index: address.index
      })

/**
 * A modified symbol as it is now, and which parts are which. With
 * `withRemoved` (the Diff view) the removed parts are appended back into their
 * units, to be drawn red.
 */
const afterDefinition = (
  was: KicadLibSymbol,
  now: KicadLibSymbol,
  withRemoved: boolean
): { node: SExprList; paint: PartPaint } => {
  const node = parseSExpr(serializeSExpr(now._node)) as SExprList
  const inAfter = bagOf(node)
  const injected = new Set<SExprList>()
  for (const part of withRemoved ? partsOf(was._node) : []) {
    const text = serializeSExpr(part.node)
    if (inAfter.take(`${bucketOf(part.address)}|${text}`)) continue
    const copy = parseSExpr(text) as SExprList
    getOrCreateUnitNode(node, part.address.unit, part.address.style).children.push(copy)
    injected.add(copy)
  }
  const inBefore = bagOf(was._node)
  const paint: PartPaint = { whole: null, changed: [], removed: [] }
  for (const part of partsOf(node)) {
    if (injected.has(part.node)) paint.removed.push(partKey(part.address))
    else if (!inBefore.take(`${bucketOf(part.address)}|${serializeSExpr(part.node)}`)) {
      paint.changed.push(partKey(part.address))
    }
  }
  const old = fieldValues(was)
  for (const [key, value] of fieldValues(now)) {
    if (old.get(key) !== value) paint.changed.push(schematicFieldKey(key))
  }
  return { node, paint: orWhole(paint) }
}

/** A modified symbol as it was: the parts that did not survive are the changes. */
const beforeDefinition = (
  was: KicadLibSymbol,
  now: KicadLibSymbol
): { node: SExprList; paint: PartPaint } => {
  const inAfter = bagOf(now._node)
  const paint: PartPaint = { whole: null, changed: [], removed: [] }
  for (const part of partsOf(was._node)) {
    if (!inAfter.take(`${bucketOf(part.address)}|${serializeSExpr(part.node)}`)) {
      paint.changed.push(partKey(part.address))
    }
  }
  const next = fieldValues(now)
  for (const [key, value] of fieldValues(was)) {
    if (next.get(key) !== value) paint.changed.push(schematicFieldKey(key))
  }
  return { node: was._node, paint: orWhole(paint) }
}

/** Units the symbol has in either version, so a unit that went away can still be shown. */
export function symbolDiffUnitCount(
  before: KicadSymbolLibrary | null,
  after: KicadSymbolLibrary | null,
  name: string
): number {
  const counts = [before, after].flatMap((library) => {
    const symbol = library?.symbols.get(name)
    return symbol ? [symbolUnitCount(symbol._node)] : []
  })
  return Math.max(1, ...counts)
}

export interface SymbolDiffView {
  doc: KicadSchematic
  paint: SchematicDiffPaint
}

/**
 * One symbol's diff, one unit of it placed at the origin. Diff: the symbol as
 * it is now with its removed parts drawn back in (red), or the whole of it red
 * when it was removed. After: the new symbol alone. Before: the old one alone.
 * Changes keep their colors; everything else is dimmed. Null when the symbol
 * has no drawing on that side (Before of an added symbol, After of a removed
 * one). Pure; exported for tests.
 */
export function symbolDiffView(
  before: KicadSymbolLibrary | null,
  after: KicadSymbolLibrary | null,
  name: string,
  version: DiffVersion,
  unit = 1
): SymbolDiffView | null {
  const was = before?.symbols.get(name)
  const now = after?.symbols.get(name)
  let library: KicadSymbolLibrary
  let node: SExprList
  let paint: PartPaint
  if (was && now && before && after) {
    if (serializeSExpr(was._node) === serializeSExpr(now._node)) return null
    const defined =
      version === 'before'
        ? beforeDefinition(was, now)
        : afterDefinition(was, now, version === 'diff')
    library = version === 'before' ? before : after
    node = defined.node
    paint = defined.paint
  } else if (was && before && version !== 'after') {
    library = before
    node = was._node
    paint = { whole: version === 'diff' ? 'removed' : 'changed', changed: [], removed: [] }
  } else if (now && after && version !== 'before') {
    library = after
    node = now._node
    paint = { whole: 'changed', changed: [], removed: [] }
  } else {
    return null
  }

  // The definition plus its `extends` parents, wrapped as a preview sheet.
  const definitions = new Map<string, string>([[name, serializeSExpr(node, 2)]])
  const typed = library.symbols.get(name)
  if (typed) {
    const chain = libSymbolChain(typed, (parent) => library.symbols.get(parent))
    for (const parent of chain.slice(1)) {
      if (!definitions.has(parent.name))
        definitions.set(parent.name, serializeSExpr(parent._node, 2))
    }
  }
  const doc = parseKicadSchematic(
    `(kicad_sch\n  (version 20231120)\n  (generator "goatcad")\n  (lib_symbols\n${[...definitions.values()].join('\n')}\n  )\n)\n`
  )
  const target = doc.libSymbols.get(name)
  if (!target) return null
  const chain = libSymbolChain(target, (parent) => doc.libSymbols.get(parent))
  addSchematicSymbolToAST(
    doc,
    target,
    { x: nm(0), y: nm(0), angle: 0 },
    getLibSymbolProperty(target, 'Reference') ?? 'U',
    libSymbolUnitPins(chain, unit, 1),
    [],
    unit,
    1
  )
  const changed = new Set<string>()
  const removed = new Set<string>()
  if (paint.whole === 'changed') changed.add('symbol:0')
  else if (paint.whole === 'removed') removed.add('symbol:0')
  for (const key of paint.changed) changed.add(`symbol:0/${key}`)
  for (const key of paint.removed) removed.add(`symbol:0/${key}`)
  return { doc: parseKicadSchematic(serializeKicadSchematic(doc)), paint: { changed, removed } }
}
