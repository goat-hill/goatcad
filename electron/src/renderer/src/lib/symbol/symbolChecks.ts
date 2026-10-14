// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * The symbol checks: KiCad's symbol checker, `CheckLibSymbol` and the
 * `CheckDuplicatePins` / `CheckLibSymbolGraphics` it calls
 * (`eeschema/symbol_checker.cpp`). KiCad gives these no violation keys and no
 * severities, so the codes and severities here are ours
 * (kicad-parity.md); which cases are found is KiCad's.
 *
 * Results use the sheet checks' shape (`schematic/checks.ts`), so the delta,
 * grouping and compaction an agent already reads apply unchanged.
 */
import { mmToNm, nmToMm, spacingToMm, type Nm } from '../kicad/coordinates'
import { findChild, getFirstAtomValue } from '../kicad/sexpr'
import {
  libSymbolChain,
  pinText,
  type KicadLibSymbol,
  type Point,
  type SymbolGraphic,
  type SymbolPin
} from '../kicad/schematic'
import type { CheckResult } from '../schematic/checks'
import { symbolUnitCount, type SymbolPartAddress } from './symbolEdit'

/** The rules, for an agent. */
export const SYMBOL_CHECK_RULES: Record<string, string> = {
  'duplicate-pin':
    'Two pins share a number in one body style, so the netlist cannot tell them apart. Renumber one; pins in different body styles may share a number.',
  'power-symbol':
    'A power symbol must have one unit and one pin, and that pin must be power input or power output: anything else does not name a net.',
  'power-symbol-hidden-pin':
    "A power symbol's power-input pin is hidden. KiCad no longer needs it hidden: the symbol's value names the net either way.",
  'hidden-power-pin':
    'A hidden power-input pin connects to the net named after it on every sheet, without a wire. Intended for some parts; a surprise on most.',
  'off-grid-pin':
    'A pin end is off the grid, so a wire drawn on the schematic grid cannot meet it. Move it by whole grid steps.',
  'reference-prefix':
    'The reference prefix is empty, or ends in a digit or "?", which annotation cannot number.',
  'zero-size-graphic': 'A circle has no radius or a rectangle has no size, so nothing is drawn.'
}

/** KiCad's floor for the pin grid: 25 mil, and the grid a check uses is never finer. */
export const MIN_PIN_GRID: Nm = mmToNm(spacingToMm(25, 'mil'))

/** An address as a finding's target, and back: what the editor selects. */
export const symbolTarget = (address: SymbolPartAddress): string =>
  address.kind === 'field'
    ? `field:${address.field ?? ''}`
    : `${address.kind}:${address.unit}.${address.style}.${address.index}`

export const symbolTargetAddress = (target: string): SymbolPartAddress | null => {
  const field = target.match(/^field:(.+)$/)
  if (field) return { kind: 'field', unit: 0, style: 0, index: 0, field: field[1] }
  const part = target.match(/^(pin|graphic):(\d+)\.(\d+)\.(\d+)$/)
  if (!part) return null
  return {
    kind: part[1] as 'pin' | 'graphic',
    unit: Number(part[2]),
    style: Number(part[3]),
    index: Number(part[4])
  }
}

/**
 * KiCad's stacked pin notation (`ExpandStackedPinNotation`): `[1,3,5-7]` is
 * one pin carrying five numbers. Null when the number is not stacked, or is
 * malformed, in which case KiCad treats it as the one number it spells.
 */
export const expandStackedPinNumber = (number: string): string[] | null => {
  if (!number.startsWith('[') || !number.endsWith(']') || number.length < 2) return null
  const numbers: string[] = []
  for (const raw of number.slice(1, -1).split(',')) {
    const part = raw.trim()
    if (!part) continue
    const dash = part.indexOf('-')
    if (dash < 0) {
      numbers.push(part)
      continue
    }
    const start = part
      .slice(0, dash)
      .trim()
      .match(/^(.*?)(\d+)$/)
    const end = part
      .slice(dash + 1)
      .trim()
      .match(/^(.*?)(\d+)$/)
    if (!start || !end || start[1] !== end[1] || Number(start[2]) > Number(end[2])) return null
    for (let n = Number(start[2]); n <= Number(end[2]); n++) numbers.push(`${start[1]}${n}`)
  }
  return numbers.length ? numbers : null
}

interface PlacedPin {
  pin: SymbolPin
  unit: number
  style: number
  /** Null for a pin the open symbol does not own (it `extends` another). */
  address: SymbolPartAddress | null
}

interface PlacedGraphic {
  graphic: SymbolGraphic
  address: SymbolPartAddress | null
}

const mm = (value: number): number => Math.round(nmToMm(value as Nm) * 1000) / 1000
const at = (point: Point): string => `(${mm(point.x)}, ${mm(point.y)})`
const position = (point: Point): { x: number; y: number } => ({ x: mm(point.x), y: mm(point.y) })

/** Every pin and shape of a definition, with the unit and style it belongs to. */
const partsOf = (
  definition: KicadLibSymbol,
  owned: boolean
): { pins: PlacedPin[]; graphics: PlacedGraphic[] } => {
  const pins: PlacedPin[] = definition.pins.map((pin) => ({
    pin,
    unit: 0,
    style: 0,
    address: null
  }))
  const graphics: PlacedGraphic[] = definition.graphics.map((graphic) => ({
    graphic,
    address: null
  }))
  for (const { unit, style, pins: unitPins, graphics: unitGraphics } of definition.variants) {
    const address = (kind: 'pin' | 'graphic', index: number): SymbolPartAddress | null =>
      owned ? { kind, unit, style, index } : null
    unitPins.forEach((pin, index) =>
      pins.push({ pin, unit, style, address: address('pin', index) })
    )
    unitGraphics.forEach((graphic, index) =>
      graphics.push({ graphic, address: address('graphic', index) })
    )
  }
  return { pins, graphics }
}

/** `(power)` and `(power global)` are global; `(power local)` names a net on one sheet. */
const powerKind = (definition: KicadLibSymbol): 'global' | 'local' | null => {
  const node = findChild(definition._node, 'power')
  if (!node) return null
  return getFirstAtomValue(node) === 'local' ? 'local' : 'global'
}

/**
 * Check one library symbol. A derived symbol is checked as KiCad checks it:
 * its reference is its own, while its pins, units and power flag are those of
 * the symbol it `extends`, resolved through `lookup`. `grid` is the pin grid,
 * never finer than `MIN_PIN_GRID`.
 */
export const symbolChecks = (
  symbol: KicadLibSymbol,
  grid: Nm,
  lookup: (name: string) => KicadLibSymbol | undefined = () => undefined
): CheckResult[] => {
  const out: CheckResult[] = []
  const chain = libSymbolChain(symbol, lookup)
  const root = chain[chain.length - 1]
  const owned = root === symbol
  const { pins, graphics } = partsOf(root, owned)
  const unitCount = symbolUnitCount(root._node)
  const pinGrid = Math.max(grid, MIN_PIN_GRID)
  const inherited = owned ? '' : ` (inherited from ${root.name})`

  const pinLabel = (placed: PlacedPin): string =>
    unitCount > 1 && placed.unit > 0
      ? `pin ${placed.pin.number}, unit ${String.fromCharCode(64 + placed.unit)}`
      : `pin ${placed.pin.number}`
  const pinFinding = (
    placed: PlacedPin[]
  ): Pick<CheckResult, 'items' | 'targets' | 'subject' | 'position'> => ({
    items: placed.map((entry) => `pin:${entry.pin.number}`).sort(),
    targets: placed.flatMap((entry) => (entry.address ? [symbolTarget(entry.address)] : [])),
    subject: placed.map(pinLabel).join('; '),
    position: position(placed[0].pin.position)
  })

  const reference = symbol.properties.find((property) => property.key === 'Reference')?.value ?? ''
  if (!reference || /[0-9?]$/.test(reference)) {
    out.push({
      code: 'reference-prefix',
      severity: 'warning',
      message: reference
        ? `The reference prefix "${reference}" ends in "${reference.slice(-1)}", which annotation cannot number after.`
        : 'The reference is empty.',
      items: ['field:Reference'],
      targets: [symbolTarget({ kind: 'field', unit: 0, style: 0, index: 0, field: 'Reference' })],
      subject: reference || 'Reference'
    })
  }

  // `CheckDuplicatePins`: one entry per number a pin carries, sorted so equal
  // numbers sit together; neighbors clash unless both name different styles.
  const logical = pins.flatMap((placed) =>
    (expandStackedPinNumber(placed.pin.number) ?? [placed.pin.number]).map((number) => ({
      placed,
      number
    }))
  )
  logical.sort(
    (a, b) =>
      (a.number < b.number ? -1 : a.number > b.number ? 1 : 0) ||
      a.placed.style - b.placed.style ||
      a.placed.unit - b.placed.unit
  )
  for (let i = 1; i < logical.length; i++) {
    const prev = logical[i - 1]
    const next = logical[i]
    if (prev.number !== next.number || prev.placed === next.placed) continue
    if (prev.placed.style && next.placed.style && prev.placed.style !== next.placed.style) continue
    out.push({
      code: 'duplicate-pin',
      severity: 'error',
      message: `Pin ${next.number} at ${at(next.placed.pin.position)} has the same number as the pin at ${at(prev.placed.pin.position)}${inherited}.`,
      ...pinFinding([prev.placed, next.placed])
    })
  }

  const power = powerKind(root)
  if (power) {
    const problems: string[] = []
    if (unitCount !== 1) problems.push(`it has ${unitCount} units`)
    if (pins.length !== 1) problems.push(`it has ${pins.length} pins`)
    const type = pins[0]?.pin.electricalType
    if (type && type !== 'power_in' && type !== 'power_out')
      problems.push(`its pin is ${type}, not power input or power output`)
    if (problems.length) {
      out.push({
        code: 'power-symbol',
        severity: 'error',
        message: `This power symbol cannot name a net: ${problems.join('; ')}${inherited}.`,
        ...(pins.length ? pinFinding(pins.slice(0, 1)) : { items: [], subject: symbol.name })
      })
    }
    if (type === 'power_in' && pins[0].pin.hidden) {
      out.push({
        code: 'power-symbol-hidden-pin',
        severity: 'warning',
        message: `The power symbol's pin ${pins[0].pin.number} is hidden, which KiCad no longer requires${inherited}.`,
        ...pinFinding(pins.slice(0, 1))
      })
    }
  }

  for (const placed of pins) {
    const { pin } = placed
    const name = pinText(pin.name)
    if (power !== 'global' && pin.electricalType === 'power_in' && pin.hidden) {
      out.push({
        code: 'hidden-power-pin',
        severity: 'warning',
        message: `Pin ${pin.number}${name ? ` "${name}"` : ''} at ${at(pin.position)} is a hidden power input, so it joins the net "${name}" on every sheet without a wire${inherited}.`,
        ...pinFinding([placed])
      })
    }
    if (pin.position.x % pinGrid !== 0 || pin.position.y % pinGrid !== 0) {
      out.push({
        code: 'off-grid-pin',
        severity: 'warning',
        message: `Pin ${pin.number}${name ? ` "${name}"` : ''} at ${at(pin.position)} is off the ${mm(pinGrid)} mm grid${inherited}.`,
        ...pinFinding([placed])
      })
    }
  }

  // `CheckLibSymbolGraphics` reads the open symbol's own drawing; a derived
  // symbol draws none.
  if (owned) {
    for (const { graphic, address } of graphics) {
      const where =
        graphic.type === 'circle' && graphic.radius <= 0
          ? graphic.center
          : graphic.type === 'rectangle' &&
              graphic.start.x === graphic.end.x &&
              graphic.start.y === graphic.end.y
            ? graphic.start
            : null
      if (!where) continue
      out.push({
        code: 'zero-size-graphic',
        severity: 'error',
        message: `A ${graphic.type} at ${at(where)} has ${graphic.type === 'circle' ? 'no radius' : 'no size'}.`,
        items: [`${graphic.type}@${mm(where.x)},${mm(where.y)}`],
        targets: address ? [symbolTarget(address)] : [],
        subject: `${graphic.type} ${at(where)}`,
        position: position(where)
      })
    }
  }

  return out.sort(
    (a, b) => a.code.localeCompare(b.code) || a.items.join(',').localeCompare(b.items.join(','))
  )
}
