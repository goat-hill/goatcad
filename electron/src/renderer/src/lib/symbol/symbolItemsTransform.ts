/**
 * `items.transform` on a symbol definition: the symbol editor's Rotate,
 * Mirror, Move, Duplicate, Repeat and Move Symbol Anchor, applied to items by
 * id. Every edit is `symbolEdit.ts`'s own helper, so an agent's rotate is the
 * editor's rotate; this module only resolves ids, picks the pivot the editor
 * would, and names what changed.
 *
 * The agent's frame is millimeters, y down; the file's is nanometers, y up. A
 * quarter turn counterclockwise is the same turn in both.
 */
import type { SExprList } from '../kicad/sexpr'
import { getToken } from '../kicad/sexpr'
import { mmToNm, nm, type Nm } from '../kicad/coordinates'
import { parseLibSymbol, type SymbolGraphic, type SymbolPin } from '../kicad/schematic'
import type { McpChanged, McpItemsTransform } from '../../../../preload/mcpTypes'
import {
  addressOfPartNode,
  appendNodeCopy,
  appendRepeatCopy,
  boundsCenter,
  defaultUnitNodeFor,
  maxPinNumber,
  mirrorGraphicNode,
  mirrorPinNode,
  moveSymbolAnchor,
  owningUnitNode,
  rotateGraphicNode,
  rotatePinNode,
  symbolItemsBounds,
  symbolPartGraphic,
  symbolPartPin,
  translateGraphicNode,
  translatePinNode,
  translateSymbolPropertyNode,
  updatePin,
  type Point2
} from './symbolEdit'
import { resolveSymbolItem, symbolItems, type SymbolItem } from './symbolItems'

export type TransformFailure = {
  ok: false
  error: string
  detail: string
  candidates?: string[]
}

type Point = { x: number; y: number }

/** An agent's point or offset (mm, y down) in the file's frame (nm, y up). */
const fileXY = (p: Point): { x: Nm; y: Nm } => ({ x: mmToNm(p.x), y: mmToNm(0 - p.y) })

const notTransformable = (item: SymbolItem, what: string): TransformFailure => ({
  ok: false,
  error: 'not-transformable',
  detail: `${item.id} is a ${item.kind}, and ${what}.`
})

/** The center of the items' extent, as the editor turns a selection about. */
const selectionCenter = (symbolNode: SExprList, nodes: SExprList[]): Point2 | null => {
  const symbol = parseLibSymbol(symbolNode)
  const pins: SymbolPin[] = []
  const graphics: SymbolGraphic[] = []
  for (const node of nodes) {
    const address = addressOfPartNode(symbolNode, node)
    if (!address) continue
    const pin = symbolPartPin(symbol, address)
    const graphic = symbolPartGraphic(symbol, address)
    if (pin) pins.push(pin)
    if (graphic) graphics.push(graphic)
  }
  const bounds = symbolItemsBounds(pins, graphics)
  if (!bounds) return null
  const center = boundsCenter(bounds)
  return { x: nm(center.x), y: nm(center.y) }
}

/**
 * Apply `spec` to the symbol node in place. Answers what changed by id, read
 * after the edit, so a pin a duplicate renumbered is named as it is now.
 */
export function transformSymbolItems(
  symbolNode: SExprList,
  spec: McpItemsTransform
): { ok: true; changed: McpChanged } | TransformFailure {
  const before = symbolItems(symbolNode)
  const targets: SymbolItem[] = []
  for (const id of new Set(spec.ids)) {
    const found = resolveSymbolItem(before, id)
    if (!found.ok) return found
    targets.push(found.item)
  }
  const root = targets.find((item) => item.kind === 'symbol')
  if (root) return notTransformable(root, 'its items are transformed by their own ids')
  const parts = targets.filter((item) => item.kind !== 'field')
  const isPin = (node: SExprList): boolean => getToken(node) === 'pin'
  const updatedNodes = new Set<SExprList>(targets.map((item) => item.node))
  const created: SExprList[] = []

  switch (spec.transform) {
    case 'rotate':
    case 'mirror': {
      const field = targets.find((item) => item.kind === 'field')
      if (field) return notTransformable(field, 'a field only moves')
      const pivot = spec.about
        ? fileXY(spec.about)
        : selectionCenter(
            symbolNode,
            parts.map((item) => item.node)
          )
      if (!pivot) break
      // The editor's two mirror chips: "horizontal" negates x, so it is a flip across y.
      const axis = spec.axis === 'y' ? 'horizontal' : 'vertical'
      const turns = Math.round((spec.angle ?? 0) / 90)
      for (const { node } of parts) {
        if (spec.transform === 'rotate') {
          if (isPin(node)) rotatePinNode(node, pivot, turns)
          else rotateGraphicNode(node, pivot, turns)
        } else if (isPin(node)) mirrorPinNode(node, pivot, axis)
        else mirrorGraphicNode(node, pivot, axis)
      }
      break
    }
    case 'move': {
      const d = fileXY(spec.by ?? { x: 0, y: 0 })
      for (const { node, kind } of targets) {
        if (kind === 'field') translateSymbolPropertyNode(node, d.x, d.y)
        else if (isPin(node)) translatePinNode(node, d.x, d.y)
        else translateGraphicNode(node, d.x, d.y)
      }
      break
    }
    case 'duplicate': {
      const field = targets.find((item) => item.kind === 'field')
      if (field) return notTransformable(field, 'a field does not duplicate')
      updatedNodes.clear()
      const d = fileXY(spec.by ?? { x: 0, y: 0 })
      // Without a step, the editor's Duplicate: copies are numbered on from the
      // highest number. With one, its Repeat: each steps on from its source.
      let nextPin = maxPinNumber(symbolNode) + 1
      for (const { node } of parts) {
        if (spec.pinStep !== undefined) {
          created.push(appendRepeatCopy(symbolNode, node, d, spec.pinStep))
          continue
        }
        const unit = owningUnitNode(symbolNode, node) ?? defaultUnitNodeFor(symbolNode, node)
        const clone = appendNodeCopy(unit, node)
        if (isPin(clone)) {
          translatePinNode(clone, d.x, d.y)
          updatePin(clone, { number: String(nextPin++) })
        } else translateGraphicNode(clone, d.x, d.y)
        created.push(clone)
      }
      break
    }
    case 'anchor': {
      const rows = new Map(before.map((item) => [item.node, JSON.stringify(item.record)]))
      moveSymbolAnchor(symbolNode, fileXY(spec.at ?? { x: 0, y: 0 }))
      updatedNodes.clear()
      for (const item of symbolItems(symbolNode)) {
        if (rows.get(item.node) !== JSON.stringify(item.record)) updatedNodes.add(item.node)
      }
      break
    }
    case 'flip':
      return {
        ok: false,
        error: 'not-transformable',
        detail: 'A symbol has no sides to flip between.'
      }
  }

  const after = symbolItems(symbolNode)
  const idOf = (node: SExprList): string[] => {
    const item = after.find((entry) => entry.node === node)
    return item ? [item.id] : []
  }
  return {
    ok: true,
    changed: {
      created: created.flatMap(idOf),
      updated: [...updatedNodes].flatMap(idOf),
      deleted: []
    }
  }
}
