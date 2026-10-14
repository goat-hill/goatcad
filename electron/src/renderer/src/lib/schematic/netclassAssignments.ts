/**
 * The nets the schematic puts in a class itself, as KiCad's connection graph
 * finds them (`CONNECTION_GRAPH::buildConnectionGraph`, `GetNetclassesForDriver`)
 * and saves them to the project's `net_settings.netclass_assignments`: a
 * `Netclass` field on a directive label, or on a net label, names a class for
 * the net it sits on; on a bus, for every member. Rebuilt whole each time, so a
 * flag taken away or a net renamed leaves nothing behind.
 */
import type { Point, SchematicProperty } from '../kicad/schematic'
import { findChildren, getAtomValues } from '../kicad/sexpr'
import type { NetClassAssignment } from '../kicad/project'
import {
  shownTextOn,
  type SchematicConnectivity,
  type SheetConnectivityInput
} from './connectivity'

/** KiCad takes the field as `Netclass` or `Net Class`. */
const isNetclassKey = (key: string): boolean => key.replace(/\s+/g, '').toLowerCase() === 'netclass'

/** A point on a segment, to the nanometer. */
const onSegment = (p: Point, a: Point, b: Point): boolean => {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
  if (Math.abs(cross) > Math.hypot(b.x - a.x, b.y - a.y)) return false
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  )
}

export function netclassAssignments(
  sheets: SheetConnectivityInput[],
  connectivity: SchematicConnectivity,
  textVariables: Readonly<Record<string, string>> = {}
): NetClassAssignment[] {
  const shown = shownTextOn(sheets, textVariables)
  const byNet = new Map<string, Set<string>>()
  const assign = (net: string, netClass: string): void => {
    if (!net || !netClass) return
    let set = byNet.get(net)
    if (!set) byNet.set(net, (set = new Set()))
    set.add(netClass)
  }
  // A bus member's net, by the label that names it on that sheet.
  const labelled = new Map<string, string>()
  for (const net of connectivity.nets)
    for (const { sheetPath, label } of net.labels)
      labelled.set(`${sheetPath}|${label.text}`, net.name)

  sheets.forEach(({ sheetPath, schematic }, sheetIndex) => {
    const classesOf = (properties: SchematicProperty[]): string[] =>
      properties
        .filter((p) => isNetclassKey(p.key) && p.value)
        .map((p) => shown(sheetIndex, p.value))
    for (const flag of schematic.directiveLabels) {
      const classes = classesOf(flag.properties)
      if (classes.length === 0) continue
      const net = connectivity.netAt(sheetPath, flag.position)
      if (net) {
        for (const c of classes) assign(net.name, c)
        continue
      }
      // On a bus: every member it carries.
      for (const bus of connectivity.buses) {
        if (bus.sheetPath !== sheetPath) continue
        const touches = bus.wires.some((w) =>
          w.points.some((a, i) => i > 0 && onSegment(flag.position, w.points[i - 1], a))
        )
        if (!touches) continue
        for (const name of bus.names)
          for (const member of name.members) {
            const memberNet = labelled.get(`${sheetPath}|${member}`)
            if (memberNet) for (const c of classes) assign(memberNet, c)
          }
      }
    }
  })

  // A `Netclass` field on a net label (KiCad's child fields of the driver).
  const sheetIndex = new Map(sheets.map((s, i) => [s.sheetPath, i]))
  for (const net of connectivity.nets)
    for (const { sheetPath, label } of net.labels) {
      const index = sheetIndex.get(sheetPath)
      if (index === undefined) continue
      for (const property of findChildren(label._node, 'property')) {
        const [key, value] = getAtomValues(property)
        if (key !== undefined && value && isNetclassKey(key)) assign(net.name, shown(index, value))
      }
    }

  return [...byNet.keys()]
    .sort()
    .flatMap((net) => [...byNet.get(net)!].sort().map((netClass) => ({ net, netClass })))
}
