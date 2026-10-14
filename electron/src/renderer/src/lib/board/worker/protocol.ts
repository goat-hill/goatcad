/**
 * Messages between a board session and its board worker
 * (docs/performance-workstream.md, "The board worker"). The worker keeps its
 * own copy of the board: it is sent the text once, then each change as the
 * top-level items it touched, every item named by an id both sides assign.
 * Jobs run against one revision and every result carries it; a newer
 * revision, published through the shared control word, cancels a running job.
 */
import type { Nm } from '../../kicad/coordinates'
import type { BoardDesignSettings } from '../../kicad/project'
import type { CheckResult } from '../../schematic/checks'
import type { Airwire } from '../boardConnectivity'
import type { BoardLibraryData } from '../boardLibraries'
import type { SchematicNetlist } from '../schematicNetlist'

/**
 * The shared control word: index 0 holds the session's latest revision, read
 * by a running job without waiting on the queue. Every message that moves the
 * revision carries it too, which is all a worker has where the page is not
 * cross-origin isolated.
 */
export const CONTROL_REVISION = 0
export const CONTROL_WORDS = 1

/** How a change came about, which decides what the worker owes it. */
export type ChangeKind =
  /** An edit: it may leave zones to refill. */
  | 'command'
  /** A refill's own commit: the fills it computed, now in the board. */
  | 'refill'
  /** Undo or redo: the board as a snapshot left it; nothing is owed a refill. */
  | 'snapshot'

export type ToWorker =
  | { type: 'init'; control: ArrayBufferLike }
  | { type: 'load'; revision: number; text: string; ids: Int32Array }
  | {
      type: 'change'
      revision: number
      kind: ChangeKind
      /** Every top-level item, in order, by id. */
      order: Int32Array
      /** The text of each item the worker does not hold as it now is. */
      texts: Array<[number, string]>
    }
  | {
      type: 'refill'
      revision: number
      job: number
      settings: BoardDesignSettings
      /** Past this many ms an auto pass commits what it has. */
      budgetMs?: number
    }
  | {
      type: 'check'
      revision: number
      job: number
      /** Changes when the settings do, so the worker can tell a whole run is owed. */
      settingsVersion: number
      /** Sent when `settingsVersion` is new to the worker; it keeps the last. */
      settings?: BoardDesignSettings
      /** The libraries and the schematic likewise: sent when their version moves. */
      librariesVersion: number
      libraries?: BoardLibraryData | null
      schematicVersion: number
      schematic?: SchematicNetlist | null
      /** Check the whole board, whatever the last run kept. */
      whole: boolean
    }
  | { type: 'unload'; revision: number }

/** One step of a job as it ran: a check's phase, a refill's zone. */
export interface JobSpan {
  name: string
  /** Ms since the epoch, so the page can place it on its own clock. */
  start: number
  ms: number
}

/** A zone's new fill: its polygons' points, x and y interleaved, in nm. */
export interface FillPoly {
  layer: string
  points: Int32Array
}

/** A fill polygon as the board writes it. */
export const unpackFillPoly = (
  poly: FillPoly
): { layer: string; points: Array<{ x: Nm; y: Nm }> } => {
  const points: Array<{ x: Nm; y: Nm }> = new Array(poly.points.length / 2)
  for (let i = 0; i < points.length; i++) {
    points[i] = { x: poly.points[2 * i] as Nm, y: poly.points[2 * i + 1] as Nm }
  }
  return { layer: poly.layer, points }
}

export type FromWorker =
  | { type: 'loaded'; revision: number; ok: boolean; error?: string }
  | {
      type: 'connectivity'
      revision: number
      airwires: Airwire[]
      unrouted: number
      ms: number
      started: number
    }
  | {
      type: 'refilled'
      revision: number
      job: number
      /** Null when cancelled, or when the edits since the last refill reach no zone. */
      fills: Array<{ zone: string; polys: FillPoly[] }> | null
      /** Zones the budget left unfilled. */
      remaining: number
      ms: number
      /** When the job started, ms since the epoch: the page places its spans from it. */
      started: number
      /** Each zone's fill as it ran, in order; empty for a job that did not finish. */
      spans: JobSpan[]
      /** Why a job that threw has no answer. */
      error?: string
    }
  | {
      type: 'checked'
      revision: number
      job: number
      results: CheckResult[] | null
      ms: number
      started: number
      /** The ratsnest it waited for and each phase of the check, in order. */
      spans: JobSpan[]
      error?: string
    }
  /** How far a running check or refill has got, 0–1. */
  | { type: 'progress'; job: number; done: number }
  /** The worker's copy no longer follows the session's board. */
  | { type: 'error'; message: string }
