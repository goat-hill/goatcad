/**
 * A Components-table edit as `SymbolEdit`s: one per placed symbol behind the
 * chosen records, on whichever sheet each lives. Shared by the Components tab
 * and the schematic editor's property panel, which writes a symbol's identity
 * fields the same way, so a field edit means the same thing from either.
 */
import {
  setSchematicPropertyHidden,
  setSchematicSymbolFlag,
  setSchematicSymbolProperty,
  setSymbolInstanceReference,
  type KicadSchematicSymbol,
  type SchematicSymbolFlag
} from '../kicad/schematic'
import { findChildren } from '../kicad/sexpr'
import {
  moveSymbolProperty,
  removeSymbolProperty,
  renameSymbolProperty
} from '../symbol/symbolEdit'
import type { ComponentRecord, FlagKey } from '../componentsTable'
import type { SymbolEdit } from './symbolEdits'

/** Checkbox semantics are "excluded"; `in_bom` and `on_board` store the inverse. */
export const FLAG_TOKENS: Record<FlagKey, { token: SchematicSymbolFlag; invert: boolean }> = {
  dnp: { token: 'dnp', invert: false },
  excludeFromBom: { token: 'in_bom', invert: true },
  excludeFromBoard: { token: 'on_board', invert: true }
}

export const fieldEdits = (
  records: readonly ComponentRecord[],
  field: string,
  value: string
): SymbolEdit[] =>
  records.flatMap((record) =>
    record.locations.map((location): SymbolEdit => ({
      filePath: location.filePath,
      symbolIndex: location.symbolIndex,
      apply: (symbol) => {
        // A reference is per hierarchical path; every other field is on the node.
        if (field === 'Reference') setSymbolInstanceReference(symbol, location.sheetPath, value)
        else setSchematicSymbolProperty(symbol, field, value)
      }
    }))
  )

/**
 * One change to a placed part's list of fields, from the Edit fields sheet.
 * The writers are the symbol editor's (`symbolEdit.ts`), which refuse the
 * mandatory five and a key already taken by writing nothing.
 */
export type FieldListOp =
  | { op: 'add'; key: string }
  | { op: 'remove'; key: string }
  | { op: 'rename'; key: string; newKey: string }
  | { op: 'move'; key: string; delta: 1 | -1 }
  | { op: 'visible'; key: string; visible: boolean }

/** The parsed fields, put back in step with the nodes after a list change. */
const resyncProperties = (symbol: KicadSchematicSymbol): void => {
  const byNode = new Map(symbol.properties.map((property) => [property._node, property]))
  symbol.properties = findChildren(symbol._node, 'property').flatMap(
    (node) => byNode.get(node) ?? []
  )
}

export const applyFieldListOp = (symbol: KicadSchematicSymbol, change: FieldListOp): void => {
  const property = symbol.properties.find((candidate) => candidate.key === change.key)
  switch (change.op) {
    case 'add':
      // Created hidden at the part, as a value typed in the Components tab is.
      if (!property) setSchematicSymbolProperty(symbol, change.key, '')
      return
    case 'remove':
      if (removeSymbolProperty(symbol._node, change.key)) resyncProperties(symbol)
      return
    case 'rename':
      if (property && renameSymbolProperty(symbol._node, change.key, change.newKey))
        property.key = change.newKey
      return
    case 'move':
      if (moveSymbolProperty(symbol._node, change.key, change.delta)) resyncProperties(symbol)
      return
    case 'visible':
      if (property) setSchematicPropertyHidden(property, !change.visible)
  }
}

/** A field-list change on every unit of the chosen parts, as `fieldEdits` writes a value. */
export const fieldListEdits = (
  records: readonly ComponentRecord[],
  change: FieldListOp
): SymbolEdit[] =>
  records.flatMap((record) =>
    record.locations.map((location): SymbolEdit => ({
      filePath: location.filePath,
      symbolIndex: location.symbolIndex,
      apply: (symbol) => applyFieldListOp(symbol, change)
    }))
  )

export const flagEdits = (
  records: readonly ComponentRecord[],
  flag: FlagKey,
  value: boolean
): SymbolEdit[] => {
  const { token, invert } = FLAG_TOKENS[flag]
  return records.flatMap((record) =>
    record.locations.map((location): SymbolEdit => ({
      filePath: location.filePath,
      symbolIndex: location.symbolIndex,
      apply: (symbol) => setSchematicSymbolFlag(symbol, token, invert ? !value : value)
    }))
  )
}
