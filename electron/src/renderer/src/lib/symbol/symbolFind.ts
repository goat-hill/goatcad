import type { FindCandidate } from '../canvasFind'
import { pinText, type KicadLibSymbol } from '../kicad/schematic'
import type { SymbolPartAddress } from './symbolEdit'

/**
 * The texts the symbol editor finds, library space (nm, y up): pin names and
 * numbers, the fields, and graphic texts and text boxes, across every unit and
 * body style — a hit in another one switches the view to it. Hidden pins and
 * fields are offered only while the view shows them, since only what is on
 * the canvas can be selected.
 */
export function symbolFindCandidates(
  symbol: KicadLibSymbol,
  shown: { pins: boolean; fields: boolean }
): FindCandidate<SymbolPartAddress>[] {
  const found: FindCandidate<SymbolPartAddress>[] = []
  for (const { unit, style, pins, graphics } of symbol.variants) {
    pins.forEach((pin, index) => {
      if (pin.hidden && !shown.pins) return
      const target: SymbolPartAddress = { kind: 'pin', unit, style, index }
      const position = { x: pin.position.x, y: pin.position.y }
      const key = `pin:${unit}:${style}:${index}`
      const name = pinText(pin.name)
      const number = pinText(pin.number)
      if (name) found.push({ key: `${key}:name`, target, text: name, position })
      if (number) found.push({ key: `${key}:number`, target, text: number, position })
    })
    graphics.forEach((graphic, index) => {
      if ((graphic.type !== 'text' && graphic.type !== 'textBox') || !graphic.text) return
      found.push({
        key: `graphic:${unit}:${style}:${index}`,
        target: { kind: 'graphic', unit, style, index },
        text: graphic.text,
        position: { x: graphic.position.x, y: graphic.position.y }
      })
    })
  }
  for (const property of symbol.properties) {
    if (property.key.startsWith('ki_') || (property.hidden && !shown.fields)) continue
    if (!property.value) continue
    found.push({
      key: `field:${property.key}`,
      target: { kind: 'field', unit: 0, style: 0, index: 0, field: property.key },
      text: property.value,
      position: { x: property.position.x, y: property.position.y }
    })
  }
  return found
}
