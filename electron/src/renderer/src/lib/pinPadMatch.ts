/**
 * Which of a symbol's pins a footprint has a pad for, and which pads no pin
 * names — the check the library chooser shows before a footprint is assigned
 * (docs/libraries-workstream.md §3). A stacked pin (`[1,3,5-7]`) stands
 * for each of its pads, as connectivity reads it.
 */
import { stackedPads } from './schematic/connectivity'

export interface PinRef {
  number: string
  name: string
}

export interface PinPadMatch {
  /** Pads a pin lands on. */
  matched: number
  pinsWithoutPad: PinRef[]
  padsWithoutPin: string[]
}

const byNumber = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

/** The distinct pad numbers a symbol's pins name, stacked pins expanded. */
export function pinPadNumbers(pins: readonly PinRef[]): Set<string> {
  const numbers = new Set<string>()
  for (const pin of pins) {
    if (!pin.number) continue
    for (const pad of stackedPads(pin.number)) numbers.add(pad)
  }
  return numbers
}

export function matchPinsToPads(
  pins: readonly PinRef[],
  padNumbers: readonly string[]
): PinPadMatch {
  const pads = new Set(padNumbers.filter(Boolean))
  const wanted = new Set<string>()
  const seen = new Set<string>()
  const pinsWithoutPad: PinRef[] = []
  for (const pin of pins) {
    if (!pin.number || seen.has(pin.number)) continue
    seen.add(pin.number)
    const numbers = stackedPads(pin.number)
    for (const number of numbers) wanted.add(number)
    if (numbers.some((number) => !pads.has(number))) pinsWithoutPad.push(pin)
  }
  pinsWithoutPad.sort((a, b) => byNumber(a.number, b.number))
  const padsWithoutPin = [...pads].filter((pad) => !wanted.has(pad)).sort(byNumber)
  const matched = [...pads].filter((pad) => wanted.has(pad)).length
  return { matched, pinsWithoutPad, padsWithoutPin }
}
