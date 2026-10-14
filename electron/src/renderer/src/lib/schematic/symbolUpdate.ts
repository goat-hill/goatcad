// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * KiCad's Update Symbols from Library and Change Symbols, over a sheet's AST
 * (`eeschema/dialogs/dialog_change_symbols.cpp`, `processSymbols`).
 *
 * A placed symbol draws from the sheet's own copy of its definition; a
 * library edit never reaches it. Updating replaces that copy with the
 * library's current one and brings the placement's fields along as the
 * options say; changing does the same with another library id. Position,
 * orientation, unit and the per-instance references stay, and pins keep
 * their uuids by number.
 *
 * One definition serves every placement drawn from it. A placement left out of
 * the run keeps the old copy, so the new one is filed beside it under KiCad's
 * `<name>_<n>` with a `lib_name`, as `SCH_SCREEN::Append` does.
 */
import {
  cloneNodeDeep,
  findChild,
  findChildren,
  getAtomValues,
  getToken,
  serializeSExpr,
  type SExprList
} from '../kicad/sexpr'
import { makeAtom, makeList, setPositionalAtom } from '../kicad/footprint'
import { formatNmAtom, nm, type Nm } from '../kicad/coordinates'
import {
  definitionIdOf,
  libSymbolUnitCount,
  libSymbolUnitPins,
  resolveSymbolGeometry,
  setSchematicPropertyHidden,
  setSchematicPropertyPlacement,
  setSchematicPropertyValue,
  setSchematicSymbolFlag,
  setSymbolInstanceReference,
  type KicadLibSymbol,
  type KicadSchematic,
  type KicadSchematicSymbol,
  type Point,
  type SchematicProperty
} from '../kicad/schematic'
import { placedPinPosition, placedPoint } from './connectivity'
import { labelAngleForPin } from './schematicAgent'
import { directionOf, type MovedPoint } from './wireReshape'
import { applyMovePlan, planMovedPoints, selectionOf } from './schematicMove'
import { parseReference } from './annotate'
import { renamedDefinition } from './schematicClipboard'
import { setSymbolPinDisplay } from '../symbol/symbolEdit'

/** KiCad's dialog options, by its labels. */
export interface SymbolUpdateOptions {
  /** Reference and Value are in the fields list only when ticked (off by default in KiCad). */
  updateReference: boolean
  updateValue: boolean
  /** "Update field text" — a field the library gives text to. */
  resetFieldText: boolean
  /** "Reset fields if empty in new symbol". */
  resetEmptyFields: boolean
  /** "Remove fields if not in new symbol" (never a mandatory one). */
  removeExtraFields: boolean
  /** "Update field visibilities". */
  resetFieldVisibility: boolean
  /** "Update field sizes and styles". */
  resetFieldEffects: boolean
  /** "Update field positions". */
  resetFieldPositions: boolean
  /** "Update symbol attributes": in BOM, on board, excluded from simulation. */
  resetAttributes: boolean
  /**
   * "Update pin name/number visibilities": the library's. Unticked, the new
   * copy keeps whether the old one showed pin names and numbers.
   */
  resetPinTextVisibility: boolean
  /**
   * "Reset alternate pin functions". Unticked, an alternate the new symbol no
   * longer offers, or one naming the pin itself, is cleared all the same.
   */
  resetAlternatePins: boolean
  /** "Reset custom power symbols": a power symbol's Value is the library's too. */
  resetCustomPower: boolean
  /**
   * KiCad's fields list: the fields (other than Reference and Value, which
   * their own options govern) the run may touch. Absent, every field.
   */
  fields?: readonly string[]
}

/** KiCad's defaults for Update Symbols from Library. */
export const UPDATE_DEFAULTS: SymbolUpdateOptions = {
  updateReference: false,
  updateValue: false,
  resetFieldText: true,
  resetEmptyFields: false,
  removeExtraFields: false,
  resetFieldVisibility: false,
  resetFieldEffects: false,
  resetFieldPositions: false,
  resetAttributes: false,
  resetPinTextVisibility: false,
  resetAlternatePins: false,
  resetCustomPower: false
}

/** KiCad's defaults for Change Symbols: the new part's look comes along. */
export const CHANGE_DEFAULTS: SymbolUpdateOptions = {
  ...UPDATE_DEFAULTS,
  resetFieldVisibility: true,
  resetFieldEffects: true,
  resetFieldPositions: true,
  resetAttributes: true,
  resetPinTextVisibility: true,
  resetAlternatePins: true
}

/** A placement and the library id it ends up drawn from (its own, to update). */
export interface SymbolUpdateTarget {
  index: number
  libId: string
}

/** The library's current definition, flattened; undefined when no library has it. */
export type LibraryDefinitionLookup = (libId: string) => KicadLibSymbol | undefined

export interface SymbolUpdateReport {
  /** Indices written. */
  updated: number[]
  /** Library ids no library the sheet sees has. */
  notFound: string[]
  /** Placements whose unit the new symbol does not have. */
  tooFewUnits: number[]
}

const MANDATORY_FIELDS = new Set(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'])

/** Which of `targets` can be written, and why the rest cannot. */
export function checkSymbolUpdate(
  doc: KicadSchematic,
  targets: SymbolUpdateTarget[],
  lookup: LibraryDefinitionLookup
): SymbolUpdateReport & { valid: SymbolUpdateTarget[] } {
  const valid: SymbolUpdateTarget[] = []
  const notFound = new Set<string>()
  const tooFewUnits: number[] = []
  for (const target of targets) {
    const symbol = doc.symbols[target.index]
    if (!symbol) continue
    const definition = lookup(target.libId)
    if (!definition) notFound.add(target.libId)
    else if (libSymbolUnitCount([definition]) < symbol.unit) tooFewUnits.push(target.index)
    else valid.push(target)
  }
  return {
    valid,
    updated: valid.map((target) => target.index),
    notFound: [...notFound].sort(),
    tooFewUnits
  }
}

/**
 * Where each pin that survives the swap moves: from where it is drawn now to
 * where the new definition draws it, matched by number. Fed to the move plan,
 * it keeps the wires on a pin that stayed a pin (a changed symbol whose pins
 * sit elsewhere stays connected). Read before anything is written.
 */
export function symbolUpdatePinMoves(
  doc: KicadSchematic,
  targets: SymbolUpdateTarget[],
  lookup: LibraryDefinitionLookup
): MovedPoint[] {
  const moved: MovedPoint[] = []
  for (const target of checkSymbolUpdate(doc, targets, lookup).valid) {
    const symbol = doc.symbols[target.index]
    const definition = lookup(target.libId)
    if (!symbol || !definition) continue
    const after = new Map<string, Point & { angle: number }>()
    for (const pin of libSymbolUnitPins([definition], symbol.unit, symbol.bodyStyle)) {
      if (!after.has(pin.number)) after.set(pin.number, pin.position)
    }
    const seen = new Set<string>()
    for (const { pin } of resolveSymbolGeometry(doc, symbol).pins) {
      const next = after.get(pin.number)
      if (!next || seen.has(pin.number)) continue
      seen.add(pin.number)
      const from = placedPinPosition(symbol, pin)
      const to = placedPoint(symbol, next)
      const direction = directionOf(labelAngleForPin(symbol, next.angle))
      const directionBefore = directionOf(labelAngleForPin(symbol, pin.position.angle))
      if (from.x === to.x && from.y === to.y && direction === directionBefore) continue
      moved.push({
        from,
        to,
        direction,
        ...(direction !== directionBefore ? { directionBefore } : {})
      })
    }
  }
  return moved
}

const nameOf = (node: SExprList): string => getAtomValues(node)[0] ?? ''

const definitionNodes = (container: SExprList): SExprList[] =>
  container.children.filter(
    (child): child is SExprList => child.type === 'list' && getToken(child) === 'symbol'
  )

/** The stem KiCad numbers a renamed copy from: the name past the nickname. */
const itemName = (name: string): string => name.slice(name.indexOf(':') + 1)

/** Whether a copy shows pin names and numbers, as `(pin_names (hide …))` and `(pin_numbers …)` say. */
interface PinTextDisplay {
  namesHidden: boolean
  numbersHidden: boolean
}

/**
 * The pin display a target's new copy takes: none of its own when the
 * library's wins, else the copy it draws from now.
 */
const keptPinDisplay = (
  doc: KicadSchematic,
  target: SymbolUpdateTarget,
  options: SymbolUpdateOptions
): PinTextDisplay | null => {
  const symbol = doc.symbols[target.index]
  const old = symbol && doc.libSymbols.get(definitionIdOf(symbol))
  if (options.resetPinTextVisibility || !old) return null
  return { namesHidden: old.pinNamesHidden, numbersHidden: old.pinNumbersHidden }
}

/**
 * Write the updated definitions and point every target at its own. Returns
 * the name each target's copy was filed under, by placement index.
 */
function fileDefinitions(
  doc: KicadSchematic,
  targets: SymbolUpdateTarget[],
  lookup: LibraryDefinitionLookup,
  options: SymbolUpdateOptions
): Map<number, string> {
  let container = findChild(doc._root, 'lib_symbols')
  if (!container) {
    const at = doc._root.start
    container = makeList([makeAtom('lib_symbols', false, at)], at)
    const anchor = doc._root.children.findIndex(
      (child) => child.type === 'list' && getToken(child) === 'symbol'
    )
    doc._root.children.splice(anchor < 0 ? doc._root.children.length : anchor, 0, container)
  }
  const retargeted = new Set(targets.map((target) => target.index))
  // What placements left out of the run still draw from: those copies stay.
  const kept = new Set<string>()
  doc.symbols.forEach((symbol, index) => {
    if (!retargeted.has(index)) kept.add(definitionIdOf(symbol))
  })
  const byName = new Map(definitionNodes(container).map((node) => [nameOf(node), node]))
  const written = new Set<string>()
  const same = (name: string, node: SExprList): boolean => {
    const held = byName.get(name)
    return !!held && serializeSExpr(held) === serializeSExpr(renamedDefinition(node, name))
  }
  const place = (name: string, node: SExprList): void => {
    const stale = byName.get(name)
    const children = container.children
    if (stale) {
      children[children.indexOf(stale)] = node
    } else {
      // KiCad writes its cache in name order.
      const after = definitionNodes(container).find((other) => nameOf(other) > name)
      children.splice(after ? children.indexOf(after) : children.length, 0, node)
    }
    byName.set(name, node)
    written.add(name)
  }
  // One copy per library id and the pin display its placements keep.
  const copies = new Map<string, { libId: string; display: PinTextDisplay | null; at: number[] }>()
  for (const target of targets) {
    const display = keptPinDisplay(doc, target, options)
    const key = `${target.libId}\0${display ? `${display.namesHidden}${display.numbersHidden}` : ''}`
    const copy = copies.get(key) ?? { libId: target.libId, display, at: [] }
    copy.at.push(target.index)
    copies.set(key, copy)
  }
  const filed = new Map<number, string>()
  for (const { libId, display, at } of copies.values()) {
    const definition = lookup(libId)
    if (!definition) continue
    const fresh = cloneNodeDeep(definition._node) as SExprList
    setPositionalAtom(fresh, 1, libId, true)
    if (display && display.namesHidden !== definition.pinNamesHidden)
      setSymbolPinDisplay(fresh, { namesHidden: display.namesHidden })
    if (display && display.numbersHidden !== definition.pinNumbersHidden)
      setSymbolPinDisplay(fresh, { numbersHidden: display.numbersHidden })
    const file = (name: string): void => {
      for (const index of at) filed.set(index, name)
    }
    const free = (name: string): boolean => !kept.has(name) && !written.has(name)
    const stem = itemName(libId)
    // An identical copy already here is reused, under whichever name it has.
    const existing = [libId, ...[...byName.keys()].filter((name) => name.startsWith(`${stem}_`))]
    const reuse = existing.find((name) => same(name, fresh))
    if (reuse) {
      file(reuse)
      continue
    }
    if (free(libId)) {
      place(libId, fresh)
      file(libId)
      continue
    }
    for (let n = 1; ; n += 1) {
      const candidate = `${stem}_${n}`
      if (free(candidate)) {
        place(candidate, renamedDefinition(fresh, candidate))
        file(candidate)
        break
      }
    }
  }
  return filed
}

/** `(lib_id …)` to `libId`, and `(lib_name …)` present only when the copy is renamed. */
function setLibraryLink(symbol: KicadSchematicSymbol, libId: string, name: string): void {
  const node = symbol._node
  const idNode = findChild(node, 'lib_id')
  if (idNode) setPositionalAtom(idNode, 1, libId, true)
  const nameNode = findChild(node, 'lib_name')
  if (name === libId) {
    if (nameNode) node.children.splice(node.children.indexOf(nameNode), 1)
  } else if (nameNode) {
    setPositionalAtom(nameNode, 1, name, true)
  } else {
    const at = node.start
    const index = idNode ? node.children.indexOf(idNode) + 1 : 1
    node.children.splice(
      index,
      0,
      makeList([makeAtom('lib_name', false, at), makeAtom(name, true, at)], at)
    )
  }
  symbol.libId = libId
  symbol.libName = name === libId ? undefined : name
}

/**
 * Pin nodes by number: kept where the new symbol still has the number (their
 * uuids are what a board's pad links read), dropped where it does not, and
 * added for a number this unit gains. A kept pin's chosen alternate goes when
 * the options reset it, and, as KiCad clears it regardless, when the new pin
 * does not offer it or it names the pin itself.
 */
function reconcilePins(
  symbol: KicadSchematicSymbol,
  definition: KicadLibSymbol,
  options: SymbolUpdateOptions
): void {
  const node = symbol._node
  const libPins = new Map(
    [...definition.pins, ...definition.variants.flatMap((variant) => variant.pins)].map((pin) => [
      pin.number,
      pin
    ])
  )
  const pinNodes = findChildren(node, 'pin')
  const held = new Set<string>()
  for (const pinNode of pinNodes) {
    const number = getAtomValues(pinNode)[0] ?? ''
    const libPin = libPins.get(number)
    if (!libPin) {
      node.children.splice(node.children.indexOf(pinNode), 1)
      continue
    }
    held.add(number)
    const alternate = findChild(pinNode, 'alternate')
    const chosen = alternate ? getAtomValues(alternate)[0] : undefined
    if (
      alternate &&
      (options.resetAlternatePins ||
        chosen === libPin.name ||
        !libPin.alternates.some((offered) => offered.name === chosen))
    )
      pinNode.children.splice(pinNode.children.indexOf(alternate), 1)
  }
  const wanted = libSymbolUnitPins([definition], symbol.unit, symbol.bodyStyle)
    .map((pin) => pin.number)
    .filter((number, index, list) => list.indexOf(number) === index && !held.has(number))
  if (!wanted.length) return
  const at = node.start
  const remaining = findChildren(node, 'pin')
  const last = remaining[remaining.length - 1]
  const properties = findChildren(node, 'property')
  const anchor = last ?? properties[properties.length - 1]
  let index = anchor ? node.children.indexOf(anchor) + 1 : node.children.length
  for (const number of wanted) {
    node.children.splice(
      index++,
      0,
      makeList(
        [
          makeAtom('pin', false, at),
          makeAtom(number, true, at),
          makeList([makeAtom('uuid', false, at), makeAtom(crypto.randomUUID(), true, at)], at)
        ],
        at
      )
    )
  }
}

/** A library field's lib-space offset, placed as the symbol draws it. */
const placedFieldPoint = (symbol: KicadSchematicSymbol, libField: SchematicProperty): Point =>
  placedPoint(symbol, { x: libField.position.x, y: libField.position.y })

/** The Reference prefix changes, the number stays (KiCad's `GetRefDesPrefix`). */
const renumberedReference = (reference: string, libReference: string): string => {
  const prefix = parseReference(libReference).prefix.replace(/\?+$/, '')
  const { number } = parseReference(reference)
  return number === null ? `${prefix}?` : `${prefix}${number}`
}

function updateFields(
  symbol: KicadSchematicSymbol,
  definition: KicadLibSymbol,
  options: SymbolUpdateOptions
): void {
  const libFields = definition.properties.filter((field) => !field.key.startsWith('ki_'))
  const libField = (key: string): SchematicProperty | undefined =>
    libFields.find((field) => field.key === key)
  // Reference and Value: their text only when ticked. Given a fields list (the
  // dialog's), they are always in it for their look and place, which the
  // options govern as any field's; without one, KiCad's: in only when ticked.
  const textOf = (key: string): boolean =>
    key === 'Reference' ? options.updateReference : key === 'Value' ? options.updateValue : true
  const inList = (key: string): boolean =>
    key === 'Reference' || key === 'Value'
      ? !!options.fields || textOf(key)
      : !options.fields || options.fields.includes(key)
  for (const field of [...symbol.properties].reverse()) {
    if (!inList(field.key) || field.key.startsWith('ki_')) continue
    const from = libField(field.key)
    if (!from) {
      if (options.removeExtraFields && !MANDATORY_FIELDS.has(field.key)) {
        symbol._node.children.splice(symbol._node.children.indexOf(field._node), 1)
        symbol.properties.splice(symbol.properties.indexOf(field), 1)
      }
      continue
    }
    const resetText =
      textOf(field.key) && (from.value === '' ? options.resetEmptyFields : options.resetFieldText)
    if (resetText) {
      if (field.key === 'Reference') {
        if (symbol.instances.length) {
          for (const instance of symbol.instances) {
            setSymbolInstanceReference(
              symbol,
              instance.path,
              renumberedReference(instance.reference, from.value)
            )
          }
        } else {
          setSchematicPropertyValue(field, renumberedReference(field.value, from.value))
        }
      } else if (field.key !== 'Value' || !definition.isPower || options.resetCustomPower) {
        setSchematicPropertyValue(field, from.value)
      }
    }
    const hidden = options.resetFieldVisibility ? from.hidden : field.hidden
    if (options.resetFieldEffects) {
      const effects = findChild(from._node, 'effects')
      const own = findChild(field._node, 'effects')
      if (effects) {
        const copy = cloneNodeDeep(effects) as SExprList
        if (own) field._node.children[field._node.children.indexOf(own)] = copy
        else field._node.children.push(copy)
      }
      for (const token of ['show_name', 'do_not_autoplace']) {
        const mine = findChild(field._node, token)
        if (mine) field._node.children.splice(field._node.children.indexOf(mine), 1)
        const theirs = findChild(from._node, token)
        if (theirs) {
          const before = findChild(field._node, 'effects')
          const index = before ? field._node.children.indexOf(before) : field._node.children.length
          field._node.children.splice(index, 0, cloneNodeDeep(theirs))
        }
      }
      setSchematicPropertyHidden(field, hidden)
    } else if (hidden !== field.hidden) {
      setSchematicPropertyHidden(field, hidden)
    }
    if (options.resetFieldPositions) {
      setSchematicPropertyPlacement(field, placedFieldPoint(symbol, from))
    }
  }
  // Library fields the placement lacks come along, as KiCad adds them.
  for (const from of libFields) {
    if (MANDATORY_FIELDS.has(from.key) || symbol.properties.some((f) => f.key === from.key))
      continue
    if (!inList(from.key)) continue
    const copy = cloneNodeDeep(from._node) as SExprList
    const point = placedFieldPoint(symbol, from)
    const at = findChild(copy, 'at')
    if (at) {
      const angle = getAtomValues(at)[2] ?? '0'
      const fresh = makeList(
        [
          makeAtom('at', false, copy.start),
          makeAtom(formatMm(point.x), false, copy.start),
          makeAtom(formatMm(point.y), false, copy.start),
          makeAtom(angle, false, copy.start)
        ],
        copy.start
      )
      copy.children[copy.children.indexOf(at)] = fresh
    }
    const properties = findChildren(symbol._node, 'property')
    const last = properties[properties.length - 1]
    const index = last ? symbol._node.children.indexOf(last) + 1 : symbol._node.children.length
    symbol._node.children.splice(index, 0, copy)
  }
}

/** Integer nanometers as the file's millimeter atom. */
const formatMm = (value: number): string => formatNmAtom(nm(value))

/**
 * Update or change `targets` in place: the definitions, each placement's link,
 * pins, fields and (optionally) attributes. Wires are the caller's — see
 * `symbolUpdatePinMoves`. Returns what was written and what was not.
 */
export function applySymbolUpdate(
  doc: KicadSchematic,
  targets: SymbolUpdateTarget[],
  lookup: LibraryDefinitionLookup,
  options: SymbolUpdateOptions
): SymbolUpdateReport {
  const check = checkSymbolUpdate(doc, targets, lookup)
  if (!check.valid.length) return check
  const before = new Set(
    check.valid.flatMap((target) => {
      const symbol = doc.symbols[target.index]
      return symbol ? [definitionIdOf(symbol)] : []
    })
  )
  const filed = fileDefinitions(doc, check.valid, lookup, options)
  for (const target of check.valid) {
    const symbol = doc.symbols[target.index]
    const definition = lookup(target.libId)
    const name = filed.get(target.index)
    if (!symbol || !definition || !name) continue
    setLibraryLink(symbol, target.libId, name)
    reconcilePins(symbol, definition, options)
    updateFields(symbol, definition, options)
    if (options.resetAttributes) {
      setSchematicSymbolFlag(symbol, 'in_bom', definition.inBom)
      setSchematicSymbolFlag(symbol, 'on_board', definition.onBoard)
      setSchematicSymbolFlag(symbol, 'exclude_from_sim', definition.excludeFromSim)
    }
  }
  dropUnusedDefinitions(doc, before)
  return check
}

/**
 * The whole edit on one sheet file, as the editor's Update / Change symbols and
 * `schematic.update_symbols` both run it: the pin moves read first, the swap,
 * then the wires on a pin that moved following it (`grid` is the wire grid).
 * The caller's command layer tidies after.
 */
export function updateSymbolsWithWires(
  doc: KicadSchematic,
  targets: SymbolUpdateTarget[],
  lookup: LibraryDefinitionLookup,
  options: SymbolUpdateOptions,
  grid: Nm
): SymbolUpdateReport {
  const moved = symbolUpdatePinMoves(doc, targets, lookup)
  const items = targets.map(({ index }) => ({ type: 'symbol' as const, index }))
  const plan = moved.length
    ? planMovedPoints(doc, moved, selectionOf(items), { grid, wires: true, carryAttached: true })
    : null
  const report = applySymbolUpdate(doc, targets, lookup, options)
  if (plan) applyMovePlan(doc, plan)
  return report
}

/**
 * Drop the copies the run left unused, and only those: a sheet may carry other
 * unused definitions, and an update is not the place to tidy them.
 */
function dropUnusedDefinitions(doc: KicadSchematic, candidates: Set<string>): void {
  const container = findChild(doc._root, 'lib_symbols')
  if (!container) return
  const used = new Set(doc.symbols.map((symbol) => definitionIdOf(symbol)))
  const extended = new Set(
    definitionNodes(container).flatMap((node) => {
      const parent = findChild(node, 'extends')
      return parent ? [getAtomValues(parent)[0] ?? ''] : []
    })
  )
  container.children = container.children.filter(
    (child) =>
      !(child.type === 'list' && getToken(child) === 'symbol') ||
      !candidates.has(nameOf(child)) ||
      used.has(nameOf(child)) ||
      extended.has(nameOf(child))
  )
}
