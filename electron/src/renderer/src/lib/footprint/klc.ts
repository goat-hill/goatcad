/**
 * KiCad's library conventions (KLC, klc.kicad.org) as far as GoatCAD uses
 * them: the values the official footprint library is drawn to, and the style
 * rules that check them. The numbers are `kicad-library-utils`'
 * `klc-check/rules_footprint/klc_constants.py` and `F5_3.py`.
 *
 * KLC is a style policy for the official library, not correctness: its checks
 * run only as the opt-in style profile (`footprintChecks(fp, { klc: true })`),
 * and the generator's house style (`footprintStyle.ts`) draws to its nominal
 * values. What is an error is KiCad's checker (`footprintChecks.ts`).
 */
import type { KicadFootprint, KicadFontEffects } from '../kicad/footprint'
import { findChild, getFirstAtomValue, type SExprNode } from '../kicad/sexpr'
import { mmToNm, nmToMm, SNAP_EPSILON_NM, type Nm } from '../kicad/coordinates'
import type { CheckResult } from '../schematic/checks'
import { footprintExtents, isCourtyardLayer } from './footprintExtent'
import { shapeBox, unionBox, type Box } from './footprintGeometry'
import { footprintStrokes, padClearanceShape, type Stroke } from './footprintShapes'

// F5.1: silkscreen.
export const KLC_SILK_WIDTH: Nm = mmToNm(0.12)
export const KLC_SILK_WIDTHS_ALLOWED: Nm[] = [mmToNm(0.1), mmToNm(0.12), mmToNm(0.15)]
// F5.2: fabrication.
export const KLC_FAB_WIDTH: Nm = mmToNm(0.1)
// F5.3: courtyard.
export const KLC_COURTYARD_WIDTH: Nm = mmToNm(0.05)
export const KLC_COURTYARD_GRID: Nm = mmToNm(0.01)
export const KLC_COURTYARD_OFFSET = {
  default: mmToNm(0.25),
  /** A part under 2 mm on both sides. */
  miniature: mmToNm(0.15),
  /** Connectors, sockets, buttons and switches. */
  connector: mmToNm(0.5),
  bga: mmToNm(1)
} satisfies Record<string, Nm>
// F5.1 / F5.2: texts. Reference is exactly the nominal; Value may range.
export const KLC_TEXT_SIZE: Nm = mmToNm(1)
export const KLC_TEXT_THICKNESS: Nm = mmToNm(0.15)
export const KLC_TEXT_SIZE_RANGE: [Nm, Nm] = [mmToNm(0.5), mmToNm(1)]
export const KLC_TEXT_THICKNESS_RANGE: [Nm, Nm] = [mmToNm(0.025), mmToNm(0.2)]

/** The style rules, for an agent; each names the KLC rule it checks. */
export const KLC_CHECK_RULES: Record<string, string> = {
  'silk-width':
    'KLC F5.1: library silkscreen is 0.10, 0.12 or 0.15 mm wide (0.12 nominal). A style rule, not a defect.',
  'reference-text':
    'KLC F5.1: the Reference is on F.SilkS, 1.0 × 1.0 mm with a 0.15 mm stroke. A style rule, not a defect.',
  'value-text':
    'KLC F5.2: the Value is on F.Fab or B.Fab, 0.5–1.0 mm with a 0.025–0.2 mm stroke. A style rule, not a defect.',
  'missing-courtyard':
    'KLC F5.3: every footprint has a courtyard, so DRC can keep parts apart. KiCad itself ignores a missing one by default.',
  'courtyard-enclosure': 'KLC F5.3: the courtyard surrounds every pad and the fab outline.',
  'footprint-type-mismatch':
    'KLC F6.1 / F7.1: the placement type matches the pads — through hole when any pad is plated through, SMD otherwise. KiCad itself ignores this by default.'
}

const fmt = (value: Nm): string => `${nmToMm(value)}`

const textOf = (
  fp: KicadFootprint,
  key: 'Reference' | 'Value'
): { layer?: string; effects?: KicadFontEffects; node: SExprNode } | null => {
  const property = fp.properties.find((p) => p.key === key)
  if (property) return { layer: property.layer, effects: property.fontEffects, node: property._raw }
  const text = fp.fpTexts.find((t) => t.type === (key === 'Reference' ? 'reference' : 'value'))
  return text ? { layer: text.layer, effects: text.fontEffects, node: text._raw } : null
}

const within = (value: number | undefined, [min, max]: [Nm, Nm]): boolean =>
  value !== undefined && value >= min && value <= max

/**
 * KiCad's `FOOTPRINT::GetLikelyAttribute`: through hole when any plated hole
 * counts, SMD when only copper SMD pads do. Fiducial, heatsink, castellated and
 * mechanical pads do not count.
 */
export const likelyPlacement = (fp: KicadFootprint): 'through_hole' | 'smd' | null => {
  let smd = 0
  let tht = 0
  for (const pad of fp.pads) {
    const property = padProperty(pad._raw)
    if (property && IGNORED_FOR_PLACEMENT.has(property)) continue
    if (pad.type === 'thru_hole') tht++
    else if (pad.type === 'smd' && pad.layers.some((layer) => layer.endsWith('.Cu'))) smd++
  }
  return tht ? 'through_hole' : smd ? 'smd' : null
}

const IGNORED_FOR_PLACEMENT = new Set([
  'pad_prop_fiducial_glob',
  'pad_prop_fiducial_loc',
  'pad_prop_heatsink',
  'pad_prop_castellated',
  'pad_prop_mechanical'
])

/** A pad's fabrication property (`(property pad_prop_bga)`), read off its node. */
export const padProperty = (node: SExprNode): string | undefined => {
  const property = node.type === 'list' ? findChild(node, 'property') : null
  return property ? getFirstAtomValue(property) : undefined
}

/**
 * The style profile. `targets` names the items to select, as in
 * `footprintChecks`; `itemId` resolves a node to its item id.
 */
export const klcChecks = (
  fp: KicadFootprint,
  itemId: (node: SExprNode) => string | undefined,
  strokes: Stroke[] = footprintStrokes(fp)
): CheckResult[] => {
  const out: CheckResult[] = []
  const targets = (nodes: SExprNode[]): string[] => nodes.flatMap((node) => itemId(node) ?? [])

  for (const stroke of strokes) {
    if (stroke.layer !== 'F.SilkS' && stroke.layer !== 'B.SilkS') continue
    if (stroke.filled && stroke.width === 0) continue
    if (KLC_SILK_WIDTHS_ALLOWED.includes(stroke.width as Nm)) continue
    out.push({
      code: 'silk-width',
      severity: 'warning',
      message: `Silkscreen ${stroke.id} is ${fmt(stroke.width as Nm)} mm wide; KLC allows 0.1, 0.12 or 0.15.`,
      items: [stroke.id],
      targets: targets([stroke.node]),
      subject: `${stroke.layer} ${stroke.kind}`
    })
  }

  const reference = textOf(fp, 'Reference')
  const referenceRight =
    reference?.layer === 'F.SilkS' &&
    reference.effects?.height === KLC_TEXT_SIZE &&
    reference.effects.width === KLC_TEXT_SIZE &&
    reference.effects.thickness === KLC_TEXT_THICKNESS
  if (!referenceRight) {
    const effects = reference?.effects
    out.push({
      code: 'reference-text',
      severity: 'warning',
      message: reference
        ? `Reference is on ${reference.layer ?? 'no layer'} at ${fmt((effects?.height ?? 0) as Nm)} mm with a ${fmt((effects?.thickness ?? 0) as Nm)} mm stroke; KLC puts it on F.SilkS at 1.0 mm with 0.15.`
        : 'The footprint has no Reference.',
      items: ['property:Reference'],
      targets: reference ? targets([reference.node]) : [],
      subject: 'Reference'
    })
  }

  const value = textOf(fp, 'Value')
  const valueRight =
    (value?.layer === 'F.Fab' || value?.layer === 'B.Fab') &&
    within(value.effects?.height, KLC_TEXT_SIZE_RANGE) &&
    within(value.effects?.width, KLC_TEXT_SIZE_RANGE) &&
    within(value.effects?.thickness, KLC_TEXT_THICKNESS_RANGE)
  if (!valueRight) {
    const effects = value?.effects
    out.push({
      code: 'value-text',
      severity: 'warning',
      message: value
        ? `Value is on ${value.layer ?? 'no layer'} at ${fmt((effects?.height ?? 0) as Nm)} mm with a ${fmt((effects?.thickness ?? 0) as Nm)} mm stroke; KLC puts it on a Fab layer at 0.5–1.0 mm with 0.025–0.2.`
        : 'The footprint has no Value.',
      items: ['property:Value'],
      targets: value ? targets([value.node]) : [],
      subject: 'Value'
    })
  }

  const courtyard = strokes.filter((stroke) => isCourtyardLayer(stroke.layer))
  if (fp.pads.length && !courtyard.length && !fp.attributes.includes('allow_missing_courtyard')) {
    out.push({
      code: 'missing-courtyard',
      severity: 'warning',
      message: 'The footprint has no courtyard.',
      items: ['courtyard'],
      targets: [],
      subject: 'F.CrtYd'
    })
  }

  const extents = footprintExtents(fp)
  const box = extents.courtyard
  if (box && fp.pads.length) {
    // Exact pad boxes: `footprintExtents`' pad box is a conservative square.
    const padsBox = fp.pads.reduce<Box | null>(
      (acc, pad) => unionBox(acc, shapeBox(padClearanceShape(pad))),
      null
    )
    const inside = [padsBox, extents.fab]
      .filter((inner) => inner !== null)
      .every(
        (inner) =>
          inner.minX >= box.minX - SNAP_EPSILON_NM &&
          inner.minY >= box.minY - SNAP_EPSILON_NM &&
          inner.maxX <= box.maxX + SNAP_EPSILON_NM &&
          inner.maxY <= box.maxY + SNAP_EPSILON_NM
      )
    if (!inside) {
      out.push({
        code: 'courtyard-enclosure',
        severity: 'warning',
        message: 'The courtyard does not surround every pad and the fab outline.',
        items: courtyard.map((stroke) => stroke.id),
        targets: targets(courtyard.map((stroke) => stroke.node)),
        subject: 'F.CrtYd'
      })
    }
  }

  const likely = likelyPlacement(fp)
  const set = fp.attributes.find((attribute) => attribute === 'smd' || attribute === 'through_hole')
  if (likely && set && likely !== set) {
    out.push({
      code: 'footprint-type-mismatch',
      severity: 'warning',
      message: `The placement type is ${set === 'smd' ? 'SMD' : 'through hole'}, but the pads make it ${likely === 'smd' ? 'SMD' : 'through hole'}.`,
      items: ['attributes'],
      targets: [],
      subject: set === 'smd' ? 'SMD' : 'Through hole'
    })
  }

  return out
}
