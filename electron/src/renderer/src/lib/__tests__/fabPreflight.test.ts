import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../kicad/board'
import { deriveExportProfile, findExportProfile, type ExportProfile } from '../exportProfiles'
import { boardBomComponents } from '../fabBom'
import { collectDrillHits } from '../gerber/drill'
import { preflightAllowsExport, preflightAudit, type PreflightFinding } from '../fabPreflight'
import type { CheckResult } from '../schematic/checks'

const board = (body: string): ReturnType<typeof parseKicadBoard> =>
  parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND")
  ${body}
)`)

const part = (reference: string, x: number, fields: string, drill = ''): string => `
  (footprint "Lib:R" (layer "F.Cu") (uuid "fp-${reference}") (at ${x} 10)
    (property "Reference" "${reference}" (at 0 0) (layer "F.SilkS"))
    ${fields}
    ${drill})`

const audit = (
  source: ReturnType<typeof parseKicadBoard>,
  drc: CheckResult[] = [],
  profile: string | ExportProfile = 'jlcpcb'
): PreflightFinding[] =>
  preflightAudit({
    board: source,
    profile: typeof profile === 'string' ? findExportProfile(profile)! : profile,
    drc,
    bom: boardBomComponents(source.footprints),
    drillHits: collectDrillHits(source)
  })

const byCheck = (findings: PreflightFinding[]): Record<string, PreflightFinding> =>
  Object.fromEntries(findings.map((f) => [f.check, f]))

const drcFinding = (code: string, severity: 'error' | 'warning'): CheckResult => ({
  code,
  severity,
  message: code,
  items: ['t1'],
  targets: ['t1'],
  subject: 'track'
})

describe('the export pre-flight', () => {
  test('a clean board passes every check, and export is allowed', () => {
    const findings = audit(
      board(part('R1', 10, '(property "Value" "10k") (property "LCSC" "C25744")'))
    )
    expect(findings.every((f) => f.level === 'passed')).toBe(true)
    expect(preflightAllowsExport(findings)).toBe(true)
  })

  test('only an unclosed outline blocks; DRC findings are for review, errors first', () => {
    const findings = audit(board(''), [
      drcFinding('invalid-outline', 'error'),
      drcFinding('copper-clearance', 'error'),
      drcFinding('copper-clearance', 'error'),
      drcFinding('track-dangling', 'warning')
    ])
    const checks = byCheck(findings)
    expect(findings[0]).toMatchObject({ check: 'outline', level: 'blocking' })
    expect(preflightAllowsExport(findings)).toBe(false)
    expect(checks.drcErrors).toMatchObject({
      level: 'review',
      count: 2,
      subjects: ['copper-clearance']
    })
    expect(checks.drcWarnings).toMatchObject({ level: 'review', count: 1 })
  })

  test('a DRC row counts its findings per rule, the commonest first', () => {
    const findings = audit(board(''), [
      drcFinding('track-dangling', 'warning'),
      drcFinding('silk-overlap', 'warning'),
      drcFinding('silk-overlap', 'warning'),
      drcFinding('silk-overlap', 'warning')
    ])
    expect(byCheck(findings).drcWarnings.breakdown).toEqual([
      { subject: 'silk-overlap', count: 3 },
      { subject: 'track-dangling', count: 1 }
    ])
    expect(byCheck(findings).drcErrors.breakdown).toBeUndefined()
  })

  test('parts without a value or the part number the fab keys its BOM on', () => {
    const checks = byCheck(
      audit(
        board(
          part('R1', 10, '(property "Value" "10k") (property "MPN" "RC0402FR-0710KL")') +
            part('R2', 20, '(property "Value" "")') +
            part('R3', 30, '(property "Value" "1k") (attr dnp)')
        )
      )
    )
    // JLCPCB keys on LCSC and falls back to an MPN; R3 is not placed.
    expect(checks.partNumbers).toMatchObject({
      level: 'review',
      subjects: ['R2'],
      targets: ['fp-R2']
    })
    expect(checks.values).toMatchObject({ level: 'review', subjects: ['R2'] })
  })

  test("drills and hole spacing against the fab's numbers, not the board's rules", () => {
    const hole = (x: number, drill: number): string =>
      `(pad "1" thru_hole circle (at ${x} 0) (size 1.2 1.2) (drill ${drill}) (layers "*.Cu") (net 1 "GND"))`
    const checks = byCheck(
      audit(
        board(
          part(
            'J1',
            10,
            '(property "Value" "HDR") (property "LCSC" "C1")',
            hole(0, 0.15) + hole(0.5, 0.6)
          )
        )
      )
    )
    expect(checks.drillSize).toMatchObject({ level: 'review', count: 1, actual: 0.15, limit: 0.2 })
    // 0.5 mm apart less the two radii: 0.125 mm of board between them.
    expect(checks.holeSpacing).toMatchObject({ level: 'review', actual: 0.125, limit: 0.2 })
  })

  test('a zone that was never filled, and no BOM checks for a house that takes none', () => {
    const zone = `(zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z1") (hatch edge 0.5)
      (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10))))`
    const bareBoard = deriveExportProfile(findExportProfile('generic')!, {
      outputs: { gerber: {}, drill: {} }
    })
    const findings = audit(board(zone + part('R1', 10, '')), [], bareBoard)
    const checks = byCheck(findings)
    expect(checks.unfilledZones).toMatchObject({
      level: 'review',
      subjects: ['GND'],
      targets: ['z1']
    })
    expect(checks.partNumbers).toBeUndefined()
    expect(checks.values).toBeUndefined()
  })
})
