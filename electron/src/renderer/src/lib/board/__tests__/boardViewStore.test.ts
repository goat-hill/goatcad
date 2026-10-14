import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  adoptBoardLayers,
  autoTrackWidthFor,
  boardViewFor,
  boardViewReady,
  clearBoardViews,
  prefetchBoardView
} from '../boardViewStore'
import { extractBoardLocalView } from '../../kicad/projectLocal'
import type { KicadBoardLayer } from '../../kicad/board'

const LAYERS: KicadBoardLayer[] = [
  { ordinal: 0, name: 'F.Cu', type: 'signal' },
  { ordinal: 2, name: 'B.Cu', type: 'signal' },
  { ordinal: 5, name: 'F.SilkS', type: 'user' },
  { ordinal: 25, name: 'Edge.Cuts', type: 'user' },
  { ordinal: 35, name: 'F.Fab', type: 'user' }
]

const BOARD = '/w/canary.kicad_pcb'

/** Files the stubbed bridge can see, and what it was asked to write. */
let files: Record<string, string>
let written: Array<{ path: string; content: string }>

const stubBridge = (): void => {
  files = { '/w/canary.kicad_pro': '{}' }
  written = []
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      readFile: async (path: string) =>
        files[path] !== undefined
          ? { success: true, content: files[path] }
          : { success: false, error: 'ENOENT' },
      createFile: async (path: string, content: string) => {
        files[path] = content
        written.push({ path, content })
        return { success: true }
      },
      readDirectory: async () => []
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  clearBoardViews()
  stubBridge()
})

afterEach(() => {
  vi.useRealTimers()
  clearBoardViews()
  delete (globalThis as unknown as { window?: unknown }).window
})

/** Let the store's reads resolve, then fire the debounced write and let it finish. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1000)
}

describe('seeding from the board', () => {
  test('hides the annotation layers KiCad hides, and keeps the rest', async () => {
    await adoptBoardLayers(BOARD, LAYERS)
    const view = boardViewFor(BOARD)
    expect(view.layerVisibility).toEqual({
      'F.Cu': true,
      'B.Cu': true,
      'F.SilkS': true,
      'Edge.Cuts': true,
      'F.Fab': false
    })
    expect(view.activeLayer).toBe('F.Cu')
  })

  test('survives the editor being torn down and rebuilt', async () => {
    await adoptBoardLayers(BOARD, LAYERS)
    boardViewFor(BOARD).layerVisibility = { ...boardViewFor(BOARD).layerVisibility, 'F.Fab': true }
    // What a tab switch does: the component goes, the store stays.
    await adoptBoardLayers(BOARD, LAYERS)
    expect(boardViewFor(BOARD).layerVisibility['F.Fab']).toBe(true)
  })

  test('keeps two boards apart', async () => {
    await adoptBoardLayers(BOARD, LAYERS)
    await adoptBoardLayers('/w/other.kicad_pcb', LAYERS)
    boardViewFor(BOARD).activeLayer = 'B.Cu'
    expect(boardViewFor('/w/other.kicad_pcb').activeLayer).toBe('F.Cu')
  })
})

describe('the .kicad_prl beside the project', () => {
  test('is not written by merely opening a board', async () => {
    await adoptBoardLayers(BOARD, LAYERS)
    await settle()
    expect(written).toEqual([])
  })

  test('is created on the first change, named off the project stem', async () => {
    await adoptBoardLayers(BOARD, LAYERS)
    boardViewFor(BOARD).nonActiveDisplay = 'dim'
    await settle()
    expect(written.map((write) => write.path)).toEqual(['/w/canary.kicad_prl'])
    const view = extractBoardLocalView(written[0].content, LAYERS)
    expect(view?.nonActiveDisplay).toBe('dim')
  })

  test('coalesces a run of changes into one write', async () => {
    await adoptBoardLayers(BOARD, LAYERS)
    const view = boardViewFor(BOARD)
    view.activeLayer = 'B.Cu'
    view.nonActiveDisplay = 'hide'
    view.layerVisibility = { ...view.layerVisibility, 'F.SilkS': false }
    await settle()
    expect(written).toHaveLength(1)
  })

  test('is read back on the next open', async () => {
    await adoptBoardLayers(BOARD, LAYERS)
    boardViewFor(BOARD).layerVisibility = {
      ...boardViewFor(BOARD).layerVisibility,
      'F.Fab': true,
      'B.Cu': false
    }
    await settle()

    // A fresh run: the store is empty, the file is not.
    clearBoardViews()
    await adoptBoardLayers(BOARD, LAYERS)
    await settle()
    expect(boardViewFor(BOARD).layerVisibility['F.Fab']).toBe(true)
    expect(boardViewFor(BOARD).layerVisibility['B.Cu']).toBe(false)
  })

  test('is never written for a board with no project', async () => {
    delete files['/w/canary.kicad_pro']
    await adoptBoardLayers(BOARD, LAYERS)
    boardViewFor(BOARD).nonActiveDisplay = 'dim'
    await settle()
    expect(written).toEqual([])
    // Still remembered for the run, which is all a loose file gets.
    expect(boardViewFor(BOARD).nonActiveDisplay).toBe('dim')
  })

  test('keeps Use starting track width, as KiCad keeps it, and reads it back (R1)', async () => {
    await adoptBoardLayers(BOARD, LAYERS)
    expect(boardViewFor(BOARD).autoTrackWidth).toBe(true)
    boardViewFor(BOARD).autoTrackWidth = false
    await settle()
    expect(JSON.parse(files['/w/canary.kicad_prl']).board.auto_track_width).toBe(false)
    expect(await autoTrackWidthFor(BOARD)).toBe(false)

    // A board no editor has open: its project's file answers.
    clearBoardViews()
    expect(await autoTrackWidthFor(BOARD)).toBe(false)
    await adoptBoardLayers(BOARD, LAYERS)
    expect(boardViewFor(BOARD).autoTrackWidth).toBe(false)
  })

  test('does not repaint a board the user has already touched', async () => {
    files['/w/canary.kicad_prl'] = JSON.stringify({ board: { high_contrast_mode: 2 } })
    const adopting = adoptBoardLayers(BOARD, LAYERS)
    // Between the seed and the file landing, which is where a fast hand lands.
    boardViewFor(BOARD).nonActiveDisplay = 'dim'
    await adopting
    expect(boardViewFor(BOARD).nonActiveDisplay).toBe('dim')
  })
})

describe('holding the viewport back until the view has settled', () => {
  test('a board nobody asked about is ready, so an editor that never asks is never gated', () => {
    expect(boardViewReady(BOARD)).toBe(true)
  })

  test('is not ready between the prefetch and its answer', async () => {
    prefetchBoardView(BOARD)
    expect(boardViewReady(BOARD)).toBe(false)
    await adoptBoardLayers(BOARD, LAYERS)
    expect(boardViewReady(BOARD)).toBe(true)
  })

  test('the remembered layers are on before anything could be drawn', async () => {
    files['/w/canary.kicad_prl'] = JSON.stringify({ board: { high_contrast_mode: 2 } })
    prefetchBoardView(BOARD)
    // The parse: long enough for two IPC reads several times over.
    await settle()
    await adoptBoardLayers(BOARD, LAYERS)
    // Ready and restored in the same breath — no window where a viewport could
    // mount on the defaults and rebuild through them.
    expect(boardViewReady(BOARD)).toBe(true)
    expect(boardViewFor(BOARD).nonActiveDisplay).toBe('hide')
  })

  test('becomes ready even when there is no project to remember anything', async () => {
    delete files['/w/canary.kicad_pro']
    prefetchBoardView(BOARD)
    await adoptBoardLayers(BOARD, LAYERS)
    expect(boardViewReady(BOARD)).toBe(true)
  })

  test('a prefetch that answers first still lands, once the layers arrive', async () => {
    files['/w/canary.kicad_prl'] = JSON.stringify({ board: { high_contrast_mode: 1 } })
    prefetchBoardView(BOARD)
    await settle()
    // The file is in hand and the layer table is not; nothing has been applied.
    expect(boardViewReady(BOARD)).toBe(false)
    await adoptBoardLayers(BOARD, LAYERS)
    expect(boardViewFor(BOARD).nonActiveDisplay).toBe('dim')
    expect(boardViewReady(BOARD)).toBe(true)
  })
})
