/**
 * `items.transform` on a footprint: the footprint editor's Rotate, Mirror,
 * Change Side, Move, Duplicate and Place Footprint Anchor, applied to items by
 * id. The geometry is the editor's own (`footprintTransform.ts`, the
 * clipboard's `translateItem` and paste insert); this module resolves ids,
 * picks the pivot the editor would, and names what changed.
 *
 * Millimeters in the footprint's frame, y down, as the item records read.
 */
import {
  parseKicadFootprint,
  serializeKicadFootprint,
  type KicadFootprint,
  type SExprList
} from '../kicad/footprint'
import { markNodeDirty } from '../kicad/sexpr'
import { mmToNm, type Nm } from '../kicad/coordinates'
import type { McpChanged, McpItemsTransform } from '../../../../preload/mcpTypes'
import {
  copiesFromFootprint,
  copyFootprintItems,
  insertIntoFootprint,
  prepareFootprintPaste,
  translateItem
} from '../board/pcbClipboard'
import {
  hasPadstack,
  moveFootprintAnchor,
  transformFootprintItems,
  transformPivot,
  type FootprintTransform
} from './footprintTransform'
import { footprintItems, locateItems, resolveItem, type FootprintItem } from './footprintItems'

export type TransformFailure = {
  ok: false
  error: string
  detail: string
  candidates?: string[]
}

const nmXY = (p: { x: number; y: number }): { x: Nm; y: Nm } => ({
  x: mmToNm(p.x),
  y: mmToNm(p.y)
})

const notTransformable = (item: FootprintItem, what: string): TransformFailure => ({
  ok: false,
  error: 'not-transformable',
  detail: `${item.id} is a ${item.kind}, and ${what}.`
})

/** What a kind-by-kind pairing of two item lists says changed: transforms never reorder. */
const changedBetween = (before: FootprintItem[], after: FootprintItem[]): McpChanged => {
  const changed: McpChanged = { created: [], updated: [], deleted: [] }
  const seen = new Map<string, number>()
  const byKind = new Map<string, FootprintItem[]>()
  for (const item of before) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item])
  for (const item of after) {
    const index = seen.get(item.kind) ?? 0
    seen.set(item.kind, index + 1)
    const was = byKind.get(item.kind)?.[index]
    if (!was) changed.created.push(item.id)
    else if (JSON.stringify(was.record) !== JSON.stringify(item.record))
      changed.updated.push(item.id)
  }
  return changed
}

/**
 * Apply `spec` to the footprint, leaving `fp` re-read from its edited text so
 * later edits on it see the change. Answers what changed by id, read after.
 */
export function transformFootprintItemsById(
  fp: KicadFootprint,
  spec: McpItemsTransform
): { ok: true; changed: McpChanged } | TransformFailure {
  const before = footprintItems(fp)
  const targets: FootprintItem[] = []
  for (const id of new Set(spec.ids)) {
    const found = resolveItem(before, id)
    if (!found.ok) return found
    targets.push(found.item)
  }
  const model = targets.find((item) => item.kind === 'model')
  if (model) return notTransformable(model, 'a model is placed by its offset and rotate')
  const root = targets.find((item) => item.kind === 'footprint')
  if (root) return notTransformable(root, 'its items are transformed by their own ids')

  switch (spec.transform) {
    case 'rotate':
    case 'mirror':
    case 'flip': {
      const transform: FootprintTransform =
        spec.transform === 'rotate'
          ? { kind: 'rotate', angle: spec.angle ?? 0 }
          : spec.transform === 'mirror'
            ? { kind: 'mirror', direction: spec.axis === 'y' ? 'leftRight' : 'topBottom' }
            : { kind: 'flip' }
      if (transform.kind === 'flip') {
        const stacked = targets.find(
          (item) =>
            item.kind === 'pad' && fp.pads.some((pad) => pad._raw === item.node && hasPadstack(pad))
        )
        if (stacked) return notTransformable(stacked, 'its padstack does not change side')
      }
      const { selection } = locateItems(
        fp,
        targets.map((item) => item.id)
      )
      const pivot = spec.about ? nmXY(spec.about) : transformPivot(fp, selection, transform)
      transformFootprintItems(fp, selection, transform, pivot)
      break
    }
    case 'move': {
      const d = nmXY(spec.by ?? { x: 0, y: 0 })
      for (const { node } of targets) {
        markNodeDirty(node)
        translateItem(node as SExprList, d.x, d.y)
      }
      break
    }
    case 'duplicate': {
      const fixed = targets.find((item) => !copiesFromFootprint(item.node))
      if (fixed) return notTransformable(fixed, 'a field does not duplicate')
      const { nodes } = prepareFootprintPaste({
        kind: 'footprint',
        items: copyFootprintItems(targets.map((item) => item.node))
      })
      insertIntoFootprint(fp, nodes, nmXY(spec.by ?? { x: 0, y: 0 }))
      break
    }
    case 'anchor':
      moveFootprintAnchor(fp, nmXY(spec.at ?? { x: 0, y: 0 }))
      break
  }

  // The clipboard writers edit the AST alone; a re-read brings the parse level with it.
  const reread = parseKicadFootprint(serializeKicadFootprint(fp))
  for (const key of Object.keys(fp)) delete (fp as unknown as Record<string, unknown>)[key]
  Object.assign(fp, reread)
  return { ok: true, changed: changedBetween(before, footprintItems(fp)) }
}
