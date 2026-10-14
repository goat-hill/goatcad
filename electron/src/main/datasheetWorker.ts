import { parentPort } from 'worker_threads'
import createPdfium from './wasm/pdfium.js'
import wasmPath from './wasm/pdfium.wasm?asset'
import {
  DatasheetReader,
  type DatasheetReadRequest,
  type DatasheetReadResult
} from './datasheetReader'

/** PDF reading off the main thread: pdfium parses and rasterizes synchronously,
 *  and a dense page costs tens of milliseconds the UI should not pay. */

export interface DatasheetWorkerRequest {
  id: number
  request: DatasheetReadRequest
}

export interface DatasheetWorkerResponse {
  id: number
  result: DatasheetReadResult
}

const port = parentPort
if (!port) throw new Error('datasheetWorker must run as a worker thread')

// The bundler copies the .wasm beside the chunks; the loader is told where.
const reader = new DatasheetReader(() => createPdfium({ locateFile: () => wasmPath }))

port.on('message', (message: DatasheetWorkerRequest) => {
  void reader.read(message.request).then((result) => {
    const response: DatasheetWorkerResponse = { id: message.id, result }
    port.postMessage(response)
  })
})
