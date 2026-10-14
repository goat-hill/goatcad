/**
 * Why an instance is hidden where it stands. A preview hides what it stands in
 * for (a dragged track, pushed copper, a resized shape) and shows it again; a
 * lift hides an element's home paint while its copy draws in the selected band
 * (`LayeredBatch.liftElements`). The two come and go independently, so an
 * instance shows again only once neither holds it.
 */
export const HIDDEN_FOR_PREVIEW = 1
export const HIDDEN_FOR_LIFT = 2

/**
 * Instances hidden in place, by reason: each batch hides one by writing a
 * sentinel into one field (a shape's type, a glyph's alpha) and keeps the value
 * it replaced here, so showing it again restores exactly what was drawn.
 */
export class InPlaceHides {
  private readonly saved = new Map<number, number>()
  private readonly reasons = new Map<number, number>()

  constructor(
    private readonly read: (i: number) => number,
    private readonly write: (i: number, value: number) => void,
    private readonly hiddenValue: number
  ) {}

  /** Hide instance `i` for `reason`; true when it was showing before. */
  public hide(i: number, reason: number): boolean {
    const held = this.reasons.get(i) ?? 0
    if (held & reason) return false
    this.reasons.set(i, held | reason)
    if (held !== 0) return false
    this.saved.set(i, this.read(i))
    this.write(i, this.hiddenValue)
    return true
  }

  /** Release `reason`'s hold on instance `i`; true when it shows again. */
  public show(i: number, reason: number): boolean {
    const held = this.reasons.get(i) ?? 0
    if (!(held & reason)) return false
    const rest = held & ~reason
    if (rest !== 0) {
      this.reasons.set(i, rest)
      return false
    }
    this.reasons.delete(i)
    this.write(i, this.saved.get(i)!)
    this.saved.delete(i)
    return true
  }

  public isHiddenFor(i: number, reason: number): boolean {
    return ((this.reasons.get(i) ?? 0) & reason) !== 0
  }

  /** What instance `i` draws with when shown: its hidden value saved, else its field. */
  public shownValue(i: number): number {
    return this.saved.get(i) ?? this.read(i)
  }

  /** Every instance `reason` holds. */
  public heldFor(reason: number): number[] {
    return [...this.reasons].filter(([, held]) => held & reason).map(([i]) => i)
  }

  /** A slot recycled: whatever moves in starts shown. */
  public forget(i: number): void {
    this.reasons.delete(i)
    this.saved.delete(i)
  }

  public clear(): void {
    this.reasons.clear()
    this.saved.clear()
  }

  /** Follow a reorder of the buffer (`oldToNew[old]` is the new index). */
  public remap(oldToNew: readonly number[]): void {
    const reasons = [...this.reasons]
    const saved = [...this.saved]
    this.clear()
    for (const [i, held] of reasons) this.reasons.set(oldToNew[i], held)
    for (const [i, value] of saved) this.saved.set(oldToNew[i], value)
  }
}
