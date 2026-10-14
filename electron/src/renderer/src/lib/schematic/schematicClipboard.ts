/**
 * The schematic clipboard, in KiCad's own format: the text eeschema puts on
 * the system clipboard (`SCH_EDITOR_CONTROL::doCopy` → `SCH_IO_KICAD_SEXPR::Format`)
 * is a bare run of top-level nodes — an optional `(lib_symbols …)` holding the
 * copied symbols' definitions, then the items — with no `(kicad_sch …)` around
 * them. Writing that exact shape is what lets a copy here paste into KiCad and
 * a copy there paste here.
 *
 * Pure: the editor's composable (`useSchematicClipboard.ts`) owns the clipboard
 * IPC, the floating move and the undo step. Everything a paste writes is a
 * new node; nothing already on the sheet is touched, so a paste diffs to the
 * nodes it adds and nothing else.
 */

import {
  cloneNodeDeep,
  findChild,
  findChildren,
  getAtomValues,
  getToken,
  parseSExpr,
  serializeSExpr,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'
import { makeAtom, makeList, setPositionalAtom } from '../kicad/footprint'
import {
  definitionIdOf,
  getSheetProperty,
  insertTopLevelNode,
  parseKicadSchematic,
  referenceForSheetPath,
  schematicItemsOf,
  setSymbolInstanceReference,
  type KicadLibSymbol,
  type KicadSchematic,
  type Point,
  type SchematicDocumentItemType,
  type SchematicItemType
} from '../kicad/schematic'
import { nm, type Nm } from '../kicad/coordinates'
import { parseReference, planAnnotation, type AnnotateSource } from './annotate'
import {
  applyTransform,
  planPlacement,
  translateSchematicItems,
  type PlacementStep
} from './schematicMove'
import { sheetItemAt, sheetItemOrigin, isSheetItemType } from './sheetItemPlacement'
import { pageAllocator, pagesOf } from './sheetPages'

/** What a copy carries: the definitions its symbols draw from, then the items. */
export interface SchematicClipboardContent {
  libSymbols: SExprList[]
  items: SExprList[]
}

/**
 * The top-level tokens a schematic clipboard may hold — every item kind the
 * editor selects, as KiCad's `Format(SELECTION)` writes them.
 */
export const CLIPBOARD_ITEM_TOKENS: ReadonlySet<string> = new Set([
  'symbol',
  'wire',
  'bus',
  'bus_entry',
  'junction',
  'no_connect',
  'label',
  'global_label',
  'hierarchical_label',
  'netclass_flag',
  'text',
  'text_box',
  'rectangle',
  'polyline',
  'circle',
  'arc',
  'bezier',
  'image',
  'table',
  'sheet',
  'rule_area'
])

/** Every document item kind, for walking a sheet's items by uuid. */
const DOCUMENT_TYPES: SchematicDocumentItemType[] = [
  'symbol',
  'wire',
  'label',
  'junction',
  'no_connect',
  'sheet',
  'text',
  'text_box',
  'shape',
  'polyline',
  'circle',
  'arc',
  'bezier',
  'image',
  'table',
  'bus',
  'bus_entry',
  'netclass_flag',
  'rule_area'
]

export interface ItemRef {
  type: SchematicItemType
  index: number
  field?: string
  pin?: number
}

/** The `(uuid …)` a node carries directly. */
export const nodeUuid = (node: SExprList): string | undefined => {
  const child = findChild(node, 'uuid')
  return child ? getAtomValues(child)[0] : undefined
}

/**
 * The top-level node behind each selected item, in the sheet's own order. A
 * part copies as its owner — a field its symbol, a sheet's pin or field the
 * sheet — as KiCad does for a hovered field, since a field alone is nothing a
 * sheet can hold.
 */
export function selectionNodes(schematic: KicadSchematic, items: readonly ItemRef[]): SExprList[] {
  const picked = new Set<SExprNode>()
  for (const item of items) {
    let node: SExprList | undefined
    if (item.type === 'field') node = schematic.symbols[item.index]?._node
    else if (item.type === 'sheet_field' || item.type === 'sheet_pin')
      node = schematic.sheets[item.index]?._node
    else node = schematicItemsOf(schematic, item.type)[item.index]?._node
    if (node) picked.add(node)
  }
  return schematic._root.children.filter(
    (child): child is SExprList => child.type === 'list' && picked.has(child)
  )
}

/**
 * `/a/b/c` relative to `/a/b` is `/c`, and the path itself is empty: KiCad's
 * `MakeRelativeTo`, whose empty path writes as `(path "")`.
 */
export const relativeSheetPath = (path: string, base: string): string => {
  if (path === base) return ''
  if (base !== '/' && path.startsWith(`${base}/`)) return path.slice(base.length)
  return path
}

/**
 * The selection as KiCad copies it from sheet instance `sheetPath`: each
 * symbol's Reference field says what it is called there, and its instance
 * paths are made relative to it, so the clipboard's own instance has the empty path.
 * Definitions are keyed and ordered by the name placements draw them by.
 */
export function copySchematicSelection(
  schematic: KicadSchematic,
  items: readonly ItemRef[],
  sheetPath: string
): SchematicClipboardContent {
  const nodes = selectionNodes(schematic, items)
  const bySymbolNode = new Map(
    schematic.symbols.map((symbol) => [symbol._node as SExprNode, symbol])
  )
  const definitions = new Map<string, KicadLibSymbol>()
  const copies = nodes.map((node) => {
    const clone = cloneNodeDeep(node) as SExprList
    const symbol = bySymbolNode.get(node)
    if (!symbol) return clone
    const name = definitionIdOf(symbol)
    const definition = schematic.libSymbols.get(name)
    if (definition) definitions.set(name, definition)
    const reference = referenceForSheetPath(symbol, sheetPath)
    if (reference !== undefined) setPropertyValue(clone, 'Reference', reference)
    const instances = findChild(clone, 'instances')
    for (const project of instances ? findChildren(instances, 'project') : []) {
      for (const path of findChildren(project, 'path')) {
        const [value] = getAtomValues(path)
        if (value !== undefined)
          setPositionalAtom(path, 1, relativeSheetPath(value, sheetPath), true)
      }
    }
    return clone
  })
  const libSymbols = [...definitions.keys()]
    .sort()
    .map((name) => cloneNodeDeep(definitions.get(name)!._node) as SExprList)
  return { libSymbols, items: copies }
}

/**
 * The clipboard text: KiCad's node run, one top-level node after another, in
 * the compact layout eeschema copies with (fonts, strokes and fills on one line).
 */
export function serializeClipboard(content: SchematicClipboardContent): string {
  const parts: string[] = []
  if (content.libSymbols.length) {
    const lib = makeList([makeAtom('lib_symbols', false, 0), ...content.libSymbols], 0)
    parts.push(serializeSExpr(lib, 0, true))
  }
  for (const item of content.items) parts.push(serializeSExpr(item, 0, true))
  return `${parts.join('\n')}\n`
}

/**
 * Read clipboard text back — KiCad's node run, a whole `(kicad_sch …)` file,
 * or a single node. Null when it holds no schematic item: text from anywhere
 * else, a footprint, a board.
 */
export function parseClipboard(text: string): SchematicClipboardContent | null {
  if (!text.trim().startsWith('(')) return null
  let parsed: SExprNode
  try {
    parsed = parseSExpr(text)
  } catch {
    return null
  }
  if (parsed.type !== 'list') return null
  const token = getToken(parsed)
  const top: SExprNode[] =
    token === 'kicad_sch' ? parsed.children.slice(1) : token === null ? parsed.children : [parsed]
  const libSymbols: SExprList[] = []
  const items: SExprList[] = []
  for (const node of top) {
    if (node.type !== 'list') continue
    const name = getToken(node)
    if (name === 'lib_symbols') libSymbols.push(...findChildren(node, 'symbol'))
    else if (name && CLIPBOARD_ITEM_TOKENS.has(name)) items.push(node)
  }
  return items.length ? { libSymbols, items } : null
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

/** Where a paste lands, and what it must not collide with. */
export interface PasteTarget {
  /** Every sheet instance of the design — the reference pool. */
  sources: readonly AnnotateSource[]
  /** The pasted-into file's instance paths, one per placement of the sheet. */
  instancePaths: readonly string[]
  /** Project name the new `(instances …)` blocks are filed under. */
  project: string
  /** The destination's own definitions, by name. */
  libSymbols: ReadonlyMap<string, KicadLibSymbol>
  /** Sheet names the destination already uses. */
  sheetNames: readonly string[]
  /** Injected for tests. */
  newUuid?: () => string
}

/** A paste ready to insert: definitions the destination lacks, then the items. */
export type PreparedPaste = SchematicClipboardContent

const setPropertyValue = (node: SExprList, key: string, value: string): void => {
  for (const property of findChildren(node, 'property')) {
    if (getAtomValues(property)[0] === key) setPositionalAtom(property, 2, value, true)
  }
}

const propertyValue = (node: SExprList, key: string): string | undefined => {
  for (const property of findChildren(node, 'property')) {
    const [name, value] = getAtomValues(property)
    if (name === key) return value
  }
  return undefined
}

/** Give every `(uuid …)` inside `node` a fresh value — the item's, its pins', a sheet's pins'. */
export function refreshUuids(node: SExprList, newUuid: () => string): void {
  for (const child of node.children) {
    if (child.type !== 'list') continue
    if (getToken(child) === 'uuid') setPositionalAtom(child, 1, newUuid(), true)
    else refreshUuids(child, newUuid)
  }
}

const libItemName = (name: string): string => name.slice(name.indexOf(':') + 1)

/**
 * A definition under another name, its unit sub-symbols (`R_0_1`) following —
 * KiCad's parser rejects a unit whose name does not start with its parent's.
 */
export const renamedDefinition = (node: SExprList, name: string): SExprList => {
  const clone = cloneNodeDeep(node) as SExprList
  const from = libItemName(getAtomValues(clone)[0] ?? '')
  const to = libItemName(name)
  setPositionalAtom(clone, 1, name, true)
  for (const unit of findChildren(clone, 'symbol')) {
    const [unitName] = getAtomValues(unit)
    if (unitName?.startsWith(`${from}_`))
      setPositionalAtom(unit, 1, `${to}${unitName.slice(from.length)}`, true)
  }
  return clone
}

/**
 * The name a pasted definition takes here — KiCad's `SCH_SCREEN::Append`: its
 * own when the destination has none by that name or holds the same one; else
 * the first `<item>_<n>` holding the same definition, or the first free one.
 * `add` is the node to write, when the destination lacks it.
 */
function resolveDefinition(
  node: SExprList,
  existing: ReadonlyMap<string, KicadLibSymbol>,
  taken: Set<string>
): { name: string; add: SExprList | null } {
  const name = getAtomValues(node)[0] ?? ''
  const same = (candidate: string): boolean => {
    const held = existing.get(candidate)
    return (
      !!held && serializeSExpr(held._node) === serializeSExpr(renamedDefinition(node, candidate))
    )
  }
  if (!taken.has(name)) {
    taken.add(name)
    return { name, add: node }
  }
  if (!existing.has(name) || same(name)) return { name, add: null }
  const stem = libItemName(name)
  for (let n = 1; ; n += 1) {
    const candidate = `${stem}_${n}`
    if (same(candidate)) return { name: candidate, add: null }
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return { name: candidate, add: renamedDefinition(node, candidate) }
    }
  }
}

/** `(lib_name …)` after `(lib_id …)`, as KiCad writes a placement whose definition was renamed. */
const setLibName = (symbol: SExprList, name: string): void => {
  const current = findChild(symbol, 'lib_name')
  if (current) {
    setPositionalAtom(current, 1, name, true)
    return
  }
  const at = symbol.start
  const node = makeList([makeAtom('lib_name', false, at), makeAtom(name, true, at)], at)
  const libId = findChild(symbol, 'lib_id')
  const index = libId ? symbol.children.indexOf(libId) + 1 : 1
  symbol.children.splice(index, 0, node)
}

const instancesNode = (
  at: number,
  project: string,
  paths: readonly string[],
  entry: (path: string) => SExprList[]
): SExprList =>
  makeList(
    [
      makeAtom('instances', false, at),
      makeList(
        [
          makeAtom('project', false, at),
          makeAtom(project, true, at),
          ...paths.map((path) =>
            makeList([makeAtom('path', false, at), makeAtom(path, true, at), ...entry(path)], at)
          )
        ],
        at
      )
    ],
    at
  )

const replaceChild = (node: SExprList, token: string, next: SExprList): void => {
  const current = findChild(node, token)
  if (current) node.children[node.children.indexOf(current)] = next
  else node.children.push(next)
}

/**
 * The reference and unit a pasted symbol arrives with — its clipboard-relative
 * instance (the empty path) when it has one, else its fields, as `updatePastedSymbol` reads it.
 */
const clipboardIdentity = (symbol: SExprList): { reference: string; unit: number } => {
  const unitNode = findChild(symbol, 'unit')
  const unit = Number(unitNode ? getAtomValues(unitNode)[0] : 1) || 1
  const instances = findChild(symbol, 'instances')
  for (const project of instances ? findChildren(instances, 'project') : []) {
    for (const path of findChildren(project, 'path')) {
      const value = getAtomValues(path)[0]
      if (value !== '' && value !== '/') continue
      const reference = findChild(path, 'reference')
      const instanceUnit = findChild(path, 'unit')
      return {
        reference:
          (reference && getAtomValues(reference)[0]) ?? propertyValue(symbol, 'Reference') ?? '?',
        unit: Number(instanceUnit ? getAtomValues(instanceUnit)[0] : unit) || unit
      }
    }
  }
  return { reference: propertyValue(symbol, 'Reference') ?? '?', unit }
}

/** KiCad's sheet-name uniquifier: `Power` → `Power1`, `Amp2` → `Amp3`. */
export function uniqueSheetName(name: string, used: ReadonlySet<string>): string {
  if (!used.has(name)) return name
  const match = /^(.*?)(\d*)$/.exec(name)
  const base = match?.[1] ?? name
  let n = Math.max(0, Number(match?.[2] || 0)) + 1
  let candidate = `${base}${n}`
  while (used.has(candidate)) candidate = `${base}${(n += 1)}`
  return candidate
}

const KICAD_SCH_VERSION = '20250114'

/** A throwaway sheet holding just these nodes, parsed so the typed model can act on them. */
const scratchSheet = (content: SchematicClipboardContent): KicadSchematic => {
  const root = makeList(
    [
      makeAtom('kicad_sch', false, 0),
      makeList([makeAtom('version', false, 0), makeAtom(KICAD_SCH_VERSION, false, 0)], 0),
      makeList([makeAtom('lib_symbols', false, 0), ...content.libSymbols], 0),
      ...content.items
    ],
    0
  )
  return parseKicadSchematic(serializeSExpr(root))
}

const contentOf = (sheet: KicadSchematic): SchematicClipboardContent => {
  const lib = findChild(sheet._root, 'lib_symbols')
  return {
    libSymbols: lib ? findChildren(lib, 'symbol') : [],
    items: sheet._root.children.filter(
      (child): child is SExprList =>
        child.type === 'list' && CLIPBOARD_ITEM_TOKENS.has(getToken(child) ?? '')
    )
  }
}

/** Every item on a sheet, as refs. */
export const allItemRefs = (sheet: KicadSchematic): ItemRef[] =>
  DOCUMENT_TYPES.flatMap((type) =>
    schematicItemsOf(sheet, type).map((_, index) => ({ type, index }))
  )

/**
 * Make clipboard content safe to add to a sheet, as KiCad's `Paste` does:
 * every uuid fresh; each definition kept, reused or renamed beside the
 * destination's own; each symbol filed under this sheet's instance paths and
 * its reference kept unless another part of the design holds it (or it is
 * unannotated), in which case it takes the next free number — the annotate
 * run's duplicates rule, over the whole design; each sheet renamed if its name
 * is taken, its child file untouched.
 */
export function preparePaste(
  content: SchematicClipboardContent,
  target: PasteTarget
): PreparedPaste {
  const newUuid = target.newUuid ?? ((): string => crypto.randomUUID())
  const taken = new Set(target.libSymbols.keys())
  const renames = new Map<string, string>()
  const libSymbols: SExprList[] = []
  for (const definition of content.libSymbols) {
    const name = getAtomValues(definition)[0] ?? ''
    if (renames.has(name)) continue
    const resolved = resolveDefinition(definition, target.libSymbols, taken)
    renames.set(name, resolved.name)
    if (resolved.add) libSymbols.push(cloneNodeDeep(resolved.add) as SExprList)
  }

  const sheetNames = new Set(target.sheetNames)
  // Each pasted sheet instance takes the lowest page the design leaves free,
  // as KiCad's paste numbers them.
  const nextPage = pageAllocator(pagesOf(target.sources))
  const items = content.items.map((source) => {
    const node = cloneNodeDeep(source) as SExprList
    refreshUuids(node, newUuid)
    const token = getToken(node)
    if (token === 'symbol') {
      const libName = findChild(node, 'lib_name')
      const libId = findChild(node, 'lib_id')
      const drawnBy = (libName && getAtomValues(libName)[0]) ?? (libId && getAtomValues(libId)[0])
      const renamed = drawnBy ? renames.get(drawnBy) : undefined
      if (renamed && renamed !== drawnBy) setLibName(node, renamed)
      const { reference, unit } = clipboardIdentity(node)
      setPropertyValue(node, 'Reference', reference)
      replaceChild(
        node,
        'instances',
        instancesNode(node.start, target.project, target.instancePaths, () => [
          makeList([makeAtom('reference', false, 0), makeAtom(reference, true, 0)], 0),
          makeList([makeAtom('unit', false, 0), makeAtom(String(unit), false, 0)], 0)
        ])
      )
    } else if (token === 'sheet') {
      for (const key of ['Sheetname', 'Sheet name']) {
        const name = propertyValue(node, key)
        if (name === undefined) continue
        const unique = uniqueSheetName(name, sheetNames)
        sheetNames.add(unique)
        setPropertyValue(node, key, unique)
      }
      replaceChild(
        node,
        'instances',
        instancesNode(node.start, target.project, target.instancePaths, () => [
          makeList([makeAtom('page', false, 0), makeAtom(nextPage(), true, 0)], 0)
        ])
      )
    }
    return node
  })

  const sheet = scratchSheet({ libSymbols, items })
  annotatePasted(sheet, target)
  return contentOf(sheet)
}

/** The pasted symbols' references against the design: kept unless taken, numbered if not. */
function annotatePasted(sheet: KicadSchematic, target: PasteTarget): void {
  if (!sheet.symbols.length) return
  const pasted: AnnotateSource[] = target.instancePaths.map((sheetPath) => ({
    schematic: sheet,
    sheetPath,
    filePath: '\0clipboard'
  }))
  const plan = planAnnotation(
    { sources: [...target.sources, ...pasted], scope: pasted },
    { order: 'xy', numbering: 'sequential', reset: false }
  )
  for (const change of plan.changes) {
    const symbol = sheet.symbols[change.symbolIndex]
    if (symbol) setSymbolInstanceReference(symbol, change.sheetPath, change.to)
  }
}

/**
 * The paste turned and shifted as the floating move left it: the same
 * placement a drag commits (`planPlacement`), run over the pasted nodes on
 * their own so nothing already on the sheet moves or reshapes. Sheets do not
 * turn; they take the shift.
 */
export function placePaste(
  prepared: PreparedPaste,
  steps: readonly PlacementStep[],
  delta: Point,
  options: { sheetPath: string; grid: Nm }
): PreparedPaste {
  const sheet = scratchSheet(prepared)
  const refs = allItemRefs(sheet)
  if (steps.length) {
    const plan = planPlacement(sheet, refs, [...steps], delta, {
      grid: options.grid,
      wires: false,
      carryAttached: false
    })
    if (plan) applyTransform(sheet, options.sheetPath, plan)
    translateSchematicItems(
      sheet,
      refs.filter((ref) => ref.type === 'sheet'),
      delta
    )
  } else if (delta.x !== 0 || delta.y !== 0) {
    translateSchematicItems(sheet, refs, delta)
  }
  return contentOf(sheet)
}

/**
 * Write a prepared paste into `schematic`: the definitions into its
 * `lib_symbols`, each item after the last of its kind. Clones, so the same
 * paste can be written again.
 */
export function insertPaste(schematic: KicadSchematic, prepared: PreparedPaste): void {
  if (prepared.libSymbols.length) {
    let container = findChild(schematic._root, 'lib_symbols')
    if (!container) {
      const at = schematic._root.start
      container = makeList([makeAtom('lib_symbols', false, at)], at)
      const children = schematic._root.children
      const first = children.findIndex((child) => {
        const token = getToken(child)
        return !!token && (CLIPBOARD_ITEM_TOKENS.has(token) || token === 'sheet_instances')
      })
      children.splice(first >= 0 ? first : children.length, 0, container)
    }
    for (const definition of prepared.libSymbols)
      container.children.push(cloneNodeDeep(definition) as SExprList)
  }
  for (const item of prepared.items) insertTopLevelNode(schematic, cloneNodeDeep(item) as SExprList)
}

/** The uuids a paste's items carry, to find them again once the sheet re-parses. */
export const pasteUuids = (prepared: PreparedPaste): string[] =>
  prepared.items.map((item) => nodeUuid(item)).filter((uuid): uuid is string => !!uuid)

/**
 * The items on a sheet with these uuids, as refs — every kind, junctions and
 * no-connect flags included, whose parsed form keeps no uuid of its own.
 */
export function itemRefsForUuids(sheet: KicadSchematic, uuids: readonly string[]): ItemRef[] {
  const wanted = new Set(uuids)
  const refs: ItemRef[] = []
  for (const type of DOCUMENT_TYPES) {
    schematicItemsOf(sheet, type).forEach((item, index) => {
      const uuid = item.uuid ?? nodeUuid(item._node)
      if (uuid && wanted.has(uuid)) refs.push({ type, index })
    })
  }
  return refs
}

/** The points a floating paste can hang from: where each item is placed, connection points first. */
export function anchorPoints(sheet: KicadSchematic, refs: readonly ItemRef[]): Point[] {
  const points: Point[] = []
  for (const ref of refs) {
    switch (ref.type) {
      case 'symbol': {
        const symbol = sheet.symbols[ref.index]
        if (symbol) points.push(symbol.position)
        break
      }
      case 'wire':
        points.push(...(sheet.wires[ref.index]?.points ?? []))
        break
      case 'label': {
        const label = sheet.labels[ref.index]
        if (label) points.push(label.position)
        break
      }
      case 'junction':
      case 'no_connect': {
        const point = (ref.type === 'junction' ? sheet.junctions : sheet.noConnects)[ref.index]
        if (point) points.push({ x: point.x, y: point.y })
        break
      }
      case 'sheet': {
        const box = sheet.sheets[ref.index]
        if (box) points.push(box.position, ...box.pins.map((pin) => pin.position))
        break
      }
      default: {
        if (!isSheetItemType(ref.type)) break
        const entry = sheetItemAt(sheet, ref.type, ref.index)
        const origin = entry ? sheetItemOrigin(entry) : null
        if (origin) points.push(origin)
      }
    }
  }
  return points
}

/** KiCad's paste reference point: the top-left of the items' placing points. */
export function topLeftAnchor(points: readonly Point[]): Point | null {
  let best: Point | null = null
  for (const point of points) {
    if (!best || point.x < best.x || (point.x === best.x && point.y < best.y)) best = point
  }
  return best ? { x: nm(best.x), y: nm(best.y) } : null
}

/** KiCad's duplicate reference point: the placing point nearest the cursor. */
export function nearestAnchor(points: readonly Point[], cursor: Point): Point | null {
  let best: Point | null = null
  let bestDistance = Infinity
  for (const point of points) {
    const distance = Math.hypot(point.x - cursor.x, point.y - cursor.y)
    if (distance < bestDistance) {
      best = point
      bestDistance = distance
    }
  }
  return best ? { x: nm(best.x), y: nm(best.y) } : null
}

/** The Sheetname every sheet on this one uses, for the paste's uniquifier. */
export const sheetNamesOf = (sheet: KicadSchematic): string[] =>
  sheet.sheets
    .map((box) => getSheetProperty(box, 'Sheetname') ?? getSheetProperty(box, 'Sheet name'))
    .filter((name): name is string => name !== undefined)

/** A symbol's designator prefix with the number dropped: `R12` → `R?`. */
export const unannotated = (reference: string): string => `${parseReference(reference).prefix}?`
