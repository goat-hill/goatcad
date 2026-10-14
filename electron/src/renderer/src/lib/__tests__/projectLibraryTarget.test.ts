import { describe, expect, test } from 'vitest'
import { resolveProjectLibrary } from '../projectLibraryTarget'

describe('resolveProjectLibrary', () => {
  test('names the library after the active project, beside its project file', () => {
    const context = { projectPath: '/work', projectFile: '/work/boards/phone.kicad_pro' }
    expect(resolveProjectLibrary(context, 'symbol')).toMatchObject({
      ok: true,
      projectDir: '/work/boards',
      stem: 'phone',
      path: '/work/boards/phone.kicad_sym'
    })
    expect(resolveProjectLibrary(context, 'footprint')).toMatchObject({
      path: '/work/boards/phone.pretty'
    })
  })

  test('takes a named library, with or without its extension', () => {
    const context = { projectPath: '/work', projectFile: '/work/phone.kicad_pro' }
    expect(resolveProjectLibrary(context, 'footprint', 'connectors.pretty')).toMatchObject({
      path: '/work/connectors.pretty'
    })
    expect(resolveProjectLibrary(context, 'symbol', ' parts ')).toMatchObject({
      path: '/work/parts.kicad_sym'
    })
  })

  test('refuses rather than guesses when no project is active', () => {
    // A workspace holding two projects has none active: never the folder's name.
    expect(
      resolveProjectLibrary({ projectPath: '/work', projectFile: null }, 'symbol')
    ).toMatchObject({ ok: false, error: 'no-active-project' })
    expect(resolveProjectLibrary({ projectPath: null, projectFile: null }, 'symbol')).toMatchObject(
      {
        ok: false,
        error: 'no-project'
      }
    )
  })
})
