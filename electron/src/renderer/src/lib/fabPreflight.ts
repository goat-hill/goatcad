/**
 * The export pre-flight (fabrication-export-workstream.md): what stands
 * between a board and a package its fab will build, read before a file is
 * written. Pure — the board, the export profile, the board's DRC findings,
 * its BOM components and its drill hits in; one finding per check out.
 *
 * Inform loudly, block rarely: only a board with no closed outline blocks,
 * since no fab can cut it. Everything else is a review item, and a check
 * that finds nothing reports as passed so the list reads as a checklist.
 */
import type { KicadBoard } from './kicad/board'
import type { CheckResult } from './schematic/checks'
import type { ExportProfile } from './exportProfiles'
import { bomPartNumber, hasOutput } from './exportProfiles'
import { componentsForBom, resolvePartNumber, type FabBomComponent } from './fabBom'
import type { DrillHit } from './gerber/drill'
import { BUILT_IN_PROFILES } from './manufacturingProfiles'

export type PreflightLevel = 'blocking' | 'review' | 'passed'

export type PreflightCheck =
  | 'outline'
  | 'drcErrors'
  | 'drcWarnings'
  | 'unfilledZones'
  | 'drillSize'
  | 'holeSpacing'
  | 'partNumbers'
  | 'values'

export interface PreflightFinding {
  check: PreflightCheck
  level: PreflightLevel
  /** How many things it is about — findings, holes, zones, parts; 0 when it passed. */
  count: number
  /** What it names for a person: references, zone nets, DRC rule codes. Capped. */
  subjects: string[]
  /** How many of `count` each subject holds, most first: a DRC row's findings per rule. */
  breakdown?: Array<{ subject: string; count: number }>
  /** The measured value and the fab's limit, mm, for the checks that have them. */
  actual?: number
  limit?: number
  /** Board uuids a jump to the board selects. */
  targets: string[]
}

export interface PreflightInput {
  board: KicadBoard
  profile: ExportProfile
  /** The board's DRC findings, as its health pill holds them. */
  drc: readonly CheckResult[]
  bom: FabBomComponent[]
  drillHits: readonly DrillHit[]
}

/** Names a finding lists before it says "and N more". */
export const PREFLIGHT_SUBJECT_CAP = 8

/** The order a person reads them in: what blocks, then what the fab sees, then the BOM. */
const CHECK_ORDER: readonly PreflightCheck[] = [
  'outline',
  'drcErrors',
  'unfilledZones',
  'drillSize',
  'holeSpacing',
  'partNumbers',
  'values',
  'drcWarnings'
]

const LEVEL_ORDER: Record<PreflightLevel, number> = { blocking: 0, review: 1, passed: 2 }

const round = (mm: number): number => Math.round(mm * 1e4) / 1e4

/**
 * The fab's capability numbers for this board: the manufacturing profile of
 * the export profile's house whose tier matches the board's copper count,
 * else that house's first. Null for a house we hold no numbers for.
 */
const fabRules = (
  board: KicadBoard,
  profile: ExportProfile
): { minDrill: number; minHoleToHole: number } | null => {
  const copper = board.layers.filter((l) => l.name.endsWith('.Cu')).length
  const houses = BUILT_IN_PROFILES.filter((p) => p.vendor === profile.vendor)
  const tier =
    houses.find((p) => p.stackups.some((s) => s.spec.copperLayers === copper)) ?? houses[0]
  return tier
    ? { minDrill: tier.rules.minThroughHoleDiameter, minHoleToHole: tier.rules.minHoleToHole }
    : null
}

/**
 * The closest two holes come edge to edge, by a sweep over x; null with fewer
 * than two. Slots are milled after drilling, so they are left out, as DRC's
 * `hole_to_hole` leaves them.
 */
const closestHoles = (hits: readonly DrillHit[], within: number): number | null => {
  const sorted = hits.filter((h) => !h.slot).sort((a, b) => a.x - b.x)
  let best: number | null = null
  const widest = sorted.reduce((max, h) => Math.max(max, h.diameter), 0)
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]
      if (b.x - a.x > within + widest) break
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.diameter / 2 - b.diameter / 2
      // Holes at one point are one hole drilled twice, which DRC reports.
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) continue
      if (best === null || gap < best) best = gap
    }
  }
  return best
}

export function preflightAudit(input: PreflightInput): PreflightFinding[] {
  const { board, profile, drc, bom, drillHits } = input
  const out: PreflightFinding[] = []
  const finding = (
    check: PreflightCheck,
    level: PreflightLevel,
    subjects: string[],
    extra: Partial<
      Pick<PreflightFinding, 'actual' | 'limit' | 'targets' | 'count' | 'breakdown'>
    > = {}
  ): void => {
    out.push({
      check,
      level: subjects.length || extra.count ? level : 'passed',
      count: extra.count ?? subjects.length,
      subjects: subjects.slice(0, PREFLIGHT_SUBJECT_CAP),
      ...(extra.breakdown?.length ? { breakdown: extra.breakdown } : {}),
      actual: extra.actual,
      limit: extra.limit,
      targets: extra.targets ?? []
    })
  }

  // The outline: without one closed shape no fab can cut the board.
  const outline = drc.find((f) => f.code === 'invalid-outline')
  finding('outline', 'blocking', outline ? ['Edge.Cuts'] : [])

  // The board's DRC, linked rather than re-run: one row per severity, naming its rules.
  for (const [check, severity] of [
    ['drcErrors', 'error'],
    ['drcWarnings', 'warning']
  ] as const) {
    const found = drc.filter((f) => f.severity === severity && f.code !== 'invalid-outline')
    const perRule = new Map<string, number>()
    for (const f of found) perRule.set(f.code, (perRule.get(f.code) ?? 0) + 1)
    const breakdown = [...perRule]
      .map(([subject, count]) => ({ subject, count }))
      .sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject))
    finding(
      check,
      'review',
      breakdown.map((row) => row.subject),
      {
        count: found.length,
        breakdown,
        targets: [...new Set(found.flatMap((f) => f.targets ?? []))]
      }
    )
  }

  // A zone never filled ships no copper at all.
  const unfilled = board.zones.filter((z) => !z.isKeepout && z.filledPolys.length === 0)
  finding(
    'unfilledZones',
    'review',
    unfilled.map((z) => z.netName || z.name || 'zone'),
    { targets: unfilled.flatMap((z) => (z.uuid ? [z.uuid] : [])) }
  )

  // Drills against the fab's numbers, which the board's own rules may be looser than.
  const fab = fabRules(board, profile)
  if (fab && hasOutput(profile, 'drill')) {
    const small = drillHits.filter((h) => h.diameter < fab.minDrill - 1e-9)
    const smallest = small.length ? Math.min(...small.map((h) => h.diameter)) : undefined
    finding('drillSize', 'review', [], {
      count: small.length,
      actual: smallest !== undefined ? round(smallest) : undefined,
      limit: fab.minDrill
    })
    const gap = closestHoles(drillHits, fab.minHoleToHole)
    const tight = gap !== null && gap < fab.minHoleToHole - 1e-9
    finding('holeSpacing', 'review', [], {
      count: tight ? 1 : 0,
      actual: tight ? round(Math.max(0, gap)) : undefined,
      limit: fab.minHoleToHole
    })
  }

  // The BOM a fab assembles from: every placed part needs a value and, when
  // the fab keys its BOM on one, a part number.
  if (hasOutput(profile, 'bom')) {
    const parts = componentsForBom(bom, false)
    const refs = (missing: FabBomComponent[]): string[] =>
      missing.map((c) => c.reference).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    const uuidsOf = (missing: FabBomComponent[]): string[] => {
      const wanted = new Set(missing.map((c) => c.reference))
      return board.footprints.flatMap((fp) =>
        fp.uuid && fp.reference && wanted.has(fp.reference) ? [fp.uuid] : []
      )
    }
    const kind = bomPartNumber(profile)
    if (kind) {
      const missing = parts.filter((c) => !resolvePartNumber(c.fields, kind))
      finding('partNumbers', 'review', refs(missing), { targets: uuidsOf(missing) })
    }
    const unvalued = parts.filter((c) => !(c.fields.Value ?? '').trim())
    finding('values', 'review', refs(unvalued), { targets: uuidsOf(unvalued) })
  }

  return out.sort(
    (a, b) =>
      LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
      CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check)
  )
}

/** Whether the package may be written: nothing blocks it. */
export const preflightAllowsExport = (findings: readonly PreflightFinding[]): boolean =>
  !findings.some((f) => f.level === 'blocking')
