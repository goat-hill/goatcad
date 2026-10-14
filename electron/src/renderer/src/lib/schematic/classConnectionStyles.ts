/**
 * How the schematic draws each wire and bus by its net's class (KiCad's
 * `SCH_LINE::GetLineColor`, `GetEffectiveLineStyle`, `GetPenWidth`): the class's
 * schematic color, wire or bus width and line style, else Default's, else
 * KiCad's own. A wire's own stroke still wins; the scene applies that. Nothing
 * is written to the sheet: moving a wire to another net restyles it.
 */
import type { KicadSchematic } from '../kicad/schematic'
import type { Rgba } from '../kicad/color'
import { SCHEMATIC_CLASS_DEFAULTS, type ClassLineStyle, type NetClass } from '../kicad/project'
import type { SchematicConnectivity } from './connectivity'

export interface ConnectionStyle {
  color?: Rgba
  /** mm */
  width: number
  lineStyle: ClassLineStyle
}

export interface ClassConnectionStyles {
  /** By wire index on the sheet; null where the class draws as KiCad's defaults. */
  wires: (ConnectionStyle | null)[]
  /** Every bus: Default's styling, null when that is KiCad's own. */
  bus: ConnectionStyle | null
}

const styleOf = (
  cls: NetClass,
  fallback: NetClass,
  kind: 'wire' | 'bus'
): ConnectionStyle | null => {
  const color = cls.schematicColor ?? fallback.schematicColor
  const width =
    kind === 'wire'
      ? (cls.wireWidth ?? fallback.wireWidth ?? SCHEMATIC_CLASS_DEFAULTS.wireWidth)
      : (cls.busWidth ?? fallback.busWidth ?? SCHEMATIC_CLASS_DEFAULTS.busWidth)
  const lineStyle = cls.lineStyle ?? fallback.lineStyle ?? SCHEMATIC_CLASS_DEFAULTS.lineStyle
  const plain =
    !color &&
    lineStyle === SCHEMATIC_CLASS_DEFAULTS.lineStyle &&
    Math.abs(
      width -
        (kind === 'wire' ? SCHEMATIC_CLASS_DEFAULTS.wireWidth : SCHEMATIC_CLASS_DEFAULTS.busWidth)
    ) < 1e-9
  return plain ? null : { ...(color ? { color } : {}), width, lineStyle }
}

export function classConnectionStyles(
  schematic: KicadSchematic,
  sheetPath: string,
  connectivity: SchematicConnectivity,
  classOf: (net: string) => NetClass,
  defaultClass: NetClass
): ClassConnectionStyles {
  // One class lookup per net, however many wires it has.
  const byNet = new Map<string, ConnectionStyle | null>()
  const wires = schematic.wires.map((_, index) => {
    const net = connectivity.netOfWire(sheetPath, index)?.name
    if (net === undefined) return styleOf(defaultClass, defaultClass, 'wire')
    if (!byNet.has(net)) byNet.set(net, styleOf(classOf(net), defaultClass, 'wire'))
    return byNet.get(net)!
  })
  return { wires, bus: styleOf(defaultClass, defaultClass, 'bus') }
}
