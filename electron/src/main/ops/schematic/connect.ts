/**
 * `schematic.connect` — the verb that decides whether a schematic can be
 * completed.
 *
 * Design: `docs/agent-api.md`. It places a net label at
 * each pin, on the free side, and **never draws a wire**. That is
 * netlist-correct and ERC-clean; wire geometry is an aesthetic problem
 * this op declines — a model
 * cannot see the sheet, so a route it invents crosses whatever is drawn there.
 *
 * The refusal that matters is the merge. Joining two nets that are *both*
 * already named combines them, and nothing on the sheet shows that it happened:
 * the labels look the same either way. So it is refused unless `merge: true`
 * and both names come back in the error first, which means the caller has to
 * have read them.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { checksArg } from '../checksArg'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'
import { sheetFileArg } from '../fileArgs'

export const schematicConnect = defineDesignOp({
  name: 'schematic.connect',
  scope: 'schematic',
  mutates: true,
  summary: 'Join pins to a net by placing a net label at each pin; draws no wire.',
  guidance:
    'One undo step on the sheet\'s tab. Read schematic_describe first for pin ids and net names: an unknown net name creates a new net, so a typo splits a net silently. Joining two already-named nets is refused unless merge is true. Use labels between blocks; within a block use schematic_wire, and a rail is a power symbol (schematic_place_symbol, symbol power:GND). A local label names the net "/GND", not the power symbol\'s "GND": use labelKind "global" for any net a power symbol drives. A leading slash on net is dropped.',
  input: s.object({
    sheet: sheetFileArg(),
    net: s.string().trim().describe('Net name: an existing one, or a new one to create.'),
    pins: s
      .array(s.string().trim())
      .min(1)
      .describe(
        'Pin ids, <reference>.<pad>, or a pin name that is unique on the part, e.g. ["U1.VDD", "C3.1"]; a sheet pin by its item id, <sheet id>#<pin name>.'
      ),
    merge: s
      .boolean()
      .describe('Allow joining two already-named nets. Default false: refused, naming both.')
      .optional(),
    labelKind: s
      .enum(['local', 'global'] as const)
      .describe(
        'Label scope. Default "local" (this sheet); "global" spans every sheet and joins a power symbol of that name.'
      )
      .optional(),
    viewport: viewportArg,
    action: actionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: {
        net: 'VDD_3V3',
        pins: ['U1.VDD', 'C3.1'],
        viewport: 'viewport-1',
        action: 'Connect VDD_3V3'
      },
      note: 'two pins onto an existing net'
    }
  ],
  request(args) {
    if (!args.net) {
      return refused(
        'net is required and must not be empty.',
        'Name the net you want these pins on — an existing one from schematic_describe, or a new one.'
      )
    }
    const blank = args.pins.findIndex((pin) => !pin)
    if (blank >= 0) {
      return refused(
        `pins[${blank}] is empty.`,
        'Every entry is a pin id from schematic_describe, e.g. "R1.2".'
      )
    }
    return {
      kind: 'connect-pins',
      net: args.net,
      pins: args.pins,
      ...(args.sheet ? { sheet: args.sheet } : {}),
      ...(args.merge === true ? { merge: true } : {}),
      ...(args.labelKind ? { labelKind: args.labelKind } : {})
    }
  }
})
