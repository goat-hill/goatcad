/**
 * The model behind every editor's health pill and findings drawer: one list of
 * findings per open document, counted, grouped by rule, and named for a person.
 *
 * Design: `docs/design-health-workstream.md`. The engines (`schematic/checks.ts`,
 * `footprint/footprintChecks.ts`, `symbol/symbolChecks.ts`, `board/boardChecks.ts`) answer agents in their own vocabulary; this is
 * the same findings as the GUI reads them — which is why it adapts a
 * `CheckResult` rather than defining rules of its own.
 */
import type { CheckMeasure, CheckResult, CheckSeverity } from './schematic/checks'
import { tk, type MessageKey } from './messageKey'
import { markupToPlainText } from './kicad/textMarkup'
import { compareNatural } from './schematic/pinTable'

export interface HealthFinding {
  /** Unique within one report, and the same for the same finding on the next run. */
  key: string
  code: string
  severity: CheckSeverity
  /** Design names only (`U1.3`, `SDA`), set in mono. */
  subject: string
  /** The sheet it is on, by name path; null where a document has one place. */
  place: string | null
  /** The numbers it turns on, for the row (`formatMeasure`). */
  measure?: CheckMeasure
  /** Short context beside the subject where there are no numbers. */
  detail?: string
  /** The layer it is on, where a rule reports one finding per layer. */
  layer?: string
  /** The editor's one-click remedy for it, already translated, when it has one. */
  fix?: string
  /** A KiCad exclusion in the project names it, with the comment KiCad keeps. */
  excluded?: { comment: string }
}

/** An editor with no checker says so, rather than reporting a clean design. */
/** `pending`: the checks have not finished a first run, so nothing is known yet, clean or not. */
export type HealthReport =
  | { status: 'unavailable' }
  | { status: 'pending' }
  | { status: 'checked'; findings: HealthFinding[] }

export interface HealthCounts {
  errors: number
  warnings: number
}

/** An excluded finding is listed, never counted. */
export const healthCounts = (findings: HealthFinding[]): HealthCounts => ({
  errors: findings.filter((finding) => !finding.excluded && finding.severity === 'error').length,
  warnings: findings.filter((finding) => !finding.excluded && finding.severity === 'warning').length
})

/** The findings KiCad exclusions name, in list order: the drawer's last group. */
export const excludedFindings = (findings: HealthFinding[]): HealthFinding[] =>
  findings.filter((finding) => finding.excluded)

export interface HealthGroup {
  code: string
  /** The worst severity in the group: a rule that is an error in one case leads. */
  severity: CheckSeverity
  findings: HealthFinding[]
}

/**
 * One group per rule, as a reader would find them: error groups first, then by
 * the rule's title A–Z (`title`, else its code). Within a group, errors before
 * warnings, then by sheet (the root's first), then by subject in natural order
 * (`R2` before `R10`). Excluded findings are in none (`excludedFindings`).
 */
export const groupFindings = (
  findings: HealthFinding[],
  title: (code: string) => string = (code) => code
): HealthGroup[] => {
  const groups = new Map<string, HealthGroup>()
  for (const finding of findings) {
    if (finding.excluded) continue
    const group = groups.get(finding.code) ?? {
      code: finding.code,
      severity: finding.severity,
      findings: []
    }
    if (finding.severity === 'error') group.severity = 'error'
    group.findings.push(finding)
    groups.set(finding.code, group)
  }
  const rank = (severity: CheckSeverity): number => (severity === 'error' ? 0 : 1)
  const byReading = (a: HealthFinding, b: HealthFinding): number =>
    rank(a.severity) - rank(b.severity) ||
    (a.place === null ? 0 : 1) - (b.place === null ? 0 : 1) ||
    compareNatural(a.place ?? '', b.place ?? '') ||
    compareNatural(a.subject, b.subject)
  return [...groups.values()]
    .map((group) => ({ ...group, findings: [...group.findings].sort(byReading) }))
    .sort(
      (a, b) =>
        rank(a.severity) - rank(b.severity) ||
        title(a.code).localeCompare(title(b.code)) ||
        a.code.localeCompare(b.code)
    )
}

/**
 * The rule's name for a person. The engines' own sentences are written for an
 * agent (they name the op that fixes it), so the GUI names rules itself.
 */
const RULE_TITLES: Record<string, MessageKey> = {
  'unconnected-pin': tk('designHealth.rules.unconnectedPin'),
  'unconnected-wire-end': tk('designHealth.rules.unconnectedWireEnd'),
  'off-grid': tk('designHealth.rules.offGrid'),
  'pin-conflict': tk('designHealth.rules.pinConflict'),
  'input-undriven': tk('designHealth.rules.inputUndriven'),
  'wire-dangling': tk('designHealth.rules.wireDangling'),
  'label-dangling': tk('designHealth.rules.labelDangling'),
  'label-single-pin': tk('designHealth.rules.labelSinglePin'),
  'no-connect-connected': tk('designHealth.rules.noConnectConnected'),
  'no-connect-dangling': tk('designHealth.rules.noConnectDangling'),
  'multiple-net-names': tk('designHealth.rules.multipleNetNames'),
  'label-multiple-wires': tk('designHealth.rules.labelMultipleWires'),
  'net-not-bus-member': tk('designHealth.rules.netNotBusMember'),
  'bus-to-bus-conflict': tk('designHealth.rules.busToBusConflict'),
  'bus-to-net-conflict': tk('designHealth.rules.busToNetConflict'),
  'unconnected-sheet-port': tk('designHealth.rules.unconnectedSheetPort'),
  unannotated: tk('designHealth.rules.unannotated'),
  'duplicate-reference': tk('designHealth.rules.duplicateReference'),
  'extra-units': tk('designHealth.rules.extraUnits'),
  'unit-value-mismatch': tk('designHealth.rules.unitValueMismatch'),
  'missing-unit': tk('designHealth.rules.missingUnit'),
  'missing-power-pin': tk('designHealth.rules.missingPowerPin'),
  'missing-input-pin': tk('designHealth.rules.missingInputPin'),
  'missing-bidi-pin': tk('designHealth.rules.missingBidiPin'),
  'different-unit-footprint': tk('designHealth.rules.differentUnitFootprint'),
  'different-unit-net': tk('designHealth.rules.differentUnitNet'),
  'duplicate-sheet-name': tk('designHealth.rules.duplicateSheetName'),
  'similar-labels': tk('designHealth.rules.similarLabels'),
  'similar-power': tk('designHealth.rules.similarPower'),
  'similar-label-and-power': tk('designHealth.rules.similarLabelAndPower'),
  'same-local-global-label': tk('designHealth.rules.sameLocalGlobalLabel'),
  'ground-pin-not-ground': tk('designHealth.rules.groundPinNotGround'),
  'stacked-pin-name': tk('designHealth.rules.stackedPinName'),
  'field-name-whitespace': tk('designHealth.rules.fieldNameWhitespace'),
  'undefined-netclass': tk('designHealth.rules.undefinedNetclass'),
  'unresolved-variable': tk('designHealth.rules.unresolvedVariable'),
  'single-global-label': tk('designHealth.rules.singleGlobalLabel'),
  'four-way-junction': tk('designHealth.rules.fourWayJunction'),
  'symbol-library-issue': tk('designHealth.rules.symbolLibraryIssue'),
  'footprint-link-issue': tk('designHealth.rules.footprintLinkIssue'),
  'footprint-filter': tk('designHealth.rules.footprintFilter'),
  'power-input-undriven': tk('designHealth.rules.powerInputUndriven'),
  'sheet-pin-unmatched': tk('designHealth.rules.sheetPinUnmatched'),
  'hierarchical-label-unmatched': tk('designHealth.rules.hierarchicalLabelUnmatched'),
  'symbol-library-mismatch': tk('designHealth.rules.symbolLibraryMismatch'),
  'pads-overlap': tk('designHealth.rules.padsOverlap'),
  'net-tie-short': tk('designHealth.rules.netTieShort'),
  'net-tie-groups': tk('designHealth.rules.netTieGroups'),
  'silk-clipped-by-mask': tk('designHealth.rules.silkClippedByMask'),
  padstack: tk('designHealth.rules.padstack'),
  'padstack-invalid': tk('designHealth.rules.padstackInvalid'),
  'through-hole-pad-without-hole': tk('designHealth.rules.throughHolePadWithoutHole'),
  'malformed-courtyard': tk('designHealth.rules.malformedCourtyard'),
  'holes-co-located': tk('designHealth.rules.holesCoLocated'),
  'hole-to-hole': tk('designHealth.rules.holeToHole'),
  'silk-width': tk('designHealth.rules.silkWidth'),
  'reference-text': tk('designHealth.rules.referenceText'),
  'value-text': tk('designHealth.rules.valueText'),
  'missing-courtyard': tk('designHealth.rules.missingCourtyard'),
  'courtyard-enclosure': tk('designHealth.rules.courtyardEnclosure'),
  'footprint-type-mismatch': tk('designHealth.rules.footprintTypeMismatch'),
  'duplicate-pin': tk('designHealth.rules.duplicatePin'),
  'power-symbol': tk('designHealth.rules.powerSymbol'),
  'power-symbol-hidden-pin': tk('designHealth.rules.powerSymbolHiddenPin'),
  'hidden-power-pin': tk('designHealth.rules.hiddenPowerPin'),
  'off-grid-pin': tk('designHealth.rules.offGridPin'),
  'reference-prefix': tk('designHealth.rules.referencePrefix'),
  'zero-size-graphic': tk('designHealth.rules.zeroSizeGraphic'),
  'custom-rules': tk('designHealth.rules.customRules'),
  'copper-clearance': tk('designHealth.rules.copperClearance'),
  'copper-short': tk('designHealth.rules.copperShort'),
  'tracks-crossing': tk('designHealth.rules.tracksCrossing'),
  'track-on-post-machined-layer': tk('designHealth.rules.trackOnPostMachinedLayer'),
  'hole-clearance': tk('designHealth.rules.holeClearance'),
  'holes-too-close': tk('designHealth.rules.holesTooClose'),
  'copper-edge-clearance': tk('designHealth.rules.copperEdgeClearance'),
  'unconnected-items': tk('designHealth.rules.unconnectedItems'),
  'track-width': tk('designHealth.rules.trackWidth'),
  'via-diameter': tk('designHealth.rules.viaDiameter'),
  'annular-width': tk('designHealth.rules.annularWidth'),
  'drill-out-of-range': tk('designHealth.rules.drillOutOfRange'),
  'microvia-drill-out-of-range': tk('designHealth.rules.microviaDrillOutOfRange'),
  'courtyards-overlap': tk('designHealth.rules.courtyardsOverlap'),
  'pth-inside-courtyard': tk('designHealth.rules.pthInsideCourtyard'),
  'npth-inside-courtyard': tk('designHealth.rules.npthInsideCourtyard'),
  'invalid-outline': tk('designHealth.rules.invalidOutline'),
  'items-not-allowed': tk('designHealth.rules.itemsNotAllowed'),
  'zones-intersect': tk('designHealth.rules.zonesIntersect'),
  'isolated-copper': tk('designHealth.rules.isolatedCopper'),
  'starved-thermal': tk('designHealth.rules.starvedThermal'),
  'track-dangling': tk('designHealth.rules.trackDangling'),
  'via-dangling': tk('designHealth.rules.viaDangling'),
  'text-height': tk('designHealth.rules.textHeight'),
  'text-thickness': tk('designHealth.rules.textThickness'),
  'mirrored-text-on-front': tk('designHealth.rules.mirroredTextOnFront'),
  'nonmirrored-text-on-back': tk('designHealth.rules.nonmirroredTextOnBack'),
  'text-on-edge-cuts': tk('designHealth.rules.textOnEdgeCuts'),
  'drc-error': tk('designHealth.rules.drcError'),
  'drc-warning': tk('designHealth.rules.drcWarning'),
  'track-segment-length': tk('designHealth.rules.trackSegmentLength'),
  'track-angle': tk('designHealth.rules.trackAngle'),
  'track-not-centered-on-via': tk('designHealth.rules.trackNotCenteredOnVia'),
  'part-type-mismatch': tk('designHealth.rules.partTypeMismatch'),
  footprint: tk('designHealth.rules.footprint'),
  'no-courtyard': tk('designHealth.rules.noCourtyard'),
  'item-on-disabled-layer': tk('designHealth.rules.itemOnDisabledLayer'),
  'assertion-failure': tk('designHealth.rules.assertionFailure'),
  'missing-tuning-profile': tk('designHealth.rules.missingTuningProfile'),
  'silk-overlap': tk('designHealth.rules.silkOverlap'),
  'silk-over-copper': tk('designHealth.rules.silkOverCopper'),
  'silk-edge-clearance': tk('designHealth.rules.silkEdgeClearance'),
  'solder-mask-bridge': tk('designHealth.rules.solderMaskBridge'),
  'length-out-of-range': tk('designHealth.rules.lengthOutOfRange'),
  'skew-out-of-range': tk('designHealth.rules.skewOutOfRange'),
  'too-many-vias': tk('designHealth.rules.tooManyVias'),
  'diff-pair-gap': tk('designHealth.rules.diffPairGap'),
  'diff-pair-uncoupled-length': tk('designHealth.rules.diffPairUncoupledLength'),
  creepage: tk('designHealth.rules.creepage'),
  'library-footprint-issue': tk('designHealth.rules.libraryFootprintIssue'),
  'library-footprint-mismatch': tk('designHealth.rules.libraryFootprintMismatch'),
  'duplicate-footprints': tk('designHealth.rules.duplicateFootprints'),
  'missing-footprint': tk('designHealth.rules.missingFootprint'),
  'extra-footprint': tk('designHealth.rules.extraFootprint'),
  'footprint-symbol-mismatch': tk('designHealth.rules.footprintSymbolMismatch'),
  'footprint-symbol-field-mismatch': tk('designHealth.rules.footprintSymbolFieldMismatch'),
  'footprint-filters-mismatch': tk('designHealth.rules.footprintFiltersMismatch'),
  'net-conflict': tk('designHealth.rules.netConflict'),
  'connection-width': tk('designHealth.rules.connectionWidth'),
  'copper-sliver': tk('designHealth.rules.copperSliver')
}

/** The rule's title key, or null for a rule this table does not know yet. */
export const ruleTitle = (code: string): MessageKey | null => RULE_TITLES[code] ?? null

/** Codes the table names, for the test that holds every engine rule to a title. */
export const titledRules = (): string[] => Object.keys(RULE_TITLES)

/** Keys made unique: two findings with the same identity get `#2`, `#3`. */
const uniqueKeys = <T>(entries: T[], keyOf: (entry: T) => string): string[] => {
  const seen = new Map<string, number>()
  return entries.map((entry) => {
    const base = keyOf(entry)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : `${base}#${count}`
  })
}

const identity = (result: CheckResult): string =>
  [
    result.code,
    result.sheetPath ?? '',
    result.items.join(','),
    result.position ? `${result.position.x},${result.position.y}` : '',
    result.layer ?? ''
  ].join('|')

const rowExtras = (result: CheckResult): Pick<HealthFinding, 'measure' | 'detail' | 'layer'> => ({
  ...(result.layer ? { layer: result.layer } : {}),
  ...(result.measure ? { measure: result.measure } : {}),
  ...(result.detail ? { detail: markupToPlainText(result.detail) } : {})
})

/** A measured value as a row prints it: at most four decimals, no trailing zeros. */
export const measureValue = (value: number, unit: CheckMeasure['unit']): string => {
  const number = String(Number(value.toFixed(unit === 'count' ? 0 : unit === 'deg' ? 1 : 4)))
  return unit === 'mm'
    ? `${number} mm`
    : unit === 'deg'
      ? `${number}°`
      : unit === 'ps'
        ? `${number} ps`
        : number
}

// A subject names design items as they read — `PCIe_{C1x1}` as `PCIeC1x1`
// (kicad/textMarkup.ts). Only the drawer's copy: an agent reads the
// `CheckResult`, whose names stay as stored so it can address them.
const subjectOf = (result: CheckResult): string =>
  (result.subject && markupToPlainText(result.subject)) ||
  result.items.join(', ') ||
  (result.position ? `(${result.position.x}, ${result.position.y})` : '')

/** A sheet's name path for a row; none on the root sheet, whose path is only `/`. */
const sheetPlace = (
  sheetPath: string | undefined,
  names: ReadonlyMap<string, string>
): string | null => {
  if (sheetPath === undefined) return null
  const name = names.get(sheetPath) ?? sheetPath
  return name === '/' ? null : name
}

/**
 * A schematic's findings as the drawer lists them, alike on every sheet: in the
 * checks' order, each naming the sheet it is on, the root's none (`names` maps
 * an instance path to its name path).
 */
export const schematicFindings = (
  results: CheckResult[],
  names: ReadonlyMap<string, string>
): HealthFinding[] => {
  const keys = uniqueKeys(results, identity)
  return results.map((result, index) => ({
    key: keys[index],
    code: result.code,
    severity: result.severity,
    subject: subjectOf(result),
    place: sheetPlace(result.sheetPath, names),
    ...rowExtras(result),
    ...(result.excluded ? { excluded: { comment: result.excluded.comment } } : {})
  }))
}

/** A footprint's or a symbol's findings: one document, so every finding is here. */
export const documentFindings = (results: CheckResult[]): HealthFinding[] => {
  const keys = uniqueKeys(results, identity)
  return results.map((result, index) => ({
    key: keys[index],
    code: result.code,
    severity: result.severity,
    subject: subjectOf(result),
    place: null,
    ...rowExtras(result),
    ...(result.excluded ? { excluded: { comment: result.excluded.comment } } : {})
  }))
}

/** A finding's canvas marker: where it is, in the editor's frame, and how bad. */
export interface FindingMark {
  key: string
  x: number
  y: number
  severity: 'error' | 'warning'
  /** The finding the drawer or a click last picked: drawn over every other. */
  selected?: true
}

/**
 * The markers an editor draws for its findings, the drawer's list read beside
 * the results it was built from, index for index: one per error or warning
 * that has a place, none for a finding a KiCad exclusion names. `at` places a
 * result, by default at its own position; `selected` names the picked finding.
 */
export const findingMarks = (
  results: readonly CheckResult[],
  findings: readonly HealthFinding[],
  at: (result: CheckResult) => { x: number; y: number } | null = (result) =>
    result.position ?? null,
  selected: string | null = null
): FindingMark[] =>
  results.flatMap((result, index) => {
    const finding = findings[index]
    if (!finding || finding.excluded) return []
    const place = at(result)
    return place
      ? [
          {
            key: finding.key,
            x: place.x,
            y: place.y,
            severity: result.severity,
            ...(finding.key === selected ? { selected: true as const } : {})
          }
        ]
      : []
  })
