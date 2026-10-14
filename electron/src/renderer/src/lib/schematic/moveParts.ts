// What a schematic move grabs by and which grid it takes: KiCad's
// `EE_GRID_HELPER::computeAnchors` and its grid classes, per selected item.
// Sheet space (nm, y down).

import {
  resolveSymbolGeometry,
  type KicadSchematic,
  type Point,
  type SchematicItemType
} from '../kicad/schematic'
import { NM_PER_MM, spacingToMm } from '../kicad/coordinates'
import type { MoveRole } from '../moveAnchors'
import { placedPinPosition } from './connectivity'
import { isSheetItemType, sheetItemAt, sheetItemOrigin } from './sheetItemPlacement'

export interface MovePart {
  role: MoveRole
  anchors: Point[]
}

interface PartRef {
  type: SchematicItemType
  index: number
  field?: string
  pin?: number
}

/** A pin offset off this grid from its symbol's origin makes the symbol move with the cursor. */
const PIN_GRID_NM = spacingToMm(25, 'mil') * NM_PER_MM

/**
 * Each selected item's grid class and grab anchors. One item KiCad will not
 * move from an anchor (`IsMovableFromAnchorPoint`: a sheet, an image, a bus
 * entry, a symbol whose pins are off its 25 mil grid) has none, and so moves
 * with the cursor.
 */
export function schematicMoveParts(sheet: KicadSchematic, refs: readonly PartRef[]): MovePart[] {
  const parts = refs.flatMap((ref) => {
    const part = movePart(sheet, ref)
    return part ? [part] : []
  })
  if (refs.length === 1 && parts.length === 1 && !movableFromAnchor(sheet, refs[0]))
    parts[0] = { role: parts[0].role, anchors: [] }
  return parts
}

function movableFromAnchor(sheet: KicadSchematic, ref: PartRef): boolean {
  if (ref.type === 'sheet' || ref.type === 'image' || ref.type === 'bus_entry') return false
  if (ref.type !== 'symbol') return true
  const symbol = sheet.symbols[ref.index]
  return resolveSymbolGeometry(sheet, symbol).pins.every(
    ({ pin }) => pin.position.x % PIN_GRID_NM === 0 && pin.position.y % PIN_GRID_NM === 0
  )
}

function movePart(sheet: KicadSchematic, ref: PartRef): MovePart | null {
  switch (ref.type) {
    case 'symbol': {
      const symbol = sheet.symbols[ref.index]
      if (!symbol) return null
      const pins = resolveSymbolGeometry(sheet, symbol).pins.map(({ pin }) =>
        placedPinPosition(symbol, pin)
      )
      return { role: 'connectable', anchors: [symbol.position, ...pins] }
    }
    case 'field': {
      const property = sheet.symbols[ref.index]?.properties.find((p) => p.key === ref.field)
      return property ? { role: 'text', anchors: [property.position] } : null
    }
    case 'wire': {
      const points = sheet.wires[ref.index]?.points
      return points?.length
        ? { role: 'wire', anchors: [points[0], points[points.length - 1]] }
        : null
    }
    case 'junction': {
      const point = sheet.junctions[ref.index]
      return point ? { role: 'wire', anchors: [point] } : null
    }
    case 'no_connect': {
      const point = sheet.noConnects[ref.index]
      return point ? { role: 'connectable', anchors: [point] } : null
    }
    case 'label': {
      const label = sheet.labels[ref.index]
      return label ? { role: 'connectable', anchors: [label.position] } : null
    }
    case 'sheet': {
      const box = sheet.sheets[ref.index]
      return box
        ? { role: 'connectable', anchors: [box.position, ...box.pins.map((pin) => pin.position)] }
        : null
    }
    case 'sheet_pin': {
      const pin = sheet.sheets[ref.index]?.pins[ref.pin ?? -1]
      return pin ? { role: 'connectable', anchors: [pin.position] } : null
    }
    case 'sheet_field': {
      const property = sheet.sheets[ref.index]?.properties.find((p) => p.key === ref.field)
      return property ? { role: 'text', anchors: [property.position] } : null
    }
  }
  if (!isSheetItemType(ref.type)) return null
  const entry = sheetItemAt(sheet, ref.type, ref.index)
  if (!entry) return null
  const origin = sheetItemOrigin(entry)
  switch (entry.type) {
    case 'bus': {
      const points = entry.item.points
      return { role: 'wire', anchors: points.length ? [points[0], points[points.length - 1]] : [] }
    }
    case 'bus_entry':
      return { role: 'wire', anchors: origin ? [origin] : [] }
    case 'netclass_flag':
    case 'rule_area':
      return { role: 'connectable', anchors: origin ? [origin] : [] }
    case 'text':
    case 'text_box':
    case 'table':
      return { role: 'text', anchors: origin ? [origin] : [] }
    case 'polyline': {
      const points = entry.item.graphic.points
      return {
        role: 'graphic',
        anchors: points.length ? [points[0], points[points.length - 1]] : []
      }
    }
  }
  // Shapes and images have no anchors: they move with the cursor.
  return { role: 'graphic', anchors: [] }
}
