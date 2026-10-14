import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { StepMeshData } from '../../../../../../preload/modelTypes'
import { BoardModelAssetCache, decodedGeometryBytes } from '../modelAssetCache'

const mesh = (): StepMeshData => ({
  name: 'triangle',
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  color: null,
  faceColors: []
})

const installApi = (): Mock => {
  const loadStepModel = vi.fn(async () => ({ success: true, meshes: [mesh()] }))
  vi.stubGlobal('window', {
    api: {
      resolveModelPath: vi.fn(async (link: string) => ({ path: `/models/${link}` })),
      loadStepModel,
      readFile: vi.fn()
    }
  })
  return loadStepModel
}

afterEach(() => vi.unstubAllGlobals())

describe('BoardModelAssetCache', () => {
  it('deduplicates a decoded template in one board context', async () => {
    const loadStepModel = installApi()
    const cache = new BoardModelAssetCache()

    const [first, second] = await Promise.all([
      cache.template('part.step', '/boards/a.kicad_pcb', '/boards'),
      cache.template('part.step', '/boards/a.kicad_pcb', '/boards')
    ])

    expect(first).toBe(second)
    expect(loadStepModel).toHaveBeenCalledOnce()
    expect(cache.stats.entries).toBe(1)
    expect(cache.stats.decodedBytes).toBe(decodedGeometryBytes(first!))
    cache.dispose()
  })

  it('rejects geometry after the decoded board budget is exhausted', async () => {
    installApi()
    // One triangle is 84 bytes: 36 positions + 36 normals + 12 indices.
    const cache = new BoardModelAssetCache({ totalBudgetBytes: 100 })

    expect(await cache.template('first.step', null, null)).not.toBeNull()
    expect(await cache.template('second.step', null, null)).toBeNull()
    expect(cache.stats.decodedBytes).toBe(84)
    expect(cache.stats.rejected).toBe(1)
    cache.dispose()
  })
})
