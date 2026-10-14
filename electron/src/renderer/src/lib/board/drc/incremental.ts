/**
 * Checking a board again after an edit, around what the edit changed
 * (design-health-workstream.md, "The DRC engine").
 *
 * A rule module is region-scoped or board-scoped (`BOARD_RULE_MODULES`). After
 * an edit, only the region rules run, and only round the edit: the dirty
 * region is every box the edit touched — each changed item's old and new
 * copper, holes, drawings and courtyard, and where a refill changed a fill
 * (the difference of its old and new copper) — grown by the farthest any rule
 * reaches. A finding of the last run stands unless one of the boxes it
 * involves meets that region; the region rules make every finding that does.
 * So the result is the whole run's, which a test holds on every rule over
 * KiCad's corpus.
 *
 * The board rules — the ratsnest, islands, spokes, zones against zones, the
 * edge, keepouts — read the whole board: they run in a settled pass, and
 * until then their last findings stand, marked stale.
 *
 * Anything a region cannot bound runs the whole board: another rule set, a
 * change to the board's nets or setup, or, where the project's rules test
 * areas or courtyards, any change to a zone or footprint.
 */
import { allZones, type KicadBoard, type KicadBoardZone } from '../../kicad/board'
import type { Box } from '../../geometry/polygon'
import { difference, union, type ClipRegion } from '../../geometry/clip'
import { ringBox } from '../../geometry/polygon'
import { footprintTransform, tfPoint } from '../../schematic/placement'
import { isCopperLayer } from '../../kicad/layers'
import { padHoleShape, type BoardSpatialIndex, type CopperItem } from '../spatialIndex'
import { drawingItems } from '../drawingItems'
import { boardCourtyards, boardCourtyardsFrom } from '../courtyards'
import { getToken, type SExprNode } from '../../kicad/sexpr'
import type { BoardCheckInput } from '../boardChecks'
import { BOARD_RULE_MODULES, type RuleScope } from './modules'
import { buildDrcContext } from './context'
import { worldOf, type Finding } from './shared'

/** A check of a board: every finding with its rule and the boxes it involves. */
export interface BoardCheckRun {
  input: BoardCheckInput
  findings: Finding[]
  /** The board rules' findings are an earlier board's, waiting on a settled run. */
  stale: boolean
  /**
   * What the next edit changes in place, as it was: each zone's fills and each
   * footprint's drilled holes, by AST node. Tracks, pads and drawings keep
   * their old shapes in this run's index and drawing items.
   */
  before: { fills: Map<SExprNode, KicadBoardZone['filledPolys']>; holes: Map<SExprNode, Box[]> }
}

/** An edit since a run: the board it started from and the AST nodes it changed. */
export interface BoardEdit {
  fromBoard: KicadBoard
  fromIndex: BoardSpatialIndex
  raws: ReadonlySet<unknown>
}

/** Beyond the farthest rule's reach, so float noise at the edge never matters. */
const REACH_MARGIN = 1e-3

/** Past this many boxes the region is their bounds: near() stays cheap. */
const MAX_REGION_BOXES = 256

/** The project's rule functions that read an area or courtyard anywhere on the board. */
const AREA_FUNCTIONS =
  /\b(intersectsArea|insideArea|enclosedByArea|intersectsCourtyard|intersectsFrontCourtyard|intersectsBackCourtyard|insideCourtyard|insideFrontCourtyard|insideBackCourtyard)\b/

/** Top-level nodes whose change reaches every item: nets, setup, layers. */
const GLOBAL_TOKENS = new Set(['net', 'setup', 'layers', 'general', 'net_class'])

/**
 * Told as each phase of a run starts, with the run's whole plan: `context`,
 * then each rule by name, a rule round an edit as `region:<name>`.
 */
export type CheckPhase = (phase: string, plan: readonly string[]) => void

/**
 * Check a board: the whole of it, or — given the last run and the edit since —
 * the region rules round the edit, and the board rules only when `settled`.
 */
export function* checkBoard(
  input: BoardCheckInput,
  since?: { run: BoardCheckRun; edit: BoardEdit },
  settled = true,
  phase?: CheckPhase
): Generator<void, BoardCheckRun> {
  // Courtyards carry over for every footprint the edit left alone.
  if (since) boardCourtyardsFrom(since.edit.fromBoard, input.board, since.edit.raws)
  const changed = since ? changedBoxes(since.run, input, since.edit) : null
  const phaseOf = (rule: { name: string; scope: RuleScope }, scope: RuleScope | null): string =>
    scope === 'region' ? `region:${rule.name}` : rule.name
  const scopes: Array<RuleScope | null> =
    !since || !changed ? [null] : settled ? ['region', 'board'] : ['region']
  const plan = [
    'context',
    ...scopes.flatMap((scope) =>
      BOARD_RULE_MODULES.filter((rule) => !scope || rule.scope === scope).map((rule) =>
        phaseOf(rule, scope)
      )
    )
  ]
  phase?.('context', plan)
  const ctx = yield* buildDrcContext(input)
  const runRules = function* (scope: RuleScope | null): Generator<void> {
    for (const rule of BOARD_RULE_MODULES) {
      if (scope && rule.scope !== scope) continue
      phase?.(phaseOf(rule, scope), plan)
      ctx.setRule(rule.name)
      const steps = rule.run(ctx)
      if (steps) yield* steps
    }
  }
  const finish = (findings: Finding[], stale: boolean): BoardCheckRun => ({
    input,
    findings,
    stale,
    before: snapshot(input.board)
  })

  if (!since || !changed) {
    yield* runRules(null)
    return finish(ctx.findings, false)
  }

  const reach = Math.max(ctx.maxClearance, ctx.holeClearance) + REACH_MARGIN
  const region = regionOf(changed, reach)
  ctx.setRegion(region)
  yield* runRules('region')
  const scopeOf = new Map(BOARD_RULE_MODULES.map((rule) => [rule.name, rule.scope]))
  const meets = (box: Box): boolean =>
    region.some(
      (r) => box.maxX >= r.minX && box.minX <= r.maxX && box.maxY >= r.minY && box.minY <= r.maxY
    )
  const kept = since.run.findings.filter(
    (finding) => scopeOf.get(finding.rule) === 'region' && !finding.boxes.some((box) => meets(box))
  )
  const regionFindings = [...ctx.findings]
  let boardFindings = since.run.findings.filter((finding) => scopeOf.get(finding.rule) === 'board')
  let stale = since.run.stale
  if (settled) {
    ctx.setRegion(null)
    yield* runRules('board')
    boardFindings = ctx.findings.slice(regionFindings.length)
    stale = false
  } else if (region.length > 0) stale = true
  return finish([...kept, ...regionFindings, ...boardFindings], stale)
}

/** What a run keeps of the board for the next edit to compare against (`BoardCheckRun.before`). */
function snapshot(board: KicadBoard): BoardCheckRun['before'] {
  const fills = new Map<SExprNode, KicadBoardZone['filledPolys']>()
  for (const zone of allZones(board)) fills.set(zone._raw, zone.filledPolys)
  const holes = new Map<SExprNode, Box[]>()
  for (const bfp of board.footprints) {
    const boxes: Box[] = []
    let tf: ReturnType<typeof footprintTransform> | null = null
    for (const pad of bfp.footprint.pads) {
      if (!pad.drill) continue
      tf ??= footprintTransform(bfp)
      const box = holeBox(padHoleShape(pad, tfPoint(tf, pad.position.x, pad.position.y)))
      if (box) boxes.push(box)
    }
    if (boxes.length) holes.set(bfp._raw, boxes)
  }
  return { fills, holes }
}

const holeBox = (hole: ReturnType<typeof padHoleShape>): Box | null =>
  hole?.kind === 'capsule'
    ? {
        minX: Math.min(hole.x0, hole.x1) - hole.halfWidth,
        minY: Math.min(hole.y0, hole.y1) - hole.halfWidth,
        maxX: Math.max(hole.x0, hole.x1) + hole.halfWidth,
        maxY: Math.max(hole.y0, hole.y1) + hole.halfWidth
      }
    : null

/**
 * The boxes an edit touched, old and new; null where no region bounds it and
 * the whole board runs.
 */
function changedBoxes(run: BoardCheckRun, after: BoardCheckInput, edit: BoardEdit): Box[] | null {
  const before = run.input
  if (
    edit.fromIndex !== before.index ||
    edit.fromBoard !== before.board ||
    before.settings !== after.settings ||
    (before.customRules ?? before.settings.customRules) !==
      (after.customRules ?? after.settings.customRules)
  )
    return null
  const raws = edit.raws
  for (const raw of raws) {
    const token = getToken(raw as SExprNode)
    if (token && GLOBAL_TOKENS.has(token)) return null
  }
  const customRules = after.customRules ?? after.settings.customRules ?? ''
  const areaRules = AREA_FUNCTIONS.test(customRules)
  const boxes: Box[] = []

  // Copper: every item whose node the edit touched, before and after.
  const touched = (board: KicadBoard, index: BoardSpatialIndex): void => {
    for (const item of index.items) if (raws.has(ownerRaw(board, item))) boxes.push(item)
  }
  touched(before.board, before.index)
  touched(after.board, after.index)

  // Footprints the edit touched: their drilled holes (a pad with no copper has
  // one too), before and after, and their courtyards. Where the rules read
  // areas, any footprint changed runs the whole board.
  for (const bfp of after.board.footprints) {
    if (!raws.has(bfp._raw)) continue
    if (areaRules) return null
    const tf = footprintTransform(bfp)
    for (const pad of bfp.footprint.pads) {
      const box = pad.drill
        ? holeBox(padHoleShape(pad, tfPoint(tf, pad.position.x, pad.position.y)))
        : null
      if (box) boxes.push(box)
    }
  }
  for (const [raw, holes] of run.before.holes) if (raws.has(raw)) boxes.push(...holes)
  const courtyards = (board: KicadBoard): void =>
    boardCourtyards(board).forEach((courtyard, fp) => {
      if (courtyard.box && raws.has(board.footprints[fp]._raw)) boxes.push(courtyard.box)
    })
  courtyards(before.board)
  courtyards(after.board)
  if (areaRules && before.board.footprints.some((bfp) => raws.has(bfp._raw))) return null

  // Copper drawings: those that differ, whatever changed them (a net propagated
  // from a pad the edit renamed reaches a graphic far from it).
  const variables = after.settings.textVariables
  const drawingKey = (d: ReturnType<typeof drawingItems>['items'][number]): string =>
    `${d.uuid ?? ''}|${d.drawing}|${d.layers.join(',')}|${d.net}|${d.fp ?? ''}|${d.minX},${d.minY},${d.maxX},${d.maxY}|${JSON.stringify(d.shape)}`
  const drawingsBefore = drawingItems(before.board, before.index, variables).items
  const drawingsAfter = drawingItems(after.board, after.index, variables).items
  const keysBefore = new Set(drawingsBefore.map(drawingKey))
  const keysAfter = new Set(drawingsAfter.map(drawingKey))
  for (const d of drawingsBefore) if (!keysAfter.has(drawingKey(d))) boxes.push(d)
  for (const d of drawingsAfter) if (!keysBefore.has(drawingKey(d))) boxes.push(d)

  // Zones: where a refill changed a fill, the difference of the two fills.
  // A zone's layers are its fills': a zone moved or reshaped changes those.
  const zonesAfter = new Set<SExprNode>(allZones(after.board).map((zone) => zone._raw))
  for (const zone of allZones(after.board)) {
    const old = run.before.fills.get(zone._raw)
    if (old === zone.filledPolys) continue
    if (areaRules || zone.isKeepout) return null
    boxes.push(...fillChange(fillRegions(old ?? [], zone), fillRegions(zone.filledPolys, zone)))
  }
  // A zone deleted: all of its fill. Its outline and layers are gone with it,
  // so its fills are read as they were, layer by layer.
  for (const [raw, fills] of run.before.fills) {
    if (zonesAfter.has(raw)) continue
    if (areaRules) return null
    boxes.push(
      ...fills.filter((p) => p.points.length >= 3).map((p) => ringBox(p.points.map(worldOf)))
    )
  }
  return boxes
}

/** The AST node an index item was read from: its track's or via's, a pad's footprint's. */
function ownerRaw(board: KicadBoard, item: CopperItem): unknown {
  const ref = item.ref
  switch (ref.type) {
    case 'segment':
      return board.segments[ref.index]?._raw
    case 'tarc':
      return board.trackArcs[ref.index]?._raw
    case 'via':
      return board.vias[ref.index]?._raw
    case 'pad':
      return board.footprints[ref.index]?._raw
    case 'drawing':
      return undefined
  }
}

/** A zone's copper fills by layer, as world regions. */
function fillRegions(
  polys: KicadBoardZone['filledPolys'],
  zone: KicadBoardZone
): Map<string, ClipRegion[]> {
  const out = new Map<string, ClipRegion[]>()
  for (const poly of polys) {
    const layer = poly.layer ?? zone.layers[0]
    if (!layer || !isCopperLayer(layer) || poly.points.length < 3) continue
    const list = out.get(layer) ?? []
    list.push({ outer: poly.points.map(worldOf), holes: [] })
    out.set(layer, list)
  }
  return out
}

/**
 * Where two fills differ: the boxes of their symmetric difference. Before the
 * geometry engine has loaded, the boxes of both fills whole.
 */
function fillChange(before: Map<string, ClipRegion[]>, after: Map<string, ClipRegion[]>): Box[] {
  const out: Box[] = []
  for (const layer of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(layer) ?? []
    const is = after.get(layer) ?? []
    const a = union(was, [])
    const b = union(is, [])
    for (const region of [...difference(a, b), ...difference(b, a)]) out.push(ringBox(region.outer))
  }
  return out
}

/** The changed boxes grown by the reach, merged where they meet, at most MAX_REGION_BOXES. */
function regionOf(changed: readonly Box[], reach: number): Box[] {
  let boxes = changed.map((b) => ({
    minX: b.minX - reach,
    minY: b.minY - reach,
    maxX: b.maxX + reach,
    maxY: b.maxY + reach
  }))
  // Merge boxes that meet until none do.
  let merged = true
  while (merged && boxes.length > 1) {
    merged = false
    const out: Box[] = []
    for (const box of boxes) {
      const hit = out.find(
        (o) => box.maxX >= o.minX && box.minX <= o.maxX && box.maxY >= o.minY && box.minY <= o.maxY
      )
      if (hit) {
        hit.minX = Math.min(hit.minX, box.minX)
        hit.minY = Math.min(hit.minY, box.minY)
        hit.maxX = Math.max(hit.maxX, box.maxX)
        hit.maxY = Math.max(hit.maxY, box.maxY)
        merged = true
      } else out.push({ ...box })
    }
    boxes = out
  }
  if (boxes.length <= MAX_REGION_BOXES) return boxes
  return [
    boxes.reduce((all, b) => ({
      minX: Math.min(all.minX, b.minX),
      minY: Math.min(all.minY, b.minY),
      maxX: Math.max(all.maxX, b.maxX),
      maxY: Math.max(all.maxY, b.maxY)
    }))
  ]
}
