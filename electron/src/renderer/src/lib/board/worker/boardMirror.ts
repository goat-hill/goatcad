/**
 * The board worker's copy of a session's board (docs/performance-workstream.md,
 * "The board worker"). Loaded from the board's text, then kept current by each
 * change the session makes, sent as its top-level items by id: an item the
 * worker holds is reused as it is, any other is parsed from its text. An item
 * changed in place on the session's side arrives as new text under its old id
 * and replaces the node here, so the board before a change is never written:
 * a job still reading it sees the board it started on.
 */
import { parseKicadBoard, remapKicadBoard, type KicadBoard } from '../../kicad/board'
import { parseSExpr, type SExprList, type SExprNode } from '../../kicad/sexpr'
import { boardIndex, type BoardSpatialIndex } from '../spatialIndex'

/** What one change did to the copy: the boards on either side and every node it touched. */
export interface MirrorChange {
  from: { board: KicadBoard; index: BoardSpatialIndex }
  raws: Set<SExprNode>
}

export class BoardMirror {
  private nodes = new Map<number, SExprNode>()
  private current: { board: KicadBoard; index: BoardSpatialIndex } | null = null

  get board(): KicadBoard | null {
    return this.current?.board ?? null
  }

  get index(): BoardSpatialIndex | null {
    return this.current?.index ?? null
  }

  /** The id a top-level item of the current board goes by. */
  idOf(node: SExprNode): number | undefined {
    return this.ids.get(node)
  }

  /** Each current top-level item's id. */
  private ids = new Map<SExprNode, number>()

  /** Parse the board; `ids` names its top-level items in order. */
  load(text: string, ids: Int32Array): void {
    const board = parseKicadBoard(text)
    const children = (board._raw as SExprList).children
    if (children.length !== ids.length) {
      throw new Error(`board worker: ${children.length} top-level items, ${ids.length} ids`)
    }
    this.nodes = new Map()
    children.forEach((node, i) => this.nodes.set(ids[i], node))
    this.ids = new Map([...this.nodes].map(([id, node]) => [node, id]))
    this.current = { board, index: boardIndex(board) }
  }

  /** Apply a change; throws when it names an item the copy does not hold. */
  apply(order: Int32Array, texts: ReadonlyArray<[number, string]>): MirrorChange {
    const before = this.current
    if (!before) throw new Error('board worker: change before load')
    const replaced = new Map<number, SExprNode>()
    for (const [id, text] of texts) replaced.set(id, parseItem(text))
    const raws = new Set<SExprNode>()
    const next = new Map<number, SExprNode>()
    const children: SExprNode[] = []
    for (const id of order) {
      const fresh = replaced.get(id)
      const node = fresh ?? this.nodes.get(id)
      if (!node) throw new Error(`board worker: no item ${id}`)
      if (fresh) {
        raws.add(fresh)
        const old = this.nodes.get(id)
        if (old) raws.add(old)
      }
      next.set(id, node)
      children.push(node)
    }
    for (const [id, node] of this.nodes) if (!next.has(id)) raws.add(node)
    this.nodes = next
    this.ids = new Map([...next].map(([id, node]) => [node, id]))

    const root = before.board._raw as SExprList
    // The old board keeps its own children: a new root for the new board.
    const nextRoot: SExprList = { ...root, children }
    const board = remapKicadBoard({ ...before.board, _raw: nextRoot })
    const index = boardIndex(board, {
      from: before.index,
      prevArrays: before.board,
      raws
    })
    this.current = { board, index }
    return { from: before, raws }
  }

  clear(): void {
    this.nodes = new Map()
    this.current = null
  }
}

/** A top-level item from its text: a list, or a lone atom (the root's token). */
const parseItem = (text: string): SExprNode => parseSExpr(text)
