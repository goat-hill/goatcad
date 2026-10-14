import { describe, expect, test } from 'vitest'
import { parseKicadSchematic } from '../../kicad/schematic'
import { makeNetClass, netClassForNet, type NetClass } from '../../kicad/project'
import { buildConnectivity } from '../connectivity'
import { classConnectionStyles } from '../classConnectionStyles'

const wire = (y: number): string =>
  `(wire (pts (xy 100 ${y}) (xy 120 ${y})) (stroke (width 0) (type default)))`
const label = (text: string, y: number): string =>
  `(label "${text}" (at 100 ${y} 0) (effects (font (size 1.27 1.27))))`

describe('wires drawn by their net class (KiCad SCH_LINE::GetLineColor)', () => {
  const schematic = parseKicadSchematic(
    `(kicad_sch (version 20231120) (generator "test") (uuid "root")
       ${wire(100)} ${label('+5V', 100)} ${wire(120)} ${label('SIG', 120)})`
  )
  const inputs = [{ sheetPath: '/root', namePath: '/', schematic }]
  const connectivity = buildConnectivity(inputs)
  const fallback = makeNetClass('Default')
  const power: NetClass = {
    ...makeNetClass('Power'),
    wireWidth: 0.5,
    lineStyle: 'dash',
    schematicColor: { r: 200, g: 0, b: 0, a: 1 }
  }
  const classOf = (net: string): NetClass =>
    netClassForNet(net, [fallback, power], [{ netClass: 'Power', pattern: '/+*' }])

  test("a class's color, width and style reach its wires; a plain class draws as before", () => {
    const styles = classConnectionStyles(schematic, '/root', connectivity, classOf, fallback)
    expect(styles.wires[0]).toEqual({
      color: { r: 200, g: 0, b: 0, a: 1 },
      width: 0.5,
      lineStyle: 'dash'
    })
    expect(styles.wires[1]).toBeNull()
    expect(styles.bus).toBeNull()
  })
})
