/**
 * What changed between two versions of one `.kicad_pcb`, item by item — the
 * model behind the board's visual diff, `schematicDiff.ts`'s twin.
 *
 * Items pair by uuid (`tstamp` in files before KiCad 8), so a dragged part is
 * one moved footprint rather than a removal and an addition. A matched item is
 * `moved` when only its geometry differs and `modified` when anything else
 * does. A zone's fill is neither: a refill rewrites every filled polygon
 * without the design changing, so it is left out of both.
 */
import { getToken, serializeSExpr, type SExprNode } from '../kicad/sexpr'
import type { KicadBoard } from '../kicad/board'
import type { FieldChange, SchematicChangeKind } from './schematicDiff'

export type BoardChangeKind = SchematicChangeKind

/** An item's render-key prefix, which is also its `BoardItemRef.type`. */
export type BoardItemKind = (typeof COLLECTIONS)[number][0]

export interface BoardChange {
  kind: BoardChangeKind
  item: BoardItemKind
  /** The uuid, or `kind#index` for an item without one. */
  id: string
  /** What a person calls it: a reference, a net, a text. */
  label: string
  /** Its render key (`footprint:3`) in each version that has it. */
  beforeKey?: string
  afterKey?: string
  fields: FieldChange[]
}

export interface BoardDiff {
  changes: BoardChange[]
  counts: Record<BoardChangeKind, number>
}

/** Every diffed collection, by render-key prefix, in the order the list reads. */
const COLLECTIONS = [
  ['footprint', 'footprints'],
  ['zone', 'zones'],
  ['via', 'vias'],
  ['segment', 'segments'],
  ['tarc', 'trackArcs'],
  ['gr_line', 'grLines'],
  ['gr_arc', 'grArcs'],
  ['gr_circle', 'grCircles'],
  ['gr_rect', 'grRects'],
  ['gr_poly', 'grPolys'],
  ['gr_curve', 'grCurves'],
  ['gr_text', 'grTexts'],
  ['gr_text_box', 'grTextBoxes'],
  ['table', 'tables'],
  ['dimension', 'dimensions'],
  ['point', 'points']
] as const satisfies ReadonlyArray<readonly [string, keyof KicadBoard]>

type ArrayName = (typeof COLLECTIONS)[number][1]

const ARRAY_OF = Object.fromEntries(COLLECTIONS) as Record<BoardItemKind, ArrayName>
const ITEM_ORDER = Object.fromEntries(COLLECTIONS.map(([kind], i) => [kind, i])) as Record<
  BoardItemKind,
  number
>

/** Lists naming where a thing is rather than what it is. */
const GEOMETRY = new Set(['at', 'xy', 'start', 'end', 'mid', 'center', 'pts'])
/** A zone's computed fill: rewritten by every refill, never a design change. */
const FILL = new Set(['filled_polygon', 'fill_segments', 'filled_areas_thickness'])

/**
 * An item's content and geometry, separated: content is the node with every
 * geometry list removed, geometry those lists alone, in order.
 */
const signatures = (node: SExprNode): { content: string; geometry: string } => {
  const geometry: string[] = []
  const write = (n: SExprNode): string => {
    if (n.type === 'atom') return n.value
    const head = getToken(n)
    if (head !== null && FILL.has(head)) return ''
    if (head !== null && GEOMETRY.has(head)) {
      geometry.push(serializeSExpr(n, 0, true))
      return ''
    }
    return `(${n.children.map(write).filter(Boolean).join(' ')})`
  }
  return { content: write(node), geometry: geometry.join(' ') }
}

interface Entry {
  item: BoardItemKind
  id: string
  key: string
  label: string
  node: SExprNode
  properties?: ReadonlyArray<{ key: string; value: string }>
  text?: string
}

/** Every matchable item of one side, by id. */
export function boardEntries(board: KicadBoard): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  const netName = new Map(board.nets.map((n) => [n.number, n.name]))
  for (const [item, name] of COLLECTIONS) {
    const list = board[name] as ReadonlyArray<{ uuid?: string; _raw: SExprNode }>
    list.forEach((raw, i) => {
      const entry: Entry = {
        item,
        id: raw.uuid ?? `${item}#${i}`,
        key: `${item}:${i}`,
        label: item,
        node: raw._raw
      }
      if (item === 'footprint') {
        const fp = board.footprints[i]
        entry.label = fp.reference ?? fp.libId
        entry.properties = fp.footprint.properties
      } else if (item === 'segment' || item === 'tarc' || item === 'via') {
        const net = (board[name] as ReadonlyArray<{ net: number }>)[i].net
        entry.label = netName.get(net) || item
      } else if (item === 'zone') {
        const zone = board.zones[i]
        entry.label = zone.name ?? zone.netName ?? item
      } else if (item === 'gr_text') {
        entry.label = entry.text = board.grTexts[i].text
      }
      // Two items claiming one id (a copy that kept its uuid) keep the first.
      if (!entries.has(entry.id)) entries.set(entry.id, entry)
    })
  }
  return entries
}

const fieldChanges = (
  before: ReadonlyArray<{ key: string; value: string }>,
  after: ReadonlyArray<{ key: string; value: string }>
): FieldChange[] => {
  const changes: FieldChange[] = []
  const was = new Map(before.map((p) => [p.key, p.value]))
  const now = new Map(after.map((p) => [p.key, p.value]))
  for (const [name, value] of now) {
    const old = was.get(name)
    if (old !== value)
      changes.push({ name, ...(old !== undefined ? { before: old } : {}), after: value })
  }
  for (const [name, value] of was) if (!now.has(name)) changes.push({ name, before: value })
  return changes
}

const row = (kind: BoardChangeKind, entry: Entry, fields: FieldChange[] = []): BoardChange => ({
  kind,
  item: entry.item,
  id: entry.id,
  label: entry.label,
  fields
})

/**
 * Diff two parsed versions. Either may be null (a file that did not exist on
 * that side), which makes every item of the other side added or removed.
 */
export function diffBoards(before: KicadBoard | null, after: KicadBoard | null): BoardDiff {
  const was = before ? boardEntries(before) : new Map<string, Entry>()
  const now = after ? boardEntries(after) : new Map<string, Entry>()
  const changes: BoardChange[] = []

  for (const [id, entry] of now) {
    const old = was.get(id)
    if (!old) {
      changes.push({ ...row('added', entry), afterKey: entry.key })
      continue
    }
    const a = signatures(old.node)
    const b = signatures(entry.node)
    const contentChanged = a.content !== b.content
    if (!contentChanged && a.geometry === b.geometry) continue
    let fields: FieldChange[] = []
    if (entry.properties && old.properties) fields = fieldChanges(old.properties, entry.properties)
    else if (entry.text !== undefined && old.text !== entry.text) {
      fields = [{ name: 'text', before: old.text, after: entry.text }]
    }
    changes.push({
      ...row(contentChanged ? 'modified' : 'moved', entry, fields),
      beforeKey: old.key,
      afterKey: entry.key
    })
  }
  for (const [id, entry] of was) {
    if (!now.has(id)) changes.push({ ...row('removed', entry), beforeKey: entry.key })
  }

  changes.sort(
    (a, b) =>
      ITEM_ORDER[a.item] - ITEM_ORDER[b.item] ||
      a.label.localeCompare(b.label, undefined, { numeric: true })
  )
  const counts: Record<BoardChangeKind, number> = { added: 0, removed: 0, modified: 0, moved: 0 }
  for (const change of changes) counts[change.kind]++
  return { changes, counts }
}

const parseKey = (key: string): { item: BoardItemKind; index: number } | null => {
  const at = key.lastIndexOf(':')
  const item = key.slice(0, at)
  const index = Number(key.slice(at + 1))
  return item in ARRAY_OF && Number.isInteger(index) ? { item: item as BoardItemKind, index } : null
}

/**
 * The "after" board with the removed items drawn back in where they were, so
 * one picture shows both what is new and what went away. Returns the combined
 * board (render only — it is never written) and the render key each removed
 * change landed on, by change id. A removed track keeps its old net number,
 * which may name another net in the after board: the diff draws no net names.
 */
export function withRemovedBoardItems(
  after: KicadBoard | null,
  before: KicadBoard | null,
  changes: readonly BoardChange[]
): { board: KicadBoard | null; removedKeys: Map<string, string> } {
  const removedKeys = new Map<string, string>()
  if (!before) return { board: after, removedKeys }
  const base = after ?? before
  const board: KicadBoard = { ...base }
  for (const [, name] of COLLECTIONS) {
    ;(board as unknown as Record<ArrayName, unknown[]>)[name] = after ? [...after[name]] : []
  }
  for (const change of changes) {
    if (change.kind !== 'removed' || !change.beforeKey) continue
    const ref = parseKey(change.beforeKey)
    if (!ref) continue
    const name = ARRAY_OF[ref.item]
    const item = before[name][ref.index]
    if (!item) continue
    const target = board[name] as unknown[]
    removedKeys.set(change.id, `${ref.item}:${target.length}`)
    target.push(item)
  }
  return { board, removedKeys }
}
