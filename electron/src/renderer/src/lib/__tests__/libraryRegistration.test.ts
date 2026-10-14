import { describe, it, expect } from 'vitest'
import { planAddLibrary, plannedUri } from '../libraryRegistration'

const PROJECT = '/home/u/designs/esp32-breakout'

describe('planAddLibrary', () => {
  it('names the copy after the source, inside the project', () => {
    const plan = planAddLibrary('symbol', '/home/u/Downloads/TPS62840.kicad_sym', PROJECT, [])
    expect(plan.sourceName).toBe('TPS62840.kicad_sym')
    expect(plan.copyTarget).toBe(`${PROJECT}/TPS62840.kicad_sym`)
    expect(plan.alreadyInProject).toBe(false)
  })

  it('suffixes a copy that would collide with a file already in the project', () => {
    const plan = planAddLibrary('symbol', '/home/u/Downloads/TPS62840.kicad_sym', PROJECT, [
      'TPS62840.kicad_sym'
    ])
    expect(plan.copyTarget).toBe(`${PROJECT}/TPS62840-1.kicad_sym`)
  })

  it('keeps the .pretty extension for a footprint library directory', () => {
    const plan = planAddLibrary('footprint', '/home/u/parts/Modules.pretty', PROJECT, [])
    expect(plan.copyTarget).toBe(`${PROJECT}/Modules.pretty`)
  })

  it('recognizes a library already inside the project, so no copy is offered', () => {
    const plan = planAddLibrary('symbol', `${PROJECT}/sub/House.kicad_sym`, PROJECT, [])
    expect(plan.alreadyInProject).toBe(true)
  })

  it('compares case-insensitively, since macOS and Windows do', () => {
    const plan = planAddLibrary('symbol', `${PROJECT.toUpperCase()}/House.kicad_sym`, PROJECT, [])
    expect(plan.alreadyInProject).toBe(true)
  })
})

describe('plannedUri', () => {
  const plan = planAddLibrary('symbol', '/home/u/Downloads/TPS62840.kicad_sym', PROJECT, [])

  it('records a copy relative to the project, so it resolves on a clone', () => {
    expect(plannedUri(plan, 'copy', PROJECT)).toBe('${KIPRJMOD}/TPS62840.kicad_sym')
  })

  it('records a reference as the absolute path it actually points at', () => {
    expect(plannedUri(plan, 'reference', PROJECT)).toBe('/home/u/Downloads/TPS62840.kicad_sym')
  })

  it('stays project-relative for a library already inside the project', () => {
    const inside = planAddLibrary('symbol', `${PROJECT}/House.kicad_sym`, PROJECT, [])
    expect(plannedUri(inside, 'reference', PROJECT)).toBe('${KIPRJMOD}/House.kicad_sym')
  })
})
