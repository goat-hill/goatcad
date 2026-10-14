import { readFileSync } from 'fs'
import { parentPort } from 'worker_threads'
import occtimportjs, { type OcctImportModule } from 'occt-import-js'
import { toStepMeshes } from './stepMesh'
import type { StepLoadResult } from '../preload/modelTypes'

/**
 * STEP tessellation worker: synchronous OpenCascade work stays off the main thread.
 * Main process, not renderer: Node loads the wasm from node_modules directly, while
 * the renderer's CSP has no `wasm-unsafe-eval` and packaged `file://` wasm fetches
 * are fragile.
 */

interface StepWorkerRequest {
  id: number
  path: string
}

export type StepWorkerResponse = StepLoadResult & { id: number }

let occtPromise: Promise<OcctImportModule> | null = null
const occt = (): Promise<OcctImportModule> => {
  occtPromise ??= occtimportjs()
  return occtPromise
}

const port = parentPort
if (!port) throw new Error('stepWorker must run as a worker thread')

port.on('message', (request: StepWorkerRequest) => {
  void (async (): Promise<void> => {
    try {
      const content = readFileSync(request.path)
      const module = await occt()
      const result = module.ReadStepFile(new Uint8Array(content), null)
      const meshes = toStepMeshes(result)
      const transfers: ArrayBuffer[] = []
      for (const mesh of meshes) {
        transfers.push(mesh.positions.buffer as ArrayBuffer, mesh.indices.buffer as ArrayBuffer)
        if (mesh.normals) transfers.push(mesh.normals.buffer as ArrayBuffer)
      }
      const response: StepWorkerResponse = { id: request.id, success: true, meshes }
      port.postMessage(response, transfers)
    } catch (err: unknown) {
      const response: StepWorkerResponse = {
        id: request.id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        meshes: []
      }
      port.postMessage(response)
    }
  })()
})
