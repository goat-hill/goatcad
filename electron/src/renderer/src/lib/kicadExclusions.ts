// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * KiCad's exclusions, read from a project: the findings a KiCad user marked
 * "exclude" in its DRC or ERC dialog, kept in `board.design_settings.drc_exclusions`
 * and `erc.erc_exclusions` as `key|x|y|<item ids>…` strings, each with an
 * optional comment (`pcb_marker.cpp` / `sch_marker.cpp` `SerializeToString`).
 *
 * KiCad matches an exclusion on the whole string, marker position included.
 * Our findings are not placed where KiCad places its markers, so an exclusion
 * matches here on its rule and its items alone (`kicadIds`), and a sheet path
 * where it names one; one that names no item (KiCad's newer `unconnected_items`
 * form, a drawing-sheet variable) cannot match. Read-only: GoatCAD writes none.
 */
import type { CheckResult } from './schematic/checks'
import type { RuleOf } from './ruleSeverity'

export interface KicadExclusion {
  /** The string as the project holds it, which is also its identity. */
  raw: string
  /** KiCad's violation key. */
  key: string
  /** The non-nil item uuids it names, main then aux. */
  ids: string[]
  /** ERC: the sheet instance its main item is on (`/<root>/…`), when it names one. */
  sheetPath?: string
  comment: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NIL = '00000000-0000-0000-0000-000000000000'

/** One exclusion string; null for one too short to name a rule. */
export const parseExclusion = (raw: string, comment = ''): KicadExclusion | null => {
  const fields = raw.split('|')
  if (fields.length < 3 || !fields[0]) return null
  const ids = fields.slice(3).filter((field) => UUID.test(field) && field !== NIL)
  // ERC: key|x|y|main|aux|sheet-specific path|main item path|aux item path.
  const mainPath = fields.length >= 8 ? fields[6] : ''
  return {
    raw,
    key: fields[0],
    ids,
    ...(mainPath.startsWith('/') ? { sheetPath: mainPath } : {}),
    comment
  }
}

/** A project's exclusions for one checker; empty for none or malformed JSON. */
export const extractExclusions = (
  projectJsonText: string,
  scope: 'drc' | 'erc'
): KicadExclusion[] => {
  let root: unknown
  try {
    root = JSON.parse(projectJsonText)
  } catch {
    return []
  }
  const at = (value: unknown, key: string): unknown =>
    value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  const list =
    scope === 'erc'
      ? at(at(root, 'erc'), 'erc_exclusions')
      : at(at(at(root, 'board'), 'design_settings'), 'drc_exclusions')
  if (!Array.isArray(list)) return []
  const out: KicadExclusion[] = []
  for (const entry of list) {
    // KiCad 9 writes `[string, comment]`; earlier versions a bare string.
    const raw = Array.isArray(entry) ? entry[0] : entry
    const comment = Array.isArray(entry) && typeof entry[1] === 'string' ? entry[1] : ''
    if (typeof raw !== 'string') continue
    const parsed = parseExclusion(raw, comment)
    if (parsed) out.push(parsed)
  }
  return out
}

/**
 * A finding and an exclusion are the same when they are one rule over the same
 * items: one's ids hold all of the other's. Either way round, because the two
 * sides draw items differently — an edge clearance names the edge in KiCad and
 * not here, and a finding here can gather several of KiCad's markers (the
 * drivers on one net, the ends at one off-grid point).
 */
const matches = (result: CheckResult, key: string, exclusion: KicadExclusion): boolean => {
  if (exclusion.key !== key || !exclusion.ids.length) return false
  const ids = result.kicadIds ?? []
  if (!ids.length) return false
  if (exclusion.sheetPath && result.sheetPath && exclusion.sheetPath !== result.sheetPath)
    return false
  const has = new Set(ids)
  const excluded = new Set(exclusion.ids)
  return exclusion.ids.every((id) => has.has(id)) || ids.every((id) => excluded.has(id))
}

/** Mark the findings a project's KiCad exclusions name. */
export const applyExclusions = (
  results: CheckResult[],
  exclusions: readonly KicadExclusion[],
  ruleOf: RuleOf
): CheckResult[] => {
  if (!exclusions.length) return results
  const byKey = new Map<string, KicadExclusion[]>()
  for (const exclusion of exclusions) {
    const list = byKey.get(exclusion.key) ?? []
    list.push(exclusion)
    byKey.set(exclusion.key, list)
  }
  return results.map((result) => {
    const key = ruleOf(result.code)?.key
    const candidates = key ? byKey.get(key) : undefined
    const hit = candidates?.find((exclusion) => matches(result, key!, exclusion))
    return hit ? { ...result, excluded: { comment: hit.comment, exclusion: hit.raw } } : result
  })
}

/** How many findings each exclusion matched, by its string. */
export const exclusionMatches = (results: readonly CheckResult[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const result of results) {
    const raw = result.excluded?.exclusion
    if (raw) counts.set(raw, (counts.get(raw) ?? 0) + 1)
  }
  return counts
}

/** The findings that count: what the pill, the `*.check` ops and the pre-flight read. */
export const activeFindings = (results: readonly CheckResult[]): CheckResult[] =>
  results.filter((result) => !result.excluded)
