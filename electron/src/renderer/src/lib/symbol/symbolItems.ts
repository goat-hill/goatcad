/**
 * The items of one symbol definition as records an agent reads and writes:
 * pins, graphics and fields, in the symbol's own frame (millimeters, y down —
 * sheet space, as `symbol_get` answers). The symbol twin of
 * `footprint/footprintItems.ts`.
 *
 * A `.kicad_sym` stores y up, so every point is negated on the way in and out.
 * Angles keep their number: KiCad's are counter-clockwise as drawn, in either
 * frame, so a pin at 90 points up on the sheet as it does in the file.
 *
 * Pure: every function takes a `(symbol "Name" …)` node — a library's, or a
 * schematic's embedded `lib_symbols` copy — and edits it through `symbolEdit.ts`'s
 * helpers, so the caller decides whether the edit lands or is thrown away.
 *
 * Ids: `pin:<number>`, or `pin:<number>@<unit>.<style>` when units or body
 * styles share a number, or `pin@<unit>.<style>.<index>` when even that is
 * ambiguous; `<kind>:<unit>.<style>.<index>` for a graphic, the index counting
 * graphics within that unit sub-symbol as `SymbolPartAddress` does;
 * `field:<Key>` for a field; `symbol` for the definition itself, whose record
 * is Symbol Properties and which is neither created nor deleted here.
 */
import { makeAtom, makeList, setPointsChildNm } from '../kicad/footprint'
import {
  findChildren,
  getFirstAtomValue,
  getToken,
  markNodeDirty,
  type SExprList
} from '../kicad/sexpr'
import { mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import { measureTextWidth } from '../kicad/newstroke'
import {
  parseLibSymbol,
  parseVariantSuffix,
  SYMBOL_GRAPHIC_TOKENS,
  type KicadLibSymbol,
  type KicadTextEffects,
  type SymbolGraphic,
  type SymbolPin,
  type SymbolStroke
} from '../kicad/schematic'
import { hexColorToRgba, rgbaToHexColor, type Rgba } from '../kicad/color'
import { powerKindOf } from './symbolPropertySchema'
import { rotateLocal, type Box } from '../footprint/footprintGeometry'
import {
  narrowingsOf,
  pageOf,
  QUERY_DEFAULT_LIMIT,
  tally,
  type Narrowing,
  type QueryPage
} from '../queryPage'
import {
  addArc,
  addBezier,
  addCircle,
  addPin,
  addPolyline,
  addRectangle,
  addSymbolProperty,
  addPinAlternate,
  addText,
  addTextBox,
  deleteGraphic,
  deletePin,
  getOrCreateUnitNode,
  graphicExtentPoints,
  isMandatoryField,
  isUserField,
  MANDATORY_FIELD_KEYS,
  movePartToUnit,
  pinAlternateNodes,
  pinExtentPoints,
  removePinAlternate,
  removeSymbolProperty,
  removeUnit,
  renameSymbol,
  renameSymbolProperty,
  setSymbolFlag,
  setSymbolFootprintFilters,
  setSymbolPinDisplay,
  setSymbolPowerKind,
  setSymbolProperty,
  setSymbolPropertyVisible,
  setSymbolUnitName,
  setSymbolUnitsInterchangeable,
  symbolBodyStyleCount,
  symbolPropertyNode,
  symbolUnitCount,
  symbolUnitName,
  updateArc,
  updateCircle,
  updatePin,
  updatePolyline,
  updateRectangle,
  updateSymbolProperty,
  updateSymbolText,
  updateSymbolTextBox,
  type GraphicStylePatch,
  type SymbolPowerKind,
  type TextEffectsPatch
} from './symbolEdit'
import {
  SYMBOL_ITEM_KINDS,
  SYMBOL_READ_ONLY_KEYS,
  type RecordMode,
  type SymbolItemKind
} from '../../../../shared/itemRecords'
import { checkRecord } from '../../../../shared/recordRules'

export { SYMBOL_ITEM_KINDS, type SymbolItemKind }

/** The definition's own id: `items_get` and `items_update` on it are Symbol Properties. */
export const SYMBOL_ID = 'symbol'

export interface SymbolItem {
  id: string
  kind: SymbolItemKind
  /** The AST node the item is. */
  node: SExprList
  record: Record<string, unknown>
  /** Nanometers, y down. */
  box: Box | null
}

export type SymbolItemFailure = {
  ok: false
  error: 'item-not-found' | 'not-applicable' | 'invalid-record' | 'refused'
  detail: string
  candidates?: string[]
}

type Point = { x: number; y: number }

const mm = (value: number): number => nmToMm(Math.round(value) as Nm)
const toNm = (value: number): Nm => mmToNm(value)
/** `0 - v`, not `-v`: a negated zero would read back as -0 and print as such. */
const flip = (value: number): number => 0 - value

/** A file point (nm, y up) as the agent reads it (mm, y down). */
const sheetXY = (p: Point): Point => ({ x: mm(p.x), y: mm(flip(p.y)) })
/** An agent's point (mm, y down) as the file stores it (nm, y up). */
const fileXY = (p: Point): { x: Nm; y: Nm } => ({ x: toNm(p.x), y: toNm(flip(p.y)) })
/** A file point flipped into the y-down nanometer frame the boxes use. */
const downNm = (p: Point): Point => ({ x: p.x, y: flip(p.y) })

const pathBox = (points: Point[], width: number): Box => ({
  minX: Math.min(...points.map((p) => p.x)) - width / 2,
  minY: Math.min(...points.map((p) => p.y)) - width / 2,
  maxX: Math.max(...points.map((p) => p.x)) + width / 2,
  maxY: Math.max(...points.map((p) => p.y)) + width / 2
})

/** A text's box (nm, y down), justified about its anchor and turned by its angle. */
const textBox = (text: string, at: Point, angle: number, effects: KicadTextEffects): Box => {
  const height = effects.fontSize.height
  const advance = mmToNm(
    measureTextWidth(text, {
      width: nmToMm(effects.fontSize.width),
      height: nmToMm(height),
      thickness: nmToMm(effects.thickness ?? ((height * 0.15) as Nm))
    })
  )
  const tall = height * text.split('\n').length
  const [x0, x1] =
    effects.horizontalAlign === 'left'
      ? [0, advance]
      : effects.horizontalAlign === 'right'
        ? [-advance, 0]
        : [-advance / 2, advance / 2]
  const [y0, y1] =
    effects.verticalAlign === 'top'
      ? [0, tall]
      : effects.verticalAlign === 'bottom'
        ? [-tall, 0]
        : [-tall / 2, tall / 2]
  const corners = [
    rotateLocal(x0, y0, angle),
    rotateLocal(x1, y0, angle),
    rotateLocal(x1, y1, angle),
    rotateLocal(x0, y1, angle)
  ].map((p) => ({ x: at.x + p.x, y: at.y + p.y }))
  return pathBox(corners, 0)
}

const GRAPHIC_KIND: Record<SymbolGraphic['type'], SymbolItemKind> = {
  line: 'polyline',
  bezier: 'bezier',
  rectangle: 'rect',
  circle: 'circle',
  arc: 'arc',
  text: 'text',
  textBox: 'text_box'
}

const pinRecord = (pin: SymbolPin, unit: number, style: number): Record<string, unknown> => ({
  number: pin.number,
  name: pin.name,
  type: pin.electricalType,
  shape: pin.graphicStyle,
  at: sheetXY(pin.position),
  angle: pin.position.angle,
  length: mm(pin.length),
  hidden: pin.hidden,
  unit,
  style,
  nameSize: mm(pin.nameEffects.fontSize.height),
  numberSize: mm(pin.numberEffects.fontSize.height),
  ...(pin.alternates.length
    ? {
        alternates: pin.alternates.map((alternate) => ({
          name: alternate.name,
          type: alternate.electricalType,
          shape: alternate.graphicStyle
        }))
      }
    : {})
})

/** A stroked shape's line and fill. */
const strokeRecord = (g: {
  stroke: SymbolStroke
  fill: string
  fillColor?: Rgba
}): Record<string, unknown> => ({
  width: mm(g.stroke.width),
  strokeType: g.stroke.type ?? 'default',
  strokeColor: rgbaToHexColor(g.stroke.color),
  fill: g.fill,
  fillColor: rgbaToHexColor(g.fillColor)
})

/** How a text is set: the keys text, text boxes and fields share. */
const textStyleRecord = (effects: KicadTextEffects): Record<string, unknown> => ({
  size: mm(effects.fontSize.height),
  thickness: effects.thickness === undefined ? null : mm(effects.thickness),
  bold: effects.bold,
  italic: effects.italic,
  justify: effects.horizontalAlign,
  verticalJustify: effects.verticalAlign,
  color: rgbaToHexColor(effects.color)
})

const graphicRecord = (g: SymbolGraphic): Record<string, unknown> => {
  switch (g.type) {
    case 'line':
    case 'bezier':
      return { points: g.points.map(sheetXY), ...strokeRecord(g) }
    case 'rectangle':
      return { start: sheetXY(g.start), end: sheetXY(g.end), ...strokeRecord(g) }
    case 'circle':
      return { center: sheetXY(g.center), radius: mm(g.radius), ...strokeRecord(g) }
    case 'arc':
      return {
        start: sheetXY(g.start),
        mid: sheetXY(g.mid),
        end: sheetXY(g.end),
        ...strokeRecord(g)
      }
    case 'text':
      return {
        text: g.text,
        at: sheetXY(g.position),
        angle: g.position.angle,
        ...textStyleRecord(g.effects)
      }
    case 'textBox':
      // The file holds a top-left corner and an extent (height negative, as
      // the box runs down in a y-up file); two corners are what a model edits.
      return {
        text: g.text,
        start: sheetXY(g.position),
        end: sheetXY({ x: g.position.x + g.size.width, y: g.position.y + g.size.height }),
        angle: g.position.angle,
        ...textStyleRecord(g.effects),
        margins: {
          left: mm(g.margins.left),
          top: mm(g.margins.top),
          right: mm(g.margins.right),
          bottom: mm(g.margins.bottom)
        },
        ...strokeRecord(g)
      }
  }
}

/** The definition's own record: what Symbol Properties edits. */
const symbolRecord = (symbolNode: SExprList, def: KicadLibSymbol): Record<string, unknown> => {
  const value = (key: string): string | undefined =>
    def.properties.find((property) => property.key === key)?.value
  const units = symbolUnitCount(symbolNode)
  return {
    name: def.name,
    ...(def.extends ? { extends: def.extends } : {}),
    power: powerKindOf(def),
    inBom: def.inBom,
    onBoard: def.onBoard,
    inPositionFiles: def.inPosFiles,
    excludeFromSim: def.excludeFromSim,
    duplicatePinNumbersAreJumpers: def.duplicatePinNumbersAreJumpers,
    showPinNames: !def.pinNamesHidden,
    showPinNumbers: !def.pinNumbersHidden,
    pinNameOffset: mm(def.pinNameOffset),
    description: value('Description') ?? value('ki_description') ?? '',
    keywords: value('ki_keywords') ?? '',
    datasheet: value('Datasheet') ?? '',
    footprintFilters: (value('ki_fp_filters') ?? '').split(/\s+/).filter(Boolean),
    units,
    unitNames: Array.from({ length: units }, (_, i) => symbolUnitName(symbolNode, i + 1) ?? ''),
    unitsInterchangeable: !def.unitsLocked,
    styles: symbolBodyStyleCount(symbolNode)
  }
}

const graphicBox = (g: SymbolGraphic): Box => {
  if (g.type === 'text') {
    return textBox(g.text, downNm(g.position), g.position.angle, g.effects)
  }
  const width = g.type === 'textBox' ? 0 : g.stroke.width
  return pathBox(graphicExtentPoints(g).map(downNm), width)
}

/** The unit sub-symbols a part can be addressed in, with their (unit, style). */
const unitNodes = (
  symbolNode: SExprList
): Array<{ node: SExprList; unit: number; style: number; position: number }> =>
  findChildren(symbolNode, 'symbol').flatMap((node, position) => {
    // A name this cannot read is a part nothing can address, as in
    // `symbolPartAddresses`; KiCad never writes one.
    const suffix = parseVariantSuffix(getFirstAtomValue(node) ?? '')
    return suffix ? [{ node, ...suffix, position }] : []
  })

const graphicNodesOf = (unitNode: SExprList): SExprList[] =>
  unitNode.children.filter(
    (child): child is SExprList =>
      child.type === 'list' && SYMBOL_GRAPHIC_TOKENS.has(getToken(child) ?? '')
  )

/** Every item of a symbol definition, with its id, record and box. */
export function symbolItems(symbolNode: SExprList): SymbolItem[] {
  const symbol = parseLibSymbol(symbolNode)
  const units = unitNodes(symbolNode)
  const pins: Array<{
    pin: SymbolPin
    node: SExprList
    unit: number
    style: number
    index: number
  }> = []
  const graphics: SymbolItem[] = []
  for (const unit of units) {
    // `parseLibSymbol` walks the same sub-symbols in the same order, so the
    // typed variant and the node lists line up index for index.
    const variant = symbol.variants[unit.position]
    findChildren(unit.node, 'pin').forEach((node, index) => {
      const pin = variant?.pins[index]
      if (pin) pins.push({ pin, node, unit: unit.unit, style: unit.style, index })
    })
    graphicNodesOf(unit.node).forEach((node, index) => {
      const graphic = variant?.graphics[index]
      if (!graphic) return
      const kind = GRAPHIC_KIND[graphic.type]
      graphics.push({
        id: `${kind}:${unit.unit}.${unit.style}.${index}`,
        kind,
        node,
        record: { ...graphicRecord(graphic), unit: unit.unit, style: unit.style },
        box: graphicBox(graphic)
      })
    })
  }

  const byNumber = new Map<string, number>()
  const byNumberAt = new Map<string, number>()
  for (const { pin, unit, style } of pins) {
    byNumber.set(pin.number, (byNumber.get(pin.number) ?? 0) + 1)
    const key = `${pin.number}@${unit}.${style}`
    byNumberAt.set(key, (byNumberAt.get(key) ?? 0) + 1)
  }
  const out: SymbolItem[] = pins.map(({ pin, node, unit, style, index }) => {
    const at = `${pin.number}@${unit}.${style}`
    const id =
      pin.number === ''
        ? `pin@${unit}.${style}.${index}`
        : byNumber.get(pin.number) === 1
          ? `pin:${pin.number}`
          : byNumberAt.get(at) === 1
            ? `pin:${at}`
            : `pin@${unit}.${style}.${index}`
    return {
      id,
      kind: 'pin',
      node,
      record: pinRecord(pin, unit, style),
      box: pathBox(pinExtentPoints(pin).map(downNm), 0)
    }
  })
  out.push(...graphics)

  for (const property of symbol.properties) {
    if (!isUserField(property.key)) continue
    out.push({
      id: `field:${property.key}`,
      kind: 'field',
      node: property._node,
      record: {
        key: property.key,
        value: property.value,
        at: sheetXY(property.position),
        angle: property.position.angle,
        hidden: property.hidden,
        showName: property.showName,
        doNotAutoplace: property.doNotAutoplace,
        private: property.isPrivate === true,
        ...textStyleRecord(property.effects)
      },
      box:
        property.hidden || !property.value
          ? null
          : textBox(
              property.value,
              downNm(property.position),
              property.position.angle,
              property.effects
            )
    })
  }
  out.push({
    id: SYMBOL_ID,
    kind: 'symbol',
    node: symbolNode,
    record: symbolRecord(symbolNode, symbol),
    box: null
  })
  return out
}

/** An item as an agent reads it. */
export const symbolItemRow = (item: SymbolItem): Record<string, unknown> => ({
  id: item.id,
  kind: item.kind,
  ...item.record,
  ...(item.box
    ? {
        box: {
          x: mm(item.box.minX),
          y: mm(item.box.minY),
          width: mm(item.box.maxX - item.box.minX),
          height: mm(item.box.maxY - item.box.minY)
        }
      }
    : {})
})

const nearIds = (wanted: string, ids: string[]): string[] => {
  const needle = wanted.toLowerCase()
  const close = ids.filter((id) => {
    const lower = id.toLowerCase()
    return lower.includes(needle) || needle.includes(lower)
  })
  return (close.length ? close : ids).slice(0, 8)
}

/** Where a pin lives, as `pin@<unit>.<style>.<index>` spells it. */
const pinAddress = (items: SymbolItem[], item: SymbolItem): string => {
  const { unit, style } = item.record as { unit: number; style: number }
  const index = items
    .filter((other) => other.kind === 'pin' && other.record.unit === unit)
    .filter((other) => other.record.style === style)
    .indexOf(item)
  return `pin@${unit}.${style}.${index}`
}

/**
 * Look an id up. Besides the exact id, a pin answers to `pin:<number>@<unit>.<style>`
 * and `pin@<unit>.<style>.<index>` whatever its own id is, so an address the
 * caller built from a record always resolves.
 */
export function resolveSymbolItem(
  items: SymbolItem[],
  id: string
): { ok: true; item: SymbolItem } | SymbolItemFailure {
  const exact = items.find((item) => item.id === id)
  if (exact) return { ok: true, item: exact }
  const pins = items.filter((item) => item.kind === 'pin')
  const address = pins.find((pin) => pinAddress(items, pin) === id)
  if (address) return { ok: true, item: address }
  const wanted = /^pin:(.*)$/.exec(id)?.[1]
  if (wanted !== undefined) {
    const matches = pins.filter(
      (pin) =>
        pin.record.number === wanted ||
        `${pin.record.number as string}@${pin.record.unit as number}.${pin.record.style as number}` ===
          wanted
    )
    if (matches.length === 1) return { ok: true, item: matches[0] }
    if (matches.length > 1) {
      return {
        ok: false,
        error: 'item-not-found',
        detail: `${matches.length} pins are numbered ${wanted}; address one by its id.`,
        candidates: matches.map((pin) => pin.id)
      }
    }
  }
  return {
    ok: false,
    error: 'item-not-found',
    detail: `No item on this symbol has the id "${id}".`,
    candidates: nearIds(
      id,
      items.map((item) => item.id)
    )
  }
}

// --- Queries ------------------------------------------------------------------

export interface SymbolItemQuery {
  kind?: SymbolItemKind
  unit?: number
  number?: string
  /** Millimeters, y down. */
  box?: { x: number; y: number; width: number; height: number }
  near?: { x: number; y: number }
  /** Millimeters around `near`; 1 by default. */
  radius?: number
  limit?: number
  /** Matches to skip before the first row. */
  offset?: number
}

const QUERY_CAP = 400

const touches = (a: Box, b: Box): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY

/**
 * Items matching every filter given. `unit` matches the sub-symbol a part is
 * written in exactly, so `unit: 0` lists the parts common to all units and a
 * field (which belongs to no unit) never matches it.
 */
export function querySymbolItems(
  items: SymbolItem[],
  query: SymbolItemQuery
): QueryPage<SymbolItem> & { matches: SymbolItem[] } {
  const region = query.box
    ? {
        minX: toNm(query.box.x),
        minY: toNm(query.box.y),
        maxX: toNm(query.box.x + query.box.width),
        maxY: toNm(query.box.y + query.box.height)
      }
    : null
  const radius = toNm(query.radius ?? 1)
  const around = query.near
    ? {
        minX: toNm(query.near.x) - radius,
        minY: toNm(query.near.y) - radius,
        maxX: toNm(query.near.x) + radius,
        maxY: toNm(query.near.y) + radius
      }
    : null
  const matched = items.filter(
    (item) =>
      (!query.kind || item.kind === query.kind) &&
      (query.unit === undefined || item.record.unit === query.unit) &&
      (query.number === undefined ||
        (item.kind === 'pin' && item.record.number === query.number)) &&
      (!region || (item.box !== null && touches(item.box, region))) &&
      (!around || (item.box !== null && touches(item.box, around)))
  )
  const limit = Math.max(1, Math.min(query.limit ?? QUERY_DEFAULT_LIMIT, QUERY_CAP))
  return { ...pageOf(matched, query.offset, limit), matches: matched }
}

/** The breakdowns a capped symbol query names: by kind, then by unit. */
export const symbolNarrowings = (
  matches: readonly SymbolItem[],
  query: SymbolItemQuery
): Narrowing[] =>
  narrowingsOf(matches, query.kind !== undefined, [
    {
      arg: 'unit',
      given: query.unit !== undefined,
      tally: (items) =>
        tally(items, (item) =>
          typeof item.record.unit === 'number' ? [String(item.record.unit)] : []
        )
    }
  ])

// --- Record validation ------------------------------------------------------------

const REQUIRED: Record<SymbolItemKind, readonly string[]> = {
  pin: ['number', 'at'],
  polyline: ['points'],
  bezier: ['points'],
  rect: ['start', 'end'],
  circle: ['center', 'radius'],
  arc: ['start', 'mid', 'end'],
  text: ['text', 'at'],
  text_box: ['text', 'start', 'end'],
  field: ['key'],
  symbol: []
}

const invalid = (detail: string): SymbolItemFailure => ({
  ok: false,
  error: 'invalid-record',
  detail
})

/** A record held to what its kind takes and to each key's rule (`shared/recordRules.ts`). */
const validate = (
  kind: SymbolItemKind,
  record: Record<string, unknown>,
  mode: RecordMode
): SymbolItemFailure | null => {
  const failure = checkRecord('symbol', kind, record, mode)
  return failure
    ? { ok: false, error: failure.error as SymbolItemFailure['error'], detail: failure.detail }
    : null
}

/**
 * Another pin of the same unit and body style already carrying `number`. A
 * symbol whose duplicate pin numbers are jumpers ties such pins on purpose.
 */
const duplicatePin = (
  symbolNode: SExprList,
  number: string,
  unit: number,
  style: number,
  except: SExprList | null
): SymbolItemFailure | null => {
  if (parseLibSymbol(symbolNode).duplicatePinNumbersAreJumpers) return null
  const taken = symbolItems(symbolNode).find(
    (item) =>
      item.kind === 'pin' &&
      item.node !== except &&
      item.record.number === number &&
      item.record.unit === unit &&
      item.record.style === style
  )
  return taken
    ? {
        ok: false,
        error: 'refused',
        detail: `${taken.id} already has number ${number} in unit ${unit}, style ${style}; pick another number.`
      }
    : null
}

// --- Writes ---------------------------------------------------------------------

/**
 * Write a validated partial record onto a node through the editor's helpers.
 * `current` is the item's record, for the text box, whose two corners are
 * stored as one corner plus an extent.
 */
const write = (
  kind: SymbolItemKind,
  node: SExprList,
  r: Record<string, unknown>,
  current: Record<string, unknown>
): void => {
  const at = r.at === undefined ? undefined : fileXY(r.at as Point)
  const style: GraphicStylePatch = {
    ...(r.width !== undefined ? { strokeWidth: toNm(r.width as number) } : {}),
    ...(r.strokeType !== undefined ? { strokeType: r.strokeType as string } : {}),
    ...(r.strokeColor !== undefined
      ? { strokeColor: hexColorToRgba(r.strokeColor as string | null) }
      : {}),
    ...(r.fill !== undefined ? { fill: r.fill as string } : {}),
    ...(r.fillColor !== undefined
      ? { fillColor: hexColorToRgba(r.fillColor as string | null) }
      : {})
  }
  const text: TextEffectsPatch & { size?: Nm } = {
    ...(r.bold !== undefined ? { bold: r.bold as boolean } : {}),
    ...(r.italic !== undefined ? { italic: r.italic as boolean } : {}),
    ...(r.justify !== undefined ? { hAlign: r.justify as 'left' | 'center' | 'right' } : {}),
    ...(r.verticalJustify !== undefined
      ? { vAlign: r.verticalJustify as 'top' | 'center' | 'bottom' }
      : {}),
    ...(r.color !== undefined ? { color: hexColorToRgba(r.color as string | null) } : {}),
    ...(r.thickness !== undefined
      ? { thickness: r.thickness === null ? null : toNm(r.thickness as number) }
      : {}),
    ...(r.size !== undefined ? { size: toNm(r.size as number) } : {})
  }
  /** A point key as a patch's `<key>X`/`<key>Y` pair. */
  const corners = (key: string): Record<string, Nm> => {
    if (r[key] === undefined) return {}
    const p = fileXY(r[key] as Point)
    return { [`${key}X`]: p.x, [`${key}Y`]: p.y }
  }
  switch (kind) {
    case 'pin':
      updatePin(node, {
        ...(r.number !== undefined ? { number: r.number as string } : {}),
        ...(r.name !== undefined ? { name: r.name as string } : {}),
        ...(r.type !== undefined ? { electricalType: r.type as string } : {}),
        ...(r.shape !== undefined ? { graphicStyle: r.shape as string } : {}),
        ...(at ? { x: at.x, y: at.y } : {}),
        ...(r.angle !== undefined ? { angle: r.angle as number } : {}),
        ...(r.length !== undefined ? { length: toNm(r.length as number) } : {}),
        ...(r.hidden !== undefined ? { hidden: r.hidden as boolean } : {}),
        ...(r.nameSize !== undefined ? { nameSize: toNm(r.nameSize as number) } : {}),
        ...(r.numberSize !== undefined ? { numberSize: toNm(r.numberSize as number) } : {})
      })
      if (r.alternates !== undefined) {
        // The list is written whole: the record holds every alternate.
        while (pinAlternateNodes(node).length) removePinAlternate(node, 0)
        for (const alternate of r.alternates as Array<Record<string, string | undefined>>) {
          addPinAlternate(node, String(alternate.name).trim(), alternate.type, alternate.shape)
        }
      }
      return
    case 'polyline':
    case 'bezier':
      if (r.points) setPointsChildNm(node, (r.points as Point[]).map(fileXY))
      updatePolyline(node, style)
      return
    case 'rect':
      updateRectangle(node, { ...corners('start'), ...corners('end'), ...style })
      return
    case 'circle':
      updateCircle(node, {
        ...corners('center'),
        ...(r.radius !== undefined ? { radius: toNm(r.radius as number) } : {}),
        ...style
      })
      return
    case 'arc':
      updateArc(node, {
        ...corners('start'),
        ...corners('mid'),
        ...corners('end'),
        ...style
      })
      return
    case 'text':
      updateSymbolText(node, {
        ...(r.text !== undefined ? { text: r.text as string } : {}),
        ...(at ? { x: at.x, y: at.y } : {}),
        ...(r.angle !== undefined ? { angle: r.angle as number } : {}),
        ...text
      })
      return
    case 'text_box': {
      const moved = r.start !== undefined || r.end !== undefined
      const start = fileXY((r.start ?? current.start) as Point)
      const end = fileXY((r.end ?? current.end) as Point)
      const box = moved
        ? {
            x: start.x,
            y: start.y,
            width: (end.x - start.x) as Nm,
            height: (end.y - start.y) as Nm
          }
        : {}
      const margins = r.margins as Partial<Record<'left' | 'top' | 'right' | 'bottom', number>>
      const margin = (side: 'left' | 'top' | 'right' | 'bottom'): Nm | undefined =>
        margins?.[side] === undefined ? undefined : toNm(margins[side])
      updateSymbolTextBox(node, {
        ...(r.text !== undefined ? { text: r.text as string } : {}),
        ...box,
        ...(r.angle !== undefined ? { angle: r.angle as number } : {}),
        ...(margins
          ? {
              marginLeft: margin('left'),
              marginTop: margin('top'),
              marginRight: margin('right'),
              marginBottom: margin('bottom')
            }
          : {}),
        ...text,
        ...style
      })
      return
    }
    case 'field':
      updateSymbolProperty(node, {
        ...(r.value !== undefined ? { value: r.value as string } : {}),
        ...(at ? { x: at.x, y: at.y } : {}),
        ...(r.angle !== undefined ? { angle: r.angle as number } : {}),
        ...(r.hidden !== undefined ? { visible: !(r.hidden as boolean) } : {}),
        ...(r.showName !== undefined ? { showName: r.showName as boolean } : {}),
        ...(r.doNotAutoplace !== undefined ? { doNotAutoplace: r.doNotAutoplace as boolean } : {}),
        ...(r.private !== undefined ? { private: r.private as boolean } : {}),
        ...text
      })
      return
    case 'symbol':
      writeSymbol(node, r)
  }
}

/** A field written on the definition, created hidden as KiCad keeps its data fields. */
const setDataField = (symbolNode: SExprList, key: string, value: string): void => {
  const existed = symbolPropertyNode(symbolNode, key) !== null
  if (!existed && !value) return
  setSymbolProperty(symbolNode, key, value)
  const created = existed ? null : symbolPropertyNode(symbolNode, key)
  if (created) setSymbolPropertyVisible(created, false)
}

const FLAG_TOKENS = {
  inBom: 'in_bom',
  onBoard: 'on_board',
  inPositionFiles: 'in_pos_files',
  excludeFromSim: 'exclude_from_sim',
  duplicatePinNumbersAreJumpers: 'duplicate_pin_numbers_are_jumpers'
} as const

/** Symbol Properties, through the writers the editor's panel uses. */
const writeSymbol = (symbolNode: SExprList, r: Record<string, unknown>): void => {
  if (r.name !== undefined) renameSymbol(symbolNode, (r.name as string).trim())
  if (r.power !== undefined) setSymbolPowerKind(symbolNode, r.power as SymbolPowerKind)
  for (const [key, token] of Object.entries(FLAG_TOKENS)) {
    if (r[key] !== undefined) setSymbolFlag(symbolNode, token, r[key] as boolean)
  }
  setSymbolPinDisplay(symbolNode, {
    ...(r.showPinNames !== undefined ? { namesHidden: !(r.showPinNames as boolean) } : {}),
    ...(r.showPinNumbers !== undefined ? { numbersHidden: !(r.showPinNumbers as boolean) } : {}),
    ...(r.pinNameOffset !== undefined ? { nameOffset: toNm(r.pinNameOffset as number) } : {})
  })
  if (r.description !== undefined) {
    // An older file's `ki_description` stays its home until the file has a Description field.
    const key =
      !symbolPropertyNode(symbolNode, 'Description') &&
      symbolPropertyNode(symbolNode, 'ki_description')
        ? 'ki_description'
        : 'Description'
    setDataField(symbolNode, key, r.description as string)
  }
  if (r.keywords !== undefined) setDataField(symbolNode, 'ki_keywords', r.keywords as string)
  if (r.datasheet !== undefined) setDataField(symbolNode, 'Datasheet', r.datasheet as string)
  if (r.footprintFilters !== undefined)
    setSymbolFootprintFilters(symbolNode, (r.footprintFilters as string[]).join(' '))
  if (r.units !== undefined) {
    const units = r.units as number
    const had = symbolUnitCount(symbolNode)
    for (let unit = had; unit > units; unit--) removeUnit(symbolNode, unit)
    for (let unit = had + 1; unit <= units; unit++) getOrCreateUnitNode(symbolNode, unit, 1)
  }
  if (r.unitNames !== undefined) {
    ;(r.unitNames as string[]).forEach((name, index) =>
      setSymbolUnitName(symbolNode, index + 1, name)
    )
  }
  if (r.unitsInterchangeable !== undefined)
    setSymbolUnitsInterchangeable(symbolNode, r.unitsInterchangeable as boolean)
}

const without = (record: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))

/** Write a partial record onto one item. */
export function updateSymbolItem(
  symbolNode: SExprList,
  item: SymbolItem,
  record: Record<string, unknown>
): { ok: true } | SymbolItemFailure {
  const blocked = Object.keys(record).filter((key) =>
    SYMBOL_READ_ONLY_KEYS[item.kind]?.includes(key)
  )
  if (blocked.length) {
    return {
      ok: false,
      error: 'not-applicable',
      detail: `A ${item.kind}'s ${blocked.join(', ')} cannot be changed.`
    }
  }
  const failure = validate(item.kind, record, 'update')
  if (failure) return failure
  if (!Object.values(record).some((value) => value !== undefined)) {
    return invalid('The record changes nothing.')
  }
  const refusal =
    item.kind === 'symbol'
      ? symbolRefusal(symbolNode, record)
      : item.kind === 'field'
        ? fieldRenameRefusal(symbolNode, item, record)
        : placedInRefusal(symbolNode, item, record)
  if (refusal) return refusal
  markNodeDirty(symbolNode)
  if (record.unit !== undefined || record.style !== undefined) {
    movePartToUnit(
      symbolNode,
      item.node,
      (record.unit as number | undefined) ?? (item.record.unit as number),
      (record.style as number | undefined) ?? (item.record.style as number)
    )
  }
  if (item.kind === 'field' && record.key !== undefined && record.key !== item.record.key) {
    renameSymbolProperty(symbolNode, item.record.key as string, (record.key as string).trim())
  }
  write(item.kind, item.node, without(record, ['unit', 'style', 'key']), item.record)
  return { ok: true }
}

/** Why a unit and style a part would move to (or its new number) is refused, or null. */
const placedInRefusal = (
  symbolNode: SExprList,
  item: SymbolItem,
  record: Record<string, unknown>
): SymbolItemFailure | null => {
  const unit = (record.unit as number | undefined) ?? (item.record.unit as number)
  const style = (record.style as number | undefined) ?? (item.record.style as number)
  const range = unitStyleRefusal(symbolNode, unit, style)
  if (range) return range
  const number = (record.number as string | undefined) ?? (item.record.number as string)
  const moved =
    unit !== item.record.unit || style !== item.record.style || number !== item.record.number
  return item.kind === 'pin' && moved
    ? duplicatePin(symbolNode, number, unit, style, item.node)
    : null
}

/** Why a field's new key is refused, or null. */
const fieldRenameRefusal = (
  symbolNode: SExprList,
  item: SymbolItem,
  record: Record<string, unknown>
): SymbolItemFailure | null => {
  const from = item.record.key as string
  const to = (record.key as string | undefined)?.trim()
  if (to === undefined || to === from) return null
  if (isMandatoryField(from) || isMandatoryField(to)) {
    return {
      ok: false,
      error: 'refused',
      detail: `${MANDATORY_FIELD_KEYS.join(', ')} keep their names; create a field with the new key instead.`
    }
  }
  if (!isUserField(to)) {
    return {
      ok: false,
      error: 'not-applicable',
      detail: `${to} is symbol metadata, not a field; pick a key without the ki_ prefix.`
    }
  }
  return symbolPropertyNode(symbolNode, to)
    ? { ok: false, error: 'refused', detail: `The symbol already has a ${to} field.` }
    : null
}

/** Why a Symbol Properties record is refused, or null. */
const symbolRefusal = (
  symbolNode: SExprList,
  record: Record<string, unknown>
): SymbolItemFailure | null => {
  if (record.unitNames === undefined) return null
  const units = (record.units as number | undefined) ?? symbolUnitCount(symbolNode)
  const names = record.unitNames as string[]
  return names.length === units
    ? null
    : invalid(`symbol.unitNames must hold one name per unit: ${units}, not ${names.length}.`)
}

/** Why a unit or body style is out of reach, or null: one past the last adds it. */
const unitStyleRefusal = (
  symbolNode: SExprList,
  unit: number,
  style: number
): SymbolItemFailure | null => {
  const units = symbolUnitCount(symbolNode)
  if (unit > units + 1) {
    return {
      ok: false,
      error: 'refused',
      detail: `The symbol has ${units} unit${units === 1 ? '' : 's'}; use unit 0–${units}, or ${units + 1} to add one.`
    }
  }
  const styles = symbolBodyStyleCount(symbolNode)
  if (style > styles + 1) {
    return {
      ok: false,
      error: 'refused',
      detail: `The symbol has ${styles} body style${styles === 1 ? '' : 's'}; use style 0–${styles}, or ${styles + 1} to add one.`
    }
  }
  return null
}

/** The name sub-symbols are written under: a schematic copy's `Lib:Name` loses its `Lib:`. */
const bareName = (symbolNode: SExprList): string => {
  const name = getFirstAtomValue(symbolNode) ?? ''
  return name.slice(name.indexOf(':') + 1)
}

/**
 * Add a part with one of `symbolEdit`'s adders, then make sure it sits in the
 * `(unit, style)` sub-symbol. The adders write to `<name>_<unit>_1`, which is
 * wrong twice over for this layer: they know no body style, and a schematic's
 * `lib_symbols` copy names its sub-symbols after the bare symbol (`R_1_1`
 * under `Device:R`), which KiCad's parser requires. So the part is moved into
 * the sub-symbol found by suffix (or one created under the bare name), and a
 * sub-symbol the adder made only to hold it is dropped again.
 */
const addInUnit = (
  symbolNode: SExprList,
  unit: number,
  style: number,
  add: (unit: number) => SExprList
): SExprList => {
  const before = new Set(findChildren(symbolNode, 'symbol'))
  const node = add(unit)
  const holder = findChildren(symbolNode, 'symbol').find((sub) => sub.children.includes(node))
  if (!holder) return node
  const wantedName = `${bareName(symbolNode)}_${unit}_${style}`
  let target = [...before].find((sub) => {
    const suffix = parseVariantSuffix(getFirstAtomValue(sub) ?? '')
    return suffix?.unit === unit && suffix.style === style
  })
  if (!target && getFirstAtomValue(holder) === wantedName) target = holder
  if (!target) {
    const at = symbolNode.start
    target = makeList([makeAtom('symbol', false, at), makeAtom(wantedName, true, at)], at)
    symbolNode.children.push(target)
  }
  if (target === holder) return node
  holder.children = holder.children.filter((child) => child !== node)
  target.children.push(node)
  if (!before.has(holder) && holder.children.length <= 2) {
    symbolNode.children = symbolNode.children.filter((child) => child !== holder)
  }
  return node
}

/** Add one item; answers with the id it has in a fresh `symbolItems` read. */
export function createSymbolItem(
  symbolNode: SExprList,
  kind: SymbolItemKind,
  record: Record<string, unknown>
): { ok: true; id: string } | SymbolItemFailure {
  if (kind === 'symbol') {
    return {
      ok: false,
      error: 'not-applicable',
      detail: 'The definition is not an item to add; symbol_create makes a symbol.'
    }
  }
  const failure = validate(kind, record, 'create')
  if (failure) return failure
  const missing = REQUIRED[kind].filter((key) => record[key] === undefined)
  if (missing.length) return invalid(`A new ${kind} needs ${missing.join(', ')}.`)
  const r = record

  if (kind === 'field') {
    const key = (r.key as string).trim()
    if (!isUserField(key)) {
      return {
        ok: false,
        error: 'not-applicable',
        detail: `${key} is symbol metadata, not a field; pick a key without the ki_ prefix.`
      }
    }
    if (symbolPropertyNode(symbolNode, key)) {
      return {
        ok: false,
        error: 'refused',
        detail: `The symbol already has a ${key} field; update field:${key} instead.`
      }
    }
    markNodeDirty(symbolNode)
    addSymbolProperty(symbolNode, key, (r.value as string | undefined) ?? '')
    const node = symbolPropertyNode(symbolNode, key)
    const rest = without(r, ['key', 'value'])
    if (node && Object.keys(rest).length) write('field', node, rest, {})
    return { ok: true, id: `field:${key}` }
  }

  const unit = (r.unit as number | undefined) ?? 1
  const style = (r.style as number | undefined) ?? 1
  const range = unitStyleRefusal(symbolNode, unit, style)
  if (range) return range
  if (kind === 'pin') {
    const taken = duplicatePin(symbolNode, r.number as string, unit, style, null)
    if (taken) return taken
  }

  markNodeDirty(symbolNode)
  const point = (key: string): { x: Nm; y: Nm } => fileXY(r[key] as Point)
  const points = (): Array<{ x: Nm; y: Nm }> => (r.points as Point[]).map(fileXY)
  const angle = (r.angle as number | undefined) ?? 0
  const node = addInUnit(symbolNode, unit, style, (u) => {
    switch (kind) {
      case 'pin':
        return addPin(
          symbolNode,
          {
            name: (r.name as string | undefined) ?? '',
            number: r.number as string,
            ...point('at'),
            angle,
            length: toNm((r.length as number | undefined) ?? 2.54),
            electricalType: (r.type as string | undefined) ?? 'passive',
            graphicStyle: (r.shape as string | undefined) ?? 'line'
          },
          u
        )
      case 'polyline':
        return addPolyline(symbolNode, points(), u)
      case 'bezier':
        return addBezier(symbolNode, points(), u)
      case 'rect':
        return addRectangle(symbolNode, point('start'), point('end'), u)
      case 'circle':
        return addCircle(symbolNode, point('center'), toNm(r.radius as number), u)
      case 'arc':
        return addArc(symbolNode, point('start'), point('mid'), point('end'), u)
      case 'text':
        return addText(symbolNode, r.text as string, { ...point('at'), angle }, u)
      case 'text_box':
      default: {
        const start = point('start')
        const end = point('end')
        return addTextBox(
          symbolNode,
          r.text as string,
          { ...start, angle },
          { width: (end.x - start.x) as Nm, height: (end.y - start.y) as Nm },
          u
        )
      }
    }
  })
  // The adders take geometry only; styling (width, fill, sizes, hidden) goes on
  // through the same writer an update uses.
  const rest = without(r, ['unit', 'style'])
  write(kind, node, rest, rest)
  const created = symbolItems(symbolNode).find((item) => item.node === node)
  return { ok: true, id: created?.id ?? `${kind}:${unit}.${style}` }
}

/** Remove items. Refuses the whole call before removing any. */
export function deleteSymbolItems(
  symbolNode: SExprList,
  items: SymbolItem[]
): { ok: true } | SymbolItemFailure {
  if (items.some((item) => item.kind === 'symbol')) {
    return {
      ok: false,
      error: 'not-applicable',
      detail:
        'The definition is not an item to delete; symbol_delete removes it, and a lower symbol.units drops units.'
    }
  }
  const kept = items.filter(
    (item) => item.kind === 'field' && isMandatoryField(item.record.key as string)
  )
  if (kept.length) {
    return {
      ok: false,
      error: 'refused',
      detail: `Every symbol keeps ${MANDATORY_FIELD_KEYS.join(', ')}; set hidden instead (${kept
        .map((item) => item.id)
        .join(', ')}).`
    }
  }
  markNodeDirty(symbolNode)
  for (const item of items) {
    if (item.kind === 'pin') deletePin(symbolNode, item.node)
    else if (item.kind === 'field') removeSymbolProperty(symbolNode, item.record.key as string)
    else deleteGraphic(symbolNode, item.node)
  }
  return { ok: true }
}
