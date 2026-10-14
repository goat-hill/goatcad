/**
 * A symbol part named for a list row — Select Other's (shared/SelectOtherMenu.vue):
 * the primitive's shared name, then what tells it from its neighbours under the
 * pointer — a pin's number and name, a field's name, a text's words, and the
 * unit it belongs to when the symbol has several. Parts joined by a middle dot:
 * "Pin · 3 · VCC · Unit B".
 */
import type { KicadLibSymbol } from '../kicad/schematic'
import { symbolPartGraphic, symbolPartPin, unitLetter, type SymbolPartAddress } from './symbolEdit'
import { labelExcerpt, primitiveLabel } from '../primitiveLabel'

export type Translate = (key: string, params?: Record<string, unknown>) => string

export function symbolItemLabel(
  symbol: KicadLibSymbol,
  address: SymbolPartAddress,
  t: Translate
): string {
  const multiUnit = symbol.variants.some((v) => v.unit > 1)
  const unit =
    multiUnit && address.unit > 0
      ? t('symbolEditor.units.option', { letter: unitLetter(address.unit) })
      : undefined

  if (address.kind === 'field') return primitiveLabel(t('shared.primitives.field'), address.field)
  if (address.kind === 'pin') {
    const pin = symbolPartPin(symbol, address)
    const name = pin?.name && pin.name !== '~' ? pin.name : undefined
    return primitiveLabel(t('shared.primitives.pin'), pin?.number, name, unit)
  }
  const graphic = symbolPartGraphic(symbol, address)
  switch (graphic?.type) {
    case 'rectangle':
      return primitiveLabel(t('shared.primitives.rectangle'), unit)
    case 'line':
      return primitiveLabel(t('shared.primitives.line'), unit)
    case 'bezier':
      return primitiveLabel(t('shared.primitives.curve'), unit)
    case 'circle':
      return primitiveLabel(t('shared.primitives.circle'), unit)
    case 'arc':
      return primitiveLabel(t('shared.primitives.arc'), unit)
    case 'text':
      return primitiveLabel(t('shared.primitives.text'), labelExcerpt(graphic.text), unit)
    case 'textBox':
      return primitiveLabel(t('shared.primitives.textBox'), labelExcerpt(graphic.text), unit)
    default:
      return primitiveLabel(t('shared.primitives.graphic'), unit)
  }
}
