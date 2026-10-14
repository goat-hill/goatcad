/**
 * A board item named for a list row — Select Other's (shared/SelectOtherMenu.vue):
 * its kind, then what tells it from its neighbours under the pointer — a
 * footprint's reference, a pad's number, copper's layer and net, a graphic's
 * layer, a text's words. Parts joined by a middle dot: "Track · F.Cu · GND".
 */
import { allZones, type KicadBoard } from '../kicad/board'
import type { BoardItemRef } from '../engine/BoardScene'
import { labelExcerpt, primitiveLabel } from '../primitiveLabel'

export type Translate = (key: string) => string

export function boardItemLabel(board: KicadBoard, ref: BoardItemRef, t: Translate): string {
  const net = (number: number | undefined): string | undefined =>
    number ? board.nets.find((n) => n.number === number)?.name || undefined : undefined

  switch (ref.type) {
    case 'footprint': {
      const fp = board.footprints[ref.index]
      return primitiveLabel(t('shared.primitives.footprint'), fp?.reference, fp?.layer)
    }
    case 'pad': {
      const fp = board.footprints[ref.index]
      const pad = ref.pad === undefined ? undefined : fp?.footprint.pads[ref.pad]
      return primitiveLabel(t('shared.primitives.pad'), pad?.number, fp?.reference)
    }
    case 'fp_field': {
      const fp = board.footprints[ref.index]
      const prop = ref.child === undefined ? undefined : fp?.footprint.properties[ref.child]
      return primitiveLabel(t('shared.primitives.field'), prop?.key, fp?.reference)
    }
    case 'fp_text': {
      const fp = board.footprints[ref.index]
      const text = ref.child === undefined ? undefined : fp?.footprint.fpTexts[ref.child]
      return primitiveLabel(t('shared.primitives.text'), labelExcerpt(text?.text), fp?.reference)
    }
    case 'via':
      return primitiveLabel(t('shared.primitives.via'), net(board.vias[ref.index]?.net))
    case 'segment': {
      const seg = board.segments[ref.index]
      return primitiveLabel(t('shared.primitives.track'), seg?.layer, net(seg?.net))
    }
    case 'tarc': {
      const arc = board.trackArcs[ref.index]
      return primitiveLabel(t('shared.primitives.trackArc'), arc?.layer, net(arc?.net))
    }
    case 'zone': {
      const zone = allZones(board)[ref.index]
      const title = zone?.isKeepout ? t('shared.primitives.ruleArea') : t('shared.primitives.zone')
      return primitiveLabel(
        title,
        zone?.name || zone?.netName || net(zone?.net),
        zone?.layers.join(', ')
      )
    }
    case 'gr_line':
      return primitiveLabel(t('shared.primitives.line'), board.grLines[ref.index]?.layer)
    case 'gr_arc':
      return primitiveLabel(t('shared.primitives.arc'), board.grArcs[ref.index]?.layer)
    case 'gr_circle':
      return primitiveLabel(t('shared.primitives.circle'), board.grCircles[ref.index]?.layer)
    case 'gr_rect':
      return primitiveLabel(t('shared.primitives.rectangle'), board.grRects[ref.index]?.layer)
    case 'gr_poly':
      return primitiveLabel(t('shared.primitives.polygon'), board.grPolys[ref.index]?.layer)
    case 'gr_curve':
      return primitiveLabel(t('shared.primitives.curve'), board.grCurves[ref.index]?.layer)
    case 'gr_text': {
      const text = board.grTexts[ref.index]
      return primitiveLabel(t('shared.primitives.text'), labelExcerpt(text?.text), text?.layer)
    }
    case 'gr_text_box': {
      const box = board.grTextBoxes[ref.index]
      return primitiveLabel(t('shared.primitives.textBox'), labelExcerpt(box?.text), box?.layer)
    }
    case 'table':
      return primitiveLabel(t('shared.primitives.table'), board.tables[ref.index]?.layer)
    case 'point':
      return primitiveLabel(t('shared.primitives.point'), board.points[ref.index]?.layer)
    case 'tuning_pattern': {
      const pattern = board.tuningPatterns[ref.index]
      return primitiveLabel(
        t('shared.primitives.tuningPattern'),
        pattern?.layer,
        pattern?.lastNetName || undefined
      )
    }
    default:
      return ref.type
  }
}
