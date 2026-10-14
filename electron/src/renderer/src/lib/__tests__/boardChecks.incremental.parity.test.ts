/**
 * Checking round an edit against checking the whole board, over KiCad's
 * corpus (`board/drc/incremental.ts`): seeded edits to each board — moves,
 * deletions, new tracks and vias, a refill that loses an island — each checked
 * both ways and compared, one edit per check and three folded into one. The default suite holds the same on the sample
 * project; this reads KiCad's boards in place, so it is a parity suite, and
 * needs no KiCad installed. `PARITY_EDITS` sets the edits per board (8).
 */
import { readFileSync } from 'fs'
import { basename } from 'path'
import { beforeAll, describe, expect, test } from 'vitest'
import { loadClipper } from '../geometry/clip'
import { parseKicadBoard } from '../kicad/board'
import { boardRules } from '../board/rules/boardRules'
import { customRulesOf, parityBoards, settingsFor } from './parityBoards'
import { incrementalMismatches } from '../board/__tests__/incrementalHarness'
import { budgetFor, PARITY_TEST_TIMEOUT_MS } from './parityBudget'

const EDITS = Number(process.env.PARITY_EDITS ?? 8)

describe('board checks round an edit against the whole board', () => {
  beforeAll(async () => {
    await loadClipper()
  })

  for (const boardFile of parityBoards()) {
    test(basename(boardFile), { timeout: PARITY_TEST_TIMEOUT_MS }, (ctx) => {
      const budget = budgetFor('incremental', boardFile)
      const text = readFileSync(boardFile, 'utf8')
      const settings = settingsFor(boardFile)
      const customRules = customRulesOf(boardFile)
      let board
      try {
        board = parseKicadBoard(text)
      } catch {
        return ctx.skip('not a board this parser reads')
      }
      if (customRules && boardRules(board, settings, customRules).customRules.unsupported.length)
        return ctx.skip('its custom rules use what is not read yet')
      expect(incrementalMismatches(text, settings, customRules, 1, EDITS, 1, budget)).toEqual([])
      // Several edits folded into one check, as the editor folds a move and its refill.
      expect(incrementalMismatches(text, settings, customRules, 2, 3, 3, budget)).toEqual([])
    })
  }
})
