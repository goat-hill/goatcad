import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  loadIndex,
  markIndexStale,
  indexGeneration,
  indexRecords,
  projectIndexRecords,
  loadProjectIndex,
  clearProjectIndex
} from '../libraryIndex'
import type { SymbolRecord } from '../libraryIndex'

const sym = (id: string): SymbolRecord => ({
  type: 'symbol',
  id,
  name: id.split(':')[1],
  library: id.split(':')[0],
  scope: 'global',
  file: `/s/${id}.kicad_sym`,
  isPower: false,
  value: '',
  description: '',
  keywords: '',
  datasheet: '',
  footprint: '',
  fpFilters: [],
  pins: 2
})

/** Records main will serve next, plus a call counter and a manual gate. */
let served: SymbolRecord[] = []
let projectServed: SymbolRecord[] = []
let fetches = 0
let gate: Promise<void> | null = null
let openGate: (() => void) | null = null

/** Hold the next fetch open until the returned function is called. */
const closeGate = (): (() => void) => {
  gate = new Promise<void>((resolve) => {
    openGate = resolve
  })
  return () => {
    openGate?.()
    gate = null
  }
}

const stubApi = (): void => {
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      getLibraryIndex: async () => {
        fetches++
        if (gate) await gate
        return { records: served, libraries: [] }
      },
      getProjectIndex: async (): Promise<{ records: SymbolRecord[] }> => ({
        records: projectServed
      })
    }
  }
}

beforeEach(() => {
  served = [sym('Device:R')]
  projectServed = []
  fetches = 0
  gate = null
  openGate = null
  stubApi()
})

afterEach(() => {
  clearProjectIndex()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('index staleness', () => {
  it('serves cached records until something announces a change', async () => {
    await loadIndex()
    await loadIndex()
    expect(fetches).toBe(1)

    // A library was added: the very next load must refetch, rather than
    // no-opping on the `loaded` flag as it did before (workstream §6.2).
    served = [sym('Device:R'), sym('MyLib:Part')]
    markIndexStale()
    await loadIndex()

    expect(fetches).toBe(2)
    expect(indexRecords().map((r) => r.id)).toContain('MyLib:Part')
  })

  it('bumps the generation on every invalidation, so cached consumers can compare', async () => {
    await loadIndex()
    const before = indexGeneration()
    markIndexStale()
    expect(indexGeneration()).toBeGreaterThan(before)
  })

  it('settles back to cached reads once the reload lands', async () => {
    await loadIndex()
    markIndexStale()
    await loadIndex()
    await loadIndex()
    expect(fetches).toBe(2)
  })

  it('keeps a change announced mid-fetch from being swallowed by that fetch', async () => {
    await loadIndex()
    markIndexStale()

    // Hold the reload open, then announce another change while it is in flight:
    // the records being returned predate that change, so staleness must survive.
    const release = closeGate()
    const pending = loadIndex()
    markIndexStale()
    release()
    await pending

    served = [sym('Device:R'), sym('Later:Part')]
    await loadIndex()
    expect(indexRecords().map((r) => r.id)).toContain('Later:Part')
  })
})

describe('project-scope records', () => {
  const projectSym = { ...sym('MyProjLib:Part'), scope: 'project' as const }

  it('are reachable through their own accessor, not through indexRecords', async () => {
    // The two sets are stored apart so either can reload without the other.
    // Filtering indexRecords() by scope silently returns nothing for project
    // scope, which is exactly how the Project pane shipped empty once.
    projectServed = [projectSym]
    await loadIndex()
    await loadProjectIndex('/hw/psu')

    expect(projectIndexRecords().map((r) => r.id)).toEqual(['MyProjLib:Part'])
    expect(indexRecords().some((r) => r.scope === 'project')).toBe(false)
  })

  it('are dropped when the project closes', async () => {
    projectServed = [projectSym]
    await loadProjectIndex('/hw/psu')
    expect(projectIndexRecords()).toHaveLength(1)

    clearProjectIndex()
    expect(projectIndexRecords()).toHaveLength(0)
  })
})
