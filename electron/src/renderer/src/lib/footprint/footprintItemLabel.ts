/**
 * A footprint item named for a list row — Select Other's (shared/SelectOtherMenu.vue):
 * the primitive's name, then what tells it from its neighbours under the
 * pointer — a pad's number, a graphic's layer, a text's words, a field's name.
 * Parts joined by a middle dot: "Pad · 3", "Line · F.SilkS". The types are
 * the ones `FootprintScene.hitCandidates` reports.
 */
import type { KicadFootprint } from '../kicad/footprint'
import { labelExcerpt, primitiveLabel } from '../primitiveLabel'

export type Translate = (key: string) => string

export function footprintItemLabel(
  fp: KicadFootprint,
  ref: { type: string; index: number },
  t: Translate
): string {
  const i = ref.index

  switch (ref.type) {
    case 'pad':
      return primitiveLabel(t('shared.primitives.pad'), fp.pads[i]?.number)
    case 'line':
      return primitiveLabel(t('shared.primitives.line'), fp.fpLines[i]?.layer)
    case 'arc':
      return primitiveLabel(t('shared.primitives.arc'), fp.fpArcs[i]?.layer)
    case 'circle':
      return primitiveLabel(t('shared.primitives.circle'), fp.fpCircles[i]?.layer)
    case 'rect':
      return primitiveLabel(t('shared.primitives.rectangle'), fp.fpRects[i]?.layer)
    case 'poly':
      return primitiveLabel(t('shared.primitives.polygon'), fp.fpPolys[i]?.layer)
    case 'curve':
      return primitiveLabel(t('shared.primitives.curve'), fp.fpCurves[i]?.layer)
    case 'point':
      return primitiveLabel(t('shared.primitives.point'), fp.points[i]?.layer)
    case 'table':
      return primitiveLabel(t('shared.primitives.table'), fp.tables[i]?.layer)
    case 'textbox': {
      const box = fp.fpTextBoxes[i]
      return primitiveLabel(t('shared.primitives.textBox'), labelExcerpt(box?.text), box?.layer)
    }
    case 'text': {
      const text = fp.fpTexts[i]
      return primitiveLabel(t('shared.primitives.text'), labelExcerpt(text?.text), text?.layer)
    }
    case 'property': {
      const prop = fp.properties[i]
      return primitiveLabel(t('shared.primitives.field'), prop?.key, labelExcerpt(prop?.value))
    }
    case 'zone': {
      const zone = fp.zones[i]
      const title = zone?.isKeepout ? t('shared.primitives.ruleArea') : t('shared.primitives.zone')
      return primitiveLabel(title, zone?.layers.join(', '))
    }
    default:
      return ref.type
  }
}
