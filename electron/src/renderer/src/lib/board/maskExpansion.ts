/**
 * How far the solder mask opens round a pad, via or track, and how far the
 * paste stencil opens round a pad — KiCad 10's rules
 * (`PAD::GetSolderMaskExpansion`, `PAD::GetSolderPasteMargin`,
 * `PCB_VIA::IsTented`, `PCB_TRACK::GetSolderMaskExpansion`), for the Gerber
 * writer, the 3D board and the layer index alike.
 *
 * - **Mask:** a custom rule's `solder_mask_expansion`, when the project has
 *   one; else the pad's own margin, its footprint's, the board's. Never so
 *   negative that the opening closes: at most half the pad's smaller side.
 * - **Paste:** a custom rule's `solder_paste_abs_margin`, else the pad's,
 *   footprint's or board's margin, plus its ratio of the pad's size on each
 *   axis. Clamped the same way, but for a custom pad. Only a pad with copper
 *   has either; one on mask or paste alone is its own size.
 * - **Vias** open the mask where they are not tented, by the board's margin.
 * - **Tracks** open it where the file says (`(layers "F.Cu" "F.Mask")`), by
 *   their own margin, else the board's, never below half their width.
 *
 * Rules are read for pads only, and not a rule's relative paste margin: KiCad
 * keeps it scaled by a thousand internally, and no board in its corpus sets one.
 */
import type { KicadBoard, KicadTrackArc, KicadTrackSegment } from '../kicad/board'
import { padOnLayer, type KicadPad } from '../kicad/footprint'
import { expandLayerToken, isCopperLayer } from '../kicad/layers'
import { mmAtomToNm, mmToNm, type Nm } from '../kicad/coordinates'
import { findChild, getFirstAtomValue } from '../kicad/sexpr'
import type { BoardRules } from './rules/boardRules'

/** Whether a pad is on a layer, its tokens (`*.Cu`, `*.Mask`, `F&B.Cu`) expanded. */
export function padTouchesLayer(pad: KicadPad, layer: string): boolean {
  return pad.layers.some((l) => {
    // `*.Cu` is every copper layer the board has, whatever its stackup.
    if (l === '*.Cu') return isCopperLayer(layer)
    return expandLayerToken(l).includes(layer)
  })
}

/** A pad has copper somewhere: only then does it take a margin. */
const hasCopper = (pad: KicadPad): boolean =>
  pad.layers.some((layer) => layer === '*.Cu' || layer === 'F&B.Cu' || isCopperLayer(layer))

/** The outer copper on a mask or paste layer's side. */
const copperSide = (layer: string): 'F.Cu' | 'B.Cu' => (layer.startsWith('B.') ? 'B.Cu' : 'F.Cu')

/** A rule's value for the pad, in nm, when the project's rules set one. */
const ruled = (
  rules: BoardRules | undefined,
  type: 'solder_mask_expansion' | 'solder_paste_abs_margin',
  fp: number,
  pad: number,
  layer: string
): Nm | undefined => {
  if (!rules?.resolver.hasRules(type)) return undefined
  const opt = rules.resolver.evaluate(type, rules.padItem(fp, pad), null, layer).value.opt
  return opt === undefined ? undefined : mmToNm(opt)
}

/** The mask opening's margin round a pad on `F.Mask` or `B.Mask`, nm. */
export function padMaskMargin(
  board: KicadBoard,
  fp: number,
  padIndex: number,
  layer: string,
  rules?: BoardRules
): Nm {
  const footprint = board.footprints[fp].footprint
  const pad = footprint.pads[padIndex]
  if (!hasCopper(pad)) return 0 as Nm
  const margin =
    ruled(rules, 'solder_mask_expansion', fp, padIndex, layer) ??
    pad.solderMaskMargin ??
    footprint.solderMaskMargin ??
    board.padToMaskClearance
  if (margin >= 0) return margin
  const { w, h } = padOnLayer(pad, copperSide(layer)).size
  return Math.max(margin, -Math.trunc(Math.min(w, h) / 2)) as Nm
}

/** The paste opening's margin round a pad on `F.Paste` or `B.Paste`, per axis, nm. */
export function padPasteMargin(
  board: KicadBoard,
  fp: number,
  padIndex: number,
  layer: string,
  rules?: BoardRules
): { x: Nm; y: Nm } {
  const footprint = board.footprints[fp].footprint
  const pad = footprint.pads[padIndex]
  if (!hasCopper(pad)) return { x: 0 as Nm, y: 0 as Nm }
  const margin =
    ruled(rules, 'solder_paste_abs_margin', fp, padIndex, layer) ??
    pad.solderPasteMargin ??
    footprint.solderPasteMargin ??
    board.padToPasteClearance
  const ratio =
    pad.solderPasteMarginRatio ?? footprint.solderPasteMarginRatio ?? board.padToPasteClearanceRatio
  const onLayer = padOnLayer(pad, copperSide(layer))
  const axis = (size: Nm): Nm => {
    const value = margin + Math.round(size * ratio)
    return (onLayer.shape === 'custom' ? value : Math.max(value, -size / 2)) as Nm
  }
  return { x: axis(onLayer.size.w), y: axis(onLayer.size.h) }
}

/** The mask opening's margin round an untented via: the board's. */
export const viaMaskMargin = (board: KicadBoard): Nm => board.padToMaskClearance

/** The mask opening's margin round a track the file opens, nm; null where it is covered. */
export function trackMaskMargin(
  board: KicadBoard,
  track: KicadTrackSegment | KicadTrackArc
): Nm | null {
  if (!track.mask) return null
  const margin = track.mask.margin ?? board.padToMaskClearance
  return Math.max(margin, -track.width / 2) as Nm
}

/**
 * The board setup's mask rules (`(setup …)`): the minimum web between two
 * openings, which heals narrower ones shut; how far copper must keep from an
 * opening it does not belong to; and whether a footprint's own openings may
 * bridge.
 */
export function maskSettings(board: KicadBoard): {
  webWidth: Nm
  toCopper: Nm
  bridgesInFootprints: boolean
} {
  const setup = board._raw.type === 'list' ? findChild(board._raw, 'setup') : null
  const value = (token: string): string | undefined => {
    const node = setup ? findChild(setup, token) : null
    return node ? getFirstAtomValue(node) : undefined
  }
  const nm = (token: string): Nm => {
    const atom = value(token)
    return atom === undefined ? (0 as Nm) : mmAtomToNm(atom)
  }
  return {
    webWidth: nm('solder_mask_min_width'),
    toCopper: nm('solder_mask_to_copper_clearance'),
    bridgesInFootprints: value('allow_soldermask_bridges_in_footprints') === 'yes'
  }
}
