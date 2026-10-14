// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * The item layer an agent reads a sheet through: every item as one record
 * with an id and a bounding box, and a query over them.
 *
 * `describe` is the compact summary — what is placed, what is on which net,
 * what is open. This is the detail: where a thing is, how much of the sheet it
 * covers, where each of its pins is and which way is free. A layout script
 * plans from these records and never has to parse the file or guess the
 * placement transform. Ids follow `docs/agent-api.md`: a
 * symbol is its reference, a pin is `<reference>.<number>`, a field is
 * `<reference>#<name>`, and everything else is its KiCad uuid, or a positional
 * `<kind>@x,y` for a node that carries none.
 *
 * Every function here is data in, data out, so the projection is tested
 * without the editor (`__tests__/schematicItems.test.ts`).
 */
import { mmToNm, nm, nmToMm, type Nm } from '../kicad/coordinates'
import {
  referenceForSheetPath,
  getSheetProperty,
  setSchematicFieldsAutoplaced,
  setSchematicPropertyJustify,
  setSchematicPropertyPlacement,
  resolveSymbolGeometry,
  type KicadLabel,
  type KicadSchematic,
  type KicadSchematicPoint,
  type KicadSchematicSymbol,
  type KicadSchematicText,
  type KicadSheet,
  type KicadSheetPin,
  SHEET_PIN_ANGLE,
  sheetSideOf,
  type SheetSide,
  type KicadTextEffects,
  type KicadWire,
  type Point,
  type SchematicProperty
} from '../kicad/schematic'
import { placedPinPosition, placedPoint, type SchematicConnectivity } from './connectivity'
// KiCad's KeepUpright fold, which decides whether a text is drawn along the
// sheet or up it. It lives with the renderer because that is where it was
// first needed; it is file semantics, and importing it keeps one copy of the
// rule rather than a second that can drift from what is drawn.
import {
  schematicFieldDrawn,
  schematicFieldTextAngle,
  type SymbolFrame
} from '../engine/schematicTextOrientation'
import { graphicPoints, junctionsForNewWire } from './schematicTools'
import { directionOf, type Direction } from './wireReshape'
import { KICAD_DEFAULT_LINE_WIDTH, measureTextWidth } from '../kicad/newstroke'
import {
  narrowingsOf,
  pageOf,
  QUERY_DEFAULT_LIMIT,
  tally,
  type Narrowing,
  type QueryPage
} from '../queryPage'
import {
  addressablePins,
  asMm,
  labelAngleForPin,
  partPropertyMap,
  pinRefOf,
  resolvePinRef,
  symbolValue,
  type AddressablePin,
  type Box
} from './schematicAgent'
import { unitItemId, type SubpartSettings } from './symbolUnits'
import {
  graphicItemId,
  graphicItems,
  graphicView,
  textStyleRecord,
  wireStrokeRecord,
  type GraphicItem,
  type GraphicKind
} from './sheetGraphicItems'
import {
  SHEET_ITEM_KINDS as ITEM_KINDS,
  SHEET_UPDATE_KEYS as SHEET_RECORD_KEYS,
  type SheetItemKind as ItemKind
} from '../../../../shared/itemRecords'

export { ITEM_KINDS, SHEET_RECORD_KEYS, type ItemKind }

/** A box in the millimetres an agent reads, as `render.schematic` reports a frame. */
export interface MmFrame {
  x: number
  y: number
  width: number
  height: number
}

/** Which way a label's text occupies the sheet from its anchor, or which side
 *  of a pin is free — the words a layout script reasons in. */
export type { Direction } from './wireReshape'

export interface SheetItem {
  id: string
  kind: ItemKind
  /** Anchor in nm: a symbol's origin, a label's anchor, a wire's first point. */
  at: Point
  /** Degrees, on the kinds that turn. */
  angle?: number
  /** Extent in nm. A junction's is its point. */
  box: Box
  /** Net name where the item lies on one; symbols list nets per pin instead. */
  net?: string
  /** The one-line row `query` answers with. */
  brief: Record<string, unknown>
  /** The full record `get` answers with. */
  record: () => Record<string, unknown>
}

export interface ItemsInput {
  schematic: KicadSchematic
  connectivity: SchematicConnectivity | null
  sheetPath: string
  /** How a unit is written after its reference; KiCad's default when absent. */
  subpart?: SubpartSettings
}

const KEEP_UPRIGHT_VERTICAL = (angle: number): boolean => {
  const folded = ((angle % 360) + 360) % 360
  return folded === 90 || folded === 270
}

/** KiCad's gap between a label's anchor and its glyphs, as a fraction of the
 *  text size: `DEFAULT_TEXT_OFFSET_RATIO` in `eeschema/default_values.h`. */
export const TEXT_OFFSET_RATIO = 0.15

const frameOf = (box: Box): MmFrame => ({
  x: asMm(box.minX as Nm),
  y: asMm(box.minY as Nm),
  width: asMm((box.maxX - box.minX) as Nm),
  height: asMm((box.maxY - box.minY) as Nm)
})

const mm = (point: Point): { x: number; y: number } => ({ x: asMm(point.x), y: asMm(point.y) })

const pointBox = (point: Point): Box => ({
  minX: point.x,
  minY: point.y,
  maxX: point.x,
  maxY: point.y
})

const boxOfPoints = (points: readonly { x: number; y: number }[]): Box => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return points.length ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
}

const boxesIntersect = (a: Box, b: Box): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY

/** Distance from a point to a box, zero inside it. */
const boxDistance = (box: Box, point: Point): number => {
  const dx = Math.max(box.minX - point.x, 0, point.x - box.maxX)
  const dy = Math.max(box.minY - point.y, 0, point.y - box.maxY)
  return Math.hypot(dx, dy)
}

/** Advance width and height of one line of text, in nm, from the stroke font
 *  the renderer draws with, so the box is the box the eye sees. */
const textExtent = (text: string, effects: KicadTextEffects): { w: number; h: number } => {
  const height = nmToMm(effects.fontSize.height)
  const width = nmToMm(effects.fontSize.width) || height
  const widthMm = measureTextWidth(text, {
    width,
    height,
    thickness: effects.thickness ? nmToMm(effects.thickness) : KICAD_DEFAULT_LINE_WIDTH,
    bold: effects.bold,
    italic: effects.italic
  })
  return { w: mmToNm(widthMm), h: effects.fontSize.height }
}

/**
 * Where a label's text sits, and which way it runs from the anchor.
 *
 * KiCad folds a label's angle with `KeepUpright` before drawing — 180° reads as
 * 0°, 270° as 90° — so text never reads leftward or downward, and only the
 * justification says which side of the anchor it occupies.
 * Horizontal text sits above its anchor line, vertical text to the left of it.
 */
export const labelExtent = (
  label: Pick<KicadLabel, 'text' | 'position' | 'effects'>
): { box: Box; extends: Direction } => {
  const { w, h } = textExtent(label.text, label.effects)
  const offset = Math.round(label.effects.fontSize.height * TEXT_OFFSET_RATIO)
  const { x, y } = label.position
  const away = label.effects.horizontalAlign === 'right'
  if (KEEP_UPRIGHT_VERTICAL(label.position.angle)) {
    return {
      box: away
        ? { minX: x - offset - h, maxX: x - offset, minY: y + offset, maxY: y + offset + w }
        : { minX: x - offset - h, maxX: x - offset, minY: y - offset - w, maxY: y - offset },
      extends: away ? 'down' : 'up'
    }
  }
  return {
    box: away
      ? { minX: x - offset - w, maxX: x - offset, minY: y - offset - h, maxY: y - offset }
      : { minX: x + offset, maxX: x + offset + w, minY: y - offset - h, maxY: y - offset },
    extends: away ? 'left' : 'right'
  }
}

/**
 * Where a field's text sits, from its own anchor and justification.
 *
 * `frame` is the turn and mirror of the symbol the field belongs to, because
 * KiCad stores a field's angle and justification **in the symbol's frame**
 * (`schematicFieldDrawn`): a horizontal value on a symbol turned 90° carries
 * `angle 90` in the file, and its `justify right` runs rightward. Omit it for
 * a text that belongs to the sheet rather than to a symbol, which is already
 * sheet-space.
 */
export const fieldExtent = (
  property: Pick<SchematicProperty, 'value' | 'position' | 'effects'>,
  frame: SymbolFrame = { angle: 0 }
): Box => {
  const { w, h } = textExtent(property.value, property.effects)
  const { x, y } = property.position
  const drawn = schematicFieldDrawn(
    property.position.angle,
    property.effects.horizontalAlign,
    property.effects.verticalAlign,
    frame
  )
  const { horizontal: horizontalAlign, vertical: verticalAlign } = drawn
  const drawnVertical = drawn.angle === 90
  const along = (
    anchor: number,
    length: number,
    align: 'left' | 'center' | 'right'
  ): [number, number] =>
    align === 'left'
      ? [anchor, anchor + length]
      : align === 'right'
        ? [anchor - length, anchor]
        : [anchor - length / 2, anchor + length / 2]
  if (drawnVertical) {
    // Rotated a quarter turn counter-clockwise: the line of text runs up the
    // sheet, its top faces left. "left" alignment therefore starts at the
    // anchor and runs upward; "top" alignment hangs the glyphs rightward.
    const [minY, maxY] = along(
      y,
      w,
      horizontalAlign === 'left' ? 'right' : horizontalAlign === 'right' ? 'left' : 'center'
    )
    const [minX, maxX] = along(
      x,
      h,
      verticalAlign === 'top' ? 'left' : verticalAlign === 'bottom' ? 'right' : 'center'
    )
    return { minX, minY, maxX, maxY }
  }
  const [minX, maxX] = along(x, w, horizontalAlign)
  const [minY, maxY] = along(
    y,
    h,
    verticalAlign === 'top' ? 'left' : verticalAlign === 'bottom' ? 'right' : 'center'
  )
  return { minX, minY, maxX, maxY }
}

/**
 * The file's symbol-relative field angle for a **drawn** angle in sheet space:
 * the inverse of the fold `fieldExtent` and the renderer read through. What an
 * agent asks for ("lay this field along the sheet") is what it gets on a
 * symbol turned any way, and reading the field back returns what was written.
 */
export const fieldAngleForSheetAngle = (sheetAngle: number, symbolAngle: number): number =>
  (((sheetAngle + symbolAngle) % 360) + 360) % 360

const positionalId = (kind: ItemKind, point: Point): string =>
  `${kind}@${asMm(point.x)},${asMm(point.y)}`

const ORIGIN: Point = { x: 0 as Nm, y: 0 as Nm }

/** One id rule per kind, shared by the list and the resolver. */
const labelId = (label: KicadLabel, index: number): string =>
  label.uuid ?? `${positionalId('label', label.position)}#${index}`
export const wireId = (wire: KicadWire, index: number): string =>
  wire.uuid ?? `${positionalId('wire', wire.points[0] ?? ORIGIN)}#${index}`
/** A no-connect flag has no uuid an id could use; it is addressed by where it sits. */
export const noConnectId = (flag: Point): string => positionalId('no_connect', flag)
export const textId = (text: KicadSchematicText, index: number): string =>
  text.uuid ?? `${positionalId('text', text.position)}#${index}`
export const sheetId = (sheet: KicadSheet, index: number): string =>
  sheet.uuid ?? `${positionalId('sheet', sheet.position)}#${index}`
const fieldId = (reference: string, key: string): string => `${reference}#${key}`

/**
 * A field as its symbol's record lists it. A hidden field has no box: it is
 * not drawn, so it is not among the items a query matches, but its id is
 * listed here and `getItems` answers it.
 */
const fieldEntry = (
  reference: string,
  symbol: KicadSchematicSymbol,
  property: SchematicProperty
): Record<string, unknown> => ({
  id: fieldId(reference, property.key),
  name: property.key,
  value: property.value,
  // The DRAWN angle, in sheet space: 0 reads left-to-right on the sheet
  // whatever the symbol's turn. The file's symbol-relative value is converted
  // here and back again on write, so the angle an agent reads is the angle it
  // can write.
  at: mm(property.position),
  angle: schematicFieldTextAngle(property.position.angle, symbol.position.angle),
  ...(property.hidden
    ? { hidden: true }
    : {
        box: frameOf(fieldExtent(property, { angle: symbol.position.angle, mirror: symbol.mirror }))
      })
})

/** A field's own record, as `getItems` answers it: the entry, and whose it is. */
const fieldRecord = (
  reference: string,
  symbol: KicadSchematicSymbol,
  property: SchematicProperty
): Record<string, unknown> => {
  const { id, ...entry } = fieldEntry(reference, symbol, property)
  return { id, kind: 'field', reference, ...entry }
}

/** Every addressable item on the sheet, in file order within each kind. */
export function sheetItems(input: ItemsInput): SheetItem[] {
  const { schematic, connectivity, sheetPath } = input
  const items: SheetItem[] = []

  // Net per pin id, once, rather than a lookup per pin through the graph.
  const netOfPin = new Map<string, string>()
  for (const net of connectivity?.nets ?? []) {
    // A pin alone on a net with nothing else on it is not "on a net" in any
    // sense an agent wants; null says unconnected more plainly than a
    // generated name would.
    const alone = net.pins.length === 1 && !net.wires.length && !net.labels.length
    if (alone) continue
    for (const pin of net.pins) {
      netOfPin.set(pinRefOf({ reference: pin.reference, number: pin.pin.number }), net.name)
    }
  }
  const netAt = (point: Point): string | undefined => connectivity?.netAt(sheetPath, point)?.name

  const pins = addressablePins(schematic, sheetPath)

  // What sits on each connection point, by id — so a pin row can say which
  // label, flag, wire end or junction is on it. A query by nearness matches a
  // label's text box, which reaches back toward a pin it is not on; this is
  // the exact answer, read from the symbol the agent already asked for.
  const pointKey = (point: Point): string => `${point.x},${point.y}`
  const attachedAt = new Map<string, string[]>()
  const attach = (point: Point, id: string): void => {
    const key = pointKey(point)
    const list = attachedAt.get(key)
    if (list) list.push(id)
    else attachedAt.set(key, [id])
  }
  schematic.labels.forEach((label, index) => attach(label.position, labelId(label, index)))
  schematic.wires.forEach((wire, index) => {
    const id = wireId(wire, index)
    const ends = [wire.points[0], wire.points[wire.points.length - 1]].filter(
      (point): point is Point => point !== undefined
    )
    for (const end of ends) attach(end, id)
  })
  for (const junction of schematic.junctions) attach(junction, positionalId('junction', junction))
  for (const flag of schematic.noConnects) attach(flag, noConnectId(flag))

  const fieldIds = new Set<string>()
  for (const symbol of schematic.symbols) {
    const reference = referenceForSheetPath(symbol, sheetPath)
    if (!reference) continue
    const box = symbolBox(schematic, symbol)
    // A unit of a multi-unit part is its own item, `U5A`; its pins and
    // fields keep the part's reference.
    const symbolId = unitItemId(schematic, symbol, reference, input.subpart)
    items.push({
      id: symbolId,
      kind: 'symbol',
      at: symbol.position,
      angle: symbol.position.angle,
      box,
      brief: { reference, libId: symbol.libId, value: symbolValue(symbol) },
      record: () => ({
        id: symbolId,
        kind: 'symbol',
        reference,
        libId: symbol.libId,
        value: symbolValue(symbol),
        unit: symbol.unit,
        at: mm(symbol.position),
        angle: symbol.position.angle,
        ...(symbol.mirror ? { mirror: symbol.mirror } : {}),
        ...(symbol.dnp ? { dnp: true } : {}),
        ...(symbol.inBom ? {} : { inBom: false }),
        ...(symbol.onBoard ? {} : { onBoard: false }),
        box: frameOf(box),
        fields: symbol.properties
          .filter((property) => !property.key.startsWith('ki_'))
          .map((property) => fieldEntry(reference, symbol, property)),
        properties: partPropertyMap(symbol),
        pins: pins
          .filter((pin) => pin.symbol === symbol)
          .map((pin) => {
            const id = pinRefOf(pin)
            const attached = attachedAt.get(pointKey(pin.position))
            return {
              id,
              number: pin.number,
              name: pin.name,
              type: pin.electricalType,
              at: mm(pin.position),
              free: directionOf(pin.labelAngle),
              net: netOfPin.get(id) ?? null,
              ...(attached?.length ? { attached } : {})
            }
          })
      })
    })
    for (const property of symbol.properties) {
      if (property.hidden || property.key.startsWith('ki_') || !property.value) continue
      const fieldBox = fieldExtent(property, {
        angle: symbol.position.angle,
        mirror: symbol.mirror
      })
      const id = fieldId(reference, property.key)
      // Every unit carries the part's fields; the first one drawn answers for them.
      if (fieldIds.has(id)) continue
      fieldIds.add(id)
      items.push({
        id,
        kind: 'field',
        at: property.position,
        angle: schematicFieldTextAngle(property.position.angle, symbol.position.angle),
        box: fieldBox,
        brief: { reference, name: property.key, value: property.value },
        record: () => fieldRecord(reference, symbol, property)
      })
    }
  }

  schematic.labels.forEach((label, index) => {
    const id = labelId(label, index)
    const { box, extends: runs } = labelExtent(label)
    const labelKind =
      label.type === 'global_label'
        ? 'global'
        : label.type === 'hierarchical_label'
          ? 'hierarchical'
          : 'local'
    const net = netAt(label.position)
    items.push({
      id,
      kind: 'label',
      at: label.position,
      angle: label.position.angle,
      box,
      net,
      brief: { text: label.text, labelKind },
      record: () => {
        // A label's justification follows its angle, so it is not a key of its own.
        const { size, bold, italic, color } = textStyleRecord(label.effects)
        return {
          id,
          kind: 'label',
          labelKind,
          text: label.text,
          at: mm(label.position),
          angle: label.position.angle,
          ...(label.type === 'label' ? {} : { shape: label.shape ?? 'input' }),
          extends: runs,
          box: frameOf(box),
          net: net ?? null,
          size,
          bold,
          italic,
          color
        }
      }
    })
  })

  schematic.wires.forEach((wire, index) => {
    const id = wireId(wire, index)
    const box = boxOfPoints(wire.points)
    const net = connectivity?.netOfWire(sheetPath, index)?.name
    items.push({
      id,
      kind: 'wire',
      at: wire.points[0] ?? ORIGIN,
      box,
      net,
      brief: { points: wire.points.map(mm) },
      record: () => ({
        id,
        kind: 'wire',
        points: wire.points.map(mm),
        box: frameOf(box),
        net: net ?? null,
        ...wireStrokeRecord(wire)
      })
    })
  })

  for (const junction of schematic.junctions) {
    const id = positionalId('junction', junction)
    const net = netAt(junction)
    items.push({
      id,
      kind: 'junction',
      at: junction,
      box: pointBox(junction),
      net,
      brief: {},
      record: () => ({ id, kind: 'junction', at: mm(junction), net: net ?? null })
    })
  }

  for (const flag of schematic.noConnects) {
    const id = noConnectId(flag)
    const under = pins.find((pin) => pin.position.x === flag.x && pin.position.y === flag.y)
    items.push({
      id,
      kind: 'no_connect',
      at: flag,
      box: pointBox(flag),
      brief: { pin: under ? pinRefOf(under) : null },
      record: () => ({ id, kind: 'no_connect', at: mm(flag), pin: under ? pinRefOf(under) : null })
    })
  }

  schematic.texts.forEach((text, index) => {
    const id = textId(text, index)
    const box = fieldExtent({ value: text.text, position: text.position, effects: text.effects })
    items.push({
      id,
      kind: 'text',
      at: text.position,
      angle: text.position.angle,
      box,
      brief: { text: text.text },
      record: () => ({
        id,
        kind: 'text',
        text: text.text,
        at: mm(text.position),
        angle: text.position.angle,
        box: frameOf(box),
        ...textStyleRecord(text.effects)
      })
    })
  })

  for (const graphic of graphicItems(schematic)) {
    items.push({
      id: graphicItemId(graphic),
      kind: graphic.kind,
      ...graphicView(graphic, { schematic, connectivity, sheetPath })
    })
  }

  schematic.sheets.forEach((sheet, index) => {
    const id = sheetId(sheet, index)
    const box: Box = {
      minX: sheet.position.x,
      minY: sheet.position.y,
      maxX: sheet.position.x + sheet.size.width,
      maxY: sheet.position.y + sheet.size.height
    }
    const field = (key: string): string => getSheetProperty(sheet, key) ?? ''
    items.push({
      id,
      kind: 'sheet',
      at: sheet.position,
      box,
      brief: { name: field('Sheetname'), file: field('Sheetfile') },
      record: () => ({
        id,
        kind: 'sheet',
        name: field('Sheetname'),
        file: field('Sheetfile'),
        at: mm(sheet.position),
        size: { width: asMm(sheet.size.width), height: asMm(sheet.size.height) },
        box: frameOf(box),
        pins: sheet.pins.map((pin) => ({
          id: `${id}#${pin.name}`,
          name: pin.name,
          type: pin.electricalType,
          side: sheetSideOf(sheet, pin.position),
          at: mm(pin.position)
        }))
      })
    })
    // A pin is addressable in its own right: an agent that got a name or a side
    // wrong has to be able to fix that one pin, not delete the block.
    for (const pin of sheet.pins) {
      const pinId = `${id}#${pin.name}`
      const side = sheetSideOf(sheet, pin.position)
      items.push({
        id: pinId,
        kind: 'sheet_pin',
        at: pin.position,
        box: labelExtent({
          text: pin.name,
          position: pin.position,
          effects: pin.effects
        }).box,
        net: netAt(pin.position),
        brief: { ofSheet: id, name: pin.name, shape: pin.electricalType, side },
        record: () => ({
          id: pinId,
          kind: 'sheet_pin',
          ofSheet: id,
          name: pin.name,
          shape: pin.electricalType,
          side,
          at: mm(pin.position),
          net: netAt(pin.position) ?? null
        })
      })
    }
  })

  return items
}

/**
 * Sheet-space bounding box of a placed symbol's body and pins, fields excluded.
 *
 * Both ends of every pin count — the connection point and the body end — so
 * a part whose pins stick out past its outline is as wide as it draws.
 */
export function symbolBox(schematic: KicadSchematic, symbol: KicadSchematicSymbol): Box {
  const geometry = resolveSymbolGeometry(schematic, symbol)
  const points: { x: number; y: number }[] = []
  for (const { graphic } of geometry.graphics) {
    for (const point of graphicPoints(graphic)) points.push(placedPoint(symbol, point))
  }
  for (const { pin } of geometry.pins) {
    const radians = (pin.position.angle * Math.PI) / 180
    points.push(placedPoint(symbol, pin.position))
    points.push(
      placedPoint(symbol, {
        x: pin.position.x + Math.cos(radians) * pin.length,
        y: pin.position.y + Math.sin(radians) * pin.length
      })
    )
  }
  if (!points.length) points.push(symbol.position)
  return boxOfPoints(points)
}

// --- get ---------------------------------------------------------------------

export type GetItemsResult =
  | { ok: true; items: Record<string, unknown>[] }
  | { ok: false; missing: string; candidates: string[] }

/** The full records for `ids`, or the first id that names nothing and the
 *  ids that look like it. */
export function getItems(input: ItemsInput, ids: readonly string[]): GetItemsResult {
  const all = sheetItems(input)
  const byId = new Map(all.map((item) => [item.id, item]))
  const items: Record<string, unknown>[] = []
  for (const id of ids) {
    const item = byId.get(id)
    if (item) {
      items.push(item.record())
      continue
    }
    // A multi-unit part's reference reads as each of its units.
    const units = all.filter((entry) => entry.kind === 'symbol' && entry.brief.reference === id)
    if (units.length) {
      for (const unit of units) items.push(unit.record())
      continue
    }
    // A hidden or empty field is not a sheet item, since nothing of it is
    // drawn, but the symbol's record hands out its id — Footprint, most often.
    const field = resolveItem(input, id)
    if (field.ok && field.item.kind === 'field') {
      items.push(fieldRecord(field.item.reference, field.item.symbol, field.item.property))
      continue
    }
    return { ok: false, missing: id, candidates: candidatesFor(id, all) }
  }
  return { ok: true, items }
}

/**
 * The ids that look like one that resolved to nothing: the same id in another
 * case, then ids containing it, then ids sharing its owner — `R1` for
 * `R1#Vale` — so a typo in a field name is one more turn, not a dead end.
 */
const candidatesFor = (id: string, all: readonly SheetItem[]): string[] => {
  const needle = id.toLowerCase()
  const ids = all.map((entry) => entry.id)
  const exact = ids.filter((entry) => entry.toLowerCase() === needle)
  if (exact.length) return exact
  const containing = ids.filter((entry) => entry.toLowerCase().includes(needle))
  if (containing.length) return containing.slice(0, 8)
  const owner = needle.split(/[#.@]/)[0]
  return ids.filter((entry) => entry.toLowerCase().split(/[#.@]/)[0] === owner).slice(0, 8)
}

// --- query -------------------------------------------------------------------

export interface ItemQuery {
  kind?: ItemKind
  /** Millimetre frame in sheet space; items whose box touches it. */
  box?: MmFrame
  /** A pin id, or a point, with `radius` around it. */
  near?: { pin?: string; x?: number; y?: number }
  /** Millimetres. Defaults to two grid squares. */
  radius?: number
  /** A net name as `describe` prints it, with or without its sheet-path slash. */
  net?: string
  limit?: number
  /** Matches to skip before the first row. */
  offset?: number
}

export const QUERY_MAX_LIMIT = 400
export const QUERY_DEFAULT_RADIUS_MM = 5.08

export type QueryItemsResult =
  | (QueryPage<Record<string, unknown>> & {
      ok: true
      /** The breakdowns a capped answer names: by kind, then by net. */
      narrowings: Narrowing[]
    })
  | { ok: false; error: 'pin-not-found'; detail: string; candidates: string[] }

export function queryItems(input: ItemsInput, query: ItemQuery): QueryItemsResult {
  let center: Point | null = null
  if (query.near) {
    if (query.near.pin) {
      const found = resolvePinRef(query.near.pin, addressablePins(input.schematic, input.sheetPath))
      if (!found.ok)
        return {
          ok: false,
          error: 'pin-not-found',
          detail: found.reason,
          candidates: found.candidates
        }
      center = found.pin.position
    } else if (query.near.x !== undefined && query.near.y !== undefined) {
      center = { x: mmToNm(query.near.x), y: mmToNm(query.near.y) }
    }
  }
  const radius = mmToNm(query.radius ?? QUERY_DEFAULT_RADIUS_MM)
  const frame: Box | null = query.box
    ? {
        minX: mmToNm(query.box.x),
        minY: mmToNm(query.box.y),
        maxX: mmToNm(query.box.x + query.box.width),
        maxY: mmToNm(query.box.y + query.box.height)
      }
    : null
  const wantedNet = query.net
    ? [query.net, query.net.startsWith('/') ? query.net.slice(1) : `/${query.net}`]
    : null

  const netsOf = (item: SheetItem): string[] => {
    if (item.net) return [item.net]
    if (item.kind === 'symbol') {
      const pins = (item.record().pins as { net: string | null }[]) ?? []
      return pins.flatMap((pin) => (pin.net !== null ? [pin.net] : []))
    }
    return []
  }
  const onNet = (item: SheetItem): boolean =>
    !wantedNet || netsOf(item).some((net) => wantedNet.includes(net))

  const matches = sheetItems(input)
    .filter((item) => !query.kind || item.kind === query.kind)
    .filter((item) => !frame || boxesIntersect(item.box, frame))
    // By anchor as well as by box: a label sits a text-offset off the pin it
    // is on, and "what is on this pin" must find it at any radius.
    .filter(
      (item) =>
        !center ||
        Math.min(
          boxDistance(item.box, center),
          Math.hypot(item.at.x - center.x, item.at.y - center.y)
        ) <= radius
    )
    .filter(onNet)
    // Reading order: top to bottom, then left to right, so a list of rows is
    // the sheet as the eye scans it rather than as the file happens to be.
    .sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x)

  const limit = Math.min(Math.max(1, query.limit ?? QUERY_DEFAULT_LIMIT), QUERY_MAX_LIMIT)
  const page = pageOf(matches, query.offset, limit)
  return {
    ok: true,
    ...page,
    rows: page.rows.map((item) => ({
      id: item.id,
      kind: item.kind,
      at: mm(item.at),
      ...(item.angle !== undefined ? { angle: item.angle } : {}),
      box: frameOf(item.box),
      ...(item.net ? { net: item.net } : {}),
      ...item.brief
    })),
    narrowings: page.truncated
      ? narrowingsOf(matches, query.kind !== undefined, [
          { arg: 'net', given: wantedNet !== null, tally: (items) => tally(items, netsOf) }
        ])
      : []
  }
}

// --- resolving an id to the thing it names ----------------------------------

export type ResolvedItem =
  | {
      kind: 'symbol'
      index: number
      symbol: KicadSchematicSymbol
      reference: string
      /** The id it answers to: the reference, or `U5A` for one unit of a part. */
      id: string
      /** Present when the id named a whole multi-unit part (`U5`): its unit ids.
       *  `symbol` is then the part's first unit on the sheet. */
      units?: string[]
    }
  | {
      kind: 'field'
      index: number
      symbol: KicadSchematicSymbol
      reference: string
      property: SchematicProperty
    }
  | { kind: 'label'; index: number; label: KicadLabel }
  | { kind: 'wire'; index: number; wire: KicadWire }
  | { kind: 'junction'; index: number; point: KicadSchematicPoint }
  | { kind: 'no_connect'; index: number; point: KicadSchematicPoint }
  | { kind: 'text'; index: number; text: KicadSchematicText }
  | { kind: GraphicKind; index: number; graphic: GraphicItem }
  | { kind: 'sheet'; index: number; sheet: KicadSheet }
  | { kind: 'sheet_pin'; index: number; sheet: KicadSheet; pin: KicadSheetPin }

export type ResolveResult =
  { ok: true; item: ResolvedItem } | { ok: false; missing: string; candidates: string[] }

/**
 * The item an id names, with the parsed object behind it — what a write
 * mutates. Same id rules as `sheetItems`, by construction: both call the one
 * builder per kind.
 */
export function resolveItem(input: ItemsInput, id: string): ResolveResult {
  const { schematic, sheetPath } = input
  const placed = schematic.symbols.flatMap((symbol, index) => {
    const reference = referenceForSheetPath(symbol, sheetPath)
    return reference
      ? [{ symbol, index, reference, id: unitItemId(schematic, symbol, reference, input.subpart) }]
      : []
  })
  const unit = placed.find((entry) => entry.id === id)
  if (unit) return { ok: true, item: { kind: 'symbol', ...unit } }
  const part = placed.filter((entry) => entry.reference === id)
  // A part with one unit placed here is that unit; with several, the part.
  if (part.length === 1) return { ok: true, item: { kind: 'symbol', ...part[0] } }
  if (part.length) {
    const [first] = part
    return {
      ok: true,
      item: { kind: 'symbol', ...first, id, units: part.map((entry) => entry.id) }
    }
  }
  for (let index = 0; index < schematic.symbols.length; index += 1) {
    const symbol = schematic.symbols[index]
    const reference = referenceForSheetPath(symbol, sheetPath)
    if (!reference) continue
    // The owner is matched as a prefix rather than split off at a `#`: a power
    // symbol's reference starts with one (`#FLG1`), and a field key may hold one.
    if (id.startsWith(`${reference}#`)) {
      const key = id.slice(reference.length + 1)
      const property = symbol.properties.find((candidate) => candidate.key === key)
      if (property) {
        return { ok: true, item: { kind: 'field', index, symbol, reference, property } }
      }
    }
  }
  const labelIndex = schematic.labels.findIndex((label, index) => labelId(label, index) === id)
  if (labelIndex >= 0) {
    const label = schematic.labels[labelIndex]
    return { ok: true, item: { kind: 'label', index: labelIndex, label } }
  }
  const wireIndex = schematic.wires.findIndex((wire, index) => wireId(wire, index) === id)
  if (wireIndex >= 0) {
    return { ok: true, item: { kind: 'wire', index: wireIndex, wire: schematic.wires[wireIndex] } }
  }
  const junctionIndex = schematic.junctions.findIndex(
    (point) => positionalId('junction', point) === id
  )
  if (junctionIndex >= 0) {
    const point = schematic.junctions[junctionIndex]
    return { ok: true, item: { kind: 'junction', index: junctionIndex, point } }
  }
  const flagIndex = schematic.noConnects.findIndex(
    (point) => positionalId('no_connect', point) === id
  )
  if (flagIndex >= 0) {
    const point = schematic.noConnects[flagIndex]
    return { ok: true, item: { kind: 'no_connect', index: flagIndex, point } }
  }
  const textIndex = schematic.texts.findIndex((text, index) => textId(text, index) === id)
  if (textIndex >= 0) {
    return { ok: true, item: { kind: 'text', index: textIndex, text: schematic.texts[textIndex] } }
  }
  const graphic = graphicItems(schematic).find((candidate) => graphicItemId(candidate) === id)
  if (graphic) return { ok: true, item: { kind: graphic.kind, index: graphic.index, graphic } }
  const sheetIndex = schematic.sheets.findIndex((sheet, index) => sheetId(sheet, index) === id)
  if (sheetIndex >= 0) {
    const sheet = schematic.sheets[sheetIndex]
    return { ok: true, item: { kind: 'sheet', index: sheetIndex, sheet } }
  }
  for (let index = 0; index < schematic.sheets.length; index += 1) {
    const sheet = schematic.sheets[index]
    const prefix = `${sheetId(sheet, index)}#`
    if (!id.startsWith(prefix)) continue
    const pin = sheet.pins.find((candidate) => candidate.name === id.slice(prefix.length))
    if (pin) return { ok: true, item: { kind: 'sheet_pin', index, sheet, pin } }
  }
  return { ok: false, missing: id, candidates: candidatesFor(id, sheetItems(input)) }
}

// --- a sheet pin as a wire or label end ------------------------------------------

/** A sheet pin on this sheet, addressed by its item id `<sheet id>#<pin name>`. */
export interface SheetPinEnd {
  id: string
  sheet: KicadSheet
  pin: KicadSheetPin
  position: Point
  /** Which way a wire or label leaves it: out of the edge it sits on. */
  free: Direction
  /** The same, as the angle a label on it reads at. */
  labelAngle: number
}

/** The sheet pin `id` names on this sheet, or null when it names none. */
export function resolveSheetPinEnd(schematic: KicadSchematic, id: string): SheetPinEnd | null {
  const trimmed = id.trim()
  for (let index = 0; index < schematic.sheets.length; index += 1) {
    const sheet = schematic.sheets[index]
    const prefix = `${sheetId(sheet, index)}#`
    if (!trimmed.startsWith(prefix)) continue
    const pin = sheet.pins.find((candidate) => candidate.name === trimmed.slice(prefix.length))
    if (!pin) continue
    const labelAngle = SHEET_PIN_ANGLE[sheetSideOf(sheet, pin.position)]
    return {
      id: trimmed,
      sheet,
      pin,
      position: { x: pin.position.x, y: pin.position.y },
      free: directionOf(labelAngle),
      labelAngle
    }
  }
  return null
}

// --- resizing a sheet box --------------------------------------------------------

/** The smallest side a sheet box takes. A twin of `MIN_SHEET_EXTENT` in
 *  `components/schematic/SchematicViewport2D.vue`, the GUI resize's floor. */
export const MIN_SHEET_EXTENT: Nm = mmToNm(2.54)

/** KiCad's `bumpToNextGrid` step: a pin needs the box to reach the next 50 mil line past it. */
const SHEET_BUMP: Nm = mmToNm(1.27)

export type SheetResizePlan =
  | {
      ok: true
      pins: Array<{ pin: KicadSheetPin; side: SheetSide; to: Point; moved: boolean }>
    }
  | { ok: false; error: 'sheet-too-small' | 'off-grid'; detail: string }

/**
 * A sheet resized to `size` from its top-left corner, as KiCad's `SCH_SHEET::Resize`
 * does it: every pin keeps its edge and its place along it, so a right or bottom
 * pin moves with its edge and the rest stay. Refused when the box would no longer
 * reach past a pin (KiCad's `GetMinWidth`/`GetMinHeight`, from the pin's point to
 * the next 1.27 mm line), and when a moved pin would leave the connection grid.
 */
export function planSheetResize(
  sheet: KicadSheet,
  size: { width: Nm; height: Nm },
  grid: Nm,
  id: string
): SheetResizePlan {
  const { x: left, y: top } = sheet.position
  const pins = sheet.pins.map((pin) => ({ pin, side: sheetSideOf(sheet, pin.position) }))
  const bump = (value: number): number => (Math.floor(value / SHEET_BUMP) + 1) * SHEET_BUMP
  const need = { width: MIN_SHEET_EXTENT as number, height: MIN_SHEET_EXTENT as number }
  const binding: string[] = []
  for (const { pin, side } of pins) {
    const vertical = side === 'left' || side === 'right'
    const reach = vertical ? bump(pin.position.y) - top : bump(pin.position.x) - left
    if (vertical) need.height = Math.max(need.height, reach)
    else need.width = Math.max(need.width, reach)
    if (reach > (vertical ? size.height : size.width)) binding.push(`${pin.name} (${side})`)
  }
  if (size.width < need.width || size.height < need.height) {
    const pinsNote = binding.length
      ? ` to keep ${binding.join(', ')} on ${binding.length === 1 ? 'its edge' : 'their edges'}`
      : ''
    return {
      ok: false,
      error: 'sheet-too-small',
      detail: `${id} needs at least ${asMm(nm(need.width))} × ${asMm(nm(need.height))} mm${pinsNote}. Pass a size at least that, or move or delete those pins first.`
    }
  }
  const right = nm(left + size.width)
  const bottom = nm(top + size.height)
  const off = (value: number): boolean => ((value % grid) + grid) % grid !== 0
  const nearest = (edge: number, origin: number): number =>
    asMm(nm(Math.round(edge / grid) * grid - origin))
  const fixes: string[] = []
  if (pins.some(({ side }) => side === 'right') && off(right)) {
    fixes.push(`width ${nearest(right, left)}`)
  }
  if (pins.some(({ side }) => side === 'bottom') && off(bottom)) {
    fixes.push(`height ${nearest(bottom, top)}`)
  }
  if (fixes.length) {
    return {
      ok: false,
      error: 'off-grid',
      detail: `That size puts the pins on ${id}'s moving edges off the ${asMm(grid)} mm connection grid; the nearest size that keeps them on it has ${fixes.join(' and ')} mm.`
    }
  }
  return {
    ok: true,
    pins: pins.map(({ pin, side }) => {
      const to =
        side === 'right'
          ? { x: right, y: pin.position.y }
          : side === 'bottom'
            ? { x: pin.position.x, y: bottom }
            : { x: pin.position.x, y: pin.position.y }
      return { pin, side, to, moved: to.x !== pin.position.x || to.y !== pin.position.y }
    })
  }
}

// --- what a symbol carries with it --------------------------------------------

export interface AttachedItems {
  /** Pins of the symbol, as `connect` addresses them. */
  pins: AddressablePin[]
  /** Labels whose anchor sits on one of those pins, with the pin. */
  labels: { index: number; label: KicadLabel; pin: AddressablePin }[]
  /** No-connect flags sitting on one of those pins, with the pin. */
  noConnects: { index: number; point: KicadSchematicPoint; pin: AddressablePin }[]
}

/**
 * The labels and no-connect flags sitting on a symbol's pins.
 *
 * A move takes them along and a removal takes them away; otherwise the sheet
 * keeps a net name floating where a pin used to be, which is what the third
 * run found.
 */
export function attachedToSymbol(
  schematic: KicadSchematic,
  sheetPath: string,
  /** One unit's pins, for a part of several units. */
  symbol: KicadSchematicSymbol
): AttachedItems {
  const pins = addressablePins(schematic, sheetPath).filter((pin) => pin.symbol === symbol)
  const byPoint = new Map(pins.map((pin) => [`${pin.position.x},${pin.position.y}`, pin]))
  const labels: AttachedItems['labels'] = []
  schematic.labels.forEach((label, index) => {
    const pin = byPoint.get(`${label.position.x},${label.position.y}`)
    if (pin) labels.push({ index, label, pin })
  })
  const noConnects: AttachedItems['noConnects'] = []
  schematic.noConnects.forEach((point, index) => {
    const pin = byPoint.get(`${point.x},${point.y}`)
    if (pin) noConnects.push({ index, point, pin })
  })
  return { pins, labels, noConnects }
}

export interface SymbolTransform {
  at?: Point
  angle?: number
  mirror?: 'x' | 'y' | undefined
}

/**
 * Where each pin lands after a transform, before it is applied — position and
 * the way a label on it should then read — keyed by pin number.
 */
export function pinsAfterTransform(
  schematic: KicadSchematic,
  symbol: KicadSchematicSymbol,
  change: SymbolTransform
): Map<string, { position: Point; labelAngle: number }> {
  const moved: KicadSchematicSymbol = {
    ...symbol,
    position: {
      x: change.at?.x ?? symbol.position.x,
      y: change.at?.y ?? symbol.position.y,
      angle: change.angle ?? symbol.position.angle
    },
    mirror: 'mirror' in change ? change.mirror : symbol.mirror
  }
  const after = new Map<string, { position: Point; labelAngle: number }>()
  for (const { pin } of resolveSymbolGeometry(schematic, moved).pins) {
    after.set(pin.number, {
      position: placedPinPosition(moved, pin),
      labelAngle: labelAngleForPin(moved, pin.position.angle)
    })
  }
  return after
}

// --- fields after a turn --------------------------------------------------------

export interface FieldPlacement {
  property: SchematicProperty
  at: Point
  angle: number
  horizontal: 'left' | 'center' | 'right'
  vertical: 'top' | 'center' | 'bottom'
}

/** Fields are stacked this far apart, and this far off the body. */
const FIELD_PITCH = mmToNm(2.54)
const FIELD_GAP = mmToNm(0.635)

/**
 * Where a symbol's visible fields go when it is autoplaced: on the side with
 * the fewest pins, stacked, reading horizontally — KiCad's autoplacer's rule,
 * without its refinements. Fields marked `do_not_autoplace` and hidden fields
 * stay where they are.
 *
 * Each placement is what the file stores, so the angle and justification are
 * the symbol's frame (`schematicFieldDrawn`): a field reading horizontally on
 * a symbol turned 90° is stored at 90, and a left-justified one on a symbol
 * turned 180° is stored right-justified.
 */
export function autoplaceFields(
  schematic: KicadSchematic,
  sheetPath: string,
  symbol: KicadSchematicSymbol
): FieldPlacement[] {
  const reference = referenceForSheetPath(symbol, sheetPath) ?? ''
  const fields = symbol.properties.filter(
    (property) =>
      !property.hidden &&
      !property.doNotAutoplace &&
      !property.key.startsWith('ki_') &&
      property.value
  )
  if (!fields.length) return []
  const box = symbolBox(schematic, symbol)
  const pins = addressablePins(schematic, sheetPath).filter((pin) => pin.reference === reference)
  const count: Record<Direction, number> = { right: 0, up: 0, left: 0, down: 0 }
  for (const pin of pins) count[directionOf(pin.labelAngle)] += 1
  const sides: Direction[] = ['right', 'up', 'left', 'down']
  const side = sides.reduce((best, candidate) =>
    count[candidate] < count[best] ? candidate : best
  )
  const centerY = (box.minY + box.maxY) / 2
  const centerX = (box.minX + box.maxX) / 2
  const stackHeight = (fields.length - 1) * FIELD_PITCH
  const frame: SymbolFrame = { angle: symbol.position.angle, mirror: symbol.mirror }
  const angle = fieldAngleForSheetAngle(0, symbol.position.angle) % 180
  const stored = (
    property: SchematicProperty,
    at: Point,
    horizontal: FieldPlacement['horizontal'],
    vertical: FieldPlacement['vertical']
  ): FieldPlacement => {
    // The flips that draw a stored justification also store a drawn one.
    const justify = schematicFieldDrawn(angle, horizontal, vertical, frame)
    return { property, at, angle, horizontal: justify.horizontal, vertical: justify.vertical }
  }
  return fields.map((property, index): FieldPlacement => {
    switch (side) {
      case 'right':
        return stored(
          property,
          {
            x: nmOf(box.maxX + FIELD_GAP),
            y: nmOf(centerY - stackHeight / 2 + index * FIELD_PITCH)
          },
          'left',
          'center'
        )
      case 'left':
        return stored(
          property,
          {
            x: nmOf(box.minX - FIELD_GAP),
            y: nmOf(centerY - stackHeight / 2 + index * FIELD_PITCH)
          },
          'right',
          'center'
        )
      case 'up':
        return stored(
          property,
          {
            x: nmOf(centerX),
            y: nmOf(box.minY - FIELD_GAP - (fields.length - 1 - index) * FIELD_PITCH)
          },
          'center',
          'bottom'
        )
      case 'down':
        return stored(
          property,
          { x: nmOf(centerX), y: nmOf(box.maxY + FIELD_GAP + index * FIELD_PITCH) },
          'center',
          'top'
        )
    }
  })
}

/**
 * Autoplace a symbol's fields into the document and mark them so
 * (`(fields_autoplaced yes)`), which is what lets a later turn place them again.
 */
export function autoplaceFieldsInAST(
  schematic: KicadSchematic,
  sheetPath: string,
  symbol: KicadSchematicSymbol
): void {
  for (const placement of autoplaceFields(schematic, sheetPath, symbol)) {
    setSchematicPropertyPlacement(placement.property, { ...placement.at, angle: placement.angle })
    setSchematicPropertyJustify(placement.property, placement.horizontal, placement.vertical)
  }
  setSchematicFieldsAutoplaced(symbol, true)
}

const nmOf = (value: number): Nm => Math.round(value) as Nm

// --- routing a wire -------------------------------------------------------------

export type WireEnd = { pin: string } | { x: number; y: number }

export interface RoutedWire {
  points: Point[]
  /** The pins the two ends landed on, when they did. */
  fromPin?: AddressablePin
  toPin?: AddressablePin
  /** The sheet pins the two ends landed on, when they did. */
  fromSheetPin?: SheetPinEnd
  toSheetPin?: SheetPinEnd
}

export type RouteResult =
  | { ok: true; wire: RoutedWire }
  | { ok: false; error: 'pin-not-found'; detail: string; candidates: string[] }
  | { ok: false; error: 'would-cross'; detail: string; candidates: string[] }
  | { ok: false; error: 'would-touch-pin'; detail: string; candidates: string[] }

const segmentsOf = (points: Point[]): [Point, Point][] =>
  points.slice(1).map((point, index) => [points[index], point])

const segmentCrossesBox = ([a, b]: [Point, Point], box: Box): boolean => {
  // Axis-aligned segments only, which is all a routed wire has.
  if (a.y === b.y) {
    const y = a.y
    const [x0, x1] = a.x < b.x ? [a.x, b.x] : [b.x, a.x]
    return y > box.minY && y < box.maxY && x1 > box.minX && x0 < box.maxX
  }
  const x = a.x
  const [y0, y1] = a.y < b.y ? [a.y, b.y] : [b.y, a.y]
  return x > box.minX && x < box.maxX && y1 > box.minY && y0 < box.maxY
}

const pointOnSegmentInterior = (point: Point, [a, b]: [Point, Point]): boolean => {
  if (a.y === b.y && point.y === a.y) {
    const [x0, x1] = a.x < b.x ? [a.x, b.x] : [b.x, a.x]
    return point.x > x0 && point.x < x1
  }
  if (a.x === b.x && point.x === a.x) {
    const [y0, y1] = a.y < b.y ? [a.y, b.y] : [b.y, a.y]
    return point.y > y0 && point.y < y1
  }
  return false
}

/**
 * A wire between two ends — pins or points — as a straight run or one bend.
 *
 * The bend leaves a pin along its free side, which is the only way a wire off
 * a pin can look right. The run is refused when a segment would cut through a
 * symbol other than the two it joins, or when its interior would pass over
 * another pin's connection point: the first draws over a part, and the second
 * is a connection KiCad would make and this connectivity would not (see
 * `junctionsForNewWire`), which is the worst kind of silent.
 */
export function routeWire(
  input: ItemsInput,
  from: WireEnd,
  to: WireEnd,
  posture?: 'hv' | 'vh'
): RouteResult {
  const pins = addressablePins(input.schematic, input.sheetPath)
  const resolveEnd = (
    end: WireEnd
  ):
    | { ok: true; point: Point; pin?: AddressablePin; sheetPin?: SheetPinEnd }
    | { ok: false; detail: string; candidates: string[] } => {
    if ('pin' in end) {
      const sheetPin = resolveSheetPinEnd(input.schematic, end.pin)
      if (sheetPin) return { ok: true, point: sheetPin.position, sheetPin }
      const found = resolvePinRef(end.pin, pins)
      return found.ok
        ? { ok: true, point: found.pin.position, pin: found.pin }
        : { ok: false, detail: found.reason, candidates: found.candidates }
    }
    return { ok: true, point: { x: mmToNm(end.x), y: mmToNm(end.y) } }
  }
  const a = resolveEnd(from)
  if (!a.ok)
    return { ok: false, error: 'pin-not-found', detail: a.detail, candidates: a.candidates }
  const b = resolveEnd(to)
  if (!b.ok)
    return { ok: false, error: 'pin-not-found', detail: b.detail, candidates: b.candidates }

  let points: Point[]
  const freeOf = (pin?: AddressablePin, sheetPin?: SheetPinEnd): Direction | null =>
    pin ? directionOf(pin.labelAngle) : (sheetPin?.free ?? null)
  const startFree = freeOf(a.pin, a.sheetPin)
  const endFree = freeOf(b.pin, b.sheetPin)
  const vertical = (d: Direction | null): boolean => d === 'up' || d === 'down'
  const horizontal = (d: Direction | null): boolean => d === 'left' || d === 'right'
  const towards = (free: Direction | null, from: number, to: number): boolean =>
    free === null || (free === 'up' || free === 'left' ? to < from : to > from)
  if (a.point.x === b.point.x || a.point.y === b.point.y) {
    points = [a.point, b.point]
  } else if (
    posture === undefined &&
    vertical(startFree) &&
    vertical(endFree) &&
    towards(startFree, a.point.y, b.point.y) &&
    towards(endFree, b.point.y, a.point.y)
  ) {
    // Two vertical pins facing each other: leave both along their free sides
    // and cross between them — the Z a person draws between a capacitor and
    // the supply pin under it.
    const midY = snapGrid((a.point.y + b.point.y) / 2)
    points = [a.point, { x: a.point.x, y: midY }, { x: b.point.x, y: midY }, b.point]
  } else if (
    posture === undefined &&
    horizontal(startFree) &&
    horizontal(endFree) &&
    towards(startFree, a.point.x, b.point.x) &&
    towards(endFree, b.point.x, a.point.x)
  ) {
    const midX = snapGrid((a.point.x + b.point.x) / 2)
    points = [a.point, { x: midX, y: a.point.y }, { x: midX, y: b.point.y }, b.point]
  } else {
    // One bend: leave the starting pin along its free side, or arrive at the
    // far pin along its free side when the start is a bare point.
    const horizontalFirst =
      posture !== undefined
        ? posture === 'hv'
        : horizontal(startFree)
          ? true
          : vertical(startFree)
            ? false
            : vertical(endFree)
              ? true
              : !horizontal(endFree)
    const corner = horizontalFirst ? { x: b.point.x, y: a.point.y } : { x: a.point.x, y: b.point.y }
    points = [a.point, corner, b.point]
  }

  const exclude = new Set([a.pin?.reference, b.pin?.reference].filter(Boolean))
  const segments = segmentsOf(points)
  const crossed: string[] = []
  for (const symbol of input.schematic.symbols) {
    const reference = referenceForSheetPath(symbol, input.sheetPath)
    if (!reference || exclude.has(reference)) continue
    const box = symbolBox(input.schematic, symbol)
    if (segments.some((segment) => segmentCrossesBox(segment, box))) crossed.push(reference)
  }
  if (crossed.length) {
    return {
      ok: false,
      error: 'would-cross',
      detail: `A straight or one-bend run from ${describeEnd(from)} to ${describeEnd(to)} would cross ${crossed.join(', ')}.`,
      candidates: crossed
    }
  }
  // A pin under a segment's interior, or under the bend itself: KiCad joins
  // both, this connectivity joins neither, so neither may be drawn.
  const corners = points.slice(1, -1)
  const touched = pins
    .filter((pin) => pin !== a.pin && pin !== b.pin)
    .filter(
      (pin) =>
        segments.some((segment) => pointOnSegmentInterior(pin.position, segment)) ||
        corners.some((corner) => corner.x === pin.position.x && corner.y === pin.position.y)
    )
    .map(pinRefOf)
  if (touched.length) {
    return {
      ok: false,
      error: 'would-touch-pin',
      detail: `The run from ${describeEnd(from)} to ${describeEnd(to)} would pass over ${touched.join(', ')}.`,
      candidates: touched
    }
  }
  return {
    ok: true,
    wire: {
      points,
      fromPin: a.pin,
      toPin: b.pin,
      ...(a.sheetPin ? { fromSheetPin: a.sheetPin } : {}),
      ...(b.sheetPin ? { toSheetPin: b.sheetPin } : {})
    }
  }
}

const describeEnd = (end: WireEnd): string => ('pin' in end ? end.pin : `(${end.x}, ${end.y})`)

/** Onto the 1.27 mm half-grid, which is where every pin end already sits. */
const snapGrid = (value: number): Nm => {
  const step = mmToNm(1.27)
  return (Math.round(value / step) * step) as Nm
}

/** The junction dots a routed wire needs on this sheet — the wire tool's own
 *  rule, fed every symbol pin as an item a wire end can meet. */
export function junctionsForRoutedWire(input: ItemsInput, points: Point[]): Point[] {
  const { schematic, sheetPath } = input
  const pinPoints = addressablePins(schematic, sheetPath).map((pin) => pin.position)
  return junctionsForNewWire(
    schematic.wires.map((wire) => wire.points),
    schematic.junctions,
    pinPoints,
    points
  )
}
