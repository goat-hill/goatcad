/**
 * Messages between the page and the schematic check worker
 * (`checkWorkerHost.ts`). The worker keeps a parsed copy of each sheet file it
 * has been sent, by path, and is sent a file's text again only when it
 * changed; a job names the design's sheet instances over those files and
 * answers with the findings of the checks that read the sheets alone
 * (`sheetChecks`). One job runs at a time, so there is nothing to cancel: the
 * host holds back a newer request until the one running answers.
 */
import type { Nm } from '../../kicad/coordinates'
import type { CheckResult, PinMap } from '../checks'
import type { ProjectNaming } from '../connectivity'

/** One sheet instance of the design, over a file the worker holds. */
export interface CheckInstance {
  file: string
  sheetPath: string
  namePath: string
  sheetName?: string
  page?: string
}

export interface CheckRequest {
  /** The design's sheet instances, in the order the graph is built from. */
  instances: CheckInstance[]
  naming: ProjectNaming
  grid: Nm
  pinMap: PinMap
  netclasses?: readonly string[]
  textVariables?: Readonly<Record<string, string>>
}

export type ToWorker = {
  type: 'check'
  job: number
  /** Each file whose text the worker does not hold as it now is. */
  texts: Array<[string, string]>
  /** Files the worker may let go of. */
  drop: string[]
} & CheckRequest

export type FromWorker =
  | { type: 'checked'; job: number; results: CheckResult[]; ms: number }
  /** The job threw; it answers no findings, and says why. */
  | { type: 'failed'; job: number; message: string }
