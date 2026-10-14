// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Every ERC rule KiCad 10 checks, in the order and groups of its Violation
 * Severity page (`eeschema/erc/erc_item.cpp` `allItemTypes`), with KiCad's
 * default severity (`erc_settings.cpp`). `codes` are the sheet checks that
 * report each; a rule with none is not checked yet. Two keys that page lists
 * are left out, since KiCad's ERC never raises them: `bus_definition_conflict`
 * (nothing reports it since bus aliases moved to the project file) and
 * `bus_entry_needed` (only its Eagle importer's note). A project that sets
 * them keeps them; the table just does not show them.
 */
import { ERC_KICAD_KEYS } from './checks'
import { rulesByCode, type CatalogRule, type RuleOf, type RuleSeverity } from '../ruleSeverity'

export type ErcGroup = 'connections' | 'conflicts' | 'misc'

const E: RuleSeverity = 'error'
const W: RuleSeverity = 'warning'
const I: RuleSeverity = 'ignore'

/**
 * Graded rules keep the engine's severity per finding: KiCad's pin-conflict
 * matrix decides each `pin_to_pin` (the setting only turns it off), and a copy
 * whose pins differ from its library is an error where one whose drawing does
 * is a warning (kicad-parity.md, deviations).
 */
const GRADED = new Set(['pin_to_pin', 'lib_symbol_mismatch'])

const RULES: Array<[ErcGroup, string, RuleSeverity]> = [
  ['connections', 'pin_not_connected', E],
  ['connections', 'pin_not_driven', E],
  ['connections', 'power_pin_not_driven', E],
  ['connections', 'no_connect_connected', W],
  ['connections', 'no_connect_dangling', W],
  ['connections', 'label_dangling', E],
  ['connections', 'isolated_pin_label', W],
  ['connections', 'single_global_label', I],
  ['connections', 'same_local_global_label', W],
  ['connections', 'wire_dangling', E],
  ['connections', 'endpoint_off_grid', W],
  ['connections', 'four_way_junction', I],
  ['connections', 'label_multiple_wires', W],
  ['connections', 'unconnected_wire_endpoint', W],
  ['conflicts', 'duplicate_reference', E],
  ['conflicts', 'pin_to_pin', W],
  ['conflicts', 'unit_value_mismatch', E],
  ['conflicts', 'different_unit_footprint', E],
  ['conflicts', 'different_unit_net', E],
  ['conflicts', 'duplicate_sheet_names', E],
  ['conflicts', 'hier_label_mismatch', E],
  ['conflicts', 'multiple_net_names', W],
  ['conflicts', 'bus_to_bus_conflict', E],
  ['conflicts', 'bus_to_net_conflict', E],
  ['conflicts', 'net_not_bus_member', W],
  ['conflicts', 'ground_pin_not_ground', W],
  ['misc', 'stacked_pin_name', W],
  ['misc', 'field_name_whitespace', W],
  ['misc', 'unannotated', E],
  ['misc', 'unresolved_variable', E],
  ['misc', 'undefined_netclass', E],
  ['misc', 'simulation_model_issue', I],
  ['misc', 'similar_labels', W],
  ['misc', 'similar_power', W],
  ['misc', 'similar_label_and_power', W],
  ['misc', 'lib_symbol_issues', W],
  ['misc', 'lib_symbol_mismatch', W],
  ['misc', 'footprint_link_issues', W],
  ['misc', 'footprint_filter', I],
  ['misc', 'extra_units', E],
  ['misc', 'missing_unit', W],
  ['misc', 'missing_input_pin', W],
  ['misc', 'missing_bidi_pin', W],
  ['misc', 'missing_power_pin', E]
]

const codesOf = (key: string): string[] =>
  Object.entries(ERC_KICAD_KEYS)
    .filter(([, kicadKey]) => kicadKey === key)
    .map(([code]) => code)

export const ERC_CATALOG: readonly CatalogRule<ErcGroup>[] = RULES.map(
  ([group, key, severity]) => ({
    key,
    group,
    severity,
    codes: codesOf(key),
    ...(GRADED.has(key) ? { graded: true } : {})
  })
)

const byCode = rulesByCode(ERC_CATALOG)

export const ercRuleOf: RuleOf = (code) => byCode.get(code)
