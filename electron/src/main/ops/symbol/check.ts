/**
 * `symbol.check` — KiCad's symbol checker over one symbol definition: a
 * library symbol, or the copy a sheet holds for a placed one.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { codesArg } from '../checksArg'
import { isSymbolRefusal, placedSheetArg, symbolArg, symbolTarget } from './target'

export const symbolCheck = defineDesignOp({
  name: 'symbol.check',
  scope: 'project',
  mutates: false,
  summary:
    "Run KiCad's symbol checker over one symbol definition: pin numbers, grid, power pins, prefix, shapes.",
  guidance:
    "One row per rule with the pins it names (pin:<number>). A definition has no revision, so no since. A placed reference checks its sheet's copy. Electrical checks on a sheet are schematic_check.",
  input: s.object({ symbol: symbolArg, sheet: placedSheetArg, codes: codesArg }),
  examples: [{ args: { symbol: 'board:ES8388' }, note: 'a generated symbol, before placing it' }],
  request(args) {
    const target = symbolTarget(args)
    if (isSymbolRefusal(target)) return target
    return { kind: 'check-symbol', ...target, ...(args.codes ? { codes: args.codes } : {}) }
  }
})
