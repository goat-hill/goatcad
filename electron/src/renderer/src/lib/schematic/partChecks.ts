/**
 * The ERC rules about parts as a whole and about sheets: references (not
 * annotated, duplicated, a unit the part does not have, units that disagree on
 * their value), multi-unit parts (units not placed and what their pins would
 * have carried, units that disagree on a footprint, one pin on two nets across
 * units) and two sheets of one name. KiCad's ERC is the spec; the annotation
 * rules are the ones its ERC dialog runs before the checks (`kicad-cli sch erc`
 * does not run them, so the parity suite cannot hold them).
 */
import type { CheckResult } from './checks'
import type { SchematicConnectivity, SchematicNet, SheetConnectivityInput } from './connectivity'
import {
  definitionIdOf,
  getSheetProperty,
  getSymbolProperty,
  placedPinUuid,
  type KicadLibSymbol,
  type KicadSchematic,
  type KicadSchematicSymbol,
  type KicadSymbolInstance,
  type SymbolPin
} from '../kicad/schematic'
import { asMm } from './schematicAgent'

/** One placed part on one sheet instance. */
interface Placement {
  sheetPath: string
  schematic: KicadSchematic
  symbol: KicadSchematicSymbol
  reference: string
  unit: number
  definition?: KicadLibSymbol
}

const instanceOf = (
  symbol: KicadSchematicSymbol,
  sheetPath: string
): KicadSymbolInstance | undefined =>
  symbol.instances.find((instance) => instance.path === sheetPath)

/** Every non-power part on every sheet instance, with its reference and unit there. */
const placementsOf = (sheets: SheetConnectivityInput[]): Placement[] =>
  sheets.flatMap(({ sheetPath, schematic }) =>
    schematic.symbols.flatMap((symbol): Placement[] => {
      const instance = instanceOf(symbol, sheetPath)
      const reference = instance?.reference ?? getSymbolProperty(symbol, 'Reference') ?? ''
      if (!reference || reference.startsWith('#')) return []
      return [
        {
          sheetPath,
          schematic,
          symbol,
          reference,
          unit: instance?.unit ?? symbol.unit,
          definition: schematic.libSymbols.get(definitionIdOf(symbol))
        }
      ]
    })
  )

/** How many units the part's definition has: its highest unit number. */
const unitCount = (definition: KicadLibSymbol | undefined): number =>
  Math.max(1, ...(definition?.variants.map((variant) => variant.unit) ?? []))

/** The pins a unit draws, with the pins every unit shares. */
const unitPins = (definition: KicadLibSymbol, unit: number): SymbolPin[] => [
  ...definition.pins,
  ...definition.variants
    .filter((variant) => variant.unit === 0 || variant.unit === unit)
    .flatMap((variant) => variant.pins)
]

const at = (placement: Placement): { x: number; y: number } => ({
  x: asMm(placement.symbol.position.x),
  y: asMm(placement.symbol.position.y)
})

const unitLetter = (unit: number): string => String.fromCharCode(64 + unit)

/** `R12` as prefix and number; no number when it is `R?` or bare. */
const splitReference = (reference: string): { prefix: string; number: number | null } => {
  const match = /^(.*?)(\d+)$/.exec(reference)
  return match
    ? { prefix: match[1], number: Number(match[2]) }
    : { prefix: reference.replace(/\?$/, ''), number: null }
}

const annotationChecks = (placements: Placement[]): CheckResult[] => {
  const results: CheckResult[] = []
  const byReference = new Map<string, Placement[]>()
  for (const placement of placements) {
    const { number } = splitReference(placement.reference)
    const symbolId = placement.symbol.uuid ? [placement.symbol.uuid] : []
    if (number === null) {
      results.push({
        code: 'unannotated',
        severity: 'error',
        message: `${placement.reference} is not annotated. Annotate the schematic (schematic_annotate) so every part has a reference number.`,
        items: [placement.reference],
        position: at(placement),
        sheetPath: placement.sheetPath,
        targets: symbolId,
        kicadIds: symbolId,
        subject: placement.reference
      })
      continue
    }
    const units = unitCount(placement.definition)
    if (placement.unit > units) {
      results.push({
        code: 'extra-units',
        severity: 'error',
        message: `${placement.reference} is placed as unit ${placement.unit}, but its symbol has ${units === 1 ? 'one unit' : `${units} units`}. Set a unit it has.`,
        items: [placement.reference],
        position: at(placement),
        sheetPath: placement.sheetPath,
        targets: symbolId,
        kicadIds: symbolId,
        subject: placement.reference
      })
    }
    const list = byReference.get(placement.reference) ?? []
    list.push(placement)
    byReference.set(placement.reference, list)
  }
  for (const [reference, list] of byReference) {
    if (list.length < 2) continue
    const sorted = [...list].sort(
      (a, b) =>
        a.unit - b.unit ||
        (getSymbolProperty(a.symbol, 'Value') ?? '').localeCompare(
          getSymbolProperty(b.symbol, 'Value') ?? ''
        )
    )
    for (let index = 0; index + 1 < sorted.length; index++) {
      const first = sorted[index]
      const second = sorted[index + 1]
      const ids = [first.symbol.uuid, second.symbol.uuid].filter((id): id is string => !!id)
      const multi = unitCount(first.definition) > 1
      if (
        first.unit === second.unit ||
        unitCount(first.definition) !== unitCount(second.definition)
      ) {
        const name = multi ? `${reference}${unitLetter(first.unit)}` : reference
        results.push({
          code: 'duplicate-reference',
          severity: 'error',
          message:
            first.unit === second.unit
              ? `Two parts are both ${name}. Re-annotate (schematic_annotate) or renumber one of them.`
              : `${reference} is used by parts with different unit counts. Renumber one of them.`,
          items: [reference],
          position: at(first),
          sheetPath: first.sheetPath,
          targets: ids,
          kicadIds: ids,
          subject: reference
        })
        continue
      }
      const a = getSymbolProperty(first.symbol, 'Value') ?? ''
      const b = getSymbolProperty(second.symbol, 'Value') ?? ''
      if (a !== b) {
        results.push({
          code: 'unit-value-mismatch',
          severity: 'error',
          message: `The units of ${reference} disagree on its value: ${reference}${unitLetter(first.unit)} is ${a}, ${reference}${unitLetter(second.unit)} is ${b}. Give every unit the same value.`,
          items: [reference],
          position: at(second),
          sheetPath: second.sheetPath,
          targets: ids,
          kicadIds: ids,
          subject: reference
        })
      }
    }
  }
  return results
}

/** Multi-unit parts by reference, units in sheet order. Unannotated ones are left out. */
const multiUnitParts = (placements: Placement[]): Map<string, Placement[]> => {
  const parts = new Map<string, Placement[]>()
  for (const placement of placements) {
    if (unitCount(placement.definition) < 2 || placement.reference.endsWith('?')) continue
    const list = parts.get(placement.reference) ?? []
    list.push(placement)
    parts.set(placement.reference, list)
  }
  return parts
}

const unitChecks = (placements: Placement[]): CheckResult[] => {
  const results: CheckResult[] = []
  for (const [reference, units] of multiUnitParts(placements)) {
    const base = units[0]
    const definition = base.definition!
    const count = unitCount(definition)
    const baseId = base.symbol.uuid ? [base.symbol.uuid] : []
    if (units.length !== count) {
      const placed = new Set(units.map((unit) => unit.unit))
      const missing: number[] = []
      for (let unit = 1; unit <= count; unit++) if (!placed.has(unit)) missing.push(unit)
      const list = (numbers: number[]): string =>
        numbers.map((unit) => `${reference}${unitLetter(unit)}`).join(', ')
      const report = (
        code: string,
        severity: CheckResult['severity'],
        numbers: number[],
        what: string
      ): void => {
        results.push({
          code,
          severity,
          message: `${reference} has ${what} in units not placed: ${list(numbers)}. Place them (schematic_place_symbol with unit), or the pins they carry go nowhere.`,
          items: [reference],
          position: at(base),
          sheetPath: base.sheetPath,
          targets: baseId,
          kicadIds: baseId,
          subject: reference
        })
      }
      if (missing.length) {
        results.push({
          code: 'missing-unit',
          severity: 'warning',
          message: `${reference} has units not placed: ${list(missing)}. Place them, or they never reach the board.`,
          items: [reference],
          position: at(base),
          sheetPath: base.sheetPath,
          targets: baseId,
          kicadIds: baseId,
          subject: reference
        })
      }
      const byType = (type: string): number[] =>
        missing.filter((unit) =>
          unitPins(definition, unit).some((pin) => pin.electricalType === type)
        )
      const power = byType('power_in')
      const inputs = byType('input')
      const bidi = byType('bidirectional')
      if (power.length) report('missing-power-pin', 'error', power, 'power input pins')
      if (inputs.length) report('missing-input-pin', 'warning', inputs, 'input pins')
      if (bidi.length) report('missing-bidi-pin', 'warning', bidi, 'bidirectional pins')
    }
    const withFootprint = units.find((unit) => getSymbolProperty(unit.symbol, 'Footprint'))
    const footprint = withFootprint && getSymbolProperty(withFootprint.symbol, 'Footprint')
    for (const unit of units) {
      const other = getSymbolProperty(unit.symbol, 'Footprint')
      if (!withFootprint || !other || other === footprint) continue
      const ids = [withFootprint.symbol.uuid, unit.symbol.uuid].filter((id): id is string => !!id)
      results.push({
        code: 'different-unit-footprint',
        severity: 'error',
        message: `The units of ${reference} name different footprints: ${footprint} and ${other}. A part has one footprint; give every unit the same.`,
        items: [reference],
        position: at(unit),
        sheetPath: unit.sheetPath,
        targets: ids,
        kicadIds: ids,
        subject: reference
      })
    }
  }
  return results
}

/** One pin of a multi-unit part (a pin its units share) on two nets. */
const unitNetChecks = (
  connectivity: SchematicConnectivity,
  placements: Placement[]
): CheckResult[] => {
  const multi = new Set(multiUnitParts(placements).keys())
  const results: CheckResult[] = []
  // By the net itself: two unconnected nets can share a name.
  const seen = new Map<string, { net: SchematicNet; id?: string }>()
  for (const net of connectivity.nets) {
    for (const entry of net.pins) {
      if (!multi.has(entry.reference)) continue
      const key = `${entry.reference}:${entry.pin.number}`
      const id = placedPinUuid(entry.symbol, entry.pin.number)
      const first = seen.get(key)
      if (!first) {
        seen.set(key, { net, id })
        continue
      }
      if (first.net === net) continue
      const ids = [id, first.id].filter((value): value is string => !!value)
      results.push({
        code: 'different-unit-net',
        severity: 'error',
        message: `Pin ${entry.pin.number} of ${entry.reference} is on both ${net.name} and ${first.net.name}. The units share that pin, so it can be on one net only.`,
        items: [`${entry.reference}.${entry.pin.number}`],
        position: { x: asMm(entry.position.x), y: asMm(entry.position.y) },
        sheetPath: entry.sheetPath,
        targets: entry.symbol.uuid ? [entry.symbol.uuid] : [],
        kicadIds: ids,
        subject: `${entry.reference}.${entry.pin.number}`
      })
    }
  }
  return results
}

/** Two sheet symbols on one sheet with one name, as KiCad compares them: ignoring case. */
const sheetNameChecks = (sheets: SheetConnectivityInput[]): CheckResult[] => {
  const results: CheckResult[] = []
  const seen = new Set<object>()
  for (const { sheetPath, schematic } of sheets) {
    if (seen.has(schematic)) continue
    seen.add(schematic)
    const boxes = schematic.sheets
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = getSheetProperty(boxes[i], 'Sheetname') ?? ''
        const b = getSheetProperty(boxes[j], 'Sheetname') ?? ''
        if (a.toLowerCase() !== b.toLowerCase()) continue
        const ids = [boxes[i].uuid, boxes[j].uuid].filter((id): id is string => !!id)
        results.push({
          code: 'duplicate-sheet-name',
          severity: 'error',
          message: `Two sheets here are both named ${a}. Sheet names on one sheet must differ; rename one.`,
          items: [a],
          position: { x: asMm(boxes[i].position.x), y: asMm(boxes[i].position.y) },
          sheetPath,
          targets: ids,
          kicadIds: ids,
          subject: a
        })
      }
    }
  }
  return results
}

export const partChecks = (
  connectivity: SchematicConnectivity,
  sheets: SheetConnectivityInput[]
): CheckResult[] => {
  const placements = placementsOf(sheets)
  return [
    ...annotationChecks(placements),
    ...unitChecks(placements),
    ...unitNetChecks(connectivity, placements),
    ...sheetNameChecks(sheets)
  ]
}

export const PART_RULES: Record<string, string> = {
  unannotated: 'A part with no reference number (R?). Annotate the schematic.',
  'duplicate-reference':
    'Two parts share a reference (or its units disagree on how many units the part has).',
  'extra-units': 'A part placed as a unit its symbol does not have.',
  'unit-value-mismatch': "The units of one part disagree on the part's value.",
  'missing-unit': 'A multi-unit part with units that are not placed anywhere.',
  'missing-power-pin':
    'A multi-unit part whose unplaced units carry power input pins, so the part is never powered.',
  'missing-input-pin': 'A multi-unit part whose unplaced units carry input pins, left floating.',
  'missing-bidi-pin':
    'A multi-unit part whose unplaced units carry bidirectional pins, left floating.',
  'different-unit-footprint': 'The units of one part name different footprints; a part has one.',
  'different-unit-net': 'A pin the units of a part share, on two different nets.',
  'duplicate-sheet-name': 'Two sheet symbols on one sheet with the same name (ignoring case).'
}

export const PART_KICAD_KEYS: Record<string, string> = {
  unannotated: 'unannotated',
  'duplicate-reference': 'duplicate_reference',
  'extra-units': 'extra_units',
  'unit-value-mismatch': 'unit_value_mismatch',
  'missing-unit': 'missing_unit',
  'missing-power-pin': 'missing_power_pin',
  'missing-input-pin': 'missing_input_pin',
  'missing-bidi-pin': 'missing_bidi_pin',
  'different-unit-footprint': 'different_unit_footprint',
  'different-unit-net': 'different_unit_net',
  'duplicate-sheet-name': 'duplicate_sheet_names'
}
