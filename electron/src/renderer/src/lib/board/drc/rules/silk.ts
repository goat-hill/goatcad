// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
import { buildBoardOutline, EDGE_CUTS } from '../../../engine/board3d/boardOutline'
import { viaMaskIsOpen } from '../../../kicad/board'
import { padOnLayer } from '../../../kicad/footprint'
import { padProperty } from '../../../footprint/klc'
import { nmToMm } from '../../../kicad/coordinates'
import { footprintTransform, tfPoint } from '../../../schematic/placement'
import { offset, union, type ClipRegion } from '../../../geometry/clip'
import { pointInRegion, type Region } from '../../../geometry/polygon'
import { padHoleShape, padShape, shapeCenter, type CopperShape } from '../../spatialIndex'
import { shapeOutlines } from '../../shapeOutline'
import { shapeEntersRegion } from '../../keepouts'
import { maskSettings, padTouchesLayer, trackMaskMargin } from '../../maskExpansion'
import type { RuleItem, RuleSeverity } from '../../rules/constraints'
import type { DrcContext } from '../context'
import { boxOf, layerPieces, treeOf, type Piece } from '../pieces'
import { DRC_EPSILON, at, between, collides, fmt, ownSeverity, worldOf } from '../shared'

/**
 * The silkscreen rules (`drc_test_provider_silk_clearance.cpp`,
 * `…_solder_mask.cpp`, `…_edge_clearance.cpp`): silk against silk
 * (`silk_overlap`, at the silk clearance), silk crossing a mask opening
 * (`silk_over_copper`: each opening's copper, or — where the board sets a
 * minimum mask web — the whole mask with its narrow webs healed shut), and
 * silk crossing the board edge (`silk_edge_clearance`). Only what lies on the
 * board counts, where the board has an outline. At a clearance of 0 an
 * overlap collides and touching does not, as KiCad's shape collision reads it.
 */
export function* silk(ctx: DrcContext): Generator<void> {
  const { board, layerIndex, ruleSet, emit, pair, tick, padSubject } = ctx
  const outline = buildBoardOutline(board)
  const regions: Region[] = outline.fallback ? [] : outline.regions
  const onBoardCache = new Map<Piece, boolean>()
  /** KiCad's `Collide` with the board's outline polygon: some of it lies on the board. */
  const onBoard = (piece: Piece): boolean => {
    if (regions.length === 0) return true
    let hit = onBoardCache.get(piece)
    if (hit === undefined) {
      hit = regions.some((region) => shapeEntersRegion(piece.shape, region, 1e-6))
      onBoardCache.set(piece, hit)
    }
    return hit
  }
  const { webWidth } = maskSettings(board)
  const worst = ruleSet.resolver.worst('silk_clearance')

  const { pieceOf, padsOn } = layerPieces(ctx)

  /** Item pairs that already collided on an earlier layer pair: KiCad reports a pair once. */
  const collided = new Set<string>()
  const pairKey = (a: Piece, b: Piece): string =>
    a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`

  const silkBySide = new Map<'F' | 'B', Piece[]>()
  for (const side of ['F', 'B'] as const) {
    const layer = `${side}.SilkS`
    const copper = side === 'F' ? 'F.Cu' : 'B.Cu'
    const pieces = [
      ...layerIndex
        .layer(layer)
        .items.filter((item) => item.kind !== 'pad')
        .map(pieceOf)
        .filter((piece): piece is Piece => piece !== null),
      ...padsOn(layer, copper)
    ]
    silkBySide.set(side, pieces)
    const tree = treeOf(pieces)

    // Silk against silk.
    for (let i = 0; i < pieces.length; i++) {
      if (tick()) yield
      const a = pieces[i]
      tree.search(
        a.box.minX - worst,
        a.box.minY - worst,
        a.box.maxX + worst,
        a.box.maxY + worst,
        (j) => {
          if (j <= i) return
          const b = pieces[j]
          if (a.graphic && b.graphic && a.fp === b.fp) return
          const resolved = ruleSet.resolver.evaluate('silk_clearance', a.rule, b.rule, layer)
          if (resolved.isNull || resolved.severity === 'ignore') return
          const min = resolved.value.min ?? 0
          if (min < 0 || !(onBoard(a) || onBoard(b))) return
          if (!collides(a.shape, b.shape, min)) return
          collided.add(pairKey(a, b))
          emit(
            {
              code: 'silk-overlap',
              severity: 'warning',
              message:
                min > 0
                  ? `${a.subject.name} and ${b.subject.name} are closer than ${resolved.name}'s ${fmt(min)}.`
                  : `${a.subject.name} overlaps ${b.subject.name}.`,
              position: at(between(a.shape, b.shape)),
              ...pair(a.subject, b.subject),
              ...ownSeverity(resolved.severity)
            },
            [a.box, b.box]
          )
        }
      )
    }

    // Silk against the mask: each opening, or the mask whole where narrow webs heal.
    const maskLayer = `${side}.Mask`
    if (webWidth <= 0) {
      for (const opening of maskOpenings(maskLayer, copper)) {
        if (tick()) yield
        if (!onBoard(opening)) continue
        tree.search(
          opening.box.minX - worst,
          opening.box.minY - worst,
          opening.box.maxX + worst,
          opening.box.maxY + worst,
          (j) => {
            const s = pieces[j]
            if (s.id === opening.id || collided.has(pairKey(s, opening))) return
            if (s.graphic && opening.graphic && s.fp === opening.fp) return
            const resolved = ruleSet.resolver.evaluate(
              'silk_clearance',
              s.rule,
              opening.rule,
              maskLayer
            )
            if (resolved.severity === 'ignore') return
            const min = Math.max(resolved.isNull ? -1 : (resolved.value.min ?? 0), 0)
            if (!collides(s.shape, opening.shape, min)) return
            emit(
              {
                code: 'silk-over-copper',
                severity: 'warning',
                message: `${s.subject.name} is clipped by the mask opening of ${opening.subject.name}.`,
                position: at(between(s.shape, opening.shape)),
                ...pair(s.subject, opening.subject),
                ...ownSeverity(resolved.severity)
              },
              [s.box, opening.box]
            )
          }
        )
      }
    } else {
      const healed = healedMask(maskLayer)
      for (const s of pieces) {
        if (tick()) yield
        const resolved = ruleSet.resolver.evaluate('silk_clearance', s.rule, null, maskLayer)
        const min = resolved.isNull ? 0 : (resolved.value.min ?? 0)
        if (resolved.severity === 'ignore' || min < 0) continue
        const hit = healed.find((region) =>
          shapeEntersRegion(s.shape, region, min > 0 ? -min : 1e-6)
        )
        if (!hit) continue
        ctx.one(
          'silk-over-copper',
          'warning',
          `${s.subject.name} is clipped by the solder mask.`,
          s.subject,
          shapeCenter(s.shape),
          [s.box],
          resolved.severity
        )
      }
    }
  }

  /**
   * What opens the mask on a layer, each at its copper as KiCad's silk check
   * reads it — pads, untented vias, tracks the file opens — and what is drawn
   * on the mask layer itself.
   */
  function maskOpenings(layer: string, copper: 'F.Cu' | 'B.Cu'): Piece[] {
    const out: Piece[] = []
    const side = copper === 'F.Cu' ? 'front' : 'back'
    board.footprints.forEach((bfp, fp) => {
      const tf = footprintTransform(bfp)
      bfp.footprint.pads.forEach((pad, index) => {
        if (!padTouchesLayer(pad, layer)) return
        const center = tfPoint(tf, pad.position.x, pad.position.y)
        const shape = padShape(padOnLayer(pad, copper), center)
        out.push({
          id: `pad:${fp}:${index}`,
          shape,
          box: boxOf(shape),
          subject: padSubject(bfp, pad, center),
          rule: ruleSet.padItem(fp, index),
          graphic: false,
          fp
        })
      })
    })
    board.vias.forEach((via, i) => {
      if (!via.layers.includes(copper) || !viaMaskIsOpen(via, side, board.tenting)) return
      const item = ctx.itemByRef.get(`via:${i}`)
      if (!item) return
      const p = worldOf(via.position)
      const shape: CopperShape = { kind: 'circle', cx: p.x, cy: p.y, r: nmToMm(via.size) / 2 }
      out.push({
        id: `via::${i}:`,
        shape,
        box: boxOf(shape),
        subject: ctx.subjectOfItem(item)!,
        rule: ruleSet.copperItem(item),
        graphic: false
      })
    })
    for (const [list, kind] of [
      [board.segments, 'segment'],
      [board.trackArcs, 'tarc']
    ] as const)
      list.forEach((track, i) => {
        if (track.layer !== copper || trackMaskMargin(board, track) === null) return
        const item = ctx.itemByRef.get(`${kind}:${i}`)
        if (!item) return
        out.push({
          id: `track::${i}:${kind === 'tarc' ? 'arc' : ''}`,
          shape: item.shape,
          box: item,
          subject: ctx.subjectOfItem(item)!,
          rule: ruleSet.copperItem(item),
          graphic: false
        })
      })
    for (const item of layerIndex.layer(layer).items) {
      if (item.kind === 'pad' || item.kind === 'via' || item.kind === 'track') continue
      const piece = pieceOf(item)
      if (piece) out.push(piece)
    }
    return out
  }

  /**
   * The mask as KiCad heals it (`m_SolderMaskBridges`): every opening at its
   * margin, grown by half the minimum web, joined, and shrunk back — so two
   * openings closer than the web become one.
   */
  function healedMask(layer: string): Region[] {
    const half = nmToMm(webWidth) / 2
    const pieces: ClipRegion[] = layerIndex
      .layer(layer)
      .items.flatMap((item) => shapeOutlines(item.shape, half))
      .filter((ring) => ring.length >= 3)
      .map((outer) => ({ outer, holes: [] }))
    const joined = union(pieces, [])
    return offset(joined, -half, { join: 'miter' })
  }

  // Silk against the board edge: each silk item once, at the first edge it crosses.
  const edgeRule: RuleItem = {
    kind: 'graphic',
    label: 'Edge.Cuts',
    layers: [EDGE_CUTS],
    nonCopper: true
  }
  const edges: Array<Piece & { slot: boolean }> = [
    ...layerIndex.layer(EDGE_CUTS).items.map((item) => ({
      id: `edge:${item.id}`,
      shape: item.shape,
      box: { minX: item.minX, minY: item.minY, maxX: item.maxX, maxY: item.maxY },
      subject: {
        item: ctx.drawingId(item.uuid, item.fp) ?? EDGE_CUTS,
        name: 'the board edge',
        targets: []
      },
      rule: edgeRule,
      graphic: true,
      slot: false
    })),
    ...layerIndex
      .layer('Margin')
      .items.filter((item) => item.kind === 'graphic')
      .map((item) => ({
        id: `margin:${item.id}`,
        shape: item.shape,
        box: { minX: item.minX, minY: item.minY, maxX: item.maxX, maxY: item.maxY },
        subject: {
          item: ctx.drawingId(item.uuid, item.fp) ?? EDGE_CUTS,
          name: 'the board margin',
          targets: []
        },
        rule: { ...edgeRule, layers: ['Margin'] },
        graphic: true,
        slot: false
      })),
    ...slots()
  ]
  const edgeTree = treeOf(edges)
  const edgeReach = Math.max(worst, 0)
  for (const side of ['F', 'B'] as const) {
    for (const s of silkBySide.get(side) ?? []) {
      if (tick()) yield
      // The edge checks pass over castellated and edge-connector pads whole.
      if (s.pad && (s.pad.type === 'connect' || padProperty(s.pad._raw) === 'pad_prop_castellated'))
        continue
      let found: {
        edge: Piece & { slot: boolean }
        min: number
        rule: string
        severity?: RuleSeverity
      } | null = null
      edgeTree.search(
        s.box.minX - edgeReach,
        s.box.minY - edgeReach,
        s.box.maxX + edgeReach,
        s.box.maxY + edgeReach,
        (j) => {
          if (found) return
          const edge = edges[j]
          const resolved = ruleSet.resolver.evaluate('silk_clearance', edge.rule, s.rule, null)
          if (resolved.severity === 'ignore') return
          const min = resolved.isNull ? 0 : (resolved.value.min ?? 0)
          if (min < 0) return
          if (!collides(s.shape, edge.shape, Math.max(0, min - DRC_EPSILON))) return
          // A pad's copper meets the edge first, and KiCad reports an item, an
          // edge and a point once: the copper finding stands for the silk one.
          if (s.pad && !s.rule.nonCopper) {
            const copper = ruleSet.resolver.evaluate('edge_clearance', edge.rule, s.rule, null)
            const copperMin = copper.isNull ? 0 : (copper.value.min ?? 0)
            if (
              copper.severity !== 'ignore' &&
              collides(s.shape, edge.shape, Math.max(0, copperMin - DRC_EPSILON))
            )
              return
          }
          found = { edge, min, rule: resolved.name, severity: resolved.severity }
        }
      )
      const hit = found as {
        edge: Piece & { slot: boolean }
        min: number
        rule: string
        severity?: RuleSeverity
      } | null
      if (hit) {
        emit(
          {
            code: 'silk-edge-clearance',
            severity: 'warning',
            message:
              hit.min > 0
                ? `${s.subject.name} is closer to ${hit.edge.subject.name} than ${hit.rule}'s ${fmt(hit.min)}.`
                : `${s.subject.name} crosses ${hit.edge.subject.name}, where the fab clips it.`,
            position: at(between(s.shape, hit.edge.shape)),
            items: hit.edge.slot
              ? pair(s.subject, hit.edge.subject).items
              : [hit.edge.subject.item, s.subject.item],
            targets: s.subject.targets,
            kicadIds: s.subject.ids ?? s.subject.targets,
            subject: s.subject.name,
            ...ownSeverity(hit.severity)
          },
          [s.box]
        )
        continue
      }
      // A drawing whose pieces lie both on and off the board crosses the edge
      // between them, whether or not a stroke meets it.
      if (regions.length === 0 || s.shape.kind !== 'compound') continue
      const inside = s.shape.parts.map((part) =>
        regions.some((region) => pointInRegion(shapeCenter(part), region))
      )
      if (inside.every(Boolean) || !inside.some(Boolean)) continue
      ctx.one(
        'silk-edge-clearance',
        'warning',
        `${s.subject.name} crosses the board edge, where the fab clips it.`,
        s.subject,
        shapeCenter(s.shape),
        [s.box]
      )
    }
  }

  /** Unplated slots, which a fab mills as edge. */
  function slots(): Array<Piece & { slot: boolean }> {
    const out: Array<Piece & { slot: boolean }> = []
    board.footprints.forEach((bfp, fp) => {
      const tf = footprintTransform(bfp)
      bfp.footprint.pads.forEach((pad, index) => {
        const drill = pad.drill
        if (pad.type !== 'np_thru_hole' || !drill?.oval) return
        if (drill.oval.width === drill.oval.height) return
        const center = tfPoint(tf, pad.position.x, pad.position.y)
        const shape = padHoleShape(pad, center)
        if (!shape) return
        out.push({
          id: `pad:${fp}:${index}`,
          shape,
          box: boxOf(shape),
          subject: padSubject(bfp, pad, center),
          rule: ruleSet.padItem(fp, index),
          graphic: false,
          slot: true
        })
      })
    })
    return out
  }
}
