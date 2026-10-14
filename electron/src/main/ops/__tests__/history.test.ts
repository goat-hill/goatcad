import { describe, expect, it } from 'vitest'
import { registry } from '../index'

const build = (
  name: string,
  args: Record<string, unknown>
): ReturnType<NonNullable<ReturnType<typeof registry.get>>['designRequest'] & object> => {
  const op = registry.get(name)
  if (!op?.designRequest) throw new Error(`${name} is not a design operation`)
  return op.designRequest(args)
}

describe('symbol and footprint undo', () => {
  it("take a library's list, and send a placed part to its sheet's or board's undo", () => {
    expect(build('symbol.undo', { symbol: 'board:LDO_3V3' }).ok).toBe(true)
    expect(build('footprint.redo', { footprint: 'board:SOT-23-5' }).ok).toBe(true)
    for (const [name, args, fix] of [
      ['symbol.undo', { symbol: 'U3', sheet: 'main.kicad_sch' }, 'schematic_undo'],
      ['symbol.undo', { symbol: 'U3' }, 'schematic_undo'],
      ['footprint.redo', { footprint: 'U3', board: 'main.kicad_pcb' }, 'board_redo']
    ] as const) {
      const result = build(name, args)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.fix).toContain(fix)
    }
  })
})
