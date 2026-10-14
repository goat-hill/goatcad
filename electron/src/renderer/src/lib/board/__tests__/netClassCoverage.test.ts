import { describe, expect, test } from 'vitest'
import { assignableNets, groupNets, netCoverage, splitNetName } from '../netClassCoverage'

const NETS = assignableNets([
  '',
  'GND',
  '+3V3',
  '/usb/USB_D+',
  '/usb/USB_D-',
  '/usb/VBUS',
  '/mcu/PA10',
  '/mcu/PA2',
  '/mcu/PA1',
  '/mcu/CLK_P',
  '/mcu/CLK_N',
  'unconnected-(U1-PA5-Pad12)',
  'Net-(R1-Pad1)',
  'Net-(R2-Pad1)'
])

describe('assignableNets', () => {
  test('drops the unnamed and single-pad nets and reads numbers as numbers', () => {
    expect(NETS).not.toContain('')
    expect(NETS.some((n) => n.startsWith('unconnected-'))).toBe(false)
    const mcu = NETS.filter((n) => n.startsWith('/mcu/PA'))
    expect(mcu).toEqual(['/mcu/PA1', '/mcu/PA2', '/mcu/PA10'])
  })
})

describe('netCoverage', () => {
  test('counts each pattern, and what is left is Default', () => {
    const cov = netCoverage(NETS, [{ pattern: '/usb/*', netClass: 'USB' }], [])
    expect(cov.patterns[0]).toMatchObject({ count: 3, overlap: 0, invalid: false })
    expect(cov.unassigned).toHaveLength(NETS.length - 3)
    expect(cov.unassigned).not.toContain('/usb/VBUS')
  })

  test('a net two classes take is an overlap on both rows, naming the other', () => {
    const cov = netCoverage(
      NETS,
      [
        { pattern: '/usb/*', netClass: 'USB' },
        { pattern: '*VBUS', netClass: 'Power' }
      ],
      []
    )
    expect(cov.patterns[0]).toMatchObject({ overlap: 1, overlapClasses: ['Power'] })
    expect(cov.patterns[1]).toMatchObject({ count: 1, overlap: 1, overlapClasses: ['USB'] })
    expect(cov.classesOf.get('/usb/VBUS')).toEqual(['USB', 'Power'])
  })

  test('two patterns into one class are not an overlap', () => {
    const cov = netCoverage(
      NETS,
      [
        { pattern: '/usb/*', netClass: 'USB' },
        { pattern: '*VBUS', netClass: 'USB' }
      ],
      []
    )
    expect(cov.patterns.map((p) => p.overlap)).toEqual([0, 0])
  })

  test('a schematic assignment places a net and marks it fixed', () => {
    const cov = netCoverage(
      NETS,
      [],
      [
        { net: 'GND', netClass: 'Power' },
        { net: 'NOPE', netClass: 'X' }
      ]
    )
    expect(cov.fixed).toEqual(new Set(['GND']))
    expect(cov.unassigned).not.toContain('GND')
  })

  test('an expression that does not compile is invalid; a plain miss is not', () => {
    const cov = netCoverage(
      NETS,
      [
        { pattern: '/usb/(USB', netClass: 'USB' },
        { pattern: 'NOTHING', netClass: 'USB' }
      ],
      []
    )
    expect(cov.patterns.map((p) => p.invalid)).toEqual([true, false])
  })

  test('an anchored expression counts what it matches', () => {
    const cov = netCoverage(NETS, [{ pattern: '^/mcu/PA[0-9]$', netClass: 'IO' }], [])
    expect(cov.matches[0]).toEqual(['/mcu/PA1', '/mcu/PA2'])
  })
})

describe('groupNets', () => {
  test('groups by sheet, root first, and reports what the cap left out', () => {
    const { groups, hidden } = groupNets(NETS, 5)
    expect(hidden).toBe(NETS.length - 5)
    expect(groups[0].path).toBe('')
    expect(groups.reduce((n, g) => n + g.names.length, 0)).toBe(5)
  })

  test('splits a hierarchical name at its last slash', () => {
    expect(splitNetName('/a/b/NET')).toEqual({ path: '/a/b/', leaf: 'NET' })
    expect(splitNetName('GND')).toEqual({ path: '', leaf: 'GND' })
  })
})

describe('pairs among the listed nets', () => {
  test("a pair's halves are listed together, positive first; a half alone stays alone", () => {
    const { groups } = groupNets(['/USB_D-', '/VBUS', '/USB_D+', '/CLK_P', '/USB_DP'], 10)
    expect(groups[0].items).toEqual([['/USB_D+', '/USB_D-'], '/VBUS', '/CLK_P', '/USB_DP'])
  })
})
