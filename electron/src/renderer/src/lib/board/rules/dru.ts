// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * A project's custom rules, `<project>.kicad_dru`, read into the rules the
 * resolver walks after the board's own (`resolver.ts`).
 *
 *   (version 1)
 *   (rule "HV" (condition "A.NetClass == 'HV'") (layer outer)
 *     (constraint clearance (min 1.5mm)) (severity error))
 *
 * As KiCad reads it (`drc_rule_parser.cpp`): a line whose first non-blank
 * character is `#` is a comment; a rule has a name, at most one layer clause
 * (`outer`, `inner`, or a wildcard over the board's layer names), a condition,
 * a severity and one constraint per type; a value is a unit expression. Any
 * error discards every rule in the file — KiCad falls back to the board's own
 * rules alone — and says why. Written only rule by rule (`druRules.ts`).
 */
import { getToken, parseSExpr, type SExprList, type SExprNode } from '../../kicad/sexpr'
import {
  DISALLOW,
  DISALLOW_ANY_VIA,
  type ConstraintType,
  type ConstraintValue,
  type Rule,
  type RuleSeverity,
  type ZoneConnectionStyle
} from './constraints'
import {
  compileCondition,
  evaluateNumber,
  ExpressionError,
  type RuleEnvironment
} from './expression'

export interface ParsedRules {
  /** Empty when the file has an error, as KiCad discards the lot. */
  rules: Rule[]
  errors: string[]
  /** Properties and functions the conditions name that GoatCAD does not read yet. */
  unsupported: string[]
}

/** Every constraint keyword, and the older names KiCad still reads. */
const CONSTRAINTS: Record<string, ConstraintType> = {
  clearance: 'clearance',
  hole_clearance: 'hole_clearance',
  hole_to_hole: 'hole_to_hole',
  edge_clearance: 'edge_clearance',
  physical_clearance: 'physical_clearance',
  mechanical_clearance: 'physical_clearance',
  physical_hole_clearance: 'physical_hole_clearance',
  mechanical_hole_clearance: 'physical_hole_clearance',
  courtyard_clearance: 'courtyard_clearance',
  silk_clearance: 'silk_clearance',
  creepage: 'creepage',
  track_width: 'track_width',
  track_segment_length: 'track_segment_length',
  track_angle: 'track_angle',
  connection_width: 'connection_width',
  via_diameter: 'via_diameter',
  hole_size: 'hole_size',
  hole: 'hole_size',
  annular_width: 'annular_width',
  text_height: 'text_height',
  text_thickness: 'text_thickness',
  diff_pair_gap: 'diff_pair_gap',
  diff_pair_uncoupled: 'diff_pair_uncoupled',
  length: 'length',
  skew: 'skew',
  via_count: 'via_count',
  zone_connection: 'zone_connection',
  thermal_relief_gap: 'thermal_relief_gap',
  thermal_spoke_width: 'thermal_spoke_width',
  min_resolved_spokes: 'min_resolved_spokes',
  solder_mask_expansion: 'solder_mask_expansion',
  solder_paste_abs_margin: 'solder_paste_abs_margin',
  solder_paste_rel_margin: 'solder_paste_rel_margin',
  disallow: 'disallow',
  assertion: 'assertion',
  bridged_mask: 'bridged_mask',
  via_dangling: 'via_dangling',
  // Read, and checked by nothing: KiCad's mask web check takes the board's own minimum.
  solder_mask_sliver: 'solder_mask_sliver'
}

/** Constraints whose values are counts, not lengths: no units. */
const UNITLESS: ReadonlySet<ConstraintType> = new Set([
  'via_count',
  'min_resolved_spokes',
  'track_angle',
  'via_dangling',
  'bridged_mask'
])

const DISALLOW_KINDS: Record<string, number> = {
  track: DISALLOW.track,
  via: DISALLOW_ANY_VIA,
  through_via: DISALLOW.throughVia,
  micro_via: DISALLOW.microVia,
  blind_via: DISALLOW.blindVia,
  buried_via: DISALLOW.buriedVia,
  pad: DISALLOW.pad,
  zone: DISALLOW.zone,
  text: DISALLOW.text,
  graphic: DISALLOW.graphic,
  hole: DISALLOW.hole,
  footprint: DISALLOW.footprint
}

const ZONE_CONNECTIONS: Record<string, ZoneConnectionStyle> = {
  solid: 'solid',
  thermal_reliefs: 'thermal_reliefs',
  none: 'none'
}

const SEVERITIES: ReadonlySet<string> = new Set(['error', 'warning', 'ignore', 'exclusion'])

const atoms = (list: SExprList): string[] =>
  list.children.slice(1).flatMap((child) => (child.type === 'atom' ? [child.value] : []))

/**
 * Read a rule file. `layers` are the board's layer names (canonical and user),
 * which a `(layer …)` clause is matched against.
 */
export function parseRules(
  text: string,
  env: RuleEnvironment,
  layers: readonly { name: string; userName?: string }[]
): ParsedRules {
  const errors: string[] = []
  const unsupported = new Set<string>()
  const rules: Rule[] = []
  // A `#` starts a comment only as a line's first non-blank character.
  const source = text
    .split(/\r?\n/)
    .map((line) => (line.trimStart().startsWith('#') ? '' : line))
    .join('\n')
  let root: SExprNode
  try {
    root = parseSExpr(`(kicad_dru\n${source}\n)`)
  } catch (error) {
    return {
      rules: [],
      errors: [`The rule file does not parse: ${(error as Error).message}`],
      unsupported: []
    }
  }
  if (root.type !== 'list')
    return { rules: [], errors: ['The rule file is empty'], unsupported: [] }
  const top = root.children.slice(1).filter((child): child is SExprList => child.type === 'list')
  // A file of comments only is empty, not an error.
  if (top.length > 0 && getToken(top[0]) !== 'version') errors.push('Missing version statement.')

  for (const node of top) {
    const token = getToken(node)
    if (token === 'version') continue
    if (token !== 'rule') {
      errors.push(`Unexpected '${token}': expected a rule`)
      continue
    }
    const name = node.children[1]?.type === 'atom' ? node.children[1].value : ''
    const where = `rule '${name}'`
    const constraints = new Map<ConstraintType, ConstraintValue>()
    let condition: Rule['condition'] = null
    let conditionText: string | undefined
    let ruleLayers: Set<string> | null = null
    let layerSource: string | undefined
    let severity: RuleSeverity | undefined
    let layerClauses = 0

    for (const clause of node.children.slice(2)) {
      if (clause.type !== 'list') continue
      const kind = getToken(clause)
      try {
        if (kind === 'condition') {
          conditionText = atoms(clause)[0] ?? ''
          const compiled = compileCondition(conditionText, env)
          for (const name of compiled.unsupported) unsupported.add(name)
          condition = compiled.test
        } else if (kind === 'layer') {
          if (++layerClauses > 1) throw new Error("Rule already has a 'layer' clause")
          layerSource = atoms(clause)[0] ?? ''
          ruleLayers = layerSet(layerSource, layers)
          if (ruleLayers.size === 0) throw new Error(`Unknown layer '${layerSource}'`)
        } else if (kind === 'severity') {
          const value = atoms(clause)[0] ?? ''
          if (!SEVERITIES.has(value)) throw new Error(`Unknown severity '${value}'`)
          severity = value as RuleSeverity
        } else if (kind === 'constraint') {
          const [type, value] = parseConstraint(clause, env, unsupported)
          if (constraints.has(type)) throw new Error(`Rule already has a '${type}' constraint`)
          constraints.set(type, value)
        } else {
          throw new Error(`Unexpected '${kind}'`)
        }
      } catch (error) {
        errors.push(`${where}: ${(error as Error).message}`)
      }
    }
    rules.push({
      name: `rule '${name}'`,
      implicit: null,
      layers: ruleLayers,
      layerSource,
      condition,
      conditionText,
      severity,
      constraints
    })
  }
  // One error and the file is set aside whole, as KiCad does.
  return errors.length > 0
    ? { rules: [], errors, unsupported: [...unsupported] }
    : { rules, errors, unsupported: [...unsupported] }
}

function parseConstraint(
  clause: SExprList,
  env: RuleEnvironment,
  unsupported: Set<string>
): [ConstraintType, ConstraintValue] {
  const keyword = clause.children[1]?.type === 'atom' ? clause.children[1].value : ''
  const type = CONSTRAINTS[keyword]
  if (!type) throw new Error(`Unknown constraint '${keyword}'`)
  const rest = clause.children.slice(2)
  const words = rest.flatMap((child) => (child.type === 'atom' ? [child.value] : []))

  if (type === 'disallow') {
    let flags = 0
    for (const word of words) {
      const flag = DISALLOW_KINDS[word]
      if (flag === undefined) throw new Error(`Unknown disallow kind '${word}'`)
      flags |= flag
    }
    return [type, { disallow: flags }]
  }
  if (type === 'zone_connection') {
    const style = ZONE_CONNECTIONS[words[0] ?? '']
    if (!style) throw new Error(`Unknown zone connection '${words[0] ?? ''}'`)
    return [type, { zoneConnection: style }]
  }
  if (type === 'min_resolved_spokes') {
    const count = Number(words[0])
    if (!Number.isInteger(count)) throw new Error('min_resolved_spokes takes a whole number')
    return [type, { min: count }]
  }
  if (type === 'assertion') {
    const compiled = compileCondition(words[0] ?? '', env)
    for (const name of compiled.unsupported) unsupported.add(name)
    return [type, { assertion: compiled.test }]
  }

  const value: ConstraintValue = {}
  for (const child of rest) {
    if (child.type !== 'list') continue
    const field = getToken(child)
    if (field === 'within_diff_pairs') {
      if (type !== 'skew') throw new Error('within_diff_pairs applies to skew only')
      value.withinDiffPairs = true
      continue
    }
    if (field !== 'min' && field !== 'opt' && field !== 'max')
      throw new Error(`Unknown value '${field}'`)
    const expression = atoms(child).join(' ')
    const number = UNITLESS.has(type)
      ? Number(expression.replace(/deg$/, ''))
      : evaluateNumber(expression)
    if (!Number.isFinite(number)) throw new ExpressionError(`'${expression}' is not a number`)
    value[field] = number
    if (/\d\s*[pf]s\b/.test(expression)) value.timeDomain = true
  }
  return [type, value]
}

/** A `(layer …)` clause as the set of board layers it names. */
/**
 * A `(layer …)` clause as a set of layer names. KiCad matches it against every
 * layer it has, not only the board's — a rule on `In5.Cu` of a two-layer board
 * is no error, it just matches nothing there — and `inner` and `outer` name
 * every inner and both outer copper layers.
 */
function layerSet(
  pattern: string,
  layers: readonly { name: string; userName?: string }[]
): Set<string> {
  if (pattern === 'outer') return new Set(['F.Cu', 'B.Cu'])
  if (pattern === 'inner') return new Set(INNER_COPPER)
  const out = new Set<string>()
  for (const name of CANONICAL_LAYERS) if (matches(pattern, name)) out.add(name)
  for (const layer of layers) {
    if (matches(pattern, layer.name) || (layer.userName && matches(pattern, layer.userName)))
      out.add(layer.name)
  }
  return out
}

const INNER_COPPER = Array.from({ length: 30 }, (_, i) => `In${i + 1}.Cu`)

/** Every layer KiCad names, whatever a board enables. */
const CANONICAL_LAYERS = [
  'F.Cu',
  ...INNER_COPPER,
  'B.Cu',
  ...['Adhes', 'Paste', 'SilkS', 'Mask', 'CrtYd', 'Fab'].flatMap((l) => [`F.${l}`, `B.${l}`]),
  'Dwgs.User',
  'Cmts.User',
  'Eco1.User',
  'Eco2.User',
  'Edge.Cuts',
  'Margin',
  ...Array.from({ length: 45 }, (_, i) => `User.${i + 1}`)
]

const matches = (pattern: string, name: string): boolean =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`
  ).test(name)
