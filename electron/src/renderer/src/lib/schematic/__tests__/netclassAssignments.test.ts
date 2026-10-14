import { describe, expect, test } from 'vitest'
import { parseKicadSchematic } from '../../kicad/schematic'
import { patchNetclassAssignments } from '../../kicad/project'
import { buildConnectivity } from '../connectivity'
import { netclassAssignments } from '../netclassAssignments'

const wire = (x0: number, y0: number, x1: number, y1: number): string =>
  `(wire (pts (xy ${x0} ${y0}) (xy ${x1} ${y1})) (stroke (width 0) (type default)))`
const label = (text: string, x: number, y: number, field = ''): string =>
  `(label "${text}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)))${field})`
const flag = (netClass: string, x: number, y: number): string =>
  `(netclass_flag "" (length 2.54) (shape round) (at ${x} ${y} 0) (effects (font (size 1.27 1.27)))
     (property "Netclass" "${netClass}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)))))`

const sheet = (body: string): ReturnType<typeof parseKicadSchematic> =>
  parseKicadSchematic(`(kicad_sch (version 20231120) (generator "test") (uuid "root") ${body})`)

describe('net class assignments from the schematic (KiCad netclass_assignments)', () => {
  const schematic = sheet(
    [
      wire(100, 100, 120, 100),
      label('USB_DP', 100, 100),
      flag('USB', 110, 100),
      wire(100, 120, 120, 120),
      label('VBUS', 100, 120, ' (property "Netclass" "Power" (at 100 120 0))'),
      wire(100, 140, 120, 140),
      label('CLK', 100, 140),
      flag('${FAST}', 115, 140)
    ].join(' ')
  )
  const inputs = [{ sheetPath: '/root', namePath: '/', schematic }]
  const found = netclassAssignments(inputs, buildConnectivity(inputs), { FAST: 'Fast' })

  test('a directive flag and a label field each put their net in the class, text variables resolved', () => {
    expect(found).toEqual([
      { net: '/CLK', netClass: 'Fast' },
      { net: '/USB_DP', netClass: 'USB' },
      { net: '/VBUS', netClass: 'Power' }
    ])
  })

  test('written as KiCad saves it, and a second write changes nothing', () => {
    const text = JSON.stringify({ net_settings: { netclass_assignments: { '/OLD': ['Gone'] } } })
    const patched = patchNetclassAssignments(text, found)!
    expect(JSON.parse(patched).net_settings.netclass_assignments).toEqual({
      '/CLK': ['Fast'],
      '/USB_DP': ['USB'],
      '/VBUS': ['Power']
    })
    expect(patchNetclassAssignments(patched, found)).toBe(patched)
    // None left: KiCad's empty map is null, and a file already saying so stays as it is.
    expect(
      JSON.parse(patchNetclassAssignments(patched, [])!).net_settings.netclass_assignments
    ).toBe(null)
    const plain = JSON.stringify({ net_settings: { classes: [] } })
    expect(patchNetclassAssignments(plain, [])).toBe(plain)
  })
})
