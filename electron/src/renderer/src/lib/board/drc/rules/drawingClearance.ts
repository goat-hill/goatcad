// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
import { pointToShape, shapeToShape, type CopperItem } from '../../spatialIndex'
import { type DrawingItem } from '../../drawingItems'
import type { DrcContext } from '../context'
import {
  DRC_EPSILON,
  PAD_TESTED,
  fmt,
  at,
  idsOf,
  ownSeverity,
  type Copper,
  type Hole,
  between
} from '../shared'

export function* drawingClearance(ctx: DrcContext): Generator<void> {
  const {
    reaches,
    emit,
    netName,
    pair,
    copperOf,
    maxClearance,
    drawingSet,
    drawings,
    copperNear,
    sideOf,
    requiredClearance,
    holesOf,
    copperOn,
    groupsOf,
    tieNets,
    holeOwner,
    requiredHoleClearance,
    board,
    index,
    tick
  } = ctx
  // KiCad tests a drawing from three sides (`drc_test_provider_copper_clearance.cpp`):
  // every track and via against every drawing; a pad against text, fields,
  // tables, cells and dimensions (never a short, as they have no net there),
  // but not against a graphic or text box; a graphic against pads and other
  // drawings. Only a graphic seeks out other drawings, so text never meets
  // text, nor two graphics of one footprint, nor two drawings neither of which
  // has a net. A footprint's table is not in DRC's copper index at all, only
  // the zones meet it. Which is reported when copper
  // touches follows KiCad's order by uuid: a short when the later item has a
  // net, else a clearance. A pair that fails its clearance is not tested for
  // hole clearance too, as KiCad stops at its first error.
  {
    /** KiCad's `IsConnected`: tracks, vias, pads, board graphics, text boxes and cells have a net, even 0. */
    const netOf = (item: CopperItem): number | null => {
      const d = drawingSet.byId(item.id)
      return d && !d.netted ? null : item.net
    }
    const kicadId = (c: Copper): string => idsOf(c.subject)[0] ?? c.subject.item
    /**
     * KiCad's `IsNetTieExclusion` for a hole: its center on a pad of the
     * drawing's net-tie footprint that is in a group and has the hole's net.
     */
    const onOwnTiedPad = (d: DrawingItem, hole: Hole, layer: string): boolean => {
      if (d.fp === undefined || hole.net <= 0) return false
      const groups = groupsOf(d.fp)
      if (groups.size === 0) return false
      const pads = board.footprints[d.fp].footprint.pads
      const { x, y } = hole.center
      return index
        .query(x, y, x, y)
        .some(
          (item) =>
            item.ref.type === 'pad' &&
            item.ref.index === d.fp &&
            item.net === hole.net &&
            item.layers.includes(layer) &&
            groups.has(pads[item.ref.pad].number) &&
            pointToShape(item.shape, x, y) <= DRC_EPSILON
        )
    }
    const drawingReach = maxClearance + 1e-6
    for (const d of drawings) {
      if (tick()) yield
      if (!d.inCopperTree || !reaches(d, drawingReach)) continue
      const a = copperOf.get(d.id)!
      const layer = d.layers[0]
      const graphic = d.drawing === 'graphic'
      // What a pad tests from its own side: never a short, and no hole test after.
      const padSide = PAD_TESTED.has(d.drawing)
      const near = copperNear(
        d.minX - drawingReach,
        d.minY - drawingReach,
        d.maxX + drawingReach,
        d.maxY + drawingReach
      )
      for (const other of near) {
        if (other.id === d.id) continue
        const b = copperOf.get(other.id)!
        const e = drawingSet.byId(other.id)
        const pad = other.ref.type === 'pad'
        // Neither a pad nor a text box seeks the other out.
        if (pad && d.drawing === 'textbox') continue
        if (e) {
          // Two drawings: from a graphic's side, each pair once.
          if (!graphic || !e.inCopperTree) continue
          // From the first graphic: a region run starts from every drawing within
          // reach of the region, so a pair that meets it always has its first there too.
          if (e.drawing === 'graphic' && other.id < d.id) continue
          if (e.drawing === 'graphic' && d.fp !== undefined && d.fp === e.fp) continue
        }
        const dNet = netOf(d)
        const oNet = netOf(other)
        // Same net: the pair is dropped before any test, but for no net at all.
        const sameNet = dNet === oNet
        if (sameNet && dNet !== null && (dNet > 0 || other.ref.type !== 'pad')) continue
        const ties = d.fp !== undefined && oNet !== null && tieNets(d, false).has(oNet)
        const ownTiedPad =
          pad &&
          b.footprint === d.fp &&
          b.padNumber !== null &&
          groupsOf(b.footprint!).has(b.padNumber)
        const copper = b.copper ? copperOn(other, layer) : null
        let failed = false
        if (!sameNet && !ties && !(ownTiedPad && graphic) && copper) {
          const required = requiredClearance(sideOf(a), sideOf(b), layer)
          const actual = required.value > 0 ? shapeToShape(d.shape, copper.shape) : Infinity
          if (
            required.value > 0 &&
            required.severity !== 'ignore' &&
            !(actual > 0 && actual >= required.value - DRC_EPSILON)
          ) {
            failed = true
            const later = kicadId(a) > kicadId(b) ? d : other
            const short = actual === 0 && !(pad && padSide) && netOf(later) !== null
            emit(
              {
                code: short ? 'copper-short' : 'copper-clearance',
                severity: 'error',
                ...ownSeverity(required.severity),
                message: short
                  ? `${a.subject.name} and ${b.subject.name} touch (nets ${netName(d.net) || '(none)'} and ${netName(other.net) || '(none)'}).`
                  : `${a.subject.name} and ${b.subject.name} are ${fmt(actual)} apart; ${required.rule} needs ${fmt(required.value)}.`,
                ...(short
                  ? { detail: `${netName(d.net) || '(none)'} · ${netName(other.net) || '(none)'}` }
                  : {
                      measure: {
                        actual,
                        limit: required.value,
                        bound: 'min' as const,
                        unit: 'mm' as const,
                        rule: required.rule
                      }
                    }),
                position: at(between(d.shape, copper.shape)),
                ...pair(a.subject, b.subject)
              },
              [d, other]
            )
          }
        }
        if (failed || (pad && padSide)) continue
        // Nothing may sit in a hole, at any clearance: a via's where it spans
        // the layer, a pad's.
        for (const hole of holesOf.get(other.id) ?? []) {
          if (!hole.layers.includes(layer)) continue
          if (onOwnTiedPad(d, hole, layer)) continue
          const required = requiredHoleClearance(holeOwner(hole), sideOf(a), layer)
          if (required.severity === 'ignore') continue
          const actual = shapeToShape(hole.shape, d.shape)
          if (actual > 0 && actual >= required.value - DRC_EPSILON) continue
          emit(
            {
              code: 'hole-clearance',
              severity: 'error',
              ...ownSeverity(required.severity),
              message: `The hole of ${hole.subject.name} is ${fmt(actual)} from ${a.subject.name}; ${required.rule} needs ${fmt(required.value)}.`,
              measure: {
                actual,
                limit: required.value,
                bound: 'min',
                unit: 'mm',
                rule: required.rule
              },
              position: at(between(hole.shape, d.shape)),
              ...pair(a.subject, hole.subject)
            },
            [d, other, hole.box]
          )
          break
        }
      }
    }
  }
}
