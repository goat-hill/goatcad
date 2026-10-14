import { describe, expect, it } from 'vitest'
import { registry } from '../index'

const build = (
  args: Record<string, unknown>
): ReturnType<NonNullable<ReturnType<typeof registry.get>>['designRequest'] & object> => {
  const op = registry.get('schematic.update_symbols')
  if (!op?.designRequest) throw new Error('schematic.update_symbols is not a design operation')
  return op.designRequest(args)
}

describe('schematic.update_symbols', () => {
  it('updates every symbol with no targets, but changes only named ones', () => {
    expect(build({}).ok).toBe(true)
    expect(build({ match: 'Device:R', symbol: 'Device:R_Small' }).ok).toBe(true)
    expect(build({ references: ['R1'], symbol: 'Device:R_Small' }).ok).toBe(true)
    const all = build({ symbol: 'Device:R_Small' })
    expect(all.ok).toBe(false)
    if (!all.ok) expect(all.error.code).toBe('invalid-args')
  })
})
