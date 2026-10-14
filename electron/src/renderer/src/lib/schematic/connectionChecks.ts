/**
 * The ERC rules judged on a wired piece of one sheet (`SchematicPiece`, KiCad's
 * subgraph) and then across the pieces of its net: floating wires, labels that
 * connect nothing or only one pin, no-connect flags on wired or empty nets,
 * two names on one piece, and a label joining several wires. KiCad's ERC is
 * the spec (design-health-workstream.md); the code is ours.
 *
 * A reused sheet's instances share their items, and KiCad reports each item
 * once, so every rule here reports an item once however many instances hold it.
 */
import type { CheckResult } from './checks'
import type {
  NetPin,
  SchematicConnectivity,
  SchematicNet,
  SchematicPiece,
  SheetConnectivityInput
} from './connectivity'
import {
  placedPinUuid,
  sheetPinUuid,
  type KicadLabel,
  type KicadSchematicPoint,
  type Point
} from '../kicad/schematic'
import { findChild, getFirstAtomValue } from '../kicad/sexpr'
import { asMm } from './schematicAgent'
import { noConnectId } from './schematicItems'

const mm = (point: Point): { x: number; y: number } => ({ x: asMm(point.x), y: asMm(point.y) })

const nodeUuid = (item: {
  _node?: KicadSchematicPoint['_node']
  uuid?: string
}): string | undefined => {
  if (item.uuid) return item.uuid
  const uuid = item._node ? findChild(item._node, 'uuid') : null
  return uuid ? getFirstAtomValue(uuid) : undefined
}

const pinName = (entry: NetPin): string => `${entry.reference}.${entry.pin.number}`

/** A label's name as a net name spells it. */
const labelName = (label: KicadLabel): string =>
  label.text.replace(/\//g, '{slash}').replace(/[\r\n]/g, '')

/**
 * A power port's net name: a power symbol's value, else its pin's name; a
 * legacy hidden power pin on an ordinary part names the net by the pin's name.
 */
const powerName = (entry: NetPin): string => entry.powerName || entry.pin.name

const isPowerPort = (entry: NetPin): boolean =>
  entry.pin.electricalType === 'power_in' && (entry.power || entry.pin.hidden)

/** KiCad's driver priorities, highest wins: what names a piece. */
const enum Priority {
  None = 0,
  Pin,
  SheetPin,
  HierLabel,
  LocalLabel,
  LocalPower,
  GlobalPower,
  GlobalLabel
}

interface Driver {
  priority: Priority
  name: string
  /** KiCad's id for it, for the report. */
  id?: string
  label?: KicadLabel
  pin?: NetPin
}

const labelPriority = (label: KicadLabel): Priority =>
  label.type === 'global_label'
    ? Priority.GlobalLabel
    : label.type === 'label'
      ? Priority.LocalLabel
      : Priority.HierLabel

/** Every item that could name the piece, strongest first. */
const driversOf = (piece: SchematicPiece): Driver[] => {
  const drivers: Driver[] = [
    ...piece.labels.map((label) => ({
      priority: labelPriority(label),
      name: labelName(label),
      id: label.uuid,
      label
    })),
    ...piece.pins.map((entry) => {
      const power = isPowerPort(entry)
      return {
        priority: power
          ? Priority.GlobalPower
          : entry.symbol.onBoard
            ? Priority.Pin
            : Priority.None,
        name: power ? powerName(entry) : pinName(entry),
        id: placedPinUuid(entry.symbol, entry.pin.number),
        pin: entry
      }
    }),
    ...piece.sheetPins.map((entry) => ({
      priority: Priority.SheetPin,
      name: entry.pin.name,
      id: sheetPinUuid(entry.pin)
    }))
  ]
  return drivers
    .filter((driver) => driver.priority > Priority.None)
    .sort((a, b) => b.priority - a.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The pieces of each net, and each piece's own key for once-per-file reporting. */
const indexPieces = (
  connectivity: SchematicConnectivity
): { byNet: Map<SchematicNet, SchematicPiece[]> } => {
  const byNet = new Map<SchematicNet, SchematicPiece[]>()
  for (const piece of connectivity.pieces) {
    if (!piece.net) continue
    const list = byNet.get(piece.net) ?? []
    list.push(piece)
    byNet.set(piece.net, list)
  }
  return { byNet }
}

/** Reports an item once, however many sheet instances hold it. */
const once = (): ((key: string | undefined) => boolean) => {
  const seen = new Set<string>()
  return (key) => {
    if (!key) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
}

/**
 * Wires on a piece nothing names — no pin, label or sheet pin: KiCad's "wires
 * not connected to anything".
 */
const floatingWires = (connectivity: SchematicConnectivity): CheckResult[] => {
  const first = once()
  const results: CheckResult[] = []
  for (const piece of connectivity.pieces) {
    if (!piece.wires.length && !piece.busEntries) continue
    if (driversOf(piece).length) continue
    const ids = piece.wires.flatMap((entry) => entry.wire.uuid ?? []).sort()
    if (!first(ids[0])) continue
    const at = piece.wires[0]?.wire.points[0]
    results.push({
      code: 'wire-dangling',
      severity: 'error',
      message: `${piece.wires.length === 1 ? 'A wire connects' : `${piece.wires.length} wires connect`} to no pin, label or sheet pin. Delete ${piece.wires.length === 1 ? 'it' : 'them'}, or wire ${piece.wires.length === 1 ? 'it' : 'them'} to what ${piece.wires.length === 1 ? 'it was' : 'they were'} meant for.`,
      items: [],
      ...(at ? { position: mm(at) } : {}),
      sheetPath: piece.sheetPath,
      targets: ids,
      kicadIds: ids
    })
  }
  return results
}

/** A piece that is itself a hierarchy link: a sheet pin, or a hierarchical label. */
const isHierarchical = (piece: SchematicPiece): boolean =>
  piece.sheetPins.length > 0 || piece.labels.some((label) => label.type === 'hierarchical_label')

/**
 * The pieces each piece's names join on its sheet — same-named labels and
 * power ports — as one unit, the way KiCad folds them together before it
 * weighs a label.
 */
const namedUnits = (pieces: SchematicPiece[]): ((piece: SchematicPiece) => SchematicPiece[]) => {
  const root = new Map<SchematicPiece, SchematicPiece>()
  const find = (piece: SchematicPiece): SchematicPiece => {
    let at = piece
    for (let next = root.get(at); next && next !== at; next = root.get(at)) at = next
    root.set(piece, at)
    return at
  }
  const firstByName = new Map<string, SchematicPiece>()
  for (const piece of pieces) {
    const names = [...piece.labels.map(labelName), ...piece.pins.filter(isPowerPort).map(powerName)]
    for (const name of names) {
      const key = `${piece.sheetPath}|${name}`
      const first = firstByName.get(key)
      if (first) root.set(find(piece), find(first))
      else firstByName.set(key, piece)
    }
  }
  const units = new Map<SchematicPiece, SchematicPiece[]>()
  for (const piece of pieces) {
    const key = find(piece)
    const unit = units.get(key)
    if (unit) unit.push(piece)
    else units.set(key, [piece])
  }
  return (piece) => units.get(find(piece)) ?? [piece]
}

/**
 * Labels that connect nothing: one touching no wire or pin, one whose whole
 * net reaches no pin, a local label on a sheet where its net reaches no pin
 * though it does elsewhere; and a label whose net reaches exactly one pin —
 * a name that joins nothing to anything.
 */
const labelChecks = (
  connectivity: SchematicConnectivity,
  byNet: Map<SchematicNet, SchematicPiece[]>
): CheckResult[] => {
  const first = once()
  const results: CheckResult[] = []
  // A net's totals, once per net: walking every piece's neighbors is quadratic
  // on a rail with thousands of pieces.
  const totals = new Map<
    SchematicNet,
    {
      pins: number
      noConnect: boolean
      sheets: Map<string, { pins: number; hierarchical: number }>
    }
  >()
  const totalsOf = (net: SchematicNet): NonNullable<ReturnType<typeof totals.get>> => {
    let entry = totals.get(net)
    if (entry) return entry
    entry = { pins: 0, noConnect: false, sheets: new Map() }
    for (const each of byNet.get(net) ?? []) {
      entry.pins += each.pins.length
      if (each.noConnects.length) entry.noConnect = true
      const sheet = entry.sheets.get(each.sheetPath) ?? { pins: 0, hierarchical: 0 }
      sheet.pins += each.pins.length
      if (isHierarchical(each)) sheet.hierarchical++
      entry.sheets.set(each.sheetPath, sheet)
    }
    totals.set(net, entry)
    return entry
  }
  const report = (
    code: 'label-dangling' | 'label-single-pin',
    label: KicadLabel,
    piece: SchematicPiece
  ): void => {
    if (!first(`${code}|${label.uuid ?? `${piece.sheetPath}|${label.text}`}`)) return
    const name = label.text
    results.push({
      code,
      severity: code === 'label-dangling' ? 'error' : 'warning',
      message:
        code === 'label-dangling'
          ? `The label ${name} connects nothing. Put it on the wire or pin it names, or delete it.`
          : `The label ${name} names a net that reaches only one pin, so it joins nothing to it. Wire the other end, or mark the pin no-connect if it is left open on purpose.`,
      items: [name],
      position: mm(label.position),
      sheetPath: piece.sheetPath,
      targets: label.uuid ? [label.uuid] : [],
      kicadIds: label.uuid ? [label.uuid] : [],
      subject: name
    })
  }
  // KiCad weighs a label by the pieces its name joins on its sheet, taken as
  // one: their pins, sheet pins and ports are its own, and only the net's other
  // pieces on the sheet are neighbors. Same-named labels and power ports on one
  // sheet join.
  const unitOf = namedUnits(connectivity.pieces)
  const weights = new Map<
    SchematicPiece[],
    { pins: number; noConnect: boolean; hierarchical: number; links: number }
  >()
  /** A unit's pins and hierarchy, once per unit: a rail's unit is thousands of pieces. */
  const unitWeight = (unit: SchematicPiece[]): NonNullable<ReturnType<typeof weights.get>> => {
    let weight = weights.get(unit)
    if (weight) return weight
    const ports = new Set<string>()
    weight = { pins: 0, noConnect: false, hierarchical: 0, links: 0 }
    for (const each of unit) {
      weight.pins += each.pins.length
      if (each.noConnects.length) weight.noConnect = true
      if (isHierarchical(each)) weight.hierarchical++
      weight.links += each.sheetPins.length
      for (const label of each.labels) {
        if (label.type === 'hierarchical_label') ports.add(label.text)
      }
    }
    weight.links += ports.size
    weights.set(unit, weight)
    return weight
  }
  for (const piece of connectivity.pieces) {
    if (!piece.labels.length) continue
    // A label alone is touching nothing: KiCad reports it and looks no further.
    // Another label or a no-connect flag on its point is something.
    if (
      piece.labels.length === 1 &&
      !piece.noConnects.length &&
      !piece.wires.length &&
      !piece.pins.length &&
      !piece.sheetPins.length &&
      !piece.busEntries
    ) {
      report('label-dangling', piece.labels[0], piece)
      continue
    }
    const unit = unitWeight(unitOf(piece))
    if (unit.pins > 1) continue
    const totals = piece.net ? totalsOf(piece.net) : null
    const here = totals?.sheets.get(piece.sheetPath)
    const noConnect = unit.noConnect || !!totals?.noConnect
    const allPins = totals ? totals.pins : unit.pins
    const localPins = here ? here.pins : unit.pins
    // A piece that is itself a hierarchy link, on a bus that leaves the sheet,
    // routes the member off it.
    const linked = unit.links > 0
    const localHierarchy =
      (here ? here.hierarchical - unit.hierarchical > 0 : false) ||
      unit.links > 1 ||
      (linked &&
        piece.labels.some((label) =>
          connectivity.busPorts.has(`${piece.sheetPath}|${labelName(label)}`)
        ))
    for (const label of piece.labels) {
      if (allPins === 1 && !noConnect) report('label-single-pin', label, piece)
      if (
        allPins === 0 ||
        (label.type === 'label' && localPins === 0 && allPins > 1 && !noConnect && !localHierarchy)
      ) {
        report('label-dangling', label, piece)
      }
    }
  }
  return results
}

/**
 * No-connect flags that are wrong: one on a net that has more than one pin
 * (so something is wired to what was meant to stay open), and one on a net
 * with no pin and no label (so it marks nothing).
 */
const noConnectChecks = (
  connectivity: SchematicConnectivity,
  byNet: Map<SchematicNet, SchematicPiece[]>
): CheckResult[] => {
  const first = once()
  const results: CheckResult[] = []
  const at = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y
  /** A net's distinct pins (stacked pins once) and its label count, once per net. */
  const tally = (pieces: SchematicPiece[]): { stacks: Set<string>; labels: number } => {
    const stacks = new Set<string>()
    let labels = 0
    for (const each of pieces) {
      labels += each.labels.length
      for (const entry of each.pins) {
        stacks.add(
          `${entry.sheetPath}|${entry.symbol.uuid ?? entry.reference}|${entry.position.x},${entry.position.y}`
        )
      }
    }
    return { stacks, labels }
  }
  const netTotals = new Map<SchematicNet, { stacks: Set<string>; labels: number }>()
  for (const piece of connectivity.pieces) {
    const flag = piece.noConnects[0] as KicadSchematicPoint | undefined
    if (!flag) continue
    const ports = piece.labels.filter((label) => label.type === 'hierarchical_label')
    if (
      (piece.sheetPins.length || ports.length) &&
      !piece.pins.length &&
      !piece.labels.some((label) => label.type !== 'hierarchical_label')
    ) {
      continue
    }
    if (piece.sheetPins.some((entry) => at(entry.pin.position, flag))) continue
    if (ports.some((label) => at(label.position, flag))) continue
    if (
      piece.pins.some(
        (entry) => entry.pin.electricalType === 'no_connect' && at(entry.position, flag)
      )
    ) {
      continue
    }
    const netPieces = (piece.net && byNet.get(piece.net)) ?? [piece]
    const { stacks, labels } = (piece.net && netTotals.get(piece.net)) ?? tally(netPieces)
    if (piece.net && !netTotals.has(piece.net)) netTotals.set(piece.net, { stacks, labels })
    const id = nodeUuid(flag)
    if (stacks.size > 1) {
      if (!first(`connected|${id ?? `${piece.sheetPath}|${flag.x},${flag.y}`}`)) continue
      // A handful to name in the message; a rail can carry thousands.
      const named = new Set<string>()
      for (const each of netPieces) {
        for (const entry of each.pins) if (named.size < 8) named.add(pinName(entry))
        if (named.size >= 8) break
      }
      const pins = [...named].sort()
      results.push({
        code: 'no-connect-connected',
        severity: 'warning',
        message: `A no-connect flag sits on a net that joins ${pins.join(', ')}. Either the pin is meant to stay open and the wire to it is a mistake, or it is wired on purpose and the flag should go.`,
        items: pins,
        position: mm(flag),
        sheetPath: piece.sheetPath,
        targets: id ? [id] : [],
        kicadIds: id ? [id] : [],
        subject: piece.net?.name
      })
    } else if (!stacks.size && !labels) {
      if (!first(`dangling|${id ?? `${piece.sheetPath}|${flag.x},${flag.y}`}`)) continue
      results.push({
        code: 'no-connect-dangling',
        severity: 'warning',
        message:
          'A no-connect flag marks nothing: no pin or label is on its net. Move it onto the pin meant to stay open, or delete it.',
        items: [noConnectId(flag)],
        position: mm(flag),
        sheetPath: piece.sheetPath,
        targets: id ? [id] : [],
        kicadIds: id ? [id] : [],
        // A person reads a flag by where it is, not by its id.
        subject: `(${mm(flag).x}, ${mm(flag).y})`
      })
    }
  }
  return results
}

/**
 * Two names on one net on one sheet — two labels, or a label and a power port —
 * where only the stronger reaches the netlist. KiCad folds a sheet's pieces
 * that share a name into one before it asks, so this is judged per net and
 * sheet, not per piece.
 */
const multipleNames = (connectivity: SchematicConnectivity): CheckResult[] => {
  const first = once()
  const results: CheckResult[] = []
  // A sheet's pieces that share a strong name are one, as KiCad folds them.
  const strongOf = new Map<SchematicPiece, Driver[]>()
  const parent = new Map<SchematicPiece, SchematicPiece>()
  const find = (piece: SchematicPiece): SchematicPiece => {
    let root = piece
    while (parent.get(root) !== root) root = parent.get(root)!
    parent.set(piece, root)
    return root
  }
  const byName = new Map<string, SchematicPiece>()
  for (const piece of connectivity.pieces) {
    const strong = driversOf(piece).filter((driver) => driver.priority >= Priority.HierLabel)
    if (!strong.length) continue
    strongOf.set(piece, strong)
    parent.set(piece, piece)
    for (const driver of strong) {
      const key = `${piece.sheetPath}|${driver.name}`
      const other = byName.get(key)
      if (other) parent.set(find(piece), find(other))
      else byName.set(key, piece)
    }
  }
  const groups = new Map<SchematicPiece, SchematicPiece[]>()
  for (const piece of strongOf.keys()) {
    const root = find(piece)
    const list = groups.get(root) ?? []
    list.push(piece)
    groups.set(root, list)
  }
  for (const pieces of groups.values()) {
    const strong = pieces
      .flatMap((piece) => strongOf.get(piece)!)
      .sort((a, b) => b.priority - a.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    if (strong.length < 2) continue
    const [chosen] = strong
    const other = strong.slice(1).find((driver) => driver.name !== chosen.name)
    if (!other) continue
    const { sheetPath } = pieces[0]
    if (!first(`${other.id ?? `${sheetPath}|${other.name}`}`)) continue
    const where = other.label?.position ?? other.pin?.position
    results.push({
      code: 'multiple-net-names',
      severity: 'warning',
      message: `Both ${chosen.name} and ${other.name} name the same wire; ${chosen.name} is the one the netlist uses. Delete or rename one of them.`,
      items: [chosen.name, other.name],
      ...(where ? { position: mm(where) } : {}),
      sheetPath,
      targets: [chosen.id, other.id].filter((id): id is string => !!id),
      kicadIds: [chosen.id, other.id].filter((id): id is string => !!id),
      subject: chosen.name
    })
  }
  return results
}

/**
 * A local label sitting where two or more wires pass through it (not ending
 * there): it joins them, which is rarely what was drawn.
 */
const labelOnWires = (sheets: SheetConnectivityInput[]): CheckResult[] => {
  const results: CheckResult[] = []
  const seen = new Set<object>()
  for (const { sheetPath, schematic } of sheets) {
    if (seen.has(schematic)) continue
    seen.add(schematic)
    for (const label of schematic.labels) {
      if (label.type !== 'label') continue
      const point = label.position
      const through = [...schematic.wires, ...schematic.buses].filter((line) =>
        line.points.some((a, index) => {
          const b = line.points[index + 1]
          if (!b) return false
          if ((a.x === point.x && a.y === point.y) || (b.x === point.x && b.y === point.y))
            return false
          const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
          return (
            cross === 0 &&
            Math.min(a.x, b.x) <= point.x &&
            point.x <= Math.max(a.x, b.x) &&
            Math.min(a.y, b.y) <= point.y &&
            point.y <= Math.max(a.y, b.y)
          )
        })
      )
      if (through.length < 2) continue
      const ids = [label.uuid, ...through.map((line) => line.uuid)].filter(
        (id): id is string => !!id
      )
      results.push({
        code: 'label-multiple-wires',
        severity: 'warning',
        message: `The label ${label.text} sits where ${through.length} wires pass through it, and so joins them. Move it onto the end of one wire.`,
        items: [label.text],
        position: mm(point),
        sheetPath,
        targets: ids,
        kicadIds: ids,
        subject: label.text
      })
    }
  }
  return results
}

/**
 * A wire joined to a bus through a bus entry that the bus does not carry:
 * none of the names on the wire is one of the bus's members. A net named by a
 * global label or a power port is exempt, as KiCad has it.
 */
const netNotBusMember = (connectivity: SchematicConnectivity): CheckResult[] => {
  const first = once()
  const results: CheckResult[] = []
  for (const piece of connectivity.pieces) {
    const [link] = piece.busLinks
    if (!link) continue
    const drivers = driversOf(piece)
    if (!drivers.length || drivers[0].priority >= Priority.GlobalPower) continue
    const members = new Set(link.members)
    if (drivers.some((driver) => members.has(driver.name))) continue
    const id = nodeUuid(link.entry)
    if (!first(id ?? `${piece.sheetPath}|${link.entry.position.x},${link.entry.position.y}`))
      continue
    const name = drivers[0].name
    results.push({
      code: 'net-not-bus-member',
      severity: 'warning',
      message: `${name} joins a bus through a bus entry, but the bus carries no member of that name. Rename the net to one of the bus's members, or take it off the bus.`,
      items: [name],
      position: mm(link.entry.position),
      sheetPath: piece.sheetPath,
      targets: id ? [id] : [],
      kicadIds: id ? [id] : [],
      subject: name
    })
  }
  return results
}

/** Whether a point lies on a line: at either end or along it. */
const onLine = (point: Point, points: readonly Point[]): boolean =>
  points.some((a, index) => {
    const b = points[index + 1]
    if (!b) return false
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
    return (
      Math.abs(cross) <= Math.hypot(b.x - a.x, b.y - a.y) * 10_000 &&
      Math.min(a.x, b.x) <= point.x &&
      point.x <= Math.max(a.x, b.x) &&
      Math.min(a.y, b.y) <= point.y &&
      point.y <= Math.max(a.y, b.y)
    )
  })

/**
 * A bus's global label and its sheet port (a sheet pin or hierarchical label)
 * that carry no member in common: the bus means two different things.
 */
const busToBus = (connectivity: SchematicConnectivity): CheckResult[] => {
  const first = once()
  const results: CheckResult[] = []
  for (const bus of connectivity.buses) {
    const label = bus.names.find((name) => name.source === 'global_label')
    const port = bus.names.find(
      (name) => name.source === 'sheet_pin' || name.source === 'hierarchical_label'
    )
    if (!label || !port) continue
    const members = new Set(label.members)
    if (port.members.some((member) => members.has(member))) continue
    if (!first(label.id ?? `${bus.sheetPath}|${label.text}`)) continue
    const targets = [label.id, port.id].filter((id): id is string => !!id)
    results.push({
      code: 'bus-to-bus-conflict',
      severity: 'error',
      message: `The bus ${label.text} meets the port ${port.text}, and they share no member. Rename one so the members line up.`,
      items: [label.text, port.text],
      position: mm(label.position),
      sheetPath: bus.sheetPath,
      targets,
      kicadIds: targets,
      subject: label.text
    })
  }
  return results
}

/** A net's name on a bus, or a bus's name on a wire: one wire both a net and a bus. */
const busToNet = (
  connectivity: SchematicConnectivity,
  sheets: SheetConnectivityInput[]
): CheckResult[] => {
  const first = once()
  const results: CheckResult[] = []
  const busesOn = new Map<string, typeof connectivity.buses>()
  for (const bus of connectivity.buses) {
    const list = busesOn.get(bus.sheetPath) ?? []
    list.push(bus)
    busesOn.set(bus.sheetPath, list)
  }
  const report = (
    sheetPath: string,
    net: { text: string; id?: string; position: Point },
    bus: { text: string; id?: string }
  ): void => {
    if (!first(net.id ?? `${sheetPath}|${net.position.x},${net.position.y}`)) return
    const targets = [net.id, bus.id].filter((id): id is string => !!id)
    results.push({
      code: 'bus-to-net-conflict',
      severity: 'error',
      message: `${net.text} is a net name and ${bus.text} a bus on the same wire. A wire carries a net or a bus, not both; join them through a bus entry.`,
      items: [net.text, bus.text],
      position: mm(net.position),
      sheetPath,
      targets,
      kicadIds: targets,
      subject: net.text
    })
  }
  for (const piece of connectivity.pieces) {
    const buses = busesOn.get(piece.sheetPath) ?? []
    if (!buses.length) continue
    const names = [
      ...piece.labels.map((label) => ({
        text: label.text,
        id: label.uuid,
        position: label.position
      })),
      ...piece.sheetPins.map((entry) => ({
        text: entry.pin.name,
        id: sheetPinUuid(entry.pin),
        position: entry.pin.position
      }))
    ]
    for (const name of names) {
      const bus = buses.find((each) =>
        each.wires.some((wire) => onLine(name.position, wire.points))
      )
      if (bus)
        report(piece.sheetPath, name, {
          text: bus.names[0]?.text ?? 'a bus',
          id: bus.wires[0]?.uuid
        })
    }
  }
  for (const { sheetPath, schematic } of sheets) {
    for (const bus of busesOn.get(sheetPath) ?? []) {
      for (const name of bus.names) {
        const wire = schematic.wires.find((each) => onLine(name.position, each.points))
        if (wire)
          report(sheetPath, { text: 'a wire', id: wire.uuid, position: name.position }, name)
      }
    }
  }
  return results
}

/**
 * Hierarchy ends that connect nothing: a sheet pin with nothing on it on the
 * parent sheet, and a hierarchical label on the root sheet, which has no
 * parent to reach.
 */
const openHierarchy = (
  connectivity: SchematicConnectivity,
  sheets: SheetConnectivityInput[]
): CheckResult[] => {
  const first = once()
  const results: CheckResult[] = []
  /** `select` is what the editor selects: a sheet pin's sheet box, or the label. */
  const report = (
    sheetPath: string,
    name: string,
    id: string | undefined,
    select: string | undefined,
    position: Point,
    message: string
  ): void => {
    if (!first(id ?? `${sheetPath}|${name}|${position.x},${position.y}`)) return
    results.push({
      code: 'unconnected-sheet-port',
      severity: 'error',
      message,
      items: [name],
      position: mm(position),
      sheetPath,
      targets: select ? [select] : [],
      kicadIds: id ? [id] : [],
      subject: name
    })
  }
  // A no-connect flag on it says it is open on purpose.
  const lone = (piece: SchematicPiece): boolean =>
    !piece.wires.length &&
    !piece.pins.length &&
    !piece.labels.length &&
    !piece.busEntries &&
    !piece.noConnects.length
  for (const piece of connectivity.pieces) {
    if (!lone(piece) || piece.sheetPins.length !== 1) continue
    const [{ pin, sheet }] = piece.sheetPins
    report(
      piece.sheetPath,
      pin.name,
      sheetPinUuid(pin),
      sheet.uuid,
      pin.position,
      `The sheet pin ${pin.name} has nothing wired to it on this sheet. Wire it, or delete it if the block does not need it.`
    )
  }
  for (const bus of connectivity.buses) {
    if (bus.wires.length || bus.names.length !== 1 || bus.names[0].source !== 'sheet_pin') continue
    const [name] = bus.names
    report(
      bus.sheetPath,
      name.text,
      name.id,
      name.select,
      name.position,
      `The sheet pin ${name.text} has nothing wired to it on this sheet. Wire it, or delete it if the block does not need it.`
    )
  }
  const roots = new Set(
    sheets.filter(({ sheetPath }) => sheetPath.split('/').filter(Boolean).length <= 1)
  )
  for (const { sheetPath, schematic } of roots) {
    for (const label of schematic.labels) {
      if (label.type !== 'hierarchical_label') continue
      report(
        sheetPath,
        label.text,
        label.uuid,
        label.uuid,
        label.position,
        `The hierarchical label ${label.text} is on the root sheet, which has no parent sheet for it to connect to. Make it a local or global label.`
      )
    }
  }
  return results
}

/** Every rule of this module, in no particular order. */
export const connectionChecks = (
  connectivity: SchematicConnectivity,
  sheets: SheetConnectivityInput[]
): CheckResult[] => {
  const { byNet } = indexPieces(connectivity)
  return [
    ...floatingWires(connectivity),
    ...labelChecks(connectivity, byNet),
    ...noConnectChecks(connectivity, byNet),
    ...multipleNames(connectivity),
    ...labelOnWires(sheets),
    ...netNotBusMember(connectivity),
    ...busToBus(connectivity),
    ...busToNet(connectivity, sheets),
    ...openHierarchy(connectivity, sheets)
  ]
}

/** One sentence per rule, for `schematic.check`. */
export const CONNECTION_RULES: Record<string, string> = {
  'wire-dangling':
    'Wires that reach no pin, label or sheet pin: leftovers from an edit, or a connection that was never finished.',
  'label-dangling':
    'A label that connects nothing: it touches no wire or pin, or nothing on its net reaches a pin on this sheet.',
  'label-single-pin':
    'A label whose net reaches exactly one pin, so the name joins that pin to nothing.',
  'no-connect-connected':
    'A no-connect flag on a net that joins more than one pin: the pin is either meant to be open or meant to be wired, not both.',
  'no-connect-dangling': 'A no-connect flag with no pin or label on its net: it marks nothing.',
  'multiple-net-names':
    'Two labels (or a label and a power port) name one piece of wire; only the stronger name reaches the netlist.',
  'label-multiple-wires':
    'A label on the interior of more than one wire joins them all, which is rarely what was drawn.',
  'net-not-bus-member':
    'A wire joined to a bus through a bus entry, carrying a name the bus does not have as a member.',
  'bus-to-bus-conflict':
    "A bus's global label and its sheet port share no member, so the bus means two things.",
  'bus-to-net-conflict': 'A net name on a bus, or a bus name on a wire: a wire is a net or a bus.',
  'unconnected-sheet-port':
    'A sheet pin with nothing on it, or a hierarchical label on the root sheet: a hierarchy end that connects nothing.'
}

/** Each rule's KiCad violation key. */
export const CONNECTION_KICAD_KEYS: Record<string, string> = {
  'wire-dangling': 'wire_dangling',
  'label-dangling': 'label_dangling',
  'label-single-pin': 'isolated_pin_label',
  'no-connect-connected': 'no_connect_connected',
  'no-connect-dangling': 'no_connect_dangling',
  'multiple-net-names': 'multiple_net_names',
  'label-multiple-wires': 'label_multiple_wires',
  'net-not-bus-member': 'net_not_bus_member',
  'bus-to-bus-conflict': 'bus_to_bus_conflict',
  'bus-to-net-conflict': 'bus_to_net_conflict',
  'unconnected-sheet-port': 'pin_not_connected'
}
