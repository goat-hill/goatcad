// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
import { viaMaskIsOpen } from '../../../kicad/board'
import { padOnLayer, type KicadPad } from '../../../kicad/footprint'
import { isCopperLayer } from '../../../kicad/layers'
import { nmToMm } from '../../../kicad/coordinates'
import { findChild, getAtomValues } from '../../../kicad/sexpr'
import { footprintTransform, tfPoint } from '../../../schematic/placement'
import { PackedRTree } from '../../../geometry/packedRTree'
import { boxesTouch, type Box } from '../../../geometry/polygon'
import { padShape, shapeCenter, type CopperShape } from '../../spatialIndex'
import { shapeOutlines } from '../../shapeOutline'
import {
  maskSettings,
  padMaskMargin,
  padTouchesLayer,
  trackMaskMargin,
  viaMaskMargin
} from '../../maskExpansion'
import { netTieGroups } from '../../../footprint/footprintChecks'
import type { RuleItem } from '../../rules/constraints'
import type { DrcContext } from '../context'
import {
  DRAWING_NAMES,
  at,
  between,
  collides,
  idsOf,
  npthWithoutRing,
  positional,
  type Subject
} from '../shared'

/** Something that opens the mask, or copper that may lie inside an opening. */
interface Piece {
  /** Stable identity, whichever side it was read from. */
  id: string
  subject: Subject
  /** Its shape on the layer it is tested on: the mask, or the copper beneath. */
  shape: CopperShape
  box: Box
  /** Its net where it has one (0 is no net); -1 for what carries none (text, a footprint's graphic). */
  net: number
  /** How far the mask opens round it (KiCad's `GetSolderMaskExpansion`), mm. */
  expansion: number
  /** An opening that exposes no copper of its own: a mask-only pad or drawing, or a free pad. */
  aperture: boolean
  /** It has copper on the side's outer layer. */
  onCopper: boolean
  fp?: number
  pad?: KicadPad
  /** A pad whose hole has no ring: the bridge checks pass it over as an opening. */
  bareHole: boolean
  /**
   * Where KiCad's walk meets it (`forEachGeometryItem`): tracks and vias in
   * file order, then the board's drawings, then each footprint's pads and
   * drawings. Which net an opening of no copper of its own meets first
   * decides which of its bridges KiCad names.
   */
  rank: number
  rule: () => RuleItem
}

/**
 * Solder-mask bridges (KiCad's `solder_mask_bridge`,
 * `drc_test_provider_solder_mask.cpp`): the mask between two openings, or
 * between an opening and copper it must cover, is too narrow to hold, so
 * copper of two nets is left bare together. On each side:
 * - two openings closer than the board's minimum web (each grown by its own
 *   margin);
 * - copper the mask covers closer to an opening than the board's
 *   mask-to-copper clearance (again with the margins);
 * - an opening reaching into a pour of another net.
 * An opening with no copper of its own — a pad or drawing on the mask alone,
 * or a free pad — bridges only when it bares copper of two nets, and the
 * finding names both. One net's copper never bridges itself; a pad bridges
 * nothing with its own number or its net-tie group; a footprint that allows
 * bridges, or the board allowing them within footprints, excuses its own; a
 * project rule can let an item bridge (`bridged_mask`, severity ignore).
 */
export function* solderMask(ctx: DrcContext): Generator<void> {
  const { board, ruleSet, emit, tick, padSubject, footprintSubject, zoneSubject, itemByRef } = ctx
  const settings = maskSettings(board)
  const web = nmToMm(settings.webWidth)
  const toCopper = nmToMm(settings.toCopper)
  const boardMargin = nmToMm(board.padToMaskClearance)
  const hasBridgeRules = ruleSet.resolver.hasRules('bridged_mask')
  let margins: Map<string, number> | null = null

  const allowsBridges = (fp: number | undefined): boolean =>
    fp !== undefined &&
    board.footprints[fp].footprint.attributes.includes('allow_soldermask_bridges')
  const tieGroups = new Map<number, Map<string, number>>()
  const groupsOf = (fp: number): Map<string, number> => {
    let groups = tieGroups.get(fp)
    if (!groups) tieGroups.set(fp, (groups = netTieGroups(board.footprints[fp].footprint)))
    return groups
  }
  /** The nets a net-tie footprint's item joins: its pad's group's, else every tied pad's. */
  const tieNets = (piece: Piece): Set<number> | null => {
    if (piece.fp === undefined) return null
    const groups = groupsOf(piece.fp)
    if (groups.size === 0) return null
    const pads = board.footprints[piece.fp].footprint.pads
    const group = piece.pad ? groups.get(piece.pad.number) : undefined
    const nets = new Set<number>()
    for (const pad of pads) {
      const g = groups.get(pad.number)
      if (g === undefined || (piece.pad && g !== group)) continue
      if (pad.net?.number !== undefined) nets.add(pad.net.number)
    }
    return nets
  }
  const sameLogicalPad = (a: Piece, b: Piece): boolean => {
    if (!a.pad || !b.pad || a.fp !== b.fp) return false
    if (a.pad.number && a.pad.number === b.pad.number) return true
    const groups = groupsOf(a.fp!)
    const ga = groups.get(a.pad.number)
    return ga !== undefined && ga === groups.get(b.pad.number)
  }
  const ignored = (piece: Piece, layer: string): boolean =>
    hasBridgeRules &&
    ruleSet.resolver.evaluate('bridged_mask', piece.rule(), null, layer).severity === 'ignore'

  const isFree = (pad: KicadPad): boolean =>
    (pad.net?.name ?? '').startsWith('unconnected-(') && pad.pinType === 'free'

  /** A drawing on a mask layer or copper, as a piece. */
  const drawingSubject = (
    uuid: string | undefined,
    kind: string,
    fp: number | undefined,
    shape: CopperShape,
    layer: string
  ): Subject => {
    const owner = fp !== undefined ? footprintSubject(board.footprints[fp]) : null
    return {
      item: ctx.drawingId(uuid, fp) ?? positional(kind, shapeCenter(shape)),
      name: owner ? `${kind} of ${owner.name}` : `${kind} on ${layer}`,
      targets: owner ? owner.targets : uuid ? [uuid] : [],
      ...(owner && uuid ? { ids: [uuid] } : {})
    }
  }

  for (const side of ['F', 'B'] as const) {
    const mask = `${side}.Mask`
    const copper = side === 'F' ? 'F.Cu' : 'B.Cu'
    const tentSide = side === 'F' ? 'front' : 'back'
    if (!board.layers.some((l) => l.name === copper)) continue
    const openings: Piece[] = []
    const covered: Piece[] = []

    board.footprints.forEach((bfp, fp) => {
      const tf = footprintTransform(bfp)
      bfp.footprint.pads.forEach((pad, index) => {
        const onMask = padTouchesLayer(pad, mask)
        const onCopper = padTouchesLayer(pad, copper)
        if (!onMask && !onCopper) return
        const center = tfPoint(tf, pad.position.x, pad.position.y)
        const shape = padShape(padOnLayer(pad, copper), center)
        const bareHole = pad.type === 'np_thru_hole' && npthWithoutRing(pad)
        const piece: Piece = {
          id: `pad:${fp}:${index}`,
          subject: padSubject(bfp, pad, center),
          shape,
          box: boxOf(shape),
          net: pad.net?.number ?? 0,
          expansion: nmToMm(padMaskMargin(board, fp, index, mask, ruleSet)),
          aperture:
            isFree(pad) ||
            (onMask && !pad.layers.some((l) => l === '*.Cu' || l === 'F&B.Cu' || isCopperLayer(l))),
          onCopper,
          fp,
          pad,
          bareHole,
          rank: FOOTPRINT_RANK + fp * 10_000 + index,
          rule: () => ruleSet.padItem(fp, index)
        }
        // A hole with no ring opens the mask but bridges nothing as an opening: it is tested as copper.
        if (onMask && !bareHole) openings.push(piece)
        else if (onCopper) covered.push(piece)
      })
    })

    board.vias.forEach((via, i) => {
      if (!via.layers.includes(copper)) return
      const item = itemByRef.get(`via:${i}`)
      if (!item) return
      const open = viaMaskIsOpen(via, tentSide, board.tenting)
      const shape = ctx.copperOn(item, copper)?.shape ?? item.shape
      const piece: Piece = {
        id: `via:${i}`,
        subject: ctx.subjectOfItem(item)!,
        shape,
        box: boxOf(shape),
        net: via.net,
        expansion: open ? nmToMm(viaMaskMargin(board)) : 0,
        aperture: false,
        onCopper: true,
        bareHole: false,
        rank: rawStart(via),
        rule: () => ruleSet.copperItem(item)
      }
      ;(open ? openings : covered).push(piece)
    })

    for (const [list, kind] of [
      [board.segments, 'segment'],
      [board.trackArcs, 'tarc']
    ] as const)
      list.forEach((track, i) => {
        if (track.layer !== copper) return
        const item = itemByRef.get(`${kind}:${i}`)
        if (!item) return
        // A track the file opens is its copper grown by its margin on the mask.
        const margin = trackMaskMargin(board, track)
        const shape: CopperShape =
          margin !== null && (item.shape.kind === 'capsule' || item.shape.kind === 'arc')
            ? { ...item.shape, halfWidth: item.shape.halfWidth + nmToMm(margin) }
            : item.shape
        const piece: Piece = {
          id: `${kind}:${i}`,
          subject: ctx.subjectOfItem(item)!,
          shape,
          box: boxOf(shape),
          net: track.net,
          expansion: 0,
          aperture: false,
          onCopper: true,
          bareHole: false,
          rank: rawStart(track),
          rule: () => ruleSet.copperItem(item)
        }
        ;(margin !== null ? openings : covered).push(piece)
      })

    // Copper drawings: a board graphic has its net; a footprint's graphic and any text none.
    for (const d of ctx.drawingSet.items) {
      if (!d.layers.includes(copper) || !d.inCopperTree) continue
      const graphic = d.drawing === 'graphic'
      const kind = DRAWING_NAMES[d.drawing]
      covered.push({
        id: `drawing:${d.id}`,
        subject:
          ctx.copperOf.get(d.id)?.subject ?? drawingSubject(d.uuid, kind, d.fp, d.shape, copper),
        shape: d.shape,
        box: { minX: d.minX, minY: d.minY, maxX: d.maxX, maxY: d.maxY },
        net: d.connected || d.netted ? d.net : -1,
        expansion: graphic ? shapeMargin(d.uuid) : 0,
        aperture: false,
        onCopper: true,
        ...(d.fp !== undefined ? { fp: d.fp } : {}),
        bareHole: false,
        rank:
          d.fp !== undefined ? FOOTPRINT_RANK + d.fp * 10_000 + 5_000 + d.id : DRAWING_RANK + d.id,
        rule: () => ruleSet.copperItem(d)
      })
    }

    // What is drawn on the mask itself: an opening of its own, over no copper.
    for (const item of ctx.layerIndex.layer(mask).items) {
      if (
        item.kind === 'pad' ||
        item.kind === 'via' ||
        item.kind === 'track' ||
        item.kind === 'zone'
      )
        continue
      const kind =
        item.kind in DRAWING_NAMES
          ? DRAWING_NAMES[item.kind as keyof typeof DRAWING_NAMES]
          : item.kind
      const owner = item.fp !== undefined ? board.footprints[item.fp] : undefined
      openings.push({
        id: `${mask}:${item.id}`,
        subject: drawingSubject(item.uuid, kind, item.fp, item.shape, mask),
        shape: item.shape,
        box: { minX: item.minX, minY: item.minY, maxX: item.maxX, maxY: item.maxY },
        net: -1,
        expansion: item.kind === 'graphic' ? shapeMargin(item.uuid) : 0,
        aperture: true,
        onCopper: false,
        ...(item.fp !== undefined ? { fp: item.fp } : {}),
        bareHole: false,
        rank:
          item.fp !== undefined
            ? FOOTPRINT_RANK + item.fp * 10_000 + 5_000 + item.id
            : DRAWING_RANK + item.id,
        rule: () => ({
          kind: item.kind === 'graphic' ? 'graphic' : 'text',
          label: kind,
          layers: [mask],
          nonCopper: true,
          ...(owner ? { footprint: owner.reference, footprintLayer: owner.layer } : {})
        })
      })
    }

    const maxExpansion = Math.max(
      0,
      ...openings.map((o) => o.expansion),
      ...covered.map((c) => c.expansion)
    )
    const reach = Math.max(web, toCopper) + 2 * maxExpansion
    const tree = treeOf(openings)

    /**
     * Every item an opening that owns no copper bares, with its net and the
     * order KiCad records it in: first what the opening meets on its own
     * turn — other openings, pours — then copper as the walk reaches it.
     * KiCad names its bridges by the first net recorded.
     */
    const bared = new Map<Piece, Array<{ piece: Piece; net: number; rank: number }>>()
    const bare = (
      aperture: Piece,
      test: Piece,
      net: number,
      maskSide: boolean,
      own = maskSide
    ): void => {
      // An opening meets another opening's copper only where that one has copper.
      if (maskSide && !test.onCopper) return
      if (allowsBridges(aperture.fp)) return
      const list = bared.get(aperture) ?? []
      const rank = own ? OWN_RANK + test.rank : test.rank
      list.push({ piece: test, net, rank })
      bared.set(aperture, list)
    }

    const checked = new Set<string>()
    const test = (item: Piece, maskSide: boolean): void => {
      tree.search(
        item.box.minX - reach,
        item.box.minY - reach,
        item.box.maxX + reach,
        item.box.maxY + reach,
        (j) => {
          const other = openings[j]
          if (other === item || other.id === item.id || other.bareHole) return
          if (other.net > 0 && other.net === item.net) return
          if (item.fp !== undefined && item.fp === other.fp) {
            if (settings.bridgesInFootprints || allowsBridges(item.fp)) return
          }
          if (sameLogicalPad(item, other)) return
          const itemTies = tieNets(item)
          if (itemTies && (other.net < 0 || itemTies.has(other.net))) return
          const otherTies = tieNets(other)
          if (otherTies && (item.net < 0 || otherTies.has(item.net))) return
          const key = item.id < other.id ? `${item.id}|${other.id}` : `${other.id}|${item.id}`
          if (checked.has(key)) return
          checked.add(key)
          const clearance = (maskSide ? web : toCopper) + item.expansion + other.expansion
          if (!collides(item.shape, other.shape, clearance)) return
          const itemIgnored = ignored(item, maskSide ? mask : copper)
          const otherIgnored = ignored(other, mask)
          if (
            (item.aperture && itemIgnored) ||
            (other.aperture && otherIgnored) ||
            (itemIgnored && otherIgnored)
          )
            return
          if (item.aperture) bare(item, other, other.net, maskSide)
          else if (other.aperture) bare(other, item, item.net, maskSide)
          else if (maskedAllows(other, item.net))
            report([item, other], between(item.shape, other.shape))
        }
      )
    }
    /** KiCad's `checkItemMask`: an opening in a footprint that allows bridges, or a tie's own net, is excused. */
    const maskedAllows = (piece: Piece, net: number): boolean => {
      if (allowsBridges(piece.fp)) return false
      if (piece.pad && piece.fp !== undefined) {
        const groups = groupsOf(piece.fp)
        const group = groups.get(piece.pad.number)
        if (group !== undefined) {
          if (net < 0 || piece.net === net) return false
          for (const pad of board.footprints[piece.fp].footprint.pads)
            if (groups.get(pad.number) === group && pad.net?.number === net) return false
        }
      }
      return true
    }
    /**
     * A bridge, its items sorted, or where not in KiCad's order: an opening
     * of no copper of its own, the item named with it, the one that collided.
     */
    const report = (pieces: Piece[], position: { x: number; y: number }, sorted = true): void => {
      const subjects = pieces.map((p) => p.subject)
      emit(
        {
          code: 'solder-mask-bridge',
          severity: 'error',
          message: `The ${side === 'F' ? 'front' : 'back'} solder mask between ${subjects.map((s) => s.name).join(' and ')} is too narrow to hold: it bares copper of two nets together.`,
          items: sorted ? subjects.map((s) => s.item).sort() : subjects.map((s) => s.item),
          targets: [...new Set(subjects.flatMap((s) => s.targets))],
          kicadIds: [...new Set(subjects.flatMap(idsOf))],
          subject: subjects.map((s) => s.name).join(' · '),
          position: at(position)
        },
        pieces.map((p) => p.box)
      )
    }

    for (const opening of openings) {
      if (tick()) yield
      if (opening.bareHole) continue
      test(opening, true)
      // An opening over a pour of another net.
      for (const fill of ctx.fills) {
        if (fill.layer !== copper) continue
        if (!boxesTouch(opening.box, fill.box, toCopper + opening.expansion)) continue
        const zoneNet = fill.net
        if (opening.net >= 0 && zoneNet === opening.net && zoneNet > 0) continue
        const clearance = toCopper + opening.expansion
        const { actual } = ctx.shapeToFill(opening.shape, opening.box, fill, clearance)
        if (actual > 0 && actual >= clearance) continue
        const zone: Piece = {
          id: `zone:${fill.zoneIndex}`,
          subject: zoneSubject(fill.zone),
          shape: opening.shape,
          box: fill.box,
          net: zoneNet,
          expansion: 0,
          aperture: false,
          onCopper: true,
          bareHole: false,
          rank: opening.rank,
          rule: () => fill.side
        }
        if (opening.aperture) bare(opening, zone, zoneNet, false, true)
        else report([opening, zone], shapeCenter(opening.shape))
      }
    }
    for (const item of covered) {
      if (tick()) yield
      test(item, false)
    }

    // An opening of no copper of its own bridges once it bares a second net
    // (KiCad's aperture net map): the first positive net it meets is its own;
    // each later item of another net collides, and is named against every
    // bared item of a net other than its own, each pair once.
    for (const [aperture, entries] of bared) {
      const list = [...entries].sort((x, y) => x.rank - y.rank)
      let first: { piece: Piece; net: number } | null = null
      const collisions: typeof list = []
      for (const entry of list) {
        if (first === null || (first.net <= 0 && entry.net > 0)) {
          first = entry
          continue
        }
        if (entry.net === first.net || entry.net <= 0) continue
        // A footprint's own pads of one number or net-tie group bridge nothing.
        if (aperture.fp !== undefined && entry.piece.fp === aperture.fp) {
          if (sameLogicalPad(first.piece, entry.piece)) continue
        }
        collisions.push(entry)
      }
      const reported = new Set<string>()
      for (const c of collisions)
        for (const x of list) {
          if (x.net === c.net || x.net <= 0) continue
          const key = `${x.piece.id}|${c.piece.id}`
          if (reported.has(key)) continue
          reported.add(key)
          reported.add(`${c.piece.id}|${x.piece.id}`)
          report([aperture, x.piece, c.piece], shapeCenter(aperture.shape), false)
        }
    }
  }

  /** A graphic's mask margin: its own, else the board's; never closing a stroke's opening. */
  function shapeMargin(uuid: string | undefined): number {
    const own = uuid ? graphicMargins().get(uuid) : undefined
    return own ?? boardMargin
  }
  function graphicMargins(): Map<string, number> {
    if (margins) return margins
    margins = new Map()
    const read = (raw: unknown): void => {
      const node = raw as Parameters<typeof findChild>[0]
      if (!node || (node as { type?: string }).type !== 'list') return
      const margin = findChild(node, 'solder_mask_margin')
      const uuid = findChild(node, 'uuid')
      if (margin && uuid)
        margins!.set(getAtomValues(uuid)[0] ?? '', Number(getAtomValues(margin)[0]))
    }
    for (const list of [
      board.grLines,
      board.grArcs,
      board.grCircles,
      board.grRects,
      board.grPolys,
      board.grCurves
    ])
      for (const g of list) read((g as { _raw?: unknown })._raw)
    return margins
  }
}

/** Where the walk takes the board's drawings, and then its footprints. */
const DRAWING_RANK = 1e12
/** Before anything: what an opening records on its own turn. */
const OWN_RANK = -1e13
const FOOTPRINT_RANK = 2e12

/** An item's place in the file. */
const rawStart = (item: { _raw?: unknown }): number =>
  (item._raw as { start?: number } | undefined)?.start ?? 0

function boxOf(shape: CopperShape): Box {
  if (shape.kind === 'poly')
    return { minX: shape.minX, minY: shape.minY, maxX: shape.maxX, maxY: shape.maxY }
  const points = shapeOutlines(shape, 0).flat()
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y))
  }
}

function treeOf(pieces: readonly { box: Box }[]): PackedRTree {
  const boxes = new Float64Array(pieces.length * 4)
  pieces.forEach((piece, i) =>
    boxes.set([piece.box.minX, piece.box.minY, piece.box.maxX, piece.box.maxY], i * 4)
  )
  return new PackedRTree(boxes, pieces.length)
}
