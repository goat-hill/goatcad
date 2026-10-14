import { padProperty } from '../../../footprint/klc'
import { boxesTouch, capsuleEntersRegion, type Region } from '../../../geometry/polygon'
import { PackedRTree } from '../../../geometry/packedRTree'
import type { DrcContext } from '../context'
import { COURTYARD_TOUCH, at, worldOf, overlapOf, OUTLINE_PROBLEM, type Courtyard } from '../shared'

export function* courtyardChecks(ctx: DrcContext): Generator<void> {
  const { emit, pair, one, courtyards, board, tick, region, near, holesFrom, holesNear } = ctx
  // One finding per problem in either side's outline, as KiCad reports each.
  for (const courtyard of courtyards) {
    const position = worldOf(board.footprints[courtyard.fp].position)
    const box = courtyard.box ?? {
      minX: position.x,
      minY: position.y,
      maxX: position.x,
      maxY: position.y
    }
    for (const [side, problems] of [
      ['F', courtyard.problems.front],
      ['B', courtyard.problems.back]
    ] as const)
      for (const problem of problems)
        one(
          'malformed-courtyard',
          'error',
          `${courtyard.subject.name}: the ${side}.CrtYd outline ${OUTLINE_PROBLEM[problem.reason]}.`,
          courtyard.subject,
          problem.at,
          [box],
          undefined,
          { detail: `${side}.CrtYd ${OUTLINE_PROBLEM[problem.reason]}` }
        )
  }
  // The courtyards that could meet one, by their boxes, in board order.
  const boxed = courtyards.filter((c) => c.box)
  const boxes = new Float64Array(boxed.length * 4)
  boxed.forEach((c, i) => boxes.set([c.box!.minX, c.box!.minY, c.box!.maxX, c.box!.maxY], i * 4))
  const tree = new PackedRTree(boxes, boxed.length)
  const courtyardsNear = (a: Courtyard): Courtyard[] => {
    const box = a.box!
    const fps: number[] = []
    tree.search(box.minX, box.minY, box.maxX, box.maxY, (i) => {
      const fp = boxed[i].fp
      // Each pair once, from its first footprint: in a region run, from whichever is in it.
      if (fp !== a.fp && (fp > a.fp || !near(boxed[i].box!))) fps.push(fp)
    })
    return fps.sort((x, y) => x - y).map((fp) => courtyards[fp])
  }
  // A region run tests a courtyard in the region against every hole, and any
  // other only against the holes in the region.
  const holesInRegion = region
    ? holesFrom(0).filter((hole) => hole.footprint !== null)
    : ctx.padHoles
  for (let i = 0; i < courtyards.length; i++) {
    if (tick()) yield
    const a = courtyards[i]
    if (!a.box) continue
    const aNear = near(a.box)
    if (!aNear && holesInRegion.length === 0) continue
    for (const other of aNear ? courtyardsNear(a) : []) {
      if (!other.box || !boxesTouch(a.box, other.box)) continue
      // Measured in the board's order whichever side found it, so it reads the same.
      const [first, second] = other.fp < a.fp ? [other, a] : [a, other]
      const hit = overlapOf(first.front, second.front) ?? overlapOf(first.back, second.back)
      if (!hit) continue
      emit(
        {
          code: 'courtyards-overlap',
          severity: 'error',
          message: `The courtyards of ${first.subject.name} and ${second.subject.name} overlap.`,
          position: at(hit),
          ...pair(first.subject, second.subject)
        },
        [a.box, other.box]
      )
    }
    // Another footprint's drilled holes inside this courtyard: the hole, not the pad's copper.
    for (const hole of aNear ? (region ? holesNear(a.box) : holesInRegion) : holesInRegion) {
      if (hole.footprint === a.fp || !boxesTouch(a.box, hole.box)) continue
      if (hole.pad && padProperty(hole.pad._raw) === 'pad_prop_heatsink') continue
      const p = { x: hole.shape.x0, y: hole.shape.y0 }
      const q = { x: hole.shape.x1, y: hole.shape.y1 }
      const enters = (regions: Region[]): boolean =>
        regions.some((region) =>
          capsuleEntersRegion(p, q, hole.shape.halfWidth, region, COURTYARD_TOUCH / 2)
        )
      if (!enters(a.front) && !enters(a.back)) continue
      emit(
        {
          code: hole.plated ? 'pth-inside-courtyard' : 'npth-inside-courtyard',
          severity: 'error',
          message: `The hole of ${hole.subject.name} is inside the courtyard of ${a.subject.name}.`,
          position: at(hole.center),
          ...pair(hole.subject, a.subject)
        },
        [hole.box, a.box]
      )
    }
  }
}
