/**
 * A library symbol as the project library takes a copy of it: one flat
 * definition under its new name, ready to append to a `.kicad_sym` root.
 */
import { flattenLibSymbolChain, libSymbolChain, type KicadLibSymbol } from '../kicad/schematic'
import { getAtomValues, type SExprList } from '../kicad/sexpr'
import { renameSymbol, setSymbolProperty, symbolPropertyNode } from './symbolEdit'

const bare = (name: string): string => name.slice(name.indexOf(':') + 1)

/**
 * The definition with its `extends` chain flattened in, as KiCad's Flatten
 * does: a project library may not hold the parent, so the copy carries it.
 * Named `name`; the Value field follows only when it still held the old name,
 * since an edited Value is what prints on the sheet.
 */
export function librarySymbolCopy(
  definition: KicadLibSymbol,
  lookup: (name: string) => KicadLibSymbol | undefined,
  name: string
): SExprList {
  const node = flattenLibSymbolChain(libSymbolChain(definition, lookup))
  const was = bare(definition.name)
  const atom = node.children[1]
  if (atom?.type === 'atom') {
    atom.value = was
    atom.quoted = true
  }
  if (name !== was) {
    renameSymbol(node, name)
    const value = symbolPropertyNode(node, 'Value')
    if (value && getAtomValues(value)[1] === was) setSymbolProperty(node, 'Value', name)
  }
  return node
}
