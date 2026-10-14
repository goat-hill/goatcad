// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
// AST-edit helpers for authoring `.kicad_sym` symbol libraries.
//
// Every function mutates the REAL (symbol ...) nodes of a parsed
// (kicad_symbol_lib ...) root (see symbolLibrary.ts) so that serialization
// stays lossless (RULES.md §7): a one-symbol edit diffs to only that node's
// subtree. The editor funnels each call through runCommand(), which
// serializes/emits/reparses and records undo — these helpers stay pure AST
// mutations with no I/O.
//
// Structural note that dictates insertion targets: in a raw .kicad_sym a
// top-level (symbol "Name" ...) holds (property ...) / (pin_names) / (in_bom)
// etc. plus nested UNIT sub-symbols — (symbol "Name_0_1" ...) carries the body
// graphics, (symbol "Name_1_1" ...) carries unit-1 pins. Graphics and pins are
// never direct children of the top symbol; they live in these unit nodes.

import {
  findOrCreateChild,
  makeAtom,
  makeList,
  setAtChildNm,
  setPointsChildNm,
  setPositionalAtom,
  setScalarChild,
  setXYChildNm
} from '../kicad/footprint'
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
import { removeColorChild, setColorChild, type Rgba } from '../kicad/color'
import type { KicadSymbolLibrary } from '../kicad/symbolLibrary'
import {
  DEFAULT_FONT_SIZE_NM,
  parseVariantSuffix,
  propertyKeyOf,
  propertyNameIndex,
  SYMBOL_GRAPHIC_TOKENS,
  type KicadLibSymbol,
  type SymbolGraphic,
  type SymbolPin,
  type SymbolVariant
} from '../kicad/schematic'
import {
  formatKicadNumber,
  formatNmAtom,
  mmAtomToNm,
  mmToNm,
  nm,
  type Nm
} from '../kicad/coordinates'
import { DEFAULT_TEXT_BOX_MARGIN_NM, textBoxCornerPoints } from '../schematic/textBox'

/**
 * Brand an integer nanometer literal or an integer-exact arithmetic result as
 * `Nm`. A cast, not a conversion — use `nm()` where the value may be fractional.
 */
const nmv = (v: number): Nm => v as Nm

/** `DEFAULT_TEXT_BOX_MARGINS_NM` in the integer-nanometer domain. */
const DEFAULT_TEXT_BOX_MARGINS_NM = {
  left: DEFAULT_TEXT_BOX_MARGIN_NM,
  top: DEFAULT_TEXT_BOX_MARGIN_NM,
  right: DEFAULT_TEXT_BOX_MARGIN_NM,
  bottom: DEFAULT_TEXT_BOX_MARGIN_NM
}

/**
 * Graphic tokens KiCad allows inside a symbol unit sub-symbol — the same set the
 * typed views are parsed from, so a node list and a variant's `graphics` array
 * always describe the same parts in the same order.
 */
const GRAPHIC_TOKENS = SYMBOL_GRAPHIC_TOKENS

/** A `(size 1.27 1.27)` default text size, wrapped as `(effects (font ...))`. */
const effectsNode = (at: number): SExprList =>
  makeList(
    [
      makeAtom('effects', false, at),
      makeList(
        [
          makeAtom('font', false, at),
          makeList(
            [makeAtom('size', false, at), makeAtom('1.27', false, at), makeAtom('1.27', false, at)],
            at
          )
        ],
        at
      )
    ],
    at
  )

/** `(stroke (width 0.254) (type default))`. */
const strokeNode = (at: number): SExprList =>
  makeList(
    [
      makeAtom('stroke', false, at),
      makeList([makeAtom('width', false, at), makeAtom('0.254', false, at)], at),
      makeList([makeAtom('type', false, at), makeAtom('default', false, at)], at)
    ],
    at
  )

/** `(fill (type <kind>))`. */
const fillNode = (at: number, kind = 'none'): SExprList =>
  makeList(
    [
      makeAtom('fill', false, at),
      makeList([makeAtom('type', false, at), makeAtom(kind, false, at)], at)
    ],
    at
  )

/** `(<token> x y)`. */
const xyNode = (token: string, x: Nm, y: Nm, at: number): SExprList =>
  makeList(
    [
      makeAtom(token, false, at),
      makeAtom(formatNmAtom(x), false, at),
      makeAtom(formatNmAtom(y), false, at)
    ],
    at
  )

/** `(name "text" (effects ...))` / `(number "text" (effects ...))`. */
const pinTextNode = (token: string, text: string, at: number): SExprList =>
  makeList([makeAtom(token, false, at), makeAtom(text, true, at), effectsNode(at)], at)

/** The top-symbol name (e.g. "R"), used to derive unit sub-symbol names. */
const symbolName = (symbolNode: SExprList): string => getFirstAtomValue(symbolNode) ?? ''

/**
 * The name unit sub-symbols are written under: a schematic's `lib_symbols` copy
 * is `Lib:Name` but names its sub-symbols `Name_1_1`, which KiCad's parser requires.
 */
const unitBaseName = (symbolNode: SExprList): string => {
  const name = symbolName(symbolNode)
  return name.slice(name.indexOf(':') + 1)
}

/** Nested unit sub-symbols `(symbol "<name>_<unit>_<style>" ...)`. */
const unitSubSymbols = (symbolNode: SExprList): SExprList[] => findChildren(symbolNode, 'symbol')

/**
 * The unit sub-symbol `<name>_<unit>_<style>`, created and appended when
 * absent (a fresh symbol / its first pin or graphic needs the target node).
 */
export function getOrCreateUnitNode(symbolNode: SExprList, unit: number, style: number): SExprList {
  const name = `${unitBaseName(symbolNode)}_${unit}_${style}`
  const existing = unitSubSymbols(symbolNode).find((node) => getFirstAtomValue(node) === name)
  if (existing) return existing
  const at = symbolNode.start
  const node = makeList([makeAtom('symbol', false, at), makeAtom(name, true, at)], at)
  symbolNode.children.push(node)
  return node
}

/** Drop every `(token …)` child, for the patch fields whose "unset" is absence. */
const removeChildToken = (node: SExprList, token: string): void => {
  node.children = node.children.filter(
    (child) =>
      !(
        child.type === 'list' &&
        child.children[0]?.type === 'atom' &&
        child.children[0].value === token
      )
  )
}

/** Remove `target` from whichever unit sub-symbol contains it. */
const removeFromUnits = (symbolNode: SExprList, target: SExprNode): boolean => {
  for (const unit of unitSubSymbols(symbolNode)) {
    const idx = unit.children.indexOf(target)
    if (idx !== -1) {
      unit.children.splice(idx, 1)
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Fields / properties (on the top symbol node)
// ---------------------------------------------------------------------------

/**
 * Set `(property "key" "value" ...)` on the top symbol: update the value atom
 * in place, or append a fresh property after the last existing one. Value atoms
 * are always quoted, matching KiCad.
 */
export function setSymbolProperty(symbolNode: SExprList, key: string, value: string): void {
  const properties = findChildren(symbolNode, 'property')
  const existing = properties.find((prop) => propertyKeyOf(prop) === key)
  if (existing) {
    setPositionalAtom(existing, propertyNameIndex(existing) + 1, value, true)
    return
  }
  const at = symbolNode.start
  const prop = makeList(
    [
      makeAtom('property', false, at),
      makeAtom(key, true, at),
      makeAtom(value, true, at),
      xyNode('at', nmv(0), nmv(0), at),
      effectsNode(at)
    ],
    at
  )
  // Angle-less (at 0 0) grows a third atom to match property convention.
  const atNode = prop.children[3] as SExprList
  atNode.children.push(makeAtom('0', false, at))
  const lastProp = properties[properties.length - 1]
  const insertAt = lastProp ? symbolNode.children.indexOf(lastProp) + 1 : symbolNode.children.length
  symbolNode.children.splice(insertAt, 0, prop)
}

/**
 * The fields KiCad requires, in its own order (`MANDATORY_FIELDS`,
 * include/template_fieldnames.h). Pinned to the head of the property block:
 * never renamed, removed or reordered, as KiCad's own dialog enforces.
 */
export const MANDATORY_FIELD_KEYS = [
  'Reference',
  'Value',
  'Footprint',
  'Datasheet',
  'Description'
] as const

/** Whether a key names a field KiCad requires — see `MANDATORY_FIELD_KEYS`. */
export const isMandatoryField = (key: string): boolean =>
  (MANDATORY_FIELD_KEYS as readonly string[]).includes(key)

/**
 * Whether a field is the user's content rather than KiCad's metadata. `ki_*`
 * keys each already have their own home (Keywords box, footprint-filter list,
 * internal), which is why KiCad's fields grid omits them too.
 */
export const isUserField = (key: string): boolean => !key.startsWith('ki_')

/**
 * The `ki_*` keys the panel does list. An allowlist, so a `ki_*` key we have
 * not heard of stays out by default rather than leaking into the panel.
 */
const USER_KI_KEYS = new Set(['ki_keywords', 'ki_description'])

/** Whether a field belongs in the properties panel's field list. */
export const isPanelField = (key: string): boolean => isUserField(key) || USER_KI_KEYS.has(key)

/**
 * Whether a field is DRAWN in the symbol editor, and so selectable. Shared by
 * the canvas hit-test and the panel's focus button, which must agree exactly.
 * Deliberately not `!hidden`: a hidden field still draws here, dimmed, so it
 * can be unhidden.
 */
export const isFieldOnCanvas = (property: { key: string; value: string }): boolean =>
  !!property.value && isUserField(property.key)

/** The symbol's `(property …)` nodes, in document order. */
const propertyNodes = (symbolNode: SExprList): SExprList[] => findChildren(symbolNode, 'property')

/** A property node's key — past the `private` keyword a private field carries first. */
const propertyKey = propertyKeyOf

/** One property node by key, or null. */
export function symbolPropertyNode(symbolNode: SExprList, key: string): SExprList | null {
  return propertyNodes(symbolNode).find((node) => propertyKey(node) === key) ?? null
}

/**
 * Write a scalar child in KiCad's property order, which puts the flags between
 * `(at …)` and `(effects …)`; `setScalarChild` would append after the effects.
 */
const setPropertyScalarChild = (node: SExprList, token: string, value: string): void => {
  if (findChild(node, token)) {
    setScalarChild(node, token, value)
    return
  }
  const child = makeList(
    [makeAtom(token, false, node.start), makeAtom(value, false, node.start)],
    node.start
  )
  const effects = findChild(node, 'effects')
  const at = effects ? node.children.indexOf(effects) : node.children.length
  node.children.splice(at, 0, child)
}

/**
 * The symbol an undo or redo changed: the one holding the first character at
 * which the library's text `now` differs from what it `was`, in the library as
 * it is now. Null when the texts match (a design copy's history carries no
 * text) or the change sits before every symbol.
 */
export function changedSymbolName(
  library: KicadSymbolLibrary,
  now: string,
  was: string
): string | null {
  if (now === was) return null
  let at = 0
  while (at < now.length && at < was.length && now[at] === was[at]) at++
  let found: string | null = null
  for (const name of library.names) {
    const start = library.symbols.get(name)?._node.start
    if (start === undefined || start > at) break
    found = name
  }
  return found
}

/** Add a field. False when the key is taken — keys are unique within a symbol. */
export function addSymbolProperty(symbolNode: SExprList, key: string, value = ''): boolean {
  if (!key || symbolPropertyNode(symbolNode, key)) return false
  setSymbolProperty(symbolNode, key, value)
  return true
}

/** Remove a field. Mandatory fields refuse — KiCad requires all five. */
export function removeSymbolProperty(symbolNode: SExprList, key: string): boolean {
  if (isMandatoryField(key)) return false
  const node = symbolPropertyNode(symbolNode, key)
  if (!node) return false
  symbolNode.children.splice(symbolNode.children.indexOf(node), 1)
  return true
}

/** Rename a field, refusing mandatory keys and collisions with an existing one. */
export function renameSymbolProperty(symbolNode: SExprList, key: string, newKey: string): boolean {
  if (!newKey || isMandatoryField(key) || isMandatoryField(newKey)) return false
  if (key === newKey || symbolPropertyNode(symbolNode, newKey)) return false
  const node = symbolPropertyNode(symbolNode, key)
  if (!node) return false
  setPositionalAtom(node, propertyNameIndex(node), newKey, true)
  return true
}

/**
 * Move a field one slot within the user tail. Refuses at either end and refuses
 * to cross into the mandatory head.
 */
export function moveSymbolProperty(symbolNode: SExprList, key: string, delta: 1 | -1): boolean {
  if (isMandatoryField(key)) return false
  const nodes = propertyNodes(symbolNode)
  const index = nodes.findIndex((node) => propertyKey(node) === key)
  const neighbour = nodes[index + delta]
  if (index < 0 || !neighbour || isMandatoryField(propertyKey(neighbour))) return false
  const children = symbolNode.children
  const a = children.indexOf(nodes[index])
  const b = children.indexOf(neighbour)
  children[a] = neighbour
  children[b] = nodes[index]
  return true
}

/**
 * Show or hide a field. KiCad 10 writes `(hide yes)` on the PROPERTY, but
 * `parseTextEffects` also honors a legacy one nested in `(effects …)` — so
 * hiding writes one place and showing must clear both.
 */
export function setSymbolPropertyVisible(node: SExprList, visible: boolean): void {
  const effects = findChild(node, 'effects')
  if (visible) {
    removeChildToken(node, 'hide')
    if (effects) removeChildToken(effects, 'hide')
    return
  }
  if (effects) removeChildToken(effects, 'hide')
  setPropertyScalarChild(node, 'hide', 'yes')
}

/**
 * Rename the top symbol AND cascade to its unit sub-symbols
 * (`Old_i_j` → `New_i_j`) — KiCad requires unit names of the form
 * `<parent>_<unit>_<style>`, and the preview's variant parser keys off it.
 * Caller must reject collisions with an existing top-level symbol name.
 */
export function renameSymbol(symbolNode: SExprList, newName: string): void {
  const oldName = symbolName(symbolNode)
  setPositionalAtom(symbolNode, 1, newName, true)
  for (const unit of unitSubSymbols(symbolNode)) {
    const current = getFirstAtomValue(unit) ?? ''
    const suffix = current.startsWith(`${oldName}_`) ? current.slice(oldName.length) : ''
    if (suffix) setPositionalAtom(unit, 1, `${newName}${suffix}`, true)
  }
}

// ---------------------------------------------------------------------------
// Pins (in the `_1_1` unit sub-symbol)
// ---------------------------------------------------------------------------

export interface NewPin {
  name: string
  number: string
  x: Nm
  y: Nm
  angle: number
  length: Nm
  electricalType: string
  graphicStyle: string
}

/** Append a pin to `unitNumber` (unit 1 by default) and return the new node. */
export function addPin(symbolNode: SExprList, pin: NewPin, unitNumber = 1): SExprList {
  const unit = getOrCreateUnitNode(symbolNode, unitNumber, 1)
  const at = symbolNode.start
  const node = makeList(
    [
      makeAtom('pin', false, at),
      makeAtom(pin.electricalType, false, at),
      makeAtom(pin.graphicStyle, false, at),
      makeList(
        [
          makeAtom('at', false, at),
          makeAtom(formatNmAtom(pin.x), false, at),
          makeAtom(formatNmAtom(pin.y), false, at),
          makeAtom(formatKicadNumber(pin.angle), false, at)
        ],
        at
      ),
      makeList([makeAtom('length', false, at), makeAtom(formatNmAtom(pin.length), false, at)], at),
      pinTextNode('name', pin.name, at),
      pinTextNode('number', pin.number, at)
    ],
    at
  )
  unit.children.push(node)
  return node
}

export interface PinPatch {
  name?: string
  number?: string
  x?: Nm
  y?: Nm
  angle?: number
  length?: Nm
  electricalType?: string
  graphicStyle?: string
  hidden?: boolean
  /**
   * KiCad's "Name text size" / "Number text size" — the font on the pin's own
   * `(name …)` / `(number …)` node, which is where a pin carries text effects
   * at all. Square, because every non-default size in the 223 standard
   * libraries is (2,503 of them across pin names and numbers).
   */
  nameSize?: Nm
  numberSize?: Nm
}

/**
 * Set a property's horizontal justification.
 *
 * `center` is KiCad's default and is written by omitting the token, which is
 * what the standard library does — `(justify left)` appears 254 times in
 * `Device.kicad_sym` alone, and centered fields carry nothing.
 */
export function setSymbolPropertyJustify(
  node: SExprList,
  justify: 'left' | 'right' | 'center'
): void {
  const effects = findChild(node, 'effects')
  if (!effects) return
  removeChildToken(effects, 'justify')
  if (justify === 'center') return
  const at = node.start
  effects.children.push(
    makeList([makeAtom('justify', false, at), makeAtom(justify, false, at)], at)
  )
}

/** Add or remove a `(hide yes)` child (also clears any legacy bare `hide` atom). */
function setHideFlag(node: SExprList, hidden: boolean): void {
  node.children = node.children.filter(
    (c) =>
      !(c.type === 'atom' && c.value === 'hide') &&
      !(c.type === 'list' && c.children[0]?.type === 'atom' && c.children[0].value === 'hide')
  )
  if (!hidden) return
  const at = node.start
  const flag = makeList([makeAtom('hide', false, at), makeAtom('yes', false, at)], at)
  // KiCad writes the flag directly after `(length …)` on a pin, ahead of the
  // name and number. Appending it instead round-trips fine but is not the file
  // KiCad would have written, so the next save it makes shows as a diff nobody
  // authored.
  const lengthAt = node.children.findIndex(
    (c) => c.type === 'list' && c.children[0]?.type === 'atom' && c.children[0].value === 'length'
  )
  if (lengthAt >= 0) node.children.splice(lengthAt + 1, 0, flag)
  else node.children.push(flag)
}

/** Edit an existing pin node in place. */
export function updatePin(pinNode: SExprList, data: PinPatch): void {
  if (data.electricalType !== undefined) setPositionalAtom(pinNode, 1, data.electricalType)
  if (data.graphicStyle !== undefined) setPositionalAtom(pinNode, 2, data.graphicStyle)
  if (data.hidden !== undefined) setHideFlag(pinNode, data.hidden)
  if (data.x !== undefined || data.y !== undefined || data.angle !== undefined) {
    const current = pinNode.children.find(
      (c): c is SExprList =>
        c.type === 'list' && c.children[0]?.type === 'atom' && c.children[0].value === 'at'
    )
    const cx =
      data.x ??
      (current && current.children[1]?.type === 'atom'
        ? mmAtomToNm(current.children[1].value)
        : nmv(0))
    const cy =
      data.y ??
      (current && current.children[2]?.type === 'atom'
        ? mmAtomToNm(current.children[2].value)
        : nmv(0))
    const ca =
      data.angle ??
      (current && current.children[3]?.type === 'atom' ? Number(current.children[3].value) : 0)
    setAtChildNm(pinNode, cx, cy, ca)
  }
  if (data.length !== undefined) setScalarChild(pinNode, 'length', formatNmAtom(data.length))
  for (const token of ['name', 'number'] as const) {
    const value = data[token]
    const size = token === 'name' ? data.nameSize : data.numberSize
    if (value === undefined && size === undefined) continue
    const textNode = findChild(pinNode, token)
    if (!textNode) continue
    if (value !== undefined) setPositionalAtom(textNode, 1, value, true)
    if (size !== undefined) setTextEffects(textNode, { fontHeight: size, fontWidth: size })
  }
}

/** Remove a pin from its unit sub-symbol. */
export function deletePin(symbolNode: SExprList, pinNode: SExprList): void {
  removeFromUnits(symbolNode, pinNode)
}

/**
 * Move a pin or graphic into another unit sub-symbol — KiCad's "Common to all
 * units in symbol", which is a question of WHICH `<name>_<unit>_<style>` node
 * holds the part rather than a flag written on it. Unit 0 is the shared one.
 *
 * The style is carried across deliberately: only the unit changes, so this can
 * never move a part into a body style (the editor draws style 0 and 1 only, so
 * a part landing in style 2 would vanish and read as a delete).
 *
 * The part keeps its identity — the same node is re-parented, not copied — but
 * its ADDRESS changes, so the caller re-derives it with `addressOfPartNode`.
 * An emptied sub-symbol is left in place; `removeUnit` is the deliberate way to
 * drop one.
 */
export function movePartToUnit(
  symbolNode: SExprList,
  partNode: SExprList,
  unit: number,
  style: number
): void {
  const target = getOrCreateUnitNode(symbolNode, unit, style)
  if (target.children.includes(partNode)) return
  if (!removeFromUnits(symbolNode, partNode)) return
  target.children.push(partNode)
}

// ---------------------------------------------------------------------------
// Graphics (in the `_0_1` body unit sub-symbol)
// ---------------------------------------------------------------------------

export function addRectangle(
  symbolNode: SExprList,
  start: { x: Nm; y: Nm } = { x: mmToNm(-2.54), y: mmToNm(2.54) },
  end: { x: Nm; y: Nm } = { x: mmToNm(2.54), y: mmToNm(-2.54) },
  unitNumber = 0,
  /** `none` for a shape someone drew; **`background`** for an IC's body, which
   *  is what 97% of single-body rectangles in the standard library use — the
   *  filled outline is what makes a symbol read as a part rather than as a
   *  drawing. Defaults to `none` so the editor's rectangle tool is unchanged. */
  fill: 'none' | 'background' | 'outline' = 'none'
): SExprList {
  const unit = getOrCreateUnitNode(symbolNode, unitNumber, 1)
  const at = symbolNode.start
  const node = makeList(
    [
      makeAtom('rectangle', false, at),
      xyNode('start', start.x, start.y, at),
      xyNode('end', end.x, end.y, at),
      strokeNode(at),
      fillNode(at, fill)
    ],
    at
  )
  unit.children.push(node)
  return node
}

export function addPolyline(
  symbolNode: SExprList,
  points: Array<{ x: Nm; y: Nm }> = [
    { x: mmToNm(-2.54), y: nmv(0) },
    { x: mmToNm(2.54), y: nmv(0) }
  ],
  unitNumber = 0
): SExprList {
  const unit = getOrCreateUnitNode(symbolNode, unitNumber, 1)
  const at = symbolNode.start
  const pts = makeList(
    [makeAtom('pts', false, at), ...points.map((p) => xyNode('xy', p.x, p.y, at))],
    at
  )
  const node = makeList([makeAtom('polyline', false, at), pts, strokeNode(at), fillNode(at)], at)
  unit.children.push(node)
  return node
}

/**
 * Append a cubic Bezier: four control points in a `(pts …)` list, shaped exactly
 * like a polyline's, which is why every point-walking helper treats the two alike.
 */
export function addBezier(
  symbolNode: SExprList,
  points: Array<{ x: Nm; y: Nm }>,
  unitNumber = 0
): SExprList {
  const unit = getOrCreateUnitNode(symbolNode, unitNumber, 1)
  const at = symbolNode.start
  const pts = makeList(
    [makeAtom('pts', false, at), ...points.map((p) => xyNode('xy', p.x, p.y, at))],
    at
  )
  const node = makeList([makeAtom('bezier', false, at), pts, strokeNode(at), fillNode(at)], at)
  unit.children.push(node)
  return node
}

export function addCircle(
  symbolNode: SExprList,
  center: { x: Nm; y: Nm } = { x: nmv(0), y: nmv(0) },
  radius: Nm = mmToNm(1.27),
  unitNumber = 0
): SExprList {
  const unit = getOrCreateUnitNode(symbolNode, unitNumber, 1)
  const at = symbolNode.start
  const node = makeList(
    [
      makeAtom('circle', false, at),
      xyNode('center', center.x, center.y, at),
      makeList([makeAtom('radius', false, at), makeAtom(formatNmAtom(radius), false, at)], at),
      strokeNode(at),
      fillNode(at)
    ],
    at
  )
  unit.children.push(node)
  return node
}

/**
 * Append an arc, stored as KiCad does: the three points it passes through, in
 * `start`/`mid`/`end` order. `mid` is any point on the arc between the ends —
 * together they name exactly one circular arc, which is why no center or angle
 * is written and why a renderer derives both (`circleThroughPoints`).
 *
 * Three collinear points are allowed rather than rejected: they describe a
 * straight segment, both scenes already draw that case as a line, and it is what
 * an arc looks like before its bulge is set.
 */
export function addArc(
  symbolNode: SExprList,
  start: { x: Nm; y: Nm } = { x: mmToNm(-2.54), y: nmv(0) },
  mid: { x: Nm; y: Nm } = { x: nmv(0), y: mmToNm(2.54) },
  end: { x: Nm; y: Nm } = { x: mmToNm(2.54), y: nmv(0) },
  unitNumber = 0
): SExprList {
  const unit = getOrCreateUnitNode(symbolNode, unitNumber, 1)
  const at = symbolNode.start
  const node = makeList(
    [
      makeAtom('arc', false, at),
      xyNode('start', start.x, start.y, at),
      xyNode('mid', mid.x, mid.y, at),
      xyNode('end', end.x, end.y, at),
      strokeNode(at),
      fillNode(at)
    ],
    at
  )
  unit.children.push(node)
  return node
}

/**
 * Append a text item. Carries no stroke or fill — a text's weight is its font —
 * and its angle is written in **decidegrees**, KiCad's storage for symbol text
 * (the parser divides by 10, and `updateSymbolText` multiplies on the way back).
 */
export function addText(
  symbolNode: SExprList,
  text: string,
  position: { x: Nm; y: Nm; angle: number } = { x: nmv(0), y: nmv(0), angle: 0 },
  unitNumber = 0
): SExprList {
  const unit = getOrCreateUnitNode(symbolNode, unitNumber, 1)
  const at = symbolNode.start
  const node = makeList(
    [
      makeAtom('text', false, at),
      makeAtom(text, true, at),
      makeList(
        [
          makeAtom('at', false, at),
          makeAtom(formatNmAtom(position.x), false, at),
          makeAtom(formatNmAtom(position.y), false, at),
          makeAtom(String(Math.round(position.angle * 10)), false, at)
        ],
        at
      ),
      effectsNode(at)
    ],
    at
  )
  unit.children.push(node)
  return node
}

/**
 * Append a `(text_box …)` — a bordered box with text laid out inside it.
 *
 * `position` is the box's TOP-LEFT corner and `size.height` is negative for a
 * box that runs downward, which is what KiCad writes; the node is emitted in
 * KiCad's own child order so a diff against a hand-authored file stays quiet.
 * Unlike `addText`, the angle goes in as plain degrees — see
 * `ANGLE_ATOMS_PER_DEGREE`.
 *
 * Margins are written explicitly rather than left to the parser's default, so
 * the file states what the box does instead of relying on a value that lives
 * only in our reader.
 */
export function addTextBox(
  symbolNode: SExprList,
  text: string,
  position: { x: Nm; y: Nm; angle: number } = { x: nmv(0), y: nmv(0), angle: 0 },
  size: { width: Nm; height: Nm } = { width: mmToNm(10.16), height: mmToNm(-5.08) },
  unitNumber = 0,
  margins = DEFAULT_TEXT_BOX_MARGINS_NM
): SExprList {
  const unit = getOrCreateUnitNode(symbolNode, unitNumber, 1)
  const at = symbolNode.start
  const node = makeList(
    [
      makeAtom('text_box', false, at),
      makeAtom(text, true, at),
      makeList(
        [
          makeAtom('at', false, at),
          makeAtom(formatNmAtom(position.x), false, at),
          makeAtom(formatNmAtom(position.y), false, at),
          makeAtom(formatKicadNumber(position.angle), false, at)
        ],
        at
      ),
      xyNode('size', size.width, size.height, at),
      makeList(
        [
          makeAtom('margins', false, at),
          makeAtom(formatNmAtom(margins.left), false, at),
          makeAtom(formatNmAtom(margins.top), false, at),
          makeAtom(formatNmAtom(margins.right), false, at),
          makeAtom(formatNmAtom(margins.bottom), false, at)
        ],
        at
      ),
      strokeNode(at),
      fillNode(at),
      effectsNode(at)
    ],
    at
  )
  unit.children.push(node)
  return node
}

// ---------------------------------------------------------------------------
// Alternate pin functions — `(alternate "NAME" <type> <style>)`.
//
// A repeating child list, unlike every other pin property, which is why it needs
// add/remove as well as edit. KiCad authors these in the symbol editor's Pin
// Properties dialog; the schematic then picks one per placed instance.
// ---------------------------------------------------------------------------

/** The `(alternate …)` children of a pin, in file order — the panel's row order. */
export function pinAlternateNodes(pinNode: SExprList): SExprList[] {
  return findChildren(pinNode, 'alternate')
}

/**
 * Append an alternate. Defaults mirror a fresh pin's (`passive`/`line`) so a new
 * row is immediately valid, and the name is left to the caller because an
 * unnamed alternate is the one field that has no sensible default — it is the
 * whole point of the entry.
 */
export function addPinAlternate(
  pinNode: SExprList,
  name: string,
  electricalType = 'passive',
  graphicStyle = 'line'
): SExprList {
  const at = pinNode.start
  const node = makeList(
    [
      makeAtom('alternate', false, at),
      makeAtom(name, true, at),
      makeAtom(electricalType, false, at),
      makeAtom(graphicStyle, false, at)
    ],
    at
  )
  pinNode.children.push(node)
  return node
}

/** Drop the alternate at `index` (file order). Out of range is a no-op. */
export function removePinAlternate(pinNode: SExprList, index: number): void {
  const target = pinAlternateNodes(pinNode)[index]
  if (!target) return
  pinNode.children = pinNode.children.filter((c) => c !== target)
}

export interface PinAlternatePatch {
  name?: string
  electricalType?: string
  graphicStyle?: string
}

/**
 * Edit one alternate in place. Positional atoms, so each field writes its own
 * slot — 1 is the quoted name, 2 the electrical type, 3 the graphic style.
 */
export function updatePinAlternate(
  pinNode: SExprList,
  index: number,
  patch: PinAlternatePatch
): void {
  const target = pinAlternateNodes(pinNode)[index]
  if (!target) return
  if (patch.name !== undefined) setPositionalAtom(target, 1, patch.name, true)
  if (patch.electricalType !== undefined) setPositionalAtom(target, 2, patch.electricalType, false)
  if (patch.graphicStyle !== undefined) setPositionalAtom(target, 3, patch.graphicStyle, false)
}

/** Remove a graphic from its unit sub-symbol. */
export function deleteGraphic(symbolNode: SExprList, graphicNode: SExprList): void {
  removeFromUnits(symbolNode, graphicNode)
}

// ---------------------------------------------------------------------------
// Symbols (on the library root)
// ---------------------------------------------------------------------------

/**
 * Append a minimal valid symbol definition and return its node. Empty `_0_1`
 * and `_1_1` unit sub-symbols are scaffolded so later add-graphic / add-pin
 * calls have insertion targets.
 */
export function addSymbol(root: SExprList, name: string): SExprList {
  const at = root.start
  const property = (key: string, value: string): SExprList => {
    const prop = makeList(
      [
        makeAtom('property', false, at),
        makeAtom(key, true, at),
        makeAtom(value, true, at),
        makeList(
          [
            makeAtom('at', false, at),
            makeAtom('0', false, at),
            makeAtom('0', false, at),
            makeAtom('0', false, at)
          ],
          at
        ),
        effectsNode(at)
      ],
      at
    )
    return prop
  }
  const node = makeList(
    [
      makeAtom('symbol', false, at),
      makeAtom(name, true, at),
      makeList(
        [
          makeAtom('pin_names', false, at),
          makeList([makeAtom('offset', false, at), makeAtom('0.508', false, at)], at)
        ],
        at
      ),
      makeList([makeAtom('in_bom', false, at), makeAtom('yes', false, at)], at),
      makeList([makeAtom('on_board', false, at), makeAtom('yes', false, at)], at),
      property('Reference', 'U'),
      property('Value', name),
      makeList([makeAtom('symbol', false, at), makeAtom(`${name}_0_1`, true, at)], at),
      makeList([makeAtom('symbol', false, at), makeAtom(`${name}_1_1`, true, at)], at)
    ],
    at
  )
  root.children.push(node)
  return node
}

/** Remove a top-level symbol from the library root. */
export function removeSymbol(root: SExprList, symbolNode: SExprList): void {
  const idx = root.children.indexOf(symbolNode)
  if (idx !== -1) root.children.splice(idx, 1)
}

// ---------------------------------------------------------------------------
// Node enumeration + translation — the canvas selects by index, and these
// resolve those indices back to real nodes in the SAME order the typed views
// (KicadLibSymbol.variants) parse them, so index N in the scene is index N here.
// ---------------------------------------------------------------------------

/** Pin nodes across all unit sub-symbols, in document order. */
export function symbolPinNodes(symbolNode: SExprList): SExprList[] {
  return unitSubSymbols(symbolNode).flatMap((unit) => findChildren(unit, 'pin'))
}

/** Graphic nodes (rectangle/polyline/circle/arc/text) across units, in order. */
export function symbolGraphicNodes(symbolNode: SExprList): SExprList[] {
  return unitSubSymbols(symbolNode).flatMap((unit) =>
    unit.children.filter(
      (child): child is SExprList =>
        child.type === 'list' && GRAPHIC_TOKENS.has(getToken(child) ?? '')
    )
  )
}

// ---------------------------------------------------------------------------
// Addressing parts by name
// ---------------------------------------------------------------------------

/**
 * A part of the symbol being edited, named the way the renderer names it.
 *
 * The editor works on ONE definition, so the renderer's `SymbolPartRef` fields
 * that identify a definition (`source`, `depth`) are constant here and left
 * off; what remains is the same idea — which unit sub-symbol, and where within
 * it. See ARCHITECTURE.md §3.7.
 *
 * A flat cross-unit index is fragile: it depends on how many parts every
 * EARLIER unit has, so adding a pin to unit 1 silently renumbers every part of
 * unit 2. A name is stable because it describes where the part lives rather
 * than how many things precede it.
 */
export interface SymbolPartAddress {
  kind: 'pin' | 'graphic' | 'field'
  unit: number
  style: number
  /** Position among same-kind parts within that one unit sub-symbol. */
  index: number
  /**
   * Which field, when `kind` is `'field'` — the property KEY, and the whole of
   * a field's identity (`unit`/`style`/`index` are all zero, since a property
   * hangs off the top symbol node). Named rather than indexed because the
   * fields editor reorders properties, which would retarget a live selection.
   */
  field?: string
}

/** Parts of `unitNode` of one kind, in document order. */
const partsOfUnit = (unitNode: SExprList, kind: 'pin' | 'graphic'): SExprList[] =>
  kind === 'pin'
    ? findChildren(unitNode, 'pin')
    : unitNode.children.filter(
        (child): child is SExprList =>
          child.type === 'list' && GRAPHIC_TOKENS.has(getToken(child) ?? '')
      )

/** The unit sub-symbol carrying `(unit, style)`, or null. */
const unitNodeAt = (symbolNode: SExprList, unit: number, style: number): SExprList | null => {
  for (const node of unitSubSymbols(symbolNode)) {
    const suffix = parseVariantSuffix(getFirstAtomValue(node) ?? '')
    if (suffix && suffix.unit === unit && suffix.style === style) return node
  }
  return null
}

/** The node a name addresses, or null if the symbol has no such part. */
export function symbolPartNode(
  symbolNode: SExprList,
  address: SymbolPartAddress
): SExprList | null {
  // A field lives on the top symbol node, not in a unit.
  if (address.kind === 'field') {
    return address.field ? symbolPropertyNode(symbolNode, address.field) : null
  }
  const unit = unitNodeAt(symbolNode, address.unit, address.style)
  if (!unit) return null
  return partsOfUnit(unit, address.kind)[address.index] ?? null
}

/** Every part's name, in the order the units are written. */
export function symbolPartAddresses(symbolNode: SExprList): SymbolPartAddress[] {
  const addresses: SymbolPartAddress[] = []
  for (const unitNode of unitSubSymbols(symbolNode)) {
    // A name this cannot read is a part nothing can address — see
    // `parseVariantSuffix` on why the renderer's fallback differs.
    const suffix = parseVariantSuffix(getFirstAtomValue(unitNode) ?? '')
    if (!suffix) continue
    for (const kind of ['graphic', 'pin'] as const) {
      partsOfUnit(unitNode, kind).forEach((_, index) => addresses.push({ kind, ...suffix, index }))
    }
  }
  return addresses
}

/** The name of a node already in hand — the inverse of `symbolPartNode`. */
export function addressOfPartNode(
  symbolNode: SExprList,
  node: SExprList
): SymbolPartAddress | null {
  for (const address of symbolPartAddresses(symbolNode)) {
    if (symbolPartNode(symbolNode, address) === node) return address
  }
  return null
}

/**
 * A name as one opaque string, for the places that need a Map key or must hand
 * a selection through `ViewportEngine`'s `(type, index)` callbacks. Nothing
 * parses it back — carry the address itself instead. A field spells its key,
 * since every field shares unit 0 / style 0 / index 0.
 */
export const addressKey = (a: SymbolPartAddress): string =>
  a.kind === 'field' ? `field:${a.field ?? ''}` : `${a.kind}:${a.unit}.${a.style}.${a.index}`

/**
 * Whether two names refer to the same part. Compares the KEY, not the fields
 * one by one: that would call every field equal (all are unit 0/style 0/index 0).
 */
export const sameAddress = (a: SymbolPartAddress, b: SymbolPartAddress): boolean =>
  addressKey(a) === addressKey(b)

/** The typed variant a name lives in, or null. */
const variantAt = (symbol: KicadLibSymbol, a: SymbolPartAddress): SymbolVariant | undefined =>
  symbol.variants.find((v) => v.unit === a.unit && v.style === a.style)

/**
 * The typed value a name addresses — the counterpart of `symbolPartNode`, which
 * resolves the same name to its AST node. The typed views and the node lists
 * are both built by walking unit sub-symbols in document order, so a name
 * resolves consistently through either.
 */
export function symbolPartPin(symbol: KicadLibSymbol, a: SymbolPartAddress): SymbolPin | null {
  if (a.kind !== 'pin') return null
  return variantAt(symbol, a)?.pins[a.index] ?? null
}

export function symbolPartGraphic(
  symbol: KicadLibSymbol,
  a: SymbolPartAddress
): SymbolGraphic | null {
  if (a.kind !== 'graphic') return null
  return variantAt(symbol, a)?.graphics[a.index] ?? null
}

const atomNum = (node: SExprList | null, index: number, fallback = 0): number => {
  const atom = node?.children[index]
  if (!atom || atom.type !== 'atom') return fallback
  const n = Number(atom.value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * The distance twin of `atomNum`: read a millimeter atom as integer nanometers.
 * `atomNum` stays for the slots that are NOT distances — angle atoms.
 */
const atomNm = (node: SExprList | null, index: number, fallback: Nm = nmv(0)): Nm => {
  const atom = node?.children[index]
  if (!atom || atom.type !== 'atom') return fallback
  const n = mmAtomToNm(atom.value)
  return Number.isFinite(n) ? n : fallback
}

/** Shift a pin's `(at x y a)` by (dx, dy), preserving its angle. */
export function translatePinNode(pinNode: SExprList, dx: Nm, dy: Nm): void {
  const at = findChild(pinNode, 'at')
  const angle = at && at.children[3]?.type === 'atom' ? Number(at.children[3].value) : undefined
  setAtChildNm(pinNode, nm(atomNm(at, 1) + dx), nm(atomNm(at, 2) + dy), angle)
}

/**
 * Move a field by a delta — the one whole-item transform a field takes part in.
 * Delete/rotate/duplicate never see a field, since they resolve targets by
 * `'pin' | 'graphic'`; structural edits belong to the fields editor.
 */
export function translateSymbolPropertyNode(node: SExprList, dx: Nm, dy: Nm): void {
  const at = findChild(node, 'at')
  setAtChildNm(node, nm(atomNm(at, 1) + dx), nm(atomNm(at, 2) + dy), atomNum(at, 3))
}

export interface Point2 {
  x: number
  y: number
}

/**
 * Map every anchor point a graphic carries through `fn`, in place. All the
 * whole-item transforms (translate / rotate / mirror) are this walk plus a
 * different point function — the per-primitive knowledge lives here once.
 *
 * A circle's radius, and a rectangle's axis-alignment under quarter-turns, are
 * preserved by construction, so no primitive needs special-casing beyond its
 * anchor list.
 */
function mapGraphicPoints(graphicNode: SExprList, fn: (p: Point2) => Point2): void {
  const mapXY = (token: string): void => {
    const node = findChild(graphicNode, token)
    if (!node) return
    const next = fn({ x: atomNm(node, 1), y: atomNm(node, 2) })
    // `at` nodes carry a trailing angle atom; setXYChildNm updates x/y in place
    // and leaves it, so text keeps its rotation.
    setXYChildNm(graphicNode, token, nm(next.x), nm(next.y))
  }
  switch (getToken(graphicNode)) {
    case 'rectangle':
      mapXY('start')
      mapXY('end')
      break
    case 'circle':
      mapXY('center')
      break
    case 'arc':
      mapXY('start')
      mapXY('mid')
      mapXY('end')
      break
    // For `text_box`: its `(size …)` is an EXTENT, not a point, so only the
    // anchor maps. Translation is therefore complete here; rotation and
    // mirroring finish the job by turning the stored angle, below.
    case 'text':
    case 'text_box':
      mapXY('at')
      break
    case 'polyline':
    case 'bezier': {
      const pts = findChild(graphicNode, 'pts')
      if (pts) {
        setPointsChildNm(
          graphicNode,
          findChildren(pts, 'xy').map((xy) => {
            const next = fn({ x: atomNm(xy, 1), y: atomNm(xy, 2) })
            return { x: nm(next.x), y: nm(next.y) }
          })
        )
      }
      break
    }
  }
}

/** Shift a graphic by (dx, dy), moving whichever anchor points it carries. */
export function translateGraphicNode(graphicNode: SExprList, dx: Nm, dy: Nm): void {
  mapGraphicPoints(graphicNode, (p) => ({ x: p.x + dx, y: p.y + dy }))
}

/**
 * The `ki_*` properties KiCad keeps as symbol data rather than as fields. It
 * writes them back at the origin whatever the anchor did, so moving the anchor
 * leaves them where they are.
 */
const NON_FIELD_PROPERTY_KEYS = new Set(['ki_keywords', 'ki_fp_filters', 'ki_locked'])

/**
 * KiCad's Move Symbol Anchor: make `anchor` the symbol's origin by shifting
 * everything the other way — every pin and graphic in every unit and body style
 * (and any drawn on the symbol node itself), and every field. What a placement
 * hangs from, and rotates about, is the origin. False when `anchor` is already
 * the origin, so the caller records no empty step.
 */
export function moveSymbolAnchor(symbolNode: SExprList, anchor: { x: Nm; y: Nm }): boolean {
  if (anchor.x === 0 && anchor.y === 0) return false
  const dx = nmv(0 - anchor.x)
  const dy = nmv(0 - anchor.y)
  for (const holder of [symbolNode, ...unitSubSymbols(symbolNode)]) {
    for (const pin of partsOfUnit(holder, 'pin')) translatePinNode(pin, dx, dy)
    for (const graphic of partsOfUnit(holder, 'graphic')) translateGraphicNode(graphic, dx, dy)
  }
  for (const property of propertyNodes(symbolNode)) {
    if (!NON_FIELD_PROPERTY_KEYS.has(propertyKey(property))) {
      translateSymbolPropertyNode(property, dx, dy)
    }
  }
  return true
}

/** Degrees into [0, 360). */
export const normalizeAngle = (angle: number): number => ((angle % 360) + 360) % 360

/**
 * Symbol space is y-up, so a counter-clockwise quarter turn is (x, y) → (-y, x)
 * — matching KiCad's R, which rotates counter-clockwise.
 */
export const rotatePoint = (p: Point2, pivot: Point2, quarterTurns: number): Point2 => {
  let { x, y } = { x: p.x - pivot.x, y: p.y - pivot.y }
  for (let i = 0; i < normalizeAngle(quarterTurns * 90) / 90; i++) {
    ;[x, y] = [-y, x]
  }
  return { x: x + pivot.x, y: y + pivot.y }
}

/**
 * A world point expressed in the frame of something rotated by `angleDegrees`
 * about `pivot` — the inverse of how a `text_box` places its corners. Free
 * rotation, not the quarter turns `rotatePoint` handles, because a box's stored
 * angle is arbitrary.
 */
export const unrotateAbout = (p: Point2, pivot: Point2, angleDegrees: number): Point2 => {
  const angle = (-angleDegrees * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = p.x - pivot.x
  const dy = p.y - pivot.y
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos }
}

/** `horizontal` flips left↔right (negates x); `vertical` flips top↔bottom. */
export type MirrorAxis = 'horizontal' | 'vertical'

export const mirrorPoint = (p: Point2, pivot: Point2, axis: MirrorAxis): Point2 =>
  axis === 'horizontal' ? { x: 2 * pivot.x - p.x, y: p.y } : { x: p.x, y: 2 * pivot.y - p.y }

/** A pin/text heading, mirrored: right↔left across a vertical flip line, etc. */
export const mirrorAngle = (angle: number, axis: MirrorAxis): number =>
  normalizeAngle(axis === 'horizontal' ? 180 - angle : -angle)

/** The `(at x y a)` angle of a pin or text node; 0 when absent. */
const nodeAngle = (node: SExprList): number => {
  const at = findChild(node, 'at')
  return at && at.children[3]?.type === 'atom' ? Number(at.children[3].value) || 0 : 0
}

/** Rotate a pin about `pivot`, turning its heading with it. */
export function rotatePinNode(pinNode: SExprList, pivot: Point2, quarterTurns = 1): void {
  const at = findChild(pinNode, 'at')
  const moved = rotatePoint({ x: atomNm(at, 1), y: atomNm(at, 2) }, pivot, quarterTurns)
  setAtChildNm(
    pinNode,
    nm(moved.x),
    nm(moved.y),
    normalizeAngle(nodeAngle(pinNode) + quarterTurns * 90)
  )
}

/**
 * Atoms per degree in a graphic's `(at x y angle)`, by token — and the reason
 * this table exists rather than a boolean.
 *
 * A symbol `(text …)` stores **decidegrees** (KiCad writes `900` for a quarter
 * turn) while a `(text_box …)` stores plain **degrees** (`90`), verified against
 * KiCad 10. Two identically shaped nodes, two units. Graphics not listed carry
 * no angle at all.
 *
 * Rotate and mirror below both read through this table, matching the scaling
 * `updateSymbolText` already applies.
 */
const ANGLE_ATOMS_PER_DEGREE: Record<string, number> = { text: 10, text_box: 1 }

/**
 * Snap a transformed symbol `(text …)` angle onto the axis it landed on — 0 or
 * 90, never 180 or 270.
 *
 * KiCad's symbol text angle is two-state, not a free rotation: probed with
 * `kicad-cli sym export svg`, a `(text …)` plots horizontal at exactly 0 and
 * vertical bottom→top at *every* other angle (`900`, `1800`, `2700`, `450`
 * alike). So mirroring leaves a text's reading direction alone and rotating
 * toggles it, and an off-axis angle snaps onto an axis the first time the text
 * is transformed. `(text_box …)` is genuinely free-angle — the same probe draws
 * one at 180 upside down — so this applies to `text` only.
 */
export const snapSymbolTextAngle = (degrees: number): number =>
  normalizeAngle(degrees) % 180 === 0 ? 0 : 90

/** Post-transform angle policy by token: two-state for text, free otherwise. */
const transformedGraphicAngle = (token: string, degrees: number): number =>
  token === 'text' ? snapSymbolTextAngle(degrees) : normalizeAngle(degrees)

/** Read a graphic's angle in DEGREES, whatever unit its token stores. */
const graphicAngleDegrees = (graphicNode: SExprList, scale: number): number =>
  nodeAngle(graphicNode) / scale

/** Write a graphic's angle back in its own unit, rounding to a whole atom. */
const setGraphicAngle = (graphicNode: SExprList, degrees: number, scale: number): void => {
  const at = findChild(graphicNode, 'at')
  if (!at) return
  setAtChildNm(graphicNode, atomNm(at, 1), atomNm(at, 2), Math.round(degrees * scale))
}

/** Rotate a graphic about `pivot`; text keeps its heading aligned with the turn. */
export function rotateGraphicNode(graphicNode: SExprList, pivot: Point2, quarterTurns = 1): void {
  const token = getToken(graphicNode) ?? ''
  const scale = ANGLE_ATOMS_PER_DEGREE[token]
  const angle = scale ? graphicAngleDegrees(graphicNode, scale) : 0
  mapGraphicPoints(graphicNode, (p) => rotatePoint(p, pivot, quarterTurns))
  if (scale) {
    setGraphicAngle(graphicNode, transformedGraphicAngle(token, angle + quarterTurns * 90), scale)
  }
}

/** Mirror a pin about `pivot`, flipping the direction it points. */
export function mirrorPinNode(pinNode: SExprList, pivot: Point2, axis: MirrorAxis): void {
  const at = findChild(pinNode, 'at')
  const moved = mirrorPoint({ x: atomNm(at, 1), y: atomNm(at, 2) }, pivot, axis)
  setAtChildNm(pinNode, nm(moved.x), nm(moved.y), mirrorAngle(nodeAngle(pinNode), axis))
}

/**
 * Mirror a graphic about `pivot`. Arcs stay valid because KiCad defines them by
 * three points on the curve — mirroring all three describes the mirrored arc,
 * reversed winding and all.
 */
export function mirrorGraphicNode(graphicNode: SExprList, pivot: Point2, axis: MirrorAxis): void {
  const token = getToken(graphicNode) ?? ''
  const scale = ANGLE_ATOMS_PER_DEGREE[token]
  const angle = scale ? graphicAngleDegrees(graphicNode, scale) : 0
  mapGraphicPoints(graphicNode, (p) => mirrorPoint(p, pivot, axis))
  if (scale) {
    setGraphicAngle(graphicNode, transformedGraphicAngle(token, mirrorAngle(angle, axis)), scale)
  }
}

// ---------------------------------------------------------------------------
// Units — the gates/sections of a multi-unit package (a quad NAND is four).
//
// Unit 0 is the body common to every unit; units 1..N are the gates. There is
// no unit-count field in the format: the count is implied by which sub-symbols
// exist, so adding a unit means creating its sub-symbol. KiCad shows units as
// letters (A, B, C…), matching the U1A/U1B reference suffix.
// ---------------------------------------------------------------------------

/**
 * `(unit, style)` of a `<name>_<unit>_<style>` sub-symbol, or null.
 *
 * Strips the parent's name before matching rather than reading the trailing
 * digits of the whole string, which `parseVariantSuffix` does — a symbol whose
 * own name ends in digits (`Raspberry_Pi_2_3`) reads as a variant otherwise.
 */
const variantOfSubSymbol = (
  symbolNode: SExprList,
  unitNode: SExprList
): { unit: number; style: number } | null => {
  const name = getFirstAtomValue(unitNode) ?? ''
  const suffix = name.slice(unitBaseName(symbolNode).length)
  const match = /^_(\d+)_(\d+)$/.exec(suffix)
  return match ? { unit: Number(match[1]), style: Number(match[2]) } : null
}

const unitOfSubSymbol = (symbolNode: SExprList, unitNode: SExprList): number | null =>
  variantOfSubSymbol(symbolNode, unitNode)?.unit ?? null

/** Every unit number present, ascending. Unit 0 (the common body) included. */
export function symbolUnitNumbers(symbolNode: SExprList): number[] {
  const seen = new Set<number>()
  for (const unitNode of unitSubSymbols(symbolNode)) {
    const unit = unitOfSubSymbol(symbolNode, unitNode)
    if (unit !== null) seen.add(unit)
  }
  return [...seen].sort((a, b) => a - b)
}

/** How many gates the package has: the highest unit number, 1 at minimum. */
export function symbolUnitCount(symbolNode: SExprList): number {
  return Math.max(1, ...symbolUnitNumbers(symbolNode))
}

/**
 * Every body style present, ascending — style 0 (common to all styles) excluded,
 * since it is not a style you can view on its own.
 *
 * Derived from the sub-symbols that EXIST rather than from the symbol's own
 * `(body_styles …)` declaration, which the standard library shows can disagree
 * with them: `Interface:LTC1519` declares `demorgan` (two styles) and ships a
 * `_3_3` sub-symbol. Trusting the declaration would hide real geometry.
 */
export function symbolBodyStyleNumbers(symbolNode: SExprList): number[] {
  const seen = new Set<number>()
  for (const unitNode of unitSubSymbols(symbolNode)) {
    const variant = variantOfSubSymbol(symbolNode, unitNode)
    if (variant && variant.style > 0) seen.add(variant.style)
  }
  return [...seen].sort((a, b) => a - b)
}

/** How many body styles the symbol draws: the highest style number, 1 at minimum. */
export function symbolBodyStyleCount(symbolNode: SExprList): number {
  return Math.max(1, ...symbolBodyStyleNumbers(symbolNode))
}

/** KiCad 7+ `(unit_name "…")` on a unit sub-symbol — e.g. "NMOS"/"PMOS". */
export function symbolUnitName(symbolNode: SExprList, unitNumber: number): string | null {
  for (const unitNode of unitSubSymbols(symbolNode)) {
    if (unitOfSubSymbol(symbolNode, unitNode) !== unitNumber) continue
    const nameNode = findChild(unitNode, 'unit_name')
    const value = nameNode ? getAtomValues(nameNode)[0] : undefined
    if (value) return value
  }
  return null
}

/** KiCad's display letter for a unit: 1 → A, 2 → B, … */
export function unitLetter(unitNumber: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + Math.max(0, unitNumber - 1))
}

/** Scaffold the next unit's sub-symbol and return its number. */
export function addUnit(symbolNode: SExprList): number {
  const next = symbolUnitCount(symbolNode) + 1
  getOrCreateUnitNode(symbolNode, next, 1)
  return next
}

/**
 * Drop every sub-symbol of `unitNumber` — its geometry goes with it, which is
 * why the caller runs this through the undo layer. Unit 0 is never removable:
 * it is the shared body, not a gate.
 */
export function removeUnit(symbolNode: SExprList, unitNumber: number): void {
  if (unitNumber <= 0) return
  symbolNode.children = symbolNode.children.filter(
    (child) =>
      !(
        child.type === 'list' &&
        getToken(child) === 'symbol' &&
        unitOfSubSymbol(symbolNode, child) === unitNumber
      )
  )
}

// ---------------------------------------------------------------------------
// Copying items — duplicate within a symbol, and paste across symbols.
// ---------------------------------------------------------------------------

/** The unit sub-symbol directly holding `node`, or null when it holds none. */
export function owningUnitNode(symbolNode: SExprList, node: SExprNode): SExprList | null {
  return unitSubSymbols(symbolNode).find((unit) => unit.children.includes(node)) ?? null
}

/**
 * Where a node of this kind belongs when its own unit is unknown — pasting from
 * another symbol, say. KiCad's convention: pins in `_1_1`, body graphics in
 * `_0_1` (the unit-0 common body).
 */
export function defaultUnitNodeFor(symbolNode: SExprList, node: SExprList): SExprList {
  return getToken(node) === 'pin'
    ? getOrCreateUnitNode(symbolNode, 1, 1)
    : getOrCreateUnitNode(symbolNode, 0, 1)
}

/** Deep-clone `node` and append the copy to `unitNode`; returns the clone. */
export function appendNodeCopy(unitNode: SExprList, node: SExprList): SExprList {
  const clone = cloneNodeDeep(node) as SExprList
  unitNode.children.push(clone)
  return clone
}

/**
 * Highest integer pin number in the symbol, or 0 when none parse as integers —
 * the base for auto-incrementing numbers on a duplicate, so copying a pin row
 * doesn't produce a symbol full of duplicate pin numbers.
 */
export function maxPinNumber(symbolNode: SExprList): number {
  let max = 0
  for (const pin of symbolPinNodes(symbolNode)) {
    const textNode = findChild(pin, 'number')
    const value = textNode ? getAtomValues(textNode)[0] : undefined
    const parsed = value === undefined ? NaN : parseInt(value, 10)
    if (Number.isFinite(parsed)) max = Math.max(max, parsed)
  }
  return max
}

/**
 * Step a pin's number or name on by `by`, KiCad's repeat rule: the trailing
 * integer moves and everything before it is left alone, so `1` → `2`, `D0` → `D1`
 * and `A12` → `A13`. A label with no trailing digits (`~`, `VCC`, `GND`) has
 * nothing to step and comes back unchanged, which is what makes it safe to run
 * over a pin's NAME as well as its number.
 *
 * Zero padding is preserved at the width it was written (`D00` → `D01`), because
 * a padded row is padded for alignment and losing it mid-row would look like a
 * mistake. A width that genuinely overflows simply grows (`D09` → `D10`).
 */
export function incrementPinLabel(label: string, by: number): string {
  const match = /^(.*?)(\d+)$/.exec(label)
  if (!match) return label
  const [, prefix, digits] = match
  const next = parseInt(digits, 10) + by
  if (next < 0) return label
  return `${prefix}${String(next).padStart(digits.length, '0')}`
}

/**
 * Repeat `source`: cloned into its own unit, moved by `offset`, with a pin's
 * number and name stepped on by `numberDelta`. Graphics carry no number, so
 * `numberDelta` is ignored for them.
 *
 * Numbering steps from the SOURCE pin rather than from the symbol's current
 * maximum, which is the deliberate difference from `insertCopies`. A repeat
 * continues the row it is extending — repeat pin 7 and you want 8, not
 * "one more than the highest number anywhere in the symbol", which would jump
 * the moment you extend a row in the middle of a part that already has pins.
 */
export function appendRepeatCopy(
  symbolNode: SExprList,
  source: SExprList,
  offset: { x: Nm; y: Nm },
  numberDelta: number
): SExprList {
  const unit = owningUnitNode(symbolNode, source) ?? defaultUnitNodeFor(symbolNode, source)
  const clone = appendNodeCopy(unit, source)
  if (getToken(clone) !== 'pin') {
    translateGraphicNode(clone, offset.x, offset.y)
    return clone
  }
  translatePinNode(clone, offset.x, offset.y)
  const labelOf = (token: 'name' | 'number'): string | undefined => {
    const textNode = findChild(source, token)
    return textNode ? getAtomValues(textNode)[0] : undefined
  }
  const name = labelOf('name')
  const number = labelOf('number')
  updatePin(clone, {
    name: name === undefined ? undefined : incrementPinLabel(name, numberDelta),
    number: number === undefined ? undefined : incrementPinLabel(number, numberDelta)
  })
  return clone
}

export interface SymbolBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * The points that bound a pin: its anchor and its far end. One definition,
 * because both the transform pivot and the canvas selection rectangle have to
 * agree about how far a pin reaches.
 */
export function pinExtentPoints(pin: SymbolPin): Point2[] {
  const radians = (pin.position.angle * Math.PI) / 180
  return [
    { x: pin.position.x, y: pin.position.y },
    {
      x: pin.position.x + Math.cos(radians) * pin.length,
      y: pin.position.y + Math.sin(radians) * pin.length
    }
  ]
}

/** The points that bound a graphic — the per-primitive half of the same rule. */
export function graphicExtentPoints(graphic: SymbolGraphic): Point2[] {
  switch (graphic.type) {
    case 'rectangle':
      return [graphic.start, graphic.end]
    case 'circle':
      return [
        { x: graphic.center.x - graphic.radius, y: graphic.center.y - graphic.radius },
        { x: graphic.center.x + graphic.radius, y: graphic.center.y + graphic.radius }
      ]
    case 'arc':
      return [graphic.start, graphic.mid, graphic.end]
    // Control points, for both: they bound the curve (a Bezier never leaves its
    // control hull) and they are exactly what a drag should move.
    case 'line':
    case 'bezier':
      return graphic.points
    case 'text':
      return [graphic.position]
    // The border's four corners, rotated — a box is as big as it draws, and its
    // top-left anchor alone would under-report it by the whole box.
    case 'textBox':
      return textBoxCornerPoints(graphic)
  }
}

/**
 * Bounds of the given pins and graphics in symbol space, or null when the set
 * is empty. Transforms rotate and mirror about the center of this box, which is
 * what KiCad's symbol editor does with a multi-item selection.
 *
 * A pin spans from its anchor to its far end, so a rotated selection of one pin
 * pivots about the middle of the pin rather than its connection point.
 */
export function symbolItemsBounds(
  pins: SymbolPin[],
  graphics: SymbolGraphic[]
): SymbolBounds | null {
  const points: Point2[] = [
    ...pins.flatMap(pinExtentPoints),
    ...graphics.flatMap(graphicExtentPoints)
  ]
  if (points.length === 0) return null
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y))
  }
}

/**
 * The stored point a graphic is positioned BY, when the drawing itself does not
 * reveal it — what the canvas marks with an anchor cross while it is selected.
 *
 * Only a text has one. Its glyphs lay out *relative* to `(at …)` per
 * horizontal/vertical justification, so the same coordinates put the string in
 * visibly different places, and that point is also its rotation pivot. Every
 * other symbol graphic is defined by points that are already on the shape —
 * corners, a center, an arc's three points — and a `(text_box …)`'s `at` is its
 * top-left CORNER, drawn by its own border and already carrying a handle.
 */
export function graphicAnchorPoint(graphic: SymbolGraphic): Point2 | null {
  return graphic.type === 'text' ? graphic.position : null
}

/**
 * The draggable vertices of a graphic, in the order the canvas indexes them.
 * A circle's second handle sits on its rim: dragging it sets the radius, which
 * is the only way to resize a circle that doesn't need two numbers typed.
 *
 * A text's one point is its anchor, so the canvas draws no handle on it and
 * marks it with an anchor cross instead (`graphicAnchorPoint`) — a square means
 * resize here, and writing that point moves the text.
 */
export function graphicVertexPoints(graphic: SymbolGraphic): Point2[] {
  switch (graphic.type) {
    case 'rectangle':
      return [graphic.start, graphic.end]
    case 'circle':
      return [graphic.center, { x: graphic.center.x + graphic.radius, y: graphic.center.y }]
    case 'arc':
      return [graphic.start, graphic.mid, graphic.end]
    // Control points, for both: they bound the curve (a Bezier never leaves its
    // control hull) and they are exactly what a drag should move.
    case 'line':
    case 'bezier':
      return graphic.points
    case 'text':
      return [graphic.position]
    // Two handles, like a rectangle: the `at` corner and the one across the
    // diagonal. Placed (rotated) so a handle renders on the corner it drags —
    // `textBoxCornerPoints` returns them in winding order, so 0 and 2 are the
    // opposite pair.
    case 'textBox': {
      const corners = textBoxCornerPoints(graphic)
      return [corners[0], corners[2]]
    }
  }
}

/**
 * Move one vertex of a graphic. Index order matches `graphicVertexPoints`, so
 * the handle the user grabbed and the node this writes cannot disagree.
 */
export function setGraphicVertex(
  graphicNode: SExprList,
  vertexIndex: number,
  point: { x: Nm; y: Nm }
): void {
  switch (getToken(graphicNode)) {
    case 'rectangle': {
      // Indexed like every other primitive: out of range is a no-op, not a
      // silent write to the last corner.
      const token = ['start', 'end'][vertexIndex]
      if (token) setXYChildNm(graphicNode, token, point.x, point.y)
      return
    }
    case 'arc': {
      const token = ['start', 'mid', 'end'][vertexIndex]
      if (token) setXYChildNm(graphicNode, token, point.x, point.y)
      return
    }
    case 'circle': {
      if (vertexIndex === 0) {
        setXYChildNm(graphicNode, 'center', point.x, point.y)
        return
      }
      const center = findChild(graphicNode, 'center')
      const radius = nm(Math.hypot(point.x - atomNm(center, 1), point.y - atomNm(center, 2)))
      setScalarChild(graphicNode, 'radius', formatNmAtom(radius))
      return
    }
    case 'polyline':
    case 'bezier': {
      const pts = findChild(graphicNode, 'pts')
      if (!pts) return
      const points = findChildren(pts, 'xy').map((xy) => ({
        x: atomNm(xy, 1),
        y: atomNm(xy, 2)
      }))
      if (vertexIndex < 0 || vertexIndex >= points.length) return
      points[vertexIndex] = point
      setPointsChildNm(graphicNode, points)
      return
    }
    case 'text':
      setXYChildNm(graphicNode, 'at', point.x, point.y)
      return
    case 'text_box': {
      // A box is stored as an anchor plus an extent, not two corners, so a
      // corner drag has to write whichever of the two the handle stands for:
      // the far corner just resizes, the anchor corner moves AND resizes so the
      // far corner stays where it was.
      //
      // Computed in the box's own unrotated frame. At angle 0 — every box in the
      // standard library but one — that is the rectangle case exactly; on a
      // rotated box the anchor is also the pivot, so moving it swings the far
      // corner rather than pinning it. Documented rather than fudged.
      const at = findChild(graphicNode, 'at')
      const size = findChild(graphicNode, 'size')
      if (!at || !size) return
      const origin = { x: atomNm(at, 1), y: atomNm(at, 2) }
      const extent = { x: atomNm(size, 1), y: atomNm(size, 2) }
      const local = unrotateAbout(point, origin, nodeAngle(graphicNode))
      if (vertexIndex === 0) {
        const far = { x: origin.x + extent.x, y: origin.y + extent.y }
        setXYChildNm(graphicNode, 'at', nm(local.x), nm(local.y))
        setXYChildNm(graphicNode, 'size', nm(far.x - local.x), nm(far.y - local.y))
        return
      }
      if (vertexIndex === 1) {
        setXYChildNm(graphicNode, 'size', nm(local.x - origin.x), nm(local.y - origin.y))
      }
    }
  }
}

/** Center of `bounds` — the pivot every selection transform turns about. */
export const boundsCenter = (bounds: SymbolBounds): Point2 => ({
  x: (bounds.minX + bounds.maxX) / 2,
  y: (bounds.minY + bounds.maxY) / 2
})

// ---------------------------------------------------------------------------
// Field-level geometry / stroke / fill edits (the property table's write path).
// Each patch is partial — omitted coordinates keep their current value.
// ---------------------------------------------------------------------------

/** Set a `(<token> x y)` child, keeping whichever coordinate the patch omits. */
const patchXY = (node: SExprList, token: string, x?: Nm, y?: Nm): void => {
  const cur = findChild(node, token)
  setXYChildNm(node, token, x ?? atomNm(cur, 1), y ?? atomNm(cur, 2))
}

/** Set the stroke width, creating the `(stroke …)` child when absent. */
export function setGraphicStroke(node: SExprList, width: Nm): void {
  let stroke = findChild(node, 'stroke')
  if (!stroke) {
    stroke = strokeNode(node.start)
    node.children.push(stroke)
  }
  setScalarChild(stroke, 'width', formatNmAtom(width))
}

/** Set the fill kind (`none`/`outline`/`background`), creating `(fill …)` if absent. */
export function setGraphicFill(node: SExprList, kind: string): void {
  const fill = findChild(node, 'fill')
  if (!fill) node.children.push(fillNode(node.start, kind))
  else setScalarChild(fill, 'type', kind)
}

/** The `(stroke …)` child, created (with defaults) when absent. */
const ensureStroke = (node: SExprList): SExprList => {
  let stroke = findChild(node, 'stroke')
  if (!stroke) {
    stroke = strokeNode(node.start)
    node.children.push(stroke)
  }
  return stroke
}

/** Set the stroke line style (`default`/`dash`/`dot`/…), creating `(stroke …)` if absent. */
export function setGraphicStrokeType(node: SExprList, type: string): void {
  setScalarChild(ensureStroke(node), 'type', type)
}

/** Set the stroke color, or clear the override when `color` is null. */
export function setGraphicStrokeColor(node: SExprList, color: Rgba | null): void {
  const stroke = ensureStroke(node)
  if (color) setColorChild(stroke, color)
  else removeColorChild(stroke)
}

/** Fill kinds that paint with the fill color (`SCH_PAINTER::getRenderColor`). */
const PAINTS_WITH_FILL_COLOR = new Set(['color', 'hatch', 'reverse_hatch', 'cross_hatch'])

/**
 * The fill kind once a fill color is picked: kept when it paints with the
 * color, else `color` — KiCad's dialog couples the swatch to "fill with color",
 * so picking one never silently changes nothing.
 */
export const fillKindWithColor = (kind: string | undefined): string =>
  kind && PAINTS_WITH_FILL_COLOR.has(kind) ? kind : 'color'

/**
 * Set the fill color (creating `(fill …)` if absent), or clear it when null.
 * Setting one moves the kind on as `fillKindWithColor` says.
 */
export function setGraphicFillColor(node: SExprList, color: Rgba | null): void {
  let fill = findChild(node, 'fill')
  if (!fill) {
    fill = fillNode(node.start)
    node.children.push(fill)
  }
  if (!color) {
    removeColorChild(fill)
    return
  }
  setColorChild(fill, color)
  const type = findChild(fill, 'type')
  const kind = type ? getAtomValues(type)[0] : undefined
  const next = fillKindWithColor(kind)
  if (next !== kind) setScalarChild(fill, 'type', next)
}

/** Stroke/fill styling shared by every graphic patch (undefined = leave as-is). */
export interface GraphicStylePatch {
  strokeWidth?: Nm
  strokeType?: string
  /** null clears the color override. */
  strokeColor?: Rgba | null
  fill?: string
  /** null clears the fill color. */
  fillColor?: Rgba | null
}

/** Apply the shared stroke/fill fields of a graphic patch. */
const applyGraphicStyle = (node: SExprList, patch: GraphicStylePatch): void => {
  if (patch.strokeWidth !== undefined) setGraphicStroke(node, patch.strokeWidth)
  if (patch.strokeType !== undefined) setGraphicStrokeType(node, patch.strokeType)
  if (patch.strokeColor !== undefined) setGraphicStrokeColor(node, patch.strokeColor)
  if (patch.fill !== undefined) setGraphicFill(node, patch.fill)
  if (patch.fillColor !== undefined) setGraphicFillColor(node, patch.fillColor)
}

export interface RectanglePatch extends GraphicStylePatch {
  startX?: Nm
  startY?: Nm
  endX?: Nm
  endY?: Nm
}
export function updateRectangle(node: SExprList, patch: RectanglePatch): void {
  if (patch.startX !== undefined || patch.startY !== undefined)
    patchXY(node, 'start', patch.startX, patch.startY)
  if (patch.endX !== undefined || patch.endY !== undefined)
    patchXY(node, 'end', patch.endX, patch.endY)
  applyGraphicStyle(node, patch)
}

export interface CirclePatch extends GraphicStylePatch {
  centerX?: Nm
  centerY?: Nm
  radius?: Nm
}
export function updateCircle(node: SExprList, patch: CirclePatch): void {
  if (patch.centerX !== undefined || patch.centerY !== undefined)
    patchXY(node, 'center', patch.centerX, patch.centerY)
  if (patch.radius !== undefined) setScalarChild(node, 'radius', formatNmAtom(patch.radius))
  applyGraphicStyle(node, patch)
}

export interface ArcPatch extends GraphicStylePatch {
  startX?: Nm
  startY?: Nm
  midX?: Nm
  midY?: Nm
  endX?: Nm
  endY?: Nm
}
export function updateArc(node: SExprList, patch: ArcPatch): void {
  if (patch.startX !== undefined || patch.startY !== undefined)
    patchXY(node, 'start', patch.startX, patch.startY)
  if (patch.midX !== undefined || patch.midY !== undefined)
    patchXY(node, 'mid', patch.midX, patch.midY)
  if (patch.endX !== undefined || patch.endY !== undefined)
    patchXY(node, 'end', patch.endX, patch.endY)
  applyGraphicStyle(node, patch)
}

export function updatePolyline(node: SExprList, patch: GraphicStylePatch): void {
  applyGraphicStyle(node, patch)
}

// ---------------------------------------------------------------------------
// Text effects — (effects (font (size h w) (thickness t) bold italic) (justify …))
// Reusable across symbol text, pin name/number, and property nodes.
// ---------------------------------------------------------------------------

/** Find/create the `(effects (font …))` pair on a text-bearing node. */
const ensureEffectsFont = (node: SExprList): { effects: SExprList; font: SExprList } => {
  let effects = findChild(node, 'effects')
  if (!effects) {
    effects = makeList([makeAtom('effects', false, node.start)], node.start)
    node.children.push(effects)
  }
  let font = findChild(effects, 'font')
  if (!font) {
    font = makeList([makeAtom('font', false, node.start)], node.start)
    effects.children.push(font)
  }
  return { effects, font }
}

/**
 * Toggle a bold/italic-style flag, tolerating both encodings: an existing
 * `(bold yes|no)` child is updated in place; otherwise a bare `bold` atom is
 * added or removed (KiCad 7 writes bare tokens, KiCad 8 the sub-list form).
 */
const setFontFlag = (font: SExprList, token: string, value: boolean): void => {
  if (findChild(font, token)) {
    setScalarChild(font, token, value ? 'yes' : 'no')
    return
  }
  const idx = font.children.findIndex((c) => c.type === 'atom' && c.value === token)
  if (value) {
    if (idx < 0) font.children.push(makeAtom(token, false, font.start))
  } else if (idx >= 0) {
    font.children.splice(idx, 1)
  }
}

const H_TOKENS = ['left', 'right']
const V_TOKENS = ['top', 'bottom']

/** Rewrite the `(justify …)` node from the (non-center) h/v tokens. */
const setJustify = (
  effects: SExprList,
  hAlign: 'left' | 'center' | 'right' | undefined,
  vAlign: 'top' | 'center' | 'bottom' | undefined
): void => {
  const existing = findChild(effects, 'justify')
  const atoms = existing ? getAtomValues(existing) : []
  let h = atoms.find((a) => H_TOKENS.includes(a))
  let v = atoms.find((a) => V_TOKENS.includes(a))
  const mirror = atoms.includes('mirror')
  if (hAlign !== undefined) h = hAlign === 'center' ? undefined : hAlign
  if (vAlign !== undefined) v = vAlign === 'center' ? undefined : vAlign
  const tokens = [h, v, mirror ? 'mirror' : undefined].filter((t): t is string => Boolean(t))
  if (tokens.length === 0) {
    if (existing) effects.children = effects.children.filter((c) => c !== existing)
    return
  }
  const justify = existing ?? makeList([makeAtom('justify', false, effects.start)], effects.start)
  justify.children = [
    makeAtom('justify', false, effects.start),
    ...tokens.map((t) => makeAtom(t, false, effects.start))
  ]
  if (!existing) effects.children.push(justify)
}

export interface TextEffectsPatch {
  bold?: boolean
  italic?: boolean
  hAlign?: 'left' | 'center' | 'right'
  vAlign?: 'top' | 'center' | 'bottom'
  fontHeight?: Nm
  fontWidth?: Nm
  /**
   * `(font (thickness …))`. `null` REMOVES it, which is what the panel's Auto
   * means: absent tells KiCad to derive the weight from the size and the bold
   * flag. That is nearly the only state its own libraries are in — the token
   * appears 13 times across the 223 standard libraries — so the removal path is
   * the important one, not the write. Same `undefined` vs `null` split as
   * `color`.
   */
  thickness?: Nm | null
  /**
   * `(font (color …))`. `null` removes it, which is how the color picker says
   * "inherit the theme" — distinct from `undefined`, meaning "not part of this
   * edit", the same convention `strokeColor`/`fillColor` follow.
   */
  color?: Rgba | null
}

/** Apply font/justify effects to any text-bearing node (text, pin name/number, property). */
export function setTextEffects(node: SExprList, patch: TextEffectsPatch): void {
  // No-op when the patch carries no effect fields — never inject an empty
  // (effects …) on an unrelated edit (keeps one-field edits lossless).
  if (
    patch.bold === undefined &&
    patch.italic === undefined &&
    patch.hAlign === undefined &&
    patch.vAlign === undefined &&
    patch.fontHeight === undefined &&
    patch.fontWidth === undefined &&
    patch.thickness === undefined &&
    patch.color === undefined
  ) {
    return
  }
  const { effects, font } = ensureEffectsFont(node)
  if (patch.bold !== undefined) setFontFlag(font, 'bold', patch.bold)
  if (patch.italic !== undefined) setFontFlag(font, 'italic', patch.italic)
  if (patch.fontHeight !== undefined || patch.fontWidth !== undefined) {
    const size = findChild(font, 'size')
    const curH = size ? atomNm(size, 1, DEFAULT_FONT_SIZE_NM) : DEFAULT_FONT_SIZE_NM
    const curW = size ? atomNm(size, 2, curH) : curH
    setXYChildNm(font, 'size', patch.fontHeight ?? curH, patch.fontWidth ?? curW)
  }
  if (patch.thickness === null) removeChildToken(font, 'thickness')
  else if (patch.thickness !== undefined)
    setScalarChild(font, 'thickness', formatNmAtom(patch.thickness))
  // Cleared as a REMOVAL rather than an unset `(0 0 0 0)` tuple: an absent node
  // is what a KiCad-authored file has when the text takes the theme color.
  if (patch.color === null) removeColorChild(font)
  else if (patch.color !== undefined) setColorChild(font, patch.color)
  if (patch.hAlign !== undefined || patch.vAlign !== undefined)
    setJustify(effects, patch.hAlign, patch.vAlign)
}

export interface TextPatch extends TextEffectsPatch {
  text?: string
  x?: Nm
  y?: Nm
  /** Display degrees; KiCad stores symbol-text angle ×10, so the helper scales. */
  angle?: number
  /** Square font size (height = width); use fontHeight/fontWidth for non-square. */
  size?: Nm
}
export function updateSymbolText(node: SExprList, patch: TextPatch): void {
  if (patch.text !== undefined) setPositionalAtom(node, 1, patch.text, true)
  if (patch.x !== undefined || patch.y !== undefined || patch.angle !== undefined) {
    const at = findChild(node, 'at')
    const x = patch.x ?? atomNm(at, 1)
    const y = patch.y ?? atomNm(at, 2)
    const angle = patch.angle ?? atomNum(at, 3) / 10
    setAtChildNm(node, x, y, Math.round(angle * 10))
  }
  if (patch.size !== undefined) {
    const { font } = ensureEffectsFont(node)
    setXYChildNm(font, 'size', patch.size, patch.size)
  }
  setTextEffects(node, patch)
}

/** Everything a field carries beyond its key — the styling half of field editing. */
export interface FieldPatch extends TextEffectsPatch {
  value?: string
  x?: Nm
  y?: Nm
  /**
   * DEGREES, written unscaled — the format's third angle convention, and the
   * neighbors disagree: `(text …)` is decidegrees, `(text_box …)` is degrees.
   */
  angle?: number
  /** Square font size (height = width), matching KiCad's single Text size box. */
  size?: Nm
  /** Asked positively ("Show"); the file stores the negative `(hide yes)`. */
  visible?: boolean
  showName?: boolean
  doNotAutoplace?: boolean
  /** KiCad 9's `(property private "Key" …)`: the field stays with the library symbol. */
  private?: boolean
}

/**
 * Mark a field private or public: the bare `private` keyword KiCad 9 writes
 * before the key. A mandatory field is never private (KiCad offers the switch
 * only on the others), so a request for one is ignored.
 */
export function setPropertyPrivate(node: SExprList, isPrivate: boolean): void {
  const has = propertyNameIndex(node) === 2
  if (isPrivate === has) return
  if (!isPrivate) node.children.splice(1, 1)
  else if (!isMandatoryField(propertyKeyOf(node)))
    node.children.splice(1, 0, makeAtom('private', false, node.start))
}

/** Apply a field edit to one `(property …)` node. */
export function updateSymbolProperty(node: SExprList, patch: FieldPatch): void {
  if (patch.value !== undefined)
    setPositionalAtom(node, propertyNameIndex(node) + 1, patch.value, true)
  if (patch.private !== undefined) setPropertyPrivate(node, patch.private)
  if (patch.x !== undefined || patch.y !== undefined || patch.angle !== undefined) {
    const at = findChild(node, 'at')
    const x = patch.x ?? atomNm(at, 1)
    const y = patch.y ?? atomNm(at, 2)
    setAtChildNm(node, x, y, patch.angle ?? atomNum(at, 3))
  }
  if (patch.size !== undefined) {
    const { font } = ensureEffectsFont(node)
    setXYChildNm(font, 'size', patch.size, patch.size)
  }
  if (patch.visible !== undefined) setSymbolPropertyVisible(node, patch.visible)
  if (patch.showName !== undefined)
    setPropertyScalarChild(node, 'show_name', patch.showName ? 'yes' : 'no')
  if (patch.doNotAutoplace !== undefined)
    setPropertyScalarChild(node, 'do_not_autoplace', patch.doNotAutoplace ? 'yes' : 'no')
  setTextEffects(node, patch)
}

export interface TextBoxPatch extends TextEffectsPatch, GraphicStylePatch {
  text?: string
  x?: Nm
  y?: Nm
  /** Degrees, stored as degrees — a text_box does NOT use the text ×10 scale. */
  angle?: number
  width?: Nm
  height?: Nm
  marginLeft?: Nm
  marginTop?: Nm
  marginRight?: Nm
  marginBottom?: Nm
  /** Square font size (height = width). */
  size?: Nm
}

/**
 * The properties panel's write path for a `text_box`. Shaped like
 * `updateSymbolText`, with the two differences the format forces: the angle is
 * written unscaled, and the box carries a `(size …)` extent and a `(margins …)`
 * tuple that no other graphic has.
 *
 * Every field is optional and reads its current value when omitted, so editing
 * one margin cannot silently reset the other three.
 */
export function updateSymbolTextBox(node: SExprList, patch: TextBoxPatch): void {
  if (patch.text !== undefined) setPositionalAtom(node, 1, patch.text, true)
  if (patch.x !== undefined || patch.y !== undefined || patch.angle !== undefined) {
    const at = findChild(node, 'at')
    setAtChildNm(
      node,
      patch.x ?? atomNm(at, 1),
      patch.y ?? atomNm(at, 2),
      patch.angle ?? atomNum(at, 3)
    )
  }
  if (patch.width !== undefined || patch.height !== undefined) {
    const size = findChild(node, 'size')
    setXYChildNm(node, 'size', patch.width ?? atomNm(size, 1), patch.height ?? atomNm(size, 2))
  }
  if (
    patch.marginLeft !== undefined ||
    patch.marginTop !== undefined ||
    patch.marginRight !== undefined ||
    patch.marginBottom !== undefined
  ) {
    const margins = findChild(node, 'margins')
    const current = (index: number, fallback: Nm): Nm =>
      margins ? atomNm(margins, index, fallback) : fallback
    const values = [
      patch.marginLeft ?? current(1, DEFAULT_TEXT_BOX_MARGINS_NM.left),
      patch.marginTop ?? current(2, DEFAULT_TEXT_BOX_MARGINS_NM.top),
      patch.marginRight ?? current(3, DEFAULT_TEXT_BOX_MARGINS_NM.right),
      patch.marginBottom ?? current(4, DEFAULT_TEXT_BOX_MARGINS_NM.bottom)
    ]
    const target = findOrCreateChild(node, 'margins')
    target.children = [
      makeAtom('margins', false, target.start),
      ...values.map((v) => makeAtom(formatNmAtom(v), false, target.start))
    ]
  }
  if (patch.size !== undefined) {
    const { font } = ensureEffectsFont(node)
    setXYChildNm(font, 'size', patch.size, patch.size)
  }
  setTextEffects(node, patch)
  // The box's border and fill: the rows the panel shows under its shape.
  applyGraphicStyle(node, patch)
}

// ---------------------------------------------------------------------------
// Symbol-level flags (top symbol node)
// ---------------------------------------------------------------------------

export interface PinDisplayPatch {
  /** Distance pin NAMES sit from the body end of the pin. */
  nameOffset?: Nm
  namesHidden?: boolean
  numbersHidden?: boolean
}

/**
 * The symbol-level pin display settings — KiCad's "Show pin number" / "Show pin
 * name" / "Pin Name Position Offset", which live on the SYMBOL and not on any
 * pin. That is why they were easy to miss: nothing in the pin's own properties
 * reaches them.
 *
 * `(pin_names …)` and `(pin_numbers …)` are created on demand, since KiCad omits
 * them entirely while they hold their defaults.
 */
export function setSymbolPinDisplay(symbolNode: SExprList, patch: PinDisplayPatch): void {
  if (patch.nameOffset !== undefined || patch.namesHidden !== undefined) {
    const pinNames = findOrCreateChild(symbolNode, 'pin_names')
    if (patch.nameOffset !== undefined) {
      setScalarChild(pinNames, 'offset', formatNmAtom(patch.nameOffset))
    }
    if (patch.namesHidden !== undefined) setHideFlag(pinNames, patch.namesHidden)
  }
  if (patch.numbersHidden !== undefined) {
    setHideFlag(findOrCreateChild(symbolNode, 'pin_numbers'), patch.numbersHidden)
  }
}

/**
 * Insert a fresh symbol-level child where KiCad writes it: in the header, ahead
 * of the first `(property …)` (and so ahead of every unit sub-symbol). KiCad's
 * reader takes these in any order, but a token appended after the sub-symbols
 * would diff as a stray line at the bottom of the symbol.
 */
const insertSymbolHeaderChild = (symbolNode: SExprList, child: SExprList): void => {
  const firstBody = symbolNode.children.findIndex(
    (c) => c.type === 'list' && (getToken(c) === 'property' || getToken(c) === 'symbol')
  )
  if (firstBody < 0) symbolNode.children.push(child)
  else symbolNode.children.splice(firstBody, 0, child)
}

/** The yes/no flags a symbol carries on its own node. */
export type SymbolFlagToken =
  'in_bom' | 'on_board' | 'exclude_from_sim' | 'in_pos_files' | 'duplicate_pin_numbers_are_jumpers'

/** Set a yes/no flag token, written in the header when it is new. */
export function setSymbolFlag(symbolNode: SExprList, token: SymbolFlagToken, value: boolean): void {
  const atom = value ? 'yes' : 'no'
  if (findChild(symbolNode, token)) {
    setScalarChild(symbolNode, token, atom)
    return
  }
  const at = symbolNode.start
  insertSymbolHeaderChild(
    symbolNode,
    makeList([makeAtom(token, false, at), makeAtom(atom, false, at)], at)
  )
}

/** What kind of power port a symbol is, as the panel offers it. */
export type SymbolPowerKind = 'none' | 'global' | 'local'

/**
 * Make the symbol a power port or not. A bare `(power)` is KiCad's global port
 * in every version, so it is what a new global port gets and what an existing
 * one keeps; `(power local)` (KiCad 9+) scopes the net to its sheet. A new
 * token goes right after the name, where KiCad writes it.
 */
export function setSymbolPowerKind(symbolNode: SExprList, kind: SymbolPowerKind): void {
  const existing = findChild(symbolNode, 'power')
  if (kind === 'none') {
    if (existing) symbolNode.children.splice(symbolNode.children.indexOf(existing), 1)
    return
  }
  if (!existing) {
    const at = symbolNode.start
    const node = makeList([makeAtom('power', false, at)], at)
    if (kind === 'local') node.children.push(makeAtom('local', false, at))
    // children[0] is the `symbol` token and children[1] the name.
    symbolNode.children.splice(Math.min(2, symbolNode.children.length), 0, node)
    return
  }
  const scope = getFirstAtomValue(existing)
  if (kind === 'local' && scope !== 'local') {
    existing.children = [existing.children[0], makeAtom('local', false, existing.start)]
  } else if (kind === 'global' && scope === 'local') {
    // Back to the spelling every version reads, rather than KiCad 10's `global`.
    existing.children = [existing.children[0]]
  }
}

/** Add or remove the power marker: a global port, or none. */
export function setSymbolPower(symbolNode: SExprList, power: boolean): void {
  if (!power) setSymbolPowerKind(symbolNode, 'none')
  else if (!findChild(symbolNode, 'power')) setSymbolPowerKind(symbolNode, 'global')
}

/**
 * KiCad's "All units are interchangeable", which the file stores inverted as a
 * `ki_locked` property (empty and hidden — KiCad's own spelling of it).
 */
export function setSymbolUnitsInterchangeable(
  symbolNode: SExprList,
  interchangeable: boolean
): void {
  const node = symbolPropertyNode(symbolNode, 'ki_locked')
  if (interchangeable) {
    if (node) symbolNode.children.splice(symbolNode.children.indexOf(node), 1)
    return
  }
  if (node) return
  setSymbolProperty(symbolNode, 'ki_locked', '')
  const created = symbolPropertyNode(symbolNode, 'ki_locked')
  if (created) setSymbolPropertyVisible(created, false)
}

/**
 * Normalize a footprint-filter list as KiCad stores it: whitespace-separated
 * patterns, one space between each. KiCad splits on any whitespace when it
 * reads, so a newline or a doubled space typed into the row means nothing more.
 */
export const normalizeFootprintFilters = (text: string): string =>
  text.split(/\s+/).filter(Boolean).join(' ')

/**
 * Set the symbol's footprint filters (`ki_fp_filters`, the patterns the
 * footprint picker narrows by). An empty list removes the property, as KiCad
 * writes none; a new one is hidden, as KiCad writes it.
 */
export function setSymbolFootprintFilters(symbolNode: SExprList, text: string): void {
  const value = normalizeFootprintFilters(text)
  const node = symbolPropertyNode(symbolNode, 'ki_fp_filters')
  if (!value) {
    if (node) symbolNode.children.splice(symbolNode.children.indexOf(node), 1)
    return
  }
  setSymbolProperty(symbolNode, 'ki_fp_filters', value)
  if (!node) {
    const created = symbolPropertyNode(symbolNode, 'ki_fp_filters')
    if (created) setSymbolPropertyVisible(created, false)
  }
}

/**
 * Name a unit — KiCad 7+ `(unit_name "…")`, shown in the unit picker ("NMOS").
 * KiCad keeps one name per unit and writes it into every body style's
 * sub-symbol of that unit, right after the sub-symbol's own name; so does this.
 * An empty name removes it, and the unit falls back to its letter.
 */
export function setSymbolUnitName(symbolNode: SExprList, unitNumber: number, name: string): void {
  if (unitNumber <= 0) return
  const value = name.trim()
  const targets = unitSubSymbols(symbolNode).filter(
    (unitNode) => unitOfSubSymbol(symbolNode, unitNode) === unitNumber
  )
  if (!targets.length && value) targets.push(getOrCreateUnitNode(symbolNode, unitNumber, 1))
  for (const unitNode of targets) {
    const existing = findChild(unitNode, 'unit_name')
    if (!value) {
      if (existing) unitNode.children.splice(unitNode.children.indexOf(existing), 1)
    } else if (existing) {
      setPositionalAtom(existing, 1, value, true)
    } else {
      const at = unitNode.start
      unitNode.children.splice(
        Math.min(2, unitNode.children.length),
        0,
        makeList([makeAtom('unit_name', false, at), makeAtom(value, true, at)], at)
      )
    }
  }
}
