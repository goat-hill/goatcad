// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * The KiCad netlist (`.net`, format version "E") a schematic project exports,
 * as `kicad-cli sch export netlist` writes it: a port of
 * `eeschema/netlist_exporters/netlist_exporter_xml.cpp` under `GNL_OPT_KICAD`,
 * serialized through the same `Prettify` the files use.
 *
 * The parts come from the board sync's `syncParts` and the nets from the
 * design's connectivity, so a netlist and an Update PCB from Schematic read
 * the schematic one way. `libraries` is not written: its URIs live in the
 * symbol library tables, which a design does not carry, and nothing that reads
 * a netlist into a board needs them.
 */
import { syncParts, type SyncDesign, type SyncPart } from '../board/boardSync'
import { basenameOf } from '../kicad/paths'
import {
  getLibSymbolProperty,
  pinText,
  type KicadLibSymbol,
  type KicadSchematic,
  type SymbolPin
} from '../kicad/schematic'
import {
  findChild,
  findChildren,
  getAtomValues,
  serializeSExpr,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'
import type { SchematicConnectivity } from './connectivity'
import { inPageOrder, strNumCmp } from './sheetPages'

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * KiCad's `StrNumCmp`; it lives with the page helpers (`sheetPages.ts`), which
 * order pages by it too.
 */
export { strNumCmp }

/** wxString's `<`: by code unit. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// ---------------------------------------------------------------------------
// Nets
// ---------------------------------------------------------------------------

export interface NetlistNode {
  ref: string
  pin: string
  /** The pin's name and number joined, when the pin has a name. */
  pinFunction?: string
  /** The canonical electrical type, `+no_connect` when a flag stands on the net's one pin. */
  pinType: string
}

export interface NetlistNet {
  /** One-based position in name order, counted over every net, written or not. */
  code: number
  name: string
  netClass: string
  nodes: NetlistNode[]
}

/**
 * Every net the netlist carries, in KiCad's order: nets by name (`StrNumCmp`),
 * nodes by reference then pin number. A net whose only pins are power symbols
 * is not written but keeps its code; a part kept off the board contributes no
 * node, as under `GNL_OPT_KICAD`.
 */
export const netlistNets = (
  connectivity: SchematicConnectivity,
  netClassOf: (name: string) => string = () => 'Default'
): NetlistNet[] => {
  const sorted = [...connectivity.nets].sort((a, b) => strNumCmp(a.name, b.name))
  const out: NetlistNet[] = []
  sorted.forEach((net, index) => {
    const members = net.pins
      .filter((pin) => pin.symbol.onBoard)
      .sort(
        (a, b) => byCodeUnit(a.reference, b.reference) || byCodeUnit(a.pin.number, b.pin.number)
      )
      .filter(
        (pin, i, all) =>
          i === 0 ||
          all[i - 1].reference !== pin.reference ||
          all[i - 1].pin.number !== pin.pin.number
      )
    // Measured before power symbols drop out, as KiCad does.
    const first = members[0]
    const stacked =
      members.length <= 1 ||
      members.every(
        (pin) =>
          pin.symbol === first.symbol &&
          pin.position.x === first.position.x &&
          pin.position.y === first.position.y &&
          pin.pin.name === first.pin.name
      )
    const noConnect = net.hasNoConnect && stacked
    const nodes: NetlistNode[] = []
    for (const member of members) {
      if (member.reference.startsWith('#')) continue
      const name = pinText(member.pin.name)
      const number = member.pin.number
      nodes.push({
        ref: member.reference,
        pin: number,
        ...(name ? { pinFunction: `${name}_${number}` } : {}),
        pinType: `${member.pin.electricalType}${noConnect ? '+no_connect' : ''}`
      })
    }
    if (nodes.length)
      out.push({ code: index + 1, name: net.name, netClass: netClassOf(net.name), nodes })
  })
  return out
}

// ---------------------------------------------------------------------------
// S-expression building
// ---------------------------------------------------------------------------

const atom = (value: string, quoted = true): SExprNode => ({
  type: 'atom',
  value,
  quoted,
  start: 0,
  end: 0
})

/** `(token "value"…)`, or `(token)` when a value is empty — XNODE writes no empty content. */
const leaf = (token: string, ...values: string[]): SExprList => ({
  type: 'list',
  children: [
    atom(token, false),
    ...values.filter((value) => value !== '').map((value) => atom(value))
  ],
  start: 0,
  end: 0
})

/** `(value "")`: an attribute is written even when empty. */
const attr = (token: string, value: string): SExprList => ({
  type: 'list',
  children: [atom(token, false), atom(value)],
  start: 0,
  end: 0
})

const list = (token: string, children: SExprNode[]): SExprList => ({
  type: 'list',
  children: [atom(token, false), ...children],
  start: 0,
  end: 0
})

/** `(field (name "X") "value")`: an XNODE with an attribute and content. */
const named = (token: string, name: string, value: string): SExprList => ({
  type: 'list',
  children: [atom(token, false), attr('name', name), ...(value ? [atom(value)] : [])],
  start: 0,
  end: 0
})

// ---------------------------------------------------------------------------
// Library symbols
// ---------------------------------------------------------------------------

const MANDATORY = new Set(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'])

/** A definition and the ones it extends, nearest first. */
const lineage = (schematic: KicadSchematic, id: string): KicadLibSymbol[] => {
  const chain: KicadLibSymbol[] = []
  let definition = schematic.libSymbols.get(id)
  while (definition && chain.length < 8 && !chain.includes(definition)) {
    chain.push(definition)
    definition = definition.extends ? schematic.libSymbols.get(definition.extends) : undefined
  }
  return chain
}

const inherited = (chain: KicadLibSymbol[], keys: string[]): string | undefined => {
  for (const definition of chain) {
    for (const key of keys) {
      const value = getLibSymbolProperty(definition, key)
      if (value !== undefined) return value
    }
  }
  return undefined
}

/** Pins live on the root of an `extends` chain. */
const pinSource = (chain: KicadLibSymbol[]): KicadLibSymbol | undefined => chain[chain.length - 1]

const unitCount = (definition: KicadLibSymbol | undefined): number =>
  Math.max(1, ...(definition?.variants.map((variant) => variant.unit) ?? [1]))

/** `LIB_SYMBOL::LetterSubReference`: A…Z, then AA, AB…. */
const unitLetter = (unit: number): string => {
  let n = unit
  let out = ''
  while (n > 0) {
    const digit = (n - 1) % 26
    out = String.fromCharCode(65 + digit) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** A unit's pins in `GetUnitPinInfo` order: by x, then y (down), each number once. */
const unitPins = (definition: KicadLibSymbol | undefined, unit: number): string[] => {
  if (!definition) return []
  const pins: SymbolPin[] = definition.variants
    .filter((variant) => variant.unit === unit || variant.unit === 0)
    .flatMap((variant) => variant.pins)
  // Library y points up; KiCad sorts in its y-down space.
  pins.sort((a, b) => a.position.x - b.position.x || b.position.y - a.position.y)
  const seen = new Set<string>()
  return pins.map((pin) => pin.number).filter((number) => !seen.has(number) && !!seen.add(number))
}

const splitLibId = (id: string): { lib: string; part: string } => {
  const colon = id.indexOf(':')
  return colon < 0 ? { lib: '', part: id } : { lib: id.slice(0, colon), part: id.slice(colon + 1) }
}

const fpFilterList = (filters: string | undefined): string[] =>
  (filters ?? '').split(/\s+/).filter(Boolean)

/** A Datasheet as KiCad shows it: `~` is empty in every file this app reads. */
const shownDatasheet = (value: string | undefined): string =>
  value === undefined || value === '~' ? '' : value

const libPartNode = (schematic: KicadSchematic, id: string): SExprList | null => {
  const chain = lineage(schematic, id)
  const definition = chain[0]
  if (!definition) return null
  const { lib, part } = splitLibId(id)
  const description = inherited(chain, ['Description', 'ki_description']) ?? ''
  const docs = shownDatasheet(inherited(chain, ['Datasheet']))
  const filters = fpFilterList(inherited(chain, ['ki_fp_filters']))
  const children: SExprNode[] = [attr('lib', lib), attr('part', part)]
  if (description) children.push(leaf('description', description))
  if (docs) children.push(leaf('docs', docs))
  if (filters.length)
    children.push(
      list(
        'footprints',
        filters.map((fp) => leaf('fp', fp))
      )
    )
  const fields = new Map<string, string>()
  for (const key of MANDATORY) fields.set(key, '')
  for (const source of [...chain].reverse()) {
    for (const property of source.properties) {
      if (property.key.startsWith('ki_')) continue
      fields.set(
        property.key,
        property.key === 'Datasheet' ? shownDatasheet(property.value) : property.value
      )
    }
  }
  children.push(
    list(
      'fields',
      [...fields].map(([key, value]) => named('field', key, value))
    )
  )
  const root = pinSource(chain)
  const pins = [...(root?.variants.flatMap((variant) => variant.pins) ?? [])].sort((a, b) =>
    strNumCmp(a.number, b.number, true)
  )
  const unique = pins.filter((pin, i) => i === 0 || pins[i - 1].number !== pin.number)
  if (unique.length)
    children.push(
      list(
        'pins',
        unique.map((pin) =>
          list('pin', [
            attr('num', pin.number),
            attr('name', pinText(pin.name)),
            attr('type', pin.electricalType)
          ])
        )
      )
    )
  return list('libpart', children)
}

// ---------------------------------------------------------------------------
// The design header
// ---------------------------------------------------------------------------

const TITLE_BLOCK_KEYS = ['title', 'company', 'rev', 'date'] as const

const titleBlockNode = (schematic: KicadSchematic, source: string): SExprList => {
  const block = findChild(schematic._root, 'title_block')
  const text = (token: string): string =>
    block ? (getAtomValues(findChild(block, token) ?? list('', []))[0] ?? '') : ''
  const comments = new Map<string, string>()
  for (const comment of block ? findChildren(block, 'comment') : []) {
    const [number, value] = getAtomValues(comment)
    if (number) comments.set(number, value ?? '')
  }
  return list('title_block', [
    ...TITLE_BLOCK_KEYS.map((key) => leaf(key, text(key))),
    leaf('source', source),
    ...Array.from({ length: 9 }, (_, i) =>
      list('comment', [
        attr('number', String(i + 1)),
        attr('value', comments.get(String(i + 1)) ?? '')
      ])
    )
  ])
}

/** `SCH_SHEET_PATH::PathAsString`: the instance path without the root's uuid, slash-terminated. */
const pathAsString = (sheetPath: string): string => `${sheetPath.replace(/^\/[^/]*/, '')}/`

/** `SCH_SHEET_PATH::PathHumanReadable`: `/` for the root, `/Name/` below it. */
const humanPath = (namePath: string): string =>
  namePath === '/' || namePath === '' ? '/' : `${namePath}/`

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The instance's sheet node — the last uuid of its path, found in any sheet's `(sheet …)`. */
const sheetFieldsFor = (
  design: SyncDesign,
  sheetPath: string,
  rootFile: string
): Array<[string, string]> => {
  const uuid = sheetPath.split('/').filter(Boolean).slice(1).pop()
  if (!uuid) {
    const file = basenameOf(rootFile)
    return [
      ['Sheetname', file.replace(/\.kicad_sch$/i, '')],
      ['Sheetfile', file]
    ]
  }
  for (const source of design.sheets) {
    const sheet = source.schematic.sheets.find((candidate) => candidate.uuid === uuid)
    if (sheet) return sheet.properties.map((property) => [property.key, property.value])
  }
  return []
}

const componentNode = (part: SyncPart, sheetFields: Array<[string, string]>): SExprList => {
  const { symbol, source } = part.primary
  const chain = lineage(source.schematic, symbol.libName ?? symbol.libId)
  const datasheet = part.fields.find(([key]) => key === 'Datasheet')?.[1] ?? ''
  const description = part.fields.find(([key]) => key === 'Description')?.[1] ?? ''
  const user = part.fields.filter(([key]) => !MANDATORY.has(key))
  const children: SExprNode[] = [attr('ref', part.reference), leaf('value', part.value || '~')]
  if (part.libId) children.push(leaf('footprint', part.libId))
  if (datasheet) children.push(leaf('datasheet', datasheet))
  if (description) children.push(leaf('description', description))
  children.push(
    list('fields', [
      ...user.map(([key, value]) => named('field', key, value)),
      named('field', 'Footprint', part.libId),
      named('field', 'Datasheet', datasheet),
      named('field', 'Description', description)
    ])
  )
  const { lib, part: name } = symbol.libName
    ? { lib: '', part: symbol.libName }
    : splitLibId(symbol.libId)
  children.push(
    list('libsource', [attr('lib', lib), attr('part', name), attr('description', description)])
  )
  const property = (key: string, value?: string): SExprList =>
    list('property', [attr('name', key), ...(value === undefined ? [] : [attr('value', value)])])
  for (const [key, value] of user) children.push(property(key, value))
  for (const [key, value] of sheetFields) children.push(property(key, value))
  if (part.excludeFromBom) children.push(property('exclude_from_bom'))
  if (part.dnp) children.push(property('dnp'))
  const keywords = inherited(chain, ['ki_keywords'])
  if (keywords) children.push(property('ki_keywords', keywords))
  const filters = fpFilterList(part.fpFilters)
  if (filters.length) children.push(property('ki_fp_filters', filters.join(' ')))
  children.push(
    list('sheetpath', [
      attr('names', humanPath(part.namePath)),
      attr('tstamps', pathAsString(part.sheetPath))
    ])
  )
  children.push(
    list(
      'tstamps',
      part.uuids.map((uuid) => atom(uuid))
    )
  )
  const pins = pinSource(chain)
  const units = unitCount(pins)
  children.push(
    list(
      'units',
      Array.from({ length: units }, (_, i) =>
        list('unit', [
          attr('name', unitLetter(i + 1)),
          list(
            'pins',
            unitPins(pins, i + 1).map((number) => list('pin', [attr('num', number)]))
          )
        ])
      )
    )
  )
  return list('comp', children)
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

export interface NetlistOptions {
  /** The root schematic's absolute path, written as the design's source. */
  source: string
  /** When it was written; KiCad's own spelling is ISO 8601 without a zone. */
  date: string
  tool: string
  /** The net class a net name falls in; Default when the project names none. */
  netClassOf?: (name: string) => string
}

/** `YYYY-MM-DDTHH:MM:SS` in local time, the stamp KiCad writes. */
export const netlistDate = (when: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
}

/** The whole `.net` file for a design. */
export const writeNetlist = (design: SyncDesign, options: NetlistOptions): string => {
  const rootFile = design.sheets[0]?.filePath ?? options.source
  const fileBySheet = new Map(design.sheets.map((sheet) => [sheet.sheetPath, sheet]))

  // `SCH_SHEET_LIST::SortByPageNumbers`: by page, then hierarchy order.
  const ordered = inPageOrder(design.inputs)
  const sheets = ordered.map((input, index) =>
    list('sheet', [
      attr('number', String(index + 1)),
      attr('name', humanPath(input.namePath)),
      attr('tstamps', pathAsString(input.sheetPath)),
      titleBlockNode(input.schematic, basenameOf(fileBySheet.get(input.sheetPath)?.filePath ?? ''))
    ])
  )
  const header = list('design', [
    attr('source', options.source),
    attr('date', options.date),
    attr('tool', options.tool),
    ...sheets
  ])

  // Components: sheets in hierarchy order, references in StrNumCmp order within one.
  const sheetOrder = new Map(ordered.map((input, index) => [input.sheetPath, index]))
  const { parts } = syncParts(design)
  parts.sort(
    (a, b) =>
      (sheetOrder.get(a.sheetPath) ?? 0) - (sheetOrder.get(b.sheetPath) ?? 0) ||
      strNumCmp(a.reference, b.reference, true)
  )
  const components = list(
    'components',
    parts.map((part) => componentNode(part, sheetFieldsFor(design, part.sheetPath, rootFile)))
  )

  // Every definition a written part is drawn from, once, in lib-id order.
  const definitions = new Map<string, KicadSchematic>()
  for (const part of parts) {
    const { symbol, source } = part.primary
    const id = symbol.libName ?? symbol.libId
    if (!definitions.has(id)) definitions.set(id, source.schematic)
  }
  const libparts = list(
    'libparts',
    [...definitions]
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([id, schematic]) => libPartNode(schematic, id))
      .filter((node): node is SExprList => node !== null)
  )

  const nets = list(
    'nets',
    netlistNets(design.connectivity, options.netClassOf).map((net) =>
      list('net', [
        attr('code', String(net.code)),
        attr('name', net.name),
        attr('class', net.netClass),
        ...net.nodes.map((node) =>
          list('node', [
            attr('ref', node.ref),
            attr('pin', node.pin),
            ...(node.pinFunction ? [attr('pinfunction', node.pinFunction)] : []),
            attr('pintype', node.pinType)
          ])
        )
      ])
    )
  )

  // Groups and variants are not modeled; KiCad writes both lists, empty when a design has none.
  const root = list('export', [
    attr('version', 'E'),
    header,
    components,
    list('groups', []),
    list('variants', []),
    libparts,
    nets
  ])
  return `${serializeSExpr(root)}\n`
}

/** Where File ▸ Export ▸ Netlist offers to write: beside the root sheet, as KiCad does. */
export const netlistPathFor = (rootSchematic: string): string =>
  rootSchematic.replace(/\.kicad_sch$/i, '') + '.net'
