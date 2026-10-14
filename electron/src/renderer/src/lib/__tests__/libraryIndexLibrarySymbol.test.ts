import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  clearProjectIndex,
  findLibrarySymbol,
  findSymbol,
  loadIndex,
  loadProjectIndex
} from '../libraryIndex'
import type { SymbolRecord } from '../libraryIndex'

const sym = (id: string, file: string, scope: SymbolRecord['scope']): SymbolRecord => ({
  type: 'symbol',
  id,
  name: id.split(':')[1],
  library: id.split(':')[0],
  scope,
  file,
  isPower: false,
  value: '',
  description: '',
  keywords: '',
  datasheet: '',
  footprint: '',
  fpFilters: [],
  pins: 2
})

const SYSTEM = [
  sym('Connector:RJ11', '/kicad/Connector.kicad_sym', 'system'),
  sym('Connector:6P4C', '/kicad/Connector.kicad_sym', 'system')
]
let project: SymbolRecord[] = []

beforeEach(() => {
  project = []
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      getLibraryIndex: async () => ({ records: SYSTEM, libraries: [] }),
      getProjectIndex: async (): Promise<{ records: SymbolRecord[] }> => ({ records: project })
    }
  }
})

afterEach(() => {
  clearProjectIndex()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('findLibrarySymbol', () => {
  it('answers with the library a sheet-embedded symbol comes from', async () => {
    await loadIndex(true)
    project = [sym('Connector:RJ11', '/proj/board.kicad_sch', 'project')]
    await loadProjectIndex('/proj')

    // The union shows the design's own copy; a loader must get the library.
    expect(findSymbol('Connector:RJ11')?.file).toBe('/proj/board.kicad_sch')
    expect(findLibrarySymbol('Connector:RJ11')?.file).toBe('/kicad/Connector.kicad_sym')
  })

  it('has nothing for a symbol only a sheet carries', async () => {
    await loadIndex(true)
    project = [sym('Gone:Part', '/proj/board.kicad_sch', 'project')]
    await loadProjectIndex('/proj')
    expect(findSymbol('Gone:Part')).toBeDefined()
    expect(findLibrarySymbol('Gone:Part')).toBeUndefined()
  })

  it('prefers a project library over the system one, and follows a reload', async () => {
    await loadIndex(true)
    expect(findLibrarySymbol('Connector:6P4C')?.scope).toBe('system')

    project = [sym('Connector:6P4C', '/proj/Connector.kicad_sym', 'project')]
    await loadProjectIndex('/proj')
    expect(findLibrarySymbol('Connector:6P4C')?.file).toBe('/proj/Connector.kicad_sym')

    clearProjectIndex()
    expect(findLibrarySymbol('Connector:6P4C')?.scope).toBe('system')
  })
})
