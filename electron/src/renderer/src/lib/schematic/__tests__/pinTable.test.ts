import { describe, expect, it } from 'vitest'
import { parseKicadSymbolLibrary } from '../../kicad/symbolLibrary'
import {
  buildPinTableRows,
  compareNatural,
  DEFAULT_PIN_SORT,
  duplicateAddresses,
  formatPinCsv,
  layoutImportedPins,
  normalizeElectricalType,
  parsePinCsv,
  sortPinTableRows,
  type PinTableRow
} from '../pinTable'
import { mmToNm as mm, nm, NM_PER_MIL, type Nm } from '../../kicad/coordinates'
import type { KicadLibSymbol } from '../../kicad/schematic'

/**
 * Two units plus a shared unit-0 body, a De Morgan style-2 variant, and a pin
 * whose number repeats — every case the table has to get right in one fixture.
 */
const LIBRARY = `(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "DUAL"
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "DUAL" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "DUAL_0_1"
      (pin power_in line (at 0 5.08 270) (length 2.54)
        (name "VCC" (effects (font (size 1.27 1.27))))
        (number "8" (effects (font (size 1.27 1.27)))))
    )
    (symbol "DUAL_1_1"
      (pin input line (at -7.62 2.54 0) (length 2.54)
        (name "INA" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
      (pin output line (at 7.62 0 180) (length 2.54)
        (name "OUTA" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
    )
    (symbol "DUAL_1_2"
      (pin input inverted (at -7.62 2.54 0) (length 2.54)
        (name "INA" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
    )
    (symbol "DUAL_2_1"
      (pin input line (at -7.62 -2.54 0) (length 2.54)
        (name "INB" (effects (font (size 1.27 1.27))))
        (number "3" (effects (font (size 1.27 1.27)))))
    )
    (symbol "DUAL_2_0"
      (pin power_in line (at 0 -5.08 90) (length 2.54)
        (name "VEE" (effects (font (size 1.27 1.27))))
        (number "4" (effects (font (size 1.27 1.27)))))
    )
  )
)`

const symbol = (): KicadLibSymbol => {
  const library = parseKicadSymbolLibrary(LIBRARY)
  const definition = library.symbols.get('DUAL')
  if (!definition) throw new Error('fixture symbol missing')
  return definition
}

const row = (over: Partial<PinTableRow> = {}): PinTableRow => ({
  address: { kind: 'pin', unit: 1, style: 1, index: 0 },
  number: '1',
  name: 'A',
  electricalType: 'passive',
  unit: 1,
  ...over
})

describe('buildPinTableRows', () => {
  it('lists the shared unit and every gate, in document order', () => {
    const rows = buildPinTableRows(symbol(), 1)
    expect(rows.map((r) => r.number)).toEqual(['8', '1', '1', '3', '4'])
    expect(rows.map((r) => r.unit)).toEqual([0, 1, 1, 2, 2])
    expect(rows.map((r) => r.name)).toEqual(['VCC', 'INA', 'OUTA', 'INB', 'VEE'])
  })

  it('carries an address that resolves back to the right variant', () => {
    const rows = buildPinTableRows(symbol(), 1)
    expect(rows[0].address).toEqual({ kind: 'pin', unit: 0, style: 1, index: 0 })
    expect(rows[3].address).toEqual({ kind: 'pin', unit: 2, style: 1, index: 0 })
    expect(rows[4].address).toEqual({ kind: 'pin', unit: 2, style: 0, index: 0 })
  })

  /**
   * A grid row for a pin the canvas does not draw would edit geometry
   * nobody can see.
   */
  it('shows only the body style being viewed, plus the style-0 common body', () => {
    const standard = buildPinTableRows(symbol(), 1)
    expect(standard.some((r) => r.address.style === 2)).toBe(false)

    // Style 0 is load-bearing, not a formality: `VEE` lives at
    // unit 2 / style 0 and must survive a switch to the alternate, where the
    // style-1 sub-symbols do not.
    const alternate = buildPinTableRows(symbol(), 2)
    expect(alternate.map((r) => r.address.style)).toEqual([2, 0])
    expect(alternate.map((r) => r.name)).toEqual(['INA', 'VEE'])
  })

  it('is empty for no definition', () => {
    expect(buildPinTableRows(null, 1)).toEqual([])
  })
})

describe('duplicateAddresses', () => {
  it('marks every row carrying a duplicated number', () => {
    const flagged = duplicateAddresses(buildPinTableRows(symbol(), 1))
    // Both `1`s — the unit-1 pair — and neither the `8`, the `3` nor the `4`.
    expect([...flagged].sort()).toEqual(['1.1.0', '1.1.1'])
  })

  /**
   * `A1` and `MP` are real pin numbers (BGA balls, mounting pads), so numbers
   * compare as strings and are never parsed — an unparseable number must not
   * read as absent.
   */
  it('compares non-numeric numbers too', () => {
    const rows = [
      row({ number: 'A1', address: { kind: 'pin', unit: 1, style: 1, index: 0 } }),
      row({ number: 'A1', address: { kind: 'pin', unit: 1, style: 1, index: 1 } }),
      row({ number: '2', address: { kind: 'pin', unit: 1, style: 1, index: 2 } })
    ]
    expect([...duplicateAddresses(rows)].sort()).toEqual(['1.1.0', '1.1.1'])
  })

  it('treats two blanks as duplicates of each other', () => {
    const rows = [
      row({ number: '', address: { kind: 'pin', unit: 1, style: 1, index: 0 } }),
      row({ number: '', address: { kind: 'pin', unit: 1, style: 1, index: 1 } })
    ]
    expect(duplicateAddresses(rows).size).toBe(2)
  })

  it('finds nothing when every number is distinct', () => {
    const rows = ['1', '2', '3'].map((number, index) =>
      row({ number, address: { kind: 'pin', unit: 1, style: 1, index } })
    )
    expect(duplicateAddresses(rows).size).toBe(0)
  })
})

describe('compareNatural', () => {
  /** The bug the whole function exists to fix: `10` between `1` and `2`. */
  it('orders numbers numerically, not lexicographically', () => {
    expect(['1', '10', '2', '21', '3'].sort(compareNatural)).toEqual(['1', '2', '3', '10', '21'])
  })

  it('orders a bus name by its index', () => {
    expect(['D10', 'D0', 'D2', 'D1'].sort(compareNatural)).toEqual(['D0', 'D1', 'D2', 'D10'])
  })

  it('puts plain numbers ahead of BGA balls instead of interleaving them', () => {
    expect(['B1', '2', 'A1', '10'].sort(compareNatural)).toEqual(['2', '10', 'A1', 'B1'])
  })

  it('is case-insensitive', () => {
    expect(compareNatural('sda', 'SDA')).toBe(0)
  })
})

describe('sortPinTableRows', () => {
  const rows = (): PinTableRow[] =>
    [
      { number: '10', name: 'D1', electricalType: 'output' },
      { number: '2', name: 'A0', electricalType: 'input' },
      { number: '1', name: 'D0', electricalType: 'output' }
    ].map((r, index) => row({ ...r, address: { kind: 'pin', unit: 1, style: 1, index } }))

  it('defaults to pin number ascending', () => {
    expect(sortPinTableRows(rows(), DEFAULT_PIN_SORT).map((r) => r.number)).toEqual([
      '1',
      '2',
      '10'
    ])
  })

  it('reverses on descending', () => {
    const sorted = sortPinTableRows(rows(), { key: 'number', direction: 'desc' })
    expect(sorted.map((r) => r.number)).toEqual(['10', '2', '1'])
  })

  it('sorts names naturally', () => {
    const sorted = sortPinTableRows(rows(), { key: 'name', direction: 'asc' })
    expect(sorted.map((r) => r.name)).toEqual(['A0', 'D0', 'D1'])
  })

  /** Sorting by Type is really GROUPING by it, so the pins inside each group
   *  have to stay in pin order or the grouping is barely worth having. */
  it('falls back to pin number inside a type group', () => {
    const sorted = sortPinTableRows(rows(), { key: 'electricalType', direction: 'asc' })
    expect(sorted.map((r) => r.electricalType)).toEqual(['input', 'output', 'output'])
    expect(sorted.map((r) => r.number)).toEqual(['2', '1', '10'])
  })

  it('reverses the groups without scrambling the pins inside them', () => {
    const sorted = sortPinTableRows(rows(), { key: 'electricalType', direction: 'desc' })
    expect(sorted.map((r) => r.electricalType)).toEqual(['output', 'output', 'input'])
    // Still ascending WITHIN the group, which is the point of the tie-break.
    expect(sorted.map((r) => r.number)).toEqual(['1', '10', '2'])
  })

  it('sorts the type column by its displayed label, not by the KiCad token', () => {
    // `power_in` sorts after `output` as a token and before it as "Power input"
    // would in a locale that spells it "Alimentation" — the label decides.
    const list = [
      row({
        number: '1',
        electricalType: 'output',
        address: { kind: 'pin', unit: 1, style: 1, index: 0 }
      }),
      row({
        number: '2',
        electricalType: 'power_in',
        address: { kind: 'pin', unit: 1, style: 1, index: 1 }
      })
    ]
    const sorted = sortPinTableRows(list, { key: 'electricalType', direction: 'asc' }, (value) =>
      value === 'power_in' ? 'Alimentation' : 'Sortie'
    )
    expect(sorted.map((r) => r.electricalType)).toEqual(['power_in', 'output'])
  })

  it('does not mutate the rows it is given', () => {
    const original = rows()
    const before = original.map((r) => r.number)
    sortPinTableRows(original, DEFAULT_PIN_SORT)
    expect(original.map((r) => r.number)).toEqual(before)
  })
})

describe('CSV export', () => {
  it('writes a header, CRLF endings, and the unit column only when asked', () => {
    const rows = buildPinTableRows(symbol(), 1)
    expect(formatPinCsv(rows, true)).toBe(
      'Number,Name,Type,Unit\r\n' +
        '8,VCC,power_in,0\r\n' +
        '1,INA,input,1\r\n' +
        '1,OUTA,output,1\r\n' +
        '3,INB,input,2\r\n' +
        '4,VEE,power_in,2\r\n'
    )
    expect(formatPinCsv(rows, false).split('\r\n')[0]).toBe('Number,Name,Type')
  })

  it('quotes a value containing a comma or a quote', () => {
    const rows = [row({ name: 'A0, A1', number: '1' }), row({ name: 'RX"', number: '2' })]
    const lines = formatPinCsv(rows, false).split('\r\n')
    expect(lines[1]).toBe('1,"A0, A1",passive')
    expect(lines[2]).toBe('2,"RX""",passive')
  })

  it('round-trips through the parser', () => {
    const rows = buildPinTableRows(symbol(), 1)
    const parsed = parsePinCsv(formatPinCsv(rows, true))
    expect(parsed.errors).toEqual([])
    expect(parsed.pins).toEqual(
      rows.map((r) => ({
        number: r.number,
        name: r.name,
        electricalType: r.electricalType,
        unit: r.unit
      }))
    )
  })
})

describe('CSV import', () => {
  it('reads a headerless comma file in export order', () => {
    const { pins, errors } = parsePinCsv('1,VDD,power_in\n2,GND,power_in')
    expect(errors).toEqual([])
    expect(pins).toEqual([
      { number: '1', name: 'VDD', electricalType: 'power_in', unit: 1 },
      { number: '2', name: 'GND', electricalType: 'power_in', unit: 1 }
    ])
  })

  /**
   * A datasheet table copied out of a PDF arrives tab-separated with commas
   * inside the names — counting delimiters over the whole file picks the wrong
   * one on exactly that input, so the choice is made on the first line.
   */
  it('detects tabs even when the names are full of commas', () => {
    const { pins } = parsePinCsv('1\tA0, A1 select\tinput\n2\tB0, B1 select\tinput')
    expect(pins.map((p) => p.name)).toEqual(['A0, A1 select', 'B0, B1 select'])
  })

  it('follows a header that reorders or omits columns', () => {
    const { pins } = parsePinCsv('Name,Type,Number\nSDA,bidirectional,14')
    expect(pins).toEqual([{ number: '14', name: 'SDA', electricalType: 'bidirectional', unit: 1 }])
  })

  /** "1, VDD, power_in" is data even though it sits first. */
  it('does not mistake a first data row for a header', () => {
    const { pins } = parsePinCsv('1,VDD,power_in')
    expect(pins).toHaveLength(1)
    expect(pins[0].number).toBe('1')
  })

  it('skips the bad row and keeps the rest, with a line number', () => {
    const { pins, errors } = parsePinCsv('1,VDD,power_in\n2,GND,wombat\n3,SDA,bidirectional')
    expect(pins.map((p) => p.number)).toEqual(['1', '3'])
    expect(errors).toEqual(['2: unknown electrical type "wombat"'])
  })

  it('refuses a row with no pin number', () => {
    const { pins, errors } = parsePinCsv(',VDD,power_in')
    expect(pins).toEqual([])
    expect(errors).toEqual(['1: no pin number'])
  })

  it('defaults a blank type to passive rather than refusing', () => {
    const { pins, errors } = parsePinCsv('1,VDD,')
    expect(errors).toEqual([])
    expect(pins[0].electricalType).toBe('passive')
  })

  it('reads quoted cells, including embedded quotes and delimiters', () => {
    const { pins } = parsePinCsv('1,"A0, A1",input\n2,"RX""",input')
    expect(pins.map((p) => p.name)).toEqual(['A0, A1', 'RX"'])
  })

  it('ignores blank lines', () => {
    const { pins, errors } = parsePinCsv('1,A,input\n\n\n2,B,input\n')
    expect(pins).toHaveLength(2)
    expect(errors).toEqual([])
  })
})

describe('normalizeElectricalType', () => {
  it('accepts KiCad tokens verbatim', () => {
    expect(normalizeElectricalType('power_in')).toBe('power_in')
    expect(normalizeElectricalType('tri_state')).toBe('tri_state')
  })

  it('is forgiving about shape', () => {
    expect(normalizeElectricalType('Power In')).toBe('power_in')
    expect(normalizeElectricalType('open-collector')).toBe('open_collector')
    expect(normalizeElectricalType('  BIDIRECTIONAL ')).toBe('bidirectional')
  })

  it('maps the spellings people actually write', () => {
    expect(normalizeElectricalType('I/O')).toBe('bidirectional')
    expect(normalizeElectricalType('NC')).toBe('no_connect')
    expect(normalizeElectricalType('power')).toBe('power_in')
  })

  /** A wrong type draws perfectly and fails in ERC — never guess `passive`. */
  it('refuses an unrecognised type rather than defaulting it', () => {
    expect(normalizeElectricalType('wombat')).toBeNull()
  })
})

describe('layoutImportedPins', () => {
  const pins = (
    n: number
  ): { number: string; name: string; electricalType: string; unit: number }[] =>
    Array.from({ length: n }, (_, i) => ({
      number: String(i + 1),
      name: `P${i + 1}`,
      electricalType: 'passive',
      unit: 1
    }))

  const PITCH = nm(100 * NM_PER_MIL)

  it('stacks one column at the 100 mil pitch, facing left', () => {
    const placed = layoutImportedPins(pins(3), [])
    expect(placed.map((p) => p.angle)).toEqual([0, 0, 0])
    expect(new Set(placed.map((p) => p.x)).size).toBe(1)
    expect(placed[0].y - placed[1].y).toBe(PITCH)
    expect(placed[1].y - placed[2].y).toBe(PITCH)
  })

  it('continues below the lowest existing pin instead of burying it', () => {
    const existing = [
      { x: mm(-7.62), y: mm(2.54) as Nm },
      { x: mm(-7.62), y: mm(-2.54) as Nm }
    ]
    const placed = layoutImportedPins(pins(2), existing)
    expect(placed.every((p) => p.y < mm(-2.54))).toBe(true)
    // Lines up with the column already there rather than starting a second one.
    expect(placed.every((p) => p.x === mm(-7.62))).toBe(true)
  })

  /**
   * The one outcome an import must not produce: two visible pins at one
   * coordinate read as a drawing mistake and give a reader no way to tell which
   * is which.
   */
  it('never lands on an occupied coordinate', () => {
    const existing = Array.from({ length: 5 }, (_, i) => ({
      x: mm(-7.62),
      y: nm(-i * PITCH) as Nm
    }))
    const placed = layoutImportedPins(pins(20), existing)
    const keys = new Set([...existing, ...placed].map((p) => `${p.x},${p.y}`))
    expect(keys.size).toBe(existing.length + placed.length)
  })

  it('places nothing for an empty import', () => {
    expect(layoutImportedPins([], [])).toEqual([])
  })
})
