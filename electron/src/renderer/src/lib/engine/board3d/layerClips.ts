/**
 * The two geometric truths a flat layer mesh has to obey, as `ShapeClip`s:
 * copper (and anything else drawn on the board) stops at a drill bore, and
 * silkscreen stops at the board edge.
 *
 * The machinery — grid-indexed subtraction and coverage clipping that make
 * the untouched common case free — lives in `lib/geometry/regionClips.ts`
 * and is shared with the Gerber writer; this file only knows how to phrase
 * drills and the board outline as clip geometry.
 */

import type { ClipRegion } from '../../geometry/clip'
import { KeepWithinRegions, SubtractRegions, type ShapeClip } from '../../geometry/regionClips'
import type { DrillHole } from './boardLayers'
import type { OutlineRegion } from './boardOutline'
import { placedRoundRect } from './flatMesh'

/**
 * How far past the bore wall the copper retreats, in millimeters. Keeps the
 * clipped copper edge and the substrate's cut edge from being exactly
 * coincident, and is well under anything visible (fabs etch back far more).
 */
const BORE_CLEARANCE = 0.002

/** Subtracts every drill bore from the regions that overlap one. */
export class DrillSubtract extends SubtractRegions {
  constructor(holes: readonly DrillHole[]) {
    super(
      holes.map((hole): ClipRegion => ({
        outer: placedRoundRect(
          hole.x,
          hole.y,
          hole.halfW + BORE_CLEARANCE,
          hole.halfH + BORE_CLEARANCE,
          hole.cornerR + BORE_CLEARANCE,
          hole.angle
        ),
        holes: []
      }))
    )
  }
}

/** Keeps only what lies on the board: regions are cut at the outline. */
export class OutlineKeep extends KeepWithinRegions {
  constructor(regions: readonly OutlineRegion[]) {
    super(regions.map((region) => ({ outer: region.outer, holes: region.holes })))
  }
}

/** Solder-mask openings per board face, in world space (see `maskOpenings`). */
export interface MaskOpenings {
  front: readonly ClipRegion[]
  back: readonly ClipRegion[]
}

/**
 * The clip stack for each kind of layer, or nothing when the engine is not
 * loaded — callers then render without clipping.
 */
export interface LayerClips {
  /** Copper, pads and paste: stop at every drill bore. */
  drilled: ShapeClip[] | undefined
  /** Silkscreen: stop at the bores, the board edge, and that side's mask
   *  openings — silk is not printed where the mask opens. */
  silkFor(layer: string): ShapeClip[] | undefined
}

export function buildLayerClips(
  holes: readonly DrillHole[],
  outline: { regions: OutlineRegion[]; fallback: boolean; openCount: number } | null,
  openings?: MaskOpenings
): LayerClips {
  const drill = holes.length > 0 ? new DrillSubtract(holes) : null
  // Only a complete, closed outline is trusted to eat geometry. A fallback
  // box or a half-closed sketch would clip real silk against a wrong border.
  const keep =
    outline && !outline.fallback && outline.openCount === 0 && outline.regions.length > 0
      ? new OutlineKeep(outline.regions)
      : null
  const maskFront =
    openings && openings.front.length > 0 ? new SubtractRegions(openings.front) : null
  const maskBack = openings && openings.back.length > 0 ? new SubtractRegions(openings.back) : null

  const stack = (mask: SubtractRegions | null): ShapeClip[] | undefined => {
    const clips: ShapeClip[] = []
    if (drill) clips.push(drill)
    if (mask) clips.push(mask)
    if (keep) clips.push(keep)
    return clips.length > 0 ? clips : undefined
  }
  return {
    drilled: drill ? [drill] : undefined,
    silkFor: (layer) => stack(layer.startsWith('B.') ? maskBack : maskFront)
  }
}
