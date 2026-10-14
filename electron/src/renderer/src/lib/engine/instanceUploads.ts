import type * as THREE from 'three'

/**
 * Past this many separate update ranges on one attribute, the whole attribute
 * is sent instead: three.js sorts and merges the ranges on every upload, and
 * one `bufferSubData` beats thousands of scattered ones.
 */
const MAX_UPDATE_RANGES = 512

/** Floats per instance in every attribute a batch keeps (`vec4`s). */
const STRIDE = 4

/**
 * What an instanced batch sends to the GPU at its next draw: only the
 * instances it wrote, so a click, a commit or a drag sends kilobytes however
 * large the batch. Runs written one after another (a rebuild, a footprint
 * drawn) join into one range; past `MAX_UPDATE_RANGES` separate ones, or after
 * a reorder that moves every instance, the whole attribute goes.
 *
 * A new attribute (`bind`, after a batch grows) is created whole at its first
 * upload, so nothing needs queuing for it.
 */
export class InstanceUploads<Part extends string> {
  private attrs!: Partial<Record<Part, THREE.InstancedBufferAttribute>>
  // True from uploadWhole until the next upload consumes it (onUpload). While
  // it is pending, ranges must NOT be added: when ranges exist three.js uploads
  // only those, and the rest of the rewrite would never reach the GPU.
  private whole = {} as Record<Part, boolean>

  /** The batch's current attributes, as it (re)allocates them; a part it does not keep is left out. */
  public bind(attrs: Partial<Record<Part, THREE.InstancedBufferAttribute>>): void {
    this.attrs = attrs
    for (const part of this.parts()) {
      this.whole[part] = false
      attrs[part]!.onUpload(() => (this.whole[part] = false))
    }
  }

  /** Send instance `i` of one attribute at the next upload. */
  public touch(part: Part, i: number): void {
    const attr = this.attrs[part]
    if (!attr) return
    attr.needsUpdate = true
    if (this.whole[part]) return
    const start = i * STRIDE
    const ranges = attr.updateRanges
    const last = ranges[ranges.length - 1]
    if (last && start >= last.start && start < last.start + last.count) return
    if (last && last.start + last.count === start) last.count += STRIDE
    else if (last && start + STRIDE === last.start) {
      // Recycled slots come back in reverse (a free list is a stack).
      last.start = start
      last.count += STRIDE
    } else if (ranges.length < MAX_UPDATE_RANGES) attr.addUpdateRange(start, STRIDE)
    else this.uploadWhole(part)
  }

  /** Every attribute of instance `i`: a new or moved instance. */
  public touchInstance(i: number): void {
    for (const part of this.parts()) this.touch(part, i)
  }

  /** Send one attribute whole at the next upload. */
  public uploadWhole(part: Part): void {
    const attr = this.attrs[part]
    if (!attr) return
    attr.clearUpdateRanges()
    attr.needsUpdate = true
    this.whole[part] = true
  }

  /** Send every attribute whole: after a reorder, which moves every instance. */
  public uploadAll(): void {
    for (const part of this.parts()) this.uploadWhole(part)
  }

  private parts(): Part[] {
    return (Object.keys(this.attrs) as Part[]).filter((part) => this.attrs[part])
  }
}
