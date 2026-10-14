import { describe, expect, test } from 'vitest'
import { newProjectFilesWith, refuseCreate } from '../createProject'
import { parseKicadBoard } from '../../kicad/board'
import { extractDesignSettings } from '../../kicad/project'
import { findProfile } from '../../manufacturingProfiles'

const file = (name: string): { name: string; isDirectory: boolean } => ({
  name,
  isDirectory: false
})

describe('refuseCreate', () => {
  test('an empty folder takes a project; a named profile and layer count must exist', () => {
    expect(refuseCreate([], 'canary', 'canary', undefined, false, {})).toBeNull()
    expect(
      refuseCreate([], 'canary', 'canary', undefined, false, { copperLayers: 3 })
    ).toMatchObject({
      error: 'invalid-record'
    })
    expect(
      refuseCreate([], 'canary', 'canary', undefined, false, { profile: 'nope' })
    ).toMatchObject({
      error: 'invalid-record'
    })
  })

  test('a folder with a project, or with sheets and no choice, is refused with what it holds', () => {
    expect(refuseCreate([file('old.kicad_pro')], 'x', 'x', undefined, false, {})).toMatchObject({
      error: 'project-exists',
      candidates: ['old.kicad_pro']
    })
    expect(refuseCreate([file('main.kicad_sch')], 'x', 'x', undefined, false, {})).toMatchObject({
      error: 'files-exist',
      candidates: ['main.kicad_sch']
    })
    expect(refuseCreate([file('main.kicad_sch')], 'x', 'x', 'main.kicad_sch', false, {})).toBeNull()
    expect(refuseCreate([file('main.kicad_sch')], 'x', 'x', undefined, true, {})).toBeNull()
  })
})

describe('newProjectFilesWith', () => {
  test('a profile gives the board its stackup and the project its rules and Default class', () => {
    const profile = findProfile('jlcpcb-4l-1.6')!
    const files = newProjectFilesWith('canary', { profile: profile.id })
    expect(files.map((f) => f.name)).toEqual([
      'canary.kicad_pro',
      'canary.kicad_sch',
      'canary.kicad_pcb'
    ])
    const board = parseKicadBoard(files[2].content)
    expect(board.layers.map((layer) => layer.name)).toEqual(
      expect.arrayContaining(['In1.Cu', 'In2.Cu'])
    )
    const settings = extractDesignSettings(files[0].content)!
    expect(settings.rules.minTrackWidth).toBe(profile.rules.minTrackWidth)
    expect(settings.classes[0].trackWidth).toBe(profile.defaults.trackWidth)
  })

  test('with nothing chosen, it is the plain scaffold', () => {
    const board = parseKicadBoard(newProjectFilesWith('p', {})[2].content)
    expect(board.layers.filter((layer) => layer.name.endsWith('.Cu'))).toHaveLength(2)
  })
})
