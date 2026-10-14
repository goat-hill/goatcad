/**
 * Parent/child index over element keys.
 *
 * Paint is filed under the most specific name a thing has — `symbol:3/pin:…`
 * rather than `symbol:3` — so that a single pin or body line can be moved or
 * highlighted. Anything asking for `symbol:3` must still reach all of it, and
 * that is what this resolves.
 *
 * Shared by `PrimitiveBatch` (instance indices) and `SchematicScene`'s glow
 * journal (recorded strokes), which key the same things and must agree about
 * what a parent covers — if they diverged, a selection would paint a halo
 * around a different set of strokes than it moves.
 *
 * Children are RECORDED as keys are seen, never derived by scanning for a
 * prefix. The maps this indexes hold one entry per segment, via and zone on a
 * dense board — order 10^5, where nothing has children at all — so a scan would
 * make every PCB drag pay for a schematic feature. It is also why prefix
 * matching would be wrong as well as slow: `symbol:11` starts with `symbol:1`.
 */

/** Separates a parent key from a part name. Part names never contain one. */
export const PART_SEPARATOR = '/'

/**
 * Drop keys whose parent is in the same list.
 *
 * A parent already carries its parts, so moving both moves the part twice —
 * once with the parent, once on its own. That is reachable as soon as anything
 * inside a container is separately selectable: shift-clicking a symbol and then
 * its Reference text is an ordinary thing to do, and the drag that follows must
 * not offset the text double.
 *
 * Order is preserved, so the caller's ranking survives.
 */
export function dropKeysCoveredByParent(keys: string[]): string[] {
  const present = new Set(keys)
  return keys.filter((key) => {
    const cut = key.indexOf(PART_SEPARATOR)
    return cut < 0 || !present.has(key.slice(0, cut))
  })
}

export class KeyHierarchy {
  private children = new Map<string, string[]>()

  /** Record `key` under its parent, if it names one. Call once per new key. */
  add(key: string): void {
    const cut = key.indexOf(PART_SEPARATOR)
    if (cut < 0) return
    const parent = key.slice(0, cut)
    const siblings = this.children.get(parent)
    if (siblings) siblings.push(key)
    else this.children.set(parent, [key])
  }

  /**
   * `key` plus every key filed beneath it. A key with no children resolves to
   * itself through one map lookup — every key in the PCB and footprint editors.
   *
   * `hasOwn` reports whether the parent holds anything under its own name; a
   * symbol's paint lives entirely in its parts, so usually it does not.
   */
  expand(key: string, hasOwn: (key: string) => boolean): string[] {
    const children = this.children.get(key)
    if (!children) return [key]
    return hasOwn(key) ? [key, ...children] : children
  }

  /** Whether `key` has parts filed beneath it. */
  hasChildren(key: string): boolean {
    return this.children.has(key)
  }

  delete(key: string): void {
    this.children.delete(key)
  }

  clear(): void {
    this.children.clear()
  }
}
