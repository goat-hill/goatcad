import { describe, expect, it } from 'vitest'
import { registry } from '../index'

const build = (
  args: Record<string, unknown>
): ReturnType<NonNullable<ReturnType<typeof registry.get>>['designRequest'] & object> => {
  const op = registry.get('render.board')
  if (!op?.designRequest) throw new Error('render.board is not a design operation')
  return op.designRequest({ viewport: 'viewport-1', action: 'Review', ...args })
}

const request = (args: Record<string, unknown>): Record<string, unknown> => {
  const result = build(args)
  if (!result.ok) throw new Error(result.error.message)
  return result.request as unknown as Record<string, unknown>
}

describe('render.board', () => {
  it('requires exactly one of layers and preset', () => {
    for (const args of [{}, { preset: 'front', layers: ['F.Cu'] }]) {
      const result = build(args)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('invalid-args')
        expect(result.error.fix).toBeTruthy()
      }
    }
    expect(request({ preset: 'copper' }).preset).toBe('copper')
    expect(request({ layers: ['F.Cu'] }).layers).toEqual(['F.Cu'])
  })

  it('draws zones as outlines unless fills is passed', () => {
    expect(request({ preset: 'front' })).not.toHaveProperty('fills')
    expect(request({ preset: 'front', fills: true }).fills).toBe(true)
  })

  it("dims to the canvas's 0.3 under an active layer, and refuses dim without one", () => {
    expect(request({ preset: 'copper', activeLayer: 'B.Cu' })).toMatchObject({
      activeLayer: 'B.Cu',
      dim: 0.3
    })
    expect(request({ preset: 'copper', activeLayer: 'B.Cu', dim: 0.1 }).dim).toBe(0.1)
    expect(request({ preset: 'copper' })).not.toHaveProperty('dim')
    const result = build({ preset: 'copper', dim: 0.5 })
    expect(!result.ok && result.error.code).toBe('invalid-args')
    expect(build({ preset: 'copper', activeLayer: 'F.Cu', dim: 2 }).ok).toBe(false)
  })

  it('views the back preset from the back unless side says otherwise', () => {
    expect(request({ preset: 'back' }).side).toBe('back')
    expect(request({ preset: 'back', side: 'front' })).not.toHaveProperty('side')
    expect(request({ preset: 'front' })).not.toHaveProperty('side')
  })
})
