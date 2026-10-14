/**
 * A design's own copy of a part, edited in a tab of its own: a placed
 * symbol's definition as its sheet embeds it (`lib_symbols`), a placed
 * footprint as its board holds it (docs/libraries-workstream.md §5,
 * Edit symbol… / Edit footprint…).
 *
 * The tab is a projection of the design file, not a file of its own. Its
 * session hands the editor the copy as a one-part library and writes every
 * command back into the design file's session as one step there, so the
 * design file holds the undo history, the unsaved mark and the save; the
 * library is never touched.
 */
import type { HistoryEntry } from './history'
import type { TextSession } from './document/textSession'
import {
  propertyKeyOf,
  referenceForSheetPath,
  setSchematicPropertyHidden,
  setSchematicPropertyPlacement,
  setSchematicPropertyValue,
  setSymbolInstanceReference,
  type KicadSchematic,
  type KicadSchematicSymbol,
  type SchematicProperty
} from './kicad/schematic'
import { parseKicadSymbolLibrary } from './kicad/symbolLibrary'
import { formatNmAtom, nm, type Nm } from './kicad/coordinates'
import { placedPoint, rotateCCW } from './schematic/connectivity'
import {
  cloneNodeDeep,
  findChild,
  findChildren,
  getAtomValues,
  serializeSExpr,
  type SExprList
} from './kicad/sexpr'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export type DesignCopyKind = 'symbol' | 'footprint'

const PREFIX = 'design-copy://'

/** The placed symbol a symbol copy was opened from: its uuid and the sheet path its reference is read on. */
export interface DesignCopyPlacement {
  uuid: string
  sheetPath: string
}

/**
 * The tab path of a design's copy: its kind, the design file it lives in and
 * its id there — a symbol's `lib_symbols` name (`Device:R`), a footprint's
 * uuid — and, for a symbol, the placement it was opened from, whose fields it
 * shows and edits.
 */
export const designCopyPath = (
  kind: DesignCopyKind,
  parent: string,
  id: string,
  placement?: DesignCopyPlacement
): string =>
  `${PREFIX}${kind}/${encodeURIComponent(parent)}/${encodeURIComponent(id)}` +
  (placement
    ? `/${encodeURIComponent(placement.uuid)}/${encodeURIComponent(placement.sheetPath)}`
    : '')

export const isDesignCopyPath = (path: string): boolean => path.startsWith(PREFIX)

export const parseDesignCopyPath = (
  path: string
): { kind: DesignCopyKind; parent: string; id: string; placement?: DesignCopyPlacement } | null => {
  if (!isDesignCopyPath(path)) return null
  const [kind, parent, id, uuid, sheetPath] = path.slice(PREFIX.length).split('/')
  if ((kind !== 'symbol' && kind !== 'footprint') || parent === undefined || id === undefined)
    return null
  return {
    kind,
    parent: decodeURIComponent(parent),
    id: decodeURIComponent(id),
    ...(uuid !== undefined && sheetPath !== undefined
      ? { placement: { uuid: decodeURIComponent(uuid), sheetPath: decodeURIComponent(sheetPath) } }
      : {})
  }
}

/** Two paths name the same copy, perhaps opened from different placements. */
export const sameDesignCopy = (a: string, b: string): boolean => {
  const first = parseDesignCopyPath(a)
  const second = parseDesignCopyPath(b)
  return (
    !!first &&
    !!second &&
    first.kind === second.kind &&
    first.parent === second.parent &&
    first.id === second.id
  )
}

// ---------------------------------------------------------------------------
// A sheet's symbol copy as a one-symbol library
// ---------------------------------------------------------------------------

/** The `(symbol "<id>" …)` node a sheet embeds under `lib_symbols`. */
const copyNode = (schematic: KicadSchematic, id: string): SExprList | null => {
  const container = findChild(schematic._root, 'lib_symbols')
  if (!container) return null
  return findChildren(container, 'symbol').find((node) => getAtomValues(node)[0] === id) ?? null
}

/** The placed symbol a copy was opened from, while the sheet still holds it. */
const placementOf = (
  schematic: KicadSchematic,
  placement: DesignCopyPlacement | undefined
): KicadSchematicSymbol | null =>
  (placement && schematic.symbols.find((symbol) => symbol.uuid === placement.uuid)) || null

/** A field the symbol shows, not one of KiCad's `ki_` keys (filters, keywords, description). */
const isOwnField = (key: string): boolean => !key.startsWith('ki_')

const MANDATORY = new Set(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'])

/** A placed field's sheet point in the symbol's own frame (y up): `placedPoint` undone. */
const localPoint = (
  symbol: KicadSchematicSymbol,
  point: { x: number; y: number }
): { x: Nm; y: Nm } => {
  const dx = point.x - symbol.position.x
  const dy = point.y - symbol.position.y
  const rotated = { x: symbol.mirror === 'y' ? -dx : dx, y: symbol.mirror === 'x' ? dy : -dy }
  const local = rotateCCW(rotated, -symbol.position.angle)
  return { x: nm(Math.round(local.x)), y: nm(Math.round(local.y)) }
}

/** Atoms 1 and 2 of a field's `(at x y angle)`, in place. */
const setAtPoint = (node: SExprList, point: { x: number; y: number }): void => {
  const at = findChild(node, 'at')
  if (!at) return
  const x = at.children[1]
  const y = at.children[2]
  if (x?.type === 'atom') x.value = formatNmAtom(nm(Math.round(point.x)))
  if (y?.type === 'atom') y.value = formatNmAtom(nm(Math.round(point.y)))
}

const propertyNodes = (node: SExprList): SExprList[] =>
  findChildren(node, 'property').filter((property) => isOwnField(propertyKeyOf(property)))

/**
 * The copy as a symbol library the symbol editor opens: the sheet's node,
 * name and all (`Device:R`, as KiCad names an embedded copy), alone in a
 * `kicad_symbol_lib`. Opened from a placement, its fields are that
 * placement's — their text, look and places, the places brought into the
 * symbol's own frame — as KiCad's Edit Symbol shows them. Null when the sheet
 * no longer holds the copy.
 */
export function projectSymbolCopy(
  schematic: KicadSchematic,
  id: string,
  placement?: DesignCopyPlacement
): string | null {
  const copy = copyNode(schematic, id)
  if (!copy) return null
  const node = cloneNodeDeep(copy) as SExprList
  const symbol = placementOf(schematic, placement)
  if (symbol && placement) {
    for (const field of symbol.properties) {
      if (!isOwnField(field.key)) continue
      const shown = cloneNodeDeep(field._node) as SExprList
      if (field.key === 'Reference') {
        const atom = shown.children[2]
        const reference = referenceForSheetPath(symbol, placement.sheetPath)
        if (atom?.type === 'atom' && reference !== undefined) atom.value = reference
      }
      setAtPoint(shown, localPoint(symbol, field.position))
      const own = propertyNodes(node).find((p) => propertyKeyOf(p) === field.key)
      if (own) node.children[node.children.indexOf(own)] = shown
      else {
        const last = propertyNodes(node).at(-1)
        node.children.splice(last ? node.children.indexOf(last) + 1 : 2, 0, shown)
      }
    }
  }
  return `(kicad_symbol_lib (version 20241209) (generator "goatcad") (generator_version "1.0")\n  ${serializeSExpr(node)}\n)\n`
}

/** Tokens a placed field carries beside its effects, copied with them. */
const FIELD_FLAGS = ['show_name', 'do_not_autoplace']

const sameNode = (a: SExprList | null, b: SExprList | null): boolean =>
  (a ? serializeSExpr(a) : '') === (b ? serializeSExpr(b) : '')

/** The edited field's text, place, look and visibility onto the placed field, where they differ. */
function placeEditedField(
  symbol: KicadSchematicSymbol,
  field: SchematicProperty,
  edited: SchematicProperty,
  sheetPath: string
): void {
  if (field.key === 'Reference') {
    if (referenceForSheetPath(symbol, sheetPath) !== edited.value)
      setSymbolInstanceReference(symbol, sheetPath, edited.value)
  } else if (field.value !== edited.value) setSchematicPropertyValue(field, edited.value)
  const point = placedPoint(symbol, edited.position)
  if (
    point.x !== field.position.x ||
    point.y !== field.position.y ||
    edited.position.angle !== field.position.angle
  )
    setSchematicPropertyPlacement(field, { ...point, angle: edited.position.angle })
  const effects = findChild(edited._node, 'effects')
  const own = findChild(field._node, 'effects')
  if (effects && !sameNode(own, effects)) {
    const copy = cloneNodeDeep(effects) as SExprList
    if (own) field._node.children[field._node.children.indexOf(own)] = copy
    else field._node.children.push(copy)
  }
  for (const token of FIELD_FLAGS) {
    const theirs = findChild(edited._node, token)
    const mine = findChild(field._node, token)
    if (sameNode(theirs, mine)) continue
    if (mine) field._node.children.splice(field._node.children.indexOf(mine), 1)
    if (theirs) {
      const before = findChild(field._node, 'effects')
      const index = before ? field._node.children.indexOf(before) : field._node.children.length
      field._node.children.splice(index, 0, cloneNodeDeep(theirs))
    }
  }
  if (field.hidden !== edited.hidden) setSchematicPropertyHidden(field, edited.hidden)
}

/**
 * Write a one-symbol library's symbol back over the sheet's copy, in place.
 * The copy keeps its name whatever the library calls it: the sheet's
 * placements name it, and renaming is not an edit of this part. Opened from
 * a placement, the fields are that placement's: their edits land on it — a
 * moved field moves on the sheet — a field added is added to it, a user
 * field removed is removed from it, and the copy keeps the fields it had.
 */
export function writeSymbolCopy(
  schematic: KicadSchematic,
  id: string,
  libraryText: string,
  placement?: DesignCopyPlacement
): boolean {
  const container = findChild(schematic._root, 'lib_symbols')
  const old = copyNode(schematic, id)
  if (!container || !old) return false
  const parsed = parseLibrarySymbol(libraryText)
  if (!parsed) return false
  const node = cloneNodeDeep(parsed.node) as SExprList
  const name = node.children[1]
  if (name?.type === 'atom') {
    name.value = id
    name.quoted = true
  }
  const symbol = placementOf(schematic, placement)
  if (symbol && placement) {
    const kept = propertyNodes(old)
    for (const property of propertyNodes(node)) {
      const key = propertyKeyOf(property)
      const original = kept.find((p) => propertyKeyOf(p) === key)
      if (original) node.children[node.children.indexOf(property)] = cloneNodeDeep(original)
      else node.children.splice(node.children.indexOf(property), 1)
    }
    for (const edited of parsed.fields) {
      const field = symbol.properties.find((p) => p.key === edited.key)
      if (field) {
        placeEditedField(symbol, field, edited, placement.sheetPath)
        continue
      }
      const added = cloneNodeDeep(edited._node) as SExprList
      setAtPoint(added, placedPoint(symbol, edited.position))
      const last = findChildren(symbol._node, 'property').at(-1)
      symbol._node.children.splice(
        last ? symbol._node.children.indexOf(last) + 1 : symbol._node.children.length,
        0,
        added
      )
    }
    for (const field of [...symbol.properties]) {
      if (!isOwnField(field.key) || MANDATORY.has(field.key)) continue
      if (parsed.fields.some((edited) => edited.key === field.key)) continue
      symbol._node.children.splice(symbol._node.children.indexOf(field._node), 1)
    }
  }
  const index = container.children.indexOf(old)
  if (index < 0) return false
  container.children[index] = node
  return true
}

/** The first symbol of a library's text, read as the editor wrote it: its node and its own fields. */
const parseLibrarySymbol = (
  text: string
): { node: SExprList; fields: SchematicProperty[] } | null => {
  try {
    const library = parseKicadSymbolLibrary(text)
    const first = library.names[0]
    const symbol = first !== undefined ? library.symbols.get(first) : undefined
    if (!symbol) return null
    return { node: symbol._node, fields: symbol.properties.filter((p) => isOwnField(p.key)) }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The session the editor runs on
// ---------------------------------------------------------------------------

/** What a design copy reads from and writes to: the design file's own session. */
export interface DesignCopyHost {
  /** The copy's text now, or null when the design no longer holds it. */
  read(): string | null
  /** Land the copy's new text in the design file, as one step there. */
  write(label: string, text: string): boolean
  undo(): boolean
  redo(): boolean
  mark(): number
  rollback(mark: number): void
  canUndo(): boolean
  canRedo(): boolean
  undoLabel(): string | null
  redoLabel(): string | null
  /** Called after every change to the design file; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  readOnly(): boolean
}

/**
 * A text session over a design copy: the model is parsed from the design
 * file's current text for the copy, a command serializes the edited model
 * and writes it back through the host, and undo and redo are the design
 * file's. `onText` hears the copy's text whenever it changes, for the tab's
 * buffer, and `onMissing` hears the design drop the part, for the tab to close.
 */
export function createDesignCopySession<M, Sel>(deps: {
  host: DesignCopyHost
  parse(text: string): M
  serialize(model: M): string
  onText?(text: string): void
  onMissing?(): void
}): TextSession<M, Sel> & { dispose(): void } {
  let known: string | null = null
  let model: M | null = null
  let parseError: string | null = null
  let revision = 0
  const listeners = new Set<() => void>()

  const read = (): boolean => {
    const text = deps.host.read()
    if (text === known) return false
    known = text
    if (text === null) {
      model = null
      parseError = 'missing'
      deps.onMissing?.()
    } else {
      try {
        model = deps.parse(text)
        parseError = null
      } catch (error) {
        model = null
        parseError = error instanceof Error ? error.message : String(error)
      }
      deps.onText?.(text)
    }
    return true
  }
  const changed = (): void => {
    revision += 1
    for (const listener of listeners) listener()
  }
  read()
  const unsubscribe = deps.host.subscribe(() => {
    if (read()) changed()
  })

  const entry = (label: string | null): HistoryEntry<string, Sel> => ({
    label: label ?? '',
    before: '',
    after: '',
    selectionBefore: [],
    selectionAfter: [],
    timestamp: Date.now()
  })

  return {
    model: () => model,
    parseError: () => parseError,
    revision: () => revision,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    sync: () => {
      if (read()) changed()
    },
    runCommand: (label, mutate) => {
      read()
      const target = model
      if (!target || deps.host.readOnly()) return false
      // The projection's text is formatted as the design file holds it, so the
      // model is compared with itself: serialized before the edit and after.
      let before: string
      try {
        before = deps.serialize(target)
      } catch {
        return false
      }
      mutate(target)
      let after: string
      try {
        after = deps.serialize(target)
      } catch (error) {
        console.error(`Failed to serialize after ${label}:`, error)
        known = null
        if (read()) changed()
        return false
      }
      if (after === before) return false
      const written = deps.host.write(label, after)
      // The host's change notice re-reads the copy; a refused write puts the model back.
      if (!written) {
        known = null
        read()
        changed()
      }
      return written
    },
    undo: () => {
      const label = deps.host.undoLabel()
      return deps.host.undo() ? entry(label) : null
    },
    redo: () => {
      const label = deps.host.redoLabel()
      return deps.host.redo() ? entry(label) : null
    },
    mark: () => deps.host.mark(),
    rollback: (mark) => deps.host.rollback(mark),
    canUndo: () => deps.host.canUndo(),
    canRedo: () => deps.host.canRedo(),
    undoLabel: () => deps.host.undoLabel(),
    redoLabel: () => deps.host.redoLabel(),
    dispose: unsubscribe
  }
}
