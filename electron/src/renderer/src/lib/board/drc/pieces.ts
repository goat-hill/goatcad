/**
 * The pieces the layer rules measure (silk, physical clearance): an item of
 * the layer index (`layerIndex.ts`) or a pad drawn on a layer beyond copper,
 * with its subject and the rule item conditions read.
 */
import { padOnLayer, type KicadPad } from '../../kicad/footprint'
import { footprintTransform, tfPoint } from '../../schematic/placement'
import { PackedRTree } from '../../geometry/packedRTree'
import type { Box } from '../../geometry/polygon'
import { padShape, shapeCenter, type CopperShape, type Pt } from '../spatialIndex'
import { shapeOutlines } from '../shapeOutline'
import { padTouchesLayer } from '../maskExpansion'
import type { LayerItem } from '../layerIndex'
import type { RuleItem } from '../rules/constraints'
import type { DrcContext } from './context'
import { DRAWING_NAMES, positional, type Subject } from './shared'

/** An item on one layer as the layer rules measure it: its shape, who it is, how the rules see it. */
export interface Piece {
  /** The item it is, whichever layer it was read from: a pad on silk and on mask is one. */
  id: string
  shape: CopperShape
  box: Box
  subject: Subject
  rule: RuleItem
  /** A board or footprint graphic: two of one owner never collide, being one drawing. */
  graphic: boolean
  fp?: number
  /** A pad on the silkscreen, which the edge checks read as copper first. */
  pad?: KicadPad
}

/** Pieces from a run's context: a layer item as one, and the pads a layer beyond copper carries. */
export function layerPieces(ctx: DrcContext): {
  pieceOf: (item: LayerItem) => Piece | null
  padsOn: (layer: string, side: 'F.Cu' | 'B.Cu') => Piece[]
} {
  const { board, ruleSet, padSubject, zoneSubject, footprintSubject } = ctx
  /** A layer index item as a piece: its subject, and how the rules see it. */
  const pieceOf = (item: LayerItem): Piece | null => {
    const box = { minX: item.minX, minY: item.minY, maxX: item.maxX, maxY: item.maxY }
    const owner = item.fp !== undefined ? board.footprints[item.fp] : undefined
    const ownerSubject = owner ? footprintSubject(owner) : null
    const id =
      item.kind === 'pad'
        ? `pad:${item.fp}:${item.index}`
        : item.kind === 'via' || item.kind === 'track' || item.kind === 'zone'
          ? `${item.kind}:${item.fp ?? ''}:${item.index}:${item.shape.kind === 'arc' ? 'arc' : ''}`
          : `${item.layer}:${item.id}`
    const common = {
      id,
      shape: item.shape,
      box,
      ...(item.fp !== undefined ? { fp: item.fp } : {}),
      rule: {
        kind: item.kind === 'courtyard' || item.kind === 'edge' ? 'graphic' : item.kind,
        label: item.kind,
        layers: [item.layer],
        nonCopper: true,
        ...(item.fp !== undefined ? ruleSet.ownerOf(item.fp) : {}),
        ...(item.uuid ? { uuid: item.uuid, property: ruleSet.drawingProperty(item.uuid) } : {})
      } as RuleItem
    }
    switch (item.kind) {
      case 'pad': {
        const bfp = board.footprints[item.fp!]
        const pad = bfp.footprint.pads[item.index!]
        const center = tfPoint(footprintTransform(bfp), pad.position.x, pad.position.y)
        return {
          ...common,
          subject: padSubject(bfp, pad, center),
          rule: ruleSet.padItem(item.fp!, item.index!),
          graphic: false
        }
      }
      case 'via': {
        const via = ctx.itemByRef.get(`via:${item.index}`)
        const subject = via ? ctx.subjectOfItem(via) : null
        if (!subject || !via) return null
        return { ...common, subject, rule: ruleSet.copperItem(via), graphic: false }
      }
      case 'track': {
        const key = item.shape.kind === 'arc' ? `tarc:${item.index}` : `segment:${item.index}`
        const track = ctx.itemByRef.get(key)
        const subject = track ? ctx.subjectOfItem(track) : null
        if (!subject || !track) return null
        return { ...common, subject, rule: ruleSet.copperItem(track), graphic: false }
      }
      case 'zone': {
        if (item.fp === undefined) {
          const zone = board.zones[item.index!]
          return {
            ...common,
            subject: zoneSubject(zone),
            rule: ruleSet.zoneItem(zone),
            graphic: false
          }
        }
        return {
          ...common,
          subject: {
            item: ctx.drawingId(item.uuid, item.fp) ?? positional('zone', shapeCenter(item.shape)),
            name: `zone of ${ownerSubject!.name}`,
            targets: ownerSubject!.targets,
            ...(item.uuid ? { ids: [item.uuid] } : {})
          },
          graphic: false
        }
      }
      default: {
        const kind =
          item.kind in DRAWING_NAMES
            ? DRAWING_NAMES[item.kind as keyof typeof DRAWING_NAMES]
            : item.kind
        return {
          ...common,
          subject: {
            item:
              ctx.drawingId(item.uuid, item.fp) ?? positional(item.kind, shapeCenter(item.shape)),
            name: ownerSubject ? `${kind} of ${ownerSubject.name}` : `${kind} on ${item.layer}`,
            targets: ownerSubject ? ownerSubject.targets : item.uuid ? [item.uuid] : [],
            ...(ownerSubject && item.uuid ? { ids: [item.uuid] } : {})
          },
          graphic: item.kind === 'graphic'
        }
      }
    }
  }

  /** Pads drawn on a layer beyond copper (old libraries put some on the silkscreen), by their copper. */
  const padsOn = (layer: string, side: 'F.Cu' | 'B.Cu'): Piece[] => {
    const out: Piece[] = []
    board.footprints.forEach((bfp, fp) => {
      const tf = footprintTransform(bfp)
      bfp.footprint.pads.forEach((pad, index) => {
        if (!padTouchesLayer(pad, layer)) return
        const center = tfPoint(tf, pad.position.x, pad.position.y)
        const shape = padShape(padOnLayer(pad, side), center)
        out.push({
          id: `pad:${fp}:${index}`,
          shape,
          box: boxOf(shape),
          subject: padSubject(bfp, pad, center),
          rule: ruleSet.padItem(fp, index),
          graphic: false,
          fp,
          pad
        })
      })
    })
    return out
  }
  return { pieceOf, padsOn }
}

/** A shape's box, from its outline. */
export function boxOf(shape: CopperShape): Box {
  const points: Pt[] = shapeOutlines(shape, 0).flat()
  if (shape.kind === 'poly')
    return { minX: shape.minX, minY: shape.minY, maxX: shape.maxX, maxY: shape.maxY }
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y))
  }
}

/** The pieces' boxes packed for queries. */
export function treeOf(pieces: readonly { box: Box }[]): PackedRTree {
  const boxes = new Float64Array(pieces.length * 4)
  pieces.forEach((piece, i) =>
    boxes.set([piece.box.minX, piece.box.minY, piece.box.maxX, piece.box.maxY], i * 4)
  )
  return new PackedRTree(boxes, pieces.length)
}
