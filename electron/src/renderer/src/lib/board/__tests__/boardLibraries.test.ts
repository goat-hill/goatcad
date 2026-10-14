import { describe, expect, test } from 'vitest'
import { loadBoardLibraries } from '../boardLibraries'
import { buildLibraryView, type IndexRecord } from '../../libraryIndex'
import { parseKicadBoard } from '../../kicad/board'

const board = parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (net 0 "")
  (footprint "Lib:R" (layer "F.Cu") (uuid "a") (at 0 0))
  (footprint "Lib:Gone" (layer "F.Cu") (uuid "b") (at 5 0))
  (footprint "Nowhere:R" (layer "F.Cu") (uuid "c") (at 10 0))
)`)

describe('loadBoardLibraries', () => {
  test('reads each footprint the board places from the file the index found it in', async () => {
    const read: string[] = []
    const libraries = await loadBoardLibraries(
      {
        libraries: async () =>
          buildLibraryView({
            libraries: [
              {
                type: 'footprint',
                name: 'Lib',
                file: '/l/Lib.pretty',
                scope: 'global',
                readable: true
              }
            ],
            records: [
              {
                type: 'footprint',
                id: 'Lib:R',
                name: 'R',
                library: 'Lib',
                scope: 'global',
                file: '/l/Lib.pretty/R.kicad_mod'
              } as IndexRecord
            ]
          }),
        readFile: async (path) => {
          read.push(path)
          return '(footprint "R" (layer "F.Cu"))'
        }
      },
      board
    )
    expect(read).toEqual(['/l/Lib.pretty/R.kicad_mod'])
    expect(libraries.library('Lib')).toBe('ok')
    expect(libraries.library('Nowhere')).toBe('missing')
    expect(libraries.footprint('Lib', 'R')).toBeTruthy()
    // Its library is there and lacks it.
    expect(libraries.footprint('Lib', 'Gone')).toBeNull()
    expect(libraries.location?.('Lib')).toBe('/l/Lib.pretty')
  })
})
