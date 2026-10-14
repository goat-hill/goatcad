import { Worker } from 'worker_threads'
import datasheetWorkerPath from './datasheetWorker?modulePath'
import type { DatasheetWorkerResponse } from './datasheetWorker'
import type { DatasheetReadRequest, DatasheetReadResult } from './datasheetReader'

/**
 * Lazily shared datasheet worker, the way `stepLoader.ts` shares the STEP
 * worker. Nothing is loaded until the first read, and the worker is retired
 * after a quiet spell: an agent reads a datasheet in a burst, and the open
 * documents plus the module's heap are tens of megabytes worth giving back.
 */

const IDLE_MS = 60_000

let worker: Worker | null = null
let idleTimer: NodeJS.Timeout | null = null
let nextRequestId = 1
const pending = new Map<number, (result: DatasheetReadResult) => void>()

const failAllPending = (message: string): void => {
  for (const respond of pending.values()) respond({ ok: false, error: 'internal', message })
  pending.clear()
}

const retire = (): void => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (worker && pending.size === 0) {
    void worker.terminate()
    worker = null
  }
}

const touch = (): void => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(retire, IDLE_MS)
  idleTimer.unref()
}

const ensureWorker = (): Worker => {
  if (worker) return worker
  const spawned = new Worker(datasheetWorkerPath)
  spawned.on('message', (response: DatasheetWorkerResponse) => {
    const respond = pending.get(response.id)
    if (!respond) return
    pending.delete(response.id)
    respond(response.result)
    touch()
  })
  spawned.on('error', (err) => {
    failAllPending(err instanceof Error ? err.message : String(err))
    void spawned.terminate()
    if (worker === spawned) worker = null
  })
  spawned.on('exit', () => {
    failAllPending('datasheet worker exited unexpectedly')
    if (worker === spawned) worker = null
  })
  worker = spawned
  return spawned
}

export const readDatasheet = (request: DatasheetReadRequest): Promise<DatasheetReadResult> =>
  new Promise((resolve) => {
    const id = nextRequestId++
    pending.set(id, resolve)
    if (idleTimer) clearTimeout(idleTimer)
    ensureWorker().postMessage({ id, request })
  })
