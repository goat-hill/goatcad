import { describe, expect, test } from 'vitest'
import { touchesProjectLibraries } from '../libraryFeed'
import { fileChange, type ProjectChange } from '../projectBus'

describe('touchesProjectLibraries', () => {
  test('a library file or folder, either table, or a project registration', () => {
    const changed = (path: string): ProjectChange[] => [fileChange('file-changed', path)]
    expect(touchesProjectLibraries(changed('/p/demo.kicad_sym'))).toBe(true)
    expect(touchesProjectLibraries(changed('/p/demo.pretty/U1.kicad_mod'))).toBe(true)
    expect(touchesProjectLibraries(changed('/p/demo.pretty'))).toBe(true)
    expect(touchesProjectLibraries(changed('/p/sym-lib-table'))).toBe(true)
    expect(touchesProjectLibraries(changed('C:\\p\\fp-lib-table'))).toBe(true)
    const renamed: ProjectChange = {
      kind: 'file-renamed',
      from: '/p/a.kicad_sym',
      to: '/p/a.bak',
      fileType: 'other'
    }
    expect(touchesProjectLibraries([renamed])).toBe(true)
    expect(
      touchesProjectLibraries([{ kind: 'library-registered', scope: 'project', nickname: 'demo' }])
    ).toBe(true)
    expect(touchesProjectLibraries(changed('/p/demo.kicad_sch'))).toBe(false)
    expect(touchesProjectLibraries(changed('/p/not-sym-lib-table.txt'))).toBe(false)
    // The app's own tables are the index rebuild's, not this layer's.
    expect(
      touchesProjectLibraries([{ kind: 'library-registered', scope: 'global', nickname: 'x' }])
    ).toBe(false)
  })
})
