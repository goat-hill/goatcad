/**
 * Render order on a PCB canvas — the one place it is computed
 * (ARCHITECTURE.md, PCB boards: Paint order).
 *
 * Every mesh a PCB scene adds to the document has a paint ADDRESS: the slot it
 * was written into (a layer's place in `PCB_LAYER_STACK` — the selected band
 * and the preview slot above it, `layerSlot`) and a lane within that slot.
 * The address is fixed when the geometry is written. `PaintOrder` maps it to a
 * render order for one VIEW — the active layer — so a change of view
 * re-applies orders to meshes and never touches what they hold.
 *
 * Within the document the order is KiCad's `SetTopLayer`:
 * - the stack, bottom to top, with the active layer lifted to the top;
 * - the via-and-hole slot above the topmost copper, so nothing on a copper
 *   layer buries a hole;
 * - the net-name rank above all of it: the FACING copper's label lane (the
 *   topmost copper, the active layer when that is copper), then the
 *   net-name slot's own lanes (multi-layer pads' and vias' labels).
 *
 * The selected band repeats the document's order above it, and the preview
 * slot sits above both. `OVERLAY_ORDER` ranks what draws above every band.
 * Each entry gets its own integer, so no two document meshes ever tie.
 */
import {
  LIFTED_SLOT_OFFSET,
  NETNAMES_PSEUDO_LAYER,
  PREVIEW_SLOT,
  isCopperLayer,
  pcbLayerOrder
} from './layers'

/** Where in its slot a mesh paints, bottom to top: a pour under its hatch, under the slot's strokes, under its labels. */
export const PAINT_LANES = ['fill', 'hatch', 'stroke', 'label'] as const
export type PaintLane = (typeof PAINT_LANES)[number]

/**
 * What draws above every band, in fixed ranks — on the schematic and symbol
 * canvases too, which share the markers. The selection chrome's ranks live
 * with it (`CHROME_STACK`, 2000–2003), between the ratsnest and the markers.
 */
export const OVERLAY_ORDER = {
  ratsnest: 1500,
  findingMarkers: 2400,
  originMarker: 2500
} as const

/** The first rank the overlays may use; every band's entries end below it. */
export const OVERLAY_FLOOR = 1500

export interface PaintView {
  /** The layer being worked on, lifted to the top. */
  activeLayer?: string
  /** Viewing from the back: the stack is the flipped one, and so are the slots. */
  flipped?: boolean
}

export class PaintOrder {
  /** Document entries, bottom to top: `slot * lanes + lane` → its position. */
  private readonly position = new Map<number, number>()
  /** Document slots, bottom to top, for whatever orders whole layers (the dim flatten). */
  public readonly slotsBottomUp: readonly number[]
  /** The copper the viewer is facing: its label lane rides the net-name rank. */
  public readonly facingCopper: string
  private readonly documentSize: number

  constructor(view: PaintView = {}) {
    const flipped = view.flipped ?? false
    // Slots are positions in the stack as written (mirrored for a flipped
    // view); ranks are positions in the view's order.
    const stack = pcbLayerOrder({ flipped })
    const slotOf = new Map(stack.map((layer, slot) => [layer, slot]))
    const viewOrder = pcbLayerOrder({ flipped, activeLayer: view.activeLayer })
    const copper = viewOrder.filter(isCopperLayer)
    this.facingCopper = copper[copper.length - 1] ?? 'F.Cu'

    const entries: Array<[number, PaintLane]> = []
    const slotsBottomUp: number[] = []
    const facingSlot = slotOf.get(this.facingCopper)!
    for (const layer of viewOrder) {
      const slot = slotOf.get(layer)!
      slotsBottomUp.push(slot)
      if (layer === NETNAMES_PSEUDO_LAYER) entries.push([facingSlot, 'label'])
      for (const lane of PAINT_LANES) {
        if (slot === facingSlot && lane === 'label') continue
        entries.push([slot, lane])
      }
    }
    entries.forEach(([slot, lane], at) => this.position.set(PaintOrder.key(slot, lane), at))
    this.slotsBottomUp = slotsBottomUp
    this.documentSize = entries.length
  }

  /** A document slot's place in this view, bottom 0: which of two layers is drawn over the other. */
  public rank(slot: number): number {
    return this.slotsBottomUp.indexOf(slot)
  }

  private static key(slot: number, lane: PaintLane): number {
    return slot * PAINT_LANES.length + PAINT_LANES.indexOf(lane)
  }

  /** The render order of what is written into `slot`'s `lane` (`layerSlot` of its z). */
  public renderOrder(slot: number, lane: PaintLane): number {
    if (slot >= PREVIEW_SLOT) return 2 * this.documentSize + PAINT_LANES.indexOf(lane)
    if (slot >= LIFTED_SLOT_OFFSET)
      return this.documentSize + this.documentOrder(slot - LIFTED_SLOT_OFFSET, lane)
    return this.documentOrder(slot, lane)
  }

  private documentOrder(slot: number, lane: PaintLane): number {
    const at = this.position.get(PaintOrder.key(slot, lane))
    if (at === undefined) throw new Error(`no layer at paint slot ${slot}`)
    return at
  }
}
