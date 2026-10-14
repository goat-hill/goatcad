/**
 * What every board check reads, built once per run (`boardChecks.ts`): the
 * rule set, each copper item's subject and rules, the holes, the drawings,
 * the stored fills, the courtyards, and how findings are named and reported.
 * The checks themselves are the modules in `drc/rules/`.
 */
import type { KicadBoard, KicadBoardFootprint, KicadBoardZone } from '../../kicad/board'
import type { BoardDesignSettings } from '../../kicad/project'
import { allZones, getNetName, isTeardropZone } from '../../kicad/board'
import { parseFlag, type KicadPad } from '../../kicad/footprint'
import { findChild, getAtomValues } from '../../kicad/sexpr'
import { nmToMm, type Nm } from '../../kicad/coordinates'
import { isCopperLayer } from '../../kicad/layers'
import { footprintTransform, tfPoint } from '../../schematic/placement'
import type { CheckResult } from '../../schematic/checks'
import { padProperty } from '../../footprint/klc'
import {
  padCopperCenter,
  padHoleShape,
  shapeOn,
  segmentToShape,
  shapeCenter,
  shapeToShape,
  type BoardSpatialIndex,
  type CopperItem,
  type CopperShape,
  type Pt
} from '../spatialIndex'
import {
  CONNECT_EPSILON,
  viaFlashedOn,
  type BoardConnectivity,
  type ZoneIsland
} from '../boardConnectivity'
import { YStripes } from '../../geometry/yStripes'
import { boardLayerIndex, type BoardLayerIndex } from '../layerIndex'
import { drawingItems, type DrawingItem, type DrawingSet } from '../drawingItems'
import { boardItemIds, type BoardItemIds } from '../boardItems'
import { boardRules, type BoardRules } from '../rules/boardRules'
import type { RuleItem, RuleSeverity } from '../rules/constraints'
import { boxesTouch, pointInRegion, ringBox, type Box } from '../../geometry/polygon'
import type { BoardCheckInput } from '../boardChecks'
import type { BoardLibraries } from '../boardLibraries'
import type { SchematicNetlist } from '../schematicNetlist'
import {
  STEP,
  DRAWING_NAMES,
  SLICE_MS,
  at,
  worldOf,
  positional,
  type Subject,
  idsOf,
  type Copper,
  type Capsule,
  type Hole,
  capsuleBox,
  nearestPoint,
  npthWithoutRing,
  viaHole,
  capsuleCenter,
  unionBox,
  refKey,
  keyOf,
  type Finding,
  type Side,
  type FillRing,
  type Courtyard
} from './shared'

/** A limit two items must keep, who set it, and that rule's own severity if it sets one. */
export interface Required {
  value: number
  rule: string
  severity?: RuleSeverity
}

/** What the rules read, built once per run by `buildDrcContext`. */
export interface DrcContext {
  board: KicadBoard
  index: BoardSpatialIndex
  connectivity: BoardConnectivity | null
  settings: BoardDesignSettings
  /** The footprint libraries, when the caller loaded them. */
  libraries: BoardLibraries | null
  /** The schematic's netlist, when the caller read one (`BoardCheckInput.schematic`). */
  schematic: SchematicNetlist | null
  /** The findings so far, each with its rule and the boxes it involves. */
  findings: Finding[]
  /** The region a run is confined to, as boxes; null for the whole board. */
  readonly region: readonly Box[] | null
  /** Confine what follows to a region, or free it (`drc/incremental.ts`). */
  setRegion: (boxes: readonly Box[] | null) => void
  /** Whether a box meets the region; always, in a whole-board run. What a finding must involve. */
  near: (box: Box, reach?: number) => boolean
  /** Report a finding with the boxes of what it involves. */
  emit: (result: CheckResult, boxes: readonly Box[]) => void
  /** The index's items a rule starts from: all, or those within `reach` of the region (or of other boxes). */
  itemsFrom: (reach: number, boxes?: readonly Box[] | null) => CopperItem[]
  /** How far a pad's hole may sit off its copper (a drill offset). */
  holeSlack: () => number
  /** The holes a rule starts from: all, or those within `reach` of the region. */
  holesFrom: (reach: number) => Hole[]
  /** The drilled holes of pads whose boxes meet a box. */
  holesNear: (box: Box) => Hole[]
  /**
   * Whether a box, grown by `reach`, meets where a region run starts from: the
   * region and the whole of everything that meets it. Always, in a whole-board run.
   */
  reaches: (box: Box, reach: number) => boolean
  /** Name the rule whose findings follow. */
  setRule: (name: string) => void
  /** The board's copper layers, front to back. */
  copperLayers: string[]
  /** True every `every` steps of a loop: where a long rule yields. */
  tick: (every?: number) => boolean
  /** True once a few milliseconds have passed since the last: where a fill loop yields. */
  sliceDone: () => boolean
  netName: (net: number) => string
  footprintSubject: (bfp: KicadBoardFootprint) => Subject
  zoneSubject: (zone: KicadBoardZone) => Subject
  padSubject: (bfp: KicadBoardFootprint, pad: KicadPad, center: Pt) => Subject
  /**
   * A drawing's id as `items_get` takes it: a footprint's field as
   * `<reference>#<field>` (by its uuid, or by `field` when the caller knows
   * it), a footprint's other drawing by its uuid (which names its footprint
   * there), else by its footprint's id; a board drawing by its item id. Null
   * for a board drawing with no uuid.
   */
  drawingId: (uuid: string | undefined, fp: number | undefined, field?: string) => string | null
  /** Two subjects as a finding names them, in a fixed order whichever side found the pair. */
  pair: (a: Subject, b: Subject) => Pick<CheckResult, 'items' | 'targets' | 'subject' | 'kicadIds'>
  /** Report a finding about one thing. */
  one: (
    code: string,
    severity: 'error' | 'warning',
    message: string,
    subject: Subject,
    position: Pt,
    boxes?: readonly Box[],
    /** The deciding rule's own severity, where it sets one. */
    ruleSeverity?: RuleSeverity,
    /** What its row shows: the numbers, or a detail. */
    row?: Pick<CheckResult, 'measure' | 'detail'>
  ) => void
  ruleSet: BoardRules
  /** Each index item and drawing by id, with what the rules need to know of it. */
  copperOf: { get(id: number): Copper | undefined }
  /** Each item by its reference (`pad:<fp>:<pad>`, `segment:<i>`…). */
  readonly itemByRef: Map<string, CopperItem>
  /** Every hole on the board, in the index's order, then the copperless pads'. */
  readonly holes: Hole[]
  /** The largest clearance anything can ask for: how far a search reaches. */
  maxClearance: number
  drawingSet: DrawingSet
  layerIndex: BoardLayerIndex
  drawings: readonly DrawingItem[]
  /** The index's copper and the drawings beside it, by box. */
  copperNear: (minX: number, minY: number, maxX: number, maxY: number) => CopperItem[]
  itemOf: (id: number) => CopperItem
  sharesLayer: (a: readonly string[], b: readonly string[]) => boolean
  /** Whether two items' nets exempt them from each other. */
  netsExempt: (a: Copper | Hole, netA: number, b: Copper, netB: number) => boolean
  sideOf: (c: Copper) => Side
  /** The clearance two items must keep on a layer, and who set it. */
  requiredClearance: (a: Side, b: Side, layer: string | null) => Required
  /** The holes an item drills: a pad's or a via's one, else none. */
  holesOf: { get(id: number): Hole[] | undefined }
  /** An item's copper on one layer: a via or pad not flashed there is its hole. */
  copperOn: (item: CopperItem, layer: string) => { shape: CopperShape; box: Box } | null
  flashesByLayer: (item: CopperItem) => boolean
  layersOf: (item: CopperItem) => readonly string[]
  groupsOf: (fp: number) => Map<string, number>
  tiedPads: (a: Copper, b: Copper) => boolean
  tieNets: (d: DrawingItem, ungrouped: boolean) => Set<number>
  holeOwner: (hole: Hole) => RuleItem
  holeClearance: number
  requiredHoleClearance: (owner: RuleItem, other: RuleItem, layer: string | null) => Required
  /** The stored fills, one ring per island per layer. */
  fills: FillRing[]
  itemsNear: (box: Box, reach: number) => CopperItem[]
  /** Edge separation from copper to a fill island (0 when they meet), and the fill edge nearest it. */
  shapeToFill: (
    shape: CopperShape,
    box: Box,
    fill: FillRing,
    reach: number
  ) => { actual: number; edge: Capsule | null }
  markAt: (shape: CopperShape, edge: Capsule | null) => Pt
  /** Each zone island's connectivity, by `zoneIndex:polyIndex`. */
  islandOf: Map<string, ZoneIsland>
  subjectOfItem: (item: CopperItem | undefined) => Subject | null
  courtyards: Courtyard[]
  /** The drilled holes of pads. */
  readonly padHoles: Hole[]
  /** Pad pairs copper clearance flagged, which hole clearance then passes over. */
  flaggedPadPairs: Set<string>
  padPairKey: (i: number, j: number) => string
}

/**
 * A stored fill's ring in world space and its edge index, kept per fill: a
 * zone that an edit did not refill keeps the same fill objects, so the next
 * run reuses them, and the edge index is built only when a rule reads it.
 */
const fillShapes = new WeakMap<object, { ring: Pt[]; box: Box; stripes?: YStripes }>()
const fillShape = (poly: {
  points: ReadonlyArray<{ x: Nm; y: Nm }>
}): { ring: Pt[]; box: Box; stripes?: YStripes } => {
  let shape = fillShapes.get(poly)
  if (!shape) {
    const ring = poly.points.map(worldOf)
    fillShapes.set(poly, (shape = { ring, box: ringBox(ring) }))
  }
  return shape
}

/**
 * The pad or via a teardrop belongs to: the one whose centre it holds, as
 * KiCad's teardrop description names it. A track-to-track one is the wider
 * track's. Null when none of its net is there.
 */
export function teardropOwner(index: BoardSpatialIndex, zone: KicadBoardZone): CopperItem | null {
  const ring = zone.points.map(worldOf)
  const box = ringBox(ring)
  const net = zone.net ?? 0
  let owner: CopperItem | null = null
  let widest = -1
  for (const item of index.query(box.minX, box.minY, box.maxX, box.maxY)) {
    if (item.net !== net || !item.layers.some((l) => zone.layers.includes(l))) continue
    const shape = item.shape
    const at =
      item.ref.type === 'pad'
        ? (item.anchor ?? null)
        : shape.kind === 'circle'
          ? { x: shape.cx, y: shape.cy }
          : null
    if (at && pointInRegion(at, { outer: ring, holes: [] })) return item
    if (shape.kind === 'capsule' && shape.halfWidth > widest) {
      const ends = [
        { x: shape.x0, y: shape.y0 },
        { x: shape.x1, y: shape.y1 }
      ]
      if (ends.some((p) => pointInRegion(p, { outer: ring, holes: [] }))) {
        widest = shape.halfWidth
        owner = item
      }
    }
  }
  return owner
}

export function* buildDrcContext(input: BoardCheckInput): Generator<void, DrcContext> {
  const { board, index, connectivity, settings } = input
  /** Each finding with the rule that made it and the boxes it involves. */
  const findings: Finding[] = []
  let rule = ''
  let region: readonly Box[] | null = null
  /** Whether a box, grown by `reach`, meets the region; always, in a whole-board run. */
  const near = (box: Box, reach = 0): boolean =>
    !region ||
    region.some(
      (r) =>
        box.maxX + reach >= r.minX &&
        box.minX - reach <= r.maxX &&
        box.maxY + reach >= r.minY &&
        box.minY - reach <= r.maxY
    )
  /**
   * Report a finding, with the boxes of what it involves. A region run keeps
   * only findings that involve something in the region: the rest stand as
   * the last run left them.
   */
  const emit = (result: CheckResult, boxes: readonly Box[]): void => {
    if (region && !boxes.some((box) => near(box))) return
    findings.push({ result, rule, boxes })
  }
  const copperLayers = board.layers.filter((l) => isCopperLayer(l.name)).map((l) => l.name)
  let stepCount = 0
  /** True every `every` steps: when a long loop yields. */
  const tick = (every = STEP): boolean => ++stepCount % every === 0
  // The fill loops' items vary a thousandfold in cost (a stub beside a pour, a
  // track across a whole-board one), so they yield by the clock, not a count.
  let sliceStart = performance.now()
  const sliceDone = (): boolean => {
    const now = performance.now()
    if (now - sliceStart < SLICE_MS) return false
    sliceStart = now
    return true
  }

  const netName = (net: number): string => (net > 0 ? getNetName(board, net) : '')
  const netLabel = (net: number): string => (netName(net) ? ` ${netName(net)}` : '')
  // Every item is named as `items_get` takes it (`boardItems.ts`), so a
  // finding's ids are ones an agent can read back.
  let ids: BoardItemIds | null = null
  const itemIds = (): BoardItemIds => (ids ??= boardItemIds(board))
  const footprintSubject = (bfp: KicadBoardFootprint): Subject => {
    const reference = bfp.reference || positional('footprint', worldOf(bfp.position))
    return {
      item: itemIds().byObject.get(bfp) ?? reference,
      key: reference,
      name: reference,
      targets: bfp.uuid ? [bfp.uuid] : []
    }
  }
  /** `<reference>#<field>` when the board's field ids (`boardFields.ts`) resolve it: the
   *  reference names only this footprint, and the field is a property, or an old file's
   *  reference or value text with no uuid of its own. */
  const fieldId = (fp: number, uuid: string | undefined, field?: string): string | null => {
    const bfp = board.footprints[fp]
    const reference = bfp.reference
    if (!reference || itemIds().byObject.get(bfp) !== reference) return null
    const { properties, fpTexts } = bfp.footprint
    const key = field ?? (uuid ? properties.find((p) => p.uuid === uuid)?.key : undefined)
    if (!key) return null
    const oldText = fpTexts.some(
      (text) =>
        !text.uuid &&
        text.type !== 'user' &&
        (text.type === 'reference' ? 'Reference' : 'Value') === key
    )
    return oldText || properties.some((p) => p.key === key) ? `${reference}#${key}` : null
  }
  const drawingId = (
    uuid: string | undefined,
    fp: number | undefined,
    field?: string
  ): string | null =>
    fp !== undefined
      ? (fieldId(fp, uuid, field) ?? uuid ?? footprintSubject(board.footprints[fp]).item)
      : uuid
        ? (itemIds().byUuid.get(uuid) ?? uuid)
        : null
  const zoneSubject = (zone: KicadBoardZone): Subject => {
    const first = zone.points[0] ?? { x: 0 as Nm, y: 0 as Nm }
    const item =
      (zone.footprint === undefined
        ? itemIds().byObject.get(zone)
        : drawingId(zone.uuid, zone.footprint)) ??
      zone.uuid ??
      positional('zone', worldOf(first))
    const name = `zone${netLabel(zone.net ?? 0)}`
    if (zone.footprint === undefined) return { item, name, targets: zone.uuid ? [zone.uuid] : [] }
    // A footprint's zone is selected with its footprint.
    const owner = footprintSubject(board.footprints[zone.footprint])
    return {
      item,
      name: `${name} of ${owner.name}`,
      targets: owner.targets,
      ids: zone.uuid ? [zone.uuid] : []
    }
  }
  const padSubject = (bfp: KicadBoardFootprint, pad: KicadPad, center: Pt): Subject => {
    const owner = footprintSubject(bfp)
    const name = pad.number ? `${owner.name}.${pad.number}` : positional('pad', center)
    return {
      item: itemIds().byObject.get(pad) ?? name,
      key: name,
      name,
      targets: owner.targets,
      ids: pad.uuid ? [pad.uuid] : []
    }
  }
  /** Two subjects as a finding names them, in a fixed order whichever side found the pair. */
  const pair = (
    a: Subject,
    b: Subject
  ): Pick<CheckResult, 'items' | 'targets' | 'subject' | 'kicadIds'> => {
    const [first, second] = keyOf(a) <= keyOf(b) ? [a, b] : [b, a]
    return {
      items: [first.item, second.item],
      targets: [...new Set([...first.targets, ...second.targets])],
      kicadIds: [...new Set([...idsOf(first), ...idsOf(second)])],
      subject: `${first.name} · ${second.name}`
    }
  }
  const one = (
    code: string,
    severity: 'error' | 'warning',
    message: string,
    subject: Subject,
    position: Pt,
    boxes: readonly Box[] = [],
    ruleSeverity?: RuleSeverity,
    row?: Pick<CheckResult, 'measure' | 'detail'>
  ): void => {
    emit(
      {
        code,
        severity,
        message,
        items: [subject.item],
        targets: subject.targets,
        kicadIds: idsOf(subject),
        subject: subject.name,
        position: at(position),
        ...(ruleSeverity ? { ruleSeverity } : {}),
        ...row
      },
      boxes
    )
  }

  const ruleSet = boardRules(board, settings, input.customRules ?? settings.customRules)
  // The layers beyond copper: the edge and the courtyards, as the index holds them.
  const layerIndex = boardLayerIndex(board, ruleSet.textVariables, ruleSet)
  // Copper drawings (`drawingItems.ts`): graphics and text on copper, each one
  // item, by the ids after the index's.
  const drawingSet = drawingItems(board, index, ruleSet.textVariables)
  const drawings = drawingSet.items
  // How far to look: the rule set counts each pad's and footprint's own
  // clearance, and each zone's.
  let maxClearance = ruleSet.maxClearance

  // Each item's entry and holes are built the first time a rule asks for
  // them, so a check round a few items costs only those items.
  const copperEntries = new Map<number, Copper>()
  const holeEntries = new Map<number, Hole[]>()
  const describe = (item: CopperItem): void => {
    const ref = item.ref
    if (ref.type === 'drawing') {
      const d = drawingSet.byId(item.id)!
      const owner = d.fp !== undefined ? footprintSubject(board.footprints[d.fp]) : null
      const kind = DRAWING_NAMES[d.drawing]
      copperEntries.set(d.id, {
        ref: d,
        subject: {
          item: drawingId(d.uuid, d.fp) ?? positional(kind, shapeCenter(d.shape)),
          name: owner ? `${kind} of ${owner.name}` : `${kind}${d.netted ? netLabel(d.net) : ''}`,
          // A footprint's drawing selects its footprint, as a pad does.
          targets: owner ? owner.targets : d.uuid ? [d.uuid] : [],
          ...(owner && d.uuid ? { ids: [d.uuid] } : {})
        },
        footprint: d.fp ?? null,
        padNumber: null,
        copper: true,
        edgeTested: d.inCopperTree
      })
      holeEntries.set(item.id, [])
      return
    }
    if (ref.type === 'pad') {
      const bfp = board.footprints[ref.index]
      const pad = bfp.footprint.pads[ref.pad]
      const center = tfPoint(footprintTransform(bfp), pad.position.x, pad.position.y)
      const subject = padSubject(bfp, pad, padCopperCenter(pad, center, 0))
      const property = padProperty(pad._raw)
      copperEntries.set(item.id, {
        ref: item,
        subject,
        footprint: ref.index,
        padNumber: pad.number || null,
        copper: !npthWithoutRing(pad),
        edgeTested: property !== 'pad_prop_castellated' && pad.type !== 'connect'
      })
      const hole = padHoleShape(pad, center)
      holeEntries.set(
        item.id,
        hole && hole.kind === 'capsule'
          ? [
              {
                shape: hole,
                layers: copperLayers,
                net: item.net,
                subject,
                footprint: ref.index,
                plated: pad.type !== 'np_thru_hole',
                micro: false,
                item,
                pad,
                box: capsuleBox(hole),
                center
              }
            ]
          : []
      )
      return
    }
    const kind = ref.type === 'segment' ? 'track' : ref.type === 'tarc' ? 'arc' : 'via'
    const owner =
      ref.type === 'segment'
        ? board.segments[ref.index]
        : ref.type === 'tarc'
          ? board.trackArcs[ref.index]
          : board.vias[ref.index]
    const start = 'position' in owner ? owner.position : owner.start
    const subject: Subject = {
      item: itemIds().byObject.get(owner) ?? owner.uuid ?? positional(kind, worldOf(start)),
      name: `${kind}${netLabel(item.net)}`,
      targets: owner.uuid ? [owner.uuid] : []
    }
    copperEntries.set(item.id, {
      ref: item,
      subject,
      footprint: null,
      padNumber: null,
      copper: true,
      edgeTested: true
    })
    if (ref.type !== 'via') {
      holeEntries.set(item.id, [])
      return
    }
    const via = board.vias[ref.index]
    const hole = viaHole(via)
    holeEntries.set(item.id, [
      {
        shape: hole,
        layers: item.layers,
        net: item.net,
        subject,
        footprint: null,
        plated: true,
        micro: via.type === 'micro',
        item,
        pad: null,
        box: capsuleBox(hole),
        center: capsuleCenter(hole)
      }
    ])
  }
  const itemOf = (id: number): CopperItem => index.items[id] ?? drawingSet.byId(id)!
  /**
   * The index's items a rule starts from: all of them, or in a region run
   * those within `reach` of the region (or of other boxes), in the index's order.
   */
  const itemsFrom = (reach: number, boxes: readonly Box[] | null = region): CopperItem[] => {
    if (!boxes) return index.items
    const ids = new Set<number>()
    for (const r of boxes)
      for (const item of index.query(
        r.minX - reach,
        r.minY - reach,
        r.maxX + reach,
        r.maxY + reach
      ))
        ids.add(item.id)
    return [...ids].sort((a, b) => a - b).map((id) => index.items[id])
  }
  const copperOf = {
    get: (id: number): Copper | undefined => {
      if (!copperEntries.has(id)) describe(itemOf(id))
      return copperEntries.get(id)
    }
  }
  const holesOf = {
    get: (id: number): Hole[] | undefined => {
      if (!holeEntries.has(id)) describe(itemOf(id))
      return holeEntries.get(id)
    }
  }
  /** Holes of pads the index holds no copper for: a hole on no copper layer. */
  const copperlessHoles = (): Hole[] => {
    const out: Hole[] = []
    board.footprints.forEach((bfp, fpIndex) => {
      const tf = footprintTransform(bfp)
      for (const pad of bfp.footprint.pads) {
        if (
          !pad.drill ||
          pad.layers.some((l) => l === '*.Cu' || l === 'F&B.Cu' || isCopperLayer(l))
        )
          continue
        const center = tfPoint(tf, pad.position.x, pad.position.y)
        const hole = padHoleShape(pad, center)
        if (!hole || hole.kind !== 'capsule') continue
        out.push({
          shape: hole,
          layers: copperLayers,
          net: pad.net?.number ?? 0,
          subject: padSubject(bfp, pad, center),
          footprint: fpIndex,
          plated: pad.type !== 'np_thru_hole',
          micro: false,
          item: null,
          pad,
          box: capsuleBox(hole),
          center
        })
      }
    })
    return out
  }
  let copperless: Hole[] | null = null
  let allHoles: Hole[] | null = null
  const holesAll = (): Hole[] =>
    (allHoles ??= [
      ...index.items.flatMap((item) => holesOf.get(item.id) ?? []),
      ...(copperless ??= copperlessHoles())
    ])
  /** The holes of pads whose boxes meet a box: a pad's copper, or its hole off it. */
  const holesNear = (box: Box): Hole[] => {
    const slack = holeSlack()
    return [
      ...index
        .query(box.minX - slack, box.minY - slack, box.maxX + slack, box.maxY + slack)
        .flatMap((item) => holesOf.get(item.id) ?? []),
      ...(copperless ??= copperlessHoles())
    ].filter((hole) => hole.footprint !== null && boxesTouch(hole.box, box))
  }
  /** The holes a rule starts from: all, or those within `reach` of the region. */
  const holesFrom = (reach: number): Hole[] =>
    region
      ? [
          ...itemsFrom(reach + holeSlack(), reachRegion())
            .flatMap((item) => holesOf.get(item.id) ?? [])
            .filter((hole) => reaches(hole.box, reach)),
          ...(copperless ??= copperlessHoles()).filter((hole) => reaches(hole.box, reach))
        ]
      : holesAll()
  /**
   * Where a region run starts from: the region, and the whole of everything
   * that meets it — its copper, holes and drawings. A finding that involves
   * something meeting the region may pair it with what lies beyond its far
   * side, out of the region's own reach; within reach of this, it never is.
   */
  let expanded: { of: readonly Box[]; boxes: Box[] } | null = null
  let slack: number | null = null
  /** How far a pad's hole may sit off its copper (a drill offset): how much further to look. */
  const holeSlack = (): number => {
    if (slack === null) {
      slack = 0
      for (const bfp of board.footprints)
        for (const pad of bfp.footprint.pads) {
          const offset = pad.drill?.offset
          if (offset) slack = Math.max(slack, Math.hypot(nmToMm(offset.x), nmToMm(offset.y)))
        }
    }
    return slack
  }
  const reachRegion = (): readonly Box[] => {
    if (!region) return []
    if (expanded?.of === region) return expanded.boxes
    const boxes: Box[] = [...region]
    const slack = holeSlack()
    for (const r of region) {
      for (const item of index.query(
        r.minX - slack,
        r.minY - slack,
        r.maxX + slack,
        r.maxY + slack
      )) {
        const holes = holesOf.get(item.id) ?? []
        if (near(item) || holes.some((hole) => near(hole.box))) {
          boxes.push(item)
          for (const hole of holes) boxes.push(hole.box)
        }
      }
      for (const d of drawingSet.query(r.minX, r.minY, r.maxX, r.maxY)) boxes.push(d)
    }
    for (const hole of (copperless ??= copperlessHoles())) if (near(hole.box)) boxes.push(hole.box)
    expanded = { of: region, boxes }
    return boxes
  }
  /** Whether a box, grown by `reach`, meets where a region run starts from; always, in a whole-board run. */
  const reaches = (box: Box, reach: number): boolean =>
    !region ||
    reachRegion().some(
      (r) =>
        box.maxX + reach >= r.minX &&
        box.minX - reach <= r.maxX &&
        box.maxY + reach >= r.minY &&
        box.minY - reach <= r.maxY
    )
  let refs: Map<string, CopperItem> | null = null
  const itemByRefAll = (): Map<string, CopperItem> => {
    if (!refs) {
      refs = new Map()
      for (const item of index.items) refs.set(refKey(item.ref), item)
      for (const d of drawings) refs.set(refKey(d.ref), d)
    }
    return refs
  }
  /** The index's copper and the drawings beside it, by box. */
  const copperNear = (minX: number, minY: number, maxX: number, maxY: number): CopperItem[] => [
    ...index.query(minX, minY, maxX, maxY),
    ...drawingSet.query(minX, minY, maxX, maxY)
  ]

  const sharesLayer = (a: readonly string[], b: readonly string[]): boolean =>
    a.some((layer) => b.includes(layer))

  /**
   * Whether two items' nets exempt them from each other. KiCad's track pass
   * skips every same-net pair; its pad pass tests two unassigned pads
   * against each other, since neither belongs to anything.
   */
  const netsExempt = (a: Copper | Hole, netA: number, b: Copper, netB: number): boolean =>
    netA === netB && (netA !== 0 || a.footprint === null || b.footprint === null)

  /** One side of a clearance pair, as the rules see it. */
  const sideOf = (c: Copper): Side => ruleSet.copperItem(c.ref)

  /**
   * The clearance two items must keep on a layer, and who set it — the
   * resolver's answer (`rules/resolver.ts`), which the router and the filler
   * get too.
   */
  const requiredClearance = (a: Side, b: Side, layer: string | null): Required => {
    const resolved = ruleSet.resolver.evaluate('clearance', a, b, layer)
    return {
      value: resolved.value.min ?? 0,
      rule: resolved.name,
      ...(resolved.severity ? { severity: resolved.severity } : {})
    }
  }

  const viaFlashed = (item: CopperItem, layer: string): boolean =>
    viaFlashedOn(board, index, item, layer, layersOf)

  /**
   * An item's copper on one layer, as KiCad's `GetEffectiveShape(layer)`: a
   * via or plated pad not flashed there is only its hole (the index already
   * leaves such layers off a pad); null when it has nothing on the layer.
   */
  const copperOn = (item: CopperItem, layer: string): { shape: CopperShape; box: Box } | null => {
    const hole = holesOf.get(item.id)?.[0]
    const bare = hole ? { shape: hole.shape, box: hole.box } : null
    switch (item.ref.type) {
      case 'segment':
      case 'tarc':
        return item.layers.includes(layer) ? { shape: item.shape, box: item } : null
      case 'pad':
        if (item.layers.includes(layer)) return { shape: shapeOn(item, layer), box: item }
        return hole?.plated && hole.layers.includes(layer) ? bare : null
      case 'via':
        if (!item.layers.includes(layer)) return null
        return viaFlashed(item, layer) ? { shape: shapeOn(item, layer), box: item } : bare
      case 'drawing':
        return item.layers.includes(layer) ? { shape: item.shape, box: item } : null
    }
  }
  /**
   * Whether an item's copper differs by layer: a padstack, or a via or plated
   * pad that drops unused layers.
   */
  const flashesByLayer = (item: CopperItem): boolean => {
    if (item.shapes) return true
    if (item.ref.type === 'via') {
      const raw = board.vias[item.ref.index]._raw
      return parseFlag(raw, 'remove_unused_layers') || parseFlag(raw, 'start_end_only')
    }
    if (item.ref.type !== 'pad') return false
    const hole = holesOf.get(item.id)?.[0]
    return !!hole?.plated && hole.layers.length > item.layers.length
  }
  /** Every layer an item may have copper on: a plated pad's hole passes them all. */
  const layersOf = (item: CopperItem): readonly string[] => {
    const hole = item.ref.type === 'pad' ? holesOf.get(item.id)?.[0] : undefined
    return hole?.plated ? hole.layers : item.layers
  }

  /** A footprint's net-tie groups: each pad number to its group, from `(net_tie_pad_groups "1,2" …)`. */
  const netTieGroups = new Map<number, Map<string, number>>()
  const groupsOf = (fp: number): Map<string, number> => {
    let groups = netTieGroups.get(fp)
    if (!groups) {
      groups = new Map()
      const raw = board.footprints[fp].footprint._raw
      const node = raw.type === 'list' ? findChild(raw, 'net_tie_pad_groups') : null
      const tied = node ? getAtomValues(node) : []
      tied.forEach((group, index) => {
        for (const number of group.split(',')) groups!.set(number.trim(), index)
      })
      netTieGroups.set(fp, groups)
    }
    return groups
  }
  const tiedPads = (a: Copper, b: Copper): boolean => {
    if (a.padNumber === null || b.padNumber === null) return false
    const groups = groupsOf(a.footprint!)
    const ga = groups.get(a.padNumber)
    return ga !== undefined && ga === groups.get(b.padNumber)
  }
  /**
   * The nets a net-tie footprint's graphic joins on its layer: those of the
   * pads it meets, with their groups' (`FOOTPRINT::BuildNetTieCache`). Copper
   * of those nets may touch it. `ungrouped` counts a pad in no group too, as
   * the zone test does.
   */
  const tieNets = (d: DrawingItem, ungrouped: boolean): Set<number> => {
    const nets = new Set<number>()
    if (d.fp === undefined || d.drawing !== 'graphic') return nets
    const groups = groupsOf(d.fp)
    if (groups.size === 0) return nets
    const pads = board.footprints[d.fp].footprint.pads
    for (const item of index.query(d.minX, d.minY, d.maxX, d.maxY)) {
      if (item.ref.type !== 'pad' || item.ref.index !== d.fp) continue
      if (!item.layers.includes(d.layers[0])) continue
      const group = groups.get(pads[item.ref.pad].number)
      if (group === undefined && !ungrouped) continue
      if (shapeToShape(item.shape, d.shape) > CONNECT_EPSILON) continue
      if (item.net > 0) nets.add(item.net)
      if (group === undefined) continue
      for (const pad of pads)
        if (groups.get(pad.number) === group && pad.net?.number) nets.add(pad.net.number)
    }
    return nets
  }

  /** The item a hole belongs to, as the rules see it. */
  const holeOwner = (hole: Hole): RuleItem =>
    hole.item
      ? ruleSet.copperItem(hole.item)
      : ruleSet.padItem(
          hole.footprint!,
          board.footprints[hole.footprint!].footprint.pads.indexOf(hole.pad!)
        )
  const holeClearance = ruleSet.resolver.worst('hole_clearance')
  const requiredHoleClearance = (
    owner: RuleItem,
    other: RuleItem,
    layer: string | null
  ): Required => {
    const resolved = ruleSet.resolver.evaluate('hole_clearance', owner, other, layer)
    return {
      value: resolved.value.min ?? 0,
      rule: resolved.name,
      ...(resolved.severity ? { severity: resolved.severity } : {})
    }
  }
  // The stored fills as KiCad's copper-clearance, connectivity and
  // zone-connection providers read them: one ring per island per layer. A
  // zone's `connect_pads` clearance is maxed with the net classes, but a
  /**
   * A teardrop is its pad's or via's setting, not an item: a finding names it
   * on the pad or via it belongs to (`teardropOwner`) and selects that.
   */
  const teardropSubject = (zone: KicadBoardZone): Subject => {
    const item = teardropOwner(index, zone)
    const owner = item ? (copperOf.get(item.id)?.subject ?? null) : null
    return owner ? { ...owner, name: `teardrop on ${owner.name}` } : zoneSubject(zone)
  }

  // pad's or footprint's own clearance overrides both (`DRC_ENGINE::EvalRules`).
  const fills: FillRing[] = []
  const zones = allZones(board)
  for (let zoneIndex = 0; zoneIndex < zones.length; zoneIndex++) {
    const zone = zones[zoneIndex]
    // A teardrop is copper like any fill here: items and holes are measured
    // against it. The zone-only passes (islands, spokes, pours) pass it over.
    if (zone.isKeepout) continue
    const teardrop = isTeardropZone(zone)
    const subject = teardrop ? teardropSubject(zone) : zoneSubject(zone)
    const side = ruleSet.zoneItem(zone)
    if (side.localClearance) maxClearance = Math.max(maxClearance, side.localClearance.value)
    for (let polyIndex = 0; polyIndex < zone.filledPolys.length; polyIndex++) {
      if (sliceDone()) yield
      const poly = zone.filledPolys[polyIndex]
      const layer = poly.layer ?? zone.layers[0]
      if (!layer || !isCopperLayer(layer) || poly.points.length < 3) continue
      const shape = fillShape(poly)
      fills.push({
        zone,
        zoneIndex,
        polyIndex,
        layer,
        net: zone.net ?? 0,
        ring: shape.ring,
        get stripes() {
          return (shape.stripes ??= new YStripes(shape.ring))
        },
        box: shape.box,
        subject,
        side,
        teardrop
      })
    }
  }

  // Copper within a fill's box. A pour's box is often the whole board, where
  // the grid query walks every cell and dedupes every item; a flat scan of the
  // items is far cheaper there.
  const extent = index.items.reduce<Box>((box, item) => unionBox(box, item), {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity
  })
  const extentArea = Math.max(1e-9, (extent.maxX - extent.minX) * (extent.maxY - extent.minY))
  const itemsNear = (box: Box, reach: number): CopperItem[] => {
    const minX = box.minX - reach
    const minY = box.minY - reach
    const maxX = box.maxX + reach
    const maxY = box.maxY + reach
    if ((maxX - minX) * (maxY - minY) < extentArea / 4) return index.query(minX, minY, maxX, maxY)
    return index.items.filter(
      (i) => i.maxX >= minX && i.minX <= maxX && i.maxY >= minY && i.minY <= maxY
    )
  }

  /** Edge separation from copper to a fill island (0 when they meet), and the fill edge nearest it. */
  const shapeToFill = (
    shape: CopperShape,
    box: Box,
    fill: FillRing,
    reach: number
  ): { actual: number; edge: Capsule | null } => {
    const middles = shape.kind === 'compound' ? shape.parts.map(shapeCenter) : [shapeCenter(shape)]
    if (middles.some((p) => fill.stripes.contains(p))) return { actual: 0, edge: null }
    let actual = Infinity
    let edge: Capsule | null = null
    fill.stripes.someEdgeInYRange(box.minY - reach, box.maxY + reach, (a, b) => {
      if (Math.max(a.x, b.x) < box.minX - reach || Math.min(a.x, b.x) > box.maxX + reach)
        return false
      const d = segmentToShape(shape, a.x, a.y, b.x, b.y, 0)
      if (d < actual) {
        actual = d
        edge = { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth: 0 }
      }
      return actual === 0
    })
    return { actual, edge }
  }
  const markAt = (shape: CopperShape, edge: Capsule | null): Pt =>
    edge ? nearestPoint(shape, edge) : shapeCenter(shape)

  // Islands no pad reaches (`isolated_copper`, a warning), by the ratsnest's
  // clusters as KiCad's DRC reads them: an island's cluster, through tracks,
  // vias and other islands of its net, holds no pad. KiCad's connectivity
  // leaves a zone on no net out, and counts its first island on each layer.
  const islandOf = new Map<string, ZoneIsland>()
  for (const net of connectivity?.nets.values() ?? [])
    for (const island of net.islands)
      islandOf.set(`${island.zoneIndex}:${island.polyIndex}`, island)
  const subjectOfItem = (item: CopperItem | undefined): Subject | null =>
    item ? copperOf.get(item.id)!.subject : null
  // A side's courtyard is its closed shapes and chained strokes nested into
  // outlines and cutouts, as KiCad builds it (`FOOTPRINT::BuildCourtyardCaches`).
  const courtyards: Courtyard[] = layerIndex.courtyards.map((courtyard) => ({
    ...courtyard,
    subject: footprintSubject(board.footprints[courtyard.fp])
  }))
  // Two pads already found too close are not tested again for hole clearance:
  // KiCad reports one violation per pad pair (`testPadAgainstItem`).
  const flaggedPadPairs = new Set<string>()
  const padPairKey = (i: number, j: number): string => (i < j ? `${i}:${j}` : `${j}:${i}`)

  return {
    findings,
    get region() {
      return region
    },
    setRegion: (boxes: readonly Box[] | null): void => {
      region = boxes
    },
    near,
    emit,
    itemsFrom,
    holesFrom,
    holesNear,
    holeSlack,
    reaches,
    setRule: (name: string): void => {
      rule = name
    },
    copperLayers,
    sliceDone,
    netName,
    footprintSubject,
    zoneSubject,
    padSubject,
    drawingId,
    pair,
    one,
    ruleSet,
    copperOf,
    get itemByRef() {
      return itemByRefAll()
    },
    get holes() {
      return holesAll()
    },
    maxClearance,
    drawingSet,
    layerIndex,
    drawings,
    copperNear,
    itemOf,
    sharesLayer,
    netsExempt,
    sideOf,
    requiredClearance,
    holesOf,
    copperOn,
    flashesByLayer,
    layersOf,
    groupsOf,
    tiedPads,
    tieNets,
    holeOwner,
    holeClearance,
    requiredHoleClearance,
    fills,
    itemsNear,
    shapeToFill,
    markAt,
    islandOf,
    subjectOfItem,
    courtyards,
    get padHoles() {
      return holesAll().filter((hole) => hole.footprint !== null)
    },
    board,
    index,
    connectivity,
    settings,
    libraries: input.libraries ?? null,
    schematic: input.schematic ?? null,
    tick,
    flaggedPadPairs,
    padPairKey
  }
}
