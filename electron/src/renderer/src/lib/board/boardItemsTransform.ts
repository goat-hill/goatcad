/**
 * `items.transform` on a board: the PCB editor's Move, Rotate, Flip, Mirror
 * and Duplicate, applied to items by id. The edits are the editor's own
 * (`boardSelectionEdit.ts`); this module resolves ids to the editor's
 * selection refs, picks the pivot the editor would, and names what changed.
 *
 * Where the agent departs from the editor, for a call that must answer the
 * same every time: a pivot of several items is the middle of their box,
 * never snapped to the person's grid, and a duplicated footprint counts up
 * from its own number to the first free reference, so its id names one
 * footprint. Locked
 * items transform, as the editor's selection verbs move them.
 *
 * Millimeters in board space, y down, as the item records read.
 */
import { getToken, type SExprList } from '../kicad/sexpr'
import { remapKicadBoard, type KicadBoard } from '../kicad/board'
import { mmToNm, type Nm } from '../kicad/coordinates'
import type { McpChanged, McpItemsTransform } from '../../../../preload/mcpTypes'
import { boardItemIds, boardItems, resolveWritable, type BoardItem } from './boardItems'
import { NODE_TRANSFORM_TYPES, transformCenter } from './boardItemTransform'
import {
  MIRROR_TYPES,
  duplicateNodes,
  flipBoardItems,
  flipUnits,
  mirrorBoardItems,
  mirrorCenter,
  mirrorEntries,
  moveElements,
  rotateBoardItems,
  snapshotMoveElements,
  type SelectionRef
} from './boardSelectionEdit'
import { boardCollection } from './pcbPropertySchema'
import { insertIntoBoard } from './pcbClipboard'
import { patternMembers } from './tuningPatterns'
import { referenceNode } from './footprintPlace'
import { strNumCmp } from '../schematic/sheetPages'

/** A refusal: an item failure, or a transform that does not take an item. */
export type TransformFailure = { ok: false; error: string; detail: string; candidates?: string[] }

export type BoardTransformOutcome =
  { ok: true; board: KicadBoard; changed: McpChanged } | TransformFailure

const nmXY = (p: { x: number; y: number }): { x: Nm; y: Nm } => ({
  x: mmToNm(p.x),
  y: mmToNm(p.y)
})

const notTransformable = (detail: string): TransformFailure => ({
  ok: false,
  error: 'not-transformable',
  detail
})

/** The board editor's selection type for each graphic kind. */
const GRAPHIC_TYPES: Partial<Record<BoardItem['kind'], string>> = {
  line: 'gr_line',
  arc: 'gr_arc',
  circle: 'gr_circle',
  rect: 'gr_rect',
  poly: 'gr_poly',
  bezier: 'gr_curve'
}

/** The selection ref the board editor would hold for an item, or a refusal. */
function refOf(board: KicadBoard, item: BoardItem): SelectionRef | TransformFailure {
  switch (item.kind) {
    case 'footprint':
      return { type: 'footprint', index: board.footprints.indexOf(item.footprint) }
    case 'pad':
      return notTransformable(
        `${item.id} is a pad, which goes with its footprint; transform ${item.id.split('.')[0]}.`
      )
    case 'track':
      return 'mid' in item.track
        ? { type: 'tarc', index: board.trackArcs.indexOf(item.track) }
        : { type: 'segment', index: board.segments.indexOf(item.track) }
    case 'via':
      return { type: 'via', index: board.vias.indexOf(item.via) }
    case 'zone':
      if (item.zone.footprint !== undefined)
        return notTransformable(`${item.id} is a footprint's zone and goes with its footprint.`)
      return { type: 'zone', index: board.zones.indexOf(item.zone) }
    case 'text':
      return { type: 'gr_text', index: board.grTexts.indexOf(item.text) }
    case 'text_box':
      return { type: 'gr_text_box', index: board.grTextBoxes.indexOf(item.textBox) }
    case 'point':
      return { type: 'point', index: board.points.indexOf(item.point) }
    case 'table':
      return { type: 'table', index: board.tables.indexOf(item.table) }
    case 'tuning_pattern':
      return { type: 'tuning_pattern', index: board.tuningPatterns.indexOf(item.pattern) }
    default:
      return {
        type: GRAPHIC_TYPES[item.kind]!,
        index: (boardCollection(board, GRAPHIC_TYPES[item.kind]!) ?? []).indexOf(item.graphic)
      }
  }
}

/** The ids of the items `refs` name on `board`; a transform never reorders a collection. */
const idsAt = (board: KicadBoard, refs: readonly SelectionRef[]): string[] => {
  const { byObject } = boardItemIds(board)
  return refs.flatMap((ref) => {
    const object = boardCollection(board, ref.type)?.[ref.index]
    const id = object ? byObject.get(object as object) : undefined
    return id ? [id] : []
  })
}

/**
 * A duplicated footprint's reference made unique as KiCad's Paste Special
 * "unique annotations" does (`BOARD_REANNOTATE_TOOL::ReannotateDuplicates`):
 * in reference order, count up from its own number to the first one the
 * board does not use, so R1 copies as R2 when R2 is free and R3 when it is
 * not, and an unannotated R? as R1.
 */
function renumberFootprints(nodes: readonly SExprList[], existing: string[]): void {
  const used = new Set(existing)
  const values = nodes.flatMap((node) => {
    if (getToken(node) !== 'footprint') return []
    const value = referenceNode(node)?.children[2]
    return value?.type === 'atom' ? [value] : []
  })
  values.sort((a, b) => strNumCmp(a.value, b.value, true))
  for (const value of values) {
    // KiCad's prefix (`UTIL::GetRefDesPrefix`) drops the trailing digits and ?s.
    const stem = value.value.replace(/[?\d]+$/, '')
    let number = Number(/(\d*)$/.exec(value.value)![1] || 0)
    let reference = value.value
    while (used.has(reference)) reference = `${stem}${++number}`
    value.value = reference
    used.add(reference)
  }
}

/**
 * Apply one transform to the items `request.ids` names, editing `board`'s AST.
 * Answers the board remapped and what changed, or a refusal with the board
 * untouched.
 */
export function transformBoardItemsById(
  board: KicadBoard,
  request: McpItemsTransform
): BoardTransformOutcome {
  if (request.transform === 'anchor')
    return notTransformable(
      'A board has no anchor: anchor moves the origin of a footprint definition.'
    )
  const items = boardItems(board)
  const refs: SelectionRef[] = []
  /** Each ref's id as the call named it, for a refusal's detail. */
  const named = new Map<SelectionRef, string>()
  const seen = new Set<string>()
  for (const id of request.ids) {
    const found = resolveWritable(items, id)
    if (!found.ok) return found
    const ref = refOf(board, found.item)
    if ('ok' in ref) return ref
    const key = `${ref.type}:${ref.index}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
    named.set(ref, found.item.id)
  }
  const idOf = (ref: SelectionRef): string => named.get(ref) ?? ref.type
  // The board editor turns and flips these types; a text box or table it leaves where it is.
  if (request.transform === 'rotate' || request.transform === 'flip') {
    const still = refs.find(
      (ref) => ref.type !== 'footprint' && !NODE_TRANSFORM_TYPES.has(ref.type)
    )
    if (still)
      return notTransformable(
        `${idOf(still)} does not ${request.transform}: the board editor leaves text boxes and tables in place. Move it instead.`
      )
  }
  const about = request.about ? nmXY(request.about) : null
  const updated = (): BoardTransformOutcome => {
    const after = remapKicadBoard(board)
    return {
      ok: true,
      board: after,
      changed: { created: [], updated: idsAt(after, refs), deleted: [] }
    }
  }

  switch (request.transform) {
    case 'move': {
      const by = nmXY(request.by!)
      moveElements(board, snapshotMoveElements(board, refs), by.x, by.y)
      return updated()
    }
    case 'rotate': {
      const angle = request.angle!
      const rect = refs.find((ref) => ref.type === 'gr_rect')
      if (rect && angle % 90 !== 0)
        return notTransformable(
          `${idOf(rect)} is a rect, which turns in quarter turns; pass a multiple of 90 or turn the others without it.`
        )
      const center = about ?? transformCenter(board, refs, 'rotate', 0)
      if (!center) return notTransformable('Nothing to turn.')
      rotateBoardItems(board, refs, center, angle)
      return updated()
    }
    case 'flip': {
      const { footprints, others, units } = flipUnits(board, refs)
      const stuck = refs.find(
        (ref) => ref.type === 'footprint' && !units.some((unit) => unit.index === ref.index)
      )
      if (stuck)
        return notTransformable(
          `${idOf(stuck)} holds a table, which the board editor cannot flip either.`
        )
      const center = about ?? transformCenter(board, units, 'flip', 0)
      if (!center) return notTransformable('Nothing to flip.')
      flipBoardItems(board, footprints, others, center)
      return updated()
    }
    case 'mirror': {
      const other = refs.find((ref) => !MIRROR_TYPES.has(ref.type))
      if (other)
        return notTransformable(
          `${idOf(other)} does not mirror: mirror takes board graphics, texts and zones. Flip a footprint, track or via instead.`
        )
      const entries = mirrorEntries(board, refs)
      // "x" flips top to bottom, which the editor calls Mirror Vertically.
      const axis = request.axis === 'x' ? 'vertical' : 'horizontal'
      const center = about ?? mirrorCenter(entries, refs.length === 1, 0)
      if (!center) return notTransformable('Nothing to mirror.')
      mirrorBoardItems(board, entries, center, axis)
      return updated()
    }
    case 'duplicate': {
      // A tuning pattern duplicates with its tracks, as a pattern over their copies (T4).
      const keys = new Set(refs.map((ref) => `${ref.type}:${ref.index}`))
      const members = refs.flatMap((ref) => {
        const pattern = ref.type === 'tuning_pattern' ? board.tuningPatterns[ref.index] : undefined
        return pattern
          ? patternMembers(board, pattern).filter((m) => !keys.has(`${m.type}:${m.index}`))
          : []
      })
      const raws = [...refs, ...members].flatMap((ref) => {
        const object = boardCollection(board, ref.type)?.[ref.index] as
          { _raw: SExprList } | undefined
        return object ? [object._raw] : []
      })
      const nodes = duplicateNodes(board, raws)
      renumberFootprints(
        nodes,
        board.footprints.map((footprint) => footprint.reference ?? '')
      )
      const created = insertIntoBoard(board, nodes, nmXY(request.by!))
      const after = remapKicadBoard(board)
      return {
        ok: true,
        board: after,
        changed: { created: idsAt(after, created), updated: [], deleted: [] }
      }
    }
  }
}
