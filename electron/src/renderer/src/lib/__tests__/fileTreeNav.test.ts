import { describe, expect, it } from 'vitest'
import {
  findFileByExt,
  findFileNode,
  flattenVisibleRows,
  horizontalMove,
  indexOfSelection,
  moveSelection,
  type TreeNavItem
} from '../fileTreeNav'

const FILES: TreeNavItem[] = [
  {
    name: 'src',
    path: '/p/src',
    isDirectory: true,
    children: [
      { name: 'main.kicad_sch', path: '/p/src/main.kicad_sch', isDirectory: false },
      { name: 'Device.kicad_sym', path: '/p/src/Device.kicad_sym', isDirectory: false }
    ]
  },
  { name: 'board.kicad_pcb', path: '/p/board.kicad_pcb', isDirectory: false }
]

const SYMBOLS = { '/p/src/Device.kicad_sym': ['R', 'C', 'LED'] }

describe('flattenVisibleRows', () => {
  it('lists only the top level when nothing is expanded', () => {
    const rows = flattenVisibleRows(FILES, {})
    expect(rows.map((r) => r.path)).toEqual(['/p/src', '/p/board.kicad_pcb'])
    expect(rows[0].expandable).toBe(true)
    expect(rows[1].expandable).toBe(false)
  })

  it('treats a .kicad_sym as expandable even though it is a file', () => {
    const rows = flattenVisibleRows(FILES, { '/p/src': true })
    const library = rows.find((r) => r.path === '/p/src/Device.kicad_sym')!
    expect(library.expandable).toBe(true)
    expect(library.expanded).toBe(false)
  })

  it('expands a library into symbol rows sharing the library path', () => {
    const rows = flattenVisibleRows(
      FILES,
      { '/p/src': true, '/p/src/Device.kicad_sym': true },
      SYMBOLS
    )
    const symbols = rows.filter((r) => r.symbol)
    expect(symbols.map((r) => r.symbol)).toEqual(['R', 'C', 'LED'])
    expect(symbols.every((r) => r.path === '/p/src/Device.kicad_sym')).toBe(true)
    expect(symbols[0].parentPath).toBe('/p/src/Device.kicad_sym')
    // Order is what the user sees: the library, its symbols, then the sibling.
    expect(rows.map((r) => r.symbol ?? r.path)).toEqual([
      '/p/src',
      '/p/src/main.kicad_sch',
      '/p/src/Device.kicad_sym',
      'R',
      'C',
      'LED',
      '/p/board.kicad_pcb'
    ])
  })

  it('contributes no symbol rows when the names have not loaded yet', () => {
    const rows = flattenVisibleRows(FILES, { '/p/src': true, '/p/src/Device.kicad_sym': true })
    expect(rows.some((r) => r.symbol)).toBe(false)
  })
})

describe('selection movement', () => {
  const rows = flattenVisibleRows(
    FILES,
    { '/p/src': true, '/p/src/Device.kicad_sym': true },
    SYMBOLS
  )

  it('distinguishes a symbol row from its library row', () => {
    const library = { path: '/p/src/Device.kicad_sym' }
    const symbol = { path: '/p/src/Device.kicad_sym', symbol: 'C' }
    expect(indexOfSelection(rows, library)).not.toBe(indexOfSelection(rows, symbol))
    expect(rows[indexOfSelection(rows, symbol)].symbol).toBe('C')
  })

  it('starts at the first row on Down and the last on Up with nothing selected', () => {
    expect(moveSelection(rows, null, 1)).toEqual({ path: '/p/src', symbol: undefined })
    expect(moveSelection(rows, null, -1)).toEqual({
      path: '/p/board.kicad_pcb',
      symbol: undefined
    })
  })

  it('steps through symbol rows like any other row', () => {
    const at = { path: '/p/src/Device.kicad_sym', symbol: 'R' }
    expect(moveSelection(rows, at, 1)).toEqual({ path: '/p/src/Device.kicad_sym', symbol: 'C' })
  })

  it('stops at the ends rather than wrapping', () => {
    expect(moveSelection(rows, { path: '/p/src' }, -1)).toEqual({
      path: '/p/src',
      symbol: undefined
    })
    const last = { path: '/p/board.kicad_pcb' }
    expect(moveSelection(rows, last, 1)).toEqual({ path: '/p/board.kicad_pcb', symbol: undefined })
  })
})

describe('horizontalMove', () => {
  it('expands a collapsed row before stepping into it', () => {
    const collapsed = flattenVisibleRows(FILES, {})
    expect(horizontalMove(collapsed, { path: '/p/src' }, 'right')).toEqual({
      kind: 'expand',
      path: '/p/src'
    })
  })

  it('steps into the first child once expanded', () => {
    const rows = flattenVisibleRows(FILES, { '/p/src': true })
    expect(horizontalMove(rows, { path: '/p/src' }, 'right')).toEqual({
      kind: 'select',
      selection: { path: '/p/src/main.kicad_sch', symbol: undefined }
    })
  })

  it('does not step into a sibling from a leaf', () => {
    const rows = flattenVisibleRows(FILES, { '/p/src': true })
    expect(horizontalMove(rows, { path: '/p/src/main.kicad_sch' }, 'right')).toEqual({
      kind: 'none'
    })
  })

  it('collapses an expanded row, then steps out to the parent', () => {
    const rows = flattenVisibleRows(FILES, { '/p/src': true })
    expect(horizontalMove(rows, { path: '/p/src' }, 'left')).toEqual({
      kind: 'collapse',
      path: '/p/src'
    })
    expect(horizontalMove(rows, { path: '/p/src/main.kicad_sch' }, 'left')).toEqual({
      kind: 'select',
      selection: { path: '/p/src' }
    })
  })

  it('steps a symbol row out to its library rather than collapsing it', () => {
    const rows = flattenVisibleRows(
      FILES,
      { '/p/src': true, '/p/src/Device.kicad_sym': true },
      SYMBOLS
    )
    expect(horizontalMove(rows, { path: '/p/src/Device.kicad_sym', symbol: 'C' }, 'left')).toEqual({
      kind: 'select',
      selection: { path: '/p/src/Device.kicad_sym' }
    })
  })

  it('does nothing at the root going left, or with no selection', () => {
    const rows = flattenVisibleRows(FILES, {})
    expect(horizontalMove(rows, { path: '/p/board.kicad_pcb' }, 'left')).toEqual({ kind: 'none' })
    expect(horizontalMove(rows, null, 'right')).toEqual({ kind: 'none' })
  })
})

describe('findFileNode', () => {
  it('finds nested nodes and returns null for a stranger', () => {
    expect(findFileNode(FILES, '/p/src/Device.kicad_sym')?.name).toBe('Device.kicad_sym')
    expect(findFileNode(FILES, '/p/src')?.isDirectory).toBe(true)
    expect(findFileNode(FILES, '/p/nope')).toBeNull()
  })
})

describe('findFileByExt', () => {
  it('descends into directories and matches case-insensitively', () => {
    expect(findFileByExt(FILES, '.kicad_sch')?.path).toBe('/p/src/main.kicad_sch')
    expect(
      findFileByExt([{ name: 'A.KiCad_Sch', path: '/p/A', isDirectory: false }], '.kicad_sch')?.path
    ).toBe('/p/A')
  })

  it('returns null when nothing matches, including an empty directory', () => {
    expect(findFileByExt(FILES, '.kicad_mod')).toBeNull()
    expect(
      findFileByExt([{ name: 'empty', path: '/p/empty', isDirectory: true }], '.kicad_sch')
    ).toBeNull()
  })
})
