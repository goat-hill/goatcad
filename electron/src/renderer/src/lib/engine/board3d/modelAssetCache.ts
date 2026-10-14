/**
 * Board-scoped cache for decoded STEP/VRML assets.
 *
 * The cache owns templates, while viewport scenes own only lightweight clones.
 * It deliberately survives Layout <-> 3D mode changes and is disposed when the
 * PCB viewport itself goes away. Limits are measured after decoding because a
 * STEP file's byte size says very little about its tessellated size.
 */

import * as THREE from 'three'
import type { KicadBoard } from '../../kicad/board'
import { buildStepGroup, buildVrmlGroup } from '../modelGeometry'

export const DEFAULT_MODEL_ASSET_BUDGET_BYTES = 256 * 1024 * 1024
export const DEFAULT_SINGLE_MODEL_BUDGET_BYTES = 64 * 1024 * 1024

const WARM_CONCURRENCY = 2

const isVrml = (path: string): boolean => path.toLowerCase().endsWith('.wrl')

const bridge = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

export interface ModelAssetCacheOptions {
  totalBudgetBytes?: number
  singleModelBudgetBytes?: number
}

export interface ModelAssetCacheStats {
  entries: number
  decodedBytes: number
  rejected: number
}

/** Byte size of the unique GPU-style arrays represented by a model template. */
export function decodedGeometryBytes(root: THREE.Object3D): number {
  const seen = new Set<THREE.BufferGeometry>()
  let bytes = 0
  root.traverse((object) => {
    const geometry = (object as THREE.Mesh).geometry
    if (!geometry || seen.has(geometry)) return
    seen.add(geometry)
    for (const attribute of Object.values(geometry.attributes)) {
      bytes += attribute.array.byteLength
    }
    if (geometry.index) bytes += geometry.index.array.byteLength
  })
  return bytes
}

export class BoardModelAssetCache {
  private readonly entries = new Map<string, Promise<THREE.Object3D | null>>()
  private readonly totalBudgetBytes: number
  private readonly singleModelBudgetBytes: number
  private decodedBytes = 0
  private rejected = 0
  private disposed = false
  private warmRun = 0

  constructor(options: ModelAssetCacheOptions = {}) {
    this.totalBudgetBytes = options.totalBudgetBytes ?? DEFAULT_MODEL_ASSET_BUDGET_BYTES
    this.singleModelBudgetBytes =
      options.singleModelBudgetBytes ?? DEFAULT_SINGLE_MODEL_BUDGET_BYTES
  }

  get stats(): ModelAssetCacheStats {
    return {
      entries: this.entries.size,
      decodedBytes: this.decodedBytes,
      rejected: this.rejected
    }
  }

  /** Resolve and decode one link at most once for this board context. */
  template(
    link: string,
    boardPath: string | null,
    projectDir: string | null
  ): Promise<THREE.Object3D | null> {
    if (this.disposed || !link) return Promise.resolve(null)
    const key = `${boardPath ?? ''}\0${projectDir ?? ''}\0${link}`
    const cached = this.entries.get(key)
    if (cached) return cached

    const pending = this.load(link, boardPath, projectDir)
    this.entries.set(key, pending)
    return pending
  }

  /**
   * Warm every distinct model referenced by a board without creating placed
   * scene nodes or uploading anything to a renderer. Small bounded batches
   * keep board opening and editing responsive.
   */
  async warm(
    board: KicadBoard,
    boardPath: string | null,
    projectDir: string | null
  ): Promise<void> {
    const run = ++this.warmRun
    const links = [
      ...new Set(
        board.footprints
          .map((footprint) => footprint.footprint.model?.path.trim())
          .filter((link): link is string => !!link)
      )
    ]
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.disposed || run !== this.warmRun) return
        const link = links[next++]
        if (!link) return
        await this.template(link, boardPath, projectDir)
        // Parsing VRML and materializing groups happens on this thread.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(WARM_CONCURRENCY, links.length) }, () => worker())
    )
  }

  cancelWarm(): void {
    this.warmRun++
  }

  private async load(
    link: string,
    boardPath: string | null,
    projectDir: string | null
  ): Promise<THREE.Object3D | null> {
    const api = bridge()
    if (!api) return null
    try {
      const resolved = await api.resolveModelPath(link, boardPath, projectDir)
      if ('notFound' in resolved || this.disposed) return null
      let template: THREE.Object3D | null
      if (isVrml(resolved.path)) {
        const file = await api.readFile(resolved.path)
        template = file.success && file.content !== undefined ? buildVrmlGroup(file.content) : null
      } else {
        const step = await api.loadStepModel(resolved.path)
        template = step.success ? buildStepGroup(step.meshes) : null
      }
      if (!template || this.disposed) {
        if (template) disposeTree(template)
        return null
      }

      const bytes = decodedGeometryBytes(template)
      if (
        bytes > this.singleModelBudgetBytes ||
        this.decodedBytes + bytes > this.totalBudgetBytes
      ) {
        this.rejected++
        disposeTree(template)
        return null
      }
      this.decodedBytes += bytes
      return template
    } catch (err) {
      console.error(`Failed to load 3D model ${link}:`, err)
      return null
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelWarm()
    for (const pending of this.entries.values()) {
      void pending.then((template) => {
        if (template) disposeTree(template)
      })
    }
    this.entries.clear()
    this.decodedBytes = 0
  }
}

export function disposeTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  root.traverse((object) => {
    const mesh = object as Partial<THREE.Mesh> & THREE.Object3D
    if (mesh.geometry) geometries.add(mesh.geometry)
    const material = mesh.material
    for (const entry of Array.isArray(material) ? material : material ? [material] : []) {
      materials.add(entry)
    }
  })
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
}
