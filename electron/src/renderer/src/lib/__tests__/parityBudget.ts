/**
 * How long a parity suite may spend on one board. Our side runs synchronously,
 * so vitest's timeout cannot stop it: a board past its budget throws from
 * inside the run instead, naming where it was, and the suite moves on. A loop
 * that never yields is caught by `bin/test-parity`'s wall clock instead.
 *
 * `PARITY_BUDGET_S` sets every budget at once (for profiling a slow board).
 */
import { basename } from 'path'

export type ParitySuite = 'board' | 'fill' | 'incremental'

/** Seconds per board, each several times the slowest board measured on a laptop. */
const DEFAULT_S: Record<ParitySuite, number> = { board: 30, fill: 60, incremental: 60 }

/**
 * Boards measured well past their suite's default, by file name, each at about
 * twice its measured time (seconds measured in a comment).
 */
const SLOW_S: Partial<Record<ParitySuite, Record<string, number>>> = {
  board: {
    // 30, the demos' copy; the QA copy, 7.
    'vme-wren.kicad_pcb': 60
  },
  fill: {
    // 57, the demos' copy.
    'vme-wren.kicad_pcb': 120,
    // 40.
    'issue21482.kicad_pcb': 90
  },
  incremental: {
    // 197: a whole check is ~20 s, and each edit is checked both ways.
    'jetson-agx-thor-baseboard.kicad_pcb': 420,
    // 354: a whole check spends ~14 s spanning its largest net's ratsnest.
    '8851_HW-U1-VCU118_REV2-0_071417.kicad_pcb': 600,
    // 459, the demos' copy (its fills stored, a whole check ~25 s); the QA copy, 56.
    'vme-wren.kicad_pcb': 900,
    // 67.
    'issue22475.kicad_pcb': 150
  }
}

/** Vitest's timeout for a parity test: it bounds the awaits (kicad-cli), never our synchronous run. */
export const PARITY_TEST_TIMEOUT_MS = 600_000

export interface Budget {
  /** Throws once the budget is spent, saying `where` the run had got to. */
  check(where: () => string): void
  /** Drains a stepped run, checking the budget at each step. */
  drain<T>(steps: Generator<unknown, T>, where: () => string): T
}

export function budgetFor(suite: ParitySuite, boardFile: string): Budget {
  const override = Number(process.env.PARITY_BUDGET_S)
  const seconds =
    override > 0 ? override : (SLOW_S[suite]?.[basename(boardFile)] ?? DEFAULT_S[suite])
  const deadline = Date.now() + seconds * 1000
  const check = (where: () => string): void => {
    if (Date.now() > deadline)
      throw new Error(`${basename(boardFile)} is past its ${seconds} s ${suite} budget, ${where()}`)
  }
  return {
    check,
    drain(steps, where) {
      let step = steps.next()
      while (!step.done) {
        check(where)
        step = steps.next()
      }
      return step.value
    }
  }
}
