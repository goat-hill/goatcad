/**
 * The schematic check worker's entry: one for the app, started by
 * `checkWorkerHost.ts` on the first check a schematic view asks for.
 */
import { setDetachedAtoms } from '../../kicad/sexpr'
import { CheckWorkerEngine } from './checkWorkerEngine'
import type { FromWorker, ToWorker } from './protocol'

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage: (message: FromWorker) => void
}

// The worker has no use for a sheet's text once parsed: let it go.
setDetachedAtoms(true)

const engine = new CheckWorkerEngine()

scope.onmessage = (e: MessageEvent<ToWorker>): void => {
  scope.postMessage(engine.handle(e.data))
}
