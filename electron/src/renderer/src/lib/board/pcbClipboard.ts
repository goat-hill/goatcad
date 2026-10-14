// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Copy, cut, paste and duplicate for the board and footprint editors — the
 * pure half. The store and the cross-editor rules are `lib/documentClipboard.ts`;
 * this module turns a selection into clipboard items and clipboard items back
 * into nodes a board or a footprint can take, following `PCB_CONTROL::Paste`
 * and `CLIPBOARD_IO::SaveSelection` (pcbnew/tools/pcb_control.cpp,
 * pcbnew/kicad_clipboard.cpp):
 *
 * - **Board → board** keeps every item. Nets travel by name and land on the
 *   destination's net of that name, a missing one added to its table (KiCad's
 *   `BOARD::MapNets`), so a copy between two boards reconnects rather than
 *   landing on whatever net shares a number.
 * - **Board → footprint** drops tracks, arcs, vias and zones (a footprint has
 *   none; `survivesFootprintPaste`) and reports how many. Board graphics become
 *   footprint graphics. A footprint pastes as its own pads, graphics and user
 *   text — its fields stay behind, since the footprint being edited already has
 *   its own — laid out as in its library (the board rotation taken off, as
 *   KiCad does for its graphics), and nets are cleared.
 * - **Footprint → board** wraps the items in one new footprint named
 *   `clipboard:<uuid>`, KiCad's own dummy lib id, with empty fields.
 * - **Footprint → footprint** keeps every item. The Reference, Value and every
 *   other field are not copied: KiCad skips the mandatory ones, and a second
 *   field of a name the footprint already has is not something to mint.
 *
 * Every paste gets fresh uuids and comes unlocked (locked means "locked in
 * place", and a copy is somewhere new). A tuning pattern copied with its
 * tracks pastes as a pattern over their copies.
 *
 * Where ours departs from KiCad: a paste does not float under the cursor
 * waiting for a click, as the board editors have no floating move yet. It
 * lands with its top-left point at the cursor when the pointer is over the
 * canvas, and otherwise one grid step from where it was copied (a paste from
 * the other editor, whose coordinates mean nothing here, lands at the origin).
 * Duplicate always takes the grid step, as the symbol editor's does.
 */

import {
  findChild,
  findChildren,
  getAtomValues,
  getToken,
  makeAtom,
  makeList,
  markNodeDirty,
  parseSExpr,
  serializeSExpr,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'
import { formatNmAtom, mmAtomToNm, nm, type Nm } from '../kicad/coordinates'
import {
  survivesFootprintPaste,
  translateGraphicsNode,
  type ClipboardContents
} from '../documentClipboard'
import type { KicadBoard } from '../kicad/board'
import type { KicadFootprint } from '../kicad/footprint'
import { footprintInsertIndex, makeNetRef } from './boardSync'

export interface Point {
  x: number
  y: number
}

// ---------------------------------------------------------------------------
// Geometry over raw item nodes
// ---------------------------------------------------------------------------

/** Lists whose first two atoms are a position in the item's frame. */
const POINT_TOKENS: ReadonlySet<string> = new Set(['at', 'start', 'end', 'mid', 'center', 'xy'])

/**
 * Lists that hold positions further down: a polygon's points, a KiCad 7+
 * arc-in-points, a zone's outline and fills, a text's cached outline glyphs,
 * a table's cells.
 * Anything else (a pad's primitives, a drill offset, a font size) is either
 * relative to its parent or not a position, and is left alone.
 */
const HOLDER_TOKENS: ReadonlySet<string> = new Set([
  'pts',
  'arc',
  'polygon',
  'filled_polygon',
  'render_cache',
  'cells',
  'table_cell'
])

const readPoint = (list: SExprList): Point | null => {
  const [x, y] = getAtomValues(list)
  if (x === undefined || y === undefined) return null
  const px = mmAtomToNm(x)
  const py = mmAtomToNm(y)
  return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : null
}

const writePoint = (list: SExprList, p: Point): void => {
  const atoms = list.children.filter((child, index) => index > 0 && child.type === 'atom')
  const [xAtom, yAtom] = atoms
  if (xAtom?.type === 'atom') xAtom.value = formatNmAtom(nm(p.x))
  if (yAtom?.type === 'atom') yAtom.value = formatNmAtom(nm(p.y))
}

const mapHolder = (list: SExprList, fn: (p: Point) => Point): void => {
  for (const child of list.children) {
    if (child.type !== 'list') continue
    const token = getToken(child) ?? ''
    if (POINT_TOKENS.has(token)) {
      const p = readPoint(child)
      if (p) writePoint(child, fn(p))
    } else if (HOLDER_TOKENS.has(token)) {
      mapHolder(child, fn)
    }
  }
}

/** A tuning pattern's positions: where its meanders run from and to, and its base lines. */
const PATTERN_POINT_TOKENS: ReadonlySet<string> = new Set([
  'origin',
  'end',
  'base_line',
  'base_line_coupled'
])

/** Map every position an item owns. A pad owns only its own `at`. */
const mapItemPoints = (node: SExprList, fn: (p: Point) => Point): void => {
  const token = getToken(node)
  if (token === 'generated') {
    for (const child of node.children)
      if (child.type === 'list' && PATTERN_POINT_TOKENS.has(getToken(child) ?? ''))
        mapHolder(child, fn)
    return
  }
  if (token === 'pad') {
    const at = findChild(node, 'at')
    const p = at ? readPoint(at) : null
    if (at && p) writePoint(at, fn(p))
    return
  }
  if (token === 'footprint') {
    // Children sit in the footprint's frame and move with its `at`; its zones
    // are the exception, held board-absolute (KiCad's own format).
    const at = findChild(node, 'at')
    const p = at ? readPoint(at) : null
    if (at && p) writePoint(at, fn(p))
    for (const zone of findChildren(node, 'zone')) mapHolder(zone, fn)
    return
  }
  mapHolder(node, fn)
}

/** Shift an item by `dx, dy` nm. */
export function translateItem(node: SExprList, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return
  mapItemPoints(node, (p) => ({ x: p.x + dx, y: p.y + dy }))
}

/** Every position the items own, in their own frame (a footprint: its `at`). */
const itemPoints = (nodes: readonly SExprList[]): Point[] => {
  const points: Point[] = []
  for (const node of nodes) {
    mapItemPoints(node, (p) => {
      points.push(p)
      return p
    })
  }
  return points
}

/**
 * The point a paste hangs from: the top-left of every position the items own.
 * Null when they own none.
 */
export function itemsAnchor(nodes: readonly SExprList[]): Point | null {
  const points = itemPoints(nodes)
  if (!points.length) return null
  return {
    x: Math.min(...points.map((p) => p.x)),
    y: Math.min(...points.map((p) => p.y))
  }
}

/** Fresh uuids (and pre-v6 tstamps) on the node and everything under it; each old one's new in `renamed`. */
export function regenerateItemUuids(node: SExprList, renamed?: Map<string, string>): void {
  for (const child of node.children) {
    if (child.type !== 'list') continue
    const token = getToken(child)
    if (token === 'uuid' || token === 'tstamp') {
      const value = child.children[1]
      if (value?.type !== 'atom') continue
      const fresh = crypto.randomUUID()
      renamed?.set(value.value, fresh)
      value.value = fresh
    } else regenerateItemUuids(child, renamed)
  }
}

/**
 * A pasted tuning pattern holds the pasted copies of its tracks, as KiCad's
 * generator pastes with its items (T4): its members renamed to their copies'
 * uuids, those not pasted dropped. False for a pattern none of whose tracks
 * came with it, which is not pasted.
 */
const remapMembers = (node: SExprList, renamed: ReadonlyMap<string, string>): boolean => {
  const members = findChild(node, 'members')
  if (!members) return true
  const kept = getAtomValues(members).flatMap((uuid) => {
    const fresh = renamed.get(uuid)
    return fresh ? [fresh] : []
  })
  // Sorted, as KiCad writes them.
  members.children = [
    members.children[0],
    ...kept.sort().map((uuid) => makeAtom(uuid, true, members.start))
  ]
  return kept.length > 0
}

/** Drop the node's own lock: `(locked yes)` (v8+) or the bare `locked` flag. */
const unlock = (node: SExprList): void => {
  node.children = node.children.filter((child, index) => {
    if (index === 0) return true
    if (child.type === 'atom') return child.value !== 'locked'
    return getToken(child) !== 'locked'
  })
}

// ---------------------------------------------------------------------------
// Nets
// ---------------------------------------------------------------------------

/**
 * Rewrite every net reference under `node` to `(net "name")`, the clipboard's
 * own spelling, so a paste can find the net by name on any board. `names`
 * resolves a numbered file's `(net 3)`.
 */
const netsToNames = (node: SExprList, names: ReadonlyMap<number, string>): void => {
  for (const child of node.children) {
    if (child.type !== 'list') continue
    if (getToken(child) !== 'net') {
      netsToNames(child, names)
      continue
    }
    const atoms = child.children.slice(1).filter((c) => c.type === 'atom')
    const first = atoms[0]
    let name = ''
    if (first?.type === 'atom') {
      if (first.quoted) name = first.value
      else {
        const second = atoms[1]
        name = second?.type === 'atom' ? second.value : (names.get(Number(first.value)) ?? '')
      }
    }
    child.children = [child.children[0], makeAtom(name, true, child.start)]
  }
}

/** The net name a clipboard-spelled `(net "name")` carries. */
const netNameOf = (net: SExprList): string => getAtomValues(net)[0] ?? ''

/**
 * Write each clipboard `(net "name")` under `node` in the destination's
 * dialect. `netRef` is `boardSync.makeNetRef`'s, which adds a missing name to
 * a numbered file's table. No net is written as KiCad writes it: a pad
 * carries none, and a numbered file's track, via or zone says `(net 0)`.
 */
export function mapNetsForBoard(
  node: SExprList,
  netRef: (name: string) => SExprList,
  style: 'number' | 'name'
): void {
  const token = getToken(node)
  const kept: SExprNode[] = []
  for (const child of node.children) {
    if (child.type === 'list' && getToken(child) === 'net') {
      const name = netNameOf(child)
      if (!name) {
        if (style === 'number' && token !== 'pad') {
          kept.push(makeList([makeAtom('net', false, 0), makeAtom('0', false, 0)], 0))
        }
        continue
      }
      const ref = netRef(name)
      // A numbered file's pad reads `(net 3 "GND")`; its copper reads `(net 3)`.
      if (style === 'number' && token !== 'pad') ref.children = ref.children.slice(0, 2)
      kept.push(ref)
      continue
    }
    if (child.type === 'list' && getToken(child) === 'net_name' && token === 'zone') {
      const net = node.children.find(
        (c): c is SExprList => c.type === 'list' && getToken(c) === 'net'
      )
      const name = net ? netNameOf(net) : ''
      const value = child.children[1]
      if (value?.type === 'atom') value.value = name
      kept.push(child)
      continue
    }
    if (child.type === 'list') mapNetsForBoard(child, netRef, style)
    kept.push(child)
  }
  node.children = kept
}

/** Take the nets off a node headed for a footprint, which has none. */
const clearNets = (node: SExprList): void => {
  node.children = node.children.filter((child) => {
    if (child.type !== 'list') return true
    const token = getToken(child)
    if (token === 'net' || token === 'pinfunction' || token === 'pintype') return false
    if (token === 'net_name') {
      const value = child.children[1]
      if (value?.type === 'atom') value.value = ''
      return true
    }
    clearNets(child)
    return true
  })
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const cloneNode = (node: SExprNode): SExprList => parseSExpr(serializeSExpr(node)) as SExprList

/**
 * The clipboard items for a board selection: each top-level node, unlocked,
 * its nets spelled by name. `netNames` is the board's number → name table.
 */
export function copyBoardItems(
  raws: readonly SExprNode[],
  netNames: ReadonlyMap<number, string>
): string[] {
  return raws.map((raw) => {
    const node = cloneNode(raw)
    unlock(node)
    netsToNames(node, netNames)
    return serializeSExpr(node)
  })
}

/** Whether a footprint-editor node travels on the clipboard: fields do not. */
export function copiesFromFootprint(node: SExprNode): boolean {
  if (node.type !== 'list') return false
  const token = getToken(node)
  if (token === 'property') return false
  if (token === 'fp_text') return getAtomValues(node)[0] === 'user'
  return true
}

/** The clipboard items for a footprint-editor selection. */
export function copyFootprintItems(raws: readonly SExprNode[]): string[] {
  return raws.filter(copiesFromFootprint).map((raw) => {
    const node = cloneNode(raw)
    unlock(node)
    return serializeSExpr(node)
  })
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

export interface PreparedPaste {
  /** The nodes to insert, in the destination's spelling and the source's frame. */
  nodes: SExprList[]
  /** Items the destination cannot hold, left out (tracks and vias into a footprint). */
  dropped: number
}

const parseItems = (items: readonly string[]): SExprList[] => {
  const nodes: SExprList[] = []
  for (const text of items) {
    try {
      const node = parseSExpr(text)
      if (node.type === 'list' && getToken(node)) nodes.push(node)
    } catch {
      // Not ours to paste: skip it rather than fail the rest.
    }
  }
  return nodes
}

/** Items spelled the same on a board and in a footprint: they cross unrenamed. */
const SAME_ON_BOTH: ReadonlySet<string> = new Set(['table', 'point'])

/** `(gr_text "x" …)` ↔ `(fp_text user "x" …)`: a rename plus the text's type atom. */
const renameGraphic = (node: SExprList, to: 'board' | 'footprint'): SExprList | null => {
  const token = getToken(node) ?? ''
  const renamed = translateGraphicsNode(token, to)
  if (!renamed) return null
  const head = makeAtom(renamed, false, node.start)
  if (renamed === 'fp_text') {
    node.children = [head, makeAtom('user', false, node.start), ...node.children.slice(1)]
  } else if (renamed === 'gr_text') {
    // Only a user text is ever copied out of a footprint.
    const rest = node.children.slice(1)
    const typeAtom = rest[0]
    node.children = [
      head,
      ...(typeAtom?.type === 'atom' && !typeAtom.quoted ? rest.slice(1) : rest)
    ]
  } else {
    node.children = [head, ...node.children.slice(1)]
  }
  return node
}

const footprintAngle = (footprint: SExprList): number => {
  const at = findChild(footprint, 'at')
  const angle = at ? Number(getAtomValues(at)[2] ?? 0) : 0
  return Number.isFinite(angle) ? angle : 0
}

/** Take `by` degrees off an `(at x y angle)`; a pad drops a zero angle, as KiCad writes it. */
const turnAt = (node: SExprList, by: number): void => {
  const at = findChild(node, 'at')
  if (!at || by === 0) return
  const atoms = at.children.filter((child, index) => index > 0 && child.type === 'atom')
  const current = Number(atoms[2]?.type === 'atom' ? atoms[2].value : 0) || 0
  let angle = (((current - by) % 360) + 360) % 360
  angle = Math.round(angle * 1e6) / 1e6
  if (angle > 180) angle -= 360
  const text = String(angle)
  const angleAtom = atoms[2]
  if (angleAtom?.type === 'atom') {
    if (angle === 0 && getToken(node) === 'pad') {
      at.children = at.children.filter((child) => child !== angleAtom)
    } else angleAtom.value = text
  } else if (angle !== 0) at.children.push(makeAtom(text, false, at.start))
}

/** Rotate `p` about `c` by `degrees`, KiCad's sense (counter-clockwise on screen, y down). */
const rotateAbout = (p: Point, c: Point, degrees: number): Point => {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos + dy * sin, y: c.y - dx * sin + dy * cos }
}

/**
 * A board footprint's pads, graphics and user text, as a footprint editor
 * takes them: each where the footprint's library has it, moved to where the
 * footprint stood. The board rotation comes off every angle and its zones turn
 * back with it; a flipped footprint stays flipped, on its back layers.
 */
const footprintChildren = (footprint: SExprList): SExprList[] => {
  const at = findChild(footprint, 'at')
  const origin = (at && readPoint(at)) ?? { x: 0, y: 0 }
  const angle = footprintAngle(footprint)
  const out: SExprList[] = []
  for (const child of footprint.children) {
    if (child.type !== 'list') continue
    const token = getToken(child) ?? ''
    if (token === 'zone') {
      mapHolder(child, (p) => rotateAbout(p, origin, -angle))
      out.push(child)
      continue
    }
    const keep =
      token === 'pad' ||
      SAME_ON_BOTH.has(token) ||
      (token.startsWith('fp_') && token !== 'fp_text') ||
      (token === 'fp_text' && getAtomValues(child)[0] === 'user')
    if (!keep) continue
    if (token === 'pad' || token === 'fp_text') turnAt(child, angle)
    translateItem(child, origin.x, origin.y)
    out.push(child)
  }
  return out
}

/** What a footprint editor pastes from `contents`. */
export function prepareFootprintPaste(contents: ClipboardContents): PreparedPaste {
  const parsed = parseItems(contents.items)
  if (contents.kind === 'footprint') return { nodes: parsed, dropped: 0 }
  const nodes: SExprList[] = []
  let dropped = 0
  for (const node of parsed) {
    const token = getToken(node) ?? ''
    if (token === 'footprint') {
      for (const child of footprintChildren(node)) {
        clearNets(child)
        nodes.push(child)
      }
    } else if (!survivesFootprintPaste(token)) {
      dropped++
    } else if (SAME_ON_BOTH.has(token)) {
      nodes.push(node)
    } else {
      const renamed = renameGraphic(node, 'footprint')
      if (renamed) nodes.push(renamed)
      else dropped++
    }
  }
  return { nodes, dropped }
}

/**
 * What a board pastes from `contents`. A footprint editor's items arrive as
 * one new footprint standing at their top-left point, its children in its
 * frame and its zones board-absolute.
 */
export function prepareBoardPaste(contents: ClipboardContents): PreparedPaste {
  const parsed = parseItems(contents.items)
  if (contents.kind === 'board') return { nodes: parsed, dropped: 0 }
  const anchor = itemsAnchor(parsed) ?? { x: 0, y: 0 }
  for (const node of parsed) {
    // Zones stay where they are: a board footprint holds them board-absolute,
    // and the footprint stands at the anchor.
    if (getToken(node) !== 'zone') translateItem(node, -anchor.x, -anchor.y)
    // A library footprint's `(net 0)` is no net, not a net named "0".
    netsToNames(node, new Map())
  }
  const at = 0
  const footprint = makeList(
    [
      makeAtom('footprint', false, at),
      makeAtom(`clipboard:${crypto.randomUUID()}`, true, at),
      makeList([makeAtom('layer', false, at), makeAtom('F.Cu', true, at)], at),
      makeList([makeAtom('uuid', false, at), makeAtom(crypto.randomUUID(), true, at)], at),
      makeList(
        [
          makeAtom('at', false, at),
          makeAtom(formatNmAtom(nm(anchor.x)), false, at),
          makeAtom(formatNmAtom(nm(anchor.y)), false, at)
        ],
        at
      ),
      ...parsed
    ],
    at
  )
  return { nodes: [footprint], dropped: 0 }
}

/** Snap `value` to the grid laid from `origin` (no-op for a zero step). */
const snap = (value: number, step: number, origin = 0): number =>
  step > 0 ? Math.round((value - origin) / step) * step + origin : value

/**
 * How far to move a paste. At the cursor: the anchor, snapped to the grid,
 * lands on it (so items on the grid stay on it). Without one: a grid step down
 * and right of where it was copied, or — from the other editor — the origin.
 */
export function pasteOffset(
  anchor: Point | null,
  options: { cursor: Point | null; gridStep: Nm; sameKind: boolean; gridOrigin?: Point }
): Point {
  const from = anchor ?? { x: 0, y: 0 }
  const grid = options.gridOrigin ?? { x: 0, y: 0 }
  const origin = {
    x: snap(from.x, options.gridStep, grid.x),
    y: snap(from.y, options.gridStep, grid.y)
  }
  if (options.cursor) return { x: options.cursor.x - origin.x, y: options.cursor.y - origin.y }
  if (options.sameKind) return { x: options.gridStep, y: options.gridStep }
  return { x: -origin.x, y: -origin.y }
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/** A selection ref, as both editors spell one (`{ type, index }`). */
export interface ItemRef {
  type: string
  index: number
}

/** The board selection type of a top-level node (a track arc is `tarc`). */
const boardSelectionType = (node: SExprList): string => {
  const token = getToken(node) ?? ''
  if (token === 'arc') return 'tarc'
  if (token === 'generated') {
    const type = findChild(node, 'type')
    return type && getAtomValues(type)[0] === 'tuning_pattern' ? 'tuning_pattern' : token
  }
  return token
}

const boardCollectionLength = (board: KicadBoard, type: string): number | null => {
  switch (type) {
    case 'footprint':
      return board.footprints.length
    case 'segment':
      return board.segments.length
    case 'tarc':
      return board.trackArcs.length
    case 'via':
      return board.vias.length
    case 'zone':
      return board.zones.length
    case 'gr_line':
      return board.grLines.length
    case 'gr_arc':
      return board.grArcs.length
    case 'gr_circle':
      return board.grCircles.length
    case 'gr_rect':
      return board.grRects.length
    case 'gr_poly':
      return board.grPolys.length
    case 'gr_text':
      return board.grTexts.length
    case 'gr_curve':
      return board.grCurves.length
    case 'gr_text_box':
      return board.grTextBoxes.length
    case 'table':
      return board.tables.length
    case 'point':
      return board.points.length
    case 'tuning_pattern':
      return board.tuningPatterns.length
  }
  return null
}

/**
 * Write a prepared paste onto a board's AST, moved by `delta`: fresh uuids,
 * nets in the board's dialect, footprints with the others and everything else
 * after the last item. Returns what the board's selection will call the new
 * items once it is remapped. Mutates `board._raw` only; the caller runs this
 * inside its command.
 */
export function insertIntoBoard(
  board: KicadBoard,
  nodes: readonly SExprList[],
  delta: Point
): ItemRef[] {
  const root = board._raw as SExprList
  const { netRef, finish } = makeNetRef(board)
  const added = new Map<string, number>()
  const refs: ItemRef[] = []
  const footprints: SExprList[] = []
  const renamed = new Map<string, string>()
  for (const node of nodes) {
    translateItem(node, delta.x, delta.y)
    regenerateItemUuids(node, renamed)
    mapNetsForBoard(node, netRef, board.netRefStyle)
  }
  for (const node of nodes) {
    const token = getToken(node) ?? ''
    if (token === 'generated' && !remapMembers(node, renamed)) continue
    if (token === 'footprint') footprints.push(node)
    else root.children.push(node)
    const type = boardSelectionType(node)
    const base = boardCollectionLength(board, type)
    if (base === null) continue
    const count = added.get(type) ?? 0
    added.set(type, count + 1)
    refs.push({ type, index: base + count })
  }
  if (footprints.length) root.children.splice(footprintInsertIndex(root), 0, ...footprints)
  finish()
  return refs
}

/** The footprint editor's selection type for a top-level token. */
const FOOTPRINT_SELECTION_TYPE: Readonly<Record<string, string>> = {
  pad: 'pad',
  fp_line: 'line',
  fp_arc: 'arc',
  fp_circle: 'circle',
  fp_rect: 'rect',
  fp_poly: 'poly',
  zone: 'zone',
  fp_text: 'text',
  fp_curve: 'curve',
  fp_text_box: 'textbox',
  table: 'table',
  point: 'point'
}

const footprintCollectionLength = (fp: KicadFootprint, type: string): number | null => {
  switch (type) {
    case 'pad':
      return fp.pads.length
    case 'line':
      return fp.fpLines.length
    case 'arc':
      return fp.fpArcs.length
    case 'circle':
      return fp.fpCircles.length
    case 'rect':
      return fp.fpRects.length
    case 'poly':
      return fp.fpPolys.length
    case 'zone':
      return fp.zones.length
    case 'text':
      return fp.fpTexts.length
    case 'curve':
      return fp.fpCurves.length
    case 'textbox':
      return fp.fpTextBoxes.length
    case 'table':
      return fp.tables.length
    case 'point':
      return fp.points.length
  }
  return null
}

/**
 * Write a prepared paste onto a footprint's AST, moved by `delta`, each item
 * appended after the last as the footprint's own writers do. Returns the
 * selection refs the new items will have once the footprint is re-read.
 */
export function insertIntoFootprint(
  fp: KicadFootprint,
  nodes: readonly SExprList[],
  delta: Point
): ItemRef[] {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  const added = new Map<string, number>()
  const refs: ItemRef[] = []
  for (const node of nodes) {
    translateItem(node, delta.x, delta.y)
    regenerateItemUuids(node)
    root.children.push(node)
    const type = FOOTPRINT_SELECTION_TYPE[getToken(node) ?? '']
    const base = type ? footprintCollectionLength(fp, type) : null
    if (type === undefined || base === null) continue
    const count = added.get(type) ?? 0
    added.set(type, count + 1)
    refs.push({ type, index: base + count })
  }
  return refs
}
