import { describe, expect, it } from 'vitest'
import { buildFileTree, flattenTree, type TreeRow } from '../fileTree'

const change = (path: string): GitFileChange => ({
  path,
  status: 'modified',
  adds: 1,
  dels: 0,
  binary: false
})

const build = (paths: string[]): TreeRow[] =>
  flattenTree(buildFileTree(paths.map(change)), () => false)

const shape = (rows: TreeRow[]): string[] =>
  rows.map((row) => `${'  '.repeat(row.depth)}${row.name}${row.kind === 'dir' ? '/' : ''}`)

describe('buildFileTree', () => {
  it('folds a directory chain that offers no choice into one row', () => {
    expect(shape(build(['src/renderer/src/App.vue']))).toEqual(['src/renderer/src/', '  App.vue'])
  })

  it('stops folding where the tree actually branches', () => {
    expect(shape(build(['src/main/index.ts', 'src/preload/index.ts']))).toEqual([
      'src/',
      '  main/',
      '    index.ts',
      '  preload/',
      '    index.ts'
    ])
  })

  // localeCompare, so case doesn't split the list the way a raw `<` would —
  // README.md sorts among the lowercase names, not above all of them.
  it('puts directories before files and sorts each alphabetically', () => {
    expect(shape(build(['README.md', 'src/b.ts', 'src/a.ts', 'package.json']))).toEqual([
      'src/',
      '  a.ts',
      '  b.ts',
      'package.json',
      'README.md'
    ])
  })

  it('keeps a root-level file at depth zero', () => {
    expect(build(['README.md'])).toEqual([
      { kind: 'file', name: 'README.md', path: 'README.md', depth: 0, file: change('README.md') }
    ])
  })

  it('carries the full path on every node, not just the segment name', () => {
    const rows = build(['src/main/gitDiff.ts'])

    expect(rows.map((row) => row.path)).toEqual(['src/main', 'src/main/gitDiff.ts'])
  })
})

describe('flattenTree', () => {
  it('drops the children of a collapsed directory but keeps the directory', () => {
    const tree = buildFileTree(['src/main/a.ts', 'src/preload/b.ts', 'README.md'].map(change))

    const rows = flattenTree(tree, (path) => path === 'src/main')

    expect(shape(rows)).toEqual(['src/', '  main/', '  preload/', '    b.ts', 'README.md'])
  })
})
