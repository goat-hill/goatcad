/**
 * The board worker's entry: one per open board, started by its session's host
 * (`boardWorkerHost.ts`). Messages are handled in arrival order; a job yields
 * between slices, so a change that arrives mid-job is applied before the job
 * looks at the control word and finds itself superseded.
 */
import { setDetachedAtoms } from '../../kicad/sexpr'
import { BoardWorkerEngine } from './boardWorkerEngine'
import type { FromWorker, ToWorker } from './protocol'

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage: (message: FromWorker, transfer?: Transferable[]) => void
}

// The worker has no use for the board's text once parsed: let it go.
setDetachedAtoms(true)

const engine = new BoardWorkerEngine((message, transfer) =>
  scope.postMessage(message, transfer ?? [])
)

scope.onmessage = (e: MessageEvent<ToWorker>): void => {
  engine.handle(e.data).catch((error: unknown) => {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? (error.stack ?? error.message) : String(error)
    })
  })
}
