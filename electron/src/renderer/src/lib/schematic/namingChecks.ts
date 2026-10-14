/**
 * The ERC rules about names and text: names that differ only in case, one
 * name used as a local and a global label, a ground pin off every ground net,
 * malformed stacked pin numbers, field names with stray spaces, a netclass the
 * project does not define, and the two KiCad leaves off by default — a global
 * label used once, and four items meeting at one point. KiCad's ERC is the
 * spec; the code is ours.
 */
import type { CheckResult } from './checks'
import type { NetPin, SchematicConnectivity, SheetConnectivityInput } from './connectivity'
import { placedPinPosition, shownTextOn } from './connectivity'
import {
  getSymbolProperty,
  placedPinUuid,
  resolveSymbolGeometry,
  type KicadLabel,
  type Point,
  type SchematicProperty
} from '../kicad/schematic'
import { expandStackedPinNumber } from '../symbol/symbolChecks'
import { asMm } from './schematicAgent'
import type { ErcContext } from './ercContext'

const mm = (point: Point): { x: number; y: number } => ({ x: asMm(point.x), y: asMm(point.y) })
const ids = (...values: Array<string | undefined>): string[] =>
  values.filter((value): value is string => !!value)

/** A name on the schematic: a label, or a power port's pin. */
interface Name {
  text: string
  kind: 'local' | 'hierarchical' | 'global' | 'power'
  /** Its power port's scope, for a power pin. */
  globalPower?: boolean
  sheetPath: string
  position: Point
  id?: string
  /** What the editor selects for it. */
  target?: string
}

const namesOf = (connectivity: SchematicConnectivity): Name[] => {
  const names: Name[] = []
  for (const piece of connectivity.pieces) {
    for (const label of piece.labels) {
      names.push({
        text: label.text,
        kind:
          label.type === 'global_label'
            ? 'global'
            : label.type === 'label'
              ? 'local'
              : 'hierarchical',
        sheetPath: piece.sheetPath,
        position: label.position,
        id: label.uuid,
        target: label.uuid
      })
    }
    for (const entry of piece.pins) {
      if (!entry.power || entry.pin.electricalType !== 'power_in') continue
      names.push({
        text: entry.powerName ?? entry.pin.name,
        kind: 'power',
        globalPower: !entry.localPower,
        sheetPath: entry.sheetPath,
        position: entry.position,
        id: placedPinUuid(entry.symbol, entry.pin.number),
        target: entry.symbol.uuid
      })
    }
  }
  return names
}

/**
 * Names that differ only in case (`SDA` and `sda`): two labels, two power
 * ports, or a label and a power port. Two local labels on different sheets
 * are different nets anyway and do not count.
 */
const similarNames = (names: Name[]): CheckResult[] => {
  const results: CheckResult[] = []
  const seen = new Set<string>()
  const byFolded = new Map<string, Name[]>()
  for (const name of names) {
    const key = name.text.toLowerCase()
    const list = byFolded.get(key) ?? []
    list.push(name)
    byFolded.set(key, list)
  }
  for (const list of byFolded.values()) {
    // Compare spellings, not every pair of names: a rail named a thousand times
    // one way is still one spelling.
    const spellings = new Map<string, Name[]>()
    for (const name of list) {
      const same = spellings.get(name.text) ?? []
      same.push(name)
      spellings.set(name.text, same)
    }
    const texts = [...spellings.keys()]
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        for (const a of spellings.get(texts[i])!) {
          for (const b of spellings.get(texts[j])!) {
            if (a.kind === 'local' && b.kind === 'local' && a.sheetPath !== b.sheetPath) continue
            const pair = ids(a.id, b.id)
            const key = [...pair].sort().join('|') || `${a.text}|${b.text}|${a.sheetPath}`
            if (seen.has(key)) continue
            seen.add(key)
            const powers = (a.kind === 'power' ? 1 : 0) + (b.kind === 'power' ? 1 : 0)
            const code =
              powers === 2
                ? 'similar-power'
                : powers === 1
                  ? 'similar-label-and-power'
                  : 'similar-labels'
            results.push({
              code,
              severity: 'warning',
              message: `${a.text} and ${b.text} differ only in case, so they name two nets. Use one spelling if they are meant to be one net, or clearly different names if not.`,
              items: [a.text, b.text],
              position: mm(a.position),
              sheetPath: a.sheetPath,
              targets: ids(a.target),
              kicadIds: pair,
              subject: a.text
            })
          }
        }
      }
    }
  }
  return results
}

/**
 * One name used locally and globally (`TestSameLocalGlobalLabel`): a global
 * label or global power port against a local label or local power port, each
 * name's lowest-uuid item standing for it. Two power ports are their own rule.
 */
const sameLocalGlobal = (names: Name[]): CheckResult[] => {
  const global = new Map<string, Name>()
  const local = new Map<string, Name>()
  const keep = (map: Map<string, Name>, name: Name): void => {
    const held = map.get(name.text)
    if (!held || (name.id ?? '') < (held.id ?? '')) map.set(name.text, name)
  }
  for (const name of names) {
    if (name.kind === 'global' || (name.kind === 'power' && name.globalPower)) keep(global, name)
    else if (name.kind === 'local' || name.kind === 'power') keep(local, name)
  }
  const results: CheckResult[] = []
  for (const [text, g] of global) {
    const l = local.get(text)
    if (!l) continue
    const power = g.kind === 'power' && l.kind === 'power'
    results.push({
      code: power ? 'same-local-global-power' : 'same-local-global-label',
      severity: 'warning',
      message: power
        ? `${text} is both a local and a global power port. The local one powers only its own sheet, which is rarely what the shared name means; use one kind.`
        : `${text} is used both locally and globally, by a label or a power port. The local one joins only its own sheet, which is rarely what the shared name means; use one kind.`,
      items: [text],
      position: mm(g.position),
      sheetPath: g.sheetPath,
      targets: ids(g.target),
      kicadIds: ids(g.id, l.id),
      subject: text
    })
  }
  return results
}

const isGround = (text: string): boolean => {
  const upper = text.toUpperCase()
  return (
    upper.includes('GND') ||
    upper === 'EARTH' ||
    upper.startsWith('EARTH_') ||
    upper === 'VSS' ||
    upper === 'VSSA'
  )
}

/**
 * A part with a power pin on a ground net, and another power pin named as a
 * ground (`GND`, `VSS`, `EARTH`) that is not on one: usually a ground wired to
 * the wrong rail.
 */
const groundPins = (connectivity: SchematicConnectivity): CheckResult[] => {
  const bySymbol = new Map<string, Array<{ entry: NetPin; net: string }>>()
  for (const net of connectivity.nets) {
    for (const entry of net.pins) {
      if (entry.pin.electricalType !== 'power_in' && entry.pin.electricalType !== 'power_out')
        continue
      const key = `${entry.sheetPath}|${entry.symbol.uuid ?? entry.reference}`
      const list = bySymbol.get(key) ?? []
      list.push({ entry, net: net.name })
      bySymbol.set(key, list)
    }
  }
  const results: CheckResult[] = []
  const seen = new Set<string>()
  for (const pins of bySymbol.values()) {
    if (!pins.some(({ net }) => isGround(net))) continue
    for (const { entry, net } of pins) {
      if (!isGround(entry.pin.name) || isGround(net)) continue
      const id = placedPinUuid(entry.symbol, entry.pin.number)
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      const pin = `${entry.reference}.${entry.pin.number}`
      results.push({
        code: 'ground-pin-not-ground',
        severity: 'warning',
        message: `${pin} (${entry.pin.name}) is named as a ground but is on ${net}, while its part's other ground is on a ground net. Wire it to ground.`,
        items: [pin],
        position: mm(entry.position),
        sheetPath: entry.sheetPath,
        targets: ids(entry.symbol.uuid),
        kicadIds: ids(id),
        subject: pin
      })
    }
  }
  return results
}

/** Checks over each file once: a reused sheet's items are reported once. */
const perFile = (sheets: SheetConnectivityInput[]): SheetConnectivityInput[] => {
  const seen = new Set<object>()
  return sheets.filter(({ schematic }) => {
    if (seen.has(schematic)) return false
    seen.add(schematic)
    return true
  })
}

/** A pin number written in stacked notation (`[1,2,5-7]`) that does not parse. */
const stackedPins = (sheets: SheetConnectivityInput[]): CheckResult[] => {
  const results: CheckResult[] = []
  for (const { sheetPath, schematic } of perFile(sheets)) {
    for (const symbol of schematic.symbols) {
      for (const { pin } of resolveSymbolGeometry(schematic, symbol).pins) {
        const { number } = pin
        if (!number.includes('[') && !number.includes(']')) continue
        if (expandStackedPinNumber(number)) continue
        const id = placedPinUuid(symbol, number)
        results.push({
          code: 'stacked-pin-name',
          severity: 'warning',
          message: `Pin number ${number} looks stacked but does not parse: write it as [1,2,5-7].`,
          items: [number],
          position: mm(placedPinPosition(symbol, pin)),
          sheetPath,
          targets: ids(symbol.uuid),
          kicadIds: ids(id),
          subject: number
        })
      }
    }
  }
  return results
}

/** A field name with a leading or trailing space, which no lookup by name finds. */
const fieldWhitespace = (sheets: SheetConnectivityInput[]): CheckResult[] => {
  const results: CheckResult[] = []
  const check = (
    owner: string | undefined,
    properties: SchematicProperty[],
    sheetPath: string
  ): void => {
    for (const property of properties) {
      if (property.key === property.key.trim()) continue
      results.push({
        code: 'field-name-whitespace',
        severity: 'warning',
        message: `The field name "${property.key}" has a leading or trailing space. Trim it.`,
        items: [property.key],
        position: mm(property.position),
        sheetPath,
        targets: ids(owner),
        kicadIds: ids(owner),
        subject: property.key
      })
    }
  }
  for (const { sheetPath, schematic } of perFile(sheets)) {
    for (const symbol of schematic.symbols) check(symbol.uuid, symbol.properties, sheetPath)
    for (const sheet of schematic.sheets) check(sheet.uuid, sheet.properties, sheetPath)
  }
  return results
}

/**
 * A `Netclass` field naming a class the project does not define, read as each
 * sheet instance shows it (`Ch@{${#}-2}` names a class per instance).
 */
const undefinedNetclass = (
  sheets: SheetConnectivityInput[],
  netclasses: readonly string[],
  textVariables?: Readonly<Record<string, string>>
): CheckResult[] => {
  const known = new Set(['Default', ...netclasses])
  const shown = shownTextOn(sheets, textVariables)
  const seen = new Set<string>()
  const results: CheckResult[] = []
  sheets.forEach(({ sheetPath, schematic }, sheetIndex) => {
    const check = (
      owner: string | undefined,
      properties: SchematicProperty[],
      position: Point
    ): void => {
      for (const property of properties) {
        // KiCad takes the field as `Netclass` or `Net Class`.
        if (property.key.replace(/\s+/g, '').toLowerCase() !== 'netclass' || !property.value)
          continue
        const netclass = shown(sheetIndex, property.value)
        if (known.has(netclass)) continue
        const key = `${owner ?? `${sheetPath}|${position.x},${position.y}`}|${netclass}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({
          code: 'undefined-netclass',
          severity: 'error',
          message: `Netclass ${netclass} is not defined in the project. Define it in Schematic setup's net classes, or name one that is.`,
          items: [netclass],
          position: mm(position),
          sheetPath,
          targets: ids(owner),
          kicadIds: ids(owner),
          subject: netclass
        })
      }
    }
    for (const symbol of schematic.symbols) check(symbol.uuid, symbol.properties, symbol.position)
    for (const sheet of schematic.sheets) check(sheet.uuid, sheet.properties, sheet.position)
    for (const label of schematic.directiveLabels)
      check(label.uuid, label.properties, label.position)
  })
  return results
}

/** Off by default in KiCad: a global label whose name appears nowhere else. */
const singleGlobalLabels = (sheets: SheetConnectivityInput[]): CheckResult[] => {
  const byName = new Map<string, Array<{ label: KicadLabel; sheetPath: string }>>()
  for (const { sheetPath, schematic } of sheets) {
    for (const label of schematic.labels) {
      if (label.type !== 'global_label') continue
      const list = byName.get(label.text) ?? []
      list.push({ label, sheetPath })
      byName.set(label.text, list)
    }
  }
  const results: CheckResult[] = []
  for (const [text, list] of byName) {
    if (list.length !== 1) continue
    const [{ label, sheetPath }] = list
    results.push({
      code: 'single-global-label',
      severity: 'warning',
      message: `The global label ${text} appears only once, so it connects to nothing else.`,
      items: [text],
      position: mm(label.position),
      sheetPath,
      targets: ids(label.uuid),
      kicadIds: ids(label.uuid),
      subject: text
    })
  }
  return results
}

/** Off by default in KiCad: four or more pins and wire ends meeting at one point. */
const fourWayJunctions = (sheets: SheetConnectivityInput[]): CheckResult[] => {
  const results: CheckResult[] = []
  for (const { sheetPath, schematic } of perFile(sheets)) {
    const at = new Map<
      string,
      { point: Point; items: string[]; targets: string[]; symbols: Set<string> }
    >()
    const add = (point: Point, id: string, target: string, symbol?: string): void => {
      const key = `${point.x},${point.y}`
      const entry = at.get(key) ?? { point, items: [], targets: [], symbols: new Set() }
      if (symbol) {
        // A symbol's stacked pins at one point are one item.
        if (entry.symbols.has(symbol)) return
        entry.symbols.add(symbol)
      }
      entry.items.push(id)
      if (target && !entry.targets.includes(target)) entry.targets.push(target)
      at.set(key, entry)
    }
    for (const symbol of schematic.symbols) {
      for (const { pin } of resolveSymbolGeometry(schematic, symbol).pins) {
        add(
          placedPinPosition(symbol, pin),
          placedPinUuid(symbol, pin.number) ?? '',
          symbol.uuid ?? '',
          symbol.uuid ?? ''
        )
      }
    }
    for (const wire of schematic.wires) {
      add(wire.points[0], wire.uuid ?? '', wire.uuid ?? '')
      add(wire.points[wire.points.length - 1], wire.uuid ?? '', wire.uuid ?? '')
    }
    for (const { point, items, targets } of at.values()) {
      if (items.length < 4) continue
      results.push({
        code: 'four-way-junction',
        severity: 'warning',
        message: `${items.length} items meet at (${asMm(point.x)}, ${asMm(point.y)}). A four-way junction is easy to misread; offset one branch.`,
        items: [],
        position: mm(point),
        sheetPath,
        targets,
        kicadIds: ids(...items.slice(0, 4))
      })
    }
  }
  return results
}

/** Names KiCad resolves in any text: the title block, the sheet, the file, the date. */
const BUILT_IN_VARIABLES = new Set([
  '#',
  '##',
  'COMPANY',
  'CURRENT_DATE',
  'CURRENT_TIME_HH_MM_SS',
  'CURRENT_TIME_LOCALE',
  'FILENAME',
  'FILEPATH',
  'ISSUE_DATE',
  'KICAD_VERSION',
  'LAYER',
  'PAPER',
  'PROJECTNAME',
  'REVISION',
  'SHEETNAME',
  'SHEETPATH',
  'TITLE',
  'VARIANT',
  'VARIANT_DESC',
  'VARIANTNAME',
  'VCSHASH',
  'VCSSHORTHASH',
  ...Array.from({ length: 9 }, (_, index) => `COMMENT${index + 1}`)
])

/** Names a placed part adds for its own fields and text. */
const SYMBOL_VARIABLES = new Set([
  'DNP',
  'EXCLUDE_FROM_BOARD',
  'EXCLUDE_FROM_BOM',
  'EXCLUDE_FROM_SIM',
  'FOOTPRINT_LIBRARY',
  'FOOTPRINT_NAME',
  'OP',
  // A simulation field the part does not set reads empty (`SCH_SYMBOL::ResolveTextVar`).
  'SIM.DEVICE',
  'SIM.LIBRARY',
  'SIM.NAME',
  'SIM.PARAMS',
  'SIM.PINS',
  'SIM.TYPE',
  'SHORT_REFERENCE',
  'SYMBOL_DESCRIPTION',
  'SYMBOL_KEYWORDS',
  'SYMBOL_LIBRARY',
  'SYMBOL_NAME',
  'UNIT'
])

/**
 * `${NAME}` references in a text that nothing defines: not a built-in, not a
 * field of the part or of an enclosing sheet, not `REF:FIELD` naming a part
 * that exists, not a project text variable or an environment path. A
 * function-style reference (`${NET_NAME(1)}`) is taken as resolved.
 */
const unresolvedVariables = (
  sheets: SheetConnectivityInput[],
  context: ErcContext
): CheckResult[] => {
  const references = new Set(
    sheets.flatMap(({ sheetPath, schematic }) =>
      schematic.symbols.map((symbol) =>
        (
          symbol.instances.find((instance) => instance.path === sheetPath)?.reference ??
          getSymbolProperty(symbol, 'Reference') ??
          ''
        ).toUpperCase()
      )
    )
  )
  const project = new Set(Object.keys(context.textVariables ?? {}).map((key) => key.toUpperCase()))
  // The fields of every sheet symbol, by the child sheet path it opens.
  const sheetFields = new Map<string, Set<string>>()
  for (const { sheetPath, schematic } of sheets) {
    for (const box of schematic.sheets) {
      sheetFields.set(
        `${sheetPath}/${box.uuid ?? ''}`,
        new Set(box.properties.map((property) => property.key.toUpperCase()))
      )
    }
  }
  const results: CheckResult[] = []
  const seen = new Set<string>()
  for (const { sheetPath, schematic } of sheets) {
    const enclosing = new Set<string>()
    for (
      let path = sheetPath;
      path.lastIndexOf('/') > 0;
      path = path.slice(0, path.lastIndexOf('/'))
    ) {
      for (const key of sheetFields.get(path) ?? []) enclosing.add(key)
    }
    const known = (name: string, own: Set<string> = new Set()): boolean => {
      const upper = name.toUpperCase()
      if (BUILT_IN_VARIABLES.has(upper) || project.has(upper) || enclosing.has(upper)) return true
      if (own.has(upper)) return true
      if (/^\w+\(.*\)$/.test(name)) return true
      if (upper === 'KIPRJMOD' || upper.startsWith('KICAD')) return true
      const colon = name.indexOf(':')
      return colon > 0 && references.has(name.slice(0, colon).toUpperCase())
    }
    const scan = (
      text: string,
      own: Set<string> | undefined,
      where: Point,
      id: string | undefined
    ): void => {
      const unknown = [...text.matchAll(/\$\{([^}]*)\}/g)]
        .map((match) => match[1])
        .filter((name) => !known(name, own))
      if (!unknown.length) return
      const key = `${id ?? `${sheetPath}|${where.x},${where.y}`}`
      if (seen.has(key)) return
      seen.add(key)
      results.push({
        code: 'unresolved-variable',
        severity: 'error',
        message: `\${${unknown[0]}} is not defined: no field, sheet field or project text variable has that name. Define it in Schematic setup's text variables, or fix the name.`,
        items: unknown.map((name) => `\${${name}}`),
        position: mm(where),
        sheetPath,
        targets: ids(id),
        kicadIds: ids(id),
        subject: unknown[0]
      })
    }
    for (const symbol of schematic.symbols) {
      const own = new Set([
        ...symbol.properties.map((property) => property.key.toUpperCase()),
        ...SYMBOL_VARIABLES
      ])
      for (const property of symbol.properties)
        scan(property.value, own, property.position, symbol.uuid)
    }
    for (const label of schematic.labels) scan(label.text, undefined, label.position, label.uuid)
    for (const box of schematic.sheets) {
      const own = new Set(box.properties.map((property) => property.key.toUpperCase()))
      for (const property of box.properties) scan(property.value, own, property.position, box.uuid)
    }
    for (const text of schematic.texts) scan(text.text, undefined, text.position, text.uuid)
  }
  return results
}

export const namingChecks = (
  connectivity: SchematicConnectivity,
  sheets: SheetConnectivityInput[],
  context: ErcContext = {}
): CheckResult[] => {
  const names = namesOf(connectivity)
  return [
    ...similarNames(names),
    ...sameLocalGlobal(names),
    ...groundPins(connectivity),
    ...stackedPins(sheets),
    ...fieldWhitespace(sheets),
    ...(context.netclasses
      ? undefinedNetclass(sheets, context.netclasses, context.textVariables)
      : []),
    ...unresolvedVariables(sheets, context),
    ...singleGlobalLabels(sheets),
    ...fourWayJunctions(sheets)
  ]
}

export const NAMING_RULES: Record<string, string> = {
  'similar-labels': 'Two labels whose names differ only in case, and so name two nets.',
  'similar-power': 'Two power ports whose names differ only in case, and so name two rails.',
  'similar-label-and-power': 'A label and a power port whose names differ only in case.',
  'same-local-global-label':
    'One name used locally and globally, by labels or power ports; the local one joins only its sheet.',
  'same-local-global-power':
    'One name used by a local power port and by a global one; the local one powers only its sheet.',
  'ground-pin-not-ground':
    "A part's ground pin that is not on a ground net while another of its ground pins is.",
  'stacked-pin-name': 'A pin number in stacked notation ([1,2,5-7]) that does not parse.',
  'field-name-whitespace': 'A field name with a leading or trailing space.',
  'undefined-netclass': 'A Netclass field naming a class the project does not define.',
  'unresolved-variable':
    'A ${NAME} in a text that nothing defines: no field, sheet field or project text variable.',
  'single-global-label': 'A global label whose name appears nowhere else (off by default).',
  'four-way-junction': 'Four or more pins and wire ends meeting at one point (off by default).'
}

export const NAMING_KICAD_KEYS: Record<string, string> = {
  'similar-labels': 'similar_labels',
  'similar-power': 'similar_power',
  'similar-label-and-power': 'similar_label_and_power',
  'same-local-global-label': 'same_local_global_label',
  'same-local-global-power': 'same_local_global_power',
  'ground-pin-not-ground': 'ground_pin_not_ground',
  'stacked-pin-name': 'stacked_pin_name',
  'field-name-whitespace': 'field_name_whitespace',
  'undefined-netclass': 'undefined_netclass',
  'unresolved-variable': 'unresolved_variable',
  'single-global-label': 'single_global_label',
  'four-way-junction': 'four_way_junction'
}
