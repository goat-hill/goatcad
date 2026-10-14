// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * The footprint checks: KiCad's footprint checker at KiCad's default
 * severities — `DIALOG_FOOTPRINT_CHECKER::runChecks` and the `FOOTPRINT::Check*`
 * and `PAD::CheckPad` it calls (`pcbnew/footprint.cpp`, `pcbnew/pad.cpp`). A
 * rule KiCad ignores by default (missing courtyard, footprint type) is not run;
 * KLC's style rules join with `{ klc: true }` (`klc.ts`). Any other difference
 * from KiCad is a bug unless kicad-parity.md lists it.
 *
 * Results use the sheet checks' shape (`schematic/checks.ts`), so the delta,
 * grouping and compaction an agent already reads apply unchanged.
 */
import type { KicadFootprint, KicadPad } from '../kicad/footprint'
import { findChild, getAtomValues, getFirstAtomValue, type SExprNode } from '../kicad/sexpr'
import { mmAtomToNm, mmToNm, type Nm } from '../kicad/coordinates'
import { COPPER_LAYERS, expandLayerToken, isCopperLayer } from '../kicad/layers'
import type { CheckResult } from '../schematic/checks'
import { isCourtyardLayer } from './footprintExtent'
import { footprintItems } from './footprintItems'
import {
  pointGap,
  rotateLocal,
  segmentGap,
  shapeBox,
  shapeGap,
  type Point,
  type Shape
} from './footprintGeometry'
import { footprintStrokes, onSide, padClearanceShape, type Stroke } from './footprintShapes'
import { KLC_CHECK_RULES, klcChecks, padProperty } from './klc'
import { padOnLayer } from '../kicad/footprint'
import { padFrame, padShape } from '../board/spatialIndex'
import { customPadRegions } from '../board/drc/shared'

/** The rules, for an agent; each names the KiCad violation it matches. */
export const FOOTPRINT_CHECK_RULES: Record<string, string> = {
  'pads-overlap':
    'Two pads of different numbers share copper on a layer, which shorts them on every board (KiCad shorting_items). Move one, give both one number if they are one connection, or put them in one net-tie group.',
  'net-tie-short':
    'In a net-tie footprint, copper joins pads that are not in one net-tie pad group (KiCad shorting_items). Add them to one group, or cut the copper.',
  'net-tie-groups':
    'A net-tie pad group names a pad the footprint does not have (KiCad footprint).',
  'silk-clipped-by-mask':
    'Silkscreen crosses a solder-mask opening, where the fab clips it (KiCad silk_over_copper, a warning). Move or shorten the stroke.',
  padstack:
    'A pad is questionable (KiCad padstack, a warning); the finding says how: copper on both sides of an SMD pad, mask or paste on the other side, a property the pad type does not fit, a hole that leaves no copper, a margin larger than the pad.',
  'padstack-invalid':
    'A pad cannot be made as drawn (KiCad padstack_invalid): no size, an SMD pad with a hole, a negative corner radius or chamfer, a trapezoid delta past the pad.',
  'through-hole-pad-without-hole':
    'A through-hole pad has no drill (KiCad through_hole_pad_without_hole).',
  'malformed-courtyard':
    'A courtyard outline does not close (KiCad malformed_courtyard); ends within 0.02 mm join. Close it, or remove the stray stroke.',
  'holes-co-located': 'Two drilled holes sit at one point (KiCad holes_co_located, a warning).',
  'hole-to-hole': 'Two drilled holes touch (KiCad hole_to_hole, a warning).',
  ...KLC_CHECK_RULES
}

/** Each rule's KiCad violation key (`drc_item.cpp`); KLC's style rules have none. */
export const FOOTPRINT_KICAD_KEYS: Record<string, string> = {
  'pads-overlap': 'shorting_items',
  'net-tie-short': 'shorting_items',
  'net-tie-groups': 'footprint',
  'silk-clipped-by-mask': 'silk_over_copper',
  padstack: 'padstack',
  'padstack-invalid': 'padstack_invalid',
  'through-hole-pad-without-hole': 'through_hole_pad_without_hole',
  'malformed-courtyard': 'malformed_courtyard',
  'holes-co-located': 'holes_co_located',
  'hole-to-hole': 'hole_to_hole'
}

/**
 * How far apart two outline ends may be and still join: KiCad's courtyard
 * `chainingEpsilon` (`FOOTPRINT::BuildCourtyardCaches`). Library arcs end a
 * few µm off the lines they meet, so an exact joint would call them open.
 */
export const COURTYARD_JOIN: Nm = mmToNm(0.02)

/** KiCad's `min_drill_size`: 4 IU, below which a hole has no polygon. */
const MIN_DRILL: Nm = 4 as Nm

/** Whether open line and arc ends pair up into loops, joining within `COURTYARD_JOIN`. */
const linesClose = (open: Stroke[]): boolean => {
  if (open.length < 2) return false
  const ends = open.flatMap((stroke) => [stroke.path[0], stroke.path[stroke.path.length - 1]])
  // Union the ends within reach; every joint must then take an even number of them.
  const parent = ends.map((_, i) => i)
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])))
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (Math.hypot(ends[i].x - ends[j].x, ends[i].y - ends[j].y) <= COURTYARD_JOIN) {
        parent[root(j)] = root(i)
      }
    }
  }
  const degree = new Map<number, number>()
  const strokesAt = new Map<number, Set<number>>()
  for (let i = 0; i < ends.length; i++) {
    degree.set(root(i), (degree.get(root(i)) ?? 0) + 1)
    strokesAt.set(root(i), (strokesAt.get(root(i)) ?? new Set()).add(i >> 1))
  }
  // A joint of one stroke's own two ends is a zero-length stray, not a loop.
  return [...degree].every(([joint, count]) => count % 2 === 0 && strokesAt.get(joint)!.size > 1)
}

/** A stroke as clearance shapes: each segment a capsule, plus its fill. */
const strokeShapes = (stroke: Stroke): Shape[] => {
  const radius = stroke.width / 2
  const shapes: Shape[] =
    stroke.path.length === 1
      ? [{ core: [stroke.path[0]], radius }]
      : stroke.path.slice(1).map((point, i) => ({ core: [stroke.path[i], point], radius }))
  return stroke.filled ? [...shapes, stroke.filled] : shapes
}

/** Gap between a stroke and a shape; negative when they overlap. */
const strokeGap = (stroke: Stroke, shape: Shape): number => {
  let gap = stroke.filled ? shapeGap(stroke.filled, shape) : Infinity
  if (stroke.path.length === 1)
    return Math.min(gap, pointGap(stroke.path[0], shape) - stroke.width / 2)
  for (let i = 1; i < stroke.path.length && gap >= 0; i++) {
    gap = Math.min(gap, segmentGap(stroke.path[i - 1], stroke.path[i], shape) - stroke.width / 2)
  }
  return gap
}

const onLayer = (pad: KicadPad, layer: string): boolean =>
  pad.layers.some((token) => expandLayerToken(token, COPPER_LAYERS).includes(layer))

/**
 * KiCad's `PAD::IsOnCopperLayer`: a non-plated hole no bigger than its drill
 * has no ring, so no copper, whatever its layers say.
 */
export const hasCopper = (pad: KicadPad): boolean => {
  if (!pad.layers.some(isCopperLayer)) return false
  if (pad.type !== 'np_thru_hole' || !pad.drill) return true
  const centered = !pad.drill.offset || (pad.drill.offset.x === 0 && pad.drill.offset.y === 0)
  const drill = drillSize(pad)
  if (pad.shape === 'circle') return !(centered && pad.size.w <= drill.x)
  if (pad.shape === 'oval') return !(centered && pad.size.w <= drill.x && pad.size.h <= drill.y)
  return true
}

const copperLayersOf = (pad: KicadPad): Set<string> =>
  hasCopper(pad)
    ? new Set(
        pad.layers.filter(isCopperLayer).flatMap((token) => expandLayerToken(token, COPPER_LAYERS))
      )
    : new Set()

/** Drill width and height, the oval's when it is one. */
const drillSize = (pad: KicadPad): { x: number; y: number; oval: boolean } =>
  pad.drill
    ? {
        x: pad.drill.oval?.width ?? pad.drill.diameter,
        y: pad.drill.oval?.height ?? pad.drill.diameter,
        oval: !!pad.drill.oval
      }
    : { x: 0, y: 0, oval: false }

/** KiCad's `PAD::HasDrilledHole`: a round hole. */
const hasDrilledHole = (pad: KicadPad): boolean => {
  const drill = drillSize(pad)
  return drill.x > 0 && drill.y > 0 && drill.x === drill.y
}

/** The hole as a capsule at the pad's position (the drill `offset` moves the copper), its slot turned with the pad. */
const holeShape = (pad: KicadPad): Shape => {
  const angle = pad.position.angle ?? 0
  const center = pad.position
  const drill = drillSize(pad)
  const half = Math.abs(drill.x - drill.y) / 2
  const along = drill.x >= drill.y ? rotateLocal(half, 0, angle) : rotateLocal(0, half, angle)
  return {
    core: half
      ? [
          { x: center.x - along.x, y: center.y - along.y },
          { x: center.x + along.x, y: center.y + along.y }
        ]
      : [center],
    radius: Math.min(drill.x, drill.y) / 2
  }
}

/** A convex shape entirely inside another (distance from a capsule is convex). */
const inside = (inner: Shape, outer: Shape): boolean =>
  inner.core.every((point: Point) => pointGap(point, outer) + inner.radius <= 0)

/** `(rect_delta x y)` of a trapezoid pad. */
const rectDelta = (pad: KicadPad): { x: number; y: number } | null => {
  const node = pad._raw.type === 'list' ? findChild(pad._raw, 'rect_delta') : null
  const [x, y] = node ? getAtomValues(node) : []
  return x !== undefined && y !== undefined ? { x: mmAtomToNm(x), y: mmAtomToNm(y) } : null
}

/**
 * KiCad's `PAD::CheckPad` for one padstack, sorted by the violation each
 * finding raises. Messages are KiCad's, trimmed of its parentheses.
 */
const checkPad = (pad: KicadPad): PadProblems => {
  const padstack: string[] = []
  const invalid: string[] = []
  let noHole = false
  const frontCopper = onLayer(pad, 'F.Cu')
  const backCopper = onLayer(pad, 'B.Cu')
  const drill = drillSize(pad)
  const property = padProperty(pad._raw)

  if (!frontCopper && !backCopper && (drill.x || drill.y) && pad.type !== 'np_thru_hole') {
    padstack.push('plated through holes normally have a copper pad on at least one outer layer')
  }
  const plated = pad.type === 'thru_hole'
  const npth = pad.type === 'np_thru_hole'
  if ((property === 'pad_prop_fiducial_glob' || property === 'pad_prop_fiducial_loc') && npth)
    padstack.push("'fiducial' pads are normally plated")
  if (property === 'pad_prop_testpoint' && npth)
    padstack.push("'testpoint' pads are normally plated")
  if (property === 'pad_prop_heatsink' && npth) padstack.push("'heatsink' pads are normally plated")
  if (property === 'pad_prop_castellated' && !plated)
    padstack.push("'castellated' pads are normally PTH")
  if (property === 'pad_prop_bga' && pad.type !== 'smd')
    padstack.push("'BGA' property is for SMD pads")
  if (property === 'pad_prop_mechanical' && !plated)
    padstack.push("'mechanical' pads are normally PTH")
  if (property === 'pad_prop_pressfit' && (!plated || !hasDrilledHole(pad)))
    padstack.push("'press-fit' pads are normally PTH with round holes")

  if (plated || npth) {
    if (drill.x <= 0 || (drill.y <= 0 && drill.oval)) noHole = true
  } else {
    if (pad.type === 'connect' && (onLayer(pad, 'F.Paste') || onLayer(pad, 'B.Paste')))
      padstack.push('connector pads normally have no solder paste; use a SMD pad instead')
    if (drill.x > 0 || drill.y > 0) invalid.push('SMD pad has a hole')
    if (frontCopper && backCopper) padstack.push('SMD pad has copper on both sides of the board')
    else if (frontCopper && onLayer(pad, 'B.Mask'))
      padstack.push('SMD pad has copper and mask layers on different sides of the board')
    else if (frontCopper && onLayer(pad, 'B.Paste'))
      padstack.push('SMD pad has copper and paste layers on different sides of the board')
    else if (backCopper && onLayer(pad, 'F.Mask'))
      padstack.push('SMD pad has copper and mask layers on different sides of the board')
    else if (backCopper && onLayer(pad, 'F.Paste'))
      padstack.push('SMD pad has copper and paste layers on different sides of the board')
    else if (!frontCopper && !backCopper && copperLayersOf(pad).size)
      padstack.push('SMD pad has no outer layers')
  }

  // `doCheckPad`, on each of its padstack's layers: the shape itself.
  const layers: Array<{
    onLayer: KicadPad
    size: { w: number; h: number }
    delta: { x: number; y: number } | null
  }> = [{ onLayer: pad, size: pad.size, delta: pad.shape === 'trapezoid' ? rectDelta(pad) : null }]
  for (const [key, props] of Object.entries(pad.padstack?.layers ?? {})) {
    const onLayer = padOnLayer(pad, key === 'Inner' ? 'In1.Cu' : key)
    layers.push({
      onLayer,
      size: props.size,
      delta: props.shape === 'trapezoid' ? (props.rectDelta ?? null) : null
    })
  }
  for (const { onLayer, size, delta } of layers) {
    const { w, h } = size
    if (onLayer.shape !== 'custom' && (w <= 0 || (h <= 0 && onLayer.shape !== 'circle')))
      invalid.push('Pad must have a positive size')
    if (copperLayersOf(pad).size && drill.x > 0) {
      if (drill.x <= MIN_DRILL || drill.y <= MIN_DRILL)
        invalid.push('PTH pad hole size must be larger than 0.000004 mm')
      if (plated) {
        if (w <= 0 || h <= 0 || inside(padClearanceShape(onLayer), holeShape(pad)))
          padstack.push('PTH pad hole leaves no copper')
      } else if (pointGap(pad.position, padClearanceShape(onLayer)) > 0) {
        padstack.push('pad hole not inside pad shape')
      }
    }
    if ((pad.clearance ?? 0) < 0) padstack.push('negative local clearance values have no effect')
    const mask = pad.solderMaskMargin ?? 0
    if (mask < 0 && onLayer.shape !== 'custom' && (-mask > w || -mask > h))
      padstack.push(
        'negative solder mask clearance is larger than pad; no solder mask will be generated'
      )
    const paste = pad.solderPasteMargin ?? 0
    const ratio = pad.solderPasteMarginRatio ?? 0
    if (w + paste + Math.round(w * ratio) <= 0 || h + paste + Math.round(h * ratio) <= 0)
      padstack.push(
        'negative solder paste margin is larger than pad; no solder paste mask will be generated'
      )
    if (onLayer.shape === 'roundrect' && (onLayer.roundrectRatio ?? 0) < 0)
      invalid.push('negative corner radius is not allowed')
    if (onLayer.chamfer?.length && (onLayer.chamferRatio ?? 0) < 0)
      invalid.push('negative corner chamfer is not allowed')
    if (
      delta &&
      ((delta.x < 0 && delta.x < -h) ||
        (delta.x > 0 && delta.x > h) ||
        (delta.y < 0 && delta.y < -w) ||
        (delta.y > 0 && delta.y > w))
    )
      invalid.push('trapezoid delta is too large')
    if (onLayer.shape === 'custom') {
      const frame = padFrame(padShape(onLayer, { x: 0, y: 0 }))
      if ((customPadRegions(onLayer, frame, 0)?.length ?? 1) > 1)
        invalid.push('custom pad shape must resolve to a single polygon')
    }
  }
  // Each problem once per padstack layer it is found on, as KiCad reports them.
  return { padstack, invalid, noHole }
}

interface PadProblems {
  padstack: string[]
  invalid: string[]
  noHole: boolean
}

const padCache = new WeakMap<KicadPad, PadProblems>()

/**
 * `checkPad`, once per pad: an edit reparses only what it touched, so a
 * board's unchanged pads keep their objects and their answers.
 */
export const padProblems = (pad: KicadPad): PadProblems => {
  let problems = padCache.get(pad)
  if (!problems) padCache.set(pad, (problems = checkPad(pad)))
  return problems
}

/**
 * The footprint's net-tie pad groups as pad number → group index, KiCad's
 * `MapPadNumbersToNetTieGroups`: comma-separated, `\` escaping, trimmed.
 */
export const netTieGroups = (fp: KicadFootprint): Map<string, number> => {
  const map = new Map<string, number>()
  const node = fp._raw.type === 'list' ? findChild(fp._raw, 'net_tie_pad_groups') : null
  const groups = node ? getAtomValues(node) : []
  groups.forEach((group, index) => {
    let escaped = false
    let pad = ''
    const take = (): void => {
      const trimmed = pad.trim()
      if (trimmed) map.set(trimmed, index)
      pad = ''
    }
    for (const ch of group) {
      if (escaped) {
        escaped = false
        pad += ch
      } else if (ch === '\\') escaped = true
      else if (ch === ',') take()
      else pad += ch
    }
    take()
  })
  return map
}

export const footprintChecks = (
  fp: KicadFootprint,
  options: { klc?: boolean } = {}
): CheckResult[] => {
  const out: CheckResult[] = []
  const strokes = footprintStrokes(fp)
  const padLabel = (pad: KicadPad): string => `pad:${pad.number}`
  const padsSubject = (pads: KicadPad[]): string =>
    `${pads.length === 1 ? 'pad' : 'pads'} ${pads.map((pad) => pad.number || '(unnumbered)').join(', ')}`
  // `items` is what an agent reads (`pad:3`); `targets` are the exact item ids
  // the editor selects, which a shared or empty pad number cannot name.
  const itemIds = new Map(footprintItems(fp).map((item) => [item.node, item.id]))
  const itemId = (node: SExprNode): string | undefined => itemIds.get(node)
  const targets = (nodes: SExprNode[]): string[] => nodes.flatMap((node) => itemId(node) ?? [])
  const groups = netTieGroups(fp)
  const shape = new Map(fp.pads.map((pad) => [pad, padClearanceShape(pad)]))

  // Courtyard: KiCad builds each side's outline; one that does not close is malformed.
  for (const side of ['F', 'B'] as const) {
    const layer = strokes.filter(
      (stroke) => isCourtyardLayer(stroke.layer) && stroke.layer.startsWith(side)
    )
    const open = layer.filter((stroke) => !stroke.closed)
    if (open.length && !linesClose(open)) {
      out.push({
        code: 'malformed-courtyard',
        severity: 'error',
        message: `The ${side}.CrtYd outline is not closed.`,
        items: layer.map((stroke) => stroke.id),
        targets: targets(layer.map((stroke) => stroke.node)),
        subject: `${side}.CrtYd`
      })
    }
  }

  for (const pad of fp.pads) {
    const { padstack, invalid, noHole } = padProblems(pad)
    const base = {
      items: [padLabel(pad)],
      targets: targets([pad._raw]),
      subject: padsSubject([pad])
    }
    if (invalid.length)
      out.push({
        code: 'padstack-invalid',
        severity: 'error',
        message: `Pad ${pad.number}: ${[...new Set(invalid)].join('; ')}.`,
        ...base
      })
    if (noHole)
      out.push({
        code: 'through-hole-pad-without-hole',
        severity: 'error',
        message: `Pad ${pad.number} is through hole with no drill.`,
        ...base
      })
    if (padstack.length)
      out.push({
        code: 'padstack',
        severity: 'warning',
        message: `Pad ${pad.number}: ${[...new Set(padstack)].join('; ')}.`,
        ...base
      })
  }

  // `CheckShortingPads`: holes first, for every pair; then copper, skipping one
  // logical pad (a shared non-empty number) and one net-tie group.
  const copper = new Map(fp.pads.map((pad) => [pad, copperLayersOf(pad)]))
  const boxes = new Map(fp.pads.map((pad) => [pad, shapeBox(shape.get(pad)!)]))
  for (let i = 0; i < fp.pads.length; i++) {
    for (let j = i + 1; j < fp.pads.length; j++) {
      const a = fp.pads[i]
      const b = fp.pads[j]
      const pair = {
        items: [padLabel(a), padLabel(b)].sort(),
        targets: targets([a._raw, b._raw]),
        subject: padsSubject([a, b])
      }
      if (hasDrilledHole(a) && hasDrilledHole(b)) {
        if (a.position.x === b.position.x && a.position.y === b.position.y) {
          out.push({
            code: 'holes-co-located',
            severity: 'warning',
            message: `Pads ${a.number} and ${b.number} have holes at one point.`,
            ...pair
          })
        } else if (shapeGap(holeShape(a), holeShape(b)) < 0) {
          out.push({
            code: 'hole-to-hole',
            severity: 'warning',
            message: `The holes of pads ${a.number} and ${b.number} touch.`,
            ...pair
          })
        }
      }
      if (a.number && a.number === b.number) continue
      const group = groups.get(a.number)
      if (group !== undefined && group === groups.get(b.number)) continue
      if (![...copper.get(a)!].some((layer) => copper.get(b)!.has(layer))) continue
      const boxA = boxes.get(a)!
      const boxB = boxes.get(b)!
      if (
        boxA.maxX < boxB.minX ||
        boxB.maxX < boxA.minX ||
        boxA.maxY < boxB.minY ||
        boxB.maxY < boxA.minY
      )
        continue
      if (shapeGap(shape.get(a)!, shape.get(b)!) <= 0) {
        out.push({
          code: 'pads-overlap',
          severity: 'error',
          message: `Pads ${a.number} and ${b.number} share copper.`,
          ...pair
        })
      }
    }
  }

  // Net ties: `CheckNetTiePadGroups` and `CheckNetTies`, for a footprint that has groups.
  if (groups.size) {
    const numbers = new Set(fp.pads.map((pad) => pad.number))
    for (const number of groups.keys()) {
      if (numbers.has(number)) continue
      out.push({
        code: 'net-tie-groups',
        severity: 'error',
        message: `A net-tie pad group names pad ${number}, which the footprint does not have.`,
        items: ['net_tie_pad_groups'],
        targets: [],
        subject: `pad ${number}`
      })
    }
    for (const layer of ['F.Cu', 'In1.Cu', 'B.Cu']) {
      const drawn = strokes.filter((stroke) =>
        expandLayerToken(stroke.layer, COPPER_LAYERS).includes(layer)
      )
      // Copper drawings that touch are one piece of copper.
      const parent = drawn.map((_, i) => i)
      const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])))
      for (let i = 0; i < drawn.length; i++) {
        for (let j = i + 1; j < drawn.length; j++) {
          if (strokeShapes(drawn[j]).some((part) => strokeGap(drawn[i], part) <= 0))
            parent[root(j)] = root(i)
        }
      }
      const pieces = new Map<number, { stroke: Stroke; pads: KicadPad[] }>()
      for (let i = 0; i < drawn.length; i++) {
        const piece = pieces.get(root(i)) ?? { stroke: drawn[root(i)], pads: [] }
        for (const pad of fp.pads) {
          if (
            copper.get(pad)!.has(layer) &&
            !piece.pads.includes(pad) &&
            strokeGap(drawn[i], shape.get(pad)!) <= 0
          )
            piece.pads.push(pad)
        }
        pieces.set(root(i), piece)
      }
      for (const { stroke, pads } of pieces.values()) {
        const first = groups.get(pads[0]?.number ?? '')
        for (const other of pads.slice(1)) {
          const group = groups.get(other.number)
          if (group !== undefined && group === first) continue
          out.push({
            code: 'net-tie-short',
            severity: 'error',
            message: `Copper ${stroke.id} joins pads ${pads[0].number} and ${other.number}, which share no net-tie group.`,
            items: [stroke.id, padLabel(pads[0]), padLabel(other)],
            targets: targets([stroke.node, pads[0]._raw, other._raw]),
            subject: padsSubject([pads[0], other])
          })
        }
      }
    }
  }

  // `CheckClippedSilk`: silk against the mask openings on its side, pads and drawings.
  const footprintMask = (() => {
    const node = fp._raw.type === 'list' ? findChild(fp._raw, 'solder_mask_margin') : null
    const value = node ? getFirstAtomValue(node) : undefined
    return value === undefined ? 0 : mmAtomToNm(value)
  })()
  for (const side of ['F', 'B'] as const) {
    const openings = [
      ...fp.pads
        .filter((pad) => onSide(pad.layers, side, 'Mask'))
        .map((pad) => ({
          node: pad._raw,
          label: padLabel(pad),
          pad,
          // KiCad's `GetSolderMaskExpansion`: a pad on no copper layer is not expanded.
          shape: padClearanceShape(
            pad,
            pad.layers.some(isCopperLayer) ? (pad.solderMaskMargin ?? footprintMask) : 0
          )
        })),
      ...strokes
        .filter((stroke) => stroke.layer === `${side}.Mask`)
        .flatMap((stroke) =>
          strokeShapes(stroke).map((part) => ({
            node: stroke.node,
            label: stroke.id,
            pad: null,
            shape: part
          }))
        )
    ]
    for (const stroke of strokes) {
      if (stroke.layer !== `${side}.SilkS`) continue
      const hits = openings.filter((opening) => strokeGap(stroke, opening.shape) < 0)
      if (!hits.length) continue
      const nodes = [...new Set(hits.map((hit) => hit.node))]
      const labels = [...new Set(hits.map((hit) => hit.label))]
      const pads = [...new Set(hits.flatMap((hit) => (hit.pad ? [hit.pad] : [])))]
      out.push({
        code: 'silk-clipped-by-mask',
        severity: 'warning',
        message: `Silkscreen ${stroke.id} crosses the mask opening of ${labels.join(', ')}.`,
        items: [stroke.id, ...labels.sort()],
        targets: targets([stroke.node, ...nodes]),
        subject: pads.length
          ? `${stroke.layer} ${stroke.kind} · ${padsSubject(pads)}`
          : `${stroke.layer} ${stroke.kind}`
      })
    }
  }

  return options.klc ? [...out, ...klcChecks(fp, itemId, strokes)] : out
}
