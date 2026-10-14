/**
 * Refilling a board's zones: the editor's auto-refill and `B`, and the
 * agent's `board.refill`, run this one loop over `zoneFill.ts`.
 *
 * Zones fill in rank order, each against the fresh fills of the zones above it
 * (`freshFills`), yielding between steps so a large board never blocks input.
 * A deadline stops before the next zone, leaving the rest for a later pass:
 * the caller commits what came back and says what was left.
 */
import type { KicadBoard, KicadBoardZone } from '../kicad/board'
import type { Nm } from '../kicad/coordinates'
import type { BoardSpatialIndex } from './spatialIndex'
import type { BoardRules } from './rules/boardRules'
import { computeZoneFillSteps, fillOrder, freshFills, zoneFillOptions } from './zoneFill'
import { yieldControl } from '../cooperate'

/** One zone's new fill, in the shape `setZoneFilledPolysInAST` writes. */
export interface ZoneRefill {
  zone: KicadBoardZone
  polys: Array<{ layer: string; points: Array<{ x: Nm; y: Nm }> }>
}

export interface RefillResult {
  fills: ZoneRefill[]
  /** Zones asked for that the deadline left unfilled, in fill order. */
  remaining: KicadBoardZone[]
}

/** Whether the filler pours this zone at all: a rule area or a degenerate outline has no fill. */
export const fillable = (zone: KicadBoardZone): boolean =>
  !zone.isKeepout && zone.points.length >= 3

/**
 * Compute new fills for `targets` (every fillable zone for 'all'). Null when
 * `cancelled` answers true between steps: the board moved on and the result
 * would be stale. `zone` is told as each zone starts, with every zone the
 * refill means to fill. The Clipper engine must be loaded.
 */
export async function computeRefill(
  board: KicadBoard,
  index: BoardSpatialIndex,
  rules: BoardRules,
  targets: ReadonlySet<KicadBoardZone> | 'all',
  options: {
    deadline?: number
    cancelled?: () => boolean
    zone?: (zone: KicadBoardZone, plan: readonly KicadBoardZone[]) => void
  } = {}
): Promise<RefillResult | null> {
  const fills: ZoneRefill[] = []
  const remaining: KicadBoardZone[] = []
  const fresh = freshFills()
  const plan = fillOrder(board.zones).filter(
    (zone) => fillable(zone) && (targets === 'all' || targets.has(zone))
  )
  for (const zone of plan) {
    if (options.deadline !== undefined && performance.now() > options.deadline) {
      remaining.push(zone)
      continue
    }
    options.zone?.(zone, plan)
    const steps = computeZoneFillSteps(board, index, zone, {
      ...zoneFillOptions(rules, zone),
      fillOf: fresh.fillOf
    })
    let step = steps.next()
    while (!step.done) {
      await yieldControl()
      if (options.cancelled?.()) return null
      step = steps.next()
    }
    fresh.set(zone, step.value)
    fills.push({
      zone,
      polys: step.value.flatMap((layerFill) =>
        layerFill.polys.map((points) => ({ layer: layerFill.layer, points }))
      )
    })
  }
  return { fills, remaining }
}
