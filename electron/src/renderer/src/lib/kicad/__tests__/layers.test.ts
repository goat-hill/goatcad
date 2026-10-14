import { describe, expect, test } from 'vitest'
import {
  DEFAULT_PCB_LAYER,
  LayerStack,
  LIFT_Z,
  LIFTED_SLOT_OFFSET,
  PCB_LAYER_STACK,
  PREVIEW_Z,
  isLiftedSlot,
  KICAD_LAYER_COLORS,
  LAYER_DEPTH,
  NETNAMES_PSEUDO_LAYER,
  VIA_PSEUDO_LAYER,
  boardLayerFlipper,
  expandLayerToken,
  kicadLayerId,
  pcbLayerOrder,
  layerSlot,
  layerZ,
  resolveWildcardLayer
} from '../layers'

const slotOf = (order: string[], layer: string): number => order.indexOf(layer)

describe('pcbLayerOrder', () => {
  test('every palette layer has a slot, so nothing falls back silently', () => {
    for (const layer of Object.keys(KICAD_LAYER_COLORS)) {
      expect(PCB_LAYER_STACK).toContain(layer)
    }
  })

  test('names are unique — a duplicate would give one layer two slots', () => {
    expect(new Set(PCB_LAYER_STACK).size).toBe(PCB_LAYER_STACK.length)
  })

  test("KiCad's order: back under inner under front, copper over its own silk", () => {
    const order = pcbLayerOrder()
    expect(slotOf(order, 'B.SilkS')).toBeLessThan(slotOf(order, 'B.Cu'))
    expect(slotOf(order, 'B.Cu')).toBeLessThan(slotOf(order, 'In1.Cu'))
    expect(slotOf(order, 'In1.Cu')).toBeLessThan(slotOf(order, 'F.Cu'))
    // Copper draws OVER silkscreen, which is why KiCad has a silk-over-pad rule
    expect(slotOf(order, 'F.SilkS')).toBeLessThan(slotOf(order, 'F.Cu'))
    // Fab and courtyard are documentation, at the bottom of each side's group
    expect(slotOf(order, 'F.Fab')).toBeLessThan(slotOf(order, 'F.Paste'))
    expect(slotOf(order, 'F.CrtYd')).toBeLessThan(slotOf(order, 'F.Paste'))
  })

  test('documentation layers sit above the whole physical stack', () => {
    const order = pcbLayerOrder()
    expect(slotOf(order, 'F.Cu')).toBeLessThan(slotOf(order, 'Edge.Cuts'))
    expect(slotOf(order, 'Edge.Cuts')).toBeLessThan(slotOf(order, 'Dwgs.User'))
    // The last board layer; only the net names sit above it.
    expect(order[order.length - 2]).toBe('Dwgs.User')
  })

  test('the net names sit above everything, a promoted layer included', () => {
    expect(pcbLayerOrder().at(-1)).toBe(NETNAMES_PSEUDO_LAYER)
    expect(pcbLayerOrder({ activeLayer: 'B.Cu', flipped: true }).at(-1)).toBe(NETNAMES_PSEUDO_LAYER)
  })

  test('the stack holds every copper and user layer a board can declare', () => {
    for (let n = 1; n <= 30; n++) expect(PCB_LAYER_STACK).toContain(`In${n}.Cu`)
    for (let n = 1; n <= 45; n++) expect(PCB_LAYER_STACK).toContain(`User.${n}`)
    // Inner copper stacks front to back between the outer pair.
    const order = pcbLayerOrder()
    expect(slotOf(order, 'In1.Cu')).toBeGreaterThan(slotOf(order, 'In30.Cu'))
    expect(slotOf(order, 'In30.Cu')).toBeGreaterThan(slotOf(order, 'B.Cu'))
    expect(slotOf(order, 'In1.Cu')).toBeLessThan(slotOf(order, 'F.Cu'))
  })

  test('vias sit above every copper layer they can pass through', () => {
    const order = pcbLayerOrder()
    expect(slotOf(order, VIA_PSEUDO_LAYER)).toBeGreaterThan(slotOf(order, 'F.Cu'))
    expect(slotOf(order, VIA_PSEUDO_LAYER)).toBeLessThan(slotOf(order, 'Dwgs.User'))
  })

  test('flipping trades the front and back halves', () => {
    const order = pcbLayerOrder({ flipped: true })
    const flat = pcbLayerOrder()
    expect(slotOf(order, 'B.SilkS')).toBe(slotOf(flat, 'F.SilkS'))
    expect(slotOf(order, 'F.SilkS')).toBe(slotOf(flat, 'B.SilkS'))
    // Sideless layers keep their place
    expect(slotOf(order, 'Edge.Cuts')).toBe(slotOf(flat, 'Edge.Cuts'))
  })

  test('the active layer is promoted to the top of the stack', () => {
    const order = pcbLayerOrder({ activeLayer: 'F.SilkS' })
    expect(order[order.length - 2]).toBe('F.SilkS')
    expect(order.length).toBe(PCB_LAYER_STACK.length)
  })

  test('a promoted copper layer still draws under the vias passing through it', () => {
    const order = pcbLayerOrder({ activeLayer: 'B.Cu' })
    expect(slotOf(order, VIA_PSEUDO_LAYER)).toBeGreaterThan(slotOf(order, 'B.Cu'))
    expect(slotOf(order, 'B.Cu')).toBeGreaterThan(slotOf(order, 'F.Cu'))
    expect(order.length).toBe(PCB_LAYER_STACK.length)
  })

  test('promotion happens after the flip, so it names the layer the user picked', () => {
    const order = pcbLayerOrder({ activeLayer: 'B.Cu', flipped: true })
    expect(slotOf(order, 'B.Cu')).toBeGreaterThan(slotOf(order, 'F.Cu'))
    expect(order.filter((l) => l === 'B.Cu').length).toBe(1)
  })

  test('an unknown active layer leaves the stack alone', () => {
    expect(pcbLayerOrder({ activeLayer: 'Nope.Cu' })).toEqual([...PCB_LAYER_STACK])
  })
})

describe('one stack for both PCB surfaces', () => {
  test('every layer the footprint editor can draw on has a slot', () => {
    // The footprint editor's own layer set, per KiCad's F.Cu/B.Cu pairs plus
    // the documentation layers a .kicad_mod may reference.
    const footprintLayers = [
      'F.Cu',
      'B.Cu',
      'F.Mask',
      'B.Mask',
      'F.Paste',
      'B.Paste',
      'F.SilkS',
      'B.SilkS',
      'F.Fab',
      'B.Fab',
      'F.CrtYd',
      'B.CrtYd',
      'F.Adhes',
      'B.Adhes',
      'Edge.Cuts',
      'Dwgs.User',
      'Cmts.User',
      'User.1'
    ]
    for (const layer of footprintLayers) {
      expect(PCB_LAYER_STACK).toContain(layer)
    }
  })

  test('wildcards resolve to the front of the stack', () => {
    expect(resolveWildcardLayer('*.Cu')).toBe('F.Cu')
    expect(resolveWildcardLayer('*.Mask')).toBe('F.Mask')
    expect(resolveWildcardLayer('*.Paste')).toBe('F.Paste')
    expect(resolveWildcardLayer('F&B.Cu')).toBe('F.Cu')
    expect(resolveWildcardLayer(undefined)).toBe(DEFAULT_PCB_LAYER)
    expect(resolveWildcardLayer('B.SilkS')).toBe('B.SilkS')
  })
})

describe('expandLayerToken', () => {
  test('`*.Cu` is every copper layer the board has, not just the outer two', () => {
    expect(expandLayerToken('*.Cu', ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])).toEqual([
      'F.Cu',
      'In1.Cu',
      'In2.Cu',
      'B.Cu'
    ])
    // With no board to ask — the footprint editor — it is the outer pair.
    expect(expandLayerToken('*.Cu')).toEqual(['F.Cu', 'B.Cu'])
  })

  test('`F&B.Cu` is the outer pair however deep the board is', () => {
    expect(expandLayerToken('F&B.Cu', ['F.Cu', 'In1.Cu', 'B.Cu'])).toEqual(['F.Cu', 'B.Cu'])
  })

  test('every other wildcard is a fixed front/back pair', () => {
    expect(expandLayerToken('*.Mask')).toEqual(['F.Mask', 'B.Mask'])
    expect(expandLayerToken('*.Paste')).toEqual(['F.Paste', 'B.Paste'])
    expect(expandLayerToken('*.SilkS')).toEqual(['F.SilkS', 'B.SilkS'])
    expect(expandLayerToken('*.Adhes')).toEqual(['F.Adhes', 'B.Adhes'])
  })

  test('a concrete layer expands to itself', () => {
    expect(expandLayerToken('In2.Cu', ['F.Cu', 'In2.Cu', 'B.Cu'])).toEqual(['In2.Cu'])
    expect(expandLayerToken('Edge.Cuts')).toEqual(['Edge.Cuts'])
  })
})

describe('LayerStack', () => {
  test('resolves a layer to the z of its slot, wildcards included', () => {
    const stack = new LayerStack()
    expect(stack.zOf('*.Cu')).toBe(stack.zOf('F.Cu'))
    expect(stack.zOf('F.Cu', 'fill')).toBeLessThan(stack.zOf('F.Cu'))
  })

  test('an unknown layer falls back rather than collapsing to the bottom', () => {
    const stack = new LayerStack()
    expect(stack.zOf('Nope.Layer')).toBe(stack.zOf(DEFAULT_PCB_LAYER))
  })

  test('a slot is a place in the stack as written, mirrored for a flipped view', () => {
    // The active layer moves no slot: promotion is render order (PaintOrder).
    const stack = new LayerStack()
    expect(stack.slotOf('B.Cu')).toBe(PCB_LAYER_STACK.indexOf('B.Cu'))
    expect(stack.slotOf(VIA_PSEUDO_LAYER)).toBe(PCB_LAYER_STACK.indexOf(VIA_PSEUDO_LAYER))
    stack.arrange({ flipped: true })
    expect(stack.slotOf('B.Cu')).toBe(PCB_LAYER_STACK.indexOf('F.Cu'))
    expect(stack.slotOf(NETNAMES_PSEUDO_LAYER)).toBe(PCB_LAYER_STACK.length - 1)
  })
})

describe('layerZ', () => {
  test('depths order within one layer: fill under body under marker', () => {
    expect(layerZ(4, 'fill')).toBeLessThan(layerZ(4, 'body'))
    expect(layerZ(4, 'body')).toBeLessThan(layerZ(4, 'detail'))
    expect(layerZ(4, 'detail')).toBeLessThan(layerZ(4, 'marker'))
    expect(layerZ(4, 'marker')).toBeLessThan(layerZ(4, 'label'))
  })

  test('a whole layer clears the one under it — no depth escapes its band', () => {
    const depths = Object.keys(LAYER_DEPTH) as Array<keyof typeof LAYER_DEPTH>
    for (const depth of depths) {
      expect(layerZ(2, depth)).toBeLessThan(layerZ(3, 'fill'))
    }
  })

  test('tool previews clear the whole stack', () => {
    const top = PCB_LAYER_STACK.length - 1
    expect(PREVIEW_Z).toBeGreaterThan(layerZ(top, 'label'))
  })
})

describe('layerSlot', () => {
  test('recovers the slot from any depth in its band — float z never drifts one out', () => {
    for (let slot = 0; slot <= PCB_LAYER_STACK.length; slot++) {
      for (const depth of Object.keys(LAYER_DEPTH) as Array<keyof typeof LAYER_DEPTH>) {
        expect(layerSlot(layerZ(slot, depth))).toBe(slot)
      }
    }
  })
})

describe('the selected band', () => {
  const top = PCB_LAYER_STACK.length - 1
  const depths = Object.keys(LAYER_DEPTH) as Array<keyof typeof LAYER_DEPTH>

  test('is addressed wholly above the document', () => {
    expect(layerZ(0, 'fill') + LIFT_Z).toBeGreaterThan(layerZ(top, 'label'))
    expect(isLiftedSlot(top)).toBe(false)
    expect(isLiftedSlot(layerSlot(layerZ(0) + LIFT_Z))).toBe(true)
  })

  test('lifting moves every slot at every depth up exactly one band', () => {
    for (let slot = 0; slot <= top; slot++) {
      for (const depth of depths) {
        expect(layerSlot(layerZ(slot, depth) + LIFT_Z)).toBe(slot + LIFTED_SLOT_OFFSET)
      }
    }
  })

  test('tool previews are addressed above the selection too', () => {
    expect(PREVIEW_Z).toBeGreaterThan(layerZ(top, 'label') + LIFT_Z)
  })
})

describe('boardLayerFlipper', () => {
  const rows = (names: string[]): Array<{ ordinal: number; name: string; type: string }> =>
    names.map((name, i) => ({ ordinal: i * 2, name, type: 'signal' }))

  test('front and back swap; other layers stay', () => {
    const flip = boardLayerFlipper(rows(['F.Cu', 'B.Cu']))
    expect(flip('F.SilkS')).toBe('B.SilkS')
    expect(flip('B.CrtYd')).toBe('F.CrtYd')
    expect(flip('*.Cu')).toBe('*.Cu')
    expect(flip('F&B.Cu')).toBe('F&B.Cu')
    expect(flip('Edge.Cuts')).toBe('Edge.Cuts')
    expect(flip('In1.Cu')).toBe('In1.Cu')
  })

  test('inner copper runs end for end on four layers or more', () => {
    const six = boardLayerFlipper(rows(['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu']))
    expect(six('In1.Cu')).toBe('In4.Cu')
    expect(six('In2.Cu')).toBe('In3.Cu')
    expect(six('In4.Cu')).toBe('In1.Cu')
  })

  test('front and back user layers pair by their shared name, then as renamed neighbors', () => {
    const flip = boardLayerFlipper([
      { ordinal: 39, name: 'User.1', type: 'front', userName: 'F.Glue' },
      { ordinal: 41, name: 'User.2', type: 'user' },
      { ordinal: 43, name: 'User.3', type: 'back', userName: 'B.Glue' },
      { ordinal: 45, name: 'User.4', type: 'front', userName: 'Top art' },
      { ordinal: 47, name: 'User.5', type: 'back', userName: 'Bottom art' }
    ])
    expect(flip('User.1')).toBe('User.3')
    expect(flip('User.3')).toBe('User.1')
    expect(flip('User.2')).toBe('User.2')
    expect(flip('User.4')).toBe('User.5')
  })
})

describe('kicadLayerId', () => {
  test('KiCad 10’s ids: outer copper, then masks between, inner copper at 2 + 2n', () => {
    const order = ['In2.Cu', 'F.Paste', 'B.Cu', 'F.Cu', 'User.1', 'F.Mask', 'In1.Cu']
    expect(order.sort((a, b) => kicadLayerId(a) - kicadLayerId(b))).toEqual([
      'F.Cu',
      'F.Mask',
      'B.Cu',
      'In1.Cu',
      'In2.Cu',
      'F.Paste',
      'User.1'
    ])
    expect(kicadLayerId('Nonsense')).toBe(Infinity)
  })
})
