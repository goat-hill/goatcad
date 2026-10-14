// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * The board checks: KiCad's DRC over the copper the spatial index holds, the
 * drawings beside it, the holes it does not, and the courtyards and outline
 * the layer index holds (`pcbnew/drc/drc_test_provider_*.cpp`). Any
 * difference from KiCad is a bug unless kicad-parity.md lists it;
 * the rules not run yet (silkscreen, mask, library parity) are listed there too.
 *
 * Pure: `(board, index, connectivity, design settings) → CheckResult[]`, at
 * the project's `rule_severities` (KiCad's defaults where it sets none), with
 * the findings its KiCad exclusions name marked `excluded`, run
 * cooperatively (`boardChecksSteps`) so a large board never blocks input.
 * Results use the sheet checks' shape (`schematic/checks.ts`); positions are
 * board millimeters, y down, as the file and KiCad's own report have them.
 * Geometry is the index's world: millimeters, y up.
 */
import type { KicadBoard } from '../kicad/board'
import type { BoardDesignSettings } from '../kicad/project'
import { applySeverities, type RuleOf } from '../ruleSeverity'
import { applyExclusions } from '../kicadExclusions'
import type { CheckResult } from '../schematic/checks'
import type { BoardSpatialIndex } from './spatialIndex'
import type { BoardConnectivity } from './boardConnectivity'
import { checkBoard, type BoardCheckRun, type BoardEdit, type CheckPhase } from './drc/incremental'
import { byCodeThenItems } from './drc/shared'
import type { BoardLibraries } from './boardLibraries'
import type { SchematicNetlist } from './schematicNetlist'

/** The rules, for an agent; each names the KiCad violation it matches. */
export const BOARD_CHECK_RULES: Record<string, string> = {
  'custom-rules':
    "The project's custom rules file has an error, so none of its rules apply (KiCad sets the file aside the same way). The finding quotes the error; fix it in the .kicad_dru.",
  'copper-clearance':
    'Two pieces of copper on different nets are closer than their clearance (KiCad clearance) — tracks, pads, vias, or a zone fill that has gone stale. Move or reroute one, or refill; the finding gives the gap and the rule.',
  'copper-short':
    'Copper of two nets touches (KiCad shorting_items). Reroute so the nets no longer meet.',
  'tracks-crossing': 'Two tracks of different nets cross on one layer (KiCad tracks_crossing).',
  'track-on-post-machined-layer':
    'A track joins a pad or via on a layer its hole is backdrilled or post-machined away on (KiCad track_on_post_machined_layer), so the connection is drilled off. Route it on a layer the hole keeps, or shorten the backdrill.',
  'hole-clearance':
    'A drilled hole is closer to copper of another net than the hole clearance (KiCad hole_clearance).',
  'holes-too-close':
    'Two drilled holes are closer than the minimum hole-to-hole spacing (KiCad hole_to_hole, a warning): the drill breaks out between them.',
  'holes-co-located': 'Two drilled holes sit at one point (KiCad holes_co_located, a warning).',
  'copper-edge-clearance':
    'Copper is closer to the board edge than the edge clearance (KiCad copper_edge_clearance).',
  'unconnected-items':
    'Two items on one net are not joined by copper (KiCad unconnected_items): a ratsnest line still spans them. Route it.',
  'track-width': 'A track is narrower than the minimum track width (KiCad track_width).',
  'via-diameter': 'A via is smaller than the minimum via diameter (KiCad via_diameter).',
  'annular-width':
    'A via or plated pad leaves less copper around its hole than the minimum annular width (KiCad annular_width).',
  'drill-out-of-range':
    'A hole is smaller than the minimum drill the fab can make (KiCad drill_out_of_range).',
  'microvia-drill-out-of-range':
    'A microvia hole is smaller than the minimum microvia drill (KiCad microvia_drill_out_of_range).',
  'courtyards-overlap': 'Two footprint courtyards overlap (KiCad courtyards_overlap).',
  'pth-inside-courtyard':
    "A plated hole lies inside another footprint's courtyard (KiCad pth_inside_courtyard).",
  'npth-inside-courtyard':
    "An unplated hole lies inside another footprint's courtyard (KiCad npth_inside_courtyard).",
  'malformed-courtyard':
    'A courtyard outline does not close (KiCad malformed_courtyard); ends within 0.02 mm join. Close it, or remove the stray stroke.',
  'invalid-outline':
    'The Edge.Cuts outline does not form a closed shape (KiCad invalid_outline), so the board has no edge to check against.',
  'zones-intersect':
    'Two zones of one net overlap at the same priority (KiCad zones_intersect), so which one fills the overlap is undefined. Give one a higher priority.',
  'isolated-copper':
    "A zone island reaches no copper of its net (KiCad isolated_copper, a warning): dead copper the zone's island setting kept. Remove islands, or connect it.",
  'starved-thermal':
    "A pad joins its net's zone by fewer thermal spokes than the minimum (KiCad starved_thermal). Clear what blocks the spokes, or connect the pad with a track.",
  'track-dangling':
    'A track has an end that connects to nothing (KiCad track_dangling, a warning): a stub left from routing. Delete it or finish the route.',
  'via-dangling':
    'A via connects to nothing, or on one layer only (KiCad via_dangling, a warning), so it joins nothing. Delete it or route to it.',
  'items-not-allowed':
    "A track, via, pad, footprint or pour lies in a keepout area that forbids it (KiCad items_not_allowed) — the board's own, or one a footprint carries, like a module's antenna keepout. Move it out, or refill the pour.",
  'text-height':
    'A text is shorter (or taller) than the rules allow on its layer (KiCad text_height, a warning); silkscreen text below the minimum does not print legibly. Resize it.',
  'text-thickness':
    'A text is stroked thinner (or thicker) than the rules allow on its layer (KiCad text_thickness, a warning). Thicken the stroke.',
  'mirrored-text-on-front':
    'A text on a front layer is mirrored, so it reads backwards (KiCad mirrored_text_on_front_layer, a warning). Un-mirror it.',
  'nonmirrored-text-on-back':
    'A text on a back layer is not mirrored, so it reads backwards seen from below (KiCad nonmirrored_text_on_back_layer, a warning). Mirror it.',
  'text-on-edge-cuts':
    'Text, a table or a dimension is on Edge.Cuts, where the fab would cut it as board outline (KiCad text_on_edge_cuts). Move it to another layer.',
  'unresolved-variable':
    "A text uses a ${VARIABLE} nothing defines (KiCad unresolved_variable), so it prints the reference itself. Define the variable in the project's text variables, or fix the name.",
  'drc-error':
    'A text carries a ${DRC_ERROR …} marker, which raises this error until it is removed (KiCad generic_error).',
  'drc-warning':
    'A text carries a ${DRC_WARNING …} marker, which raises this warning until it is removed (KiCad generic_warning).',
  'track-segment-length':
    "A track segment is shorter or longer than the project's rules allow (KiCad track_segment_length).",
  'track-angle':
    "Two joined track segments meet at an angle the project's rules do not allow (KiCad track_angle).",
  'track-not-centered-on-via':
    'A track ends inside a via but not at its center (KiCad track_not_centered_on_via, off by default). Snap the end to the via.',
  'part-type-mismatch':
    "A footprint's type (SMD or through hole) disagrees with its pads (KiCad footprint_type_mismatch, off by default); the position file and assembly read the type.",
  padstack:
    'A pad is questionable (KiCad padstack, a warning); the finding says how: copper on both sides of an SMD pad, mask or paste on the other side, a property the pad type does not fit, a hole that leaves no copper, a margin larger than the pad.',
  'padstack-invalid':
    'A pad cannot be made as drawn (KiCad padstack_invalid): no size, an SMD pad with a hole, a negative corner radius or chamfer, a trapezoid delta past the pad.',
  'through-hole-pad-without-hole':
    'A through-hole pad has no drill (KiCad through_hole_pad_without_hole).',
  footprint:
    "A footprint is malformed (KiCad footprint): a net-tie pad group names a pad it does not have. Fix the footprint's net-tie groups.",
  'no-courtyard':
    'A footprint has no courtyard (KiCad missing_courtyard, off by default), so nothing checks what crowds it.',
  'item-on-disabled-layer':
    'An item is on a copper layer the board does not have (KiCad item_on_disabled_layer): it will not be fabricated. Move it, or add the layer.',
  'assertion-failure':
    "An item fails an assertion in the project's custom rules (KiCad assertion_failure); the finding names the rule.",
  'missing-tuning-profile':
    'A net class names a tuning profile the project does not define (KiCad missing_tuning_profile, a warning).',
  'silk-overlap':
    'Two silkscreen items overlap, or come closer than the silk clearance (KiCad silk_overlap, a warning), so the print smears. Move one.',
  'silk-over-copper':
    'Silkscreen crosses a solder-mask opening, where the fab clips it off the exposed copper (KiCad silk_over_copper, a warning). Move or shorten the silk.',
  'solder-mask-bridge':
    'The solder mask between two openings, or between an opening and copper it should cover, is too narrow to hold, so copper of two nets is bared together (KiCad solder_mask_bridge) and solder can bridge them. Move them apart, shrink the mask margin, or allow the bridge in the footprint.',
  'silk-edge-clearance':
    'Silkscreen crosses the board edge or comes closer than the silk clearance to it (KiCad silk_edge_clearance, a warning), so the fab clips it. Move it inside the board.',
  'length-out-of-range':
    "A net's routed length (or, for a rule in picoseconds, its delay) is outside what the project's rules allow (KiCad length_out_of_range); tracks, via heights and pad-to-die lengths count. Lengthen or shorten the route.",
  'skew-out-of-range':
    "A net is longer or shorter than the longest net its rule matches (or its pair's other half) by more than the rules allow (KiCad skew_out_of_range).",
  'too-many-vias':
    "A net has more (or fewer) vias than the project's rules allow (KiCad too_many_vias).",
  'diff-pair-gap':
    "Where a differential pair's halves run side by side, the gap between them is outside the rule (KiCad diff_pair_gap_out_of_range). Route them at the pair's gap.",
  'diff-pair-uncoupled-length':
    'A differential pair runs apart (uncoupled) for longer than the rules allow (KiCad diff_pair_uncoupled_length_too_long). Keep the halves together.',
  creepage:
    "Copper of two nets is closer over the board's surface than the project's creepage rule allows (KiCad creepage): the path runs round slots, cutouts and the edge, not through them. Move the copper apart, or cut a slot between it.",
  'library-footprint-issue':
    "A footprint's library is not in the project's library tables, or does not hold it (KiCad lib_footprint_issues, a warning). Add the library, or change the footprint's library link.",
  'library-footprint-mismatch':
    'A footprint no longer matches its copy in the library (KiCad lib_footprint_mismatch, a warning); the finding says what differs. Update it from the library, or save the board copy back.',
  'duplicate-footprints':
    'Two footprints share a reference (KiCad duplicate_footprints, a warning), so the schematic cannot tell them apart. Re-annotate, or delete the copy.',
  'missing-footprint':
    'A part in the schematic has no footprint on the board (KiCad missing_footprint, a warning). Update the PCB from the schematic.',
  'extra-footprint':
    'A footprint on the board is in no part of the schematic (KiCad extra_footprint, a warning). Delete it, add its symbol, or mark it board-only.',
  'footprint-symbol-mismatch':
    "A footprint's value, library footprint, Do not populate or Exclude from BOM differs from its symbol's (KiCad footprint_symbol_mismatch, a warning). Update the PCB from the schematic.",
  'footprint-symbol-field-mismatch':
    "A footprint's field is missing or differs from its symbol's (KiCad footprint_symbol_field_mismatch, a warning). Update the PCB from the schematic.",
  'footprint-filters-mismatch':
    "A footprint is not one its symbol's footprint filters allow (KiCad footprint_filters_mismatch, off by default).",
  'net-conflict':
    "A pad's net is not the one the schematic gives its pin, or a pin has no pad (KiCad net_conflict, a warning). Update the PCB from the schematic.",
  'connection-width':
    'Copper narrows to less than the minimum connection width somewhere between wider copper (KiCad connection_width, a warning): a neck in a pour, or two tracks meeting end to end. Widen the copper there.',
  'copper-sliver':
    'Copper ends in a spike sharper than 20° (KiCad copper_sliver, a warning), a tip too thin to etch reliably. Smooth the pour or pad there.'
}

/** Each rule's KiCad violation key (`drc_item.cpp`). */
export const BOARD_KICAD_KEYS: Record<string, string> = {
  'copper-clearance': 'clearance',
  'copper-short': 'shorting_items',
  'tracks-crossing': 'tracks_crossing',
  'track-on-post-machined-layer': 'track_on_post_machined_layer',
  'hole-clearance': 'hole_clearance',
  'holes-too-close': 'hole_to_hole',
  'holes-co-located': 'holes_co_located',
  'copper-edge-clearance': 'copper_edge_clearance',
  'unconnected-items': 'unconnected_items',
  'track-width': 'track_width',
  'via-diameter': 'via_diameter',
  'annular-width': 'annular_width',
  'drill-out-of-range': 'drill_out_of_range',
  'microvia-drill-out-of-range': 'microvia_drill_out_of_range',
  'courtyards-overlap': 'courtyards_overlap',
  'pth-inside-courtyard': 'pth_inside_courtyard',
  'npth-inside-courtyard': 'npth_inside_courtyard',
  'malformed-courtyard': 'malformed_courtyard',
  'invalid-outline': 'invalid_outline',
  'items-not-allowed': 'items_not_allowed',
  'zones-intersect': 'zones_intersect',
  'isolated-copper': 'isolated_copper',
  'starved-thermal': 'starved_thermal',
  'track-dangling': 'track_dangling',
  'via-dangling': 'via_dangling',
  'text-height': 'text_height',
  'text-thickness': 'text_thickness',
  'mirrored-text-on-front': 'mirrored_text_on_front_layer',
  'nonmirrored-text-on-back': 'nonmirrored_text_on_back_layer',
  'text-on-edge-cuts': 'text_on_edge_cuts',
  'unresolved-variable': 'unresolved_variable',
  'drc-error': 'generic_error',
  'drc-warning': 'generic_warning',
  'track-segment-length': 'track_segment_length',
  'track-angle': 'track_angle',
  'track-not-centered-on-via': 'track_not_centered_on_via',
  'part-type-mismatch': 'footprint_type_mismatch',
  padstack: 'padstack',
  'padstack-invalid': 'padstack_invalid',
  'through-hole-pad-without-hole': 'through_hole_pad_without_hole',
  footprint: 'footprint',
  'no-courtyard': 'missing_courtyard',
  'item-on-disabled-layer': 'item_on_disabled_layer',
  'assertion-failure': 'assertion_failure',
  'missing-tuning-profile': 'missing_tuning_profile',
  'silk-overlap': 'silk_overlap',
  'silk-over-copper': 'silk_over_copper',
  'silk-edge-clearance': 'silk_edge_clearance',
  'solder-mask-bridge': 'solder_mask_bridge',
  'length-out-of-range': 'length_out_of_range',
  'skew-out-of-range': 'skew_out_of_range',
  'too-many-vias': 'too_many_vias',
  'diff-pair-gap': 'diff_pair_gap_out_of_range',
  'diff-pair-uncoupled-length': 'diff_pair_uncoupled_length_too_long',
  creepage: 'creepage',
  'library-footprint-issue': 'lib_footprint_issues',
  'library-footprint-mismatch': 'lib_footprint_mismatch',
  'duplicate-footprints': 'duplicate_footprints',
  'missing-footprint': 'missing_footprint',
  'extra-footprint': 'extra_footprint',
  'footprint-symbol-mismatch': 'footprint_symbol_mismatch',
  'footprint-symbol-field-mismatch': 'footprint_symbol_field_mismatch',
  'footprint-filters-mismatch': 'footprint_filters_mismatch',
  'net-conflict': 'net_conflict',
  'connection-width': 'connection_width',
  'copper-sliver': 'copper_sliver'
}

/**
 * The rules KiCad leaves off until a project turns them on (`drcCatalog.ts`
 * lists them with severity ignore; keep the two in step).
 */
const OFF_BY_DEFAULT: ReadonlySet<string> = new Set([
  'missing_courtyard',
  'track_not_centered_on_via',
  'tuning_profile_track_geometries',
  'footprint_filters_mismatch',
  'footprint_type_mismatch'
])

export interface BoardCheckInput {
  board: KicadBoard
  index: BoardSpatialIndex
  /**
   * The ratsnest; null skips what reads it (the caller has not computed it):
   * unconnected items, isolated copper, and which thermal spokes join nothing.
   */
  connectivity: BoardConnectivity | null
  settings: BoardDesignSettings
  /** The project's custom rules, its `.kicad_dru` text; absent when it has none. */
  customRules?: string
  /**
   * The footprint libraries the board's footprints came from
   * (`boardLibraries.ts`); absent skips the library rules, which then have
   * nothing to compare against.
   */
  libraries?: BoardLibraries
  /**
   * The schematic's netlist, for the parity rules; absent when the project has
   * no schematic or the caller has not read it, and those rules then skip.
   */
  schematic?: SchematicNetlist | null
}

/**
 * Check a board, with what the pill shows: the findings ranked at the
 * project's severities, KiCad's exclusions marked, sorted. Given the last run
 * and the edit since, only round the edit, and the board-wide rules only when
 * `settled` (`drc/incremental.ts`).
 */
export function* boardCheckRun(
  input: BoardCheckInput,
  since?: { run: BoardCheckRun; edit: BoardEdit },
  settled = true,
  phase?: CheckPhase
): Generator<void, BoardCheckRun & { results: CheckResult[] }> {
  const run = yield* checkBoard(input, since, settled, phase)
  return {
    ...run,
    results: rankFindings(
      run.findings.map((finding) => finding.result),
      input.settings
    )
  }
}

/** Findings as the pill counts them: at the project's severities, KiCad's exclusions marked, sorted. */
export const rankFindings = (
  results: readonly CheckResult[],
  settings: BoardDesignSettings
): CheckResult[] => {
  const ranked = applySeverities([...results], boardRuleOf, settings.severities ?? {})
  return applyExclusions(ranked, settings.exclusions ?? [], boardRuleOf).sort(byCodeThenItems)
}

export function* boardChecksSteps(input: BoardCheckInput): Generator<void, CheckResult[]> {
  return (yield* boardCheckRun(input)).results
}

const boardRuleOf: RuleOf = (code) => {
  const key = BOARD_KICAD_KEYS[code]
  if (!key) return undefined
  return OFF_BY_DEFAULT.has(key) ? { key, severity: 'ignore' } : { key }
}

/** The whole run at once, for callers with nothing to keep responsive. */
export const boardChecks = (input: BoardCheckInput): CheckResult[] => {
  const steps = boardChecksSteps(input)
  let result = steps.next()
  while (!result.done) result = steps.next()
  return result.value
}
