import { beforeAll, describe, expect, test } from 'vitest'
import { loadClipper } from '../../geometry/clip'
import { kicadDefaultSettings } from '../../__tests__/parityBoards'
import { parseKicadBoard } from '../../kicad/board'
import { BoardSpatialIndex } from '../spatialIndex'
import { computeConnectivity } from '../boardConnectivity'
import { boardChecks } from '../boardChecks'
import { incrementalMismatches } from './incrementalHarness'
import { incrementalBoard, incrementalRules } from './incrementalBoard'

// The contrived board keeps this per-commit run fast; the parity suite holds
// the same harness to the sample project and KiCad's corpus
// (boardChecks.incremental.parity.test.ts).
beforeAll(async () => {
  await loadClipper()
})

describe('checking round an edit', () => {
  const text = incrementalBoard()
  const settings = kicadDefaultSettings()

  test('the board has findings for the edits to make and clear', () => {
    const board = parseKicadBoard(text)
    const index = BoardSpatialIndex.build(board)
    const codes = new Set(
      boardChecks({
        board,
        index,
        connectivity: computeConnectivity(board, index),
        settings,
        customRules: incrementalRules
      }).map((r) => r.code)
    )
    expect(codes.size).toBeGreaterThanOrEqual(3)
  })

  test('equals checking the whole board, edit after edit', () => {
    for (const seed of [1, 2, 3, 4]) {
      expect(incrementalMismatches(text, settings, incrementalRules, seed, 12)).toEqual([])
    }
  })

  test('equals it with several edits folded into one check, as the editor folds a move and its refill', () => {
    expect(incrementalMismatches(text, settings, incrementalRules, 7, 8, 3)).toEqual([])
  })
})
