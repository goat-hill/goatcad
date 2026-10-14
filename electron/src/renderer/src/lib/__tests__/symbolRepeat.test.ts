import { describe, expect, it } from 'vitest'
import { parseKicadSymbolLibrary, serializeKicadSymbolLibrary } from '../kicad/symbolLibrary'
import {
  appendRepeatCopy,
  incrementPinLabel,
  symbolGraphicNodes,
  symbolPinNodes
} from '../symbol/symbolEdit'
import { repeatOffset, REPEAT_NUMBER_STEP, REPEAT_PITCH } from '../symbolRepeat'
import { mmToNm } from '../kicad/coordinates'
import type { SymbolPin } from '../kicad/schematic'

const LIBRARY = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "Conn"
    (property "Reference" "J" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "Conn_0_1"
      (rectangle (start -2.54 2.54) (end 2.54 -2.54)
        (stroke (width 0.254) (type default)) (fill (type none)))
    )
    (symbol "Conn_1_1"
      (pin passive line (at -5.08 2.54 0) (length 2.54)
        (name "D0" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
    )
  )
)
`

describe('incrementPinLabel', () => {
  it('steps the trailing integer and leaves the rest alone', () => {
    expect(incrementPinLabel('1', 1)).toBe('2')
    expect(incrementPinLabel('D0', 3)).toBe('D3')
    expect(incrementPinLabel('A12', 1)).toBe('A13')
    expect(incrementPinLabel('9', 1)).toBe('10')
  })

  it('leaves a label with no trailing digits unchanged', () => {
    // The reason a pin's NAME can be run through this unconditionally: `~` means
    // "no name", and a plain signal name has nothing to number.
    expect(incrementPinLabel('~', 5)).toBe('~')
    expect(incrementPinLabel('VCC', 1)).toBe('VCC')
    expect(incrementPinLabel('', 1)).toBe('')
  })

  it('keeps zero padding at the width it was written, and lets it grow', () => {
    expect(incrementPinLabel('D00', 1)).toBe('D01')
    expect(incrementPinLabel('D09', 1)).toBe('D10')
  })
})

/**
 * The direction rule, which is the whole of this feature's design: only the
 * pin's AXIS matters, never which way along it it points. Rows read the way
 * symbol text reads — left-to-right or bottom-to-top — so a right-edge column
 * runs down exactly as a left-edge one does.
 */
describe('repeatOffset', () => {
  const P = REPEAT_PITCH

  it('columns downward for a horizontal pin, whichever edge it is on', () => {
    expect(repeatOffset(0)).toEqual({ x: 0, y: -P }) // left edge, points right
    expect(repeatOffset(180)).toEqual({ x: 0, y: -P }) // right edge, points left
  })

  it('runs rightward for a vertical pin, whichever edge it is on', () => {
    expect(repeatOffset(90)).toEqual({ x: P, y: 0 }) // bottom edge, points up
    expect(repeatOffset(270)).toEqual({ x: P, y: 0 }) // top edge, points down
  })

  it('goes down for a graphic, which has no heading to be relative to', () => {
    expect(repeatOffset(null)).toEqual({ x: 0, y: -P })
  })

  it('never returns a diagonal, even for an off-axis pin', () => {
    // An angle KiCad would not write, but the file could carry: snap to an axis
    // rather than stepping diagonally, where nothing would line up.
    for (const angle of [0, 44, 46, 100, 179, 200, 271, 359, 360, -90]) {
      const { x, y } = repeatOffset(angle)
      expect(x === 0 || y === 0).toBe(true)
      expect(Math.hypot(x, y)).toBeCloseTo(P, 9)
    }
  })

  it('is exact on the axis it moves along — no float tail to accumulate', () => {
    // Pressing the key forty times must not drift the fortieth pin off grid.
    expect(repeatOffset(0).y).toBe(-P)
    expect(repeatOffset(90).x).toBe(P)
  })
})

describe('appendRepeatCopy', () => {
  /** Repeat `times` from the pin, chaining off the previous copy each time. */
  const repeated = (times: number, angle = 0): SymbolPin[] => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    const symbolNode = library.symbols.get('Conn')!._node
    let source = symbolPinNodes(symbolNode)[0]
    for (let i = 0; i < times; i++) {
      source = appendRepeatCopy(symbolNode, source, repeatOffset(angle), REPEAT_NUMBER_STEP)
    }
    const round = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
    return round.symbols.get('Conn')!.variants.find((v) => v.unit === 1)!.pins
  }

  it('chains: each press continues the row from the copy before it', () => {
    const pins = repeated(3)
    expect(pins.map((p) => p.number)).toEqual(['1', '2', '3', '4'])
    expect(pins.map((p) => p.name)).toEqual(['D0', 'D1', 'D2', 'D3'])
    // Evenly spaced from the original at 2.54 mm, not compounding or stalling.
    expect(pins.map((p) => p.position.y)).toEqual([2.54, 0, -2.54, -5.08].map(mmToNm))
  })

  it('keeps the pin pointing the way the original does', () => {
    const pins = repeated(2)
    for (const pin of pins) {
      expect(pin.position.angle).toBe(0)
      expect(pin.position.x).toBe(mmToNm(-5.08))
      expect(pin.length).toBe(mmToNm(2.54))
      expect(pin.electricalType).toBe('passive')
    }
  })

  it('lands the copy in the unit its source lives in, leaving the body alone', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    const symbolNode = library.symbols.get('Conn')!._node
    appendRepeatCopy(symbolNode, symbolPinNodes(symbolNode)[0], repeatOffset(0), 1)
    const symbol = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library)).symbols.get(
      'Conn'
    )!
    expect(symbol.variants.find((v) => v.unit === 1)!.pins.length).toBe(2)
    expect(symbol.variants.find((v) => v.unit === 0)!.pins.length).toBe(0)
    expect(symbol.variants.find((v) => v.unit === 0)!.graphics.length).toBe(1)
  })

  it('repeats a graphic by moving it, with no number to step', () => {
    const library = parseKicadSymbolLibrary(LIBRARY)
    const symbolNode = library.symbols.get('Conn')!._node
    appendRepeatCopy(symbolNode, symbolGraphicNodes(symbolNode)[0], repeatOffset(null), 1)
    const round = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library))
    const graphics = round.symbols.get('Conn')!.variants.find((v) => v.unit === 0)!.graphics
    expect(graphics.length).toBe(2)
    const moved = graphics[1] as Extract<(typeof graphics)[number], { type: 'rectangle' }>
    expect(moved.start.y).toBe(mmToNm(2.54) - REPEAT_PITCH)
    expect(moved.end.y).toBe(mmToNm(-2.54) - REPEAT_PITCH)
  })
})
