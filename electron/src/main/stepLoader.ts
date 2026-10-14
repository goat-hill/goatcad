import { Worker } from 'worker_threads'
import stepWorkerPath from './stepWorker?modulePath'
import type { StepWorkerResponse } from './stepWorker'
import type { StepLoadResult } from '../preload/modelTypes'

/** Lazily shared STEP worker; request ids keep concurrent loads separate. */

let worker: Worker | null = null
let nextRequestId = 1
const pending = new Map<number, (result: StepLoadResult) => void>()

const failAllPending = (error: string): void => {
  for (const respond of pending.values()) {
    respond({ success: false, error, meshes: [] })
  }
  pending.clear()
}

const ensureWorker = (): Worker => {
  if (worker) return worker
  const spawned = new Worker(stepWorkerPath)
  spawned.on('message', (response: StepWorkerResponse) => {
    const respond = pending.get(response.id)
    if (!respond) return
    pending.delete(response.id)
    respond({ success: response.success, error: response.error, meshes: response.meshes })
  })
  spawned.on('error', (err) => {
    failAllPending(err instanceof Error ? err.message : String(err))
    void spawned.terminate()
    if (worker === spawned) worker = null
  })
  spawned.on('exit', () => {
    failAllPending('STEP worker exited unexpectedly')
    if (worker === spawned) worker = null
  })
  worker = spawned
  return spawned
}

export const loadStepFile = (filePath: string): Promise<StepLoadResult> =>
  new Promise((resolve) => {
    const id = nextRequestId++
    pending.set(id, resolve)
    ensureWorker().postMessage({ id, path: filePath })
  })
