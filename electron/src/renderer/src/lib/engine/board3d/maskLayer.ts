/**
 * The solder mask as real geometry: the board face minus everything the mask
 * layer opens (pads at their mask margin, mask-layer graphics) minus the
 * drill bores.
 *
 * Rendered as a translucent plane just above the copper, this is what makes
 * mask-defined pads, mask slivers between fine-pitch pads and exposed-copper
 * areas read honestly in 3D — the alternative (painting the substrate face
 * green) shows mask where the fab would open it. Returns `null` when the
 * geometry cannot be trusted (engine missing, boolean failure); the caller
 * then falls back to face paint.
 */

import type { ClipRegion } from '../../geometry/clip'
import { drainSteps, subtractInPiecesSteps } from '../../geometry/regionClips'
import type { DrillHole } from './boardLayers'
import type { OutlineRegion } from './boardOutline'
import { placedRoundRect } from './flatMesh'

export function buildMaskRegions(
  outline: readonly OutlineRegion[],
  openings: readonly ClipRegion[],
  holes: readonly DrillHole[]
): ClipRegion[] | null {
  return drainSteps(buildMaskRegionsSteps(outline, openings, holes))
}

/** Stepwise `buildMaskRegions`: yields between booleans (see `ShapeClip`). */
export function* buildMaskRegionsSteps(
  outline: readonly OutlineRegion[],
  openings: readonly ClipRegion[],
  holes: readonly DrillHole[]
): Generator<void, ClipRegion[] | null> {
  if (outline.length === 0) return null
  const cuts: ClipRegion[] = [...openings]
  for (const hole of holes) {
    cuts.push({
      outer: placedRoundRect(hole.x, hole.y, hole.halfW, hole.halfH, hole.cornerR, hole.angle),
      holes: []
    })
  }
  try {
    // Partitioned per outline region: a dense board opens the mask thousands
    // of times, and one difference over all of them would return a region
    // earcut takes seconds on.
    const out: ClipRegion[] = []
    for (const region of outline) {
      out.push(
        ...(yield* subtractInPiecesSteps(
          { outer: [...region.outer], holes: [...region.holes] },
          cuts
        ))
      )
    }
    return out
  } catch (error) {
    console.warn('mask layer boolean failed; falling back to face paint', error)
    return null
  }
}
