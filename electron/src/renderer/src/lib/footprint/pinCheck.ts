/**
 * Symbol pins against footprint pads, by number: the check that catches a
 * swapped pinout before it reaches copper.
 *
 * A shared pad number is one pin, and a pad the symbol omits on purpose (a
 * no-connect pad) shows up under `padsWithoutPin`, which is correct.
 */
export interface PinCheck {
  matched: number
  padsWithoutPin: string[]
  pinsWithoutPad: string[]
}

const byNumber = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

export const pinCheck = (padNumbers: string[], pinNumbers: string[]): PinCheck => {
  const pads = new Set(padNumbers.filter(Boolean))
  const pins = new Set(pinNumbers.filter(Boolean))
  return {
    matched: [...pads].filter((number) => pins.has(number)).length,
    padsWithoutPin: [...pads].filter((number) => !pins.has(number)).sort(byNumber),
    pinsWithoutPad: [...pins].filter((number) => !pads.has(number)).sort(byNumber)
  }
}

/** Whether a check says anything a reader must act on. */
export const pinCheckClean = (check: PinCheck): boolean =>
  check.padsWithoutPin.length === 0 && check.pinsWithoutPad.length === 0
