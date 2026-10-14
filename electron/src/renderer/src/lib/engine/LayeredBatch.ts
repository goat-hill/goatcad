import * as THREE from 'three'
import { LabelBatch } from './LabelBatch'
import { PrimitiveBatch, type PrimitiveBatchOptions } from './PrimitiveBatch'
import { PART_SEPARATOR } from './keyHierarchy'
import { createSlotViewUniforms, type BatchView, type BoardViewUniforms } from './boardView'

/** What a batch has to offer to be split across slots. */
export interface SlotBatch {
  readonly mesh: THREE.Mesh
  /** The board view the slot draws under, if any: its slot uniforms are set per slot. */
  readonly view?: BatchView
  writeMeta: Uint32Array
  setCoverageMode(on: boolean): void
  reset(): void
  removeElement(key: string): void
  renameElements(renames: ReadonlyArray<readonly [string, string]>): void
  debugElements(): Map<string, string[]>
  saveOrigins(keys: string[]): void
  clearOrigins(): void
  translateElement(key: string, dx: number, dy: number): void
  getBounds(target: THREE.Box3): THREE.Box3
  dispose(): void
  hasElement(key: string): boolean
  elementKeys(): string[]
  liftCopyTo(key: string, target: this, dz: number): void
  dropLift(key: string): void
  hasUnlifted(key: string): boolean
}

/**
 * A second band of slots above the document for what is selected
 * (`LIFTED_SLOT_OFFSET`, layers.ts): slot `s` lifts to `s + offset`, and every
 * piece moved there has its z raised by `dz`, so the band is also on the far
 * side of the selection split.
 */
export interface SlotBand {
  offset: number
  dz: number
}

/** The element a key belongs to: a part (`footprint:3/pad:1`) answers to its parent. */
const topKey = (key: string): string => {
  const cut = key.indexOf(PART_SEPARATOR)
  return cut < 0 ? key : key.slice(0, cut)
}

/**
 * One batch per render slot, drawn in slot order — the shape a document needs
 * when the things BETWEEN its strokes must interleave with them. A board's
 * translucent zone fills are the case: a single batch spanning every layer can
 * only draw entirely before or entirely after them, so the fills' place in the
 * stack would have to be settled by a depth buffer instead, and a depth buffer
 * cannot carry a stroke's soft edge (see `boardFillRenderOrder`). Split per
 * slot, fills land between the batches they belong between, and paint order
 * alone is authoritative.
 *
 * Batches are created on demand, so a document pays only for the slots it
 * uses, and are kept across `reset` — a rebuild refills the same buffers.
 *
 * Key-addressed operations fan out to every slot, which is how an element that
 * spans layers — a pad on copper and mask — recolors and drags as one. A batch
 * that has never seen the key does nothing, at the cost of a failed map
 * lookup; tracking which slots hold which key would buy nothing and could go
 * stale.
 */
export abstract class LayeredBatch<T extends SlotBatch> {
  /** Add this to the scene, the way a single batch's `mesh` would be added. */
  public readonly group = new THREE.Group()

  private readonly batches = new Map<number, T>()

  /**
   * The meta the next instance written takes, on whichever slot it lands
   * (`boardView.ts`): every slot's batch holds this same array.
   */
  public readonly writeMeta = new Uint32Array(4)

  protected constructor(
    private readonly slotOfZ: (z: number) => number,
    private renderOrderOfSlot: (slot: number) => number,
    private readonly create: (view: BatchView | undefined) => T,
    private readonly band: SlotBand | null = null,
    private readonly view?: BoardViewUniforms
  ) {}

  /**
   * Draw the slots in a new order (`PaintOrder`, for a change of view): every
   * batch's render order is set again, slots that appear later included, and
   * nothing they hold is touched.
   */
  public reorder(renderOrderOfSlot: (slot: number) => number): void {
    this.renderOrderOfSlot = renderOrderOfSlot
    for (const [slot, batch] of this.batches) batch.mesh.renderOrder = renderOrderOfSlot(slot)
  }

  protected at(z: number): T {
    return this.atSlot(this.slotOfZ(z))
  }

  private atSlot(slot: number): T {
    let batch = this.batches.get(slot)
    if (!batch) {
      batch = this.create(
        this.view ? { shared: this.view, slot: createSlotViewUniforms() } : undefined
      )
      batch.writeMeta = this.writeMeta
      batch.mesh.renderOrder = this.renderOrderOfSlot(slot)
      this.slotCreated?.(slot, batch)
      this.batches.set(slot, batch)
      this.group.add(batch.mesh)
    }
    return batch
  }

  /** Told of every slot as it first appears, so its view uniforms start right. */
  public slotCreated: ((slot: number, batch: T) => void) | null = null

  protected each(visit: (batch: T) => void): void {
    for (const batch of this.batches.values()) visit(batch)
  }

  /**
   * The live slots, for a caller that has to treat one layer as a unit rather
   * than as the strokes in it: the view sets a slot's uniforms, and a preview
   * flatten (`ViewportEngine.setPreviewLayers`) draws a slot's mesh by itself.
   */
  public slots(): Array<{ slot: number; batch: T }> {
    return [...this.batches].map(([slot, batch]) => ({ slot, batch }))
  }

  public reset(): void {
    this.each((b) => b.reset())
  }

  /**
   * Put exactly `keys` in the selected band: each element named there is
   * copied up from whatever home slots hold it, parts included, and hidden at
   * home; anything in the band that is no longer named is dropped there and
   * shown at home again. Home paint never moves, so a home slot's order — and
   * its buffer on the GPU — is untouched by selection: only the copies are
   * written. What is lifted is read from the batches rather than remembered,
   * so a rebuild, an edit's re-render or a rename can never leave the two
   * disagreeing — a re-rendered element simply lands at home, shown, and the
   * next call lifts it again. The batches that received paint are returned,
   * for a caller whose order within a slot matters.
   */
  public liftElements(keys: ReadonlySet<string>): T[] {
    const band = this.band
    if (!band) return []
    const received = new Set<T>()
    const slots = [...this.batches]
    for (const [slot, batch] of slots) {
      if (slot < band.offset) continue
      const leaving = new Set(
        batch
          .elementKeys()
          .map(topKey)
          .filter((key) => !keys.has(key))
      )
      for (const key of leaving) {
        batch.removeElement(key)
        this.batches.get(slot - band.offset)?.dropLift(key)
      }
    }
    for (const [slot, home] of slots) {
      if (slot >= band.offset) continue
      for (const key of keys) {
        if (!home.hasUnlifted(key)) continue
        // Drawn again at home since its last lift: the band's copy is stale.
        const target = this.atSlot(slot + band.offset)
        target.removeElement(key)
        home.dropLift(key)
        home.liftCopyTo(key, target, band.dz)
        received.add(target)
      }
    }
    return [...received]
  }

  public removeElement(key: string): void {
    this.each((b) => b.removeElement(key))
  }

  public renameElements(renames: ReadonlyArray<readonly [string, string]>): void {
    this.each((b) => b.renameElements(renames))
  }

  /** Test-only: per-key rows across slots, keys prefixed by slot ordinal. */
  public debugElements(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const [slot, b] of this.batches) {
      for (const [key, rows] of b.debugElements()) out.set(`${slot}|${key}`, rows)
    }
    return out
  }

  public saveOrigins(keys: string[]): void {
    this.each((b) => b.saveOrigins(keys))
  }

  public clearOrigins(): void {
    this.each((b) => b.clearOrigins())
  }

  public translateElement(key: string, dx: number, dy: number): void {
    this.each((b) => b.translateElement(key, dx, dy))
  }

  public getBounds(target: THREE.Box3): THREE.Box3 {
    this.each((b) => b.getBounds(target))
    return target
  }

  public dispose(): void {
    this.each((b) => {
      b.mesh.removeFromParent()
      b.dispose()
    })
    this.batches.clear()
  }
}

/**
 * SDF strokes, pads and rings, split across slots.
 *
 * `depthWrite` is not the caller's to pass: being split across slots IS the
 * claim that paint order settles the stacking, and a depth write would then
 * only take the anti-aliased rim out of what follows.
 */
export class LayeredPrimitiveBatch extends LayeredBatch<PrimitiveBatch> {
  constructor(
    slotOfZ: (z: number) => number,
    renderOrderOfSlot: (slot: number) => number,
    options: Omit<PrimitiveBatchOptions, 'depthWrite' | 'view'> = {},
    slotCapacity = 512,
    band: SlotBand | null = null,
    view?: BoardViewUniforms
  ) {
    super(
      slotOfZ,
      renderOrderOfSlot,
      (slotView) =>
        new PrimitiveBatch(slotCapacity, { ...options, depthWrite: false, view: slotView }),
      band,
      view
    )
  }

  /**
   * The base lift, then the order within every band slot that received paint:
   * a copy is appended, and a pad body appended after a neighbour's drill
   * mark would cover it.
   */
  public override liftElements(keys: ReadonlySet<string>): PrimitiveBatch[] {
    const received = super.liftElements(keys)
    for (const batch of received) if (batch.needsSort) batch.finalizeSorted()
    return received
  }

  /** Test-only: each slot's live z values in paint order. */
  public debugDrawOrder(): Map<number, number[]> {
    return new Map(this.slots().map(({ slot, batch }) => [slot, batch.debugDrawOrder()]))
  }

  public setElementHidden(key: string, hidden: boolean): void {
    this.each((b) => b.setElementHidden(key, hidden))
  }

  public elementBounds(key: string, target: THREE.Box3): THREE.Box3 {
    this.each((b) => b.elementBounds(key, target))
    return target
  }

  public addCapsule(
    key: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    halfWidth: number,
    color: THREE.Color,
    alpha: number,
    z: number
  ): void {
    this.at(z).addCapsule(key, x0, y0, x1, y1, halfWidth, color, alpha, z)
  }

  public addRoundRect(
    key: string,
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
    cornerRadius: number,
    rotation: number,
    color: THREE.Color,
    alpha: number,
    z: number
  ): void {
    this.at(z).addRoundRect(key, cx, cy, halfW, halfH, cornerRadius, rotation, color, alpha, z)
  }

  public addRing(
    key: string,
    cx: number,
    cy: number,
    radius: number,
    halfStroke: number,
    color: THREE.Color,
    alpha: number,
    z: number
  ): void {
    this.at(z).addRing(key, cx, cy, radius, halfStroke, color, alpha, z)
  }

  public addArc(
    key: string,
    cx: number,
    cy: number,
    radius: number,
    halfStroke: number,
    bisector: number,
    aperture: number,
    color: THREE.Color,
    alpha: number,
    z: number
  ): void {
    this.at(z).addArc(key, cx, cy, radius, halfStroke, bisector, aperture, color, alpha, z)
  }

  /** Order instances by depth WITHIN each slot; the slots order themselves. */
  public finalizeSorted(): void {
    this.each((b) => b.finalizeSorted())
  }

  /** The same, for only the slots a patch left out of order. */
  public sortWhereNeeded(): void {
    this.each((b) => {
      if (b.needsSort) b.finalizeSorted()
    })
  }

  public setElementColor(key: string, color: THREE.Color): void {
    this.each((b) => b.setElementColor(key, color))
  }

  public copyElementTo(
    key: string,
    target: PrimitiveBatch,
    color: THREE.Color,
    alpha: number
  ): void {
    this.each((b) => b.copyElementTo(key, target, color, alpha))
  }

  public shiftElementColors(key: string, amount: number): void {
    this.each((b) => b.shiftElementColors(key, amount))
  }

  public repaintElements(paint: (key: string, color: THREE.Color) => THREE.Color | null): void {
    this.each((b) => b.repaintElements(paint))
  }

  public resetColors(): void {
    this.each((b) => b.resetColors())
  }
}

/**
 * SDF glyph labels, split across slots. A pad number belongs to its pad, so it
 * has to be coverable by the layers over that pad — a back-side pad's number
 * has no business showing through the front copper above it.
 */
export class LayeredLabelBatch extends LayeredBatch<LabelBatch> {
  // Held in a box the factory closes over: slots appear on demand, long after
  // the constructor, and each one has to open in the theme's current ink.
  private readonly ink: { color: THREE.ColorRepresentation | null }

  constructor(
    slotOfZ: (z: number) => number,
    renderOrderOfSlot: (slot: number) => number,
    slotCapacity = 128,
    band: SlotBand | null = null,
    view?: BoardViewUniforms
  ) {
    const ink: { color: THREE.ColorRepresentation | null } = { color: null }
    super(
      slotOfZ,
      renderOrderOfSlot,
      (slotView) => {
        const batch = new LabelBatch(slotCapacity, { depthWrite: false, view: slotView })
        if (ink.color !== null) batch.setColor(ink.color)
        return batch
      },
      band,
      view
    )
    this.ink = ink
  }

  public setElementHidden(key: string, hidden: boolean): void {
    this.each((b) => b.setElementHidden(key, hidden))
  }

  /** Recolor every label, and every slot that appears afterwards. */
  public setColor(color: THREE.ColorRepresentation): void {
    this.ink.color = color
    this.each((b) => b.setColor(color))
  }

  public addLabel(
    key: string,
    text: string,
    cx: number,
    cy: number,
    z: number,
    refDim: number
  ): void {
    this.at(z).addLabel(key, text, cx, cy, z, refDim)
  }

  public addLabelBlock(
    key: string,
    lines: readonly string[],
    cx: number,
    cy: number,
    z: number,
    boxW: number,
    boxH: number,
    rotation: number,
    alpha = 1
  ): void {
    this.at(z).addLabelBlock(key, lines, cx, cy, z, boxW, boxH, rotation, alpha)
  }

  public addLabelAlong(
    key: string,
    text: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    trackWidth: number,
    z: number,
    alpha = 1
  ): void {
    this.at(z).addLabelAlong(key, text, x0, y0, x1, y1, trackWidth, z, alpha)
  }
}
