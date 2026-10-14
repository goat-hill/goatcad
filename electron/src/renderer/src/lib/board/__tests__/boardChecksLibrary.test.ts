/**
 * Library parity: a board footprint against its library copy
 * (`footprintParity.ts`, `drc/rules/libraryParity.ts`), with the libraries
 * handed in as the editor hands them in.
 */
import { describe, expect, test, vi } from 'vitest'
import { parseKicadBoard, type KicadBoard } from '../../kicad/board'
import { parseKicadFootprint, type KicadFootprint } from '../../kicad/footprint'
import { serializeSExpr } from '../../kicad/sexpr'
import { DEFAULT_DESIGN_RULES, DEFAULT_NET_CLASSES } from '../../kicad/project'
import { BoardSpatialIndex } from '../spatialIndex'
import { boardChecks } from '../boardChecks'
import { flipBoardFootprintInAST } from '../footprintFlip'
import {
  boardLibrariesOf,
  readBoardLibraryData,
  type BoardLibraries,
  type BoardLibraryIo
} from '../boardLibraries'
import { buildLibraryView, type IndexLibrary, type IndexRecord } from '../../libraryIndex'
import { createLibraryFeed, touchesProjectLibraries } from '../../libraryFeed'
import { fileChange } from '../../projectBus'
import type { CheckResult } from '../../schematic/checks'

/** The library's part: a silkscreen line, a fab poly and rect, two pads and a hole. */
const LIBRARY = `(footprint "R" (layer "F.Cu") (attr smd)
  (fp_line (start -1 -0.5) (end 1 -0.5) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_poly (pts (xy -1 -1) (xy 1 -1) (xy 0 1)) (stroke (width 0.1) (type solid)) (fill yes) (layer "F.Fab"))
  (fp_rect (start -0.5 -0.3) (end 0.5 0.3) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab"))
  (pad "1" smd rect (at -1 0) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "2" smd rect (at 1 0 90) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "" np_thru_hole circle (at 0 2) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask")))`

/** The part placed at an angle: its children in its own frame, its pads' angles board-absolute. */
const placed = (angle = 0, edit: (text: string) => string = (text) => text): string => `
  (footprint "Lib:R" (layer "F.Cu") (uuid "fp-1") (at 120 120${angle ? ` ${angle}` : ''})
    (property "Reference" "R1" (at 0 0) (layer "F.Fab") (uuid "ref"))
    (attr smd)
    ${edit(`(fp_line (start 1 -0.5) (end -1 -0.5) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
    (fp_poly (pts (xy 0 1) (xy 1 -1) (xy -1 -1) (xy 0 1)) (stroke (width 0.1) (type solid)) (fill yes) (layer "F.Fab"))
    (fp_rect (start -0.5 -0.3) (end 0.5 0.3) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab"))
    (pad "1" smd rect (at -1 0 ${angle}) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
    (pad "2" smd rect (at 1 0 ${angle + 90}) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
    (pad "1" np_thru_hole circle (at 0 2 ${angle}) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask"))`)})`

const boardOf = (body: string): KicadBoard =>
  parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user)
    (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user) (7 "B.SilkS" user)
    (35 "F.Fab" user) (37 "B.Fab" user) (25 "Edge.Cuts" user))
  (net 0 "")
  ${body}
)`)

const libraries = (
  footprints: Record<string, KicadFootprint | null | undefined> = {
    'Lib:R': parseKicadFootprint(LIBRARY)
  }
): BoardLibraries => ({
  library: (nickname) => (nickname === 'Lib' ? 'ok' : 'missing'),
  footprint: (nickname, name) => footprints[`${nickname}:${name}`]
})

const run = (board: KicadBoard, libs: BoardLibraries | undefined = libraries()): CheckResult[] =>
  boardChecks({
    board,
    index: BoardSpatialIndex.build(board),
    connectivity: null,
    settings: {
      rules: { ...DEFAULT_DESIGN_RULES },
      classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
      patterns: [],
      assignments: []
    },
    libraries: libs
  }).filter((r) => r.code.startsWith('library-'))

const codes = (results: CheckResult[]): string[] => results.map((r) => r.code)

describe('library issues', () => {
  test('a library the project lacks, and a footprint its library lacks', () => {
    const missingLibrary = boardOf(placed().replace('"Lib:R"', '"Other:R"'))
    expect(codes(run(missingLibrary))).toEqual(['library-footprint-issue'])
    expect(codes(run(boardOf(placed()), libraries({ 'Lib:R': null })))).toEqual([
      'library-footprint-issue'
    ])
  })

  test('without the libraries, or before a library is read, the rules stay quiet', () => {
    expect(run(boardOf(placed()), undefined)).toEqual([])
    expect(run(boardOf(placed()), libraries({}))).toEqual([])
  })
})

describe('library mismatch', () => {
  test("a footprint as its library draws it matches, whichever way a line or poly runs, and an unplated hole's old number aside", () => {
    expect(run(boardOf(placed()))).toEqual([])
    expect(run(boardOf(placed(90)))).toEqual([])
  })

  test('a pad resized on the board no longer matches, and the finding says which', () => {
    const results = run(
      boardOf(placed(0, (text) => text.replace('(size 0.6 0.8)', '(size 0.7 0.8)')))
    )
    expect(codes(results)).toEqual(['library-footprint-mismatch'])
    expect(results[0].message).toContain('pad 1: size differs')
  })

  test('a graphic added on the board no longer matches', () => {
    const extra = (text: string): string =>
      `${text}\n    (fp_line (start 0 0) (end 1 1) (stroke (width 0.1) (type solid)) (layer "F.Fab"))`
    expect(codes(run(boardOf(placed(0, extra))))).toEqual(['library-footprint-mismatch'])
  })

  test('a footprint flipped to the back matches the library copy flipped the same way', () => {
    const board = boardOf(placed(30))
    flipBoardFootprintInAST(board, board.footprints[0], {
      x: board.footprints[0].position.x,
      y: board.footprints[0].position.y
    })
    const flipped = parseKicadBoard(serializeSExpr(board._raw))
    expect(flipped.footprints[0].layer).toBe('B.Cu')
    expect(run(flipped)).toEqual([])
  })

  test('off a quarter turn a rect saved as a poly a nanometer off still matches; at a quarter turn it is another shape', () => {
    const asPoly = (text: string): string =>
      text.replace(
        '(fp_rect (start -0.5 -0.3) (end 0.5 0.3) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab"))',
        '(fp_poly (pts (xy -0.5 -0.3) (xy 0.5 -0.3) (xy 0.5 0.3) (xy -0.499999 0.3)) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab"))'
      )
    expect(run(boardOf(placed(45, asPoly)))).toEqual([])
    expect(codes(run(boardOf(placed(0, asPoly))))).toEqual(['library-footprint-mismatch'])
  })
})

describe('a library registered while the board is open', () => {
  test('clears library-footprint-issue once the project layer is re-read', async () => {
    vi.useFakeTimers()
    try {
      const board = boardOf(placed())
      const lib: IndexLibrary = {
        type: 'footprint',
        name: 'Lib',
        file: '/p/Lib.pretty',
        scope: 'project',
        readable: true
      }
      const record = {
        type: 'footprint',
        id: 'Lib:R',
        name: 'R',
        library: 'Lib',
        scope: 'project',
        file: '/p/Lib.pretty/R.kicad_mod'
      } as IndexRecord
      let view = buildLibraryView({ libraries: [], records: [] })
      const io: BoardLibraryIo = {
        libraries: async () => view,
        readFile: async (path) => (path === record.file ? LIBRARY : null)
      }
      let libs: BoardLibraries | undefined
      const feed = createLibraryFeed(
        () => readBoardLibraryData(io, board),
        (data) => (libs = data && boardLibrariesOf(data))
      )
      feed.refresh()
      await feed.ready()
      expect(codes(run(board, libs))).toEqual(['library-footprint-issue'])

      // footprint_create writes Lib.pretty and registers it in fp-lib-table, then announces it.
      view = buildLibraryView({ libraries: [lib], records: [record] })
      expect(touchesProjectLibraries([fileChange('file-created', record.file)])).toBe(true)
      feed.refreshSoon()
      const ready = feed.ready()
      await vi.advanceTimersByTimeAsync(150)
      await ready
      expect(run(board, libs)).toEqual([])
      feed.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
