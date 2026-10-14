import { describe, expect, test } from 'vitest'
import { CHROME_STACK } from '../../engine/SelectionChrome'
import {
  LIFTED_SLOT_OFFSET,
  NETNAMES_PSEUDO_LAYER,
  PREVIEW_SLOT,
  VIA_PSEUDO_LAYER,
  pcbLayerOrder
} from '../layers'
import {
  OVERLAY_FLOOR,
  OVERLAY_ORDER,
  PAINT_LANES,
  PaintOrder,
  type PaintLane
} from '../paintOrder'

const slotOf = (layer: string, flipped = false): number => pcbLayerOrder({ flipped }).indexOf(layer)

describe('PaintOrder', () => {
  const at = (order: PaintOrder, layer: string, lane: PaintLane = 'stroke'): number =>
    order.renderOrder(slotOf(layer), lane)

  test('the stack as written, bottom to top, lane by lane', () => {
    const order = new PaintOrder()
    expect(at(order, 'B.Cu')).toBeLessThan(at(order, 'F.SilkS'))
    expect(at(order, 'F.SilkS')).toBeLessThan(at(order, 'F.Cu'))
    const lanes = PAINT_LANES.map((lane) => at(order, 'B.Cu', lane))
    expect([...lanes].sort((a, b) => a - b)).toEqual(lanes)
  })

  test('the active layer rises to the top, and the vias with it when it is copper', () => {
    const order = new PaintOrder({ activeLayer: 'B.Cu' })
    expect(at(order, 'B.Cu')).toBeGreaterThan(at(order, 'F.Cu'))
    expect(at(order, VIA_PSEUDO_LAYER)).toBeGreaterThan(at(order, 'B.Cu'))
    expect(order.facingCopper).toBe('B.Cu')
  })

  test('the facing copper labels and the net-name slot are above everything, the vias included', () => {
    for (const activeLayer of [undefined, 'F.Cu', 'In2.Cu', 'B.Cu', 'F.SilkS', 'Edge.Cuts']) {
      const order = new PaintOrder({ activeLayer })
      const facingLabels = at(order, order.facingCopper, 'label')
      const top = Math.max(
        ...pcbLayerOrder()
          .filter((layer) => layer !== NETNAMES_PSEUDO_LAYER)
          .flatMap((layer) => PAINT_LANES.map((lane) => at(order, layer, lane)))
          .filter((o) => o !== facingLabels)
      )
      expect(facingLabels).toBeGreaterThan(top)
      expect(at(order, NETNAMES_PSEUDO_LAYER, 'label')).toBeGreaterThan(facingLabels)
    }
  })

  test('a copper layer that is not facing keeps its labels just over its own copper', () => {
    const order = new PaintOrder({ activeLayer: 'B.Cu' })
    expect(at(order, 'F.Cu', 'label')).toBe(at(order, 'F.Cu', 'stroke') + 1)
  })

  test('with a non-copper layer active, the front copper faces; flipped, the back', () => {
    expect(new PaintOrder({ activeLayer: 'F.SilkS' }).facingCopper).toBe('F.Cu')
    expect(new PaintOrder({ flipped: true }).facingCopper).toBe('B.Cu')
  })

  test('every document entry has its own order, the selected band repeats it above, previews top it', () => {
    const order = new PaintOrder({ activeLayer: 'In1.Cu' })
    const slots = pcbLayerOrder().map((_, slot) => slot)
    const document = slots.flatMap((slot) =>
      PAINT_LANES.map((lane) => order.renderOrder(slot, lane))
    )
    expect(new Set(document).size).toBe(document.length)
    const selected = slots.flatMap((slot) =>
      PAINT_LANES.map((lane) => order.renderOrder(slot + LIFTED_SLOT_OFFSET, lane))
    )
    expect(Math.min(...selected)).toBeGreaterThan(Math.max(...document))
    expect(selected).toEqual(document.map((o) => o + document.length))
    const preview = PAINT_LANES.map((lane) => order.renderOrder(PREVIEW_SLOT, lane))
    expect(Math.min(...preview)).toBeGreaterThan(Math.max(...selected))
    expect(Math.max(...preview)).toBeLessThan(OVERLAY_FLOOR)
  })

  test('the overlays rank above every band, the selection chrome among them', () => {
    expect(Math.min(...Object.values(OVERLAY_ORDER))).toBe(OVERLAY_FLOOR)
    for (const { renderOrder } of Object.values(CHROME_STACK))
      expect(renderOrder).toBeGreaterThan(OVERLAY_FLOOR)
  })

  test('dim layers are listed in the view order', () => {
    const order = new PaintOrder({ activeLayer: 'B.Cu' })
    const slots = order.slotsBottomUp
    expect(slots.indexOf(slotOf('B.Cu'))).toBeGreaterThan(slots.indexOf(slotOf('F.Cu')))
  })

  test('a flipped view addresses the flipped stack', () => {
    const order = new PaintOrder({ flipped: true })
    expect(order.renderOrder(slotOf('B.Cu', true), 'stroke')).toBeGreaterThan(
      order.renderOrder(slotOf('F.Cu', true), 'stroke')
    )
  })
})
