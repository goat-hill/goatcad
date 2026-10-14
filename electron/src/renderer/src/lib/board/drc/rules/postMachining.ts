import type { KicadBoard } from '../../../kicad/board'
import type { KicadHoleMachining, KicadPostMachining } from '../../../kicad/footprint'
import { itemsConnect } from '../../boardConnectivity'
import { stackupHeights } from '../../netLength'
import { pointToShape, type CopperItem } from '../../spatialIndex'
import type { DrcContext } from '../context'
import { at, worldOf } from '../shared'

/**
 * A track joined to a pad or via on a layer its hole is machined away on
 * (`track_on_post_machined_layer`, an error): a backdrill or tertiary drill
 * boring out a run of copper layers, or a counterbore or countersink milled
 * into the hole from one face, deep enough to reach the layer. The track's
 * connection there is drilled off the board. Once per track.
 *
 * Depth is measured as KiCad's `BOARD_STACKUP::GetLayerDistance` measures it
 * (`stackupHeights`). A backdrill's layers count by their place in the copper stack. KiCad
 * numbers inner layers from 3 (`PAD::IsBackdrilledOrPostMachined`), so on a
 * board where B.Cu shares an inner layer's number its range can take in one
 * layer more than it bores; here it takes the layers it bores.
 */
export function* postMachining(ctx: DrcContext): Generator<void> {
  const { board, copperLayers, emit, pair, subjectOfItem, itemsFrom, index, tick } = ctx
  // Most boards machine no hole at all.
  if (
    !board.vias.some((via) => via.machining) &&
    !board.footprints.some((bfp) => bfp.footprint.pads.some((pad) => pad.machining))
  )
    return
  const machined = postMachinedOn(board, copperLayers)
  const tracks = itemsFrom(0)
    .filter((item) => item.ref.type === 'segment' || item.ref.type === 'tarc')
    .sort((a, b) => a.id - b.id)
  for (const track of tracks) {
    if (tick()) yield
    const layer = track.layers[0]
    if (!layer) continue
    const hit = index
      .query(track.minX, track.minY, track.maxX, track.maxY)
      .filter((other) => other.ref.type === 'pad' || other.ref.type === 'via')
      .sort((a, b) => a.id - b.id)
      .find((other) => machined(other, layer) && itemsConnect(board, track, other).includes(layer))
    if (!hit) continue
    const t =
      track.ref.type === 'segment'
        ? board.segments[track.ref.index]
        : board.trackArcs[track.ref.index]
    const [start, end] = [worldOf(t.start), worldOf(t.end)]
    const position =
      pointToShape(hit.shape, start.x, start.y) <= 0
        ? start
        : pointToShape(hit.shape, end.x, end.y) <= 0
          ? end
          : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    const a = subjectOfItem(track)!
    const b = subjectOfItem(hit)!
    emit(
      {
        code: 'track-on-post-machined-layer',
        severity: 'error',
        message: `${a.name} connects to ${b.name} on ${layer}, where its hole is backdrilled or post-machined away.`,
        position: at(position),
        ...pair(a, b)
      },
      [track, hit]
    )
  }
}

const machiningOf = (board: KicadBoard, item: CopperItem): KicadHoleMachining | undefined =>
  item.ref.type === 'via'
    ? board.vias[item.ref.index]?.machining
    : item.ref.type === 'pad'
      ? board.footprints[item.ref.index]?.footprint.pads[item.ref.pad]?.machining
      : undefined

/**
 * Whether a pad's or via's hole is machined away on a copper layer: within a
 * backdrill's run of layers, or within a post-machining's depth of its face.
 */
export function postMachinedOn(
  board: KicadBoard,
  copperLayers: readonly string[]
): (item: CopperItem, layer: string) => boolean {
  // Depth is measured through the board's own stackup; with none, KiCad's
  // stackup is empty and every layer lies at no depth, so a machining reaches all.
  const heights = board.stackup ? stackupHeights(board) : () => 0
  const ordinal = (layer: string): number => copperLayers.indexOf(layer)
  const bores = (run: { layers: [string, string] } | undefined, layer: string): boolean => {
    if (!run) return false
    const [a, b, l] = [ordinal(run.layers[0]), ordinal(run.layers[1]), ordinal(layer)]
    return a >= 0 && b >= 0 && l >= Math.min(a, b) && l <= Math.max(a, b)
  }
  const reaches = (pm: KicadPostMachining | undefined, face: string, layer: string): boolean => {
    if (!pm || !pm.size || pm.size <= 0 || !copperLayers.includes(face)) return false
    let depth = pm.depth ?? 0
    // A countersink with no depth of its own goes as deep as its cone.
    if (depth <= 0 && pm.mode === 'countersink' && pm.angle && pm.angle > 0)
      depth = Math.trunc(pm.size / 2 / Math.tan((pm.angle * Math.PI) / 360))
    return depth > 0 && heights(face, layer) < depth
  }
  return (item, layer) => {
    const machining = machiningOf(board, item)
    if (!machining || !copperLayers.includes(layer)) return false
    return (
      (!!machining.backdrill &&
        machining.backdrill.size > 0 &&
        bores(machining.backdrill, layer)) ||
      (!!machining.tertiaryDrill &&
        machining.tertiaryDrill.size > 0 &&
        bores(machining.tertiaryDrill, layer)) ||
      reaches(machining.frontPostMachining, 'F.Cu', layer) ||
      reaches(machining.backPostMachining, 'B.Cu', layer)
    )
  }
}
