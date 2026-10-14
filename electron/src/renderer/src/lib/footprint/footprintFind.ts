import type { FindCandidate } from '../canvasFind'
import type { KicadFootprint } from '../kicad/footprint'

/** What a footprint find hit selects: a pad, a field or a free text. */
export interface FootprintFindTarget {
  type: 'pad' | 'property' | 'text'
  index: number
}

/**
 * The texts the footprint editor finds, footprint space (nm, y down): pad
 * numbers, the fields (Reference, Value and the rest) and free texts, as
 * stored. A field or text that is hidden, or has no place, is not on the
 * canvas to select, so it is not offered.
 */
export function footprintFindCandidates(fp: KicadFootprint): FindCandidate<FootprintFindTarget>[] {
  const found: FindCandidate<FootprintFindTarget>[] = []
  fp.pads.forEach((pad, index) => {
    if (!pad.number) return
    found.push({
      key: `pad:${index}`,
      target: { type: 'pad', index },
      text: pad.number,
      position: { x: pad.position.x, y: pad.position.y }
    })
  })
  fp.properties.forEach((property, index) => {
    if (!property.position || property.hide || !property.value) return
    found.push({
      key: `property:${index}`,
      target: { type: 'property', index },
      text: property.value,
      position: { x: property.position.x, y: property.position.y }
    })
  })
  fp.fpTexts.forEach((text, index) => {
    if (!text.position || text.hide || !text.text) return
    found.push({
      key: `text:${index}`,
      target: { type: 'text', index },
      text: text.text,
      position: { x: text.position.x, y: text.position.y }
    })
  })
  return found
}
