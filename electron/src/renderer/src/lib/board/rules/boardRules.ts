/**
 * A board's rules, and its items as the rules see them: the resolver every
 * consumer asks (`resolver.ts`), built from the board's design settings, its
 * net classes — the composites its nets resolve to included — and, once read,
 * the project's `.kicad_dru` rules after them.
 */
import type { KicadBoard, KicadBoardFootprint, KicadBoardZone } from '../../kicad/board'
import { allZones, expandBoardText, getNetName, isTeardropZone } from '../../kicad/board'
import type { KicadPad } from '../../kicad/footprint'
import { findChild, getFirstAtomValue, type SExprNode } from '../../kicad/sexpr'
import { mmAtomToNm, nmToMm, type Nm } from '../../kicad/coordinates'
import { footprintTransform, tfPoint } from '../../schematic/placement'
import { isCopperLayer } from '../../kicad/layers'
import {
  effectiveClassName,
  netClassForNet,
  type BoardDesignSettings,
  type ComponentClassSettings,
  type NetClass
} from '../../kicad/project'
import type { CopperItem } from '../spatialIndex'
import type { DrawingItem } from '../drawingItems'
import type { Rule, RuleItem, ZoneConnectionStyle } from './constraints'
import { boardSetupRules, netClassRules, tuningProfileRules } from './implicitRules'
import { ConstraintResolver } from './resolver'
import { parseRules } from './dru'
import { wildcard } from './diffPairs'
import { compileCondition, type RuleEnvironment } from './expression'
import { boardCourtyards } from '../courtyards'
import { resolveLayers, ringEntersRegion, shapeEntersRegion } from '../keepouts'
import { pointInRegion, segmentsCrossProperly, type Box, type Region } from '../../geometry/polygon'
import type { CopperShape, Pt } from '../spatialIndex'
import { shapeOutlines } from '../shapeOutline'
import { boardIndex } from '../spatialIndex'
import { distanceToSegment } from '../../geometry/distance'
import { fromToPaths, itemKeyOf, type FromTo } from '../fromTo'

export interface BoardRules {
  resolver: ConstraintResolver
  /** What reading the project's `.kicad_dru` said: why it was set aside, what it names that is not read. */
  customRules: { errors: string[]; unsupported: string[]; count: number }
  /** A net's effective class. */
  netClassOf: (net: number) => NetClass
  /** An indexed copper item as the rules see it; one object per item, so callers may compare them. */
  copperItem: (item: CopperItem) => RuleItem
  zoneItem: (zone: KicadBoardZone) => RuleItem
  /** A track or through via not drawn yet, on `layers`: what a route asks its sizes for. */
  newItem: (kind: 'track' | 'via', net: number, layers: readonly string[]) => RuleItem
  /**
   * How a pad joins a zone of its net on a layer (`DRC_ENGINE::EvalZoneConnection`):
   * the style — pad, then footprint, then a rule, then the zone; "thermal for
   * through-hole" is thermal on a plated hole and solid elsewhere — with the
   * relief's gap and spoke width, and who set the style.
   */
  zoneConnection: (
    pad: RuleItem,
    zone: KicadBoardZone,
    layer: string
  ) => { style: 'solid' | 'thermal' | 'none'; gap: number; spokeWidth: number; source: string }
  /** A pad by footprint and pad index, whether or not the index holds copper for it. */
  padItem: (fpIndex: number, padIndex: number) => RuleItem
  /** A footprint as the rules see it: its reference, value, side and placement. */
  footprintItem: (fpIndex: number) => RuleItem
  /** What an item of a footprint (a graphic, a text) reads of that footprint. */
  ownerOf: (fpIndex: number) => Partial<RuleItem>
  /** A graphic's or text's own properties, by its uuid (`Start_X`, `Line_Width`, `Text`…). */
  drawingProperty: (uuid: string) => RuleItem['property']
  /**
   * The largest clearance anything on the board can ask for: the rules' worst,
   * every zone's own and every pad's or footprint's override. How far a
   * search for what is too close must reach.
   */
  maxClearance: number
  /**
   * What an answer for one copper item depends on beyond the item itself:
   * rules built from inputs that are each the same give the same answer for
   * copper an edit did not touch. A project with its own rules adds the
   * board, since a condition may read anything on it.
   */
  inputs: readonly unknown[]
  /** The board's `max_error`, mm: how far arcs' chords may stray. */
  maxError: number
  /** The project's text variables, for board text (`expandBoardText`). */
  textVariables: Readonly<Record<string, string>>
}

/** A footprint's own `(clearance …)`, mm; null when it sets none. */
export const footprintClearance = (bfp: KicadBoardFootprint): number | null => {
  const raw = bfp.footprint._raw
  const node = raw.type === 'list' ? findChild(raw, 'clearance') : null
  const value = node ? getFirstAtomValue(node) : undefined
  return value === undefined ? null : nmToMm(mmAtomToNm(value))
}

/**
 * The board's rules: its own, then the project's custom rules — `ruleText`,
 * the `.kicad_dru` file's contents, when it has one.
 */
export function boardRules(
  board: KicadBoard,
  settings: BoardDesignSettings,
  ruleText?: string
): BoardRules {
  const netNames = new Set(board.nets.map((net) => net.name).filter(Boolean))
  // The classes are read when a condition runs, by then defined below.
  const env = ruleEnvironment(board, netNames, (bfp) => componentClassesOf(bfp))
  // The project's and board's text variables are expanded first, as KiCad
  // expands them (a `${Class:…}` selector aside, which is the rules' own).
  const parsed = ruleText
    ? parseRules(
        expandBoardText(ruleText, board, undefined, settings.textVariables ?? {}),
        env,
        board.layers
      )
    : null
  const userRules = parsed?.rules ?? []
  const classOf = new Map<number, NetClass>()
  const netClassOf = (net: number): NetClass => {
    let cls = classOf.get(net)
    if (!cls) {
      cls = netClassForNet(
        net > 0 ? getNetName(board, net) : '',
        settings.classes,
        settings.patterns,
        settings.assignments
      )
      classOf.set(net, cls)
    }
    return cls
  }
  // Every composite some net resolves to gets its class rules too, after the named classes.
  const composites = new Map<string, NetClass>()
  for (const net of board.nets) {
    if (net.number <= 0) continue
    const cls = netClassOf(net.number)
    if (cls.constituents) composites.set(effectiveClassName(cls), cls)
  }
  const classes = [...settings.classes, ...composites.values()]
  const rules: Rule[] = [
    ...boardSetupRules(settings.rules),
    ...netClassRules(settings.rules, classes, netNames),
    ...tuningProfileRules(
      settings.rules,
      classes,
      settings.tuning,
      netNames,
      settings.severities?.tuning_profile_track_geometries ?? 'ignore'
    ),
    ...userRules
  ]
  const resolver = new ConstraintResolver(rules, {
    minClearance: settings.rules.minClearance,
    minHoleClearance: settings.rules.minCopperHoleClearance
  })

  const netFields = (net: number): Pick<RuleItem, 'net' | 'netName' | 'netClass'> => ({
    net,
    netName: net > 0 ? getNetName(board, net) : '',
    netClass: effectiveClassName(netClassOf(net))
  })

  /** A footprint's component classes: those its symbol gave it, each once, sorted as KiCad sorts them. */
  const classCache = new Map<KicadBoardFootprint, readonly string[]>()
  let assignments: Array<{ className: string; test: (item: RuleItem) => boolean }> | null = null
  const componentClassesOf = (bfp: KicadBoardFootprint): readonly string[] => {
    let classes = classCache.get(bfp)
    if (!classes) {
      const own = bfp.footprint.componentClasses ?? []
      classCache.set(bfp, own)
      // The assignments see the footprint with the classes its symbol gave it.
      const fpIndex = board.footprints.indexOf(bfp)
      assignments ??= classAssignments(board, settings.componentClasses, env)
      const base = footprintRuleItem(fpIndex, {
        footprint: bfp.reference,
        footprintLayer: bfp.layer,
        footprintLibId: bfp.libId,
        ...(bfp.footprint.sheetName !== undefined ? { sheetName: bfp.footprint.sheetName } : {}),
        componentClasses: own
      })
      const assigned = assignments.filter((a) => a.test(base)).map((a) => a.className)
      classes = [...new Set([...own, ...assigned])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      classCache.set(bfp, classes)
    }
    return classes
  }

  let drawingProps: Map<string, DrawingEntry> | null = null

  /** What an item reads of the footprint it belongs to (or is). */
  const ownerFields = (
    bfp: KicadBoardFootprint
  ): Pick<
    RuleItem,
    | 'footprint'
    | 'footprintLayer'
    | 'footprintLibId'
    | 'sheetName'
    | 'componentClasses'
    | 'ownerUuid'
    | 'ownerProperty'
  > => ({
    footprint: bfp.reference,
    footprintLayer: bfp.layer,
    footprintLibId: bfp.libId,
    ...(bfp.footprint.sheetName !== undefined ? { sheetName: bfp.footprint.sheetName } : {}),
    componentClasses: componentClassesOf(bfp),
    ...(bfp.uuid ? { ownerUuid: bfp.uuid } : {}),
    // What it lacks of its own, it reads of its footprint, as KiCad's properties do.
    ownerProperty: (name) => footprintItem(board.footprints.indexOf(bfp)).property?.(name)
  })

  const copperItems = new WeakMap<CopperItem, RuleItem>()
  const copperItem = (item: CopperItem): RuleItem => {
    const cached = copperItems.get(item)
    if (cached) return cached
    const ref = item.ref
    let ruleItem: RuleItem
    if (ref.type === 'pad') {
      const bfp = board.footprints[ref.index]
      const pad = bfp.footprint.pads[ref.pad]
      ruleItem = {
        kind: 'pad',
        label: `${bfp.reference || 'footprint'}.${pad.number}`,
        ...netFields(item.net),
        layers: item.layers,
        nonCopper: item.layers.length === 0,
        hasHole: !!pad.drill,
        clearanceOverride: clearanceOverrideOf(pad, bfp, board.version ?? 0),
        ...ownerFields(bfp),
        ...(pad.uuid ? { uuid: pad.uuid } : {}),
        zone: padZoneSettings(pad, bfp),
        geometry: { shape: item.shape },
        property: padProperty(pad, bfp)
      }
    } else if (ref.type === 'via') {
      const via = board.vias[ref.index]
      ruleItem = {
        kind: 'via',
        label: `via${item.net > 0 ? ` ${getNetName(board, item.net)}` : ''}`,
        ...netFields(item.net),
        layers: item.layers,
        nonCopper: false,
        hasHole: true,
        viaType: viaTypeOf(via.type, via.layers),
        ...(via.uuid ? { uuid: via.uuid } : {}),
        geometry: { shape: item.shape },
        property: (name) => {
          switch (name) {
            case 'diameter':
            case 'width':
              return nmToMm(via.size)
            case 'hole':
              return nmToMm(via.drill)
            case 'position x':
              return nmToMm(via.position.x)
            case 'position y':
              return nmToMm(via.position.y)
            case 'locked':
              return via.locked ? 1 : 0
          }
          return undefined
        }
      }
    } else if (ref.type === 'drawing') {
      // A copper drawing: a board graphic, text box or cell has its net; the rest none.
      const drawing = item as DrawingItem
      const bfp = drawing.fp !== undefined ? board.footprints[drawing.fp] : undefined
      ruleItem = {
        kind: drawing.drawing,
        label: drawing.drawing,
        ...(drawing.netted ? netFields(item.net) : {}),
        layers: item.layers,
        nonCopper: false,
        ...(bfp ? ownerFields(bfp) : {}),
        ...(drawing.uuid
          ? {
              uuid: drawing.uuid,
              property: (name: string) => {
                drawingProps ??= drawingEntries(board)
                const entry = drawingProps.get(drawing.uuid!)
                return entry && drawingPropertyOf(entry, name)
              }
            }
          : {}),
        geometry: { shape: item.shape }
      }
    } else {
      const track = ref.type === 'segment' ? board.segments[ref.index] : board.trackArcs[ref.index]
      ruleItem = {
        property: (name) =>
          name === 'width'
            ? nmToMm(track.width)
            : name === 'locked'
              ? track.locked
                ? 1
                : 0
              : undefined,
        kind: ref.type === 'segment' ? 'track' : 'arc',
        ...(track.uuid ? { uuid: track.uuid } : {}),
        geometry: { shape: item.shape },
        label: `track${item.net > 0 ? ` ${getNetName(board, item.net)}` : ''}`,
        ...netFields(item.net),
        layers: item.layers,
        nonCopper: false
      }
    }
    if (ref.type !== 'drawing') ruleItem.itemKey = itemKeyOf(ref)
    copperItems.set(item, ruleItem)
    return ruleItem
  }

  const newItem = (kind: 'track' | 'via', net: number, layers: readonly string[]): RuleItem => ({
    kind,
    label: `${kind}${net > 0 ? ` ${getNetName(board, net)}` : ''}`,
    ...netFields(net),
    layers,
    nonCopper: false,
    ...(kind === 'via' ? { hasHole: true, viaType: 'through' as const } : {})
  })

  const padItems = new Map<string, RuleItem>()
  const padItem = (fpIndex: number, padIndex: number): RuleItem => {
    const key = `${fpIndex}:${padIndex}`
    const cached = padItems.get(key)
    if (cached) return cached
    const bfp = board.footprints[fpIndex]
    const pad = bfp.footprint.pads[padIndex]
    const net = pad.net?.number ?? 0
    const ruleItem: RuleItem = {
      kind: 'pad',
      label: `${bfp.reference || 'footprint'}.${pad.number}`,
      ...netFields(net),
      layers: pad.layers,
      nonCopper: !pad.layers.some((layer) => layer === '*.Cu' || isCopperLayer(layer)),
      hasHole: !!pad.drill,
      clearanceOverride: clearanceOverrideOf(pad, bfp, board.version ?? 0),
      ...ownerFields(bfp),
      ...(pad.uuid ? { uuid: pad.uuid } : {}),
      itemKey: `pad:${fpIndex}:${padIndex}`,
      zone: padZoneSettings(pad, bfp),
      property: padProperty(pad, bfp)
    }
    padItems.set(key, ruleItem)
    return ruleItem
  }

  const footprintItems = new Map<number, RuleItem>()
  const footprintItem = (fpIndex: number): RuleItem => {
    const cached = footprintItems.get(fpIndex)
    if (cached) return cached
    const ruleItem = footprintRuleItem(fpIndex, ownerFields(board.footprints[fpIndex]))
    footprintItems.set(fpIndex, ruleItem)
    return ruleItem
  }
  /** A footprint as the rules see it, with what it reads of itself as owner. */
  function footprintRuleItem(fpIndex: number, owner: Partial<RuleItem>): RuleItem {
    const bfp = board.footprints[fpIndex]
    const attribute = (name: string): number => (bfp.footprint.attributes.includes(name) ? 1 : 0)
    return {
      kind: 'footprint',
      label: bfp.reference || 'footprint',
      layers: [bfp.layer],
      nonCopper: true,
      itemKey: `footprint:${fpIndex}`,
      ...owner,
      ...(bfp.uuid ? { uuid: bfp.uuid } : {}),
      fields: new Map(bfp.footprint.properties.map((field) => [field.key, field.value])),
      property: (name) => {
        switch (name) {
          case 'reference':
            return bfp.reference ?? ''
          case 'value':
            return bfp.value ?? ''
          case 'orientation':
            return bfp.position.angle ?? 0
          case 'position x':
            return nmToMm(bfp.position.x)
          case 'position y':
            return nmToMm(bfp.position.y)
          case 'locked':
            return bfp.footprint.locked ? 1 : 0
          case 'library link':
            return bfp.libId
          case 'library description':
            return bfp.footprint.description ?? ''
          case 'keywords':
            return bfp.footprint.tags ?? ''
          case 'not in schematic':
            return attribute('board_only')
          case 'exclude from bill of materials':
            return attribute('exclude_from_bom')
          case 'exclude from position files':
            return attribute('exclude_from_pos_files')
          case 'do not populate':
            return attribute('dnp')
          case 'exempt from courtyard requirement':
            return attribute('allow_missing_courtyard')
          case 'clearance override':
            return bfp.footprint.clearance !== undefined ? nmToMm(bfp.footprint.clearance) : null
          case 'soldermask margin override':
            return bfp.footprint.solderMaskMargin !== undefined
              ? nmToMm(bfp.footprint.solderMaskMargin)
              : null
          case 'solderpaste margin override':
            return bfp.footprint.solderPasteMargin !== undefined
              ? nmToMm(bfp.footprint.solderPasteMargin)
              : null
          case 'solderpaste margin ratio override':
            return bfp.footprint.solderPasteMarginRatio ?? null
        }
        return undefined
      }
    }
  }

  const zoneItems = new WeakMap<KicadBoardZone, RuleItem>()
  const zoneItem = (zone: KicadBoardZone): RuleItem => {
    const cached = zoneItems.get(zone)
    if (cached) return cached
    const net = zone.net ?? 0
    const label = `zone${net > 0 ? ` ${getNetName(board, net)}` : ''}`
    const ruleItem: RuleItem = {
      kind: 'zone',
      label,
      ...netFields(net),
      layers: zone.layers,
      nonCopper: zone.isKeepout || !zone.layers.some(isCopperLayer),
      zoneId: zone.uuid,
      ...(zone.uuid ? { uuid: zone.uuid } : {}),
      ...(board.zones.includes(zone) ? { itemKey: `zone:${board.zones.indexOf(zone)}` } : {}),
      ...(zone.footprint !== undefined ? ownerFields(board.footprints[zone.footprint]) : {}),
      teardrop: isTeardropZone(zone),
      zoneSettings: {
        connection: ZONE_STYLE_OF_ZONE[zone.padConnection ?? 'thermal'],
        thermalGap: zone.thermalGap !== undefined ? nmToMm(zone.thermalGap) : 0.5,
        spokeWidth: zone.thermalBridgeWidth !== undefined ? nmToMm(zone.thermalBridgeWidth) : 0.5,
        minThickness: zone.minThickness !== undefined ? nmToMm(zone.minThickness) : 0.25
      },
      geometry: {
        ring: zone.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) })),
        fills: zone.filledPolys.map((fill) => ({
          layer: fill.layer ?? zone.layers[0],
          ring: fill.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) }))
        }))
      },
      property: (name) => {
        const keepout = zone.keepoutRules
        switch (name) {
          case 'name':
            return zone.name ?? ''
          case 'priority':
            return zone.priority ?? 0
          case 'minimum width':
            return zone.minThickness !== undefined ? nmToMm(zone.minThickness) : 0.25
          case 'keep out tracks':
            return keepout?.tracks ? 1 : 0
          case 'keep out vias':
            return keepout?.vias ? 1 : 0
          case 'keep out pads':
            return keepout?.pads ? 1 : 0
          case 'keep out zone fills':
          case 'keep out copper pours':
            return keepout?.copperpour ? 1 : 0
          case 'keep out footprints':
            return keepout?.footprints ? 1 : 0
        }
        return undefined
      },
      localClearance:
        zone.padClearance !== undefined && !zone.isKeepout
          ? { value: nmToMm(zone.padClearance), source: `${label} clearance` }
          : undefined
    }
    zoneItems.set(zone, ruleItem)
    return ruleItem
  }

  let maxClearance = resolver.worst('clearance')
  for (const zone of allZones(board)) {
    if (zone.padClearance !== undefined && !zone.isKeepout)
      maxClearance = Math.max(maxClearance, nmToMm(zone.padClearance))
  }
  for (const bfp of board.footprints) {
    maxClearance = Math.max(maxClearance, footprintClearance(bfp) ?? 0)
    for (const pad of bfp.footprint.pads)
      if (pad.clearance !== undefined) maxClearance = Math.max(maxClearance, nmToMm(pad.clearance))
  }

  const zoneConnection: BoardRules['zoneConnection'] = (pad, zone, layer) => {
    const zoneRule = zoneItem(zone)
    const resolved = resolver.evaluate('zone_connection', pad, zoneRule, layer)
    const raw = resolved.value.zoneConnection ?? 'thermal_reliefs'
    const style =
      raw === 'thru_hole_only'
        ? pad.zone?.plated
          ? 'thermal'
          : 'solid'
        : raw === 'thermal_reliefs'
          ? 'thermal'
          : raw
    const gap = resolver.evaluate('thermal_relief_gap', pad, zoneRule, layer).value.min ?? 0.5
    const spoke = resolver.evaluate('thermal_spoke_width', pad, zoneRule, layer).value
    return { style, gap, spokeWidth: spoke.opt ?? spoke.min ?? 0.5, source: resolved.name }
  }

  return {
    resolver,
    zoneConnection,
    customRules: {
      errors: parsed?.errors ?? [],
      unsupported: parsed?.unsupported ?? [],
      count: userRules.length
    },
    netClassOf,
    copperItem,
    newItem,
    zoneItem,
    padItem,
    footprintItem,
    ownerOf: (fpIndex) => ownerFields(board.footprints[fpIndex]),
    drawingProperty: (uuid) => {
      drawingProps ??= drawingEntries(board)
      const entry = drawingProps.get(uuid)
      return entry && ((name: string) => drawingPropertyOf(entry, name))
    },
    maxClearance,
    inputs: [
      settings.rules,
      settings.classes,
      settings.patterns,
      settings.assignments,
      ruleText ?? '',
      board.nets.map((net) => `${net.number}:${net.name}`).join('\n'),
      userRules.length > 0 ? board : null
    ],
    maxError: settings.rules.maxError,
    textVariables: settings.textVariables ?? {}
  }
}

/**
 * A pad's own clearance, else its footprint's, as the rules' pre-emption reads
 * it; a zero is no override. The source names the item, as a finding says it.
 */
function clearanceOverrideOf(
  pad: KicadPad,
  bfp: KicadBoardFootprint,
  version: number
): RuleItem['clearanceOverride'] {
  if (pad.clearance !== undefined && pad.clearance !== 0) {
    return {
      value: nmToMm(pad.clearance),
      source: `${bfp.reference || 'footprint'}.${pad.number} clearance`
    }
  }
  // A file from before KiCad wrote an unset clearance as absent reads a 0 as
  // unset, so the footprint's applies; a newer file's 0 is the pad's own, and
  // masks the footprint's (KiCad's parser, at format 20240201).
  if (pad.clearance === 0 && version > ZERO_CLEARANCE_IS_UNSET) return undefined
  const own = footprintClearance(bfp)
  return own ? { value: own, source: `${bfp.reference || 'footprint'} clearance` } : undefined
}

/** The last board format whose `(clearance 0)` means unset. */
const ZERO_CLEARANCE_IS_UNSET = 20240201

/**
 * KiCad's via types: a `blind` via touching an outer layer is blind, else
 * buried — KiCad 9 wrote both as `blind`, KiCad 10 writes `buried` apart.
 */
function viaTypeOf(type: string | undefined, layers: readonly string[]): RuleItem['viaType'] {
  if (type === 'micro') return 'micro'
  if (type !== 'blind' && type !== 'buried') return 'through'
  const outer = layers.some((layer) => layer === 'F.Cu' || layer === 'B.Cu')
  return outer ? 'blind' : 'buried'
}

/** KiCad's display names for a pad's type and shape, as `A.Pad_Type` and `A.Pad_Shape` read. */
const PAD_TYPES: Record<string, string> = {
  thru_hole: 'Through-hole',
  smd: 'SMD',
  connect: 'Edge connector',
  np_thru_hole: 'NPTH, mechanical'
}
const PAD_SHAPES: Record<string, string> = {
  circle: 'Circle',
  rect: 'Rectangle',
  oval: 'Oval',
  trapezoid: 'Trapezoid',
  roundrect: 'Rounded rectangle',
  custom: 'Custom'
}

/** A pad's properties by KiCad's name; a footprint's (reference, value) through its pad. */
function padProperty(pad: KicadPad, bfp: KicadBoardFootprint): RuleItem['property'] {
  return (name) => {
    switch (name) {
      case 'reference':
        return bfp.reference ?? ''
      case 'value':
        return bfp.value ?? ''
      case 'pad type':
        return PAD_TYPES[pad.type] ?? pad.type
      case 'pad shape':
        return pad.chamferRatio ? 'Chamfered rectangle' : (PAD_SHAPES[pad.shape] ?? pad.shape)
      case 'pad number':
        return pad.number
      case 'pin type':
        return pad.pinType ?? ''
      case 'orientation':
        return pad.position.angle ?? 0
      case 'size x':
        return nmToMm(pad.size.w)
      case 'size y':
        return nmToMm(pad.size.h)
      case 'hole size x':
        return pad.drill ? nmToMm(pad.drill.oval?.width ?? pad.drill.diameter) : 0
      case 'hole size y':
        return pad.drill ? nmToMm(pad.drill.oval?.height ?? pad.drill.diameter) : 0
      case 'clearance override':
        return pad.clearance !== undefined ? nmToMm(pad.clearance) : null
      case 'corner radius ratio':
        return pad.roundrectRatio ?? 0
      case 'thermal relief gap': {
        const gap = rawChild(pad._raw, 'thermal_gap')
        return gap !== undefined ? nmToMm(mmAtomToNm(gap)) : null
      }
      case 'thermal relief spoke width': {
        const width =
          rawChild(pad._raw, 'thermal_bridge_width') ?? rawChild(pad._raw, 'thermal_width')
        return width !== undefined ? nmToMm(mmAtomToNm(width)) : null
      }
      case 'thermal relief spoke angle': {
        const angle = rawChild(pad._raw, 'thermal_bridge_angle')
        return angle !== undefined ? Number(angle) : null
      }
    }
    return undefined
  }
}

/** KiCad's DRC epsilon, mm: an area is shrunk by it, so merely touching the border is not inside. */
const AREA_EPSILON = 0.0005

const looksLikeUuid = (text: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)

/**
 * What the custom rules' conditions ask of the board beyond two items: which
 * layers a pattern names, and the geometric functions — an item against the
 * zones and rule areas (`intersectsArea`, `enclosedByArea`) and against
 * footprints' courtyards (`intersectsCourtyard`).
 */
/**
 * Whether a footprint selector names a footprint, as KiCad's
 * `testFootprintSelector` reads one: `${Class:X}` a component class it has;
 * otherwise its reference, or with a `:` in it its library id, as a
 * case-sensitive wildcard.
 */
function selectsFootprint(
  selector: string,
  reference: string,
  libId: string,
  classes: readonly string[]
): boolean {
  if (selector === '') return false
  if (selector.startsWith('$') && selector.endsWith('}') && /^\$\{CLASS:/i.test(selector))
    return classes.includes(selector.slice(8, -1))
  return wildcard(selector, reference) || (selector.includes(':') && wildcard(selector, libId))
}

function ruleEnvironment(
  board: KicadBoard,
  netNames: ReadonlySet<string>,
  classesOf: (bfp: KicadBoardFootprint) => readonly string[]
): RuleEnvironment {
  const layerCache = new Map<string, Set<string>>()
  const layersMatching = (pattern: string): Set<string> => {
    let set = layerCache.get(pattern)
    if (!set) {
      set = new Set(
        board.layers
          .filter(
            (l) => wildcard(pattern, l.name) || (!!l.userName && wildcard(pattern, l.userName))
          )
          .map((l) => l.name)
      )
      layerCache.set(pattern, set)
    }
    return set
  }

  // Every zone and rule area, board and footprint, with its region.
  let areas: Array<{ uuid?: string; name?: string; layers: string[]; region: Region }> | null = null
  const allAreas = (): NonNullable<typeof areas> => {
    if (areas) return areas
    const zones = [...board.zones, ...board.footprints.flatMap((bfp) => bfp.footprint.zones)]
    areas = zones
      .filter((zone) => zone.points.length >= 3)
      .map((zone) => ({
        uuid: zone.uuid,
        name: 'name' in zone ? zone.name : undefined,
        layers: resolveLayers(zone.layers, board),
        region: {
          outer: zone.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) })),
          holes: (zone.holes ?? []).map((hole) =>
            hole.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) }))
          )
        }
      }))
    return areas
  }
  const areasFor = (selector: string): NonNullable<typeof areas> =>
    allAreas().filter((area) =>
      looksLikeUuid(selector)
        ? area.uuid === selector
        : !!area.name && wildcard(selector, area.name)
    )
  const onLayers = (
    item: RuleItem,
    areaLayers: readonly string[],
    layer: string | null
  ): boolean =>
    layer !== null
      ? areaLayers.includes(layer) && item.layers.includes(layer)
      : item.layers.some((l) => areaLayers.includes(l))

  let courtyards: ReturnType<typeof boardCourtyards> | null = null
  let groups: ReturnType<typeof boardGroups> | null = null
  let paths: FromTo | null = null

  /**
   * A footprint meets an area by its courtyard's outline, as KiCad's
   * `collidesWithArea` reads one: the front courtyard where the area is on a
   * front layer, the back where on a back one.
   */
  const footprintInArea = (item: RuleItem, selector: string): boolean => {
    const fp = Number(item.itemKey?.slice('footprint:'.length))
    const bfp = board.footprints[fp]
    if (!bfp) return false
    courtyards ??= boardCourtyards(board)
    const courtyard = courtyards.find((c) => c.fp === fp)
    if (!courtyard) return false
    // Ours are the footprint's own sides: its front is B.CrtYd once it is flipped.
    const flipped = bfp.layer === 'B.Cu'
    const front = (flipped ? courtyard.back : courtyard.front)[0]?.outer
    const back = (flipped ? courtyard.front : courtyard.back)[0]?.outer
    return areasFor(selector).some(
      (area) =>
        (!!front &&
          area.layers.some((l) => l.startsWith('F.')) &&
          ringEntersRegion(front, area.region)) ||
        (!!back &&
          area.layers.some((l) => l.startsWith('B.')) &&
          ringEntersRegion(back, area.region))
    )
  }

  /**
   * A zone meets an area by its fill on the layer asked, as KiCad's
   * `collidesWithArea` reads a copper zone; a rule area never does.
   */
  const zoneEnters = (item: RuleItem, region: Region, layers: readonly string[]): boolean =>
    !item.nonCopper &&
    (item.geometry?.fills ?? []).some(
      ({ layer, ring }) => layers.includes(layer) && ringReachesInto(ring, region)
    )

  const enters = (item: RuleItem, region: Region, tolerance: number): boolean => {
    const shape = item.geometry?.shape
    if (shape) return shapeEntersRegion(shape, region, tolerance)
    const ring = item.geometry?.ring
    return ring ? ringEntersRegion(ring, region) : false
  }

  return {
    layersMatching,
    netNames,
    intersectsArea: (item, selector, context) =>
      item.kind === 'footprint'
        ? footprintInArea(item, selector)
        : !item.unfilled &&
          areasFor(selector).some(
            (area) =>
              area.uuid !== item.zoneId &&
              onLayers(item, area.layers, context.layer) &&
              (item.kind === 'zone'
                ? zoneEnters(
                    item,
                    area.region,
                    context.layer !== null ? [context.layer] : area.layers
                  )
                : enters(item, area.region, AREA_EPSILON))
          ),
    enclosedByArea: (item, selector, context) =>
      !item.unfilled &&
      areasFor(selector).some((area) => {
        if (area.uuid === item.zoneId || !onLayers(item, area.layers, context.layer)) return false
        const points = item.geometry?.shape
          ? shapeOutlines(item.geometry.shape as CopperShape, 0).flat()
          : (item.geometry?.ring ?? [])
        return points.length > 0 && points.every((p) => pointInRegion(p, area.region))
      }),
    intersectsCourtyard: (item, selector, side) => {
      courtyards ??= boardCourtyards(board)
      return courtyards.some((courtyard) => {
        const bfp = board.footprints[courtyard.fp]
        if (!selectsFootprint(selector, bfp.reference ?? '', bfp.libId, classesOf(bfp)))
          return false
        // A footprint's front is its own primary side: B.CrtYd once it is flipped.
        const flipped = bfp.layer === 'B.Cu'
        const regions =
          side === 'any'
            ? [...courtyard.front, ...courtyard.back]
            : (side === 'front') !== flipped
              ? courtyard.front
              : courtyard.back
        // Touching counts, as KiCad's collision does.
        return regions.some((region) => enters(item, region, -1e-9))
      })
    },
    // Its footprint's: a footprint itself belongs to none.
    memberOfFootprint: (item, selector) =>
      item.kind !== 'footprint' &&
      item.footprint !== undefined &&
      selectsFootprint(
        selector,
        item.footprint,
        item.footprintLibId ?? '',
        item.componentClasses ?? []
      ),
    fromTo: (item, from, to) => {
      if (item.itemKey === undefined) return false
      paths ??= fromToPaths(board, boardIndex(board))
      return paths.onPath(item.itemKey, item.net ?? 0, from, to)
    },
    memberOfGroup: (item, name) => {
      groups ??= boardGroups(board)
      // Its own group, else (a pad, a footprint's graphic) its footprint's.
      let group =
        (item.uuid !== undefined ? groups.groupOf.get(item.uuid) : undefined) ??
        (item.kind !== 'footprint' && item.ownerUuid !== undefined
          ? groups.groupOf.get(item.ownerUuid)
          : undefined)
      const seen = new Set<string>()
      while (group && !seen.has(group.uuid)) {
        if (wildcard(name, group.name)) return true
        seen.add(group.uuid)
        group = groups.groupOf.get(group.uuid)
      }
      return false
    }
  }
}

/**
 * The project's component class assignments as conditions over a footprint,
 * written in the rules' own language as KiCad writes them
 * (`COMPONENT_CLASS_ASSIGNMENT_DATA::GetAssignmentInDRCLanguage`), and the
 * per-sheet classes when the project turns them on. An assignment with no
 * condition applies to every footprint; one whose condition does not compile
 * applies to none.
 */
function classAssignments(
  board: KicadBoard,
  settings: ComponentClassSettings | undefined,
  env: RuleEnvironment
): Array<{ className: string; test: (item: RuleItem) => boolean }> {
  if (!settings) return []
  const expressionOf = (type: string, primary: string, secondary: string): string => {
    switch (type) {
      case 'REFERENCE': {
        const refs = primary.trim()
        if (refs === '') return ''
        return `( ${refs
          .split(',')
          .map((ref) => `A.Reference == '${ref}'`)
          .join(' || ')} )`
      }
      case 'FOOTPRINT':
        return primary.trim() ? `( A.Library_Link == '${primary.trim()}' )` : ''
      case 'SIDE':
        return primary === 'Any' ? '' : `( A.Layer == '${primary === 'Front' ? 'F.Cu' : 'B.Cu'}' )`
      case 'ROTATION': {
        const rotation = primary.trim()
        return /^[-+]?\d+$/.test(rotation) ? `( A.Orientation == ${rotation} deg )` : ''
      }
      case 'FOOTPRINT_FIELD':
        return primary.trim() && secondary.trim()
          ? `( A.getField('${primary.trim()}') == '${secondary.trim()}' )`
          : ''
      case 'CUSTOM':
        return primary.trim() ? `( ${primary.trim()} )` : ''
      case 'SHEET_NAME':
        return primary.trim() ? `( A.memberOfSheet('${primary.trim()}') )` : ''
    }
    return ''
  }
  const compile = (
    className: string,
    expression: string
  ): { className: string; test: (item: RuleItem) => boolean } => {
    if (expression === '') return { className, test: () => true }
    try {
      const { test } = compileCondition(expression, env)
      return {
        className,
        test: (item: RuleItem) => test({ a: item, b: null, layer: null, type: 'assertion' })
      }
    } catch {
      return { className, test: () => false }
    }
  }
  const out = settings.assignments.map((assignment) =>
    compile(
      assignment.className,
      assignment.conditions
        .map((c) => expressionOf(c.type, c.primary, c.secondary))
        .filter((e) => e !== '')
        .join(assignment.all ? ' && ' : ' || ')
    )
  )
  if (settings.sheetClasses) {
    const sheets = new Set(board.footprints.map((bfp) => bfp.footprint.sheetName ?? ''))
    for (const sheet of sheets) {
      if (sheet === '' || sheet === '/') continue
      const name = sheet.replace(/["']/g, '')
      out.push(compile(name, `( A.memberOfSheet('${name}') )`))
    }
  }
  return out
}

/** A graphic or text the custom rules can read properties of, as it is in the board. */
type DrawingEntry =
  | {
      kind: 'shape'
      item: { strokeWidth?: Nm }
      start?: { x: Nm; y: Nm }
      end?: { x: Nm; y: Nm }
      /** Its footprint, whose placement puts its points on the board. */
      bfp?: KicadBoardFootprint
    }
  | {
      kind: 'text'
      item: {
        text?: string
        value?: string
        hide?: boolean
        knockout?: boolean
        fontEffects?: { thickness: Nm; bold?: boolean; italic?: boolean }
      }
    }

/**
 * Each graphic's and text's entry by its uuid. Only references: a board's
 * footprints hold hundreds of thousands of graphics, and the properties are
 * read for the few a rule asks about (`drawingProperty`).
 */
function drawingEntries(board: KicadBoard): Map<string, DrawingEntry> {
  const out = new Map<string, DrawingEntry>()
  const shape = (
    item: { uuid?: string; strokeWidth?: Nm },
    start?: { x: Nm; y: Nm },
    end?: { x: Nm; y: Nm },
    bfp?: KicadBoardFootprint
  ): void => {
    if (item.uuid) out.set(item.uuid, { kind: 'shape', item, start, end, bfp })
  }
  const text = (
    item: Extract<DrawingEntry, { kind: 'text' }>['item'] & { uuid?: string }
  ): void => {
    if (item.uuid) out.set(item.uuid, { kind: 'text', item })
  }
  for (const g of board.grLines) shape(g, g.start, g.end)
  for (const g of board.grArcs) shape(g, g.start, g.end)
  for (const g of board.grCircles) shape(g, g.center, g.end)
  for (const g of board.grRects) shape(g, g.start, g.end)
  for (const g of board.grPolys) shape(g)
  for (const g of board.grCurves) shape(g)
  for (const t of board.grTexts) text(t)
  for (const bfp of board.footprints) {
    const f = bfp.footprint
    for (const g of f.fpLines) shape(g, g.start, g.end, bfp)
    for (const g of f.fpArcs) shape(g, g.start, g.end, bfp)
    for (const g of f.fpCircles) shape(g, g.center, g.end, bfp)
    for (const g of f.fpRects) shape(g, g.start, g.end, bfp)
    for (const g of f.fpPolys) shape(g, undefined, undefined, bfp)
    for (const g of f.fpCurves) shape(g, undefined, undefined, bfp)
    for (const t of f.fpTexts) text(t)
    for (const t of f.properties) text(t)
  }
  return out
}

/**
 * A graphic's or text's property as KiCad's property system names it: a
 * shape's start and end (board millimeters, y down; a circle's start its
 * center) and stroke, a text's content, stroke, style and visibility. A
 * footprint's are placed with it.
 */
function drawingPropertyOf(entry: DrawingEntry, name: string): string | number | undefined {
  if (entry.kind === 'text') {
    const item = entry.item
    switch (name) {
      case 'text':
        return item.text ?? item.value ?? ''
      case 'thickness':
        return item.fontEffects ? nmToMm(item.fontEffects.thickness) : undefined
      case 'bold':
        return item.fontEffects?.bold ? 1 : 0
      case 'italic':
        return item.fontEffects?.italic ? 1 : 0
      case 'knockout':
        return item.knockout ? 1 : 0
      case 'visible':
        return item.hide ? 0 : 1
    }
    return undefined
  }
  const place = (p: { x: Nm; y: Nm } | undefined): { x: number; y: number } | undefined => {
    if (!p) return undefined
    if (!entry.bfp) return { x: nmToMm(p.x), y: nmToMm(p.y) }
    const w = tfPoint(footprintTransform(entry.bfp), p.x, p.y)
    return { x: w.x, y: -w.y }
  }
  switch (name) {
    case 'start x':
      return place(entry.start)?.x
    case 'start y':
      return place(entry.start)?.y
    case 'end x':
      return place(entry.end)?.x
    case 'end y':
      return place(entry.end)?.y
    case 'line width':
      return entry.item.strokeWidth !== undefined ? nmToMm(entry.item.strokeWidth) : undefined
  }
  return undefined
}

interface BoardGroup {
  uuid: string
  name: string
}

/**
 * The board's groups, and its footprints' own, by the uuid of each member:
 * `(group "name" (uuid …) (members …))` — `(id …)` in older files — and the
 * tuning patterns KiCad files as groups too (`(generated …)`). A group listed
 * in another's members sits inside it.
 */
function boardGroups(board: KicadBoard): { groupOf: Map<string, BoardGroup> } {
  const groupOf = new Map<string, BoardGroup>()
  const read = (node: SExprNode): void => {
    if (node.type !== 'list') return
    const token = node.children[0]?.type === 'atom' ? node.children[0].value : ''
    if (token !== 'group' && token !== 'generated') return
    const idNode = findChild(node, 'uuid') ?? findChild(node, 'id')
    const uuid = idNode ? getFirstAtomValue(idNode) : undefined
    if (!uuid) return
    const nameNode = findChild(node, 'name')
    const second = node.children[1]
    const name =
      token === 'group'
        ? second?.type === 'atom' && !second.quoted
          ? ''
          : second?.type === 'atom'
            ? second.value
            : ''
        : nameNode
          ? (getFirstAtomValue(nameNode) ?? '')
          : ''
    const members = findChild(node, 'members')
    for (const member of members?.children.slice(1) ?? [])
      if (member.type === 'atom') groupOf.set(member.value, { uuid, name })
  }
  if (board._raw.type === 'list') for (const node of board._raw.children) read(node)
  for (const bfp of board.footprints) for (const node of bfp.footprint.groups) read(node)
  return { groupOf }
}

/** A zone's `connect_pads` as a connection style. */
const ZONE_STYLE_OF_ZONE: Record<string, ZoneConnectionStyle> = {
  solid: 'solid',
  thermal: 'thermal_reliefs',
  thru_hole_only: 'thru_hole_only',
  none: 'none'
}

/** KiCad's `(zone_connect n)` numbering: 0 none, 1 thermal reliefs, 2 solid, 3 thermal for PTH. */
const ZONE_CONNECT: Array<ZoneConnectionStyle | undefined> = [
  'none',
  'thermal_reliefs',
  'solid',
  'thru_hole_only'
]

const rawChild = (raw: SExprNode, token: string): string | undefined => {
  const node = raw.type === 'list' ? findChild(raw, token) : null
  return node ? getFirstAtomValue(node) : undefined
}

/**
 * A pad's own zone settings and its footprint's connection style, which the
 * zone rules consult before the zone's (`resolver.ts`): KiCad reads a pad's
 * `zone_connect`, `thermal_gap` and `thermal_bridge_width`, and a footprint's
 * `zone_connect` (a footprint's `thermal_gap` it drops on load).
 */
function padZoneSettings(pad: KicadPad, bfp: KicadBoardFootprint): RuleItem['zone'] {
  const mm = (token: string): number | undefined => {
    const value = rawChild(pad._raw, token)
    return value !== undefined && Number(value) > 0 ? nmToMm(mmAtomToNm(value)) : undefined
  }
  const own = rawChild(pad._raw, 'zone_connect')
  return {
    padConnection: own !== undefined ? ZONE_CONNECT[Number(own)] : undefined,
    footprintConnection:
      bfp.footprint.zoneConnect !== undefined ? ZONE_CONNECT[bfp.footprint.zoneConnect] : undefined,
    padThermalGap: mm('thermal_gap'),
    padSpokeWidth: mm('thermal_bridge_width'),
    plated: pad.type === 'thru_hole'
  }
}

/** How far inside a region's rings a point lies; 0 or less outside. */
const depthIn = (p: Pt, region: Region): number => {
  if (!pointInRegion(p, region)) return 0
  let d = Infinity
  for (const ring of [region.outer, ...region.holes])
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
      d = Math.min(d, distanceToSegment(p, ring[j], ring[i]))
  return d
}

/**
 * Whether a fill's outline reaches into a region shrunk by KiCad's DRC
 * epsilon: copper along its border, or meeting it at a corner, does not.
 */
const ringReachesInto = (ring: readonly Pt[], region: Region): boolean => {
  // Asked again for every rule a zone is evaluated under: each fill and area once.
  let byRegion = reachCache.get(ring)
  if (!byRegion) reachCache.set(ring, (byRegion = new WeakMap()))
  let reaches = byRegion.get(region)
  if (reaches === undefined) {
    reaches = boxesOverlap(ringBounds(ring), ringBounds(region.outer)) && reachesInto(ring, region)
    byRegion.set(region, reaches)
  }
  return reaches
}
const reachCache = new WeakMap<readonly Pt[], WeakMap<Region, boolean>>()

const boundsCache = new WeakMap<readonly Pt[], Box>()
const ringBounds = (ring: readonly Pt[]): Box => {
  let box = boundsCache.get(ring)
  if (!box) {
    box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (const p of ring) {
      box.minX = Math.min(box.minX, p.x)
      box.minY = Math.min(box.minY, p.y)
      box.maxX = Math.max(box.maxX, p.x)
      box.maxY = Math.max(box.maxY, p.y)
    }
    boundsCache.set(ring, box)
  }
  return box
}
const boxesOverlap = (a: Box, b: Box): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY

const reachesInto = (ring: readonly Pt[], region: Region): boolean => {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]
    const b = ring[i]
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    if (depthIn(b, region) > AREA_EPSILON || depthIn(mid, region) > AREA_EPSILON) return true
    for (const edges of [region.outer, ...region.holes])
      for (let k = 0, l = edges.length - 1; k < edges.length; l = k++)
        if (segmentsCrossProperly(a, b, edges[l], edges[k])) return true
  }
  // A region wholly inside the fill.
  return region.outer.some((p) => depthIn(p, { outer: [...ring], holes: [] }) > AREA_EPSILON)
}
