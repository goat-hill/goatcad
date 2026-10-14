/**
 * A gallery of generated symbols, held to the layout's own text model: every
 * name, number and field boxed by `symbolTextBoxes` and judged by
 * `textViolations` — the same two functions the layout sizes the body with, so
 * a symbol that passes here is one the layout could not have sized differently.
 *
 * Set SYMBOL_GALLERY_DIR to also write `<dir>/gallery.kicad_sym` and a
 * project beside it, so `render.symbol` can draw each one for a person.
 */
import { describe, expect, test } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateSymbol, parseOrCreateLibrary } from '../symbolGenerate'
import { serializeKicadSymbolLibrary } from '../../kicad/symbolLibrary'
import {
  planSymbol,
  symbolTextBoxes,
  textViolations,
  type SymbolGroupSpec,
  type SymbolPinSpec,
  type SymbolPinType
} from '../symbolLayout'

const MM = 1e6

const p = (
  number: string,
  name: string,
  type: SymbolPinType,
  group: string,
  extra: Partial<SymbolPinSpec> = {}
): SymbolPinSpec => ({ number, name, type, group, ...extra })

interface Case {
  name: string
  groups: SymbolGroupSpec[]
  pins: SymbolPinSpec[]
}

export const GALLERY: Case[] = [
  {
    name: 'LDO3',
    groups: [
      { id: 'in', role: 'signal' },
      { id: 'out', role: 'signal' },
      { id: 'gnd', role: 'ground' }
    ],
    pins: [
      p('1', 'VIN', 'power_in', 'in'),
      p('2', 'GND', 'power_in', 'gnd'),
      p('3', 'VOUT', 'power_out', 'out')
    ]
  },
  {
    name: 'SENSOR_LONGNAMES',
    groups: [
      { id: 'pwr', role: 'power' },
      { id: 'gnd', role: 'ground' },
      { id: 'ctl', role: 'signal' },
      { id: 'i2c', role: 'signal' }
    ],
    pins: [
      p('1', 'VDD', 'power_in', 'pwr'),
      p('2', 'GND', 'power_in', 'gnd'),
      p('3', 'nRESET_IN', 'input', 'ctl'),
      p('4', 'INTERRUPT_OUT', 'output', 'ctl'),
      p('5', 'ADDR_SELECT', 'input', 'ctl'),
      p('6', 'SDA', 'bidirectional', 'i2c'),
      p('7', 'SCL', 'input', 'i2c')
    ]
  },
  {
    // Long rail names, which the top refuses (see the test below), pinned to
    // the left as the refusal's remedy says.
    name: 'LONG_RAILS_LEFT',
    groups: [
      { id: 'pwr', role: 'power', side: 'left' },
      { id: 'gnd', role: 'ground' },
      { id: 'in', role: 'signal' },
      { id: 'out', role: 'signal' }
    ],
    pins: [
      p('1', 'VDD_CORE_1V2', 'power_in', 'pwr'),
      p('2', 'VDD_IO_3V3', 'power_in', 'pwr'),
      p('3', 'GND', 'power_in', 'gnd'),
      p('4', 'IN+', 'input', 'in'),
      p('5', 'IN-', 'input', 'in'),
      p('6', 'OUTPUT_ENABLE_N', 'input', 'out'),
      p('7', 'FAULT_INDICATOR', 'output', 'out')
    ]
  },
  {
    name: 'CODEC_EP',
    groups: [
      { id: 'pwr', role: 'power' },
      { id: 'gnd', role: 'ground' },
      { id: 'ain', role: 'signal' },
      { id: 'aout', role: 'signal' },
      { id: 'i2s', role: 'signal' },
      { id: 'i2c', role: 'signal' }
    ],
    pins: [
      p('1', 'AVDD', 'power_in', 'pwr'),
      p('2', 'DVDD', 'power_in', 'pwr'),
      p('3', 'HPVDD', 'power_in', 'pwr'),
      p('4', 'AGND', 'power_in', 'gnd'),
      p('5', 'DGND', 'power_in', 'gnd'),
      p('33', 'EP', 'power_in', 'gnd', { stackWith: '4' }),
      p('6', 'MICBIAS', 'output', 'ain'),
      p('7', 'LIN1', 'input', 'ain'),
      p('8', 'RIN1', 'input', 'ain'),
      p('9', 'LIN2', 'input', 'ain'),
      p('10', 'RIN2', 'input', 'ain'),
      p('11', 'LOUT1', 'output', 'aout'),
      p('12', 'ROUT1', 'output', 'aout'),
      p('13', 'LOUT2', 'output', 'aout'),
      p('14', 'ROUT2', 'output', 'aout'),
      p('15', 'I2S_MCLK', 'input', 'i2s'),
      p('16', 'I2S_SCLK', 'bidirectional', 'i2s'),
      p('17', 'I2S_LRCK', 'bidirectional', 'i2s'),
      p('18', 'I2S_DSDIN', 'input', 'i2s'),
      p('19', 'I2S_ASDOUT', 'output', 'i2s'),
      p('20', 'SCL', 'input', 'i2c'),
      p('21', 'SDA', 'bidirectional', 'i2c'),
      p('22', 'CE', 'input', 'i2c')
    ]
  },
  {
    name: 'USBC_RECEPTACLE',
    groups: [
      { id: 'pwr', role: 'power' },
      { id: 'gnd', role: 'ground' },
      { id: 'usb2', role: 'signal' },
      { id: 'cc', role: 'signal' },
      { id: 'sbu', role: 'signal' },
      { id: 'ss', role: 'signal' }
    ],
    pins: [
      p('A4', 'VBUS', 'power_in', 'pwr'),
      p('A9', 'VBUS', 'power_in', 'pwr', { stackWith: 'A4' }),
      p('B4', 'VBUS', 'power_in', 'pwr', { stackWith: 'A4' }),
      p('B9', 'VBUS', 'power_in', 'pwr', { stackWith: 'A4' }),
      p('A1', 'GND', 'power_in', 'gnd'),
      p('A12', 'GND', 'power_in', 'gnd', { stackWith: 'A1' }),
      p('B1', 'GND', 'power_in', 'gnd', { stackWith: 'A1' }),
      p('B12', 'GND', 'power_in', 'gnd', { stackWith: 'A1' }),
      p('S1', 'SHIELD', 'passive', 'gnd'),
      p('A6', 'D+', 'bidirectional', 'usb2'),
      p('B6', 'D+', 'bidirectional', 'usb2', { stackWith: 'A6' }),
      p('A7', 'D-', 'bidirectional', 'usb2'),
      p('B7', 'D-', 'bidirectional', 'usb2', { stackWith: 'A7' }),
      p('A5', 'CC1', 'bidirectional', 'cc'),
      p('B5', 'CC2', 'bidirectional', 'cc'),
      p('A8', 'SBU1', 'bidirectional', 'sbu'),
      p('B8', 'SBU2', 'bidirectional', 'sbu'),
      p('A2', 'SSTXp1', 'output', 'ss'),
      p('A3', 'SSTXn1', 'output', 'ss'),
      p('B11', 'SSRXp1', 'input', 'ss'),
      p('B10', 'SSRXn1', 'input', 'ss'),
      p('B2', 'SSTXp2', 'output', 'ss'),
      p('B3', 'SSTXn2', 'output', 'ss'),
      p('A11', 'SSRXp2', 'input', 'ss'),
      p('A10', 'SSRXn2', 'input', 'ss')
    ]
  },
  {
    name: 'MCU48',
    groups: [
      { id: 'pwr', role: 'power' },
      { id: 'gnd', role: 'ground' },
      { id: 'pa', role: 'signal' },
      { id: 'pb', role: 'signal' },
      { id: 'misc', role: 'signal' }
    ],
    pins: [
      p('1', 'VDD', 'power_in', 'pwr'),
      p('42', 'VDD', 'power_in', 'pwr', { stackWith: '1' }),
      p('48', 'VDD', 'power_in', 'pwr', { stackWith: '1' }),
      p('9', 'VDDA', 'power_in', 'pwr'),
      p('8', 'VSS', 'power_in', 'gnd'),
      p('43', 'VSS', 'power_in', 'gnd', { stackWith: '8' }),
      p('47', 'VSS', 'power_in', 'gnd', { stackWith: '8' }),
      ...Array.from({ length: 16 }, (_, i) =>
        p(String(10 + i), `PA${i}`, 'bidirectional' as const, 'pa')
      ),
      ...Array.from({ length: 16 }, (_, i) =>
        p(String(26 + i), `PB${i}`, 'bidirectional' as const, 'pb')
      ),
      p('2', 'PC13', 'bidirectional', 'misc'),
      p('3', 'PC14/OSC32_IN', 'bidirectional', 'misc'),
      p('4', 'PC15/OSC32_OUT', 'bidirectional', 'misc'),
      p('5', 'PF0/OSC_IN', 'bidirectional', 'misc'),
      p('6', 'PF1/OSC_OUT', 'bidirectional', 'misc'),
      p('7', 'NRST', 'input', 'misc'),
      p('44', 'BOOT0', 'input', 'misc')
    ]
  }
]

describe('generated symbol gallery: no text within the clearance of other text', () => {
  const dir = process.env.SYMBOL_GALLERY_DIR
  const library = parseOrCreateLibrary(null)
  const report: string[] = []

  for (const c of GALLERY) {
    test(c.name, () => {
      const plan = planSymbol(c.groups, c.pins, { reference: 'U' })
      if (!plan.ok) throw new Error(`${c.name}: ${plan.error} ${plan.detail ?? ''}`)
      generateSymbol(library, c.name, plan.layout, { reference: 'U', value: c.name })
      const found = textViolations(symbolTextBoxes(plan.layout, 'U?', c.name), plan.layout.body)
      const body = plan.layout.body
      report.push(
        `${c.name}: body ${(body.maxX - body.minX) / MM} x ${(body.maxY - body.minY) / MM} mm, pins ${plan.layout.pins.length}, warnings ${JSON.stringify(plan.layout.warnings)}`
      )
      for (const pr of found) report.push(`  TOO CLOSE ${pr.a} <-> ${pr.b}`)
      if (dir) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'gallery.kicad_sym'), serializeKicadSymbolLibrary(library))
        writeFileSync(join(dir, 'report.txt'), report.join('\n') + '\n')
      }
      expect(found).toEqual([])
      // The loop sized the body; it must not have given up.
      expect(plan.layout.warnings.filter((w) => w.includes('could not be sized'))).toEqual([])
    })
  }

  test('a rail name past the limit is refused, and the remedy is the side', () => {
    const plan = planSymbol(
      [
        { id: 'pwr', role: 'power' },
        { id: 'gnd', role: 'ground' },
        { id: 'io', role: 'signal' }
      ],
      [
        p('1', 'VDD_CORE_1V2', 'power_in', 'pwr'),
        p('2', 'GND', 'power_in', 'gnd'),
        p('3', 'IN', 'input', 'io')
      ]
    )
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toBe('rail-name-too-long')
    expect(plan.detail).toContain('VDD_CORE_1V2')
  })
})
