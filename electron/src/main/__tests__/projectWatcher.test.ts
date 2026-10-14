import { describe, it, expect } from 'vitest'
import { exceedsWatchBudget, isIgnoredChange, MAX_WATCHED_DIRECTORIES } from '../projectWatcher'

describe('isIgnoredChange', () => {
  it('ignores git internals — a single `git status` rewrites the index', () => {
    expect(isIgnoredChange('.git/index')).toBe(true)
    expect(isIgnoredChange('.git/refs/heads/master')).toBe(true)
  })

  it('ignores build and tooling directories at any depth', () => {
    expect(isIgnoredChange('node_modules/pkg/index.js')).toBe(true)
    expect(isIgnoredChange('sub/dist/bundle.js')).toBe(true)
    expect(isIgnoredChange('.goatherd/review.md')).toBe(true)
  })

  it('ignores the temp files editors write beside the real one', () => {
    expect(isIgnoredChange('main.kicad_sch.tmp')).toBe(true)
  })

  it('reports design files, including ones in nested folders', () => {
    expect(isIgnoredChange('main.kicad_sch')).toBe(false)
    expect(isIgnoredChange('boards/main.kicad_pcb')).toBe(false)
    expect(isIgnoredChange('libs/House.pretty/R_0402.kicad_mod')).toBe(false)
  })

  it('handles Windows separators, since fs.watch reports them natively', () => {
    expect(isIgnoredChange('.git\\index')).toBe(true)
    expect(isIgnoredChange('boards\\main.kicad_pcb')).toBe(false)
  })

  it('does not mistake a name that merely contains an ignored one', () => {
    expect(isIgnoredChange('git/main.kicad_sch')).toBe(false)
    expect(isIgnoredChange('my-dist-notes.kicad_sch')).toBe(false)
  })
})

describe('exceedsWatchBudget', () => {
  /** A tree as `{ dir: [subdirs] }`; anything unlisted is a leaf. */
  const treeReader =
    (tree: Record<string, string[]>) =>
    (dir: string): string[] =>
      tree[dir] ?? []

  it('passes an ordinary project', () => {
    const read = treeReader({ '/p': ['lib', '.git'], '/p/lib': ['House.pretty'], '/p/.git': [] })
    expect(exceedsWatchBudget('/p', read)).toBe(false)
  })

  it('counts ignored directories too — fs.watch will watch them regardless', () => {
    // The ignore list filters *events*; the watches are still established, which
    // is exactly the cost the budget exists to bound.
    const read = treeReader({ '/p': ['node_modules'], '/p/node_modules': ['a', 'b', 'c'] })
    expect(exceedsWatchBudget('/p', read, 3)).toBe(true)
  })

  it('stops walking once the limit is passed', () => {
    const visited: string[] = []
    const read = (dir: string): string[] => {
      visited.push(dir)
      return ['a', 'b', 'c', 'd']
    }
    expect(exceedsWatchBudget('/p', read, 2)).toBe(true)
    // The bail-out is the point: a walk taken to avoid an expensive watch must
    // not itself walk an unbounded tree.
    expect(visited).toEqual(['/p'])
  })

  it('treats an unreadable directory as empty rather than throwing', () => {
    expect(exceedsWatchBudget('/p', () => [])).toBe(false)
  })

  it('bounds well above a real project and well below a node_modules tree', () => {
    expect(MAX_WATCHED_DIRECTORIES).toBeGreaterThan(500)
    expect(MAX_WATCHED_DIRECTORIES).toBeLessThan(10_000)
  })
})
