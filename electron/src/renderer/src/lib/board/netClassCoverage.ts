// What Board Setup's assignment table does to the board's nets: how many each
// pattern takes, which nets land in more than one class, and which fall
// through to Default. Pure — the page renders it, the matching is
// `matchesNetPattern`, the same the checks and router use.

import { matchesNetPattern, type NetClassAssignment, type NetClassPattern } from '../kicad/project'
import { matchDiffPair } from './rules/diffPairs'

export interface PatternCoverage {
  count: number
  /** Nets it takes that another pattern or assignment also puts in a different class. */
  overlap: number
  /** Those other classes, by name. */
  overlapClasses: string[]
  /** Reads as an expression that does not compile, and matches nothing. */
  invalid: boolean
}

export interface NetCoverage {
  /** The board's nets, in display order. */
  nets: readonly string[]
  /** Per pattern, in the table's order. */
  patterns: PatternCoverage[]
  /** The nets each pattern takes, in `nets` order. */
  matches: string[][]
  /** Each assigned net's classes, assignments first then patterns in order. */
  classesOf: ReadonlyMap<string, string[]>
  /** Nets the schematic assigns directly (`netclass_assignments`). */
  fixed: ReadonlySet<string>
  /** Nets no assignment or pattern reaches: Default's. */
  unassigned: string[]
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * The nets a class can be about: named ones, less the single-pad nets KiCad
 * names `unconnected-(…)`, which route nowhere. The root's first, then sheet by
 * sheet, each as a person reads it (`D2` before `D10`).
 */
export function assignableNets(names: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const name of names) if (name !== '' && !name.startsWith('unconnected-')) out.add(name)
  return [...out].sort((a, b) => {
    const x = splitNetName(a)
    const y = splitNetName(b)
    if (x.path !== y.path) {
      if (x.path === '') return -1
      if (y.path === '') return 1
      return collator.compare(x.path, y.path)
    }
    return collator.compare(x.leaf, y.leaf)
  })
}

/** Text that reads as a regular expression but cannot be compiled as one. */
export function isBrokenExpression(pattern: string): boolean {
  try {
    new RegExp(`^${pattern}$`)
    return false
  } catch {
    return true
  }
}

export function matchNets(pattern: string, nets: readonly string[]): string[] {
  if (pattern.trim() === '') return []
  return nets.filter((net) => matchesNetPattern(pattern, net))
}

export function netCoverage(
  nets: readonly string[],
  patterns: readonly NetClassPattern[],
  assignments: readonly NetClassAssignment[]
): NetCoverage {
  const classesOf = new Map<string, string[]>()
  const add = (net: string, netClass: string): void => {
    const list = classesOf.get(net)
    if (!list) classesOf.set(net, [netClass])
    else if (!list.includes(netClass)) list.push(netClass)
  }
  const present = new Set(nets)
  const fixed = new Set<string>()
  for (const { net, netClass } of assignments) {
    if (!present.has(net)) continue
    fixed.add(net)
    add(net, netClass)
  }
  const matches = patterns.map((p) => matchNets(p.pattern, nets))
  matches.forEach((list, i) => list.forEach((net) => add(net, patterns[i].netClass)))

  const coverage = patterns.map<PatternCoverage>((p, i) => {
    const others = new Set<string>()
    let overlap = 0
    for (const net of matches[i]) {
      const elsewhere = classesOf.get(net)!.filter((c) => c !== p.netClass)
      if (elsewhere.length === 0) continue
      overlap++
      elsewhere.forEach((c) => others.add(c))
    }
    return {
      count: matches[i].length,
      overlap,
      overlapClasses: [...others],
      invalid: matches[i].length === 0 && isBrokenExpression(p.pattern)
    }
  })

  return {
    nets,
    patterns: coverage,
    matches,
    classesOf,
    fixed,
    unassigned: nets.filter((net) => !classesOf.has(net))
  }
}

/** A hierarchical name split at its last `/`: the sheet path, and the net's own name. */
export function splitNetName(name: string): { path: string; leaf: string } {
  const slash = name.lastIndexOf('/')
  return slash < 0
    ? { path: '', leaf: name }
    : { path: name.slice(0, slash + 1), leaf: name.slice(slash + 1) }
}

export interface NetGroup {
  path: string
  names: string[]
  /**
   * The names again, a differential pair's halves taken together where both
   * are listed (KiCad's naming, `matchDiffPair`): positive first, at the place
   * the first of them came.
   */
  items: Array<string | [string, string]>
}

/** A sheet's nets with each pair whose halves are both there joined, in the order they came. */
const pairUp = (names: readonly string[]): NetGroup['items'] => {
  const listed = new Set(names)
  const taken = new Set<string>()
  const items: NetGroup['items'] = []
  for (const name of names) {
    if (taken.has(name)) continue
    const pair = matchDiffPair(name)
    if (pair && listed.has(pair.complement) && !taken.has(pair.complement)) {
      taken.add(name).add(pair.complement)
      items.push(pair.polarity === 1 ? [name, pair.complement] : [pair.complement, name])
    } else items.push(name)
  }
  return items
}

/** Up to `cap` nets, grouped by sheet in the order they come, and how many were left out. */
export function groupNets(
  names: readonly string[],
  cap: number
): { groups: NetGroup[]; hidden: number } {
  const byPath = new Map<string, string[]>()
  for (const name of names.slice(0, cap)) {
    const { path } = splitNetName(name)
    const list = byPath.get(path)
    if (list) list.push(name)
    else byPath.set(path, [name])
  }
  return {
    groups: [...byPath].map(([path, list]) => ({ path, names: list, items: pairUp(list) })),
    hidden: Math.max(0, names.length - cap)
  }
}
