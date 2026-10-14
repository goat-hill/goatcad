// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Every DRC rule KiCad 10 lets a project rank, in the order and groups of its
 * Violation Severity page (`pcbnew/drc/drc_item.cpp` `allItemTypes`), with
 * KiCad's default severity (`board_design_settings.cpp`). `codes` are the
 * board checks that report each; a rule with none is not checked yet.
 */
import { BOARD_KICAD_KEYS } from './boardChecks'
import type { CatalogRule, RuleSeverity } from '../ruleSeverity'

export type DrcGroup =
  'electrical' | 'dfm' | 'schematicParity' | 'signalIntegrity' | 'readability' | 'misc'

const E: RuleSeverity = 'error'
const W: RuleSeverity = 'warning'
const I: RuleSeverity = 'ignore'

const RULES: Array<[DrcGroup, string, RuleSeverity]> = [
  ['electrical', 'shorting_items', E],
  ['electrical', 'tracks_crossing', E],
  ['electrical', 'clearance', E],
  ['electrical', 'creepage', E],
  ['electrical', 'via_dangling', W],
  ['electrical', 'track_dangling', W],
  ['electrical', 'starved_thermal', E],
  ['dfm', 'copper_edge_clearance', E],
  ['dfm', 'hole_clearance', E],
  ['dfm', 'hole_to_hole', W],
  ['dfm', 'holes_co_located', W],
  ['dfm', 'track_width', E],
  ['dfm', 'track_angle', E],
  ['dfm', 'track_segment_length', E],
  ['dfm', 'annular_width', E],
  ['dfm', 'drill_out_of_range', E],
  ['dfm', 'microvia_drill_out_of_range', E],
  ['dfm', 'via_diameter', E],
  ['dfm', 'courtyards_overlap', E],
  ['dfm', 'missing_courtyard', I],
  ['dfm', 'malformed_courtyard', E],
  ['dfm', 'invalid_outline', E],
  ['dfm', 'copper_sliver', W],
  ['dfm', 'solder_mask_bridge', E],
  ['dfm', 'connection_width', W],
  ['dfm', 'track_on_post_machined_layer', E],
  ['dfm', 'track_not_centered_on_via', I],
  ['dfm', 'tuning_profile_track_geometries', I],
  ['schematicParity', 'duplicate_footprints', W],
  ['schematicParity', 'missing_footprint', W],
  ['schematicParity', 'extra_footprint', W],
  ['schematicParity', 'footprint_symbol_mismatch', W],
  ['schematicParity', 'footprint_symbol_field_mismatch', W],
  ['schematicParity', 'footprint_filters_mismatch', I],
  ['schematicParity', 'net_conflict', W],
  ['schematicParity', 'unconnected_items', E],
  ['signalIntegrity', 'length_out_of_range', E],
  ['signalIntegrity', 'skew_out_of_range', E],
  ['signalIntegrity', 'too_many_vias', E],
  ['signalIntegrity', 'diff_pair_gap_out_of_range', E],
  ['signalIntegrity', 'diff_pair_uncoupled_length_too_long', E],
  ['readability', 'silk_overlap', W],
  ['readability', 'silk_over_copper', W],
  ['readability', 'silk_edge_clearance', W],
  ['readability', 'text_height', W],
  ['readability', 'text_thickness', W],
  ['readability', 'mirrored_text_on_front_layer', W],
  ['readability', 'nonmirrored_text_on_back_layer', W],
  ['misc', 'items_not_allowed', E],
  ['misc', 'text_on_edge_cuts', E],
  ['misc', 'zones_intersect', E],
  ['misc', 'isolated_copper', W],
  ['misc', 'footprint', E],
  ['misc', 'padstack', W],
  ['misc', 'pth_inside_courtyard', E],
  ['misc', 'npth_inside_courtyard', E],
  ['misc', 'item_on_disabled_layer', E],
  ['misc', 'unresolved_variable', E],
  ['misc', 'assertion_failure', E],
  ['misc', 'footprint_type_mismatch', I],
  ['misc', 'lib_footprint_issues', W],
  ['misc', 'lib_footprint_mismatch', W],
  ['misc', 'through_hole_pad_without_hole', E],
  ['misc', 'missing_tuning_profile', W]
]

const codesOf = (key: string): string[] =>
  Object.entries(BOARD_KICAD_KEYS)
    .filter(([, kicadKey]) => kicadKey === key)
    .map(([code]) => code)

/**
 * KiCad's findings no project can rank (`heading_internal`): an invalid
 * padstack and the `${DRC_ERROR}` / `${DRC_WARNING}` markers. Reported at
 * their own severity, never listed for setting.
 */
export const DRC_INTERNAL_KEYS: ReadonlySet<string> = new Set([
  'padstack_invalid',
  'generic_error',
  'generic_warning'
])

/** The rules that rank other checks' findings (`CatalogRule.ranksOthers`): the tuning profiles' implicit rules. */
const RANKS_OTHERS: ReadonlySet<string> = new Set(['tuning_profile_track_geometries'])

export const DRC_CATALOG: readonly CatalogRule<DrcGroup>[] = RULES.map(
  ([group, key, severity]) => ({
    key,
    group,
    severity,
    codes: codesOf(key),
    ...(RANKS_OTHERS.has(key) ? { ranksOthers: true } : {})
  })
)
